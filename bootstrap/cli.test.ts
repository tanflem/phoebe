// The bootstrapper's table composition (#75): `boot` joins `runCli`'s one
// dispatch as a `CommandTableExtension` rather than a pre-branch in front of
// it. `bootstrap/cli.ts` itself is a side-effecting entry point (reads real
// `process.argv`, sets `process.exitCode`), so it isn't imported here —
// instead this exercises the same `runCli(argv, ctx, extension)` call it
// makes, with the exact `commands`/`helpText` it builds.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import type { CliContext } from "../src/cli-context.ts";
import { runCli } from "../src/cli.ts";
import { buildHelpText } from "../src/commands/engine.ts";
import { BOOT_HELP_TEXT, BOOT_SUMMARY, createBootCommand } from "./boot-command.ts";

function fakeCtx(cwd: string): CliContext & { text(): { out: string; err: string } } {
  let out = "";
  let err = "";
  return {
    cwd,
    env: {},
    stdout: { write: (s: string) => void (out += s) },
    stderr: { write: (s: string) => void (err += s) },
    text: () => ({ out, err }),
  };
}

function bootstrapExtension(runBoot: (argv: readonly string[]) => Promise<void>) {
  return {
    commands: { boot: createBootCommand({ runBoot }) },
    helpText: buildHelpText(`${BOOT_SUMMARY}\n`),
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phoebe-bootstrap-cli-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runCli composed with the bootstrapper's boot extension", () => {
  test("phoebe boot --help works, going through the same dispatch as every other command", async () => {
    const ctx = fakeCtx(dir);
    const code = await runCli(
      ["boot", "--help"],
      ctx,
      bootstrapExtension(async () => {
        throw new Error("runBoot should not run for --help");
      }),
    );
    expect(code).toBe(0);
    expect(ctx.text().out).toBe(BOOT_HELP_TEXT);
  });

  test("phoebe --help (no subcommand) lists boot alongside every other command", async () => {
    const ctx = fakeCtx(dir);
    const code = await runCli(
      ["--help"],
      ctx,
      bootstrapExtension(async () => {}),
    );
    expect(code).toBe(0);
    expect(ctx.text().out).toContain(BOOT_SUMMARY);
    expect(ctx.text().out).toContain("phoebe init [dir]");
    expect(ctx.text().out).toContain("phoebe status --json");
  });

  test("phoebe boot forwards its argv straight through to runBoot", async () => {
    const calls: (readonly string[])[] = [];
    const ctx = fakeCtx(dir);
    const code = await runCli(
      ["boot", "--run-once"],
      ctx,
      bootstrapExtension(async (argv) => void calls.push(argv)),
    );
    expect(code).toBe(0);
    expect(calls).toEqual([["--run-once"]]);
  });

  test("every other command still dispatches unchanged (unaffected by the extension)", async () => {
    const ctx = fakeCtx(dir);
    const code = await runCli(
      ["list"],
      ctx,
      bootstrapExtension(async () => {}),
    );
    expect(code).toBe(0);
    expect(ctx.text().out).toContain("No tenants");
  });

  test("a plain runCli call with no extension never mentions boot", async () => {
    const ctx = fakeCtx(dir);
    const code = await runCli(["--help"], ctx);
    expect(code).toBe(0);
    expect(ctx.text().out).not.toContain("boot");
  });
});
