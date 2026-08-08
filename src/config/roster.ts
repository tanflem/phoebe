// The config seam's one total field-descriptor table (#42, #55). Every field on
// `PhoebeUserConfig` is described exactly once here — kind, default, env
// overlay key, base-document eligibility, and any extra shape validation —
// instead of five parallel lists (`CONFIG_FIELDS`, `BASE_CONFIG_FIELDS`,
// `STRING_FIELDS`, `NESTED_STRING_FIELDS`, `ENV_OVERLAY_KEYS`) that could (and
// did, #36) drift out of sync with each other and with `PhoebeUserConfig`.
//
// `ROSTER`'s `as const satisfies Record<keyof PhoebeUserConfig, FieldDescriptor>`
// is total *by construction*: TypeScript rejects the file the moment a field is
// added to `PhoebeUserConfig` (./types.ts) without a matching roster entry, and
// rejects a roster entry naming a field `PhoebeUserConfig` doesn't have. This is
// implementation for the rest of `src/config/` — never exported from `index.ts`.

import {
  BLOCKER_SOURCES,
  PROVIDER_NAMES,
  STACK_MODES,
  WORK_KIND_NAMES,
  validateBlockedByPattern,
  validateConfigDir,
  validateEngineSourceField,
  validateIssueSource,
  validateWorkOrder,
  validateWorkspaceField,
  type PhoebeUserConfig,
} from "./types.ts";

const PR_SCOPE_VALUES = ["phoebe", "all"] as const;
const PR_BASE_SCOPE_VALUES = ["default", "all"] as const;
const DRAFT_PRS_VALUES = ["skip-non-phoebe", "skip-all", "include"] as const;

export type FieldKind =
  | { type: "string" }
  | { type: "number" }
  | { type: "enum"; values: readonly string[] }
  | { type: "string-array" }
  | { type: "nested"; keys: readonly string[] }
  | { type: "required" }
  | { type: "derived" }
  | { type: "bootstrapper-only" };

export type FieldDescriptor = {
  kind: FieldKind;
  /** Shipped default for an omitted optional field. Absent for `required`,
   *  `derived`, and `bootstrapper-only` fields, which have none. */
  default?: unknown;
  /** `PHOEBE_*` scalar/enum overlay key. Absent when the field is not
   *  env-overridable through the config-resolution overlay. */
  env?: string;
  /** Whether the generated deployment-wide base document may set this field
   *  (see #21/#42's "repository-owned" vs deployment-wide split). */
  baseAllowed: boolean;
  /** Extra shape validation beyond `kind`, run against a present value with a
   *  location string to embed in the thrown error. */
  validate?: (value: unknown, location: string) => void;
};

function assertOneOf(values: readonly string[]): (value: unknown, location: string) => void {
  return (value, location) => {
    if (!values.includes(value as string)) {
      throw new Error(
        `${location} must be one of ${values.join(", ")} (got ${JSON.stringify(value)}).`,
      );
    }
  };
}

function assertWorkOrderShape(value: unknown, location: string): void {
  try {
    validateWorkOrder(value as readonly string[]);
  } catch (error) {
    throw new Error(`${location}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The roster. `Record<keyof PhoebeUserConfig, FieldDescriptor>` makes it total
 * by construction — see the module docstring.
 */
export const ROSTER = {
  repoSlug: { kind: { type: "required" }, env: "PHOEBE_REPO_SLUG", baseAllowed: false },
  repoUrl: { kind: { type: "required" }, env: "PHOEBE_REPO_URL", baseAllowed: false },
  installCommand: { kind: { type: "required" }, env: "PHOEBE_INSTALL_COMMAND", baseAllowed: false },
  checkCommand: { kind: { type: "required" }, env: "PHOEBE_CHECK_COMMAND", baseAllowed: false },
  testCommand: { kind: { type: "required" }, env: "PHOEBE_TEST_COMMAND", baseAllowed: false },

  engine: {
    kind: { type: "bootstrapper-only" },
    baseAllowed: true,
    validate: validateEngineSourceField,
  },
  workspace: {
    kind: { type: "bootstrapper-only" },
    baseAllowed: false,
    validate: validateWorkspaceField,
  },
  configDir: {
    kind: { type: "bootstrapper-only" },
    baseAllowed: false,
    validate: validateConfigDir,
  },

  issueSource: { kind: { type: "derived" }, baseAllowed: false, validate: validateIssueSource },

  defaultBranch: {
    kind: { type: "string" },
    default: "main",
    env: "PHOEBE_DEFAULT_BRANCH",
    baseAllowed: true,
  },
  branchPrefix: {
    kind: { type: "string" },
    default: "phoebe/",
    env: "PHOEBE_BRANCH_PREFIX",
    baseAllowed: true,
  },
  readyLabel: {
    kind: { type: "string" },
    default: "ready-for-agent",
    env: "PHOEBE_READY_LABEL",
    baseAllowed: true,
  },
  researchLabel: {
    kind: { type: "string" },
    default: "wayfinder:research",
    env: "PHOEBE_RESEARCH_LABEL",
    baseAllowed: true,
  },
  processingLabel: {
    kind: { type: "string" },
    default: "processing",
    env: "PHOEBE_PROCESSING_LABEL",
    baseAllowed: true,
  },
  prScope: {
    kind: { type: "enum", values: PR_SCOPE_VALUES },
    default: "phoebe",
    env: "PHOEBE_PR_SCOPE",
    baseAllowed: true,
    validate: assertOneOf(PR_SCOPE_VALUES),
  },
  prAuthors: {
    kind: { type: "string-array" },
    default: [] as readonly string[],
    baseAllowed: true,
  },
  prBaseScope: {
    kind: { type: "enum", values: PR_BASE_SCOPE_VALUES },
    default: "default",
    env: "PHOEBE_PR_BASE_SCOPE",
    baseAllowed: true,
    validate: assertOneOf(PR_BASE_SCOPE_VALUES),
  },
  draftPrs: {
    kind: { type: "enum", values: DRAFT_PRS_VALUES },
    default: "skip-non-phoebe",
    env: "PHOEBE_DRAFT_PRS",
    baseAllowed: true,
    validate: assertOneOf(DRAFT_PRS_VALUES),
  },
  prOptOutLabel: {
    kind: { type: "string" },
    default: "ready-for-human",
    env: "PHOEBE_PR_OPT_OUT_LABEL",
    baseAllowed: true,
  },
  readyCommand: {
    kind: { type: "string" },
    default: "npm run ready",
    env: "PHOEBE_READY_COMMAND",
    baseAllowed: true,
  },
  blockedByPattern: {
    kind: { type: "string" },
    default: String.raw`Blocked by\s+#(\d+)`,
    env: "PHOEBE_BLOCKED_BY_PATTERN",
    baseAllowed: true,
    validate: validateBlockedByPattern,
  },
  blockerSource: {
    kind: { type: "enum", values: BLOCKER_SOURCES },
    default: "body",
    env: "PHOEBE_BLOCKER_SOURCE",
    baseAllowed: true,
    validate: assertOneOf(BLOCKER_SOURCES),
  },
  stackMode: {
    kind: { type: "enum", values: STACK_MODES },
    default: "banner",
    env: "PHOEBE_STACK_MODE",
    baseAllowed: true,
    validate: assertOneOf(STACK_MODES),
  },
  reviewsSuccessHeading: {
    kind: { type: "string" },
    default: "## Review feedback addressed",
    env: "PHOEBE_REVIEWS_SUCCESS_HEADING",
    baseAllowed: true,
  },
  promptFiles: {
    kind: { type: "nested", keys: ["issue", "conflict", "checks", "reviews", "research"] },
    default: {
      issue: "prompts/issues-prompt.md",
      conflict: "prompts/conflict-prompt.md",
      checks: "prompts/checks-prompt.md",
      reviews: "prompts/reviews-prompt.md",
      research: "prompts/research-prompt.md",
    },
    baseAllowed: true,
  },
  workOrder: {
    kind: { type: "string-array" },
    default: WORK_KIND_NAMES as readonly string[],
    baseAllowed: true,
    validate: assertWorkOrderShape,
  },
  defaultProvider: {
    kind: { type: "enum", values: PROVIDER_NAMES },
    default: "cursor",
    env: "PHOEBE_DEFAULT_PROVIDER",
    baseAllowed: true,
    validate: assertOneOf(PROVIDER_NAMES),
  },
  defaultModels: {
    kind: { type: "nested", keys: PROVIDER_NAMES },
    default: {
      cursor: "composer-2.5",
      claude: "claude-sonnet-4-6",
      codex: "gpt-5.4-mini",
    },
    baseAllowed: true,
  },
  providerEnv: {
    kind: { type: "nested", keys: PROVIDER_NAMES },
    default: {
      cursor: "CURSOR_API_KEY",
      claude: "ANTHROPIC_API_KEY",
      codex: "OPENAI_KEY",
    },
    baseAllowed: true,
  },
  // 45 min: comfortably fits install(≤10) + a long agent run + test(≤10) + push,
  // so hitting it means "actually stuck", not "slow" (#72). Not env-overridable
  // through this overlay — `PHOEBE_RUN_TIMEOUT_MS` is read directly by
  // src/run-timeout.ts against the *resolved* config value, same pattern as the
  // other three run-protection knobs below.
  runTimeoutMs: { kind: { type: "number" }, default: 2_700_000, baseAllowed: true },
  // Matches the house number for consecutive-failures-before-escalation (#75).
  maxUnitTimeouts: { kind: { type: "number" }, default: 3, baseAllowed: true },
  // Matches the house number for consecutive-no-commit-attempts (#25).
  maxUnitAttempts: { kind: { type: "number" }, default: 3, baseAllowed: true },
  // Comfortably outlasts a single heartbeat interval miss (#15's heartbeat
  // ticks every ttl/3) while still self-healing an orphaned claim promptly.
  leaseTtlMs: { kind: { type: "number" }, default: 1_800_000, baseAllowed: true },
} as const satisfies Record<keyof PhoebeUserConfig, FieldDescriptor>;

export type RosterField = keyof typeof ROSTER;

/**
 * `ROSTER` widened to `Record<RosterField, FieldDescriptor>`. `as const
 * satisfies` (deliberately, so `resolveConfig`'s `??` ladder gets each field's
 * literal default type) keeps every entry's *own* narrow object type, so a
 * generic `ROSTER[field]` for a field-typed variable only has the properties
 * that specific entry's literal happened to declare — `.validate`/`.env` don't
 * exist on the union for entries that omit them. `FIELDS` is the same object,
 * re-typed so generic code (`applyEnvOverlay`, `validateUserConfig`,
 * `validateBaseConfig`) can read every descriptor's optional columns uniformly.
 */
export const FIELDS: Record<RosterField, FieldDescriptor> = ROSTER;

/** Fields with no cross-repo default — `resolveConfiguration` rejects a
 *  repository declaration missing any of these. */
export const REQUIRED_FIELDS = (Object.keys(ROSTER) as RosterField[]).filter(
  (field) => ROSTER[field].kind.type === "required",
);

/** Fields a generated deployment-wide base document must not set — they name
 *  a specific repository or tenant directory (#21, #98). */
export const REPOSITORY_OWNED_FIELDS = (Object.keys(ROSTER) as RosterField[]).filter(
  (field) => !ROSTER[field].baseAllowed,
);

/** Fields a generated deployment-wide base document may set. */
export const BASE_ALLOWED_FIELDS = (Object.keys(ROSTER) as RosterField[]).filter(
  (field) => ROSTER[field].baseAllowed,
);
