// Shape of the repo-specific configuration the Phoebe engine runs against.
// The values live in ../phoebe.config.ts — the single file allowed to mention
// this repository. Engine modules (everything under src/) import the resolved
// config from ./resolved-config.ts and stay repo-agnostic;
// src/config-seam.test.ts enforces it.
//
// Two shapes live here. `PhoebeUserConfig` is what a consumer writes: only the
// unavoidable repo/toolchain fields are required; everything else is optional
// and filled from `CONFIG_DEFAULTS` by `resolveConfig()`. `PhoebeConfig` is the
// fully-resolved shape the engine sees at runtime — every field populated.

export const PROVIDER_NAMES = ["cursor", "claude", "codex"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/**
 * Selects where the thin `phoebe boot` bootstrapper materializes the engine
 * from — a GitHub ref (branch/tag/SHA, defaulting to `main` on the shipped
 * engine repo) or a local mount. The engine itself never reads this: it is a
 * bootstrapper concern, resolved by `bootstrap/engine-source.ts`. It lives on
 * `PhoebeUserConfig` only so a consumer config that sets it still type-checks,
 * and `resolveConfig` deliberately drops it — it never reaches `PhoebeConfig`.
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
  /** Lock, markers, logs. */
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
  /** Reasoning-effort flag passed to each provider's CLI. `undefined` ⇒ the
   *  provider is invoked without an effort flag (the CLI's own default). */
  defaultEfforts: Record<ProviderName, string | undefined>;
  /** Env var holding each provider's API key — the only key the agent child inherits. */
  providerEnv: Record<ProviderName, string>;
  /** Container filesystem layout (named volumes). */
  paths: PathsConfig;
};

/**
 * User-facing shape of `phoebe.config.ts`. Only the five fields with no sane
 * cross-repo default are required; everything else is optional and filled from
 * `CONFIG_DEFAULTS` by `resolveConfig()`. Nested objects (`promptFiles`,
 * `paths`, `defaultModels`, `defaultEfforts`, `providerEnv`) are merged
 * key-by-key, so overriding one provider's model or one prompt file does not
 * force the caller to supply the rest.
 */
export type PhoebeUserConfig = {
  repoSlug: string;
  repoUrl: string;
  installCommand: string;
  checkCommand: string;
  testCommand: string;
  /** Bootstrapper-only engine source (see {@link EngineSourceField}). The
   *  engine ignores it; `resolveConfig` drops it. Omitted ⇒ github/main. */
  engine?: EngineSourceField;
  defaultBranch?: string;
  branchPrefix?: string;
  readyLabel?: string;
  researchLabel?: string;
  processingLabel?: string;
  prScope?: PhoebeConfig["prScope"];
  prAuthors?: readonly string[];
  prBaseScope?: PhoebeConfig["prBaseScope"];
  draftPrs?: PhoebeConfig["draftPrs"];
  prOptOutLabel?: string;
  readyCommand?: string;
  blockedByPattern?: string;
  reviewsSuccessHeading?: string;
  promptFiles?: Partial<PromptFilesConfig>;
  workOrder?: readonly string[];
  defaultProvider?: ProviderName;
  defaultModels?: Partial<Record<ProviderName, string>>;
  defaultEfforts?: Partial<Record<ProviderName, string | undefined>>;
  providerEnv?: Partial<Record<ProviderName, string>>;
  paths?: Partial<PathsConfig>;
};

/**
 * Engine defaults for every optional user field. These land in the resolved
 * config whenever the consumer's `phoebe.config.ts` omits them, so a minimal
 * consumer config only has to name the repo and its three toolchain commands.
 */
export const CONFIG_DEFAULTS = {
  defaultBranch: "main",
  branchPrefix: "phoebe/",
  readyLabel: "ready-for-agent",
  researchLabel: "wayfinder:research",
  processingLabel: "processing",
  prScope: "phoebe" as const,
  prAuthors: [] as readonly string[],
  prBaseScope: "default" as const,
  draftPrs: "skip-non-phoebe" as const,
  prOptOutLabel: "ready-for-human",
  readyCommand: "npm run ready",
  blockedByPattern: String.raw`Blocked by\s+#(\d+)`,
  reviewsSuccessHeading: "## Review feedback addressed",
  promptFiles: {
    issue: "prompts/issues-prompt.md",
    conflict: "prompts/conflict-prompt.md",
    checks: "prompts/checks-prompt.md",
    reviews: "prompts/reviews-prompt.md",
    research: "prompts/research-prompt.md",
  } satisfies PromptFilesConfig,
  workOrder: ["conflicts", "checks", "reviews", "issues", "research"] as readonly string[],
  defaultProvider: "cursor" as ProviderName,
  defaultModels: {
    cursor: "composer-2.5",
    claude: "claude-sonnet-4-6",
    codex: "gpt-5.4-mini",
  } satisfies Record<ProviderName, string>,
  defaultEfforts: {
    cursor: undefined,
    claude: "xhigh",
    codex: undefined,
  } satisfies Record<ProviderName, string | undefined>,
  providerEnv: {
    cursor: "CURSOR_API_KEY",
    claude: "ANTHROPIC_API_KEY",
    codex: "OPENAI_KEY",
  } satisfies Record<ProviderName, string>,
  paths: {
    repoDir: "/data/repo",
    worktreesDir: "/data/worktrees",
    stateDir: "/data/state",
  } satisfies PathsConfig,
} as const;

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

const REQUIRED_USER_FIELDS = [
  "repoSlug",
  "repoUrl",
  "installCommand",
  "checkCommand",
  "testCommand",
] as const satisfies readonly (keyof PhoebeUserConfig)[];

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
 * Throw when a required field is missing or blank, or when `blockedByPattern`
 * is not a valid regex or fails to expose the blocker issue number as capture
 * group 1. `parseBlockedBy` reads `match[1]`, so a pattern without a capture
 * group would silently break the entire blocker-detection path — reject it up
 * front. Kept separate from `resolveConfig` so consumers or tests can validate
 * a config independent of the defaults merge.
 */
export function validateUserConfig(user: PhoebeUserConfig): void {
  const missing = REQUIRED_USER_FIELDS.filter((key) => {
    const value = user[key];
    return typeof value !== "string" || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new Error(
      `phoebe.config.ts is missing required field(s): ${missing.join(", ")}. ` +
        `Only these five fields are required — the engine fills the rest from its defaults.`,
    );
  }
  if (user.blockedByPattern !== undefined) {
    try {
      new RegExp(user.blockedByPattern, "gi");
    } catch (err) {
      throw new Error(
        `phoebe.config.ts blockedByPattern is not a valid regex: ${(err as Error).message}`,
      );
    }
    if (countCaptureGroups(user.blockedByPattern) < 1) {
      throw new Error(
        `phoebe.config.ts blockedByPattern must define capture group 1 for the ` +
          `blocker issue number (parseBlockedBy reads match[1]). Wrap the number ` +
          `portion in parentheses, e.g. String.raw\`Blocked by\\s+#(\\d+)\`.`,
      );
    }
  }
}

/**
 * Merge a user config with `CONFIG_DEFAULTS` and return the fully-populated
 * shape the engine runs against. Nested records are shallow-merged so partial
 * overrides (one prompt file, one provider's env var, etc.) work as expected.
 */
export function resolveConfig(user: PhoebeUserConfig): PhoebeConfig {
  validateUserConfig(user);
  return {
    repoSlug: user.repoSlug,
    repoUrl: user.repoUrl,
    installCommand: user.installCommand,
    checkCommand: user.checkCommand,
    testCommand: user.testCommand,
    defaultBranch: user.defaultBranch ?? CONFIG_DEFAULTS.defaultBranch,
    branchPrefix: user.branchPrefix ?? CONFIG_DEFAULTS.branchPrefix,
    readyLabel: user.readyLabel ?? CONFIG_DEFAULTS.readyLabel,
    researchLabel: user.researchLabel ?? CONFIG_DEFAULTS.researchLabel,
    processingLabel: user.processingLabel ?? CONFIG_DEFAULTS.processingLabel,
    prScope: user.prScope ?? CONFIG_DEFAULTS.prScope,
    prAuthors: user.prAuthors ?? CONFIG_DEFAULTS.prAuthors,
    prBaseScope: user.prBaseScope ?? CONFIG_DEFAULTS.prBaseScope,
    draftPrs: user.draftPrs ?? CONFIG_DEFAULTS.draftPrs,
    prOptOutLabel: user.prOptOutLabel ?? CONFIG_DEFAULTS.prOptOutLabel,
    readyCommand: user.readyCommand ?? CONFIG_DEFAULTS.readyCommand,
    blockedByPattern: user.blockedByPattern ?? CONFIG_DEFAULTS.blockedByPattern,
    reviewsSuccessHeading: user.reviewsSuccessHeading ?? CONFIG_DEFAULTS.reviewsSuccessHeading,
    promptFiles: { ...CONFIG_DEFAULTS.promptFiles, ...user.promptFiles },
    workOrder: user.workOrder ?? CONFIG_DEFAULTS.workOrder,
    defaultProvider: user.defaultProvider ?? CONFIG_DEFAULTS.defaultProvider,
    defaultModels: { ...CONFIG_DEFAULTS.defaultModels, ...user.defaultModels },
    defaultEfforts: { ...CONFIG_DEFAULTS.defaultEfforts, ...user.defaultEfforts },
    providerEnv: { ...CONFIG_DEFAULTS.providerEnv, ...user.providerEnv },
    paths: { ...CONFIG_DEFAULTS.paths, ...user.paths },
  };
}
