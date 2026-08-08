// `phoebe add-repo <owner/repo> [--url] [--with-prompts] [--from-config]` —
// scaffold a tenant under `repos/<owner>/<repo>/` (host-side; #63/#95).

import type { ArgSpec } from "../arg-spec.ts";
import { parseArgs } from "../arg-spec.ts";
import { copyShippedPromptsInto } from "../init.ts";
import { addRepo, readFlatRepoFields, TRUST_DOMAIN_NOTE } from "../tenant-commands.ts";
import type { Command } from "./types.ts";

const ADD_REPO_USAGE =
  "Usage: phoebe add-repo <owner/repo> [--url <git-url>] [--with-prompts] [--from-config]";

/**
 * The permissive tenant-lifecycle grammar (add-repo / remove-repo / purge):
 * only `--flag` (two dashes) is a flag at all; any other `--flag` is
 * captured rather than rejected (none of these ever validated their flags),
 * and `--url` takes a value only when the next token isn't itself
 * flag-shaped — the guard this ticket unifies into one shared implementation
 * (`guardedValueFlags` in ../arg-spec.ts).
 */
const ADD_REPO_SPEC: ArgSpec = {
  flagPrefix: "--",
  guardedValueFlags: ["url"],
  onUnknownFlag: "capture",
};

export const addRepoCommand: Command = {
  name: "add-repo",
  summary: "phoebe add-repo <owner/repo>     Add a tenant (→ nested multi-tenant)",
  help: `phoebe add-repo — add a tenant

${ADD_REPO_USAGE}
`,
  async run(argv, ctx) {
    const { positionals, flags } = parseArgs(argv, ADD_REPO_SPEC);
    const slug = positionals[0];
    if (slug === undefined) {
      throw new Error(ADD_REPO_USAGE);
    }
    const configDir = ctx.cwd;
    const fromConfig = flags["from-config"] === true ? readFlatRepoFields(configDir) : {};
    const withPrompts = flags["with-prompts"] === true;
    const result = addRepo({
      configDir,
      slug,
      ...(typeof flags["url"] === "string" ? { repoUrl: flags["url"] } : {}),
      ...fromConfig,
      withPrompts,
      ...(withPrompts ? { seedPrompt: (dir: string) => copyShippedPromptsInto(dir) } : {}),
    });
    ctx.stdout.write(
      `[phoebe] add-repo ${slug} → ${result.tenantDir}\n` +
        result.created.map((p) => `    created ${p}`).join("\n") +
        `\n\nFill in ${result.tenantDir}/.env (copy .env.example). ` +
        `The running deployment picks it up on the next poll.\n`,
    );
    // Trust-domain note on every run — fires exactly when co-tenancy matters (#61/#63).
    ctx.stderr.write(`\n${TRUST_DOMAIN_NOTE}\n`);
    return 0;
  },
};
