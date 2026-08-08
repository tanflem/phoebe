// Tests for the layered/filesystem side of the config seam: `resolveConfiguration`
// merging built-ins < generated base < repository < environment, and
// `loadConfiguration` reading both authored layers off disk. Exercised only
// through src/config/index.ts (#55) — the roster, `parseBaseConfigDocument`,
// and `applyEnvOverlay` are implementation.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  formatResolvedConfiguration,
  loadConfiguration,
  parseResolvedConfigurationSnapshot,
  resolveConfiguration,
  type PhoebeUserConfig,
} from "./config/index.ts";
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

describe("resolveConfiguration: layering", () => {
  test("merges built-ins, base, repository, then environment with arrays replacing whole", () => {
    const resolved = resolveConfiguration({
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
      issue: "repo/issue.md",
      conflict: "prompts/conflict-prompt.md",
      checks: "base/checks.md",
      reviews: "prompts/reviews-prompt.md",
      research: "prompts/research-prompt.md",
    });
    // paths is never a layerable field (#58): it is always derived from
    // repoSlug + the deployment data base, so tenant paths can never collide.
    expect(resolved.config.paths).toEqual(derivePaths("acme/widget"));
    expect(resolved.config.workOrder).toEqual(["checks"]);
    expect(resolved.engine).toEqual({ source: "github", repo: "acme/engine", ref: "repo" });
  });

  test("honors issueSource from the repository declaration (#21)", () => {
    const resolved = resolveConfiguration({
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
      resolveConfiguration({
        base: { readyLabel: "generated" },
        repository: repository as PhoebeUserConfig,
        env: { PHOEBE_REPO_SLUG: "env/repo" },
      }),
    ).toThrow(/repository declaration.*repoSlug/i);
  });
});

describe("loadConfiguration", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(
    baseConfig?: Record<string, unknown>,
    repositoryOverrides: Partial<PhoebeUserConfig> = { readyLabel: "repo-ready" },
  ): {
    root: string;
    repositoryPath: string;
    basePath: string;
  } {
    const root = mkdtempSync(join(tmpdir(), "phoebe-base-config-"));
    roots.push(root);
    const repositoryPath = join(root, "phoebe.config.ts");
    const basePath = join(root, "generated-base.json");
    writeFileSync(
      repositoryPath,
      `export default ${JSON.stringify(repositoryConfig(repositoryOverrides))};\n`,
    );
    writeFileSync(
      basePath,
      `${JSON.stringify({
        schemaVersion: 1,
        config: baseConfig ?? {
          branchPrefix: "managed/",
          engine: { source: "github", repo: "acme/phoebe", ref: "stable" },
        },
      })}\n`,
    );
    return { root, repositoryPath, basePath };
  }

  test("loads the absolute PHOEBE_BASE_CONFIG path and resolves engine/runtime together", async () => {
    const { repositoryPath, basePath } = fixture();
    const resolved = await loadConfiguration({
      repositoryPath,
      env: { PHOEBE_BASE_CONFIG: basePath },
    });
    expect(resolved.config.branchPrefix).toBe("managed/");
    expect(resolved.config.readyLabel).toBe("repo-ready");
    expect(resolved.engine).toEqual({ source: "github", repo: "acme/phoebe", ref: "stable" });
  });

  test("rejects relative, missing, and unreadable base paths before resolution", async () => {
    const { root, repositoryPath, basePath } = fixture();
    await expect(
      loadConfiguration({
        repositoryPath,
        env: { PHOEBE_BASE_CONFIG: "relative/generated-base.json" },
      }),
    ).rejects.toThrow(/PHOEBE_BASE_CONFIG.*absolute/i);
    await expect(
      loadConfiguration({ repositoryPath, env: { PHOEBE_BASE_CONFIG: "" } }),
    ).rejects.toThrow(/PHOEBE_BASE_CONFIG.*absolute/i);
    await expect(
      loadConfiguration({
        repositoryPath,
        env: { PHOEBE_BASE_CONFIG: join(root, "missing.json") },
      }),
    ).rejects.toThrow(/Failed to read PHOEBE_BASE_CONFIG.*missing\.json/i);
    rmSync(basePath);
    await expect(
      loadConfiguration({ repositoryPath, env: { PHOEBE_BASE_CONFIG: basePath } }),
    ).rejects.toThrow(/Failed to read PHOEBE_BASE_CONFIG.*generated-base\.json/i);
  });

  test("rejects malformed UTF-8 instead of decoding replacement characters", async () => {
    const { repositoryPath, basePath } = fixture();
    const prefix = Buffer.from(`{"schemaVersion":1,"config":{"readyLabel":"`);
    const malformed = Buffer.from([0xc3, 0x28]);
    const suffix = Buffer.from(`"}}`);
    writeFileSync(basePath, Buffer.concat([prefix, malformed, suffix]));

    await expect(
      loadConfiguration({ repositoryPath, env: { PHOEBE_BASE_CONFIG: basePath } }),
    ).rejects.toThrow(/(?=.*UTF-8)(?=.*generated-base\.json)/i);
  });

  test("formats deterministic, versioned, non-secret JSON", async () => {
    const { repositoryPath, basePath } = fixture();
    const resolved = await loadConfiguration({
      repositoryPath,
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
      config: { ...resolved.config, engine: resolved.engine },
    });
    expect(first).not.toContain("must-not-leak");
  });

  describe("rejects a malformed generated base document with a path-specific error", () => {
    test.each([
      ["invalid JSON", undefined, /Invalid JSON.*generated-base\.json/, true],
      [
        "unsupported version",
        { schemaVersion: 2, config: {} },
        /(?=.*unsupported schemaVersion 2)(?=.*generated-base\.json)/i,
        false,
      ],
      [
        "unknown document field",
        { schemaVersion: 1, config: {}, extra: true },
        /(?=.*unknown field)(?=.*extra)(?=.*generated-base\.json)/i,
        false,
      ],
      [
        "unknown config field",
        { schemaVersion: 1, config: { mystery: true } },
        /(?=.*unknown field)(?=.*config\.mystery)(?=.*generated-base\.json)/i,
        false,
      ],
      [
        "repository-owned field",
        { schemaVersion: 1, config: { repoSlug: "managed/repo" } },
        /(?=.*must not define)(?=.*repoSlug)(?=.*generated-base\.json)/i,
        false,
      ],
      [
        "workspace field (#55: joins REPOSITORY_OWNED_FIELDS)",
        { schemaVersion: 1, config: { workspace: { depth: 2 } } },
        /(?=.*must not define)(?=.*workspace)(?=.*generated-base\.json)/i,
        false,
      ],
      [
        "configDir field (#55: joins REPOSITORY_OWNED_FIELDS)",
        { schemaVersion: 1, config: { configDir: ".phoebe" } },
        /(?=.*must not define)(?=.*configDir)(?=.*generated-base\.json)/i,
        false,
      ],
      [
        "unknown nested field",
        { schemaVersion: 1, config: { promptFiles: { surprise: "/tmp" } } },
        /(?=.*unknown field)(?=.*config\.promptFiles\.surprise)(?=.*generated-base\.json)/i,
        false,
      ],
      [
        // paths is never layerable (#58): it is always derived from repoSlug +
        // the deployment data base, so tenant paths can never collide.
        "paths field",
        { schemaVersion: 1, config: { paths: { stateDir: "/managed/state" } } },
        /(?=.*unknown field)(?=.*config\.paths)(?=.*generated-base\.json)/i,
        false,
      ],
      [
        "invalid array",
        { schemaVersion: 1, config: { workOrder: "issues" } },
        /(?=.*config\.workOrder)(?=.*array)(?=.*generated-base\.json)/i,
        false,
      ],
      [
        "empty work order",
        { schemaVersion: 1, config: { workOrder: [] } },
        /(?=.*WORK_ORDER must not be empty)(?=.*generated-base\.json)/i,
        false,
      ],
      [
        "unknown work kind",
        { schemaVersion: 1, config: { workOrder: ["bogus"] } },
        /(?=.*Unknown work kind "bogus")(?=.*generated-base\.json)/i,
        false,
      ],
      [
        "invalid blockerSource",
        { schemaVersion: 1, config: { blockerSource: "bogus" } },
        /(?=.*config\.blockerSource must be one of)(?=.*generated-base\.json)/i,
        false,
      ],
      [
        "invalid stackMode",
        { schemaVersion: 1, config: { stackMode: "bogus" } },
        /(?=.*config\.stackMode must be one of)(?=.*generated-base\.json)/i,
        false,
      ],
      [
        "invalid prBaseScope",
        { schemaVersion: 1, config: { prBaseScope: "bogus" } },
        /(?=.*config\.prBaseScope must be)(?=.*generated-base\.json)/i,
        false,
      ],
      [
        "non-array prAuthors",
        { schemaVersion: 1, config: { prAuthors: "octocat" } },
        /(?=.*config\.prAuthors must be an array of strings)(?=.*generated-base\.json)/i,
        false,
      ],
      [
        "non-numeric runTimeoutMs",
        { schemaVersion: 1, config: { runTimeoutMs: "60000" } },
        /(?=.*config\.runTimeoutMs must be a number)(?=.*generated-base\.json)/i,
        false,
      ],
      [
        "malformed engine field",
        { schemaVersion: 1, config: { engine: { source: "bogus" } } },
        /(?=.*config\.engine)(?=.*generated-base\.json)/i,
        false,
      ],
      [
        "malformed blockedByPattern",
        { schemaVersion: 1, config: { blockedByPattern: String.raw`no capture group` } },
        /(?=.*capture group 1)(?=.*generated-base\.json)/i,
        false,
      ],
      [
        // issueSource names a specific repo (#21), same as repoSlug — out of
        // place in the deployment-wide generated base.
        "issueSource field",
        { schemaVersion: 1, config: { issueSource: { repoSlug: "managed/planning" } } },
        /(?=.*must not define)(?=.*issueSource)(?=.*generated-base\.json)/i,
        false,
      ],
    ] as const)("%s", async (_name, body, expected, invalidJson) => {
      const { repositoryPath, basePath } = fixture();
      writeFileSync(basePath, invalidJson ? "{" : `${JSON.stringify(body)}\n`);
      await expect(
        loadConfiguration({ repositoryPath, env: { PHOEBE_BASE_CONFIG: basePath } }),
      ).rejects.toThrow(expected);
    });
  });

  // #55: the roster's `baseAllowed` column decides, per field, whether the
  // generated deployment-wide base document may set it. This is the test #36
  // needed — every `baseAllowed: true` field is actually accepted, and every
  // repository-owned field is actually rejected.
  test("accepts every baseAllowed field in one base document", async () => {
    // No repository readyLabel override — the repository layer would otherwise
    // shadow the base's, and this test is about what the base can set.
    const { repositoryPath, basePath } = fixture(undefined, {});
    writeFileSync(
      basePath,
      `${JSON.stringify({
        schemaVersion: 1,
        config: {
          engine: { source: "github", repo: "acme/engine", ref: "stable" },
          defaultBranch: "trunk",
          branchPrefix: "managed/",
          readyLabel: "managed-ready",
          researchLabel: "managed-research",
          processingLabel: "managed-processing",
          prScope: "all",
          prAuthors: ["octocat"],
          prBaseScope: "all",
          draftPrs: "include",
          prOptOutLabel: "managed-opt-out",
          readyCommand: "make ready",
          blockedByPattern: String.raw`Blocked by\s+#(\d+)`,
          blockerSource: "both",
          stackMode: "native",
          reviewsSuccessHeading: "## managed heading",
          promptFiles: { issue: "managed/issue.md" },
          workOrder: ["issues"],
          defaultProvider: "claude",
          defaultModels: { claude: "managed-model" },
          providerEnv: { claude: "MANAGED_CLAUDE_KEY" },
          runTimeoutMs: 60_000,
          maxUnitTimeouts: 5,
          maxUnitAttempts: 2,
          leaseTtlMs: 120_000,
        },
      })}\n`,
    );
    const resolved = await loadConfiguration({
      repositoryPath,
      env: { PHOEBE_BASE_CONFIG: basePath },
    });
    expect(resolved.engine).toEqual({ source: "github", repo: "acme/engine", ref: "stable" });
    expect(resolved.config).toMatchObject({
      defaultBranch: "trunk",
      branchPrefix: "managed/",
      readyLabel: "managed-ready",
      researchLabel: "managed-research",
      processingLabel: "managed-processing",
      prScope: "all",
      prAuthors: ["octocat"],
      prBaseScope: "all",
      draftPrs: "include",
      prOptOutLabel: "managed-opt-out",
      readyCommand: "make ready",
      blockerSource: "both",
      stackMode: "native",
      reviewsSuccessHeading: "## managed heading",
      workOrder: ["issues"],
      defaultProvider: "claude",
      runTimeoutMs: 60_000,
      maxUnitTimeouts: 5,
      maxUnitAttempts: 2,
      leaseTtlMs: 120_000,
    });
    expect(resolved.config.promptFiles.issue).toBe("managed/issue.md");
    expect(resolved.config.defaultModels.claude).toBe("managed-model");
    expect(resolved.config.providerEnv.claude).toBe("MANAGED_CLAUDE_KEY");
  });

  test.each([
    "repoSlug",
    "repoUrl",
    "installCommand",
    "checkCommand",
    "testCommand",
    "issueSource",
    "workspace",
    "configDir",
  ])("rejects the repository-owned field %s in a base document", async (field) => {
    const { repositoryPath, basePath } = fixture();
    const value = field === "issueSource" ? { repoSlug: "x/y" } : field === "workspace" ? {} : "x";
    writeFileSync(
      basePath,
      `${JSON.stringify({ schemaVersion: 1, config: { [field]: value } })}\n`,
    );
    await expect(
      loadConfiguration({ repositoryPath, env: { PHOEBE_BASE_CONFIG: basePath } }),
    ).rejects.toThrow(new RegExp(`must not define.*${field}`, "i"));
  });
});

describe("parseResolvedConfigurationSnapshot", () => {
  // #37: a boot-supervised child parses boot's snapshot; a directly-invoked
  // engine resolves the authored files itself. Both must thread the same
  // `PHOEBE_DATA_DIR`-derived data base into resolution, or the two entry
  // points derive different `config.paths` for identical environments.
  test("matches direct resolution's paths for a non-default data base", () => {
    const repository = repositoryConfig();
    const direct = resolveConfiguration({ repository, dataBase: "/custom/data" });
    const snapshot = formatResolvedConfiguration(direct);

    const fromSnapshot = parseResolvedConfigurationSnapshot(snapshot, { dataBase: "/custom/data" });

    expect(fromSnapshot.config.paths).toEqual(direct.config.paths);
    expect(fromSnapshot.config.paths).toEqual(derivePaths("acme/widget", "/custom/data"));
  });

  test("defaults paths to the default data base when no override is given", () => {
    const repository = repositoryConfig();
    const direct = resolveConfiguration({ repository });
    const snapshot = formatResolvedConfiguration(direct);

    const fromSnapshot = parseResolvedConfigurationSnapshot(snapshot);

    expect(fromSnapshot.config.paths).toEqual(direct.config.paths);
    expect(fromSnapshot.config.paths).toEqual(derivePaths("acme/widget"));
  });
});
