// `phoebe serve` (#24) — a read-only, self-contained HTML view of every
// tenant across one or more `--state-dir` roots, for an operator running more
// than one container (separate trust domains, or separate hosts) with no
// single-container `phoebe list` view.
//
// Constraints from the issue, load-bearing for how this is built:
//   - read-only: this module never writes, labels, or triggers anything —
//     it only calls `readStatusSnapshot` (already read-only).
//   - no store: `collectServeSnapshot` re-walks disk on every call; the HTTP
//     handler calls it fresh per request, so there is nothing to keep alive
//     or go stale in-process (the staleness that matters is the snapshot's
//     own `updatedAt`, surfaced per row).
//   - no auth story: the server binds to localhost by default (`runServe` in
//     cli.ts); anything else is the operator's reverse proxy.
//
// A `--state-dir` root is a deployment's data base (what `PHOEBE_DATA_DIR` /
// `resolveDataBase` points at, e.g. `/data/repos`) — `derivePaths` (paths.ts)
// lays out every tenant under it as `<root>/<owner>/<repo>/state/status-v2.json`
// regardless of whether that deployment's *config* is flat, nested, or
// workspace, so walking two directory levels under the root is enough to find
// every tenant without touching any config tree (`phoebe list` also reads
// config health, which is why it needs a config dir; this doesn't).

import { readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { resolveDataBase } from "./paths.ts";
import { STATUS_SCHEMA_VERSION, workIdentityId, type StatusSnapshot } from "./status-contract.ts";
import type { StatusReadResult } from "./status-store.ts";
import { readTenantStatus } from "./tenant-commands.ts";

export const DEFAULT_SERVE_PORT = 4879;
export const DEFAULT_SERVE_HOST = "127.0.0.1";

/** A snapshot older than this reads as stale rather than just "aged" (3x the default poll interval). */
const STALE_AGE_MS = 15 * 60 * 1000;

export type ServeTenantRow = {
  slug: string;
  /** The `--state-dir` root this tenant was discovered under (disambiguates same slug on two containers). */
  root: string;
  status: StatusReadResult;
};

export type ServeStateDirResult = {
  root: string;
  readable: boolean;
  error?: string;
  tenants: readonly ServeTenantRow[];
};

export type ParsedServeArgs = { help: boolean; port: number; stateDirs: string[] };

const SERVE_USAGE = "Usage: phoebe serve [--port N] [--state-dir DIR]...";

/**
 * `--port` (default {@link DEFAULT_SERVE_PORT}) and repeatable `--state-dir`
 * (default: the resolved data base, so an in-container run with no flags
 * still covers that container's own tenants — same default `phoebe list` uses).
 */
export function parseServeArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedServeArgs {
  let help = false;
  let port = DEFAULT_SERVE_PORT;
  const stateDirs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--port" || arg.startsWith("--port=")) {
      const value = arg === "--port" ? argv[++i] : arg.slice("--port=".length);
      const port_ = value === undefined ? Number.NaN : Number(value);
      if (value === undefined || !Number.isInteger(port_) || port_ < 0 || port_ > 65535) {
        throw new Error(`\`--port\` requires an integer 0-65535 (got ${JSON.stringify(value)}).`);
      }
      port = port_;
      continue;
    }
    if (arg === "--state-dir" || arg.startsWith("--state-dir=")) {
      const value = arg === "--state-dir" ? argv[++i] : arg.slice("--state-dir=".length);
      if (value === undefined || value.length === 0) {
        throw new Error("`--state-dir` requires a directory path.");
      }
      stateDirs.push(value);
      continue;
    }
    throw new Error(`Unknown flag \`${arg}\` for \`phoebe serve\`. ${SERVE_USAGE}`);
  }
  return { help, port, stateDirs: stateDirs.length > 0 ? stateDirs : [resolveDataBase(env)] };
}

export const SERVE_HELP_TEXT = `phoebe serve — one read-only page showing every tenant's live state and queue

${SERVE_USAGE}

Serves a single self-contained HTML page: one row per tenant (repo slug,
lifecycle state, active work, last outcome, snapshot age) plus its queue
lookahead. Reads status-v2 snapshots fresh on every request — nothing is
cached, and nothing is ever written, labeled, or triggered.

Options:
  --port N          Port to listen on (default ${DEFAULT_SERVE_PORT})
  --state-dir DIR    A deployment data base to include; repeatable. Each is
                     walked as <DIR>/<owner>/<repo>/state/status-v2.json —
                     the same layout every tenant's data lives at regardless
                     of config mode. Default: this container's own data base
                     (honors PHOEBE_DATA_DIR), so a plain \`phoebe serve\`
                     covers the local container.
  --help, -h         Show this message

Binds to ${DEFAULT_SERVE_HOST} only — there is no auth story. Put a reverse
proxy in front if this needs to be reachable from anywhere else.
`;

function describeError(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code === "ENOENT") return "directory does not exist";
    if (code === "EACCES") return "permission denied";
  }
  return error instanceof Error ? error.message : String(error);
}

function listSubdirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * Walk one `--state-dir` root for every `<owner>/<repo>` tenant under it. A
 * root that cannot be listed at all (typo, unmounted volume) is reported as
 * `readable: false` with its own row on the page — an operator's misconfigured
 * flag must be visible, not silently zero tenants. A readable root with an
 * unreadable owner subdirectory just skips that owner (matches `phoebe list`'s
 * nested scan).
 */
function collectStateDir(root: string): ServeStateDirResult {
  let owners: string[];
  try {
    owners = listSubdirs(root);
  } catch (error) {
    return { root, readable: false, error: describeError(error), tenants: [] };
  }
  const tenants: ServeTenantRow[] = [];
  for (const owner of owners.sort()) {
    let repos: string[];
    try {
      repos = listSubdirs(join(root, owner));
    } catch {
      continue;
    }
    for (const repo of repos.sort()) {
      const slug = `${owner}/${repo}`;
      const stateDir = join(root, owner, repo, "state");
      tenants.push({ slug, root, status: readTenantStatus(stateDir) });
    }
  }
  return { root, readable: true, tenants };
}

/** No store (#24): every call re-reads disk — nothing here is retained between requests. */
export function collectServeSnapshot(stateDirs: readonly string[]): ServeStateDirResult[] {
  return stateDirs.map(collectStateDir);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `3s ago` / `4m ago` / `2h 5m ago` / `3d 1h ago`. `now` and `updatedAt` are both epoch-comparable. */
export function formatAge(updatedAt: string, now: number): string {
  const then = Date.parse(updatedAt);
  if (Number.isNaN(then)) return "unknown age (invalid updatedAt)";
  const ms = Math.max(0, now - then);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

function lifecycleCell(snapshot: StatusSnapshot): string {
  const { state, reason } = snapshot.lifecycle;
  const text = reason ? `${state} — ${reason}` : state;
  return `<span class="lifecycle s-${escapeHtml(state)}">${escapeHtml(text)}</span>`;
}

function activeWorkCell(snapshot: StatusSnapshot): string {
  const work = snapshot.activeWork;
  if (work === null) return "—";
  const id = workIdentityId(work);
  const label = id !== undefined ? `${work.kind} #${id}` : `${work.kind} (unnumbered)`;
  const href =
    id !== undefined && id === work.pullRequestNumber
      ? snapshot.links.pullRequest
      : snapshot.links.issue;
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : escapeHtml(label);
}

function lastOutcomeCell(snapshot: StatusSnapshot, now: number): string {
  const candidates = [snapshot.lastSuccess, snapshot.lastFailure].filter(
    (outcome): outcome is NonNullable<typeof outcome> => outcome !== null,
  );
  if (candidates.length === 0) return "—";
  const latest = candidates.sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt))[0]!;
  const label =
    latest.outcome === "success"
      ? "success"
      : `${latest.outcome}${latest.failureCategory ? ` (${latest.failureCategory})` : ""}`;
  return `${escapeHtml(label)} · ${escapeHtml(formatAge(latest.endedAt, now))}`;
}

/** `#12 → #34* → #56` — `*` marks a blocked (not-yet-workable) entry, titled with its blockers. */
function queueChainCell(snapshot: StatusSnapshot): string {
  if (snapshot.queue.length === 0) return "(empty)";
  return snapshot.queue
    .map((entry) => {
      const href = `${snapshot.links.repository}/issues/${entry.issueNumber}`;
      const link = `<a href="${escapeHtml(href)}">#${entry.issueNumber}</a>`;
      if (entry.workable) return link;
      const blockedBy = entry.blockedBy.map((b) => `#${b}`).join(", ");
      const title = blockedBy.length > 0 ? `blocked by ${blockedBy}` : "blocked";
      return `${link}<span class="blocked" title="${escapeHtml(title)}">*</span>`;
    })
    .join(" → ");
}

function badStatusText(status: Exclude<StatusReadResult, { available: true }>): string {
  switch (status.reason) {
    case "not-found":
      return "no status snapshot yet";
    case "corrupt":
      return `corrupt snapshot — ${status.message}`;
    case "unsupported-version":
      return `unsupported schema ${status.receivedVersion} (this page reads ${STATUS_SCHEMA_VERSION})`;
  }
}

function renderTenantRows(tenant: ServeTenantRow, now: number): string {
  const status = tenant.status;
  if (!status.available) {
    return (
      `<tr class="tenant bad">` +
      `<td>${escapeHtml(tenant.slug)}</td>` +
      `<td>${escapeHtml(tenant.root)}</td>` +
      `<td class="bad-state" colspan="4">⚠ ${escapeHtml(badStatusText(status))} — age: unknown</td>` +
      `</tr>`
    );
  }
  const snapshot = status.status;
  const ageMs = Math.max(0, now - Date.parse(snapshot.updatedAt));
  const staleClass = Number.isNaN(ageMs) || ageMs > STALE_AGE_MS ? " stale" : "";
  return (
    `<tr class="tenant">` +
    `<td>${escapeHtml(tenant.slug)}</td>` +
    `<td>${escapeHtml(tenant.root)}</td>` +
    `<td>${lifecycleCell(snapshot)}</td>` +
    `<td>${activeWorkCell(snapshot)}</td>` +
    `<td>${lastOutcomeCell(snapshot, now)}</td>` +
    `<td class="age${staleClass}" title="${escapeHtml(snapshot.updatedAt)}">${escapeHtml(formatAge(snapshot.updatedAt, now))}</td>` +
    `</tr>` +
    `<tr class="queue"><td></td><td colspan="5">queue: ${queueChainCell(snapshot)}</td></tr>`
  );
}

const PAGE_STYLE = `
  body { font: 14px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.1rem; margin: 0 0 0.25rem; }
  .meta { color: #555; margin: 0 0 1.5rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 0.35rem 0.75rem; border-bottom: 1px solid #ddd; vertical-align: top; }
  tr.queue td { border-bottom: 1px solid #eee; color: #555; font-size: 0.85em; padding-top: 0; }
  tr.bad td.bad-state { color: #a33; }
  td.age.stale { color: #a33; font-weight: bold; }
  span.blocked { color: #a33; }
  .state-dir-errors { color: #a33; }
`;

/**
 * Render the full page. `now` is passed in (not read internally) so age is
 * computed once per render and every test/route agrees on "now".
 */
export function renderServePage(results: readonly ServeStateDirResult[], now: number): string {
  const generatedAt = new Date(now).toISOString();
  const stateDirErrors = results.filter((r) => !r.readable);
  const allTenants = results.flatMap((r) => r.tenants);

  const errorList =
    stateDirErrors.length > 0
      ? `<ul class="state-dir-errors">${stateDirErrors
          .map((r) => `<li>⚠ ${escapeHtml(r.root)}: ${escapeHtml(r.error ?? "unreadable")}</li>`)
          .join("")}</ul>`
      : "";

  const rows =
    allTenants.length > 0
      ? allTenants.map((tenant) => renderTenantRows(tenant, now)).join("\n")
      : `<tr><td colspan="6">No tenants found under any configured --state-dir.</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Phoebe fleet</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<h1>Phoebe fleet</h1>
<p class="meta">Generated ${escapeHtml(generatedAt)} — read-only, re-read from disk on every request. Snapshot age reflects the last time that runtime wrote its status; it does not confirm the runtime is still alive.</p>
${errorList}
<table>
<thead><tr><th>Repo</th><th>Source</th><th>Lifecycle</th><th>Active work</th><th>Last outcome</th><th>Snapshot age</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>
`;
}

/** Fresh collect + render per request — the "no store" constraint (#24). */
export function createServeRequestListener(
  stateDirs: readonly string[],
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
      res.end("Method not allowed.\n");
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    if (path !== "/") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found.\n");
      return;
    }
    const html = renderServePage(collectServeSnapshot(stateDirs), Date.now());
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : html);
  };
}

/** Starts listening; does not wait for the `listening` event (see `runServe` in cli.ts, which does). */
export function startServeServer(opts: { port: number; stateDirs: readonly string[] }): Server {
  const server = createServer(createServeRequestListener(opts.stateDirs));
  server.listen(opts.port, DEFAULT_SERVE_HOST);
  return server;
}
