// Fleet supervision tests (#58/#59): one child per tenant, hot add/remove/change,
// shared-engine relaunch-all, stop-drains-all, and per-tenant respawn of a child
// that died on its own — all driven through injected fakes (scripted children, a
// gated clock, a stop latch), no processes or real timers.

import { describe, expect, test } from "vite-plus/test";
import type { EngineExit, LaunchedEngine } from "./reconcile.ts";
import type { DiscoveredTenant, TenantSample } from "./tenants.ts";
import { superviseFleet, type DrainTimer, type FleetChild } from "./supervise-fleet.ts";

function tenant(slug: string): DiscoveredTenant {
  return {
    id: `/etc/phoebe/repos/${slug}`,
    slug,
    dir: `/etc/phoebe/repos/${slug}`,
    configPath: `/etc/phoebe/repos/${slug}/phoebe.config.ts`,
    envPath: `/etc/phoebe/repos/${slug}/.env`,
  };
}

function sample(slug: string, fingerprint: string | null): TenantSample {
  return { tenant: tenant(slug), fingerprint };
}

function fakeChild(): { child: FleetChild; kills: string[]; exit: (e?: EngineExit) => void } {
  const kills: string[] = [];
  let settle!: (e: EngineExit) => void;
  const exited = new Promise<EngineExit>((resolve) => {
    settle = resolve;
  });
  return {
    kills,
    // A drained child exits promptly on SIGTERM (its graceful drain), so
    // `kill` settles `exited` too — otherwise `drainAll` would await forever.
    child: {
      kill: (signal) => {
        kills.push(signal);
        settle({ code: 0, signal: null });
      },
      exited,
    },
    exit: (e = { code: 0, signal: null }) => settle(e),
  };
}

// A child that ignores SIGTERM — its work unit never finishes — so `exited`
// only settles once it is SIGKILLed. Exercises the drain escalation (#79).
function stubbornChild(): { child: FleetChild; kills: string[] } {
  const kills: string[] = [];
  let settle!: (e: EngineExit) => void;
  const exited = new Promise<EngineExit>((resolve) => {
    settle = resolve;
  });
  return {
    kills,
    child: {
      kill: (signal) => {
        kills.push(signal);
        if (signal === "SIGKILL") settle({ code: null, signal: "SIGKILL" });
      },
      exited,
    },
  };
}

// A gated cancelable timer standing in for the drain grace: nothing fires until
// `fireAll`, and a canceled timer stays quiet — so a test drives the escalation.
function gatedTimers(): { make: DrainTimer; fireAll: () => void; canceledCount: () => number } {
  const pending: Array<{ resolve: () => void; canceled: boolean }> = [];
  return {
    make: (_ms: number) => {
      const entry = { resolve: () => {}, canceled: false };
      const expired = new Promise<void>((resolve) => {
        entry.resolve = resolve;
      });
      pending.push(entry);
      return {
        expired,
        cancel: () => {
          entry.canceled = true;
        },
      };
    },
    fireAll: () => {
      for (const entry of pending) if (!entry.canceled) entry.resolve();
    },
    canceledCount: () => pending.filter((e) => e.canceled).length,
  };
}

function gatedClock(): { wait: () => Promise<void>; tick: () => void } {
  const pending: Array<() => void> = [];
  return {
    wait: () => new Promise<void>((resolve) => pending.push(resolve)),
    tick: () => {
      for (const resolve of pending.splice(0)) resolve();
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

function harness(initial: TenantSample[]) {
  const clock = gatedClock();
  const engineState = { config: "1:1", remoteSha: "a".repeat(40) };
  let tenants = [...initial];
  const spawned: Array<{ slug: string | null; fake: ReturnType<typeof fakeChild> }> = [];
  let stopRequested = false;
  let launches = 0;
  let throwOnDiscover = false;
  const discoverErrors: unknown[] = [];

  // A (re)materialized engine is checked out at the *current* tracked ref, so
  // its sha matches the ref at launch time — exactly what real materialization
  // does. (A hard-coded sha would make detectChange fire forever after a ref
  // move: sample.remoteSha would never equal the launched sha.)
  const engine = (): LaunchedEngine => ({
    entry: "/data/engine/src/cli.ts",
    sha: engineState.remoteSha,
    config: engineState.config,
    quarantinedSha: null,
    guarded: true,
    sample: () => ({ config: engineState.config, remoteSha: engineState.remoteSha }),
  });

  const result = superviseFleet({
    intervalMs: 1000,
    crashBackoffMs: 500,
    launch: () => {
      launches += 1;
      return engine();
    },
    discover: () => {
      if (throwOnDiscover) throw new Error("EACCES: repos/ momentarily unreadable");
      return tenants;
    },
    onDiscoverError: (e) => discoverErrors.push(e),
    spawn: (t) => {
      const fake = fakeChild();
      spawned.push({ slug: t.slug, fake });
      return fake.child;
    },
    stop: {
      get requested() {
        return stopRequested;
      },
      wait: clock.wait,
    },
  });

  return {
    result,
    spawned,
    get launches() {
      return launches;
    },
    setTenants: (next: TenantSample[]) => {
      tenants = next;
    },
    setThrowOnDiscover: (v: boolean) => {
      throwOnDiscover = v;
    },
    get discoverErrors() {
      return discoverErrors;
    },
    moveEngineRef: (sha: string) => {
      engineState.remoteSha = sha;
    },
    tick: clock.tick,
    requestStop: () => {
      stopRequested = true;
      clock.tick();
    },
  };
}

describe("superviseFleet", () => {
  test("spawns one child per discovered tenant at start", async () => {
    const h = harness([sample("acme/widget", "fp1"), sample("acme/gadget", "fp1")]);
    await settle();
    const slugs = h.spawned.map((s) => s.slug).sort((a, b) => (a ?? "").localeCompare(b ?? ""));
    expect(slugs).toEqual(["acme/gadget", "acme/widget"]);
  });

  test("hot-adds a tenant that appears", async () => {
    const h = harness([sample("acme/widget", "fp1")]);
    await settle();
    expect(h.spawned).toHaveLength(1);

    h.setTenants([sample("acme/widget", "fp1"), sample("acme/gadget", "fp1")]);
    h.tick();
    await settle();
    expect(h.spawned.map((s) => s.slug)).toContain("acme/gadget");
    expect(h.spawned).toHaveLength(2);
  });

  test("hot-removes a tenant that vanishes, draining its child", async () => {
    const h = harness([sample("acme/widget", "fp1"), sample("acme/gadget", "fp1")]);
    await settle();
    const gadget = h.spawned.find((s) => s.slug === "acme/gadget")!;

    h.setTenants([sample("acme/widget", "fp1")]);
    h.tick();
    await settle();
    expect(gadget.fake.kills).toContain("SIGTERM");
  });

  test("relaunches only the changed tenant on a config-fingerprint move", async () => {
    const h = harness([sample("acme/widget", "fp1"), sample("acme/gadget", "fp1")]);
    await settle();
    const widget = h.spawned.find((s) => s.slug === "acme/widget")!;

    h.setTenants([sample("acme/widget", "fp2"), sample("acme/gadget", "fp1")]);
    h.tick();
    await settle();
    expect(widget.fake.kills).toContain("SIGTERM"); // old child drained
    // A fresh widget child was spawned (2 initial + 1 relaunch = 3).
    expect(h.spawned.filter((s) => s.slug === "acme/widget")).toHaveLength(2);
    expect(h.spawned.filter((s) => s.slug === "acme/gadget")).toHaveLength(1); // untouched
  });

  test("a shared-engine ref move drains and respawns the whole fleet", async () => {
    const h = harness([sample("acme/widget", "fp1"), sample("acme/gadget", "fp1")]);
    await settle();
    const initial = [...h.spawned];

    h.moveEngineRef("b".repeat(40));
    h.tick();
    await settle();
    for (const s of initial) expect(s.fake.kills).toContain("SIGTERM");
    expect(h.launches).toBe(2); // re-materialized once
    expect(h.spawned).toHaveLength(4); // 2 initial + 2 respawned
  });

  test("a throwing discovery skips the tenant axis instead of draining the fleet", async () => {
    const h = harness([sample("acme/widget", "fp1"), sample("acme/gadget", "fp1")]);
    await settle();
    const initial = [...h.spawned];

    // A transient `repos/` read error (EACCES/EMFILE) → discover throws. The
    // supervisor must treat it as unknown state, not "every tenant removed".
    h.setThrowOnDiscover(true);
    h.tick();
    await settle();
    for (const s of initial) expect(s.fake.kills).toEqual([]); // nobody drained
    expect(h.discoverErrors).toHaveLength(1);

    // Recovers on the next good poll — no respawn churn (fleet was never torn down).
    h.setThrowOnDiscover(false);
    h.tick();
    await settle();
    expect(h.spawned).toHaveLength(2);
  });

  test("a hold id keeps a missing sample from draining (#86/#91)", async () => {
    const clock = gatedClock();
    const engineState = { config: "1:1", remoteSha: "a".repeat(40) };
    let samples: TenantSample[] = [sample("acme/widget", "fp1"), sample("acme/gadget", "fp1")];
    let hold: string[] = [];
    const spawned: Array<{ slug: string | null; fake: ReturnType<typeof fakeChild> }> = [];
    let stopRequested = false;

    const result = superviseFleet({
      intervalMs: 1000,
      crashBackoffMs: 500,
      launch: () => ({
        entry: "/data/engine/src/cli.ts",
        sha: engineState.remoteSha,
        config: engineState.config,
        quarantinedSha: null,
        guarded: true,
        sample: () => ({ config: engineState.config, remoteSha: engineState.remoteSha }),
      }),
      discover: () => ({ samples, hold }),
      spawn: (t) => {
        const fake = fakeChild();
        spawned.push({ slug: t.slug, fake });
        return fake.child;
      },
      stop: {
        get requested() {
          return stopRequested;
        },
        wait: clock.wait,
      },
    });

    await settle();
    expect(spawned).toHaveLength(2);
    const gadgetDir = tenant("acme/gadget").id;

    // Mid-rewrite: gadget disappears from samples but is marked held.
    samples = [sample("acme/widget", "fp1")];
    hold = [gadgetDir];
    clock.tick();
    await settle();
    const gadget = spawned.find((s) => s.slug === "acme/gadget")!;
    expect(gadget.fake.kills).toEqual([]);

    // Dir genuinely gone → drain.
    hold = [];
    clock.tick();
    await settle();
    expect(gadget.fake.kills).toContain("SIGTERM");

    stopRequested = true;
    clock.tick();
    for (const s of spawned) s.fake.exit();
    await result;
  });

  test("respawns a child that died on its own (per-tenant supervision)", async () => {
    const h = harness([sample("acme/widget", "fp1")]);
    await settle();
    const first = h.spawned[0]!;

    first.fake.exit({ code: 1, signal: null }); // crash
    await settle();
    h.tick(); // release the respawn backoff wait
    await settle();
    expect(h.spawned.filter((s) => s.slug === "acme/widget")).toHaveLength(2);
  });

  test("a container stop drains every child and resolves 0", async () => {
    const h = harness([sample("acme/widget", "fp1"), sample("acme/gadget", "fp1")]);
    await settle();
    const all = [...h.spawned];

    h.requestStop();
    // The drained children must settle their exits so drainAll resolves.
    for (const s of all) s.fake.exit();
    const exit = await h.result;
    expect(exit).toEqual({ code: 0, signal: null });
    for (const s of all) expect(s.fake.kills).toContain("SIGTERM");
  });

  test("SIGKILLs a child that ignores SIGTERM after the drain grace (#79)", async () => {
    const clock = gatedClock();
    const timers = gatedTimers();
    const stubborn = stubbornChild();
    const reaped: string[] = [];
    let stopRequested = false;

    const result = superviseFleet({
      intervalMs: 1000,
      drainTimer: timers.make,
      launch: () => ({
        entry: "/data/engine/src/cli.ts",
        sha: "a".repeat(40),
        config: "1:1",
        quarantinedSha: null,
        guarded: true,
        sample: () => ({ config: "1:1", remoteSha: "a".repeat(40) }),
      }),
      discover: () => [sample("acme/widget", "fp1")],
      spawn: () => stubborn.child,
      onReap: (id) => reaped.push(id),
      stop: {
        get requested() {
          return stopRequested;
        },
        wait: clock.wait,
      },
    });

    await settle();
    expect(stubborn.kills).toEqual([]);

    // Container stop → drainAll → drain sends SIGTERM, which this child ignores.
    stopRequested = true;
    clock.tick();
    await settle();
    expect(stubborn.kills).toEqual(["SIGTERM"]); // still waiting on the grace

    // The grace elapses → escalate to SIGKILL, which brings it down and lets
    // drain (and drainAll, and the supervisor) complete.
    timers.fireAll();
    const exit = await result;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(stubborn.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(reaped).toEqual([tenant("acme/widget").id]); // onReap still fires after kill
  });

  test("a graceful drain cancels the grace timer and never SIGKILLs (#79)", async () => {
    const clock = gatedClock();
    const timers = gatedTimers();
    const spawned: Array<ReturnType<typeof fakeChild>> = [];
    let stopRequested = false;

    const result = superviseFleet({
      intervalMs: 1000,
      drainTimer: timers.make,
      launch: () => ({
        entry: "/data/engine/src/cli.ts",
        sha: "a".repeat(40),
        config: "1:1",
        quarantinedSha: null,
        guarded: true,
        sample: () => ({ config: "1:1", remoteSha: "a".repeat(40) }),
      }),
      discover: () => [sample("acme/widget", "fp1")],
      spawn: () => {
        const fake = fakeChild();
        spawned.push(fake);
        return fake.child;
      },
      stop: {
        get requested() {
          return stopRequested;
        },
        wait: clock.wait,
      },
    });

    await settle();
    stopRequested = true;
    clock.tick();
    // A well-behaved child settles its exit on SIGTERM (fakeChild does).
    const exit = await result;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(spawned[0]!.kills).toEqual(["SIGTERM"]); // no SIGKILL
    expect(timers.canceledCount()).toBe(1); // grace timer was canceled, not left pending
  });
});
