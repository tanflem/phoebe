# Work kinds

Every cycle Phoebe walks `config.workOrder` and runs **one** unit of the first
kind that has workable work. There are five kinds: three **janitors** that keep
open PRs moving (`conflicts`, `checks`, `reviews`) and two **producers** that
start new work (`issues`, and `research` for wayfinder research tickets). This
file documents how each selects and executes a unit. Field references point at
[`configuration.md`](configuration.md); the runtime plumbing is
`src/orchestrator.ts` and `src/main.ts`.

## The poll loop and `workOrder`

```yaml
workOrder: ["conflicts", "checks", "reviews", "issues", "research"] # default
```

Each cycle the engine gathers work data for every kind, then
`selectFirstWorkUnit` returns the first kind (in `workOrder` order) that yields a
unit. Order is priority: with the default, a conflicting PR is reconciled before
a red-CI PR, which is handled before review feedback, which is handled before a
brand-new issue is picked up, which is handled before a research ticket. That
keeps already-open work flowing rather than piling up new branches.

- **Persistent mode** (no flags) runs all kinds and sleeps
  `PHOEBE_POLL_INTERVAL_MS` (default 300000) between empty cycles.
- **`--run-once`** works at most one unit of the first _one-shot-eligible_ kind
  and exits. `issues` and `research` are one-shot-eligible; the three janitor
  kinds are **persistent-mode only**. Under `--run-once` with nothing to work,
  Phoebe prints "Nothing to do" and exits.
- **`--dry-run`** prints the unit it would pick without executing (host-safe).

A failed unit in persistent mode is logged and skipped; the daemon continues to
the next cycle. Under `--run-once`, a failure throws.

## Which PRs the janitors scan

All three janitors scan open PRs based on the same scope rules (`isPrInScope`):

1. **Cross-repository PRs (forks) are always excluded.**
2. PRs carrying `prOptOutLabel` (default `ready-for-human`) are excluded.
3. If `prScope` is `"phoebe"`, only `branchPrefix` branches qualify; `"all"`
   admits any same-repo PR.
4. If `prAuthors` is non-empty, only PRs authored by one of those GitHub logins
   qualify.
5. If `prBaseScope` is `"default"`, only PRs targeting `defaultBranch` qualify;
   `"all"` also admits stacked PRs targeting another same-repo branch.
6. Drafts are filtered by `draftPrs`: `skip-all` drops every draft;
   `skip-non-phoebe` drops drafts on non-Phoebe branches; `include` keeps them.

For stacked PRs, conflict and behind-branch catch-up merges use that PR's actual
base branch rather than `defaultBranch`.

## `issues` — start new work

The producer. Selection (`selectIssue`):

1. List open issues labelled `readyLabel`, oldest-created first.
2. Sort by **priority** then age then number. Priority is inferred from the
   title + body text: `bug` (bug/broken/crash/regression/fix) → `tracer`
   (tracer/wire/poc) → `polish` (default) → `refactor`.
3. For each candidate in order, resolve a worktree base; take the first issue
   that resolves.

**Base resolution** (`resolveWorktreeBase`) handles blockers:

- `PHOEBE_BASE` set → use it verbatim (escape hatch, no blocker logic).
- No blocker reference → base `origin/main`.
- Blocked, blocker PR **open** → **stack** on `origin/<blocker branch>` (unless
  `stackMode` is `off` — see below).
- Blocked, blocker PR **merged** → base `origin/main` (blocker work is already
  in the base).
- Blocked, blocker has **no** open or merged PR → **skip** this cycle.

Blockers are discovered per `blockerSource`: `body` (default) parses
`blockedByPattern` over the issue body text (capture group 1 = blocker issue
number); `native` reads GitHub's issue-dependencies API instead; `both` unions
and deduplicates the two.

`stackMode` decides what a **stacked** result means for the PR (`resolveStackedPrPlan`):

- `banner` (default) — today's behavior, unchanged. The PR is opened against
  `defaultBranch` with a ⛓️ banner warning not to merge before the blocker;
  maintenance flows catch the branch up to `main` as blockers merge.
- `native` — the PR is opened against the blocker's branch instead and
  registered into a true GitHub stacked PR via `gh stack link` (bottom-to-top),
  so the diff shows only this issue's commits and GitHub owns retarget-on-merge.
  No banner. Needs the `github/gh-stack` extension — see
  [`configuration.md`](configuration.md#native-stacking-tooling).
- `off` — never stacked. A blocker still gates the skip decision above, but the
  branch is cut from `origin/main` and the PR opened against `defaultBranch`
  with no banner.

**Execution** (`runOneIssue`):

1. Create branch `<branchPrefix>issue-<n>` off the resolved base in a worktree.
2. Run `installCommand`, then the agent with the `issue` prompt
   (`{{ISSUE_NUMBER}}` supplied).
3. Count commits since the base. If zero, no PR is created.
4. Push. If no open PR exists for the branch, open one titled
   `Phoebe: <issue title> (#<n>)` with body `Closes #<n>` (plus the stacked
   banner when applicable); otherwise post a follow-up note.

The issue prompt has the agent **claim** the issue first — swap `readyLabel` for
`processingLabel` — so parallel operators and humans see it is in flight.

## `research` — resolve wayfinder research tickets

The second producer. It picks up **wayfinder research tickets** — open issues
labelled `researchLabel` (default `wayfinder:research`), which in wayfinder are
child issues of a `wayfinder:map` (the engine keys off the label alone, not the
parent-map relationship) — and follows
[wayfinder's](../.agents/skills/wayfinder/SKILL.md) resolution protocol:
investigate primary sources, produce a Markdown summary, post a resolution
comment, close the ticket, and append a pointer to the map's _Decisions so far_.

Selection **reuses the `issues` path** (`selectIssue`) against the
`researchLabel`-tagged open issues rather than the `readyLabel` set: same
priority/age ordering, same `Blocked by #N` handling and base resolution
(blocked tickets with no blocker PR are skipped this cycle). It is _not_ full
wayfinder-native selection — no querying of map children, no GitHub native
`blocked-by`, no assignment-as-claim; those are follow-ups. Double-work
avoidance relies on branch/PR existence, same as `issues`.

**Execution** reuses `runOneIssue` with the `research` prompt: branch off the
resolved base, run the agent, and — **only when the agent left commits** — push
and open a PR. The output shape is adaptive, decided by the prompt rather than
the engine:

- **Issue-level artifact (default):** the prompt posts the summary/answer as a
  comment, closes the ticket, and updates the map. No commits → no PR.
- **Committed doc (PR):** when the finding naturally belongs in the repo, the
  prompt writes and commits the doc; the engine pushes and opens a PR whose body
  closes the ticket on merge.

The engine stays **map-agnostic** — it only selects the ticket, allocates the
worktree, and runs the prompt; the resolution comment, close, and map update all
happen inside the prompt. Disable the kind for a repo by omitting `research` from
`workOrder`.

## `conflicts` — reconcile PRs that conflict with the base

Selection (`selectConflictUnit` → oldest eligible PR number):

1. Scan in-scope open PRs; a PR is a candidate when `mergeable` is
   `CONFLICTING`, or `UNKNOWN` while `mergeStateStatus` is `DIRTY` (GitHub may
   still be computing mergeability — the engine retries a few times).
2. Skip PRs whose issue is **stacked on an open blocker** — divergence from the
   base is expected there, not a real conflict.
3. Skip PRs whose latest **failure watermark** matches the current PR head _and_
   base head — a prior fix attempt already failed against this exact pair, so
   retrying would loop until either side moves.

**Execution** (`fixOnePrConflict`):

1. Compute merged-blocker PR numbers for stacked catch-up (bottom-up order).
2. Try a **clean, agent-free merge** first: merge each merged-blocker PR head,
   then `origin/<defaultBranch>`, and push. If it succeeds, done (a stacked
   catch-up posts a retraction comment noting the branch is now independently
   mergeable).
3. If the clean merge conflicts, hand off to the agent with the `conflict`
   prompt (worktree pre-staged with the attempted merge; `BLOCKER_PR_NUMBERS`
   supplied). The agent resolves, verifies, and pushes.
4. If neither the agent nor the merge produced commits and the PR still
   conflicts, post a failure comment carrying a fresh watermark
   (`prHead` + `mainHead`) and leave the branch untouched for a human.

## `checks` — fix failing CI

Check state comes from the REST Actions API (`gh run list`), not GraphQL
`statusCheckRollup`, because fine-grained PATs cannot read the rollup. Only the
newest run per workflow counts; a rollup is `FAILURE` only when at least one
check failed and **none are pending**.

Selection (`selectChecksUnit` → oldest eligible PR number):

1. Scan in-scope open PRs; candidate when the combined rollup is `FAILURE`.
2. Skip conflicting PRs (those belong to `conflicts`).
3. Skip stacked-on-open-blocker PRs and watermarked PRs (`prHead` unchanged
   since the last failed attempt).

**Execution** (`fixOnePrChecks`):

1. If the PR is `BEHIND` the base, try a clean catch-up merge first (including
   merged-blocker PRs); if that conflicts, defer to the `conflicts` kind next
   cycle.
2. Otherwise run the agent with the `checks` prompt; the formatted list of
   failing checks is passed as `{{FAILING_CHECKS}}`.
3. Push new commits. If the agent produced nothing and origin is unchanged, post
   a failure comment with a `prHead` watermark.

## `reviews` — address review-thread feedback

Selection (`selectReviewsUnit` → oldest eligible PR number). This kind needs the
bot's own GitHub login (`phoebeLogin`), fetched once per cycle:

1. Scan in-scope open PRs, page through all `reviewThreads`.
2. A PR qualifies when it has **new, unresolved, non-outdated** thread activity
   from someone **other than Phoebe and other than the PR author**, newer than
   the PR's `handled` watermark.
3. Skip conflicting PRs and stacked-on-open-blocker PRs.

**Execution** (`fixOnePrReviews`):

1. Run the agent with the `reviews` prompt. It triages every unresolved thread,
   makes code changes where needed, and posts a summary comment containing
   `reviewsSuccessHeading`.
2. Push new commits (or detect the agent already pushed).
3. Post a `handled` watermark comment stamped with the newest activity time from
   the **pre-run** snapshot — so feedback posted _during_ the run is not marked
   handled and correctly re-selects the PR next cycle. If the agent produced no
   summary and no push, the comment notes the failure and Phoebe retries on new
   activity.

## Watermarks

Janitors record their progress as **hidden HTML-comment markers** on the PR so
state survives across daemon restarts (nothing is kept in memory between
cycles). The parser reads comments newest-first and takes the first marker it
finds, so **the latest matching marker wins** when several exist — deleting the
newest one falls back to the next-newest, not to a clean slate. To reset state,
move whatever the marker is keyed on (see the table below) or remove the newest
matching comment. See [`operating.md`](operating.md#watermark-comments) for the
operator's view.

| Kind        | Marker                   | Keyed on                    | Effect                                                |
| ----------- | ------------------------ | --------------------------- | ----------------------------------------------------- |
| `conflicts` | `phoebe-conflict-fail`   | `prHead` + `mainHead`       | Skip re-fixing until either the PR or the base moves. |
| `checks`    | `phoebe-checks-fail`     | `prHead`                    | Skip re-fixing until the PR head moves.               |
| `reviews`   | `phoebe-reviews-handled` | `latest` activity timestamp | Only re-run on review activity newer than this.       |

</content>
