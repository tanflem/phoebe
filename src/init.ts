// `phoebe init` scaffolder. Given a target directory, drops the consumer-owned
// runtime into place. Three profiles share this module:
//
//   flat (default)   Full single-tenant runtime: config (five required fields
//                    + engine), prompts/, .env.example, container/, gitignore.
//   workspace (#93)  Bootable workspace *root*: engine + workspace block,
//                    deployment .env.example, container/ (incl. mount docs),
//                    gitignore. No child files, no prompts/.
//   tenant (#94)     Child in-tree install at a repo root: config + .env.example
//                    + .gitignore'd .env (no container/). Prefills repoSlug/
//                    repoUrl from the checkout's origin; refuses re-clobber.
//
// Flat/workspace re-runs skip existing files. Tenant re-runs refuse loudly
// when a root `phoebe.config.ts` already exists (mirror add-repo).
// The plan/render split keeps the pure logic (what files, what placeholders)
// separately testable from the fs I/O in `runInit`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { TENANT_CONFIG_FILE, TENANT_ENV_FILE } from "../bootstrap/tenants.ts";
import { resolveConfiguration } from "./config/index.ts";
import { defaultGit, type GitRunner } from "./git-model.ts";
import {
  defaultRepoUrl,
  parseSlug,
  renderTenantConfig,
  slugFromRemoteUrl,
  stripUrlCredentials,
  TENANT_ENV_EXAMPLE,
  TENANT_PLACEHOLDER_SLUG,
  TENANT_PLACEHOLDER_URL,
} from "./tenant-commands.ts";

/** Init scaffold profile — which file set lands under the target dir. */
export type InitProfile = "flat" | "workspace" | "tenant";

/** Placeholder tokens rendered into every scaffolded file. */
export type TemplateParams = {
  /** GitHub `owner/repo` slug written into the config. */
  repoSlug: string;
  /** HTTPS clone URL written into the config. */
  repoUrl: string;
  /** The consumer's install command (also written into the config). */
  installCommand: string;
  /** The consumer's check/format/lint gate command. */
  checkCommand: string;
  /** The consumer's test command. */
  testCommand: string;
  /** Which agent CLI runs by default (`cursor` | `claude` | `codex`). */
  defaultProvider: string;
  /** The npm package name of the CLI — normally `phoebe-agent`. */
  cliBin: string;
};

// A throwaway resolution of the roster's shipped defaults (src/config/) — the
// wizard/scaffolder want the resolved defaults, not the (unexported) defaults
// table itself. The five repository-identity fields are never read back out;
// only the defaulted fields below (`defaultProvider`, `defaultModels`,
// `providerEnv`, `promptFiles`) are. Exported so `phoebe setup` (setup.ts)
// shares the same one resolution instead of running its own.
export const DEFAULT_RESOLVED_CONFIG = resolveConfiguration({
  repository: {
    repoSlug: "placeholder/placeholder",
    repoUrl: "https://example.invalid/placeholder.git",
    installCommand: "placeholder",
    checkCommand: "placeholder",
    testCommand: "placeholder",
  },
}).config;

// The four repo/toolchain values default to the same generic placeholders the
// template hardcoded before they were tokenized, and `defaultProvider` to the
// engine's own default — so `phoebe init` renders a config identical in effect
// to today's. `phoebe setup` supplies real answers instead. One template, two
// callers.
export const DEFAULT_TEMPLATE_PARAMS: TemplateParams = {
  repoSlug: "your-org/your-repo",
  repoUrl: "https://github.com/your-org/your-repo.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
  defaultProvider: DEFAULT_RESOLVED_CONFIG.defaultProvider,
  cliBin: "phoebe-agent",
};

/**
 * One consumer-owned output produced by init. Sources are one of:
 *  - `template`: a file under the shipped `templates/` tree, rendered with
 *    placeholder substitution.
 *  - `shipped-prompt`: a file under the shipped `prompts/` tree, copied
 *    verbatim (prompts already carry their own `{{…}}` markers that the
 *    engine expands at run time — do NOT substitute those here).
 *  - `gitignore`: an additive-merge marker; `entries` are appended to any
 *    existing `.gitignore`, deduped line-wise.
 */
export type PlannedOutput = {
  destRelPath: string;
  source:
    | { kind: "template"; templateRelPath: string }
    | { kind: "shipped-prompt"; promptRelPath: string }
    | { kind: "gitignore"; entries: readonly string[] };
};

// Flat gitignore: deployment `.env`, every per-tenant `repos/<owner>/<repo>/.env`
// (#63) must never be committed; `node_modules/` for the scaffolded toolchain.
const FLAT_GITIGNORE_ENTRIES = [".env", "repos/**/.env", "node_modules/"] as const;

// Workspace root: only deployment `.env` (children carry their own `.env` and
// `.gitignore` when scaffolded with `init --tenant`).
const WORKSPACE_GITIGNORE_ENTRIES = [".env", "node_modules/"] as const;

// Workspace child in-tree install: secrets stay out of the child repo.
const TENANT_GITIGNORE_ENTRIES = [".env"] as const;

/** Shared container files scaffolded for flat and workspace roots. */
function planContainerOutputs(): PlannedOutput[] {
  return [
    {
      destRelPath: "container/Dockerfile",
      source: { kind: "template", templateRelPath: "container/Dockerfile" },
    },
    {
      destRelPath: "container/compose.yml",
      source: { kind: "template", templateRelPath: "container/compose.yml" },
    },
    {
      destRelPath: "container/compose.local.yml",
      source: { kind: "template", templateRelPath: "container/compose.local.yml" },
    },
  ];
}

/**
 * Enumerate every file init will produce for a profile. Flat prompts are
 * derived from the roster's `promptFiles` default so adding a new prompt kind
 * to the engine automatically gets scaffolded — no drift between the two lists.
 *
 * Tenant profile (`init --tenant`) is handled by {@link initTenant} — origin
 * prefill makes the config dynamic, so it is not part of this static plan.
 */
export function planInitOutputs(profile: InitProfile = "flat"): PlannedOutput[] {
  if (profile === "tenant") {
    throw new Error(
      "`phoebe init --tenant` uses initTenant() (dynamic origin prefill), not planInitOutputs.",
    );
  }

  if (profile === "workspace") {
    return [
      {
        destRelPath: "phoebe.config.ts",
        source: { kind: "template", templateRelPath: "phoebe.config.workspace.ts" },
      },
      {
        destRelPath: ".env.example",
        source: { kind: "template", templateRelPath: ".env.example" },
      },
      ...planContainerOutputs(),
      // Mount docs (#87/#93): workspace operators need `.git` on the mount and
      // materialised submodules before boot. Lives beside the #57 container
      // templates; not rendered (no placeholders).
      {
        destRelPath: "container/README.md",
        source: { kind: "template", templateRelPath: "container/README.md" },
      },
      {
        destRelPath: ".gitignore",
        source: { kind: "gitignore", entries: WORKSPACE_GITIGNORE_ENTRIES },
      },
    ];
  }

  // flat — today's single-tenant deployment scaffold
  const promptOutputs: PlannedOutput[] = Object.values(DEFAULT_RESOLVED_CONFIG.promptFiles).map(
    (relPath) => ({
      destRelPath: relPath,
      source: { kind: "shipped-prompt", promptRelPath: relPath },
    }),
  );
  return [
    {
      destRelPath: "phoebe.config.ts",
      source: { kind: "template", templateRelPath: "phoebe.config.ts" },
    },
    {
      destRelPath: ".env.example",
      source: { kind: "template", templateRelPath: ".env.example" },
    },
    ...planContainerOutputs(),
    ...promptOutputs,
    {
      destRelPath: ".gitignore",
      source: { kind: "gitignore", entries: FLAT_GITIGNORE_ENTRIES },
    },
  ];
}

/**
 * Substitute `{{KEY}}` tokens with the matching value. Unknown tokens throw
 * so a typo in a template surfaces during tests rather than silently landing
 * in a consumer's repo. Iteration is over the params (not a regex over the
 * source) so a value that happens to contain a `{{…}}`-shaped substring is
 * never re-scanned.
 *
 * Every token in every shipped template sits inside a quoted string literal
 * (a TS string, a Dockerfile `ARG ...="..."`, a YAML `"..."` scalar), so each
 * value is escaped the same way `renderTenantConfig` escapes its fields:
 * `JSON.stringify` minus its outer quotes. That neutralizes a `"`, `\`, or
 * newline in a user-typed value (e.g. `phoebe setup` answers) that would
 * otherwise break out of the surrounding literal (issue #71).
 */
export function renderTemplate(source: string, params: TemplateParams): string {
  let rendered = source;
  for (const [key, value] of Object.entries(params) as Array<[keyof TemplateParams, string]>) {
    const token = `{{${keyToToken(key)}}}`;
    const escaped = JSON.stringify(value).slice(1, -1);
    rendered = rendered.split(token).join(escaped);
  }
  const leftover = /\{\{([A-Z_]+)\}\}/.exec(rendered);
  if (leftover) {
    throw new Error(
      `Template contained an unrenderable placeholder \`{{${leftover[1]}}}\` — ` +
        `every {{TOKEN}} in a scaffolded file must map to a TemplateParams field.`,
    );
  }
  return rendered;
}

function keyToToken(key: keyof TemplateParams): string {
  // installCommand -> INSTALL_COMMAND, cliBin -> CLI_BIN
  return key.replace(/([A-Z])/g, "_$1").toUpperCase();
}

/**
 * Additive `.gitignore` merge — append any missing entries under a `# Phoebe`
 * header, leaving existing lines untouched. An empty file becomes a bare list
 * (no header) because there's nothing else to distinguish it from.
 */
export function mergeGitignore(existing: string, entries: readonly string[]): string {
  const existingLines = new Set(
    existing
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );
  const missing = entries.filter((entry) => !existingLines.has(entry));
  if (missing.length === 0) {
    return existing;
  }
  if (existing.trim().length === 0) {
    return `${missing.join("\n")}\n`;
  }
  const separator = existing.endsWith("\n") ? "" : "\n";
  return `${existing}${separator}\n# Phoebe\n${missing.join("\n")}\n`;
}

export type InitReport = {
  /** New files written (destination paths, relative to the target dir). */
  created: string[];
  /** `.gitignore` entries appended in-place (destination paths). */
  updated: string[];
  /** Existing files left alone (destination paths). */
  skipped: string[];
};

/**
 * Walk up from this module's directory to find the shipped resource root. This
 * runs from `src/init.ts` (no build step) and reads `templates/…` + `prompts/…`
 * from the package root. Stops at a `node_modules` boundary so an installed dep
 * never resolves scaffold sources from the consuming repo. (Runtime `promptFiles`
 * loading is separate — see `resolvePromptFile` in `prompt.ts`, which reads
 * from the consumer runtime root.)
 */
function resolvePackageResource(relativePath: string, moduleDir: string): string {
  let dir = moduleDir;
  while (true) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir || basename(parent) === "node_modules") {
      throw new Error(
        `Could not find ${relativePath} within the Phoebe package (searched from ${moduleDir})`,
      );
    }
    dir = parent;
  }
}

export type RunInitOptions = {
  /** Directory the scaffolded files land under. Created if missing. */
  targetDir: string;
  /** Scaffold profile (flat | workspace | tenant). Default: flat. */
  profile?: InitProfile;
  /** Override any template params (repo/toolchain values, provider, `cliBin`). */
  params?: Partial<TemplateParams>;
  /** Root for shipped `templates/` and `prompts/` (test seam). Defaults to
   *  the walk-up from this module. */
  packageRoot?: string;
};

function readShippedFile(
  relPath: string,
  packageRoot: string | undefined,
  moduleDir: string,
): string {
  const absolute = packageRoot
    ? resolvePath(packageRoot, relPath)
    : resolvePackageResource(relPath, moduleDir);
  return readFileSync(absolute, "utf8");
}

/**
 * Read a shipped `templates/<relPath>` file verbatim (no substitution). Shares
 * the package-resource walk-up with `runInit` so `phoebe setup` renders the
 * exact same config template `init` writes — one template, two callers. Pass
 * `packageRoot` in tests to point at a fixture tree.
 */
export function readTemplate(templateRelPath: string, packageRoot?: string): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return readShippedFile(join("templates", templateRelPath), packageRoot, moduleDir);
}

/**
 * Execute the plan: create missing files, additively update `.gitignore`, and
 * leave every existing file alone. Returns a report so the CLI (and tests)
 * can render a summary without re-walking the filesystem.
 *
 * Not idempotent in the "produces the same output twice" sense — running init
 * twice on a directory the consumer has edited must not change their files.
 * That's the entire guarded-re-run contract. A second run into an empty
 * directory *does* reproduce the first-run output.
 */
export function runInit(opts: RunInitOptions): InitReport {
  const targetDir = resolvePath(opts.targetDir);
  const profile = opts.profile ?? "flat";
  if (profile === "tenant") {
    throw new Error("`phoebe init --tenant` uses initTenant(), not runInit().");
  }
  const params: TemplateParams = { ...DEFAULT_TEMPLATE_PARAMS, ...opts.params };
  const moduleDir = dirname(fileURLToPath(import.meta.url));

  mkdirSync(targetDir, { recursive: true });

  const report: InitReport = { created: [], updated: [], skipped: [] };

  for (const output of planInitOutputs(profile)) {
    const destAbs = join(targetDir, output.destRelPath);
    mkdirSync(dirname(destAbs), { recursive: true });

    if (output.source.kind === "gitignore") {
      const existing = existsSync(destAbs) ? readFileSync(destAbs, "utf8") : "";
      const merged = mergeGitignore(existing, output.source.entries);
      if (merged === existing) {
        report.skipped.push(output.destRelPath);
      } else if (existing.length === 0) {
        writeFileSync(destAbs, merged);
        report.created.push(output.destRelPath);
      } else {
        writeFileSync(destAbs, merged);
        report.updated.push(output.destRelPath);
      }
      continue;
    }

    if (existsSync(destAbs)) {
      report.skipped.push(output.destRelPath);
      continue;
    }

    if (output.source.kind === "template") {
      const rawTemplate = readShippedFile(
        join("templates", output.source.templateRelPath),
        opts.packageRoot,
        moduleDir,
      );
      const rendered = renderTemplate(rawTemplate, params);
      writeFileSync(destAbs, rendered);
    } else {
      // Shipped prompts ship verbatim — the engine's own render step handles
      // their `{{PLACEHOLDER}}` tokens at run time.
      const prompt = readShippedFile(output.source.promptRelPath, opts.packageRoot, moduleDir);
      writeFileSync(destAbs, prompt);
    }
    report.created.push(output.destRelPath);
  }

  return report;
}

/**
 * Read `origin` at scaffold time (`git -C <dir> remote get-url origin`).
 * Returns null when the remotes are missing/unreadable — not a fatal error;
 * `initTenant` falls back to placeholders the operator fills.
 */
export function readOriginRemoteUrl(dir: string, git: GitRunner = defaultGit): string | null {
  try {
    const url = git(["remote", "get-url", "origin"], { cwd: dir }).trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

export type InitTenantResult = InitReport & {
  /** Directory the in-tree install landed in. */
  tenantDir: string;
  /** Authoritative slug written into the config. */
  repoSlug: string;
  repoUrl: string;
};

export type InitTenantOptions = {
  /** Child checkout root (operator runs this after `git submodule add`). */
  targetDir: string;
  /** Explicit slug wins over origin-derived (#85 written form is authoritative). */
  repoSlug?: string;
  /** Explicit url wins over origin (and over defaultRepoUrl(slug)). */
  repoUrl?: string;
  installCommand?: string;
  checkCommand?: string;
  testCommand?: string;
  /** Opt-in seed of shipped prompts into `prompts/` (#63 pattern). */
  withPrompts?: boolean;
  /** Override prompt seeder (tests). Defaults to {@link copyShippedPromptsInto}. */
  seedPrompt?: (promptsDir: string) => string[];
  /** Git runner seam for origin prefill (tests). */
  git?: GitRunner;
};

/**
 * Scaffold a workspace child's in-tree Phoebe install at its repo root (#94).
 *
 * Layout (no `container/` — that is deployment-level, owned by the workspace
 * root): `phoebe.config.ts`, `.env.example`, `.gitignore` entry for `.env`.
 * Prefills `repoSlug`/`repoUrl` from the child's `origin` when present;
 * otherwise writes placeholders. Refuses if a root `phoebe.config.ts` already
 * exists (loud re-run, mirrors `add-repo`).
 */
export function initTenant(opts: InitTenantOptions): InitTenantResult {
  const tenantDir = resolvePath(opts.targetDir);
  const configPath = join(tenantDir, TENANT_CONFIG_FILE);
  if (existsSync(configPath)) {
    throw new Error(
      `Tenant install already exists at ${configPath}. ` +
        `Edit it in place, or delete it first — refusing to overwrite.`,
    );
  }

  mkdirSync(tenantDir, { recursive: true });

  const git = opts.git ?? defaultGit;
  // Scaffold-time one-shot origin read (#94). Distinct from the runtime
  // #86 supervisor origin checks. Explicit operator flags always win.
  const originUrl = readOriginRemoteUrl(tenantDir, git);
  const originSlug = originUrl !== null ? slugFromRemoteUrl(originUrl) : null;

  let repoSlug: string;
  if (opts.repoSlug !== undefined) {
    parseSlug(opts.repoSlug);
    repoSlug = opts.repoSlug;
  } else if (opts.repoUrl !== undefined) {
    repoSlug = slugFromRemoteUrl(opts.repoUrl) ?? TENANT_PLACEHOLDER_SLUG;
  } else if (originSlug !== null) {
    repoSlug = originSlug;
  } else {
    repoSlug = TENANT_PLACEHOLDER_SLUG;
  }

  let repoUrl: string;
  if (opts.repoUrl !== undefined) {
    repoUrl = opts.repoUrl;
  } else if (opts.repoSlug !== undefined) {
    repoUrl = defaultRepoUrl(opts.repoSlug);
  } else if (originUrl !== null) {
    repoUrl = originUrl;
  } else {
    repoUrl = TENANT_PLACEHOLDER_URL;
  }
  // Never persist or print credential-bearing URLs (#94): a tokenised origin or
  // `--url` would otherwise leak into the committed config and the init report.
  repoUrl = stripUrlCredentials(repoUrl);

  const report: InitReport = { created: [], updated: [], skipped: [] };

  writeFileSync(
    configPath,
    renderTenantConfig({
      repoSlug,
      repoUrl,
      installCommand: opts.installCommand ?? "npm ci",
      checkCommand: opts.checkCommand ?? "npm run check",
      testCommand: opts.testCommand ?? "npm test",
    }),
  );
  report.created.push(TENANT_CONFIG_FILE);

  const envExamplePath = join(tenantDir, `${TENANT_ENV_FILE}.example`);
  writeFileSync(envExamplePath, TENANT_ENV_EXAMPLE);
  report.created.push(`${TENANT_ENV_FILE}.example`);

  const gitignorePath = join(tenantDir, ".gitignore");
  const existingGitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const merged = mergeGitignore(existingGitignore, TENANT_GITIGNORE_ENTRIES);
  if (merged !== existingGitignore) {
    writeFileSync(gitignorePath, merged);
    report[existingGitignore.length === 0 ? "created" : "updated"].push(".gitignore");
  } else {
    report.skipped.push(".gitignore");
  }

  if (opts.withPrompts) {
    const seed = opts.seedPrompt ?? ((dir: string) => copyShippedPromptsInto(dir));
    for (const abs of seed(join(tenantDir, "prompts"))) {
      // Report as relative `prompts/<name>` under the tenant dir.
      report.created.push(abs.startsWith(tenantDir) ? abs.slice(tenantDir.length + 1) : abs);
    }
  }

  return { ...report, tenantDir, repoSlug, repoUrl };
}

/**
 * Copy the shipped default prompts into a `prompts/` dir (for
 * `add-repo --with-prompts`, #63). Each shipped `prompts/<name>.md` lands as
 * `<promptsDir>/<name>.md`, where the engine resolves a tenant's override from
 * its cwd. Returns the written paths. Reuses the same package-resource resolver
 * as `runInit`, so an installed dep still finds the shipped prompts.
 */
export function copyShippedPromptsInto(
  promptsDir: string,
  opts: { packageRoot?: string; moduleDir?: string } = {},
): string[] {
  const moduleDir = opts.moduleDir ?? dirname(fileURLToPath(import.meta.url));
  mkdirSync(promptsDir, { recursive: true });
  const written: string[] = [];
  for (const relPath of Object.values(DEFAULT_RESOLVED_CONFIG.promptFiles)) {
    const content = readShippedFile(relPath, opts.packageRoot, moduleDir);
    const dest = join(promptsDir, basename(relPath));
    writeFileSync(dest, content);
    written.push(dest);
  }
  return written;
}

/** Human-readable summary suitable for the CLI to stdout after init runs. */
export function formatInitReport(report: InitReport, targetDir: string): string {
  const lines = [`[phoebe] init → ${targetDir}`];
  const emit = (label: string, paths: readonly string[]): void => {
    if (paths.length === 0) return;
    lines.push(`  ${label}:`);
    for (const path of paths) {
      lines.push(`    ${path}`);
    }
  };
  emit("created", report.created);
  emit("updated", report.updated);
  emit("skipped (already present)", report.skipped);
  if (report.skipped.length > 0) {
    lines.push("");
    lines.push("Existing files were left untouched. Delete them and re-run init to regenerate.");
  }
  return `${lines.join("\n")}\n`;
}
