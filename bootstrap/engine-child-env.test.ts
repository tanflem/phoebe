// Contract tests for the one child-env builder every engine spawn path routes
// through (#64). Isolation is structural: each engine child gets an env built
// from an explicit allowlist plus *only* its own `secrets` source. Tenant B's
// secrets and the deployment engine-clone credential must be structurally
// absent from tenant A's child env — never spread in, so fail-closed.

import { describe, expect, test } from "vite-plus/test";
import { childEnv } from "./engine-child-env.ts";

describe("childEnv", () => {
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
    const env = childEnv({ base, secrets: {} });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/phoebe");
    expect(env.GIT_AUTHOR_NAME).toBe("Phoebe");
    expect(env.PHOEBE_POLL_INTERVAL_MS).toBe("300000");
  });

  test("gives the child its own tenant's secrets", () => {
    const env = childEnv({
      base,
      secrets: { GH_TOKEN: "TENANT_A_TOKEN", CURSOR_API_KEY: "TENANT_A_CURSOR" },
    });
    expect(env.GH_TOKEN).toBe("TENANT_A_TOKEN");
    expect(env.CURSOR_API_KEY).toBe("TENANT_A_CURSOR");
  });

  test("never spreads the caller's `base` env as secrets — deployment token fail-closed", () => {
    // The #60 engine-clone credential lives in the supervisor's GH_TOKEN. A
    // tenant child that sets no GH_TOKEN of its own must NOT inherit the
    // deployment one from `base`.
    const env = childEnv({ base, secrets: { CURSOR_API_KEY: "x" } });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.SECRET_ON_SUPERVISOR).toBeUndefined();
  });

  test("does not leak config-overlay knobs that would corrupt a tenant's own config", () => {
    // PHOEBE_REPO_SLUG (and the other overlay keys) are per-tenant; passing the
    // supervisor's through would override every tenant identically.
    const env = childEnv({ base, secrets: {} });
    expect(env.PHOEBE_REPO_SLUG).toBeUndefined();
  });

  test("tenant A's env never contains tenant B's secrets", () => {
    const a = childEnv({ base, secrets: { GH_TOKEN: "A", CURSOR_API_KEY: "A_KEY" } });
    expect(a.GH_TOKEN).toBe("A");
    expect(Object.values(a)).not.toContain("B_KEY");
  });

  test("omits allowlisted base keys that are absent or empty", () => {
    const env = childEnv({ base: { PATH: "/bin", HOME: "" }, secrets: {} });
    expect(env.PATH).toBe("/bin");
    expect("HOME" in env).toBe(false);
  });

  test("passes the generated base config path through (#38)", () => {
    const env = childEnv({
      base: { ...base, PHOEBE_BASE_CONFIG: "/etc/phoebe/generated-base.json" },
      secrets: {},
    });
    expect(env.PHOEBE_BASE_CONFIG).toBe("/etc/phoebe/generated-base.json");
  });

  test("overlays extraEnv (per-launch provenance/snapshot) between the base allowlist and secrets (#38)", () => {
    const env = childEnv({
      base,
      secrets: { GH_TOKEN: "TENANT_TOKEN" },
      extraEnv: { PHOEBE_RUNNING_ENGINE_SOURCE: "github", GH_TOKEN: "SHOULD_NOT_WIN" },
    });
    expect(env.PHOEBE_RUNNING_ENGINE_SOURCE).toBe("github");
    // Tenant secrets still win over extraEnv on a collision.
    expect(env.GH_TOKEN).toBe("TENANT_TOKEN");
  });

  test("flat's secret source is process.env itself, copied through byte-for-byte (#64)", () => {
    // The flat spawn path passes its own `process.env` as `secrets` — one
    // tenant is one trust domain, so the whole ambient env is the source, not
    // a scrubbed subset. Its superset swallows the base allowlist, and empty
    // values (a legitimate `FOO=` in a real env) survive rather than being
    // treated as unset.
    const flatProcessEnv = { ...base, EXTRA_UNLISTED_VAR: "value", EMPTY_BUT_SET: "" };
    const env = childEnv({ base: flatProcessEnv, secrets: flatProcessEnv });
    expect(env.EXTRA_UNLISTED_VAR).toBe("value");
    expect(env.EMPTY_BUT_SET).toBe("");
    expect(env.GH_TOKEN).toBe("DEPLOYMENT_CLONE_TOKEN");
  });
});
