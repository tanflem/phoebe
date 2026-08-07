import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  type PathLike,
} from "node:fs";
import { join } from "node:path";
import {
  ContractCapabilityError,
  parseStatusSnapshot,
  STATUS_SCHEMA_VERSION,
  type StatusSnapshot,
} from "./status-contract.ts";

export const STATUS_SNAPSHOT_FILE = `${STATUS_SCHEMA_VERSION}.json`;
const RUNTIME_ID_FILE = "runtime-id";

export type StatusStoreIo = {
  mkdir: (path: PathLike, options: { recursive: true }) => unknown;
  write: (path: PathLike, data: string, encoding: "utf8") => unknown;
  rename: (from: PathLike, to: PathLike) => unknown;
  read: (path: PathLike, encoding: "utf8") => string;
};

const DEFAULT_IO: StatusStoreIo = {
  mkdir: mkdirSync,
  write: writeFileSync,
  rename: renameSync,
  read: readFileSync,
};

export type StatusReadResult =
  | { available: true; status: StatusSnapshot }
  | {
      available: false;
      reason: "not-found" | "corrupt";
      message: string;
    }
  | {
      available: false;
      reason: "unsupported-version";
      receivedVersion: string;
      message: string;
    };

export function statusSnapshotPath(stateDir: string): string {
  return join(stateDir, STATUS_SNAPSHOT_FILE);
}

export function writeStatusSnapshot(
  stateDir: string,
  snapshot: StatusSnapshot,
  io: StatusStoreIo = DEFAULT_IO,
): void {
  io.mkdir(stateDir, { recursive: true });
  const target = statusSnapshotPath(stateDir);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  io.write(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  io.rename(temporary, target);
}

export function readStatusSnapshot(
  stateDir: string,
  io: StatusStoreIo = DEFAULT_IO,
): StatusReadResult {
  const path = statusSnapshotPath(stateDir);
  try {
    return {
      available: true,
      status: parseStatusSnapshot(JSON.parse(io.read(path, "utf8"))),
    };
  } catch (error) {
    if (error instanceof ContractCapabilityError) throw error;
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return {
        available: false,
        reason: "not-found",
        message: `No ${STATUS_SCHEMA_VERSION} snapshot exists at ${path}.`,
      };
    }
    return {
      available: false,
      reason: "corrupt",
      message: `Could not decode ${STATUS_SCHEMA_VERSION} at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export function loadOrCreateRuntimeId(
  stateDir: string,
  options: { preferredId?: string; randomId?: () => string } = {},
): string {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, RUNTIME_ID_FILE);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length === 0) throw new Error(`Runtime identity at ${path} is empty.`);
    if (options.preferredId !== undefined && options.preferredId !== existing) {
      throw new Error(
        `PHOEBE_RUNTIME_ID "${options.preferredId}" does not match persisted runtime ID "${existing}".`,
      );
    }
    return existing;
  }
  const runtimeId = options.preferredId ?? (options.randomId ?? randomUUID)();
  if (runtimeId.trim().length === 0) throw new Error("Runtime ID must not be empty.");
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${runtimeId}\n`, "utf8");
  renameSync(temporary, path);
  return runtimeId;
}
