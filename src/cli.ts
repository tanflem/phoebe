#!/usr/bin/env node

// `phoebe` bin — the packaged CLI consumers invoke via
// `npx phoebe-agent [flags]` (or a pinned `phoebe` script).
//
// `runCli` is dispatch only (#73): look `argv[0]` up in the command table
// (`./commands/index.ts`), fall back to the unnamed default (engine mode)
// otherwise, and run it. Every command owns its own argv grammar, help text,
// and body — this file reads no `process.*`, which is what makes it
// testable through a fake `CliContext` for the first time.
//
// This is the only supported v1 programmatic surface: there is no exported
// `run(config)` — CLI-only. That keeps every consumer on the same load/resolve/
// install pipeline and leaves the door open to CLI-only concerns (init/pin
// scaffolding, log formatting) without breaking a library API.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { CliContext } from "./cli-context.ts";
import type { Command } from "./commands/index.ts";
import { COMMAND_TABLE, DEFAULT_COMMAND, HELP_TEXT, runEngineMode } from "./commands/index.ts";

export type { CliContext } from "./cli-context.ts";
export { BOOTSTRAP_RESOLVED_CONFIG_ENV } from "./commands/engine.ts";
export { HELP_TEXT };

/**
 * How a caller extends the table without `src/` ever knowing the extra
 * command's own module — today only the bootstrapper's `boot` (#75), which
 * must stay out of `src/`'s table (putting it there would mean `src/`
 * importing `bootstrap/`, the wrong dependency direction). `helpText` is the
 * *complete* replacement root usage (built with `buildHelpText`, ./commands/
 * engine.ts) so `phoebe --help` lists the extra command too.
 */
export type CommandTableExtension = {
  commands: Readonly<Record<string, Command>>;
  helpText: string;
};

/**
 * Look `argv[0]` up in the command table and run it with the rest of argv.
 * No match (including an empty argv, or a name the table doesn't know) falls
 * to the default engine-mode entry, which gets the *full* argv — it does its
 * own `--config`/`--help` extraction and forwards the rest to the engine.
 *
 * `extension` merges caller-supplied commands over the table for this call
 * only (`COMMAND_TABLE` itself is never mutated) and swaps in its
 * `helpText` for the unnamed default's `--help` output, so a table extended
 * this way still gets exactly one dispatch and one complete `--help`.
 *
 * Never rejects: a thrown `Error` from a command is reported to
 * `ctx.stderr` and turned into exit code 1, the same shape `phoebe`'s real
 * entry point below (and the bootstrapper's) has always reported it in.
 */
export async function runCli(
  argv: readonly string[],
  ctx: CliContext,
  extension?: CommandTableExtension,
): Promise<number> {
  const table =
    extension === undefined ? COMMAND_TABLE : { ...COMMAND_TABLE, ...extension.commands };
  const command = argv.length > 0 ? table[argv[0]!] : undefined;
  try {
    if (command !== undefined) return await command.run(argv.slice(1), ctx);
    return extension === undefined
      ? await DEFAULT_COMMAND.run(argv, ctx)
      : await runEngineMode(argv, ctx, extension.helpText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`[phoebe] ${message}\n`);
    return 1;
  }
}

// Run the engine only when this module is invoked directly (`node …/src/cli.ts`)
// — how the engine runs standalone. The bootstrapper reaches it by importing
// `runCli` (bootstrap/cli.ts), so this guard stays dormant there; tests import
// `runCli` without triggering the pipeline for the same reason. `argv[1]`
// is realpath'd so a symlinked entry still matches `import.meta.url`, which Node
// resolves through symlinks.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const ctx: CliContext = {
    cwd: process.cwd(),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  };
  runCli(process.argv.slice(2), ctx).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // `runCli` reports every command error itself and never rejects; this
      // is only a backstop against a truly unexpected failure (e.g. a
      // synchronous throw from a command module's own top-level state).
      const message = error instanceof Error ? error.message : String(error);
      ctx.stderr.write(`[phoebe] ${message}\n`);
      process.exitCode = 1;
    },
  );
}
