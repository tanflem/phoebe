// The mode ladder (#66/#83, map #39): which topology a root config resolves
// to, and — the part #64/#98 end-to-end depend on — what cwd/argv each
// topology's spawn adapter hands the engine child. `launchTarget`/the crash
// guard's own behaviour stays covered by boot.test.ts / crash-loop.test.ts;
// this file is only the ladder + the two spawn adapters `resolveDeployment`
// (deployment.ts) newly exposes for direct testing.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import type { CrashGuard } from "./crash-loop.ts";
import { resolveDeployment, type Deployment } from "./deployment.ts";
import type { DiscoveredTenant } from "./tenants.ts";
import type { LaunchedEngine } from "./supervise.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phoebe-deployment-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeRootConfig(fields = ""): void {
  writeFileSync(join(dir, "phoebe.config.ts"), `export default {${fields}}`);
}

function writeChildConfig(at: string, fields: string): void {
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "phoebe.config.ts"), `export default {${fields}}`);
}

function fakeGuard(): CrashGuard {
  return {
    fallbackFor: () => null,
    record: () => {},
    noteAlive: () => {},
    shouldRetry: () => false,
  };
}

const stubEngine: LaunchedEngine = {
  entry: "/data/engine/src/cli.ts",
  sha: null,
  config: null,
  quarantinedSha: null,
  guarded: false,
  sample: () => ({ config: null, remoteSha: null }),
};

type EngineOpts = {
  env?: Record<string, string>;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onSpawnError?: (error: Error) => void;
};
type EngineChildOpts = EngineOpts & { cwd?: string };

function captureSpawnEngine(): {
  fn: (
    entry: string,
    args: readonly string[],
    opts: EngineOpts,
  ) => { kill: (s: NodeJS.Signals) => void };
  calls: { entry: string; args: readonly string[]; opts: EngineOpts }[];
} {
  const calls: { entry: string; args: readonly string[]; opts: EngineOpts }[] = [];
  return {
    calls,
    fn: (entry, args, opts) => {
      calls.push({ entry, args, opts });
      return { kill: () => {} };
    },
  };
}

function captureSpawnEngineChild(): {
  fn: (
    entry: string,
    args: readonly string[],
    opts: EngineChildOpts,
  ) => {
    kill: (s: NodeJS.Signals) => void;
    on: (event: string, listener: (...a: unknown[]) => void) => void;
  };
  calls: { entry: string; args: readonly string[]; opts: EngineChildOpts }[];
} {
  const calls: { entry: string; args: readonly string[]; opts: EngineChildOpts }[] = [];
  return {
    calls,
    fn: (entry, args, opts) => {
      calls.push({ entry, args, opts });
      return { kill: () => {}, on: () => {} };
    },
  };
}

/** Normalizes `children.discover()`'s three possible shapes to a tenant list. */
async function discoveredTenants(deployment: Deployment): Promise<DiscoveredTenant[]> {
  const raw = await deployment.children.discover();
  const samples = Array.isArray(raw) ? raw : raw.samples;
  return samples.map((s) => s.tenant);
}

async function withCapturedWarnings<T>(
  run: () => Promise<T>,
): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: string) => warnings.push(message);
  try {
    const result = await run();
    return { result, warnings };
  } finally {
    console.warn = original;
  }
}

describe("resolveDeployment: the detection ladder", () => {
  test("neither a `workspace` block nor a `repos/` dir selects flat", async () => {
    writeRootConfig();
    const deployment = await resolveDeployment({
      configDir: dir,
      env: {},
      argv: [],
      guard: fakeGuard(),
    });
    const tenants = await discoveredTenants(deployment);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]!.id).toBe(dir);
    expect(tenants[0]!.slug).toBeNull();
  });

  test("a `repos/` dir (no `workspace` block) selects nested", async () => {
    writeRootConfig();
    writeChildConfig(join(dir, "repos", "acme", "widget"), "");
    const deployment = await resolveDeployment({
      configDir: dir,
      env: {},
      argv: [],
      guard: fakeGuard(),
    });
    const tenants = await discoveredTenants(deployment);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]!.slug).toBe("acme/widget");
    expect(tenants[0]!.dir).toBe(join(dir, "repos", "acme", "widget"));
  });

  test("a `workspace` block selects workspace mode", async () => {
    writeRootConfig("workspace: {}");
    writeChildConfig(join(dir, "widget"), 'repoSlug: "acme/widget"');
    const deployment = await resolveDeployment({
      configDir: dir,
      env: {},
      argv: [],
      guard: fakeGuard(),
    });
    const tenants = await discoveredTenants(deployment);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]!.slug).toBe("acme/widget");
    expect(tenants[0]!.dir).toBe(join(dir, "widget"));
  });

  test("a `workspace` block plus a `repos/` dir warns and ignores `repos/`", async () => {
    writeRootConfig("workspace: {}");
    writeChildConfig(join(dir, "widget"), 'repoSlug: "acme/widget"');
    // A nested-style `repos/` tenant that must NOT be picked up.
    writeChildConfig(join(dir, "repos", "acme", "gadget"), "");

    const { result: deployment, warnings } = await withCapturedWarnings(() =>
      resolveDeployment({ configDir: dir, env: {}, argv: [], guard: fakeGuard() }),
    );
    const tenants = await discoveredTenants(deployment);

    expect(tenants.map((t) => t.slug)).toEqual(["acme/widget"]);
    expect(warnings.some((w) => /workspace block present.*ignoring `repos\/`/.test(w))).toBe(true);
  });
});

describe("resolveDeployment: spawn adapters (#64/#98)", () => {
  test("flat spawns with no explicit cwd and no --config — inherits process.cwd()", async () => {
    writeRootConfig();
    const engineSpawn = captureSpawnEngine();
    const deployment = await resolveDeployment({
      configDir: dir,
      env: {},
      argv: ["--run-once"],
      guard: fakeGuard(),
      spawnEngine: engineSpawn.fn,
    });
    const tenants = await discoveredTenants(deployment);
    deployment.children.spawn(tenants[0]!, stubEngine);

    expect(engineSpawn.calls).toHaveLength(1);
    const call = engineSpawn.calls[0]!;
    expect(call.args).toEqual(["--run-once"]);
    expect("cwd" in call.opts).toBe(false);
  });

  test("a co-located nested tenant spawns with cwd but no --config", async () => {
    writeRootConfig();
    writeChildConfig(join(dir, "repos", "acme", "widget"), "");
    const childSpawn = captureSpawnEngineChild();
    const deployment = await resolveDeployment({
      configDir: dir,
      env: {},
      argv: ["--run-once"],
      guard: fakeGuard(),
      spawnEngineChild: childSpawn.fn,
    });
    const tenants = await discoveredTenants(deployment);
    deployment.children.spawn(tenants[0]!, stubEngine);

    expect(childSpawn.calls).toHaveLength(1);
    const call = childSpawn.calls[0]!;
    expect(call.opts.cwd).toBe(tenants[0]!.dir);
    expect(call.args).toEqual(["--run-once"]);
  });

  test("a relocated (configDir) nested tenant spawns with cwd + --config (#98)", async () => {
    writeRootConfig();
    writeChildConfig(join(dir, "repos", "acme", "widget"), 'configDir: ".phoebe"');
    const childSpawn = captureSpawnEngineChild();
    const deployment = await resolveDeployment({
      configDir: dir,
      env: {},
      argv: ["--run-once"],
      guard: fakeGuard(),
      spawnEngineChild: childSpawn.fn,
    });
    const tenants = await discoveredTenants(deployment);
    const tenant = tenants[0]!;
    expect(tenant.envPath).toBe(join(tenant.dir, ".phoebe", ".env"));

    deployment.children.spawn(tenant, stubEngine);

    expect(childSpawn.calls).toHaveLength(1);
    const call = childSpawn.calls[0]!;
    expect(call.opts.cwd).toBe(join(tenant.dir, ".phoebe"));
    expect(call.args).toEqual(["--config", tenant.configPath, "--run-once"]);
  });

  test("a relocated (configDir) workspace tenant spawns with cwd + --config (#98)", async () => {
    writeRootConfig("workspace: {}");
    writeChildConfig(join(dir, "widget"), 'repoSlug: "acme/widget", configDir: ".phoebe"');
    const childSpawn = captureSpawnEngineChild();
    const deployment = await resolveDeployment({
      configDir: dir,
      env: {},
      argv: ["--run-once"],
      guard: fakeGuard(),
      spawnEngineChild: childSpawn.fn,
    });
    const tenants = await discoveredTenants(deployment);
    const tenant = tenants[0]!;

    deployment.children.spawn(tenant, stubEngine);

    expect(childSpawn.calls).toHaveLength(1);
    const call = childSpawn.calls[0]!;
    expect(call.opts.cwd).toBe(join(tenant.dir, ".phoebe"));
    expect(call.args).toEqual(["--config", tenant.configPath, "--run-once"]);
  });
});
