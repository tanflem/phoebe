import { randomUUID } from "node:crypto";
import { createEventJournal, replayEventJournal, type WorkOutcomeInput } from "./event-journal.ts";
import { unitTag } from "./phoebe-log.ts";
import {
  EVENTS_SCHEMA_VERSION,
  STATUS_SCHEMA_VERSION,
  workIdentityId,
  type FailureCategory,
  type NormalizedOutcome,
  type QueueEntry,
  type StatusSnapshot,
  type WorkIdentity,
  type WorkKind,
  type WorkKindRef,
  type WorkOutcomeEvent,
} from "./status-contract.ts";
import { loadOrCreateRuntimeId, readStatusSnapshot, writeStatusSnapshot } from "./status-store.ts";

const CAPABILITIES = [
  STATUS_SCHEMA_VERSION,
  EVENTS_SCHEMA_VERSION,
  "events-replay-v1",
  "events-range-v1",
] as const;

type VerificationResult = WorkOutcomeEvent["verification"][number];

/** The work a `work-started`/`unit-quarantined` transition identifies (#60). */
type WorkRef = {
  kind: WorkKind;
  issueNumber?: number;
  pullRequestNumber?: number;
  branch?: string;
};

export type RuntimeStatusTransition =
  | { kind: "selecting" }
  | { kind: "idle"; reason: string }
  | { kind: "work-started"; work: WorkRef & { workId?: string } }
  | {
      kind: "work-completed";
      verification?: readonly VerificationResult[];
      resources?: { agentExitCode?: number; summary?: string };
      pullRequestNumber?: number;
    }
  | {
      kind: "work-failed";
      error: unknown;
      pullRequestNumber?: number;
      verification?: readonly VerificationResult[];
      resources?: { agentExitCode?: number; summary?: string };
    }
  | { kind: "work-timed-out"; elapsedMs: number }
  | { kind: "unit-quarantined"; work: WorkRef; reason: string }
  | { kind: "backoff"; reason: string; until?: string }
  | { kind: "draining"; reason: string }
  | { kind: "engine-failed"; error: unknown }
  | { kind: "stopped" };

type EventJournalWriter = {
  append: (input: WorkOutcomeInput) => WorkOutcomeEvent;
};

/** The `#<id>` an already-tagged log line renders — falls back to `workId` when a unit is unnumbered. */
function workRefLabel(work: WorkKindRef & { workId?: string }): string {
  return String(workIdentityId(work) ?? work.workId);
}

export function sanitizeTelemetryText(
  value: unknown,
  secrets: readonly string[] = [],
  maxLength = 2_000,
): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const secret of [...secrets]
    .filter((item) => item.length >= 4)
    .sort((left, right) => right.length - left.length)) {
    text = text.split(secret).join("[REDACTED]");
  }
  text = text
    .replace(/(https?:\/\/x-access-token:)[^@\s]+@/gi, "$1[REDACTED]@")
    .replace(/\b(Bearer)\s+\S+/gi, "$1 [REDACTED]")
    .replace(
      /\b((?:GH_TOKEN|GITHUB_TOKEN|ANTHROPIC_API_KEY|CURSOR_API_KEY|OPENAI_KEY|OPENAI_API_KEY)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function classifyFailure(message: string): {
  outcome: NormalizedOutcome;
  category: FailureCategory;
  retryable: boolean;
} {
  if (/\b(429|quota|rate.?limit)\b/i.test(message)) {
    return { outcome: "quota-backoff", category: "quota", retryable: true };
  }
  if (/\b(verification|ready|typecheck|lint|test(?:s|ing)?|check(?:s|ing)?)\b/i.test(message)) {
    return { outcome: "verification-failure", category: "verification", retryable: true };
  }
  if (/\b(agent|codex|claude|cursor).*(exited?|spawn|failed|error)\b/i.test(message)) {
    return { outcome: "agent-failure", category: "agent", retryable: true };
  }
  if (/\b(state volume|state-volume|enospc|eacces|read-only)\b/i.test(message)) {
    return { outcome: "infrastructure-failure", category: "state-volume", retryable: false };
  }
  if (/\bgithub|gh api\b/i.test(message)) {
    return { outcome: "infrastructure-failure", category: "github", retryable: true };
  }
  if (/\bgit\b/i.test(message)) {
    return { outcome: "infrastructure-failure", category: "git", retryable: true };
  }
  if (/\bprovider\b/i.test(message)) {
    return { outcome: "agent-failure", category: "provider", retryable: true };
  }
  return { outcome: "infrastructure-failure", category: "internal", retryable: true };
}

function eventLinks(snapshot: StatusSnapshot): WorkOutcomeEvent["links"] {
  return {
    ...(snapshot.links.issue ? { issue: snapshot.links.issue } : {}),
    ...(snapshot.links.pullRequest ? { pullRequest: snapshot.links.pullRequest } : {}),
    ...(snapshot.links.branch ? { branch: snapshot.links.branch } : {}),
  };
}

function outcomeSummary(event: WorkOutcomeEvent): NonNullable<StatusSnapshot["lastSuccess"]> {
  return {
    eventId: event.eventId,
    sequence: event.sequence,
    workId: event.work.workId,
    outcome: event.outcome,
    endedAt: event.endedAt,
    ...(event.failure ? { failureCategory: event.failure.category } : {}),
  };
}

export function createRuntimeStatusReporter(options: {
  stateDir?: string;
  runtimeId?: string;
  repository: StatusSnapshot["repository"];
  digests: StatusSnapshot["digests"];
  provider: WorkOutcomeEvent["provider"];
  verificationCommands: readonly string[];
  quarantinedEngineSha?: string;
  secrets?: readonly string[];
  now?: () => Date;
  randomId?: () => string;
  log?: (line: string) => void;
  eventJournal?: EventJournalWriter;
  writeSnapshot?: (stateDir: string, snapshot: StatusSnapshot) => void;
  onWriteError?: (error: unknown) => void;
}): {
  record: (transition: RuntimeStatusTransition) => StatusSnapshot;
  snapshot: () => StatusSnapshot;
  setQueue: (queue: readonly QueueEntry[]) => StatusSnapshot;
} {
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const log = options.log ?? ((line: string) => console.log(line));
  const tag = unitTag(options.repository.slug);
  const startedAt = now().toISOString();
  const runtimeId = options.stateDir
    ? loadOrCreateRuntimeId(options.stateDir, {
        ...(options.runtimeId ? { preferredId: options.runtimeId } : {}),
        randomId,
      })
    : (options.runtimeId ?? `ephemeral:${randomId()}`);
  const eventJournal =
    options.eventJournal ??
    (options.stateDir
      ? createEventJournal({
          stateDir: options.stateDir,
          runtimeId,
          randomId,
        })
      : undefined);
  const initialReplay = options.stateDir ? replayEventJournal(options.stateDir) : undefined;
  const previousStatus = options.stateDir ? readStatusSnapshot(options.stateDir) : undefined;
  const previousSnapshot =
    previousStatus?.available && previousStatus.status.runtime.runtimeId === runtimeId
      ? previousStatus.status
      : undefined;
  const replayedSuccess = initialReplay?.events.findLast((event) => event.outcome === "success");
  const replayedFailure = initialReplay?.events.findLast((event) => event.outcome !== "success");
  const repositoryLink = `https://github.com/${options.repository.slug}`;
  let snapshot: StatusSnapshot = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    updatedAt: startedAt,
    runtime: {
      runtimeId,
      instanceId: randomId(),
      startedAt,
    },
    repository: options.repository,
    digests: options.digests,
    capabilities: CAPABILITIES,
    lifecycle: { state: "starting" },
    activeWork: null,
    queue: previousSnapshot?.queue ?? [],
    lastSuccess:
      previousSnapshot?.lastSuccess ?? (replayedSuccess ? outcomeSummary(replayedSuccess) : null),
    lastFailure:
      previousSnapshot?.lastFailure ?? (replayedFailure ? outcomeSummary(replayedFailure) : null),
    control: {
      retry: { attempt: 0 },
      backoff: { active: false },
      quarantine: options.quarantinedEngineSha
        ? {
            active: true,
            engineSha: options.quarantinedEngineSha,
            reason: "Engine commit quarantined after crash-loop detection.",
          }
        : { active: false },
      drain: { requested: false },
    },
    health: {
      state: "healthy",
      telemetry: {
        writable: true,
        lastError: null,
        lastErrorAt: null,
      },
    },
    journal: {
      earliestSequence: initialReplay?.earliestSequence ?? null,
      latestSequence: initialReplay?.latestSequence ?? null,
      retainedSegments: initialReplay?.retainedSegments ?? 0,
      quarantinedTailCount: initialReplay?.quarantinedTailCount ?? 0,
    },
    links: { repository: repositoryLink },
  };

  const markTelemetryFailure = (error: unknown, at: string): void => {
    const message = sanitizeTelemetryText(error, options.secrets);
    snapshot.health = {
      state: "degraded",
      telemetry: { writable: false, lastError: message, lastErrorAt: at },
    };
    options.onWriteError?.(error);
  };

  const persist = (at: string): void => {
    if (!options.stateDir) return;
    try {
      (options.writeSnapshot ?? writeStatusSnapshot)(options.stateDir, snapshot);
    } catch (error) {
      markTelemetryFailure(error, at);
    }
  };

  const attachPullRequest = (pullRequestNumber: number | undefined): void => {
    if (pullRequestNumber === undefined || snapshot.activeWork === null) return;
    snapshot.activeWork.pullRequestNumber = pullRequestNumber;
    snapshot.links.pullRequest = `${repositoryLink}/pull/${pullRequestNumber}`;
  };

  const applyEvent = (
    at: string,
    outcome: NormalizedOutcome,
    failure: WorkOutcomeEvent["failure"],
    extra: {
      verification?: readonly VerificationResult[];
      resources?: { agentExitCode?: number; summary?: string };
    },
  ): void => {
    const active = snapshot.activeWork;
    if (!active || !eventJournal) return;
    const started = Date.parse(active.startedAt);
    const ended = Date.parse(at);
    const verification = (
      extra.verification ??
      options.verificationCommands.map((command) => ({
        command,
        status: "unknown" as const,
        summary: "Phoebe did not receive a structured result for this configured command.",
      }))
    ).map((result) => ({
      command: sanitizeTelemetryText(result.command, options.secrets),
      status: result.status,
      summary: sanitizeTelemetryText(result.summary, options.secrets),
    }));
    const input: WorkOutcomeInput = {
      work: {
        workId: active.workId,
        kind: active.kind,
        ...(active.issueNumber !== undefined ? { issueNumber: active.issueNumber } : {}),
        ...(active.pullRequestNumber !== undefined
          ? { pullRequestNumber: active.pullRequestNumber }
          : {}),
      },
      provider: options.provider,
      digests: {
        config: options.digests.config,
        policy: options.digests.policy,
        prompts: options.digests.prompts,
      },
      startedAt: active.startedAt,
      endedAt: at,
      outcome,
      failure,
      verification,
      retries: snapshot.control.retry.attempt,
      escalations: 0,
      resources: {
        durationMs:
          Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0,
        ...(extra.resources?.agentExitCode !== undefined
          ? { agentExitCode: extra.resources.agentExitCode }
          : {}),
        summary: sanitizeTelemetryText(
          extra.resources?.summary ??
            (outcome === "success" ? "Work unit completed." : "Work unit failed."),
          options.secrets,
        ),
      },
      links: eventLinks(snapshot),
    };
    try {
      const event = eventJournal.append(input);
      const summary = outcomeSummary(event);
      if (outcome === "success") snapshot.lastSuccess = summary;
      else snapshot.lastFailure = summary;
      if (options.stateDir) {
        const replay = replayEventJournal(options.stateDir);
        snapshot.journal = {
          earliestSequence: replay.earliestSequence,
          latestSequence: replay.latestSequence,
          retainedSegments: replay.retainedSegments,
          quarantinedTailCount: replay.quarantinedTailCount,
        };
      } else {
        snapshot.journal.latestSequence = event.sequence;
        snapshot.journal.earliestSequence ??= event.sequence;
      }
    } catch (error) {
      markTelemetryFailure(error, at);
    }
  };

  const record = (transition: RuntimeStatusTransition): StatusSnapshot => {
    const at = now().toISOString();
    snapshot.updatedAt = at;
    // Every transition prints at most one tagged line — the volume the
    // multiplexed-container rail (#73/#60) exists to bound. `selecting` alone
    // yields `null`: one per poll cycle per tenant is exactly the noise floor
    // that rail was built to avoid.
    let line: string | null;
    switch (transition.kind) {
      case "selecting":
        snapshot.lifecycle = { state: "selecting" };
        snapshot.control.backoff = { active: false };
        line = null;
        break;
      case "idle": {
        const reason = sanitizeTelemetryText(transition.reason, options.secrets);
        snapshot.lifecycle = { state: "idle", reason };
        snapshot.activeWork = null;
        line = `${tag} ${reason}`;
        break;
      }
      case "work-started": {
        const work: WorkIdentity = {
          workId: transition.work.workId ?? randomId(),
          kind: transition.work.kind,
          startedAt: at,
          ...(transition.work.issueNumber !== undefined
            ? { issueNumber: transition.work.issueNumber }
            : {}),
          ...(transition.work.pullRequestNumber !== undefined
            ? { pullRequestNumber: transition.work.pullRequestNumber }
            : {}),
          ...(transition.work.branch ? { branch: transition.work.branch } : {}),
        };
        snapshot.activeWork = work;
        snapshot.lifecycle = { state: "running" };
        snapshot.links = {
          repository: repositoryLink,
          ...(work.issueNumber !== undefined
            ? { issue: `${repositoryLink}/issues/${work.issueNumber}` }
            : {}),
          ...(work.pullRequestNumber !== undefined
            ? { pullRequest: `${repositoryLink}/pull/${work.pullRequestNumber}` }
            : {}),
          ...(work.branch
            ? { branch: `${repositoryLink}/tree/${encodeURIComponent(work.branch)}` }
            : {}),
        };
        line = `${tag} started ${work.kind} #${workRefLabel(work)}`;
        break;
      }
      case "work-completed": {
        const work = snapshot.activeWork;
        attachPullRequest(transition.pullRequestNumber);
        applyEvent(at, "success", null, transition);
        snapshot.lifecycle = { state: "selecting" };
        snapshot.activeWork = null;
        snapshot.control.retry = { attempt: 0 };
        line = work ? `${tag} completed ${work.kind} #${workRefLabel(work)}` : null;
        break;
      }
      case "work-failed": {
        const work = snapshot.activeWork;
        attachPullRequest(transition.pullRequestNumber);
        const message = sanitizeTelemetryText(transition.error, options.secrets);
        const classified = classifyFailure(message);
        applyEvent(
          at,
          classified.outcome,
          {
            category: classified.category,
            summary: message,
            retryable: classified.retryable,
          },
          transition,
        );
        snapshot.lifecycle = { state: "failed", reason: message };
        snapshot.activeWork = null;
        snapshot.control.retry = { attempt: snapshot.control.retry.attempt + 1 };
        if (classified.outcome === "quota-backoff") {
          snapshot.control.backoff = { active: true, reason: message };
        }
        line = work ? `${tag} failed ${work.kind} #${workRefLabel(work)} — ${message}` : null;
        break;
      }
      case "work-timed-out": {
        const work = snapshot.activeWork;
        const seconds = Math.round(transition.elapsedMs / 1_000);
        const summary = `Work unit exceeded its ${seconds}s wall-clock budget and was aborted.`;
        applyEvent(
          at,
          "agent-failure",
          { category: "agent", summary, retryable: true },
          { resources: { summary } },
        );
        snapshot.lifecycle = { state: "failed", reason: summary };
        snapshot.activeWork = null;
        snapshot.control.retry = { attempt: snapshot.control.retry.attempt + 1 };
        line = work ? `${tag} timed-out ${work.kind} #${workRefLabel(work)} — ${summary}` : null;
        break;
      }
      case "unit-quarantined": {
        // Log-only (#75/#60): the durable quarantine record is the GitHub
        // marker/label on the unit itself, not this ephemeral snapshot — so
        // beyond `updatedAt` (set above for every transition), nothing here
        // mutates `snapshot`. It fires after `activeWork` is already cleared,
        // so the unit is carried explicitly rather than read off `activeWork`.
        const reason = sanitizeTelemetryText(transition.reason, options.secrets);
        line = `${tag} quarantined ${transition.work.kind} #${workRefLabel(transition.work)} — ${reason}`;
        break;
      }
      case "backoff": {
        const reason = sanitizeTelemetryText(transition.reason, options.secrets);
        snapshot.lifecycle = { state: "idle", reason };
        snapshot.control.backoff = {
          active: true,
          reason,
          ...(transition.until ? { until: transition.until } : {}),
        };
        line = `${tag} ${reason}`;
        break;
      }
      case "draining": {
        const reason = sanitizeTelemetryText(transition.reason, options.secrets);
        snapshot.lifecycle = { state: "draining", reason };
        snapshot.control.drain = { requested: true, requestedAt: at };
        line = `${tag} ${reason}`;
        break;
      }
      case "engine-failed": {
        const reason = sanitizeTelemetryText(transition.error, options.secrets);
        snapshot.lifecycle = { state: "failed", reason };
        line = `${tag} ${reason}`;
        break;
      }
      case "stopped":
        snapshot.lifecycle = { state: "stopped" };
        snapshot.activeWork = null;
        line = `${tag} stopped`;
        break;
    }
    if (line !== null) log(line);
    persist(at);
    return snapshot;
  };

  const setQueue = (queue: readonly QueueEntry[]): StatusSnapshot => {
    const at = now().toISOString();
    snapshot.updatedAt = at;
    snapshot.queue = queue;
    persist(at);
    return snapshot;
  };

  persist(startedAt);
  return { record, snapshot: () => snapshot, setQueue };
}
