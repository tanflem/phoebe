import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { resolveConfiguration } from "./config/index.ts";
import { buildRuntimeContractContext } from "./runtime-contract-context.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime contract digests", () => {
  test("projects every required digest without exposing prompt bodies or secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "phoebe-contract-context-"));
    roots.push(root);
    mkdirSync(join(root, "prompts"));
    for (const name of ["issue", "conflict", "checks", "reviews", "research"]) {
      writeFileSync(join(root, "prompts", `${name}.md`), `${name} prompt super-secret\n`);
    }
    const { config } = resolveConfiguration({
      repository: {
        repoSlug: "owner/repo",
        repoUrl: "https://github.com/owner/repo.git",
        installCommand: "pnpm install",
        checkCommand: "vp check",
        testCommand: "vp test",
        promptFiles: {
          issue: "prompts/issue.md",
          conflict: "prompts/conflict.md",
          checks: "prompts/checks.md",
          reviews: "prompts/reviews.md",
          research: "prompts/research.md",
        },
      },
    });

    const context = buildRuntimeContractContext({
      config,
      providerName: "codex",
      model: "gpt-test",
      runtimeRoot: root,
      env: {
        PHOEBE_RUNNING_ENGINE_SOURCE: "github",
        PHOEBE_RUNNING_ENGINE_REPO: "JesusFilm/phoebe",
        PHOEBE_RUNNING_ENGINE_REF: "main",
        PHOEBE_RUNNING_ENGINE_SHA: "abc123",
        PHOEBE_BOOTSTRAP_VERSION: "0.1.0",
        GH_TOKEN: "super-secret",
      },
    });

    expect(context.repository).toEqual({
      slug: "owner/repo",
      url: "https://github.com/owner/repo.git",
      defaultBranch: "main",
    });
    expect(Object.values(context.digests)).toHaveLength(6);
    expect(
      Object.values(context.digests).every((value) => /^sha256:[0-9a-f]{64}$/.test(value)),
    ).toBe(true);
    expect(context.provider.digest).toBe(context.digests.providerModel);
    expect(context.secrets).toContain("super-secret");
    expect(JSON.stringify({ ...context, secrets: undefined })).not.toContain("super-secret");
  });
});
