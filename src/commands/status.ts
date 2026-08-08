// `phoebe status --json` — read the local status-v2 projection without
// starting work or contacting GitHub.

import { resolveConfigPath } from "../load-config.ts";
import { loadResolvedConfiguration } from "../config-resolution.ts";
import { ContractCapabilityError, STATUS_SCHEMA_VERSION } from "../status-contract.ts";
import { readStatusSnapshot } from "../status-store.ts";
import { parseCliArgs } from "./engine.ts";
import type { Command } from "./types.ts";

export type ParsedStatusArgs = { configPath: string | undefined; help: boolean };

export function parseStatusArgs(argv: readonly string[]): ParsedStatusArgs {
  const parsed = parseCliArgs(argv);
  const unknown = parsed.forward.filter((arg) => arg !== "--json");
  if (unknown.length > 0) {
    throw new Error(
      `Unknown status argument(s): ${unknown.join(", ")}. See \`phoebe status --help\`.`,
    );
  }
  if (!parsed.help && !parsed.forward.includes("--json")) {
    throw new Error("`phoebe status` requires --json.");
  }
  return { configPath: parsed.configPath, help: parsed.help };
}

export const STATUS_HELP_TEXT = `phoebe status — read the local runtime projection

Usage:
  phoebe status --json [--config <path>]

Reads paths.stateDir/status-v2.json without starting work or contacting GitHub.
On success, stdout is the exact snapshot. Missing or corrupt data is represented
as a stable JSON error object; unsupported major versions are explicit.
`;

export const statusCommand: Command = {
  name: "status",
  summary: "phoebe status --json             Read the local status-v2 projection",
  help: STATUS_HELP_TEXT,
  async run(argv, ctx) {
    const parsed = parseStatusArgs(argv);
    if (parsed.help) {
      ctx.stdout.write(STATUS_HELP_TEXT);
      return 0;
    }
    const configPath = resolveConfigPath(parsed.configPath, ctx.cwd);
    const resolved = await loadResolvedConfiguration(configPath, { env: ctx.env });
    try {
      const result = readStatusSnapshot(resolved.config.paths.stateDir);
      ctx.stdout.write(
        `${JSON.stringify(
          result.available
            ? result.status
            : {
                schemaVersion: STATUS_SCHEMA_VERSION,
                available: false,
                error: {
                  code: result.reason,
                  message: result.message,
                },
              },
          null,
          2,
        )}\n`,
      );
      return 0;
    } catch (error) {
      if (!(error instanceof ContractCapabilityError)) throw error;
      ctx.stdout.write(
        `${JSON.stringify(
          {
            schemaVersion: STATUS_SCHEMA_VERSION,
            available: false,
            error: {
              code: "unsupported-schema-major",
              supportedVersion: error.supportedVersion,
              receivedVersion: error.receivedVersion,
              message: error.message,
            },
          },
          null,
          2,
        )}\n`,
      );
      return 2;
    }
  },
};
