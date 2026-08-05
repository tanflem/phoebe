import { describe, expect, test } from "vite-plus/test";
import {
  ContractCapabilityError,
  digestValue,
  parseStatusSnapshot,
  STATUS_SCHEMA_VERSION,
  type StatusSnapshot,
} from "./status-contract.ts";

const snapshot = (): StatusSnapshot => ({
  schemaVersion: STATUS_SCHEMA_VERSION,
  updatedAt: "2026-07-30T12:00:00.000Z",
  runtime: {
    runtimeId: "runtime-1",
    instanceId: "instance-1",
    startedAt: "2026-07-30T11:00:00.000Z",
  },
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
  capabilities: ["status-v2", "events-v1", "events-replay-v1", "events-range-v1"],
  lifecycle: { state: "idle", reason: "No work this cycle." },
  activeWork: null,
  queue: [],
  lastSuccess: null,
  lastFailure: null,
  control: {
    retry: { attempt: 0 },
    backoff: { active: false },
    quarantine: { active: false },
    drain: { requested: false },
  },
  health: {
    state: "healthy",
    telemetry: { writable: true, lastError: null, lastErrorAt: null },
  },
  journal: {
    earliestSequence: null,
    latestSequence: null,
    retainedSegments: 0,
    quarantinedTailCount: 0,
  },
  links: {
    repository: "https://github.com/owner/repo",
  },
});

describe("status-v2 contract", () => {
  test("accepts the v2 projection and tolerates unknown additive fields", () => {
    const input = {
      ...snapshot(),
      additiveTopLevelField: true,
      runtime: { ...snapshot().runtime, additiveRuntimeField: "future" },
    };

    expect(parseStatusSnapshot(input)).toBe(input);
  });

  test("rejects a status-v1 snapshot with an explicit capability error", () => {
    expect(() => parseStatusSnapshot({ ...snapshot(), schemaVersion: "status-v1" })).toThrowError(
      ContractCapabilityError,
    );
    expect(() => parseStatusSnapshot({ ...snapshot(), schemaVersion: "status-v1" })).toThrow(
      /supports status-v2 but received status-v1/,
    );
  });

  test("rejects an unsupported future major with an explicit capability error", () => {
    expect(() => parseStatusSnapshot({ ...snapshot(), schemaVersion: "status-v3" })).toThrow(
      /supports status-v2 but received status-v3/,
    );
  });

  test("rejects malformed v2 data instead of treating it as another version", () => {
    expect(() =>
      parseStatusSnapshot({ ...snapshot(), runtime: { runtimeId: "runtime-1" } }),
    ).toThrow(/invalid status-v2 snapshot/);
  });

  test("rejects a queue entry missing its resolved blocker set", () => {
    expect(() =>
      parseStatusSnapshot({
        ...snapshot(),
        queue: [{ issueNumber: 42, workable: true }],
      }),
    ).toThrow(/invalid status-v2/);
  });

  test("accepts a queue with resolved multi-blocker sets", () => {
    const input = {
      ...snapshot(),
      queue: [
        { issueNumber: 100, blockedBy: [], workable: true },
        { issueNumber: 103, blockedBy: [101, 102], workable: true },
      ],
    };
    expect(parseStatusSnapshot(input)).toBe(input);
  });

  test("produces stable, key-order-independent sha256 digests", () => {
    expect(digestValue({ b: 2, a: 1 })).toBe(digestValue({ a: 1, b: 2 }));
    expect(digestValue({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("rejects semantically invalid v2 values that would violate the published schemas", () => {
    expect(() =>
      parseStatusSnapshot({
        ...snapshot(),
        lifecycle: { state: "teleporting" },
      }),
    ).toThrow(/invalid status-v2/);
  });
});
