// The supervisor's global concurrency broker — scheduling across N repos (#59).
//
// One engine child per tenant, but one machine: left ungated, N children could
// run N heavy work units (worktree + install + agent + test + push) at once and
// thrash the host. The supervisor holds a single in-memory counting semaphore
// and hands out a bounded number of *slots*; each engine child requests one
// before executing a unit and releases it when the unit finishes. The cheap
// poll → fetch → select phase stays ungated and parallel across children.
//
// Fairness is FIFO round-robin over children-that-have-work: a child only
// requests once it has a workable unit, and one that releases and immediately
// re-requests goes to the back of the queue, so no repo can hog the host
// (starvation-free, zero config). A child that finds work while the cap is full
// blocks in the queue rather than sleep-retrying, preserving strict FIFO.
//
// The broker is the only entity that sees all repos — the natural fairness
// authority — and crash-reclaim is clean: when a child dies (crash / OOM /
// reconcile-SIGTERM) the supervisor reclaims every slot it held, so no failure
// mode can permanently shrink the cap (#59/#72 carry-forward). This module is
// the pure semaphore + owner bookkeeping; the IPC adapter that maps child
// messages onto it lives in the supervisor (bootstrap/supervise.ts).

/** Default concurrency cap: today's proven single-repo host load (#59). */
export const DEFAULT_MAX_CONCURRENT = 1;

/**
 * Read the configured cap from `PHOEBE_MAX_CONCURRENT_AGENTS`. A missing,
 * non-numeric, or < 1 value falls back to the default 1 — raising the cap is a
 * deliberate operator act.
 */
export function resolveMaxConcurrent(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env["PHOEBE_MAX_CONCURRENT_AGENTS"]);
  return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_MAX_CONCURRENT;
}

type Waiter = { owner: string; grant: () => void };

export type SlotBroker = {
  /** Request a slot for `owner`. Resolves immediately if one is free, else FIFO. */
  acquire(owner: string): Promise<void>;
  /** Release one slot held by `owner`, handing it to the next waiter if any. */
  release(owner: string): void;
  /** A child died: drop its queued requests and release every slot it held. */
  reclaim(owner: string): void;
  /** Slots currently held across all owners. */
  readonly inUse: number;
  /** How many owners are blocked waiting. */
  readonly waiting: number;
  readonly capacity: number;
};

/**
 * Create a counting semaphore with the given capacity (clamped to ≥ 1). Tracks
 * how many slots each owner holds so a dead owner's slots can be reclaimed
 * exactly, without double-counting or leaking.
 */
export function createSlotBroker(capacity: number): SlotBroker {
  const cap = Math.max(1, Math.floor(capacity));
  const held = new Map<string, number>();
  const queue: Waiter[] = [];

  const inUse = (): number => {
    let total = 0;
    for (const n of held.values()) total += n;
    return total;
  };

  const take = (owner: string): void => {
    held.set(owner, (held.get(owner) ?? 0) + 1);
  };

  const drop = (owner: string): void => {
    const current = held.get(owner) ?? 0;
    if (current <= 1) held.delete(owner);
    else held.set(owner, current - 1);
  };

  /** Give a freed slot to the front of the queue, or let `inUse` fall. */
  const handOff = (): void => {
    const next = queue.shift();
    if (next) {
      take(next.owner);
      next.grant();
    }
  };

  return {
    acquire(owner: string): Promise<void> {
      if (inUse() < cap) {
        take(owner);
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        queue.push({ owner, grant: resolve });
      });
    },
    release(owner: string): void {
      // A release only frees a slot the owner actually holds; ignore a spurious
      // release (double-release, release-without-acquire) rather than over-grant.
      if ((held.get(owner) ?? 0) === 0) return;
      drop(owner);
      handOff();
    },
    reclaim(owner: string): void {
      // Drop the dead owner's queued requests first (their promises never
      // resolve — the child is gone), then release each slot it held so those
      // capacity units go to live waiters.
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (queue[i]?.owner === owner) queue.splice(i, 1);
      }
      const count = held.get(owner) ?? 0;
      held.delete(owner);
      for (let i = 0; i < count; i += 1) handOff();
    },
    get inUse() {
      return inUse();
    },
    get waiting() {
      return queue.length;
    },
    get capacity() {
      return cap;
    },
  };
}
