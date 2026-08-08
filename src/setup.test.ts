// `phoebe setup` wizard contract:
//   * pure helpers (arg parse, git-remote parse, .env round-trip, config-value
//     extraction, validation, secret masking) are exhaustively unit-tested,
//   * `runSetup` orchestration (prompt order, re-prompt, default derivation,
//     confirm gate, file writes, TTY guard) is tested against a scripted
//     prompter — no terminal in the loop,
//   * the real readline prompter is tested over string streams, including that
//     a typed secret never reaches the output.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { DEFAULT_RESOLVED_CONFIG } from "./init.ts";
import {
  createReadlinePrompter,
  extractConfigValues,
  maskSecret,
  parseGitRemote,
  type Prompter,
  renderEnv,
  runSetup,
  summaryLines,
  validateNonEmpty,
  validateRepoSlug,
} from "./setup.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "phoebe-setup-test-"));
}

function capture(): { output: Writable; text: () => string } {
  let buf = "";
  const output = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { output, text: () => buf };
}

// --- Pure helpers -----------------------------------------------------------

describe("parseGitRemote", () => {
  test("parses scp-style SSH remotes", () => {
    expect(parseGitRemote("git@github.com:acme/widget.git")).toEqual({
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
    });
  });
  test("parses https remotes with and without .git", () => {
    expect(parseGitRemote("https://github.com/acme/widget.git")).toEqual({
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
    });
    expect(parseGitRemote("https://github.com/acme/widget")).toEqual({
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
    });
  });
  test("parses ssh:// URLs and preserves a non-github host", () => {
    expect(parseGitRemote("ssh://git@gitlab.example.com/team/repo.git")).toEqual({
      repoSlug: "team/repo",
      repoUrl: "https://gitlab.example.com/team/repo.git",
    });
  });
  test("returns undefined for values that are not owner/repo remotes", () => {
    expect(parseGitRemote("")).toBeUndefined();
    expect(parseGitRemote("not a url")).toBeUndefined();
    expect(parseGitRemote("https://github.com/justowner")).toBeUndefined();
  });
});

describe("extractConfigValues", () => {
  test("pulls the wizard fields out of a config file", () => {
    const config = `const config = {
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
      installCommand: "pnpm i",
      checkCommand: "pnpm check",
      testCommand: "pnpm test",
      defaultProvider: "claude",
    };`;
    expect(extractConfigValues(config)).toEqual({
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
      installCommand: "pnpm i",
      checkCommand: "pnpm check",
      testCommand: "pnpm test",
      defaultProvider: "claude",
    });
  });
  test("omits fields that are absent", () => {
    expect(extractConfigValues(`{ repoSlug: "a/b" }`)).toEqual({ repoSlug: "a/b" });
  });
});

describe("validators", () => {
  test("validateRepoSlug accepts owner/repo and rejects the rest", () => {
    expect(validateRepoSlug("acme/widget")).toBeUndefined();
    expect(validateRepoSlug("nope")).toMatch(/owner\/repo/);
    expect(validateRepoSlug("a/b/c")).toMatch(/owner\/repo/);
    expect(validateRepoSlug("has space/repo")).toMatch(/owner\/repo/);
  });
  test("validateNonEmpty rejects blank", () => {
    const v = validateNonEmpty("Install command");
    expect(v("npm ci")).toBeUndefined();
    expect(v("   ")).toMatch(/must not be empty/);
  });
});

describe("maskSecret", () => {
  test("hides any non-empty value and names blanks", () => {
    expect(maskSecret("super-secret-token")).toBe("••••••••");
    expect(maskSecret("x")).toBe("••••••••");
    expect(maskSecret("")).toBe("(blank)");
    expect(maskSecret("   ")).toBe("(blank)");
  });
});

describe("renderEnv", () => {
  test("fills GH_TOKEN and the chosen provider key, leaves everything else", () => {
    const example = [
      "# header",
      "GH_TOKEN=",
      "ANTHROPIC_API_KEY=",
      "CURSOR_API_KEY=",
      "OPENAI_KEY=",
      "# PHOEBE_AGENT=claude",
    ].join("\n");
    const out = renderEnv(example, {
      ghToken: "ght",
      providerEnvVar: "ANTHROPIC_API_KEY",
      providerKey: "antk",
    });
    expect(out).toContain("GH_TOKEN=ght");
    expect(out).toContain("ANTHROPIC_API_KEY=antk");
    expect(out).toContain("CURSOR_API_KEY=\n");
    expect(out).toContain("OPENAI_KEY=");
    // The commented toggle is untouched (not filled).
    expect(out).toContain("# PHOEBE_AGENT=claude");
    expect(out).toContain("# header");
  });
  test("blank values are written as-is", () => {
    const out = renderEnv("GH_TOKEN=\nCURSOR_API_KEY=", {
      ghToken: "",
      providerEnvVar: "CURSOR_API_KEY",
      providerKey: "",
    });
    expect(out).toBe("GH_TOKEN=\nCURSOR_API_KEY=");
  });
});

describe("summaryLines", () => {
  test("masks both secrets", () => {
    const lines = summaryLines({
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
      installCommand: "npm ci",
      checkCommand: "npm run check",
      testCommand: "npm test",
      provider: "claude",
      model: "claude-sonnet-4-6",
      ghToken: "ghsecret",
      providerEnvVar: "ANTHROPIC_API_KEY",
      providerKey: "antsecret",
    });
    const joined = lines.join("\n");
    expect(joined).toContain("acme/widget");
    expect(joined).toContain("claude (model: claude-sonnet-4-6)");
    expect(joined).not.toContain("ghsecret");
    expect(joined).not.toContain("antsecret");
    expect(joined).toContain("••••••••");
  });
});

// --- Scripted prompter for orchestration tests ------------------------------

const ACCEPT_DEFAULT = "<<default>>";

type Script = {
  text?: string[];
  secret?: string[];
  pick?: number[];
  confirm?: boolean[];
};

type Recorder = {
  questions: string[];
  textDefaults: string[];
  secretDefaults: string[];
  pickDefaultIndex: number | undefined;
};

function scriptedPrompter(script: Script): { prompter: Prompter; rec: Recorder } {
  const q = {
    text: [...(script.text ?? [])],
    secret: [...(script.secret ?? [])],
    pick: [...(script.pick ?? [])],
    confirm: [...(script.confirm ?? [])],
  };
  const rec: Recorder = {
    questions: [],
    textDefaults: [],
    secretDefaults: [],
    pickDefaultIndex: undefined,
  };
  const take = <T>(arr: T[], name: string): T => {
    if (arr.length === 0) throw new Error(`scripted prompter ran out of ${name} answers`);
    return arr.shift() as T;
  };
  const prompter: Prompter = {
    text(question, opts) {
      rec.questions.push(question);
      rec.textDefaults.push(opts?.default ?? "");
      const v = take(q.text, "text");
      return Promise.resolve(v === ACCEPT_DEFAULT ? (opts?.default ?? "") : v);
    },
    secret(question, opts) {
      rec.questions.push(question);
      rec.secretDefaults.push(opts?.default ?? "");
      const v = take(q.secret, "secret");
      return Promise.resolve(v === ACCEPT_DEFAULT ? (opts?.default ?? "") : v);
    },
    pick(question, _choices, opts) {
      rec.questions.push(question);
      rec.pickDefaultIndex = opts.defaultIndex;
      return Promise.resolve(take(q.pick, "pick"));
    },
    confirm(question, _opts) {
      rec.questions.push(question);
      return Promise.resolve(take(q.confirm, "confirm"));
    },
    close() {},
  };
  return { prompter, rec };
}

const noHooks = { gitRemoteUrl: () => undefined, ghAuthToken: () => undefined };

describe("runSetup", () => {
  test("writes a real config and .env from the answers", async () => {
    const target = makeTempDir();
    const { output } = capture();
    const { prompter, rec } = scriptedPrompter({
      text: [
        "acme/widget",
        "https://github.com/acme/widget.git",
        "pnpm i",
        "pnpm check",
        "pnpm test",
      ],
      secret: ["ghsecret", "antsecret"],
      pick: [0], // claude (PROVIDER_ORDER[0])
      confirm: [true],
    });

    await runSetup({
      targetDir: target,
      io: { input: new PassThrough(), output },
      env: {},
      cwd: target,
      prompter,
      hooks: noHooks,
      packageRoot: REPO_ROOT,
    });

    const config = readFileSync(join(target, "phoebe.config.ts"), "utf8");
    expect(config).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(config).toContain(`repoSlug: "acme/widget"`);
    expect(config).toContain(`repoUrl: "https://github.com/acme/widget.git"`);
    expect(config).toContain(`installCommand: "pnpm i"`);
    expect(config).toContain(`checkCommand: "pnpm check"`);
    expect(config).toContain(`testCommand: "pnpm test"`);
    expect(config).toContain(`defaultProvider: "claude"`);
    // Config must stay type-only so the mounted file loads before the engine exists.
    expect(config).not.toMatch(/^import (?!type )/m);

    const env = readFileSync(join(target, ".env"), "utf8");
    expect(env).toContain("GH_TOKEN=ghsecret");
    expect(env).toContain("ANTHROPIC_API_KEY=antsecret");
    expect(env).toContain("CURSOR_API_KEY=\n");
    expect(env).toContain("OPENAI_KEY=");

    // Provider default index pointed at the engine default provider's slot.
    expect(rec.pickDefaultIndex).toBe(1); // DEFAULT_RESOLVED_CONFIG.defaultProvider === "cursor" → index 1
  });

  test("never prints either secret", async () => {
    const target = makeTempDir();
    const { output, text } = capture();
    const { prompter } = scriptedPrompter({
      text: [
        "acme/widget",
        "https://github.com/acme/widget.git",
        "npm ci",
        "npm run check",
        "npm test",
      ],
      secret: ["ghsecretVALUE", "antsecretVALUE"],
      pick: [0],
      confirm: [true],
    });
    await runSetup({
      targetDir: target,
      io: { input: new PassThrough(), output },
      env: {},
      cwd: target,
      prompter,
      hooks: noHooks,
      packageRoot: REPO_ROOT,
    });
    expect(text()).not.toContain("ghsecretVALUE");
    expect(text()).not.toContain("antsecretVALUE");
    expect(text()).toContain(`runs model ${DEFAULT_RESOLVED_CONFIG.defaultModels.claude}`);
    expect(text()).toContain("Next steps:");
    expect(text()).toContain("docker compose --env-file ../.env up -d");
  });

  test("re-prompts on an invalid repo slug", async () => {
    const target = makeTempDir();
    const { output, text } = capture();
    const { prompter } = scriptedPrompter({
      text: [
        "not-a-slug",
        "acme/widget",
        "https://github.com/acme/widget.git",
        "npm ci",
        "npm run check",
        "npm test",
      ],
      secret: ["", ""],
      pick: [1],
      confirm: [true],
    });
    await runSetup({
      targetDir: target,
      io: { input: new PassThrough(), output },
      env: {},
      cwd: target,
      prompter,
      hooks: noHooks,
      packageRoot: REPO_ROOT,
    });
    expect(text()).toMatch(/✗ Expected owner\/repo/);
    expect(readFileSync(join(target, "phoebe.config.ts"), "utf8")).toContain(
      `repoSlug: "acme/widget"`,
    );
  });

  test("declining the confirm gate writes neither owned file", async () => {
    const target = makeTempDir();
    const { output, text } = capture();
    const { prompter } = scriptedPrompter({
      text: [
        "acme/widget",
        "https://github.com/acme/widget.git",
        "npm ci",
        "npm run check",
        "npm test",
      ],
      secret: ["x", "y"],
      pick: [0],
      confirm: [false],
    });
    await runSetup({
      targetDir: target,
      io: { input: new PassThrough(), output },
      env: {},
      cwd: target,
      prompter,
      hooks: noHooks,
      packageRoot: REPO_ROOT,
    });
    // init's placeholder config remains; setup did not overwrite it.
    expect(readFileSync(join(target, "phoebe.config.ts"), "utf8")).toContain(
      `repoSlug: "your-org/your-repo"`,
    );
    expect(existsSync(join(target, ".env"))).toBe(false);
    expect(text()).toContain("Aborted");
  });

  test("pre-fills defaults from a git remote when there is no prior config", async () => {
    const target = makeTempDir();
    const { output } = capture();
    const { prompter, rec } = scriptedPrompter({
      text: [ACCEPT_DEFAULT, ACCEPT_DEFAULT, ACCEPT_DEFAULT, ACCEPT_DEFAULT, ACCEPT_DEFAULT],
      secret: [ACCEPT_DEFAULT, ACCEPT_DEFAULT],
      pick: [1],
      confirm: [true],
    });
    await runSetup({
      targetDir: target,
      io: { input: new PassThrough(), output },
      env: {},
      cwd: target,
      prompter,
      hooks: { gitRemoteUrl: () => "git@github.com:acme/widget.git", ghAuthToken: () => undefined },
      packageRoot: REPO_ROOT,
    });
    // First two text prompts are repoSlug then repoUrl.
    expect(rec.textDefaults[0]).toBe("acme/widget");
    expect(rec.textDefaults[1]).toBe("https://github.com/acme/widget.git");
    const config = readFileSync(join(target, "phoebe.config.ts"), "utf8");
    expect(config).toContain(`repoSlug: "acme/widget"`);
  });

  test("re-run pre-fills every default from the existing config and .env", async () => {
    const target = makeTempDir();
    // Seed a prior setup result.
    writeFileSync(
      join(target, "phoebe.config.ts"),
      `const config = {
        repoSlug: "team/svc",
        repoUrl: "https://github.com/team/svc.git",
        installCommand: "make install",
        checkCommand: "make check",
        testCommand: "make test",
        defaultProvider: "codex",
      };\n`,
    );
    writeFileSync(join(target, ".env"), "GH_TOKEN=existingGH\nOPENAI_KEY=existingKEY\n");

    const { output } = capture();
    const { prompter, rec } = scriptedPrompter({
      text: [ACCEPT_DEFAULT, ACCEPT_DEFAULT, ACCEPT_DEFAULT, ACCEPT_DEFAULT, ACCEPT_DEFAULT],
      secret: [ACCEPT_DEFAULT, ACCEPT_DEFAULT],
      pick: [2], // the scripted prompter returns this index regardless of the default
      confirm: [true],
    });
    await runSetup({
      targetDir: target,
      io: { input: new PassThrough(), output },
      env: {},
      cwd: target,
      // A real git remote must NOT override an explicit prior config value.
      hooks: {
        gitRemoteUrl: () => "git@github.com:someone/else.git",
        ghAuthToken: () => undefined,
      },
      prompter,
      packageRoot: REPO_ROOT,
    });

    expect(rec.textDefaults).toEqual([
      "team/svc",
      "https://github.com/team/svc.git",
      "make install",
      "make check",
      "make test",
    ]);
    // defaultProvider "codex" → PROVIDER_ORDER index 2.
    expect(rec.pickDefaultIndex).toBe(2);
    // Secret defaults come from the existing .env (GH_TOKEN, then codex's OPENAI_KEY).
    expect(rec.secretDefaults).toEqual(["existingGH", "existingKEY"]);

    const config = readFileSync(join(target, "phoebe.config.ts"), "utf8");
    expect(config).toContain(`repoSlug: "team/svc"`);
    expect(config).toContain(`defaultProvider: "codex"`);
    const env = readFileSync(join(target, ".env"), "utf8");
    expect(env).toContain("GH_TOKEN=existingGH");
    expect(env).toContain("OPENAI_KEY=existingKEY");
  });

  test("re-run preserves a hand-set key for a non-selected provider", async () => {
    const target = makeTempDir();
    writeFileSync(
      join(target, "phoebe.config.ts"),
      `const config = { repoSlug: "team/svc", defaultProvider: "codex" };\n`,
    );
    // The user runs codex, but had also filled in Anthropic's key by hand.
    writeFileSync(
      join(target, ".env"),
      "GH_TOKEN=existingGH\nANTHROPIC_API_KEY=handAnthropic\nCURSOR_API_KEY=\nOPENAI_KEY=existingKEY\n",
    );

    const { output } = capture();
    const { prompter } = scriptedPrompter({
      text: [ACCEPT_DEFAULT, ACCEPT_DEFAULT, ACCEPT_DEFAULT, ACCEPT_DEFAULT, ACCEPT_DEFAULT],
      secret: [ACCEPT_DEFAULT, ACCEPT_DEFAULT],
      pick: [2], // codex → OPENAI_KEY is the selected key
      confirm: [true],
    });
    await runSetup({
      targetDir: target,
      io: { input: new PassThrough(), output },
      env: {},
      cwd: target,
      hooks: { gitRemoteUrl: () => undefined, ghAuthToken: () => undefined },
      prompter,
      packageRoot: REPO_ROOT,
    });

    const env = readFileSync(join(target, ".env"), "utf8");
    // The selected provider's key and GH_TOKEN round-trip …
    expect(env).toContain("GH_TOKEN=existingGH");
    expect(env).toContain("OPENAI_KEY=existingKEY");
    // … and the hand-set non-selected key is NOT blanked on an Enter-through re-run.
    expect(env).toContain("ANTHROPIC_API_KEY=handAnthropic");
  });

  test("refuses to run without a TTY when no prompter is injected", async () => {
    const target = makeTempDir();
    const input = Object.assign(new PassThrough(), { isTTY: false });
    const { output } = capture();
    await expect(
      runSetup({
        targetDir: target,
        io: { input, output },
        env: {},
        cwd: target,
        hooks: noHooks,
        packageRoot: REPO_ROOT,
      }),
    ).rejects.toThrow(/needs a terminal/);
    // Nothing was scaffolded before the guard tripped.
    expect(existsSync(join(target, "phoebe.config.ts"))).toBe(false);
  });
});

// --- Real readline prompter -------------------------------------------------

describe("createReadlinePrompter", () => {
  test("text returns the typed answer, or the default on empty input", async () => {
    const input = new PassThrough();
    const { output } = capture();
    const p = createReadlinePrompter({ input, output });
    const typed = p.text("Name", { default: "def" });
    input.write("acme/widget\n");
    expect(await typed).toBe("acme/widget");
    const defaulted = p.text("Name", { default: "def" });
    input.write("\n");
    expect(await defaulted).toBe("def");
    p.close();
  });

  test("pick returns the chosen index and defaults on empty input", async () => {
    const input = new PassThrough();
    const { output } = capture();
    const p = createReadlinePrompter({ input, output });
    const picked = p.pick("Q", ["a", "b", "c"], { defaultIndex: 1 });
    input.write("3\n");
    expect(await picked).toBe(2);
    const defaulted = p.pick("Q", ["a", "b", "c"], { defaultIndex: 1 });
    input.write("\n");
    expect(await defaulted).toBe(1);
    p.close();
  });

  test("confirm reads y/n and honors the default", async () => {
    const input = new PassThrough();
    const { output } = capture();
    const p = createReadlinePrompter({ input, output });
    const yes = p.confirm("OK?", { defaultYes: true });
    input.write("\n");
    expect(await yes).toBe(true);
    const no = p.confirm("OK?", { defaultYes: true });
    input.write("n\n");
    expect(await no).toBe(false);
    p.close();
  });

  test("secret returns the typed value but never echoes it to the output", async () => {
    const input = new PassThrough();
    const { output, text } = capture();
    const p = createReadlinePrompter({ input, output });
    const secret = p.secret("Token", {});
    input.write("hunter2\n");
    expect(await secret).toBe("hunter2");
    expect(text()).not.toContain("hunter2");
    p.close();
  });
});
