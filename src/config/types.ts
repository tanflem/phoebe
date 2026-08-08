// Hand-written config types: the shape of `phoebe.config.ts` (`PhoebeUserConfig`)
// and the fully-resolved shape the engine runs against (`PhoebeConfig`), plus the
// small supporting types and enum consts every layer of the config seam shares.
//
// These types are not derived from the roster (./roster.ts) — the roster is
// checked *against* them (`Record<keyof PhoebeUserConfig, FieldDescriptor>`),
// so adding a field here without describing it in the roster is a compile error.

import { isAbsolute } from "node:path";

export const PROVIDER_NAMES = ["cursor", "claude", "codex"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/**
 * Where the engine discovers an issue's blockers. `body` reads
 * `blockedByPattern` over the issue body text (the original, repo-agnostic but
 * fragile source); `native` reads GitHub's issue-dependencies API
 * (`repos/{owner}/{repo}/issues/{n}/dependencies/blocked_by`); `both` unions the
 * two and deduplicates. Defaults to `body` so existing consumers keep their
 * exact behavior until they opt in.
 */
export const BLOCKER_SOURCES = ["body", "native", "both"] as const;
export type BlockerSource = (typeof BLOCKER_SOURCES)[number];

/**
 * How the engine stacks a PR whose issue is blocked by another issue with an
 * open PR (see `resolveWorktreeBase`). All three modes share the same *skip*
 * decision — a blocker with no open/merged PR still parks the issue — they
 * differ only in how the resulting PR relates to its blocker:
 *
 *  - `banner` (default): today's behavior, unchanged. The run's branch is cut
 *    off the blocker's branch (`origin/phoebe/issue-<blocker>`) so the blocker's
 *    commits ride along, but the PR is opened against `defaultBranch`; a
 *    ⛓️ "do not merge before the blocker" banner is added to the body and the
 *    maintenance flows lazily catch the branch up to `main` as blockers merge.
 *  - `native`: true GitHub stacked PRs. The branch is cut off the blocker's
 *    branch exactly as in `banner`, but the PR is opened *against the blocker's
 *    branch* and registered into a native GitHub stack via `gh stack link`, so
 *    the PR diff shows only this issue's commits. GitHub only retargets a PR
 *    onto `main` on its own when the base branch is *deleted*; tenant repos
 *    keep merged branches around, so the engine retargets explicitly instead
 *    (`retargetMergedStackedPrs` in main.ts, run every cycle). The banner and
 *    catch-up-merge steps are skipped.
 *  - `off`: no stacking at all. Even with an open blocker PR the branch is cut
 *    off `origin/main` and the PR opened against `defaultBranch` with no banner.
 *    Blockers are still honored for the skip decision.
 *
 * `PHOEBE_BASE` overrides all of this: an explicit base forces that base and
 * disables stacking regardless of `stackMode` (see `resolveWorktreeBase`).
 * Defaults to `banner` so existing consumers keep their exact behavior.
 */
export const STACK_MODES = ["banner", "native", "off"] as const;
export type StackMode = (typeof STACK_MODES)[number];

/**
 * Selects where the thin `phoebe boot` bootstrapper materializes the engine
 * from — a GitHub ref (branch/tag/SHA, defaulting to `main` on the shipped
 * engine repo) or a local mount. The engine itself never reads this: it is a
 * bootstrapper concern, resolved by `bootstrap/engine-source.ts`. It lives on
 * `PhoebeUserConfig` only so a consumer config that sets it still type-checks,
 * and `resolveConfiguration` deliberately drops it — it never reaches
 * `PhoebeConfig`.
 */
export type EngineSourceField =
  | { source: "github"; ref?: string; repo?: string }
  | { source: "local" };

/** Canonical engine source shared by the bootstrapper and config inspection CLI. */
export type ResolvedEngineSource =
  | { source: "github"; ref: string; repo: string }
  | { source: "local" };

/** Runtime validation shared by repository and generated engine-source fields. */
export function validateEngineSourceField(
  value: unknown,
  context = "phoebe.config.ts `engine`",
): asserts value is EngineSourceField {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${context} must be { source: "github", ref?, repo? } or { source: "local" } ` +
        `with string ref/repo (got ${JSON.stringify(value)}).`,
    );
  }
  const field = value as Record<string, unknown>;
  const unknown = Object.keys(field).filter((key) => !["source", "ref", "repo"].includes(key));
  const validLocal =
    field["source"] === "local" && field["ref"] === undefined && field["repo"] === undefined;
  const validGithub =
    field["source"] === "github" &&
    (field["ref"] === undefined || typeof field["ref"] === "string") &&
    (field["repo"] === undefined || typeof field["repo"] === "string");
  if (unknown.length > 0 || (!validLocal && !validGithub)) {
    const unknownDetail =
      unknown.length > 0
        ? ` Unknown field(s): ${unknown.map((key) => `${context}.${key}`).join(", ")}.`
        : "";
    throw new Error(
      `${context} must be { source: "github", ref?, repo? } or { source: "local" } ` +
        `with string ref/repo (got ${JSON.stringify(value)}).${unknownDetail}`,
    );
  }
}

/**
 * Where issues are discovered, labeled, and commented on, when it differs
 * from the repo being worked (#21) — e.g. a team whose planning tracker is a
 * separate repo from its codebase. `readyLabel` defaults to the tenant's own
 * `readyLabel` when omitted. Discovery, blocker resolution, label
 * transitions, claim/release comments, and the research queue all address
 * this repo; clone, worktree, branch, PR, and status identity stay on
 * `repoSlug` regardless.
 */
export type IssueSourceConfig = {
  repoSlug: string;
  readyLabel?: string;
};

/**
 * Bootstrapper-only workspace discovery knobs (#83/#97). Presence of this
 * block on the deployment-root config selects workspace mode; `depth` is how
 * many directory levels under the root the bootstrapper scans for tenant
 * configs (integer ≥ 1, default 1). The engine never reads this: it lives on
 * `PhoebeUserConfig` so a consumer config that sets it still type-checks, and
 * `resolveConfiguration` deliberately drops it — it never reaches `PhoebeConfig`.
 */
export type WorkspaceField = {
  /** Scan depth under the workspace root; omit ⇒ 1. */
  depth?: number;
};

export type PromptFilesConfig = {
  issue: string;
  conflict: string;
  checks: string;
  reviews: string;
  research: string;
};

export type PathsConfig = {
  /** The private clone (origin hub). */
  repoDir: string;
  /** Per-unit git worktrees. */
  worktreesDir: string;
  /** Per-tenant state (status-v2.json, runtime-id, events-v1/). */
  stateDir: string;
};

export type PhoebeConfig = {
  /** GitHub `owner/repo` slug, passed to every `gh -R` call. */
  repoSlug: string;
  /** HTTPS clone URL for the container's private clone. */
  repoUrl: string;
  /** Branch PRs target and worktrees base off (usually `main`). */
  defaultBranch: string;
  /** Prefix for agent branches; issue branches are `<prefix>issue-<n>`. */
  branchPrefix: string;
  /** Label marking issues Phoebe may pick up. */
  readyLabel: string;
  /**
   * Resolved issue-discovery target — always populated, defaulting to
   * `{ repoSlug, readyLabel }` when the user omits `issueSource` entirely, so
   * every call site can read `config.issueSource.*` unconditionally (#21).
   */
  issueSource: {
    repoSlug: string;
    readyLabel: string;
  };
  /** Label marking wayfinder research tickets the `research` work kind picks up. */
  researchLabel: string;
  /** Label the agent applies to an issue it has claimed and is working. */
  processingLabel: string;
  /** Which open PRs the conflicts/checks/reviews work-kinds scan.
   *  "phoebe" = only branchPrefix branches. "all" = any same-repo PR. */
  prScope: "phoebe" | "all";
  /** Optional GitHub logins allowed into PR scans. Empty means every author. */
  prAuthors: readonly string[];
  /** Which PR base branches janitors scan.
   *  "default" = only defaultBranch. "all" = every base branch. */
  prBaseScope: "default" | "all";
  /** Draft PR handling: "skip-non-phoebe" = drafts on non-Phoebe branches are
   *  off-limits; "skip-all" = never touch drafts; "include" = drafts are fair game. */
  draftPrs: "skip-non-phoebe" | "skip-all" | "include";
  /** PRs carrying this label are excluded from the PR scan in every mode. */
  prOptOutLabel: string;
  /** Shell command strings — toolchains differ per repo, so these are data. */
  installCommand: string;
  checkCommand: string;
  testCommand: string;
  /** The all-in-one gate the agent runs before pushing (e.g. `npm run ready`).
   *  Substituted into default prompts as `{{READY_COMMAND}}`. */
  readyCommand: string;
  /**
   * JavaScript-compatible regex source that matches an issue-blocker reference
   * in issue body text. Must expose the blocker issue number as capture group 1.
   * Compiled with the `gi` flags.
   */
  blockedByPattern: string;
  /**
   * Where issue blockers are discovered — see {@link BlockerSource}. `body`
   * reads `blockedByPattern` over the issue body; `native` reads GitHub's
   * issue-dependencies API; `both` unions and deduplicates the two.
   */
  blockerSource: BlockerSource;
  /**
   * How a blocked issue's PR is stacked on its blocker — see {@link StackMode}.
   * `banner` (default) keeps the historical branch-off-blocker + banner +
   * catch-up behavior with the PR based on `defaultBranch`; `native` opens the
   * PR against the blocker's branch and registers a GitHub-native stack; `off`
   * disables stacking entirely.
   */
  stackMode: StackMode;
  /**
   * Markdown heading the reviews agent must include when it posts its summary
   * comment. The orchestrator detects the summary by substring match on this
   * exact string, so it must be unique enough not to collide with other
   * comments. Substituted into the default reviews prompt as
   * `{{REVIEWS_SUCCESS_HEADING}}`.
   */
  reviewsSuccessHeading: string;
  /**
   * Prompt template paths, relative to the runtime root (process cwd —
   * consumer checkout on the host; `/etc/phoebe` in the container where
   * compose mounts config + `prompts/`). Absolute paths are accepted as-is.
   */
  promptFiles: PromptFilesConfig;
  /** Ordered work kinds, validated by the orchestrator at startup. */
  workOrder: readonly string[];
  defaultProvider: ProviderName;
  defaultModels: Record<ProviderName, string>;
  /** Env var holding each provider's API key — the only key the agent child inherits. */
  providerEnv: Record<ProviderName, string>;
  /**
   * Whole-unit wall-clock budget in ms (#72). A fleet-protection backstop: a
   * hung unit that exceeds this has its agent subprocess killed so it cannot
   * hold the #59 concurrency slot forever. Env-overridable via
   * `PHOEBE_RUN_TIMEOUT_MS`. Default 45 min.
   */
  runTimeoutMs: number;
  /**
   * Consecutive per-unit timeouts before a unit is quarantined and escalated to
   * a human (#75). Env-overridable via `PHOEBE_MAX_UNIT_TIMEOUTS`. Default 3.
   */
  maxUnitTimeouts: number;
  /**
   * Consecutive no-progress attempts before a unit is quarantined — no commit
   * for a PR-keyed unit (conflicts/checks, #25), or no resulting PR for an
   * issue-keyed one (issues/research, #22) — the fails-fast sibling of
   * `maxUnitTimeouts`. Env-overridable via `PHOEBE_MAX_UNIT_ATTEMPTS`. Default 3.
   */
  maxUnitAttempts: number;
  /**
   * How long a `processingLabel` claim's lease may go without a heartbeat
   * before Phoebe reclaims it back to `readyLabel` (#15). Env-overridable via
   * `PHOEBE_LEASE_TTL_MS`. Default 30 min.
   */
  leaseTtlMs: number;
  /**
   * Per-tenant filesystem layout. Not user-supplied: derived from `repoSlug`
   * and the deployment data base by `resolveConfiguration` (see src/paths.ts,
   * #58/#62).
   */
  paths: PathsConfig;
};

/**
 * User-facing shape of `phoebe.config.ts`. Only the five fields with no sane
 * cross-repo default are required; everything else is optional and filled from
 * the roster's defaults (./roster.ts) by `resolveConfiguration()`. Nested
 * objects (`promptFiles`, `defaultModels`, `providerEnv`) are merged
 * key-by-key, so overriding one provider's model or one prompt file does not
 * force the caller to supply the rest. `paths` is *not* here: it is derived
 * from `repoSlug` (src/paths.ts).
 */
export type PhoebeUserConfig = {
  repoSlug: string;
  repoUrl: string;
  installCommand: string;
  checkCommand: string;
  testCommand: string;
  /** Bootstrapper-only engine source (see {@link EngineSourceField}). The
   *  engine ignores it; `resolveConfiguration` drops it. Omitted ⇒ github/main. */
  engine?: EngineSourceField;
  /**
   * Bootstrapper-only workspace discovery (see {@link WorkspaceField}).
   * Presence of this block selects workspace discovery mode (#83/#91); `depth`
   * is how many directory levels under the root to scan for child configs
   * (default 1 when omitted). The engine never reads it; `resolveConfiguration`
   * drops it the same way it drops `engine`.
   */
  workspace?: WorkspaceField;
  /**
   * Bootstrapper-only asset directory (#98). Relocates where this tenant's
   * co-located `.env` and prompt/asset files live to a subdirectory of the dir
   * holding this `phoebe.config.ts` — e.g. `configDir: ".phoebe"` reuses a
   * standalone deployment's `.phoebe/` folder instead of duplicating `.env` and
   * `prompts/` at the repo root. Default `"."` (co-located — today's behavior).
   *
   * Honored for fleet tenants (workspace children + nested `repos/`): the
   * supervisor reads the tenant `.env` from `<dir>/<configDir>/.env` and runs
   * the tenant's engine child with cwd `<dir>/<configDir>` (so relative
   * `promptFiles` resolve there), while still loading THIS config from `<dir>`.
   * The `phoebe.config.ts` itself must stay at `<dir>` — workspace discovery
   * skips dotfolders, so it cannot live inside `.phoebe/`. Must be a relative
   * path with no `..`. The engine never reads it; `resolveConfiguration` drops it.
   */
  configDir?: string;
  defaultBranch?: string;
  branchPrefix?: string;
  readyLabel?: string;
  /** Split issue discovery from the work repo (#21). Omitted ⇒ same repo. */
  issueSource?: IssueSourceConfig;
  researchLabel?: string;
  processingLabel?: string;
  prScope?: PhoebeConfig["prScope"];
  prAuthors?: readonly string[];
  prBaseScope?: PhoebeConfig["prBaseScope"];
  draftPrs?: PhoebeConfig["draftPrs"];
  prOptOutLabel?: string;
  readyCommand?: string;
  blockedByPattern?: string;
  blockerSource?: BlockerSource;
  stackMode?: StackMode;
  reviewsSuccessHeading?: string;
  promptFiles?: Partial<PromptFilesConfig>;
  workOrder?: readonly string[];
  defaultProvider?: ProviderName;
  defaultModels?: Partial<Record<ProviderName, string>>;
  providerEnv?: Partial<Record<ProviderName, string>>;
  /** Whole-unit wall-clock timeout in ms (#72); default 45 min. */
  runTimeoutMs?: number;
  /** Consecutive timeouts before a unit is quarantined (#75); default 3. */
  maxUnitTimeouts?: number;
  /** Consecutive no-progress attempts before a unit is quarantined (#25, #22); default 3. */
  maxUnitAttempts?: number;
  /** Claim-lease TTL in ms before an orphaned claim is reclaimed (#15); default 30 min. */
  leaseTtlMs?: number;
};

export const WORK_KIND_NAMES = ["conflicts", "checks", "reviews", "issues", "research"] as const;
export type WorkKindName = (typeof WORK_KIND_NAMES)[number];

/** Fail fast when the configured work order is empty or names an unknown kind. */
export function validateWorkOrder(order: readonly string[]): readonly WorkKindName[] {
  if (order.length === 0) {
    throw new Error(
      `WORK_ORDER must not be empty. Include at least one of: ${WORK_KIND_NAMES.join(", ")}.`,
    );
  }
  const validated: WorkKindName[] = [];
  for (const kind of order) {
    if (!WORK_KIND_NAMES.includes(kind as WorkKindName)) {
      throw new Error(
        `Unknown work kind "${kind}" in WORK_ORDER. Use one of: ${WORK_KIND_NAMES.join(", ")}.`,
      );
    }
    validated.push(kind as WorkKindName);
  }
  return validated;
}

/**
 * Reject a malformed bootstrapper-only `configDir`. It relocates a tenant's
 * asset directory (`.env`, prompts) to a subdirectory of the config's own dir,
 * so it must be a non-empty *relative* path that stays inside that dir — an
 * absolute path or a `..` segment would point the supervisor at another
 * tenant's (or the host's) secrets. Named so a mistyped consumer config fails
 * loudly the same way `workspace`/`blockedByPattern` do, even though only the
 * bootstrapper reads the value. Wired into the roster (./roster.ts) as
 * `configDir`'s `validate`.
 */
export function validateConfigDir(value: unknown, location: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `${location} must be a non-empty relative path (got ${JSON.stringify(value)}).`,
    );
  }
  if (isAbsolute(value)) {
    throw new Error(
      `${location} must be relative to the config's directory, not absolute ` +
        `(got ${JSON.stringify(value)}).`,
    );
  }
  if (value.split(/[/\\]/).some((segment) => segment === "..")) {
    throw new Error(
      `${location} must stay within the tenant directory — no ".." segments ` +
        `(got ${JSON.stringify(value)}).`,
    );
  }
}

/**
 * Reject a malformed bootstrapper-only `workspace` block. Presence is enough
 * to select workspace mode later; `depth` must be an integer ≥ 1 when set, and
 * omitted `depth` is fine (bootstrap defaults it to 1). Wired into the roster
 * (./roster.ts) as `workspace`'s `validate`.
 */
export function validateWorkspaceField(value: unknown, location: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location} must be { depth?: integer ≥ 1 } (got ${JSON.stringify(value)}).`);
  }
  const { depth } = value as WorkspaceField;
  if (depth === undefined) return;
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1) {
    throw new Error(`${location}.depth must be an integer ≥ 1 (got ${JSON.stringify(depth)}).`);
  }
}

/**
 * Reject a malformed `issueSource` (#21): an object with a required non-empty
 * `repoSlug`, an optional string `readyLabel`, and no other keys. Wired into
 * the roster (./roster.ts) as `issueSource`'s `validate`.
 */
export function validateIssueSource(value: unknown, location: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location} must be an object of the form { repoSlug, readyLabel? }.`);
  }
  const { repoSlug, readyLabel, ...rest } = value as Record<string, unknown>;
  const unknownKeys = Object.keys(rest);
  if (unknownKeys.length > 0) {
    throw new Error(`${location} has unknown field(s): ${unknownKeys.join(", ")}.`);
  }
  if (typeof repoSlug !== "string" || repoSlug.trim().length === 0) {
    throw new Error(`${location}.repoSlug must be a non-empty string.`);
  }
  if (readyLabel !== undefined && typeof readyLabel !== "string") {
    throw new Error(`${location}.readyLabel must be a string.`);
  }
}

/**
 * Count the numbered capture groups defined by a regex source. We compile it
 * with an added empty alternative (`|`) so the resulting regex always matches
 * the empty string; the match array's length minus one then equals the number
 * of capture groups, regardless of whether the original pattern would have
 * matched anything on its own. Escaped parens, non-capturing groups (`(?:…)`),
 * lookarounds, and named groups are handled correctly because we're asking
 * the engine's own group count, not parsing the source ourselves.
 */
function countCaptureGroups(source: string): number {
  const compiled = new RegExp(`${source}|`);
  const match = compiled.exec("");
  // The extra `|` guarantees a match against ""; TS still narrows to nullable.
  if (!match) {
    return 0;
  }
  return match.length - 1;
}

/**
 * Reject a `blockedByPattern` that is not a valid regex, or one that is valid
 * but does not expose the blocker issue number as capture group 1.
 * `parseBlockedBy` reads `match[1]`, so a pattern without a capture group would
 * silently break the entire blocker-detection path — reject it up front. Wired
 * into the roster (./roster.ts) as `blockedByPattern`'s `validate`.
 */
export function validateBlockedByPattern(value: unknown, location: string): void {
  if (typeof value !== "string") {
    throw new Error(`${location} must be a string.`);
  }
  try {
    new RegExp(value, "gi");
  } catch (err) {
    throw new Error(`${location} is not a valid regex: ${(err as Error).message}`);
  }
  if (countCaptureGroups(value) < 1) {
    throw new Error(
      `${location} must define capture group 1 for the blocker issue number ` +
        `(parseBlockedBy reads match[1]). Wrap the number portion in parentheses, ` +
        `e.g. String.raw\`Blocked by\\s+#(\\d+)\`.`,
    );
  }
}
