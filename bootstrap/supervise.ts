// The supervision loop — `phoebe boot`'s watch over the running engine(s), for
// every deployment topology (#65, map #44).
//
// Flat, nested, and workspace deployments used to run two separately-maintained
// loops (`superviseEngine` for flat's single child, `superviseFleet` for nested/
// workspace's N children) that happened to reimplement the same stop latch, the
// same poll interval, the same drain-then-relaunch ordering, and the same
// `detectChange` call, byte-identical. `bootstrap/tenants.ts` already models flat
// as a fleet of one (`{ mode: "flat"; tenants: [DiscoveredTenant] }`); this module
// believes it: `supervise` is the one loop, generic in a child type `T` — it only
// ever touches `T.id` (the reconcile key), never `slug`/`dir`/`configPath`, so a
// flat deployment's single, constant tenant and a real fleet's N discovered
// tenants drive the exact same code.
//
// Two things a flat single-engine deployment needs that a fleet does not are
// injected, not branched on:
//   - `onChildGone` (required — a silently-defaulting policy is how #38
//     happened): when a child exits on its own, is it worth respawning, or
//     should its exit become the whole container's? Flat propagates unless the
//     crash-loop guard (crash-loop.ts) elects a retry; a real fleet always
//     respawns the one dead tenant with backoff and leaves its siblings alone.
//   - `onChildRun`/`onChildTick` (optional): the guard's bookkeeping — every
//     ended run, however it ended, and a heartbeat for a run still in progress.
//     Split from `onChildGone` so the bookkeeping and the decision can be wired
//     independently (a fleet-aggregated guard verdict is a follow-up, #47).
//
// Two axes are polled every `intervalMs`:
//   - the engine axis (shared): `launch()`'s own `sample()` reports whether the
//     mounted config or the tracked ref moved. A hit drains every current child
//     (the distinct `REF_CHANGE_DRAIN_SIGNAL` for a ref move, so a draining
//     child can report why — src/drain.ts) and re-launches once, so every child
//     runs a version-uniform engine. Flat's tenant fingerprint is constant
//     (null), so this is its *only* relaunch trigger — one config edit is one
//     relaunch, not two.
//   - the tenant axis (`children.discover`): which children should exist right
//     now, with a fingerprint each. A dir appearing/vanishing/changing spawns,
//     drains, or relaunches *only* that child, reusing the currently-launched
//     engine — flat's discover always yields its one tenant with a constant
//     fingerprint, so this axis is permanently inert for it.
//
// A child that dies on its own (crash/OOM, not a drain this loop requested) is
// per-child supervision: `onChildGone` decides, and a respawn re-launches (so a
// guarded flat deployment's crash-loop fallback can pin to a different commit)
// without touching any sibling's already-running child.
//
// Keep drain-then-launch: materializing a new engine before draining looks like
// a strict improvement (shorter outage), but `materializeGithubEngine` does
// `checkout --force --detach` in one shared clone dir per repo, so launching
// first would rewrite the working tree under still-running children. Every
// engine-axis relaunch here drains first and launches only once every current
// child has exited; the outage window on a failed relaunch is bounded by the
// poll interval, not by how long materializing takes.
//
// Everything impure — launching, spawning, discovering, the poll clock, the
// stop latch, the drain-escalation timer — is injected, so the whole loop is
// unit-tested without processes or real timers.

import { statSync } from "node:fs";
import { REF_CHANGE_DRAIN_SIGNAL } from "../src/drain.ts";
import type { ResolvedEngineSource } from "./engine-source.ts";

/** How often the loop samples the engine axis and re-polls the tenant axis. */
export const DEFAULT_INTERVAL_MS = 60_000;

/**
 * How long boot waits before respawning a child that exited on its own —
 * whether that is flat's one-and-only engine (a crash-loop retry) or one tenant
 * in a real fleet. Long enough that a commit dying instantly cannot spin the
 * loop, short enough that flat's crash-loop guard reaches its verdict in well
 * under a minute. Deliberately not the poll interval: a consumer who slows
 * their poll down to a quarter-hour should not thereby wait that long for a
 * respawn.
 */
export const CHILD_RESPAWN_BACKOFF_MS = 10_000;

/**
 * How long a drain (any reason — engine-axis relaunch, a tenant removed or
 * changed, or a container stop) gets before boot escalates to `SIGKILL` (#23,
 * #79). Generous by design: it exists only to bound a *wedged* drain (a stuck
 * git push, a hung process), not the normal "finish the unit" wait — that is
 * already bounded by the engine's own whole-unit run timeout (`runTimeoutMs`,
 * default 45 min, #72) plus its own SIGKILL escalation. This must stay
 * comfortably above that so a healthy, still-working unit is never cut off
 * mid-drain.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 3_600_000;

/** Which of the two watched inputs moved, and so why a child is relaunching. */
export type ReconcileReason = "config" | "ref";

/**
 * A single sample of the engine axis.
 * - `config`: the mounted config's stat fingerprint; null when it cannot be read.
 * - `remoteSha`: the tracked branch's current tip; null when there is nothing to
 *   watch — a local mount, a pinned SHA/tag, or a ref the remote does not have.
 */
export type WatchState = {
  config: string | null;
  remoteSha: string | null;
};

/** A materialized engine, and the world it was launched from. */
export type LaunchedEngine = {
  /** The engine CLI path that was spawned. */
  entry: string;
  /** Source provenance passed to the runtime status contract. */
  source?: ResolvedEngineSource;
  /** The commit it is running; null for a local mount (nothing to compare). */
  sha: string | null;
  /** The config fingerprint at launch. */
  config: string | null;
  /** Sample the engine axis now, bound to the source this engine came from. */
  sample: () => WatchState;
  /**
   * The crash-looping commit this launch is avoiding, when it is a crash-loop
   * fallback (bootstrap/crash-loop.ts) — the tracked branch still points there,
   * and the watch must not read that as a change to chase. Null normally.
   */
  quarantinedSha: string | null;
  /**
   * Whether the crash-loop guard covers this launch — true only for a github
   * source tracking a moving branch. The loop only carries it through to
   * `ChildRun`; the guard decides with it.
   */
  guarded: boolean;
  /**
   * Canonical resolved config handed to the child so it cannot re-read a
   * different authored state than the one that selected this engine source.
   */
  resolvedConfiguration?: string;
};

export type EngineExit = { code: number | null; signal: NodeJS.Signals | null };

/** A finished child run: what was running, how it ended, and how long it lived. */
export type EngineRun = {
  engine: LaunchedEngine;
  exit: EngineExit;
  elapsedMs: number;
  /**
   * Whether boot ended this run (a drain this loop requested) rather than the
   * child exiting of its own accord — the difference between evidence about the
   * engine commit and evidence about nothing.
   */
  requestedStop: boolean;
};

/** The supervised child: enough of a process to drain it and await it. */
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

// --- The generic supervise loop --------------------------------------------

/** A finished child run, generic in the child identity `T`. */
export type ChildRun<T> = EngineRun & { tenant: T };

/**
 * What to do about a child that exited on its own. `"respawn"` re-launches and
 * spawns it again after `CHILD_RESPAWN_BACKOFF_MS`; `{ propagate }` ends the
 * whole supervisor with that exit — flat's only way out, and the reason this is
 * a required dep (#38): a silently-absent policy must not default to either.
 */
export type ChildGoneAction = "respawn" | { propagate: EngineExit };

/** A child paired with its reconcile fingerprint at one discovery poll. */
export type ChildSample<T> = { tenant: T; fingerprint: string | null };

/**
 * One discovery poll's result. `hold` lists child ids still present with a
 * transiently unusable fingerprint, so the tenant axis holds a running child
 * rather than draining it (mirrors `tenants.ts`'s `FleetDiscoverResult`, #86).
 */
export type DiscoverResult<T> = { samples: ChildSample<T>[]; hold?: readonly string[] };

/** Discovery may be sync or async; samples alone, or samples + hold ids. */
export type DiscoverInput<T> =
  | ChildSample<T>[]
  | DiscoverResult<T>
  | Promise<ChildSample<T>[] | DiscoverResult<T>>;

/**
 * A cancelable one-shot timer backing the drain escalation. Injected — like the
 * poll clock — so the `SIGKILL` path is unit-tested without real timers.
 * `cancel` runs when the child exits within the grace, so a graceful drain
 * leaves no pending timer behind.
 */
export type DrainTimer = (ms: number) => { expired: Promise<void>; cancel: () => void };

const defaultDrainTimer: DrainTimer = (ms) => {
  let cancel = (): void => {};
  const expired = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    // The drain grace must never keep an otherwise-idle container alive.
    timer.unref?.();
    cancel = () => clearTimeout(timer);
  });
  return { expired, cancel };
};

export type SuperviseDeps<T extends { id: string }> = {
  /** Materialize the (shared) engine: re-read the config, resolve + materialize the source. */
  launch: () => Promise<LaunchedEngine> | LaunchedEngine;
  children: {
    /** The children that should be running now, with their fingerprints. */
    discover: () => DiscoverInput<T>;
    /** Spawn one engine child for a tenant, running the given engine's entry. */
    spawn: (tenant: T, engine: LaunchedEngine) => SupervisedChild;
  };
  /**
   * A child exited on its own (not a drain this loop requested). Required —
   * never optional-defaulting-to-respawn (#38). Called synchronously so the
   * decision cannot itself race a concurrent stop.
   */
  onChildGone: (run: ChildRun<T>) => ChildGoneAction;
  /**
   * Every finished run, however it ended — drained by this loop, or exited on
   * its own. The crash-loop guard's bookkeeping hook: this is where boot learns
   * a commit ran healthily, or died on startup.
   */
  onChildRun?: (run: ChildRun<T>) => void;
  /**
   * Each poll tick, once per still-running child, with how long it has been up.
   * The guard's other half: it banks a commit as proven while it is still
   * running, so an engine that has been up for weeks and is then killed
   * outright still leaves a fallback target behind.
   */
  onChildTick?: (tick: { tenant: T; engine: LaunchedEngine; elapsedMs: number }) => void;
  stop: StopLatch;
  intervalMs?: number;
  /** Reads the clock for run durations; injectable so the loop is tested without waiting. */
  now?: () => number;
  /** Grace after a drain signal before boot escalates to `SIGKILL`. Defaults to `DEFAULT_DRAIN_TIMEOUT_MS`. */
  drainTimeoutMs?: number;
  /** Cancelable timer backing the drain escalation; injected for tests. Defaults to a real `setTimeout`. */
  drainTimer?: DrainTimer;
  /** Backoff before respawning a child that exited on its own. Defaults to `CHILD_RESPAWN_BACKOFF_MS`. */
  childRespawnBackoffMs?: number;
  /** The engine axis changed — every current child is being drained and relaunched. */
  onEngineChange?: (reason: ReconcileReason) => void;
  /** The tenant axis moved: which child ids were added, removed, or relaunched. */
  onChildChange?: (change: { added: string[]; removed: string[]; changed: string[] }) => void;
  /** A (re)launch failed. Fatal only for the very first launch — see `supervise`'s own throw. */
  onLaunchError?: (error: unknown) => void;
  /** The engine axis's `sample()` threw — treated as "no change", not a crash. */
  onSampleError?: (error: unknown) => void;
  /** A tenant-discovery poll threw. The caller decides fatal-or-not: rethrow here to abort. */
  onDiscoverError?: (error: unknown) => void;
  /** An engine-axis drain exceeded its bound and boot escalated to `SIGKILL`. */
  onDrainTimeout?: (reason: ReconcileReason) => void;
  /** A drained (or crashed-and-reaped) child's slot was reclaimed; the broker owner id. */
  onReap?: (tenantId: string) => void;
  /**
   * Reduce everything just drained (or a self-exit reaped mid-stop) into the
   * container's own exit. Defaults to always `{ code: 0, signal: null }` — a
   * real fleet has no single "engine exit" to propagate. Flat overrides this
   * to return its one, constant child's own exit, since flat is always
   * exactly one child (#65) and the container's exit is meant to be the
   * engine's.
   */
  onStop?: (exits: readonly EngineExit[]) => EngineExit;
};

type ChildRecord<T> = {
  tenant: T;
  engine: LaunchedEngine;
  child: SupervisedChild;
  fingerprint: string | null;
  /** True once this loop asked the child to stop — its exit is expected. */
  draining: boolean;
  /** Set when the child's exit resolves. */
  exited: EngineExit | null;
  startedAt: number;
};

function normalizeDiscover<T>(raw: ChildSample<T>[] | DiscoverResult<T>): DiscoverResult<T> {
  if (Array.isArray(raw)) return { samples: raw };
  return raw;
}

type ChildDiff<T> = { added: T[]; removed: string[]; changed: T[] };

/**
 * The per-child reconcile decision: what changed between the last poll's
 * fingerprint map and the current discovered set. Generic twin of
 * `tenants.ts`'s `diffFleet` — same fold, kept separate because this loop must
 * only ever touch `T.id`, never a tenant's `slug`/`dir`/`configPath`.
 */
function diffChildren<T extends { id: string }>(
  previous: ReadonlyMap<string, string | null>,
  current: readonly ChildSample<T>[],
  hold: ReadonlySet<string>,
): ChildDiff<T> {
  const added: T[] = [];
  const changed: T[] = [];
  const seen = new Set<string>();

  for (const { tenant, fingerprint } of current) {
    seen.add(tenant.id);
    if (!previous.has(tenant.id)) {
      added.push(tenant);
      continue;
    }
    const before = previous.get(tenant.id) ?? null;
    if (before !== null && fingerprint !== null && before !== fingerprint) {
      changed.push(tenant);
    }
  }

  const removed = [...previous.keys()].filter((id) => !seen.has(id) && !hold.has(id));
  return { added, removed, changed };
}

/**
 * Supervise the engine(s) until the container stops, an engine/tenant axis
 * moves, or a child's own exit ends the run. See the module comment for the two
 * polled axes and the drain-then-launch ordering.
 */
export async function supervise<T extends { id: string }>(
  deps: SuperviseDeps<T>,
): Promise<EngineExit> {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const backoffMs = deps.childRespawnBackoffMs ?? CHILD_RESPAWN_BACKOFF_MS;
  const drainTimeoutMs = deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const drainTimer = deps.drainTimer ?? defaultDrainTimer;
  const now = deps.now ?? Date.now;
  const children = new Map<string, ChildRecord<T>>();

  // A re-armable wake signal so a child death breaks the poll wait immediately.
  let wake: () => void = () => {};
  const rearm = (): Promise<void> =>
    new Promise<void>((resolve) => {
      wake = resolve;
    });
  let waking = rearm();

  // The first launch is fatal on failure — it is the container's whole reason
  // to exist. Every later call goes through the same helper but logs and
  // retries instead (a relaunch's engine has already drained, so a transient
  // failure — a network blip mid-fetch, a ref deleted between poll and fetch —
  // must not take the container down with it).
  let everLaunched = false;
  const launch = async (): Promise<LaunchedEngine | null> => {
    try {
      const launched = await deps.launch();
      everLaunched = true;
      return launched;
    } catch (error) {
      if (!everLaunched) throw error;
      deps.onLaunchError?.(error);
      return null;
    }
  };

  let engine = (await launch()) as LaunchedEngine;

  const spawnFor = (tenant: T, fingerprint: string | null, forEngine: LaunchedEngine): void => {
    const child = deps.children.spawn(tenant, forEngine);
    const record: ChildRecord<T> = {
      tenant,
      engine: forEngine,
      child,
      fingerprint,
      draining: false,
      exited: null,
      startedAt: now(),
    };
    children.set(tenant.id, record);
    void child.exited.then((exit) => {
      record.exited = exit;
      wake();
    });
  };

  /** Drain one child, bounded, reporting its run; returns what it exited as. */
  const drain = async (
    record: ChildRecord<T>,
    signal: NodeJS.Signals,
    timeoutReason: ReconcileReason | null,
  ): Promise<EngineExit> => {
    record.draining = true;
    record.child.kill(signal);
    const timer = drainTimer(drainTimeoutMs);
    const raced = await Promise.race([
      record.child.exited.then((exit) => ({ kind: "exited" as const, exit })),
      timer.expired.then(() => ({ kind: "timeout" as const })),
    ]);
    let exit: EngineExit;
    if (raced.kind === "timeout") {
      if (timeoutReason !== null) deps.onDrainTimeout?.(timeoutReason);
      record.child.kill("SIGKILL");
      exit = await record.child.exited;
    } else {
      timer.cancel();
      exit = raced.exit;
    }
    deps.onChildRun?.({
      tenant: record.tenant,
      engine: record.engine,
      exit,
      elapsedMs: now() - record.startedAt,
      requestedStop: true,
    });
    deps.onReap?.(record.tenant.id);
    return exit;
  };

  const drainAll = async (
    signal: NodeJS.Signals,
    timeoutReason: ReconcileReason | null = null,
  ): Promise<EngineExit[]> => {
    const exits = await Promise.all(
      [...children.values()].map((record) => drain(record, signal, timeoutReason)),
    );
    children.clear();
    return exits;
  };

  const finishStop = (exits: readonly EngineExit[]): EngineExit =>
    deps.onStop?.(exits) ?? { code: 0, signal: null };

  const stopExit = async (): Promise<EngineExit> => finishStop(await drainAll("SIGTERM"));

  // Initial fleet: one child per discovered tenant. Flat's discover always
  // yields exactly its one, constant tenant — a fleet of one.
  for (const { tenant, fingerprint } of normalizeDiscover(await deps.children.discover()).samples) {
    spawnFor(tenant, fingerprint, engine);
  }

  while (true) {
    if (deps.stop.requested) return await stopExit();

    await Promise.race([deps.stop.wait(intervalMs), waking]);
    waking = rearm();

    if (deps.stop.requested) return await stopExit();

    // Every still-running child gets a tick — the crash-loop guard's other
    // bookkeeping half (bootstrap/crash-loop.ts): a commit is banked as proven
    // while it runs, not only once its run ends.
    for (const record of children.values()) {
      if (record.draining || record.exited !== null) continue;
      deps.onChildTick?.({
        tenant: record.tenant,
        engine: record.engine,
        elapsedMs: now() - record.startedAt,
      });
    }

    // 1. Reap children that exited on their own — per-child supervision. Each
    // gets a policy decision (`onChildGone`): respawn it, or let its exit
    // become the whole supervisor's (flat's only way out, #38).
    const records = [...children.values()];
    for (const record of records) {
      if (record.exited === null || record.draining) continue;
      children.delete(record.tenant.id);
      const run: ChildRun<T> = {
        tenant: record.tenant,
        engine: record.engine,
        exit: record.exited,
        elapsedMs: now() - record.startedAt,
        requestedStop: false,
      };
      deps.onChildRun?.(run);
      const action = deps.onChildGone(run);
      if (action !== "respawn") {
        await drainAll("SIGTERM");
        return action.propagate;
      }
      // Back off, then re-launch from the top — where a guarded deployment's
      // crash-loop fallback actually takes effect — and re-check the stop
      // latch the wait may have woken on.
      await deps.stop.wait(backoffMs);
      if (deps.stop.requested) return finishStop([run.exit, ...(await drainAll("SIGTERM"))]);
      if (children.has(record.tenant.id)) continue;
      const fresh = await launch();
      if (fresh === null) continue;
      engine = fresh;
      spawnFor(record.tenant, record.fingerprint, engine);
    }
    if (deps.stop.requested) return await stopExit();

    // 2. Engine axis: a shared-engine change drains + respawns every child.
    let current: WatchState | null;
    try {
      current = engine.sample();
    } catch (error) {
      // A failed poll (network blip on `ls-remote`, unreadable mount) is not a
      // change — leave every child alone and look again next tick.
      deps.onSampleError?.(error);
      current = null;
    }
    if (current) {
      const reason = detectChange({
        launched: { config: engine.config, sha: engine.sha, quarantinedSha: engine.quarantinedSha },
        current,
      });
      if (reason) {
        deps.onEngineChange?.(reason);
        const survivors = [...children.values()].map((record) => ({
          tenant: record.tenant,
          fingerprint: record.fingerprint,
        }));
        // A ref change gets a distinct signal from a plain config change or
        // container stop, so a draining child can report why (#23, src/drain.ts).
        const signal = reason === "ref" ? REF_CHANGE_DRAIN_SIGNAL : "SIGTERM";
        const exits = await drainAll(signal, reason);
        if (deps.stop.requested) return finishStop(exits);
        const fresh = await launch();
        if (fresh !== null) {
          engine = fresh;
          for (const { tenant, fingerprint } of survivors) spawnFor(tenant, fingerprint, engine);
        }
        continue;
      }
    }
    if (deps.stop.requested) return await stopExit();

    // 3. Tenant axis: add / remove / relaunch individual children. A discovery
    // that throws is *unknown* state, not "every tenant removed" — skip this
    // axis this poll. Whether that unknown state is fatal is the caller's call:
    // `onDiscoverError` may itself throw to abort the supervisor.
    const previous = new Map<string, string | null>(
      [...children.values()].map((record) => [record.tenant.id, record.fingerprint] as const),
    );
    let samples: ChildSample<T>[];
    let hold = new Set<string>();
    try {
      const discovered = normalizeDiscover(await deps.children.discover());
      samples = discovered.samples;
      hold = new Set(discovered.hold ?? []);
    } catch (error) {
      deps.onDiscoverError?.(error);
      continue;
    }
    const diff = diffChildren(previous, samples, hold);
    if (diff.added.length || diff.removed.length || diff.changed.length) {
      deps.onChildChange?.({
        added: diff.added.map((tenant) => tenant.id),
        removed: diff.removed,
        changed: diff.changed.map((tenant) => tenant.id),
      });
    }
    const sampleById = new Map(samples.map((sample) => [sample.tenant.id, sample] as const));
    for (const id of diff.removed) {
      const record = children.get(id);
      if (record) {
        await drain(record, "SIGTERM", null);
        children.delete(id);
      }
    }
    for (const tenant of diff.changed) {
      const record = children.get(tenant.id);
      if (record) {
        await drain(record, "SIGTERM", null);
        children.delete(tenant.id);
      }
      spawnFor(tenant, sampleById.get(tenant.id)?.fingerprint ?? null, engine);
    }
    for (const tenant of diff.added) {
      spawnFor(tenant, sampleById.get(tenant.id)?.fingerprint ?? null, engine);
    }
  }
}
