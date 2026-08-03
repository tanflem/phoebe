import { describe, expect, test } from "vite-plus/test";
import { PROVIDERS } from "./providers.ts";
import { CONFIG_DEFAULTS } from "../config-schema.ts";

describe("cursor provider", () => {
  test("builds a print-mode argv with the prompt as the final argument", () => {
    const cmd = PROVIDERS.cursor.buildCommand({ prompt: "do the thing", model: "composer-x" });
    expect(cmd.argv[0]).toBe("agent");
    expect(cmd.argv).toContain("--print");
    expect(cmd.argv).toContain("--force");
    expect(cmd.argv.slice(-1)[0]).toBe("do the thing");
    const modelIdx = cmd.argv.indexOf("--model");
    expect(cmd.argv[modelIdx + 1]).toBe("composer-x");
    expect(cmd.stdin).toBeUndefined();
  });

  test("rejects prompts too large for a single argv argument", () => {
    const huge = "x".repeat(121 * 1024);
    expect(() => PROVIDERS.cursor.buildCommand({ prompt: huge, model: "m" })).toThrow(/bytes/);
  });

  test("ignores effort — cursor has no effort flag", () => {
    const cmd = PROVIDERS.cursor.buildCommand({ prompt: "p", model: "m", effort: "xhigh" });
    expect(cmd.argv).not.toContain("--effort");
  });

  test("parses cursor top-level tool_call events", () => {
    const line = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      tool_call: { readToolCall: { args: { path: "src/a.ts" } } },
    });
    expect(PROVIDERS.cursor.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Read", args: "src/a.ts" },
    ]);
  });

  test("parses shell tool_call function arguments", () => {
    const line = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      tool_call: { function: { name: "shell", arguments: JSON.stringify({ command: "vp test" }) } },
    });
    expect(PROVIDERS.cursor.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "vp test" },
    ]);
  });
});

describe("claude provider", () => {
  test("delivers the prompt on stdin, not argv", () => {
    const cmd = PROVIDERS.claude.buildCommand({ prompt: "big prompt", model: "claude-m" });
    expect(cmd.argv[0]).toBe("claude");
    expect(cmd.argv).toContain("--dangerously-skip-permissions");
    expect(cmd.argv.slice(-2)).toEqual(["-p", "-"]);
    expect(cmd.argv).not.toContain("big prompt");
    expect(cmd.stdin).toBe("big prompt");
    const modelIdx = cmd.argv.indexOf("--model");
    expect(cmd.argv[modelIdx + 1]).toBe("claude-m");
  });

  test("passes the default reasoning effort as --effort right after the model", () => {
    const cmd = PROVIDERS.claude.buildCommand({
      prompt: "big prompt",
      model: "claude-m",
      effort: CONFIG_DEFAULTS.defaultEfforts.claude,
    });
    const modelIdx = cmd.argv.indexOf("--model");
    expect(cmd.argv[modelIdx + 1]).toBe("claude-m");
    expect(cmd.argv[modelIdx + 2]).toBe("--effort");
    expect(cmd.argv[modelIdx + 3]).toBe("xhigh");
  });

  test("honors an overriding effort (e.g. from PHOEBE_EFFORT)", () => {
    const cmd = PROVIDERS.claude.buildCommand({ prompt: "p", model: "claude-m", effort: "low" });
    const effortIdx = cmd.argv.indexOf("--effort");
    expect(cmd.argv[effortIdx + 1]).toBe("low");
  });

  test("omits --effort when no effort is configured", () => {
    const cmd = PROVIDERS.claude.buildCommand({ prompt: "p", model: "claude-m" });
    expect(cmd.argv).not.toContain("--effort");
  });

  test("parses assistant text and allowlisted tool_use blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "working…" },
          { type: "tool_use", name: "Bash", input: { command: "vp check" } },
          { type: "tool_use", name: "SecretTool", input: { x: "ignored" } },
        ],
      },
    });
    expect(PROVIDERS.claude.parseStreamLine(line)).toEqual([
      { type: "text", text: "working…" },
      { type: "tool_call", name: "Bash", args: "vp check" },
    ]);
  });

  test("parses the terminal result event", () => {
    const line = JSON.stringify({ type: "result", result: "done" });
    expect(PROVIDERS.claude.parseStreamLine(line)).toEqual([{ type: "result", result: "done" }]);
  });

  test("ignores non-JSON lines", () => {
    expect(PROVIDERS.claude.parseStreamLine("plain text")).toEqual([]);
    expect(PROVIDERS.claude.parseStreamLine("{not json")).toEqual([]);
  });
});

describe("codex provider", () => {
  test("delivers the prompt on stdin with bypass flags", () => {
    const cmd = PROVIDERS.codex.buildCommand({ prompt: "fix it", model: "gpt-m" });
    expect(cmd.argv.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
    expect(cmd.argv).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd.stdin).toBe("fix it");
    const modelIdx = cmd.argv.indexOf("-m");
    expect(cmd.argv[modelIdx + 1]).toBe("gpt-m");
  });

  test("ignores effort — codex has no effort flag", () => {
    const cmd = PROVIDERS.codex.buildCommand({ prompt: "fix it", model: "gpt-m", effort: "xhigh" });
    expect(cmd.argv).not.toContain("--effort");
  });

  test("maps agent_message completion to text + result", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "all done" },
    });
    expect(PROVIDERS.codex.parseStreamLine(line)).toEqual([
      { type: "text", text: "all done" },
      { type: "result", result: "all done" },
    ]);
  });

  test("maps command_execution start to a Bash tool call", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: "vp test" },
    });
    expect(PROVIDERS.codex.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "vp test" },
    ]);
  });

  test("surfaces stdout error events as result events", () => {
    const line = JSON.stringify({ type: "error", error: { message: "rate limited" } });
    expect(PROVIDERS.codex.parseStreamLine(line)).toEqual([
      { type: "result", result: "rate limited" },
    ]);
  });
});
