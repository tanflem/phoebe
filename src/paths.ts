// Per-tenant filesystem layout, derived from the repo slug.
//
// A multi-tenant Phoebe deployment nests every tenant's persistent state under
// a single slug-keyed root on the shared `phoebe-data` volume (#62):
//
//   /data/repos/<owner>/<repo>/
//       repo/         the private clone (origin hub)
//       worktrees/    per-unit git worktrees
//       state/        per-tenant state (status-v2.json, runtime-id, events-v1/)
//
// The base (`/data/repos`) is a deployment-global constant in the container;
// `PHOEBE_DATA_DIR` overrides it for host/dev. Derivation is a pure function of
// (slug, base), so it is trivially unit-testable and the ~15 `config.paths.*`
// readers in the engine are unchanged — only the value's origin moved off the
// user config (#58: `paths` leaves `PhoebeUserConfig`; it is now a resolved,
// derived field).
//
// The shared engine checkout and the deployment-global crash-loop state live at
// `/data/engine` (#60), *outside* this per-tenant namespace — see
// bootstrap/crash-loop.ts. Rooting tenant data at `/data/repos` (not bare
// `/data/<slug>`) keeps any tenant slug from ever colliding with `engine`.

import { join } from "node:path";
import type { PathsConfig } from "./config/types.ts";

/** Container base for all tenant data; the `phoebe-data` volume mounts here (#62). */
export const DEFAULT_DATA_BASE = "/data/repos";

/**
 * Derive a tenant's `{repoDir, worktreesDir, stateDir}` from its `owner/repo`
 * slug and the deployment data base. The slug is authoritative and the nested
 * path is derived from it (#58), so two tenants can never collide and any
 * retained data is only ever reused by the same repo. A pure function of its
 * inputs — no environment read — so callers stay testable.
 */
export function derivePaths(repoSlug: string, dataBase: string = DEFAULT_DATA_BASE): PathsConfig {
  const root = join(dataBase, repoSlug);
  return {
    repoDir: join(root, "repo"),
    worktreesDir: join(root, "worktrees"),
    stateDir: join(root, "state"),
  };
}

/**
 * The deployment data base, honoring the `PHOEBE_DATA_DIR` host/dev override.
 * Kept apart from `derivePaths` so the derivation stays pure; the CLI reads the
 * env once and threads the result into `resolveConfig`.
 */
export function resolveDataBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env["PHOEBE_DATA_DIR"];
  return typeof raw === "string" && raw.length > 0 ? raw : DEFAULT_DATA_BASE;
}
