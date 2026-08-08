// `phoebe config resolve --json` contract (#73) — moved verbatim from
// src/cli.test.ts when this command relocated to its own module.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { BOOTSTRAP_RESOLVED_CONFIG_ENV } from "../config/index.ts";
import { loadEngineConfiguration } from "./engine.ts";
import { parseConfigResolveArgs, runConfigResolve } from "./config-resolve.ts";

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
