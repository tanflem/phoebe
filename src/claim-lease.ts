// Crash-safe issue claims (#15). A bare `ready-for-phoebe` → `phoebe-processing`
// label flip carries no owner id and no timestamp, so a runtime that dies
// between labeling and pushing a branch orphans the claim forever — nothing
// re-claims a `phoebe-processing` issue, because selection only ever looks at
// `ready-for-phoebe`. This module is the policy: a lease marker (runtime id +
// claimed-at + heartbeat-at + branch) posted as an issue comment alongside the
// label, refreshed while the run is alive, and read back by a reclaim sweep
// that flips expired/abandoned/marker-less claims back to `ready-for-phoebe`.
//
// State lives entirely on GitHub (the marker comment + the label), matching
// #75's quarantine marker — it survives container/volume loss. The
// marker/decision builders here mirror quarantine.ts's `build*`/`parse*`
// family, read via orchestrator.ts's `parseLatestMarker` (latest wins, since a
// heartbeat posts a fresh comment each tick rather than editing in place).

/** Default lease TTL: long enough that a normal run's heartbeats never lapse
 *  it, short enough that an orphaned claim self-heals promptly. */
export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

/**
 * Resolve the lease TTL: `PHOEBE_LEASE_TTL_MS` (a positive number) wins, else
 * the config field, else the default 30 minutes. Mirrors #75's
 * `resolveMaxUnitTimeouts` — a fleet-protection backstop, not a per-repo
 * tuning knob most consumers need to touch.
 */
export function resolveLeaseTtlMs(
  env: NodeJS.ProcessEnv,
  configValue: number = DEFAULT_LEASE_TTL_MS,
): number {
  const raw = Number(env["PHOEBE_LEASE_TTL_MS"]);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return Number.isFinite(configValue) && configValue > 0 ? configValue : DEFAULT_LEASE_TTL_MS;
}

/**
 * How often to refresh the heartbeat while a claim is held. A third of the
 * TTL, so a single missed/delayed heartbeat never lapses the lease — it takes
 * two or three in a row before `nowMs - heartbeatAt` crosses the TTL.
 */
export function leaseHeartbeatIntervalMs(ttlMs: number): number {
  return Math.max(30_000, Math.floor(ttlMs / 3));
}

export type LeaseMarker = {
  runtimeId: string;
  claimedAt: string;
  heartbeatAt: string;
  branch: string;
};

const LEASE_MARKER_RE =
  /<!--\s*phoebe-lease:\s*runtimeId=(\S+)\s+claimedAt=(\S+)\s+heartbeatAt=(\S+)\s+branch=(\S+)\s*-->/i;

export function buildLeaseMarker(lease: LeaseMarker): string {
  return `<!-- phoebe-lease: runtimeId=${lease.runtimeId} claimedAt=${lease.claimedAt} heartbeatAt=${lease.heartbeatAt} branch=${lease.branch} -->`;
}

export function parseLeaseMarker(text: string): LeaseMarker | null {
  const match = LEASE_MARKER_RE.exec(text);
  if (!match) return null;
  return {
    runtimeId: match[1]!,
    claimedAt: match[2]!,
    heartbeatAt: match[3]!,
    branch: match[4]!,
  };
}

/** Posted on claim, and again on every heartbeat tick — `parseLatestMarker`
 *  over an issue's comments always resolves to the freshest one. */
export function buildLeaseComment(lease: LeaseMarker): string {
  return [
    `🔒 Phoebe holds a lease on this issue — runtime \`${lease.runtimeId}\`, branch \`${lease.branch}\`.`,
    "",
    "This lease is refreshed periodically while work is in progress. If the " +
      "heartbeat goes stale (the runtime died) or this runtime restarts, Phoebe " +
      "reclaims the issue back to the ready queue automatically — no manual relabel needed.",
    "",
    buildLeaseMarker(lease),
  ].join("\n");
}

const RECLAIM_REASON_TEXT: Record<ReclaimReason, string> = {
  "no-lease":
    "no lease marker was found (a bare label flip, or a claim from before this feature shipped)",
  "own-restart": "this runtime restarted, so any claim it still held is dead",
  expired: "the lease heartbeat went stale past the TTL",
};

export function buildReclaimComment(reason: ReclaimReason): string {
  return `♻️ Phoebe reclaimed this issue back to the ready queue — ${RECLAIM_REASON_TEXT[reason]}.`;
}

export type ReclaimReason = "no-lease" | "own-restart" | "expired";

/** Same shape as `main.ts`'s `gh` wrapper — injected so tests assert argv. */
export type GhRunner = (args: string[], opts?: { input?: string }, repo?: string) => void;

/**
 * Flip the claim labels as two explicit calls, add before remove (#81), never
 * one combined `gh issue edit --add-label --remove-label`. `gh` performs the
 * add and the remove as separate API calls regardless, so a combined edit
 * that fails partway can strand an issue with neither label — invisible to
 * both `selectIssue` (which needs `readyLabel`) and the reclaim sweep (which
 * needs `processingLabel`). Ordering add-before-remove means a failure
 * between the two calls instead leaves *both* labels, a state the reclaim
 * sweep already knows how to find and resolve.
 */
export function claimIssueLabels(
  opts: { issueNumber: number; processingLabel: string; readyLabel: string; repoSlug: string },
  gh: GhRunner,
): void {
  gh(
    ["issue", "edit", String(opts.issueNumber), "--add-label", opts.processingLabel],
    undefined,
    opts.repoSlug,
  );
  gh(
    ["issue", "edit", String(opts.issueNumber), "--remove-label", opts.readyLabel],
    undefined,
    opts.repoSlug,
  );
}

/**
 * Decide whether a `phoebe-processing` issue's lease should be reclaimed.
 *
 * - No marker at all ⇒ always reclaim (`no-lease`) — this is exactly the
 *   orphan case #15 exists to fix, including any pre-existing bare label
 *   flip from before this shipped.
 * - `forceOwnReclaim` (boot only) ⇒ a claim under this runtime's own id is
 *   reclaimed unconditionally, regardless of TTL: a fresh process start is
 *   proof the prior holder of this persisted runtime id is dead, so there is
 *   no reason to wait out the TTL. This must stay boot-only — applying it
 *   every cycle would let a *live* process instantly re-reclaim (and
 *   thrash-retry) its own just-failed unit instead of backing off for the
 *   TTL like any other claim.
 * - Otherwise, reclaim only once the heartbeat is older than the TTL (or is
 *   unparseable, which is treated the same as stale — a lease Phoebe cannot
 *   read is not a lease Phoebe can trust). A fresh heartbeat is never
 *   reclaimed, so a slow-but-alive run is never yanked mid-flight.
 */
export function reclaimDecision(
  lease: LeaseMarker | null,
  opts: { ownRuntimeId: string; nowMs: number; ttlMs: number; forceOwnReclaim: boolean },
): ReclaimReason | null {
  if (lease === null) return "no-lease";
  if (opts.forceOwnReclaim && lease.runtimeId === opts.ownRuntimeId) return "own-restart";
  const heartbeatMs = Date.parse(lease.heartbeatAt);
  if (!Number.isFinite(heartbeatMs) || opts.nowMs - heartbeatMs > opts.ttlMs) return "expired";
  return null;
}
