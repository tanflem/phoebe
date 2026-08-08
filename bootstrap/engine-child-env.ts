// The supervisor's per-tenant env scrub — isolation model A, §1 (#61).
//
// In a nested/multi-tenant deployment the supervisor (boot.ts) spawns one engine
// child per tenant. Left as today's `stdio: "inherit"` with no `env`, every
// child would inherit the supervisor's full `process.env` — which holds the
// deployment engine-clone credential (#60) and, once several tenants' `.env`
// files are loaded, every tenant's secrets. That is exactly the cross-tenant
// exposure model A must prevent.
//
// So the supervisor builds each child's env here, **deny-by-default from an
// explicit allowlist**: a hardcoded base (PATH/HOME/git identity), the
// deployment-global `PHOEBE_*` knobs the engine reads, plus *only* tenant T's
// freshly-parsed `.env`. The supervisor's own `process.env` is never spread in,
// so the #60 clone credential — and any future secret dropped there — is
// fail-closed invisible to children (simply never on the list). Isolation is
// structural, not disciplinary: a child can only ever hold its own tenant's
// secrets. `buildAgentEnv` (src/agent-env.ts) then narrows correctly at the
// agent hop, unchanged, because the child's env already holds only tenant T's.
//
// Flat single-tenant mode does NOT use this: one tenant is one trust domain
// (the whole container), Docker injects exactly that tenant's secrets, and the
// child inherits the supervisor env as it does today.

/**
 * Hardcoded base allowlist: process essentials plus the deployment-global git
 * identity every tenant shares. Not secrets, and not per-tenant.
 */
export const ENGINE_CHILD_BASE_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

/**
 * Deployment-global `PHOEBE_*` knobs the engine reads that are safe to share
 * across every tenant. Deliberately excludes the per-tenant config-overlay keys
 * (`PHOEBE_REPO_SLUG`, `PHOEBE_INSTALL_COMMAND`, …): each tenant loads its own
 * `phoebe.config.ts`, so a global overlay would corrupt every tenant identically.
 */
export const ENGINE_CHILD_DEPLOYMENT_KNOBS = [
  "PHOEBE_POLL_INTERVAL_MS",
  "PHOEBE_RUN_TIMEOUT_MS",
  "PHOEBE_MAX_UNIT_TIMEOUTS",
  "PHOEBE_DATA_DIR",
  "PHOEBE_BASE",
  "PHOEBE_AGENT",
  "PHOEBE_MODEL",
  "PHOEBE_BASE_CONFIG",
] as const;

/**
 * Build a scrubbed, tenant-only env for one engine child. Deny-by-default: start
 * empty, copy the allowlisted base + deployment knobs from `base` (the
 * supervisor's `process.env`), overlay `extraEnv` — this launch's engine
 * provenance and resolved-config snapshot (boot.ts's `engineProvenanceEnv`),
 * the same per-launch values the flat spawn path passes — then overlay tenant
 * T's parsed `.env` last. Because `base`'s `GH_TOKEN` is not on either
 * allowlist, the only `GH_TOKEN` a child can hold is its own tenant's — the
 * deployment clone credential never leaks.
 */
export function buildEngineChildEnv(opts: {
  base: Record<string, string | undefined>;
  tenantEnv: Record<string, string>;
  extraEnv?: Record<string, string>;
}): Record<string, string> {
  const { base, tenantEnv, extraEnv } = opts;
  const env: Record<string, string> = {};
  for (const key of [...ENGINE_CHILD_BASE_KEYS, ...ENGINE_CHILD_DEPLOYMENT_KNOBS]) {
    const value = base[key];
    if (value !== undefined && value !== "") {
      env[key] = value;
    }
  }
  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value !== "") env[key] = value;
    }
  }
  // Tenant secrets last: they are the tenant's own, and win over any collision.
  for (const [key, value] of Object.entries(tenantEnv)) {
    if (value !== "") env[key] = value;
  }
  return env;
}
