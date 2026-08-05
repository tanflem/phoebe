// Poison-unit quarantine tests (#75): config resolution, the timeout-counter
// and baseline markers, the count/quarantine/auto-unstick decisions, and the
// selection exclusion that reuses the opt-out filter.

import { describe, expect, test } from "vite-plus/test";
import { asSha } from "./branded.ts";
import {
  buildQuarantineComment,
  buildUnitAttemptMarker,
  buildUnitTimeoutMarker,
  DEFAULT_MAX_UNIT_ATTEMPTS,
  DEFAULT_MAX_UNIT_TIMEOUTS,
  findLatestUnitAttemptComment,
  nextAttemptCount,
  nextTimeoutCount,
  parseQuarantineBaseline,
  parseUnitAttemptMarker,
  parseUnitTimeoutMarker,
  PHOEBE_QUARANTINE_LABEL,
  planUnitAttempt,
  resolveMaxUnitAttempts,
  resolveMaxUnitTimeouts,
  shouldAutoUnstick,
  shouldBackoffUnitRetry,
  shouldQuarantine,
  unitBackoffMs,
  type UnitAttemptMarker,
} from "./quarantine.ts";
import { isPrInScope, selectIssue, type Issue } from "./orchestrator.ts";
import { asBranchRef } from "./branded.ts";

describe("resolveMaxUnitTimeouts", () => {
  test("defaults to 3", () => {
    expect(resolveMaxUnitTimeouts({})).toBe(DEFAULT_MAX_UNIT_TIMEOUTS);
    expect(DEFAULT_MAX_UNIT_TIMEOUTS).toBe(3);
  });
  test("env overrides config overrides default", () => {
    expect(resolveMaxUnitTimeouts({}, 5)).toBe(5);
    expect(resolveMaxUnitTimeouts({ PHOEBE_MAX_UNIT_TIMEOUTS: "2" }, 5)).toBe(2);
    expect(resolveMaxUnitTimeouts({ PHOEBE_MAX_UNIT_TIMEOUTS: "0" }, 5)).toBe(5);
  });
});

describe("markers", () => {
  test("timeout counter marker round-trips", () => {
    expect(parseUnitTimeoutMarker(buildUnitTimeoutMarker(2))).toEqual({ n: 2 });
    expect(parseUnitTimeoutMarker("no marker here")).toBeNull();
  });

  test("escalation comment embeds the baseline marker and names the label", () => {
    const comment = buildQuarantineComment({
      kind: "issues",
      id: 42,
      k: 3,
      baseline: "abc123",
      reason: "timed out",
    });
    expect(comment).toContain(PHOEBE_QUARANTINE_LABEL);
    expect(comment).toContain("timed out 3 times");
    expect(parseQuarantineBaseline(comment)).toBe("abc123");
  });

  test("escalation comment carries the last failure signature for a no-commit trigger (#25)", () => {
    const comment = buildQuarantineComment({
      kind: "conflicts",
      id: 1043,
      k: 3,
      baseline: "deadbeef",
      reason: "produced no commit",
      signature: "mergeable-conflicting",
    });
    expect(comment).toContain("produced no commit 3 times");
    expect(comment).toContain("mergeable-conflicting");
  });

  test("escalation comment names the blocked dependents for the issue-keyed no-PR trigger (#22)", () => {
    const comment = buildQuarantineComment({
      kind: "issues",
      id: 784,
      k: 3,
      baseline: "2026-08-01T00:00:00Z",
      reason: "was claimed and released with no PR",
      signature: "apply-patch-failed",
      dependents: [763, 700],
    });
    expect(comment).toContain("was claimed and released with no PR 3 times");
    expect(comment).toContain("apply-patch-failed");
    expect(comment).toContain("#763");
    expect(comment).toContain("#700");
  });

  test("escalation comment omits the dependents line when there are none", () => {
    const comment = buildQuarantineComment({
      kind: "issues",
      id: 784,
      k: 3,
      baseline: "2026-08-01T00:00:00Z",
      reason: "was claimed and released with no PR",
      signature: "apply-patch-failed",
      dependents: [],
    });
    expect(comment).not.toContain("keeps");
  });
});

describe("count + quarantine decisions", () => {
  test("first timeout with no prior marker records 1", () => {
    expect(nextTimeoutCount(null, false)).toBe(1);
  });
  test("carries the prior count when there is no newer activity", () => {
    expect(nextTimeoutCount(2, false)).toBe(3);
  });
  test("resets to 0 (then +1) when newer activity is present", () => {
    expect(nextTimeoutCount(2, true)).toBe(1);
  });
  test("quarantines at the threshold", () => {
    expect(shouldQuarantine(2, 3)).toBe(false);
    expect(shouldQuarantine(3, 3)).toBe(true);
  });
});

describe("shouldAutoUnstick", () => {
  test("PR unit clears when head SHA advanced past baseline", () => {
    expect(shouldAutoUnstick({ baseline: "aaa", currentHeadSha: asSha("bbb") })).toBe(true);
    expect(shouldAutoUnstick({ baseline: "aaa", currentHeadSha: asSha("aaa") })).toBe(false);
  });
  test("issue unit clears when lastEditedAt is newer than baseline", () => {
    const baseline = "2026-07-31T12:00:00Z";
    expect(shouldAutoUnstick({ baseline, currentIssueEditedAt: "2026-07-31T13:00:00Z" })).toBe(
      true,
    );
    expect(shouldAutoUnstick({ baseline, currentIssueEditedAt: "2026-07-31T11:00:00Z" })).toBe(
      false,
    );
  });
  test("no content signal → stays quarantined (a bare comment can't re-arm)", () => {
    expect(shouldAutoUnstick({ baseline: "aaa" })).toBe(false);
  });
});

describe("selection excludes quarantined units", () => {
  test("a quarantined PR is out of scope", () => {
    const pr = {
      headRefName: asBranchRef("phoebe/issue-1"),
      authorLogin: "phoebe-bot",
      isDraft: false,
      isCrossRepository: false,
      labels: [PHOEBE_QUARANTINE_LABEL],
    };
    expect(isPrInScope(pr)).toBe(false);
  });

  test("a quarantined issue is not selected", () => {
    const issue = (over: Partial<Issue>): Issue => ({
      number: 1,
      title: "t",
      body: "",
      labels: [],
      createdAt: "2026-01-01T00:00:00Z",
      ...over,
    });
    const issues = [
      issue({ number: 1, labels: [PHOEBE_QUARANTINE_LABEL] }),
      issue({ number: 2, labels: [] }),
    ];
    const picked = selectIssue(issues, new Map());
    expect(picked?.issue.number).toBe(2);
  });
});

describe("resolveMaxUnitAttempts", () => {
  test("defaults to 3", () => {
    expect(resolveMaxUnitAttempts({})).toBe(DEFAULT_MAX_UNIT_ATTEMPTS);
    expect(DEFAULT_MAX_UNIT_ATTEMPTS).toBe(3);
  });
  test("env overrides config overrides default", () => {
    expect(resolveMaxUnitAttempts({}, 5)).toBe(5);
    expect(resolveMaxUnitAttempts({ PHOEBE_MAX_UNIT_ATTEMPTS: "2" }, 5)).toBe(2);
    expect(resolveMaxUnitAttempts({ PHOEBE_MAX_UNIT_ATTEMPTS: "0" }, 5)).toBe(5);
  });
});

describe("unit attempt marker (#25)", () => {
  const marker: UnitAttemptMarker = {
    n: 2,
    signature: "mergeable-conflicting",
    ref: "abc1234",
    at: "2026-08-04T12:00:00.000Z",
  };

  test("round-trips through build/parse, scoped by kind", () => {
    const text = buildUnitAttemptMarker("conflicts", marker);
    expect(parseUnitAttemptMarker("conflicts", text)).toEqual(marker);
  });

  test("a checks marker is invisible to a conflicts parse — independent per-kind counters", () => {
    const text = buildUnitAttemptMarker("checks", marker);
    expect(parseUnitAttemptMarker("conflicts", text)).toBeNull();
    expect(parseUnitAttemptMarker("checks", text)).toEqual(marker);
  });

  test("parse returns null when no marker is present", () => {
    expect(parseUnitAttemptMarker("conflicts", "just a normal comment")).toBeNull();
  });
});

describe("findLatestUnitAttemptComment", () => {
  test("finds the newest kind-matching marker and its comment id", () => {
    const older = buildUnitAttemptMarker("conflicts", {
      n: 1,
      signature: "sig-a",
      ref: "sha1",
      at: "2026-08-04T10:00:00.000Z",
    });
    const newer = buildUnitAttemptMarker("conflicts", {
      n: 2,
      signature: "sig-b",
      ref: "sha1",
      at: "2026-08-04T11:00:00.000Z",
    });
    const comments = [
      { id: "IC_1", body: older },
      { id: "IC_2", body: "unrelated human comment" },
      { id: "IC_3", body: newer },
    ];
    const found = findLatestUnitAttemptComment(comments, "conflicts");
    expect(found?.commentId).toBe("IC_3");
    expect(found?.marker.n).toBe(2);
  });

  test("ignores markers for a different kind", () => {
    const checksMarker = buildUnitAttemptMarker("checks", {
      n: 1,
      signature: "sig-a",
      ref: "sha1",
      at: "2026-08-04T10:00:00.000Z",
    });
    expect(findLatestUnitAttemptComment([{ id: "IC_1", body: checksMarker }], "conflicts")).toBe(
      null,
    );
  });

  test("returns null with no comments", () => {
    expect(findLatestUnitAttemptComment([], "conflicts")).toBeNull();
  });
});

describe("nextAttemptCount (#25)", () => {
  test("first attempt with no prior marker records 1", () => {
    expect(nextAttemptCount(null, "sha1")).toBe(1);
  });
  test("carries the prior count when the ref (PR head) is unchanged", () => {
    const previous: UnitAttemptMarker = { n: 2, signature: "s", ref: "sha1", at: "t" };
    expect(nextAttemptCount(previous, "sha1")).toBe(3);
  });
  test("resets to 0 (then +1) once the ref advances — a commit landed", () => {
    const previous: UnitAttemptMarker = { n: 2, signature: "s", ref: "sha1", at: "t" };
    expect(nextAttemptCount(previous, "sha2")).toBe(1);
  });
});

describe("planUnitAttempt", () => {
  test("below threshold: increments and does not quarantine", () => {
    const plan = planUnitAttempt({
      previous: { n: 1, signature: "s", ref: "sha1", at: "t" },
      ref: "sha1",
      signature: "s2",
      now: "2026-08-04T12:00:00.000Z",
      k: 3,
    });
    expect(plan.marker.n).toBe(2);
    expect(plan.marker.signature).toBe("s2");
    expect(plan.quarantined).toBe(false);
  });

  test("at threshold: quarantines", () => {
    const plan = planUnitAttempt({
      previous: { n: 2, signature: "s", ref: "sha1", at: "t" },
      ref: "sha1",
      signature: "s",
      now: "2026-08-04T12:00:00.000Z",
      k: 3,
    });
    expect(plan.marker.n).toBe(3);
    expect(plan.quarantined).toBe(true);
  });

  test("a produced commit (ref advanced) never quarantines even past K in the old run", () => {
    const plan = planUnitAttempt({
      previous: { n: 5, signature: "s", ref: "sha1", at: "t" },
      ref: "sha2",
      signature: "s",
      now: "2026-08-04T12:00:00.000Z",
      k: 3,
    });
    expect(plan.marker.n).toBe(1);
    expect(plan.quarantined).toBe(false);
  });
});

describe("planUnitAttempt reused for the issue-keyed no-PR trigger (#22)", () => {
  // An issue-keyed unit has no in-progress ref to stale-check against, so the
  // caller (main.ts's recordFailedIssueAttempt) passes a constant `ref` — the
  // issue number — across every attempt, and resets by dropping the marker
  // (previous: null) the moment a run produces a PR, rather than relying on
  // `ref` advancing.
  test("consecutive no-PR claims with a constant ref count up and quarantine at K", () => {
    const first = planUnitAttempt({
      previous: null,
      ref: "784",
      signature: "apply-patch-failed",
      now: "2026-08-04T10:00:00.000Z",
      k: 3,
    });
    expect(first.marker.n).toBe(1);
    expect(first.quarantined).toBe(false);

    const second = planUnitAttempt({
      previous: first.marker,
      ref: "784",
      signature: "apply-patch-failed",
      now: "2026-08-04T11:00:00.000Z",
      k: 3,
    });
    expect(second.marker.n).toBe(2);
    expect(second.quarantined).toBe(false);

    const third = planUnitAttempt({
      previous: second.marker,
      ref: "784",
      signature: "apply-patch-failed",
      now: "2026-08-04T12:00:00.000Z",
      k: 3,
    });
    expect(third.marker.n).toBe(3);
    expect(third.quarantined).toBe(true);
  });

  test("a claim that produced a PR resets the counter — a slow-but-progressing unit is never quarantined", () => {
    // Two no-PR claims, then a successful one clears the tracking comment
    // (main.ts's resetIssueAttemptCounter), so the next failure starts at 1
    // instead of continuing from 3.
    const afterTwoFailures: { n: number; signature: string; ref: string; at: string } = {
      n: 2,
      signature: "apply-patch-failed",
      ref: "784",
      at: "2026-08-04T11:00:00.000Z",
    };
    expect(shouldQuarantine(afterTwoFailures.n, 3)).toBe(false);

    // The reset drops the marker entirely — the next failed attempt reads no
    // prior marker, exactly like `previous: null` above.
    const afterReset = planUnitAttempt({
      previous: null,
      ref: "784",
      signature: "apply-patch-failed",
      now: "2026-08-04T13:00:00.000Z",
      k: 3,
    });
    expect(afterReset.marker.n).toBe(1);
    expect(afterReset.quarantined).toBe(false);
  });
});

describe("unit backoff (#25)", () => {
  test("no backoff before any attempt", () => {
    expect(unitBackoffMs(0)).toBe(0);
  });
  test("doubles per attempt, capped", () => {
    expect(unitBackoffMs(1)).toBe(5 * 60_000);
    expect(unitBackoffMs(2)).toBe(10 * 60_000);
    expect(unitBackoffMs(3)).toBe(20 * 60_000);
    expect(unitBackoffMs(10)).toBe(60 * 60_000);
  });

  test("shouldBackoffUnitRetry holds off a retry inside the backoff window", () => {
    expect(
      shouldBackoffUnitRetry({
        attemptCount: 1,
        lastAttemptAt: "2026-08-04T12:00:00.000Z",
        now: "2026-08-04T12:01:00.000Z",
      }),
    ).toBe(true);
  });

  test("shouldBackoffUnitRetry allows retry once the window has elapsed — a transient failure recovers", () => {
    expect(
      shouldBackoffUnitRetry({
        attemptCount: 1,
        lastAttemptAt: "2026-08-04T12:00:00.000Z",
        now: "2026-08-04T12:06:00.000Z",
      }),
    ).toBe(false);
  });

  test("first attempt (count 0) is never backed off", () => {
    expect(
      shouldBackoffUnitRetry({
        attemptCount: 0,
        lastAttemptAt: "2026-08-04T12:00:00.000Z",
        now: "2026-08-04T12:00:00.000Z",
      }),
    ).toBe(false);
  });
});
