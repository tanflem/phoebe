import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { replayEventJournal, type WorkOutcomeInput } from "./event-journal.ts";
import { createRuntimeStatusReporter } from "./runtime-status.ts";
import { readStatusSnapshot } from "./status-store.ts";

const roots: string[] = [];

function makeStateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "phoebe-runtime-status-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const context = {
  repository: {
    slug: "owner/repo",
    url: "https://github.com/owner/repo",
    defaultBranch: "main",
  },
  digests: {
    engine: "sha256:engine",
    bootstrap: "sha256:bootstrap",
    config: "sha256:config",
    policy: "sha256:policy",
    prompts: "sha256:prompts",
    providerModel: "sha256:provider-model",
  },
  provider: {
    name: "codex",
    model: "gpt-test",
    digest: "sha256:provider-model",
  },
  verificationCommands: ["vp check", "vp test", "vp run ready"],
} as const;

describe("runtime status projection", () => {
  test("publishes lifecycle state and a normalized success event before projecting it", () => {
    const stateDir = makeStateDir();
    let second = 0;
    let id = 0;
    const reporter = createRuntimeStatusReporter({
      stateDir,
      runtimeId: "runtime-1",
      ...context,
      now: () => new Date(`2026-07-30T12:00:0${second++}.000Z`),
      randomId: () => `id-${++id}`,
    });

    reporter.record({ kind: "selecting" });
    reporter.record({
      kind: "work-started",
      work: {
        kind: "issues",
        issueNumber: 42,
        branch: "phoebe/issue-42",
      },
    });
    reporter.record({
      kind: "work-completed",
      pullRequestNumber: 7,
      verification: [{ command: "vp run ready", status: "passed", summary: "All gates passed." }],
      resources: { agentExitCode: 0, summary: "1 commit" },
    });

    const persisted = readStatusSnapshot(stateDir);
    expect(persisted).toMatchObject({
      available: true,
      status: {
        lifecycle: { state: "selecting" },
        activeWork: null,
        lastSuccess: {
          outcome: "success",
          sequence: 1,
        },
        journal: {
          earliestSequence: 1,
          latestSequence: 1,
        },
      },
    });
    expect(replayEventJournal(stateDir).events[0]).toMatchObject({
      schemaVersion: "events-v1",
      runtimeId: "runtime-1",
      sequence: 1,
      work: {
        kind: "issues",
        issueNumber: 42,
        pullRequestNumber: 7,
      },
      outcome: "success",
      verification: [{ command: "vp run ready", status: "passed", summary: "All gates passed." }],
      resources: { durationMs: 1_000, agentExitCode: 0, summary: "1 commit" },
      links: { pullRequest: "https://github.com/owner/repo/pull/7" },
    });
  });

  test("publishes the resolved issue queue lookahead (#20)", () => {
    const stateDir = makeStateDir();
    const reporter = createRuntimeStatusReporter({
      stateDir,
      runtimeId: "runtime-1",
      ...context,
    });

    reporter.setQueue([
      { issueNumber: 100, blockedBy: [], workable: true },
      { issueNumber: 103, blockedBy: [101, 102], workable: false },
    ]);

    const expectedQueue = [
      { issueNumber: 100, blockedBy: [], workable: true },
      { issueNumber: 103, blockedBy: [101, 102], workable: false },
    ];
    expect(reporter.snapshot().queue).toEqual(expectedQueue);
    const persisted = readStatusSnapshot(stateDir);
    expect(persisted).toMatchObject({ available: true });
    expect(persisted.available && persisted.status.queue).toEqual(expectedQueue);
  });

  test("preserves the last success and failure when the runtime restarts", () => {
    const stateDir = makeStateDir();
    const first = createRuntimeStatusReporter({
      stateDir,
      runtimeId: "runtime-1",
      ...context,
    });
    first.record({ kind: "work-started", work: { kind: "issues", issueNumber: 42 } });
    first.record({ kind: "work-completed" });
    first.record({ kind: "work-started", work: { kind: "checks", pullRequestNumber: 9 } });
    first.record({ kind: "work-failed", error: new Error("verification failed") });

    const restarted = createRuntimeStatusReporter({
      stateDir,
      runtimeId: "runtime-1",
      ...context,
    });

    expect(restarted.snapshot()).toMatchObject({
      lastSuccess: { sequence: 1, outcome: "success" },
      lastFailure: { sequence: 2, outcome: "verification-failure" },
    });
  });

  test.each([
    ["verification failed: vp test", "verification-failure", "verification"],
    ["agent exited with code 1", "agent-failure", "agent"],
    ["provider quota exceeded (429 rate limit)", "quota-backoff", "quota"],
  ] as const)("normalizes %s", (message, outcome, category) => {
    const stateDir = makeStateDir();
    const reporter = createRuntimeStatusReporter({
      stateDir,
      runtimeId: "runtime-1",
      ...context,
    });
    reporter.record({ kind: "work-started", work: { kind: "checks", pullRequestNumber: 9 } });
    reporter.record({ kind: "work-failed", error: new Error(message) });

    expect(replayEventJournal(stateDir).events[0]).toMatchObject({
      outcome,
      failure: { category },
    });
    expect(reporter.snapshot()).toMatchObject({
      lifecycle: { state: "failed" },
      lastFailure: { outcome, failureCategory: category },
      control: { retry: { attempt: 1 } },
    });
  });

  test("makes telemetry failure visible without throwing into the work loop", () => {
    const stateDir = makeStateDir();
    const writes: unknown[] = [];
    const reporter = createRuntimeStatusReporter({
      stateDir,
      runtimeId: "runtime-1",
      ...context,
      eventJournal: {
        append(_input: WorkOutcomeInput) {
          throw new Error("observer delivery unavailable");
        },
      },
      onWriteError: (error) => writes.push(error),
    });
    reporter.record({ kind: "work-started", work: { kind: "reviews", pullRequestNumber: 8 } });

    expect(() => reporter.record({ kind: "work-completed" })).not.toThrow();
    expect(writes).toHaveLength(1);
    expect(readStatusSnapshot(stateDir)).toMatchObject({
      available: true,
      status: {
        health: {
          state: "degraded",
          telemetry: {
            writable: false,
            lastError: "observer delivery unavailable",
          },
        },
      },
    });
  });

  test("prints exactly one tagged [phoebe:<slug>] line per transition, in the unit-event grammar (#60)", () => {
    const lines: string[] = [];
    const reporter = createRuntimeStatusReporter({
      ...context,
      runtimeId: "runtime-1",
      log: (line) => lines.push(line),
    });

    reporter.record({ kind: "selecting" });
    expect(lines).toEqual([]);

    reporter.record({
      kind: "work-started",
      work: { kind: "issues", issueNumber: 42, branch: "phoebe/issue-42" },
    });
    expect(lines.at(-1)).toBe("[phoebe:owner/repo] started issues #42");

    reporter.record({ kind: "work-completed" });
    expect(lines.at(-1)).toBe("[phoebe:owner/repo] completed issues #42");

    reporter.record({ kind: "work-started", work: { kind: "checks", pullRequestNumber: 9 } });
    reporter.record({ kind: "work-failed", error: new Error("boom") });
    expect(lines.at(-1)).toBe("[phoebe:owner/repo] failed checks #9 — boom");

    reporter.record({ kind: "work-started", work: { kind: "checks", pullRequestNumber: 9 } });
    reporter.record({ kind: "work-timed-out", elapsedMs: 45_000 });
    expect(lines.at(-1)).toBe(
      "[phoebe:owner/repo] timed-out checks #9 — Work unit exceeded its 45s wall-clock budget and was aborted.",
    );

    reporter.record({
      kind: "unit-quarantined",
      work: { kind: "checks", pullRequestNumber: 9 },
      reason: "timed out 3× — labelled phoebe:quarantined",
    });
    expect(lines.at(-1)).toBe(
      "[phoebe:owner/repo] quarantined checks #9 — timed out 3× — labelled phoebe:quarantined",
    );

    // Never the bare, un-attributable `[phoebe]` prefix.
    expect(lines.every((line) => line.startsWith("[phoebe:owner/repo]"))).toBe(true);
  });

  test("selecting emits no line; every other transition emits exactly one (#60)", () => {
    const lines: string[] = [];
    const reporter = createRuntimeStatusReporter({
      ...context,
      runtimeId: "runtime-1",
      log: (line) => lines.push(line),
    });

    reporter.record({ kind: "selecting" });
    expect(lines).toHaveLength(0);

    reporter.record({ kind: "idle", reason: "nothing to do" });
    expect(lines).toHaveLength(1);

    reporter.record({ kind: "work-started", work: { kind: "issues", issueNumber: 1 } });
    expect(lines).toHaveLength(2);

    reporter.record({ kind: "work-completed" });
    expect(lines).toHaveLength(3);

    reporter.record({ kind: "work-started", work: { kind: "issues", issueNumber: 1 } });
    expect(lines).toHaveLength(4);

    reporter.record({ kind: "work-failed", error: new Error("boom") });
    expect(lines).toHaveLength(5);

    reporter.record({ kind: "work-started", work: { kind: "issues", issueNumber: 1 } });
    expect(lines).toHaveLength(6);

    reporter.record({ kind: "work-timed-out", elapsedMs: 1_000 });
    expect(lines).toHaveLength(7);

    reporter.record({
      kind: "unit-quarantined",
      work: { kind: "issues", issueNumber: 1 },
      reason: "poisonous",
    });
    expect(lines).toHaveLength(8);

    reporter.record({ kind: "backoff", reason: "quota" });
    expect(lines).toHaveLength(9);

    reporter.record({ kind: "draining", reason: "stop" });
    expect(lines).toHaveLength(10);

    reporter.record({ kind: "engine-failed", error: new Error("dead") });
    expect(lines).toHaveLength(11);

    reporter.record({ kind: "stopped" });
    expect(lines).toHaveLength(12);

    reporter.record({ kind: "selecting" });
    expect(lines).toHaveLength(12);
  });

  test("work-timed-out clears activeWork, records an agent-category failure, and bumps retry (#60)", () => {
    const stateDir = makeStateDir();
    const reporter = createRuntimeStatusReporter({
      stateDir,
      runtimeId: "runtime-1",
      ...context,
    });
    reporter.record({ kind: "work-started", work: { kind: "checks", pullRequestNumber: 9 } });
    reporter.record({ kind: "work-timed-out", elapsedMs: 45_000 });

    expect(reporter.snapshot()).toMatchObject({
      activeWork: null,
      lifecycle: { state: "failed" },
      lastFailure: { outcome: "agent-failure", failureCategory: "agent" },
      control: { retry: { attempt: 1 } },
    });
    expect(replayEventJournal(stateDir).events[0]).toMatchObject({
      outcome: "agent-failure",
      failure: { category: "agent", retryable: true },
      resources: { summary: "Work unit exceeded its 45s wall-clock budget and was aborted." },
    });
  });

  test("unit-quarantined logs the unit's tagged line without mutating the snapshot beyond updatedAt (#60)", () => {
    const stateDir = makeStateDir();
    const reporter = createRuntimeStatusReporter({ stateDir, runtimeId: "runtime-1", ...context });
    reporter.record({ kind: "work-started", work: { kind: "issues", issueNumber: 42 } });
    reporter.record({ kind: "work-timed-out", elapsedMs: 1_000 });
    const before = reporter.snapshot();

    reporter.record({
      kind: "unit-quarantined",
      work: { kind: "issues", issueNumber: 42 },
      reason: "timed out 3× — labelled phoebe:quarantined",
    });

    const after = reporter.snapshot();
    expect(after).toEqual({ ...before, updatedAt: after.updatedAt });
    expect(after.control.quarantine).toEqual({ active: false });
  });

  test("a nonzero agent exit is recorded as exactly one failed outcome — never also completed (#60 regression)", () => {
    const stateDir = makeStateDir();
    const lines: string[] = [];
    const reporter = createRuntimeStatusReporter({
      stateDir,
      runtimeId: "runtime-1",
      ...context,
      log: (line) => lines.push(line),
    });
    reporter.record({ kind: "work-started", work: { kind: "issues", issueNumber: 42 } });
    lines.length = 0;

    reporter.record({
      kind: "work-failed",
      error: new Error("Agent exited with code 1."),
      resources: {
        agentExitCode: 1,
        summary: "The work unit completed its cleanup after a nonzero agent exit.",
      },
    });

    expect(lines).toEqual(["[phoebe:owner/repo] failed issues #42 — Agent exited with code 1."]);
    expect(reporter.snapshot()).toMatchObject({
      lifecycle: { state: "failed" },
      activeWork: null,
      lastSuccess: null,
    });
    expect(replayEventJournal(stateDir).events.at(-1)).toMatchObject({ outcome: "agent-failure" });
  });

  test("projects graceful drain and crash-loop quarantine without exposing secrets", () => {
    const reporter = createRuntimeStatusReporter({
      ...context,
      runtimeId: "runtime-1",
      quarantinedEngineSha: "bad-sha",
      secrets: ["super-secret"],
    });
    reporter.record({
      kind: "draining",
      reason: "GH_TOKEN=super-secret graceful stop",
    });

    expect(reporter.snapshot()).toMatchObject({
      lifecycle: { state: "draining", reason: "GH_TOKEN=[REDACTED] graceful stop" },
      control: {
        quarantine: { active: true, engineSha: "bad-sha" },
        drain: { requested: true },
      },
    });
    expect(JSON.stringify(reporter.snapshot())).not.toContain("super-secret");
  });
});
