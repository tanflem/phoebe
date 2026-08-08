// `phoebe setup` — CLI-layer wrapper around the wizard in `../setup.ts`. Argv
// parsing lives here (#73); the interactive orchestration itself stays in
// `runSetup`, which already takes `cwd`/`env`/`io` as injectable options —
// the pattern the rest of the command table follows.

import type { ArgSpec } from "../arg-spec.ts";
import { parseArgs } from "../arg-spec.ts";
import { runSetup } from "../setup.ts";
import type { Command } from "./types.ts";

export type ParsedSetupArgs = { targetDir: string; help: boolean };

const SETUP_SPEC: ArgSpec = {
  booleanFlags: ["help"],
  aliases: { h: "help" },
  maxPositionals: 1,
  unknownFlag: (arg) =>
    `Unknown flag \`${arg}\` for \`phoebe setup\`. See \`phoebe setup --help\`.`,
  tooManyPositionals: (first, extra) =>
    `\`phoebe setup\` takes at most one target directory (got \`${first}\` and \`${extra}\`).`,
};

/**
 * Parse argv left after the leading `setup` token. Mirrors `phoebe init`:
 * an optional positional target directory plus `--help`; unknown flags and a
 * second positional are rejected loudly.
 */
export function parseSetupArgs(argv: readonly string[]): ParsedSetupArgs {
  const parsed = parseArgs(argv, SETUP_SPEC);
  return { targetDir: parsed.positionals[0] ?? ".", help: parsed.flags["help"] === true };
}

export const SETUP_HELP_TEXT = `phoebe setup — interactive one-stop setup wizard

Usage:
  phoebe setup [dir]

Scaffolds the consumer runtime (everything \`phoebe init\` writes), then walks you
through a short Q&A and writes a complete phoebe.config.ts and a filled .env into
[dir] (default: current directory). Pick your AI provider, drop in your tokens,
and go straight to \`docker compose build\`.

Requires an interactive terminal. For non-interactive scaffolding with
placeholder values, use \`phoebe init\` instead.
`;

export const setupCommand: Command = {
  name: "setup",
  summary: "phoebe setup [dir]               Interactive wizard: scaffold + fill config & .env",
  help: SETUP_HELP_TEXT,
  async run(argv, ctx) {
    const parsed = parseSetupArgs(argv);
    if (parsed.help) {
      ctx.stdout.write(SETUP_HELP_TEXT);
      return 0;
    }
    await runSetup({ targetDir: parsed.targetDir, cwd: ctx.cwd, env: ctx.env });
    return 0;
  },
};
