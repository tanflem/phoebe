// Multi-tenant lifecycle commands (#63) — the CLI surface for a deployment that
// owns many repos rather than a single scaffold.
//
// Host-side (operate on the bind-mounted config tree):
//   - `add-repo <owner/repo>`  scaffold repos/<owner>/<repo>/ → transitions the
//                              deployment to nested; the running supervisor
//                              discovers it on the next poll (file-drop, #58).
//   - `remove-repo <owner/repo>`  delete the tenant config dir (reversible;
//                              /data/repos/<slug> is retained, #62).
// In-container (act on the data volume):
//   - `list`   enumerate tenants + health (config valid? env present? engine
//              state from status.json? retained /data?).
//   - `purge <owner/repo> --yes`  destructive wipe of a *removed* tenant's
//              retained /data/repos/<slug>; refuses while a live config exists.
//
// The functions here are pure filesystem operations parameterised by the config
// dir and data base, so they are unit-tested against temp dirs; the CLI layer
// (src/cli.ts) resolves those roots and prints the reports.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { REPOS_DIR, TENANT_CONFIG_FILE, TENANT_ENV_FILE } from "../bootstrap/tenants.ts";
import { ContractCapabilityError, type QueueEntry } from "./status-contract.ts";
import { readStatusSnapshot } from "./status-store.ts";
import { readStatus, STATUS_FILE, type StatusSnapshot } from "./unit-event.ts";

/**
 * The named model-A constraint (#61/#63): all tenants share uid 10001, so their
 * `.env` files are NOT DAC-isolated at rest. `add-repo` prints this on every run
 * — it fires exactly when a second tenant makes co-tenancy relevant.
 */
export const TRUST_DOMAIN_NOTE =
  "⚠️  One container = one trust domain. All tenants run as the same user, so a " +
  "prompt-injected agent in one repo can read every co-tenant's .env at rest. " +
  "Only co-locate repos whose mutual compromise is already acceptable (same " +
  "org / token scope). Mutually-untrusted repos need separate containers.";

/**
 * Validate and split an `owner/repo` slug. Throws on anything malformed.
 *
 * The character class allows `.` (real repo names contain it, e.g. `foo.js`),
 * so a segment could be exactly `.` or `..` — which every consumer joins into a
 * filesystem path (`addRepo`/`removeRepo`/`purgeTenant`, the last an `rmSync`).
 * A traversing segment would escape the tenant tree / data base, so reject `.`
 * and `..` as whole segments explicitly (the regex alone cannot, since it must
 * still admit dots inside a name).
 */
export function parseSlug(slug: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(slug);
  if (!match) {
    throw new Error(`Invalid repo slug "${slug}". Expected "owner/repo" (e.g. acme/widget).`);
  }
  const [owner, repo] = [match[1]!, match[2]!];
  if (owner === "." || owner === ".." || repo === "." || repo === "..") {
    throw new Error(`Invalid repo slug "${slug}": "." and ".." are not allowed path segments.`);
  }
  return { owner, repo };
}

/** Derive the default HTTPS clone URL for a GitHub slug. */
export function defaultRepoUrl(slug: string): string {
  return `https://github.com/${slug}.git`;
}

/**
 * Render a per-tenant `phoebe.config.ts`. Type-only import (like the shipped
 * flat scaffold) so it loads from the container mount with no `node_modules`;
 * deliberately carries NO `engine` field — engine source is shared, set in the
 * deployment-root config (#60/#63).
 */
export function renderTenantConfig(fields: {
  repoSlug: string;
  repoUrl: string;
  installCommand: string;
  checkCommand: string;
  testCommand: string;
}): string {
  return `// Per-tenant Phoebe config — scaffolded by \`phoebe add-repo\`.
//
// One tenant of a multi-tenant deployment. The shared engine source and
// fleet-global knobs live in the deployment-root phoebe.config.ts, not here.
import type { PhoebeUserConfig } from "phoebe-agent";

const config: PhoebeUserConfig = {
  repoSlug: ${JSON.stringify(fields.repoSlug)},
  repoUrl: ${JSON.stringify(fields.repoUrl)},
  installCommand: ${JSON.stringify(fields.installCommand)},
  checkCommand: ${JSON.stringify(fields.checkCommand)},
  testCommand: ${JSON.stringify(fields.testCommand)},
};

export default config;
`;
}

const TENANT_ENV_EXAMPLE = `# Per-tenant secrets — copy to \`.env\`. Read ONLY by this tenant's engine child
# (the supervisor scrubs every other tenant's secrets, #61).

# --- Required ---
GH_TOKEN=

# --- Provider key (set the one this repo's defaultProvider uses) ---
CURSOR_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_KEY=
`;

export type AddRepoResult = { tenantDir: string; created: string[] };

/**
 * Scaffold one tenant under `repos/<owner>/<repo>/`. Creates `repos/` on first
 * use (transitioning the deployment to nested). Refuses to overwrite an existing
 * tenant. Prompt overrides are seeded only with `withPrompts` (the engine ships
 * defaults otherwise, #63).
 */
export function addRepo(opts: {
  configDir: string;
  slug: string;
  repoUrl?: string;
  installCommand?: string;
  checkCommand?: string;
  testCommand?: string;
  withPrompts?: boolean;
  seedPrompt?: (promptsDir: string) => string[];
}): AddRepoResult {
  const { owner, repo } = parseSlug(opts.slug);
  const tenantDir = join(opts.configDir, REPOS_DIR, owner, repo);
  if (existsSync(tenantDir)) {
    throw new Error(
      `Tenant ${opts.slug} already exists at ${tenantDir}. ` +
        `Edit it in place, or \`remove-repo\` it first.`,
    );
  }
  mkdirSync(tenantDir, { recursive: true });

  const created: string[] = [];
  const configPath = join(tenantDir, TENANT_CONFIG_FILE);
  writeFileSync(
    configPath,
    renderTenantConfig({
      repoSlug: opts.slug,
      repoUrl: opts.repoUrl ?? defaultRepoUrl(opts.slug),
      installCommand: opts.installCommand ?? "npm ci",
      checkCommand: opts.checkCommand ?? "npm run check",
      testCommand: opts.testCommand ?? "npm test",
    }),
  );
  created.push(configPath);

  const envExamplePath = join(tenantDir, `${TENANT_ENV_FILE}.example`);
  writeFileSync(envExamplePath, TENANT_ENV_EXAMPLE);
  created.push(envExamplePath);

  if (opts.withPrompts && opts.seedPrompt) {
    created.push(...opts.seedPrompt(join(tenantDir, "prompts")));
  }

  return { tenantDir, created };
}

/**
 * Remove a tenant's config dir (reversible — its `/data/repos/<slug>` is retained
 * by the supervisor, #62; use `purge` to reclaim it). Refuses when the tenant
 * does not exist so a typo is loud rather than a silent no-op.
 */
export function removeRepo(opts: { configDir: string; slug: string }): { removed: string } {
  const { owner, repo } = parseSlug(opts.slug);
  const tenantDir = join(opts.configDir, REPOS_DIR, owner, repo);
  if (!existsSync(tenantDir)) {
    throw new Error(`No tenant ${opts.slug} at ${tenantDir}.`);
  }
  rmSync(tenantDir, { recursive: true, force: true });
  return { removed: tenantDir };
}

export type TenantListing = {
  slug: string;
  configValid: boolean;
  envPresent: boolean;
  retainedData: boolean;
  status: StatusSnapshot | null;
  /** The status-v2 `queue` lookahead, or `[]` when no contract snapshot is readable yet. */
  queue: readonly QueueEntry[];
};

/** Whether a `.env` (not just the example) is present for a tenant dir. */
function envPresent(dir: string): boolean {
  return existsSync(join(dir, TENANT_ENV_FILE));
}

/**
 * Read the status-v2 contract snapshot's `queue` for one tenant's state dir.
 * Tolerant by design — a missing/corrupt snapshot or a stale pre-v2 one (from
 * before an engine upgrade) must not break `phoebe list`, so this reduces every
 * failure mode to an empty lookahead rather than surfacing it.
 */
function readTenantQueue(stateDir: string): readonly QueueEntry[] {
  try {
    const result = readStatusSnapshot(stateDir);
    return result.available ? result.status.queue : [];
  } catch (error) {
    if (error instanceof ContractCapabilityError) return [];
    throw error;
  }
}

/** Enumerate every nested tenant with its health signals for `phoebe list`. */
export function listTenants(opts: { configDir: string; dataBase: string }): TenantListing[] {
  const reposRoot = join(opts.configDir, REPOS_DIR);
  const listings: TenantListing[] = [];
  let owners: string[];
  try {
    owners = readdirSync(reposRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return listings;
  }
  for (const owner of owners) {
    let repos: string[];
    try {
      repos = readdirSync(join(reposRoot, owner), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const repo of repos) {
      const slug = `${owner}/${repo}`;
      const dir = join(reposRoot, owner, repo);
      const dataDir = join(opts.dataBase, slug);
      const stateDir = join(dataDir, "state");
      listings.push({
        slug,
        configValid: existsSync(join(dir, TENANT_CONFIG_FILE)),
        envPresent: envPresent(dir),
        retainedData: existsSync(dataDir),
        status: readStatus(join(stateDir, STATUS_FILE)),
        queue: readTenantQueue(stateDir),
      });
    }
  }
  return listings.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Destructively wipe a *removed* tenant's retained `/data/repos/<slug>`. Refuses
 * while a live config dir still exists for that slug (purge is for removed
 * tenants only — otherwise it would nuke a running tenant's clone), and requires
 * an explicit `confirm` (the CLI's `--yes`).
 */
export function purgeTenant(opts: {
  configDir: string;
  dataBase: string;
  slug: string;
  confirm: boolean;
}): { purged: string } {
  const { owner, repo } = parseSlug(opts.slug);
  if (!opts.confirm) {
    throw new Error(`Refusing to purge ${opts.slug} without --yes (this is irreversible).`);
  }
  const tenantConfigDir = join(opts.configDir, REPOS_DIR, owner, repo);
  if (existsSync(tenantConfigDir)) {
    throw new Error(
      `Tenant ${opts.slug} still has a live config at ${tenantConfigDir}. ` +
        `\`remove-repo\` it first — purge only reclaims data for removed tenants.`,
    );
  }
  const dataDir = join(opts.dataBase, owner, repo);
  if (!existsSync(dataDir)) {
    throw new Error(`No retained data at ${dataDir} for ${opts.slug}.`);
  }
  rmSync(dataDir, { recursive: true, force: true });
  return { purged: dataDir };
}

/** Read a tenant config's fields for `add-repo --from-config` migration. */
export function readFlatRepoFields(configDir: string): {
  installCommand?: string;
  checkCommand?: string;
  testCommand?: string;
} {
  const path = join(configDir, TENANT_CONFIG_FILE);
  try {
    const source = readFileSync(path, "utf8");
    const pick = (key: string): string | undefined => {
      const m = new RegExp(`${key}\\s*:\\s*(["'\\\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(source);
      return m?.[2];
    };
    return {
      installCommand: pick("installCommand"),
      checkCommand: pick("checkCommand"),
      testCommand: pick("testCommand"),
    };
  } catch {
    return {};
  }
}

/** True when the deployment root has a `repos/` dir (nested mode). */
export function isNested(configDir: string): boolean {
  try {
    return statSync(join(configDir, REPOS_DIR)).isDirectory();
  } catch {
    return false;
  }
}
