import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { CONFIG_DEFAULTS, resolveConfig, type PhoebeUserConfig } from "./config-schema.ts";
import {
  formatResolvedConfiguration,
  loadResolvedConfiguration,
  parseBaseConfigDocument,
  resolveLayeredConfiguration,
} from "./config-resolution.ts";
import { applyEnvOverlay } from "./load-config.ts";
import { derivePaths } from "./paths.ts";

function repositoryConfig(overrides: Partial<PhoebeUserConfig> = {}): PhoebeUserConfig {
  return {
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    ...overrides,
  };
}

describe("resolveLayeredConfiguration", () => {
  test("is compatible with the existing resolver when PHOEBE_BASE_CONFIG is unset", () => {
    const repository = repositoryConfig({
      readyLabel: "repo-ready",
      promptFiles: { issue: "repo/issue.md" },
      workOrder: ["issues", "checks"],
    });
    const env = {
      PHOEBE_READY_LABEL: "env-ready",
      PHOEBE_DEFAULT_PROVIDER: "claude",
    };

    const layered = resolveLayeredConfiguration({ repository, env });
    expect(layered.config).toEqual(resolveConfig(applyEnvOverlay(repository, env)));
    expect(layered.engine).toEqual({
      source: "github",
      repo: "JesusFilm/phoebe",
      ref: "main",
    });
  });

  test("merges built-ins, base, repository, then environment with arrays replacing whole", () => {
    const resolved = resolveLayeredConfiguration({
      base: {
        readyLabel: "base-ready",
        branchPrefix: "base/",
        promptFiles: {
          issue: "base/issue.md",
          checks: "base/checks.md",
        },
        workOrder: ["research", "issues"],
        engine: { source: "github", repo: "acme/engine", ref: "base" },
      },
      repository: repositoryConfig({
        branchPrefix: "repo/",
        promptFiles: { issue: "repo/issue.md" },
        workOrder: ["checks"],
        engine: { source: "github", ref: "repo" },
      }),
      env: { PHOEBE_READY_LABEL: "env-ready" },
    });

    expect(resolved.config.readyLabel).toBe("env-ready");
    expect(resolved.config.branchPrefix).toBe("repo/");
    expect(resolved.config.promptFiles).toEqual({
      ...CONFIG_DEFAULTS.promptFiles,
      issue: "repo/issue.md",
      checks: "base/checks.md",
    });
    // paths is never a layerable field (#58): it is always derived from
    // repoSlug + the deployment data base, so tenant paths can never collide.
    expect(resolved.config.paths).toEqual(derivePaths("acme/widget"));
    expect(resolved.config.workOrder).toEqual(["checks"]);
    expect(resolved.engine).toEqual({
      source: "github",
      repo: "acme/engine",
      ref: "repo",
    });
  });

  test("honors issueSource from the repository declaration (#21)", () => {
    const resolved = resolveLayeredConfiguration({
      base: { readyLabel: "base-ready" },
      repository: repositoryConfig({
        issueSource: { repoSlug: "acme/planning", readyLabel: "triaged" },
      }),
    });
    expect(resolved.config.issueSource).toEqual({
      repoSlug: "acme/planning",
      readyLabel: "triaged",
    });
    // Unrelated to the work repo's own identity or discovery label.
    expect(resolved.config.repoSlug).toBe("acme/widget");
    expect(resolved.config.readyLabel).toBe("base-ready");
  });

  test("requires the five repository-owned fields from the repository declaration", () => {
    const repository = repositoryConfig() as Record<string, unknown>;
    delete repository.repoSlug;
    expect(() =>
      resolveLayeredConfiguration({
        base: { readyLabel: "generated" },
        repository: repository as PhoebeUserConfig,
        env: { PHOEBE_REPO_SLUG: "env/repo" },
      }),
    ).toThrow(/repository declaration.*repoSlug/i);
  });
});

describe("parseBaseConfigDocument", () => {
  const path = "/etc/phoebe/generated-base.json";

  test("accepts the supported version and optional config fields", () => {
    expect(
      parseBaseConfigDocument(
        JSON.stringify({
          schemaVersion: 1,
          config: {
            readyLabel: "managed-ready",
            engine: { source: "github", ref: "stable" },
          },
        }),
        path,
      ),
    ).toEqual({
      readyLabel: "managed-ready",
      engine: { source: "github", ref: "stable" },
    });
  });

  test.each([
    ["invalid JSON", "{", /Invalid JSON.*generated-base\.json/],
    [
      "unsupported version",
      JSON.stringify({ schemaVersion: 2, config: {} }),
      /(?=.*unsupported schemaVersion 2)(?=.*generated-base\.json)/i,
    ],
    [
      "unknown document field",
      JSON.stringify({ schemaVersion: 1, config: {}, extra: true }),
      /(?=.*unknown field)(?=.*extra)(?=.*generated-base\.json)/i,
    ],
    [
      "unknown config field",
      JSON.stringify({ schemaVersion: 1, config: { mystery: true } }),
      /(?=.*unknown field)(?=.*config\.mystery)(?=.*generated-base\.json)/i,
    ],
    [
      "repository-owned field",
      JSON.stringify({ schemaVersion: 1, config: { repoSlug: "managed/repo" } }),
      /(?=.*must not define)(?=.*repoSlug)(?=.*generated-base\.json)/i,
    ],
    [
      "unknown nested field",
      JSON.stringify({ schemaVersion: 1, config: { promptFiles: { surprise: "/tmp" } } }),
      /(?=.*unknown field)(?=.*config\.promptFiles\.surprise)(?=.*generated-base\.json)/i,
    ],
    [
      // paths is never layerable (#58): it is always derived from repoSlug +
      // the deployment data base, so tenant paths can never collide.
      "paths field",
      JSON.stringify({ schemaVersion: 1, config: { paths: { stateDir: "/managed/state" } } }),
      /(?=.*unknown field)(?=.*config\.paths)(?=.*generated-base\.json)/i,
    ],
    [
      "invalid array",
      JSON.stringify({ schemaVersion: 1, config: { workOrder: "issues" } }),
      /(?=.*config\.workOrder)(?=.*array)(?=.*generated-base\.json)/i,
    ],
    [
      "empty work order",
      JSON.stringify({ schemaVersion: 1, config: { workOrder: [] } }),
      /(?=.*WORK_ORDER must not be empty)(?=.*generated-base\.json)/i,
    ],
    [
      "unknown work kind",
      JSON.stringify({ schemaVersion: 1, config: { workOrder: ["bogus"] } }),
      /(?=.*Unknown work kind "bogus")(?=.*generated-base\.json)/i,
    ],
    [
      "invalid blockerSource",
      JSON.stringify({ schemaVersion: 1, config: { blockerSource: "bogus" } }),
      /(?=.*config\.blockerSource must be one of)(?=.*generated-base\.json)/i,
    ],
    [
      "invalid stackMode",
      JSON.stringify({ schemaVersion: 1, config: { stackMode: "bogus" } }),
      /(?=.*config\.stackMode must be one of)(?=.*generated-base\.json)/i,
    ],
    [
      // issueSource names a specific repo (#21), same as repoSlug — out of
      // place in the deployment-wide generated base.
      "issueSource field",
      JSON.stringify({
        schemaVersion: 1,
        config: { issueSource: { repoSlug: "managed/planning" } },
      }),
      /(?=.*must not define)(?=.*issueSource)(?=.*generated-base\.json)/i,
    ],
  ])("rejects %s with a path-specific error", (_name, json, expected) => {
    expect(() => parseBaseConfigDocument(json, path)).toThrow(expected);
  });
});

describe("loadResolvedConfiguration", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(): { root: string; repositoryPath: string; basePath: string } {
    const root = mkdtempSync(join(tmpdir(), "phoebe-base-config-"));
    roots.push(root);
    const repositoryPath = join(root, "phoebe.config.ts");
    const basePath = join(root, "generated-base.json");
    writeFileSync(
      repositoryPath,
      `export default ${JSON.stringify(repositoryConfig({ readyLabel: "repo-ready" }))};\n`,
    );
    writeFileSync(
      basePath,
      `${JSON.stringify({
        schemaVersion: 1,
        config: {
          branchPrefix: "managed/",
          engine: { source: "github", repo: "acme/phoebe", ref: "stable" },
        },
      })}\n`,
    );
    return { root, repositoryPath, basePath };
  }

  test("loads the absolute PHOEBE_BASE_CONFIG path and resolves engine/runtime together", async () => {
    const { repositoryPath, basePath } = fixture();
    const resolved = await loadResolvedConfiguration(repositoryPath, {
      env: { PHOEBE_BASE_CONFIG: basePath },
    });
    expect(resolved.config.branchPrefix).toBe("managed/");
    expect(resolved.config.readyLabel).toBe("repo-ready");
    expect(resolved.engine).toEqual({
      source: "github",
      repo: "acme/phoebe",
      ref: "stable",
    });
  });

  test("rejects relative, missing, and unreadable base paths before resolution", async () => {
    const { root, repositoryPath, basePath } = fixture();
    await expect(
      loadResolvedConfiguration(repositoryPath, {
        env: { PHOEBE_BASE_CONFIG: "relative/generated-base.json" },
      }),
    ).rejects.toThrow(/PHOEBE_BASE_CONFIG.*absolute/i);
    await expect(
      loadResolvedConfiguration(repositoryPath, {
        env: { PHOEBE_BASE_CONFIG: "" },
      }),
    ).rejects.toThrow(/PHOEBE_BASE_CONFIG.*absolute/i);
    await expect(
      loadResolvedConfiguration(repositoryPath, {
        env: { PHOEBE_BASE_CONFIG: join(root, "missing.json") },
      }),
    ).rejects.toThrow(/Failed to read PHOEBE_BASE_CONFIG.*missing\.json/i);
    rmSync(basePath);
    await expect(
      loadResolvedConfiguration(repositoryPath, {
        env: { PHOEBE_BASE_CONFIG: basePath },
      }),
    ).rejects.toThrow(/Failed to read PHOEBE_BASE_CONFIG.*generated-base\.json/i);
  });

  test("rejects malformed UTF-8 instead of decoding replacement characters", async () => {
    const { repositoryPath, basePath } = fixture();
    const prefix = Buffer.from(`{"schemaVersion":1,"config":{"readyLabel":"`);
    const malformed = Buffer.from([0xc3, 0x28]);
    const suffix = Buffer.from(`"}}`);
    writeFileSync(basePath, Buffer.concat([prefix, malformed, suffix]));

    await expect(
      loadResolvedConfiguration(repositoryPath, {
        env: { PHOEBE_BASE_CONFIG: basePath },
      }),
    ).rejects.toThrow(/(?=.*UTF-8)(?=.*generated-base\.json)/i);
  });

  test("formats deterministic, versioned, non-secret JSON", async () => {
    const { repositoryPath, basePath } = fixture();
    const resolved = await loadResolvedConfiguration(repositoryPath, {
      env: {
        PHOEBE_BASE_CONFIG: basePath,
        GH_TOKEN: "must-not-leak",
        OPENAI_KEY: "also-must-not-leak",
      },
    });
    const first = formatResolvedConfiguration(resolved);
    const second = formatResolvedConfiguration(resolved);
    expect(first).toBe(second);
    expect(JSON.parse(first)).toEqual({
      schemaVersion: 1,
      config: {
        ...resolved.config,
        engine: resolved.engine,
      },
    });
    expect(first).not.toContain("must-not-leak");
  });
});
