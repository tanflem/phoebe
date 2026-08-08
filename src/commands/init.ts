// `phoebe init` — scaffold a consumer-owned runtime. Argv parsing (#73) lives
// here; the scaffolding itself is `../init.ts`.

import type { ArgSpec } from "../arg-spec.ts";
import { parseArgs } from "../arg-spec.ts";
import {
  copyShippedPromptsInto,
  formatInitReport,
  initTenant,
  runInit,
  type InitProfile,
} from "../init.ts";
import type { Command } from "./types.ts";

export type ParsedInitArgs = {
  targetDir: string;
  help: boolean;
  /**
   * Scaffold profile. Default `flat` (today's single-tenant layout).
   * `--workspace` and `--tenant` are mutually exclusive (#93/#94).
   */
  profile: InitProfile;
  /** Tenant profile: explicit slug override (wins over origin prefill). */
  repoSlug?: string;
  /** Tenant profile: explicit url override (wins over origin prefill). */
  repoUrl?: string;
  /** Tenant profile: opt-in seed of shipped prompts. */
  withPrompts: boolean;
};

const SLUG_VALUE_ERROR = "`--slug` requires an `owner/repo` value.";
const URL_VALUE_ERROR = "`--url` requires a git remote URL value.";

const INIT_SPEC: ArgSpec = {
  booleanFlags: ["help", "workspace", "tenant", "with-prompts"],
  valueFlags: ["slug", "url"],
  aliases: { h: "help" },
  maxPositionals: 1,
  unknownFlag: (arg) => `Unknown flag \`${arg}\` for \`phoebe init\`. See \`phoebe init --help\`.`,
  missingValue: (arg) => (arg.startsWith("--slug") ? SLUG_VALUE_ERROR : URL_VALUE_ERROR),
  tooManyPositionals: (first, extra) =>
    `\`phoebe init\` takes at most one target directory (got \`${first}\` and \`${extra}\`).`,
};

/**
 * Parse argv left after the leading `init` token has been consumed. Supports
 * an optional positional target directory (`phoebe init ./my-agent`), the
 * mutually exclusive profile flags `--workspace` / `--tenant`, tenant-only
 * overrides (`--slug`, `--url`, `--with-prompts`), and `--help`. Extra flags
 * are rejected loudly so a typo like `--forcee` fails fast instead of being
 * silently ignored.
 */
export function parseInitArgs(argv: readonly string[]): ParsedInitArgs {
  const parsed = parseArgs(argv, INIT_SPEC);

  // Which flags were written, in order, decides the message — re-scan the
  // raw argv rather than tracking occurrence order through the generic
  // tokenizer. A repeated occurrence of the *same* profile flag is also
  // rejected (matches the original single-pass parser).
  const profileFlags = argv.filter((arg) => arg === "--workspace" || arg === "--tenant");
  if (profileFlags.length > 1) {
    throw new Error(
      `\`phoebe init\` flags \`--workspace\` and \`--tenant\` are mutually exclusive ` +
        `(got both \`${profileFlags[0]}\` and \`${profileFlags[1]}\`).`,
    );
  }

  // `valueFlags` always resolve to a string (or throw); the cast just tells
  // TypeScript what the tokenizer's generic `string | true` can't.
  const rawSlug = parsed.flags["slug"];
  const slug = typeof rawSlug === "string" ? rawSlug : undefined;
  if (slug !== undefined && (slug.length === 0 || slug.startsWith("-"))) {
    throw new Error(SLUG_VALUE_ERROR);
  }
  const rawUrl = parsed.flags["url"];
  const url = typeof rawUrl === "string" ? rawUrl : undefined;
  if (url !== undefined && (url.length === 0 || url.startsWith("-"))) {
    throw new Error(URL_VALUE_ERROR);
  }

  const profile: InitProfile =
    parsed.flags["tenant"] === true
      ? "tenant"
      : parsed.flags["workspace"] === true
        ? "workspace"
        : "flat";
  const withPrompts = parsed.flags["with-prompts"] === true;

  if ((slug !== undefined || url !== undefined || withPrompts) && profile !== "tenant") {
    throw new Error(
      `\`--slug\`, \`--url\`, and \`--with-prompts\` are only valid with \`phoebe init --tenant\`.`,
    );
  }

  return {
    targetDir: parsed.positionals[0] ?? ".",
    help: parsed.flags["help"] === true,
    profile,
    ...(slug !== undefined ? { repoSlug: slug } : {}),
    ...(url !== undefined ? { repoUrl: url } : {}),
    withPrompts,
  };
}

export const INIT_HELP_TEXT = `phoebe init — scaffold a consumer-owned runtime

Usage:
  phoebe init [dir]                 Flat single-tenant deployment (default)
  phoebe init --workspace [dir]     Workspace root (engine + workspace block)
  phoebe init --tenant [dir]        Workspace child in-tree install
                                    [--slug owner/repo] [--url <git-url>] [--with-prompts]

Profiles (mutually exclusive; default is flat):

  flat (default) writes into [dir]:
    phoebe.config.ts             Consumer config starter (five required fields + engine)
    prompts/                     Copies of the shipped agent prompts (edit to override)
    .env.example                 Documented environment variables to copy to .env
    .gitignore                   Additive — .env, repos/**/.env, node_modules/
    container/Dockerfile         Runtime image (Node 24 + git + gh, entrypoint: phoebe boot)
    container/compose.yml        Compose config for the long-lived boot container
    container/compose.local.yml  Dev overlay to run an engine checkout from your host

  --workspace writes into [dir]:
    phoebe.config.ts             engine + workspace: { depth: 1 } only (no per-repo fields)
    .env.example                 Deployment secrets (GH_TOKEN, provider keys) — no tenant secrets
    .gitignore                   Additive — .env, node_modules/
    container/                   Same #57 templates as flat, plus README.md mount docs
    (no prompts/, no child files — link children then run init --tenant)

  --tenant writes a child's in-tree install (after \`git submodule add\`):
    phoebe.config.ts             Per-tenant config (no engine; repoSlug authoritative)
    .env.example                 Per-tenant secrets template (copy to .env)
    .gitignore                   Additive — .env
    prompts/                     Only with --with-prompts
    (no container/ — deployment-level, owned by the workspace root)

    Prefills repoSlug/repoUrl from the child's \`origin\` remote; --slug/--url win.
    Absent origin → placeholder slug/url the operator fills. Re-run refuses if config exists.

Flat/workspace: existing files are left untouched. Tenant: refuses to overwrite.
`;

export const initCommand: Command = {
  name: "init",
  summary: "phoebe init [dir]                Scaffold a flat single-tenant deployment",
  help: INIT_HELP_TEXT,
  async run(argv, ctx) {
    const parsed = parseInitArgs(argv);
    if (parsed.help) {
      ctx.stdout.write(INIT_HELP_TEXT);
      return 0;
    }

    if (parsed.profile === "tenant") {
      const result = initTenant({
        targetDir: parsed.targetDir,
        ...(parsed.repoSlug !== undefined ? { repoSlug: parsed.repoSlug } : {}),
        ...(parsed.repoUrl !== undefined ? { repoUrl: parsed.repoUrl } : {}),
        withPrompts: parsed.withPrompts,
        ...(parsed.withPrompts ? { seedPrompt: (dir: string) => copyShippedPromptsInto(dir) } : {}),
      });
      ctx.stdout.write(
        formatInitReport(result, parsed.targetDir) +
          `  repoSlug: ${result.repoSlug}\n` +
          `  repoUrl:  ${result.repoUrl}\n` +
          `\nFill in ${result.tenantDir}/.env (copy .env.example). ` +
          `Workspace discovery picks this child up on the next boot poll.\n`,
      );
      return 0;
    }

    const report = runInit({ targetDir: parsed.targetDir, profile: parsed.profile });
    ctx.stdout.write(formatInitReport(report, parsed.targetDir));
    return 0;
  },
};
