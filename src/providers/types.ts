// Agent provider contract — how Phoebe invokes a coding-agent CLI and reads
// its output stream. Ported from Sandcastle's AgentProvider design (Matt
// Pocock, https://github.com/mattpocock/sandcastle — the design ancestor of
// this engine), trimmed to what Phoebe uses: one print-mode run per work unit,
// no session capture, no interactive mode.

import type { ProviderName } from "../config/index.ts";

/** A ready-to-spawn CLI invocation. `argv[0]` is the binary; no shell involved. */
export type AgentCommand = {
  readonly argv: readonly string[];
  /** When set, piped to the child's stdin (large prompts don't fit argv). */
  readonly stdin?: string;
};

/** Events parsed from one line of the agent's JSONL output stream. */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "result"; result: string }
  | { type: "tool_call"; name: string; args: string };

export type Provider = {
  readonly name: ProviderName;
  buildCommand(opts: { prompt: string; model: string }): AgentCommand;
  parseStreamLine(line: string): AgentEvent[];
};
