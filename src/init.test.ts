// Init scaffolder contract:
//   * plan enumerates every consumer-owned file (prompts derived from the
//     roster's `promptFiles` default so drift is impossible),
//   * template rendering substitutes every `{{TOKEN}}` and throws on unknowns,
//   * `.gitignore` merges are additive (no dedup gap, no clobber),
//   * `runInit` never overwrites an existing file (the guarded-re-run
//     acceptance criterion),
//   * workspace profile (#93) writes engine + workspace block, no child files.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_RESOLVED_CONFIG,
  DEFAULT_TEMPLATE_PARAMS,
  formatInitReport,
  initTenant,
  mergeGitignore,
  planInitOutputs,
  readOriginRemoteUrl,
  renderTemplate,
  runInit,
} from "./init.ts";
import {
  slugFromRemoteUrl,
  TENANT_ENV_EXAMPLE,
  TENANT_PLACEHOLDER_SLUG,
  TENANT_PLACEHOLDER_URL,
} from "./tenant-commands.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "phoebe-init-test-"));
}

describe("planInitOutputs", () => {
  test("flat: scaffolds config, env example, three container files, every prompt, gitignore", () => {
    const plan = planInitOutputs("flat");
    const dests = plan.map((p) => p.destRelPath);
    expect(dests).toContain("phoebe.config.ts");
    expect(dests).toContain(".env.example");
    expect(dests).toContain("container/Dockerfile");
    expect(dests).toContain("container/compose.yml");
    expect(dests).toContain("container/compose.local.yml");
    expect(dests).toContain(".gitignore");
    expect(dests).not.toContain("container/README.md");
    for (const promptPath of Object.values(DEFAULT_RESOLVED_CONFIG.promptFiles)) {
      expect(dests).toContain(promptPath);
    }
  });

  test("workspace: engine-root files + mount docs, no prompts or child dirs", () => {
    const plan = planInitOutputs("workspace");
    const dests = plan.map((p) => p.destRelPath);
    expect(dests).toEqual([
      "phoebe.config.ts",
      ".env.example",
      "container/Dockerfile",
      "container/compose.yml",
      "container/compose.local.yml",
      "container/README.md",
      ".gitignore",
    ]);
    for (const promptPath of Object.values(DEFAULT_RESOLVED_CONFIG.promptFiles)) {
      expect(dests).not.toContain(promptPath);
    }
  });

  test("tenant profile uses initTenant (dynamic origin prefill), not the static plan", () => {
    expect(() => planInitOutputs("tenant")).toThrow(/initTenant/);
    expect(() => runInit({ targetDir: makeTempDir(), profile: "tenant" })).toThrow(/initTenant/);
  });

  test("the retired supervisor + daemon-overlay scaffolding is gone", () => {
    // `phoebe boot` is the container's long-lived main process now: it owns
    // restarts, engine updates, and the crash-loop fallback, so there is no
    // shell supervisor to scaffold and nothing for a daemon overlay to switch
    // on — the base compose file is already the daemon.
    const dests = planInitOutputs().map((p) => p.destRelPath);
    expect(dests).not.toContain("container/supervisor.sh");
    expect(dests).not.toContain("container/compose.daemon.yml");
  });
});

describe("renderTemplate", () => {
  test("substitutes {{INSTALL_COMMAND}} and {{CLI_BIN}}", () => {
    const out = renderTemplate("run {{INSTALL_COMMAND}} then {{CLI_BIN}}", {
      ...DEFAULT_TEMPLATE_PARAMS,
      installCommand: "pnpm i",
      cliBin: "phoebe-agent",
    });
    expect(out).toBe("run pnpm i then phoebe-agent");
  });

  test("substitutes the repo/toolchain and provider tokens", () => {
    const out = renderTemplate(
      "{{REPO_SLUG}} {{REPO_URL}} {{CHECK_COMMAND}} {{TEST_COMMAND}} {{DEFAULT_PROVIDER}}",
      {
        ...DEFAULT_TEMPLATE_PARAMS,
        repoSlug: "acme/widget",
        repoUrl: "https://github.com/acme/widget.git",
        checkCommand: "make check",
        testCommand: "make test",
        defaultProvider: "claude",
      },
    );
    expect(out).toBe("acme/widget https://github.com/acme/widget.git make check make test claude");
  });

  test("throws on an unknown {{TOKEN}}", () => {
    expect(() => renderTemplate("hello {{UNKNOWN}}", DEFAULT_TEMPLATE_PARAMS)).toThrow(/UNKNOWN/);
  });

  test("substitutes all occurrences of a token", () => {
    const out = renderTemplate("{{CLI_BIN}} and {{CLI_BIN}}", DEFAULT_TEMPLATE_PARAMS);
    expect(out).toBe("phoebe-agent and phoebe-agent");
  });

  test("escapes a double quote so it cannot break out of the surrounding string literal (#71)", () => {
    const out = renderTemplate('installCommand: "{{INSTALL_COMMAND}}",', {
      ...DEFAULT_TEMPLATE_PARAMS,
      installCommand: 'pnpm i --filter "web"',
    });
    expect(out).toBe('installCommand: "pnpm i --filter \\"web\\"",');
  });

  test("escapes a backslash and a newline the same way (#71)", () => {
    const out = renderTemplate("{{TEST_COMMAND}}", {
      ...DEFAULT_TEMPLATE_PARAMS,
      testCommand: 'echo "line1"\nline2\\end',
    });
    expect(out).toBe(JSON.stringify('echo "line1"\nline2\\end').slice(1, -1));
    expect(out).not.toContain("\n");
  });
});

describe("mergeGitignore", () => {
  test("creates a bare list when no existing content", () => {
    const merged = mergeGitignore("", [".env", "node_modules/"]);
    expect(merged).toBe(".env\nnode_modules/\n");
  });

  test("appends missing entries under a Phoebe header when the file has content", () => {
    const merged = mergeGitignore("dist/\n", [".env", "node_modules/"]);
    expect(merged).toBe("dist/\n\n# Phoebe\n.env\nnode_modules/\n");
  });

  test("does not duplicate entries that already exist elsewhere", () => {
    const merged = mergeGitignore("dist/\nnode_modules/\n", [".env", "node_modules/"]);
    expect(merged).toBe("dist/\nnode_modules/\n\n# Phoebe\n.env\n");
  });

  test("returns input unchanged when every entry already present", () => {
    const existing = ".env\nnode_modules/\n";
    expect(mergeGitignore(existing, [".env", "node_modules/"])).toBe(existing);
  });

  test("handles a missing trailing newline on existing content", () => {
    const merged = mergeGitignore("dist/", [".env"]);
    expect(merged).toBe("dist/\n\n# Phoebe\n.env\n");
  });
});

describe("runInit", () => {
  test("writes every planned file into an empty directory", () => {
    const target = makeTempDir();
    const report = runInit({ targetDir: target });

    for (const output of planInitOutputs()) {
      const abs = join(target, output.destRelPath);
      expect(statSync(abs).isFile()).toBe(true);
    }
    expect(report.skipped).toEqual([]);
    // .gitignore is "created" (empty existing) rather than "updated".
    expect(report.created).toContain(".gitignore");
    expect(report.created).toContain("phoebe.config.ts");
    expect(report.created).toContain("container/Dockerfile");
    expect(report.updated).toEqual([]);
  });

  test("Dockerfile pins `phoebe boot` into ENTRYPOINT so compose command: overrides append flags", () => {
    // Compose's `command:` replaces `CMD` outright. If the Dockerfile split
    // `phoebe boot` across ENTRYPOINT + CMD, `command: ["--run-once"]` would
    // exec `tini -- --run-once` (no valid child program) and the container
    // would fail to boot. Keeping the whole invocation in ENTRYPOINT means a
    // compose `command:` only ever contributes engine flags. Lock it.
    const target = makeTempDir();
    runInit({ targetDir: target });
    const dockerfile = readFileSync(join(target, "container/Dockerfile"), "utf8");
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--", "phoebe", "boot"]');
    expect(dockerfile).toContain("CMD []");
  });

  test("the scaffolded container marker satisfies the engine's execution gate", () => {
    // Without /.phoebe-container the engine refuses every non-dry-run unit
    // (src/execution-gate.ts), so a stock scaffold that omits it produces a
    // container that silently does nothing.
    const target = makeTempDir();
    runInit({ targetDir: target });
    expect(readFileSync(join(target, "container/Dockerfile"), "utf8")).toContain(
      "touch /.phoebe-container",
    );
  });

  test("the scaffolded image runs the workload unprivileged, with writable volumes", () => {
    // The template's own hardening invariants are asserted in
    // container-image.test.ts; this covers the seam that matters to a consumer
    // — that they survive rendering into the file `init` actually writes. A
    // placeholder substitution that mangled the USER line or the /data chown
    // would hand every consumer a root container.
    const target = makeTempDir();
    runInit({ targetDir: target });
    const dockerfile = readFileSync(join(target, "container/Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^USER phoebe$/m);
    expect(dockerfile).toContain("chown -R phoebe:phoebe /data");
  });

  test("the scaffolded config declares an engine source the bootstrapper can read", () => {
    // `phoebe boot` resolves the engine from this field before the engine
    // exists, and loads the config from the container mount — where a *value*
    // import of `phoebe-agent` cannot resolve. The template must therefore
    // stay type-only.
    const target = makeTempDir();
    runInit({ targetDir: target });
    const config = readFileSync(join(target, "phoebe.config.ts"), "utf8");
    expect(config).toContain("engine:");
    expect(config).toContain('import type { PhoebeUserConfig } from "phoebe-agent"');
    // No *runtime* import of any kind: every import in this file must be
    // type-only, or loading the mounted config dies on module resolution.
    expect(config).not.toMatch(/^import (?!type )/m);
  });

  test("renders {{INSTALL_COMMAND}} and {{CLI_BIN}} into scaffolded files", () => {
    const target = makeTempDir();
    runInit({
      targetDir: target,
      params: { installCommand: "pnpm i", cliBin: "phoebe-agent" },
    });
    const dockerfile = readFileSync(join(target, "container/Dockerfile"), "utf8");
    expect(dockerfile).not.toMatch(/\{\{[A-Z_]+\}\}/);
    const config = readFileSync(join(target, "phoebe.config.ts"), "utf8");
    expect(config).toContain(`installCommand: "pnpm i"`);
    expect(config).toContain(`from "phoebe-agent"`);
  });

  test("scaffolds a config with the generic placeholders and no leftover tokens", () => {
    const target = makeTempDir();
    runInit({ targetDir: target });
    const config = readFileSync(join(target, "phoebe.config.ts"), "utf8");
    expect(config).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(config).toContain(`repoSlug: "your-org/your-repo"`);
    expect(config).toContain(`repoUrl: "https://github.com/your-org/your-repo.git"`);
    expect(config).toContain(`checkCommand: "npm run check"`);
    expect(config).toContain(`testCommand: "npm test"`);
    // Default provider matches the engine default, so init's resolved config is
    // unchanged from before these fields were tokenized.
    expect(config).toContain(`defaultProvider: "${DEFAULT_RESOLVED_CONFIG.defaultProvider}"`);
  });

  test("does not overwrite existing files on re-run", () => {
    const target = makeTempDir();
    runInit({ targetDir: target });

    // Simulate consumer edits to two scaffolded files.
    const editedConfigContents = "// EDITED BY CONSUMER\nexport default {};\n";
    writeFileSync(join(target, "phoebe.config.ts"), editedConfigContents);
    const editedCompose = "services:\n  phoebe:\n    image: edited\n";
    writeFileSync(join(target, "container/compose.yml"), editedCompose);

    const report = runInit({ targetDir: target });

    expect(readFileSync(join(target, "phoebe.config.ts"), "utf8")).toBe(editedConfigContents);
    expect(readFileSync(join(target, "container/compose.yml"), "utf8")).toBe(editedCompose);
    expect(report.skipped).toContain("phoebe.config.ts");
    expect(report.skipped).toContain("container/compose.yml");
    expect(report.created).toEqual([]);
  });

  test("appends new gitignore entries without touching existing ones", () => {
    const target = makeTempDir();
    writeFileSync(join(target, ".gitignore"), "dist/\n");
    const report = runInit({ targetDir: target });
    const gitignore = readFileSync(join(target, ".gitignore"), "utf8");
    expect(gitignore.startsWith("dist/\n")).toBe(true);
    expect(gitignore).toContain(".env");
    expect(report.updated).toContain(".gitignore");
    expect(report.created).not.toContain(".gitignore");
  });

  test("creates the target directory when it does not exist", () => {
    const parent = makeTempDir();
    const target = join(parent, "nested/deeper");
    runInit({ targetDir: target });
    expect(statSync(join(target, "phoebe.config.ts")).isFile()).toBe(true);
  });

  test("scaffolded prompt files match the shipped templates verbatim", () => {
    const target = makeTempDir();
    runInit({ targetDir: target });
    // If this test needs a fixture package root someday, plumb `packageRoot`.
    // For now the walk-up finds the repo's own prompts/ from src/.
    const scaffolded = readFileSync(join(target, "prompts/issues-prompt.md"), "utf8");
    expect(scaffolded).toContain("{{ISSUE_NUMBER}}");
    expect(scaffolded).toContain("Phoebe");
  });
});

describe("runInit — workspace profile (#93)", () => {
  test("writes the workspace-root manifest into an empty directory", () => {
    const target = makeTempDir();
    const report = runInit({ targetDir: target, profile: "workspace" });

    for (const output of planInitOutputs("workspace")) {
      expect(statSync(join(target, output.destRelPath)).isFile()).toBe(true);
    }
    // No flat-only artefacts.
    expect(existsSync(join(target, "prompts"))).toBe(false);
    expect(existsSync(join(target, "repos"))).toBe(false);
    expect(report.skipped).toEqual([]);
    expect(report.created).toContain("phoebe.config.ts");
    expect(report.created).toContain("container/README.md");
  });

  test("root config carries engine + workspace: { depth: 1 }", () => {
    const target = makeTempDir();
    runInit({ targetDir: target, profile: "workspace" });
    const config = readFileSync(join(target, "phoebe.config.ts"), "utf8");
    expect(config).toContain("engine:");
    expect(config).toMatch(/workspace:\s*\{\s*depth:\s*1\s*\}/);
    // No per-repo required fields on the workspace root.
    expect(config).not.toContain("repoSlug:");
    expect(config).not.toContain("repoUrl:");
    expect(config).toContain('import type { PhoebeUserConfig } from "phoebe-agent"');
    expect(config).not.toMatch(/^import (?!type )/m);
  });

  test("container templates match #57 flat scaffolding byte-for-byte (compose files)", () => {
    const flat = makeTempDir();
    const workspace = makeTempDir();
    runInit({ targetDir: flat, profile: "flat" });
    runInit({ targetDir: workspace, profile: "workspace" });
    for (const rel of [
      "container/Dockerfile",
      "container/compose.yml",
      "container/compose.local.yml",
    ] as const) {
      expect(readFileSync(join(workspace, rel), "utf8")).toBe(
        readFileSync(join(flat, rel), "utf8"),
      );
    }
  });

  test(".env.example is deployment-level (GH_TOKEN + providers + toggles)", () => {
    const target = makeTempDir();
    runInit({ targetDir: target, profile: "workspace" });
    const envExample = readFileSync(join(target, ".env.example"), "utf8");
    // Deployment secrets only — no per-child TENANT_* / REPO_* key template.
    expect(envExample).toContain("GH_TOKEN=");
    expect(envExample).toContain("ANTHROPIC_API_KEY=");
    expect(envExample).toContain("CURSOR_API_KEY=");
    expect(envExample).toContain("OPENAI_KEY=");
    expect(envExample).toContain("PHOEBE_AGENT");
    expect(envExample).not.toMatch(/^TENANT_/m);
    expect(envExample).not.toMatch(/^REPO_/m);
  });

  test(".gitignore covers .env and node_modules only (no repos/**/.env)", () => {
    const target = makeTempDir();
    runInit({ targetDir: target, profile: "workspace" });
    const gitignore = readFileSync(join(target, ".gitignore"), "utf8");
    expect(gitignore).toContain(".env");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).not.toContain("repos/**/.env");
  });

  test("mount docs require :ro mount, .git, and materialize-before-boot", () => {
    const target = makeTempDir();
    runInit({ targetDir: target, profile: "workspace" });
    const readme = readFileSync(join(target, "container/README.md"), "utf8");
    expect(readme).toContain(":/etc/phoebe:ro");
    expect(readme).toMatch(/\.git/);
    expect(readme).toContain("git submodule update --init");
    expect(readme).toMatch(/skip-and-warn/i);
  });

  test("compose still bind-mounts the whole root :ro at /etc/phoebe", () => {
    const target = makeTempDir();
    runInit({ targetDir: target, profile: "workspace" });
    const compose = readFileSync(join(target, "container/compose.yml"), "utf8");
    expect(compose).toContain("- ..:/etc/phoebe:ro");
    expect(compose).toContain("working_dir: /etc/phoebe");
  });
});

describe("slugFromRemoteUrl / initTenant (#94)", () => {
  test("slugFromRemoteUrl parses HTTPS, scp-like SSH, and ssh:// forms", () => {
    expect(slugFromRemoteUrl("https://github.com/acme/widget.git")).toBe("acme/widget");
    expect(slugFromRemoteUrl("https://github.com/acme/widget")).toBe("acme/widget");
    expect(slugFromRemoteUrl("git@github.com:acme/widget.git")).toBe("acme/widget");
    expect(slugFromRemoteUrl("ssh://git@github.com/acme/widget.git")).toBe("acme/widget");
    expect(slugFromRemoteUrl("https://x-access-token:tok@github.com/acme/widget.git")).toBe(
      "acme/widget",
    );
    expect(slugFromRemoteUrl("not-a-url")).toBeNull();
    expect(slugFromRemoteUrl("")).toBeNull();
  });

  test("readOriginRemoteUrl uses git remote get-url origin", () => {
    const calls: string[][] = [];
    const url = readOriginRemoteUrl("/tmp/child", (args, opts) => {
      calls.push(args);
      expect(opts?.cwd).toBe("/tmp/child");
      return "https://github.com/acme/widget.git\n";
    });
    expect(url).toBe("https://github.com/acme/widget.git");
    expect(calls).toEqual([["remote", "get-url", "origin"]]);
  });

  test("writes in-tree layout with no container/; config + env.example + .gitignore", () => {
    const target = makeTempDir();
    const result = initTenant({
      targetDir: target,
      git: () => {
        throw new Error("no remote");
      },
    });

    expect(existsSync(join(target, "phoebe.config.ts"))).toBe(true);
    expect(existsSync(join(target, ".env.example"))).toBe(true);
    expect(existsSync(join(target, ".gitignore"))).toBe(true);
    expect(existsSync(join(target, "container"))).toBe(false);
    expect(existsSync(join(target, "prompts"))).toBe(false);
    expect(result.created).toContain("phoebe.config.ts");
    expect(result.created).toContain(".env.example");
    expect(result.created).toContain(".gitignore");
    expect(readFileSync(join(target, ".env.example"), "utf8")).toBe(TENANT_ENV_EXAMPLE);
    expect(readFileSync(join(target, ".gitignore"), "utf8")).toContain(".env");
  });

  test("prefills repoSlug/repoUrl from child origin", () => {
    const target = makeTempDir();
    const origin = "git@github.com:acme/widget.git";
    const result = initTenant({
      targetDir: target,
      git: () => `${origin}\n`,
    });
    expect(result.repoSlug).toBe("acme/widget");
    expect(result.repoUrl).toBe(origin);
    const config = readFileSync(join(target, "phoebe.config.ts"), "utf8");
    expect(config).toContain('repoSlug: "acme/widget"');
    expect(config).toContain(`repoUrl: ${JSON.stringify(origin)}`);
    expect(config).not.toMatch(/\bengine\s*:/);
  });

  test("explicit --slug/--url overrides win over origin", () => {
    const target = makeTempDir();
    const result = initTenant({
      targetDir: target,
      repoSlug: "other/repo",
      repoUrl: "https://example.com/other/repo.git",
      git: () => "https://github.com/acme/widget.git\n",
    });
    expect(result.repoSlug).toBe("other/repo");
    expect(result.repoUrl).toBe("https://example.com/other/repo.git");
  });

  test("strips credentials from a tokenised origin before writing/printing repoUrl", () => {
    const target = makeTempDir();
    const result = initTenant({
      targetDir: target,
      git: () => "https://x-access-token:ghs_secret@github.com/acme/widget.git\n",
    });
    expect(result.repoSlug).toBe("acme/widget");
    expect(result.repoUrl).toBe("https://github.com/acme/widget.git");
    const config = readFileSync(join(target, "phoebe.config.ts"), "utf8");
    expect(config).not.toContain("ghs_secret");
    expect(config).not.toContain("x-access-token");
    expect(config).toContain('repoUrl: "https://github.com/acme/widget.git"');
  });

  test("absent origin falls back to the operator-fill placeholder", () => {
    const target = makeTempDir();
    const result = initTenant({
      targetDir: target,
      git: () => {
        throw new Error("fatal: No such remote 'origin'");
      },
    });
    expect(result.repoSlug).toBe(TENANT_PLACEHOLDER_SLUG);
    expect(result.repoUrl).toBe(TENANT_PLACEHOLDER_URL);
  });

  test("refuses to overwrite an existing phoebe.config.ts", () => {
    const target = makeTempDir();
    writeFileSync(join(target, "phoebe.config.ts"), "// existing\n");
    expect(() =>
      initTenant({
        targetDir: target,
        git: () => "https://github.com/acme/widget.git\n",
      }),
    ).toThrow(/already exists/);
  });

  test("opt-in --with-prompts seeds prompts/", () => {
    const target = makeTempDir();
    const result = initTenant({
      targetDir: target,
      withPrompts: true,
      seedPrompt: (dir) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "issues-prompt.md"), "prompt");
        return [join(dir, "issues-prompt.md")];
      },
      git: () => {
        throw new Error("no remote");
      },
    });
    expect(result.created.some((p) => p.includes("prompts"))).toBe(true);
    expect(readFileSync(join(target, "prompts/issues-prompt.md"), "utf8")).toBe("prompt");
  });

  test("a scaffolded child is discovered as a workspace tenant (ticket 1)", async () => {
    // Ticket 1 (#91) discovery: any dir under the workspace root with a root
    // `phoebe.config.ts` is a tenant, keyed by that config's repoSlug.
    const { discoverWorkspaceTenants } = await import("../bootstrap/tenants.ts");
    const workspace = makeTempDir();
    const child = join(workspace, "widget");
    initTenant({
      targetDir: child,
      git: () => "https://github.com/acme/widget.git\n",
    });

    const discovery = await discoverWorkspaceTenants(workspace, 1, {
      loadRepoSlug: async (configPath) => {
        const src = readFileSync(configPath, "utf8");
        const m = /repoSlug:\s*"([^"]+)"/.exec(src);
        if (!m) throw new Error(`no repoSlug in ${configPath}`);
        return m[1]!;
      },
    });
    expect(discovery.mode).toBe("workspace");
    expect(discovery.tenants).toHaveLength(1);
    expect(discovery.tenants[0]!.slug).toBe("acme/widget");
    expect(discovery.tenants[0]!.dir).toBe(child);
  });
});

describe("formatInitReport", () => {
  test("lists created / updated / skipped sections and a re-run hint", () => {
    const rendered = formatInitReport({ created: ["a"], updated: ["b"], skipped: ["c"] }, "/tmp/x");
    expect(rendered).toContain("/tmp/x");
    expect(rendered).toContain("created");
    expect(rendered).toContain("updated");
    expect(rendered).toContain("skipped");
    expect(rendered).toContain("Delete them");
  });

  test("omits sections with no entries", () => {
    const rendered = formatInitReport({ created: ["a"], updated: [], skipped: [] }, "/tmp/x");
    expect(rendered).toContain("created");
    expect(rendered).not.toContain("updated:");
    expect(rendered).not.toContain("skipped");
  });
});
