// Contract tests for `resolveConfig` / `validateUserConfig`: five required
// fields, engine defaults for the rest, and a shallow merge for the four
// nested records so a consumer can override one prompt file or one provider's
// model without repeating the others.

import { describe, expect, test } from "vite-plus/test";
import {
  CONFIG_DEFAULTS,
  PROVIDER_NAMES,
  resolveConfig,
  validateUserConfig,
  type PhoebeUserConfig,
} from "./config-schema.ts";

function minimalUserConfig(overrides: Partial<PhoebeUserConfig> = {}): PhoebeUserConfig {
  return {
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    ...overrides,
  };
}

describe("validateUserConfig", () => {
  test("accepts a minimal five-field config", () => {
    expect(() => validateUserConfig(minimalUserConfig())).not.toThrow();
  });

  test.each([
    ["repoSlug"],
    ["repoUrl"],
    ["installCommand"],
    ["checkCommand"],
    ["testCommand"],
  ] as const)("rejects when %s is missing", (key) => {
    const config = { ...minimalUserConfig() } as Record<string, unknown>;
    delete config[key];
    expect(() => validateUserConfig(config as PhoebeUserConfig)).toThrow(
      new RegExp(`missing required field.*${key}`, "i"),
    );
  });

  test("rejects blank required strings the same as missing ones", () => {
    expect(() => validateUserConfig(minimalUserConfig({ repoSlug: "   " }))).toThrow(/repoSlug/);
  });

  test("lists every missing required field in one error", () => {
    const config = {
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
    } as PhoebeUserConfig;
    expect(() => validateUserConfig(config)).toThrow(/installCommand.*checkCommand.*testCommand/);
  });

  test("rejects a blockedByPattern that is not a valid regex", () => {
    expect(() =>
      validateUserConfig(minimalUserConfig({ blockedByPattern: "Blocked by [" })),
    ).toThrow(/blockedByPattern/);
  });

  test("rejects a blockedByPattern that is valid but has no capture group", () => {
    // parseBlockedBy reads match[1]; a pattern without a group would silently
    // yield NaN blocker numbers.
    expect(() =>
      validateUserConfig(minimalUserConfig({ blockedByPattern: String.raw`Blocked by #\d+` })),
    ).toThrow(/capture group 1/);
  });

  test("rejects a blockedByPattern whose only groups are non-capturing", () => {
    expect(() =>
      validateUserConfig(minimalUserConfig({ blockedByPattern: String.raw`(?:Blocked by )#\d+` })),
    ).toThrow(/capture group 1/);
  });

  test("accepts a pattern that uses non-capturing groups plus a real capture group", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({ blockedByPattern: String.raw`(?:Blocked by|Depends on)\s+#(\d+)` }),
      ),
    ).not.toThrow();
  });

  test("accepts an omitted issueSource", () => {
    expect(() => validateUserConfig(minimalUserConfig())).not.toThrow();
  });

  test("accepts issueSource with just repoSlug", () => {
    expect(() =>
      validateUserConfig(minimalUserConfig({ issueSource: { repoSlug: "acme/planning" } })),
    ).not.toThrow();
  });

  test("accepts issueSource with repoSlug and readyLabel", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({
          issueSource: { repoSlug: "acme/planning", readyLabel: "triaged" },
        }),
      ),
    ).not.toThrow();
  });

  test("rejects issueSource with an empty repoSlug", () => {
    expect(() =>
      validateUserConfig(minimalUserConfig({ issueSource: { repoSlug: "  " } })),
    ).toThrow(/issueSource\.repoSlug/);
  });

  test("rejects a non-object issueSource", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({
          issueSource: "acme/planning" as unknown as PhoebeUserConfig["issueSource"],
        }),
      ),
    ).toThrow(/issueSource must be an object/);
  });

  test("rejects issueSource with unknown fields", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({
          issueSource: {
            repoSlug: "acme/planning",
            processingLabel: "nope",
          } as unknown as PhoebeUserConfig["issueSource"],
        }),
      ),
    ).toThrow(/issueSource has unknown field/);
  });

  test("rejects a non-string issueSource.readyLabel", () => {
    expect(() =>
      validateUserConfig(
        minimalUserConfig({
          issueSource: { repoSlug: "acme/planning", readyLabel: 7 as unknown as string },
        }),
      ),
    ).toThrow(/issueSource\.readyLabel/);
  });

  test("accepts a workspace block with omitted depth (bootstrap defaults to 1)", () => {
    expect(() => validateUserConfig(minimalUserConfig({ workspace: {} }))).not.toThrow();
  });

  test("accepts a workspace block with an integer depth ≥ 1", () => {
    expect(() => validateUserConfig(minimalUserConfig({ workspace: { depth: 1 } }))).not.toThrow();
    expect(() => validateUserConfig(minimalUserConfig({ workspace: { depth: 3 } }))).not.toThrow();
  });

  test("rejects workspace.depth < 1", () => {
    expect(() => validateUserConfig(minimalUserConfig({ workspace: { depth: 0 } }))).toThrow(
      /workspace\.depth.*integer ≥ 1/i,
    );
    expect(() => validateUserConfig(minimalUserConfig({ workspace: { depth: -1 } }))).toThrow(
      /workspace\.depth/i,
    );
  });

  test("rejects non-integer workspace.depth", () => {
    expect(() => validateUserConfig(minimalUserConfig({ workspace: { depth: 1.5 } }))).toThrow(
      /workspace\.depth/i,
    );
  });
});

describe("resolveConfig", () => {
  test("fills every optional field from CONFIG_DEFAULTS", () => {
    const resolved = resolveConfig(minimalUserConfig());
    expect(resolved.defaultBranch).toBe(CONFIG_DEFAULTS.defaultBranch);
    expect(resolved.branchPrefix).toBe(CONFIG_DEFAULTS.branchPrefix);
    expect(resolved.readyLabel).toBe(CONFIG_DEFAULTS.readyLabel);
    expect(resolved.researchLabel).toBe(CONFIG_DEFAULTS.researchLabel);
    expect(resolved.processingLabel).toBe(CONFIG_DEFAULTS.processingLabel);
    expect(resolved.readyCommand).toBe(CONFIG_DEFAULTS.readyCommand);
    expect(resolved.blockedByPattern).toBe(CONFIG_DEFAULTS.blockedByPattern);
    expect(resolved.blockerSource).toBe(CONFIG_DEFAULTS.blockerSource);
    expect(resolved.stackMode).toBe(CONFIG_DEFAULTS.stackMode);
    expect(resolved.reviewsSuccessHeading).toBe(CONFIG_DEFAULTS.reviewsSuccessHeading);
    expect(resolved.prScope).toBe(CONFIG_DEFAULTS.prScope);
    expect(resolved.prAuthors).toEqual(CONFIG_DEFAULTS.prAuthors);
    expect(resolved.prBaseScope).toBe(CONFIG_DEFAULTS.prBaseScope);
    expect(resolved.draftPrs).toBe(CONFIG_DEFAULTS.draftPrs);
    expect(resolved.prOptOutLabel).toBe(CONFIG_DEFAULTS.prOptOutLabel);
    expect(resolved.workOrder).toEqual(CONFIG_DEFAULTS.workOrder);
    expect(resolved.defaultProvider).toBe(CONFIG_DEFAULTS.defaultProvider);
    expect(resolved.runTimeoutMs).toBe(CONFIG_DEFAULTS.runTimeoutMs);
    expect(resolved.maxUnitTimeouts).toBe(CONFIG_DEFAULTS.maxUnitTimeouts);
    expect(resolved.maxUnitAttempts).toBe(CONFIG_DEFAULTS.maxUnitAttempts);
    expect(resolved.leaseTtlMs).toBe(CONFIG_DEFAULTS.leaseTtlMs);
  });

  test("run-protection knobs carry sane shipped defaults", () => {
    expect(CONFIG_DEFAULTS.runTimeoutMs).toBe(2_700_000);
    expect(CONFIG_DEFAULTS.maxUnitTimeouts).toBe(3);
    expect(CONFIG_DEFAULTS.maxUnitAttempts).toBe(3);
    expect(CONFIG_DEFAULTS.leaseTtlMs).toBe(1_800_000);
    const resolved = resolveConfig(
      minimalUserConfig({
        runTimeoutMs: 60_000,
        maxUnitTimeouts: 5,
        maxUnitAttempts: 4,
        leaseTtlMs: 120_000,
      }),
    );
    expect(resolved.runTimeoutMs).toBe(60_000);
    expect(resolved.maxUnitTimeouts).toBe(5);
    expect(resolved.maxUnitAttempts).toBe(4);
    expect(resolved.leaseTtlMs).toBe(120_000);
  });

  test("preserves the caller's required-field values verbatim", () => {
    const resolved = resolveConfig(minimalUserConfig());
    expect(resolved.repoSlug).toBe("acme/widget");
    expect(resolved.repoUrl).toBe("https://github.com/acme/widget.git");
    expect(resolved.installCommand).toBe("npm ci");
    expect(resolved.checkCommand).toBe("npm run check");
    expect(resolved.testCommand).toBe("npm test");
  });

  test("caller overrides shadow the defaults", () => {
    const resolved = resolveConfig(
      minimalUserConfig({
        defaultBranch: "trunk",
        readyLabel: "green-light",
        readyCommand: "pnpm ready",
        prAuthors: ["tanflem"],
        prBaseScope: "all",
      }),
    );
    expect(resolved.defaultBranch).toBe("trunk");
    expect(resolved.readyLabel).toBe("green-light");
    expect(resolved.readyCommand).toBe("pnpm ready");
    expect(resolved.prAuthors).toEqual(["tanflem"]);
    expect(resolved.prBaseScope).toBe("all");
  });

  test("shallow-merges nested records: promptFiles overrides one at a time", () => {
    const resolved = resolveConfig(
      minimalUserConfig({ promptFiles: { issue: "custom/issue.md" } }),
    );
    expect(resolved.promptFiles.issue).toBe("custom/issue.md");
    expect(resolved.promptFiles.reviews).toBe(CONFIG_DEFAULTS.promptFiles.reviews);
    expect(resolved.promptFiles.conflict).toBe(CONFIG_DEFAULTS.promptFiles.conflict);
    expect(resolved.promptFiles.checks).toBe(CONFIG_DEFAULTS.promptFiles.checks);
    expect(resolved.promptFiles.research).toBe(CONFIG_DEFAULTS.promptFiles.research);
  });

  test("shallow-merges provider defaults: one model override leaves the others", () => {
    const resolved = resolveConfig(
      minimalUserConfig({ defaultModels: { claude: "claude-opus-4-7" } }),
    );
    expect(resolved.defaultModels.claude).toBe("claude-opus-4-7");
    expect(resolved.defaultModels.cursor).toBe(CONFIG_DEFAULTS.defaultModels.cursor);
    expect(resolved.defaultModels.codex).toBe(CONFIG_DEFAULTS.defaultModels.codex);
  });

  test("shallow-merges provider env vars the same way", () => {
    const resolved = resolveConfig(minimalUserConfig({ providerEnv: { cursor: "MY_CURSOR_KEY" } }));
    expect(resolved.providerEnv.cursor).toBe("MY_CURSOR_KEY");
    expect(resolved.providerEnv.claude).toBe(CONFIG_DEFAULTS.providerEnv.claude);
  });

  test("derives per-tenant paths from the slug under the default data base", () => {
    const resolved = resolveConfig(minimalUserConfig());
    expect(resolved.paths.repoDir).toBe("/data/repos/acme/widget/repo");
    expect(resolved.paths.worktreesDir).toBe("/data/repos/acme/widget/worktrees");
    expect(resolved.paths.stateDir).toBe("/data/repos/acme/widget/state");
  });

  test("threads a custom data base into the derived paths", () => {
    const resolved = resolveConfig(minimalUserConfig(), { dataBase: "/srv/phoebe" });
    expect(resolved.paths.repoDir).toBe("/srv/phoebe/acme/widget/repo");
    expect(resolved.paths.worktreesDir).toBe("/srv/phoebe/acme/widget/worktrees");
    expect(resolved.paths.stateDir).toBe("/srv/phoebe/acme/widget/state");
  });

  test("defaults name a model and env var for every declared provider", () => {
    // Guards against a new provider being added without a matching default.
    for (const provider of PROVIDER_NAMES) {
      expect(CONFIG_DEFAULTS.defaultModels[provider]).toBeTruthy();
      expect(CONFIG_DEFAULTS.providerEnv[provider]).toBeTruthy();
    }
  });

  test("blockerSource defaults to body and honors an override", () => {
    expect(resolveConfig(minimalUserConfig()).blockerSource).toBe("body");
    expect(resolveConfig(minimalUserConfig({ blockerSource: "both" })).blockerSource).toBe("both");
    expect(resolveConfig(minimalUserConfig({ blockerSource: "native" })).blockerSource).toBe(
      "native",
    );
  });

  test("stackMode defaults to banner and honors an override", () => {
    expect(resolveConfig(minimalUserConfig()).stackMode).toBe("banner");
    expect(resolveConfig(minimalUserConfig({ stackMode: "native" })).stackMode).toBe("native");
    expect(resolveConfig(minimalUserConfig({ stackMode: "off" })).stackMode).toBe("off");
  });

  test("default blockedByPattern compiles and captures the issue number", () => {
    const pattern = new RegExp(CONFIG_DEFAULTS.blockedByPattern, "gi");
    const matches = [..."Blocked by #42\nblocked by  #7".matchAll(pattern)].map((m) =>
      Number(m[1]),
    );
    expect(matches).toEqual([42, 7]);
  });

  describe("issueSource (#21)", () => {
    test("defaults to the work repo and readyLabel when omitted", () => {
      const resolved = resolveConfig(minimalUserConfig());
      expect(resolved.issueSource).toEqual({
        repoSlug: resolved.repoSlug,
        readyLabel: resolved.readyLabel,
      });
    });

    test("still defaults to the work repo when only readyLabel is overridden", () => {
      const resolved = resolveConfig(minimalUserConfig({ readyLabel: "green-light" }));
      expect(resolved.issueSource).toEqual({
        repoSlug: "acme/widget",
        readyLabel: "green-light",
      });
    });

    test("honors an explicit issueSource repoSlug", () => {
      const resolved = resolveConfig(
        minimalUserConfig({ issueSource: { repoSlug: "acme/planning" } }),
      );
      expect(resolved.issueSource.repoSlug).toBe("acme/planning");
      // readyLabel falls back to the tenant's own readyLabel, per the issue's
      // "defaults to the tenant's readyLabel" contract.
      expect(resolved.issueSource.readyLabel).toBe(resolved.readyLabel);
    });

    test("honors an explicit issueSource readyLabel independent of the tenant's own", () => {
      const resolved = resolveConfig(
        minimalUserConfig({
          readyLabel: "green-light",
          issueSource: { repoSlug: "acme/planning", readyLabel: "triaged" },
        }),
      );
      expect(resolved.issueSource).toEqual({ repoSlug: "acme/planning", readyLabel: "triaged" });
      expect(resolved.readyLabel).toBe("green-light");
    });
  });

  test("round-trips a config carrying bootstrapper-only engine + workspace fields", () => {
    // Type-level: assigning these on PhoebeUserConfig must compile. Runtime:
    // resolveConfig accepts the user shape and still produces a full engine config.
    const user: PhoebeUserConfig = minimalUserConfig({
      engine: { source: "github", ref: "v0.1.0" },
      workspace: { depth: 2 },
    });
    const resolved = resolveConfig(user);
    expect(resolved.repoSlug).toBe("acme/widget");
    expect(resolved.defaultBranch).toBe(CONFIG_DEFAULTS.defaultBranch);
    expect(resolved.paths.repoDir).toBe("/data/repos/acme/widget/repo");
  });

  test("drops bootstrapper-only engine and workspace from the engine-facing shape", () => {
    // Mirrors how `engine` is never on PhoebeConfig: both fields are accepted
    // on the user config so consumers type-check, then discarded by construction.
    const resolved = resolveConfig(
      minimalUserConfig({
        engine: { source: "local" },
        workspace: { depth: 2 },
      }),
    );
    expect(resolved).not.toHaveProperty("engine");
    expect(resolved).not.toHaveProperty("workspace");
    // A spread snapshot of keys must not sneak them back in under any alias.
    expect(Object.keys(resolved).sort()).not.toContain("engine");
    expect(Object.keys(resolved).sort()).not.toContain("workspace");
  });
});
