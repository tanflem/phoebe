import { afterEach, describe, expect, test } from "vite-plus/test";
import { asBranchRef, asPrNumber, asSha } from "./branded.ts";
import { resolveConfig } from "./config-schema.ts";
import { setResolvedConfig } from "./resolved-config.ts";
import { config as sampleUserConfig } from "../phoebe.config.ts";
import type { BlockerSource } from "./config-schema.ts";
import {
  buildChecksFailWatermarkMarker,
  buildConflictFailWatermarkMarker,
  buildInitialPrBody,
  buildReviewsHandledComment,
  buildReviewsHandledMarker,
  checksFailureSignature,
  checksFixFailureComment,
  classifyPriority,
  compareIssues,
  conflictFailureSignature,
  conflictFixFailureComment,
  filterBackoffEligible,
  findBlockedDependents,
  followUpPrComment,
  formatFailingChecksForPrompt,
  hasNewNonPhoebeReviewActivity,
  isPhoebeHeadBranch,
  isPrInScope,
  isPrMergeConflicting,
  isReviewSummaryComment,
  issueAttemptFailureSignature,
  issueBranch,
  issueBlockers,
  listFailingChecks,
  mergeBlockerNumbers,
  newestReviewThreadCommentCreatedAt,
  parseBlockedBy,
  parseChecksFailWatermark,
  parseConflictFailWatermark,
  parseLatestMarker,
  parseReviewsHandledWatermark,
  parseIssueNumberFromBranch,
  resolveWorktreeBase,
  resolveStackedPrPlan,
  getMergedBlockerPrNumbers,
  ghStackExtensionInstallArgs,
  nativeStackGitConfig,
  oneShotWorkKinds,
  selectChecksUnit,
  selectConflictFixCandidates,
  selectConflictUnit,
  selectFirstWorkUnit,
  selectIssue,
  selectReviewsUnit,
  summarizeChecksSelection,
  summarizeConflictSelection,
  summarizeReviewsSelection,
  shouldPostChecksFixFailure,
  statusCheckRollupState,
  validateWorkOrder,
  workflowRunsToCheckItems,
  WORK_KIND_ONE_SHOT_ELIGIBLE,
  shouldPostConflictFixFailure,
  shouldSkipStackedChecksFix,
  shouldSkipStackedConflictFix,
  shouldSkipStackedReviewsFix,
  shouldSkipWatermarkChecksFix,
  shouldSkipWatermarkConflictFix,
  slugifyFailureSignature,
  stackedCatchUpRetractionComment,
  stackedPrComment,
  type BlockerPrState,
  type ChecksCandidate,
  type ConflictingPrCandidate,
  type Issue,
  type ReviewThread,
  type ReviewsCandidate,
  type StatusCheckItem,
} from "./orchestrator.ts";

function issue(overrides: Partial<Issue> & Pick<Issue, "number">): Issue {
  return {
    title: `Issue ${overrides.number}`,
    body: "",
    labels: ["ready-for-agent"],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("parseBlockedBy", () => {
  test("parses Blocked by #N from body", () => {
    expect(parseBlockedBy("Blocked by #98\n\n## Summary")).toEqual([98]);
  });

  test("deduplicates multiple refs", () => {
    expect(parseBlockedBy("Blocked by #98\nBlocked by #98")).toEqual([98]);
  });

  test("returns empty when no blockers", () => {
    expect(parseBlockedBy("No blockers here")).toEqual([]);
  });
});

describe("mergeBlockerNumbers", () => {
  test("body mode ignores native blockers (reproduces today's behavior)", () => {
    expect(mergeBlockerNumbers([98], [42], "body")).toEqual([98]);
    expect(mergeBlockerNumbers([], [42], "body")).toEqual([]);
  });

  test("native mode ignores body blockers", () => {
    expect(mergeBlockerNumbers([98], [42], "native")).toEqual([42]);
  });

  test("both mode unions and deduplicates, body refs first", () => {
    expect(mergeBlockerNumbers([98, 7], [7, 42], "both")).toEqual([98, 7, 42]);
  });

  test("empty native result leaves body blockers untouched under both", () => {
    expect(mergeBlockerNumbers([98], [], "both")).toEqual([98]);
  });

  test("empty native result yields nothing under native", () => {
    expect(mergeBlockerNumbers([98], [], "native")).toEqual([]);
  });
});

describe("issueBlockers", () => {
  const withBlockerSource = (source: BlockerSource) =>
    setResolvedConfig(resolveConfig({ ...sampleUserConfig, blockerSource: source }));

  afterEach(() => setResolvedConfig(resolveConfig(sampleUserConfig)));

  test("defaults to config.blockerSource — body ignores native", () => {
    withBlockerSource("body");
    expect(issueBlockers(issue({ number: 1, body: "Blocked by #98" }), [42])).toEqual([98]);
  });

  test("native source uses native blockers, not the body regex", () => {
    withBlockerSource("native");
    expect(issueBlockers(issue({ number: 1, body: "Blocked by #98" }), [42])).toEqual([42]);
  });

  test("both source unions body and native, deduplicated", () => {
    withBlockerSource("both");
    expect(issueBlockers(issue({ number: 1, body: "Blocked by #98" }), [98, 42])).toEqual([98, 42]);
  });
});

describe("classifyPriority", () => {
  test("classifies bug-fix issues highest", () => {
    expect(classifyPriority(issue({ number: 1, title: "Fix crash on startup" }))).toBe("bug");
  });

  test("classifies tracer bullets", () => {
    expect(classifyPriority(issue({ number: 2, title: "Wire API-mode discovery POC" }))).toBe(
      "tracer",
    );
  });

  test("defaults to polish", () => {
    expect(classifyPriority(issue({ number: 3, title: "Add quota resilience" }))).toBe("polish");
  });
});

describe("compareIssues", () => {
  test("orders bug before polish, then oldest createdAt", () => {
    const bug = issue({
      number: 10,
      title: "Fix broken workflow",
      createdAt: "2026-06-02T00:00:00Z",
    });
    const polish = issue({
      number: 5,
      title: "Add toggle",
      createdAt: "2026-06-01T00:00:00Z",
    });
    expect(compareIssues(bug, polish)).toBeLessThan(0);
    expect(compareIssues(polish, bug)).toBeGreaterThan(0);
  });
});

describe("resolveWorktreeBase", () => {
  const emptyStates = new Map<number, BlockerPrState>();

  test("PHOEBE_BASE overrides everything", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    expect(resolveWorktreeBase(blocked, emptyStates, "feature/custom")).toEqual({
      worktreeBase: "feature/custom",
      stacked: false,
    });
  });

  test("unblocked issues base off origin/main", () => {
    expect(resolveWorktreeBase(issue({ number: 108 }), emptyStates)).toEqual({
      worktreeBase: "origin/main",
      stacked: false,
    });
  });

  test("stacks on blocker remote tip when blocker PR is open", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: true, openPrNumber: asPrNumber(104), hasMergedPr: false }],
    ]);
    expect(resolveWorktreeBase(blocked, states)).toEqual({
      worktreeBase: `origin/${issueBranch(98)}`,
      stacked: true,
      blockerIssueNumber: 98,
      blockerPrNumber: 104,
    });
  });

  test("uses origin/main when blocker PR merged", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    const states = new Map<number, BlockerPrState>([[98, { hasOpenPr: false, hasMergedPr: true }]]);
    expect(resolveWorktreeBase(blocked, states)).toEqual({
      worktreeBase: "origin/main",
      stacked: false,
    });
  });

  test("skips when blocked with no open or merged blocker PR", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: false, hasMergedPr: false }],
    ]);
    expect(resolveWorktreeBase(blocked, states)).toBeNull();
  });

  test("skips when blocker state is unknown", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    expect(resolveWorktreeBase(blocked, emptyStates)).toBeNull();
  });

  test("stacks on a native blocker (no body ref) under native source", () => {
    setResolvedConfig(resolveConfig({ ...sampleUserConfig, blockerSource: "native" }));
    const blocked = issue({ number: 102, body: "## Blocked by\n\n- #98" });
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: true, openPrNumber: asPrNumber(104), hasMergedPr: false }],
    ]);
    expect(resolveWorktreeBase(blocked, states, undefined, [98])).toEqual({
      worktreeBase: `origin/${issueBranch(98)}`,
      stacked: true,
      blockerIssueNumber: 98,
      blockerPrNumber: 104,
    });
    setResolvedConfig(resolveConfig(sampleUserConfig));
  });

  test("native blockers are ignored under the default body source", () => {
    // Body has no ref, so a native-only blocker must not gate the base in body mode.
    const blocked = issue({ number: 102, body: "no body ref here" });
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: false, hasMergedPr: false }],
    ]);
    expect(resolveWorktreeBase(blocked, states, undefined, [98])).toEqual({
      worktreeBase: "origin/main",
      stacked: false,
    });
  });

  test("stackMode 'off' honors the blocker for the skip decision but never stacks", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    const open = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: true, openPrNumber: asPrNumber(104), hasMergedPr: false }],
    ]);
    // Open blocker PR: base off main, not the blocker branch — and not skipped.
    expect(resolveWorktreeBase(blocked, open, undefined, [], "off")).toEqual({
      worktreeBase: "origin/main",
      stacked: false,
    });
    // No blocker PR at all: still skipped, exactly as the other modes.
    const none = new Map<number, BlockerPrState>([[98, { hasOpenPr: false, hasMergedPr: false }]]);
    expect(resolveWorktreeBase(blocked, none, undefined, [], "off")).toBeNull();
  });

  test("stackMode 'native' cuts the branch off the blocker tip, same as banner", () => {
    const blocked = issue({ number: 102, body: "Blocked by #98" });
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: true, openPrNumber: asPrNumber(104), hasMergedPr: false }],
    ]);
    expect(resolveWorktreeBase(blocked, states, undefined, [], "native")).toEqual({
      worktreeBase: `origin/${issueBranch(98)}`,
      stacked: true,
      blockerIssueNumber: 98,
      blockerPrNumber: 104,
    });
  });
});

describe("resolveStackedPrPlan", () => {
  const stacked = { stacked: true as const, blockerIssueNumber: 98 };
  const unstacked = { stacked: false as const };

  test("banner: base=main, banner on, no stack link (today's behavior)", () => {
    expect(
      resolveStackedPrPlan({
        issueNumber: 102,
        resolution: stacked,
        stackMode: "banner",
        defaultBranch: "main",
      }),
    ).toEqual({ prBase: "main", includeBanner: true, stackLinkArgs: null });
  });

  test("native: base=blocker branch, no banner, bottom-to-top stack link argv", () => {
    expect(
      resolveStackedPrPlan({
        issueNumber: 102,
        resolution: stacked,
        stackMode: "native",
        defaultBranch: "main",
      }),
    ).toEqual({
      prBase: issueBranch(98),
      includeBanner: false,
      stackLinkArgs: ["stack", "link", issueBranch(98), issueBranch(102)],
    });
  });

  test("unstacked resolution (off / unblocked / PHOEBE_BASE): base=main, no banner, no link", () => {
    for (const stackMode of ["banner", "native", "off"] as const) {
      expect(
        resolveStackedPrPlan({
          issueNumber: 102,
          resolution: unstacked,
          stackMode,
          defaultBranch: "main",
        }),
      ).toEqual({ prBase: "main", includeBanner: false, stackLinkArgs: null });
    }
  });

  test("honors a non-default defaultBranch for the base", () => {
    expect(
      resolveStackedPrPlan({
        issueNumber: 102,
        resolution: unstacked,
        stackMode: "banner",
        defaultBranch: "trunk",
      }).prBase,
    ).toBe("trunk");
  });
});

describe("native-stack tooling argv builders", () => {
  test("git config presets remote.pushDefault and rerere.enabled", () => {
    expect(nativeStackGitConfig()).toEqual([
      ["config", "remote.pushDefault", "origin"],
      ["config", "rerere.enabled", "true"],
    ]);
  });

  test("extension install targets github/gh-stack", () => {
    expect(ghStackExtensionInstallArgs()).toEqual(["extension", "install", "github/gh-stack"]);
  });
});

describe("selectIssue", () => {
  test("picks highest-priority workable issue and skips blocked-without-PR", () => {
    const issues = [
      issue({
        number: 103,
        title: "Add toggle",
        body: "Blocked by #98",
        createdAt: "2026-06-01T00:00:00Z",
      }),
      issue({
        number: 108,
        title: "Phoebe poll loop",
        createdAt: "2026-06-02T00:00:00Z",
      }),
    ];
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: false, hasMergedPr: false }],
    ]);
    const picked = selectIssue(issues, states);
    expect(picked?.issue.number).toBe(108);
    expect(picked?.resolution.worktreeBase).toBe("origin/main");
  });

  test("returns null when every issue is blocked without an open PR", () => {
    const issues = [
      issue({ number: 102, body: "Blocked by #98" }),
      issue({ number: 103, body: "Blocked by #98" }),
    ];
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: false, hasMergedPr: false }],
    ]);
    expect(selectIssue(issues, states)).toBeNull();
  });

  test("threads per-issue native blockers into base resolution under native source", () => {
    setResolvedConfig(resolveConfig({ ...sampleUserConfig, blockerSource: "native" }));
    // No body ref; the blocker is known only via the native dependencies map.
    const issues = [issue({ number: 102, body: "## Blocked by\n\n- #98" })];
    const states = new Map<number, BlockerPrState>([
      [98, { hasOpenPr: true, openPrNumber: asPrNumber(104), hasMergedPr: false }],
    ]);
    const nativeBlockersByIssue = new Map<number, readonly number[]>([[102, [98]]]);
    const picked = selectIssue(issues, states, undefined, nativeBlockersByIssue);
    expect(picked?.issue.number).toBe(102);
    expect(picked?.resolution.stacked).toBe(true);
    expect(picked?.resolution.blockerIssueNumber).toBe(98);
    setResolvedConfig(resolveConfig(sampleUserConfig));
  });
});

describe("stackedPrComment", () => {
  test("names blocker issue and PR with do-not-merge warning", () => {
    const comment = stackedPrComment(98, asPrNumber(104));
    expect(comment).toContain("#98");
    expect(comment).toContain("PR #104");
    expect(comment).toContain("Do not merge");
  });
});

describe("isPhoebeHeadBranch", () => {
  test("matches phoebe/ prefix", () => {
    expect(isPhoebeHeadBranch(asBranchRef("phoebe/issue-109"))).toBe(true);
    expect(isPhoebeHeadBranch(asBranchRef("feature/foo"))).toBe(false);
  });
});

const defaultPrScopeConfig = {
  branchPrefix: "phoebe/",
  prScope: "phoebe" as const,
  prAuthors: [] as readonly string[],
  draftPrs: "skip-non-phoebe" as const,
  prOptOutLabel: "ready-for-human",
};

function prScanFields(
  overrides: Partial<{
    headRefName: string;
    authorLogin: string;
    isDraft: boolean;
    isCrossRepository: boolean;
    labels: string[];
  }> = {},
) {
  return {
    isDraft: false,
    authorLogin: "octocat",
    isCrossRepository: false,
    labels: [] as string[],
    ...overrides,
    headRefName: asBranchRef(overrides.headRefName ?? "phoebe/issue-1"),
  };
}

describe("isPrInScope", () => {
  test("phoebe scope includes Phoebe branches", () => {
    expect(isPrInScope(prScanFields({ headRefName: "phoebe/issue-1" }), defaultPrScopeConfig)).toBe(
      true,
    );
  });

  test("phoebe scope excludes non-Phoebe branches", () => {
    expect(isPrInScope(prScanFields({ headRefName: "feature/foo" }), defaultPrScopeConfig)).toBe(
      false,
    );
  });

  test("all scope includes same-repo non-Phoebe branches", () => {
    expect(
      isPrInScope(prScanFields({ headRefName: "feature/foo" }), {
        ...defaultPrScopeConfig,
        prScope: "all",
      }),
    ).toBe(true);
  });

  test("author scope includes only configured GitHub logins, case-insensitively", () => {
    const scoped = { ...defaultPrScopeConfig, prScope: "all" as const, prAuthors: ["TanFlem"] };
    expect(isPrInScope(prScanFields({ authorLogin: "tanflem" }), scoped)).toBe(true);
    expect(isPrInScope(prScanFields({ authorLogin: "coworker" }), scoped)).toBe(false);
  });

  test("cross-repo PRs are always excluded", () => {
    expect(
      isPrInScope(prScanFields({ headRefName: "feature/foo", isCrossRepository: true }), {
        ...defaultPrScopeConfig,
        prScope: "all",
      }),
    ).toBe(false);
  });

  test("opt-out label excludes any PR including Phoebe branches", () => {
    expect(
      isPrInScope(
        prScanFields({ headRefName: "phoebe/issue-1", labels: ["ready-for-human"] }),
        defaultPrScopeConfig,
      ),
    ).toBe(false);
  });

  test("skip-all draft mode excludes all drafts", () => {
    expect(
      isPrInScope(prScanFields({ headRefName: "phoebe/issue-1", isDraft: true }), {
        ...defaultPrScopeConfig,
        draftPrs: "skip-all",
      }),
    ).toBe(false);
    expect(
      isPrInScope(prScanFields({ headRefName: "feature/foo", isDraft: true }), {
        ...defaultPrScopeConfig,
        prScope: "all",
        draftPrs: "skip-all",
      }),
    ).toBe(false);
  });

  test("skip-non-phoebe draft mode excludes drafts on human branches only", () => {
    expect(
      isPrInScope(prScanFields({ headRefName: "feature/foo", isDraft: true }), {
        ...defaultPrScopeConfig,
        prScope: "all",
      }),
    ).toBe(false);
    expect(
      isPrInScope(prScanFields({ headRefName: "phoebe/issue-1", isDraft: true }), {
        ...defaultPrScopeConfig,
        prScope: "all",
      }),
    ).toBe(true);
  });

  test("include draft mode allows drafts on any in-scope branch", () => {
    expect(
      isPrInScope(prScanFields({ headRefName: "feature/foo", isDraft: true }), {
        ...defaultPrScopeConfig,
        prScope: "all",
        draftPrs: "include",
      }),
    ).toBe(true);
  });
});

describe("parseIssueNumberFromBranch", () => {
  test("parses phoebe/issue-N branches", () => {
    expect(parseIssueNumberFromBranch(asBranchRef("phoebe/issue-109"))).toBe(109);
  });

  test("returns null for non-issue branches", () => {
    expect(parseIssueNumberFromBranch(asBranchRef("phoebe/custom"))).toBeNull();
  });
});

describe("isPrMergeConflicting", () => {
  test("detects CONFLICTING mergeable state", () => {
    expect(isPrMergeConflicting("CONFLICTING")).toBe(true);
    expect(isPrMergeConflicting("MERGEABLE")).toBe(false);
  });

  test("treats UNKNOWN + DIRTY as conflicting", () => {
    expect(isPrMergeConflicting("UNKNOWN", "DIRTY")).toBe(true);
    expect(isPrMergeConflicting("UNKNOWN", "CLEAN")).toBe(false);
  });
});

describe("shouldSkipStackedConflictFix", () => {
  test("skips when blocker PR is still open", () => {
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: true, openPrNumber: asPrNumber(112), hasMergedPr: false }],
    ]);
    expect(shouldSkipStackedConflictFix("Blocked by #108", states)).toBe(true);
  });

  test("does not skip when blocker PR merged", () => {
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: false, hasMergedPr: true, mergedPrNumber: asPrNumber(112) }],
    ]);
    expect(shouldSkipStackedConflictFix("Blocked by #108", states)).toBe(false);
  });
});

describe("getMergedBlockerPrNumbers", () => {
  test("returns every merged blocker PR number in stack order", () => {
    const states = new Map<number, BlockerPrState>([
      [100, { hasOpenPr: false, hasMergedPr: true, mergedPrNumber: asPrNumber(110) }],
      [101, { hasOpenPr: false, hasMergedPr: true, mergedPrNumber: asPrNumber(111) }],
      [102, { hasOpenPr: true, openPrNumber: asPrNumber(112), hasMergedPr: false }],
    ]);
    expect(
      getMergedBlockerPrNumbers("Blocked by #100\nBlocked by #101\nBlocked by #102", states),
    ).toEqual([110, 111]);
  });

  test("returns empty when no blockers merged", () => {
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: true, openPrNumber: asPrNumber(112), hasMergedPr: false }],
    ]);
    expect(getMergedBlockerPrNumbers("Blocked by #108", states)).toEqual([]);
  });
});

describe("stackedCatchUpRetractionComment", () => {
  test("retracts single-blocker banner", () => {
    const comment = stackedCatchUpRetractionComment([asPrNumber(112)]);
    expect(comment).toContain("#112");
    expect(comment).toContain("independently mergeable");
  });

  test("names all blockers for multi-blocker stacks", () => {
    const comment = stackedCatchUpRetractionComment([asPrNumber(110), asPrNumber(111)]);
    expect(comment).toContain("#110");
    expect(comment).toContain("#111");
  });
});

describe("validateWorkOrder", () => {
  test("accepts known kinds", () => {
    expect(validateWorkOrder(["conflicts", "checks", "reviews", "issues"])).toEqual([
      "conflicts",
      "checks",
      "reviews",
      "issues",
    ]);
    expect(validateWorkOrder(["conflicts", "issues"])).toEqual(["conflicts", "issues"]);
    expect(validateWorkOrder(["issues"])).toEqual(["issues"]);
  });

  test("accepts research", () => {
    expect(validateWorkOrder(["conflicts", "checks", "reviews", "issues", "research"])).toEqual([
      "conflicts",
      "checks",
      "reviews",
      "issues",
      "research",
    ]);
    expect(validateWorkOrder(["research"])).toEqual(["research"]);
  });

  test("throws on empty order", () => {
    expect(() => validateWorkOrder([])).toThrow(/must not be empty/);
  });

  test("throws on unknown kind", () => {
    expect(() => validateWorkOrder(["conflicts", "bogus"])).toThrow(/Unknown work kind/);
  });
});

describe("selectConflictUnit", () => {
  const pr = (
    overrides: Omit<Partial<ConflictingPrCandidate>, "prNumber"> & { prNumber: number },
  ) =>
    ({
      ...overrides,
      prNumber: asPrNumber(overrides.prNumber),
      headRefName: overrides.headRefName ?? asBranchRef(`phoebe/issue-${overrides.prNumber}`),
    }) satisfies ConflictingPrCandidate;

  test("picks oldest PR number among eligible conflicts", () => {
    const prs = [pr({ prNumber: 120 }), pr({ prNumber: 115 }), pr({ prNumber: 118 })];
    const bodies = new Map<number, string>();
    const states = new Map<number, BlockerPrState>();
    expect(selectConflictUnit(prs, { issueBodies: bodies, blockerStates: states })?.prNumber).toBe(
      115,
    );
  });

  test("selects stacked follow-up when blocker merged (catch-up eligible)", () => {
    const prs = [pr({ prNumber: 115, issueNumber: 115 })];
    const bodies = new Map<number, string>([[115, "Blocked by #108"]]);
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: false, hasMergedPr: true, mergedPrNumber: asPrNumber(112) }],
    ]);
    expect(selectConflictUnit(prs, { issueBodies: bodies, blockerStates: states })?.prNumber).toBe(
      115,
    );
  });

  test("returns null when every conflict is stacked on open blocker", () => {
    const prs = [pr({ prNumber: 110 })];
    const bodies = new Map<number, string>([[110, "Blocked by #108"]]);
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: true, openPrNumber: asPrNumber(112), hasMergedPr: false }],
    ]);
    expect(selectConflictUnit(prs, { issueBodies: bodies, blockerStates: states })).toBeNull();
  });
});

describe("selectFirstWorkUnit", () => {
  const pr = (prNumber: number): ConflictingPrCandidate => ({
    prNumber: asPrNumber(prNumber),
    headRefName: asBranchRef(`phoebe/issue-${prNumber}`),
  });

  test("prefers conflicts before issues when both have work", () => {
    const issues = [issue({ number: 135, title: "New feature" })];
    const picked = selectFirstWorkUnit(["conflicts", "issues"], {
      issues,
      blockerStates: new Map(),
      conflictingPrs: [pr(200)],
      failingCheckPrs: [],
      reviewActivityPrs: [],
      issueBodies: new Map(),
    });
    expect(picked?.kind).toBe("conflicts");
    expect(picked?.kind === "conflicts" && picked.unit.prNumber).toBe(200);
  });

  test("takes issues when conflicts kind is omitted from order", () => {
    const issues = [issue({ number: 135, title: "New feature" })];
    const picked = selectFirstWorkUnit(["issues"], {
      issues,
      blockerStates: new Map(),
      conflictingPrs: [pr(200)],
      failingCheckPrs: [],
      reviewActivityPrs: [],
      issueBodies: new Map(),
    });
    expect(picked?.kind).toBe("issues");
    expect(picked?.kind === "issues" && picked.unit.issue.number).toBe(135);
  });

  test("takes conflicts only when issues kind is omitted", () => {
    const picked = selectFirstWorkUnit(["conflicts"], {
      issues: [issue({ number: 135 })],
      blockerStates: new Map(),
      conflictingPrs: [pr(200)],
      failingCheckPrs: [],
      reviewActivityPrs: [],
      issueBodies: new Map(),
    });
    expect(picked?.kind).toBe("conflicts");
  });

  test("under oneShotOnly skips conflicts and takes the first eligible kind", () => {
    const issues = [issue({ number: 137, title: "Run-once respects WORK_ORDER" })];
    const picked = selectFirstWorkUnit(
      ["conflicts", "issues"],
      {
        issues,
        blockerStates: new Map(),
        conflictingPrs: [pr(200)],
        failingCheckPrs: [],
        reviewActivityPrs: [],
        issueBodies: new Map(),
      },
      { oneShotOnly: true },
    );
    expect(picked?.kind).toBe("issues");
    expect(picked?.kind === "issues" && picked.unit.issue.number).toBe(137);
  });

  test("under oneShotOnly returns null for conflict-only WORK_ORDER even when conflicts exist", () => {
    const picked = selectFirstWorkUnit(
      ["conflicts"],
      {
        issues: [],
        blockerStates: new Map(),
        conflictingPrs: [pr(200)],
        failingCheckPrs: [],
        reviewActivityPrs: [],
        issueBodies: new Map(),
      },
      { oneShotOnly: true },
    );
    expect(picked).toBeNull();
  });

  test("under oneShotOnly never selects conflicts when issues are absent", () => {
    const picked = selectFirstWorkUnit(
      ["conflicts", "issues"],
      {
        issues: [],
        blockerStates: new Map(),
        conflictingPrs: [pr(200)],
        failingCheckPrs: [],
        reviewActivityPrs: [],
        issueBodies: new Map(),
      },
      { oneShotOnly: true },
    );
    expect(picked).toBeNull();
  });
});

describe("selectFirstWorkUnit research ordering", () => {
  const researchIssue = (number: number, overrides: Partial<Issue> = {}): Issue =>
    issue({ number, title: `Research ${number}`, labels: ["wayfinder:research"], ...overrides });

  test("selects a research ticket via the reused issues path", () => {
    const picked = selectFirstWorkUnit(["research"], {
      issues: [],
      researchIssues: [researchIssue(140)],
      blockerStates: new Map(),
      conflictingPrs: [],
      failingCheckPrs: [],
      reviewActivityPrs: [],
      issueBodies: new Map(),
    });
    expect(picked?.kind).toBe("research");
    expect(picked?.kind === "research" && picked.unit.issue.number).toBe(140);
  });

  test("prefers issues before research when both have work", () => {
    const picked = selectFirstWorkUnit(["issues", "research"], {
      issues: [issue({ number: 150, title: "New feature" })],
      researchIssues: [researchIssue(140)],
      blockerStates: new Map(),
      conflictingPrs: [],
      failingCheckPrs: [],
      reviewActivityPrs: [],
      issueBodies: new Map(),
    });
    expect(picked?.kind).toBe("issues");
    expect(picked?.kind === "issues" && picked.unit.issue.number).toBe(150);
  });

  test("skips a research ticket blocked by an issue with no blocker PR", () => {
    const picked = selectFirstWorkUnit(["research"], {
      issues: [],
      researchIssues: [researchIssue(141, { body: "Blocked by #108" })],
      blockerStates: new Map<number, BlockerPrState>([
        [108, { hasOpenPr: false, hasMergedPr: false }],
      ]),
      conflictingPrs: [],
      failingCheckPrs: [],
      reviewActivityPrs: [],
      issueBodies: new Map(),
    });
    expect(picked).toBeNull();
  });

  test("under oneShotOnly selects research when it is the eligible kind", () => {
    const picked = selectFirstWorkUnit(
      ["conflicts", "research"],
      {
        issues: [],
        researchIssues: [researchIssue(142)],
        blockerStates: new Map(),
        conflictingPrs: [],
        failingCheckPrs: [],
        reviewActivityPrs: [],
        issueBodies: new Map(),
      },
      { oneShotOnly: true },
    );
    expect(picked?.kind).toBe("research");
  });

  test("selects nothing for research when researchIssues is absent", () => {
    const picked = selectFirstWorkUnit(["research"], {
      issues: [issue({ number: 150 })],
      blockerStates: new Map(),
      conflictingPrs: [],
      failingCheckPrs: [],
      reviewActivityPrs: [],
      issueBodies: new Map(),
    });
    expect(picked).toBeNull();
  });
});

describe("WORK_KIND_ONE_SHOT_ELIGIBLE", () => {
  test("janitor kinds are persistent-mode only", () => {
    expect(WORK_KIND_ONE_SHOT_ELIGIBLE.conflicts).toBe(false);
    expect(WORK_KIND_ONE_SHOT_ELIGIBLE.checks).toBe(false);
    expect(WORK_KIND_ONE_SHOT_ELIGIBLE.reviews).toBe(false);
    expect(WORK_KIND_ONE_SHOT_ELIGIBLE.issues).toBe(true);
  });

  test("research is one-shot-eligible like issues", () => {
    expect(WORK_KIND_ONE_SHOT_ELIGIBLE.research).toBe(true);
  });
});

describe("oneShotWorkKinds", () => {
  test("filters to one-shot-eligible kinds in WORK_ORDER order", () => {
    expect(oneShotWorkKinds(["conflicts", "checks", "reviews", "issues"])).toEqual(["issues"]);
    expect(oneShotWorkKinds(["conflicts", "issues"])).toEqual(["issues"]);
    expect(oneShotWorkKinds(["conflicts"])).toEqual([]);
    expect(oneShotWorkKinds(["issues"])).toEqual(["issues"]);
  });

  test("keeps research alongside issues", () => {
    expect(oneShotWorkKinds(["conflicts", "checks", "reviews", "issues", "research"])).toEqual([
      "issues",
      "research",
    ]);
    expect(oneShotWorkKinds(["conflicts", "research"])).toEqual(["research"]);
  });
});

describe("selectConflictFixCandidates", () => {
  const pr = (
    overrides: Omit<Partial<ConflictingPrCandidate>, "prNumber"> & { prNumber: number },
  ) =>
    ({
      headSha: asSha("aaa111"),
      ...overrides,
      prNumber: asPrNumber(overrides.prNumber),
      headRefName: overrides.headRefName ?? asBranchRef(`phoebe/issue-${overrides.prNumber}`),
    }) satisfies ConflictingPrCandidate;

  const emptyBodies = new Map<number, string>();
  const emptyStates = new Map<number, BlockerPrState>();

  test("filters out stacked PRs with open blocker", () => {
    const prs = [pr({ prNumber: 109 }), pr({ prNumber: 110 })];
    const bodies = new Map<number, string>([
      [109, "No blockers"],
      [110, "Blocked by #108"],
    ]);
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: true, openPrNumber: asPrNumber(112), hasMergedPr: false }],
    ]);
    expect(
      selectConflictFixCandidates(prs, { issueBodies: bodies, blockerStates: states }).map(
        (p) => p.prNumber,
      ),
    ).toEqual([109]);
  });

  test("skips PRs whose failure watermark matches current SHAs", () => {
    const prs = [
      pr({
        prNumber: 100,
        headSha: asSha("pr100"),
        failureWatermark: { prHead: asSha("pr100"), mainHead: asSha("main1") },
      }),
      pr({
        prNumber: 101,
        headSha: asSha("pr101"),
        failureWatermark: null,
      }),
    ];
    expect(
      selectConflictFixCandidates(
        prs,
        { issueBodies: emptyBodies, blockerStates: emptyStates },
        {
          currentMainHead: asSha("main1"),
        },
      ).map((p) => p.prNumber),
    ).toEqual([101]);
  });

  test("re-attempts when PR head moved since watermark", () => {
    const prs = [
      pr({
        prNumber: 100,
        headSha: asSha("pr100v2"),
        failureWatermark: { prHead: asSha("pr100v1"), mainHead: asSha("main1") },
      }),
    ];
    expect(
      selectConflictFixCandidates(
        prs,
        { issueBodies: emptyBodies, blockerStates: emptyStates },
        {
          currentMainHead: asSha("main1"),
        },
      ).map((p) => p.prNumber),
    ).toEqual([100]);
  });

  test("re-attempts when main moved since watermark", () => {
    const prs = [
      pr({
        prNumber: 100,
        headSha: asSha("pr100"),
        failureWatermark: { prHead: asSha("pr100"), mainHead: asSha("main1") },
      }),
    ];
    expect(
      selectConflictFixCandidates(
        prs,
        { issueBodies: emptyBodies, blockerStates: emptyStates },
        {
          currentMainHead: asSha("main2"),
        },
      ).map((p) => p.prNumber),
    ).toEqual([100]);
  });

  test("watermark skip still applies to merged-blocker catch-up candidates", () => {
    const prs = [
      pr({
        prNumber: 115,
        issueNumber: 115,
        headSha: asSha("pr115"),
        failureWatermark: { prHead: asSha("pr115"), mainHead: asSha("main1") },
      }),
    ];
    const bodies = new Map<number, string>([[115, "Blocked by #108"]]);
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: false, hasMergedPr: true, mergedPrNumber: asPrNumber(112) }],
    ]);
    expect(
      selectConflictFixCandidates(
        prs,
        { issueBodies: bodies, blockerStates: states },
        { currentMainHead: asSha("main1") },
      ),
    ).toEqual([]);
  });
});

describe("selectConflictUnit watermark skip", () => {
  const pr = (
    overrides: Omit<Partial<ConflictingPrCandidate>, "prNumber"> & { prNumber: number },
  ) =>
    ({
      headSha: asSha("aaa111"),
      ...overrides,
      prNumber: asPrNumber(overrides.prNumber),
      headRefName: overrides.headRefName ?? asBranchRef(`phoebe/issue-${overrides.prNumber}`),
    }) satisfies ConflictingPrCandidate;

  test("picks oldest non-skipped conflicting PR", () => {
    const prs = [
      pr({
        prNumber: 100,
        headSha: asSha("pr100"),
        failureWatermark: { prHead: asSha("pr100"), mainHead: asSha("main1") },
      }),
      pr({ prNumber: 101, headSha: asSha("pr101"), failureWatermark: null }),
    ];
    const unit = selectConflictUnit(
      prs,
      { issueBodies: new Map(), blockerStates: new Map() },
      { currentMainHead: asSha("main1") },
    );
    expect(unit?.prNumber).toBe(101);
  });
});

describe("conflict fail watermark", () => {
  const watermark = { prHead: asSha("abc123def"), mainHead: asSha("9876543210ab") };

  test("builds a parseable HTML comment marker", () => {
    const marker = buildConflictFailWatermarkMarker(watermark);
    expect(marker).toBe("<!-- phoebe-conflict-fail: prHead=abc123def mainHead=9876543210ab -->");
    expect(parseConflictFailWatermark(marker)).toEqual(watermark);
  });

  test("parseConflictFailWatermark returns null when marker absent", () => {
    expect(parseConflictFailWatermark("no marker here")).toBeNull();
  });

  test("parseLatestMarker returns latest conflict marker", () => {
    const older = buildConflictFailWatermarkMarker({
      prHead: asSha("old"),
      mainHead: asSha("oldmain"),
    });
    const newer = buildConflictFailWatermarkMarker(watermark);
    expect(
      parseLatestMarker(
        [`failure\n${older}`, "unrelated", `retry\n${newer}`],
        parseConflictFailWatermark,
      ),
    ).toEqual(watermark);
  });
});

describe("shouldSkipWatermarkConflictFix", () => {
  const watermark = { prHead: asSha("pr1"), mainHead: asSha("main1") };

  test("skips when both SHAs match watermark", () => {
    expect(
      shouldSkipWatermarkConflictFix({
        watermark,
        currentPrHead: asSha("pr1"),
        currentMainHead: asSha("main1"),
      }),
    ).toBe(true);
  });

  test("does not skip without a watermark", () => {
    expect(
      shouldSkipWatermarkConflictFix({
        watermark: null,
        currentPrHead: asSha("pr1"),
        currentMainHead: asSha("main1"),
      }),
    ).toBe(false);
  });

  test("re-attempts when either SHA moved", () => {
    expect(
      shouldSkipWatermarkConflictFix({
        watermark,
        currentPrHead: asSha("pr2"),
        currentMainHead: asSha("main1"),
      }),
    ).toBe(false);
    expect(
      shouldSkipWatermarkConflictFix({
        watermark,
        currentPrHead: asSha("pr1"),
        currentMainHead: asSha("main2"),
      }),
    ).toBe(false);
  });
});

describe("conflictFixFailureComment", () => {
  test("names the PR and explains merge was aborted", () => {
    const comment = conflictFixFailureComment(asPrNumber(42));
    expect(comment).toContain("PR #42");
    expect(comment).toContain("merge --abort");
  });

  test("embeds SHA watermark marker when provided", () => {
    const comment = conflictFixFailureComment(asPrNumber(42), {
      prHead: asSha("deadbeef"),
      mainHead: asSha("cafebabe"),
    });
    expect(comment).toContain("<!-- phoebe-conflict-fail: prHead=deadbeef mainHead=cafebabe -->");
    expect(parseConflictFailWatermark(comment)).toEqual({
      prHead: "deadbeef",
      mainHead: "cafebabe",
    });
  });
});

describe("shouldPostConflictFixFailure", () => {
  const base = {
    originShaBefore: asSha("abc123"),
    originShaAfter: asSha("abc123"),
    mergeable: "CONFLICTING" as const,
    mergeStateStatus: "DIRTY",
  };

  test("sandbox pushed then cleanup failed — origin advanced, no failure comment", () => {
    expect(
      shouldPostConflictFixFailure({
        ...base,
        hostCommitCount: 0,
        originShaAfter: asSha("def456"),
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      }),
    ).toBe(false);
  });

  test("PR now mergeable even when origin SHA unchanged — no failure comment", () => {
    expect(
      shouldPostConflictFixFailure({
        ...base,
        hostCommitCount: 0,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      }),
    ).toBe(false);
  });

  test("genuine no-op — origin unchanged and still conflicting", () => {
    expect(
      shouldPostConflictFixFailure({
        ...base,
        hostCommitCount: 0,
      }),
    ).toBe(true);
  });

  test("host has unpushed commits — no failure comment", () => {
    expect(
      shouldPostConflictFixFailure({
        ...base,
        hostCommitCount: 1,
      }),
    ).toBe(false);
  });
});

describe("buildInitialPrBody", () => {
  test("includes stacked banner on initial PR only", () => {
    const body = buildInitialPrBody({
      issueNumber: 103,
      commitCount: 2,
      stacked: { blockerIssueNumber: 98, blockerPrNumber: asPrNumber(104) },
    });
    expect(body).toContain("Closes #103");
    expect(body).toContain("Blocked by #98");
    expect(body).toContain("Commits: 2");
  });
});

describe("followUpPrComment", () => {
  test("contains only the incremental delta, not the stacked banner", () => {
    const comment = followUpPrComment(103, 2);
    expect(comment).toContain("#103");
    expect(comment).toContain("2 new commit(s)");
    expect(comment).not.toContain("Blocked by");
    expect(comment).not.toContain("Do not merge");
    expect(comment).not.toContain("Closes #");
  });
});

describe("statusCheckRollupState", () => {
  const check = (overrides: Partial<StatusCheckItem>): StatusCheckItem => ({
    __typename: "CheckRun",
    name: "test",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    ...overrides,
  });

  test("returns NONE when no checks", () => {
    expect(statusCheckRollupState([])).toBe("NONE");
  });

  test("returns PENDING when any check is queued or in progress", () => {
    expect(
      statusCheckRollupState([
        check({ name: "a", status: "IN_PROGRESS", conclusion: null }),
        check({ name: "b", conclusion: "FAILURE" }),
      ]),
    ).toBe("PENDING");
  });

  test("returns FAILURE when a check failed and none pending", () => {
    expect(
      statusCheckRollupState([
        check({ name: "a", conclusion: "SUCCESS" }),
        check({ name: "b", conclusion: "FAILURE" }),
      ]),
    ).toBe("FAILURE");
  });

  test("returns SUCCESS when all checks passed", () => {
    expect(statusCheckRollupState([check({ conclusion: "SUCCESS" })])).toBe("SUCCESS");
  });

  test("handles StatusContext pending and failure states", () => {
    expect(
      statusCheckRollupState([{ __typename: "StatusContext", context: "ci", state: "PENDING" }]),
    ).toBe("PENDING");
    expect(
      statusCheckRollupState([{ __typename: "StatusContext", context: "ci", state: "FAILURE" }]),
    ).toBe("FAILURE");
  });
});

describe("workflowRunsToCheckItems", () => {
  test("uppercases REST enums and keeps only the newest run per workflow", () => {
    expect(
      workflowRunsToCheckItems([
        { workflowName: "ready", status: "completed", conclusion: "success" },
        { workflowName: "ready", status: "completed", conclusion: "failure" },
        { workflowName: "autofix.ci", status: "in_progress", conclusion: null },
      ]),
    ).toEqual([
      { name: "ready", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "autofix.ci", status: "IN_PROGRESS", conclusion: null },
    ]);
  });

  test("maps onto rollup state: failed run yields FAILURE, running run yields PENDING", () => {
    expect(
      statusCheckRollupState(
        workflowRunsToCheckItems([
          { workflowName: "ready", status: "completed", conclusion: "failure" },
        ]),
      ),
    ).toBe("FAILURE");
    expect(
      statusCheckRollupState(
        workflowRunsToCheckItems([
          { workflowName: "ready", status: "queued", conclusion: null },
          { workflowName: "autofix.ci", status: "completed", conclusion: "failure" },
        ]),
      ),
    ).toBe("PENDING");
    expect(
      statusCheckRollupState(
        workflowRunsToCheckItems([
          { workflowName: "ready", status: "completed", conclusion: "success" },
        ]),
      ),
    ).toBe("SUCCESS");
  });

  test("treats REST-only pending statuses as pending", () => {
    expect(
      statusCheckRollupState(
        workflowRunsToCheckItems([{ workflowName: "ready", status: "pending", conclusion: null }]),
      ),
    ).toBe("PENDING");
    expect(
      statusCheckRollupState(
        workflowRunsToCheckItems([
          { workflowName: "ready", status: "requested", conclusion: null },
        ]),
      ),
    ).toBe("PENDING");
  });

  test("falls back to run name when workflowName is missing", () => {
    expect(
      workflowRunsToCheckItems([{ name: "ready", status: "completed", conclusion: "success" }]),
    ).toEqual([{ name: "ready", status: "COMPLETED", conclusion: "SUCCESS" }]);
  });
});

describe("listFailingChecks", () => {
  test("lists only failing checks with names and conclusions", () => {
    const checks: StatusCheckItem[] = [
      { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "StatusContext", context: "ci/old", state: "ERROR" },
    ];
    expect(listFailingChecks(checks)).toEqual([
      { name: "lint", conclusion: "FAILURE" },
      { name: "ci/old", conclusion: "ERROR" },
    ]);
  });
});

describe("selectChecksUnit", () => {
  const checksPr = (
    overrides: Omit<Partial<ChecksCandidate>, "prNumber"> & { prNumber: number },
  ): ChecksCandidate => ({
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    failingChecks: [{ name: "test", conclusion: "FAILURE" }],
    ...overrides,
    prNumber: asPrNumber(overrides.prNumber),
    headRefName: overrides.headRefName ?? asBranchRef(`phoebe/issue-${overrides.prNumber}`),
  });

  test("picks oldest PR number among eligible failing-CI candidates", () => {
    const prs = [
      checksPr({ prNumber: 120 }),
      checksPr({ prNumber: 115 }),
      checksPr({ prNumber: 118 }),
    ];
    expect(
      selectChecksUnit(prs, { issueBodies: new Map(), blockerStates: new Map() })?.prNumber,
    ).toBe(115);
  });

  test("skips conflicting PRs", () => {
    const prs = [
      checksPr({ prNumber: 110, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
      checksPr({ prNumber: 111 }),
    ];
    expect(
      selectChecksUnit(prs, { issueBodies: new Map(), blockerStates: new Map() })?.prNumber,
    ).toBe(111);
  });

  test("skips stacked PRs with open blocker", () => {
    const prs = [checksPr({ prNumber: 110 })];
    const bodies = new Map<number, string>([[110, "Blocked by #108"]]);
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: true, openPrNumber: asPrNumber(112), hasMergedPr: false }],
    ]);
    expect(selectChecksUnit(prs, { issueBodies: bodies, blockerStates: states })).toBeNull();
  });

  test("skips PRs with unchanged failure watermark", () => {
    const prs = [
      checksPr({
        prNumber: 100,
        headSha: asSha("pr100"),
        failureWatermark: { prHead: asSha("pr100") },
      }),
      checksPr({ prNumber: 101, headSha: asSha("pr101"), failureWatermark: null }),
    ];
    expect(
      selectChecksUnit(prs, { issueBodies: new Map(), blockerStates: new Map() })?.prNumber,
    ).toBe(101);
  });
});

describe("selectFirstWorkUnit checks ordering", () => {
  const conflictPr = (prNumber: number): ConflictingPrCandidate => ({
    prNumber: asPrNumber(prNumber),
    headRefName: asBranchRef(`phoebe/issue-${prNumber}`),
  });

  const checksPr = (prNumber: number): ChecksCandidate => ({
    prNumber: asPrNumber(prNumber),
    headRefName: asBranchRef(`phoebe/issue-${prNumber}`),
    mergeable: "MERGEABLE",
    failingChecks: [{ name: "test", conclusion: "FAILURE" }],
  });

  test("prefers conflicts before checks before issues", () => {
    const issues = [issue({ number: 135, title: "New feature" })];
    const picked = selectFirstWorkUnit(["conflicts", "checks", "issues"], {
      issues,
      blockerStates: new Map(),
      conflictingPrs: [conflictPr(200)],
      failingCheckPrs: [checksPr(201)],
      reviewActivityPrs: [],
      issueBodies: new Map(),
    });
    expect(picked?.kind).toBe("conflicts");
  });

  test("takes checks when no conflicts but failing CI exists", () => {
    const issues = [issue({ number: 135, title: "New feature" })];
    const picked = selectFirstWorkUnit(["conflicts", "checks", "issues"], {
      issues,
      blockerStates: new Map(),
      conflictingPrs: [],
      failingCheckPrs: [checksPr(201)],
      reviewActivityPrs: [],
      issueBodies: new Map(),
    });
    expect(picked?.kind).toBe("checks");
    expect(picked?.kind === "checks" && picked.unit.prNumber).toBe(201);
  });

  test("under oneShotOnly skips checks", () => {
    const issues = [issue({ number: 137 })];
    const picked = selectFirstWorkUnit(
      ["conflicts", "checks", "issues"],
      {
        issues,
        blockerStates: new Map(),
        conflictingPrs: [],
        failingCheckPrs: [checksPr(201)],
        reviewActivityPrs: [],
        issueBodies: new Map(),
      },
      { oneShotOnly: true },
    );
    expect(picked?.kind).toBe("issues");
  });
});

describe("checks fail watermark", () => {
  const watermark = { prHead: asSha("abc123def") };

  test("builds a parseable HTML comment marker", () => {
    const marker = buildChecksFailWatermarkMarker(watermark);
    expect(marker).toBe("<!-- phoebe-checks-fail: prHead=abc123def -->");
    expect(parseChecksFailWatermark(marker)).toEqual(watermark);
  });

  test("parseLatestMarker returns latest checks marker", () => {
    const older = buildChecksFailWatermarkMarker({ prHead: asSha("old") });
    const newer = buildChecksFailWatermarkMarker(watermark);
    expect(
      parseLatestMarker(
        [`failure\n${older}`, "unrelated", `retry\n${newer}`],
        parseChecksFailWatermark,
      ),
    ).toEqual(watermark);
  });
});

describe("shouldSkipWatermarkChecksFix", () => {
  test("skips when prHead matches watermark", () => {
    expect(
      shouldSkipWatermarkChecksFix({
        watermark: { prHead: asSha("pr1") },
        currentPrHead: asSha("pr1"),
      }),
    ).toBe(true);
  });

  test("re-attempts when prHead moved", () => {
    expect(
      shouldSkipWatermarkChecksFix({
        watermark: { prHead: asSha("pr1") },
        currentPrHead: asSha("pr2"),
      }),
    ).toBe(false);
  });
});

describe("shouldSkipStackedChecksFix", () => {
  test("aliases stacked conflict skip logic", () => {
    expect(shouldSkipStackedChecksFix).toBe(shouldSkipStackedConflictFix);
  });
});

describe("checksFixFailureComment", () => {
  test("embeds prHead-only watermark when provided", () => {
    const comment = checksFixFailureComment(asPrNumber(42), { prHead: asSha("deadbeef") });
    expect(comment).toContain("PR #42");
    expect(comment).toContain("<!-- phoebe-checks-fail: prHead=deadbeef -->");
  });
});

describe("shouldPostChecksFixFailure", () => {
  const base = { originShaBefore: asSha("abc123"), originShaAfter: asSha("abc123") };

  test("genuine no-op — origin unchanged and no local commits", () => {
    expect(shouldPostChecksFixFailure({ ...base, hostCommitCount: 0 })).toBe(true);
  });

  test("agent pushed — no failure comment", () => {
    expect(
      shouldPostChecksFixFailure({ ...base, hostCommitCount: 0, originShaAfter: asSha("def456") }),
    ).toBe(false);
  });

  test("host has unpushed commits — no failure comment", () => {
    expect(shouldPostChecksFixFailure({ ...base, hostCommitCount: 1 })).toBe(false);
  });
});

describe("formatFailingChecksForPrompt", () => {
  test("formats name and conclusion per line", () => {
    expect(
      formatFailingChecksForPrompt([
        { name: "lint", conclusion: "FAILURE" },
        { name: "test", conclusion: "TIMED_OUT" },
      ]),
    ).toBe("lint: FAILURE\ntest: TIMED_OUT");
  });
});

function reviewThread(
  overrides: Partial<ReviewThread> & Pick<ReviewThread, "comments">,
): ReviewThread {
  return {
    isResolved: false,
    isOutdated: false,
    ...overrides,
  };
}

function reviewsPr(
  overrides: Omit<Partial<ReviewsCandidate>, "prNumber"> & { prNumber: number },
): ReviewsCandidate {
  return {
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    threads: [],
    ...overrides,
    prNumber: asPrNumber(overrides.prNumber),
    headRefName: overrides.headRefName ?? asBranchRef(`phoebe/issue-${overrides.prNumber}`),
  };
}

describe("hasNewNonPhoebeReviewActivity", () => {
  const phoebeLogin = "phoebe-bot";

  test("detects new comment on unresolved thread after watermark", () => {
    const threads = [
      reviewThread({
        comments: [
          { authorLogin: "reviewer", createdAt: "2026-06-01T10:00:00Z" },
          { authorLogin: "reviewer", createdAt: "2026-06-02T12:00:00Z" },
        ],
      }),
    ];
    expect(
      hasNewNonPhoebeReviewActivity({
        threads,
        phoebeLogin,
        watermark: { latest: "2026-06-01T11:00:00Z" },
      }),
    ).toBe(true);
  });

  test("ignores Phoebe's own challenge replies", () => {
    const threads = [
      reviewThread({
        comments: [{ authorLogin: phoebeLogin, createdAt: "2026-06-03T12:00:00Z" }],
      }),
    ];
    expect(
      hasNewNonPhoebeReviewActivity({
        threads,
        phoebeLogin,
        watermark: { latest: "2026-06-01T00:00:00Z" },
      }),
    ).toBe(false);
  });

  test("ignores PR author's own replies on human PRs", () => {
    const authorLogin = "human-dev";
    const threads = [
      reviewThread({
        comments: [{ authorLogin, createdAt: "2026-06-03T12:00:00Z" }],
      }),
    ];
    expect(
      hasNewNonPhoebeReviewActivity({
        threads,
        phoebeLogin,
        authorLogin,
        watermark: { latest: "2026-06-01T00:00:00Z" },
      }),
    ).toBe(false);
  });

  test("ignores resolved and outdated threads", () => {
    const threads = [
      reviewThread({
        isResolved: true,
        comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
      }),
      reviewThread({
        isOutdated: true,
        comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
      }),
    ];
    expect(
      hasNewNonPhoebeReviewActivity({
        threads,
        phoebeLogin,
        watermark: null,
      }),
    ).toBe(false);
  });

  test("no watermark treats any non-Phoebe unresolved activity as new", () => {
    const threads = [
      reviewThread({
        comments: [{ authorLogin: "reviewer", createdAt: "2026-06-01T10:00:00Z" }],
      }),
    ];
    expect(
      hasNewNonPhoebeReviewActivity({
        threads,
        phoebeLogin,
        watermark: null,
      }),
    ).toBe(true);
  });
});

describe("newestReviewThreadCommentCreatedAt", () => {
  test("returns newest createdAt across all thread comments", () => {
    const threads = [
      reviewThread({
        comments: [{ authorLogin: "a", createdAt: "2026-06-01T10:00:00Z" }],
      }),
      reviewThread({
        comments: [
          { authorLogin: "b", createdAt: "2026-06-02T08:00:00Z" },
          { authorLogin: "c", createdAt: "2026-06-03T09:00:00Z" },
        ],
      }),
    ];
    expect(newestReviewThreadCommentCreatedAt(threads)).toBe("2026-06-03T09:00:00Z");
  });
});

describe("reviews handled watermark", () => {
  test("builds and parses timestamp marker", () => {
    const marker = buildReviewsHandledMarker({ latest: "2026-06-03T09:00:00Z" });
    expect(marker).toBe("<!-- phoebe-reviews-handled: latest=2026-06-03T09:00:00Z -->");
    expect(parseReviewsHandledWatermark(marker)).toEqual({ latest: "2026-06-03T09:00:00Z" });
  });

  test("parseLatestMarker returns latest reviews marker", () => {
    const older = buildReviewsHandledMarker({ latest: "2026-06-01T00:00:00Z" });
    const newer = buildReviewsHandledMarker({ latest: "2026-06-03T00:00:00Z" });
    expect(
      parseLatestMarker(
        [`done\n${older}`, "unrelated", `retry\n${newer}`],
        parseReviewsHandledWatermark,
      ),
    ).toEqual({ latest: "2026-06-03T00:00:00Z" });
  });
});

describe("buildReviewsHandledComment", () => {
  test("failure comment is visible and embeds marker", () => {
    const comment = buildReviewsHandledComment({
      latestActivityAt: "2026-06-03T09:00:00Z",
      failed: true,
    });
    expect(comment).toContain("attempted to handle review feedback and failed");
    expect(comment).toContain("<!-- phoebe-reviews-handled: latest=2026-06-03T09:00:00Z -->");
  });

  test("success comment is marker only", () => {
    const comment = buildReviewsHandledComment({
      latestActivityAt: "2026-06-03T09:00:00Z",
      failed: false,
    });
    expect(comment).toBe("<!-- phoebe-reviews-handled: latest=2026-06-03T09:00:00Z -->");
  });
});

describe("isReviewSummaryComment", () => {
  test("detects handle-pr-review summary heading", () => {
    expect(isReviewSummaryComment("## Review feedback addressed (abc123)\n\n**Fixed:**")).toBe(
      true,
    );
    expect(isReviewSummaryComment("Phoebe update")).toBe(false);
  });
});

describe("selectReviewsUnit", () => {
  const phoebeLogin = "phoebe-bot";

  test("picks oldest PR with new non-Phoebe review activity", () => {
    const thread = reviewThread({
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const prs = [
      reviewsPr({ prNumber: 120, threads: [thread] }),
      reviewsPr({ prNumber: 115, threads: [thread] }),
    ];
    expect(
      selectReviewsUnit(prs, { issueBodies: new Map(), blockerStates: new Map() }, phoebeLogin)
        ?.prNumber,
    ).toBe(115);
  });

  test("skips conflicting PRs", () => {
    const thread = reviewThread({
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const prs = [
      reviewsPr({
        prNumber: 110,
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
        threads: [thread],
      }),
      reviewsPr({ prNumber: 111, threads: [thread] }),
    ];
    expect(
      selectReviewsUnit(prs, { issueBodies: new Map(), blockerStates: new Map() }, phoebeLogin)
        ?.prNumber,
    ).toBe(111);
  });

  test("skips stacked PRs with open blocker", () => {
    const thread = reviewThread({
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const prs = [reviewsPr({ prNumber: 110, threads: [thread] })];
    const bodies = new Map<number, string>([[110, "Blocked by #108"]]);
    const states = new Map<number, BlockerPrState>([
      [108, { hasOpenPr: true, openPrNumber: asPrNumber(112), hasMergedPr: false }],
    ]);
    expect(
      selectReviewsUnit(prs, { issueBodies: bodies, blockerStates: states }, phoebeLogin),
    ).toBeNull();
  });

  test("skips when watermark covers all activity", () => {
    const thread = reviewThread({
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const prs = [
      reviewsPr({
        prNumber: 110,
        threads: [thread],
        handledWatermark: { latest: "2026-06-03T12:00:00Z" },
      }),
    ];
    expect(
      selectReviewsUnit(prs, { issueBodies: new Map(), blockerStates: new Map() }, phoebeLogin),
    ).toBeNull();
  });

  test("human PR with null issue number and reviewer activity is eligible", () => {
    const thread = reviewThread({
      comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
    });
    const prs = [
      reviewsPr({
        prNumber: 130,
        headRefName: asBranchRef("feature/human-pr"),
        authorLogin: "human-dev",
        threads: [thread],
      }),
    ];
    expect(
      selectReviewsUnit(prs, { issueBodies: new Map(), blockerStates: new Map() }, phoebeLogin)
        ?.prNumber,
    ).toBe(130);
  });
});

describe("selectFirstWorkUnit reviews ordering", () => {
  const phoebeLogin = "phoebe-bot";
  const thread = reviewThread({
    comments: [{ authorLogin: "reviewer", createdAt: "2026-06-03T12:00:00Z" }],
  });

  const reviewsCandidate = reviewsPr({ prNumber: 202, threads: [thread] });

  const checksPr = (prNumber: number): ChecksCandidate => ({
    prNumber: asPrNumber(prNumber),
    headRefName: asBranchRef(`phoebe/issue-${prNumber}`),
    mergeable: "MERGEABLE",
    failingChecks: [{ name: "test", conclusion: "FAILURE" }],
  });

  test("prefers checks before reviews when both match", () => {
    const issues = [issue({ number: 135 })];
    const picked = selectFirstWorkUnit(["conflicts", "checks", "reviews", "issues"], {
      issues,
      blockerStates: new Map(),
      conflictingPrs: [],
      failingCheckPrs: [checksPr(201)],
      reviewActivityPrs: [reviewsCandidate],
      issueBodies: new Map(),
      phoebeLogin,
    });
    expect(picked?.kind).toBe("checks");
  });

  test("takes reviews when no conflicts or checks", () => {
    const issues = [issue({ number: 135 })];
    const picked = selectFirstWorkUnit(["conflicts", "checks", "reviews", "issues"], {
      issues,
      blockerStates: new Map(),
      conflictingPrs: [],
      failingCheckPrs: [],
      reviewActivityPrs: [reviewsCandidate],
      issueBodies: new Map(),
      phoebeLogin,
    });
    expect(picked?.kind).toBe("reviews");
    expect(picked?.kind === "reviews" && picked.unit.prNumber).toBe(202);
  });

  test("under oneShotOnly skips reviews", () => {
    const issues = [issue({ number: 137 })];
    const picked = selectFirstWorkUnit(
      ["conflicts", "checks", "reviews", "issues"],
      {
        issues,
        blockerStates: new Map(),
        conflictingPrs: [],
        failingCheckPrs: [],
        reviewActivityPrs: [reviewsCandidate],
        issueBodies: new Map(),
        phoebeLogin,
      },
      { oneShotOnly: true },
    );
    expect(picked?.kind).toBe("issues");
  });
});

describe("shouldSkipStackedReviewsFix", () => {
  test("aliases stacked conflict skip logic", () => {
    expect(shouldSkipStackedReviewsFix).toBe(shouldSkipStackedConflictFix);
  });
});

describe("selection summaries", () => {
  const conflictPr = (
    overrides: Omit<Partial<ConflictingPrCandidate>, "prNumber"> & { prNumber: number },
  ) =>
    ({
      headSha: asSha(`sha${overrides.prNumber}`),
      ...overrides,
      prNumber: asPrNumber(overrides.prNumber),
      headRefName: overrides.headRefName ?? asBranchRef(`phoebe/issue-${overrides.prNumber}`),
    }) satisfies ConflictingPrCandidate;

  test("summarizeConflictSelection reports stacked and watermark skips with the picked unit", () => {
    const prs = [
      // Stacked on an open blocker → skipped as stacked.
      conflictPr({ prNumber: 100, issueNumber: 100 }),
      // Watermark unchanged (prHead + mainHead match) → skipped as watermark.
      conflictPr({
        prNumber: 101,
        headSha: asSha("pr101"),
        failureWatermark: { prHead: asSha("pr101"), mainHead: asSha("main1") },
      }),
      // Fixable.
      conflictPr({ prNumber: 102, headSha: asSha("pr102"), failureWatermark: null }),
    ];
    const ctx = {
      issueBodies: new Map([[100, "Blocked by #98"]]),
      blockerStates: new Map([
        [98, { hasOpenPr: true, openPrNumber: asPrNumber(200), hasMergedPr: false }],
      ]),
    };
    const summary = summarizeConflictSelection(prs, ctx, { currentMainHead: asSha("main1") });
    expect(summary.skippedStacked).toBe(1);
    expect(summary.skippedWatermark).toBe(1);
    expect(summary.unit?.prNumber).toBe(102);
  });

  test("summarizeChecksSelection counts skips and picks the oldest fixable PR", () => {
    const prs: ChecksCandidate[] = [
      {
        prNumber: asPrNumber(110),
        headRefName: asBranchRef("phoebe/issue-110"),
        mergeable: "MERGEABLE",
        failingChecks: [],
      },
      {
        prNumber: asPrNumber(111),
        headRefName: asBranchRef("phoebe/issue-111"),
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
        failingChecks: [],
      },
    ];
    const summary = summarizeChecksSelection(prs, {
      issueBodies: new Map(),
      blockerStates: new Map(),
    });
    expect(summary.skipped).toBe(1);
    expect(summary.unit?.prNumber).toBe(110);
  });

  test("summarizeReviewsSelection counts PRs with no new activity as skipped", () => {
    const phoebeLogin = "phoebe-bot";
    const prs: ReviewsCandidate[] = [
      {
        prNumber: asPrNumber(120),
        headRefName: asBranchRef("phoebe/issue-120"),
        mergeable: "MERGEABLE",
        threads: [
          {
            isResolved: false,
            isOutdated: false,
            comments: [{ createdAt: "2026-06-01T00:00:00Z", authorLogin: "human" }],
          },
        ],
      },
      {
        prNumber: asPrNumber(121),
        headRefName: asBranchRef("phoebe/issue-121"),
        mergeable: "MERGEABLE",
        threads: [
          {
            isResolved: false,
            isOutdated: false,
            comments: [{ createdAt: "2026-06-01T00:00:00Z", authorLogin: phoebeLogin }],
          },
        ],
      },
    ];
    const summary = summarizeReviewsSelection(
      prs,
      { issueBodies: new Map(), blockerStates: new Map() },
      phoebeLogin,
    );
    expect(summary.skipped).toBe(1);
    expect(summary.unit?.prNumber).toBe(120);
  });
});

describe("slugifyFailureSignature", () => {
  test("lowercases and hyphenates", () => {
    expect(slugifyFailureSignature("Mergeable CONFLICTING")).toBe("mergeable-conflicting");
  });
  test("falls back to unknown for empty input", () => {
    expect(slugifyFailureSignature("")).toBe("unknown");
  });
  test("truncates to maxLen", () => {
    expect(slugifyFailureSignature("a".repeat(200), 10)).toBe("a".repeat(10));
  });
});

describe("conflictFailureSignature", () => {
  test("no mergeable info — clean-merge setup failed before an agent ran", () => {
    expect(conflictFailureSignature({})).toBe("merge-setup-failed");
  });
  test("embeds mergeable + mergeStateStatus", () => {
    expect(conflictFailureSignature({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })).toBe(
      "mergeable-conflicting-dirty",
    );
  });
});

describe("checksFailureSignature", () => {
  test("no failing checks recorded", () => {
    expect(checksFailureSignature([])).toBe("checks-failed");
  });
  test("embeds failing check names", () => {
    expect(checksFailureSignature([{ name: "lint", conclusion: "failure" }])).toBe(
      "checks-failed-lint",
    );
  });
});

describe("issueAttemptFailureSignature (#22)", () => {
  test("embeds the verification report's failed command", () => {
    expect(issueAttemptFailureSignature({ failedCommand: "apply_patch", agentExitCode: 1 })).toBe(
      "apply-patch-failed",
    );
  });
  test("falls back to the agent exit code with no verification report", () => {
    expect(issueAttemptFailureSignature({ agentExitCode: 2 })).toBe("agent-exit-2");
  });
  test("falls back to a generic marker with no signal at all", () => {
    expect(issueAttemptFailureSignature({ agentExitCode: null })).toBe("no-commit-produced");
    expect(issueAttemptFailureSignature({ agentExitCode: 0 })).toBe("no-commit-produced");
  });
});

describe("findBlockedDependents (#22)", () => {
  test("finds open issues that name the quarantined issue as a body blocker", () => {
    const issues = [
      issue({ number: 763, body: "Blocked by #784" }),
      issue({ number: 700, body: "Blocked by #784\nAlso relates to #1" }),
      issue({ number: 900, body: "unrelated" }),
    ];
    expect(findBlockedDependents(784, issues)).toEqual([763, 700]);
  });

  test("finds dependents via native blockers", () => {
    setResolvedConfig(resolveConfig({ ...sampleUserConfig, blockerSource: "native" }));
    try {
      const issues = [issue({ number: 50, body: "no body refs" })];
      const nativeBlockersByIssue = new Map([[50, [784]]]);
      expect(findBlockedDependents(784, issues, nativeBlockersByIssue)).toEqual([50]);
    } finally {
      setResolvedConfig(resolveConfig(sampleUserConfig));
    }
  });

  test("excludes the issue itself even if self-referential", () => {
    const issues = [issue({ number: 784, body: "Blocked by #784" })];
    expect(findBlockedDependents(784, issues)).toEqual([]);
  });

  test("empty when nothing depends on it", () => {
    const issues = [issue({ number: 1, body: "" })];
    expect(findBlockedDependents(784, issues)).toEqual([]);
  });
});

describe("filterBackoffEligible", () => {
  const now = "2026-08-04T12:00:00.000Z";

  test("a candidate with no attempt marker is always eligible", () => {
    const candidates = [{ attemptMarker: null }];
    expect(filterBackoffEligible(candidates, now)).toEqual(candidates);
  });

  test("drops a candidate still inside its backoff window", () => {
    const candidates = [
      {
        prNumber: 1,
        attemptMarker: { n: 1, signature: "s", ref: "sha1", at: "2026-08-04T11:59:00.000Z" },
      },
    ];
    expect(filterBackoffEligible(candidates, now)).toEqual([]);
  });

  test("keeps a candidate once its backoff window has elapsed", () => {
    const candidates = [
      {
        prNumber: 1,
        attemptMarker: { n: 1, signature: "s", ref: "sha1", at: "2026-08-04T11:00:00.000Z" },
      },
    ];
    expect(filterBackoffEligible(candidates, now)).toEqual(candidates);
  });
});
