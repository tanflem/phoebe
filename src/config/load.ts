// Filesystem-facing config plumbing: resolving a `--config` argument to an
// absolute path, dynamically importing the consumer's `phoebe.config.ts`,
// reading the optional generated base document, and `loadConfiguration` — the
// verb that chains all three into the same canonical resolution boot and the
// engine use.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseBaseConfigDocument,
  resolveConfiguration,
  type ResolvedConfiguration,
} from "./resolve.ts";
import type { PhoebeUserConfig } from "./types.ts";

/**
 * Resolve a `--config` argument (or the default) to an absolute path and
 * assert the file exists. Split from `loadUserConfig` so the CLI can print
 * a precise "file not found" message before attempting the dynamic import.
 */
export function resolveConfigPath(argPath: string | undefined, cwd: string): string {
  const candidate = argPath ?? "phoebe.config.ts";
  const absolute = isAbsolute(candidate) ? candidate : resolvePath(cwd, candidate);
  if (!existsSync(absolute)) {
    throw new Error(
      argPath
        ? `Config file not found: ${absolute} (passed via --config).`
        : `Config file not found: ${absolute}. ` +
            `Create a phoebe.config.ts in the current directory or pass --config <path>.`,
    );
  }
  return absolute;
}

/**
 * Dynamically import a `phoebe.config.ts` and return the user shape. Native
 * Node type-stripping (unflagged on Node ≥ 24, the version Phoebe requires)
 * handles the TS syntax — no bundler needed on the consumer side. Accepts
 * either a default export or a named `config` export so the pre-`defineConfig`
 * scaffold still loads.
 *
 * `reloadKey` busts Node's ESM module cache, which is keyed by URL and would
 * otherwise hand back the first import forever. The engine never needs it (each
 * run is a fresh process); `phoebe boot` does, because it re-reads the mounted
 * config in-process when the reconcile watch sees it change (#42). Pass the
 * config's fingerprint, not a counter: an unchanged config then reuses the
 * cached module instead of leaking a new registry entry per read.
 */
export async function loadUserConfig(
  configPath: string,
  opts: { reloadKey?: string } = {},
): Promise<PhoebeUserConfig> {
  const fileUrl = pathToFileURL(configPath);
  if (opts.reloadKey !== undefined) {
    fileUrl.searchParams.set("phoebe-reload", opts.reloadKey);
  }
  const url = fileUrl.href;
  let mod: unknown;
  try {
    mod = await import(url);
  } catch (error) {
    throw new Error(
      `Failed to load ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const record = mod as Record<string, unknown>;
  const candidate =
    (typeof record["default"] === "object" && record["default"] !== null
      ? record["default"]
      : undefined) ??
    (typeof record["config"] === "object" && record["config"] !== null
      ? record["config"]
      : undefined);
  if (!candidate) {
    throw new Error(
      `${configPath} must export a Phoebe config as \`export default defineConfig({ ... })\` ` +
        `or a named \`export const config = { ... }\`.`,
    );
  }
  return candidate as PhoebeUserConfig;
}

/** Validate and return the configured absolute base-document path, if any. */
export function resolveBaseConfigPath(env: NodeJS.ProcessEnv): string | undefined {
  const path = env["PHOEBE_BASE_CONFIG"];
  if (path === undefined) return undefined;
  if (!isAbsolute(path)) {
    throw new Error(`PHOEBE_BASE_CONFIG must be an absolute path (got "${path}").`);
  }
  return path;
}

/** Read the generated layer with path-specific errors. */
function loadBaseConfig(
  env: NodeJS.ProcessEnv,
  read: (path: string) => Uint8Array = readFileSync,
): ReturnType<typeof parseBaseConfigDocument> | undefined {
  const path = resolveBaseConfigPath(env);
  if (path === undefined) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = read(path);
  } catch (error) {
    throw new Error(
      `Failed to read PHOEBE_BASE_CONFIG at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(
      `PHOEBE_BASE_CONFIG at ${path} is not valid UTF-8: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseBaseConfigDocument(contents, path);
}

/**
 * Load both authored layers (the consumer's `phoebe.config.ts` and the
 * optional generated base) and resolve them through the shared contract —
 * the filesystem counterpart to `resolveConfiguration`.
 */
export async function loadConfiguration(input: {
  repositoryPath: string;
  env?: NodeJS.ProcessEnv;
  reloadKey?: string;
  dataBase?: string;
}): Promise<ResolvedConfiguration> {
  const env = input.env ?? process.env;
  const repository = await loadUserConfig(input.repositoryPath, { reloadKey: input.reloadKey });
  const base = loadBaseConfig(env);
  return resolveConfiguration({ repository, base, env, dataBase: input.dataBase });
}
