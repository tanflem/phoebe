# Contributing `stackMode` / native `blocked_by` upstream

**Outcome: yes.** Both features are ready to offer to `JesusFilm/phoebe` as two
separate, low-risk PRs, with one open risk flagged before the second lands. This
doc records the investigation behind that call (issue #8) so a future PR author
does not have to re-derive it.

## What shipped, where

| Gap                                   | PR                                               | Config surface                            |
| ------------------------------------- | ------------------------------------------------ | ----------------------------------------- |
| B — native `blocked_by` discovery     | [#9](https://github.com/tanflem/phoebe/pull/9)   | `blockerSource` (`PHOEBE_BLOCKER_SOURCE`) |
| A — native stacked PRs via `gh-stack` | [#10](https://github.com/tanflem/phoebe/pull/10) | `stackMode` (`PHOEBE_STACK_MODE`)         |

Both fork/main-only for now — `sync-fork` only pulls `JesusFilm/phoebe` → this
fork, never the other direction, so neither has reached upstream yet.

## Checklist from the issue

**`stackMode` defaults to `banner` — confirmed, no work needed.**
`CONFIG_DEFAULTS.stackMode` is `"banner"` (`src/config-schema.ts`), and
`resolveStackedPrPlan`'s `banner` branch is explicitly documented as
"today's behavior exactly." `blockerSource` defaults to `"body"` the same way.
Both features are opt-in; an upstream consumer who never sets either field sees
byte-for-byte the same behavior as today.

**Fork-specific assumptions — none found, and it's enforced, not just observed.**
`src/config-seam.test.ts` fails the build if any file under `src/` (excluding
the config layer itself) contains this fork's repo-specific literals
(`repoSlug`, `repoUrl`, `readyLabel`, `branchPrefix`) or a reference to the
reference consumer/toolchain (`youtube`, `JesusFilm`, `vp`). Both PRs' diffs
land entirely inside that guarded engine body (`src/orchestrator.ts`,
`src/main.ts`, `src/config-schema.ts`, `src/config-resolution.ts`,
`src/load-config.ts`) plus their own unit tests. The only non-`src/` file
either touched is `.phoebe/container/Dockerfile` — this repo's own **dogfood**
container, not shipped code — and its 6-line change is a comment mirroring the
one made to the shipped scaffold (`templates/container/Dockerfile`); it carries
no logic and needs no adaptation to travel upstream. `git grep tanflem` inside
`src/` turns up only two test fixture values (an example `prAuthors` login in
`config-schema.test.ts` / `orchestrator.test.ts`), not a behavioral assumption.

**Toolchain/container policy — already lazy, no `gh` version bump needed.**
The container installs `gh` from GitHub's own apt repo
(`templates/container/Dockerfile`), which always resolves to current stable —
there is no pinned version to bump. The `github/gh-stack` extension is not
baked into any image: `prepareNativeStackTooling` in `src/main.ts` installs it
(and sets `remote.pushDefault` / `rerere.enabled`) at boot, once, **guarded on
`stackMode === "native"`** — the default `banner`/`off` image and every
existing deployment that doesn't opt in pulls in zero new dependency. Both
Dockerfiles document baking the extension in instead, for operators who want it
offline.

**Contribution norms — two gaps found and fixed by this PR, tests already existed.**
Both #9 and #10 shipped unit tests alongside the code
(`config-resolution.test.ts`, `config-schema.test.ts`, `load-config.test.ts`,
`orchestrator.test.ts`, `orchestrator.ts:ghStackExtensionInstallArgs` covered by
`orchestrator.test.ts`). Two norms were missed and are fixed alongside this
investigation rather than left for the upstream PR to trip over:

- Neither PR added a changeset, so neither would have appeared in the next
  `CHANGELOG.md` version bump despite both being real, user-facing config
  additions. Added retroactively: `.changeset/native-blocked-by-discovery.md`,
  `.changeset/native-stacked-prs.md`.
- `docs/configuration.md` documented `blockedByPattern` but not its new
  sibling fields `blockerSource` / `stackMode`, nor their `PHOEBE_*` overlay
  vars — and `docs/work-kinds.md`'s base-resolution walkthrough still described
  only the pre-#9/#10 body-pattern-only, banner-only behavior. Both updated.

## One open risk — do not skip before the `native` PR

`src/main.ts` carries a `LIVE-VERIFY` marker on `registerNativeStack`:
`gh-stack` is (as of this writing) a two-day-old public-preview GitHub CLI
extension, and this codebase has not yet confirmed live that `gh stack link`
tolerates the trailing `-R <repo>` every call through this engine's `gh()`
wrapper appends, or that linking two branches that already have PRs never
clobbers their titles. Locally this is non-fatal by design — a failed
`gh stack link` leaves a working (if unregistered) stack and only logs a
warning — but an upstream maintainer reviewing "GitHub owns retarget-on-merge"
as a claimed behavior deserves that claim verified against a real repo first,
not just asserted from the extension's README. Do this before, not as part of,
the native-stacking upstream PR.

## Recommended plan

**Split into two upstream PRs, native `blocked_by` first.**

1. **PR 1 — native `blocked_by` discovery (`blockerSource`).** Self-contained:
   no new external tool, no new git config, no unresolved risk. Useful to
   upstream on its own even for consumers who never touch stacking.
2. **PR 2 — native stacked PRs (`stackMode`).** Depends on nothing from PR 1
   at the code level (`resolveWorktreeBase`'s stacking decision is orthogonal
   to how the blocker was discovered), but land it second anyway: it touches
   overlapping files (`config-schema.ts`, `config-resolution.ts`,
   `load-config.ts`), so sequencing avoids a rebase, and it's the riskier of
   the two (a public-preview `gh` extension) — worth letting the safer PR set
   the review pattern first. Do the live `gh stack link -R` verification above
   before opening it.

Each PR should carry: the corresponding source diff, its existing unit tests
unchanged, a changeset, and the relevant slice of the `docs/configuration.md` /
`docs/work-kinds.md` updates from this PR. Neither needs the `.phoebe/`
dogfood-Dockerfile comment — that's this fork's own container, not shipped
code.

This fork (`tanflem/phoebe`) is a genuine GitHub fork of `JesusFilm/phoebe`
(confirmed via `gh repo view`), so opening the PRs is mechanically a normal
cross-fork PR — no separate remote or access setup needed. Actually opening
them is left to a maintainer: it is a repo-visible action against a
third-party org's repository, outside what this issue asked an agent to do
unattended.
