// Prompt template rendering: {{KEY}} argument substitution plus !`command`
// shell expansion, executed in the work unit's worktree. The marker trick is
// ported from Sandcastle's PromptPreprocessor: shell blocks present in the raw
// template are marked *before* argument substitution, so `!`...`` patterns
// arriving via substituted values are treated as data, never executed.
//
// Prompt file paths (`config.promptFiles.*`) resolve against the runtime root
// (process cwd) — the consumer checkout on the host, `/etc/phoebe` in the
// container where compose mounts `phoebe.config.ts` and `prompts/`. They do
// not walk the installed package; `phoebe init` copies shipped prompts into
// the runtime root for that reason.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { PhoebeConfig } from "./config-schema.ts";

export type PromptArgs = Record<string, string>;

/**
 * Resolve a `promptFiles.*` path against the runtime root. Absolute paths are
 * used as-is; relative paths join to `runtimeRoot`. Throws when the file is
 * missing — never falls back into the installed package tree.
 */
export function resolvePromptFile(promptPath: string, runtimeRoot: string): string {
  const absolute = isAbsolute(promptPath) ? promptPath : resolve(runtimeRoot, promptPath);
  if (!existsSync(absolute)) {
    throw new Error(
      `Could not find prompt file ${promptPath} (resolved to ${absolute} from runtime root ${runtimeRoot})`,
    );
  }
  return absolute;
}

/** Read a prompt template from a path relative to (or absolute under) the runtime root. */
export function loadPromptTemplate(promptPath: string, runtimeRoot: string): string {
  return readFileSync(resolvePromptFile(promptPath, runtimeRoot), "utf8");
}

/**
 * The standard placeholder set every default prompt template can reference —
 * derived once per run from the resolved config so callers can retarget the
 * toolchain by editing `phoebe.config.ts` alone. Per-callsite args
 * (`ISSUE_NUMBER`, `PR_NUMBER`, …) are merged on top by `runAgentInWorktree`.
 */
export function buildDefaultPromptArgs(config: PhoebeConfig): PromptArgs {
  return {
    INSTALL_COMMAND: config.installCommand,
    CHECK_COMMAND: config.checkCommand,
    TEST_COMMAND: config.testCommand,
    READY_COMMAND: config.readyCommand,
    DEFAULT_BRANCH: config.defaultBranch,
    BRANCH_PREFIX: config.branchPrefix,
    READY_LABEL: config.issueSource.readyLabel,
    RESEARCH_LABEL: config.researchLabel,
    PROCESSING_LABEL: config.processingLabel,
    REVIEWS_SUCCESS_HEADING: config.reviewsSuccessHeading,
    // #21: the repo issues/comments/labels address, which may differ from the
    // repo the agent's worktree is cloned from. Every `gh issue ...` call the
    // default prompts run needs `-R {{ISSUE_SOURCE_REPO_SLUG}}` for that reason.
    ISSUE_SOURCE_REPO_SLUG: config.issueSource.repoSlug,
  };
}

/**
 * Marker inserted between `!` and the opening backtick for shell blocks that
 * appear in the raw template. Only marked blocks are executed.
 */
const SHELL_BLOCK_MARKER = "\x01";

const SHELL_BLOCK_PATTERN = /!`([^`]+)`/g;
const MARKED_SHELL_BLOCK_PATTERN = new RegExp(`!${SHELL_BLOCK_MARKER}\`([^\`]+)\``, "g");
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function substitutePromptArgs(template: string, args: PromptArgs): string {
  const marked = template.replace(SHELL_BLOCK_PATTERN, (_m, cmd: string) => {
    return `!${SHELL_BLOCK_MARKER}\`${cmd}\``;
  });
  return marked.replace(PLACEHOLDER_PATTERN, (match, key: string) => {
    const value = args[key];
    if (value === undefined) {
      throw new Error(`Prompt placeholder {{${key}}} has no value.`);
    }
    return value;
  });
}

/** Execute marked shell blocks and splice their trimmed stdout into the prompt. */
export function expandShellBlocks(prompt: string, execShell: (command: string) => string): string {
  return prompt
    .replace(MARKED_SHELL_BLOCK_PATTERN, (_m, command: string) => {
      return execShell(command).trimEnd();
    })
    .replaceAll(SHELL_BLOCK_MARKER, "");
}

export function renderPrompt(
  template: string,
  args: PromptArgs,
  execShell: (command: string) => string,
): string {
  return expandShellBlocks(substitutePromptArgs(template, args), execShell);
}
