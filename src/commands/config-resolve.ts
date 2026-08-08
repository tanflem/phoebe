// `phoebe config resolve --json` — the deliberately narrow inspection command
// that prints the same canonical resolution boot and the engine use, without
// starting either. Flattened to one table entry (#73) rather than growing
// subcommand nesting for what is, so far, exactly one case.

import type { ArgSpec } from "../arg-spec.ts";
import { parseArgs } from "../arg-spec.ts";
import {
  formatResolvedConfiguration,
  loadConfiguration,
  resolveConfigPath,
} from "../config/index.ts";
import type { Command } from "./types.ts";

export type ParsedConfigResolveArgs = { configPath: string | undefined };

const CONFIG_RESOLVE_USAGE = "Usage: phoebe config resolve --json [--config <path>].";

const CONFIG_RESOLVE_SPEC: ArgSpec = {
  booleanFlags: ["json"],
  valueFlags: ["config"],
  aliases: { c: "config" },
  maxPositionals: 0,
  unknownFlag: (arg) =>
    `Unknown flag \`${arg}\` for \`phoebe config resolve\`. ${CONFIG_RESOLVE_USAGE}`,
  missingValue: (arg) => `${arg} requires a path argument.`,
};

/**
 * Parse the deliberately narrow inspection command. JSON is required so the
 * output remains machine-readable and stable; no engine flag is meaningful on
 * this read-only path.
 */
export function parseConfigResolveArgs(argv: readonly string[]): ParsedConfigResolveArgs {
  if (argv[0] !== "resolve") {
    throw new Error(CONFIG_RESOLVE_USAGE);
  }
  const parsed = parseArgs(argv.slice(1), CONFIG_RESOLVE_SPEC);
  if (parsed.flags["json"] !== true) {
    throw new Error("`phoebe config resolve` requires --json.");
  }
  const configPath = parsed.flags["config"];
  return { configPath: typeof configPath === "string" ? configPath : undefined };
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
  const resolved = await loadConfiguration({
    repositoryPath: configPath,
    env: runtime.env ?? process.env,
  });
  return formatResolvedConfiguration(resolved);
}

export const configResolveCommand: Command = {
  name: "config resolve",
  summary: "phoebe config resolve --json     Print the canonical effective configuration",
  help: `phoebe config resolve — print the effective configuration

${CONFIG_RESOLVE_USAGE}

Resolves the same layers boot and the engine use (built-in defaults, the
optional generated base, phoebe.config.ts, the PHOEBE_* env overlay) and
prints the result as JSON, without starting the engine.
`,
  async run(argv, ctx) {
    ctx.stdout.write(await runConfigResolve(argv, { cwd: ctx.cwd, env: ctx.env }));
    return 0;
  },
};
