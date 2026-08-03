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
    expect(resolved.reviewsSuccessHeading).toBe(CONFIG_DEFAULTS.reviewsSuccessHeading);
    expect(resolved.prScope).toBe(CONFIG_DEFAULTS.prScope);
    expect(resolved.prAuthors).toEqual(CONFIG_DEFAULTS.prAuthors);
    expect(resolved.prBaseScope).toBe(CONFIG_DEFAULTS.prBaseScope);
    expect(resolved.draftPrs).toBe(CONFIG_DEFAULTS.draftPrs);
    expect(resolved.prOptOutLabel).toBe(CONFIG_DEFAULTS.prOptOutLabel);
    expect(resolved.workOrder).toEqual(CONFIG_DEFAULTS.workOrder);
    expect(resolved.defaultProvider).toBe(CONFIG_DEFAULTS.defaultProvider);
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

  test("defaults claude reasoning effort to xhigh and leaves the others unset", () => {
    const resolved = resolveConfig(minimalUserConfig());
    expect(resolved.defaultEfforts.claude).toBe("xhigh");
    expect(resolved.defaultEfforts.cursor).toBeUndefined();
    expect(resolved.defaultEfforts.codex).toBeUndefined();
  });

  test("shallow-merges provider efforts: one override leaves the others", () => {
    const resolved = resolveConfig(minimalUserConfig({ defaultEfforts: { codex: "high" } }));
    expect(resolved.defaultEfforts.codex).toBe("high");
    expect(resolved.defaultEfforts.claude).toBe(CONFIG_DEFAULTS.defaultEfforts.claude);
    expect(resolved.defaultEfforts.cursor).toBe(CONFIG_DEFAULTS.defaultEfforts.cursor);
  });

  test("shallow-merges provider env vars the same way", () => {
    const resolved = resolveConfig(minimalUserConfig({ providerEnv: { cursor: "MY_CURSOR_KEY" } }));
    expect(resolved.providerEnv.cursor).toBe("MY_CURSOR_KEY");
    expect(resolved.providerEnv.claude).toBe(CONFIG_DEFAULTS.providerEnv.claude);
  });

  test("shallow-merges paths", () => {
    const resolved = resolveConfig(minimalUserConfig({ paths: { repoDir: "/srv/repo" } }));
    expect(resolved.paths.repoDir).toBe("/srv/repo");
    expect(resolved.paths.worktreesDir).toBe(CONFIG_DEFAULTS.paths.worktreesDir);
    expect(resolved.paths.stateDir).toBe(CONFIG_DEFAULTS.paths.stateDir);
  });

  test("defaults name a model and env var for every declared provider", () => {
    // Guards against a new provider being added without a matching default.
    for (const provider of PROVIDER_NAMES) {
      expect(CONFIG_DEFAULTS.defaultModels[provider]).toBeTruthy();
      expect(CONFIG_DEFAULTS.providerEnv[provider]).toBeTruthy();
    }
  });

  test("default blockedByPattern compiles and captures the issue number", () => {
    const pattern = new RegExp(CONFIG_DEFAULTS.blockedByPattern, "gi");
    const matches = [..."Blocked by #42\nblocked by  #7".matchAll(pattern)].map((m) =>
      Number(m[1]),
    );
    expect(matches).toEqual([42, 7]);
  });
});
