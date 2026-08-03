// Phoebe orchestration engine — an away-from-keyboard (AFK) worker loop.
//
// Picks ready-labelled issues off the configured repo one at a time and
// works each in a git worktree off the container's private clone, on its own
// branch, opening a PR to the default branch. The container is both
// orchestrator and execution environment; agent CLIs run as direct children
// with an allowlisted env. See docs/architecture.md for the full design.
//
// The `runEngine(argv)` export is the loop entry point invoked by src/cli.ts
// after it loads the consumer's phoebe.config.ts and installs the resolved
// config into src/resolved-config.ts. Recognised argv flags:
//
//   (no flags)              # persistent poll loop
//   --run-once              # one unit of the first one-shot-eligible kind
//   --dry-run --run-once    # host-side selection preview
//
// Work-unit execution is refused outside the container marker
// (src/execution-gate.ts).

import { execFileSync, execSync } from "node:child_process";
import { config } from "./resolved-config.ts";
import { PROVIDER_NAMES, type ProviderName } from "./config-schema.ts";
import {
  asBranchRef,
  asPrNumber,
  asSha,
  type BranchRef,
  type PrNumber,
  type Sha,
} from "./branded.ts";
import { buildAgentEnv } from "./agent-env.ts";
import { installDrainSignal, type DrainSignal } from "./drain.ts";
import {
  EXECUTION_REFUSED_MESSAGE,
  executionDecision,
  isInsideContainer,
} from "./execution-gate.ts";
import {
  addWorktreeForExistingBranch,
  addWorktreeForNewBranch,
  commitCount,
  ensureClone,
  fetchOrigin as gitFetchOrigin,
  originBranchSha as gitOriginBranchSha,
  pushBranch,
  removeWorktree,
  worktreeDirForBranch,
} from "./git-model.ts";
import { PROVIDERS } from "./providers/providers.ts";
import { runAgent } from "./providers/run-agent.ts";
import type { Provider } from "./providers/types.ts";
import {
  buildDefaultPromptArgs,
  loadPromptTemplate as loadPromptTemplateFromRoot,
  renderPrompt,
} from "./prompt.ts";
import { buildRuntimeContractContext } from "./runtime-contract-context.ts";
import { createRuntimeStatusReporter, type RuntimeStatusTransition } from "./runtime-status.ts";
import {
  buildInitialPrBody,
  buildReviewsHandledComment,
  checksFixFailureComment,
  conflictFixFailureComment,
  followUpPrComment,
  formatFailingChecksForPrompt,
  isReviewSummaryComment,
  issueBranch,
  isPrInScope,
  isPrMergeConflicting,
  listFailingChecks,
  newestReviewThreadCommentCreatedAt,
  parseBlockedBy,
  parseLatestMarker,
  parseChecksFailWatermark,
  parseConflictFailWatermark,
  parseReviewsHandledWatermark,
  parseIssueNumberFromBranch,
  getMergedBlockerPrNumbers,
  oneShotWorkKinds,
  stackedCatchUpRetractionComment,
  RUN_ONCE_NOTHING_MESSAGE,
  selectFirstWorkUnit,
  selectIssue,
  summarizeChecksSelection,
  summarizeConflictSelection,
  summarizeReviewsSelection,
  shouldPostChecksFixFailure,
  shouldPostConflictFixFailure,
  statusCheckRollupState,
  validateWorkOrder,
  workflowRunsToCheckItems,
  type BlockerPrState,
  type ChecksCandidate,
  type ChecksFailWatermark,
  type ConflictingPrCandidate,
  type ConflictFailWatermark,
  type Issue,
  type IssueWorkUnit,
  type ReviewThread,
  type ReviewsCandidate,
  type StackContext,
  type StatusCheckItem,
  type WorkflowRunItem,
  type WorkKindName,
  type WorkUnit,
} from "./orchestrator.ts";

const DEFAULT_POLL_INTERVAL_MS = 300_000;
// Never let a gh/git child process block the persistent loop forever (rate-limit
// backoff, credential prompt, network partition). Configured toolchain commands
// (install/test) get a longer leash.
const CHILD_PROCESS_TIMEOUT_MS = 120_000;
const SHELL_COMMAND_TIMEOUT_MS = 600_000;
const MERGEABLE_RETRY_MS = 5_000;
const MERGEABLE_RETRY_COUNT = 3;

const PR_BASE = config.defaultBranch;
const defaultBranchRef = asBranchRef(config.defaultBranch);

const inContainer = isInsideContainer();
// On the host only selection/--dry-run runs, against the local checkout; in
// the container all git state lives in the private clone on the named volume.
const repoDir = inContainer ? config.paths.repoDir : process.cwd();
const worktreesDir = config.paths.worktreesDir;

// ---------------------------------------------------------------------------
// Provider selection (multi-provider ready)
// ---------------------------------------------------------------------------

function selectProvider(): { provider: Provider; model: string; effort: string | undefined } {
  const name = process.env["PHOEBE_AGENT"] ?? config.defaultProvider;
  if (!(PROVIDER_NAMES as readonly string[]).includes(name)) {
    throw new Error(`Unknown PHOEBE_AGENT "${name}". Use one of: ${PROVIDER_NAMES.join(", ")}.`);
  }
  const provider = PROVIDERS[name as ProviderName];
  const model = process.env["PHOEBE_MODEL"] ?? config.defaultModels[name as ProviderName];
  const effort = process.env["PHOEBE_EFFORT"] ?? config.defaultEfforts[name as ProviderName];
  return { provider, model, effort };
}

const workOrder = validateWorkOrder(config.workOrder);

// ---------------------------------------------------------------------------
// gh helpers — always pinned to the configured repo
// ---------------------------------------------------------------------------

function ghJson<T>(args: string[]): T {
  return JSON.parse(
    execFileSync("gh", [...args, "-R", config.repoSlug], {
      encoding: "utf8",
      timeout: CHILD_PROCESS_TIMEOUT_MS,
    }),
  ) as T;
}

function ghApiJson<T>(endpoint: string): T {
  return JSON.parse(
    execFileSync("gh", ["api", endpoint], {
      encoding: "utf8",
      timeout: CHILD_PROCESS_TIMEOUT_MS,
    }),
  ) as T;
}

function gh(args: string[], opts?: { input?: string }): void {
  execFileSync("gh", [...args, "-R", config.repoSlug], {
    stdio: opts?.input !== undefined ? ["pipe", "inherit", "inherit"] : "inherit",
    timeout: CHILD_PROCESS_TIMEOUT_MS,
    ...(opts?.input !== undefined ? { input: opts.input } : {}),
  });
}

/** Open issues carrying `label`, oldest-created first. Shared by `issues` and `research`. */
function listIssuesWithLabel(label: string): Issue[] {
  type GhIssue = Omit<Issue, "labels"> & { labels: Array<{ name: string }> };
  return ghJson<GhIssue[]>([
    "issue",
    "list",
    "--state",
    "open",
    "--label",
    label,
    "--limit",
    "100",
    "--search",
    "sort:created-asc",
    "--json",
    "number,title,body,labels,createdAt",
  ]).map((row) => ({
    number: row.number,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt,
    labels: row.labels.map((l) => l.name),
  }));
}

function listReadyIssues(): Issue[] {
  return listIssuesWithLabel(config.readyLabel);
}

function listResearchIssues(): Issue[] {
  return listIssuesWithLabel(config.researchLabel);
}

function blockerPrState(blockerIssueNumber: number): BlockerPrState {
  const branch: BranchRef = issueBranch(blockerIssueNumber);
  const open = ghJson<Array<{ number: number }>>([
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "number",
    "--limit",
    "1",
  ]);
  const merged = ghJson<Array<{ number: number }>>([
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "merged",
    "--json",
    "number",
    "--limit",
    "1",
  ]);
  return {
    hasOpenPr: open.length > 0,
    openPrNumber: open[0] ? asPrNumber(open[0].number) : undefined,
    hasMergedPr: merged.length > 0,
    mergedPrNumber: merged[0] ? asPrNumber(merged[0].number) : undefined,
  };
}

function buildBlockerStates(issues: readonly Issue[]): Map<number, BlockerPrState> {
  const blockerNumbers = new Set<number>();
  for (const issue of issues) {
    for (const n of parseBlockedBy(issue.body)) {
      blockerNumbers.add(n);
    }
  }
  const states = new Map<number, BlockerPrState>();
  for (const n of blockerNumbers) {
    try {
      states.set(n, blockerPrState(n));
    } catch (error) {
      // Absent entries are treated as unmerged blockers — safe to retry next cycle.
      console.warn(
        `[phoebe] Skipping blocker state for #${n} this cycle — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return states;
}

function buildBlockerStatesFromBodies(
  bodies: ReadonlyArray<{ number: number; body: string }>,
): Map<number, BlockerPrState> {
  return buildBlockerStates(
    bodies.map(({ number, body }) => ({
      number,
      title: "",
      body,
      labels: [],
      createdAt: "",
    })),
  );
}

function postPrComment(prNumber: PrNumber, body: string): void {
  gh(["pr", "comment", String(prNumber), "--body", body]);
}

type OpenPhoebePr = {
  number: PrNumber;
  headRefName: BranchRef;
  baseRefName: BranchRef;
  authorLogin: string;
};

function listOpenPhoebePrs(): OpenPhoebePr[] {
  type GhOpenPr = {
    number: number;
    headRefName: string;
    baseRefName: string;
    isDraft: boolean;
    isCrossRepository: boolean;
    labels: Array<{ name: string }>;
    author: { login: string };
  };
  const args = [
    "pr",
    "list",
    "--state",
    "open",
    "--json",
    "number,headRefName,baseRefName,isDraft,isCrossRepository,labels,author",
    "--limit",
    "100",
  ];
  if (config.prBaseScope === "default") {
    args.splice(2, 0, "--base", PR_BASE);
  }
  return ghJson<GhOpenPr[]>(args)
    .filter((pr) =>
      isPrInScope({
        headRefName: asBranchRef(pr.headRefName),
        authorLogin: pr.author.login,
        isDraft: pr.isDraft,
        isCrossRepository: pr.isCrossRepository,
        labels: pr.labels.map((label) => label.name),
      }),
    )
    .map((pr) => ({
      number: asPrNumber(pr.number),
      headRefName: asBranchRef(pr.headRefName),
      baseRefName: asBranchRef(pr.baseRefName),
      authorLogin: pr.author.login,
    }));
}

type PrMergeInfo = {
  number: PrNumber;
  headRefName: BranchRef;
  baseRefName: BranchRef;
  headRefOid: Sha;
  baseRefOid: Sha;
  mergeable: string;
  mergeStateStatus: string;
};

function viewPrMergeInfo(prNumber: PrNumber): PrMergeInfo {
  const raw = ghJson<{
    number: number;
    headRefName: string;
    baseRefName: string;
    headRefOid: string;
    baseRefOid: string;
    mergeable: string;
    mergeStateStatus: string;
  }>([
    "pr",
    "view",
    String(prNumber),
    "--json",
    "number,headRefName,baseRefName,headRefOid,baseRefOid,mergeable,mergeStateStatus",
  ]);
  return {
    number: asPrNumber(raw.number),
    headRefName: asBranchRef(raw.headRefName),
    baseRefName: asBranchRef(raw.baseRefName),
    headRefOid: asSha(raw.headRefOid),
    baseRefOid: asSha(raw.baseRefOid),
    mergeable: raw.mergeable,
    mergeStateStatus: raw.mergeStateStatus,
  };
}

/** All comment bodies on a PR, oldest first — the raw input to every watermark parse. */
function fetchPrCommentBodies(prNumber: PrNumber): string[] {
  const { comments } = ghJson<{ comments: Array<{ body: string }> }>([
    "pr",
    "view",
    String(prNumber),
    "--json",
    "comments",
  ]);
  return comments.map((comment) => comment.body);
}

function phoebeGhLogin(): string {
  return ghApiJson<{ login: string }>("user").login;
}

function issueBody(issueNumber: number): string {
  return ghJson<{ body: string }>(["issue", "view", String(issueNumber), "--json", "body"]).body;
}

// ---------------------------------------------------------------------------
// git helpers bound to the clone
// ---------------------------------------------------------------------------

function fetchOrigin(): void {
  gitFetchOrigin(repoDir);
}

function originBranchSha(branch: BranchRef): Sha {
  return gitOriginBranchSha(repoDir, branch);
}

function currentConflictFailureWatermark(
  branch: BranchRef,
  baseBranch: BranchRef,
): ConflictFailWatermark {
  fetchOrigin();
  return {
    prHead: originBranchSha(branch),
    mainHead: originBranchSha(baseBranch),
  };
}

function currentChecksFailureWatermark(branch: BranchRef): ChecksFailWatermark {
  fetchOrigin();
  return { prHead: originBranchSha(branch) };
}

function gitInWorktree(
  worktreeDir: string,
  args: string[],
  opts?: { stdio?: "inherit" | "ignore" | "pipe" },
): string {
  return execFileSync("git", ["-C", worktreeDir, ...args], {
    encoding: "utf8",
    timeout: CHILD_PROCESS_TIMEOUT_MS,
    ...(opts?.stdio ? { stdio: opts.stdio } : {}),
  }) as unknown as string;
}

/** Run a configured toolchain command (a shell string) inside a worktree. */
function runShellCommand(command: string, cwd: string): void {
  execSync(command, { cwd, stdio: "inherit", timeout: SHELL_COMMAND_TIMEOUT_MS });
}

/** Shell executor for prompt !`...` expansion — captures stdout. */
function promptShell(cwd: string): (command: string) => string {
  return (command) =>
    execSync(command, { cwd, encoding: "utf8", timeout: SHELL_COMMAND_TIMEOUT_MS });
}

/** Load a `promptFiles.*` template from the runtime root (process cwd). */
function loadPromptTemplate(relativePath: string): string {
  return loadPromptTemplateFromRoot(relativePath, process.cwd());
}

// ---------------------------------------------------------------------------
// Work-unit execution
// ---------------------------------------------------------------------------

function prepareWorktree(opts: { branch: BranchRef; baseRef?: string }): string {
  const worktreeDir = worktreeDirForBranch(worktreesDir, opts.branch);
  removeWorktree(repoDir, worktreeDir);
  if (opts.baseRef) {
    addWorktreeForNewBranch({
      repoDir,
      worktreeDir,
      branch: opts.branch,
      baseRef: opts.baseRef,
    });
  } else {
    addWorktreeForExistingBranch({ repoDir, worktreeDir, branch: opts.branch });
  }
  return worktreeDir;
}

async function runAgentInWorktree(opts: {
  worktreeDir: string;
  promptFile: string;
  promptArgs: Record<string, string>;
}): Promise<number> {
  const { provider, model, effort } = selectProvider();
  // Caller-supplied per-callsite args (ISSUE_NUMBER, PR_NUMBER, …) override
  // the standard config-derived set by key.
  const prompt = renderPrompt(
    loadPromptTemplate(opts.promptFile),
    { ...buildDefaultPromptArgs(config), ...opts.promptArgs },
    promptShell(opts.worktreeDir),
  );
  const env = buildAgentEnv({
    parentEnv: process.env,
    provider: provider.name,
    providerEnv: config.providerEnv,
  });
  const { exitCode } = await runAgent({
    provider,
    model,
    effort,
    prompt,
    cwd: opts.worktreeDir,
    env,
  });
  if (exitCode !== 0) {
    console.log(`[phoebe] Agent exited with code ${exitCode}.`);
  }
  return exitCode;
}

// The observed outcome of an automatic (no-agent) merge attempt:
//   "pushed"     — merged cleanly and pushed; the PR is caught up.
//   "conflicted" — real merge conflicts in the tree; an agent must resolve them.
//   "failed"     — could not even start/finish the merge (e.g. worktree setup);
//                  no conflicts were observed.
type CleanMergeOutcome = "pushed" | "conflicted" | "failed";

function tryCleanMerge(
  branch: BranchRef,
  mergedBlockerPrNumbers: readonly PrNumber[] = [],
  baseBranch: BranchRef = defaultBranchRef,
): CleanMergeOutcome {
  let worktreeDir: string;
  try {
    worktreeDir = prepareWorktree({ branch });
  } catch {
    return "failed";
  }

  try {
    for (const blockerPrNumber of mergedBlockerPrNumbers) {
      gitInWorktree(worktreeDir, ["fetch", "origin", `pull/${blockerPrNumber}/head`], {
        stdio: "inherit",
      });
      gitInWorktree(worktreeDir, ["merge", "FETCH_HEAD"], { stdio: "pipe" });
    }
    gitInWorktree(worktreeDir, ["fetch", "origin", baseBranch], { stdio: "inherit" });
    gitInWorktree(worktreeDir, ["merge", `origin/${baseBranch}`], { stdio: "pipe" });
    pushBranch(worktreeDir, branch);
    removeWorktree(repoDir, worktreeDir);
    return "pushed";
  } catch {
    try {
      const unmerged = gitInWorktree(worktreeDir, ["diff", "--name-only", "--diff-filter=U"]);
      if (unmerged.trim()) {
        gitInWorktree(worktreeDir, ["merge", "--abort"], { stdio: "ignore" });
        removeWorktree(repoDir, worktreeDir);
        return "conflicted";
      }
    } catch {
      // Fall through to failed.
    }
    try {
      gitInWorktree(worktreeDir, ["merge", "--abort"], { stdio: "ignore" });
    } catch {
      // Best-effort.
    }
    removeWorktree(repoDir, worktreeDir);
    return "failed";
  }
}

/** Blocker-first merge attempt, mirroring `cmd && … || true` hook semantics. */
function attemptBlockerFirstMerges(
  worktreeDir: string,
  mergedBlockerPrNumbers: readonly PrNumber[],
  baseBranch: BranchRef,
): void {
  try {
    for (const n of mergedBlockerPrNumbers) {
      gitInWorktree(worktreeDir, ["fetch", "origin", `pull/${n}/head`], { stdio: "inherit" });
      gitInWorktree(worktreeDir, ["merge", "FETCH_HEAD"], { stdio: "pipe" });
    }
    gitInWorktree(worktreeDir, ["fetch", "origin", baseBranch], { stdio: "inherit" });
    gitInWorktree(worktreeDir, ["merge", `origin/${baseBranch}`], { stdio: "pipe" });
  } catch {
    // Conflicts stay in the tree for the agent to resolve.
  }
}

type AgentWorkflowResult = {
  worktreeDir: string;
  branch: BranchRef;
  originShaBefore: Sha;
  originShaAfter: Sha;
  localCommitCount: number;
};

/**
 * The shared skeleton behind every PR-fix agent: snapshot origin, prepare a
 * worktree, install, optionally prime the tree, run the agent, then re-snapshot
 * origin and count the host-side commits. Only `onResult` differs per work kind
 * (push vs. failure comment vs. watermark); the worktree is always removed.
 */
async function runAgentWorkflow(opts: {
  pr: { prNumber: PrNumber; headRefName: BranchRef };
  promptFile: string;
  promptArgs: Record<string, string>;
  beforeAgent?: (worktreeDir: string) => void;
  onResult: (result: AgentWorkflowResult) => void | Promise<void>;
}): Promise<number> {
  const branch = opts.pr.headRefName;

  fetchOrigin();
  const originShaBefore = originBranchSha(branch);

  const worktreeDir = prepareWorktree({ branch });
  try {
    runShellCommand(config.installCommand, worktreeDir);
    opts.beforeAgent?.(worktreeDir);

    const agentExitCode = await runAgentInWorktree({
      worktreeDir,
      promptFile: opts.promptFile,
      promptArgs: opts.promptArgs,
    });

    fetchOrigin();
    const originShaAfter = originBranchSha(branch);
    const localCommitCount = commitCount(worktreeDir, `origin/${branch}..HEAD`);

    await opts.onResult({ worktreeDir, branch, originShaBefore, originShaAfter, localCommitCount });
    return agentExitCode;
  } finally {
    removeWorktree(repoDir, worktreeDir);
  }
}

async function runConflictResolutionAgent(
  pr: ConflictingPrCandidate,
  mergedBlockerPrNumbers: readonly PrNumber[],
): Promise<number> {
  const baseBranch = pr.baseRefName ?? defaultBranchRef;
  return runAgentWorkflow({
    pr,
    promptFile: config.promptFiles.conflict,
    promptArgs: {
      PR_NUMBER: String(pr.prNumber),
      PR_BRANCH: pr.headRefName,
      BLOCKER_PR_NUMBERS: mergedBlockerPrNumbers.join(","),
    },
    beforeAgent: (worktreeDir) =>
      attemptBlockerFirstMerges(worktreeDir, mergedBlockerPrNumbers, baseBranch),
    onResult: ({ worktreeDir, branch, originShaBefore, originShaAfter, localCommitCount }) => {
      const prInfo = viewPrMergeInfo(pr.prNumber);
      if (
        shouldPostConflictFixFailure({
          hostCommitCount: localCommitCount,
          originShaBefore,
          originShaAfter,
          mergeable: prInfo.mergeable,
          mergeStateStatus: prInfo.mergeStateStatus,
        })
      ) {
        console.log(
          `[phoebe] Conflict fix for PR #${pr.prNumber} produced no commits — leaving PR unchanged.`,
        );
        postPrComment(
          pr.prNumber,
          conflictFixFailureComment(
            pr.prNumber,
            currentConflictFailureWatermark(pr.headRefName, baseBranch),
          ),
        );
      } else if (localCommitCount > 0) {
        pushBranch(worktreeDir, branch);
        console.log(`[phoebe] Conflict resolved for PR #${pr.prNumber} — pushed.`);
      } else {
        console.log(`[phoebe] Conflict resolved for PR #${pr.prNumber} — already pushed by agent.`);
      }
    },
  });
}

async function fixOnePrConflict(
  pr: ConflictingPrCandidate,
  ctx: StackContext,
): Promise<number | null> {
  const baseBranch = pr.baseRefName ?? defaultBranchRef;
  console.log(`[phoebe] Conflict fix: PR #${pr.prNumber} (${pr.headRefName}).`);
  fetchOrigin();

  const issueNumber = pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName);
  const body = issueNumber !== null ? (ctx.issueBodies.get(issueNumber) ?? "") : "";
  const mergedBlockerPrNumbers = getMergedBlockerPrNumbers(body, ctx.blockerStates);
  if (mergedBlockerPrNumbers.length > 0) {
    console.log(
      `[phoebe] Stacked catch-up: merging blocker PR(s) ${mergedBlockerPrNumbers.map((n) => `#${n}`).join(", ")} before ${config.defaultBranch}.`,
    );
  }

  const cleanResult = tryCleanMerge(pr.headRefName, mergedBlockerPrNumbers, baseBranch);
  if (cleanResult === "pushed") {
    console.log(`[phoebe] Clean merge for PR #${pr.prNumber} — pushed.`);
    if (mergedBlockerPrNumbers.length > 0) {
      postPrComment(pr.prNumber, stackedCatchUpRetractionComment(mergedBlockerPrNumbers));
    }
    return null;
  }
  if (cleanResult === "failed") {
    console.log(`[phoebe] Could not start merge for PR #${pr.prNumber} — skipping.`);
    postPrComment(
      pr.prNumber,
      conflictFixFailureComment(
        pr.prNumber,
        currentConflictFailureWatermark(pr.headRefName, baseBranch),
      ),
    );
    return null;
  }

  return runConflictResolutionAgent(pr, mergedBlockerPrNumbers);
}

async function runChecksResolutionAgent(pr: ChecksCandidate): Promise<number> {
  return runAgentWorkflow({
    pr,
    promptFile: config.promptFiles.checks,
    promptArgs: {
      PR_NUMBER: String(pr.prNumber),
      PR_BRANCH: pr.headRefName,
      FAILING_CHECKS: formatFailingChecksForPrompt(pr.failingChecks),
    },
    onResult: ({ worktreeDir, branch, originShaBefore, originShaAfter, localCommitCount }) => {
      if (
        shouldPostChecksFixFailure({
          hostCommitCount: localCommitCount,
          originShaBefore,
          originShaAfter,
        })
      ) {
        console.log(
          `[phoebe] Checks fix for PR #${pr.prNumber} produced no commits — leaving PR unchanged.`,
        );
        postPrComment(
          pr.prNumber,
          checksFixFailureComment(pr.prNumber, currentChecksFailureWatermark(pr.headRefName)),
        );
      } else if (localCommitCount > 0) {
        pushBranch(worktreeDir, branch);
        console.log(`[phoebe] Checks fixed for PR #${pr.prNumber} — pushed.`);
      } else {
        console.log(`[phoebe] Checks fixed for PR #${pr.prNumber} — already pushed by agent.`);
      }
    },
  });
}

async function fixOnePrChecks(pr: ChecksCandidate, ctx: StackContext): Promise<number | null> {
  const baseBranch = pr.baseRefName ?? defaultBranchRef;
  console.log(
    `[phoebe] Checks fix: PR #${pr.prNumber} (${pr.headRefName}) — ` +
      `${pr.failingChecks.map((c) => c.name).join(", ")}.`,
  );
  fetchOrigin();

  if (pr.mergeStateStatus === "BEHIND") {
    const issueNumber = pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName);
    const body = issueNumber !== null ? (ctx.issueBodies.get(issueNumber) ?? "") : "";
    const mergedBlockerPrNumbers = getMergedBlockerPrNumbers(body, ctx.blockerStates);
    if (mergedBlockerPrNumbers.length > 0) {
      console.log(
        `[phoebe] Behind ${baseBranch} — catch-up merging blocker PR(s) ${mergedBlockerPrNumbers.map((n) => `#${n}`).join(", ")} before ${baseBranch}.`,
      );
    } else {
      console.log(`[phoebe] Behind ${baseBranch} — catch-up merge for PR #${pr.prNumber}.`);
    }

    const cleanResult = tryCleanMerge(pr.headRefName, mergedBlockerPrNumbers, baseBranch);
    if (cleanResult === "pushed") {
      console.log(
        `[phoebe] Catch-up merge for PR #${pr.prNumber} — pushed; waiting for CI on next cycle.`,
      );
      if (mergedBlockerPrNumbers.length > 0) {
        postPrComment(pr.prNumber, stackedCatchUpRetractionComment(mergedBlockerPrNumbers));
      }
      return null;
    }
    if (cleanResult === "conflicted" || cleanResult === "failed") {
      console.log(
        `[phoebe] Catch-up merge conflicted for PR #${pr.prNumber} — deferring to conflicts mode.`,
      );
      return null;
    }
  }

  return runChecksResolutionAgent(pr);
}

type GraphQLReviewThreadsPage = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            isResolved: boolean;
            isOutdated: boolean;
            comments: {
              nodes: Array<{
                createdAt: string;
                author: { login: string } | null;
              }>;
            };
          }>;
        };
      };
    };
  };
};

function fetchReviewThreads(prNumber: PrNumber): ReviewThread[] {
  const [owner, repo] = config.repoSlug.split("/");
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const afterArg = cursor ? `, after:"${cursor}"` : "";
    const query = `query($owner:String!,$repo:String!,$pr:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$pr) {
      reviewThreads(first:100${afterArg}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          comments(first:30) {
            nodes {
              createdAt
              author { login }
            }
          }
        }
      }
    }
  }
}`;
    const page = JSON.parse(
      execFileSync(
        "gh",
        [
          "api",
          "graphql",
          "-f",
          `query=${query}`,
          "-f",
          `owner=${owner}`,
          "-f",
          `repo=${repo}`,
          "-F",
          `pr=${prNumber}`,
        ],
        { encoding: "utf8", timeout: CHILD_PROCESS_TIMEOUT_MS },
      ),
    ) as GraphQLReviewThreadsPage;

    const reviewThreads = page.data.repository.pullRequest.reviewThreads;
    for (const node of reviewThreads.nodes) {
      threads.push({
        isResolved: node.isResolved,
        isOutdated: node.isOutdated,
        comments: node.comments.nodes.map((comment) => ({
          createdAt: comment.createdAt,
          authorLogin: comment.author?.login ?? "",
        })),
      });
    }
    hasNextPage = reviewThreads.pageInfo.hasNextPage;
    cursor = reviewThreads.pageInfo.endCursor;
    if (!hasNextPage) {
      break;
    }
  }

  return threads;
}

function hasNewReviewSummaryComment(
  prNumber: PrNumber,
  phoebeLogin: string,
  since: string,
): boolean {
  const { comments } = ghJson<{
    comments: Array<{ body: string; createdAt: string; author: { login: string } }>;
  }>(["pr", "view", String(prNumber), "--json", "comments"]);
  return comments.some(
    (comment) =>
      comment.author.login === phoebeLogin &&
      comment.createdAt > since &&
      isReviewSummaryComment(comment.body),
  );
}

async function runReviewsResolutionAgent(
  pr: ReviewsCandidate,
  phoebeLogin: string,
): Promise<number> {
  const runStartedAt = new Date().toISOString();
  return runAgentWorkflow({
    pr,
    promptFile: config.promptFiles.reviews,
    promptArgs: {
      PR_NUMBER: String(pr.prNumber),
      PR_BRANCH: pr.headRefName,
    },
    onResult: ({ worktreeDir, branch, originShaBefore, originShaAfter, localCommitCount }) => {
      if (localCommitCount > 0) {
        pushBranch(worktreeDir, branch);
        console.log(`[phoebe] Review feedback handled for PR #${pr.prNumber} — pushed.`);
      } else if (originShaAfter !== originShaBefore) {
        console.log(
          `[phoebe] Review feedback handled for PR #${pr.prNumber} — already pushed by agent.`,
        );
      }

      const hasSummary = hasNewReviewSummaryComment(pr.prNumber, phoebeLogin, runStartedAt);
      const pushed = localCommitCount > 0 || originShaAfter !== originShaBefore;
      // Watermark only the activity captured before the agent ran (pr.threads is
      // the pre-run snapshot from fetchReviewsWorkData). Re-fetching here could
      // absorb feedback posted concurrently with the run — marking it handled
      // even though the agent never observed it, so it would never trigger another
      // cycle. Any activity newer than this snapshot correctly re-selects the PR.
      const latestActivityAt = newestReviewThreadCommentCreatedAt(pr.threads);

      if (hasSummary) {
        console.log(`[phoebe] Review summary posted for PR #${pr.prNumber}.`);
      } else if (!pushed) {
        console.log(`[phoebe] Review handling for PR #${pr.prNumber} produced no summary or push.`);
      }

      postPrComment(
        pr.prNumber,
        buildReviewsHandledComment({
          latestActivityAt,
          failed: !hasSummary && !pushed,
        }),
      );
    },
  });
}

async function fixOnePrReviews(pr: ReviewsCandidate, phoebeLogin: string): Promise<number> {
  console.log(`[phoebe] Reviews fix: PR #${pr.prNumber} (${pr.headRefName}).`);
  fetchOrigin();
  return runReviewsResolutionAgent(pr, phoebeLogin);
}

/**
 * Work a single issue-shaped ticket: branch off the resolved base, run the
 * given prompt, and — only when the agent left commits — push and open (or
 * update) a PR. Shared by the `issues` and `research` kinds; the two differ
 * only in `promptFile`. A research ticket that resolves as an issue-level
 * artifact (comment + close + map update, done by the prompt) leaves no
 * commits, so no PR is opened; one that produces a committed doc does.
 */
async function runOneIssue(opts: {
  issueNumber: number;
  issueTitle: string;
  worktreeBase: string;
  stacked: boolean;
  promptFile: string;
  blockerIssueNumber?: number;
  blockerPrNumber?: PrNumber;
}): Promise<number> {
  const { issueNumber, issueTitle, worktreeBase, stacked, promptFile } = opts;
  const { blockerIssueNumber, blockerPrNumber } = opts;
  const agentBranch = issueBranch(issueNumber);

  fetchOrigin();
  const worktreeDir = prepareWorktree({ branch: agentBranch, baseRef: worktreeBase });
  try {
    runShellCommand(config.installCommand, worktreeDir);

    const agentExitCode = await runAgentInWorktree({
      worktreeDir,
      promptFile,
      promptArgs: { ISSUE_NUMBER: String(issueNumber) },
    });

    const newCommitCount = commitCount(worktreeDir, `${worktreeBase}..HEAD`);

    if (newCommitCount > 0) {
      pushBranch(worktreeDir, agentBranch);
      const existingPrRow = ghJson<Array<{ number: number }>>([
        "pr",
        "list",
        "--head",
        agentBranch,
        "--state",
        "open",
        "--json",
        "number",
      ])[0];
      const existingPr = existingPrRow ? asPrNumber(existingPrRow.number) : undefined;
      if (existingPr === undefined) {
        const prTitle = `Phoebe: ${issueTitle} (#${issueNumber})`;
        const prBody = buildInitialPrBody({
          issueNumber,
          commitCount: newCommitCount,
          ...(stacked && blockerIssueNumber !== undefined && blockerPrNumber !== undefined
            ? { stacked: { blockerIssueNumber, blockerPrNumber } }
            : {}),
        });
        gh(
          [
            "pr",
            "create",
            "--head",
            agentBranch,
            "--base",
            PR_BASE,
            "--title",
            prTitle,
            "--body-file",
            "-",
          ],
          { input: prBody },
        );
      } else {
        console.log(
          `[phoebe] PR #${existingPr} already exists for ${agentBranch} — posting follow-up note.`,
        );
        postPrComment(existingPr, followUpPrComment(issueNumber, newCommitCount));
      }
    } else {
      console.log("[phoebe] No commits — skipping PR creation.");
    }
    return agentExitCode;
  } finally {
    removeWorktree(repoDir, worktreeDir);
  }
}

// ---------------------------------------------------------------------------
// Work kinds + cycle data
// ---------------------------------------------------------------------------

/**
 * Everything a work-unit runner needs beyond the unit itself, assembled from the
 * cycle's fetch results and passed into `runUnit` — so the runners hold no
 * module-level state between selection and execution.
 */
type RunContext = {
  stack: StackContext;
  phoebeLogin: string;
};

type WorkKind = {
  name: WorkKindName;
  fetch: () => Promise<WorkKindFetch>;
  runUnit: (unit: WorkUnit["unit"], context: RunContext) => Promise<number | null>;
};

type WorkKindFetch =
  | {
      kind: "conflicts";
      conflictingPrs: ConflictingPrCandidate[];
      issueBodies: Map<number, string>;
      currentMainHead: Sha;
    }
  | {
      kind: "checks";
      failingCheckPrs: ChecksCandidate[];
      issueBodies: Map<number, string>;
    }
  | {
      kind: "reviews";
      reviewActivityPrs: ReviewsCandidate[];
      issueBodies: Map<number, string>;
      phoebeLogin: string;
    }
  | { kind: "issues"; issues: Issue[]; blockerStates: Map<number, BlockerPrState> }
  | {
      kind: "research";
      researchIssues: Issue[];
      blockerStates: Map<number, BlockerPrState>;
    };

async function conflictingPrCandidate(pr: OpenPhoebePr): Promise<ConflictingPrCandidate | null> {
  for (let attempt = 0; attempt < MERGEABLE_RETRY_COUNT; attempt++) {
    const info = viewPrMergeInfo(pr.number);
    if (isPrMergeConflicting(info.mergeable, info.mergeStateStatus)) {
      const issueNumber = parseIssueNumberFromBranch(info.headRefName);
      return {
        prNumber: info.number,
        headRefName: info.headRefName,
        baseRefName: info.baseRefName,
        headSha: info.headRefOid,
        baseSha: info.baseRefOid,
        ...(issueNumber !== null ? { issueNumber } : {}),
      };
    }
    if (info.mergeable !== "UNKNOWN") {
      return null;
    }
    if (attempt < MERGEABLE_RETRY_COUNT - 1) {
      await sleep(MERGEABLE_RETRY_MS);
    }
  }
  return null;
}

async function fetchConflictingPrs(): Promise<ConflictingPrCandidate[]> {
  const openPrs = listOpenPhoebePrs();
  const conflicting: ConflictingPrCandidate[] = [];
  for (const pr of openPrs) {
    try {
      const candidate = await conflictingPrCandidate(pr);
      if (candidate) {
        conflicting.push(candidate);
      }
    } catch (error) {
      console.warn(
        `[phoebe] Skipping PR #${pr.number} for conflicts this cycle — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return conflicting;
}

// GraphQL statusCheckRollup is not readable by fine-grained PATs (GitHub-App/
// OAuth only), so check state comes from the REST Actions API instead.
function listCommitCheckItems(headSha: Sha): StatusCheckItem[] {
  return workflowRunsToCheckItems(
    ghJson<WorkflowRunItem[]>([
      "run",
      "list",
      "--commit",
      headSha,
      "--json",
      "workflowName,status,conclusion",
      "--limit",
      "50",
    ]),
  );
}

async function failingChecksCandidate(pr: OpenPhoebePr): Promise<ChecksCandidate | null> {
  for (let attempt = 0; attempt < MERGEABLE_RETRY_COUNT; attempt++) {
    const info = viewPrMergeInfo(pr.number);
    if (isPrMergeConflicting(info.mergeable, info.mergeStateStatus)) {
      return null;
    }
    const checkItems = listCommitCheckItems(info.headRefOid);
    const rollup = statusCheckRollupState(checkItems);
    if (rollup === "FAILURE") {
      const issueNumber = parseIssueNumberFromBranch(info.headRefName);
      return {
        prNumber: info.number,
        headRefName: info.headRefName,
        baseRefName: info.baseRefName,
        headSha: info.headRefOid,
        mergeable: info.mergeable,
        mergeStateStatus: info.mergeStateStatus,
        failingChecks: listFailingChecks(checkItems),
        ...(issueNumber !== null ? { issueNumber } : {}),
      };
    }
    if (rollup !== "PENDING" && info.mergeable !== "UNKNOWN") {
      return null;
    }
    if (attempt < MERGEABLE_RETRY_COUNT - 1) {
      await sleep(MERGEABLE_RETRY_MS);
    }
  }
  return null;
}

async function fetchFailingCheckPrs(): Promise<ChecksCandidate[]> {
  const openPrs = listOpenPhoebePrs();
  const failing: ChecksCandidate[] = [];
  for (const pr of openPrs) {
    try {
      const candidate = await failingChecksCandidate(pr);
      if (candidate) {
        failing.push(candidate);
      }
    } catch (error) {
      console.warn(
        `[phoebe] Skipping PR #${pr.number} for checks this cycle — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return failing;
}

/**
 * Fetch the issue body behind every PR that maps to a Phoebe issue branch, keyed
 * by issue number. Dedupes so each issue is fetched once even when several PRs
 * share it. The stack selectors read these bodies for `blocked by` references.
 */
function harvestIssueBodies(
  prs: ReadonlyArray<{ issueNumber?: number; headRefName: BranchRef }>,
): Map<number, string> {
  const issueNumbers = [
    ...new Set(
      prs
        .map((pr) => pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName))
        .filter((n): n is number => n !== null),
    ),
  ];
  return new Map(issueNumbers.map((number) => [number, issueBody(number)] as const));
}

async function fetchReviewsWorkData(): Promise<{
  reviewActivityPrs: ReviewsCandidate[];
  issueBodies: Map<number, string>;
  phoebeLogin: string;
}> {
  const phoebeLogin = phoebeGhLogin();
  const openPrs = listOpenPhoebePrs();
  const reviewActivityPrs: ReviewsCandidate[] = [];

  for (const pr of openPrs) {
    try {
      const info = viewPrMergeInfo(pr.number);
      if (isPrMergeConflicting(info.mergeable, info.mergeStateStatus)) {
        continue;
      }
      const threads = fetchReviewThreads(pr.number);
      const issueNumber = parseIssueNumberFromBranch(info.headRefName);
      reviewActivityPrs.push({
        prNumber: info.number,
        headRefName: info.headRefName,
        baseRefName: info.baseRefName,
        authorLogin: pr.authorLogin,
        mergeable: info.mergeable,
        mergeStateStatus: info.mergeStateStatus,
        threads,
        handledWatermark: parseLatestMarker(
          fetchPrCommentBodies(pr.number),
          parseReviewsHandledWatermark,
        ),
        ...(issueNumber !== null ? { issueNumber } : {}),
      });
    } catch (error) {
      console.warn(
        `[phoebe] Skipping PR #${pr.number} for reviews this cycle — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const issueBodies = harvestIssueBodies(reviewActivityPrs);
  return { reviewActivityPrs, issueBodies, phoebeLogin };
}

async function fetchConflictWorkData(): Promise<{
  conflictingPrs: ConflictingPrCandidate[];
  issueBodies: Map<number, string>;
  currentMainHead: Sha;
}> {
  const rawConflictingPrs = await fetchConflictingPrs();
  fetchOrigin();
  const currentMainHead = originBranchSha(defaultBranchRef);
  const conflictingPrs = rawConflictingPrs.map((pr) => ({
    ...pr,
    failureWatermark: parseLatestMarker(
      fetchPrCommentBodies(pr.prNumber),
      parseConflictFailWatermark,
    ),
  }));
  const issueBodies = harvestIssueBodies(conflictingPrs);
  return { conflictingPrs, issueBodies, currentMainHead };
}

async function fetchChecksWorkData(): Promise<{
  failingCheckPrs: ChecksCandidate[];
  issueBodies: Map<number, string>;
}> {
  const rawFailingPrs = await fetchFailingCheckPrs();
  const failingCheckPrs = rawFailingPrs.map((pr) => ({
    ...pr,
    failureWatermark: parseLatestMarker(
      fetchPrCommentBodies(pr.prNumber),
      parseChecksFailWatermark,
    ),
  }));
  const issueBodies = harvestIssueBodies(failingCheckPrs);
  return { failingCheckPrs, issueBodies };
}

function fetchIssueWorkData(): { issues: Issue[]; blockerStates: Map<number, BlockerPrState> } {
  const issues = listReadyIssues();
  return { issues, blockerStates: buildBlockerStates(issues) };
}

function fetchResearchWorkData(): {
  researchIssues: Issue[];
  blockerStates: Map<number, BlockerPrState>;
} {
  const researchIssues = listResearchIssues();
  return { researchIssues, blockerStates: buildBlockerStates(researchIssues) };
}

async function runIssueUnit(unit: IssueWorkUnit): Promise<number> {
  const { issue: target, resolution } = unit;
  console.log(
    `[phoebe] Working #${target.number} — base ${resolution.worktreeBase}` +
      (resolution.stacked ? ` (stacked on #${resolution.blockerIssueNumber})` : "") +
      ".",
  );
  return runOneIssue({
    issueNumber: target.number,
    issueTitle: target.title,
    worktreeBase: resolution.worktreeBase,
    stacked: resolution.stacked,
    promptFile: config.promptFiles.issue,
    blockerIssueNumber: resolution.blockerIssueNumber,
    blockerPrNumber: resolution.blockerPrNumber,
  });
}

async function runResearchUnit(unit: IssueWorkUnit): Promise<number> {
  const { issue: target, resolution } = unit;
  console.log(
    `[phoebe] Researching #${target.number} — base ${resolution.worktreeBase}` +
      (resolution.stacked ? ` (stacked on #${resolution.blockerIssueNumber})` : "") +
      ".",
  );
  return runOneIssue({
    issueNumber: target.number,
    issueTitle: target.title,
    worktreeBase: resolution.worktreeBase,
    stacked: resolution.stacked,
    promptFile: config.promptFiles.research,
    blockerIssueNumber: resolution.blockerIssueNumber,
    blockerPrNumber: resolution.blockerPrNumber,
  });
}

const KINDS: Record<WorkKindName, WorkKind> = {
  conflicts: {
    name: "conflicts",
    fetch: async () => {
      const { conflictingPrs, issueBodies, currentMainHead } = await fetchConflictWorkData();
      return { kind: "conflicts", conflictingPrs, issueBodies, currentMainHead };
    },
    runUnit: async (unit, context) => {
      return fixOnePrConflict(unit as ConflictingPrCandidate, context.stack);
    },
  },
  checks: {
    name: "checks",
    fetch: async () => {
      const { failingCheckPrs, issueBodies } = await fetchChecksWorkData();
      return { kind: "checks", failingCheckPrs, issueBodies };
    },
    runUnit: async (unit, context) => {
      return fixOnePrChecks(unit as ChecksCandidate, context.stack);
    },
  },
  reviews: {
    name: "reviews",
    fetch: async () => {
      const { reviewActivityPrs, issueBodies, phoebeLogin } = await fetchReviewsWorkData();
      return { kind: "reviews", reviewActivityPrs, issueBodies, phoebeLogin };
    },
    runUnit: async (unit, context) => {
      return fixOnePrReviews(unit as ReviewsCandidate, context.phoebeLogin);
    },
  },
  issues: {
    name: "issues",
    fetch: async () => {
      const { issues, blockerStates } = fetchIssueWorkData();
      return { kind: "issues", issues, blockerStates };
    },
    runUnit: async (unit) => {
      return runIssueUnit(unit as IssueWorkUnit);
    },
  },
  research: {
    name: "research",
    fetch: async () => {
      const { researchIssues, blockerStates } = fetchResearchWorkData();
      return { kind: "research", researchIssues, blockerStates };
    },
    runUnit: async (unit) => {
      return runResearchUnit(unit as IssueWorkUnit);
    },
  },
};

type CycleWorkData = {
  issues: Issue[];
  researchIssues: Issue[];
  blockerStates: Map<number, BlockerPrState>;
  conflictingPrs: ConflictingPrCandidate[];
  failingCheckPrs: ChecksCandidate[];
  reviewActivityPrs: ReviewsCandidate[];
  issueBodies: Map<number, string>;
  phoebeLogin?: string;
  currentMainHead?: Sha;
};

async function fetchCycleWorkData(kinds: readonly WorkKindName[]): Promise<CycleWorkData> {
  let issues: Issue[] = [];
  let researchIssues: Issue[] = [];
  let blockerStates = new Map<number, BlockerPrState>();
  let conflictingPrs: ConflictingPrCandidate[] = [];
  let failingCheckPrs: ChecksCandidate[] = [];
  let reviewActivityPrs: ReviewsCandidate[] = [];
  let issueBodies = new Map<number, string>();
  let phoebeLogin: string | undefined;
  let currentMainHead: Sha | undefined;

  for (const kind of kinds) {
    const fetched = await KINDS[kind].fetch();
    if (fetched.kind === "issues") {
      issues = fetched.issues;
      for (const [number, state] of fetched.blockerStates) {
        blockerStates.set(number, state);
      }
    } else if (fetched.kind === "research") {
      researchIssues = fetched.researchIssues;
      for (const [number, state] of fetched.blockerStates) {
        blockerStates.set(number, state);
      }
    } else if (fetched.kind === "conflicts") {
      conflictingPrs = fetched.conflictingPrs;
      issueBodies = fetched.issueBodies;
      currentMainHead = fetched.currentMainHead;
    } else if (fetched.kind === "checks") {
      failingCheckPrs = fetched.failingCheckPrs;
      for (const [number, body] of fetched.issueBodies) {
        issueBodies.set(number, body);
      }
    } else {
      reviewActivityPrs = fetched.reviewActivityPrs;
      phoebeLogin = fetched.phoebeLogin;
      for (const [number, body] of fetched.issueBodies) {
        issueBodies.set(number, body);
      }
    }
  }

  const allBodies = [...issueBodies.entries()].map(([number, body]) => ({ number, body }));
  if (allBodies.length > 0) {
    const mergedBlockerStates = buildBlockerStatesFromBodies(allBodies);
    for (const [blockerIssue, state] of mergedBlockerStates) {
      blockerStates.set(blockerIssue, state);
    }
  }

  return {
    issues,
    researchIssues,
    blockerStates,
    conflictingPrs,
    failingCheckPrs,
    reviewActivityPrs,
    issueBodies,
    phoebeLogin,
    currentMainHead,
  };
}

function logIdleCycle(data: CycleWorkData): string {
  const phoebeBase = process.env["PHOEBE_BASE"];
  if (data.issues.length > 0 && !selectIssue(data.issues, data.blockerStates, phoebeBase)) {
    const reason = `${data.issues.length} ${config.readyLabel} issue(s) but none workable this cycle (blocked or waiting on blocker PR).`;
    console.log(`[phoebe] ${reason}`);
    return reason;
  }
  if (
    data.researchIssues.length > 0 &&
    !selectIssue(data.researchIssues, data.blockerStates, phoebeBase)
  ) {
    const reason = `${data.researchIssues.length} ${config.researchLabel} ticket(s) but none workable this cycle (blocked or waiting on blocker PR).`;
    console.log(`[phoebe] ${reason}`);
    return reason;
  }
  const stack: StackContext = { issueBodies: data.issueBodies, blockerStates: data.blockerStates };
  if (data.conflictingPrs.length > 0) {
    const conflictOpts = data.currentMainHead
      ? { currentMainHead: data.currentMainHead }
      : undefined;
    const { unit, skippedStacked, skippedWatermark } = summarizeConflictSelection(
      data.conflictingPrs,
      stack,
      conflictOpts,
    );
    if (skippedStacked > 0) {
      console.log(
        `[phoebe] ${skippedStacked} conflicting PR(s) skipped (stacked on open blocker).`,
      );
    }
    if (skippedWatermark > 0) {
      console.log(
        `[phoebe] ${skippedWatermark} conflicting PR(s) skipped (unchanged failure watermark).`,
      );
    }
    if (!unit) {
      const reason = `${data.conflictingPrs.length} conflicting PR(s) but none fixable this cycle.`;
      console.log(`[phoebe] ${reason}`);
      return reason;
    }
  }
  if (data.failingCheckPrs.length > 0) {
    const { unit, skipped } = summarizeChecksSelection(data.failingCheckPrs, stack);
    if (skipped > 0) {
      console.log(
        `[phoebe] ${skipped} failing-CI PR(s) skipped (conflicting, stacked, or watermarked).`,
      );
    }
    if (!unit) {
      const reason = `${data.failingCheckPrs.length} failing-CI PR(s) but none fixable this cycle.`;
      console.log(`[phoebe] ${reason}`);
      return reason;
    }
  }
  if (data.reviewActivityPrs.length > 0 && data.phoebeLogin) {
    const { unit, skipped } = summarizeReviewsSelection(
      data.reviewActivityPrs,
      stack,
      data.phoebeLogin,
    );
    if (skipped > 0) {
      console.log(
        `[phoebe] ${skipped} review-feedback PR(s) skipped (stacked, watermarked, or no new activity).`,
      );
    }
    if (!unit) {
      const reason = `${data.reviewActivityPrs.length} review-feedback PR(s) but none fixable this cycle.`;
      console.log(`[phoebe] ${reason}`);
      return reason;
    }
  }
  const reason = "No work this cycle — idle.";
  console.log(`[phoebe] ${reason}`);
  return reason;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeUnit(picked: WorkUnit): string {
  if (picked.kind === "conflicts") {
    const unit = picked.unit;
    return `conflict fix for PR #${unit.prNumber} (${unit.headRefName})`;
  }
  if (picked.kind === "checks") {
    const unit = picked.unit;
    return `checks fix for PR #${unit.prNumber} (${unit.headRefName})`;
  }
  if (picked.kind === "reviews") {
    const unit = picked.unit;
    return `review feedback for PR #${unit.prNumber} (${unit.headRefName})`;
  }
  if (picked.kind === "research") {
    const unit = picked.unit;
    return `research ticket #${unit.issue.number} — base ${unit.resolution.worktreeBase}`;
  }
  const unit = picked.unit;
  return `issue #${unit.issue.number} — base ${unit.resolution.worktreeBase}`;
}

function statusWork(
  picked: WorkUnit,
): Extract<RuntimeStatusTransition, { kind: "work-started" }>["work"] {
  if (picked.kind === "conflicts" || picked.kind === "checks" || picked.kind === "reviews") {
    return {
      kind: picked.kind,
      pullRequestNumber: picked.unit.prNumber,
      branch: picked.unit.headRefName,
      ...(picked.unit.issueNumber !== undefined ? { issueNumber: picked.unit.issueNumber } : {}),
    };
  }
  return {
    kind: picked.kind,
    issueNumber: picked.unit.issue.number,
    branch: issueBranch(picked.unit.issue.number),
  };
}

function pullRequestNumberAfterWork(picked: WorkUnit): number | undefined {
  if (picked.kind === "conflicts" || picked.kind === "checks" || picked.kind === "reviews") {
    return picked.unit.prNumber;
  }
  const branch = issueBranch(picked.unit.issue.number);
  try {
    const rows = ghJson<Array<{ number: number }>>([
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number",
      "--limit",
      "1",
    ]);
    return rows[0] ? asPrNumber(rows[0].number) : undefined;
  } catch (error) {
    console.warn(
      `[phoebe] Could not resolve the PR link for ${branch} — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/**
 * Drive the Phoebe worker loop until it exits (persistent mode) or completes
 * one unit (`--run-once`). Called by src/cli.ts after the resolved config is
 * installed; the CLI passes its argv with `--config <path>` already stripped
 * so this only sees engine-level flags.
 */
export async function runEngine(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const runOnce = argv.includes("--run-once");
  const dryRun = argv.includes("--dry-run");
  const rawPollIntervalMs = Number(process.env["PHOEBE_POLL_INTERVAL_MS"]);
  const pollIntervalMs =
    Number.isFinite(rawPollIntervalMs) && rawPollIntervalMs > 0
      ? rawPollIntervalMs
      : DEFAULT_POLL_INTERVAL_MS;
  const selectedProvider = selectProvider();
  const contractContext = buildRuntimeContractContext({
    config,
    providerName: selectedProvider.provider.name,
    model: selectedProvider.model,
    runtimeRoot: process.cwd(),
    env: process.env,
  });
  const status = createRuntimeStatusReporter({
    ...(inContainer ? { stateDir: config.paths.stateDir } : {}),
    ...(process.env["PHOEBE_RUNTIME_ID"] ? { runtimeId: process.env["PHOEBE_RUNTIME_ID"] } : {}),
    ...contractContext,
    secrets: [
      process.env["GH_TOKEN"] ?? "",
      ...Object.values(config.providerEnv).map((name) => process.env[name] ?? ""),
    ],
    onWriteError: (error) =>
      console.warn(
        `[phoebe] Runtime telemetry write failed — ${
          error instanceof Error ? error.message : String(error)
        }. Work will continue.`,
      ),
  });

  console.log(
    runOnce
      ? "[phoebe] Run-once mode — will work at most one unit of the first one-shot-eligible kind in WORK_ORDER, then exit."
      : `[phoebe] Persistent mode — idle poll every ${pollIntervalMs}ms. SIGTERM drains: finish the current unit, then exit 0.`,
  );
  if (dryRun) {
    console.log("[phoebe] Dry-run — selection only, nothing executes.");
  }

  // Bootstrap the private clone every work unit fetches/worktrees against. Only
  // in the container (on the host repoDir is the cwd, already a repo) and never
  // for --dry-run (selection uses the GitHub API, not a local clone). No-op once
  // the clone exists, so it's safe on every daemon restart.
  if (inContainer && !dryRun) {
    ensureClone({ repoUrl: config.repoUrl, repoDir });
  }

  // `phoebe boot` stops the engine with SIGTERM (container shutdown, and later a
  // config/ref change). Drain gracefully rather than dying mid-unit: finish the
  // unit in flight, start no new one, then return (exit 0). The wait below wakes
  // early on drain so an idle poll-sleep does not stall shutdown.
  const drain = installDrainSignal();
  let failed = false;
  try {
    await runLoop({ runOnce, dryRun, pollIntervalMs, drain, status });
  } catch (error) {
    failed = true;
    status.record({ kind: "engine-failed", error });
    throw error;
  } finally {
    if (!failed) status.record({ kind: "stopped" });
    drain.dispose();
  }
}

async function runLoop({
  runOnce,
  dryRun,
  pollIntervalMs,
  drain,
  status,
}: {
  runOnce: boolean;
  dryRun: boolean;
  pollIntervalMs: number;
  drain: DrainSignal;
  status: ReturnType<typeof createRuntimeStatusReporter>;
}): Promise<void> {
  while (true) {
    if (drain.requested) {
      console.log("[phoebe] Drain requested — starting no new work unit; exiting 0.");
      status.record({
        kind: "draining",
        reason: "Drain requested — starting no new work unit.",
      });
      break;
    }
    status.record({ kind: "selecting" });
    const fetchKinds = runOnce ? oneShotWorkKinds(workOrder) : workOrder;
    const data = await fetchCycleWorkData(fetchKinds);
    const picked = selectFirstWorkUnit(
      workOrder,
      {
        issues: data.issues,
        researchIssues: data.researchIssues,
        blockerStates: data.blockerStates,
        conflictingPrs: data.conflictingPrs,
        failingCheckPrs: data.failingCheckPrs,
        reviewActivityPrs: data.reviewActivityPrs,
        issueBodies: data.issueBodies,
        phoebeBase: process.env["PHOEBE_BASE"],
        phoebeLogin: data.phoebeLogin,
        currentMainHead: data.currentMainHead,
      },
      { oneShotOnly: runOnce },
    );

    if (!picked) {
      if (runOnce) {
        console.log(RUN_ONCE_NOTHING_MESSAGE);
        status.record({ kind: "idle", reason: RUN_ONCE_NOTHING_MESSAGE });
      } else {
        status.record({ kind: "idle", reason: logIdleCycle(data) });
      }
      if (runOnce || dryRun) break;
      // Interruptible idle poll — a SIGTERM mid-sleep wakes it, the next
      // iteration's drain check breaks, and shutdown does not wait a full cycle.
      await drain.wait(pollIntervalMs);
      continue;
    }

    // A drain that arrived during the fetch/selection above must not let this
    // freshly-picked unit start — "start no new one". The in-flight unit (if any)
    // already finished before we looped back here, so exit now.
    if (drain.requested) {
      console.log("[phoebe] Drain requested before starting the next unit — exiting 0.");
      status.record({
        kind: "draining",
        reason: "Drain requested before starting the next unit.",
      });
      break;
    }

    const decision = executionDecision({ dryRun, inContainer });
    if (decision === "dry-run") {
      const reason = `Would execute: ${describeUnit(picked)}.`;
      console.log(`[phoebe] ${reason}`);
      status.record({ kind: "idle", reason });
      break;
    }
    if (decision === "refuse") {
      console.error(EXECUTION_REFUSED_MESSAGE);
      status.record({ kind: "engine-failed", error: EXECUTION_REFUSED_MESSAGE });
      process.exit(1);
    }

    status.record({ kind: "work-started", work: statusWork(picked) });
    try {
      const agentExitCode = await KINDS[picked.kind].runUnit(picked.unit, {
        stack: { issueBodies: data.issueBodies, blockerStates: data.blockerStates },
        phoebeLogin: data.phoebeLogin ?? "",
      });
      const pullRequestNumber = pullRequestNumberAfterWork(picked);
      if (agentExitCode !== null && agentExitCode !== 0) {
        status.record({
          kind: "work-failed",
          error: new Error(`Agent exited with code ${agentExitCode}.`),
          ...(pullRequestNumber !== undefined ? { pullRequestNumber } : {}),
          resources: {
            agentExitCode,
            summary: "The work unit completed its cleanup after a nonzero agent exit.",
          },
        });
      } else {
        status.record({
          kind: "work-completed",
          ...(pullRequestNumber !== undefined ? { pullRequestNumber } : {}),
          ...(agentExitCode === null
            ? {}
            : {
                resources: {
                  agentExitCode,
                  summary: "The work unit completed after a successful agent run.",
                },
              }),
        });
      }
    } catch (error) {
      status.record({ kind: "work-failed", error });
      if (runOnce) {
        throw error;
      }
      // A failed unit must not kill the daemon — prepareWorktree clears any
      // stale worktree on the next attempt.
      console.error(
        `[phoebe] Failed executing ${describeUnit(picked)} — ${error instanceof Error ? error.message : String(error)}`,
      );
      await drain.wait(pollIntervalMs);
      continue;
    }

    if (runOnce) break;
    // Drain requested while the unit ran: it is finished, so exit now rather
    // than picking up another. This is the graceful-drain boundary.
    if (drain.requested) {
      console.log("[phoebe] Finished the in-flight unit under drain — exiting 0.");
      status.record({
        kind: "draining",
        reason: "Finished the in-flight unit under drain.",
      });
      break;
    }
  }
}
