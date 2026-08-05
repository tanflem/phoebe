// Pure selection + base-resolution logic for Phoebe's orchestrator.
// Kept separate from main.ts so it can be unit-tested without Docker/gh.

import { asBranchRef, asSha, type BranchRef, type PrNumber, type Sha } from "./branded.ts";
import type { BlockerSource, StackMode, WorkKindName } from "./config-schema.ts";
import { config } from "./resolved-config.ts";
import {
  PHOEBE_QUARANTINE_LABEL,
  shouldBackoffUnitRetry,
  type UnitAttemptMarker,
} from "./quarantine.ts";

export {
  validateWorkOrder,
  BLOCKER_SOURCES,
  STACK_MODES,
  WORK_KIND_NAMES,
  type BlockerSource,
  type StackMode,
  type WorkKindName,
} from "./config-schema.ts";

/** Native blocker issue numbers keyed by the blocked issue's number. */
export type NativeBlockerMap = ReadonlyMap<number, readonly number[]>;

export type Issue = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  createdAt: string;
};

export type BlockerPrState = {
  hasOpenPr: boolean;
  openPrNumber?: PrNumber;
  hasMergedPr: boolean;
  mergedPrNumber?: PrNumber;
};

export type BaseResolution = {
  worktreeBase: string;
  stacked: boolean;
  blockerIssueNumber?: number;
  blockerPrNumber?: PrNumber;
};

/**
 * The stack-aware context every candidate selector needs: issue bodies (to read
 * `blocked by` references) keyed by issue number, and the open/merged PR state of
 * each referenced blocker. Bundled so the three work-kind flows thread one value
 * instead of the same `(issueBodies, blockerStates)` pair.
 */
export type StackContext = {
  issueBodies: ReadonlyMap<number, string>;
  blockerStates: ReadonlyMap<number, BlockerPrState>;
};

const PRIORITY_ORDER = ["bug", "tracer", "polish", "refactor"] as const;
export type Priority = (typeof PRIORITY_ORDER)[number];

/**
 * Parse blocker references from issue body text (and optional comments).
 * The pattern is configurable via `config.blockedByPattern`; capture group 1
 * must yield the blocker issue number.
 */
export function parseBlockedBy(...texts: string[]): number[] {
  const blockers: number[] = [];
  const pattern = new RegExp(config.blockedByPattern, "gi");
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) {
      blockers.push(Number(match[1]));
    }
  }
  return [...new Set(blockers)];
}

/**
 * Combine body-regex and native (issue-dependencies API) blocker numbers per
 * `config.blockerSource`, deduplicating while preserving first-seen order
 * (body refs before native ones under `both`). This is the single seam the
 * native-blocker source feeds through: every downstream stacking decision keeps
 * consuming a plain `number[]`, so only *where* the numbers come from changes.
 */
export function mergeBlockerNumbers(
  bodyBlockers: readonly number[],
  nativeBlockers: readonly number[],
  source: BlockerSource = config.blockerSource,
): number[] {
  const combined: number[] = [];
  if (source === "body" || source === "both") {
    combined.push(...bodyBlockers);
  }
  if (source === "native" || source === "both") {
    combined.push(...nativeBlockers);
  }
  return [...new Set(combined)];
}

/** An issue's effective blockers: body refs merged with its native blockers. */
export function issueBlockers(issue: Issue, nativeBlockers: readonly number[] = []): number[] {
  return mergeBlockerNumbers(parseBlockedBy(issue.body), nativeBlockers);
}

export function classifyPriority(issue: Issue): Priority {
  const text = `${issue.title} ${issue.body}`.toLowerCase();
  if (/\b(bug|broken|crash|regression|fix)\b/.test(text)) return "bug";
  if (/\b(tracer|wire|poc)\b/.test(text)) return "tracer";
  if (/\brefactor\b/.test(text)) return "refactor";
  return "polish";
}

export function compareIssues(a: Issue, b: Issue): number {
  const pa = PRIORITY_ORDER.indexOf(classifyPriority(a));
  const pb = PRIORITY_ORDER.indexOf(classifyPriority(b));
  if (pa !== pb) return pa - pb;
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb) return ta - tb;
  return a.number - b.number;
}

export function issueBranch(issueNumber: number): BranchRef {
  return asBranchRef(`${config.branchPrefix}issue-${issueNumber}`);
}

/**
 * Resolve the worktree base for an issue.
 * Returns `null` when the issue should be skipped this cycle (blocked with no
 * open/merged blocker PR).
 *
 * A diamond/multi-blocker issue (#13) must gate on *every* blocker, not just
 * the first: any blocker with no PR at all yet parks the issue, exactly as the
 * single-blocker case always has. Once every blocker has at least an open PR,
 * the issue is workable — stacked on whichever blocker is still unmerged
 * (the last one in blocker-list order, so a diamond re-bases forward as each
 * of its parents merges in turn) unless every blocker has already merged, in
 * which case the branch cuts off `main` same as an unblocked issue.
 */
export function resolveWorktreeBase(
  issue: Issue,
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  phoebeBase?: string,
  nativeBlockers: readonly number[] = [],
  stackMode: StackMode = config.stackMode,
): BaseResolution | null {
  if (phoebeBase) {
    return { worktreeBase: phoebeBase, stacked: false };
  }

  const blockers = issueBlockers(issue, nativeBlockers);
  if (blockers.length === 0) {
    return { worktreeBase: "origin/main", stacked: false };
  }

  let lastUnmergedBlocker: { issueNumber: number; state: BlockerPrState } | null = null;
  for (const blockerIssueNumber of blockers) {
    const state = blockerStates.get(blockerIssueNumber);
    if (!state) {
      return null;
    }
    if (state.hasMergedPr) {
      continue;
    }
    if (!state.hasOpenPr) {
      return null;
    }
    lastUnmergedBlocker = { issueNumber: blockerIssueNumber, state };
  }

  if (!lastUnmergedBlocker) {
    // Every blocker has merged.
    return { worktreeBase: "origin/main", stacked: false };
  }

  // `off` still honors every blocker for the skip decision above, but never
  // stacks: the branch is cut off main and no banner is added downstream.
  if (stackMode === "off") {
    return { worktreeBase: "origin/main", stacked: false };
  }

  // `banner` and `native` both cut the branch off the unmerged blocker's tip;
  // they diverge only in the PR base + banner, decided by `resolveStackedPrPlan`.
  return {
    worktreeBase: `origin/${issueBranch(lastUnmergedBlocker.issueNumber)}`,
    stacked: true,
    blockerIssueNumber: lastUnmergedBlocker.issueNumber,
    blockerPrNumber: lastUnmergedBlocker.state.openPrNumber,
  };
}

/** Pick the highest-priority workable issue, or `null` when none qualify. */
export function selectIssue(
  issues: readonly Issue[],
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  phoebeBase?: string,
  nativeBlockersByIssue: NativeBlockerMap = new Map(),
): { issue: Issue; resolution: BaseResolution } | null {
  // Quarantined issues/research tickets (#75) are skipped for work until a human
  // clears the label or the issue is edited (the auto-un-stick sweep).
  const eligible = issues.filter((issue) => !issue.labels.includes(PHOEBE_QUARANTINE_LABEL));
  const sorted = [...eligible].sort(compareIssues);
  for (const issue of sorted) {
    const resolution = resolveWorktreeBase(
      issue,
      blockerStates,
      phoebeBase,
      nativeBlockersByIssue.get(issue.number) ?? [],
    );
    if (resolution) {
      return { issue, resolution };
    }
  }
  return null;
}

/**
 * The full `issues` work order, ordered as {@link selectIssue} would take it,
 * with each entry's resolved blocker set and whether it is workable this
 * cycle — the status-v2 `queue` lookahead. Unlike `selectIssue`, which stops at
 * the first workable candidate, this walks every eligible issue so an operator
 * can see what comes after `activeWork`, not just what runs next.
 */
export function buildIssueQueue(
  issues: readonly Issue[],
  blockerStates: ReadonlyMap<number, BlockerPrState>,
  phoebeBase?: string,
  nativeBlockersByIssue: NativeBlockerMap = new Map(),
): Array<{ issueNumber: number; blockedBy: readonly number[]; workable: boolean }> {
  const eligible = issues.filter((issue) => !issue.labels.includes(PHOEBE_QUARANTINE_LABEL));
  const sorted = [...eligible].sort(compareIssues);
  return sorted.map((issue) => {
    const nativeBlockers = nativeBlockersByIssue.get(issue.number) ?? [];
    return {
      issueNumber: issue.number,
      blockedBy: issueBlockers(issue, nativeBlockers),
      workable: resolveWorktreeBase(issue, blockerStates, phoebeBase, nativeBlockers) !== null,
    };
  });
}

export function stackedPrComment(blockerIssueNumber: number, blockerPrNumber: PrNumber): string {
  return (
    `⛓️ Blocked by #${blockerIssueNumber} (PR #${blockerPrNumber}). ` +
    `Its commits appear in this diff until #${blockerPrNumber} merges. ` +
    `**Do not merge this PR before #${blockerPrNumber}** — doing so would pull ` +
    `#${blockerIssueNumber}'s work into \`main\` ahead of its own review.`
  );
}

/**
 * Pure PR-shape decision for a freshly-pushed issue branch, given the resolved
 * base and the configured {@link StackMode}. Everything the impure PR-open step
 * needs — the `--base` branch, whether to add the stacked banner to the body,
 * and the `gh stack link` argv (or `null`) — is decided here so it can be unit
 * tested without shelling out to `gh`.
 *
 * The three modes:
 *  - not stacked (unblocked / merged blocker / `PHOEBE_BASE` / `off`): base is
 *    `defaultBranch`, no banner, no stack link. Byte-for-byte the historical
 *    behavior.
 *  - `banner`: base is `defaultBranch`, banner added, no stack link — today's
 *    behavior exactly.
 *  - `native`: base is the blocker's branch (`<branchPrefix>issue-<blocker>`),
 *    no banner, and a `gh stack link <predecessor> <successor>` argv registers
 *    the native GitHub stack (bottom-to-top). The PR is created first with
 *    Phoebe's own title/body, so `link` only corrects the base chain and never
 *    auto-generates a title over ours.
 */
export type StackedPrPlan = {
  /** The branch the PR is opened against (`gh pr create --base`). */
  prBase: string;
  /** Whether the stacked "do not merge before the blocker" banner is added. */
  includeBanner: boolean;
  /** `gh` argv (sans the `gh` program) that registers the native stack, or `null`. */
  stackLinkArgs: string[] | null;
};

export function resolveStackedPrPlan(opts: {
  issueNumber: number;
  resolution: Pick<BaseResolution, "stacked" | "blockerIssueNumber">;
  stackMode?: StackMode;
  defaultBranch?: string;
}): StackedPrPlan {
  const stackMode = opts.stackMode ?? config.stackMode;
  const defaultBranch = opts.defaultBranch ?? config.defaultBranch;
  const notStacked: StackedPrPlan = {
    prBase: defaultBranch,
    includeBanner: false,
    stackLinkArgs: null,
  };

  // `off` never reaches here stacked (resolveWorktreeBase collapses it), so an
  // unstacked resolution — or any non-native mode below — falls through to a
  // main-based, unbannered PR.
  if (!opts.resolution.stacked || opts.resolution.blockerIssueNumber === undefined) {
    return notStacked;
  }

  if (stackMode === "native") {
    const predecessor = issueBranch(opts.resolution.blockerIssueNumber);
    const successor = issueBranch(opts.issueNumber);
    return {
      prBase: predecessor,
      includeBanner: false,
      // Bottom-to-top: the lower (blocker) branch first, then this run's branch.
      stackLinkArgs: ["stack", "link", predecessor, successor],
    };
  }

  // `banner` (the only remaining stacked mode): base on main + add the banner.
  return { prBase: defaultBranch, includeBanner: true, stackLinkArgs: null };
}

/**
 * Local git config the native-stack path pre-sets on the private clone so
 * `gh stack` / rebase operations run non-interactively — `remote.pushDefault`
 * removes the "which remote?" prompt when more than one exists, and
 * `rerere.enabled` lets cascade-rebases reuse recorded conflict resolutions.
 * Returned as `git` argv (sans the `git` program) so the impure caller runs
 * them against the clone directory. Only applied when `stackMode === 'native'`.
 */
export function nativeStackGitConfig(): readonly (readonly string[])[] {
  return [
    ["config", "remote.pushDefault", "origin"],
    ["config", "rerere.enabled", "true"],
  ];
}

/** `gh` argv (sans the `gh` program) that installs the gh-stack extension. */
export function ghStackExtensionInstallArgs(): readonly string[] {
  return ["extension", "install", "github/gh-stack"];
}

export type ConflictingPrCandidate = {
  prNumber: PrNumber;
  headRefName: BranchRef;
  baseRefName?: BranchRef;
  issueNumber?: number;
  headSha?: Sha;
  baseSha?: Sha;
  failureWatermark?: ConflictFailWatermark | null;
  /** No-commit-attempt counter (#25) — read from the unit's tracking comment. */
  attemptMarker?: UnitAttemptMarker | null;
};

export type ConflictFailWatermark = {
  prHead: Sha;
  mainHead: Sha;
};

const CONFLICT_FAIL_WATERMARK_RE =
  /<!--\s*phoebe-conflict-fail:\s*prHead=([0-9a-f]+)\s+mainHead=([0-9a-f]+)\s*-->/i;

export function buildConflictFailWatermarkMarker(watermark: ConflictFailWatermark): string {
  return `<!-- phoebe-conflict-fail: prHead=${watermark.prHead} mainHead=${watermark.mainHead} -->`;
}

export function parseConflictFailWatermark(text: string): ConflictFailWatermark | null {
  const match = CONFLICT_FAIL_WATERMARK_RE.exec(text);
  if (!match) {
    return null;
  }
  return { prHead: asSha(match[1]!), mainHead: asSha(match[2]!) };
}

/**
 * Scan comment bodies newest-first and return the first marker `parse` extracts,
 * or `null` when none match. Shared by every work kind's watermark lookup — the
 * latest marker wins when several exist on one PR.
 */
export function parseLatestMarker<T>(
  bodies: readonly string[],
  parse: (text: string) => T | null,
): T | null {
  for (let i = bodies.length - 1; i >= 0; i--) {
    const parsed = parse(bodies[i]!);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

export function shouldSkipWatermarkConflictFix(opts: {
  watermark: ConflictFailWatermark | null;
  currentPrHead: Sha;
  currentMainHead: Sha;
}): boolean {
  if (!opts.watermark) {
    return false;
  }
  return (
    opts.watermark.prHead === opts.currentPrHead && opts.watermark.mainHead === opts.currentMainHead
  );
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ISSUE_BRANCH_RE = new RegExp(`^${escapeRegExp(config.branchPrefix)}issue-(\\d+)$`);

export function isPhoebeHeadBranch(branch: BranchRef): boolean {
  return branch.startsWith(config.branchPrefix);
}

export type PrScopeConfig = {
  branchPrefix: string;
  prScope: "phoebe" | "all";
  prAuthors: readonly string[];
  draftPrs: "skip-non-phoebe" | "skip-all" | "include";
  prOptOutLabel: string;
};

export type PrScanFields = {
  headRefName: BranchRef;
  authorLogin: string;
  isDraft: boolean;
  isCrossRepository: boolean;
  labels: readonly string[];
};

const defaultPrScopeConfig = (): PrScopeConfig => ({
  branchPrefix: config.branchPrefix,
  prScope: config.prScope,
  prAuthors: config.prAuthors,
  draftPrs: config.draftPrs,
  prOptOutLabel: config.prOptOutLabel,
});

/** Whether an open PR is eligible for conflicts/checks/reviews scanning. */
export function isPrInScope(
  pr: PrScanFields,
  scopeConfig: PrScopeConfig = defaultPrScopeConfig(),
): boolean {
  if (pr.isCrossRepository) {
    return false;
  }
  if (pr.labels.includes(scopeConfig.prOptOutLabel)) {
    return false;
  }
  // Poison-unit quarantine (#75): a unit that timed out K times is labelled and
  // skipped for *work* (still inspected for auto-un-stick elsewhere). Reuses the
  // existing opt-out filter mechanism; the label is a Phoebe-owned constant.
  if (pr.labels.includes(PHOEBE_QUARANTINE_LABEL)) {
    return false;
  }
  if (
    scopeConfig.prAuthors.length > 0 &&
    !scopeConfig.prAuthors.some((author) => author.toLowerCase() === pr.authorLogin.toLowerCase())
  ) {
    return false;
  }
  const isPhoebe = pr.headRefName.startsWith(scopeConfig.branchPrefix);
  if (scopeConfig.prScope === "phoebe" && !isPhoebe) {
    return false;
  }
  if (pr.isDraft) {
    if (scopeConfig.draftPrs === "skip-all") {
      return false;
    }
    if (scopeConfig.draftPrs === "skip-non-phoebe" && !isPhoebe) {
      return false;
    }
  }
  return true;
}

export function parseIssueNumberFromBranch(branch: BranchRef): number | null {
  const match = ISSUE_BRANCH_RE.exec(branch);
  return match ? Number(match[1]) : null;
}

/** GitHub may return UNKNOWN while mergeability is still computing. */
export function isPrMergeConflicting(mergeable: string, mergeStateStatus?: string): boolean {
  if (mergeable === "CONFLICTING") return true;
  if (mergeable === "UNKNOWN" && mergeStateStatus === "DIRTY") return true;
  return false;
}

/**
 * Skip idle conflict-fix when the PR's issue is still stacked on a blocker with
 * an open PR — its divergence from `main` is expected, not a real conflict.
 */
export function shouldSkipStackedConflictFix(
  issueBody: string,
  blockerStates: ReadonlyMap<number, BlockerPrState>,
): boolean {
  for (const blockerIssueNumber of parseBlockedBy(issueBody)) {
    const state = blockerStates.get(blockerIssueNumber);
    if (state?.hasOpenPr) {
      return true;
    }
  }
  return false;
}

/** Merged blocker PR numbers for lazy catch-up (bottom-up stack order). */
export function getMergedBlockerPrNumbers(
  issueBody: string,
  blockerStates: ReadonlyMap<number, BlockerPrState>,
): PrNumber[] {
  const merged: PrNumber[] = [];
  for (const blockerIssueNumber of parseBlockedBy(issueBody)) {
    const state = blockerStates.get(blockerIssueNumber);
    if (state?.hasMergedPr && state.mergedPrNumber !== undefined) {
      merged.push(state.mergedPrNumber);
    }
  }
  return merged;
}

export function stackedCatchUpRetractionComment(blockerPrNumbers: readonly PrNumber[]): string {
  if (blockerPrNumbers.length === 1) {
    return (
      `Blocker #${blockerPrNumbers[0]} merged; this branch has been caught up to \`main\` ` +
      `and is now independently mergeable.`
    );
  }
  const list = blockerPrNumbers.map((n) => `#${n}`).join(", ");
  return (
    `Blockers ${list} merged; this branch has been caught up to \`main\` ` +
    `and is now independently mergeable.`
  );
}

export type StackRetargetCandidate = {
  prNumber: PrNumber;
  baseRefName: BranchRef;
};

/**
 * Open Phoebe PRs whose base is a native-stack blocker branch (#13) whose own
 * PR has since merged. GitHub only auto-retargets a PR onto its grandparent
 * when the base branch is *deleted*; tenant repos run
 * `delete_branch_on_merge=false`, so a merged blocker's branch survives and
 * nothing else ever moves its successor's base off it. `blockerStates` here is
 * keyed by the blocker issue number parsed straight out of each candidate's
 * `baseRefName` — the base branch name *is* the evidence of the native stack,
 * independent of `blocked by` body/native refs.
 */
export function selectStackRetargetCandidates<T extends StackRetargetCandidate>(
  prs: readonly T[],
  blockerStates: ReadonlyMap<number, BlockerPrState>,
): T[] {
  return prs.filter((pr) => {
    const blockerIssueNumber = parseIssueNumberFromBranch(pr.baseRefName);
    if (blockerIssueNumber === null) {
      return false;
    }
    return blockerStates.get(blockerIssueNumber)?.hasMergedPr === true;
  });
}

/** Posted after a successor PR's base is moved from a merged blocker's branch to `defaultBranch` (#13). */
export function stackRetargetedComment(defaultBranch: string): string {
  return (
    `Blocker merged; this PR's base has been retargeted to \`${defaultBranch}\` ` +
    `so it can merge independently.`
  );
}

/** Oldest PR (lowest number) among candidates, or `null` when the list is empty. */
function pickOldestPr<T extends { prNumber: number }>(candidates: readonly T[]): T | null {
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((oldest, pr) => (pr.prNumber < oldest.prNumber ? pr : oldest));
}

export function selectConflictFixCandidates(
  prs: readonly ConflictingPrCandidate[],
  ctx: StackContext,
  opts?: { currentMainHead: Sha },
): ConflictingPrCandidate[] {
  return prs.filter((pr) => {
    const issueNumber = pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName);
    if (issueNumber !== null) {
      const body = ctx.issueBodies.get(issueNumber) ?? "";
      if (shouldSkipStackedConflictFix(body, ctx.blockerStates)) {
        return false;
      }
    }
    const currentBaseHead = pr.baseSha ?? opts?.currentMainHead;
    if (currentBaseHead && pr.headSha) {
      if (
        shouldSkipWatermarkConflictFix({
          watermark: pr.failureWatermark ?? null,
          currentPrHead: pr.headSha,
          currentMainHead: currentBaseHead,
        })
      ) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Drop PR-keyed candidates that are inside their no-commit-attempt backoff
 * window (#25) — a transient failure (rate limit, 504) then recovers on its
 * own instead of burning a full agent cycle every poll while it's within the
 * growing gap between retries. A quarantined unit never reaches this filter:
 * it's already excluded upstream by the `PHOEBE_QUARANTINE_LABEL` scope check.
 */
export function filterBackoffEligible<T extends { attemptMarker?: UnitAttemptMarker | null }>(
  candidates: readonly T[],
  now: string,
): T[] {
  return candidates.filter((c) => {
    const marker = c.attemptMarker;
    if (!marker) {
      return true;
    }
    return !shouldBackoffUnitRetry({ attemptCount: marker.n, lastAttemptAt: marker.at, now });
  });
}

export type StatusCheckItem = {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
};

export type FailingCheck = {
  name: string;
  conclusion: string;
};

export function checkItemName(item: StatusCheckItem): string {
  return item.name ?? item.context ?? "unknown";
}

export function isCheckItemFailing(item: StatusCheckItem): boolean {
  if (item.__typename === "CheckRun" || item.status !== undefined) {
    const conclusion = item.conclusion ?? "";
    return (
      conclusion === "FAILURE" ||
      conclusion === "CANCELLED" ||
      conclusion === "TIMED_OUT" ||
      conclusion === "ACTION_REQUIRED"
    );
  }
  const state = item.state ?? "";
  return state === "FAILURE" || state === "ERROR";
}

export function isCheckItemPending(item: StatusCheckItem): boolean {
  if (item.__typename === "CheckRun" || item.status !== undefined) {
    const status = item.status ?? "";
    return (
      status === "QUEUED" ||
      status === "IN_PROGRESS" ||
      status === "WAITING" ||
      status === "PENDING" ||
      status === "REQUESTED"
    );
  }
  const state = item.state ?? "";
  return state === "PENDING" || state === "EXPECTED";
}

/** Combined rollup: FAILURE when at least one check failed and none are pending. */
export function statusCheckRollupState(
  checks: readonly StatusCheckItem[],
): "FAILURE" | "PENDING" | "SUCCESS" | "NONE" {
  if (checks.length === 0) {
    return "NONE";
  }
  if (checks.some(isCheckItemPending)) {
    return "PENDING";
  }
  if (checks.some(isCheckItemFailing)) {
    return "FAILURE";
  }
  return "SUCCESS";
}

export type WorkflowRunItem = {
  workflowName?: string;
  name?: string;
  status?: string;
  conclusion?: string | null;
};

/**
 * Map `gh run list` rows onto StatusCheckItem. The REST Actions API is the
 * check-state source usable by fine-grained PATs — GraphQL statusCheckRollup
 * is GitHub-App/OAuth only. REST enums are lowercase; rows arrive newest
 * first, and only the newest run per workflow counts.
 */
export function workflowRunsToCheckItems(runs: readonly WorkflowRunItem[]): StatusCheckItem[] {
  const seen = new Set<string>();
  const items: StatusCheckItem[] = [];
  for (const run of runs) {
    const name = run.workflowName ?? run.name ?? "unknown";
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    items.push({
      name,
      status: (run.status ?? "").toUpperCase(),
      conclusion: run.conclusion ? run.conclusion.toUpperCase() : null,
    });
  }
  return items;
}

export function listFailingChecks(checks: readonly StatusCheckItem[]): FailingCheck[] {
  return checks.filter(isCheckItemFailing).map((item) => ({
    name: checkItemName(item),
    conclusion: item.conclusion ?? item.state ?? "",
  }));
}

export type ChecksCandidate = {
  prNumber: PrNumber;
  headRefName: BranchRef;
  baseRefName?: BranchRef;
  issueNumber?: number;
  headSha?: Sha;
  mergeable: string;
  mergeStateStatus?: string;
  failingChecks: FailingCheck[];
  failureWatermark?: ChecksFailWatermark | null;
  /** No-commit-attempt counter (#25) — read from the unit's tracking comment. */
  attemptMarker?: UnitAttemptMarker | null;
};

export type ChecksFailWatermark = {
  prHead: Sha;
};

const CHECKS_FAIL_WATERMARK_RE = /<!--\s*phoebe-checks-fail:\s*prHead=([0-9a-f]+)\s*-->/i;

export function buildChecksFailWatermarkMarker(watermark: ChecksFailWatermark): string {
  return `<!-- phoebe-checks-fail: prHead=${watermark.prHead} -->`;
}

export function parseChecksFailWatermark(text: string): ChecksFailWatermark | null {
  const match = CHECKS_FAIL_WATERMARK_RE.exec(text);
  if (!match) {
    return null;
  }
  return { prHead: asSha(match[1]!) };
}

export function shouldSkipWatermarkChecksFix(opts: {
  watermark: ChecksFailWatermark | null;
  currentPrHead: Sha;
}): boolean {
  if (!opts.watermark) {
    return false;
  }
  return opts.watermark.prHead === opts.currentPrHead;
}

/** Reuse stacked-blocker skip logic — stacked PR red CI is handled at blocker merge. */
export const shouldSkipStackedChecksFix = shouldSkipStackedConflictFix;

export function selectChecksCandidates(
  prs: readonly ChecksCandidate[],
  ctx: StackContext,
): ChecksCandidate[] {
  return prs.filter((pr) => {
    if (isPrMergeConflicting(pr.mergeable, pr.mergeStateStatus)) {
      return false;
    }
    const issueNumber = pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName);
    if (issueNumber !== null) {
      const body = ctx.issueBodies.get(issueNumber) ?? "";
      if (shouldSkipStackedChecksFix(body, ctx.blockerStates)) {
        return false;
      }
    }
    if (pr.headSha) {
      if (
        shouldSkipWatermarkChecksFix({
          watermark: pr.failureWatermark ?? null,
          currentPrHead: pr.headSha,
        })
      ) {
        return false;
      }
    }
    return true;
  });
}

/** Pick the single checks unit — oldest PR number among eligible failing-CI candidates. */
export function selectChecksUnit(
  prs: readonly ChecksCandidate[],
  ctx: StackContext,
): ChecksCandidate | null {
  return pickOldestPr(selectChecksCandidates(prs, ctx));
}

export type ReviewThreadComment = {
  createdAt: string;
  authorLogin: string;
};

export type ReviewThread = {
  isResolved: boolean;
  isOutdated: boolean;
  comments: readonly ReviewThreadComment[];
};

export type ReviewsCandidate = {
  prNumber: PrNumber;
  headRefName: BranchRef;
  baseRefName?: BranchRef;
  issueNumber?: number;
  authorLogin?: string;
  mergeable: string;
  mergeStateStatus?: string;
  threads: readonly ReviewThread[];
  handledWatermark?: ReviewsHandledWatermark | null;
};

export type ReviewsHandledWatermark = {
  latest: string;
};

const REVIEWS_HANDLED_WATERMARK_RE = /<!--\s*phoebe-reviews-handled:\s*latest=([^\s>]+)\s*-->/i;

export function buildReviewsHandledMarker(watermark: ReviewsHandledWatermark): string {
  return `<!-- phoebe-reviews-handled: latest=${watermark.latest} -->`;
}

export function parseReviewsHandledWatermark(text: string): ReviewsHandledWatermark | null {
  const match = REVIEWS_HANDLED_WATERMARK_RE.exec(text);
  if (!match) {
    return null;
  }
  return { latest: match[1]! };
}

export function isReviewSummaryComment(body: string): boolean {
  return body.includes(config.reviewsSuccessHeading);
}

export function isActivityNewerThanWatermark(
  createdAt: string,
  watermark: ReviewsHandledWatermark | null,
): boolean {
  if (!watermark) {
    return true;
  }
  return createdAt > watermark.latest;
}

export function newestReviewThreadCommentCreatedAt(
  threads: readonly ReviewThread[],
): string | null {
  let newest: string | null = null;
  for (const thread of threads) {
    for (const comment of thread.comments) {
      if (newest === null || comment.createdAt > newest) {
        newest = comment.createdAt;
      }
    }
  }
  return newest;
}

export function hasNewNonPhoebeReviewActivity(opts: {
  threads: readonly ReviewThread[];
  phoebeLogin: string;
  authorLogin?: string;
  watermark: ReviewsHandledWatermark | null;
}): boolean {
  for (const thread of opts.threads) {
    if (thread.isResolved || thread.isOutdated) {
      continue;
    }
    for (const comment of thread.comments) {
      if (comment.authorLogin === opts.phoebeLogin) {
        continue;
      }
      if (opts.authorLogin !== undefined && comment.authorLogin === opts.authorLogin) {
        continue;
      }
      if (isActivityNewerThanWatermark(comment.createdAt, opts.watermark)) {
        return true;
      }
    }
  }
  return false;
}

/** Reuse stacked-blocker skip logic — stacked PR review comments are often about blocker code. */
export const shouldSkipStackedReviewsFix = shouldSkipStackedConflictFix;

export function selectReviewsCandidates(
  prs: readonly ReviewsCandidate[],
  ctx: StackContext,
  phoebeLogin: string,
): ReviewsCandidate[] {
  return prs.filter((pr) => {
    if (isPrMergeConflicting(pr.mergeable, pr.mergeStateStatus)) {
      return false;
    }
    const issueNumber = pr.issueNumber ?? parseIssueNumberFromBranch(pr.headRefName);
    if (issueNumber !== null) {
      const body = ctx.issueBodies.get(issueNumber) ?? "";
      if (shouldSkipStackedReviewsFix(body, ctx.blockerStates)) {
        return false;
      }
    }
    return hasNewNonPhoebeReviewActivity({
      threads: pr.threads,
      phoebeLogin,
      authorLogin: pr.authorLogin,
      watermark: pr.handledWatermark ?? null,
    });
  });
}

/** Pick the single reviews unit — oldest PR number among eligible review-feedback candidates. */
export function selectReviewsUnit(
  prs: readonly ReviewsCandidate[],
  ctx: StackContext,
  phoebeLogin: string,
): ReviewsCandidate | null {
  return pickOldestPr(selectReviewsCandidates(prs, ctx, phoebeLogin));
}

export function buildReviewsHandledComment(opts: {
  latestActivityAt: string | null;
  failed: boolean;
}): string {
  const latest = opts.latestActivityAt ?? "1970-01-01T00:00:00Z";
  const marker = buildReviewsHandledMarker({ latest });
  if (opts.failed) {
    return (
      "Phoebe attempted to handle review feedback and failed; will retry on new review activity.\n\n" +
      marker
    );
  }
  return marker;
}

/** Whether a work-kind may run under `--run-once`. Janitor kinds are persistent-mode only. */
export const WORK_KIND_ONE_SHOT_ELIGIBLE: Record<WorkKindName, boolean> = {
  conflicts: false,
  checks: false,
  reviews: false,
  issues: true,
  research: true,
};

export const RUN_ONCE_NOTHING_MESSAGE =
  "[phoebe] Nothing to do under --run-once (janitor kinds are persistent-mode only).";

export function oneShotWorkKinds(workOrder: readonly WorkKindName[]): readonly WorkKindName[] {
  return workOrder.filter((kind) => WORK_KIND_ONE_SHOT_ELIGIBLE[kind]);
}

/** Pick the single conflict unit — oldest PR number among unblocked candidates. */
export function selectConflictUnit(
  prs: readonly ConflictingPrCandidate[],
  ctx: StackContext,
  opts?: { currentMainHead: Sha },
): ConflictingPrCandidate | null {
  return pickOldestPr(selectConflictFixCandidates(prs, ctx, opts));
}

export type IssueWorkUnit = { issue: Issue; resolution: BaseResolution };

export type WorkUnit =
  | { kind: "conflicts"; unit: ConflictingPrCandidate }
  | { kind: "checks"; unit: ChecksCandidate }
  | { kind: "reviews"; unit: ReviewsCandidate }
  | { kind: "issues"; unit: IssueWorkUnit }
  | { kind: "research"; unit: IssueWorkUnit };

export type WorkSelectionData = {
  issues: readonly Issue[];
  /** Wayfinder research tickets selected by the `research` kind (reuses the issues path). */
  researchIssues?: readonly Issue[];
  blockerStates: ReadonlyMap<number, BlockerPrState>;
  /** Native (issue-dependencies API) blockers per issue number; empty in body-only mode. */
  nativeBlockersByIssue?: NativeBlockerMap;
  conflictingPrs: readonly ConflictingPrCandidate[];
  failingCheckPrs: readonly ChecksCandidate[];
  reviewActivityPrs: readonly ReviewsCandidate[];
  issueBodies: ReadonlyMap<number, string>;
  phoebeBase?: string;
  phoebeLogin?: string;
  currentMainHead?: Sha;
};

export type WorkSelectionOptions = {
  /** When true, skip kinds with `WORK_KIND_ONE_SHOT_ELIGIBLE[kind] === false`. */
  oneShotOnly?: boolean;
};

function conflictSelectionOpts(currentMainHead?: Sha): { currentMainHead: Sha } | undefined {
  return currentMainHead ? { currentMainHead } : undefined;
}

/** Walk `workOrder` and return the first kind that has a unit of work. */
export function selectFirstWorkUnit(
  workOrder: readonly WorkKindName[],
  data: WorkSelectionData,
  opts?: WorkSelectionOptions,
): WorkUnit | null {
  const ctx: StackContext = {
    issueBodies: data.issueBodies,
    blockerStates: data.blockerStates,
  };
  for (const kind of workOrder) {
    if (opts?.oneShotOnly && !WORK_KIND_ONE_SHOT_ELIGIBLE[kind]) {
      continue;
    }
    if (kind === "conflicts") {
      const unit = selectConflictUnit(
        data.conflictingPrs,
        ctx,
        conflictSelectionOpts(data.currentMainHead),
      );
      if (unit) {
        return { kind: "conflicts", unit };
      }
    } else if (kind === "checks") {
      const unit = selectChecksUnit(data.failingCheckPrs, ctx);
      if (unit) {
        return { kind: "checks", unit };
      }
    } else if (kind === "reviews") {
      if (!data.phoebeLogin) {
        continue;
      }
      const unit = selectReviewsUnit(data.reviewActivityPrs, ctx, data.phoebeLogin);
      if (unit) {
        return { kind: "reviews", unit };
      }
    } else if (kind === "issues") {
      const unit = selectIssue(
        data.issues,
        data.blockerStates,
        data.phoebeBase,
        data.nativeBlockersByIssue,
      );
      if (unit) {
        return { kind: "issues", unit };
      }
    } else if (kind === "research") {
      // Research reuses the issues selection path (blocker + priority ordering)
      // against the researchLabel-tagged tickets gathered separately this cycle.
      const unit = selectIssue(
        data.researchIssues ?? [],
        data.blockerStates,
        data.phoebeBase,
        data.nativeBlockersByIssue,
      );
      if (unit) {
        return { kind: "research", unit };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Idle-cycle selection summaries
//
// These sit beside the selectors so main's idle logging asks "what did you skip,
// and why?" instead of rebuilding blocker maps and re-running every selector. The
// `unit` field is the same pick the live loop would make; the skip counts explain
// an idle cycle to the operator.
// ---------------------------------------------------------------------------

export type ConflictSelectionSummary = {
  unit: ConflictingPrCandidate | null;
  skippedStacked: number;
  skippedWatermark: number;
};

export function summarizeConflictSelection(
  prs: readonly ConflictingPrCandidate[],
  ctx: StackContext,
  opts?: { currentMainHead: Sha },
): ConflictSelectionSummary {
  const withoutWatermark = selectConflictFixCandidates(prs, ctx);
  const candidates = selectConflictFixCandidates(prs, ctx, opts);
  return {
    unit: pickOldestPr(candidates),
    skippedStacked: prs.length - withoutWatermark.length,
    skippedWatermark: withoutWatermark.length - candidates.length,
  };
}

export type ChecksSelectionSummary = {
  unit: ChecksCandidate | null;
  skipped: number;
};

export function summarizeChecksSelection(
  prs: readonly ChecksCandidate[],
  ctx: StackContext,
): ChecksSelectionSummary {
  const candidates = selectChecksCandidates(prs, ctx);
  return { unit: pickOldestPr(candidates), skipped: prs.length - candidates.length };
}

export type ReviewsSelectionSummary = {
  unit: ReviewsCandidate | null;
  skipped: number;
};

export function summarizeReviewsSelection(
  prs: readonly ReviewsCandidate[],
  ctx: StackContext,
  phoebeLogin: string,
): ReviewsSelectionSummary {
  const candidates = selectReviewsCandidates(prs, ctx, phoebeLogin);
  return { unit: pickOldestPr(candidates), skipped: prs.length - candidates.length };
}

/** Bound, marker-safe slug for a `UnitAttemptMarker.signature` (#25). */
export function slugifyFailureSignature(input: string, maxLen = 80): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, maxLen) || "unknown";
}

/** Failure signature for a conflict unit that produced no commit (#25). */
export function conflictFailureSignature(opts: {
  mergeable?: string;
  mergeStateStatus?: string;
}): string {
  if (!opts.mergeable) {
    return "merge-setup-failed";
  }
  return slugifyFailureSignature(
    `mergeable-${opts.mergeable}${opts.mergeStateStatus ? `-${opts.mergeStateStatus}` : ""}`,
  );
}

/** Failure signature for a checks unit that produced no commit (#25). */
export function checksFailureSignature(failingChecks: readonly FailingCheck[]): string {
  if (failingChecks.length === 0) {
    return "checks-failed";
  }
  return slugifyFailureSignature(`checks-failed-${failingChecks.map((c) => c.name).join("-")}`);
}

export function conflictFixFailureComment(
  prNumber: PrNumber,
  watermark?: ConflictFailWatermark,
): string {
  const parts = [
    `Phoebe attempted an idle merge-conflict fix (merge \`origin/main\` into this branch) ` +
      `for PR #${prNumber} but could not resolve it cleanly. The branch was left unchanged ` +
      `(\`git merge --abort\`). A human should resolve the conflicts manually.`,
  ];
  if (watermark) {
    parts.push("", buildConflictFailWatermarkMarker(watermark));
  }
  return parts.join("\n");
}

/**
 * After a sandbox conflict fix, the host may see 0 unpushed commits even when the sandbox
 * already pushed. Only post a failure comment when origin is unchanged and the PR still
 * conflicts.
 */
export function shouldPostConflictFixFailure(opts: {
  hostCommitCount: number;
  originShaBefore: Sha;
  originShaAfter: Sha;
  mergeable: string;
  mergeStateStatus?: string;
}): boolean {
  if (opts.hostCommitCount > 0) {
    return false;
  }
  if (opts.originShaAfter !== opts.originShaBefore) {
    return false;
  }
  return isPrMergeConflicting(opts.mergeable, opts.mergeStateStatus);
}

export function checksFixFailureComment(
  prNumber: PrNumber,
  watermark?: ChecksFailWatermark,
): string {
  const parts = [
    `Phoebe attempted an idle CI fix for PR #${prNumber} but could not resolve the failing ` +
      `checks. The branch was left unchanged. A human should investigate the CI failures.`,
  ];
  if (watermark) {
    parts.push("", buildChecksFailWatermarkMarker(watermark));
  }
  return parts.join("\n");
}

/**
 * After a checks fix agent run, post a failure comment only when the agent made
 * no commits and did not push.
 */
export function shouldPostChecksFixFailure(opts: {
  hostCommitCount: number;
  originShaBefore: Sha;
  originShaAfter: Sha;
}): boolean {
  if (opts.hostCommitCount > 0) {
    return false;
  }
  return opts.originShaAfter === opts.originShaBefore;
}

export function formatFailingChecksForPrompt(checks: readonly FailingCheck[]): string {
  return checks.map((c) => `${c.name}: ${c.conclusion}`).join("\n");
}

export function buildInitialPrBody(opts: {
  issueNumber: number;
  commitCount: number;
  stacked?: { blockerIssueNumber: number; blockerPrNumber: PrNumber };
}): string {
  const parts = [`Closes #${opts.issueNumber}`, "", "Automated PR from Phoebe.", ""];
  if (opts.stacked) {
    parts.push(stackedPrComment(opts.stacked.blockerIssueNumber, opts.stacked.blockerPrNumber), "");
  }
  parts.push(`Commits: ${opts.commitCount}`);
  return parts.join("\n");
}

/** Incremental note for follow-up pushes — no stacked-PR banner. */
export function followUpPrComment(issueNumber: number, commitCount: number): string {
  return `Phoebe update for #${issueNumber}: ${commitCount} new commit(s) pushed to this branch.`;
}
