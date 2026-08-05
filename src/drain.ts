// Graceful-drain coordination for the persistent engine loop.
//
// `phoebe boot` (the bootstrapper) runs the engine as a long-lived child and
// stops it with SIGTERM — on container shutdown, and on a config/ref change the
// reconcile watch relaunches for (bootstrap/reconcile.ts). A hard SIGTERM would
// kill the engine mid-work-unit, abandoning a half-finished agent run (a dirty
// worktree, maybe a partially pushed branch). Instead the engine treats SIGTERM
// as a *drain* request: finish the unit in flight, start no new one, exit 0.
//
// This module is that one-way latch — a boolean that flips on the first signal,
// plus an interruptible wait so an idle poll-sleep wakes immediately instead of
// stalling shutdown for a whole poll interval. It takes the emitter and signal
// names as arguments (defaulting to `process` / `SIGTERM`) so the latch logic is
// unit-tested without sending real process signals.
//
// Both poll loops use it, for the same reason: the engine's work loop drains on
// it (src/main.ts), and the bootstrapper's reconcile watch takes it as the
// container's stop request (bootstrap/reconcile.ts) so a shutdown wakes the
// watch instead of waiting out a poll interval — and so boot survives the moment
// between draining one engine and spawning its replacement.

/**
 * The signal `phoebe boot`'s reconcile watch sends when the *tracked engine
 * ref* moved (bootstrap/reconcile.ts), as opposed to a plain container
 * SIGTERM/SIGINT. Distinct so the drained engine can tell the two apart and
 * report *why* it is draining on its status snapshot (`lifecycle.reason`,
 * #23) — "the ref moved, reload onto it" reads very differently to an
 * operator than "the container is stopping".
 */
export const REF_CHANGE_DRAIN_SIGNAL: NodeJS.Signals = "SIGUSR2";

export interface DrainSignal {
  /** True once a drain has been requested; never flips back. */
  readonly requested: boolean;
  /**
   * The signal that triggered the drain, or null before one arrives. Latched
   * to the *first* signal received, same as `requested` — a drain reason
   * does not change once set.
   */
  readonly signal: NodeJS.Signals | null;
  /**
   * Resolve after `ms`, or immediately once a drain is requested — whichever
   * comes first. A drain arriving mid-wait wakes it so the loop stops promptly
   * rather than sleeping out the full poll interval. Single-waiter: the loop
   * awaits one wait() at a time.
   */
  wait(ms: number): Promise<void>;
  /** Remove the signal listeners and cancel any pending wait. Idempotent. */
  dispose(): void;
}

export function installDrainSignal(
  emitter: NodeJS.EventEmitter = process,
  signals: readonly NodeJS.Signals[] = ["SIGTERM"],
): DrainSignal {
  let requested = false;
  let signal: NodeJS.Signals | null = null;
  // Resolver for an in-flight wait(), so a drain can wake it early. Cleared once
  // it fires (or the wait times out) so we never resolve a stale promise.
  let wake: (() => void) | undefined;

  const onSignal = (received: NodeJS.Signals) => {
    if (!requested) signal = received;
    requested = true;
    wake?.();
  };
  // One bound handler per signal (captured in the closure) so `dispose` can
  // `off` the exact function it `on`'d — an anonymous handler per signal
  // cannot be removed later.
  const handlers = new Map(signals.map((configured) => [configured, () => onSignal(configured)]));
  for (const [configured, handler] of handlers) emitter.on(configured, handler);

  return {
    get requested() {
      return requested;
    },
    get signal() {
      return signal;
    },
    wait(ms: number): Promise<void> {
      if (requested) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          wake = undefined;
          resolve();
        }, ms);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
      });
    },
    dispose() {
      for (const [configured, handler] of handlers) emitter.off(configured, handler);
      wake?.();
    },
  };
}
