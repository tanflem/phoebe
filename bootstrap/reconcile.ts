// The reconcile watch loop — `phoebe boot`'s supervision of the running engine.
//
// `boot` is the container's long-lived main process (#40): it resolves the
// engine source and execs the engine as a long-running child. This module is
// what it does for the rest of the container's life — poll the two things that
// decide *which* engine should be running, and reconcile when they diverge:
//
//   - the mounted `phoebe.config.ts` (its `engine` field picks the source), and
//   - the tip of the tracked branch, versus the commit the engine is running.
//
// On a change the engine is not killed: it is sent `SIGTERM`, which it treats as
// a graceful drain (src/drain.ts) — finish the work unit in flight, start no new
// one, exit 0. Only once it is gone does boot re-resolve the source (re-read the
// config, fetch and check out the new ref) and spawn the replacement. So a
// reconcile never interrupts a work unit and never restarts the container.
//
// A poll is deliberately cheap: one `stat` of the config plus at most one
// `git ls-remote` (see bootstrap/github-engine.ts). No fetch, no checkout, and
// no work at all when nothing moved.
//
// Following a branch means eventually following it onto a commit that does not
// boot, so the loop also reports every finished run and asks whether a
// self-exit is worth retrying. The policy behind those two hooks — count fast
// crashes, pin back to the last-good commit — is bootstrap/crash-loop.ts; all
// the loop knows is that a launch may be avoiding a quarantined commit, which
// the ref-watch must then stop treating as a change.
//
// The loop takes everything impure as a dependency — launching, spawning, the
// poll clock, the stop latch — so the drain-then-relaunch ordering is unit-tested
// without processes or timers.

import { statSync } from "node:fs";
import { REF_CHANGE_DRAIN_SIGNAL } from "../src/drain.ts";
import type { ResolvedEngineSource } from "./engine-source.ts";

/** How often the watch samples the config and the tracked ref. */
export const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;

/**
 * How long a reconcile-triggered drain (config/ref change) gets before boot
 * escalates to SIGKILL. Generous by design: it exists only to bound a *wedged*
 * drain (a stuck git push, a hung process), not the normal "finish the unit"
 * wait — that is already bounded by the engine's own whole-unit run timeout
 * (`runTimeoutMs`, default 45 min, #72) plus its own SIGKILL escalation. This
 * must stay comfortably above that so a healthy, still-working unit is never
 * cut off mid-drain (#23's own acceptance: a ref change must not interrupt the
 * unit in flight). Coordinates with JesusFilm/phoebe#79, which bounds the
 * nested-fleet drain (bootstrap/supervise-fleet.ts) the same way.
 */
export const DEFAULT_RECONCILE_DRAIN_TIMEOUT_MS = 60 * 60_000;

/**
 * How long boot waits before relaunching an engine that crashed. Long enough
 * that a commit dying instantly cannot spin the loop, short enough that the
 * crash-loop guard reaches its verdict in well under a minute. Deliberately not
 * the poll interval: a consumer who slows their reconcile poll down to a
 * quarter-hour should not thereby wait an hour for a fallback.
 */
export const CRASH_BACKOFF_MS = 10_000;

/** Which of the two watched inputs moved, and so why the engine is relaunching. */
export type ReconcileReason = "config" | "ref";

/**
 * A single sample of the watched world.
 * - `config`: the mounted config's stat fingerprint; null when it cannot be read.
 * - `remoteSha`: the tracked branch's current tip; null when there is nothing to
 *   watch — a local mount, a pinned SHA/tag, or a ref the remote does not have.
 */
export type WatchState = {
  config: string | null;
  remoteSha: string | null;
};

/** A running engine, and the world it was launched from. */
export type LaunchedEngine = {
  /** The engine CLI path that was spawned. */
  entry: string;
  /** Source provenance passed to the runtime status contract. */
  source?: ResolvedEngineSource;
  /** The commit it is running; null for a local mount (nothing to compare). */
  sha: string | null;
  /** The config fingerprint at launch. */
  config: string | null;
  /** Sample the watched inputs now, bound to the source this engine came from. */
  sample: () => WatchState;
  /**
   * The crash-looping commit this launch is avoiding, when it is a crash-loop
   * fallback (bootstrap/crash-loop.ts) — the tracked branch still points there,
   * and the watch must not read that as a change to chase. Null normally.
   */
  quarantinedSha: string | null;
  /**
   * Whether the crash-loop guard covers this launch — true only for a github
   * source tracking a moving branch. The loop only carries it through to the
   * exit hooks; boot.ts is what decides with it.
   */
  guarded: boolean;
  /**
   * Canonical resolved config handed to the child so it cannot re-read a
   * different authored state than the one that selected this engine source.
   */
  resolvedConfiguration?: string;
};

export type EngineExit = { code: number | null; signal: NodeJS.Signals | null };

/** A finished engine run: what was running, how it ended, and how long it lived. */
export type EngineRun = {
  engine: LaunchedEngine;
  exit: EngineExit;
  elapsedMs: number;
  /**
   * Whether boot ended this run (a reconcile drain, or a container stop) rather
   * than the engine exiting of its own accord — the difference between evidence
   * about the engine commit and evidence about nothing.
   */
  requestedStop: boolean;
};

/** The supervised engine child: enough of a process to drain it and await it. */
export type SupervisedChild = {
  kill: (signal: NodeJS.Signals) => void;
  exited: Promise<EngineExit>;
};

/**
 * The outside stop request (container `SIGTERM`/`SIGINT`). A one-way latch whose
 * `wait` doubles as the poll clock, so a shutdown wakes the loop immediately
 * instead of sleeping out a whole poll interval — `installDrainSignal`
 * (src/drain.ts) is exactly this shape.
 */
export type StopLatch = {
  readonly requested: boolean;
  wait: (ms: number) => Promise<void>;
};

export type SuperviseDeps = {
  /** Re-read the config, resolve + materialize the engine source. */
  launch: () => Promise<LaunchedEngine> | LaunchedEngine;
  /** Spawn the engine as a long-running child. */
  spawn: (entry: string, engine: LaunchedEngine) => SupervisedChild;
  stop: StopLatch;
  intervalMs?: number;
  /** Reads the clock for run durations; injectable so the loop is tested without waiting. */
  now?: () => number;
  onRelaunch?: (reason: ReconcileReason) => void;
  onLaunchError?: (error: unknown) => void;
  onSampleError?: (error: unknown) => void;
  /**
   * Every finished run, however it ended — drained for a reconcile, stopped with
   * the container, or crashed. The crash-loop guard's bookkeeping hook: this is
   * where boot learns a commit ran healthily, or died on startup.
   */
  onRunEnd?: (run: EngineRun) => void;
  /**
   * Each poll tick, with how long the engine has been up. The guard's other half:
   * it banks a commit as proven while it is still running, so an engine that has
   * been up for weeks and is then killed outright still leaves a fallback target
   * behind.
   */
  onRunTick?: (tick: { engine: LaunchedEngine; elapsedMs: number }) => void;
  /**
   * The engine exited on its own. True relaunches it — the crash-loop guard
   * choosing to try again (possibly onto the last-good commit) rather than let a
   * bad engine take the container down; false propagates the exit, which is the
   * default and the only behaviour when no guard is wired.
   */
  relaunchAfterExit?: (run: EngineRun) => boolean;
  /**
   * How long a reconcile-triggered drain gets before boot escalates to
   * SIGKILL (#23). Defaults to `DEFAULT_RECONCILE_DRAIN_TIMEOUT_MS`.
   */
  drainTimeoutMs?: number;
  /**
   * Sleeps for the drain-timeout race; injectable so the bound is unit-tested
   * without a real timer. Defaults to a real `setTimeout`.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * A reconcile-triggered drain exceeded its bound and boot escalated to
   * SIGKILL — the engine did not finish its unit (or exit) in time.
   */
  onDrainTimeout?: (reason: ReconcileReason) => void;
};

/**
 * A cheap identity for the mounted config: mtime plus size. A stat is all a
 * no-change poll should cost, and any edit — in place or a replacing rename —
 * moves the mtime. Unreadable (missing, mid-rewrite, mount blip) is null, which
 * `detectChange` reads as "unknown", never as a change.
 */
export function configFingerprint(
  path: string,
  stat: (path: string) => { mtimeMs: number; size: number } = statSync,
): string | null {
  try {
    const stats = stat(path);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return null;
  }
}

/**
 * Fingerprint every authored layer that decides what deployment should run.
 * With no generated base this is exactly the legacy repository fingerprint.
 * Once a base path is configured, its missing/unreadable state is itself a
 * fingerprint: losing a required generated document must drain the old engine
 * and keep a replacement from starting, not silently continue new work.
 */
export function deploymentConfigFingerprint(
  repositoryPath: string,
  basePath: string | undefined,
  stat: (path: string) => { mtimeMs: number; size: number } = statSync,
): string | null {
  const repository = configFingerprint(repositoryPath, stat);
  if (basePath === undefined || repository === null) return repository;
  const base = configFingerprint(basePath, stat);
  return `${repository}|base:${base ?? "unreadable"}`;
}

/**
 * Is the running engine stale? Compares the live sample against what the engine
 * was launched from — not against the previous sample — so the answer is always
 * "is what's running still right", which survives a missed poll and cannot
 * relaunch twice for the same change.
 *
 * Either side being null means "nothing to compare" and yields no relaunch: an
 * unreadable config must not restart the engine, and a null `remoteSha` is how a
 * local mount and a pinned SHA/tag report an inert ref-watch.
 *
 * One tip is deliberately ignored: the quarantined commit a crash-loop fallback
 * is running away from (bootstrap/crash-loop.ts). While the branch still points
 * there, "the running engine is not on the tip" is the intended state, not a
 * change — reading it as one would relaunch straight back into the bad commit.
 */
export function detectChange(opts: {
  launched: { config: string | null; sha: string | null; quarantinedSha?: string | null };
  current: WatchState;
}): ReconcileReason | null {
  const { launched, current } = opts;
  // Config first: re-reading it can change which ref is even tracked.
  if (launched.config !== null && current.config !== null && current.config !== launched.config) {
    return "config";
  }
  if (launched.sha !== null && current.remoteSha !== null && current.remoteSha !== launched.sha) {
    return current.remoteSha === launched.quarantinedSha ? null : "ref";
  }
  return null;
}

type WatchOutcome =
  | { kind: "exit"; exit: EngineExit }
  | { kind: "change"; reason: ReconcileReason };

/**
 * Poll until the engine exits by itself, the container is stopping, or a watched
 * input moves. Races the child's exit against the poll clock so neither a long
 * poll interval nor a quiet engine delays the other.
 */
async function watchEngine(
  engine: LaunchedEngine,
  child: SupervisedChild,
  deps: SuperviseDeps,
  clock: { intervalMs: number; startedAt: number; now: () => number },
): Promise<WatchOutcome> {
  const { intervalMs } = clock;
  // One reaction on the child's exit for the whole watch — re-deriving it each
  // iteration would pile up handlers on a promise that outlives thousands of
  // polls over a long-lived container.
  const exitOutcome = child.exited.then((exit) => ({ kind: "exit" as const, exit }));
  while (true) {
    const raced = await Promise.race([
      exitOutcome,
      deps.stop.wait(intervalMs).then(() => ({ kind: "tick" as const })),
    ]);
    if (raced.kind === "exit") return raced;

    if (deps.stop.requested) {
      // The container is going down. The spawn wrapper forwards the signal to
      // the child, but one that arrived before this child existed never reached
      // it — so re-send (the engine's drain latch is one-way and idempotent) and
      // wait the drain out rather than relaunching into a shutdown.
      child.kill("SIGTERM");
      return { kind: "exit", exit: await child.exited };
    }

    deps.onRunTick?.({ engine, elapsedMs: clock.now() - clock.startedAt });

    let current: WatchState;
    try {
      current = engine.sample();
    } catch (error) {
      // A failed poll (network blip on `ls-remote`, unreadable mount) is not a
      // change — leave the engine alone and look again next tick.
      deps.onSampleError?.(error);
      continue;
    }

    const reason = detectChange({
      launched: { config: engine.config, sha: engine.sha, quarantinedSha: engine.quarantinedSha },
      current,
    });
    if (reason) return { kind: "change", reason };
  }
}

/**
 * Run the engine, and keep the *right* engine running: watch, drain, relaunch,
 * repeat. Resolves with the exit to give the container when the engine exits on
 * its own (and the crash-loop guard does not want it retried) or the container
 * is stopping — the two cases where boot should stop supervising and die with
 * the engine's status.
 */
export async function superviseEngine(deps: SuperviseDeps): Promise<EngineExit> {
  const intervalMs = deps.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
  const now = deps.now ?? Date.now;
  let everLaunched = false;

  while (true) {
    if (deps.stop.requested) return { code: 0, signal: null };

    let engine: LaunchedEngine;
    try {
      engine = await deps.launch();
    } catch (error) {
      // The first launch is the container's whole reason to exist, so a bad
      // config or a missing mount fails loudly. A *relaunch* failure is
      // transient by comparison (network blip mid-fetch, a ref deleted between
      // poll and fetch) and the old engine has already drained — retrying on the
      // next poll brings the engine back instead of taking the container down.
      if (!everLaunched) throw error;
      deps.onLaunchError?.(error);
      await deps.stop.wait(intervalMs);
      continue;
    }
    everLaunched = true;

    const startedAt = now();
    const child = deps.spawn(engine.entry, engine);
    const outcome = await watchEngine(engine, child, deps, { intervalMs, startedAt, now });

    if (outcome.kind === "exit") {
      // A stop makes the engine's exit the container's exit, whatever the guard
      // would have preferred — we are going down either way, and the run was cut
      // short rather than judged.
      const requestedStop = deps.stop.requested;
      const run = { engine, exit: outcome.exit, elapsedMs: now() - startedAt, requestedStop };
      deps.onRunEnd?.(run);
      if (requestedStop || !deps.relaunchAfterExit?.(run)) return outcome.exit;
      // Retrying a crash: back off first, so a commit that dies on startup
      // cannot spin the loop, and re-check the stop latch the wait may have
      // woken on. `launch` runs again from the top, which is where the fallback
      // to a last-good commit actually takes effect.
      await deps.stop.wait(CRASH_BACKOFF_MS);
      if (deps.stop.requested) return outcome.exit;
      continue;
    }

    deps.onRelaunch?.(outcome.reason);
    // A ref change gets a distinct signal from a plain container stop, so the
    // draining engine's own status snapshot can report *why* (#23,
    // src/drain.ts). A config change is not (yet) distinguished from a plain
    // stop — it stays on SIGTERM.
    child.kill(outcome.reason === "ref" ? REF_CHANGE_DRAIN_SIGNAL : "SIGTERM");
    // Nothing new starts until the drain finishes: one engine at a time, and the
    // in-flight work unit runs to completion — but bounded, so an engine wedged
    // mid-drain cannot hang the upgrade forever.
    const exit = await boundedDrain(child, {
      timeoutMs: deps.drainTimeoutMs ?? DEFAULT_RECONCILE_DRAIN_TIMEOUT_MS,
      sleep: deps.sleep ?? defaultSleep,
      onTimeout: () => deps.onDrainTimeout?.(outcome.reason),
    });
    deps.onRunEnd?.({ engine, exit, elapsedMs: now() - startedAt, requestedStop: true });
    if (deps.stop.requested) return exit;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    // A timer that outlives the race it belongs to (the child exited first)
    // must not itself keep the process alive for up to an hour.
    setTimeout(resolve, ms).unref();
  });

/**
 * Await a drained child, escalating to SIGKILL if it has not exited within
 * `timeoutMs`. The bound exists only for a wedged drain (a stuck git push, a
 * hung process) — a healthy unit that is merely still running is expected to
 * finish well inside it (see `DEFAULT_RECONCILE_DRAIN_TIMEOUT_MS`).
 */
async function boundedDrain(
  child: SupervisedChild,
  opts: { timeoutMs: number; sleep: (ms: number) => Promise<void>; onTimeout: () => void },
): Promise<EngineExit> {
  const exitOutcome = child.exited.then((exit) => ({ kind: "exit" as const, exit }));
  const timeoutOutcome = opts.sleep(opts.timeoutMs).then(() => ({ kind: "timeout" as const }));
  const raced = await Promise.race([exitOutcome, timeoutOutcome]);
  if (raced.kind === "exit") return raced.exit;
  opts.onTimeout();
  child.kill("SIGKILL");
  return child.exited;
}
