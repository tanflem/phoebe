// Tests for the consumer-facing config plumbing exported from ./config/index.ts:
//
//   - the `PHOEBE_*` scalar/enum env overlay, exercised through
//     `resolveConfiguration`'s `env` option (the overlay itself,
//     `applyEnvOverlay`, is implementation — #55).
//   - `resolveConfigPath` returns absolute paths and rejects missing files
//     with a message that distinguishes an explicit --config from the default.
//   - `loadUserConfig` accepts both `export default` and named `export const
//     config` shapes and quotes the underlying error on failure.
//
// `defineConfig` moved to the bootstrapper — see bootstrap/define-config.test.ts.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  loadUserConfig,
  resolveConfigPath,
  resolveConfiguration,
  type PhoebeUserConfig,
} from "./config/index.ts";

function baseUser(overrides: Partial<PhoebeUserConfig> = {}): PhoebeUserConfig {
  return {
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    ...overrides,
  };
}

function resolveWithEnv(env: NodeJS.ProcessEnv) {
  return resolveConfiguration({ repository: baseUser(), env }).config;
}

describe("PHOEBE_* env overlay (via resolveConfiguration)", () => {
  test("unset env vars leave the config field untouched", () => {
    const resolved = resolveWithEnv({});
    expect(resolved.repoSlug).toBe("acme/widget");
    expect(resolved.installCommand).toBe("npm ci");
  });

  test("empty-string env vars are ignored (treated the same as unset)", () => {
    expect(resolveWithEnv({ PHOEBE_REPO_SLUG: "" }).repoSlug).toBe("acme/widget");
  });

  // Every scalar/enum overlay key documented in docs/configuration.md, paired
  // with a value valid for that field. A field-scoped table (rather than magic
  // name-mangling) keeps the surface documented and predictable.
  const SCALAR_OVERLAYS = [
    ["PHOEBE_REPO_SLUG", "repoSlug", "env/repo"],
    ["PHOEBE_REPO_URL", "repoUrl", "https://example.invalid/env-repo.git"],
    ["PHOEBE_DEFAULT_BRANCH", "defaultBranch", "trunk"],
    ["PHOEBE_BRANCH_PREFIX", "branchPrefix", "env/"],
    ["PHOEBE_READY_LABEL", "readyLabel", "env-ready"],
    ["PHOEBE_RESEARCH_LABEL", "researchLabel", "env-research"],
    ["PHOEBE_PROCESSING_LABEL", "processingLabel", "env-processing"],
    ["PHOEBE_PR_OPT_OUT_LABEL", "prOptOutLabel", "env-opt-out"],
    ["PHOEBE_INSTALL_COMMAND", "installCommand", "env install"],
    ["PHOEBE_CHECK_COMMAND", "checkCommand", "env check"],
    ["PHOEBE_TEST_COMMAND", "testCommand", "env test"],
    ["PHOEBE_READY_COMMAND", "readyCommand", "env ready"],
    ["PHOEBE_BLOCKED_BY_PATTERN", "blockedByPattern", String.raw`Env blocked by\s+#(\d+)`],
    ["PHOEBE_REVIEWS_SUCCESS_HEADING", "reviewsSuccessHeading", "## env heading"],
  ] as const;

  test.each(SCALAR_OVERLAYS)("%s overlays %s", (envKey, field, value) => {
    const resolved = resolveWithEnv({ [envKey]: value });
    expect(resolved[field]).toBe(value);
  });

  const ENUM_OVERLAYS = [
    ["PHOEBE_PR_SCOPE", "prScope", "all", "bogus"],
    ["PHOEBE_PR_BASE_SCOPE", "prBaseScope", "all", "bogus"],
    ["PHOEBE_DRAFT_PRS", "draftPrs", "include", "bogus"],
    ["PHOEBE_BLOCKER_SOURCE", "blockerSource", "both", "bogus"],
    ["PHOEBE_STACK_MODE", "stackMode", "off", "bogus"],
    ["PHOEBE_DEFAULT_PROVIDER", "defaultProvider", "claude", "bogus"],
  ] as const;

  test.each(ENUM_OVERLAYS)("%s overlays and validates %s", (envKey, field, valid, invalid) => {
    expect(resolveWithEnv({ [envKey]: valid })[field]).toBe(valid);
    expect(() => resolveWithEnv({ [envKey]: invalid })).toThrow(new RegExp(envKey));
  });

  test("prAuthors, promptFiles, workOrder, and the run-protection knobs are not env-overridable here", () => {
    // prAuthors/promptFiles/workOrder are structured shapes — config-file
    // territory, not this scalar overlay. The four run-protection knobs
    // (runTimeoutMs etc.) are read directly from `PHOEBE_*` against the
    // *resolved* value elsewhere (src/run-timeout.ts, src/quarantine.ts,
    // src/claim-lease.ts), not through this overlay.
    const resolved = resolveWithEnv({
      PHOEBE_RUN_TIMEOUT_MS: "1",
      PHOEBE_MAX_UNIT_TIMEOUTS: "1",
      PHOEBE_MAX_UNIT_ATTEMPTS: "1",
      PHOEBE_LEASE_TTL_MS: "1",
    });
    expect(resolved.runTimeoutMs).toBe(2_700_000);
    expect(resolved.maxUnitTimeouts).toBe(3);
    expect(resolved.maxUnitAttempts).toBe(3);
    expect(resolved.leaseTtlMs).toBe(1_800_000);
  });
});

describe("resolveConfigPath + loadUserConfig", () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "phoebe-cli-"));
    mkdirSync(workDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("resolveConfigPath returns an absolute path when a relative one is passed", () => {
    const rel = "phoebe.config.ts";
    writeFileSync(join(workDir, rel), "export default {};", "utf8");
    expect(resolveConfigPath(rel, workDir)).toBe(join(workDir, rel));
  });

  test("resolveConfigPath uses the default when no --config passed", () => {
    const defaultPath = join(workDir, "phoebe.config.ts");
    writeFileSync(defaultPath, "export default {};", "utf8");
    expect(resolveConfigPath(undefined, workDir)).toBe(defaultPath);
  });

  test("resolveConfigPath differentiates the missing-file error by source", () => {
    const empty = mkdtempSync(join(tmpdir(), "phoebe-cli-empty-"));
    try {
      expect(() => resolveConfigPath(undefined, empty)).toThrow(/pass --config/);
      expect(() => resolveConfigPath("nope.ts", empty)).toThrow(/passed via --config/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("loadUserConfig loads a default-exported config", async () => {
    const path = join(workDir, "default-export.ts");
    writeFileSync(
      path,
      `export default {
        repoSlug: "org/one",
        repoUrl: "https://x/y.git",
        installCommand: "a",
        checkCommand: "b",
        testCommand: "c",
      };
      `,
      "utf8",
    );
    const cfg = await loadUserConfig(path);
    expect(cfg.repoSlug).toBe("org/one");
  });

  test("loadUserConfig re-reads an edited config when given a fresh reloadKey", async () => {
    // The reconcile watch (#42) re-reads the mounted config *in-process* after an
    // edit. Node's ESM cache is keyed by URL, so without the key the second read
    // would hand back the first import and boot would relaunch onto stale config.
    const path = join(workDir, "reloaded.ts");
    writeFileSync(path, `export default { repoSlug: "org/before" };`, "utf8");
    expect((await loadUserConfig(path, { reloadKey: "v1" })).repoSlug).toBe("org/before");

    writeFileSync(path, `export default { repoSlug: "org/after" };`, "utf8");
    expect((await loadUserConfig(path, { reloadKey: "v2" })).repoSlug).toBe("org/after");
    // Same key ⇒ the cached module, which is what makes a no-change poll free.
    expect((await loadUserConfig(path, { reloadKey: "v2" })).repoSlug).toBe("org/after");
  });

  test("loadUserConfig loads a named `config` export (pre-defineConfig scaffold)", async () => {
    const path = join(workDir, "named-config.ts");
    writeFileSync(
      path,
      `export const config = {
        repoSlug: "org/two",
        repoUrl: "https://x/y.git",
        installCommand: "a",
        checkCommand: "b",
        testCommand: "c",
      };
      `,
      "utf8",
    );
    const cfg = await loadUserConfig(path);
    expect(cfg.repoSlug).toBe("org/two");
  });

  test("loadUserConfig errors clearly when the file exports no config", async () => {
    const path = join(workDir, "empty-export.ts");
    writeFileSync(path, `export const something = 1;\n`, "utf8");
    await expect(loadUserConfig(path)).rejects.toThrow(/must export/);
  });

  test("loadUserConfig quotes the underlying error on syntax failure", async () => {
    const path = join(workDir, "broken.ts");
    writeFileSync(path, `export default { unterminated`, "utf8");
    await expect(loadUserConfig(path)).rejects.toThrow(/Failed to load/);
  });
});
