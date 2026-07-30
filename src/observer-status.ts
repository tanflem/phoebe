import { mkdirSync, readFileSync, renameSync, writeFileSync, type PathLike } from "node:fs";
import { dirname, join } from "node:path";
import type { ProviderName } from "./config-schema.ts";

export const OBSERVER_STATUS_VERSION = 1 as const;
export const DEFAULT_OBSERVER_EVENT_LIMIT = 20;
export const OBSERVER_STATUS_FILE = "observer-status.json";

export type ObserverPhase =
  | "starting"
  | "selecting"
  | "idle"
  | "running"
  | "draining"
  | "stopped"
  | "failed";

export type ObserverWork = {
  kind: "conflicts" | "checks" | "reviews" | "issues" | "research";
  description: string;
  issueNumber?: number;
  prNumber?: number;
  branch?: string;
};

export type ObserverConfiguration = {
  defaultBranch: string;
  branchPrefix: string;
  readyLabel: string;
  researchLabel: string;
  prScope: "phoebe" | "all";
  draftPrs: "skip-non-phoebe" | "skip-all" | "include";
  prOptOutLabel: string;
  workOrder: readonly string[];
  provider: ProviderName;
  model: string;
  pollIntervalMs: number;
};

export type ObserverEngine = {
  source: "github" | "local" | "direct";
  repo?: string;
  ref?: string;
  sha?: string;
  quarantinedSha?: string;
};

export type ObserverEvent = {
  at: string;
  kind: "started" | "idle" | "work-started" | "work-completed" | "work-failed" | "draining";
  message: string;
  work?: ObserverWork;
};

export type ObserverOutcome = {
  at: string;
  result: "completed" | "failed";
  work: ObserverWork;
  error?: string;
};

export type ObserverStatus = {
  schemaVersion: typeof OBSERVER_STATUS_VERSION;
  updatedAt: string;
  startedAt: string;
  repoSlug: string;
  phase: ObserverPhase;
  engine: ObserverEngine;
  configuration: ObserverConfiguration;
  currentWork: (ObserverWork & { startedAt: string }) | null;
  idleReason: string | null;
  lastOutcome: ObserverOutcome | null;
  recentEvents: ObserverEvent[];
};

export type ObserverStatusResult =
  | {
      schemaVersion: typeof OBSERVER_STATUS_VERSION;
      observedAt: string;
      available: true;
      status: ObserverStatus;
    }
  | {
      schemaVersion: typeof OBSERVER_STATUS_VERSION;
      observedAt: string;
      available: false;
      reason: "not-found" | "unreadable";
      message: string;
    };

export type ObserverTransition =
  | { kind: "selecting" }
  | { kind: "idle"; reason: string }
  | { kind: "work-started"; work: ObserverWork }
  | { kind: "work-completed" }
  | { kind: "work-failed"; error: unknown }
  | { kind: "draining"; reason: string }
  | { kind: "engine-failed"; error: unknown }
  | { kind: "stopped" };

type StatusIo = {
  mkdir: (path: PathLike, options: { recursive: true }) => unknown;
  write: (path: PathLike, data: string, encoding: "utf8") => unknown;
  rename: (oldPath: PathLike, newPath: PathLike) => unknown;
  read: (path: PathLike, encoding: "utf8") => string;
};

const DEFAULT_IO: StatusIo = {
  mkdir: mkdirSync,
  write: writeFileSync,
  rename: renameSync,
  read: readFileSync,
};

export function observerStatusPath(stateDir: string): string {
  return join(stateDir, OBSERVER_STATUS_FILE);
}

export function sanitizeStatusText(
  value: unknown,
  secrets: readonly string[] = [],
  maxLength = 2_000,
): string {
  let text = value instanceof Error ? value.message : String(value);

  for (const secret of [...secrets]
    .filter((item) => item.length >= 4)
    .sort((a, b) => b.length - a.length)) {
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

function engineFromEnv(env: NodeJS.ProcessEnv): ObserverEngine {
  const rawSource = env["PHOEBE_RUNNING_ENGINE_SOURCE"];
  const source = rawSource === "github" || rawSource === "local" ? rawSource : "direct";
  return {
    source,
    ...(env["PHOEBE_RUNNING_ENGINE_REPO"] ? { repo: env["PHOEBE_RUNNING_ENGINE_REPO"] } : {}),
    ...(env["PHOEBE_RUNNING_ENGINE_REF"] ? { ref: env["PHOEBE_RUNNING_ENGINE_REF"] } : {}),
    ...(env["PHOEBE_RUNNING_ENGINE_SHA"] ? { sha: env["PHOEBE_RUNNING_ENGINE_SHA"] } : {}),
    ...(env["PHOEBE_QUARANTINED_ENGINE_SHA"]
      ? { quarantinedSha: env["PHOEBE_QUARANTINED_ENGINE_SHA"] }
      : {}),
  };
}

function writeAtomically(path: string, value: unknown, io: StatusIo): void {
  io.mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  io.write(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  io.rename(temporaryPath, path);
}

export function createObserverStatusReporter(options: {
  /** Omit for an in-memory reporter (host-side dry-run/refusal paths). */
  path?: string;
  repoSlug: string;
  configuration: ObserverConfiguration;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  eventLimit?: number;
  secrets?: readonly string[];
  onWriteError?: (error: unknown) => void;
  io?: StatusIo;
}): { record: (transition: ObserverTransition) => ObserverStatus; snapshot: () => ObserverStatus } {
  const now = options.now ?? (() => new Date());
  const io = options.io ?? DEFAULT_IO;
  const eventLimit = options.eventLimit ?? DEFAULT_OBSERVER_EVENT_LIMIT;
  const startedAt = now().toISOString();
  let status: ObserverStatus = {
    schemaVersion: OBSERVER_STATUS_VERSION,
    updatedAt: startedAt,
    startedAt,
    repoSlug: options.repoSlug,
    phase: "starting",
    engine: engineFromEnv(options.env ?? process.env),
    configuration: options.configuration,
    currentWork: null,
    idleReason: null,
    lastOutcome: null,
    recentEvents: [{ at: startedAt, kind: "started", message: "Engine started." }],
  };

  const persist = (): void => {
    if (options.path === undefined) return;
    try {
      writeAtomically(options.path, status, io);
    } catch (error) {
      options.onWriteError?.(error);
    }
  };

  const appendEvent = (event: ObserverEvent): void => {
    status.recentEvents = [...status.recentEvents, event].slice(-eventLimit);
  };

  const record = (transition: ObserverTransition): ObserverStatus => {
    const at = now().toISOString();
    status.updatedAt = at;

    switch (transition.kind) {
      case "selecting":
        status.phase = "selecting";
        status.idleReason = null;
        break;
      case "idle":
        status.phase = "idle";
        status.currentWork = null;
        status.idleReason = transition.reason;
        appendEvent({ at, kind: "idle", message: transition.reason });
        break;
      case "work-started":
        status.phase = "running";
        status.currentWork = { ...transition.work, startedAt: at };
        status.idleReason = null;
        appendEvent({
          at,
          kind: "work-started",
          message: `Started ${transition.work.description}.`,
          work: transition.work,
        });
        break;
      case "work-completed": {
        const work = status.currentWork;
        if (work !== null) {
          const { startedAt: _startedAt, ...publicWork } = work;
          status.lastOutcome = { at, result: "completed", work: publicWork };
          appendEvent({
            at,
            kind: "work-completed",
            message: `Finished ${publicWork.description}.`,
            work: publicWork,
          });
        }
        status.phase = "selecting";
        status.currentWork = null;
        break;
      }
      case "work-failed": {
        const error = sanitizeStatusText(transition.error, options.secrets);
        const work = status.currentWork;
        if (work !== null) {
          const { startedAt: _startedAt, ...publicWork } = work;
          status.lastOutcome = { at, result: "failed", work: publicWork, error };
          appendEvent({
            at,
            kind: "work-failed",
            message: `Failed ${publicWork.description}: ${error}`,
            work: publicWork,
          });
        }
        status.phase = "failed";
        status.currentWork = null;
        break;
      }
      case "draining":
        status.phase = "draining";
        appendEvent({ at, kind: "draining", message: transition.reason });
        break;
      case "engine-failed":
        status.phase = "failed";
        status.idleReason = sanitizeStatusText(transition.error, options.secrets);
        break;
      case "stopped":
        status.phase = "stopped";
        status.currentWork = null;
        break;
    }

    persist();
    return status;
  };

  persist();
  return { record, snapshot: () => status };
}

function isObserverStatus(value: unknown): value is ObserverStatus {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate["schemaVersion"] === OBSERVER_STATUS_VERSION &&
    typeof candidate["updatedAt"] === "string" &&
    typeof candidate["repoSlug"] === "string" &&
    typeof candidate["phase"] === "string"
  );
}

export function readObserverStatus(
  path: string,
  options: { now?: () => Date; io?: StatusIo } = {},
): ObserverStatusResult {
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  try {
    const parsed: unknown = JSON.parse((options.io ?? DEFAULT_IO).read(path, "utf8"));
    if (!isObserverStatus(parsed)) {
      return {
        schemaVersion: OBSERVER_STATUS_VERSION,
        observedAt,
        available: false,
        reason: "unreadable",
        message: `Status at ${path} does not match observer schema v${OBSERVER_STATUS_VERSION}.`,
      };
    }
    return {
      schemaVersion: OBSERVER_STATUS_VERSION,
      observedAt,
      available: true,
      status: parsed,
    };
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
    return {
      schemaVersion: OBSERVER_STATUS_VERSION,
      observedAt,
      available: false,
      reason: code === "ENOENT" ? "not-found" : "unreadable",
      message:
        code === "ENOENT"
          ? `No observer status has been written at ${path}.`
          : `Could not read observer status at ${path}: ${sanitizeStatusText(error)}`,
    };
  }
}
