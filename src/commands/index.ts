// The one command table (#73): every named `phoebe <command>` plus the
// unnamed default (engine mode). `runCli` (../cli.ts) does nothing but look a
// command up here and call it — table lookup, parse, validate, and run all
// happen inside each command's own `run`.

import { addRepoCommand } from "./add-repo.ts";
import { configResolveCommand } from "./config-resolve.ts";
import { buildHelpText, engineCommand, HELP_TEXT, runEngineMode } from "./engine.ts";
import { initCommand } from "./init.ts";
import { listCommand } from "./list.ts";
import { purgeCommand } from "./purge.ts";
import { removeRepoCommand } from "./remove-repo.ts";
import { serveCommand } from "./serve.ts";
import { setupCommand } from "./setup.ts";
import { statusCommand } from "./status.ts";
import type { Command } from "./types.ts";

/** Keyed by the leading argv token that routes to it. */
export const COMMAND_TABLE: Readonly<Record<string, Command>> = {
  setup: setupCommand,
  init: initCommand,
  config: configResolveCommand,
  status: statusCommand,
  "add-repo": addRepoCommand,
  "remove-repo": removeRepoCommand,
  list: listCommand,
  purge: purgeCommand,
  serve: serveCommand,
};

/** The table's unnamed entry — anything not matching a name above. */
export const DEFAULT_COMMAND: Command = engineCommand;

// `buildHelpText`/`runEngineMode` let a caller extend the table with a
// command `src/` cannot own (the dependency direction is one-way — engine
// code never imports the bootstrapper) while still getting one composed
// `--help` and one dispatch (`runCli`'s `extension` parameter, #75).
export { HELP_TEXT, buildHelpText, runEngineMode };

export type { Command } from "./types.ts";
