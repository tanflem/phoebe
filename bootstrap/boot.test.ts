// The `phoebe boot` source resolution. `boot` reads the mounted config, resolves
// the engine source, and turns it into the path it execs. This pins the `local`
// mount decision and which sources the crash-loop guard covers; the `github`
// source is materialized separately (github-engine.ts) and tested there, and the
// fallback policy itself lives in crash-loop.ts.

import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { isMovingBranch, LOCAL_ENGINE_DIR, observerEngineEnv, resolveEngineEntry } from "./boot.ts";
import type { LaunchedEngine } from "./reconcile.ts";

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

describe("observerEngineEnv", () => {
  const launched = (overrides: Partial<LaunchedEngine>): LaunchedEngine => ({
    entry: "/engine/src/cli.ts",
    source: { source: "github", repo: "JesusFilm/phoebe", ref: "main" },
    sha: "a".repeat(40),
    config: "1:2",
    quarantinedSha: null,
    guarded: true,
    sample: () => ({ config: "1:2", remoteSha: "a".repeat(40) }),
    ...overrides,
  });

  test("describes the configured source and exact running commit", () => {
    expect(observerEngineEnv(launched({}))).toEqual({
      PHOEBE_RUNNING_ENGINE_SOURCE: "github",
      PHOEBE_RUNNING_ENGINE_REPO: "JesusFilm/phoebe",
      PHOEBE_RUNNING_ENGINE_REF: "main",
      PHOEBE_RUNNING_ENGINE_SHA: "a".repeat(40),
    });
  });

  test("makes a crash-loop fallback explicit", () => {
    expect(
      observerEngineEnv(
        launched({
          sha: "a".repeat(40),
          quarantinedSha: "b".repeat(40),
        }),
      ),
    ).toMatchObject({
      PHOEBE_RUNNING_ENGINE_SHA: "a".repeat(40),
      PHOEBE_QUARANTINED_ENGINE_SHA: "b".repeat(40),
    });
  });

  test("local engines do not invent repo/ref/SHA provenance", () => {
    expect(
      observerEngineEnv(
        launched({
          source: { source: "local" },
          sha: null,
          quarantinedSha: null,
          guarded: false,
        }),
      ),
    ).toEqual({ PHOEBE_RUNNING_ENGINE_SOURCE: "local" });
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
