// Shared configuration resolution for the engine, bootstrapper, and read-only
// inspection CLI. Every runtime path must go through this module so the engine
// source selected by `phoebe boot` cannot diverge from the runtime config the
// materialized engine sees.

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolveEngineSource, type ResolvedEngineSource } from "../bootstrap/engine-source.ts";
import {
  BLOCKER_SOURCES,
  STACK_MODES,
  PROVIDER_NAMES,
  CONFIG_DEFAULTS,
  resolveConfig,
  validateEngineSourceField,
  validateUserConfig,
  validateWorkOrder,
  type EngineSourceField,
  type PhoebeConfig,
  type PhoebeUserConfig,
} from "./config-schema.ts";
import { applyEnvOverlay, loadUserConfig } from "./load-config.ts";

const REQUIRED_REPOSITORY_FIELDS = [
  "repoSlug",
  "repoUrl",
  "installCommand",
  "checkCommand",
  "testCommand",
] as const;

// Optional fields that still identify *which* repo something is, same as the
// required fields above — so they are equally out of place in the generated,
// deployment-wide base document (#21: issueSource names a specific repo).
const OPTIONAL_REPOSITORY_OWNED_FIELDS = ["issueSource"] as const;

const REPOSITORY_OWNED_FIELDS = [
  ...REQUIRED_REPOSITORY_FIELDS,
  ...OPTIONAL_REPOSITORY_OWNED_FIELDS,
] as const;

const CONFIG_FIELDS = [
  ...REQUIRED_REPOSITORY_FIELDS,
  ...OPTIONAL_REPOSITORY_OWNED_FIELDS,
  "engine",
  "defaultBranch",
  "branchPrefix",
  "readyLabel",
  "researchLabel",
  "processingLabel",
  "prScope",
  "prAuthors",
  "prBaseScope",
  "draftPrs",
  "prOptOutLabel",
  "readyCommand",
  "blockedByPattern",
  "blockerSource",
  "stackMode",
  "reviewsSuccessHeading",
  "promptFiles",
  "workOrder",
  "defaultProvider",
  "defaultModels",
  "providerEnv",
  "runTimeoutMs",
  "maxUnitTimeouts",
  "maxUnitAttempts",
  "leaseTtlMs",
] as const satisfies readonly (keyof PhoebeUserConfig)[];

/**
 * Every optional field `CONFIG_DEFAULTS` supplies must also be in
 * `CONFIG_FIELDS`, or a generated base config setting it is rejected as
 * unknown even though `resolveConfig` fully supports it (#36). `engine` has no
 * static default (bootstrap-only, dropped by `resolveConfig`) and is exempt.
 */
export function assertConfigFieldsCoversDefaults(): void {
  const covered = new Set<string>(CONFIG_FIELDS);
  const missing = Object.keys(CONFIG_DEFAULTS).filter((field) => !covered.has(field));
  if (missing.length > 0) {
    throw new Error(
      `CONFIG_FIELDS is missing field(s) present in CONFIG_DEFAULTS: ${missing.join(", ")}. ` +
        `Add them to CONFIG_FIELDS in src/config-resolution.ts.`,
    );
  }
}

const BASE_CONFIG_FIELDS = CONFIG_FIELDS.filter(
  (field) => !(REPOSITORY_OWNED_FIELDS as readonly string[]).includes(field),
);

const STRING_FIELDS = [
  "defaultBranch",
  "branchPrefix",
  "readyLabel",
  "researchLabel",
  "processingLabel",
  "prOptOutLabel",
  "readyCommand",
  "blockedByPattern",
  "reviewsSuccessHeading",
] as const;

const NUMBER_FIELDS = ["runTimeoutMs", "maxUnitTimeouts", "maxUnitAttempts", "leaseTtlMs"] as const;

const NESTED_STRING_FIELDS = {
  promptFiles: ["issue", "conflict", "checks", "reviews", "research"],
  defaultModels: [...PROVIDER_NAMES],
  providerEnv: [...PROVIDER_NAMES],
} as const;

export type PhoebeBaseConfig = Partial<
  Omit<
    PhoebeUserConfig,
    "repoSlug" | "repoUrl" | "installCommand" | "checkCommand" | "testCommand" | "issueSource"
  >
>;

export type ResolvedConfiguration = {
  config: PhoebeConfig;
  engine: ResolvedEngineSource;
};

/** Internal handoff that freezes boot's resolution for the child engine. */
export const BOOTSTRAP_RESOLVED_CONFIG_ENV = "PHOEBE_BOOTSTRAP_RESOLVED_CONFIG";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function assertString(value: unknown, location: string, path: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(describePath(path, `${location} must be a string.`));
  }
}

function assertNumber(value: unknown, location: string, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(describePath(path, `${location} must be a number.`));
  }
}

function validateNestedStringRecord(
  value: unknown,
  field: keyof typeof NESTED_STRING_FIELDS,
  path: string,
): void {
  const location = `config.${field}`;
  if (!isRecord(value)) {
    throw new Error(describePath(path, `${location} must be an object.`));
  }
  assertNoUnknownFields(value, NESTED_STRING_FIELDS[field], location, path);
  for (const [key, nestedValue] of Object.entries(value)) {
    assertString(nestedValue, `${location}.${key}`, path);
  }
}

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
  assertNoUnknownFields(config, BASE_CONFIG_FIELDS, "config", path);

  for (const field of STRING_FIELDS) {
    const value = config[field];
    if (value !== undefined) assertString(value, `config.${field}`, path);
  }

  for (const field of NUMBER_FIELDS) {
    const value = config[field];
    if (value !== undefined) assertNumber(value, `config.${field}`, path);
  }

  if (config["prAuthors"] !== undefined) {
    if (
      !Array.isArray(config["prAuthors"]) ||
      !config["prAuthors"].every((value) => typeof value === "string")
    ) {
      throw new Error(describePath(path, "config.prAuthors must be an array of strings."));
    }
  }

  if (
    config["prScope"] !== undefined &&
    config["prScope"] !== "phoebe" &&
    config["prScope"] !== "all"
  ) {
    throw new Error(describePath(path, `config.prScope must be "phoebe" or "all".`));
  }
  if (
    config["prBaseScope"] !== undefined &&
    config["prBaseScope"] !== "default" &&
    config["prBaseScope"] !== "all"
  ) {
    throw new Error(describePath(path, `config.prBaseScope must be "default" or "all".`));
  }
  if (
    config["draftPrs"] !== undefined &&
    config["draftPrs"] !== "skip-non-phoebe" &&
    config["draftPrs"] !== "skip-all" &&
    config["draftPrs"] !== "include"
  ) {
    throw new Error(
      describePath(path, `config.draftPrs must be "skip-non-phoebe", "skip-all", or "include".`),
    );
  }
  if (
    config["defaultProvider"] !== undefined &&
    !(PROVIDER_NAMES as readonly unknown[]).includes(config["defaultProvider"])
  ) {
    throw new Error(
      describePath(path, `config.defaultProvider must be one of ${PROVIDER_NAMES.join(", ")}.`),
    );
  }
  if (
    config["blockerSource"] !== undefined &&
    !(BLOCKER_SOURCES as readonly unknown[]).includes(config["blockerSource"])
  ) {
    throw new Error(
      describePath(path, `config.blockerSource must be one of ${BLOCKER_SOURCES.join(", ")}.`),
    );
  }
  if (
    config["stackMode"] !== undefined &&
    !(STACK_MODES as readonly unknown[]).includes(config["stackMode"])
  ) {
    throw new Error(
      describePath(path, `config.stackMode must be one of ${STACK_MODES.join(", ")}.`),
    );
  }

  if (config["workOrder"] !== undefined) {
    if (
      !Array.isArray(config["workOrder"]) ||
      !config["workOrder"].every((value) => typeof value === "string")
    ) {
      throw new Error(describePath(path, "config.workOrder must be an array of strings."));
    }
    try {
      validateWorkOrder(config["workOrder"]);
    } catch (error) {
      throw new Error(describePath(path, error instanceof Error ? error.message : String(error)));
    }
  }

  for (const field of Object.keys(NESTED_STRING_FIELDS) as Array<
    keyof typeof NESTED_STRING_FIELDS
  >) {
    if (config[field] !== undefined) validateNestedStringRecord(config[field], field, path);
  }

  if (config["engine"] !== undefined) {
    try {
      validateEngineSourceField(config["engine"], "config.engine");
    } catch (error) {
      throw new Error(describePath(path, error instanceof Error ? error.message : String(error)));
    }
  }

  if (config["blockedByPattern"] !== undefined) {
    const candidate = {
      repoSlug: "validation/repository",
      repoUrl: "https://example.invalid/repository.git",
      installCommand: "install",
      checkCommand: "check",
      testCommand: "test",
      blockedByPattern: config["blockedByPattern"],
    } as PhoebeUserConfig;
    try {
      validateUserConfig(candidate);
    } catch (error) {
      throw new Error(
        describePath(
          path,
          `config.blockedByPattern is invalid: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
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

/** Validate and return the configured absolute base-document path, if any. */
export function resolveBaseConfigPath(env: NodeJS.ProcessEnv): string | undefined {
  const path = env["PHOEBE_BASE_CONFIG"];
  if (path === undefined) return undefined;
  if (!isAbsolute(path)) {
    throw new Error(`PHOEBE_BASE_CONFIG must be an absolute path (got "${path}").`);
  }
  return path;
}

/** Read the generated layer with path-specific errors. */
export function loadBaseConfig(
  env: NodeJS.ProcessEnv,
  read: (path: string) => Uint8Array = readFileSync,
): PhoebeBaseConfig | undefined {
  const path = resolveBaseConfigPath(env);
  if (path === undefined) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = read(path);
  } catch (error) {
    throw new Error(
      `Failed to read PHOEBE_BASE_CONFIG at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(
      `PHOEBE_BASE_CONFIG at ${path} is not valid UTF-8: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseBaseConfigDocument(contents, path);
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
 */
export function resolveLayeredConfiguration(input: {
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
  if (input.repository.engine !== undefined) {
    validateEngineSourceField(input.repository.engine);
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

/** Load both authored layers and resolve them through the shared contract. */
export async function loadResolvedConfiguration(
  repositoryPath: string,
  options: { env?: NodeJS.ProcessEnv; reloadKey?: string; dataBase?: string } = {},
): Promise<ResolvedConfiguration> {
  const env = options.env ?? process.env;
  const repository = await loadUserConfig(repositoryPath, { reloadKey: options.reloadKey });
  const base = loadBaseConfig(env);
  return resolveLayeredConfiguration({ repository, base, env, dataBase: options.dataBase });
}

/**
 * Canonical, versioned and non-secret representation for deployment validation.
 * Only resolved config values and environment-variable names are included;
 * process environment values are never serialized.
 */
export function formatResolvedConfiguration(resolved: ResolvedConfiguration): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      config: {
        ...resolved.config,
        engine: resolved.engine,
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * Read the non-secret snapshot passed from boot to its child engine. The child
 * uses this instead of re-reading mutable authored files, so engine source and
 * runtime config are one atomic resolution even across an in-between edit.
 */
export function parseResolvedConfigurationSnapshot(contents: string): ResolvedConfiguration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Invalid ${BOOTSTRAP_RESOLVED_CONFIG_ENV}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isRecord(parsed) || parsed["schemaVersion"] !== 1 || !isRecord(parsed["config"])) {
    throw new Error(
      `${BOOTSTRAP_RESOLVED_CONFIG_ENV} must be a schemaVersion 1 resolved configuration.`,
    );
  }
  const { engine, ...runtime } = parsed["config"];
  validateEngineSourceField(engine, `${BOOTSTRAP_RESOLVED_CONFIG_ENV}.config.engine`);
  const config = resolveConfig(runtime as PhoebeUserConfig);
  validateWorkOrder(config.workOrder);
  return { config, engine: resolveEngineSource(engine) };
}
