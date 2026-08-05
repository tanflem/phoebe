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
