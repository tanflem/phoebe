#!/usr/bin/env node

// `phoebe` bootstrapper entry — the real command surface, in TypeScript.
//
// This is NOT the file npm symlinks as the bin: Node 24 refuses to type-strip
// `.ts` under `node_modules`, so a tiny JS launcher (bootstrap/bin.mjs) is the
// bin instead. That launcher copies the package out of `node_modules` and execs
// THIS module with plain `node` — from outside `node_modules`, where raw `.ts`
// runs. So all bootstrapper logic lives here as type-checked TypeScript.
//
// `phoebe boot` (bootstrap/boot.ts, wired in here as `bootCommand`,
// bootstrap/boot-command.ts) is the container's long-lived main process: it
// resolves the engine source (bootstrap/engine-source.ts) — a local mount or
// a github checkout (bootstrap/github-engine.ts) — execs the engine as a
// long-running child forwarding SIGTERM so the engine drains, and supervises it
// with the reconcile watch (bootstrap/reconcile.ts): a config or ref change
// drains and respawns in place. Every other invocation goes through the same
// `runCli` dispatch — scaffold via `init`, otherwise run the engine directly.
//
// `boot` joins that one dispatch as a table extension (#75) rather than a
// table entry: it composes onto the engine's command table from here, so
// `src/` never has to import `bootstrap/boot.ts` to know it exists. That also
// means `boot` goes through the shared tokenizer like every other command —
// `phoebe boot --help` works and `phoebe --help` lists it — where before it
// was a bare `argv[0] === "boot"` branch with no argv parsing at all.

import { buildHelpText } from "../src/commands/engine.ts";
import type { CliContext } from "../src/cli.ts";
import { runCli } from "../src/cli.ts";
import { BOOT_SUMMARY, bootCommand } from "./boot-command.ts";

const argv = process.argv.slice(2);
const ctx: CliContext = {
  cwd: process.cwd(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
};

runCli(argv, ctx, {
  commands: { boot: bootCommand },
  helpText: buildHelpText(`${BOOT_SUMMARY}\n`),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // `runCli` reports every command error itself and never rejects; this
    // is only a backstop against a truly unexpected failure.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[phoebe] ${message}`);
    process.exitCode = 1;
  },
);
