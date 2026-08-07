// Work-unit execution is gated to the Phoebe container. Selection logic and
// --dry-run stay host-runnable for fast iteration; anything that mutates a
// clone, launches an agent CLI, or pushes runs only where the container
// marker exists (created by the Dockerfile).

import { existsSync } from "node:fs";

export const CONTAINER_MARKER_PATH = "/.phoebe-container";

export function isInsideContainer(exists: (path: string) => boolean = existsSync): boolean {
  return exists(CONTAINER_MARKER_PATH);
}

export type ExecutionDecision = "execute" | "dry-run" | "refuse";

/** Pure decision: may this process execute the selected work unit? */
export function executionDecision(opts: {
  dryRun: boolean;
  inContainer: boolean;
}): ExecutionDecision {
  if (opts.dryRun) return "dry-run";
  return opts.inContainer ? "execute" : "refuse";
}

export const EXECUTION_REFUSED_MESSAGE =
  "Refusing to execute a work unit outside the Phoebe container. " +
  "Use --dry-run to preview selection on the host, or start the container loop.";
