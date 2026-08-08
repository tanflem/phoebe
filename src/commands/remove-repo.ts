// `phoebe remove-repo <owner/repo>` — delete a tenant's config dir
// (reversible; its retained /data is untouched, #62).

import type { ArgSpec } from "../arg-spec.ts";
import { parseArgs } from "../arg-spec.ts";
import { removeRepo } from "../tenant-commands.ts";
import type { Command } from "./types.ts";

const REMOVE_REPO_SPEC: ArgSpec = { flagPrefix: "--", onUnknownFlag: "capture" };

export const removeRepoCommand: Command = {
  name: "remove-repo",
  summary: "phoebe remove-repo <owner/repo>  Remove a tenant's config (data retained)",
  help: "phoebe remove-repo — remove a tenant's config\n\nUsage: phoebe remove-repo <owner/repo>\n",
  async run(argv, ctx) {
    const { positionals } = parseArgs(argv, REMOVE_REPO_SPEC);
    const slug = positionals[0];
    if (slug === undefined) throw new Error("Usage: phoebe remove-repo <owner/repo>");
    const { removed } = removeRepo({ configDir: ctx.cwd, slug });
    ctx.stdout.write(
      `[phoebe] remove-repo ${slug} → deleted ${removed}\n` +
        `Its /data is retained (reversible). \`phoebe purge ${slug} --yes\` reclaims it.\n`,
    );
    return 0;
  },
};
