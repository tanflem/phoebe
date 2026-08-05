// Discovery tests (#58/#63/#91/#92): flat vs nested selection by `repos/`
// presence, the nested scan over `repos/<owner>/<repo>/`, workspace tree walk,
// origin cross-check, and fleet-level slug uniqueness.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  diffFleet,
  discoverTenants,
  discoverWorkspaceTenants,
  DuplicateOriginSlugError,
  DuplicateTenantSlugError,
  isNestedDeployment,
  slugFromUrl,
  TENANT_CONFIG_FILE,
  TENANT_ENV_FILE,
  type DiscoveredTenant,
} from "./tenants.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phoebe-tenants-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(at: string): void {
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, TENANT_CONFIG_FILE), "export default {}");
}

function writeSlugConfig(at: string, slug: string): void {
  mkdirSync(at, { recursive: true });
  writeFileSync(
    join(at, TENANT_CONFIG_FILE),
    `export default { repoSlug: ${JSON.stringify(slug)} }`,
  );
}

/** Injected origin map so tests never need a real git checkout. */
function origins(map: Record<string, string | null>): (tenantDir: string) => string | null {
  return (tenantDir) => (Object.hasOwn(map, tenantDir) ? map[tenantDir]! : null);
}

describe("slugFromUrl", () => {
  test("returns the same slug for SSH and HTTPS forms of one repo", () => {
    expect(slugFromUrl("git@github.com:acme/widget.git")).toBe("acme/widget");
    expect(slugFromUrl("https://github.com/acme/widget.git")).toBe("acme/widget");
    expect(slugFromUrl("https://github.com/acme/widget")).toBe("acme/widget");
    expect(slugFromUrl("git@github.com:acme/widget")).toBe("acme/widget");
  });

  test("strips .git and tolerates https credentials", () => {
    expect(slugFromUrl("https://x-access-token:ghs_x@github.com/acme/widget.git")).toBe(
      "acme/widget",
    );
  });

  test("returns null for empty, malformed, and non-GitHub URLs", () => {
    expect(slugFromUrl("")).toBeNull();
    expect(slugFromUrl("   ")).toBeNull();
    expect(slugFromUrl("not-a-url")).toBeNull();
    expect(slugFromUrl("git@gitlab.com:acme/widget.git")).toBeNull();
    expect(slugFromUrl("https://gitlab.com/acme/widget.git")).toBeNull();
    expect(slugFromUrl("https://github.com/only-owner")).toBeNull();
    expect(slugFromUrl("git@github.com:acme")).toBeNull();
  });
});

describe("flat mode", () => {
  test("no repos/ dir → one in-place tenant", () => {
    writeConfig(dir);
    const discovery = discoverTenants(dir);
    expect(discovery.mode).toBe("flat");
    expect(discovery.tenants).toHaveLength(1);
    const [tenant] = discovery.tenants;
    expect(tenant.dir).toBe(dir);
    expect(tenant.slug).toBeNull();
    expect(tenant.configPath).toBe(join(dir, TENANT_CONFIG_FILE));
    expect(tenant.envPath).toBe(join(dir, TENANT_ENV_FILE));
  });

  test("isNestedDeployment is false without repos/", () => {
    writeConfig(dir);
    expect(isNestedDeployment(dir)).toBe(false);
  });
});

describe("nested mode", () => {
  test("repos/ dir → one tenant per <owner>/<repo> with a config", () => {
    writeConfig(join(dir, "repos", "acme", "widget"));
    writeConfig(join(dir, "repos", "acme", "gadget"));
    writeConfig(join(dir, "repos", "globex", "thing"));

    const discovery = discoverTenants(dir);
    expect(discovery.mode).toBe("nested");
    expect(discovery.tenants.map((t) => t.slug)).toEqual([
      "acme/gadget",
      "acme/widget",
      "globex/thing",
    ]);
    const widget = discovery.tenants.find((t) => t.slug === "acme/widget");
    expect(widget?.dir).toBe(join(dir, "repos", "acme", "widget"));
    expect(widget?.id).toBe(widget?.dir);
  });

  test("a repo dir without a config is not a tenant", () => {
    writeConfig(join(dir, "repos", "acme", "widget"));
    mkdirSync(join(dir, "repos", "acme", "empty"), { recursive: true });
    const discovery = discoverTenants(dir);
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/widget"]);
  });

  test("an empty repos/ is a valid nested deployment with zero tenants", () => {
    mkdirSync(join(dir, "repos"), { recursive: true });
    const discovery = discoverTenants(dir);
    expect(discovery.mode).toBe("nested");
    expect(discovery.tenants).toEqual([]);
    expect(isNestedDeployment(dir)).toBe(true);
  });
});

describe("workspace mode", () => {
  test("depth 1 finds immediate children with a config; root is never a tenant", async () => {
    writeSlugConfig(join(dir, "widget"), "acme/widget");
    writeSlugConfig(join(dir, "gadget"), "acme/gadget");
    // Root config would be the workspace declaration — not a tenant even if present.
    writeSlugConfig(dir, "acme/workspace-root");

    const slugs = new Map([
      [join(dir, "widget", TENANT_CONFIG_FILE), "acme/widget"],
      [join(dir, "gadget", TENANT_CONFIG_FILE), "acme/gadget"],
      [join(dir, TENANT_CONFIG_FILE), "acme/workspace-root"],
    ]);
    const discovery = await discoverWorkspaceTenants(dir, 1, {
      loadRepoSlug: (path) => {
        const slug = slugs.get(path);
        if (!slug) throw new Error(`unexpected path ${path}`);
        return slug;
      },
      readOriginUrl: () => null,
    });
    expect(discovery.mode).toBe("workspace");
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/gadget", "acme/widget"]);
    expect(discovery.tenants.every((t) => t.dir !== dir)).toBe(true);
    expect(discovery.holdIds).toEqual([]);
  });

  test("depth 2 walks nested dirs and prunes at the first config hit", async () => {
    writeSlugConfig(join(dir, "apps", "widget"), "acme/widget");
    // Nested under a found tenant — must not be discovered (prune-at-first-hit).
    writeSlugConfig(join(dir, "apps", "widget", "nested"), "acme/nested");
    // Deeper than depth without an intermediate config needs depth ≥ remaining.
    writeSlugConfig(join(dir, "apps", "lib", "gadget"), "acme/gadget");

    const discovery = await discoverWorkspaceTenants(dir, 2, {
      loadRepoSlug: (path) => {
        if (path.includes("/nested/")) return "acme/nested";
        if (path.includes("widget")) return "acme/widget";
        if (path.includes("gadget")) return "acme/gadget";
        throw new Error(path);
      },
      readOriginUrl: () => null,
    });
    // depth 2: root→apps (no config)→widget (config, prune); root→apps→lib has no config
    // at depth budget remaining 0 under lib when depth is 2...
    // walk(root, 2): apps has no config → walk(apps, 1): widget has config → tenant;
    // lib has no config → walk(lib, 0) → stop. gadget at apps/lib/gadget needs depth 3.
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/widget"]);
    expect(discovery.tenants.find((t) => t.slug === "acme/nested")).toBeUndefined();

    const deep = await discoverWorkspaceTenants(dir, 3, {
      loadRepoSlug: (path) => {
        if (path.includes("/nested/")) return "acme/nested";
        if (path.includes("widget")) return "acme/widget";
        if (path.includes("gadget")) return "acme/gadget";
        throw new Error(path);
      },
      readOriginUrl: () => null,
    });
    expect(deep.tenants.map((t) => t.slug)).toEqual(["acme/gadget", "acme/widget"]);
  });

  test("skips broken children with a warning and continues", async () => {
    writeSlugConfig(join(dir, "good"), "acme/good");
    writeConfig(join(dir, "broken")); // present config, load fails
    const warnings: string[] = [];

    const discovery = await discoverWorkspaceTenants(dir, 1, {
      loadRepoSlug: (path) => {
        if (path.includes("broken")) throw new Error("parse failure");
        return "acme/good";
      },
      readOriginUrl: () => null,
      warn: (m) => warnings.push(m),
    });
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/good"]);
    expect(discovery.holdIds).toEqual([join(dir, "broken")]);
    expect(warnings.some((w) => /broken/.test(w) && /parse failure/.test(w))).toBe(true);
  });

  test("duplicate repoSlug is a fatal discovery error naming both paths", async () => {
    writeSlugConfig(join(dir, "a"), "acme/same");
    writeSlugConfig(join(dir, "b"), "acme/same");

    await expect(
      discoverWorkspaceTenants(dir, 1, {
        loadRepoSlug: () => "acme/same",
        readOriginUrl: () => null,
      }),
    ).rejects.toBeInstanceOf(DuplicateTenantSlugError);

    try {
      await discoverWorkspaceTenants(dir, 1, {
        loadRepoSlug: () => "acme/same",
        readOriginUrl: () => null,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateTenantSlugError);
      const dup = error as DuplicateTenantSlugError;
      expect(dup.slug).toBe("acme/same");
      expect(dup.paths).toContain(join(dir, "a"));
      expect(dup.paths).toContain(join(dir, "b"));
      expect(dup.message).toMatch(/duplicate repoSlug "acme\/same"/);
    }
  });

  test("origin mismatch with config repoSlug is skip-and-warn (config authoritative)", async () => {
    const good = join(dir, "good");
    const mismatch = join(dir, "mismatch");
    writeSlugConfig(good, "acme/good");
    writeSlugConfig(mismatch, "acme/configured");
    const warnings: string[] = [];

    const discovery = await discoverWorkspaceTenants(dir, 1, {
      loadRepoSlug: (path) => {
        if (path.includes("mismatch")) return "acme/configured";
        return "acme/good";
      },
      readOriginUrl: origins({
        [good]: "git@github.com:acme/good.git",
        [mismatch]: "https://github.com/acme/other.git",
      }),
      warn: (m) => warnings.push(m),
    });
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/good"]);
    expect(discovery.holdIds).toEqual([mismatch]);
    expect(
      warnings.some(
        (w) => w.includes("mismatch") && w.includes("acme/other") && w.includes("acme/configured"),
      ),
    ).toBe(true);
  });

  test("absent origin admits the child on config repoSlug authority", async () => {
    writeSlugConfig(join(dir, "orphan"), "acme/orphan");
    const warnings: string[] = [];

    const discovery = await discoverWorkspaceTenants(dir, 1, {
      loadRepoSlug: () => "acme/orphan",
      readOriginUrl: () => null,
      warn: (m) => warnings.push(m),
    });
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/orphan"]);
    expect(discovery.holdIds).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("malformed / non-GitHub origin is treated as absent and admits", async () => {
    writeSlugConfig(join(dir, "child"), "acme/child");
    const discovery = await discoverWorkspaceTenants(dir, 1, {
      loadRepoSlug: () => "acme/child",
      readOriginUrl: () => "https://gitlab.com/acme/child.git",
    });
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/child"]);
  });

  test("matching origin slug (SSH or HTTPS) admits the child", async () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    writeSlugConfig(a, "acme/widget");
    writeSlugConfig(b, "acme/gadget");

    const discovery = await discoverWorkspaceTenants(dir, 1, {
      loadRepoSlug: (path) =>
        path === join(a, TENANT_CONFIG_FILE) ? "acme/widget" : "acme/gadget",
      readOriginUrl: origins({
        [a]: "git@github.com:acme/widget.git",
        [b]: "https://github.com/acme/gadget",
      }),
    });
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/gadget", "acme/widget"]);
  });

  test("duplicate origin-slug across the fleet is a fatal discovery error", async () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    writeSlugConfig(a, "acme/one");
    writeSlugConfig(b, "acme/two");

    const loadSlug = (path: string): string =>
      path === join(a, TENANT_CONFIG_FILE) ? "acme/one" : "acme/two";
    const sameRemote = origins({
      // Same remote under different config slugs (SSH vs HTTPS normalises equal)
      [a]: "git@github.com:acme/shared.git",
      [b]: "https://github.com/acme/shared.git",
    });

    await expect(
      discoverWorkspaceTenants(dir, 1, {
        loadRepoSlug: loadSlug,
        readOriginUrl: sameRemote,
      }),
    ).rejects.toBeInstanceOf(DuplicateOriginSlugError);

    try {
      await discoverWorkspaceTenants(dir, 1, {
        loadRepoSlug: loadSlug,
        readOriginUrl: sameRemote,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateOriginSlugError);
      const dup = error as DuplicateOriginSlugError;
      expect(dup.originSlug).toBe("acme/shared");
      expect(dup.paths).toContain(a);
      expect(dup.paths).toContain(b);
      expect(dup.message).toMatch(/duplicate origin slug "acme\/shared"/);
    }
  });

  test("skips noise dirs (node_modules, .git, dotdirs)", async () => {
    writeSlugConfig(join(dir, "real"), "acme/real");
    writeSlugConfig(join(dir, "node_modules", "pkg"), "acme/pkg");
    writeSlugConfig(join(dir, ".git", "modules", "x"), "acme/git");
    writeSlugConfig(join(dir, ".hidden"), "acme/hidden");

    const discovery = await discoverWorkspaceTenants(dir, 2, {
      loadRepoSlug: (path) => {
        if (path.includes("real")) return "acme/real";
        throw new Error(`should not load ${path}`);
      },
      readOriginUrl: () => null,
    });
    expect(discovery.tenants.map((t) => t.slug)).toEqual(["acme/real"]);
  });
});

describe("diffFleet", () => {
  const tenant = (id: string): DiscoveredTenant => ({
    id,
    slug: id,
    dir: id,
    configPath: `${id}/phoebe.config.ts`,
    envPath: `${id}/.env`,
  });

  test("classifies added, removed, changed, and unchanged", () => {
    const previous = new Map<string, string | null>([
      ["a", "fp1"],
      ["b", "fp1"],
      ["c", "fp1"],
    ]);
    const diff = diffFleet(previous, [
      { tenant: tenant("a"), fingerprint: "fp1" }, // unchanged
      { tenant: tenant("b"), fingerprint: "fp2" }, // changed
      { tenant: tenant("d"), fingerprint: "fp1" }, // added
      // c removed
    ]);
    expect(diff.added.map((t) => t.id)).toEqual(["d"]);
    expect(diff.changed.map((t) => t.id)).toEqual(["b"]);
    expect(diff.removed).toEqual(["c"]);
  });

  test("a null fingerprint on either side is never a change", () => {
    const previous = new Map<string, string | null>([
      ["a", null],
      ["b", "fp1"],
    ]);
    const diff = diffFleet(previous, [
      { tenant: tenant("a"), fingerprint: "fp2" }, // prev null → not changed
      { tenant: tenant("b"), fingerprint: null }, // now null → not changed
    ]);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  test("empty previous → everything is added", () => {
    const diff = diffFleet(new Map(), [{ tenant: tenant("a"), fingerprint: "fp1" }]);
    expect(diff.added.map((t) => t.id)).toEqual(["a"]);
  });

  test("held ids are not removed when absent from the current sample (#86)", () => {
    const previous = new Map<string, string | null>([
      ["a", "fp1"],
      ["b", "fp1"],
    ]);
    // b is gone from samples (unreadable config mid-rewrite) but still present → hold
    const diff = diffFleet(previous, [{ tenant: tenant("a"), fingerprint: "fp1" }], new Set(["b"]));
    expect(diff.removed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  test("a held id that is no longer held is removed", () => {
    const previous = new Map<string, string | null>([
      ["a", "fp1"],
      ["b", "fp1"],
    ]);
    const diff = diffFleet(previous, [{ tenant: tenant("a"), fingerprint: "fp1" }], new Set());
    expect(diff.removed).toEqual(["b"]);
  });
});
