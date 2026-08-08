// Runtime handle to the resolved, defaults-filled config the engine reads.
//
// The engine (everything else under src/) imports `config` from here and stays
// repo-agnostic; the CLI (src/cli.ts) resolves built-ins, the optional generated
// base, the consumer's `phoebe.config.ts`, and the `PHOEBE_*` env overlay, then
// installs the result via `setResolvedConfig` before importing the engine entry.
// Tests install a sample config via the setup file wired in `vite.config.ts`.
//
// A `Proxy` gates every field read: reading before install throws with a
// pointer at the CLI/setup path, so an accidentally repo-coupled engine import
// fails loudly at the callsite instead of silently reading `undefined`.

import type { PhoebeConfig } from "./config/index.ts";

let resolved: PhoebeConfig | null = null;

/** Install the resolved config. Idempotent — later calls replace the prior value. */
export function setResolvedConfig(next: PhoebeConfig): void {
  resolved = next;
}

/** For test isolation: clear the installed config back to the "not installed" state. */
export function clearResolvedConfig(): void {
  resolved = null;
}

/** Whether a resolved config has been installed. */
export function hasResolvedConfig(): boolean {
  return resolved !== null;
}

export const config: PhoebeConfig = new Proxy({} as PhoebeConfig, {
  get(_target, prop) {
    if (resolved === null) {
      throw new Error(
        `Attempted to read config.${String(prop)} before the resolved config was installed. ` +
          `The Phoebe CLI (src/cli.ts) installs it after loading phoebe.config.ts; ` +
          `tests install a sample via src/test-setup.ts (wired from vite.config.ts).`,
      );
    }
    return resolved[prop as keyof PhoebeConfig];
  },
  ownKeys() {
    if (resolved === null) return [];
    return Reflect.ownKeys(resolved);
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (resolved === null) return undefined;
    return Reflect.getOwnPropertyDescriptor(resolved, prop);
  },
  has(_target, prop) {
    if (resolved === null) return false;
    return prop in resolved;
  },
});
