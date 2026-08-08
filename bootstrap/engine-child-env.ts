// The one child-env builder every engine spawn path routes through (#64).
//
// `phoebe boot` spawns an engine child two ways: flat (one child, the
// supervisor's own process) and nested/workspace (one child per tenant, from
// `superviseFleet`). Both need the same deployment-critical vars — the base
// allowlist, the atomic launch snapshot, and engine provenance — and only ever
// differ in *where the secrets come from*. Splitting the two spawn paths into
// separate env-construction code is exactly how #38 happened: nested silently
// lost the snapshot, provenance, and `PHOEBE_BASE_CONFIG` because nothing
// forced the two builders to stay in sync. `childEnv` is the one function both
// paths call so that cannot happen again.
//
// Isolation is still structural, not disciplinary: a child can only ever hold
// what its own `secrets` source handed over, never the caller's ambient env.
// For nested/workspace, that source is tenant T's freshly-parsed `.env` — the
// supervisor's own `process.env` (and the #60 deployment clone credential in
// it) is never on the base allowlist, so it is fail-closed invisible to fleet
// children. For flat, the source is the supervisor's own `process.env`
// itself: one tenant is one trust domain (the whole container), and Docker
// already injects exactly that tenant's secrets into it — so passing it
// through in full changes nothing. `buildAgentEnv` (src/agent-env.ts) then
// narrows correctly at the agent hop, unchanged, because the child's env
// already holds only its tenant's secrets.

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
 * Build one engine child's env: the allowlisted base + deployment knobs from
 * `base` (the deployment's `process.env`), overlaid with `extraEnv` — this
 * launch's engine provenance and resolved-config snapshot (boot.ts's
 * `engineProvenanceEnv`) — overlaid last with `secrets`, the caller's secret
 * source (`boot.ts`'s doc comment above explains why that source differs by
 * spawn path).
 *
 * `secrets` is copied through as-is (no empty-string filtering): for the flat
 * path it *is* `process.env`, which may legitimately hold an empty-string
 * value, and the copy must be lossless for the child's env to be
 * byte-identical to today's plain inherit. `base`/`extraEnv` keep the
 * empty-string filter — those are allowlisted knobs, where an explicitly
 * empty value means "unset", not "set to empty".
 */
export function childEnv(opts: {
  base: Record<string, string | undefined>;
  secrets: Record<string, string | undefined>;
  extraEnv?: Record<string, string>;
}): Record<string, string> {
  const { base, secrets, extraEnv } = opts;
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
  // Secrets last: they are the caller's own trust domain, and win over any
  // collision with the base allowlist or the launch provenance.
  for (const [key, value] of Object.entries(secrets)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
