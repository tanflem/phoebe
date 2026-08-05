// The nested/multi-tenant supervision loop — `phoebe boot`'s fleet manager (#58/#59).
//
// Flat single-tenant deployments keep the original single-child `superviseEngine`
// (reconcile.ts), untouched. This is the *nested* path: a shared engine (#60)
// with one child per discovered tenant (#58), a global concurrency broker across
// them (#59), and hot add/remove/change of tenants without a container restart.
//
// Two orthogonal axes are polled:
//   - Engine axis (shared, #60): the top config's `engine` field or the tracked
//     ref moves → re-materialize once and drain+respawn the *whole* fleet, so
//     every tenant runs a version-uniform engine.
//   - Tenant axis (#58): a tenant dir appears / vanishes / its config changes →
//     spawn / drain+reap / relaunch *only* that child.
// A child that dies on its own (crash / OOM) is per-tenant supervision (#60 §6):
// its slot is reclaimed and it is respawned with backoff, leaving the shared
// engine and every sibling untouched.
//
// Everything impure — materializing, spawning, the poll clock, the stop latch,
// the broker — is injected, so the ordering is unit-tested without processes or
// real timers (mirroring reconcile.ts's superviseEngine harness).

import { detectChange, type EngineExit, type LaunchedEngine, type StopLatch } from "./reconcile.ts";
import {
  diffFleet,
  DuplicateTenantSlugError,
  type DiscoveredTenant,
  type FleetDiscoverResult,
  type TenantSample,
} from "./tenants.ts";

/** How long to wait before respawning a tenant child that died on its own. */
export const CHILD_RESPAWN_BACKOFF_MS = 10_000;
/** Default fleet poll cadence (shared with the single-engine watch). */
export const DEFAULT_FLEET_INTERVAL_MS = 60_000;

/**
 * How long a drain waits for a child to exit after `SIGTERM` before escalating
 * to `SIGKILL` (#79). The engine treats `SIGTERM` as a graceful drain — finish
 * the work unit in flight, start no new one, exit (src/drain.ts) — and that unit
 * is itself bounded by the engine's per-unit run timeout (#72, default 45 min).
 * This grace sits comfortably above that so a legitimately draining unit is never
 * force-killed; it exists only for a child that ignores `SIGTERM` (or whose unit
 * timeout also fails), guaranteeing `drain` — and therefore `drainAll`, which
 * gates both the container-stop path and the in-process engine-relaunch path —
 * always completes rather than hanging on the container's stop grace alone.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 3_600_000;

/** A supervised tenant child — enough to drain it and await its exit. */
export type FleetChild = {
  kill: (signal: NodeJS.Signals) => void;
  exited: Promise<EngineExit>;
};

/**
 * A cancelable one-shot timer backing the drain escalation. Injected — like the
 * poll clock — so the `SIGKILL` path is unit-tested without real timers. `cancel`
 * runs when the child exits within the grace, so a graceful drain leaves no
 * pending timer behind.
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

/** Discover may be sync or async; samples alone, or samples + hold ids (#86/#91). */
export type FleetDiscoverInput =
  | TenantSample[]
  | FleetDiscoverResult
  | Promise<TenantSample[] | FleetDiscoverResult>;

function normalizeDiscover(raw: TenantSample[] | FleetDiscoverResult): FleetDiscoverResult {
  if (Array.isArray(raw)) return { samples: raw };
  return raw;
}

export type SuperviseFleetDeps = {
  /** Materialize the shared engine (entry + sha + engine-axis `sample`). */
  launch: () => Promise<LaunchedEngine> | LaunchedEngine;
  /**
   * The tenants that should be running now, with their config fingerprints.
   * May include `hold` ids for still-present dirs with a transiently unusable
   * config so those children are not drained (#86).
   */
  discover: () => FleetDiscoverInput;
  /** Spawn one engine child for a tenant, running the shared engine's entry. */
  spawn: (tenant: DiscoveredTenant, engine: LaunchedEngine) => FleetChild;
  stop: StopLatch;
  intervalMs?: number;
  now?: () => number;
  onEngineChange?: (reason: "config" | "ref") => void;
  onTenantChange?: (change: { added: string[]; removed: string[]; changed: string[] }) => void;
  onChildExit?: (info: { tenantId: string; exit: EngineExit; expected: boolean }) => void;
  onLaunchError?: (error: unknown) => void;
  /** A tenant-discovery poll threw (unknown state) — the axis was skipped, not drained. */
  onDiscoverError?: (error: unknown) => void;
  /** Reap a child we intentionally drained (relaunch/remove); the broker owner id. */
  onReap?: (tenantId: string) => void;
  crashBackoffMs?: number;
  /** Grace after `SIGTERM` before a drain escalates to `SIGKILL` (#79). */
  drainTimeoutMs?: number;
  /** Cancelable timer backing the drain escalation; injected for tests (#79). */
  drainTimer?: DrainTimer;
};

type ChildRecord = {
  tenant: DiscoveredTenant;
  child: FleetChild;
  fingerprint: string | null;
  /** True once we asked this child to stop (relaunch/remove) — its exit is expected. */
  draining: boolean;
  /** Set when the child's exit resolves. */
  exited: EngineExit | null;
};

/**
 * Supervise a fleet of tenant children until the container stops. Resolves 0
 * when drained by a container stop (nested boot has no single "engine exit" to
 * propagate — a lone child's death is handled in-loop, not by exiting).
 */
export async function superviseFleet(deps: SuperviseFleetDeps): Promise<EngineExit> {
  const intervalMs = deps.intervalMs ?? DEFAULT_FLEET_INTERVAL_MS;
  const backoffMs = deps.crashBackoffMs ?? CHILD_RESPAWN_BACKOFF_MS;
  const drainTimeoutMs = deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const drainTimer = deps.drainTimer ?? defaultDrainTimer;
  const children = new Map<string, ChildRecord>();

  // A re-armable wake signal so a child death breaks the poll wait immediately.
  let wake: () => void = () => {};
  const rearm = (): Promise<void> =>
    new Promise<void>((resolve) => {
      wake = resolve;
    });
  let waking = rearm();

  let engine = await deps.launch();

  const spawnFor = (tenant: DiscoveredTenant, fingerprint: string | null): void => {
    const child = deps.spawn(tenant, engine);
    const record: ChildRecord = { tenant, child, fingerprint, draining: false, exited: null };
    children.set(tenant.id, record);
    void child.exited.then((exit) => {
      record.exited = exit;
      wake();
    });
  };

  const drain = async (record: ChildRecord): Promise<void> => {
    record.draining = true;
    record.child.kill("SIGTERM");
    // Bound the graceful drain: a child that ignores `SIGTERM`, or whose work
    // unit never finishes, must not block `drain` — and so `drainAll`, which
    // gates the container-stop and in-process engine-relaunch paths — forever.
    const timer = drainTimer(drainTimeoutMs);
    const outcome = await Promise.race([
      record.child.exited.then(() => "exited" as const),
      timer.expired.then(() => "timeout" as const),
    ]);
    if (outcome === "timeout") {
      record.child.kill("SIGKILL");
      await record.child.exited;
    } else {
      timer.cancel();
    }
    deps.onReap?.(record.tenant.id);
  };

  const drainAll = async (): Promise<void> => {
    await Promise.all([...children.values()].map((record) => drain(record)));
    children.clear();
  };

  // Initial fleet: one child per discovered tenant.
  for (const { tenant, fingerprint } of normalizeDiscover(await deps.discover()).samples) {
    spawnFor(tenant, fingerprint);
  }

  while (true) {
    if (deps.stop.requested) {
      await drainAll();
      return { code: 0, signal: null };
    }

    await Promise.race([deps.stop.wait(intervalMs), waking]);
    waking = rearm();

    if (deps.stop.requested) {
      await drainAll();
      return { code: 0, signal: null };
    }

    // 1. Reap / respawn children that died on their own (per-tenant supervision).
    // Snapshot first — the body deletes from and adds to `children`.
    const records = Array.from(children.values());
    for (const record of records) {
      if (record.exited === null || record.draining) continue;
      const exit = record.exited;
      deps.onChildExit?.({ tenantId: record.tenant.id, exit, expected: false });
      children.delete(record.tenant.id);
      // Back off, then respawn the same tenant onto the (unchanged) shared engine.
      await deps.stop.wait(backoffMs);
      if (deps.stop.requested) break;
      if (!children.has(record.tenant.id)) spawnFor(record.tenant, record.fingerprint);
    }
    if (deps.stop.requested) {
      await drainAll();
      return { code: 0, signal: null };
    }

    // 2. Engine axis: a shared-engine change drains + respawns the whole fleet.
    let current;
    try {
      current = engine.sample();
    } catch (error) {
      deps.onLaunchError?.(error);
      current = null;
    }
    if (current) {
      const reason = detectChange({
        launched: { config: engine.config, sha: engine.sha, quarantinedSha: engine.quarantinedSha },
        current,
      });
      if (reason) {
        deps.onEngineChange?.(reason);
        const survivors = [...children.values()].map((r) => ({
          tenant: r.tenant,
          fingerprint: r.fingerprint,
        }));
        await drainAll();
        try {
          engine = await deps.launch();
          for (const { tenant, fingerprint } of survivors) spawnFor(tenant, fingerprint);
        } catch (error) {
          deps.onLaunchError?.(error);
        }
        continue;
      }
    }

    // 3. Tenant axis: add / remove / relaunch individual children.
    // A discovery that throws is *unknown* state, not "every tenant removed":
    // skip the tenant axis this poll rather than draining the whole fleet on a
    // transient `repos/` read error (tenants.ts already re-throws non-ENOENT).
    // A fatal discovery error (duplicate workspace slug) aborts the supervisor.
    const previous = new Map<string, string | null>(
      [...children.values()].map((r) => [r.tenant.id, r.fingerprint] as const),
    );
    let samples: TenantSample[];
    let hold = new Set<string>();
    try {
      const discovered = normalizeDiscover(await deps.discover());
      samples = discovered.samples;
      hold = new Set(discovered.hold ?? []);
    } catch (error) {
      if (error instanceof DuplicateTenantSlugError) throw error;
      deps.onDiscoverError?.(error);
      continue;
    }
    const diff = diffFleet(previous, samples, hold);
    if (diff.added.length || diff.removed.length || diff.changed.length) {
      deps.onTenantChange?.({
        added: diff.added.map((t) => t.id),
        removed: diff.removed,
        changed: diff.changed.map((t) => t.id),
      });
    }
    const sampleById = new Map(samples.map((s) => [s.tenant.id, s] as const));
    for (const id of diff.removed) {
      const record = children.get(id);
      if (record) {
        await drain(record);
        children.delete(id);
      }
    }
    for (const tenant of diff.changed) {
      const record = children.get(tenant.id);
      if (record) {
        await drain(record);
        children.delete(tenant.id);
      }
      spawnFor(tenant, sampleById.get(tenant.id)?.fingerprint ?? null);
    }
    for (const tenant of diff.added) {
      spawnFor(tenant, sampleById.get(tenant.id)?.fingerprint ?? null);
    }
  }
}
