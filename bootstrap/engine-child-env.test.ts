// Contract tests for the supervisor's per-tenant env scrub (#61 §1). Isolation
// is structural: each engine child gets a deny-by-default env built from an
// explicit allowlist plus *only* its own tenant's parsed `.env`. Tenant B's
// secrets and the deployment engine-clone credential must be structurally
// absent from tenant A's child env — never spread in, so fail-closed.

import { describe, expect, test } from "vite-plus/test";
import { buildEngineChildEnv } from "./engine-child-env.ts";

describe("buildEngineChildEnv", () => {
  const base = {
    PATH: "/usr/bin",
    HOME: "/home/phoebe",
    TZ: "UTC",
    GIT_AUTHOR_NAME: "Phoebe",
    GH_TOKEN: "DEPLOYMENT_CLONE_TOKEN",
    PHOEBE_POLL_INTERVAL_MS: "300000",
    PHOEBE_RECONCILE_INTERVAL_MS: "60000",
    PHOEBE_REPO_SLUG: "someone/else",
    SECRET_ON_SUPERVISOR: "leak-me",
  };

  test("passes PATH/HOME/git-identity and allowlisted deployment knobs through", () => {
    const env = buildEngineChildEnv({ base, tenantEnv: {} });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/phoebe");
    expect(env.GIT_AUTHOR_NAME).toBe("Phoebe");
    expect(env.PHOEBE_POLL_INTERVAL_MS).toBe("300000");
  });

  test("gives the child its own tenant's secrets", () => {
    const env = buildEngineChildEnv({
      base,
      tenantEnv: { GH_TOKEN: "TENANT_A_TOKEN", CURSOR_API_KEY: "TENANT_A_CURSOR" },
    });
    expect(env.GH_TOKEN).toBe("TENANT_A_TOKEN");
    expect(env.CURSOR_API_KEY).toBe("TENANT_A_CURSOR");
  });

  test("never spreads the supervisor's own process.env — deployment token fail-closed", () => {
    // The #60 engine-clone credential lives in the supervisor's GH_TOKEN. A
    // child that sets no tenant GH_TOKEN must NOT inherit the deployment one.
    const env = buildEngineChildEnv({ base, tenantEnv: { CURSOR_API_KEY: "x" } });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.SECRET_ON_SUPERVISOR).toBeUndefined();
  });

  test("does not leak config-overlay knobs that would corrupt a tenant's own config", () => {
    // PHOEBE_REPO_SLUG (and the other overlay keys) are per-tenant; passing the
    // supervisor's through would override every tenant identically.
    const env = buildEngineChildEnv({ base, tenantEnv: {} });
    expect(env.PHOEBE_REPO_SLUG).toBeUndefined();
  });

  test("tenant A's env never contains tenant B's secrets", () => {
    const a = buildEngineChildEnv({ base, tenantEnv: { GH_TOKEN: "A", CURSOR_API_KEY: "A_KEY" } });
    expect(a.GH_TOKEN).toBe("A");
    expect(Object.values(a)).not.toContain("B_KEY");
  });

  test("omits allowlisted keys that are absent or empty on the base", () => {
    const env = buildEngineChildEnv({ base: { PATH: "/bin", HOME: "" }, tenantEnv: {} });
    expect(env.PATH).toBe("/bin");
    expect("HOME" in env).toBe(false);
  });

  test("passes the generated base config path through (#38)", () => {
    const env = buildEngineChildEnv({
      base: { ...base, PHOEBE_BASE_CONFIG: "/etc/phoebe/generated-base.json" },
      tenantEnv: {},
    });
    expect(env.PHOEBE_BASE_CONFIG).toBe("/etc/phoebe/generated-base.json");
  });

  test("overlays extraEnv (per-launch provenance/snapshot) between the base allowlist and tenant secrets (#38)", () => {
    const env = buildEngineChildEnv({
      base,
      tenantEnv: { GH_TOKEN: "TENANT_TOKEN" },
      extraEnv: { PHOEBE_RUNNING_ENGINE_SOURCE: "github", GH_TOKEN: "SHOULD_NOT_WIN" },
    });
    expect(env.PHOEBE_RUNNING_ENGINE_SOURCE).toBe("github");
    // Tenant secrets still win over extraEnv on a collision.
    expect(env.GH_TOKEN).toBe("TENANT_TOKEN");
  });
});
