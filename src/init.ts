// `phoebe init` scaffolder. Given a target directory, drops the consumer-owned
// runtime into place: `phoebe.config.ts`, a `prompts/` dir with copies of the
// shipped defaults (edit-and-commit), `.env.example`, `.gitignore` entries,
// and the `container/` templates (Dockerfile, compose, and a dev-only overlay
// for running a local engine checkout). Re-runs are guarded — an existing file
// is skipped, not silently overwritten, so consumer edits are safe.
//
// The plan/render split keeps the pure logic (what files, what placeholders)
// separately testable from the fs I/O in `runInit`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DEFAULTS } from "./config-schema.ts";

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
  defaultProvider: CONFIG_DEFAULTS.defaultProvider,
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

const GITIGNORE_ENTRIES = [".env", "node_modules/"] as const;

/**
 * Enumerate every file init will produce. The prompt list is derived from
 * `CONFIG_DEFAULTS.promptFiles` so adding a new prompt kind to the engine
 * automatically gets scaffolded — no drift between the two lists.
 */
export function planInitOutputs(): PlannedOutput[] {
  const promptOutputs: PlannedOutput[] = Object.values(CONFIG_DEFAULTS.promptFiles).map(
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
    ...promptOutputs,
    {
      destRelPath: ".gitignore",
      source: { kind: "gitignore", entries: GITIGNORE_ENTRIES },
    },
  ];
}

/**
 * Substitute `{{KEY}}` tokens with the matching value. Unknown tokens throw
 * so a typo in a template surfaces during tests rather than silently landing
 * in a consumer's repo. Iteration is over the params (not a regex over the
 * source) so a value that happens to contain a `{{…}}`-shaped substring is
 * never re-scanned.
 */
export function renderTemplate(source: string, params: TemplateParams): string {
  let rendered = source;
  for (const [key, value] of Object.entries(params) as Array<[keyof TemplateParams, string]>) {
    const token = `{{${keyToToken(key)}}}`;
    rendered = rendered.split(token).join(value);
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
  const params: TemplateParams = { ...DEFAULT_TEMPLATE_PARAMS, ...opts.params };
  const moduleDir = dirname(fileURLToPath(import.meta.url));

  mkdirSync(targetDir, { recursive: true });

  const report: InitReport = { created: [], updated: [], skipped: [] };

  for (const output of planInitOutputs()) {
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
