// `phoebe purge <owner/repo> --yes` — in-container, destructively wipe a
// *removed* tenant's retained data (#63/#95).

import type { ArgSpec } from "../arg-spec.ts";
import { parseArgs } from "../arg-spec.ts";
import { resolveDataBase } from "../paths.ts";
import { purgeTenant } from "../tenant-commands.ts";
import type { Command } from "./types.ts";

const PURGE_SPEC: ArgSpec = { flagPrefix: "--", onUnknownFlag: "capture" };

export const purgeCommand: Command = {
  name: "purge",
  summary: "phoebe purge <owner/repo> --yes  Wipe a removed tenant's data (in-container)",
  help: "phoebe purge — wipe a removed tenant's retained data\n\nUsage: phoebe purge <owner/repo> --yes\n",
  async run(argv, ctx) {
    const { positionals, flags } = parseArgs(argv, PURGE_SPEC);
    const slug = positionals[0];
    if (slug === undefined) throw new Error("Usage: phoebe purge <owner/repo> --yes");
    const { purged } = purgeTenant({
      configDir: ctx.cwd,
      dataBase: resolveDataBase(ctx.env),
      slug,
      confirm: flags["yes"] === true,
    });
    ctx.stdout.write(`[phoebe] purge ${slug} → wiped ${purged}\n`);
    return 0;
  },
};
