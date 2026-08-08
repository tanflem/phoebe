// `phoebe list` — in-container, enumerate tenants + health (reads the
// status-v2 contract snapshot; #63/#95).

import { resolveDataBase } from "../paths.ts";
import type { StatusSnapshot } from "../status-contract.ts";
import { workIdentityId } from "../status-contract.ts";
import { listTenants, type TenantListing } from "../tenant-commands.ts";
import type { Command } from "./types.ts";

const QUEUE_LOOKAHEAD_LIMIT = 5;

/** `#12, #34→#12, #56` — each issue number, with its blockers when it has any. */
export function formatQueueLookahead(queue: TenantListing["queue"]): string {
  if (queue.length === 0) return "queue: (empty)";
  const shown = queue
    .slice(0, QUEUE_LOOKAHEAD_LIMIT)
    .map((entry) =>
      entry.blockedBy.length > 0
        ? `#${entry.issueNumber}→${entry.blockedBy.map((b) => `#${b}`).join(",")}`
        : `#${entry.issueNumber}`,
    )
    .join(", ");
  const rest = queue.length - QUEUE_LOOKAHEAD_LIMIT;
  return `queue: ${shown}${rest > 0 ? ` (+${rest} more)` : ""}`;
}

/**
 * Render one tenant's engine state from its status-v2 lifecycle — a `stopped`,
 * `draining`, or `failed` tenant must read as such, not as `idle` (a silent
 * "no status" or "idle" reading here is indistinguishable from a tenant that
 * never booted, which is the case a mid-fleet-upgrade version mismatch costs
 * the most).
 */
function formatSnapshotState(snapshot: StatusSnapshot): string {
  const { state } = snapshot.lifecycle;
  if (state === "running" && snapshot.activeWork) {
    const work = snapshot.activeWork;
    return `working ${work.kind} #${workIdentityId(work) ?? work.workId}`;
  }
  if (state === "draining") return "draining";
  if (state === "stopped") return "stopped";
  if (state === "failed") return `failed — ${snapshot.lifecycle.reason ?? "unknown reason"}`;
  return "idle"; // starting / selecting / idle / running-with-no-activeWork
}

function formatTenantStatus(status: TenantListing["status"]): string {
  if (status === null) return "no status";
  if (!status.available) {
    if (status.reason === "unsupported-version") {
      return `status from a newer engine (${status.receivedVersion})`;
    }
    return status.reason === "not-found" ? "no status" : "unreadable status";
  }
  return formatSnapshotState(status.status);
}

export function formatTenantListing(listing: TenantListing): string {
  const flag = (label: string, on: boolean): string => `${on ? "✓" : "✗"} ${label}`;
  const state = formatTenantStatus(listing.status);
  return (
    `  ${listing.slug}\n` +
    `      ${flag("config", listing.configValid)}  ${flag("env", listing.envPresent)}  ` +
    `${flag("data", listing.retainedData)}  ${state}\n` +
    `      ${formatQueueLookahead(listing.queue)}`
  );
}

export const listCommand: Command = {
  name: "list",
  summary: "phoebe list                      List tenants + health (in-container)",
  help: "phoebe list — enumerate tenants + health\n\nUsage: phoebe list\n",
  async run(_argv, ctx) {
    const listings = await listTenants({
      configDir: ctx.cwd,
      dataBase: resolveDataBase(ctx.env),
    });
    if (listings.length === 0) {
      ctx.stdout.write("[phoebe] No tenants (flat single-tenant deployment, or none added yet).\n");
      return 0;
    }
    ctx.stdout.write(
      `[phoebe] ${listings.length} tenant(s):\n${listings.map(formatTenantListing).join("\n")}\n`,
    );
    return 0;
  },
};
