// `bootCommand` dispatch contract (#75): `--help` short-circuits without
// touching `runBoot`, and everything else is forwarded to it untouched — the
// same `onUnknownFlag: "forward"` shape engine mode uses (src/commands/
// engine.ts), since boot's own argv is meant for the engine child it
// launches, not for boot itself. `createBootCommand` swaps in a fake
// `runBoot` so none of this ever touches a real container boot.

import { describe, expect, test } from "vite-plus/test";
import type { CliContext } from "../src/cli-context.ts";
import { BOOT_HELP_TEXT, BOOT_SUMMARY, createBootCommand } from "./boot-command.ts";

function fakeCtx(): CliContext & { text(): { out: string; err: string } } {
  let out = "";
  let err = "";
  return {
    cwd: process.cwd(),
    env: {},
    stdout: { write: (s: string) => void (out += s) },
    stderr: { write: (s: string) => void (err += s) },
    text: () => ({ out, err }),
  };
}

describe("bootCommand", () => {
  test("--help prints boot's own help and never calls runBoot", async () => {
    const calls: (readonly string[])[] = [];
    const command = createBootCommand({ runBoot: async (argv) => void calls.push(argv) });
    const ctx = fakeCtx();
    const code = await command.run(["--help"], ctx);
    expect(code).toBe(0);
    expect(ctx.text().out).toBe(BOOT_HELP_TEXT);
    expect(calls).toEqual([]);
  });

  test("-h is the same short-circuit as --help", async () => {
    const calls: (readonly string[])[] = [];
    const command = createBootCommand({ runBoot: async (argv) => void calls.push(argv) });
    const code = await command.run(["-h"], fakeCtx());
    expect(code).toBe(0);
    expect(calls).toEqual([]);
  });

  test("every other argument forwards to runBoot untouched, in order", async () => {
    const calls: (readonly string[])[] = [];
    const command = createBootCommand({ runBoot: async (argv) => void calls.push(argv) });
    const code = await command.run(["--run-once", "--repo", "acme/widget"], fakeCtx());
    expect(code).toBe(0);
    expect(calls).toEqual([["--run-once", "--repo", "acme/widget"]]);
  });

  test("--help still wins even mixed with other forwarded flags", async () => {
    const calls: (readonly string[])[] = [];
    const command = createBootCommand({ runBoot: async (argv) => void calls.push(argv) });
    const code = await command.run(["--dry-run", "--help"], fakeCtx());
    expect(code).toBe(0);
    expect(calls).toEqual([]);
  });

  test("a runBoot rejection propagates so runCli's dispatch reports it", async () => {
    const command = createBootCommand({
      runBoot: async () => {
        throw new Error("boom");
      },
    });
    await expect(command.run([], fakeCtx())).rejects.toThrow("boom");
  });

  test("summary is column-aligned with every other root usage line", () => {
    expect(BOOT_SUMMARY.indexOf("Container")).toBe(35);
  });
});
