// Bound stdout/stderr logging for one tenant (#62). The engine's main run
// loop is one process per repo slug, so every line it prints can and must
// carry that slug — never the bare, un-attributable `[phoebe]` prefix.
// `phoebeLog`/`phoebeError` bind the tag once at boot so every later call
// site reads it through this helper instead of re-typing a literal
// `[phoebe]` that a future edit could leave bare.

export type PhoebeLogFn = (message: string) => void;

/** The per-tenant stdout/stderr tag. Flat mode uses its config's `repoSlug`, never bare. */
export function unitTag(tenant: string): string {
  return `[phoebe:${tenant}]`;
}

export function createPhoebeLog(
  tenant: string,
  deps: { log?: (line: string) => void; error?: (line: string) => void } = {},
): { tag: string; phoebeLog: PhoebeLogFn; phoebeError: PhoebeLogFn } {
  const tag = unitTag(tenant);
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  return {
    tag,
    phoebeLog: (message) => log(`${tag} ${message}`),
    phoebeError: (message) => error(`${tag} ${message}`),
  };
}
