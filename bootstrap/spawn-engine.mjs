// The one home for the bootstrapper's child-process signal plumbing.
//
// Both the published bin launcher (bin.mjs) and `phoebe boot` (boot.ts) exec a
// `node <entry>` child with inherited stdio and need the same behaviour: forward
// the stop signals so a container SIGTERM reaches the real process (the engine's
// graceful drain), then die however the child died. Keeping it in one module
// stops the two callers from drifting on the fiddly exit/re-raise handling.
//
// Plain JS, not TypeScript: bin.mjs runs first, still inside node_modules, where
// Node 24 refuses to type-strip `.ts`. boot.ts imports it untyped (same as
// materialize.mjs) from the materialized copy outside node_modules.

import { spawn } from "node:child_process";

/**
 * Die however a child process died: re-raise a killing signal so this process
 * exits the same way, or exit with the child's code.
 *
 * The caller must have removed its own listeners for that signal first —
 * otherwise re-raising just re-runs them and this process falls through and
 * exits 0, hiding the child's signal death from its parent.
 */
export function propagateExit(code, signal) {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
}

/**
 * Spawn `node <entry> <args...>` with inherited stdio, forwarding SIGINT/SIGTERM
 * to it, and propagate its exit (see propagateExit). Returns the child handle.
 *
 * `onSpawnError` overrides the default handling of a spawn failure (print
 * `[phoebe] <message>` and exit 1); callers that want to surface it differently
 * pass their own.
 *
 * `onExit` overrides dying with the child. `phoebe boot` passes one because it
 * *supervises* the engine: a child that exited because boot drained it for a
 * relaunch must not take the container with it (bootstrap/reconcile.ts). Callers
 * that pass `onExit` own the propagation — propagateExit is exported for them.
 */
export function spawnEngine(entry, args, { env, onSpawnError, onExit } = {}) {
  const child = spawn(process.execPath, [entry, ...args], {
    stdio: "inherit",
    ...(env ? { env } : {}),
  });

  const forwarders = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const forward = () => child.kill(signal);
    forwarders.set(signal, forward);
    process.on(signal, forward);
  }
  const clearForwarders = () => {
    for (const [signal, forward] of forwarders) process.off(signal, forward);
  };

  child.on("error", (error) => {
    clearForwarders();
    if (onSpawnError) {
      onSpawnError(error);
      return;
    }
    console.error(`[phoebe] ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    // Removed before propagating: a re-raised signal must not just re-run the
    // forwarder (a no-op kill on the dead child) and leave this process alive.
    clearForwarders();
    if (onExit) {
      onExit(code, signal);
      return;
    }
    propagateExit(code, signal);
  });

  return child;
}
