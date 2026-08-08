// The `phoebe boot` source resolution. `boot` reads the mounted config, resolves
// the engine source, and turns it into the path it execs. This pins the `local`
// mount decision and which sources the crash-loop guard covers; the `github`
// source is materialized separately (github-engine.ts) and tested there, and the
// fallback policy itself lives in crash-loop.ts.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  assertBaseConfigProtocol,
  engineProvenanceEnv,
  isMovingBranch,
  loadBootConfiguration,
  LOCAL_ENGINE_DIR,
  observerEngineEnv,
  resolveEngineEntry,
  setupGitCredentials,
} from "./boot.ts";
import { BOOTSTRAP_RESOLVED_CONFIG_ENV } from "../src/config-resolution.ts";
import { childEnv } from "./engine-child-env.ts";
import { deploymentConfigFingerprint } from "./reconcile.ts";
import { derivePaths } from "../src/paths.ts";

describe("resolveEngineEntry", () => {
  test("a local source execs the engine CLI under the mounted dir", () => {
    const entry = resolveEngineEntry(
      { source: "local" },
      { localEngineDir: "/opt/phoebe-engine", exists: () => true },
    );
    expect(entry).toBe(join("/opt/phoebe-engine", "src", "cli.ts"));
  });

  test("local defaults to /opt/phoebe-engine", () => {
    expect(LOCAL_ENGINE_DIR).toBe("/opt/phoebe-engine");
    const entry = resolveEngineEntry({ source: "local" }, { exists: () => true });
    expect(entry).toBe(join(LOCAL_ENGINE_DIR, "src", "cli.ts"));
  });

  test("a local source with no mount fails loudly, naming the dir", () => {
    expect(() =>
      resolveEngineEntry(
        { source: "local" },
        { localEngineDir: "/opt/phoebe-engine", exists: () => false },
      ),
    ).toThrow(/no engine is mounted at \/opt\/phoebe-engine/);
  });

  test("a mounted-but-empty volume (dir present, no src/cli.ts) also fails loudly", () => {
    const entry = join("/opt/phoebe-engine", "src", "cli.ts");
    // Everything exists except the engine entry file — an empty/wrong mount.
    expect(() =>
      resolveEngineEntry(
        { source: "local" },
        { localEngineDir: "/opt/phoebe-engine", exists: (path) => path !== entry },
      ),
    ).toThrow(/no engine is mounted at \/opt\/phoebe-engine/);
  });
});

describe("bootstrapper/engine configuration parity", () => {
  test("requires snapshot-protocol support before a base-configured engine can start", () => {
    const entry = "/engine/src/cli.ts";
    expect(() =>
      assertBaseConfigProtocol(entry, "/etc/phoebe/generated-base.json", () => {
        throw new Error("ENOENT");
      }),
    ).toThrow(/does not support PHOEBE_BASE_CONFIG.*generated-base\.json/i);

    expect(() =>
      assertBaseConfigProtocol(
        entry,
        "/etc/phoebe/generated-base.json",
        () => `{"schemaVersion":1}`,
      ),
    ).not.toThrow();
  });

  test("keeps older engine refs compatible when no generated base is configured", () => {
    expect(() =>
      assertBaseConfigProtocol("/old-engine/src/cli.ts", undefined, () => {
        throw new Error("old engine has no marker");
      }),
    ).not.toThrow();
  });

  test("boot resolves the generated engine source and runtime fields through the shared contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "phoebe-boot-config-"));
    const repositoryPath = join(root, "phoebe.config.ts");
    const basePath = join(root, "generated-base.json");
    try {
      writeFileSync(
        repositoryPath,
        `export default {
          repoSlug: "acme/widget",
          repoUrl: "https://github.com/acme/widget.git",
          installCommand: "npm ci",
          checkCommand: "npm run check",
          testCommand: "npm test",
          engine: { source: "github", ref: "repository-ref" }
        };\n`,
      );
      writeFileSync(
        basePath,
        `${JSON.stringify({
          schemaVersion: 1,
          config: {
            branchPrefix: "managed/",
            engine: { source: "github", repo: "acme/phoebe", ref: "base-ref" },
          },
        })}\n`,
      );
      const env = {
        PHOEBE_BASE_CONFIG: basePath,
        PHOEBE_BRANCH_PREFIX: "environment/",
      };
      const resolved = await loadBootConfiguration(
        repositoryPath,
        env,
        deploymentConfigFingerprint(repositoryPath, basePath),
      );

      expect(resolved.engine).toEqual({
        source: "github",
        repo: "acme/phoebe",
        ref: "repository-ref",
      });
      expect(resolved.config.branchPrefix).toBe("environment/");
      // paths is never layerable (#58): it is always derived from repoSlug +
      // the deployment data base, so tenant paths can never collide.
      expect(resolved.config.paths).toEqual(derivePaths("acme/widget"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("observerEngineEnv", () => {
  test("passes engine, bootstrap, and crash-loop provenance to the runtime", () => {
    expect(
      observerEngineEnv({
        source: { source: "github", repo: "JesusFilm/phoebe", ref: "main" },
        sha: "last-good-sha",
        quarantinedSha: "bad-sha",
      }),
    ).toMatchObject({
      PHOEBE_RUNNING_ENGINE_SOURCE: "github",
      PHOEBE_RUNNING_ENGINE_REPO: "JesusFilm/phoebe",
      PHOEBE_RUNNING_ENGINE_REF: "main",
      PHOEBE_RUNNING_ENGINE_SHA: "last-good-sha",
      PHOEBE_QUARANTINED_ENGINE_SHA: "bad-sha",
      // Matches whatever version is being released — bootstrapVersion() reads
      // the same file, so the assertion is that the pass-through happens.
      PHOEBE_BOOTSTRAP_VERSION: (
        JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
          version: string;
        }
      ).version,
    });
  });
});

describe("engineProvenanceEnv", () => {
  test("carries the resolved-config snapshot alongside engine provenance", () => {
    const env = engineProvenanceEnv({
      source: { source: "github", repo: "JesusFilm/phoebe", ref: "main" },
      sha: "last-good-sha",
      quarantinedSha: null,
      resolvedConfiguration: '{"schemaVersion":1}',
    });
    expect(env[BOOTSTRAP_RESOLVED_CONFIG_ENV]).toBe('{"schemaVersion":1}');
    expect(env.PHOEBE_RUNNING_ENGINE_SOURCE).toBe("github");
  });

  test("omits the snapshot key when no resolved configuration was produced", () => {
    const env = engineProvenanceEnv({ sha: null, quarantinedSha: null });
    expect(BOOTSTRAP_RESOLVED_CONFIG_ENV in env).toBe(false);
  });
});

// Flat (spawnSupervised) and nested/workspace (spawnFleetChild) both build
// their child's env through the one `childEnv` builder (#64), differing only
// in `secrets`: flat passes its own `process.env`, nested/workspace pass the
// tenant's parsed `.env`. This pins that both still land the same
// deployment-critical vars — provenance, the atomic resolved-config snapshot,
// and the generated base config — for the same launch, and that the flat
// path's resulting env is unchanged from before this builder existed.
describe("flat vs nested child-env parity (#64, closes #38)", () => {
  const engine = {
    source: { source: "github", repo: "JesusFilm/phoebe", ref: "main" } as const,
    sha: "abc123",
    quarantinedSha: null,
    resolvedConfiguration: '{"schemaVersion":1,"config":{}}',
  };
  const deploymentEnv = {
    PATH: "/usr/bin",
    HOME: "/home/phoebe",
    GH_TOKEN: "DEPLOYMENT_CLONE_TOKEN",
    PHOEBE_BASE_CONFIG: "/etc/phoebe/generated-base.json",
  };

  test("a nested tenant's child env carries the same provenance + snapshot + base config as the flat path's", () => {
    // Flat path: spawnSupervised's env — base allowlist ∪ knobs ∪ provenance ∪
    // snapshot, with the deployment's own process.env as the secret source.
    const flatEnv = childEnv({
      base: deploymentEnv,
      secrets: deploymentEnv,
      extraEnv: engineProvenanceEnv(engine),
    });

    // Nested path: spawnFleetChild's tenant-scrubbed env for the same launch.
    const nestedEnv = childEnv({
      base: deploymentEnv,
      secrets: { GH_TOKEN: "TENANT_TOKEN" },
      extraEnv: engineProvenanceEnv(engine),
    });

    for (const key of [
      BOOTSTRAP_RESOLVED_CONFIG_ENV,
      "PHOEBE_RUNNING_ENGINE_SOURCE",
      "PHOEBE_RUNNING_ENGINE_REPO",
      "PHOEBE_RUNNING_ENGINE_REF",
      "PHOEBE_RUNNING_ENGINE_SHA",
      "PHOEBE_BOOTSTRAP_VERSION",
      "PHOEBE_BASE_CONFIG",
    ]) {
      expect(nestedEnv[key]).toBe(flatEnv[key]);
    }
    // Never the deployment clone credential — only the tenant's own.
    expect(nestedEnv.GH_TOKEN).toBe("TENANT_TOKEN");
  });

  test("a nested launch quarantined by the crash-loop guard still parities PHOEBE_QUARANTINED_ENGINE_SHA", () => {
    const quarantinedEngine = { ...engine, quarantinedSha: "bad-sha" };
    const flatEnv = childEnv({
      base: deploymentEnv,
      secrets: deploymentEnv,
      extraEnv: engineProvenanceEnv(quarantinedEngine),
    });
    const nestedEnv = childEnv({
      base: deploymentEnv,
      secrets: { GH_TOKEN: "TENANT_TOKEN" },
      extraEnv: engineProvenanceEnv(quarantinedEngine),
    });
    expect(nestedEnv.PHOEBE_QUARANTINED_ENGINE_SHA).toBe("bad-sha");
    expect(nestedEnv.PHOEBE_QUARANTINED_ENGINE_SHA).toBe(flatEnv.PHOEBE_QUARANTINED_ENGINE_SHA);
  });

  test("the flat child's env is byte-identical to a plain process.env + provenance merge (#64)", () => {
    // Before #64, spawnSupervised passed `engineProvenanceEnv(engine)` straight
    // to spawnEngine, which merges it onto process.env internally
    // (`{ ...process.env, ...env }` in spawn-engine.mjs). childEnv's flat usage
    // (secrets: process.env) must reproduce exactly that, including unlisted
    // vars neither allowlist names.
    const realisticProcessEnv = {
      ...deploymentEnv,
      npm_config_yes: "true",
      RANDOM_UNLISTED_VAR: "still-here",
    };
    const provenanceEnv = engineProvenanceEnv(engine);
    const before = { ...realisticProcessEnv, ...provenanceEnv };
    const after = childEnv({
      base: realisticProcessEnv,
      secrets: realisticProcessEnv,
      extraEnv: provenanceEnv,
    });
    expect(after).toEqual(before);
  });
});

// --- which launches the crash-loop guard covers ------------------------------

describe("isMovingBranch", () => {
  const SHA = "a".repeat(40);
  const repo = "JesusFilm/phoebe";
  /** `git ls-remote <url> <ref>` output for a branch and for a tag. */
  const lsRemote = (refName: string) => () => `${SHA}\t${refName}\n`;
  const never = () => {
    throw new Error("ls-remote should not have been called");
  };

  test("a branch is watched, so the guard covers it", () => {
    expect(
      isMovingBranch(
        { source: "github", ref: "main", repo },
        undefined,
        lsRemote("refs/heads/main"),
      ),
    ).toBe(true);
  });

  test("a pinned SHA is inert — and costs no network call to establish", () => {
    // Pinning means pinning: an operator who named a commit gets that commit,
    // crash-looping and all, rather than a silently different one.
    expect(isMovingBranch({ source: "github", ref: SHA, repo }, undefined, never)).toBe(false);
  });

  test("a tag is inert too", () => {
    expect(
      isMovingBranch(
        { source: "github", ref: "v1.2.3", repo },
        undefined,
        lsRemote("refs/tags/v1.2.3"),
      ),
    ).toBe(false);
  });

  test("a local mount has no commit to fall back to", () => {
    expect(isMovingBranch({ source: "local" }, undefined, never)).toBe(false);
  });

  test("a remote that will not answer leaves the guard off rather than failing the launch", () => {
    // Materializing is about to make the same call and raise the real error.
    expect(
      isMovingBranch({ source: "github", ref: "main", repo }, undefined, () => {
        throw new Error("could not resolve host github.com");
      }),
    ).toBe(false);
  });
});

// --- GH_TOKEN → git credential helper at boot --------------------------------

describe("setupGitCredentials", () => {
  test("runs when token present", () => {
    const calls: string[][] = [];
    setupGitCredentials({
      token: "ghs_test",
      gh: (args) => {
        calls.push([...args]);
      },
    });
    expect(calls).toEqual([["auth", "setup-git", "--hostname", "github.com"]]);
  });

  test("skips when absent", () => {
    const calls: string[][] = [];
    setupGitCredentials({
      token: undefined,
      gh: (args) => {
        calls.push([...args]);
      },
    });
    expect(calls).toEqual([]);
  });

  test("warns on failure", () => {
    const warnings: string[] = [];
    setupGitCredentials({
      token: "ghs_test",
      gh: () => {
        throw new Error("gh not found");
      },
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/could not configure git credentials.*gh not found/);
  });
});
