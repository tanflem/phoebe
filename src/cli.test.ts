// `runCli` dispatch contract (#73): table lookup, parse, validate, run — for
// every command in the table, the unnamed default (engine mode), unknown
// command names, and the exit-code path. Each command's own argv grammar and
// behavior is tested in its own module (src/commands/*.test.ts); this file
// only proves `runCli` routes to the right one and never touches `process.*`
// itself (a fake `CliContext` is enough to drive it end to end).

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import type { CliContext } from "./cli-context.ts";
import { HELP_TEXT, runCli } from "./cli.ts";

function fakeCtx(
  overrides: Partial<CliContext> = {},
): CliContext & { text(): { out: string; err: string } } {
  let out = "";
  let err = "";
  return {
    cwd: overrides.cwd ?? process.cwd(),
    env: overrides.env ?? {},
    stdout: { write: (s: string) => void (out += s) },
    stderr: { write: (s: string) => void (err += s) },
    text: () => ({ out, err }),
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phoebe-cli-dispatch-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runCli — default (engine) entry", () => {
  test("empty argv falls to the default entry", async () => {
    const ctx = fakeCtx({ cwd: dir });
    const code = await runCli([], ctx);
    expect(code).toBe(1);
    expect(ctx.text().err).toContain("Config file not found");
  });

  test("an unrecognized command name also falls to the default entry", async () => {
    const ctx = fakeCtx({ cwd: dir });
    const code = await runCli(["frobnicate"], ctx);
    expect(code).toBe(1);
    expect(ctx.text().err).toContain("Config file not found");
  });

  test("--help with no subcommand prints the full root usage", async () => {
    const ctx = fakeCtx({ cwd: dir });
    const code = await runCli(["--help"], ctx);
    expect(code).toBe(0);
    expect(ctx.text().out).toBe(HELP_TEXT);
    expect(ctx.text().out).toContain("phoebe init [dir]");
  });
});

describe("runCli — table entries", () => {
  test("setup --help", async () => {
    const ctx = fakeCtx({ cwd: dir });
    const code = await runCli(["setup", "--help"], ctx);
    expect(code).toBe(0);
    expect(ctx.text().out).toContain("phoebe setup — interactive one-stop setup wizard");
  });

  test("init actually scaffolds (dispatched with an absolute target dir)", async () => {
    const ctx = fakeCtx({ cwd: dir });
    const target = join(dir, "scaffold");
    const code = await runCli(["init", target], ctx);
    expect(code).toBe(0);
    expect(ctx.text().out).toContain(`[phoebe] init → ${target}`);
    expect(existsSync(join(target, "phoebe.config.ts"))).toBe(true);
  });

  test("config resolve — unknown subcommand surfaces the config-resolve usage", async () => {
    const ctx = fakeCtx({ cwd: dir });
    const code = await runCli(["config", "show"], ctx);
    expect(code).toBe(1);
    expect(ctx.text().err).toContain("Usage: phoebe config resolve --json");
  });

  test("status --help", async () => {
    const ctx = fakeCtx({ cwd: dir });
    const code = await runCli(["status", "--help"], ctx);
    expect(code).toBe(0);
    expect(ctx.text().out).toContain("phoebe status — read the local runtime projection");
  });

  test("add-repo scaffolds a tenant under the dispatched cwd", async () => {
    const ctx = fakeCtx({ cwd: dir });
    const code = await runCli(["add-repo", "acme/widget"], ctx);
    expect(code).toBe(0);
    expect(ctx.text().out).toContain("add-repo acme/widget");
    expect(existsSync(join(dir, "repos", "acme", "widget", "phoebe.config.ts"))).toBe(true);
  });

  test("remove-repo without a slug exits 1 with the usage message", async () => {
    const ctx = fakeCtx({ cwd: dir });
    const code = await runCli(["remove-repo"], ctx);
    expect(code).toBe(1);
    expect(ctx.text().err).toContain("Usage: phoebe remove-repo <owner/repo>");
  });

  test("list reports no tenants for an empty deployment", async () => {
    const ctx = fakeCtx({ cwd: dir });
    const code = await runCli(["list"], ctx);
    expect(code).toBe(0);
    expect(ctx.text().out).toContain("No tenants");
  });

  test("purge without a slug exits 1 with the usage message", async () => {
    const ctx = fakeCtx({ cwd: dir });
    const code = await runCli(["purge"], ctx);
    expect(code).toBe(1);
    expect(ctx.text().err).toContain("Usage: phoebe purge <owner/repo> --yes");
  });

  test("serve --help (does not open a socket)", async () => {
    const ctx = fakeCtx({ cwd: dir });
    const code = await runCli(["serve", "--help"], ctx);
    expect(code).toBe(0);
    expect(ctx.text().out).toContain("phoebe serve — one read-only page");
  });
});

describe("runCli — exit-code path", () => {
  test("a thrown Error is reported to stderr as `[phoebe] <message>` and exits 1", async () => {
    const ctx = fakeCtx({ cwd: dir });
    const code = await runCli(["purge"], ctx);
    expect(code).toBe(1);
    expect(ctx.text().err).toBe("[phoebe] Usage: phoebe purge <owner/repo> --yes\n");
  });

  test("status reports `not-found` (not an error) with no snapshot written yet", async () => {
    const configDir = dir;
    writeFileSync(
      join(configDir, "phoebe.config.ts"),
      `export default {
        repoSlug: "acme/widget",
        repoUrl: "https://github.com/acme/widget.git",
        installCommand: "npm ci",
        checkCommand: "npm run check",
        testCommand: "npm test"
      };\n`,
    );
    const ctx = fakeCtx({ cwd: configDir });
    const code = await runCli(["status", "--json"], ctx);
    expect(code).toBe(0);
    const parsed = JSON.parse(ctx.text().out);
    expect(parsed.available).toBe(false);
    expect(parsed.error.code).toBe("not-found");
  });

  test("a successful command exits 0 without writing to stderr", async () => {
    const ctx = fakeCtx({ cwd: dir });
    const code = await runCli(["list"], ctx);
    expect(code).toBe(0);
    expect(ctx.text().err).toBe("");
  });
});
