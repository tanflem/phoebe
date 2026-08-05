// Repo-governance guard for the nested (multi-tenant) dogfood under
// `.phoebe-nested/` (#77). The flat single-tenant dogfood (`.phoebe/`) is pinned
// by container-image.test.ts; this pins the *nested* layout the fleet path is
// dogfooded against — the one live exercise of discovery/supervision/isolation
// beyond the unit suite. If the layout drifts (a `repos/` dir renamed, a tenant
// config deleted, a stray per-tenant engine field added, the shared engine
// flipped off local) this fails loudly.
//
// It reads `.phoebe-nested/` straight off disk through the very functions boot
// uses (`discoverTenants`, `listTenants`), so it is CI-provable without Docker
// or a token. Lives under `src/` for the same reason as container-image.test.ts:
// test files never ship (package.json `files` excludes `**/*.test.ts`) and
// `vp test` already covers this tree.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { discoverTenants } from "../bootstrap/tenants.ts";
import { listTenants } from "./tenant-commands.ts";

const repoRoot = join(import.meta.dirname, "..");
const CONFIG_DIR = join(repoRoot, ".phoebe-nested");

/** The two tenants this deployment dogfoods, in `discoverTenants` sort order. */
const TENANTS = ["JesusFilm/phoebe", "JesusFilm/youtube-studio"] as const;

/** A config file with `//` comment lines stripped — assert on instructions, not
 * the prose, which necessarily says the word "engine" while explaining its
 * absence (mirrors container-image.test.ts's `instructionsOnly`). */
function code(relFromConfigDir: string): string {
  return readFileSync(join(CONFIG_DIR, relFromConfigDir), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

describe("the nested dogfood deployment (.phoebe-nested/)", () => {
  test("is a nested deployment of exactly the two intended tenants", () => {
    const discovery = discoverTenants(CONFIG_DIR);
    expect(discovery.mode).toBe("nested");
    expect(discovery.tenants.map((tenant) => tenant.slug)).toEqual([...TENANTS]);
  });

  test("shares one local engine, set once in the deployment-root config", () => {
    // The bootstrapper reads only `engine` from the root (#60); the dogfood runs
    // the engine from the working-tree mount, so the shared source is `local`.
    expect(code("phoebe.config.ts")).toMatch(/engine\s*:\s*\{\s*source\s*:\s*"local"\s*}/);
  });

  test("carries no per-tenant engine field — the engine source is shared (#60)", () => {
    for (const slug of TENANTS) {
      const config = code(join("repos", slug, "phoebe.config.ts"));
      expect(config).toContain(`repoSlug: "${slug}"`);
      expect(config).not.toMatch(/\bengine\s*:/);
    }
  });

  test("phoebe list enumerates both tenants, each with a valid config", async () => {
    // A data base that does not exist → no retained data / status, but the
    // config enumeration (what #62/#63 `phoebe list` reports) is filesystem-only.
    const listings = await listTenants({
      configDir: CONFIG_DIR,
      dataBase: join(CONFIG_DIR, "__absent_data_base__"),
    });
    expect(listings.map((listing) => listing.slug)).toEqual([...TENANTS]);
    for (const listing of listings) {
      expect(listing.configValid).toBe(true);
    }
  });

  test("ships a per-tenant .env.example (secrets stay out of git)", () => {
    for (const slug of TENANTS) {
      expect(existsSync(join(CONFIG_DIR, "repos", slug, ".env.example"))).toBe(true);
    }
  });

  // The nested compose reuses the flat dogfood image but necessarily re-declares
  // its own `volumes:`; compose has no cross-file anchor to share them. Nothing
  // else cross-checks the two files (unlike the two Dockerfiles, which
  // container-image.test.ts pins), so pin the one shape that must not drift: the
  // #62 two-volume layout + the read-only engine mount, in BOTH compose files.
  test("keeps the #62 two-volume layout in step with the flat dogfood compose", () => {
    const TWO_VOLUME_MOUNTS = [
      "phoebe-data:/data/repos",
      "phoebe-engine:/data/engine",
      "../..:/opt/phoebe-engine:ro",
    ] as const;
    const nested = readFileSync(join(CONFIG_DIR, "container", "compose.yml"), "utf8");
    const flat = readFileSync(join(repoRoot, ".phoebe", "container", "compose.yml"), "utf8");
    for (const mount of TWO_VOLUME_MOUNTS) {
      expect(nested).toContain(mount);
      expect(flat).toContain(mount);
    }
    // And it must reuse the flat image rather than declare a Dockerfile of its
    // own (a third image would escape container-image.test.ts's hardening guard).
    expect(nested).toContain("image: phoebe-runtime:dogfood");
    expect(nested).toContain("context: ../../.phoebe/container");
  });
});
