// Crash-loop fallback for `phoebe boot` — the guard on a bad engine ref.
//
// The supervision loop (supervise.ts) will happily follow the tracked branch
// onto any commit someone pushes, including one that dies on startup. Without a
// guard that is an unattended container crash-looping on an unattended repo. So
// boot keeps a small record of which engine commits actually *ran*: a SHA that
// dies fast, repeatedly, is quarantined, and boot pins back to the last SHA that
// ran healthily until the tracked branch moves past the bad one.
//
// This module is that record and the decisions over it — pure folds plus a JSON
// file — so the whole ladder (first crash → threshold → fallback → recovery) is
// tested without spawning an engine. The wording an operator sees is the
// module's too (`describeEvent` below); only the sink (`log`) is the caller's.
// The wiring — when a run ends, what dir the record lives under — is boot.ts;
// the loop that calls it is supervise.ts.
//
// The record is deployment-global: one guard about one engine SHA for the whole
// fleet (#60). It lives beside the shared engine checkout on the `phoebe-engine`
// volume (`/data/engine`, default), *outside* the per-tenant `/data/repos/<owner>/<repo>`
// namespace (#62) — the crash-loop guard judges the engine, not any tenant. It
// survives the container restart the crash itself causes, which is its whole
// point.
//
// Only a github source with a moving branch is guarded. A local mount has no
// commit to pin, and a pinned ref means pinning — boot must not silently serve
// different code than the operator asked for (see boot.ts's eligibility check).
//
// This is the only crash-loop policy there is: the engine's own self-update and
// the shell supervisor that mirrored a copy of these decisions are gone (#44).
//
// **Breadth × count (#78).** In a fleet, `CRASH_LOOP_THRESHOLD` fast crashes of
// one SHA is not enough on its own to condemn it: one broken *tenant*
// crash-looping must not cost the other nine their engine. A SHA is condemned
// only when the count reaches the threshold *and* every tenant with a live
// child (the injected `roster` dep) has fast-crashed on it — breadth rules out
// "one tenant is broken", count keeps the one-off protection (a flaky network,
// a busy host). The record gains `crashedTenants`, the set of tenant ids that
// have fast-crashed on `failingSha`; `condemns` is the pure breadth × count
// query. Flat is a fleet of one (#65), so its roster is always the same single
// tenant and this reduces *exactly* to the old count-only rule. A tenant
// discovered mid-crash-loop joins the roster before it has had a chance to
// crash, so condemnation is delayed by one generation, not prevented — it will
// crash too, and then join `crashedTenants`.
//
// The persisted shape changed to add `crashedTenants`. It is not versioned: a
// file from before this change fails `isCrashLoopState` and degrades to
// `INITIAL_CRASH_LOOP_STATE` like any other unrecognised shape, the same as a
// half-written or hand-edited one. The cost is losing one fallback target
// across the upgrade, which is the module's existing, deliberate failure mode
// for any format it does not recognise — not a reason to version the file.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EngineRun } from "./supervise.ts";

/**
 * Consecutive fast crashes of one engine SHA before boot pins back to the
 * last-good one. Three is enough to rule out a one-off (a flaky network on the
 * engine's first fetch, a busy host) while still recovering in minutes.
 */
const CRASH_LOOP_THRESHOLD = 3;

/**
 * How long an engine run must survive to count as healthy. A commit that cannot
 * boot dies well inside this; a long-lived engine that later hits a runtime
 * error does not, and pinning to older code would not help it.
 */
const HEALTHY_RUN_MS = 60_000;

/** Filename of the crash-loop record inside the engine dir. */
const CRASH_LOOP_STATE_FILE = "engine-crash-loop.json";

/** Crash-loop bookkeeping, persisted across container restarts on the state volume. */
type CrashLoopState = {
  /** SHA that last ran healthily — the fallback target. */
  lastGoodSha: string | null;
  /** SHA currently accumulating fast-crash counts (or quarantined as bad). */
  failingSha: string | null;
  /** Consecutive fast crashes recorded for `failingSha`, across every tenant. */
  failureCount: number;
  /**
   * Tenant ids that have fast-crashed on `failingSha` this generation — the
   * breadth half of "breadth × count" (#78). Reset whenever `failingSha`
   * changes or its quarantine lifts.
   */
  crashedTenants: readonly string[];
};

/** Nothing known yet: no proven commit, no quarantine. */
const INITIAL_CRASH_LOOP_STATE: CrashLoopState = {
  lastGoodSha: null,
  failingSha: null,
  failureCount: 0,
  crashedTenants: [],
};

/** A finished engine run, as the fallback policy sees it. */
type RunOutcome = {
  /** The engine commit that was running. */
  sha: string;
  /** Its exit code; null when a signal killed it. */
  exitCode: number | null;
  /** How long it lived. */
  elapsedMs: number;
  /**
   * Whether boot ended this run — a reconcile drain or a container stop — rather
   * than the engine exiting of its own accord. Load-bearing: a run boot cut
   * short proves nothing either way.
   */
  requestedStop: boolean;
};

/**
 * `record`/`shouldRetry`'s outcome, dropped for a run with nothing to say
 * anything about — a local mount has no commit to judge (the null-sha drop).
 */
function toRunOutcome(run: EngineRun): RunOutcome | null {
  if (run.engine.sha === null) return null;
  return {
    sha: run.engine.sha,
    exitCode: run.exit.code,
    elapsedMs: run.elapsedMs,
    requestedStop: run.requestedStop,
  };
}

/** What a finished run proved about the commit it was running. */
type RunVerdict =
  /** The commit works — it lived past the healthy window, or finished its own work. */
  | "healthy"
  /** The commit dies on startup: the thing the fallback exists to catch. */
  | "crash"
  /** Nothing was proved, so the record must not move. */
  | "inconclusive";

/**
 * Judge a finished run. The three-way answer matters: a run that neither proved
 * nor disproved its commit has to leave the record alone, and reading it as
 * "healthy" would be the worse mistake — a container stop landing mid-crash-loop
 * would promote the crashing commit to last-good and disarm the fallback for
 * good.
 */
function judgeRun(run: RunOutcome, healthyMs: number): RunVerdict {
  // Living past the window proves the commit boots, however the run then ended.
  if (run.elapsedMs >= healthyMs) return "healthy";
  // Boot pulled the plug before the window was up: no verdict either way.
  if (run.requestedStop) return "inconclusive";
  // Exiting 0 unprompted means the engine finished what it was asked to do
  // (`--run-once`), which it could only do by booting.
  if (run.exitCode === 0) return "healthy";
  // A signal from outside — an OOM kill, a `docker kill` — says nothing about
  // the code either.
  if (run.exitCode === null) return "inconclusive";
  return "crash";
}

/**
 * The breadth × count verdict (#78): is `sha` condemned? Count alone (the old
 * rule) lets one broken tenant condemn a SHA for the whole fleet inside a
 * single generation; breadth — every tenant in `roster` (tenants with a live
 * child, held ones excluded by the caller) has fast-crashed on it too — is what
 * tells "the engine is broken" apart from "one tenant is broken". An empty
 * roster never condemns: with no live tenant to have crashed, there is no
 * breadth evidence, only a possibly-stale count. Flat's roster is always its
 * one constant tenant, so this collapses to the old count-only rule exactly.
 */
function isCondemned(
  state: CrashLoopState,
  sha: string,
  threshold: number,
  roster: readonly string[],
): boolean {
  return (
    state.failingSha === sha &&
    state.failureCount >= threshold &&
    roster.length > 0 &&
    roster.every((id) => state.crashedTenants.includes(id))
  );
}

/**
 * Fold a finished run into the record. A healthy run becomes the new last-good,
 * but a quarantine on a *different* SHA is preserved — the healthy run is
 * usually the fallback itself, and clearing the record there would send the next
 * launch straight back into the commit it is avoiding. A fast crash counts
 * against its own SHA, starting over whenever the failing SHA moves — except
 * against an *active* condemnation, which outlives it. `tenantId` is the
 * reporting tenant; `null` for a caller (`noteAlive`) whose run is always
 * healthy, so breadth bookkeeping never applies to it.
 */
function recordRun(
  state: CrashLoopState,
  run: RunOutcome,
  tenantId: string | null,
  opts: { healthyMs: number; threshold: number; roster: readonly string[] },
): CrashLoopState {
  switch (judgeRun(run, opts.healthyMs)) {
    case "inconclusive":
      return state;
    case "healthy": {
      const stillQuarantining = state.failingSha !== null && state.failingSha !== run.sha;
      return {
        lastGoodSha: run.sha,
        failingSha: stillQuarantining ? state.failingSha : null,
        failureCount: stillQuarantining ? state.failureCount : 0,
        crashedTenants: stillQuarantining ? state.crashedTenants : [],
      };
    }
    case "crash": {
      if (state.failingSha === run.sha) {
        return {
          ...state,
          failureCount: state.failureCount + 1,
          crashedTenants:
            tenantId !== null && !state.crashedTenants.includes(tenantId)
              ? [...state.crashedTenants, tenantId]
              : state.crashedTenants,
        };
      }
      // The fallback crashing too does not exonerate the commit it is standing
      // in for: the condemnation has to hold until the tracked ref moves past
      // the bad SHA, so a crash of some other commit must not overwrite it.
      if (
        state.failingSha !== null &&
        isCondemned(state, state.failingSha, opts.threshold, opts.roster)
      ) {
        return state;
      }
      return {
        lastGoodSha: state.lastGoodSha,
        failingSha: run.sha,
        failureCount: 1,
        crashedTenants: tenantId !== null ? [tenantId] : [],
      };
    }
  }
}

/**
 * Is there a better commit to relaunch onto than the one that just crashed?
 * Answers boot's question after a fast crash: retry (the fallback is reachable,
 * even if the threshold is not met yet) or give up and let the container exit.
 * Without this, a first-ever bad ref — or a fallback that crashes too — would
 * relaunch forever instead of failing where an operator can see it.
 */
function hasFallbackTarget(state: CrashLoopState, crashedSha: string): boolean {
  return state.lastGoodSha !== null && state.lastGoodSha !== crashedSha;
}

/**
 * The commit to run *instead of* `targetSha` (the tracked ref's current tip), or
 * null to run the target as normal. Non-null only once the target is condemned
 * (breadth × count, `isCondemned`) and a different known-good commit exists —
 * so the fallback lapses by itself the moment the branch advances past the bad
 * SHA, which is exactly "fallback persists until the ref moves on".
 */
function fallbackSha(
  targetSha: string,
  state: CrashLoopState,
  threshold: number,
  roster: readonly string[],
): string | null {
  if (!isCondemned(state, targetSha, threshold, roster)) return null;
  return hasFallbackTarget(state, targetSha) ? state.lastGoodSha : null;
}

/**
 * The crash-loop record's path inside the deployment-global engine dir
 * (`engineDir`, boot.ts's `engineBaseDir()`) — one guard, one engine SHA, all
 * tenants, colocated with the shared engine checkout rather than any tenant's
 * state dir (#60/#62).
 */
function crashLoopStatePath(engineDir: string): string {
  return join(engineDir, CRASH_LOOP_STATE_FILE);
}

function isCrashLoopState(value: unknown): value is CrashLoopState {
  if (value === null || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    (state["lastGoodSha"] === null || typeof state["lastGoodSha"] === "string") &&
    (state["failingSha"] === null || typeof state["failingSha"] === "string") &&
    typeof state["failureCount"] === "number" &&
    Array.isArray(state["crashedTenants"]) &&
    state["crashedTenants"].every((id) => typeof id === "string")
  );
}

/**
 * Read the record, or start fresh. Anything unreadable — no file yet, a
 * half-written one from a container killed mid-write, a hand-edited mess —
 * degrades to "nothing known" rather than failing boot: the cost is losing one
 * fallback target, and the alternative is a bootstrapper that a bad file bricks.
 */
function readCrashLoopState(path: string): CrashLoopState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isCrashLoopState(parsed)) return INITIAL_CRASH_LOOP_STATE;
    return {
      lastGoodSha: parsed.lastGoodSha,
      failingSha: parsed.failingSha,
      failureCount: parsed.failureCount,
      crashedTenants: parsed.crashedTenants,
    };
  } catch {
    return INITIAL_CRASH_LOOP_STATE;
  }
}

/**
 * Persist the record, creating the state dir if the volume is empty. Throws on a
 * genuinely unwritable state dir; the guard turns that into an event, since
 * losing the fallback is better than refusing to run the engine.
 */
function writeCrashLoopState(path: string, state: CrashLoopState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** Where the guard persists its record — injectable so tests need no temp dir. */
type CrashLoopStore = {
  read(): CrashLoopState;
  write(state: CrashLoopState): void;
};

/** The real store: a JSON file under the deployment-global engine dir. */
function defaultCrashLoopStore(path: string): CrashLoopStore {
  return {
    read: () => readCrashLoopState(path),
    write: (state) => writeCrashLoopState(path, state),
  };
}

/**
 * Everything the guard decides that is worth telling an operator about, in its
 * own words. Kept as data internally so the fold that produces it stays
 * testable independent of the wording, but the wording — a container silently
 * serving older code than its config asks for is exactly the confusing
 * situation these lines exist to prevent — is the module's, not the caller's.
 */
type CrashGuardEvent =
  | {
      kind: "crash";
      sha: string;
      exitCode: number | null;
      elapsedMs: number;
      failureCount: number;
      threshold: number;
    }
  /** A run proved its commit; it is now the fallback target. */
  | { kind: "last-good"; sha: string }
  /** This launch is pinned to `lastGoodSha` instead of the tracked ref's tip. */
  | { kind: "fallback"; quarantinedSha: string; lastGoodSha: string; failureCount: number }
  /** The fallback crashed too. The quarantine holds; boot is out of options. */
  | {
      kind: "fallback-crashed";
      sha: string;
      quarantinedSha: string;
      exitCode: number | null;
      elapsedMs: number;
    }
  /** The tracked ref moved past the quarantined commit; the pin lapses. */
  | { kind: "recovered"; quarantinedSha: string; sha: string }
  | { kind: "persist-failed"; path: string; error: unknown };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Render a guard event the way an operator sees it in the container logs. */
function describeEvent(event: CrashGuardEvent): string {
  switch (event.kind) {
    case "crash":
      return (
        `[phoebe] boot: engine ${event.sha} exited ${event.exitCode} after ` +
        `${Math.round(event.elapsedMs / 1000)}s — fast crash ${event.failureCount}/${event.threshold}.`
      );
    case "last-good":
      return `[phoebe] boot: engine ${event.sha} ran healthily — recorded as the crash-loop fallback target.`;
    case "fallback":
      return (
        `[phoebe] boot: engine ${event.quarantinedSha} crash-looped ${event.failureCount}× — ` +
        `falling back to last-good ${event.lastGoodSha}, and staying there until the tracked ` +
        `ref moves past the bad commit.`
      );
    case "fallback-crashed":
      return (
        `[phoebe] boot: the last-good engine ${event.sha} crashed too ` +
        `(exit ${event.exitCode} after ${Math.round(event.elapsedMs / 1000)}s) — ` +
        `${event.quarantinedSha} stays quarantined and the container will exit.`
      );
    case "recovered":
      return (
        `[phoebe] boot: tracked ref advanced to ${event.sha}, past quarantined ` +
        `${event.quarantinedSha} — crash-loop fallback lifted.`
      );
    case "persist-failed":
      return (
        `[phoebe] boot: could not write crash-loop state to ${event.path} — ` +
        `${describeError(event.error)}. The fallback will not survive a container restart.`
      );
  }
}

/**
 * The crash-loop guard boot supervises with: the persisted record, held in
 * memory for the life of the container and written through on every change.
 */
export type CrashGuard = {
  /**
   * The commit to run instead of `targetSha` (the tracked ref's tip), or null to
   * run the target. Called once per launch, before the engine is spawned.
   */
  fallbackFor: (targetSha: string) => string | null;
  /**
   * Fold a finished run into the record and persist it. Every run is recorded,
   * not only guarded launches: what a pinned launch proved is still worth
   * remembering, so an operator who later moves that deployment onto a branch
   * already has a target to fall back to. A run with no commit to judge (a
   * local mount) is dropped. `tenantId` is the reporting tenant — the only
   * thing about it the guard is allowed to learn (#78).
   */
  record: (run: EngineRun, tenantId: string) => void;
  /**
   * A commit is still running, and has been for `elapsedMs`. Once that passes
   * the healthy window the commit has proved itself, so it is banked as the
   * fallback target *while it runs* — an engine that has been up for a month and
   * is then killed by a host reboot would otherwise have left no record at all,
   * and the bad commit waiting on the branch would have nothing to fall back to.
   * Idempotent across every tenant on one SHA: the first tenant to outlive the
   * window exonerates the commit for all of them, and every later call is a
   * no-op (`lastGoodSha === sha` already).
   */
  noteAlive: (sha: string, elapsedMs: number) => void;
  /**
   * Is relaunching after this run worth it? Only for a guarded launch — a pinned
   * ref that crashes takes the container down, exactly as it did before there
   * was a guard — and only when a *different* known-good commit exists to end up
   * on, otherwise boot lets the container exit rather than loop on the same
   * broken commit forever. The answer does not depend on whether `record` ran
   * first: folding a crash in never changes which commit is last-good.
   */
  shouldRetry: (run: EngineRun) => boolean;
  /**
   * Is `sha` condemned right now — breadth (every tenant in the current
   * `roster`) × count (`failureCount` at `threshold`)? A pure query, unlike
   * `fallbackFor`: no persistence, no emitted event, no side effect on a lapsed
   * quarantine. `fallbackFor` uses it internally to decide the pin; a fleet
   * feeding it a live roster (not yet wired — a follow-up to #78) is its other
   * consumer.
   */
  condemns: (sha: string) => boolean;
};

export function createCrashGuard(deps: {
  /** The deployment-global engine checkout dir the record lives beside. */
  engineDir: string;
  /** Where the guard's decisions go, already worded for an operator. */
  log: (line: string) => void;
  /**
   * The tenants with a live child right now, excluding any `hold`ed one (#86):
   * a held tenant is present but not running, and counting it would block
   * condemnation forever. Read fresh on every `condemns`/`fallbackFor` call, so
   * a tenant coming, going, or being held is reflected the next call — never
   * cached across the guard's lifetime.
   */
  roster: () => readonly string[];
  /** Defaults to a JSON file at `crashLoopStatePath(engineDir)`. */
  store?: CrashLoopStore;
  threshold?: number;
  healthyMs?: number;
}): CrashGuard {
  const threshold = deps.threshold ?? CRASH_LOOP_THRESHOLD;
  const healthyMs = deps.healthyMs ?? HEALTHY_RUN_MS;
  const path = crashLoopStatePath(deps.engineDir);
  const store = deps.store ?? defaultCrashLoopStore(path);
  const emit = (event: CrashGuardEvent) => deps.log(describeEvent(event));
  let state = store.read();

  const persist = (next: CrashLoopState) => {
    state = next;
    try {
      store.write(next);
    } catch (error) {
      // In-memory bookkeeping still guards this container's life; only the
      // across-restart half is lost.
      emit({ kind: "persist-failed", path, error });
    }
  };

  return {
    fallbackFor(targetSha) {
      const roster = deps.roster();
      const pin = fallbackSha(targetSha, state, threshold, roster);
      if (pin !== null) {
        emit({
          kind: "fallback",
          quarantinedSha: targetSha,
          lastGoodSha: pin,
          failureCount: state.failureCount,
        });
        return pin;
      }
      if (state.failingSha !== null && state.failingSha !== targetSha) {
        // The tracked ref has moved on, so whatever we knew about the old commit
        // is history. Dropping it here (rather than leaving it for the next
        // crash to overwrite) is what makes the fallback lapse exactly once.
        const quarantinedSha = state.failingSha;
        const wasCondemned = isCondemned(state, quarantinedSha, threshold, roster);
        persist({
          lastGoodSha: state.lastGoodSha,
          failingSha: null,
          failureCount: 0,
          crashedTenants: [],
        });
        if (wasCondemned) emit({ kind: "recovered", quarantinedSha, sha: targetSha });
      }
      return null;
    },

    record(run, tenantId) {
      const outcome = toRunOutcome(run);
      if (outcome === null) return;

      const before = state;
      const verdict = judgeRun(outcome, healthyMs);
      const roster = deps.roster();
      persist(recordRun(before, outcome, tenantId, { threshold, healthyMs, roster }));

      if (verdict === "inconclusive") return;
      if (verdict === "healthy") {
        if (state.lastGoodSha !== before.lastGoodSha) emit({ kind: "last-good", sha: outcome.sha });
        return;
      }
      if (
        before.failingSha !== null &&
        before.failingSha !== outcome.sha &&
        isCondemned(before, before.failingSha, threshold, roster)
      ) {
        // A crash the condemnation swallowed — this is the fallback itself
        // dying, which reads very differently in a log to the tracked ref dying.
        emit({
          kind: "fallback-crashed",
          sha: outcome.sha,
          quarantinedSha: before.failingSha,
          exitCode: outcome.exitCode,
          elapsedMs: outcome.elapsedMs,
        });
        return;
      }
      emit({
        kind: "crash",
        sha: outcome.sha,
        exitCode: outcome.exitCode,
        elapsedMs: outcome.elapsedMs,
        failureCount: state.failureCount,
        threshold,
      });
    },

    noteAlive(sha, elapsedMs) {
      if (elapsedMs < healthyMs || state.lastGoodSha === sha) return;
      persist(
        recordRun(state, { sha, exitCode: null, elapsedMs, requestedStop: false }, null, {
          threshold,
          healthyMs,
          roster: deps.roster(),
        }),
      );
      emit({ kind: "last-good", sha });
    },

    shouldRetry(run) {
      if (!run.engine.guarded) return false;
      const outcome = toRunOutcome(run);
      if (outcome === null) return false;
      return judgeRun(outcome, healthyMs) === "crash" && hasFallbackTarget(state, outcome.sha);
    },

    condemns(sha) {
      return isCondemned(state, sha, threshold, deps.roster());
    },
  };
}
