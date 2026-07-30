import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  createObserverStatusReporter,
  observerStatusPath,
  readObserverStatus,
  sanitizeStatusText,
  type ObserverConfiguration,
} from "./observer-status.ts";

const configuration: ObserverConfiguration = {
  defaultBranch: "main",
  branchPrefix: "phoebe/",
  readyLabel: "ready-for-agent",
  researchLabel: "wayfinder:research",
  prScope: "phoebe",
  draftPrs: "skip-non-phoebe",
  prOptOutLabel: "ready-for-human",
  workOrder: ["conflicts", "checks", "reviews", "issues", "research"],
  provider: "codex",
  model: "gpt-test",
  pollIntervalMs: 15_000,
};

const tempDirs: string[] = [];

function makeStatusPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "phoebe-observer-test-"));
  tempDirs.push(dir);
  return observerStatusPath(dir);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createObserverStatusReporter", () => {
  test("persists a versioned initial snapshot atomically", () => {
    const path = makeStatusPath();
    const reporter = createObserverStatusReporter({
      path,
      repoSlug: "owner/repo",
      configuration,
      env: {
        PHOEBE_RUNNING_ENGINE_SOURCE: "github",
        PHOEBE_RUNNING_ENGINE_REPO: "JesusFilm/phoebe",
        PHOEBE_RUNNING_ENGINE_REF: "main",
        PHOEBE_RUNNING_ENGINE_SHA: "abc123",
      },
      now: () => new Date("2026-07-29T12:00:00.000Z"),
    });

    expect(reporter.snapshot()).toMatchObject({
      schemaVersion: 1,
      updatedAt: "2026-07-29T12:00:00.000Z",
      repoSlug: "owner/repo",
      phase: "starting",
      engine: {
        source: "github",
        repo: "JesusFilm/phoebe",
        ref: "main",
        sha: "abc123",
      },
      configuration,
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(reporter.snapshot());
  });

  test("reduces lifecycle transitions into current state and a bounded event history", () => {
    const path = makeStatusPath();
    let second = 0;
    const reporter = createObserverStatusReporter({
      path,
      repoSlug: "owner/repo",
      configuration,
      eventLimit: 3,
      now: () => new Date(`2026-07-29T12:00:0${second++}.000Z`),
    });
    const work = {
      kind: "issues" as const,
      description: "issue #42 — base origin/main",
      issueNumber: 42,
      branch: "phoebe/issue-42",
    };

    reporter.record({ kind: "selecting" });
    reporter.record({ kind: "idle", reason: "No work this cycle — idle." });
    reporter.record({ kind: "work-started", work });
    reporter.record({ kind: "work-completed" });

    expect(reporter.snapshot()).toMatchObject({
      phase: "selecting",
      currentWork: null,
      idleReason: null,
      lastOutcome: {
        result: "completed",
        work,
      },
    });
    expect(reporter.snapshot().recentEvents).toHaveLength(3);
    expect(reporter.snapshot().recentEvents.map((event) => event.kind)).toEqual([
      "idle",
      "work-started",
      "work-completed",
    ]);
  });

  test("records a sanitized failure without leaking configured secrets", () => {
    const path = makeStatusPath();
    const reporter = createObserverStatusReporter({
      path,
      repoSlug: "owner/repo",
      configuration,
      secrets: ["super-secret-token"],
    });
    reporter.record({
      kind: "work-started",
      work: { kind: "checks", description: "checks fix for PR #9", prNumber: 9 },
    });
    reporter.record({
      kind: "work-failed",
      error: new Error(
        "GH_TOKEN=super-secret-token Authorization: Bearer another-token\nrequest failed",
      ),
    });

    const serialized = JSON.stringify(reporter.snapshot());
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("another-token");
    expect(reporter.snapshot()).toMatchObject({
      phase: "failed",
      lastOutcome: {
        result: "failed",
        error: "GH_TOKEN=[REDACTED] Authorization: Bearer [REDACTED] request failed",
      },
    });
  });

  test("status persistence failure is reported but never kills the engine", () => {
    const writes: unknown[] = [];
    const reporter = createObserverStatusReporter({
      path: "/state/status.json",
      repoSlug: "owner/repo",
      configuration,
      onWriteError: (error) => writes.push(error),
      io: {
        mkdir: () => undefined,
        write: () => {
          throw new Error("volume is read-only");
        },
        rename: () => undefined,
        read: () => "",
      },
    });

    expect(() => reporter.record({ kind: "selecting" })).not.toThrow();
    expect(writes).toHaveLength(2);
    expect(reporter.snapshot().phase).toBe("selecting");
  });
});

describe("readObserverStatus", () => {
  test("returns one observed envelope around a valid snapshot", () => {
    const path = makeStatusPath();
    createObserverStatusReporter({
      path,
      repoSlug: "owner/repo",
      configuration,
      now: () => new Date("2026-07-29T12:00:00.000Z"),
    });

    expect(
      readObserverStatus(path, { now: () => new Date("2026-07-29T12:00:15.000Z") }),
    ).toMatchObject({
      schemaVersion: 1,
      observedAt: "2026-07-29T12:00:15.000Z",
      available: true,
      status: { repoSlug: "owner/repo", phase: "starting" },
    });
  });

  test("missing and malformed files remain machine-readable", () => {
    const path = makeStatusPath();
    expect(readObserverStatus(path)).toMatchObject({
      schemaVersion: 1,
      available: false,
      reason: "not-found",
    });

    const malformed = readObserverStatus(path, {
      io: {
        mkdir: () => undefined,
        write: () => undefined,
        rename: () => undefined,
        read: () => '{"schemaVersion":99}',
      },
    });
    expect(malformed).toMatchObject({
      schemaVersion: 1,
      available: false,
      reason: "unreadable",
    });
  });
});

describe("sanitizeStatusText", () => {
  test("redacts credential-shaped text, flattens lines, and bounds the result", () => {
    const result = sanitizeStatusText(
      "https://x-access-token:abc123@github.com/repo Authorization Bearer xyz\n" + "x".repeat(100),
      [],
      80,
    );
    expect(result).not.toContain("abc123");
    expect(result).not.toContain("xyz");
    expect(result).not.toContain("\n");
    expect(result.length).toBe(80);
    expect(result.endsWith("…")).toBe(true);
  });
});
