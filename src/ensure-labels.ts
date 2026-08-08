// Boot-time label existence (#67). Every label the engine writes —
// `readyLabel`/`processingLabel` (the claim/reclaim flip, #15/#81),
// `researchLabel` (the wayfinder queue), `prOptOutLabel` (`ready-for-human`,
// the PR hand-back signal a human must be able to apply), and
// `PHOEBE_QUARANTINE_LABEL` (#75) — is a Phoebe-owned constant the user never
// types and has no reason to know exists. Nothing in this repo ever created
// them: docs/phoebe-core-onboarding.md documented creating three of the five
// *by hand*, and never mentioned quarantine at all, so a fresh repo silently
// drops every write against a label that doesn't exist yet (quarantine writes
// swallowed or uncaught; a missing `processingLabel` ejects claimed issues
// from the queue with no PR and no visible failure).
//
// `gh label create --force` is idempotent — it updates rather than errors
// when the label already exists — so this runs unconditionally once per
// process at startup (`ensureClone`'s neighbour in the boot sequence), not
// per write. The per-write placement was fine when the only caller was
// quarantine (rare by construction); `processingLabel` is written on every
// claim, and an extra round trip per claim is not free.

import { PHOEBE_QUARANTINE_LABEL } from "./quarantine.ts";

export type LabelSpec = {
  repoSlug: string;
  name: string;
  description: string;
  color: string;
};

/** Same shape as `main.ts`'s `gh` wrapper — injected so tests assert argv. */
export type GhRunner = (args: string[], opts?: { input?: string }, repo?: string) => void;

/**
 * The Phoebe-owned label set this engine writes, deduplicated by
 * `(repoSlug, name)` — `issueSource.repoSlug` and `repoSlug` are the same
 * repo in the common single-repo install, and `PHOEBE_QUARANTINE_LABEL`
 * applies to both issues (issue source) and PRs (work repo).
 */
export function phoebeLabelSet(config: {
  repoSlug: string;
  issueSource: { repoSlug: string; readyLabel: string };
  researchLabel: string;
  processingLabel: string;
  prOptOutLabel: string;
}): LabelSpec[] {
  const specs: LabelSpec[] = [
    {
      repoSlug: config.issueSource.repoSlug,
      name: config.issueSource.readyLabel,
      description: "Phoebe may pick this issue up",
      color: "0E8A16",
    },
    {
      repoSlug: config.issueSource.repoSlug,
      name: config.processingLabel,
      description: "Phoebe is working this issue",
      color: "FBCA04",
    },
    {
      repoSlug: config.issueSource.repoSlug,
      name: config.researchLabel,
      description: "Phoebe's wayfinder research queue",
      color: "1D76DB",
    },
    {
      repoSlug: config.repoSlug,
      name: config.prOptOutLabel,
      description: "Hand this PR back to a human — Phoebe skips it",
      color: "D93F0B",
    },
    {
      repoSlug: config.issueSource.repoSlug,
      name: PHOEBE_QUARANTINE_LABEL,
      description: "Phoebe quarantined this unit after repeated failures",
      color: "B60205",
    },
    {
      repoSlug: config.repoSlug,
      name: PHOEBE_QUARANTINE_LABEL,
      description: "Phoebe quarantined this unit after repeated failures",
      color: "B60205",
    },
  ];
  const seen = new Set<string>();
  return specs.filter((spec) => {
    const key = `${spec.repoSlug}#${spec.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `gh label create --force`, once per spec — safe to call unconditionally. */
export function ensureLabels(labels: readonly LabelSpec[], gh: GhRunner): void {
  for (const label of labels) {
    gh(
      [
        "label",
        "create",
        label.name,
        "--force",
        "--description",
        label.description,
        "--color",
        label.color,
      ],
      undefined,
      label.repoSlug,
    );
  }
}
