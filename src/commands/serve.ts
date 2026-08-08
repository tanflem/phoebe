// `phoebe serve [--port N] [--state-dir DIR]...` — a read-only HTML fleet
// view (#24). Starts an HTTP server and returns once it is listening; the
// open socket (not this promise) is what keeps the process alive, so this
// command never resolves during normal operation.
//
// `../serve.ts` already owns its own argv parser (`parseServeArgs`) — it
// predates this ticket's seven-parser cleanup and wasn't one of them, so it
// stays as-is rather than being folded into the shared tokenizer for no
// behavioral gain.

import { once } from "node:events";
import { DEFAULT_SERVE_HOST, parseServeArgs, SERVE_HELP_TEXT, startServeServer } from "../serve.ts";
import type { Command } from "./types.ts";

export const serveCommand: Command = {
  name: "serve",
  summary:
    "phoebe serve [--port N]          Serve a read-only fleet page (see --help)\n    [--state-dir DIR]...",
  help: SERVE_HELP_TEXT,
  async run(argv, ctx) {
    const parsed = parseServeArgs(argv, ctx.env);
    if (parsed.help) {
      ctx.stdout.write(SERVE_HELP_TEXT);
      return 0;
    }
    const server = startServeServer({ port: parsed.port, stateDirs: parsed.stateDirs });
    await once(server, "listening");
    const address = server.address();
    const port = address !== null && typeof address === "object" ? address.port : parsed.port;
    ctx.stdout.write(
      `[phoebe] serve listening on http://${DEFAULT_SERVE_HOST}:${port}/\n` +
        `    state dirs: ${parsed.stateDirs.join(", ")}\n`,
    );
    return 0;
  },
};
