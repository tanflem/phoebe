#!/usr/bin/env node

// `phoebe` bin — the packaged CLI consumers invoke via
// `npx phoebe-agent [flags]` (or a pinned `phoebe` script). Recognises two
// modes:
//
//   phoebe init [dir]   Scaffold a consumer-owned runtime (config, prompts,
//                       .env.example, container templates, gitignore).
//                       Skips existing files — safe to re-run.
//   phoebe config resolve --json
//                       Print the canonical effective configuration and exit.
//   phoebe [flags]      Run the engine. Loads the consumer's
//                       `phoebe.config.ts`, overlays `PHOEBE_*` env vars,
//                       installs the resolved config, then hands off to main.
//
// This is the only supported v1 programmatic surface: there is no exported
// `run(config)` — CLI-only. That keeps every consumer on the same load/resolve/
// install pipeline and leaves the door open to CLI-only concerns (init/pin
// scaffolding, log formatting) without breaking a library API.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  BOOTSTRAP_RESOLVED_CONFIG_ENV,
  formatResolvedConfiguration,
  loadResolvedConfiguration,
  parseResolvedConfigurationSnapshot,
  type ResolvedConfiguration,
} from "./config-resolution.ts";
import { formatInitReport, runInit } from "./init.ts";
import { resolveConfigPath } from "./load-config.ts";
import { setResolvedConfig } from "./resolved-config.ts";
import { parseSetupArgs, runSetup, SETUP_HELP_TEXT } from "./setup.ts";

type ParsedArgs = { configPath: string | undefined; help: boolean; forward: string[] };

export { BOOTSTRAP_RESOLVED_CONFIG_ENV };

/**
 * Extract `--config <path>` / `--config=<path>` / `-c <path>` and `--help`/`-h`
 * from argv, forwarding everything else to `runEngine`. A minimal parser is
 * enough — the engine handles its own boolean flags (`--run-once`, `--dry-run`)
 * from the forwarded array.
 */
export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const forward: string[] = [];
  let configPath: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--config" || arg === "-c") {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error(`${arg} requires a path argument (e.g. --config phoebe.config.ts).`);
      }
      configPath = next;
      i += 1;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      continue;
    }
    if (arg !== undefined) {
      forward.push(arg);
    }
  }
  return { configPath, help, forward };
}

export type ParsedInitArgs = { targetDir: string; help: boolean };

/**
 * Parse argv left after the leading `init` token has been consumed. Supports
 * an optional positional target directory (`phoebe init ./my-agent`) and
 * `--help`. Extra flags are rejected loudly so a typo like `--forcee` fails
 * fast instead of being silently ignored.
 */
export function parseInitArgs(argv: readonly string[]): ParsedInitArgs {
  let targetDir: string | undefined;
  let help = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag \`${arg}\` for \`phoebe init\`. See \`phoebe init --help\`.`);
    }
    if (targetDir !== undefined) {
      throw new Error(
        `\`phoebe init\` takes at most one target directory (got \`${targetDir}\` and \`${arg}\`).`,
      );
    }
    targetDir = arg;
  }
  return { targetDir: targetDir ?? ".", help };
}

export type ParsedConfigResolveArgs = { configPath: string | undefined };

/**
 * Parse the deliberately narrow inspection command. JSON is required so the
 * output remains machine-readable and stable; no engine flag is meaningful on
 * this read-only path.
 */
export function parseConfigResolveArgs(argv: readonly string[]): ParsedConfigResolveArgs {
  if (argv[0] !== "resolve") {
    throw new Error("Usage: phoebe config resolve --json [--config <path>].");
  }

  let json = false;
  let configPath: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--config" || arg === "-c") {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error(`${arg} requires a path argument.`);
      }
      configPath = next;
      i += 1;
      continue;
    }
    if (arg?.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      continue;
    }
    throw new Error(
      `Unknown flag \`${String(arg)}\` for \`phoebe config resolve\`. ` +
        "Usage: phoebe config resolve --json [--config <path>].",
    );
  }
  if (!json) {
    throw new Error("`phoebe config resolve` requires --json.");
  }
  return { configPath };
}

/**
 * Resolve the same layers used by boot and the engine, without importing or
 * starting the engine. Returning the text keeps stdout behavior testable.
 */
export async function runConfigResolve(
  argv: readonly string[],
  runtime: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const parsed = parseConfigResolveArgs(argv);
  const configPath = resolveConfigPath(parsed.configPath, runtime.cwd ?? process.cwd());
  const resolved = await loadResolvedConfiguration(configPath, {
    env: runtime.env ?? process.env,
  });
  return formatResolvedConfiguration(resolved);
}

/**
 * Engine-mode resolution. A boot-supervised child consumes boot's immutable
 * snapshot; a directly-invoked engine resolves the authored files itself.
 */
export function loadEngineConfiguration(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedConfiguration> {
  const snapshot = env[BOOTSTRAP_RESOLVED_CONFIG_ENV];
  return snapshot === undefined
    ? loadResolvedConfiguration(configPath, { env })
    : Promise.resolve(parseResolvedConfigurationSnapshot(snapshot));
}

const HELP_TEXT = `phoebe — AFK coding agent

Usage:
  phoebe setup [dir]               Interactive wizard: scaffold + fill config & .env
  phoebe init [dir]                Scaffold a consumer-owned runtime
  phoebe config resolve --json     Print the canonical effective configuration
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
  PHOEBE_POLL_INTERVAL_MS Persistent-mode poll interval (default 300000)
`;

const INIT_HELP_TEXT = `phoebe init — scaffold a consumer-owned runtime

Usage:
  phoebe init [dir]

Writes into [dir] (default: current directory):
  phoebe.config.ts             Consumer config starter (edit the five required fields)
  prompts/                     Copies of the shipped agent prompts (edit to override)
  .env.example                 Documented environment variables to copy to .env
  .gitignore                   Additive — appends Phoebe entries only
  container/Dockerfile         Runtime image (Node 24 + git + gh, entrypoint: phoebe boot)
  container/compose.yml        Compose config for the long-lived boot container
  container/compose.local.yml  Dev overlay to run an engine checkout from your host

Existing files are left untouched, so re-running is safe. To regenerate a
scaffolded file, delete it first and re-run \`phoebe init\`.
`;

/**
 * Engine-CLI entry point. Loads the consumer's config, overlays env, installs
 * the resolved config, then runs the engine (or scaffolds via `init`). The
 * bootstrapper (bootstrap/cli.ts) delegates here so the engine keeps a single
 * load/resolve/install pipeline and stays directly runnable. The published bin
 * is a JS launcher (bootstrap/bin.mjs) that materializes the package outside
 * node_modules and execs bootstrap/cli.ts there.
 */
export async function runCli(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "setup") {
    const parsed = parseSetupArgs(args.slice(1));
    if (parsed.help) {
      process.stdout.write(SETUP_HELP_TEXT);
      return;
    }
    await runSetup({ targetDir: parsed.targetDir });
    return;
  }

  if (args[0] === "init") {
    const parsed = parseInitArgs(args.slice(1));
    if (parsed.help) {
      process.stdout.write(INIT_HELP_TEXT);
      return;
    }
    const report = runInit({ targetDir: parsed.targetDir });
    process.stdout.write(formatInitReport(report, parsed.targetDir));
    return;
  }

  if (args[0] === "config") {
    process.stdout.write(await runConfigResolve(args.slice(1)));
    return;
  }

  const parsed = parseCliArgs(args);
  if (parsed.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const configPath =
    process.env[BOOTSTRAP_RESOLVED_CONFIG_ENV] === undefined
      ? resolveConfigPath(parsed.configPath, process.cwd())
      : (parsed.configPath ?? "phoebe.config.ts");
  const resolved = await loadEngineConfiguration(configPath);
  setResolvedConfig(resolved.config);

  // Import after the config is installed — main.ts's module-level constants
  // read `config` at import time via the Proxy in resolved-config.ts.
  const { runEngine } = await import("./main.ts");
  await runEngine(parsed.forward);
}

// Run the engine only when this module is invoked directly (`node …/src/cli.ts`)
// — how the engine runs standalone. The bootstrapper reaches it by importing
// `runCli` (bootstrap/cli.ts), so this guard stays dormant there; tests import
// `parseCliArgs` without triggering the pipeline for the same reason. `argv[1]`
// is realpath'd so a symlinked entry still matches `import.meta.url`, which Node
// resolves through symlinks.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[phoebe] ${message}`);
    process.exit(1);
  });
}
