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
import { installDrainSignal, REF_CHANGE_DRAIN_SIGNAL, type DrainSignal } from "./drain.ts";
import { BrokerDisconnectedError, createSlotClient, type SlotClient } from "./slot-client.ts";
import { RunTimeoutError, resolveRunTimeoutMs, runWithDeadline } from "./run-timeout.ts";
import {
  buildLeaseComment,
  buildReclaimComment,
  claimIssueLabels,
  leaseHeartbeatIntervalMs,
  parseLeaseMarker,
  reclaimDecision,
  resolveLeaseTtlMs,
} from "./claim-lease.ts";
import {
  createEmitUnitEvent,
  STATUS_FILE,
  type EmitUnitEvent,
  type UnitRef,
} from "./unit-event.ts";
import {
  buildQuarantineComment,
  buildUnitAttemptMarker,
  buildUnitTimeoutMarker,
  decideTimeoutRecord,
  findLatestUnitAttemptComment,
  PHOEBE_QUARANTINE_LABEL,
  planUnitAttempt,
  resolveMaxUnitAttempts,
  resolveMaxUnitTimeouts,
} from "./quarantine.ts";
import { join } from "node:path";
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
  readVerificationReport,
  removeVerificationReport,
  type VerificationResult,
} from "./verification.ts";
import {
  buildInitialPrBody,
  buildReviewsHandledComment,
  checksFailureSignature,
  checksFixFailureComment,
  conflictFailureSignature,
  conflictFixFailureComment,
  filterBackoffEligible,
  findBlockedDependents,
  followUpPrComment,
  formatFailingChecksForPrompt,
  formatIssueRef,
  isReviewSummaryComment,
  issueAttemptFailureSignature,
  issueBranch,
  isPrInScope,
  isPrMergeConflicting,
  listFailingChecks,
  newestReviewThreadCommentCreatedAt,
  mergeBlockerNumbers,
  parseBlockedBy,
  parseLatestMarker,
  parseChecksFailWatermark,
  parseConflictFailWatermark,
  parseReviewsHandledWatermark,
  parseIssueNumberFromBranch,
  getMergedBlockerPrNumbers,
  ghStackExtensionInstallArgs,
  nativeStackGitConfig,
  oneShotWorkKinds,
  resolveStackedPrPlan,
  selectStackRetargetCandidates,
  stackedCatchUpRetractionComment,
  stackRetargetedComment,
  RUN_ONCE_NOTHING_MESSAGE,
  buildIssueQueue,
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
  type NativeBlockerMap,
  type ReviewThread,
  type ReviewsCandidate,
  type StackContext,
  type StatusCheckItem,
  type WorkflowRunItem,
  type WorkKindName,
  type WorkUnit,
} from "./orchestrator.ts";

const DEFAULT_POLL_INTERVAL_MS = 300_000;
// Whole-unit wall-clock budget (#72): the agent phase — the async, hang-prone
// step — runs under this deadline, so a hung unit releases its #59 slot within
// a known ceiling instead of starving the fleet. Env (`PHOEBE_RUN_TIMEOUT_MS`)
// overrides the config field.
const RUN_TIMEOUT_MS = resolveRunTimeoutMs(process.env, config.runTimeoutMs);
// Crash-safe claims (#15): how long a `processingLabel` lease may go without a
// heartbeat before the reclaim sweep flips it back to `readyLabel`. Env
// (`PHOEBE_LEASE_TTL_MS`) overrides the config field.
const LEASE_TTL_MS = resolveLeaseTtlMs(process.env, config.leaseTtlMs);
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

function selectProvider(): { provider: Provider; model: string } {
  const name = process.env["PHOEBE_AGENT"] ?? config.defaultProvider;
  if (!(PROVIDER_NAMES as readonly string[]).includes(name)) {
    throw new Error(`Unknown PHOEBE_AGENT "${name}". Use one of: ${PROVIDER_NAMES.join(", ")}.`);
  }
  const provider = PROVIDERS[name as ProviderName];
  const model = process.env["PHOEBE_MODEL"] ?? config.defaultModels[name as ProviderName];
  return { provider, model };
}

const workOrder = validateWorkOrder(config.workOrder);

// ---------------------------------------------------------------------------
// gh helpers — always pinned to the configured repo
// ---------------------------------------------------------------------------

function ghJson<T>(args: string[], repo: string = config.repoSlug): T {
  return JSON.parse(
    execFileSync("gh", [...args, "-R", repo], {
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

function gh(args: string[], opts?: { input?: string }, repo: string = config.repoSlug): void {
  execFileSync("gh", [...args, "-R", repo], {
    stdio: opts?.input !== undefined ? ["pipe", "inherit", "inherit"] : "inherit",
    timeout: CHILD_PROCESS_TIMEOUT_MS,
    ...(opts?.input !== undefined ? { input: opts.input } : {}),
  });
}

/**
 * Register a native GitHub stack for a freshly-created stacked PR (native mode
 * only). The argv is built purely by `resolveStackedPrPlan`; this only runs it.
 * `gh stack link` ships in the `github/gh-stack` extension that
 * `prepareNativeStackTooling` installs. Non-fatal by design: the PR already
 * bases off the blocker branch, so a link failure leaves a functioning stack
 * that merely is not registered — we warn and let the completed run stand
 * rather than abort it.
 *
 * LIVE-VERIFY: this goes through the `gh` wrapper, which appends `-R <slug>`.
 * gh-stack is a two-day-old public-preview extension; confirm it tolerates the
 * trailing `-R` (and that `link` over two branches that already have PRs never
 * rewrites their titles).
 */
function registerNativeStack(stackLinkArgs: string[]): void {
  try {
    gh(stackLinkArgs);
  } catch (error) {
    console.warn(
      `[phoebe] gh stack link failed — the PR bases off the blocker branch but is not ` +
        `registered as a native stack. Register it manually with \`gh ${stackLinkArgs.join(" ")}\`. ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/**
 * One-time, native-mode-only setup on the private clone: pre-set the
 * non-interactive git config gh-stack and cascade-rebase expect, then install
 * the gh-stack extension. Idempotent and best-effort — `gh extension install`
 * errors when the extension is already present, which we swallow. Run at boot
 * (guarded by `stackMode === 'native'`) rather than baked into the image, so the
 * default banner/off image carries no gh-stack dependency and needs no
 * build-time network or auth to install it.
 */
function prepareNativeStackTooling(): void {
  for (const args of nativeStackGitConfig()) {
    gitInWorktree(repoDir, [...args]);
  }
  try {
    // No `-R`: extension install is not repo-scoped, so bypass the `gh` wrapper.
    execFileSync("gh", [...ghStackExtensionInstallArgs()], {
      stdio: "inherit",
      timeout: CHILD_PROCESS_TIMEOUT_MS,
    });
  } catch (error) {
    console.warn(
      `[phoebe] gh-stack extension not installed (already present, or offline at boot). ` +
        `Native stacking needs it — install with \`gh ${ghStackExtensionInstallArgs().join(" ")}\`. ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/**
 * Fail loudly at boot when the configured token cannot read the issue source
 * repo (#21). The two repos may need different token scopes, so a bare `gh`
 * failure the first time the poll loop tries to list issues is a worse first
 * signal than a boot crash naming the repo. Only probes when `issueSource`
 * actually points somewhere other than the work repo — the work repo's own
 * reachability is already proven by `ensureClone` above.
 */
function verifyIssueSourceAccess(): void {
  if (config.issueSource.repoSlug === config.repoSlug) return;
  try {
    execFileSync("gh", ["repo", "view", config.issueSource.repoSlug, "--json", "id"], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: CHILD_PROCESS_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(
      `[phoebe] Cannot read issueSource repo "${config.issueSource.repoSlug}" with the ` +
        `configured GH_TOKEN. The work repo and issue source may need different token ` +
        `scopes — verify the token can read issues on the source repo. ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/**
 * Open issues carrying `label`, oldest-created first. Shared by `issues` and
 * `research`. Defaults to `issueSource.repoSlug` (#21) — the same repo as
 * `repoSlug` unless the tenant configured a separate issue source.
 */
function listIssuesWithLabel(label: string, repo: string = config.issueSource.repoSlug): Issue[] {
  type GhIssue = Omit<Issue, "labels"> & { labels: Array<{ name: string }> };
  return ghJson<GhIssue[]>(
    [
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
    ],
    repo,
  ).map((row) => ({
    number: row.number,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt,
    labels: row.labels.map((l) => l.name),
  }));
}

function listReadyIssues(): Issue[] {
  return listIssuesWithLabel(config.issueSource.readyLabel);
}

function listResearchIssues(): Issue[] {
  return listIssuesWithLabel(config.researchLabel);
}

/**
 * Self-recovery sweep for orphaned `processingLabel` claims (#15). Every
 * `processingLabel` issue's lease marker (its latest matching comment) is
 * read back and, per `reclaimDecision`, flipped back to `readyLabel` when it
 * has no marker, is this runtime's own claim from before a restart
 * (`forceOwnReclaim`, boot only), or its heartbeat has gone stale past the
 * TTL. A quarantined issue (#75) is left alone — that label already means a
 * human needs to look at it.
 */
function reclaimStaleClaims(runtimeId: string, opts: { forceOwnReclaim: boolean }): void {
  const nowMs = Date.now();
  for (const issue of listIssuesWithLabel(config.processingLabel)) {
    if (issue.labels.includes(PHOEBE_QUARANTINE_LABEL)) continue;
    const lease = parseLatestMarker(fetchIssueCommentBodies(issue.number), parseLeaseMarker);
    const reason = reclaimDecision(lease, {
      ownRuntimeId: runtimeId,
      nowMs,
      ttlMs: LEASE_TTL_MS,
      forceOwnReclaim: opts.forceOwnReclaim,
    });
    if (reason === null) continue;
    console.log(
      `[phoebe] Reclaiming #${issue.number} (${reason}) back to ${config.issueSource.readyLabel}.`,
    );
    gh(
      [
        "issue",
        "edit",
        String(issue.number),
        "--add-label",
        config.issueSource.readyLabel,
        "--remove-label",
        config.processingLabel,
      ],
      undefined,
      config.issueSource.repoSlug,
    );
    postIssueComment(issue.number, buildReclaimComment(reason));
  }
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

/**
 * Native blocker issue numbers from GitHub's issue-dependencies API. Returns
 * `[]` for the no-dependencies case and on any `gh` failure — a native read must
 * never crash the poll loop; in `both` mode the caller still falls through to
 * the body regex. Parses each dependency to `{ number, state }`; only `number`
 * feeds the stacking machinery (blocker PR state, not issue state, drives the
 * base decision), matching the body-regex path exactly.
 */
function fetchNativeBlockers(issueNumber: number): Array<{ number: number; state: string }> {
  try {
    const rows = ghApiJson<Array<{ number: number; state: string }>>(
      `repos/${config.issueSource.repoSlug}/issues/${issueNumber}/dependencies/blocked_by`,
    );
    return Array.isArray(rows) ? rows.map((row) => ({ number: row.number, state: row.state })) : [];
  } catch (error) {
    console.warn(
      `[phoebe] Native blocker lookup failed for #${issueNumber} — treating as no native blockers this cycle (${error instanceof Error ? error.message : String(error)}).`,
    );
    return [];
  }
}

/**
 * Native blockers keyed by issue number for the given issues. Empty (and makes
 * zero `gh` calls) under `blockerSource: "body"` so the default costs nothing;
 * `native`/`both` do one API read per issue.
 */
function buildNativeBlockersByIssue(issues: readonly Issue[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  if (config.blockerSource === "body") {
    return map;
  }
  for (const issue of issues) {
    const native = fetchNativeBlockers(issue.number).map((row) => row.number);
    if (native.length > 0) {
      map.set(issue.number, native);
    }
  }
  return map;
}

function buildBlockerStates(
  issues: readonly Issue[],
  nativeBlockersByIssue: NativeBlockerMap = new Map(),
): Map<number, BlockerPrState> {
  const blockerNumbers = new Set<number>();
  for (const issue of issues) {
    const merged = mergeBlockerNumbers(
      parseBlockedBy(issue.body),
      nativeBlockersByIssue.get(issue.number) ?? [],
    );
    for (const n of merged) {
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

/**
 * Edit an existing PR comment in place — no new comment, no new notification.
 * The #25 no-commit-attempt tracker relies on this: it silently updates one
 * comment across retries instead of posting a fresh one every attempt. Uses
 * the GraphQL `id` (not the REST numeric id), so it goes through `gh api
 * graphql` rather than the repo-scoped `gh` wrapper.
 */
function updateComment(commentId: string, body: string): void {
  execFileSync(
    "gh",
    [
      "api",
      "graphql",
      "-f",
      "query=mutation($id:ID!,$body:String!){updateIssueComment(input:{id:$id, body:$body}){issueComment{id}}}",
      "-f",
      `id=${commentId}`,
      "-f",
      `body=${body}`,
    ],
    { stdio: "inherit", timeout: CHILD_PROCESS_TIMEOUT_MS },
  );
}

/** Post `body` as a new comment, or edit `existingCommentId` in place if one is given. */
function postOrUpdateComment(
  prNumber: PrNumber,
  body: string,
  existingCommentId: string | undefined,
): void {
  if (existingCommentId) {
    updateComment(existingCommentId, body);
  } else {
    postPrComment(prNumber, body);
  }
}

function postIssueComment(issueNumber: number, body: string): void {
  gh(
    ["issue", "comment", String(issueNumber), "--body", body],
    undefined,
    config.issueSource.repoSlug,
  );
}

type OpenPhoebePr = {
  number: PrNumber;
  headRefName: BranchRef;
  baseRefName: BranchRef;
  authorLogin: string;
};

// --- Poison-unit quarantine write path (#75) ---------------------------------
// The read/skip half ships in orchestrator.ts (it filters `phoebe:quarantined`
// out of selection). This is the missing write half: on a whole-unit timeout,
// count consecutive timeouts on the unit itself (a GitHub marker) and, at K,
// apply the label + escalation comment so the poisonous unit stops being
// re-picked. Kept thin over `gh`; the count/threshold policy is pure in
// quarantine.ts (`decideTimeoutRecord`).

type TimeoutComment = { body: string; createdAt: string; authorLogin: string };

type UnitTimeoutInputs = {
  /** Comments (body + createdAt + authorLogin), oldest-first — fed to `decideTimeoutRecord`. */
  comments: TimeoutComment[];
  /** Extra external-activity instant (a PR head push), or null — a further reset signal. */
  extraActivityAt: string | null;
  /** Recorded in the escalation comment for the future auto-un-stick sweep. */
  baseline: string;
};

type GhTimeoutComment = { body: string; createdAt: string; author: { login: string } | null };

function toTimeoutComments(comments: readonly GhTimeoutComment[]): TimeoutComment[] {
  // `author` is null for a deleted account; coerce to "" (a foreign author, never
  // Phoebe) rather than letting the deref throw and skip the whole timeout record.
  return comments.map((c) => ({
    body: c.body,
    createdAt: c.createdAt,
    authorLogin: c.author?.login ?? "",
  }));
}

function fetchIssueTimeoutInputs(issueNumber: number): UnitTimeoutInputs {
  const raw = ghJson<{ updatedAt: string; comments: GhTimeoutComment[] }>([
    "issue",
    "view",
    String(issueNumber),
    "--json",
    "comments,updatedAt",
  ]);
  // Issues have no commits and `gh` does not expose body-edit times, so a new
  // human comment is the only reset signal; `updatedAt` is the un-stick baseline.
  return {
    comments: toTimeoutComments(raw.comments),
    extraActivityAt: null,
    baseline: raw.updatedAt,
  };
}

function fetchPrTimeoutInputs(prNumber: PrNumber): UnitTimeoutInputs {
  const raw = ghJson<{
    headRefOid: string;
    comments: GhTimeoutComment[];
    commits: Array<{ committedDate: string }>;
  }>(["pr", "view", String(prNumber), "--json", "comments,commits,headRefOid"]);
  // A new push (head commit) or human comment resets; head SHA is the baseline.
  const headCommitAt =
    raw.commits.length > 0 ? raw.commits[raw.commits.length - 1]!.committedDate : null;
  return {
    comments: toTimeoutComments(raw.comments),
    extraActivityAt: headCommitAt,
    baseline: raw.headRefOid,
  };
}

function postUnitComment(isIssueKind: boolean, id: string, body: string): void {
  gh([isIssueKind ? "issue" : "pr", "comment", id, "--body", body]);
}

function addQuarantineLabel(isIssueKind: boolean, id: string): void {
  gh([isIssueKind ? "issue" : "pr", "edit", id, "--add-label", PHOEBE_QUARANTINE_LABEL]);
}

/**
 * Record one whole-unit timeout toward the poison-unit quarantine (#75): read the
 * latest timeout marker on the unit, post the incremented count, and at K apply
 * `phoebe:quarantined` + the escalation comment so selection starts skipping it.
 * Best-effort — a GitHub write failure here is logged and swallowed so it can
 * never take the daemon down (the timeout itself is already recorded).
 */
function recordUnitTimeout(picked: WorkUnit, phoebeLogin: string, emit: EmitUnitEvent): void {
  const ref = unitRef(picked);
  const isIssueKind = picked.kind === "issues" || picked.kind === "research";
  try {
    // `data.phoebeLogin` is only populated when the `reviews` kind was fetched
    // this cycle, but any kind can time out — resolve it directly when absent so
    // Phoebe's own timeout markers are never mistaken for reset-triggering
    // foreign activity (which would reset the count every rotation and never
    // quarantine). Timeouts are rare, so the extra `gh api user` is cheap.
    const login = phoebeLogin || phoebeGhLogin();
    const k = resolveMaxUnitTimeouts(process.env, config.maxUnitTimeouts);
    const inputs = isIssueKind
      ? fetchIssueTimeoutInputs(Number(ref.id))
      : fetchPrTimeoutInputs(asPrNumber(Number(ref.id)));
    const { count, quarantine } = decideTimeoutRecord({
      comments: inputs.comments,
      phoebeLogin: login,
      extraActivityAt: inputs.extraActivityAt,
      k,
    });
    postUnitComment(isIssueKind, ref.id, buildUnitTimeoutMarker(count));
    if (quarantine) {
      addQuarantineLabel(isIssueKind, ref.id);
      postUnitComment(
        isIssueKind,
        ref.id,
        buildQuarantineComment({
          kind: ref.kind,
          id: Number(ref.id),
          k: count,
          baseline: inputs.baseline,
          reason: "timed out",
        }),
      );
      emit({
        unit: ref,
        event: "quarantined",
        detail: `timed out ${count}× — labelled ${PHOEBE_QUARANTINE_LABEL}`,
      });
    }
  } catch (error) {
    console.error(
      `[phoebe] Could not record timeout toward quarantine for ${ref.kind} #${ref.id} — ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

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

type PrComment = { id: string; body: string };

/** Every comment on a PR (id + body), oldest first — the raw input to every marker parse. */
function fetchPrComments(prNumber: PrNumber): PrComment[] {
  const { comments } = ghJson<{ comments: PrComment[] }>([
    "pr",
    "view",
    String(prNumber),
    "--json",
    "comments",
  ]);
  return comments;
}

/** All comment bodies on a PR, oldest first — the raw input to every watermark parse. */
function fetchPrCommentBodies(prNumber: PrNumber): string[] {
  return fetchPrComments(prNumber).map((comment) => comment.body);
}

function phoebeGhLogin(): string {
  return ghApiJson<{ login: string }>("user").login;
}

function issueBody(issueNumber: number): string {
  return ghJson<{ body: string }>(
    ["issue", "view", String(issueNumber), "--json", "body"],
    config.issueSource.repoSlug,
  ).body;
}

/** ISO timestamp of an issue's last edit — the #22/#75 auto-unstick baseline for issue-keyed units. */
function issueUpdatedAt(issueNumber: number): string {
  return ghJson<{ updatedAt: string }>(
    ["issue", "view", String(issueNumber), "--json", "updatedAt"],
    config.issueSource.repoSlug,
  ).updatedAt;
}

type IssueComment = { id: string; body: string };

/** Every comment on an issue (id + body), oldest first — the raw input to every marker parse. */
function fetchIssueComments(issueNumber: number): IssueComment[] {
  const { comments } = ghJson<{ comments: IssueComment[] }>(
    ["issue", "view", String(issueNumber), "--json", "comments"],
    config.issueSource.repoSlug,
  );
  return comments;
}

/** All comment bodies on an issue, oldest first — the raw input to the #15 lease-marker lookup. */
function fetchIssueCommentBodies(issueNumber: number): string[] {
  return fetchIssueComments(issueNumber).map((comment) => comment.body);
}

/** Post `body` as a new issue comment, or edit `existingCommentId` in place if one is given. */
function postOrUpdateIssueComment(
  issueNumber: number,
  body: string,
  existingCommentId: string | undefined,
): void {
  if (existingCommentId) {
    updateComment(existingCommentId, body);
  } else {
    postIssueComment(issueNumber, body);
  }
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

/**
 * Record one failed (no-commit) attempt on a PR-keyed unit (#25): find the
 * unit's tracking comment (if any), fold this attempt into its counter, and
 * either edit that comment in place (below threshold — no new comment, no new
 * notification) or escalate it into the quarantine comment and apply the
 * label (at threshold). Never posts more than the one tracking comment per
 * unit, so identical repeated failures add no new comments — only the fix for
 * "76 comments, 0 progress" (#25).
 */
function recordFailedAttempt(opts: {
  kind: "conflict" | "checks";
  prNumber: PrNumber;
  currentPrHead: Sha;
  signature: string;
  failureComment: string;
}): void {
  const comments = fetchPrComments(opts.prNumber);
  const found = findLatestUnitAttemptComment(comments, opts.kind);
  const k = resolveMaxUnitAttempts(process.env, config.maxUnitAttempts);
  const plan = planUnitAttempt({
    previous: found?.marker ?? null,
    ref: opts.currentPrHead,
    signature: opts.signature,
    now: new Date().toISOString(),
    k,
  });

  const body = plan.quarantined
    ? buildQuarantineComment({
        kind: opts.kind,
        id: opts.prNumber,
        k,
        baseline: opts.currentPrHead,
        reason: "produced no commit",
        signature: opts.signature,
      })
    : opts.failureComment;
  postOrUpdateComment(
    opts.prNumber,
    `${body}\n\n${buildUnitAttemptMarker(opts.kind, plan.marker)}`,
    found?.commentId,
  );

  if (plan.quarantined) {
    gh(["pr", "edit", String(opts.prNumber), "--add-label", PHOEBE_QUARANTINE_LABEL]);
    console.log(
      `[phoebe] Quarantined ${opts.kind} unit for PR #${opts.prNumber} after ${plan.marker.n} attempts with no commit (${opts.signature}).`,
    );
  }
}

/**
 * Record one failed (no-PR) claim→release cycle on an issue-keyed unit (#22):
 * the issues/research sibling of `recordFailedAttempt` (#25), since these
 * units fail fast at verification rather than hang, so #75's timeout counter
 * never sees them. `ref` is fixed to the issue number rather than a moving
 * head SHA — an issue-keyed unit has no in-progress ref to stale-check
 * against, so the reset on progress is explicit (`resetIssueAttemptCounter`)
 * instead of inferred from `ref` advancing.
 */
function recordFailedIssueAttempt(opts: {
  kind: "issues" | "research";
  issueNumber: number;
  signature: string;
  dependentsPool: readonly Issue[];
  nativeBlockersByIssue: NativeBlockerMap;
}): void {
  const comments = fetchIssueComments(opts.issueNumber);
  const found = findLatestUnitAttemptComment(comments, opts.kind);
  const k = resolveMaxUnitAttempts(process.env, config.maxUnitAttempts);
  const plan = planUnitAttempt({
    previous: found?.marker ?? null,
    ref: String(opts.issueNumber),
    signature: opts.signature,
    now: new Date().toISOString(),
    k,
  });

  const body = plan.quarantined
    ? buildQuarantineComment({
        kind: opts.kind,
        id: opts.issueNumber,
        k,
        baseline: issueUpdatedAt(opts.issueNumber),
        reason: "was claimed and released with no PR",
        signature: opts.signature,
        dependents: findBlockedDependents(
          opts.issueNumber,
          opts.dependentsPool,
          opts.nativeBlockersByIssue,
        ),
      })
    : `⚠️ Phoebe claimed this ${opts.kind === "issues" ? "issue" : "research ticket"} and released it ` +
      `with no PR (attempt ${plan.marker.n}/${k}, \`${opts.signature}\`). It stays in the ready queue ` +
      `and will retry once the claim lease expires.`;
  postOrUpdateIssueComment(
    opts.issueNumber,
    `${body}\n\n${buildUnitAttemptMarker(opts.kind, plan.marker)}`,
    found?.commentId,
  );

  if (plan.quarantined) {
    gh(["issue", "edit", String(opts.issueNumber), "--add-label", PHOEBE_QUARANTINE_LABEL]);
    console.log(
      `[phoebe] Quarantined ${opts.kind} #${opts.issueNumber} after ${plan.marker.n} claims with no PR (${opts.signature}).`,
    );
  }
}

/**
 * Clear the #22 no-PR attempt counter once a run produces a PR: edit the
 * tracking comment (if any) to drop the marker, so the next failure's
 * `findLatestUnitAttemptComment` reads no prior marker and starts at 1 again.
 * A unit that never failed has no tracking comment — nothing to reset.
 */
function resetIssueAttemptCounter(issueNumber: number, kind: "issues" | "research"): void {
  const comments = fetchIssueComments(issueNumber);
  const found = findLatestUnitAttemptComment(comments, kind);
  if (!found) {
    return;
  }
  updateComment(
    found.commentId,
    `✅ Phoebe produced a PR for this ${kind === "issues" ? "issue" : "research ticket"} — the no-PR attempt counter is reset.`,
  );
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

/**
 * Where the agent is told to write its post-verify report (#17). Kept as a
 * sibling of the worktree, not inside it — so nothing the agent does inside
 * the worktree (a stray `git add -A`, a clean/reset) can sweep it into a
 * commit or delete it as untracked cruft.
 */
function verificationReportPath(worktreeDir: string): string {
  return `${worktreeDir}.verification.json`;
}

/**
 * Claim an issue (#15): post the lease marker comment *before* flipping the
 * label, so `processingLabel` present always implies a durable claim marker
 * exists — never the reverse race (a label with no marker to reclaim by).
 *
 * The label flip itself is add-processingLabel-then-remove-readyLabel, as two
 * explicit calls (#81) rather than one combined `gh issue edit`, so a failure
 * between them leaves both labels — recoverable by the reclaim sweep — rather
 * than neither, which nothing can find.
 */
function claimIssueLease(opts: {
  issueNumber: number;
  branch: BranchRef;
  runtimeId: string;
  claimedAt: string;
}): void {
  postIssueComment(
    opts.issueNumber,
    buildLeaseComment({
      runtimeId: opts.runtimeId,
      claimedAt: opts.claimedAt,
      heartbeatAt: opts.claimedAt,
      branch: opts.branch,
    }),
  );
  claimIssueLabels(
    {
      issueNumber: opts.issueNumber,
      processingLabel: config.processingLabel,
      readyLabel: config.issueSource.readyLabel,
      repoSlug: config.issueSource.repoSlug,
    },
    gh,
  );
}

/**
 * Refresh the lease's heartbeat while a claim is held, so the reclaim sweep
 * never yanks a slow-but-alive run. Returns a disposer that stops the timer;
 * callers must invoke it once the run ends, success or failure alike. A
 * failed heartbeat post is logged and swallowed — the run keeps going, and it
 * only risks reclaim once the full TTL elapses without ever landing one.
 */
function startLeaseHeartbeat(opts: {
  issueNumber: number;
  branch: BranchRef;
  runtimeId: string;
  claimedAt: string;
  ttlMs: number;
}): () => void {
  const timer = setInterval(() => {
    try {
      postIssueComment(
        opts.issueNumber,
        buildLeaseComment({
          runtimeId: opts.runtimeId,
          claimedAt: opts.claimedAt,
          heartbeatAt: new Date().toISOString(),
          branch: opts.branch,
        }),
      );
    } catch (error) {
      console.warn(
        `[phoebe] Lease heartbeat failed for #${opts.issueNumber} — ${
          error instanceof Error ? error.message : String(error)
        }.`,
      );
    }
  }, leaseHeartbeatIntervalMs(opts.ttlMs));
  timer.unref();
  return () => clearInterval(timer);
}

async function runAgentInWorktree(opts: {
  worktreeDir: string;
  promptFile: string;
  promptArgs: Record<string, string>;
}): Promise<number> {
  const { provider, model } = selectProvider();
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
  // Bound the *agent phase* by the run budget (#72) — the one phase where a hang
  // is abortable (the agent respects the `AbortSignal`); install/test run via
  // `execSync` outside this deadline. On expiry the deadline aborts the signal,
  // `runAgent` kills the child, and a `RunTimeoutError` propagates — caught at
  // the unit boundary (the daemon logs it, releases the #59 slot in `finally`,
  // and continues; #75 counts it toward quarantine).
  const { exitCode } = await runWithDeadline({
    ms: RUN_TIMEOUT_MS,
    work: (signal) =>
      runAgent({
        provider,
        model,
        prompt,
        cwd: opts.worktreeDir,
        env,
        signal,
      }),
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

/** What every `runUnit` reports back to the main loop for telemetry. */
type UnitResult = { exitCode: number | null; verification?: readonly VerificationResult[] };

/**
 * The shared skeleton behind every PR-fix agent: snapshot origin, prepare a
 * worktree, install, optionally prime the tree, run the agent, then re-snapshot
 * origin and count the host-side commits. Only `onResult` differs per work kind
 * (push vs. failure comment vs. watermark); the worktree is always removed.
 *
 * The agent is prompted to write a verification report as part of its own
 * verify step (#17); this reads it back after the agent exits. A missing or
 * malformed report just means `verification` comes back undefined — the
 * engine never re-runs the gate itself.
 */
async function runAgentWorkflow(opts: {
  pr: { prNumber: PrNumber; headRefName: BranchRef };
  promptFile: string;
  promptArgs: Record<string, string>;
  beforeAgent?: (worktreeDir: string) => void;
  onResult: (result: AgentWorkflowResult) => void | Promise<void>;
}): Promise<UnitResult> {
  const branch = opts.pr.headRefName;

  fetchOrigin();
  const originShaBefore = originBranchSha(branch);

  const worktreeDir = prepareWorktree({ branch });
  const reportPath = verificationReportPath(worktreeDir);
  removeVerificationReport(reportPath);
  try {
    runShellCommand(config.installCommand, worktreeDir);
    opts.beforeAgent?.(worktreeDir);

    const agentExitCode = await runAgentInWorktree({
      worktreeDir,
      promptFile: opts.promptFile,
      promptArgs: { ...opts.promptArgs, VERIFICATION_RESULT_FILE: reportPath },
    });
    const verification = readVerificationReport(reportPath);

    fetchOrigin();
    const originShaAfter = originBranchSha(branch);
    const localCommitCount = commitCount(worktreeDir, `origin/${branch}..HEAD`);

    await opts.onResult({ worktreeDir, branch, originShaBefore, originShaAfter, localCommitCount });
    return { exitCode: agentExitCode, verification };
  } finally {
    removeVerificationReport(reportPath);
    removeWorktree(repoDir, worktreeDir);
  }
}

async function runConflictResolutionAgent(
  pr: ConflictingPrCandidate,
  mergedBlockerPrNumbers: readonly PrNumber[],
): Promise<UnitResult> {
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
        const watermark = currentConflictFailureWatermark(pr.headRefName, baseBranch);
        recordFailedAttempt({
          kind: "conflict",
          prNumber: pr.prNumber,
          currentPrHead: watermark.prHead,
          signature: conflictFailureSignature({
            mergeable: prInfo.mergeable,
            mergeStateStatus: prInfo.mergeStateStatus,
          }),
          failureComment: conflictFixFailureComment(pr.prNumber, watermark),
        });
      } else if (localCommitCount > 0) {
        pushBranch(worktreeDir, branch);
        console.log(`[phoebe] Conflict resolved for PR #${pr.prNumber} — pushed.`);
      } else {
        console.log(`[phoebe] Conflict resolved for PR #${pr.prNumber} — already pushed by agent.`);
      }
    },
  });
}

/**
 * Native-stack retarget sweep (#13): a native-mode successor PR is opened
 * against its blocker's branch (`resolveStackedPrPlan`), and GitHub only
 * auto-retargets a PR onto `main` when that base branch is *deleted*. Tenant
 * repos run `delete_branch_on_merge=false`, so once the blocker's PR merges its
 * branch survives and the successor's base never moves on its own — an
 * automerge step with no base filter would then squash the successor into the
 * stale blocker branch instead of `main`, losing its work silently. This
 * explicitly retargets every open Phoebe PR whose base is a merged blocker's
 * branch back onto `defaultBranch`. Harmless (and a no-op) under `banner`/`off`
 * stack modes, since only `native` ever bases a PR on another Phoebe branch.
 */
function retargetMergedStackedPrs(): void {
  const openPrs = listOpenPhoebePrs();
  const blockerIssueNumbers = new Set<number>();
  for (const pr of openPrs) {
    const blockerIssueNumber = parseIssueNumberFromBranch(pr.baseRefName);
    if (blockerIssueNumber !== null) {
      blockerIssueNumbers.add(blockerIssueNumber);
    }
  }
  if (blockerIssueNumbers.size === 0) {
    return;
  }

  const blockerStates = new Map<number, BlockerPrState>();
  for (const blockerIssueNumber of blockerIssueNumbers) {
    try {
      blockerStates.set(blockerIssueNumber, blockerPrState(blockerIssueNumber));
    } catch (error) {
      console.warn(
        `[phoebe] Skipping stack-retarget check for blocker #${blockerIssueNumber} this cycle — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const candidates = openPrs.map((pr) => ({ prNumber: pr.number, baseRefName: pr.baseRefName }));
  for (const pr of selectStackRetargetCandidates(candidates, blockerStates)) {
    console.log(
      `[phoebe] Retargeting PR #${pr.prNumber} from ${pr.baseRefName} to ${config.defaultBranch} — blocker merged.`,
    );
    try {
      gh(["pr", "edit", String(pr.prNumber), "--base", config.defaultBranch]);
      postPrComment(pr.prNumber, stackRetargetedComment(config.defaultBranch));
    } catch (error) {
      console.warn(
        `[phoebe] Failed to retarget PR #${pr.prNumber} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function fixOnePrConflict(
  pr: ConflictingPrCandidate,
  ctx: StackContext,
): Promise<UnitResult> {
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
    return { exitCode: null };
  }
  if (cleanResult === "failed") {
    console.log(`[phoebe] Could not start merge for PR #${pr.prNumber} — skipping.`);
    const watermark = currentConflictFailureWatermark(pr.headRefName, baseBranch);
    recordFailedAttempt({
      kind: "conflict",
      prNumber: pr.prNumber,
      currentPrHead: watermark.prHead,
      signature: conflictFailureSignature({}),
      failureComment: conflictFixFailureComment(pr.prNumber, watermark),
    });
    return { exitCode: null };
  }

  return runConflictResolutionAgent(pr, mergedBlockerPrNumbers);
}

async function runChecksResolutionAgent(pr: ChecksCandidate): Promise<UnitResult> {
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
        const watermark = currentChecksFailureWatermark(pr.headRefName);
        recordFailedAttempt({
          kind: "checks",
          prNumber: pr.prNumber,
          currentPrHead: watermark.prHead,
          signature: checksFailureSignature(pr.failingChecks),
          failureComment: checksFixFailureComment(pr.prNumber, watermark),
        });
      } else if (localCommitCount > 0) {
        pushBranch(worktreeDir, branch);
        console.log(`[phoebe] Checks fixed for PR #${pr.prNumber} — pushed.`);
      } else {
        console.log(`[phoebe] Checks fixed for PR #${pr.prNumber} — already pushed by agent.`);
      }
    },
  });
}

async function fixOnePrChecks(pr: ChecksCandidate, ctx: StackContext): Promise<UnitResult> {
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
      return { exitCode: null };
    }
    if (cleanResult === "conflicted" || cleanResult === "failed") {
      console.log(
        `[phoebe] Catch-up merge conflicted for PR #${pr.prNumber} — deferring to conflicts mode.`,
      );
      return { exitCode: null };
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
): Promise<UnitResult> {
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

async function fixOnePrReviews(pr: ReviewsCandidate, phoebeLogin: string): Promise<UnitResult> {
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
  attemptKind: "issues" | "research";
  dependentsPool: readonly Issue[];
  nativeBlockersByIssue: NativeBlockerMap;
}): Promise<UnitResult> {
  const { issueNumber, issueTitle, worktreeBase, stacked, promptFile } = opts;
  const { blockerIssueNumber, blockerPrNumber } = opts;
  const agentBranch = issueBranch(issueNumber);

  fetchOrigin();
  const worktreeDir = prepareWorktree({ branch: agentBranch, baseRef: worktreeBase });
  const reportPath = verificationReportPath(worktreeDir);
  removeVerificationReport(reportPath);
  try {
    runShellCommand(config.installCommand, worktreeDir);

    const agentExitCode = await runAgentInWorktree({
      worktreeDir,
      promptFile,
      promptArgs: {
        ISSUE_NUMBER: String(issueNumber),
        ISSUE_REF: formatIssueRef(issueNumber, config.issueSource.repoSlug, config.repoSlug),
        VERIFICATION_RESULT_FILE: reportPath,
      },
    });
    const verification = readVerificationReport(reportPath);

    const newCommitCount = commitCount(worktreeDir, `${worktreeBase}..HEAD`);

    if (newCommitCount > 0) {
      pushBranch(worktreeDir, agentBranch);
    }
    // Looked up regardless of `newCommitCount` (#22): an issue reclaimed after
    // its PR already opened must read as "has a PR", not as a fresh no-progress
    // attempt, even when this particular run added nothing.
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

    if (newCommitCount > 0) {
      if (existingPr === undefined) {
        // Which base branch, whether to add the stacked banner, and whether to
        // register a native GitHub stack — all decided purely from stackMode +
        // the resolved base (see resolveStackedPrPlan). In `banner`/`off` this
        // yields exactly the historical base=defaultBranch + banner-when-stacked.
        const plan = resolveStackedPrPlan({
          issueNumber,
          resolution: { stacked, blockerIssueNumber },
        });
        const prTitle = `Phoebe: ${issueTitle} (#${issueNumber})`;
        const prBody = buildInitialPrBody({
          issueNumber,
          commitCount: newCommitCount,
          issueSourceRepoSlug: config.issueSource.repoSlug,
          workRepoSlug: config.repoSlug,
          ...(plan.includeBanner &&
          blockerIssueNumber !== undefined &&
          blockerPrNumber !== undefined
            ? { stacked: { blockerIssueNumber, blockerPrNumber } }
            : {}),
        });
        // Create the PR *first* with Phoebe's own title/body (base = the blocker
        // branch in native mode), then register the stack — so `gh stack link`
        // only corrects the base chain and never auto-generates a title over
        // ours (auto-titles only happen for branches that have no PR yet).
        gh(
          [
            "pr",
            "create",
            "--head",
            agentBranch,
            "--base",
            plan.prBase,
            "--title",
            prTitle,
            "--body-file",
            "-",
          ],
          { input: prBody },
        );
        if (plan.stackLinkArgs) {
          registerNativeStack(plan.stackLinkArgs);
        }
      } else {
        console.log(
          `[phoebe] PR #${existingPr} already exists for ${agentBranch} — posting follow-up note.`,
        );
        postPrComment(
          existingPr,
          followUpPrComment(
            issueNumber,
            newCommitCount,
            config.issueSource.repoSlug,
            config.repoSlug,
          ),
        );
      }
    } else {
      console.log("[phoebe] No commits — skipping PR creation.");
    }

    // #22: count claim→release cycles that end with no PR for this issue, and
    // quarantine at threshold — the fails-fast sibling of #75's timeout
    // counter for issue-keyed units. A PR now existing (just created, already
    // open, or found for an issue reclaimed mid-review) resets the counter.
    if (newCommitCount > 0 || existingPr !== undefined) {
      resetIssueAttemptCounter(issueNumber, opts.attemptKind);
    } else {
      const failedCommand = verification?.find((v) => v.status === "failed")?.command;
      recordFailedIssueAttempt({
        kind: opts.attemptKind,
        issueNumber,
        signature: issueAttemptFailureSignature({ failedCommand, agentExitCode }),
        dependentsPool: opts.dependentsPool,
        nativeBlockersByIssue: opts.nativeBlockersByIssue,
      });
    }

    return { exitCode: agentExitCode, verification };
  } finally {
    removeVerificationReport(reportPath);
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
  runtimeId: string;
  /** issues + researchIssues from this cycle's fetch — the pool `findBlockedDependents` (#22) scans. */
  dependentsPool: readonly Issue[];
  nativeBlockersByIssue: NativeBlockerMap;
};

type WorkKind = {
  name: WorkKindName;
  fetch: () => Promise<WorkKindFetch>;
  runUnit: (unit: WorkUnit["unit"], context: RunContext) => Promise<UnitResult>;
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
  | {
      kind: "issues";
      issues: Issue[];
      blockerStates: Map<number, BlockerPrState>;
      nativeBlockersByIssue: Map<number, number[]>;
    }
  | {
      kind: "research";
      researchIssues: Issue[];
      blockerStates: Map<number, BlockerPrState>;
      nativeBlockersByIssue: Map<number, number[]>;
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
  const nowIso = new Date().toISOString();
  const withMarkers = rawConflictingPrs.map((pr) => {
    const comments = fetchPrComments(pr.prNumber);
    return {
      ...pr,
      failureWatermark: parseLatestMarker(
        comments.map((c) => c.body),
        parseConflictFailWatermark,
      ),
      attemptMarker: findLatestUnitAttemptComment(comments, "conflict")?.marker ?? null,
    };
  });
  // #25: a unit still inside its no-commit-attempt backoff window sits this cycle out.
  const conflictingPrs = filterBackoffEligible(withMarkers, nowIso);
  const issueBodies = harvestIssueBodies(conflictingPrs);
  return { conflictingPrs, issueBodies, currentMainHead };
}

async function fetchChecksWorkData(): Promise<{
  failingCheckPrs: ChecksCandidate[];
  issueBodies: Map<number, string>;
}> {
  const rawFailingPrs = await fetchFailingCheckPrs();
  const nowIso = new Date().toISOString();
  const withMarkers = rawFailingPrs.map((pr) => {
    const comments = fetchPrComments(pr.prNumber);
    return {
      ...pr,
      failureWatermark: parseLatestMarker(
        comments.map((c) => c.body),
        parseChecksFailWatermark,
      ),
      attemptMarker: findLatestUnitAttemptComment(comments, "checks")?.marker ?? null,
    };
  });
  // #25: a unit still inside its no-commit-attempt backoff window sits this cycle out.
  const failingCheckPrs = filterBackoffEligible(withMarkers, nowIso);
  const issueBodies = harvestIssueBodies(failingCheckPrs);
  return { failingCheckPrs, issueBodies };
}

function fetchIssueWorkData(): {
  issues: Issue[];
  blockerStates: Map<number, BlockerPrState>;
  nativeBlockersByIssue: Map<number, number[]>;
} {
  const issues = listReadyIssues();
  const nativeBlockersByIssue = buildNativeBlockersByIssue(issues);
  return {
    issues,
    blockerStates: buildBlockerStates(issues, nativeBlockersByIssue),
    nativeBlockersByIssue,
  };
}

function fetchResearchWorkData(): {
  researchIssues: Issue[];
  blockerStates: Map<number, BlockerPrState>;
  nativeBlockersByIssue: Map<number, number[]>;
} {
  const researchIssues = listResearchIssues();
  const nativeBlockersByIssue = buildNativeBlockersByIssue(researchIssues);
  return {
    researchIssues,
    blockerStates: buildBlockerStates(researchIssues, nativeBlockersByIssue),
    nativeBlockersByIssue,
  };
}

async function runIssueUnit(unit: IssueWorkUnit, context: RunContext): Promise<UnitResult> {
  const { issue: target, resolution } = unit;
  const { runtimeId } = context;
  console.log(
    `[phoebe] Working #${target.number} — base ${resolution.worktreeBase}` +
      (resolution.stacked ? ` (stacked on #${resolution.blockerIssueNumber})` : "") +
      ".",
  );
  // #15: the engine claims the lease itself (marker comment, then the label
  // flip) before the agent ever starts, and refreshes the heartbeat while it
  // runs — so a crash mid-run leaves a claim the next boot/cycle can reclaim,
  // rather than a bare label flip nothing ever re-examines.
  const branch = issueBranch(target.number);
  const claimedAt = new Date().toISOString();
  claimIssueLease({ issueNumber: target.number, branch, runtimeId, claimedAt });
  const stopHeartbeat = startLeaseHeartbeat({
    issueNumber: target.number,
    branch,
    runtimeId,
    claimedAt,
    ttlMs: LEASE_TTL_MS,
  });
  try {
    return await runOneIssue({
      issueNumber: target.number,
      issueTitle: target.title,
      worktreeBase: resolution.worktreeBase,
      stacked: resolution.stacked,
      promptFile: config.promptFiles.issue,
      blockerIssueNumber: resolution.blockerIssueNumber,
      blockerPrNumber: resolution.blockerPrNumber,
      attemptKind: "issues",
      dependentsPool: context.dependentsPool,
      nativeBlockersByIssue: context.nativeBlockersByIssue,
    });
  } finally {
    stopHeartbeat();
  }
}

async function runResearchUnit(unit: IssueWorkUnit, context: RunContext): Promise<UnitResult> {
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
    attemptKind: "research",
    dependentsPool: context.dependentsPool,
    nativeBlockersByIssue: context.nativeBlockersByIssue,
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
      const { issues, blockerStates, nativeBlockersByIssue } = fetchIssueWorkData();
      return { kind: "issues", issues, blockerStates, nativeBlockersByIssue };
    },
    runUnit: async (unit, context) => {
      return runIssueUnit(unit as IssueWorkUnit, context);
    },
  },
  research: {
    name: "research",
    fetch: async () => {
      const { researchIssues, blockerStates, nativeBlockersByIssue } = fetchResearchWorkData();
      return { kind: "research", researchIssues, blockerStates, nativeBlockersByIssue };
    },
    runUnit: async (unit, context) => {
      return runResearchUnit(unit as IssueWorkUnit, context);
    },
  },
};

type CycleWorkData = {
  issues: Issue[];
  researchIssues: Issue[];
  blockerStates: Map<number, BlockerPrState>;
  nativeBlockersByIssue: Map<number, number[]>;
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
  const nativeBlockersByIssue = new Map<number, number[]>();
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
      for (const [number, native] of fetched.nativeBlockersByIssue) {
        nativeBlockersByIssue.set(number, native);
      }
    } else if (fetched.kind === "research") {
      researchIssues = fetched.researchIssues;
      for (const [number, state] of fetched.blockerStates) {
        blockerStates.set(number, state);
      }
      for (const [number, native] of fetched.nativeBlockersByIssue) {
        nativeBlockersByIssue.set(number, native);
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
    nativeBlockersByIssue,
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
  if (
    data.issues.length > 0 &&
    !selectIssue(data.issues, data.blockerStates, phoebeBase, data.nativeBlockersByIssue)
  ) {
    const reason = `${data.issues.length} ${config.issueSource.readyLabel} issue(s) but none workable this cycle (blocked or waiting on blocker PR).`;
    console.log(`[phoebe] ${reason}`);
    return reason;
  }
  if (
    data.researchIssues.length > 0 &&
    !selectIssue(data.researchIssues, data.blockerStates, phoebeBase, data.nativeBlockersByIssue)
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

/** The observability identity of a picked unit: (kind, id) (#73/#75). */
function unitRef(picked: WorkUnit): UnitRef {
  if (picked.kind === "issues" || picked.kind === "research") {
    return { kind: picked.kind, id: String(picked.unit.issue.number) };
  }
  return { kind: picked.kind, id: String(picked.unit.prNumber) };
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
    // Native stacking needs the gh-stack extension + non-interactive git config
    // on the clone. Guarded so banner/off runs pull in no gh-stack dependency.
    if (config.stackMode === "native") {
      prepareNativeStackTooling();
    }
    // #21: prove the token can read the issue source before the loop's first
    // discovery call hits it — a clearer boot failure than a bare gh error
    // mid-cycle.
    verifyIssueSourceAccess();
    // #15 startup self-recovery: a fresh process start is proof any claim this
    // persisted runtime id still holds is dead (it cannot still be mid-run),
    // so reclaim those unconditionally rather than waiting out the lease TTL.
    reclaimStaleClaims(status.snapshot().runtime.runtimeId, { forceOwnReclaim: true });
  }

  // `phoebe boot` stops the engine with SIGTERM (container shutdown, and later a
  // config/ref change). Drain gracefully rather than dying mid-unit: finish the
  // unit in flight, start no new one, then return (exit 0). The wait below wakes
  // early on drain so an idle poll-sleep does not stall shutdown.
  // The supervisor's concurrency broker (#59): when this engine was forked with
  // an IPC channel, `slotClient` requests a slot per work unit and blocks until
  // the supervisor grants one. A standalone engine (no channel) gets null here
  // and runs unbrokered — it is already serialized to one unit.
  const slotClient = createSlotClient({
    send: process.send?.bind(process),
    on: (event, listener) => {
      process.on(event, listener);
    },
    off: (event, listener) => {
      process.off(event, listener);
    },
    connected: process.connected,
  });

  // Per-repo observability (#73): one tagged `[phoebe:<slug>]` line per unit
  // event + a `status.json` snapshot in this tenant's state dir, which
  // `phoebe list` reads. The emitter swallows snapshot-write failures, so it is
  // harmless on the host (where the derived state dir may be unwritable).
  const emitUnitEvent = createEmitUnitEvent({
    tenant: config.repoSlug,
    statusPath: join(config.paths.stateDir, STATUS_FILE),
  });

  const drain = installDrainSignal(process, ["SIGTERM", REF_CHANGE_DRAIN_SIGNAL]);
  let failed = false;
  try {
    await runLoop({ runOnce, dryRun, pollIntervalMs, drain, status, slotClient, emitUnitEvent });
  } catch (error) {
    failed = true;
    status.record({ kind: "engine-failed", error });
    throw error;
  } finally {
    if (!failed) status.record({ kind: "stopped" });
    drain.dispose();
  }
}

/**
 * The `lifecycle.reason` prefix for a "draining" transition — distinguishes a
 * ref-change drain (`phoebe boot`'s reconcile watch, REF_CHANGE_DRAIN_SIGNAL)
 * from a plain container stop (SIGTERM), so an operator reading the status
 * snapshot can tell "about to relaunch on the new commit" from "shutting
 * down" (#23).
 */
function drainReason(drain: DrainSignal, detail: string): string {
  const cause = drain.signal === REF_CHANGE_DRAIN_SIGNAL ? "Engine ref changed" : "Drain requested";
  return `${cause} — ${detail}`;
}

async function runLoop({
  runOnce,
  dryRun,
  pollIntervalMs,
  drain,
  status,
  slotClient,
  emitUnitEvent,
}: {
  runOnce: boolean;
  dryRun: boolean;
  pollIntervalMs: number;
  drain: DrainSignal;
  status: ReturnType<typeof createRuntimeStatusReporter>;
  slotClient: SlotClient | null;
  emitUnitEvent: EmitUnitEvent;
}): Promise<void> {
  while (true) {
    if (drain.requested) {
      console.log("[phoebe] Drain requested — starting no new work unit; exiting 0.");
      status.record({
        kind: "draining",
        reason: drainReason(drain, "starting no new work unit."),
      });
      break;
    }
    // #15 per-cycle self-recovery: reclaim any `processingLabel` issue whose
    // lease has no marker or a heartbeat older than the TTL. Not
    // `forceOwnReclaim` — a claim this same long-lived process still holds
    // between cycles is between units, not orphaned; it backs off for the TTL
    // like any other claim rather than instantly re-reclaiming (and
    // thrash-retrying) its own just-failed unit.
    if (inContainer && !dryRun) {
      reclaimStaleClaims(status.snapshot().runtime.runtimeId, { forceOwnReclaim: false });
      // #13: keep native-stack successor PRs from being stranded on a merged,
      // undeleted blocker branch — see retargetMergedStackedPrs.
      retargetMergedStackedPrs();
    }
    status.record({ kind: "selecting" });
    const fetchKinds = runOnce ? oneShotWorkKinds(workOrder) : workOrder;
    const data = await fetchCycleWorkData(fetchKinds);
    // #20: publish the resolved `issues` lookahead — every eligible issue in
    // selection order with its full blocker set, not just the one `selectIssue`
    // is about to pick — so an observer can see what comes after `activeWork`.
    status.setQueue(
      buildIssueQueue(
        data.issues,
        data.blockerStates,
        process.env["PHOEBE_BASE"],
        data.nativeBlockersByIssue,
      ),
    );
    const picked = selectFirstWorkUnit(
      workOrder,
      {
        issues: data.issues,
        researchIssues: data.researchIssues,
        blockerStates: data.blockerStates,
        nativeBlockersByIssue: data.nativeBlockersByIssue,
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
        reason: drainReason(drain, "starting no new work unit."),
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

    // Acquire a concurrency slot for the whole unit execution (#59): the
    // supervisor's global cap bounds how many repos run a unit at once. Held
    // through worktree + install + agent + test + push, released in `finally`
    // so timeout, error, and normal completion share one leak-free release
    // path (#72). Standalone (unbrokered) engines skip this entirely.
    if (slotClient) {
      try {
        await slotClient.acquire();
      } catch (error) {
        if (error instanceof BrokerDisconnectedError) {
          // The supervisor's channel closed while we waited for a slot. Stop
          // rather than run unbrokered (which, across a fleet, would bypass the
          // global cap); the supervisor is gone or will respawn us afresh.
          console.error(`[phoebe] ${error.message} — stopping this engine.`);
          break;
        }
        throw error;
      }
    }
    const ref = unitRef(picked);
    status.record({ kind: "work-started", work: statusWork(picked) });
    emitUnitEvent({ unit: ref, event: "started" });
    try {
      const { exitCode: agentExitCode, verification } = await KINDS[picked.kind].runUnit(
        picked.unit,
        {
          stack: { issueBodies: data.issueBodies, blockerStates: data.blockerStates },
          phoebeLogin: data.phoebeLogin ?? "",
          runtimeId: status.snapshot().runtime.runtimeId,
          dependentsPool: [...data.issues, ...data.researchIssues],
          nativeBlockersByIssue: data.nativeBlockersByIssue,
        },
      );
      const pullRequestNumber = pullRequestNumberAfterWork(picked);
      if (agentExitCode !== null && agentExitCode !== 0) {
        status.record({
          kind: "work-failed",
          error: new Error(`Agent exited with code ${agentExitCode}.`),
          ...(pullRequestNumber !== undefined ? { pullRequestNumber } : {}),
          ...(verification ? { verification } : {}),
          resources: {
            agentExitCode,
            summary: "The work unit completed its cleanup after a nonzero agent exit.",
          },
        });
      } else {
        status.record({
          kind: "work-completed",
          ...(pullRequestNumber !== undefined ? { pullRequestNumber } : {}),
          ...(verification ? { verification } : {}),
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
      emitUnitEvent({ unit: ref, event: "completed" });
    } catch (error) {
      status.record({ kind: "work-failed", error });
      if (error instanceof RunTimeoutError) {
        // A whole-unit timeout (#72): the agent was killed, the slot releases in
        // `finally`, and the engine survives (never told to the supervisor, #60
        // orthogonality). #75 layers the poison-unit quarantine on this event.
        emitUnitEvent({
          unit: ref,
          event: "timed-out",
          detail: `${Math.round(error.elapsedMs / 1000)}s budget exceeded`,
        });
        // Count this timeout on the unit and, at K consecutive, quarantine it so
        // a genuinely poisonous unit stops being re-picked forever (#75).
        recordUnitTimeout(picked, data.phoebeLogin ?? "", emitUnitEvent);
      } else {
        // A non-timeout failure: clear the current unit and record the error so
        // `phoebe list` shows it (the durable record is still the per-work-kind
        // watermark/failure-comment on GitHub; this is the at-a-glance snapshot).
        emitUnitEvent({
          unit: ref,
          event: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
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
    } finally {
      slotClient?.release();
    }

    if (runOnce) break;
    // Drain requested while the unit ran: it is finished, so exit now rather
    // than picking up another. This is the graceful-drain boundary.
    if (drain.requested) {
      console.log("[phoebe] Finished the in-flight unit under drain — exiting 0.");
      status.record({
        kind: "draining",
        reason: drainReason(drain, "the in-flight unit finished."),
      });
      break;
    }
  }
}
