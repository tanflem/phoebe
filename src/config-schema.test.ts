// Contract tests for the config schema seam: five required fields, the
// roster's shipped defaults for the rest, and a shallow merge for the four
// nested records so a consumer can override one prompt file or one provider's
// model without repeating the others. Exercised through `resolveConfiguration`
// (src/config/index.ts) — the roster, `validateUserConfig`, and `resolveConfig`
// are implementation and stay unimported here (#55).

import { describe, expect, test } from "vite-plus/test";
import { PROVIDER_NAMES, resolveConfiguration, type PhoebeUserConfig } from "./config/index.ts";

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

function resolve(overrides: Partial<PhoebeUserConfig> = {}, dataBase?: string) {
  return resolveConfiguration({ repository: minimalUserConfig(overrides), dataBase }).config;
}

describe("resolveConfiguration: validating the repository declaration", () => {
  test("accepts a minimal five-field config", () => {
    expect(() => resolve()).not.toThrow();
  });

  test.each([
    ["repoSlug"],
    ["repoUrl"],
    ["installCommand"],
    ["checkCommand"],
    ["testCommand"],
  ] as const)("rejects when %s is missing", (key) => {
    const repository = { ...minimalUserConfig() } as Record<string, unknown>;
    delete repository[key];
    expect(() => resolveConfiguration({ repository: repository as PhoebeUserConfig })).toThrow(
      new RegExp(`missing required field.*${key}`, "i"),
    );
  });

  test("rejects blank required strings the same as missing ones", () => {
    expect(() => resolve({ repoSlug: "   " })).toThrow(/repoSlug/);
  });

  test("lists every missing required field in one error", () => {
    const repository = {
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
    } as PhoebeUserConfig;
    expect(() => resolveConfiguration({ repository })).toThrow(
      /installCommand.*checkCommand.*testCommand/,
    );
  });

  test("rejects a blockedByPattern that is not a valid regex", () => {
    expect(() => resolve({ blockedByPattern: "Blocked by [" })).toThrow(/blockedByPattern/);
  });

  test("rejects a blockedByPattern that is valid but has no capture group", () => {
    // parseBlockedBy reads match[1]; a pattern without a group would silently
    // yield NaN blocker numbers.
    expect(() => resolve({ blockedByPattern: String.raw`Blocked by #\d+` })).toThrow(
      /capture group 1/,
    );
  });

  test("rejects a blockedByPattern whose only groups are non-capturing", () => {
    expect(() => resolve({ blockedByPattern: String.raw`(?:Blocked by )#\d+` })).toThrow(
      /capture group 1/,
    );
  });

  test("accepts a pattern that uses non-capturing groups plus a real capture group", () => {
    expect(() =>
      resolve({ blockedByPattern: String.raw`(?:Blocked by|Depends on)\s+#(\d+)` }),
    ).not.toThrow();
  });

  test("accepts an omitted issueSource", () => {
    expect(() => resolve()).not.toThrow();
  });

  test("accepts issueSource with just repoSlug", () => {
    expect(() => resolve({ issueSource: { repoSlug: "acme/planning" } })).not.toThrow();
  });

  test("accepts issueSource with repoSlug and readyLabel", () => {
    expect(() =>
      resolve({ issueSource: { repoSlug: "acme/planning", readyLabel: "triaged" } }),
    ).not.toThrow();
  });

  test("rejects issueSource with an empty repoSlug", () => {
    expect(() => resolve({ issueSource: { repoSlug: "  " } })).toThrow(/issueSource.*repoSlug/);
  });

  test("rejects a non-object issueSource", () => {
    expect(() =>
      resolve({ issueSource: "acme/planning" as unknown as PhoebeUserConfig["issueSource"] }),
    ).toThrow(/issueSource.*must be an object/);
  });

  test("rejects issueSource with unknown fields", () => {
    expect(() =>
      resolve({
        issueSource: {
          repoSlug: "acme/planning",
          processingLabel: "nope",
        } as unknown as PhoebeUserConfig["issueSource"],
      }),
    ).toThrow(/issueSource.*has unknown field/);
  });

  test("rejects a non-string issueSource.readyLabel", () => {
    expect(() =>
      resolve({
        issueSource: { repoSlug: "acme/planning", readyLabel: 7 as unknown as string },
      }),
    ).toThrow(/issueSource.*readyLabel/);
  });

  test("accepts a workspace block with omitted depth (bootstrap defaults to 1)", () => {
    expect(() => resolve({ workspace: {} })).not.toThrow();
  });

  test("accepts a workspace block with an integer depth ≥ 1", () => {
    expect(() => resolve({ workspace: { depth: 1 } })).not.toThrow();
    expect(() => resolve({ workspace: { depth: 3 } })).not.toThrow();
  });

  test("rejects workspace.depth < 1", () => {
    expect(() => resolve({ workspace: { depth: 0 } })).toThrow(/workspace.*depth.*integer ≥ 1/i);
    expect(() => resolve({ workspace: { depth: -1 } })).toThrow(/workspace.*depth/i);
  });

  test("rejects non-integer workspace.depth", () => {
    expect(() => resolve({ workspace: { depth: 1.5 } })).toThrow(/workspace.*depth/i);
  });

  test("accepts a relative configDir", () => {
    expect(() => resolve({ configDir: ".phoebe" })).not.toThrow();
    expect(() => resolve({ configDir: "deploy/phoebe" })).not.toThrow();
  });

  test("rejects an absolute configDir", () => {
    expect(() => resolve({ configDir: "/etc/phoebe" })).toThrow(/configDir.*absolute/i);
  });

  test("rejects a `..`-escaping or empty configDir", () => {
    expect(() => resolve({ configDir: "../sibling" })).toThrow(/configDir/i);
    expect(() => resolve({ configDir: "" })).toThrow(/configDir/i);
  });

  test("rejects a malformed engine field", () => {
    expect(() =>
      resolve({ engine: { source: "bogus" } as unknown as PhoebeUserConfig["engine"] }),
    ).toThrow(/engine/i);
  });
});

describe("resolveConfiguration: filling in the roster's shipped defaults", () => {
  test("fills every optional field with a shipped default", () => {
    const resolved = resolve();
    expect(resolved.defaultBranch).toBe("main");
    expect(resolved.branchPrefix).toBe("phoebe/");
    expect(resolved.readyLabel).toBe("ready-for-agent");
    expect(resolved.researchLabel).toBe("wayfinder:research");
    expect(resolved.processingLabel).toBe("processing");
    expect(resolved.readyCommand).toBe("npm run ready");
    expect(resolved.blockedByPattern).toBe(String.raw`Blocked by\s+#(\d+)`);
    expect(resolved.blockerSource).toBe("body");
    expect(resolved.stackMode).toBe("banner");
    expect(resolved.reviewsSuccessHeading).toBe("## Review feedback addressed");
    expect(resolved.prScope).toBe("phoebe");
    expect(resolved.prAuthors).toEqual([]);
    expect(resolved.prBaseScope).toBe("default");
    expect(resolved.draftPrs).toBe("skip-non-phoebe");
    expect(resolved.prOptOutLabel).toBe("ready-for-human");
    expect(resolved.workOrder).toEqual(["conflicts", "checks", "reviews", "issues", "research"]);
    expect(resolved.defaultProvider).toBe("cursor");
    expect(resolved.runTimeoutMs).toBe(2_700_000);
    expect(resolved.maxUnitTimeouts).toBe(3);
    expect(resolved.maxUnitAttempts).toBe(3);
    expect(resolved.leaseTtlMs).toBe(1_800_000);
  });

  test("run-protection knobs honor an override", () => {
    const resolved = resolve({
      runTimeoutMs: 60_000,
      maxUnitTimeouts: 5,
      maxUnitAttempts: 4,
      leaseTtlMs: 120_000,
    });
    expect(resolved.runTimeoutMs).toBe(60_000);
    expect(resolved.maxUnitTimeouts).toBe(5);
    expect(resolved.maxUnitAttempts).toBe(4);
    expect(resolved.leaseTtlMs).toBe(120_000);
  });

  test("preserves the caller's required-field values verbatim", () => {
    const resolved = resolve();
    expect(resolved.repoSlug).toBe("acme/widget");
    expect(resolved.repoUrl).toBe("https://github.com/acme/widget.git");
    expect(resolved.installCommand).toBe("npm ci");
    expect(resolved.checkCommand).toBe("npm run check");
    expect(resolved.testCommand).toBe("npm test");
  });

  test("caller overrides shadow the defaults", () => {
    const resolved = resolve({
      defaultBranch: "trunk",
      readyLabel: "green-light",
      readyCommand: "pnpm ready",
      prAuthors: ["tanflem"],
      prBaseScope: "all",
    });
    expect(resolved.defaultBranch).toBe("trunk");
    expect(resolved.readyLabel).toBe("green-light");
    expect(resolved.readyCommand).toBe("pnpm ready");
    expect(resolved.prAuthors).toEqual(["tanflem"]);
    expect(resolved.prBaseScope).toBe("all");
  });

  test("shallow-merges nested records: promptFiles overrides one at a time", () => {
    const resolved = resolve({ promptFiles: { issue: "custom/issue.md" } });
    expect(resolved.promptFiles.issue).toBe("custom/issue.md");
    expect(resolved.promptFiles.reviews).toBe("prompts/reviews-prompt.md");
    expect(resolved.promptFiles.conflict).toBe("prompts/conflict-prompt.md");
    expect(resolved.promptFiles.checks).toBe("prompts/checks-prompt.md");
    expect(resolved.promptFiles.research).toBe("prompts/research-prompt.md");
  });

  test("shallow-merges provider defaults: one model override leaves the others", () => {
    const resolved = resolve({ defaultModels: { claude: "claude-opus-4-7" } });
    expect(resolved.defaultModels.claude).toBe("claude-opus-4-7");
    expect(resolved.defaultModels.cursor).toBe("composer-2.5");
    expect(resolved.defaultModels.codex).toBe("gpt-5.4-mini");
  });

  test("shallow-merges provider env vars the same way", () => {
    const resolved = resolve({ providerEnv: { cursor: "MY_CURSOR_KEY" } });
    expect(resolved.providerEnv.cursor).toBe("MY_CURSOR_KEY");
    expect(resolved.providerEnv.claude).toBe("ANTHROPIC_API_KEY");
  });

  test("derives per-tenant paths from the slug under the default data base", () => {
    const resolved = resolve();
    expect(resolved.paths.repoDir).toBe("/data/repos/acme/widget/repo");
    expect(resolved.paths.worktreesDir).toBe("/data/repos/acme/widget/worktrees");
    expect(resolved.paths.stateDir).toBe("/data/repos/acme/widget/state");
  });

  test("threads a custom data base into the derived paths", () => {
    const resolved = resolve({}, "/srv/phoebe");
    expect(resolved.paths.repoDir).toBe("/srv/phoebe/acme/widget/repo");
    expect(resolved.paths.worktreesDir).toBe("/srv/phoebe/acme/widget/worktrees");
    expect(resolved.paths.stateDir).toBe("/srv/phoebe/acme/widget/state");
  });

  test("defaults name a model and env var for every declared provider", () => {
    // Guards against a new provider being added without a matching default.
    const resolved = resolve();
    for (const provider of PROVIDER_NAMES) {
      expect(resolved.defaultModels[provider]).toBeTruthy();
      expect(resolved.providerEnv[provider]).toBeTruthy();
    }
  });

  test("blockerSource defaults to body and honors an override", () => {
    expect(resolve().blockerSource).toBe("body");
    expect(resolve({ blockerSource: "both" }).blockerSource).toBe("both");
    expect(resolve({ blockerSource: "native" }).blockerSource).toBe("native");
  });

  test("stackMode defaults to banner and honors an override", () => {
    expect(resolve().stackMode).toBe("banner");
    expect(resolve({ stackMode: "native" }).stackMode).toBe("native");
    expect(resolve({ stackMode: "off" }).stackMode).toBe("off");
  });

  test("default blockedByPattern compiles and captures the issue number", () => {
    const pattern = new RegExp(resolve().blockedByPattern, "gi");
    const matches = [..."Blocked by #42\nblocked by  #7".matchAll(pattern)].map((m) =>
      Number(m[1]),
    );
    expect(matches).toEqual([42, 7]);
  });

  describe("issueSource (#21)", () => {
    test("defaults to the work repo and readyLabel when omitted", () => {
      const resolved = resolve();
      expect(resolved.issueSource).toEqual({
        repoSlug: resolved.repoSlug,
        readyLabel: resolved.readyLabel,
      });
    });

    test("still defaults to the work repo when only readyLabel is overridden", () => {
      const resolved = resolve({ readyLabel: "green-light" });
      expect(resolved.issueSource).toEqual({ repoSlug: "acme/widget", readyLabel: "green-light" });
    });

    test("honors an explicit issueSource repoSlug", () => {
      const resolved = resolve({ issueSource: { repoSlug: "acme/planning" } });
      expect(resolved.issueSource.repoSlug).toBe("acme/planning");
      // readyLabel falls back to the tenant's own readyLabel, per the issue's
      // "defaults to the tenant's readyLabel" contract.
      expect(resolved.issueSource.readyLabel).toBe(resolved.readyLabel);
    });

    test("honors an explicit issueSource readyLabel independent of the tenant's own", () => {
      const resolved = resolve({
        readyLabel: "green-light",
        issueSource: { repoSlug: "acme/planning", readyLabel: "triaged" },
      });
      expect(resolved.issueSource).toEqual({ repoSlug: "acme/planning", readyLabel: "triaged" });
      expect(resolved.readyLabel).toBe("green-light");
    });
  });

  test("round-trips a config carrying bootstrapper-only engine + workspace fields", () => {
    // Type-level: assigning these on PhoebeUserConfig must compile. Runtime:
    // resolveConfiguration accepts the user shape and still produces a full
    // engine config.
    const resolved = resolve({
      engine: { source: "github", ref: "v0.1.0" },
      workspace: { depth: 2 },
    });
    expect(resolved.repoSlug).toBe("acme/widget");
    expect(resolved.defaultBranch).toBe("main");
    expect(resolved.paths.repoDir).toBe("/data/repos/acme/widget/repo");
  });

  test("drops bootstrapper-only engine, workspace, and configDir from the engine-facing shape", () => {
    // Mirrors how `engine` is never on PhoebeConfig: both fields are accepted
    // on the user config so consumers type-check, then discarded by construction.
    const resolved = resolve({
      engine: { source: "local" },
      workspace: { depth: 2 },
      configDir: ".phoebe",
    });
    expect(resolved).not.toHaveProperty("engine");
    expect(resolved).not.toHaveProperty("workspace");
    expect(resolved).not.toHaveProperty("configDir");
    // A spread snapshot of keys must not sneak them back in under any alias.
    expect(Object.keys(resolved).sort()).not.toContain("engine");
    expect(Object.keys(resolved).sort()).not.toContain("workspace");
    expect(Object.keys(resolved).sort()).not.toContain("configDir");
  });
});
