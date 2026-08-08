// Engine bootstrapping — the table's unnamed default entry (#73). Not CLI
// glue: `extractRepoFlag` → `resolveEngineConfigPath` → `loadEngineConfiguration`
// → `setResolvedConfig` → dynamic `import("../main.ts")`. Loads the consumer's
// `phoebe.config.ts`, overlays `PHOEBE_*` env vars, installs the resolved
// config, then hands off to `runEngine`.
//
// A direct engine run (`--run-once` / `--dry-run`) selects its tenant (#63):
// flat has no selector; nested requires `--repo <owner/repo>`, loading only
// that tenant's config. A boot-spawned child runs with cwd = its tenant dir
// (flat from there), so this only fires for a manual invocation from the
// deployment root. `phoebe boot` (the supervisor) never reaches here. It also
// consumes boot's BOOTSTRAP_RESOLVED_CONFIG_ENV snapshot when present, so a
// boot-spawned child gets its pre-resolved config atomically rather than
// re-reading mutable files.

import { join } from "node:path";
import { REPOS_DIR } from "../../bootstrap/tenants.ts";
import type { ArgSpec } from "../arg-spec.ts";
import { parseArgs } from "../arg-spec.ts";
import {
  BOOTSTRAP_RESOLVED_CONFIG_ENV,
  parseResolvedConfigurationSnapshot,
  loadResolvedConfiguration,
  type ResolvedConfiguration,
} from "../config-resolution.ts";
import { resolveConfigPath } from "../load-config.ts";
import { resolveDataBase } from "../paths.ts";
import { setResolvedConfig } from "../resolved-config.ts";
import { isNested, parseSlug } from "../tenant-commands.ts";
import type { Command } from "./types.ts";

export { BOOTSTRAP_RESOLVED_CONFIG_ENV };

export type ParsedCliArgs = { configPath: string | undefined; help: boolean; forward: string[] };

const CLI_SPEC: ArgSpec = {
  booleanFlags: ["help"],
  valueFlags: ["config"],
  aliases: { h: "help", c: "config" },
  onUnknownFlag: "forward",
  missingValue: (arg) => `${arg} requires a path argument (e.g. --config phoebe.config.ts).`,
};

/**
 * Extract `--config <path>` / `--config=<path>` / `-c <path>` and `--help`/`-h`
 * from argv, forwarding everything else to `runEngine`. A minimal parser is
 * enough — the engine handles its own boolean flags (`--run-once`, `--dry-run`)
 * from the forwarded array. Also reused by `phoebe status`, which shares the
 * same `--config`/`--help` surface and does its own filtering of the rest.
 */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const parsed = parseArgs(argv, CLI_SPEC);
  const configPath = parsed.flags["config"];
  return {
    configPath: typeof configPath === "string" ? configPath : undefined,
    help: parsed.flags["help"] === true,
    forward: parsed.positionals,
  };
}

const REPO_FLAG_SPEC: ArgSpec = {
  guardedValueFlags: ["repo"],
  onUnknownFlag: "forward",
};

/** Pull an optional `--repo <owner/repo>` (or `--repo=…`) out of the engine argv. */
function extractRepoFlag(argv: readonly string[]): { slug: string | undefined; forward: string[] } {
  const parsed = parseArgs(argv, REPO_FLAG_SPEC);
  const slug = parsed.flags["repo"];
  return { slug: typeof slug === "string" ? slug : undefined, forward: parsed.positionals };
}

/**
 * Resolve which `phoebe.config.ts` a direct engine run loads. An explicit
 * `--config` always wins. Otherwise: nested (a `repos/` dir under cwd) requires
 * `--repo <owner/repo>` and loads `repos/<owner>/<repo>/phoebe.config.ts`; flat
 * loads the top config and ignores `--repo`.
 */
function resolveEngineConfigPath(
  configArg: string | undefined,
  repoSlug: string | undefined,
  cwd: string,
): string {
  if (configArg !== undefined) return resolveConfigPath(configArg, cwd);
  if (isNested(cwd)) {
    if (repoSlug === undefined) {
      throw new Error(
        "This is a nested (multi-tenant) deployment — specify --repo <owner/repo> " +
          "(see `phoebe list`), or run `phoebe boot` to supervise every tenant.",
      );
    }
    const { owner, repo } = parseSlug(repoSlug);
    return resolveConfigPath(join(REPOS_DIR, owner, repo, "phoebe.config.ts"), cwd);
  }
  return resolveConfigPath(undefined, cwd);
}

/**
 * Engine-mode resolution. A boot-supervised child consumes boot's immutable
 * snapshot; a directly-invoked engine resolves the authored files itself.
 */
export function loadEngineConfiguration(
  configPath: string,
  env: NodeJS.ProcessEnv,
  dataBase?: string,
): Promise<ResolvedConfiguration> {
  const snapshot = env[BOOTSTRAP_RESOLVED_CONFIG_ENV];
  return snapshot === undefined
    ? loadResolvedConfiguration(configPath, { env, dataBase })
    : Promise.resolve(parseResolvedConfigurationSnapshot(snapshot, { dataBase }));
}

// The engine command's `--help` prints the full root usage (every command's
// one-liner plus engine-mode options) — this is what `phoebe --help` with no
// subcommand has always shown, so it lives here rather than being duplicated
// in commands/index.ts.
export const HELP_TEXT = `phoebe — AFK coding agent

Usage:
  phoebe setup [dir]               Interactive wizard: scaffold + fill config & .env
  phoebe init [dir]                Scaffold a flat single-tenant deployment
  phoebe init --workspace [dir]    Scaffold a workspace root (multi-child)
  phoebe init --tenant [dir]       Scaffold a workspace child in-tree install
  phoebe add-repo <owner/repo>     Add a tenant (→ nested multi-tenant)
  phoebe remove-repo <owner/repo>  Remove a tenant's config (data retained)
  phoebe list                      List tenants + health (in-container)
  phoebe purge <owner/repo> --yes  Wipe a removed tenant's data (in-container)
  phoebe serve [--port N]          Serve a read-only fleet page (see --help)
    [--state-dir DIR]...
  phoebe config resolve --json     Print the canonical effective configuration
  phoebe status --json             Read the local status-v2 projection
  phoebe [--config <path>] [flags] Run the engine

Options (engine mode):
  --config, -c <path>   Path to phoebe.config.ts (default: ./phoebe.config.ts)
  --run-once            Work one unit of the first one-shot-eligible kind, then exit
  --dry-run             Print the selected unit without executing it
  --help, -h            Show this message

Environment overlays (each replaces the corresponding config field):
  PHOEBE_REPO_SLUG, PHOEBE_REPO_URL, PHOEBE_DEFAULT_BRANCH, PHOEBE_BRANCH_PREFIX,
  PHOEBE_READY_LABEL, PHOEBE_PROCESSING_LABEL, PHOEBE_PR_OPT_OUT_LABEL,
  PHOEBE_INSTALL_COMMAND, PHOEBE_CHECK_COMMAND, PHOEBE_TEST_COMMAND,
  PHOEBE_READY_COMMAND, PHOEBE_BLOCKED_BY_PATTERN, PHOEBE_REVIEWS_SUCCESS_HEADING,
  PHOEBE_PR_SCOPE, PHOEBE_DRAFT_PRS, PHOEBE_DEFAULT_PROVIDER

Runtime toggles (read directly by the engine, not overlaid onto the config):
  PHOEBE_BASE_CONFIG     Absolute path to a versioned generated base config
  PHOEBE_AGENT           Provider name to use for this run (cursor|claude|codex)
  PHOEBE_MODEL           Model to use for this run
  PHOEBE_RUNTIME_ID      Stable identity for a new state volume
  PHOEBE_POLL_INTERVAL_MS Persistent-mode poll interval (default 300000)
`;

export const engineCommand: Command = {
  name: "",
  summary: "phoebe [--config <path>] [flags] Run the engine",
  help: HELP_TEXT,
  async run(argv, ctx) {
    const parsed = parseCliArgs(argv);
    if (parsed.help) {
      ctx.stdout.write(HELP_TEXT);
      return 0;
    }

    const { slug: repoSlug, forward } = extractRepoFlag(parsed.forward);
    const dataBase = resolveDataBase(ctx.env);
    const configPath =
      ctx.env[BOOTSTRAP_RESOLVED_CONFIG_ENV] === undefined
        ? resolveEngineConfigPath(parsed.configPath, repoSlug, ctx.cwd)
        : (parsed.configPath ?? "phoebe.config.ts");
    const resolved = await loadEngineConfiguration(configPath, ctx.env, dataBase);
    setResolvedConfig(resolved.config);

    // Import after the config is installed — main.ts's module-level constants
    // read `config` at import time via the Proxy in resolved-config.ts.
    const { runEngine } = await import("../main.ts");
    await runEngine(forward);
    return 0;
  },
};
