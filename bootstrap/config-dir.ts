// Bootstrapper-only `configDir` reader (#98).
//
// Mirrors `engine-source.ts` / `workspace-source.ts`: `configDir` is a
// bootstrapper concern the engine never reads (`resolveConfiguration` drops it,
// same as `engine`/`workspace`). It relocates a tenant's asset directory —
// where its co-located `.env` and prompt/asset files live — to a subdirectory
// of the dir holding its `phoebe.config.ts`, so a workspace/nested tenant can
// reuse its standalone `.phoebe/` folder instead of duplicating `.env` and
// `prompts/` at the repo root.
//
// The value is validated the same way `src/config/` validates it, but read
// here from the untyped mounted config before the engine validates — a
// malformed value fails the discovery walk (skip-and-warn) rather than silently
// falling back to co-location.

import { isAbsolute } from "node:path";

/** Default asset dir: co-located with `phoebe.config.ts` (today's behavior). */
export const DEFAULT_TENANT_CONFIG_DIR = ".";

/**
 * Whether an arbitrary value is a well-formed `configDir` — a non-empty
 * *relative* path with no `..` segment (it must stay inside the tenant dir; an
 * absolute path or `..` would reach another tenant's or the host's secrets).
 */
function isConfigDir(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  if (isAbsolute(value)) return false;
  return !value.split(/[/\\]/).some((segment) => segment === "..");
}

/**
 * Extract the resolved `configDir` from a loaded tenant config, defaulting to
 * `"."` (co-located) when the field is absent. A present but malformed value is
 * a hard error — silent defaulting would hide a typo that sent the supervisor
 * reading the wrong `.env`.
 */
export function readConfigDir(config: Record<string, unknown>): string {
  const field = config["configDir"];
  if (field === undefined) return DEFAULT_TENANT_CONFIG_DIR;
  if (!isConfigDir(field)) {
    throw new Error(
      `phoebe.config.ts \`configDir\` must be a non-empty relative path with no ` +
        `".." segment (got ${JSON.stringify(field)}).`,
    );
  }
  return field;
}
