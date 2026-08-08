// The per-tenant tagging invariant (#62, closing the gap #73 left open): every
// line the engine's stdout/stderr streams carry a tenant slug —
// `[phoebe:<slug>]` — never the bare, un-attributable `[phoebe]` a host log
// collector multiplexing several repos onto one container's stdout cannot
// resolve back to a repo. `runtime-status.ts` already asserts this for the
// event rail's own transitions (#60); this sweeps the rest of the engine so a
// bare prefix reintroduced anywhere is a test failure, not a silent regression.

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, test } from "vite-plus/test";

const srcDir = join(import.meta.dirname, ".");

// `cli.ts` and `init.ts` are operator-invoked admin commands (add-repo,
// remove-repo, list, purge, phoebe init) whose output is read directly in a
// terminal, not collected off the per-tenant container stdout stream this
// invariant governs — `list` in particular reports on every tenant at once, so
// no single slug applies. The bootstrapper (`bootstrap/`, a separate component
// per AGENTS.md) has its own fleet-wide `[phoebe] boot: ...` log lane and is
// out of scope for this engine-only invariant.
const EXEMPT_FILES = new Set(["cli.ts", "init.ts"]);

function walkSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

// Drops comment lines so prose that merely *discusses* the bare tag (like this
// file's own header, or runtime-status.ts's design notes) doesn't trip the check.
function nonCommentLines(source: string): string[] {
  return source.split("\n").filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
  });
}

describe("per-tenant tagging invariant", () => {
  test("no engine source file emits a bare [phoebe] prefix", () => {
    for (const file of walkSourceFiles(srcDir)) {
      if (EXEMPT_FILES.has(basename(file))) continue;
      const bareLines = nonCommentLines(readFileSync(file, "utf8")).filter((line) =>
        /\[phoebe\](?!:)/.test(line),
      );
      expect(bareLines, `${file} has a bare [phoebe] prefix:\n${bareLines.join("\n")}`).toEqual([]);
    }
  });
});
