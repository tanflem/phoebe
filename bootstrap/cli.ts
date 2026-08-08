#!/usr/bin/env node

// `phoebe` bootstrapper entry — the real command surface, in TypeScript.
//
// This is NOT the file npm symlinks as the bin: Node 24 refuses to type-strip
// `.ts` under `node_modules`, so a tiny JS launcher (bootstrap/bin.mjs) is the
// bin instead. That launcher copies the package out of `node_modules` and execs
// THIS module with plain `node` — from outside `node_modules`, where raw `.ts`
// runs. So all bootstrapper logic lives here as type-checked TypeScript.
//
// `phoebe boot` (bootstrap/boot.ts) is the container's long-lived main process:
// it resolves the engine source (bootstrap/engine-source.ts) — a local mount or
// a github checkout (bootstrap/github-engine.ts) — execs the engine as a
// long-running child forwarding SIGTERM so the engine drains, and supervises it
// with the reconcile watch (bootstrap/supervise.ts): a config or ref change
// drains and respawns in place. Every other invocation delegates to the engine
// CLI's `runCli` — scaffold via `init`, otherwise run the engine directly.

import type { CliContext } from "../src/cli.ts";
import { runCli } from "../src/cli.ts";
import { runBoot } from "./boot.ts";

const argv = process.argv.slice(2);

if (argv[0] === "boot") {
  runBoot(argv.slice(1)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[phoebe] ${message}`);
    process.exit(1);
  });
} else {
  const ctx: CliContext = {
    cwd: process.cwd(),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  };
  runCli(argv, ctx).then(
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
}
