// The boot → engine handoff: a canonical, versioned, non-secret JSON snapshot
// of a resolved configuration. Boot resolves once and passes the snapshot to
// its child via `BOOTSTRAP_RESOLVED_CONFIG_ENV` so engine source and runtime
// config are one atomic resolution even across an in-between edit; a directly
// invoked engine (no boot) resolves the authored files itself instead.

import { resolveEngineSource } from "../../bootstrap/engine-source.ts";
import { resolveConfig, type ResolvedConfiguration } from "./resolve.ts";
import { validateEngineSourceField, validateWorkOrder, type PhoebeUserConfig } from "./types.ts";

export type { ResolvedConfiguration } from "./resolve.ts";

/** Internal handoff that freezes boot's resolution for the child engine. */
export const BOOTSTRAP_RESOLVED_CONFIG_ENV = "PHOEBE_BOOTSTRAP_RESOLVED_CONFIG";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Canonical, versioned and non-secret representation for deployment validation.
 * Only resolved config values and environment-variable names are included;
 * process environment values are never serialized.
 */
export function formatResolvedConfiguration(resolved: ResolvedConfiguration): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      config: {
        ...resolved.config,
        engine: resolved.engine,
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * Read the non-secret snapshot passed from boot to its child engine. The child
 * uses this instead of re-reading mutable authored files, so engine source and
 * runtime config are one atomic resolution even across an in-between edit.
 */
export function parseResolvedConfigurationSnapshot(
  contents: string,
  opts: { dataBase?: string } = {},
): ResolvedConfiguration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Invalid ${BOOTSTRAP_RESOLVED_CONFIG_ENV}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isRecord(parsed) || parsed["schemaVersion"] !== 1 || !isRecord(parsed["config"])) {
    throw new Error(
      `${BOOTSTRAP_RESOLVED_CONFIG_ENV} must be a schemaVersion 1 resolved configuration.`,
    );
  }
  const { engine, ...runtime } = parsed["config"];
  validateEngineSourceField(engine, `${BOOTSTRAP_RESOLVED_CONFIG_ENV}.config.engine`);
  const config = resolveConfig(runtime as PhoebeUserConfig, { dataBase: opts.dataBase });
  validateWorkOrder(config.workOrder);
  return { config, engine: resolveEngineSource(engine) };
}
