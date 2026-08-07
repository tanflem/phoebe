// Argv parsing contract for the `phoebe` bin: `--config`/`-c` (with space or
// `=`), `--help`/`-h`, and everything else forwarded to `runEngine` for the
// engine to interpret. Init flags (`--workspace` / `--tenant`) are mutually
// exclusive profile selectors. The full CLI is exercised at the smoke-test
// level in dev; here we just pin the surface.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  BOOTSTRAP_RESOLVED_CONFIG_ENV,
  formatTenantListing,
  loadEngineConfiguration,
  parseCliArgs,
  parseConfigResolveArgs,
  parseInitArgs,
  parseStatusArgs,
  runConfigResolve,
} from "./cli.ts";
import { parseStatusSnapshot, type StatusSnapshot } from "./status-contract.ts";
import type { TenantListing } from "./tenant-commands.ts";

describe("parseCliArgs", () => {
  test("returns empty parsed state for empty argv", () => {
    expect(parseCliArgs([])).toEqual({ configPath: undefined, help: false, forward: [] });
  });

  test("forwards engine flags untouched", () => {
    const parsed = parseCliArgs(["--run-once", "--dry-run"]);
    expect(parsed.forward).toEqual(["--run-once", "--dry-run"]);
    expect(parsed.configPath).toBeUndefined();
  });

  test("accepts --config <path>", () => {
    expect(parseCliArgs(["--config", "cfg.ts"])).toEqual({
      configPath: "cfg.ts",
      help: false,
      forward: [],
    });
  });

  test("accepts -c <path>", () => {
    expect(parseCliArgs(["-c", "cfg.ts"])).toEqual({
      configPath: "cfg.ts",
      help: false,
      forward: [],
    });
  });

  test("accepts --config=<path>", () => {
    expect(parseCliArgs(["--config=cfg.ts"])).toEqual({
      configPath: "cfg.ts",
      help: false,
      forward: [],
    });
  });

  test("throws when --config lacks a following argument", () => {
    expect(() => parseCliArgs(["--config"])).toThrow(/requires a path/);
    expect(() => parseCliArgs(["-c"])).toThrow(/requires a path/);
  });

  test("--help and -h set help without swallowing other args", () => {
    expect(parseCliArgs(["--help", "--run-once"])).toEqual({
      configPath: undefined,
      help: true,
      forward: ["--run-once"],
    });
    expect(parseCliArgs(["-h"]).help).toBe(true);
  });

  test("mixes --config with forwarded engine flags", () => {
    expect(parseCliArgs(["--config", "cfg.ts", "--run-once", "--dry-run"])).toEqual({
      configPath: "cfg.ts",
      help: false,
      forward: ["--run-once", "--dry-run"],
    });
  });
});

describe("parseInitArgs", () => {
  test("defaults to current directory and flat profile when no args given", () => {
    expect(parseInitArgs([])).toEqual({
      targetDir: ".",
      help: false,
      profile: "flat",
      withPrompts: false,
    });
  });

  test("accepts a positional target directory (flat)", () => {
    expect(parseInitArgs(["./my-agent"])).toEqual({
      targetDir: "./my-agent",
      help: false,
      profile: "flat",
      withPrompts: false,
    });
  });

  test("accepts --workspace with an optional directory", () => {
    expect(parseInitArgs(["--workspace"])).toEqual({
      targetDir: ".",
      help: false,
      profile: "workspace",
      withPrompts: false,
    });
    expect(parseInitArgs(["--workspace", "./ws"])).toEqual({
      targetDir: "./ws",
      help: false,
      profile: "workspace",
      withPrompts: false,
    });
    expect(parseInitArgs(["./ws", "--workspace"])).toEqual({
      targetDir: "./ws",
      help: false,
      profile: "workspace",
      withPrompts: false,
    });
  });

  test("accepts --tenant with an optional directory", () => {
    expect(parseInitArgs(["--tenant", "./child"])).toEqual({
      targetDir: "./child",
      help: false,
      profile: "tenant",
      withPrompts: false,
    });
  });

  test("accepts tenant overrides --slug / --url / --with-prompts", () => {
    expect(
      parseInitArgs([
        "--tenant",
        "./child",
        "--slug",
        "acme/widget",
        "--url",
        "git@example.com:acme/widget.git",
        "--with-prompts",
      ]),
    ).toEqual({
      targetDir: "./child",
      help: false,
      profile: "tenant",
      repoSlug: "acme/widget",
      repoUrl: "git@example.com:acme/widget.git",
      withPrompts: true,
    });
    expect(parseInitArgs(["--tenant", "--slug=acme/x", "--url=https://e/x.git"])).toEqual({
      targetDir: ".",
      help: false,
      profile: "tenant",
      repoSlug: "acme/x",
      repoUrl: "https://e/x.git",
      withPrompts: false,
    });
  });

  test("rejects tenant-only flags without --tenant", () => {
    expect(() => parseInitArgs(["--slug", "a/b"])).toThrow(/only valid with/);
    expect(() => parseInitArgs(["--workspace", "--with-prompts"])).toThrow(/only valid with/);
  });

  test("--workspace and --tenant are mutually exclusive", () => {
    expect(() => parseInitArgs(["--workspace", "--tenant"])).toThrow(/mutually exclusive/);
    expect(() => parseInitArgs(["--tenant", "--workspace", "./x"])).toThrow(/mutually exclusive/);
  });

  test("--help / -h set help without requiring a directory", () => {
    expect(parseInitArgs(["--help"])).toEqual({
      targetDir: ".",
      help: true,
      profile: "flat",
      withPrompts: false,
    });
    expect(parseInitArgs(["-h"]).help).toBe(true);
  });

  test("rejects unknown flags", () => {
    expect(() => parseInitArgs(["--forcee"])).toThrow(/Unknown flag/);
  });

  test("rejects a second positional argument", () => {
    expect(() => parseInitArgs(["a", "b"])).toThrow(/at most one target directory/);
  });
});

describe("phoebe config resolve --json", () => {
  test("parses the required JSON form with an optional repository config path", () => {
    expect(parseConfigResolveArgs(["resolve", "--json", "--config", "other.ts"])).toEqual({
      configPath: "other.ts",
    });
    expect(parseConfigResolveArgs(["resolve", "--json"])).toEqual({
      configPath: undefined,
    });
  });

  test("rejects missing --json, unknown subcommands, and unrelated flags", () => {
    expect(() => parseConfigResolveArgs(["resolve"])).toThrow(/requires --json/);
    expect(() => parseConfigResolveArgs(["show", "--json"])).toThrow(/config resolve/);
    expect(() => parseConfigResolveArgs(["resolve", "--json", "--dry-run"])).toThrow(
      /Unknown flag/,
    );
  });

  test("emits the shared canonical resolution without starting the engine", async () => {
    const root = mkdtempSync(join(tmpdir(), "phoebe-config-resolve-cli-"));
    try {
      writeFileSync(
        join(root, "phoebe.config.ts"),
        `export default {
          repoSlug: "acme/widget",
          repoUrl: "https://github.com/acme/widget.git",
          installCommand: "npm ci",
          checkCommand: "npm run check",
          testCommand: "npm test",
          readyLabel: "repository-ready"
        };\n`,
      );
      const basePath = join(root, "base.json");
      writeFileSync(
        basePath,
        `${JSON.stringify({
          schemaVersion: 1,
          config: {
            branchPrefix: "managed/",
            engine: { source: "github", ref: "stable", repo: "acme/phoebe" },
          },
        })}\n`,
      );

      const output = await runConfigResolve(["resolve", "--json"], {
        cwd: root,
        env: { PHOEBE_BASE_CONFIG: basePath, PHOEBE_READY_LABEL: "environment-ready" },
      });
      const parsed = JSON.parse(output);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.config.branchPrefix).toBe("managed/");
      expect(parsed.config.readyLabel).toBe("environment-ready");
      expect(parsed.config.engine).toEqual({
        source: "github",
        repo: "acme/phoebe",
        ref: "stable",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses boot's resolved snapshot if authored files change before the engine reads them", async () => {
    const root = mkdtempSync(join(tmpdir(), "phoebe-config-snapshot-cli-"));
    try {
      const repositoryPath = join(root, "phoebe.config.ts");
      writeFileSync(
        repositoryPath,
        `export default {
          repoSlug: "acme/widget",
          repoUrl: "https://github.com/acme/widget.git",
          installCommand: "npm ci",
          checkCommand: "npm run check",
          testCommand: "npm test"
        };\n`,
      );
      const basePath = join(root, "base.json");
      writeFileSync(
        basePath,
        `${JSON.stringify({
          schemaVersion: 1,
          config: {
            branchPrefix: "before/",
            engine: { source: "github", ref: "before" },
          },
        })}\n`,
      );
      const env = { PHOEBE_BASE_CONFIG: basePath };
      const snapshot = await runConfigResolve(["resolve", "--json"], { cwd: root, env });

      writeFileSync(
        basePath,
        `${JSON.stringify({
          schemaVersion: 1,
          config: {
            branchPrefix: "after/",
            engine: { source: "github", ref: "after" },
          },
        })}\n`,
      );

      const resolved = await loadEngineConfiguration(repositoryPath, {
        ...env,
        [BOOTSTRAP_RESOLVED_CONFIG_ENV]: snapshot,
      });
      expect(resolved.config.branchPrefix).toBe("before/");
      expect(resolved.engine).toMatchObject({ source: "github", ref: "before" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const fixtureRoot = join(import.meta.dirname, "..", "contracts", "fixtures", "status-v2");

function fixtureSnapshot(name: string): StatusSnapshot {
  return parseStatusSnapshot(JSON.parse(readFileSync(join(fixtureRoot, `${name}.json`), "utf8")));
}

function listingWithStatus(
  status: TenantListing["status"],
  overrides: Partial<TenantListing> = {},
): TenantListing {
  return {
    slug: "acme/widget",
    configValid: true,
    envPresent: true,
    retainedData: true,
    status,
    queue: [],
    ...overrides,
  };
}

describe("formatTenantListing", () => {
  test("running with activeWork renders `working <kind> #<id>`", () => {
    const listing = listingWithStatus({ available: true, status: fixtureSnapshot("running") });
    expect(formatTenantListing(listing)).toContain("working issues #42");
  });

  test("starting / selecting / idle all render idle", () => {
    const idle = listingWithStatus({ available: true, status: fixtureSnapshot("idle") });
    expect(formatTenantListing(idle)).toContain("idle");

    const starting = listingWithStatus({
      available: true,
      status: fixtureSnapshot("crash-loop-fallback"),
    });
    expect(starting.status).toMatchObject({ status: { lifecycle: { state: "starting" } } });
    expect(formatTenantListing(starting)).toContain("idle");
  });

  test("draining renders `draining`", () => {
    const listing = listingWithStatus({
      available: true,
      status: fixtureSnapshot("graceful-drain"),
    });
    expect(formatTenantListing(listing)).toContain("draining");
  });

  test("stopped renders `stopped`", () => {
    const listing = listingWithStatus({ available: true, status: fixtureSnapshot("stopped") });
    expect(formatTenantListing(listing)).toContain("stopped");
  });

  test("failed renders `failed — <lifecycle.reason>`", () => {
    const listing = listingWithStatus({ available: true, status: fixtureSnapshot("failed") });
    expect(formatTenantListing(listing)).toContain(
      "failed — State volume unwritable after 3 retries.",
    );
  });

  test("unavailable/not-found renders `no status`", () => {
    const listing = listingWithStatus({
      available: false,
      reason: "not-found",
      message: "No status-v2 snapshot exists.",
    });
    expect(formatTenantListing(listing)).toContain("no status");
  });

  test("unavailable/corrupt renders `unreadable status`", () => {
    const listing = listingWithStatus({
      available: false,
      reason: "corrupt",
      message: "Could not decode status-v2.",
    });
    expect(formatTenantListing(listing)).toContain("unreadable status");
  });

  test("a capability-error snapshot renders the received version, not a silent `no status`", () => {
    const listing = listingWithStatus({
      available: false,
      reason: "unsupported-version",
      receivedVersion: "status-v3",
      message: "This runtime supports status-v2 but received status-v3.",
    });
    expect(formatTenantListing(listing)).toContain("status from a newer engine (status-v3)");
  });

  test("a capability error still lists with its other health columns intact", () => {
    const listing = listingWithStatus(
      {
        available: false,
        reason: "unsupported-version",
        receivedVersion: "status-v3",
        message: "This runtime supports status-v2 but received status-v3.",
      },
      { configValid: false, envPresent: true, retainedData: false },
    );
    const rendered = formatTenantListing(listing);
    expect(rendered).toContain("✗ config");
    expect(rendered).toContain("✓ env");
    expect(rendered).toContain("✗ data");
    expect(rendered).toContain("status from a newer engine (status-v3)");
  });

  test("no status (hold dir, no slug resolved) renders `no status`", () => {
    const listing = listingWithStatus(null);
    expect(formatTenantListing(listing)).toContain("no status");
  });
});

describe("parseStatusArgs", () => {
  test("requires the machine-readable projection and accepts a config path", () => {
    expect(parseStatusArgs(["--json", "--config", "cfg.ts"])).toEqual({
      configPath: "cfg.ts",
      help: false,
    });
  });

  test("allows help without --json", () => {
    expect(parseStatusArgs(["--help"])).toEqual({
      configPath: undefined,
      help: true,
    });
  });

  test("rejects missing --json and unknown arguments", () => {
    expect(() => parseStatusArgs([])).toThrow(/requires --json/);
    expect(() => parseStatusArgs(["--json", "--events"])).toThrow(/Unknown status argument/);
  });
});
