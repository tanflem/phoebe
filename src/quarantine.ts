// Poison-unit repeat protection (#75) — a unit-scoped quarantine policy layered
// on #73's `UnitEvent`/`emitUnitEvent` rail and a GitHub-marker durable home.
//
// #72's timeout keeps a hung unit from starving the fleet, but it does not stop
// a *genuinely* poisonous unit — one that hangs the agent every rotation — from
// being re-picked forever, burning the full budget and producing nothing. This
// module is the policy: count consecutive timeouts per `(kind, id)`, and at K
// apply a `phoebe:quarantined` label + an escalation comment so a human takes
// over. State lives entirely on GitHub (a timeout-counter marker + the label),
// so it survives container/volume loss — the reason #73 chose markers over a
// local file. All of this is engine-side, in the per-tenant poll/selection
// layer: it touches zero of the crash-loop guard and sends the supervisor
// nothing, so a poison *unit* can never quarantine a healthy *engine SHA* (#60).
//
// The marker/comment builders here mirror the `*FailWatermark` family in
// orchestrator.ts (`build*`/`parse*`, read via `parseLatestMarker`).
//
// #25 generalises the same label/comment/baseline machinery to a second
// trigger: K consecutive attempts that produce no commit, on the PR-keyed work
// kinds (conflicts/checks) the #75 timeout counter above never covers, since
// those runs fail fast at verification rather than hanging. `UnitAttemptMarker`
// below is that counter — kind-scoped (a PR can be failing conflicts *and*
// checks at once, each with its own count) and reset-on-commit via `ref`
// (the PR head SHA at last count), the PR-unit analogue of #75's
// activity-staleness check. It shares `PHOEBE_QUARANTINE_LABEL` and
// `buildQuarantineComment` with the timeout trigger — same mechanism, a new
// counting rule — but is a distinct counter/config knob (`maxUnitAttempts`),
// since "hung" and "fails fast with no commit" are different failure shapes
// worth tuning independently.
//
// #22 is the issue-keyed sibling of #25's trigger: a claim→release cycle
// (issues/research) that fails verification and produces no `<branchPrefix>issue-<n>`
// branch/PR is the same "fails fast, never hangs" shape #75's timeout counter
// misses. It reuses `UnitAttemptMarker`/`planUnitAttempt`/`buildUnitAttemptMarker`
// as-is, kind-scoped by `"issues"`/`"research"` and the same `maxUnitAttempts`
// knob — but `ref` is the issue number (constant across attempts) rather than
// a moving head SHA, since an issue-keyed unit has no in-progress ref to
// stale-check against: the caller resets the counter explicitly the moment a
// run produces a PR, instead of inferring progress from `ref` advancing.
// `buildQuarantineComment`'s optional `dependents` list is this trigger's one
// addition — the other issues left stuck behind a quarantined blocker.

import type { Sha } from "./branded.ts";

/** Phoebe-owned skip label — distinct from the user-supplied `prOptOutLabel`. */
export const PHOEBE_QUARANTINE_LABEL = "phoebe:quarantined";

/** Positive-integer env override wins, else the config field, else `fallback`. */
function resolveThreshold(
  envValue: string | undefined,
  configValue: number,
  fallback: number,
): number {
  const raw = Number(envValue);
  if (Number.isInteger(raw) && raw >= 1) return raw;
  return Number.isInteger(configValue) && configValue >= 1 ? configValue : fallback;
}

/** Consecutive timeouts before quarantine; the #75 house number. */
export const DEFAULT_MAX_UNIT_TIMEOUTS = 3;

/**
 * Resolve K: `PHOEBE_MAX_UNIT_TIMEOUTS` (a positive integer) wins, else the
 * config field, else the default 3. A fleet-protection backstop, not a per-repo
 * tuning knob (mirrors #72's timeout resolution).
 */
export function resolveMaxUnitTimeouts(
  env: NodeJS.ProcessEnv,
  configValue: number = DEFAULT_MAX_UNIT_TIMEOUTS,
): number {
  return resolveThreshold(env["PHOEBE_MAX_UNIT_TIMEOUTS"], configValue, DEFAULT_MAX_UNIT_TIMEOUTS);
}

/** Consecutive no-progress attempts before quarantine (#25, #22); the house number. */
export const DEFAULT_MAX_UNIT_ATTEMPTS = 3;

/**
 * Resolve K for the no-progress-attempt trigger — no commit for a PR-keyed
 * unit (#25) or no PR for an issue-keyed one (#22): `PHOEBE_MAX_UNIT_ATTEMPTS`
 * wins, else the config field, else the default 3.
 */
export function resolveMaxUnitAttempts(
  env: NodeJS.ProcessEnv,
  configValue: number = DEFAULT_MAX_UNIT_ATTEMPTS,
): number {
  return resolveThreshold(env["PHOEBE_MAX_UNIT_ATTEMPTS"], configValue, DEFAULT_MAX_UNIT_ATTEMPTS);
}

// --- Timeout counter marker (posted on every timeout; embeds n) --------------

const UNIT_TIMEOUT_MARKER_RE = /<!--\s*phoebe-unit-timeout:\s*n=(\d+)\s*-->/i;

export function buildUnitTimeoutMarker(n: number): string {
  return `<!-- phoebe-unit-timeout: n=${n} -->`;
}

export function parseUnitTimeoutMarker(text: string): { n: number } | null {
  const match = UNIT_TIMEOUT_MARKER_RE.exec(text);
  return match ? { n: Number(match[1]) } : null;
}

// --- Quarantine baseline marker (in the escalation comment, for auto-unstick) -

const QUARANTINE_BASELINE_RE = /<!--\s*phoebe-quarantine-baseline:\s*([^\s>]+)\s*-->/i;

export function buildQuarantineBaselineMarker(baseline: string): string {
  return `<!-- phoebe-quarantine-baseline: ${baseline} -->`;
}

export function parseQuarantineBaseline(text: string): string | null {
  const match = QUARANTINE_BASELINE_RE.exec(text);
  return match ? match[1]! : null;
}

/**
 * The one escalation comment posted at threshold: says the unit timed out K
 * times and needs a human, and records the baseline (PR head SHA for
 * conflicts/checks/reviews; issue `lastEditedAt` for issues/research) so the
 * auto-un-stick sweep can tell when someone has actually changed the thing.
 */
export function buildQuarantineComment(opts: {
  kind: string;
  id: number;
  k: number;
  baseline: string;
  /** What kept happening, e.g. "timed out" (#75) or "produced no commit" (#25). */
  reason: string;
  /** Last observed failure detail (#25) — carried so the cause is visible without container logs. */
  signature?: string;
  /** Open issues blocked on this one (#22) — named so a stalled chain is visible without digging. */
  dependents?: readonly number[];
}): string {
  const detail = opts.signature ? ` Last failure: \`${opts.signature}\`.` : "";
  const dependentsLine =
    opts.dependents && opts.dependents.length > 0
      ? [
          "",
          `This also keeps ${opts.dependents.map((n) => `#${n}`).join(", ")} blocked until it's resolved.`,
        ]
      : [];
  return [
    `⚠️ Phoebe quarantined this unit: the \`${opts.kind}\` work on #${opts.id} ${opts.reason} ` +
      `${opts.k} times in a row without completing.${detail} It has been labelled ` +
      `\`${PHOEBE_QUARANTINE_LABEL}\` and skipped so it stops burning the run budget. ` +
      `A human should take a look.`,
    ...dependentsLine,
    "",
    `Remove the \`${PHOEBE_QUARANTINE_LABEL}\` label to retry, or push a fix / edit the ` +
      `issue — Phoebe auto-clears the label when the content advances past the baseline below.`,
    "",
    buildQuarantineBaselineMarker(opts.baseline),
  ].join("\n");
}

// --- Pure counting + quarantine decision -------------------------------------

/**
 * The next timeout count to record for a unit. Reset-on-activity (#75): if the
 * unit has newer activity than the latest timeout marker (a newer commit or
 * comment), the prior count is stale and treated as 0; otherwise carry it. Then
 * increment for this timeout. A missing prior marker means this is the first.
 */
export function nextTimeoutCount(previous: number | null, staleActivity: boolean): number {
  const base = staleActivity ? 0 : (previous ?? 0);
  return base + 1;
}

/** Quarantine when the recorded count reaches the threshold. */
export function shouldQuarantine(count: number, k: number): boolean {
  return count >= k;
}

/**
 * Whether a quarantined unit should be auto-un-stuck: someone changed the thing
 * that hung. A PR unit clears when its head SHA advanced past baseline; an issue
 * unit clears when its `lastEditedAt` is newer than baseline. A bare human
 * comment (no content change) does not clear it — it can't silently re-arm a
 * unit no one has fixed.
 */
export function shouldAutoUnstick(opts: {
  baseline: string;
  currentHeadSha?: Sha;
  currentIssueEditedAt?: string;
}): boolean {
  if (opts.currentHeadSha !== undefined) {
    return opts.currentHeadSha !== opts.baseline;
  }
  if (opts.currentIssueEditedAt !== undefined) {
    return opts.currentIssueEditedAt > opts.baseline;
  }
  return false;
}

// --- No-commit attempt counter (#25) -----------------------------------------
//
// One tracking comment per `(kind, id)`, created on the first failed attempt
// and *edited* (never reposted) on every attempt after — the fix for "a fresh
// comment every cycle". The marker embeds `ref` (the PR head SHA at the time of
// that attempt) so a later read can tell a stale count (the unit produced a
// commit since) from a live one, without a separate watermark: `nextAttemptCount`
// resets to 0 whenever `ref` no longer matches the unit's current head.

export type UnitAttemptMarker = {
  n: number;
  /** Short slug of what went wrong, e.g. `mergeable-conflicting`. */
  signature: string;
  /** The unit's identity reference at this attempt (PR head SHA today). */
  ref: string;
  /** ISO timestamp of this attempt — the backoff clock. */
  at: string;
};

function unitAttemptMarkerRe(kind: string): RegExp {
  return new RegExp(
    `<!--\\s*phoebe-unit-attempt:${kind}\\s+n=(\\d+)\\s+sig=([a-z0-9-]+)\\s+ref=([A-Za-z0-9._:-]+)\\s+at=([0-9TZ:.+-]+)\\s*-->`,
    "i",
  );
}

/** `kind` is embedded in the marker tag itself, so each kind gets its own counter on the same unit. */
export function buildUnitAttemptMarker(kind: string, marker: UnitAttemptMarker): string {
  return `<!-- phoebe-unit-attempt:${kind} n=${marker.n} sig=${marker.signature} ref=${marker.ref} at=${marker.at} -->`;
}

export function parseUnitAttemptMarker(kind: string, text: string): UnitAttemptMarker | null {
  const match = unitAttemptMarkerRe(kind).exec(text);
  if (!match) {
    return null;
  }
  return { n: Number(match[1]), signature: match[2]!, ref: match[3]!, at: match[4]! };
}

/**
 * Scan comment bodies newest-first for the latest `kind`-scoped attempt marker,
 * returning it along with the id of the comment that carries it (so the caller
 * can edit that comment in place instead of posting a new one).
 */
export function findLatestUnitAttemptComment(
  comments: readonly { id: string; body: string }[],
  kind: string,
): { marker: UnitAttemptMarker; commentId: string } | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const marker = parseUnitAttemptMarker(kind, comments[i]!.body);
    if (marker) {
      return { marker, commentId: comments[i]!.id };
    }
  }
  return null;
}

/**
 * The next attempt count for a unit. Reset-on-commit: if `currentRef` (the PR
 * head SHA now) doesn't match the marker's recorded `ref`, the unit has moved
 * since — a commit landed — so the prior count is stale and treated as 0.
 */
export function nextAttemptCount(previous: UnitAttemptMarker | null, currentRef: string): number {
  const stale = previous === null || previous.ref !== currentRef;
  const base = stale ? 0 : previous.n;
  return base + 1;
}

export type UnitAttemptPlan = {
  marker: UnitAttemptMarker;
  quarantined: boolean;
};

/** Fold one failed attempt into the next marker + whether it crosses the quarantine threshold. */
export function planUnitAttempt(opts: {
  previous: UnitAttemptMarker | null;
  ref: string;
  signature: string;
  now: string;
  k: number;
}): UnitAttemptPlan {
  const n = nextAttemptCount(opts.previous, opts.ref);
  return {
    marker: { n, signature: opts.signature, ref: opts.ref, at: opts.now },
    quarantined: shouldQuarantine(n, opts.k),
  };
}

/** Exponential backoff between retries below the quarantine threshold, capped. */
export const DEFAULT_UNIT_BACKOFF_BASE_MS = 5 * 60_000;
export const DEFAULT_UNIT_BACKOFF_CAP_MS = 60 * 60_000;

export function unitBackoffMs(
  attemptCount: number,
  baseMs: number = DEFAULT_UNIT_BACKOFF_BASE_MS,
  capMs: number = DEFAULT_UNIT_BACKOFF_CAP_MS,
): number {
  if (attemptCount <= 0) {
    return 0;
  }
  return Math.min(baseMs * 2 ** (attemptCount - 1), capMs);
}

/**
 * Whether a unit that has already failed `attemptCount` times in a row should
 * skip dispatch this cycle — a transient failure (rate limit, 504) then gets a
 * growing gap before the next try instead of burning a full cycle every poll.
 */
export function shouldBackoffUnitRetry(opts: {
  attemptCount: number;
  lastAttemptAt: string;
  now: string;
  baseMs?: number;
  capMs?: number;
}): boolean {
  if (opts.attemptCount <= 0) {
    return false;
  }
  const elapsedMs = Date.parse(opts.now) - Date.parse(opts.lastAttemptAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return false;
  }
  return elapsedMs < unitBackoffMs(opts.attemptCount, opts.baseMs, opts.capMs);
}
