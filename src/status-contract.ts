import { createHash } from "node:crypto";

export const STATUS_SCHEMA_VERSION = "status-v2" as const;
export const EVENTS_SCHEMA_VERSION = "events-v1" as const;

export type DigestSet = {
  engine: string;
  bootstrap: string;
  config: string;
  policy: string;
  prompts: string;
  providerModel: string;
};

export type WorkKind = "conflicts" | "checks" | "reviews" | "issues" | "research";
export type LifecycleState =
  | "starting"
  | "selecting"
  | "idle"
  | "running"
  | "draining"
  | "stopped"
  | "failed";

export type WorkIdentity = {
  workId: string;
  kind: WorkKind;
  issueNumber?: number;
  pullRequestNumber?: number;
  branch?: string;
  startedAt: string;
};

const PR_KEYED_WORK_KINDS: ReadonlySet<WorkKind> = new Set(["conflicts", "checks", "reviews"]);

/** The subset of `WorkIdentity` the `#<id>` rule actually reads. */
export type WorkKindRef = Pick<WorkIdentity, "kind" | "issueNumber" | "pullRequestNumber">;

/**
 * The `#<id>` a work unit is known by: `pullRequestNumber` for the PR-keyed
 * kinds (conflicts/checks/reviews), `issueNumber` for the issue-keyed kinds
 * (issues/research) — the same rule `workIdentity` (main.ts) applies to a
 * picked `WorkUnit` before it becomes a `WorkIdentity`.
 */
export function workIdentityId(work: WorkKindRef): number | undefined {
  return PR_KEYED_WORK_KINDS.has(work.kind) ? work.pullRequestNumber : work.issueNumber;
}

/**
 * One issue in the resolved work-order lookahead, ordered as Phoebe would take
 * it. `blockedBy` is the full resolved blocker set (body + native, per
 * `config.blockerSource`) — not just the first blocker — so a consumer can
 * render issue chains by number without re-querying GitHub. `workable`
 * mirrors `resolveWorktreeBase` returning non-null: every blocker has at least
 * an open PR (or none at all).
 */
export type QueueEntry = {
  issueNumber: number;
  blockedBy: readonly number[];
  workable: boolean;
};

export type OutcomeSummary = {
  eventId: string;
  sequence: number;
  workId: string;
  outcome:
    | "success"
    | "verification-failure"
    | "agent-failure"
    | "quota-backoff"
    | "infrastructure-failure"
    | "cancelled";
  endedAt: string;
  failureCategory?: string;
};

export type StatusSnapshot = {
  schemaVersion: typeof STATUS_SCHEMA_VERSION;
  updatedAt: string;
  runtime: {
    runtimeId: string;
    instanceId: string;
    startedAt: string;
  };
  repository: {
    slug: string;
    url: string;
    defaultBranch: string;
  };
  digests: DigestSet;
  capabilities: readonly string[];
  lifecycle: {
    state: LifecycleState;
    reason?: string;
  };
  activeWork: WorkIdentity | null;
  queue: readonly QueueEntry[];
  lastSuccess: OutcomeSummary | null;
  lastFailure: OutcomeSummary | null;
  control: {
    retry: { attempt: number; nextAt?: string };
    backoff: { active: boolean; until?: string; reason?: string };
    quarantine: { active: boolean; engineSha?: string; reason?: string };
    drain: { requested: boolean; requestedAt?: string };
  };
  health: {
    state: "healthy" | "degraded" | "unhealthy";
    telemetry: {
      writable: boolean;
      lastError: string | null;
      lastErrorAt: string | null;
    };
  };
  journal: {
    earliestSequence: number | null;
    latestSequence: number | null;
    retainedSegments: number;
    quarantinedTailCount: number;
  };
  links: {
    repository: string;
    issue?: string;
    pullRequest?: string;
    branch?: string;
  };
};

export type NormalizedOutcome = OutcomeSummary["outcome"];
export type FailureCategory =
  | "verification"
  | "agent"
  | "quota"
  | "provider"
  | "state-volume"
  | "git"
  | "github"
  | "internal";

export type WorkOutcomeEvent = {
  schemaVersion: typeof EVENTS_SCHEMA_VERSION;
  runtimeId: string;
  eventId: string;
  sequence: number;
  work: {
    workId: string;
    kind: WorkKind;
    issueNumber?: number;
    pullRequestNumber?: number;
  };
  provider: {
    name: string;
    model: string;
    digest: string;
  };
  digests: Pick<DigestSet, "config" | "policy" | "prompts">;
  startedAt: string;
  endedAt: string;
  outcome: NormalizedOutcome;
  failure: {
    category: FailureCategory;
    summary: string;
    retryable: boolean;
  } | null;
  verification: ReadonlyArray<{
    command: string;
    status: "passed" | "failed" | "unknown" | "not-run";
    summary: string;
  }>;
  retries: number;
  escalations: number;
  resources: {
    durationMs: number;
    agentExitCode?: number;
    summary: string;
  };
  links: {
    issue?: string;
    pullRequest?: string;
    branch?: string;
  };
};

export class ContractCapabilityError extends Error {
  readonly supportedVersion: string;
  readonly receivedVersion: string;

  constructor(supportedVersion: string, receivedVersion: string) {
    super(`This runtime supports ${supportedVersion} but received ${receivedVersion}.`);
    this.name = "ContractCapabilityError";
    this.supportedVersion = supportedVersion;
    this.receivedVersion = receivedVersion;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "string";
}

function hasNullableNumber(record: Record<string, unknown>, key: string): boolean {
  return record[key] === null || typeof record[key] === "number";
}

const WORK_KINDS = ["conflicts", "checks", "reviews", "issues", "research"] as const;
const LIFECYCLE_STATES = [
  "starting",
  "selecting",
  "idle",
  "running",
  "draining",
  "stopped",
  "failed",
] as const;
const OUTCOMES = [
  "success",
  "verification-failure",
  "agent-failure",
  "quota-backoff",
  "infrastructure-failure",
  "cancelled",
] as const;
const FAILURE_CATEGORIES = [
  "verification",
  "agent",
  "quota",
  "provider",
  "state-volume",
  "git",
  "github",
  "internal",
] as const;
const VERIFICATION_STATUSES = ["passed", "failed", "unknown", "not-run"] as const;
const HEALTH_STATES = ["healthy", "degraded", "unhealthy"] as const;

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isOptionalString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === "string";
}

function isOptionalPositiveInteger(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || isPositiveInteger(record[key]);
}

function isWorkIdentity(value: unknown): value is WorkIdentity {
  if (!isRecord(value)) return false;
  return (
    hasString(value, "workId") &&
    isOneOf(value["kind"], WORK_KINDS) &&
    hasString(value, "startedAt") &&
    isOptionalPositiveInteger(value, "issueNumber") &&
    isOptionalPositiveInteger(value, "pullRequestNumber") &&
    isOptionalString(value, "branch")
  );
}

function isOutcomeSummary(value: unknown): value is OutcomeSummary {
  if (!isRecord(value)) return false;
  return (
    hasString(value, "eventId") &&
    isPositiveInteger(value["sequence"]) &&
    hasString(value, "workId") &&
    isOneOf(value["outcome"], OUTCOMES) &&
    hasString(value, "endedAt") &&
    isOptionalString(value, "failureCategory")
  );
}

function isQueueEntry(value: unknown): value is QueueEntry {
  if (!isRecord(value)) return false;
  return (
    isPositiveInteger(value["issueNumber"]) &&
    Array.isArray(value["blockedBy"]) &&
    value["blockedBy"].every((blocker) => isPositiveInteger(blocker)) &&
    typeof value["workable"] === "boolean"
  );
}

function isStatusV2(value: unknown): value is StatusSnapshot {
  if (!isRecord(value) || value["schemaVersion"] !== STATUS_SCHEMA_VERSION) return false;
  const runtime = value["runtime"];
  const repository = value["repository"];
  const digests = value["digests"];
  const lifecycle = value["lifecycle"];
  const control = value["control"];
  const health = value["health"];
  const journal = value["journal"];
  const links = value["links"];
  if (
    !isRecord(runtime) ||
    !isRecord(repository) ||
    !isRecord(digests) ||
    !isRecord(lifecycle) ||
    !isRecord(control) ||
    !isRecord(health) ||
    !isRecord(journal) ||
    !isRecord(links)
  ) {
    return false;
  }
  const retry = control["retry"];
  const backoff = control["backoff"];
  const quarantine = control["quarantine"];
  const drain = control["drain"];
  const telemetry = health["telemetry"];
  return (
    hasString(value, "updatedAt") &&
    hasString(runtime, "runtimeId") &&
    hasString(runtime, "instanceId") &&
    hasString(runtime, "startedAt") &&
    hasString(repository, "slug") &&
    hasString(repository, "url") &&
    hasString(repository, "defaultBranch") &&
    ["engine", "bootstrap", "config", "policy", "prompts", "providerModel"].every((key) =>
      hasString(digests, key),
    ) &&
    Array.isArray(value["capabilities"]) &&
    value["capabilities"].every((capability) => typeof capability === "string") &&
    isOneOf(lifecycle["state"], LIFECYCLE_STATES) &&
    isOptionalString(lifecycle, "reason") &&
    (value["activeWork"] === null || isWorkIdentity(value["activeWork"])) &&
    Array.isArray(value["queue"]) &&
    value["queue"].every((entry) => isQueueEntry(entry)) &&
    (value["lastSuccess"] === null || isOutcomeSummary(value["lastSuccess"])) &&
    (value["lastFailure"] === null || isOutcomeSummary(value["lastFailure"])) &&
    isRecord(retry) &&
    isNonNegativeInteger(retry["attempt"]) &&
    isOptionalString(retry, "nextAt") &&
    isRecord(backoff) &&
    typeof backoff["active"] === "boolean" &&
    isOptionalString(backoff, "until") &&
    isOptionalString(backoff, "reason") &&
    isRecord(quarantine) &&
    typeof quarantine["active"] === "boolean" &&
    isOptionalString(quarantine, "engineSha") &&
    isOptionalString(quarantine, "reason") &&
    isRecord(drain) &&
    typeof drain["requested"] === "boolean" &&
    isOptionalString(drain, "requestedAt") &&
    isOneOf(health["state"], HEALTH_STATES) &&
    isRecord(telemetry) &&
    typeof telemetry["writable"] === "boolean" &&
    (telemetry["lastError"] === null || typeof telemetry["lastError"] === "string") &&
    (telemetry["lastErrorAt"] === null || typeof telemetry["lastErrorAt"] === "string") &&
    hasNullableNumber(journal, "earliestSequence") &&
    hasNullableNumber(journal, "latestSequence") &&
    (journal["earliestSequence"] === null || isPositiveInteger(journal["earliestSequence"])) &&
    (journal["latestSequence"] === null || isPositiveInteger(journal["latestSequence"])) &&
    isNonNegativeInteger(journal["retainedSegments"]) &&
    isNonNegativeInteger(journal["quarantinedTailCount"]) &&
    hasString(links, "repository") &&
    isOptionalString(links, "issue") &&
    isOptionalString(links, "pullRequest") &&
    isOptionalString(links, "branch")
  );
}

export function parseStatusSnapshot(value: unknown): StatusSnapshot {
  if (isRecord(value) && typeof value["schemaVersion"] === "string") {
    if (value["schemaVersion"] !== STATUS_SCHEMA_VERSION) {
      throw new ContractCapabilityError(STATUS_SCHEMA_VERSION, value["schemaVersion"]);
    }
  }
  if (!isStatusV2(value)) {
    throw new Error(`Received an invalid ${STATUS_SCHEMA_VERSION} snapshot.`);
  }
  return value;
}

function isEventsV1(value: unknown): value is WorkOutcomeEvent {
  if (!isRecord(value) || value["schemaVersion"] !== EVENTS_SCHEMA_VERSION) return false;
  const work = value["work"];
  const provider = value["provider"];
  const digests = value["digests"];
  const resources = value["resources"];
  const links = value["links"];
  const failure = value["failure"];
  return (
    hasString(value, "runtimeId") &&
    hasString(value, "eventId") &&
    typeof value["sequence"] === "number" &&
    Number.isSafeInteger(value["sequence"]) &&
    value["sequence"] > 0 &&
    isRecord(work) &&
    hasString(work, "workId") &&
    isOneOf(work["kind"], WORK_KINDS) &&
    isOptionalPositiveInteger(work, "issueNumber") &&
    isOptionalPositiveInteger(work, "pullRequestNumber") &&
    isRecord(provider) &&
    hasString(provider, "name") &&
    hasString(provider, "model") &&
    hasString(provider, "digest") &&
    isRecord(digests) &&
    hasString(digests, "config") &&
    hasString(digests, "policy") &&
    hasString(digests, "prompts") &&
    hasString(value, "startedAt") &&
    hasString(value, "endedAt") &&
    isOneOf(value["outcome"], OUTCOMES) &&
    (failure === null ||
      (isRecord(failure) &&
        isOneOf(failure["category"], FAILURE_CATEGORIES) &&
        typeof failure["summary"] === "string" &&
        failure["summary"].length <= 2_000 &&
        typeof failure["retryable"] === "boolean")) &&
    Array.isArray(value["verification"]) &&
    value["verification"].every(
      (item) =>
        isRecord(item) &&
        hasString(item, "command") &&
        isOneOf(item["status"], VERIFICATION_STATUSES) &&
        typeof item["summary"] === "string" &&
        item["summary"].length <= 2_000,
    ) &&
    isNonNegativeInteger(value["retries"]) &&
    isNonNegativeInteger(value["escalations"]) &&
    isRecord(resources) &&
    isNonNegativeInteger(resources["durationMs"]) &&
    (resources["agentExitCode"] === undefined ||
      (typeof resources["agentExitCode"] === "number" &&
        Number.isSafeInteger(resources["agentExitCode"]))) &&
    typeof resources["summary"] === "string" &&
    resources["summary"].length <= 2_000 &&
    isRecord(links) &&
    isOptionalString(links, "issue") &&
    isOptionalString(links, "pullRequest") &&
    isOptionalString(links, "branch")
  );
}

export function parseWorkOutcomeEvent(value: unknown): WorkOutcomeEvent {
  if (isRecord(value) && typeof value["schemaVersion"] === "string") {
    if (value["schemaVersion"] !== EVENTS_SCHEMA_VERSION) {
      throw new ContractCapabilityError(EVENTS_SCHEMA_VERSION, value["schemaVersion"]);
    }
  }
  if (!isEventsV1(value)) {
    throw new Error("Received an invalid events-v1 work outcome.");
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function digestValue(value: unknown): string {
  const encoded = JSON.stringify(canonicalize(value));
  return `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
}
