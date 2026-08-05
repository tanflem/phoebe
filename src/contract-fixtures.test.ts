import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { eventJournalDir, replayEventJournal } from "./event-journal.ts";
import { parseStatusSnapshot, parseWorkOutcomeEvent } from "./status-contract.ts";

const root = join(import.meta.dirname, "..");
const fixtureRoot = join(root, "contracts", "fixtures");
const tempDirs: string[] = [];
const ajv = addFormats(new Ajv2020({ allErrors: true, strict: true }));
const validateStatus = ajv.compile(json("contracts/status-v2.schema.json") as object);
const validateEvent = ajv.compile(json("contracts/events-v1.schema.json") as object);

function json(path: string): unknown {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function replayFixture(name: string) {
  const stateDir = mkdtempSync(join(tmpdir(), "phoebe-contract-fixture-"));
  tempDirs.push(stateDir);
  const dir = eventJournalDir(stateDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "events-00000000000000000001-open.jsonl"),
    readFileSync(join(fixtureRoot, "replay", name)),
  );
  return replayEventJournal(stateDir);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("published compatibility fixtures", () => {
  test.each([
    "idle",
    "running",
    "quota-backoff",
    "graceful-drain",
    "crash-loop-fallback",
    "queue-linear-chain",
    "queue-diamond",
  ])("status-v2/%s.json conforms to the runtime reader", (name) => {
    const fixture = json(`contracts/fixtures/status-v2/${name}.json`);
    expect(validateStatus(fixture), JSON.stringify(validateStatus.errors)).toBe(true);
    expect(() => parseStatusSnapshot(fixture)).not.toThrow();
  });

  test("idle.json carries an empty queue", () => {
    const fixture = json("contracts/fixtures/status-v2/idle.json") as { queue: unknown[] };
    expect(fixture.queue).toEqual([]);
  });

  test("queue-linear-chain.json orders a chain with single-blocker sets", () => {
    const fixture = json("contracts/fixtures/status-v2/queue-linear-chain.json") as {
      queue: Array<{ issueNumber: number; blockedBy: readonly number[] }>;
    };
    expect(fixture.queue.map((entry) => entry.issueNumber)).toEqual([100, 101, 102]);
    expect(fixture.queue.map((entry) => entry.blockedBy)).toEqual([[], [100], [101]]);
  });

  test("queue-diamond.json resolves both blockers on the converging issue", () => {
    const fixture = json("contracts/fixtures/status-v2/queue-diamond.json") as {
      queue: Array<{ issueNumber: number; blockedBy: readonly number[] }>;
    };
    const diamond = fixture.queue.find((entry) => entry.issueNumber === 103);
    expect(diamond?.blockedBy).toEqual([101, 102]);
  });

  test.each(["success", "verification-failure", "agent-failure"])(
    "events-v1/%s.json conforms to the runtime reader",
    (name) => {
      const fixture = json(`contracts/fixtures/events-v1/${name}.json`);
      expect(validateEvent(fixture), JSON.stringify(validateEvent.errors)).toBe(true);
      expect(() => parseWorkOutcomeEvent(fixture)).not.toThrow();
    },
  );

  test("corrupt-tail fixture preserves its complete prefix and quarantines the tail", () => {
    expect(replayFixture("corrupt-tail.jsonl")).toMatchObject({
      events: [{ sequence: 1 }],
      quarantinedTailCount: 1,
    });
  });

  test("missing-range fixture reports its exact gap", () => {
    expect(replayFixture("missing-range.jsonl").missingRanges).toEqual([
      { fromSequence: 2, toSequence: 2 },
    ]);
  });

  test("unsupported-major fixture produces an explicit capability error", () => {
    expect(() => replayFixture("unsupported-major.jsonl")).toThrow(
      /supports events-v1 but received events-v2/,
    );
  });

  test("schemas identify the published interfaces and permit additive fields", () => {
    const status = json("contracts/status-v2.schema.json") as Record<string, unknown>;
    const events = json("contracts/events-v1.schema.json") as Record<string, unknown>;
    expect(status).toMatchObject({
      $id: "https://phoebe.dev/contracts/status-v2.schema.json",
      additionalProperties: true,
    });
    expect(events).toMatchObject({
      $id: "https://phoebe.dev/contracts/events-v1.schema.json",
      additionalProperties: true,
    });
  });
});
