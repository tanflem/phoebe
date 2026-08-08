// The bootstrapper's minimal engine-source reader.
//
// The published `phoebe-agent` package is a thin bootstrapper: it materializes
// the engine (`src/`) from a git ref or a local mount, then runs it. The only
// part of the consumer's mounted `phoebe.config.ts` the bootstrapper needs is
// the `engine` field — the full config schema stays the engine's concern
// (src/config/). This module is that minimal reader: it
// takes the `engine` field (or a loaded config carrying it) and returns the
// resolved source with defaults applied, and nothing else.
//
// The user-facing field type (`EngineSourceField`) lives with the rest of the
// config schema in the engine so there is one source of truth for the config
// shape, validation, resolution, and defaults. This module keeps the
// bootstrapper-facing reader and re-exports that shared engine-source contract.

import {
  validateEngineSourceField,
  type EngineSourceField,
  type ResolvedEngineSource,
} from "../src/config/types.ts";

/** Repo the engine is cloned from when `source: "github"` omits `repo`. */
export const DEFAULT_ENGINE_REPO = "JesusFilm/phoebe";
/** Ref the engine is checked out at when `source: "github"` omits `ref`. */
export const DEFAULT_ENGINE_REF = "main";

/**
 * Resolve the optional `engine` field into a concrete source. An omitted field
 * (or an omitted `ref`/`repo` on a github source) falls back to the shipped
 * bootstrapper defaults.
 */
export function resolveEngineSource(field: EngineSourceField | undefined): ResolvedEngineSource {
  if (field === undefined || field.source === "github") {
    return {
      source: "github",
      ref: field?.ref ?? DEFAULT_ENGINE_REF,
      repo: field?.repo ?? DEFAULT_ENGINE_REPO,
    };
  }
  return { source: "local" };
}

export type { ResolvedEngineSource };

/**
 * Whether an arbitrary value is a well-formed `engine` field. This legacy
 * bootstrapper-facing reader shares validation with layered and snapshot
 * resolution. An unknown `source` must not fall through to `local`, and a
 * non-string `ref`/`repo` must not escape into a resolved source.
 */
/**
 * Extract the resolved engine source from a loaded consumer config, ignoring
 * every other field. This is the whole of the bootstrapper's interest in the
 * config; the engine reads (and validates) the rest once it is materialized and
 * run. The config arrives as a dynamically-imported module value, so the param
 * is an arbitrary record — `engine`, if present, is validated before use so a
 * typo (bad `source`, numeric `ref`/`repo`) fails loudly instead of silently
 * resolving to the wrong source.
 */
export function readEngineSource(config: Record<string, unknown>): ResolvedEngineSource {
  const field = config["engine"];
  if (field !== undefined) validateEngineSourceField(field);
  return resolveEngineSource(field);
}
