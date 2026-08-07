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
import { buildEngineChildEnv } from "./engine-child-env.ts";
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

// A nested-fleet child (spawnFleetChild) must receive the same
// deployment-critical vars as a flat-spawned child (spawnSupervised) for the
// same launch: engine provenance, the atomic resolved-config snapshot, and the
// generated base config (#38). Both spawn paths build their env from
// `engineProvenanceEnv`, so this pins that they cannot drift apart again.
describe("flat vs nested child-env parity (#38)", () => {
  test("a nested tenant's child env carries the same provenance + snapshot as the flat path's", () => {
    const engine = {
      source: { source: "github", repo: "JesusFilm/phoebe", ref: "main" } as const,
      sha: "abc123",
      quarantinedSha: null,
      resolvedConfiguration: '{"schemaVersion":1,"config":{}}',
    };

    // Flat path: spawnSupervised's env is exactly `engineProvenanceEnv(engine)`.
    const flatEnv = engineProvenanceEnv(engine);

    // Nested path: spawnFleetChild's tenant-scrubbed env for the same launch.
    const nestedEnv = buildEngineChildEnv({
      base: { PATH: "/usr/bin", PHOEBE_BASE_CONFIG: "/etc/phoebe/generated-base.json" },
      tenantEnv: { GH_TOKEN: "TENANT_TOKEN" },
      extraEnv: engineProvenanceEnv(engine),
    });

    for (const [key, value] of Object.entries(flatEnv)) {
      expect(nestedEnv[key]).toBe(value);
    }
    // The generated base config also reaches a nested child.
    expect(nestedEnv.PHOEBE_BASE_CONFIG).toBe("/etc/phoebe/generated-base.json");
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
