// The crash-loop fallback (#43): when a freshly-fetched engine SHA dies fast,
// over and over, `phoebe boot` stops chasing the tracked ref and pins back to
// the last SHA that ran healthily.
//
// The module's only exports are `createCrashGuard` and the `CrashGuard` type
// (#77) — the fold, the persisted record, and the wording an operator sees are
// all internal. So every case here drives the guard: a fake in-memory store
// keeps most of them fast and off the filesystem, and the guard's logged lines
// stand in for the old exported event stream — the tests capture lines and
// assert what an operator actually sees, same as boot.ts would. A handful of
// cases (storage) still use a real temp dir, because "survives a container
// restart" is a claim about a file.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { createCrashGuard, type CrashGuard } from "./crash-loop.ts";
import type { EngineRun, LaunchedEngine } from "./supervise.ts";

/** The store shape `createCrashGuard` accepts — not exported, so derived structurally. */
type CrashLoopStore = NonNullable<Parameters<typeof createCrashGuard>[0]["store"]>;

const BAD = "b".repeat(40);
const GOOD = "9".repeat(40);
const NEXT = "e".repeat(40);
const OTHER = "c".repeat(40);

// Mirrors the module's real defaults (bootstrap/crash-loop.ts) — not imported,
// since creating a guard no longer exposes them. Kept small here so the ladder
// tests run without waiting out a real 60s healthy window.
const THRESHOLD = 3;
const HEALTHY_MS = 1_000;

function launchedEngine(sha: string | null, guarded: boolean): LaunchedEngine {
  return {
    entry: "engine-entry",
    sha,
    config: null,
    sample: () => {
      throw new Error("not used in crash-guard tests");
    },
    quarantinedSha: null,
    guarded,
  };
}

/** A run that died on startup — the shape the fallback exists to catch. */
function crashRun(sha: string, opts: { guarded?: boolean } = {}): EngineRun {
  return {
    engine: launchedEngine(sha, opts.guarded ?? true),
    exit: { code: 1, signal: null },
    elapsedMs: 400,
    requestedStop: false,
  };
}

/** A run that lived past the healthy window. */
function healthyRun(sha: string, opts: { guarded?: boolean } = {}): EngineRun {
  return {
    engine: launchedEngine(sha, opts.guarded ?? true),
    exit: { code: 0, signal: null },
    elapsedMs: HEALTHY_MS * 2,
    requestedStop: false,
  };
}

/**
 * The single tenant every ladder test drives its roster through (#78): flat is
 * a fleet of one, so a one-tenant roster is what makes those tests exercise the
 * exact behaviour they did before breadth × count existed.
 */
const TENANT = "tenant-a";

/** A fake store good enough for a whole test — no filesystem involved. */
function fakeStore(): CrashLoopStore {
  let state: ReturnType<CrashLoopStore["read"]> = {
    lastGoodSha: null,
    failingSha: null,
    failureCount: 0,
    crashedTenants: [],
  };
  return {
    read: () => state,
    write: (next) => {
      state = next;
    },
  };
}

/** A guard over a fresh fake store, capturing every logged line. Defaults to a one-tenant roster. */
function guard(
  opts: {
    store?: CrashLoopStore;
    threshold?: number;
    healthyMs?: number;
    roster?: () => readonly string[];
  } = {},
) {
  const lines: string[] = [];
  const g = createCrashGuard({
    engineDir: "/unused",
    log: (line) => lines.push(line),
    store: opts.store ?? fakeStore(),
    threshold: opts.threshold ?? THRESHOLD,
    healthyMs: opts.healthyMs ?? HEALTHY_MS,
    roster: opts.roster ?? (() => [TENANT]),
  });
  return { g, lines };
}

/** Classify a logged line by which guard decision produced it, for readable assertions. */
function kindOf(line: string): string {
  if (line.includes("fast crash")) return "crash";
  if (line.includes("recorded as the crash-loop fallback target")) return "last-good";
  if (line.includes("falling back to last-good")) return "fallback";
  if (line.includes("crashed too")) return "fallback-crashed";
  if (line.includes("fallback lifted")) return "recovered";
  if (line.includes("could not write crash-loop state")) return "persist-failed";
  return `unrecognized: ${line}`;
}

describe("judging a finished run", () => {
  test("surviving the healthy window proves the commit, however the run then ended", () => {
    // The code booted and worked; whatever ended it inside the window is not a
    // bad deployment, and pinning to older code would not help.
    const { g, lines } = guard();
    g.record(
      {
        engine: launchedEngine(GOOD, true),
        exit: { code: 1, signal: null },
        elapsedMs: HEALTHY_MS,
        requestedStop: true,
      },
      TENANT,
    );
    expect(lines.map(kindOf)).toEqual(["last-good"]);
  });

  test("exiting 0 unprompted proves it too — it finished what it was asked to do", () => {
    const { g, lines } = guard();
    g.record(
      {
        engine: launchedEngine(GOOD, true),
        exit: { code: 0, signal: null },
        elapsedMs: 5,
        requestedStop: false,
      },
      TENANT,
    );
    expect(lines.map(kindOf)).toEqual(["last-good"]);
  });

  test("a fast non-zero exit is a crash", () => {
    const { g, lines } = guard();
    g.record(crashRun(BAD), TENANT);
    expect(lines.map(kindOf)).toEqual(["crash"]);
  });

  test("a run boot cut short proves nothing either way", () => {
    // This is the dangerous case: a container stop landing seconds into a
    // relaunch of a crash-looping commit. Crediting that exit as healthy would
    // promote the bad commit to last-good and disarm the fallback for good.
    const { g, lines } = guard();
    g.record(
      {
        engine: launchedEngine(BAD, true),
        exit: { code: 0, signal: null },
        elapsedMs: 5,
        requestedStop: true,
      },
      TENANT,
    );
    expect(lines).toEqual([]);
  });

  test("a signal death says nothing about the code", () => {
    // Something outside killed the process — an OOM reaper, a `docker kill`.
    const { g, lines } = guard();
    g.record(
      {
        engine: launchedEngine(BAD, true),
        exit: { code: null, signal: "SIGKILL" },
        elapsedMs: 5,
        requestedStop: false,
      },
      TENANT,
    );
    expect(lines).toEqual([]);
  });
});

describe("folding a run into the record", () => {
  const crashToThreshold = (
    g: CrashGuard,
    sha: string,
    times = THRESHOLD,
    tenantId: string = TENANT,
  ) => {
    for (let i = 0; i < times; i++) g.record(crashRun(sha), tenantId);
  };

  test("a healthy run becomes the fallback target", () => {
    const { g } = guard();
    g.record(healthyRun(GOOD), TENANT);
    crashToThreshold(g, BAD);
    expect(g.fallbackFor(BAD)).toBe(GOOD);
  });

  test("a fast crash opens a count against its own sha", () => {
    const { g, lines } = guard();
    g.record(healthyRun(GOOD), TENANT);
    g.record(crashRun(BAD), TENANT);
    expect(lines.at(-1)).toContain(`fast crash 1/${THRESHOLD}`);
  });

  test("consecutive crashes of the same sha accumulate toward the threshold", () => {
    const { g, lines } = guard();
    crashToThreshold(g, BAD);
    expect(lines).toEqual([
      expect.stringContaining(`fast crash 1/${THRESHOLD}`),
      expect.stringContaining(`fast crash 2/${THRESHOLD}`),
      expect.stringContaining(`fast crash 3/${THRESHOLD}`),
    ]);
  });

  test("a crash of a different sha starts its own count", () => {
    // The branch moved while the old commit was failing; the new commit gets a
    // clean slate rather than inheriting a verdict it did not earn.
    const { g, lines } = guard();
    g.record(healthyRun(GOOD), TENANT);
    g.record(crashRun(BAD), TENANT);
    g.record(crashRun(BAD), TENANT);
    lines.length = 0;
    g.record(crashRun(NEXT), TENANT);
    expect(lines.at(-1)).toContain(`engine ${NEXT}`);
    expect(lines.at(-1)).toContain(`fast crash 1/${THRESHOLD}`);
  });

  test("a healthy fallback run keeps the crash-looping sha quarantined", () => {
    // The engine is running GOOD *because* BAD is quarantined. Letting a healthy
    // fallback run clear the record would send boot straight back into BAD.
    const { g, lines } = guard();
    g.record(healthyRun(GOOD), TENANT);
    crashToThreshold(g, BAD);
    expect(g.fallbackFor(BAD)).toBe(GOOD);

    lines.length = 0;
    g.record(healthyRun(GOOD), TENANT);
    expect(lines).toEqual([]); // lastGoodSha did not change — nothing to announce
    expect(g.fallbackFor(BAD)).toBe(GOOD);
  });

  test("a healthy run of the failing sha itself lifts the quarantine", () => {
    // Whatever was wrong was transient, not the commit — stop avoiding it.
    const { g } = guard();
    g.record(healthyRun(GOOD), TENANT);
    g.record(crashRun(BAD), TENANT);
    g.record(crashRun(BAD), TENANT);
    g.record(healthyRun(BAD), TENANT);
    expect(g.fallbackFor(BAD)).toBeNull();
  });

  test("an inconclusive run leaves the record exactly as it was", () => {
    // A container stop landing during a crash-loop must not credit the crashing
    // commit — that would disarm the fallback permanently.
    const { g } = guard();
    g.record(healthyRun(GOOD), TENANT);
    g.record(crashRun(BAD), TENANT);
    g.record(crashRun(BAD), TENANT);
    g.record(
      {
        engine: launchedEngine(BAD, true),
        exit: { code: 0, signal: null },
        elapsedMs: 5,
        requestedStop: true,
      },
      TENANT,
    );
    // One more real crash reaches the threshold, proving the inconclusive run
    // above neither advanced nor reset the count.
    g.record(crashRun(BAD), TENANT);
    expect(g.fallbackFor(BAD)).toBe(GOOD);
  });

  test("the fallback crashing too does not release the quarantine", () => {
    // Boot is running GOOD *because* BAD is quarantined. If GOOD dies as well,
    // the honest answer is "out of options" — not "BAD is fine again".
    const { g, lines } = guard();
    g.record(healthyRun(GOOD), TENANT);
    crashToThreshold(g, BAD);
    lines.length = 0;
    g.record(crashRun(GOOD), TENANT);
    expect(lines.map(kindOf)).toEqual(["fallback-crashed"]);
    expect(g.fallbackFor(BAD)).toBe(GOOD);
  });
});

describe("choosing what to run instead of a crash-looping tip", () => {
  test("below the threshold the target still gets to run", () => {
    // A single startup crash may be a flaky network or a busy host; give the
    // configured ref its full allowance before pinning away from it.
    const { g } = guard();
    g.record(healthyRun(GOOD), TENANT);
    g.record(crashRun(BAD), TENANT);
    g.record(crashRun(BAD), TENANT);
    expect(g.fallbackFor(BAD)).toBeNull();
  });

  test("at the threshold the last-good sha takes over", () => {
    const { g } = guard();
    g.record(healthyRun(GOOD), TENANT);
    for (let i = 0; i < THRESHOLD; i++) g.record(crashRun(BAD), TENANT);
    expect(g.fallbackFor(BAD)).toBe(GOOD);
  });

  test("with nothing known-good there is nowhere to fall back to", () => {
    // First boot of a fresh volume: the very first ref crash-loops and no
    // earlier commit was ever proven. Boot must fail loudly, not invent a pin.
    const { g } = guard();
    for (let i = 0; i < THRESHOLD + 6; i++) g.record(crashRun(BAD), TENANT);
    expect(g.fallbackFor(BAD)).toBeNull();
  });

  test("falling back to the crashing sha itself would change nothing", () => {
    const { g } = guard();
    g.record(healthyRun(BAD), TENANT);
    for (let i = 0; i < THRESHOLD + 6; i++) g.record(crashRun(BAD), TENANT);
    expect(g.fallbackFor(BAD)).toBeNull();
  });

  test("a quarantine on some other sha does not divert this one", () => {
    // The branch advanced past the bad commit — reconcile resumes normally.
    const { g } = guard();
    g.record(healthyRun(GOOD), TENANT);
    for (let i = 0; i < THRESHOLD + 6; i++) g.record(crashRun(BAD), TENANT);
    expect(g.fallbackFor(NEXT)).toBeNull();
  });
});

describe("is relaunching worth it", () => {
  test("a different known-good sha is worth relaunching for", () => {
    const { g } = guard();
    g.record(healthyRun(GOOD), TENANT);
    expect(g.shouldRetry(crashRun(BAD))).toBe(true);
  });

  test("nothing known-good means retrying is pointless", () => {
    const { g } = guard();
    expect(g.shouldRetry(crashRun(BAD))).toBe(false);
  });

  test("the known-good sha crashing is the end of the road", () => {
    // The fallback itself died fast; boot has run out of better ideas and lets
    // the container exit rather than looping on the same commit forever.
    const { g } = guard();
    g.record(healthyRun(GOOD), TENANT);
    expect(g.shouldRetry(crashRun(GOOD))).toBe(false);
  });
});

describe("the ladder, end to end", () => {
  test("three fast crashes pin to last-good, and the branch moving on releases it", () => {
    const { g } = guard();
    g.record(healthyRun(GOOD), TENANT);

    for (let i = 1; i <= THRESHOLD; i++) {
      expect(g.fallbackFor(BAD)).toBeNull();
      g.record(crashRun(BAD), TENANT);
    }

    // Threshold reached: boot runs GOOD instead of the tracked ref's tip.
    expect(g.fallbackFor(BAD)).toBe(GOOD);
    g.record(healthyRun(GOOD), TENANT);
    expect(g.fallbackFor(BAD)).toBe(GOOD);

    // A fix lands and the branch advances: the new tip is not quarantined, so
    // the fallback lapses and the new commit runs.
    expect(g.fallbackFor(NEXT)).toBeNull();
    g.record(healthyRun(NEXT), TENANT);

    // NEXT is last-good now: a fresh bad commit's fallback target is NEXT, not
    // the now-stale GOOD.
    for (let i = 0; i < THRESHOLD; i++) g.record(crashRun(OTHER), TENANT);
    expect(g.fallbackFor(OTHER)).toBe(NEXT);
  });
});

describe("where the record lives", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "crash-guard-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const realGuard = (engineDir: string) =>
    createCrashGuard({
      engineDir,
      log: () => {},
      threshold: THRESHOLD,
      healthyMs: HEALTHY_MS,
      roster: () => [TENANT],
    });

  test("the record lives at <engineDir>/engine-crash-loop.json", () => {
    realGuard(dir).record(healthyRun(GOOD), TENANT);
    expect(JSON.parse(readFileSync(join(dir, "engine-crash-loop.json"), "utf8"))).toEqual({
      lastGoodSha: GOOD,
      failingSha: null,
      failureCount: 0,
      crashedTenants: [],
    });
  });

  test("an explicit engine dir is honored, not a hardcoded default", () => {
    const dirA = join(dir, "a");
    const dirB = join(dir, "b");
    realGuard(dirA).record(healthyRun(GOOD), TENANT);
    expect(existsSync(join(dirA, "engine-crash-loop.json"))).toBe(true);
    expect(existsSync(join(dirB, "engine-crash-loop.json"))).toBe(false);
  });

  test("writing creates the state dir when the volume is empty", () => {
    const nested = join(dir, "not-yet-created");
    realGuard(nested).record(healthyRun(GOOD), TENANT);
    expect(existsSync(join(nested, "engine-crash-loop.json"))).toBe(true);
  });

  test("state written by one boot is read back by the next", () => {
    // This is the whole "survives a container restart" claim.
    const first = realGuard(dir);
    first.record(healthyRun(GOOD), TENANT);
    for (let i = 0; i < THRESHOLD; i++) first.record(crashRun(BAD), TENANT);

    expect(realGuard(dir).fallbackFor(BAD)).toBe(GOOD);
  });

  test("no file yet means nothing is known — not an error", () => {
    const g = realGuard(dir);
    expect(g.fallbackFor(BAD)).toBeNull();
    expect(g.shouldRetry(crashRun(BAD))).toBe(false);
  });

  test("an unparseable file is discarded rather than crashing boot", () => {
    // A half-written file (container killed mid-write) must not brick the
    // bootstrapper; the worst case is losing one fallback target.
    writeFileSync(join(dir, "engine-crash-loop.json"), "{ not json");
    const g = realGuard(dir);
    expect(g.fallbackFor(BAD)).toBeNull();
    expect(g.shouldRetry(crashRun(BAD))).toBe(false);
  });

  test("a file of the wrong shape is discarded too", () => {
    writeFileSync(
      join(dir, "engine-crash-loop.json"),
      JSON.stringify({ lastGoodSha: 12, failureCount: "many" }),
    );
    const g = realGuard(dir);
    expect(g.fallbackFor(BAD)).toBeNull();
    expect(g.shouldRetry(crashRun(BAD))).toBe(false);
  });

  test("an unrecognised persisted shape (the pre-#78 record) degrades to nothing known", () => {
    // Not versioned: a record written before `crashedTenants` existed is just
    // another shape `isCrashLoopState` does not recognise. The upgrade costs
    // one fallback target — GOOD is forgotten too, not only the crash count.
    writeFileSync(
      join(dir, "engine-crash-loop.json"),
      JSON.stringify({ lastGoodSha: GOOD, failingSha: BAD, failureCount: THRESHOLD }),
    );
    const g = realGuard(dir);
    expect(g.condemns(BAD)).toBe(false);
    expect(g.fallbackFor(BAD)).toBeNull();
    expect(g.shouldRetry(crashRun(BAD))).toBe(false);
  });
});

describe("createCrashGuard", () => {
  test("a healthy engine leaves the guard with nothing to do", () => {
    const { g, lines } = guard();
    g.record(healthyRun(GOOD), TENANT);
    expect(g.fallbackFor(GOOD)).toBeNull();
    expect(g.shouldRetry(healthyRun(GOOD))).toBe(false);
    expect(lines.map(kindOf)).toEqual(["last-good"]);
  });

  test("a crash-looping tip is pinned to the last-good commit once the threshold is met", () => {
    const { g, lines } = guard();
    g.record(healthyRun(GOOD), TENANT);

    for (let i = 1; i <= THRESHOLD; i++) {
      expect(g.fallbackFor(BAD)).toBeNull();
      // Worth another go: there is a better commit to end up on.
      expect(g.shouldRetry(crashRun(BAD))).toBe(true);
      g.record(crashRun(BAD), TENANT);
    }

    expect(g.fallbackFor(BAD)).toBe(GOOD);
    expect(lines.map(kindOf)).toEqual(["last-good", "crash", "crash", "crash", "fallback"]);
    expect(lines.at(-1)).toContain(`engine ${BAD}`);
    expect(lines.at(-1)).toContain(`last-good ${GOOD}`);
  });

  test("a fresh guard reading from the same store sees the same verdict", () => {
    // A new boot, same state volume: it must not have to re-learn the crash.
    const store = fakeStore();
    const first = createCrashGuard({
      engineDir: "/unused",
      log: () => {},
      store,
      threshold: THRESHOLD,
      healthyMs: HEALTHY_MS,
      roster: () => [TENANT],
    });
    first.record(healthyRun(GOOD), TENANT);
    for (let i = 0; i < THRESHOLD; i++) first.record(crashRun(BAD), TENANT);

    const lines: string[] = [];
    const second = createCrashGuard({
      engineDir: "/unused",
      log: (line) => lines.push(line),
      store,
      threshold: THRESHOLD,
      healthyMs: HEALTHY_MS,
      roster: () => [TENANT],
    });
    expect(second.fallbackFor(BAD)).toBe(GOOD);
    expect(lines.map(kindOf)).toEqual(["fallback"]);
  });

  test("running the fallback does not un-quarantine the bad commit", () => {
    const { g } = guard();
    g.record(healthyRun(GOOD), TENANT);
    for (let i = 0; i < THRESHOLD; i++) g.record(crashRun(BAD), TENANT);

    g.record(healthyRun(GOOD), TENANT);
    expect(g.fallbackFor(BAD)).toBe(GOOD);
  });

  test("the tracked ref moving past the bad commit lifts the fallback, once", () => {
    const { g, lines } = guard();
    g.record(healthyRun(GOOD), TENANT);
    for (let i = 0; i < THRESHOLD; i++) g.record(crashRun(BAD), TENANT);
    expect(g.fallbackFor(BAD)).toBe(GOOD);

    lines.length = 0;
    // A fix landed; the tip is a commit nobody has a verdict on, so it runs.
    expect(g.fallbackFor(NEXT)).toBeNull();
    expect(lines.map(kindOf)).toEqual(["recovered"]);

    // And the stale quarantine is gone rather than being re-announced forever.
    lines.length = 0;
    expect(g.fallbackFor(NEXT)).toBeNull();
    expect(lines).toEqual([]);
  });

  test("a crash with nothing known-good is not worth retrying", () => {
    // First boot onto a broken ref: there is no better commit to reach, so boot
    // lets the container exit where an operator can see it.
    const { g } = guard();
    expect(g.shouldRetry(crashRun(BAD))).toBe(false);
  });

  test("the fallback crashing too is the end of the road, and BAD stays quarantined", () => {
    const { g, lines } = guard();
    g.record(healthyRun(GOOD), TENANT);
    for (let i = 0; i < THRESHOLD; i++) g.record(crashRun(BAD), TENANT);
    expect(g.fallbackFor(BAD)).toBe(GOOD);

    expect(g.shouldRetry(crashRun(GOOD))).toBe(false);
    lines.length = 0;
    g.record(crashRun(GOOD), TENANT);
    expect(lines.map(kindOf)).toEqual(["fallback-crashed"]);
    // The container exits and comes back onto the same bad tip; the pin holds.
    expect(g.fallbackFor(BAD)).toBe(GOOD);
  });

  test("a long-running engine is banked as last-good while it is still running", () => {
    // An engine up for a month that is then killed outright (host reboot, OOM)
    // exits without ever being judged. Without this, the bad commit waiting on
    // the branch would have nothing to fall back to.
    const { g, lines } = guard();
    g.noteAlive(GOOD, HEALTHY_MS);
    expect(lines.map(kindOf)).toEqual(["last-good"]);

    // Only once, though — every poll tick calls this.
    lines.length = 0;
    g.noteAlive(GOOD, HEALTHY_MS * 10);
    expect(lines).toEqual([]);
  });

  test("a young engine has not proved anything yet", () => {
    const { g, lines } = guard();
    g.noteAlive(BAD, HEALTHY_MS - 1);
    expect(lines).toEqual([]);
    expect(g.fallbackFor(BAD)).toBeNull();
  });

  test("an engine outliving the window while a commit is quarantined keeps the quarantine", () => {
    const { g } = guard();
    g.record(healthyRun(GOOD), TENANT);
    for (let i = 0; i < THRESHOLD; i++) g.record(crashRun(BAD), TENANT);

    // The fallback run of GOOD survives the window — that must not free BAD.
    g.noteAlive(GOOD, HEALTHY_MS * 5);
    expect(g.fallbackFor(BAD)).toBe(GOOD);
  });

  test("a healthy exit is never a reason to relaunch", () => {
    const { g } = guard();
    g.record(healthyRun(GOOD), TENANT);
    expect(
      g.shouldRetry({
        engine: launchedEngine(BAD, true),
        exit: { code: 0, signal: null },
        elapsedMs: 5,
        requestedStop: false,
      }),
    ).toBe(false);
  });

  test("a run boot cut short is not a reason to relaunch either", () => {
    // Boot is already deciding what happens next; a stop is not a crash.
    const { g } = guard();
    g.record(healthyRun(GOOD), TENANT);
    expect(
      g.shouldRetry({
        engine: launchedEngine(BAD, true),
        exit: { code: 1, signal: null },
        elapsedMs: 5,
        requestedStop: true,
      }),
    ).toBe(false);
  });

  test("an unwritable state dir is reported, not thrown — boot still runs", () => {
    // The state volume is missing or read-only. Losing the fallback is bad;
    // refusing to run the engine over it would be worse. Provoked with a
    // throwing fake store rather than a chmod (#77).
    const throwingStore: CrashLoopStore = {
      read: () => ({ lastGoodSha: null, failingSha: null, failureCount: 0, crashedTenants: [] }),
      write: () => {
        throw new Error("EACCES: permission denied");
      },
    };
    const lines: string[] = [];
    const g = createCrashGuard({
      engineDir: "/unused",
      log: (line) => lines.push(line),
      store: throwingStore,
      threshold: THRESHOLD,
      healthyMs: HEALTHY_MS,
      roster: () => [TENANT],
    });

    expect(() => g.record(healthyRun(GOOD), TENANT)).not.toThrow();
    expect(lines.map(kindOf)).toContain("persist-failed");
    // In-memory bookkeeping still works for the life of this container.
    expect(g.shouldRetry(crashRun(BAD))).toBe(true);
  });

  test("a run with no commit to judge is dropped", () => {
    // A local mount has no commit to say anything about — nothing to record.
    const { g, lines } = guard();
    g.record(
      {
        engine: launchedEngine(null, false),
        exit: { code: 1, signal: null },
        elapsedMs: 5,
        requestedStop: false,
      },
      TENANT,
    );
    expect(lines).toEqual([]);
    expect(g.fallbackFor(BAD)).toBeNull();
  });

  test("only a guarded launch is retried after a crash", () => {
    // A pinned ref that crashes takes the container down, exactly as it did
    // before there was a guard — retrying is only for a launch tracking a
    // moving branch.
    const { g } = guard();
    g.record(healthyRun(GOOD), TENANT);
    expect(g.shouldRetry(crashRun(BAD, { guarded: false }))).toBe(false);
    expect(g.shouldRetry(crashRun(BAD, { guarded: true }))).toBe(true);
  });
});

describe("fleet breadth × count (#78)", () => {
  test("three tenants crashing once each condemns after one generation", () => {
    const { g } = guard({ roster: () => ["a", "b", "c"] });
    g.record(crashRun(BAD), "a");
    g.record(crashRun(BAD), "b");
    expect(g.condemns(BAD)).toBe(false); // count 2/3 — below threshold too
    g.record(crashRun(BAD), "c");
    expect(g.condemns(BAD)).toBe(true); // count 3/3, and every tenant crashed
  });

  test("one tenant crashing three times with two healthy siblings does not condemn", () => {
    // Count alone would condemn here (3 fast crashes) — breadth says no, since
    // "b" and "c" never crashed and a fleet must not lose them to one bad tenant.
    const { g } = guard({ roster: () => ["a", "b", "c"] });
    g.record(crashRun(BAD), "a");
    g.record(crashRun(BAD), "a");
    g.record(crashRun(BAD), "a");
    expect(g.condemns(BAD)).toBe(false);
  });

  test("a held tenant does not block condemnation", () => {
    // "c" is present but held (#86) — excluded from the roster the caller
    // passes in, so it is never expected to crash before condemnation lands.
    const { g } = guard({ roster: () => ["a", "b"] });
    g.record(crashRun(BAD), "a");
    g.record(crashRun(BAD), "b");
    g.record(crashRun(BAD), "a");
    expect(g.condemns(BAD)).toBe(true);
  });

  test("a tenant added mid-crash-loop delays condemnation by one generation", () => {
    let roster: readonly string[] = ["a", "b"];
    const { g } = guard({ roster: () => roster });
    g.record(crashRun(BAD), "a");
    g.record(crashRun(BAD), "b");

    // "c" joins the roster before it has had a chance to crash.
    roster = ["a", "b", "c"];
    g.record(crashRun(BAD), "a"); // count reaches the threshold (3), but c has not crashed
    expect(g.condemns(BAD)).toBe(false);

    // Delayed, not prevented: c crashes too, on the very next generation.
    g.record(crashRun(BAD), "c");
    expect(g.condemns(BAD)).toBe(true);
  });

  test("one tenant's healthy run exonerates the sha for all", () => {
    const { g } = guard({ roster: () => ["a", "b", "c"] });
    g.record(crashRun(BAD), "a");
    g.record(crashRun(BAD), "b");
    g.record(crashRun(BAD), "c");
    expect(g.condemns(BAD)).toBe(true);

    // Any one tenant outliving the healthy window on BAD lifts it for everyone.
    g.record(healthyRun(BAD), "b");
    expect(g.condemns(BAD)).toBe(false);
    expect(g.fallbackFor(BAD)).toBeNull();
  });

  test("condemns is a pure query: it persists nothing and emits no line", () => {
    const { g, lines } = guard({ roster: () => ["a", "b", "c"] });
    g.record(crashRun(BAD), "a");
    g.record(crashRun(BAD), "b");
    g.record(crashRun(BAD), "c");
    lines.length = 0;
    expect(g.condemns(BAD)).toBe(true);
    expect(g.condemns(BAD)).toBe(true); // repeatable — no state mutated by asking
    expect(lines).toEqual([]);
  });

  test("an empty roster never condemns — no live tenant, no breadth evidence", () => {
    const { g } = guard({ roster: () => [] });
    for (let i = 0; i < THRESHOLD + 3; i++) g.record(crashRun(BAD), "a");
    expect(g.condemns(BAD)).toBe(false);
  });
});
