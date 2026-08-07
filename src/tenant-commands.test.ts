// Multi-tenant lifecycle command tests (#63): add-repo / remove-repo / list /
// purge against temp config + data trees.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { STATUS_SNAPSHOT_FILE } from "./status-store.ts";

const fixtureRoot = join(import.meta.dirname, "..", "contracts", "fixtures", "status-v2");

/** Copy a published status-v2 corpus fixture in as one tenant's live snapshot. */
function installFixtureSnapshot(stateDir: string, name: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, STATUS_SNAPSHOT_FILE),
    readFileSync(join(fixtureRoot, `${name}.json`)),
  );
}
import {
  addRepo,
  defaultRepoUrl,
  isNested,
  listTenants,
  parseSlug,
  purgeTenant,
  readFlatRepoFields,
  removeRepo,
  renderTenantConfig,
  slugFromRemoteUrl,
  stripUrlCredentials,
} from "./tenant-commands.ts";

const MINIMAL_STATUS_V2 = {
  schemaVersion: "status-v2",
  updatedAt: "2026-07-30T12:00:00.000Z",
  runtime: {
    runtimeId: "runtime-1",
    instanceId: "instance-1",
    startedAt: "2026-07-30T12:00:00.000Z",
  },
  repository: { slug: "acme/widget", url: "https://github.com/acme/widget", defaultBranch: "main" },
  digests: {
    engine: "sha256:e",
    bootstrap: "sha256:b",
    config: "sha256:c",
    policy: "sha256:p",
    prompts: "sha256:pr",
    providerModel: "sha256:pm",
  },
  capabilities: ["status-v2"],
  lifecycle: { state: "idle" },
  activeWork: null,
  lastSuccess: null,
  lastFailure: null,
  control: {
    retry: { attempt: 0 },
    backoff: { active: false },
    quarantine: { active: false },
    drain: { requested: false },
  },
  health: { state: "healthy", telemetry: { writable: true, lastError: null, lastErrorAt: null } },
  journal: {
    earliestSequence: null,
    latestSequence: null,
    retainedSegments: 0,
    quarantinedTailCount: 0,
  },
  links: { repository: "https://github.com/acme/widget" },
};

let configDir: string;
let dataBase: string;
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "phoebe-cfg-"));
  dataBase = mkdtempSync(join(tmpdir(), "phoebe-data-"));
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(dataBase, { recursive: true, force: true });
});

describe("parseSlug / defaultRepoUrl / slugFromRemoteUrl", () => {
  test("splits a valid slug", () => {
    expect(parseSlug("acme/widget")).toEqual({ owner: "acme", repo: "widget" });
  });
  test("rejects malformed slugs", () => {
    for (const bad of ["widget", "a/b/c", "acme/", "/widget", "acme /widget"]) {
      expect(() => parseSlug(bad)).toThrow(/Invalid repo slug/);
    }
  });
  test("rejects `.`/`..` path segments (no traversal into add/remove/purge)", () => {
    // These match the char class but would escape the tenant tree / data base
    // once joined into a path (purgeTenant → rmSync). Must be refused.
    for (const bad of ["../x", "x/..", "../..", "./x", "x/.", "."]) {
      expect(() => parseSlug(bad)).toThrow(/Invalid repo slug/);
    }
    // A dot *inside* a segment is still fine — real repo names have them.
    expect(parseSlug("acme/foo.js")).toEqual({ owner: "acme", repo: "foo.js" });
  });
  test("derives the GitHub HTTPS url", () => {
    expect(defaultRepoUrl("acme/widget")).toBe("https://github.com/acme/widget.git");
  });
  test("slugFromRemoteUrl extracts owner/repo from common remote forms", () => {
    expect(slugFromRemoteUrl("https://github.com/acme/widget.git")).toBe("acme/widget");
    expect(slugFromRemoteUrl("git@github.com:acme/widget.git")).toBe("acme/widget");
  });
  test("slugFromRemoteUrl accepts scp remotes with a non-`git` username", () => {
    expect(slugFromRemoteUrl("deploy@git.example.com:acme/widget.git")).toBe("acme/widget");
  });
  test("slugFromRemoteUrl tolerates a terminal slash after `.git`", () => {
    expect(slugFromRemoteUrl("https://github.com/acme/widget.git/")).toBe("acme/widget");
    expect(slugFromRemoteUrl("git@github.com:acme/widget.git/")).toBe("acme/widget");
  });
});

describe("stripUrlCredentials", () => {
  test("removes userinfo from http(s) URLs so tokens never persist", () => {
    expect(stripUrlCredentials("https://x-access-token:ghs_tok@github.com/acme/widget.git")).toBe(
      "https://github.com/acme/widget.git",
    );
    expect(stripUrlCredentials("https://user:pw@github.com/acme/widget.git")).toBe(
      "https://github.com/acme/widget.git",
    );
  });
  test("leaves credential-free https and ssh remotes unchanged", () => {
    expect(stripUrlCredentials("https://github.com/acme/widget.git")).toBe(
      "https://github.com/acme/widget.git",
    );
    expect(stripUrlCredentials("git@github.com:acme/widget.git")).toBe(
      "git@github.com:acme/widget.git",
    );
  });
});

describe("renderTenantConfig", () => {
  test("carries the repo fields and NO engine field (engine is shared)", () => {
    const src = renderTenantConfig({
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
      installCommand: "pnpm i",
      checkCommand: "pnpm check",
      testCommand: "pnpm test",
    });
    expect(src).toContain('repoSlug: "acme/widget"');
    expect(src).toContain('installCommand: "pnpm i"');
    expect(src).not.toMatch(/\bengine\s*:/); // no engine field — engine source is shared
  });
});

describe("addRepo", () => {
  test("scaffolds repos/<owner>/<repo>/ with config + .env.example, and goes nested", () => {
    expect(isNested(configDir)).toBe(false);
    const result = addRepo({ configDir, slug: "acme/widget" });
    expect(result.tenantDir).toBe(join(configDir, "repos", "acme", "widget"));
    expect(existsSync(join(result.tenantDir, "phoebe.config.ts"))).toBe(true);
    expect(existsSync(join(result.tenantDir, ".env.example"))).toBe(true);
    expect(isNested(configDir)).toBe(true);
  });

  test("uses the derived url and default commands when none given", () => {
    const { tenantDir } = addRepo({ configDir, slug: "acme/widget" });
    const src = readFileSync(join(tenantDir, "phoebe.config.ts"), "utf8");
    expect(src).toContain("https://github.com/acme/widget.git");
    expect(src).toContain('installCommand: "npm ci"');
  });

  test("honors explicit url + commands (e.g. from --from-config)", () => {
    const { tenantDir } = addRepo({
      configDir,
      slug: "acme/widget",
      repoUrl: "git@example.com:acme/widget.git",
      installCommand: "pnpm install --frozen-lockfile",
    });
    const src = readFileSync(join(tenantDir, "phoebe.config.ts"), "utf8");
    expect(src).toContain("git@example.com:acme/widget.git");
    expect(src).toContain("pnpm install --frozen-lockfile");
  });

  test("seeds prompts only with withPrompts", () => {
    const seedPrompt = (dir: string): string[] => {
      mkdirSync(dir, { recursive: true });
      const p = join(dir, "issues-prompt.md");
      writeFileSync(p, "prompt");
      return [p];
    };
    const bare = addRepo({ configDir, slug: "acme/one" });
    expect(bare.created.some((p) => p.includes("prompts"))).toBe(false);
    const withP = addRepo({ configDir, slug: "acme/two", withPrompts: true, seedPrompt });
    expect(withP.created.some((p) => p.includes("prompts"))).toBe(true);
  });

  test("refuses to overwrite an existing tenant", () => {
    addRepo({ configDir, slug: "acme/widget" });
    expect(() => addRepo({ configDir, slug: "acme/widget" })).toThrow(/already exists/);
  });
});

describe("removeRepo", () => {
  test("deletes the tenant config dir", () => {
    const { tenantDir } = addRepo({ configDir, slug: "acme/widget" });
    removeRepo({ configDir, slug: "acme/widget" });
    expect(existsSync(tenantDir)).toBe(false);
  });
  test("throws for an unknown tenant", () => {
    expect(() => removeRepo({ configDir, slug: "acme/ghost" })).toThrow(/No tenant/);
  });
});

describe("listTenants", () => {
  test("reports config/env/retained-data per tenant, sorted", async () => {
    addRepo({ configDir, slug: "acme/widget" });
    addRepo({ configDir, slug: "acme/gadget" });
    // widget has a real .env and retained /data; gadget has neither.
    writeFileSync(join(configDir, "repos", "acme", "widget", ".env"), "GH_TOKEN=x");
    mkdirSync(join(dataBase, "acme", "widget"), { recursive: true });

    const listings = await listTenants({ configDir, dataBase });
    expect(listings.map((l) => l.slug)).toEqual(["acme/gadget", "acme/widget"]);
    const widget = listings.find((l) => l.slug === "acme/widget")!;
    expect(widget).toMatchObject({ configValid: true, envPresent: true, retainedData: true });
    const gadget = listings.find((l) => l.slug === "acme/gadget")!;
    expect(gadget).toMatchObject({ envPresent: false, retainedData: false });
  });

  test("reads the status-v2 contract snapshot when present", async () => {
    addRepo({ configDir, slug: "acme/widget" });
    const stateDir = join(dataBase, "acme", "widget", "state");
    installFixtureSnapshot(stateDir, "running");
    const [widget] = await listTenants({ configDir, dataBase });
    expect(widget?.status).toMatchObject({
      available: true,
      status: {
        lifecycle: { state: "running" },
        activeWork: { kind: "issues", issueNumber: 42 },
      },
    });
  });

  test("reduces a version-mismatched snapshot to an available:false result carrying the received version", async () => {
    addRepo({ configDir, slug: "acme/widget" });
    const stateDir = join(dataBase, "acme", "widget", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, STATUS_SNAPSHOT_FILE),
      JSON.stringify({ ...MINIMAL_STATUS_V2, schemaVersion: "status-v3" }),
    );
    const [widget] = await listTenants({ configDir, dataBase });
    expect(widget).toMatchObject({ configValid: true, envPresent: false, retainedData: true });
    expect(widget?.status).toEqual({
      available: false,
      reason: "unsupported-version",
      receivedVersion: "status-v3",
      message: expect.stringContaining("status-v3"),
    });
  });

  test("empty when there is no repos/ dir", async () => {
    expect(await listTenants({ configDir, dataBase })).toEqual([]);
  });

  test("workspace mode lists valid + broken + env-less children with health columns", async () => {
    // Root declares workspace mode (#83); children live as siblings of the root
    // config (not under repos/). Valid child has status + .env; env-less is
    // config-ok without secrets; broken fails loadRepoSlug → configValid false.
    writeFileSync(
      join(configDir, "phoebe.config.ts"),
      `export default { workspace: { depth: 1 }, engine: { source: "local" } };\n`,
    );
    mkdirSync(join(configDir, "valid"), { recursive: true });
    mkdirSync(join(configDir, "envless"), { recursive: true });
    mkdirSync(join(configDir, "broken"), { recursive: true });
    writeFileSync(join(configDir, "valid", "phoebe.config.ts"), "export default {};\n");
    writeFileSync(join(configDir, "envless", "phoebe.config.ts"), "export default {};\n");
    writeFileSync(join(configDir, "broken", "phoebe.config.ts"), "export default {};\n");
    writeFileSync(join(configDir, "valid", ".env"), "GH_TOKEN=x\n");
    const stateDir = join(dataBase, "acme", "valid", "state");
    installFixtureSnapshot(stateDir, "running");

    const listings = await listTenants({
      configDir,
      dataBase,
      loadRepoSlug: (path) => {
        const child = basename(dirname(path));
        if (child === "broken") throw new Error("parse failure");
        if (child === "valid") return "acme/valid";
        if (child === "envless") return "acme/envless";
        throw new Error(`unexpected path ${path}`);
      },
    });

    expect(listings.map((l) => l.slug)).toEqual(["acme/envless", "acme/valid", "broken"]);
    expect(listings.find((l) => l.slug === "acme/valid")).toMatchObject({
      configValid: true,
      envPresent: true,
      retainedData: true,
    });
    expect(listings.find((l) => l.slug === "acme/valid")?.status).toMatchObject({
      available: true,
      status: { lifecycle: { state: "running" }, activeWork: { kind: "issues", issueNumber: 42 } },
    });
    expect(listings.find((l) => l.slug === "acme/envless")).toMatchObject({
      configValid: true,
      envPresent: false,
      retainedData: false,
      status: { available: false, reason: "not-found" },
    });
    expect(listings.find((l) => l.slug === "broken")).toMatchObject({
      configValid: false,
      envPresent: false,
      retainedData: false,
      status: null,
    });
  });

  test("workspace block wins over a co-present repos/ tree (list ignores nested)", async () => {
    writeFileSync(join(configDir, "phoebe.config.ts"), `export default { workspace: {} };\n`);
    addRepo({ configDir, slug: "acme/nested-only" });
    mkdirSync(join(configDir, "child"), { recursive: true });
    writeFileSync(join(configDir, "child", "phoebe.config.ts"), "export default {};\n");

    const listings = await listTenants({
      configDir,
      dataBase,
      loadRepoSlug: () => "acme/child",
    });
    expect(listings.map((l) => l.slug)).toEqual(["acme/child"]);
  });

  test("surfaces the status-v2 queue lookahead when present", async () => {
    addRepo({ configDir, slug: "acme/widget" });
    const stateDir = join(dataBase, "acme", "widget", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, STATUS_SNAPSHOT_FILE),
      JSON.stringify({
        ...MINIMAL_STATUS_V2,
        queue: [
          { issueNumber: 100, blockedBy: [], workable: true },
          { issueNumber: 103, blockedBy: [100, 101], workable: false },
        ],
      }),
    );
    const [widget] = await listTenants({ configDir, dataBase });
    expect(widget?.queue).toEqual([
      { issueNumber: 100, blockedBy: [], workable: true },
      { issueNumber: 103, blockedBy: [100, 101], workable: false },
    ]);
  });

  test("defaults to an empty queue when no status-v2 snapshot exists yet", async () => {
    addRepo({ configDir, slug: "acme/widget" });
    const [widget] = await listTenants({ configDir, dataBase });
    expect(widget?.queue).toEqual([]);
  });
});

describe("purgeTenant", () => {
  test("wipes retained data for a removed tenant with --yes", () => {
    addRepo({ configDir, slug: "acme/widget" });
    mkdirSync(join(dataBase, "acme", "widget"), { recursive: true });
    removeRepo({ configDir, slug: "acme/widget" });

    const { purged } = purgeTenant({ configDir, dataBase, slug: "acme/widget", confirm: true });
    expect(purged).toBe(join(dataBase, "acme", "widget"));
    expect(existsSync(purged)).toBe(false);
  });

  test("refuses without confirm", () => {
    expect(() => purgeTenant({ configDir, dataBase, slug: "acme/widget", confirm: false })).toThrow(
      /without --yes/,
    );
  });

  test("refuses while a live config still exists", () => {
    addRepo({ configDir, slug: "acme/widget" });
    mkdirSync(join(dataBase, "acme", "widget"), { recursive: true });
    expect(() => purgeTenant({ configDir, dataBase, slug: "acme/widget", confirm: true })).toThrow(
      /still has a live config/,
    );
  });

  test("throws when there is no retained data", () => {
    expect(() => purgeTenant({ configDir, dataBase, slug: "acme/ghost", confirm: true })).toThrow(
      /No retained data/,
    );
  });
});

describe("readFlatRepoFields", () => {
  test("extracts install/check/test from a flat top config", () => {
    writeFileSync(
      join(configDir, "phoebe.config.ts"),
      `const config = {
        repoSlug: "acme/widget",
        installCommand: "pnpm install --frozen-lockfile",
        checkCommand: "pnpm run check",
        testCommand: "pnpm run test",
      };`,
    );
    expect(readFlatRepoFields(configDir)).toEqual({
      installCommand: "pnpm install --frozen-lockfile",
      checkCommand: "pnpm run check",
      testCommand: "pnpm run test",
    });
  });

  test("returns empty when the file is missing", () => {
    expect(readFlatRepoFields(configDir)).toEqual({});
  });
});
