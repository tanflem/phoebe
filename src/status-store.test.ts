import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { STATUS_SCHEMA_VERSION, type StatusSnapshot } from "./status-contract.ts";
import {
  loadOrCreateRuntimeId,
  readStatusSnapshot,
  STATUS_SNAPSHOT_FILE,
  statusSnapshotPath,
  writeStatusSnapshot,
} from "./status-store.ts";

const roots: string[] = [];

function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "phoebe-status-v2-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const snapshot = (): StatusSnapshot => ({
  schemaVersion: STATUS_SCHEMA_VERSION,
  updatedAt: "2026-07-30T12:00:00.000Z",
  runtime: {
    runtimeId: "runtime-1",
    instanceId: "instance-1",
    startedAt: "2026-07-30T12:00:00.000Z",
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
  capabilities: ["status-v2", "events-v1"],
  lifecycle: { state: "idle" },
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
  links: { repository: "https://github.com/owner/repo" },
});

describe("status-v2 store", () => {
  test("replaces the snapshot with one atomic rename", () => {
    const calls: string[] = [];
    const dir = stateDir();
    writeStatusSnapshot(dir, snapshot(), {
      mkdir: () => undefined,
      write: (path) => calls.push(`write:${String(path)}`),
      rename: (from, to) => calls.push(`rename:${String(from)}:${String(to)}`),
      read: () => "",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/write:.*status-v2\.json\.tmp-/);
    expect(calls[1]).toMatch(/rename:.*status-v2\.json\.tmp-.*:.*status-v2\.json/);
  });

  test("reads the exact projection and returns structured missing/corrupt states", () => {
    const dir = stateDir();
    expect(readStatusSnapshot(dir)).toMatchObject({
      available: false,
      reason: "not-found",
    });

    writeStatusSnapshot(dir, snapshot());
    expect(readStatusSnapshot(dir)).toEqual({ available: true, status: snapshot() });
    // The temp file was renamed over the target, not left as debris — a reader
    // never sees a half-written file (the whole point of the temp+rename).
    expect(readdirSync(dir)).toEqual([STATUS_SNAPSHOT_FILE]);

    writeFileSync(statusSnapshotPath(dir), "{");
    expect(readStatusSnapshot(dir)).toMatchObject({
      available: false,
      reason: "corrupt",
    });
  });

  test("surfaces unsupported schema majors as capability errors", () => {
    const dir = stateDir();
    writeFileSync(
      statusSnapshotPath(dir),
      JSON.stringify({ ...snapshot(), schemaVersion: "status-v1" }),
    );
    expect(() => readStatusSnapshot(dir)).toThrow(/supports status-v2 but received status-v1/);
  });

  test("persists a generated runtime ID and honors an explicit stable ID", () => {
    const generatedDir = stateDir();
    expect(loadOrCreateRuntimeId(generatedDir, { randomId: () => "generated-id" })).toBe(
      "generated-id",
    );
    expect(loadOrCreateRuntimeId(generatedDir, { randomId: () => "different" })).toBe(
      "generated-id",
    );

    const explicitDir = stateDir();
    expect(loadOrCreateRuntimeId(explicitDir, { preferredId: "configured-id" })).toBe(
      "configured-id",
    );
    expect(readFileSync(join(explicitDir, "runtime-id"), "utf8")).toBe("configured-id\n");
  });
});
