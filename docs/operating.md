# Operating Phoebe as a human

The canonical operator manual: how a person steers Phoebe using GitHub itself —
labels, draft state, and the comment watermarks it leaves behind. There is no
separate control plane; **you drive Phoebe by changing the issues and PRs it
looks at.**

This manual is written against **config field names** (`readyLabel`,
`prOptOutLabel`, …) rather than literal strings, because every consumer sets its
own values. Look up your repo's concrete strings in its `phoebe.config.ts`, or
have each consumer keep a short "concrete values" card next to this manual. The
defaults are shown in parentheses throughout.

## The core idea

Phoebe polls the repo and, each cycle, works one unit of the first workable kind
in `workOrder`. It only ever acts on:

- **Issues** labelled `readyLabel`,
- **Wayfinder research tickets** labelled `researchLabel` (default
  `wayfinder:research`), when `research` is in `workOrder`, and
- **Open PRs in scope** (see `prScope` / `draftPrs` / `prOptOutLabel`).

So every lever below is just a way of adding or removing an issue/PR from those
sets, or of telling Phoebe "a human has this now." Research tickets are selected
the same way as ready issues (priority, age, `Blocked by #N`); see
[`work-kinds.md`](work-kinds.md#research--resolve-wayfinder-research-tickets).

## Starting a unit of work: `readyLabel`

Add `readyLabel` (default `ready-for-agent`) to an issue and Phoebe will pick it
up when it reaches the front of the queue. To influence _which_ ready issue goes
first:

- **Priority** is inferred from the title/body text: wording like _bug, broken,
  crash, regression, fix_ sorts first; _tracer, wire, poc_ next; then ordinary
  _polish_; then _refactor_ last.
- Within a priority, **older issues win** (oldest created, then lowest number).

To pause an issue without deleting it, just remove `readyLabel`. Phoebe never
touches an unlabelled issue.

### `processingLabel` means "in flight"

When Phoebe claims an issue it swaps `readyLabel` for `processingLabel` (default
`processing`) as its first action. If you see `processingLabel`, a run is (or
was) working that issue — don't start on it yourself. If a run dies and leaves
the label stranded, remove `processingLabel` and re-add `readyLabel` to requeue.

## Blocking one issue on another: `blockedByPattern`

Write a blocker reference in the issue body — by default `Blocked by #123`
(matched by `blockedByPattern`). Phoebe then:

- **skips** the issue while the blocker has no PR yet,
- **stacks** the new branch on the blocker's branch while the blocker's PR is
  open (the resulting PR carries a ⛓️ "do not merge before #123" banner), and
- bases on the default branch normally once the blocker's PR has **merged**.

This lets you queue a dependent chain of issues at once and let Phoebe sequence
them.

## Taking a PR back: `prOptOutLabel`

Add `prOptOutLabel` (default `ready-for-human`) to any PR and Phoebe drops it
from **all** janitor scans — no conflict fixes, no CI fixes, no review handling.
This is the "I've got this one" switch. Remove the label to hand it back.

## Draft PRs as hands-off: `draftPrs`

Draft state is a second, lighter opt-out governed by `draftPrs`:

| `draftPrs`                  | Effect on drafts                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `skip-non-phoebe` (default) | Drafts on non-Phoebe branches are off-limits; Phoebe's own drafts are still worked. |
| `skip-all`                  | Phoebe never touches any draft.                                                     |
| `include`                   | Drafts are fair game like any other PR.                                             |

With the default, **marking someone else's PR a draft takes it off Phoebe's
plate** without needing the opt-out label. Mark it ready-for-review to hand it
back.

## Which PRs Phoebe considers at all: `prScope`

- `prScope: "phoebe"` (default) — Phoebe only maintains its own
  `branchPrefix` (default `phoebe/`) branches.
- `prScope: "all"` — Phoebe maintains _every_ same-repo PR (still honouring
  `prOptOutLabel`, `draftPrs`, and the fork exclusion).

Cross-repository PRs from forks are **always** excluded.

## Watermark comments

Phoebe keeps no memory between cycles; it records janitor progress as hidden
HTML-comment markers on the PR. You normally never see them, but they explain
"why isn't Phoebe re-fixing this?":

| Marker                   | Meaning                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `phoebe-conflict-fail`   | A conflict fix already failed against this exact PR-head + base-head pair; Phoebe waits for either side to move before retrying. |
| `phoebe-checks-fail`     | A CI fix already failed at this PR head; Phoebe waits for a new push before retrying.                                            |
| `phoebe-reviews-handled` | Review feedback up to a timestamp was handled; Phoebe only re-runs on newer review activity.                                     |

**To force a retry**, move the thing the watermark is keyed on: push a commit
(new PR head), merge/advance the base branch, or post fresh review activity.
Because the marker lives in a PR comment, you can also delete it — but the
parser takes the **newest** matching marker, so deleting a failure comment only
resets state when it removes that newest one; an older matching marker still
underneath it will keep applying. When a janitor gives up it posts a **visible**
failure comment too, so a human knows to step in.

## Running modes

| Invocation             | Behaviour                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------- |
| no flags (the default) | Persistent poll loop; all kinds; idles `PHOEBE_POLL_INTERVAL_MS` (300000).         |
| `--run-once`           | One `issues` or `research` unit then exit. Janitor kinds are persistent-mode only. |
| `--dry-run --run-once` | Print the unit that _would_ be picked (host-safe, nothing executes).               |

Flags go after the compose service name (`docker compose run --rm phoebe
--run-once`); `phoebe boot` forwards them to the engine it launches. No flags is
the deployed shape — `docker compose up -d` runs the persistent loop.

`--dry-run` is the safe way to preview selection on your host without booting
the container. See [`upgrading.md`](upgrading.md) for start/stop/upgrade
commands and [`work-kinds.md`](work-kinds.md) for the full selection rules.

## One-off overrides without editing config

Most scalar fields have a `PHOEBE_*` env override for a single run — e.g.
`PHOEBE_AGENT=claude`, `PHOEBE_PR_SCOPE=all`, `PHOEBE_POLL_INTERVAL_MS=60000`.
See the [environment overlay table](configuration.md#environment-overlay-phoebe_).

## Quick reference

| I want to…                                    | Do this                                                                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue an issue for Phoebe                     | Add `readyLabel` (`ready-for-agent`).                                                                                                         |
| Pause a queued issue                          | Remove `readyLabel`.                                                                                                                          |
| Bump an issue up the queue                    | Word it as a bug/fix, or it waits its turn by age.                                                                                            |
| Sequence-dependent issues                     | `Blocked by #N` in the body.                                                                                                                  |
| Take a PR away from Phoebe                    | Add `prOptOutLabel` (`ready-for-human`) — works for any PR. Under the default `draftPrs`, marking a **non-Phoebe** PR draft also opts it out. |
| Hand a PR back                                | Remove the label / mark ready-for-review.                                                                                                     |
| Force a janitor to retry                      | Push, advance the base, post new review feedback, or delete the newest failure comment.                                                       |
| Let Phoebe maintain all PRs, not just its own | `prScope: "all"`.                                                                                                                             |

## Running many repos in one container

One container can serve several repos as **tenants**. The supervisor runs one
engine child per tenant and reconciles the set on every poll — **no restart** to
add or remove one. There are two discovery layouts:

- **Nested** — directories under `repos/<owner>/<repo>/` (this section).
- **Workspace** — child checkouts under a root that declares
  `workspace: { depth }` (plain clones or submodules). Full topology + runbook:
  [`workspace.md`](workspace.md).

Read [`trust.md`](trust.md) first: co-locating repos means co-locating them in
one trust domain.

| Action                                                   | How                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a repo                                               | `phoebe add-repo <owner/repo>` (host-side, in the deployment dir). Creates `repos/<owner>/<repo>/`; the supervisor discovers it next poll. Fill in its `.env`.                                                                                                                                                        |
| Migrate a flat deployment's fields down                  | `phoebe add-repo <owner/repo> --from-config` copies the top config's install/check/test commands into the new tenant.                                                                                                                                                                                                 |
| Remove a repo                                            | `phoebe remove-repo <owner/repo>` (host-side). Reversible — the tenant's `/data` is retained; re-adding re-uses it.                                                                                                                                                                                                   |
| Reclaim a removed repo's disk                            | `phoebe purge <owner/repo> --yes` (in-container). Destructive; refuses while a live config still exists.                                                                                                                                                                                                              |
| See every tenant + its health                            | `phoebe list` (in-container): config present? `.env` present? retained data? current state from each tenant's status-v2 snapshot — distinguishes `draining`, `stopped`, and `failed` from `idle`, and reports an unreadable or newer-major-version snapshot explicitly rather than showing "no status" for all three. |
| See every tenant across several containers, in a browser | `phoebe serve [--port N] [--state-dir DIR]...` — one read-only HTML page, one row per tenant (lifecycle, active work, last outcome, snapshot age) plus its queue lookahead. Binds to localhost only; reads snapshots fresh on every request, never writes.                                                            |

**Concurrency across tenants.** Only `PHOEBE_MAX_CONCURRENT_AGENTS` work units
(default **1**) execute at once across the whole fleet — a supervisor-brokered,
FIFO round-robin cap so N repos don't thrash the host. Idle polling stays
per-repo and parallel.

**Reading the logs.** Every line is tagged `[phoebe:<owner>/<repo>]` (the
supervisor tags its own `[phoebe:supervisor]`), so a host log collector can
attribute each line to its tenant. Agent output nests: `[phoebe:<slug>] [cursor] …`.
The container writes no log files — stdout is the whole story.

**When a unit hangs.** A work unit that exceeds its wall-clock budget
(`PHOEBE_RUN_TIMEOUT_MS`, default 45 min) is aborted so it can't starve the
fleet, and the engine moves on. A unit that hangs **every** time is quarantined
after `PHOEBE_MAX_UNIT_TIMEOUTS` (default 3) consecutive timeouts: Phoebe applies
a `phoebe:quarantined` label and posts one escalation comment asking for a human.
Remove the label to retry, or push a fix / edit the issue — Phoebe auto-clears
the label when the content advances.

</content>
