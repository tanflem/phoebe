// Pure config resolution: validate a user config, merge it with a generated
// base document and the `PHOEBE_*` env overlay, and fill in the roster's
// shipped defaults. Nothing here touches the filesystem — see ./load.ts for
// the disk-reading counterparts. This is `src/config/`'s implementation; only
// `resolveConfiguration` (plus the types re-exported from ./types.ts) is
// public — see ./index.ts.

import { resolveEngineSource } from "../../bootstrap/engine-source.ts";
import { derivePaths } from "../paths.ts";
import {
  BASE_ALLOWED_FIELDS,
  FIELDS,
  REPOSITORY_OWNED_FIELDS,
  ROSTER,
  type RosterField,
} from "./roster.ts";
import {
  validateWorkOrder,
  type EngineSourceField,
  type PhoebeConfig,
  type PhoebeUserConfig,
  type ResolvedEngineSource,
} from "./types.ts";

export type PhoebeBaseConfig = Partial<
  Omit<
    PhoebeUserConfig,
    | "repoSlug"
    | "repoUrl"
    | "installCommand"
    | "checkCommand"
    | "testCommand"
    | "issueSource"
    | "workspace"
    | "configDir"
  >
>;

export type ResolvedConfiguration = {
  config: PhoebeConfig;
  engine: ResolvedEngineSource;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fieldLocation(field: string): string {
  return `phoebe.config.ts \`${field}\``;
}

/**
 * Throw when a required field is missing or blank, or when a field with a
 * roster `validate` (`blockedByPattern`, `issueSource`, `workspace`,
 * `configDir`, `engine`) fails its shape check. Kept separate from
 * `resolveConfig` so consumers or tests can validate a config independent of
 * the defaults merge.
 */
export function validateUserConfig(user: PhoebeUserConfig): void {
  const missing = (Object.keys(ROSTER) as RosterField[]).filter((field) => {
    if (ROSTER[field].kind.type !== "required") return false;
    const value = (user as JsonRecord)[field];
    return typeof value !== "string" || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new Error(
      `phoebe.config.ts is missing required field(s): ${missing.join(", ")}. ` +
        `Only these five fields are required — the engine fills the rest from its defaults.`,
    );
  }

  for (const field of Object.keys(ROSTER) as RosterField[]) {
    const descriptor = FIELDS[field];
    if (!descriptor.validate) continue;
    const value = (user as JsonRecord)[field];
    if (value === undefined) continue;
    descriptor.validate(value, fieldLocation(field));
  }
}

/**
 * Merge a user config with the roster's shipped defaults and return the
 * fully-populated shape the engine runs against. Nested records are
 * shallow-merged so partial overrides (one prompt file, one provider's model,
 * etc.) work as expected.
 *
 * `paths` is *derived*, not merged: it comes from `repoSlug` and the
 * deployment data base (`opts.dataBase`, default `/data/repos`; the CLI
 * threads `PHOEBE_DATA_DIR` through — see src/paths.ts, #58/#62), so a
 * tenant's on-disk layout is a function of its slug and can never drift from
 * it.
 */
export function resolveConfig(
  user: PhoebeUserConfig,
  opts: { dataBase?: string } = {},
): PhoebeConfig {
  validateUserConfig(user);
  const readyLabel = user.readyLabel ?? ROSTER.readyLabel.default;
  return {
    repoSlug: user.repoSlug,
    repoUrl: user.repoUrl,
    installCommand: user.installCommand,
    checkCommand: user.checkCommand,
    testCommand: user.testCommand,
    defaultBranch: user.defaultBranch ?? ROSTER.defaultBranch.default,
    branchPrefix: user.branchPrefix ?? ROSTER.branchPrefix.default,
    readyLabel,
    issueSource: {
      repoSlug: user.issueSource?.repoSlug ?? user.repoSlug,
      readyLabel: user.issueSource?.readyLabel ?? readyLabel,
    },
    researchLabel: user.researchLabel ?? ROSTER.researchLabel.default,
    processingLabel: user.processingLabel ?? ROSTER.processingLabel.default,
    prScope: user.prScope ?? ROSTER.prScope.default,
    prAuthors: user.prAuthors ?? ROSTER.prAuthors.default,
    prBaseScope: user.prBaseScope ?? ROSTER.prBaseScope.default,
    draftPrs: user.draftPrs ?? ROSTER.draftPrs.default,
    prOptOutLabel: user.prOptOutLabel ?? ROSTER.prOptOutLabel.default,
    readyCommand: user.readyCommand ?? ROSTER.readyCommand.default,
    blockedByPattern: user.blockedByPattern ?? ROSTER.blockedByPattern.default,
    blockerSource: user.blockerSource ?? ROSTER.blockerSource.default,
    stackMode: user.stackMode ?? ROSTER.stackMode.default,
    reviewsSuccessHeading: user.reviewsSuccessHeading ?? ROSTER.reviewsSuccessHeading.default,
    promptFiles: { ...ROSTER.promptFiles.default, ...user.promptFiles },
    workOrder: user.workOrder ?? ROSTER.workOrder.default,
    defaultProvider: user.defaultProvider ?? ROSTER.defaultProvider.default,
    defaultModels: { ...ROSTER.defaultModels.default, ...user.defaultModels },
    providerEnv: { ...ROSTER.providerEnv.default, ...user.providerEnv },
    runTimeoutMs: user.runTimeoutMs ?? ROSTER.runTimeoutMs.default,
    maxUnitTimeouts: user.maxUnitTimeouts ?? ROSTER.maxUnitTimeouts.default,
    maxUnitAttempts: user.maxUnitAttempts ?? ROSTER.maxUnitAttempts.default,
    leaseTtlMs: user.leaseTtlMs ?? ROSTER.leaseTtlMs.default,
    paths: derivePaths(user.repoSlug, opts.dataBase),
  };
}

function readNonEmpty(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  return raw;
}

/**
 * Apply the `PHOEBE_*` overlay onto a user config and return a new object.
 * Driven entirely by the roster's `env` column: a scalar field is copied
 * straight through, an enum field is validated against its `values` first.
 * The overlay is additive over what the config file declared — an unset env
 * var leaves the field untouched (so `resolveConfig` can still fall back to
 * the roster's default if the field was also absent from the config file).
 */
export function applyEnvOverlay(user: PhoebeUserConfig, env: NodeJS.ProcessEnv): PhoebeUserConfig {
  const overlaid: PhoebeUserConfig = { ...user };
  for (const field of Object.keys(ROSTER) as RosterField[]) {
    const descriptor = FIELDS[field];
    if (descriptor.env === undefined) continue;
    const value = readNonEmpty(env, descriptor.env);
    if (value === undefined) continue;
    if (descriptor.kind.type === "enum") {
      descriptor.validate?.(value, descriptor.env);
    }
    (overlaid as JsonRecord)[field] = value;
  }
  return overlaid;
}

function describePath(path: string, detail: string): string {
  return `PHOEBE_BASE_CONFIG at ${path}: ${detail}`;
}

function unknownFields(record: JsonRecord, allowed: readonly string[]): string[] {
  return Object.keys(record).filter((key) => !allowed.includes(key));
}

function assertNoUnknownFields(
  record: JsonRecord,
  allowed: readonly string[],
  location: string,
  path: string,
): void {
  const unknown = unknownFields(record, allowed);
  if (unknown.length > 0) {
    throw new Error(
      describePath(
        path,
        `unknown field(s): ${unknown.map((field) => `${location}.${field}`).join(", ")}`,
      ),
    );
  }
}

function assertString(value: unknown, location: string, path: string): void {
  if (typeof value !== "string") {
    throw new Error(describePath(path, `${location} must be a string.`));
  }
}

function assertNumber(value: unknown, location: string, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(describePath(path, `${location} must be a number.`));
  }
}

function assertStringArray(value: unknown, location: string, path: string): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(describePath(path, `${location} must be an array of strings.`));
  }
}

function validateNestedStringRecord(value: unknown, field: RosterField, path: string): void {
  const location = `config.${field}`;
  const descriptor = ROSTER[field];
  if (descriptor.kind.type !== "nested") return;
  if (!isRecord(value)) {
    throw new Error(describePath(path, `${location} must be an object.`));
  }
  assertNoUnknownFields(value, descriptor.kind.keys, location, path);
  for (const [key, nestedValue] of Object.entries(value)) {
    assertString(nestedValue, `${location}.${key}`, path);
  }
}

/**
 * Validate the generated deployment-wide base document's `config` object
 * against the roster: reject a repository-owned field outright (it names a
 * specific repo or tenant directory, #21/#98), reject any field the roster
 * doesn't know, then check every present field's shape by `kind` plus any
 * roster `validate` (the same enum/array/pattern checks `applyEnvOverlay` and
 * `validateUserConfig` use, run once here instead of hand-duplicated).
 */
function validateBaseConfig(config: JsonRecord, path: string): asserts config is PhoebeBaseConfig {
  const prohibited = REPOSITORY_OWNED_FIELDS.filter((field) => field in config);
  if (prohibited.length > 0) {
    throw new Error(
      describePath(
        path,
        `config must not define repository-owned field(s): ${prohibited.join(", ")}`,
      ),
    );
  }
  assertNoUnknownFields(config, BASE_ALLOWED_FIELDS, "config", path);

  for (const field of BASE_ALLOWED_FIELDS) {
    const value = config[field];
    if (value === undefined) continue;
    const descriptor = FIELDS[field];
    const location = `config.${field}`;

    switch (descriptor.kind.type) {
      case "string":
        assertString(value, location, path);
        break;
      case "number":
        assertNumber(value, location, path);
        break;
      case "string-array":
        assertStringArray(value, location, path);
        break;
      case "nested":
        validateNestedStringRecord(value, field, path);
        break;
      default:
        break;
    }

    if (descriptor.validate) {
      try {
        descriptor.validate(value, location);
      } catch (error) {
        throw new Error(describePath(path, error instanceof Error ? error.message : String(error)));
      }
    }
  }
}

/**
 * Parse and validate the versioned generated JSON document. Validation happens
 * before merging so a bad lower layer cannot be hidden by a repository override.
 */
export function parseBaseConfigDocument(contents: string, path: string): PhoebeBaseConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Invalid JSON in PHOEBE_BASE_CONFIG at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(describePath(path, "document must be a JSON object."));
  }
  assertNoUnknownFields(parsed, ["schemaVersion", "config"], "document", path);
  if (parsed["schemaVersion"] !== 1) {
    throw new Error(
      describePath(path, `unsupported schemaVersion ${JSON.stringify(parsed["schemaVersion"])}.`),
    );
  }
  if (!isRecord(parsed["config"])) {
    throw new Error(describePath(path, "config must be a JSON object."));
  }
  validateBaseConfig(parsed["config"], path);
  return parsed["config"];
}

function mergeRecords(lower: JsonRecord, upper: JsonRecord): JsonRecord {
  const merged: JsonRecord = { ...lower };
  for (const [key, upperValue] of Object.entries(upper)) {
    if (upperValue === undefined) continue;
    const lowerValue = merged[key];
    merged[key] =
      isRecord(lowerValue) && isRecord(upperValue)
        ? mergeRecords(lowerValue, upperValue)
        : upperValue;
  }
  return merged;
}

/**
 * Resolve built-ins < generated base < repository < PHOEBE_* environment.
 * Records merge recursively, arrays replace whole, and undefined is absent.
 * Pure — no filesystem access; see `loadConfiguration` (./load.ts) for the
 * disk-reading counterpart.
 */
export function resolveConfiguration(input: {
  repository: PhoebeUserConfig;
  base?: PhoebeBaseConfig;
  env?: NodeJS.ProcessEnv;
  dataBase?: string;
}): ResolvedConfiguration {
  try {
    validateUserConfig(input.repository);
  } catch (error) {
    throw new Error(
      `Invalid repository declaration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const merged = mergeRecords(
    (input.base ?? {}) as JsonRecord,
    input.repository as unknown as JsonRecord,
  ) as PhoebeUserConfig;
  const overlaid = applyEnvOverlay(merged, input.env ?? {});
  const config = resolveConfig(overlaid, { dataBase: input.dataBase });
  validateWorkOrder(config.workOrder);
  return {
    config,
    engine: resolveEngineSource(overlaid.engine as EngineSourceField | undefined),
  };
}
