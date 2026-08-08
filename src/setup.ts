// `phoebe setup` — the interactive one-stop wizard that takes a repo from
// nothing to a ready-to-run Phoebe in a single command. It runs `init`'s
// scaffolding first (guarded, never-clobber), then walks the user through a
// short Q&A and writes a complete `phoebe.config.ts` and a filled `.env`, so
// there is no hand-editing between `setup` and `docker compose up`.
//
// `init` stays the bare, non-interactive scaffolding primitive; `setup` builds
// on top of it and owns exactly two files: `phoebe.config.ts` and `.env`.
//
// The module splits pure logic (git-remote parsing, .env round-tripping,
// config-value extraction, validation, summary rendering) from the thin I/O
// shell (`runSetup`). The shell drives an injectable `Prompter`, so the wizard
// order, re-prompt loop, and confirm gate unit-test against a scripted prompter
// with no terminal in the loop — the same injected-seam pattern `init.ts` and
// `cli.ts` use.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { CONFIG_DEFAULTS, PROVIDER_NAMES, type ProviderName } from "./config-schema.ts";
import { parseDotenv } from "./dotenv.ts";
import {
  DEFAULT_TEMPLATE_PARAMS,
  formatInitReport,
  readTemplate,
  renderTemplate,
  runInit,
} from "./init.ts";

// The generic placeholders `init` renders. When a prior config still carries
// one of these, we treat it as "no real value" so a detected git remote wins.
const PLACEHOLDER_SLUG = DEFAULT_TEMPLATE_PARAMS.repoSlug;
const PLACEHOLDER_URL = DEFAULT_TEMPLATE_PARAMS.repoUrl;

// Provider picker order (the headline choice). Deliberately `claude, cursor,
// codex` regardless of `PROVIDER_NAMES`' internal order.
const PROVIDER_ORDER = ["claude", "cursor", "codex"] as const satisfies readonly ProviderName[];

const GH_TOKEN_LINK = "https://github.com/settings/tokens";

// Key-creation links shown beside each secret prompt (verified 2026-07-31),
// keyed by the env var the provider reads.
const KEY_LINKS: Record<string, string> = {
  ANTHROPIC_API_KEY: "https://console.anthropic.com/settings/keys",
  CURSOR_API_KEY: "https://cursor.com/dashboard (Settings → Integrations → API Keys)",
  OPENAI_KEY: "https://platform.openai.com/api-keys",
};

const NEXT_STEPS = `  cd container
  docker compose --env-file ../.env build
  docker compose --env-file ../.env run --rm phoebe --dry-run --run-once
  docker compose --env-file ../.env up -d
`;

export const SETUP_HELP_TEXT = `phoebe setup — interactive one-stop setup wizard

Usage:
  phoebe setup [dir]

Scaffolds the consumer runtime (everything \`phoebe init\` writes), then walks you
through a short Q&A and writes a complete phoebe.config.ts and a filled .env into
[dir] (default: current directory). Pick your AI provider, drop in your tokens,
and go straight to \`docker compose build\`.

Requires an interactive terminal. For non-interactive scaffolding with
placeholder values, use \`phoebe init\` instead.
`;

// --- Pure helpers -----------------------------------------------------------

export type ParsedSetupArgs = { targetDir: string; help: boolean };

/**
 * Parse argv left after the leading `setup` token. Mirrors `phoebe init`:
 * an optional positional target directory plus `--help`; unknown flags and a
 * second positional are rejected loudly.
 */
export function parseSetupArgs(argv: readonly string[]): ParsedSetupArgs {
  let targetDir: string | undefined;
  let help = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag \`${arg}\` for \`phoebe setup\`. See \`phoebe setup --help\`.`);
    }
    if (targetDir !== undefined) {
      throw new Error(
        `\`phoebe setup\` takes at most one target directory (got \`${targetDir}\` and \`${arg}\`).`,
      );
    }
    targetDir = arg;
  }
  return { targetDir: targetDir ?? ".", help };
}

export type GitRemote = { repoSlug: string; repoUrl: string };

/**
 * Derive `owner/repo` and an HTTPS clone URL from a `git remote get-url origin`
 * value. Handles scp-style (`git@github.com:owner/repo.git`), `ssh://`, and
 * `https://` forms. Returns undefined when the value is not a recognizable
 * `owner/repo` remote.
 */
export function parseGitRemote(raw: string): GitRemote | undefined {
  const url = raw.trim();
  const build = (host: string, path: string): GitRemote | undefined => {
    const slug = path.replace(/\.git$/, "").replace(/\/+$/, "");
    if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) return undefined;
    return { repoSlug: slug, repoUrl: `https://${host}/${slug}.git` };
  };
  const scp = /^[^@\s]+@([^:/\s]+):(.+)$/.exec(url);
  if (scp) return build(scp[1], scp[2]);
  const proto = /^(?:ssh|https?):\/\/(?:[^@/]+@)?([^/\s]+)\/(.+)$/.exec(url);
  if (proto) return build(proto[1], proto[2]);
  return undefined;
}

/** Config fields the wizard can pre-fill from an existing `phoebe.config.ts`. */
export type ConfigValues = Partial<
  Record<
    "repoSlug" | "repoUrl" | "installCommand" | "checkCommand" | "testCommand" | "defaultProvider",
    string
  >
>;

/**
 * Pull the wizard's fields out of a `phoebe.config.ts` by matching each
 * `field: "value"` string literal. `setup` wrote this file from the shipped
 * template, so the shape is predictable — a regex read avoids importing
 * (and thus executing) a consumer module just to reconfigure.
 */
export function extractConfigValues(text: string): ConfigValues {
  const fields = [
    "repoSlug",
    "repoUrl",
    "installCommand",
    "checkCommand",
    "testCommand",
    "defaultProvider",
  ] as const;
  const out: ConfigValues = {};
  for (const field of fields) {
    const match = new RegExp(`\\b${field}\\s*:\\s*["'\`]([^"'\`]*)["'\`]`).exec(text);
    if (match) out[field] = match[1];
  }
  return out;
}

/** Repo slug must look like `owner/repo`. Returns an error message or undefined. */
export function validateRepoSlug(value: string): string | undefined {
  return /^[^/\s]+\/[^/\s]+$/.test(value.trim())
    ? undefined
    : `Expected owner/repo (e.g. acme/widget), got "${value}".`;
}

/** Build a non-empty validator for a labelled field. */
export function validateNonEmpty(label: string): (value: string) => string | undefined {
  return (value: string) => (value.trim().length > 0 ? undefined : `${label} must not be empty.`);
}

/** Mask a secret for display: never reveal length or characters. */
export function maskSecret(value: string): string {
  return value.trim() === "" ? "(blank)" : "••••••••";
}

export type SetupAnswers = {
  repoSlug: string;
  repoUrl: string;
  installCommand: string;
  checkCommand: string;
  testCommand: string;
  provider: ProviderName;
  model: string;
  ghToken: string;
  providerEnvVar: string;
  providerKey: string;
};

/** The confirm-gate summary lines, with both secrets masked. */
export function summaryLines(answers: SetupAnswers): string[] {
  return [
    `repoSlug        ${answers.repoSlug}`,
    `repoUrl         ${answers.repoUrl}`,
    `installCommand  ${answers.installCommand}`,
    `checkCommand    ${answers.checkCommand}`,
    `testCommand     ${answers.testCommand}`,
    `defaultProvider ${answers.provider} (model: ${answers.model})`,
    `GH_TOKEN        ${maskSecret(answers.ghToken)}`,
    `${answers.providerEnvVar.padEnd(15)} ${maskSecret(answers.providerKey)}`,
  ];
}

/**
 * Round-trip the shipped `.env.example` into a real `.env`: fill `GH_TOKEN` and
 * the chosen provider's key, and leave every other line — the other provider
 * keys, the commented runtime toggles, the comments — exactly as shipped. Blank
 * values are written as-is (fill-in-later is allowed by design).
 */
export function renderEnv(
  exampleText: string,
  fill: { ghToken: string; providerEnvVar: string; providerKey: string },
): string {
  const setKey = (text: string, key: string, value: string): string =>
    text
      .split("\n")
      .map((line) => (new RegExp(`^${key}=`).test(line) ? `${key}=${value}` : line))
      .join("\n");
  let out = setKey(exampleText, "GH_TOKEN", fill.ghToken);
  out = setKey(out, fill.providerEnvVar, fill.providerKey);
  return out;
}

function isProviderName(value: string | undefined): value is ProviderName {
  return value !== undefined && (PROVIDER_NAMES as readonly string[]).includes(value);
}

function nonPlaceholder(value: string | undefined, placeholder: string): string | undefined {
  return value !== undefined && value !== placeholder ? value : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

// --- Prompter (thin I/O shell) ---------------------------------------------

export type PromptIO = {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
};

/**
 * The four terminal interactions the wizard needs. Single-shot: validation and
 * re-prompting for text fields live in `runSetup` so they test against a
 * scripted prompter; `pick`/`confirm` re-prompt internally on a malformed
 * answer since that check is intrinsic to the widget.
 */
export interface Prompter {
  text(question: string, opts?: { default?: string }): Promise<string>;
  secret(question: string, opts?: { default?: string }): Promise<string>;
  pick(
    question: string,
    choices: readonly string[],
    opts: { defaultIndex: number },
  ): Promise<number>;
  confirm(question: string, opts: { defaultYes: boolean }): Promise<boolean>;
  close(): void;
}

/**
 * A `Prompter` over real streams. Masking is done by muting the output while
 * the secret is typed: the prompt is written unmuted, then echo is suppressed
 * until Enter (the same muted-output trick the Node readline docs use). No
 * masking logic runs in unit tests, which inject a scripted prompter instead.
 */
export function createReadlinePrompter(io: PromptIO): Prompter {
  let muted = false;
  const gate = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) io.output.write(chunk as Buffer);
      cb();
    },
  });
  const rl = createInterface({ input: io.input, output: gate, terminal: true });

  const withDefault = (raw: string, def: string): string => {
    const trimmed = raw.trim();
    return trimmed === "" ? def : trimmed;
  };

  return {
    async text(question, opts) {
      const def = opts?.default ?? "";
      const suffix = def ? ` [${def}]` : "";
      return withDefault(await rl.question(`${question}${suffix}: `), def);
    },
    async secret(question, opts) {
      const def = opts?.default ?? "";
      const suffix = def ? ` [${maskSecret(def)}]` : "";
      muted = false;
      const pending = rl.question(`${question}${suffix}: `);
      muted = true;
      const raw = await pending;
      muted = false;
      io.output.write("\n"); // the Enter keystroke's echo was muted
      return withDefault(raw, def);
    },
    async pick(question, choices, opts) {
      io.output.write(`${question}\n`);
      choices.forEach((choice, i) => io.output.write(`  ${i + 1}) ${choice}\n`));
      for (;;) {
        const raw = (await rl.question(`  Choice [${opts.defaultIndex + 1}]: `)).trim();
        if (raw === "") return opts.defaultIndex;
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 1 && n <= choices.length) return n - 1;
        io.output.write(`  Enter a number between 1 and ${choices.length}.\n`);
      }
    },
    async confirm(question, opts) {
      const hint = opts.defaultYes ? "Y/n" : "y/N";
      for (;;) {
        const raw = (await rl.question(`${question} (${hint}) `)).trim().toLowerCase();
        if (raw === "") return opts.defaultYes;
        if (raw === "y" || raw === "yes") return true;
        if (raw === "n" || raw === "no") return false;
        io.output.write("  Please answer y or n.\n");
      }
    },
    close() {
      rl.close();
    },
  };
}

// --- Orchestration ----------------------------------------------------------

export type SetupHooks = {
  /** `git remote get-url origin`, or undefined when unavailable. */
  gitRemoteUrl?: () => string | undefined;
  /** `gh auth token`, or undefined when `gh` is absent/unauthenticated. */
  ghAuthToken?: () => string | undefined;
};

export type RunSetupOptions = {
  /** Directory the scaffolded + configured runtime lands under. */
  targetDir: string;
  io?: PromptIO;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Injected prompter (tests). When omitted, a readline prompter over `io` is
   *  built and a TTY is required. */
  prompter?: Prompter;
  /** Injected git/gh probes (tests). Defaults shell out from `cwd`. */
  hooks?: SetupHooks;
  /** Root for shipped `templates/` + `prompts/` (test seam), forwarded to init. */
  packageRoot?: string;
};

function defaultHooks(cwd: string): Required<SetupHooks> {
  const tryExec = (cmd: string, args: string[]): string | undefined => {
    try {
      const out = execFileSync(cmd, args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out.length > 0 ? out : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    gitRemoteUrl: () => tryExec("git", ["remote", "get-url", "origin"]),
    ghAuthToken: () => tryExec("gh", ["auth", "token"]),
  };
}

function safe(fn: (() => string | undefined) | undefined): string | undefined {
  if (!fn) return undefined;
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * Drive the wizard end to end: guard for a TTY, scaffold via `init`, gather
 * defaults (existing files → git remote / gh → generics), prompt, show a
 * secrets-masked summary behind a single confirm gate, then write
 * `phoebe.config.ts` and `.env` and print copy-pasteable next steps. Nothing
 * the wizard owns is written until the user approves.
 */
export async function runSetup(opts: RunSetupOptions): Promise<void> {
  const io: PromptIO = opts.io ?? { input: process.stdin, output: process.stdout };
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const targetDir = resolvePath(cwd, opts.targetDir);
  const hooks = opts.hooks ?? defaultHooks(cwd);
  const write = (text: string): void => void io.output.write(text);

  let prompter = opts.prompter;
  if (!prompter) {
    if (!io.input.isTTY) {
      throw new Error(
        "`phoebe setup` is interactive and needs a terminal. For non-interactive " +
          "scaffolding with placeholder values, run `phoebe init` instead.",
      );
    }
    prompter = createReadlinePrompter(io);
  }
  const ownsPrompter = opts.prompter === undefined;

  try {
    // Pre-fill context is read *before* init so we prefer a genuinely
    // pre-existing config over the placeholder init is about to (re)write.
    const configText = readIfExists(join(targetDir, "phoebe.config.ts"));
    const existing = configText ? extractConfigValues(configText) : {};
    const existingEnvText = readIfExists(join(targetDir, ".env"));
    const existingEnv = parseDotenv(existingEnvText ?? "");

    write("Scaffolding the consumer runtime…\n");
    const report = runInit({ targetDir, packageRoot: opts.packageRoot });
    write(formatInitReport(report, targetDir));

    const remote = safe(hooks.gitRemoteUrl);
    const parsedRemote = remote ? parseGitRemote(remote) : undefined;

    const repoSlugDefault =
      nonPlaceholder(existing.repoSlug, PLACEHOLDER_SLUG) ??
      parsedRemote?.repoSlug ??
      PLACEHOLDER_SLUG;
    const repoUrlDefault =
      nonPlaceholder(existing.repoUrl, PLACEHOLDER_URL) ?? parsedRemote?.repoUrl ?? PLACEHOLDER_URL;

    write("\nRepository\n");
    const repoSlug = await promptValid(
      prompter,
      io,
      "  GitHub repo (owner/repo)",
      repoSlugDefault,
      validateRepoSlug,
    );
    const repoUrl = await prompter.text("  Clone URL", { default: repoUrlDefault });

    write("\nToolchain commands\n");
    const installCommand = await promptValid(
      prompter,
      io,
      "  Install command",
      existing.installCommand ?? DEFAULT_TEMPLATE_PARAMS.installCommand,
      validateNonEmpty("Install command"),
    );
    const checkCommand = await promptValid(
      prompter,
      io,
      "  Check command",
      existing.checkCommand ?? DEFAULT_TEMPLATE_PARAMS.checkCommand,
      validateNonEmpty("Check command"),
    );
    const testCommand = await promptValid(
      prompter,
      io,
      "  Test command",
      existing.testCommand ?? DEFAULT_TEMPLATE_PARAMS.testCommand,
      validateNonEmpty("Test command"),
    );

    write("\nAI provider\n");
    const providerDefault = isProviderName(existing.defaultProvider)
      ? existing.defaultProvider
      : CONFIG_DEFAULTS.defaultProvider;
    const defaultIndex = Math.max(0, PROVIDER_ORDER.indexOf(providerDefault));
    const providerIndex = await prompter.pick(
      "  Which agent CLI should Phoebe run by default?",
      PROVIDER_ORDER,
      { defaultIndex },
    );
    const provider = PROVIDER_ORDER[providerIndex];
    const model = CONFIG_DEFAULTS.defaultModels[provider];
    write(`  → ${provider} runs model ${model} by default (override with PHOEBE_MODEL).\n`);

    const providerEnvVar = CONFIG_DEFAULTS.providerEnv[provider];

    write("\nSecrets (blank is OK — fill them into .env later)\n");
    write(`  GH_TOKEN — create one at ${GH_TOKEN_LINK}\n`);
    const ghToken = await prompter.secret("  GH_TOKEN", {
      default:
        nonEmpty(existingEnv["GH_TOKEN"]) ??
        nonEmpty(env["GH_TOKEN"]) ??
        safe(hooks.ghAuthToken) ??
        "",
    });
    write(
      `  ${providerEnvVar} — create one at ${KEY_LINKS[providerEnvVar] ?? "your provider's dashboard"}\n`,
    );
    const providerKey = await prompter.secret(`  ${providerEnvVar}`, {
      default: nonEmpty(existingEnv[providerEnvVar]) ?? nonEmpty(env[providerEnvVar]) ?? "",
    });

    const answers: SetupAnswers = {
      repoSlug,
      repoUrl,
      installCommand,
      checkCommand,
      testCommand,
      provider,
      model,
      ghToken,
      providerEnvVar,
      providerKey,
    };

    write("\nSummary\n");
    for (const line of summaryLines(answers)) write(`  ${line}\n`);

    const approved = await prompter.confirm("\nWrite phoebe.config.ts and .env?", {
      defaultYes: true,
    });
    if (!approved) {
      write("Aborted — phoebe.config.ts and .env were not written.\n");
      return;
    }

    const rendered = renderTemplate(readTemplate("phoebe.config.ts", opts.packageRoot), {
      repoSlug,
      repoUrl,
      installCommand,
      checkCommand,
      testCommand,
      defaultProvider: provider,
      cliBin: DEFAULT_TEMPLATE_PARAMS.cliBin,
    });
    writeFileSync(join(targetDir, "phoebe.config.ts"), rendered);

    // Reconcile onto the existing `.env` when re-running so a key the user set
    // by hand for a non-selected provider survives an Enter-through re-run;
    // fall back to the freshly-scaffolded `.env.example` on a first run.
    const envBase = existingEnvText ?? readFileSync(join(targetDir, ".env.example"), "utf8");
    writeFileSync(
      join(targetDir, ".env"),
      renderEnv(envBase, { ghToken, providerEnvVar, providerKey }),
    );

    write("\nWrote phoebe.config.ts and .env.\n\nNext steps:\n");
    write(NEXT_STEPS);
  } finally {
    if (ownsPrompter) prompter.close();
  }
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Prompt until the answer passes `validate`, echoing the error between tries. */
async function promptValid(
  prompter: Prompter,
  io: PromptIO,
  question: string,
  def: string,
  validate: (value: string) => string | undefined,
): Promise<string> {
  for (;;) {
    const value = await prompter.text(question, { default: def });
    const error = validate(value);
    if (!error) return value;
    io.output.write(`  ✗ ${error}\n`);
  }
}
