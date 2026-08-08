import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { resolveConfiguration, type PhoebeConfig, type PhoebeUserConfig } from "./config/index.ts";
import {
  buildDefaultPromptArgs,
  loadPromptTemplate,
  renderPrompt,
  resolvePromptFile,
  substitutePromptArgs,
} from "./prompt.ts";

function fixtureConfig(): PhoebeConfig {
  const user: PhoebeUserConfig = {
    repoSlug: "acme/widget",
    repoUrl: "https://github.com/acme/widget.git",
    installCommand: "npm ci",
    checkCommand: "npm run check",
    testCommand: "npm test",
    readyCommand: "npm run ready",
  };
  return resolveConfiguration({ repository: user }).config;
}

describe("substitutePromptArgs", () => {
  test("replaces {{KEY}} placeholders, with or without inner spaces", () => {
    const out = substitutePromptArgs("issue {{ISSUE_NUMBER}} / {{ ISSUE_NUMBER }}", {
      ISSUE_NUMBER: "7",
    });
    expect(out).toContain("issue 7 / 7");
  });

  test("throws on a placeholder with no value", () => {
    expect(() => substitutePromptArgs("{{MISSING}}", {})).toThrow(/MISSING/);
  });
});

describe("renderPrompt", () => {
  test("executes template shell blocks and splices trimmed stdout", () => {
    const executed: string[] = [];
    const out = renderPrompt("Context:\n\n!`gh issue view {{N}}`\n\nDone.", { N: "12" }, (cmd) => {
      executed.push(cmd);
      return "issue body\n";
    });
    expect(executed).toEqual(["gh issue view 12"]);
    expect(out).toBe("Context:\n\nissue body\n\nDone.");
  });

  test("shell patterns arriving via substituted values are data, not commands", () => {
    const executed: string[] = [];
    const out = renderPrompt("Body: {{BODY}}", { BODY: "try !`rm -rf /` ok" }, (cmd) => {
      executed.push(cmd);
      return "ran";
    });
    expect(executed).toEqual([]);
    expect(out).toBe("Body: try !`rm -rf /` ok");
  });
});

describe("buildDefaultPromptArgs", () => {
  test("derives every toolchain/label placeholder from the resolved config", () => {
    const args = buildDefaultPromptArgs(fixtureConfig());
    expect(args).toMatchObject({
      INSTALL_COMMAND: "npm ci",
      CHECK_COMMAND: "npm run check",
      TEST_COMMAND: "npm test",
      READY_COMMAND: "npm run ready",
      DEFAULT_BRANCH: "main",
      BRANCH_PREFIX: "phoebe/",
      READY_LABEL: "ready-for-agent",
      PROCESSING_LABEL: "processing",
      REVIEWS_SUCCESS_HEADING: "## Review feedback addressed",
      ISSUE_SOURCE_REPO_SLUG: "acme/widget",
    });
  });

  test("READY_LABEL and ISSUE_SOURCE_REPO_SLUG follow issueSource when configured (#21)", () => {
    const user: PhoebeUserConfig = {
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
      installCommand: "npm ci",
      checkCommand: "npm run check",
      testCommand: "npm test",
      issueSource: { repoSlug: "acme/planning", readyLabel: "triaged" },
    };
    const args = buildDefaultPromptArgs(resolveConfiguration({ repository: user }).config);
    expect(args["ISSUE_SOURCE_REPO_SLUG"]).toBe("acme/planning");
    expect(args["READY_LABEL"]).toBe("triaged");
  });
});

describe("shipped default prompts", () => {
  const promptsDir = join(import.meta.dirname, "..", "prompts");

  const cases = [
    {
      file: "issues-prompt.md",
      extra: {
        ISSUE_NUMBER: "42",
        ISSUE_REF: "#42",
        VERIFICATION_RESULT_FILE: "/tmp/report.json",
      },
    },
    {
      file: "research-prompt.md",
      extra: {
        ISSUE_NUMBER: "42",
        ISSUE_REF: "#42",
        VERIFICATION_RESULT_FILE: "/tmp/report.json",
      },
    },
    {
      file: "conflict-prompt.md",
      extra: {
        PR_NUMBER: "12",
        PR_BRANCH: "phoebe/issue-42",
        BLOCKER_PR_NUMBERS: "",
        VERIFICATION_RESULT_FILE: "/tmp/report.json",
      },
    },
    {
      file: "checks-prompt.md",
      extra: {
        PR_NUMBER: "12",
        PR_BRANCH: "phoebe/issue-42",
        FAILING_CHECKS: "- ci: FAILURE",
        VERIFICATION_RESULT_FILE: "/tmp/report.json",
      },
    },
    {
      file: "reviews-prompt.md",
      extra: {
        PR_NUMBER: "12",
        PR_BRANCH: "phoebe/issue-42",
        VERIFICATION_RESULT_FILE: "/tmp/report.json",
      },
    },
  ] as const;

  test.each(cases)(
    "$file renders end-to-end with default args + per-callsite args",
    ({ file, extra }) => {
      const template = readFileSync(join(promptsDir, file), "utf8");
      const args = { ...buildDefaultPromptArgs(fixtureConfig()), ...extra };
      // execShell is a stub — no shell blocks should reach the real shell during
      // this render, so returning empty text is fine.
      const out = renderPrompt(template, args, () => "");
      expect(out, `${file} left an unsubstituted placeholder`).not.toMatch(/\{\{[A-Za-z_]/);
    },
  );

  test("issues-prompt.md references the toolchain via placeholders, not literals", () => {
    const template = readFileSync(join(promptsDir, "issues-prompt.md"), "utf8");
    expect(template).toContain("{{READY_COMMAND}}");
    expect(template).toContain("{{CHECK_COMMAND}}");
    expect(template).toContain("{{TEST_COMMAND}}");
    expect(template).toContain("{{PROCESSING_LABEL}}");
    expect(template).toContain("{{READY_LABEL}}");
    expect(template).toContain("{{DEFAULT_BRANCH}}");
    expect(template).toContain("{{ISSUE_SOURCE_REPO_SLUG}}");
    expect(template).toContain("{{ISSUE_REF}}");
  });

  test("checks + conflict prompts document the baseline-breakage branch", () => {
    for (const file of ["checks-prompt.md", "conflict-prompt.md"]) {
      const template = readFileSync(join(promptsDir, file), "utf8");
      // A baseline check against a clean default-branch checkout.
      expect(template, `${file} should describe a baseline check`).toMatch(/baseline/i);
      expect(template).toContain("{{DEFAULT_BRANCH}}");
      // The reconciliation rule: a green check gate does not clear a red test
      // suite unless every red test is baseline-only.
      expect(template).toContain("{{CHECK_COMMAND}}");
      expect(template).toContain("{{TEST_COMMAND}}");
      expect(template, `${file} should carry the reconciliation rule`).toMatch(/baseline-only/);
      // Guidance to open/link a tracking issue rather than silently proceeding.
      expect(template, `${file} should point at a tracking issue`).toMatch(/gh issue create/);
    }
  });

  test("reviews prompt is self-contained (no external skill dependency)", () => {
    const template = readFileSync(join(promptsDir, "reviews-prompt.md"), "utf8");
    expect(template).not.toMatch(/handle-pr-review/);
    expect(template).not.toMatch(/\.claude\/skills\//);
    // The prompt should carry its own workflow, so a few landmark steps live
    // inline rather than being delegated.
    expect(template).toMatch(/reviewThreads/);
    expect(template).toMatch(/resolveReviewThread/);
    expect(template).toContain("{{REVIEWS_SUCCESS_HEADING}}");
  });
});

describe("resolvePromptFile / loadPromptTemplate", () => {
  test("resolves a consumer override from the runtime root, not the installed package", () => {
    // Consumer-style layout: runtime root has an override path; a same-named
    // file also exists under a fake node_modules package tree. Resolution must
    // use the runtime-root copy (compose mounts prompts at /etc/phoebe, while
    // the engine package lives elsewhere under node_modules).
    const runtimeRoot = mkdtempSync(join(tmpdir(), "phoebe-prompt-runtime-"));
    const packageRoot = mkdtempSync(join(tmpdir(), "phoebe-prompt-pkg-"));
    mkdirSync(join(runtimeRoot, "prompts"), { recursive: true });
    mkdirSync(join(packageRoot, "node_modules", "phoebe-agent", "prompts"), { recursive: true });
    writeFileSync(join(runtimeRoot, "prompts", "issues-prompt.md"), "runtime-root override\n");
    writeFileSync(
      join(packageRoot, "node_modules", "phoebe-agent", "prompts", "issues-prompt.md"),
      "packaged default — must not win\n",
    );

    const resolved = resolvePromptFile("prompts/issues-prompt.md", runtimeRoot);
    expect(resolved).toBe(resolve(runtimeRoot, "prompts/issues-prompt.md"));
    expect(loadPromptTemplate("prompts/issues-prompt.md", runtimeRoot)).toBe(
      "runtime-root override\n",
    );
  });

  test("loads a custom promptFiles override path under the runtime root", () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "phoebe-prompt-override-"));
    mkdirSync(join(runtimeRoot, "custom"), { recursive: true });
    writeFileSync(join(runtimeRoot, "custom", "issue.md"), "custom issue prompt\n");

    expect(loadPromptTemplate("custom/issue.md", runtimeRoot)).toBe("custom issue prompt\n");
  });

  test("throws when the path is missing from the runtime root", () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "phoebe-prompt-missing-"));
    expect(() => resolvePromptFile("prompts/missing.md", runtimeRoot)).toThrow(
      /Could not find prompt file prompts\/missing\.md/,
    );
  });
});
