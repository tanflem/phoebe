// `boot` — the bootstrapper-only entry in the command table (#75). It carries
// the same `spec`/`help`/`run` shape as every engine command, but is composed
// onto the table from `bootstrap/cli.ts` rather than living in
// `src/commands/`: `boot`'s `run` calls `runBoot` (./boot.ts), and `src/`
// importing that would run the dependency the wrong way — the bootstrapper
// depends on the engine, never the reverse.
//
// `run` does nothing but parse `--help`/`-h` through the shared tokenizer and
// otherwise forward the rest of argv to `runBoot` untouched — the same
// `onUnknownFlag: "forward"` shape `phoebe`'s own engine-mode parser uses
// (src/commands/engine.ts), since boot's extra argv is meant for the engine
// child it launches, not for boot itself.

import type { ArgSpec } from "../src/arg-spec.ts";
import { parseArgs } from "../src/arg-spec.ts";
import type { Command } from "../src/commands/index.ts";
import { runBoot } from "./boot.ts";

/** The table's one-liner for `boot`, column-aligned with every other entry
 *  (see `buildHelpText`, src/commands/engine.ts). */
export const BOOT_SUMMARY = "  phoebe boot                      Container long-lived main process";

export const BOOT_HELP_TEXT = `phoebe boot — the container's long-lived main process

Usage:
  phoebe boot [-- <engine flags>]

Reads the mounted config, resolves the engine source (a local mount or a
github checkout), execs the engine as a long-running child, and supervises
it: a config or tracked-ref change drains and relaunches it in place, and a
crash-looping ref falls back to the last commit that ran healthily.

Extra arguments are forwarded to the engine child on every launch (none ⇒
its normal persistent poll loop).
`;

const BOOT_SPEC: ArgSpec = {
  booleanFlags: ["help"],
  aliases: { h: "help" },
  onUnknownFlag: "forward",
};

/**
 * Builds the command rather than exporting one fixed instance so a test can
 * swap in a fake in place of the real, container-shaped `runBoot` (which
 * reads `process.cwd()` and never resolves in normal operation) and assert
 * on dispatch — the `--help` short-circuit and argv forwarding — without
 * actually booting anything.
 */
export function createBootCommand(deps: { runBoot?: typeof runBoot } = {}): Command {
  const boot = deps.runBoot ?? runBoot;
  return {
    name: "boot",
    summary: BOOT_SUMMARY,
    help: BOOT_HELP_TEXT,
    async run(argv, ctx) {
      const parsed = parseArgs(argv, BOOT_SPEC);
      if (parsed.flags["help"] === true) {
        ctx.stdout.write(BOOT_HELP_TEXT);
        return 0;
      }
      await boot(parsed.positionals);
      return 0;
    },
  };
}

export const bootCommand: Command = createBootCommand();
