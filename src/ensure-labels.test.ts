// Boot-time label existence tests (#67): the Phoebe-owned label set is
// deduplicated by (repo, name), and `ensureLabels` issues one idempotent
// `gh label create --force` per spec against the right repo.

import { describe, expect, test } from "vite-plus/test";
import { ensureLabels, phoebeLabelSet, type GhRunner } from "./ensure-labels.ts";
import { PHOEBE_QUARANTINE_LABEL } from "./quarantine.ts";

const singleRepoConfig = {
  repoSlug: "o/r",
  issueSource: { repoSlug: "o/r", readyLabel: "ready-for-agent" },
  researchLabel: "wayfinder:research",
  processingLabel: "processing",
  prOptOutLabel: "ready-for-human",
};

describe("phoebeLabelSet", () => {
  test("single-repo install: one spec per label, quarantine deduplicated across repos", () => {
    const specs = phoebeLabelSet(singleRepoConfig);
    expect(specs.map((s) => `${s.repoSlug}#${s.name}`)).toEqual([
      "o/r#ready-for-agent",
      "o/r#processing",
      "o/r#wayfinder:research",
      "o/r#ready-for-human",
      `o/r#${PHOEBE_QUARANTINE_LABEL}`,
    ]);
  });

  test("split issue source: quarantine ensured on both the issue repo and the work repo", () => {
    const specs = phoebeLabelSet({
      ...singleRepoConfig,
      repoSlug: "o/work",
      issueSource: { repoSlug: "o/issues", readyLabel: "ready-for-agent" },
    });
    expect(specs.map((s) => `${s.repoSlug}#${s.name}`)).toEqual([
      "o/issues#ready-for-agent",
      "o/issues#processing",
      "o/issues#wayfinder:research",
      "o/work#ready-for-human",
      `o/issues#${PHOEBE_QUARANTINE_LABEL}`,
      `o/work#${PHOEBE_QUARANTINE_LABEL}`,
    ]);
  });

  test("every spec carries a --force-able description and color", () => {
    for (const spec of phoebeLabelSet(singleRepoConfig)) {
      expect(spec.description.length).toBeGreaterThan(0);
      expect(spec.color).toMatch(/^[0-9A-Fa-f]{6}$/);
    }
  });
});

describe("ensureLabels", () => {
  test("issues one `gh label create --force` call per spec, scoped to its repo", () => {
    const calls: Array<{ args: string[]; repo?: string }> = [];
    const runner: GhRunner = (args, _opts, repo) => {
      calls.push({ args, repo });
    };
    ensureLabels(
      [
        {
          repoSlug: "o/r",
          name: "processing",
          description: "Phoebe is working this issue",
          color: "FBCA04",
        },
      ],
      runner,
    );
    expect(calls).toEqual([
      {
        args: [
          "label",
          "create",
          "processing",
          "--force",
          "--description",
          "Phoebe is working this issue",
          "--color",
          "FBCA04",
        ],
        repo: "o/r",
      },
    ]);
  });

  test("a claim and a quarantine both succeed on a repo where neither label exists yet", () => {
    const existing = new Set<string>();
    const runner: GhRunner = (args, _opts, repo) => {
      if (args[0] === "label" && args[1] === "create") {
        existing.add(`${repo}#${args[2]}`);
        return;
      }
      if (args[2] === "--add-label") {
        if (!existing.has(`${repo}#${args[3]}`)) {
          throw new Error(`'${args[3]}' not found`);
        }
      }
    };

    ensureLabels(phoebeLabelSet(singleRepoConfig), runner);

    expect(() =>
      runner(["issue", "edit", "1", "--add-label", "processing"], undefined, "o/r"),
    ).not.toThrow();
    expect(() =>
      runner(["issue", "edit", "1", "--add-label", PHOEBE_QUARANTINE_LABEL], undefined, "o/r"),
    ).not.toThrow();
  });

  test("a failing create call stops the sweep and propagates — boot fails loud rather than starting half-labelled", () => {
    const calls: string[] = [];
    const runner: GhRunner = (args) => {
      calls.push(args[2]!);
      if (args[2] === "processing") throw new Error("network error");
    };
    expect(() =>
      ensureLabels(
        [
          { repoSlug: "o/r", name: "ready-for-agent", description: "d", color: "0E8A16" },
          { repoSlug: "o/r", name: "processing", description: "d", color: "FBCA04" },
          { repoSlug: "o/r", name: "wayfinder:research", description: "d", color: "1D76DB" },
        ],
        runner,
      ),
    ).toThrow("network error");
    expect(calls).toEqual(["ready-for-agent", "processing"]);
  });
});
