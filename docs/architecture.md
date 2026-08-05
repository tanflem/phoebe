# Architecture

How Phoebe is put together: one container that is both orchestrator and
execution environment, an origin-hub git model with per-unit worktrees, a
locked-down agent child, and a bootstrapper that keeps the engine up to date.

For the day-to-day mechanics of each work kind, see
[`work-kinds.md`](work-kinds.md); for every config field, see
[`configuration.md`](configuration.md).

## Topology: one container, two roles

Phoebe ships as a **single Docker container** that is simultaneously:

- the **orchestrator** — the polling loop that picks the next unit of work
  (`src/main.ts`), and
- the **execution environment** — where the chosen agent CLI runs, installs
  dependencies, edits files, runs your gates, and pushes.

There is no host-spawns-sandboxes layer. Your host checkout is never touched:
the container owns a **private clone** of the target repo and pushes branches
directly to `origin`. The same image drives any repository because every
repo-specific value lives behind one config file
([`configuration.md`](configuration.md)).

The container is built from consumer-owned templates that `phoebe init`
scaffolds (`templates/container/`): a `Dockerfile` (Node 24 + git + `gh` + the
`phoebe-agent` bootstrapper), a `compose.yml`, and a dev-only `compose.local.yml`
overlay. The image carries the **bootstrapper**, not the engine: `phoebe boot` is
the container's long-lived main process, and it materializes the engine from the
source named by `engine` in `phoebe.config.ts`. Engine source is never vendored
into the consumer repo, and changing engine version is a config edit rather than
an image rebuild.

### Host vs. container

The engine detects whether it is running inside the container by the presence
of the marker file `/.phoebe-container` (`src/execution-gate.ts`). This gate is
load-bearing:

- **On the host**, only selection and `--dry-run` are allowed. `repoDir` is the
  current working directory; nothing is mutated, no agent launches, nothing
  pushes. Running a real unit on the host is **refused** with a clear message.
- **Inside the container**, execution proceeds and all git state lives in the
  private clone on the named volume.

Keeping selection logic host-runnable makes it fast to preview what Phoebe
_would_ do (`phoebe --dry-run --run-once`) without booting the container.

## Named volumes

Four named volumes hold all persistent state (declared in `compose.yml`; the
first three are defaulted in `config.paths`):

| Volume             | Mount             | Config field         | Holds                                                            |
| ------------------ | ----------------- | -------------------- | ---------------------------------------------------------------- |
| `phoebe-repo`      | `/data/repo`      | `paths.repoDir`      | The private clone (the origin hub).                              |
| `phoebe-worktrees` | `/data/worktrees` | `paths.worktreesDir` | Per-work-unit git worktrees.                                     |
| `phoebe-state`     | `/data/state`     | `paths.stateDir`     | Lock, watermarks, crash-loop state, logs.                        |
| `phoebe-engine`    | `/data/engine`    | `PHOEBE_ENGINE_DIR`  | Engine checkouts, so a restart re-fetches instead of re-cloning. |

The consumer's deployment directory (config, optional `prompts/`, and in
multi-tenant layouts the whole tenant tree) is mounted **read-only** into
`/etc/phoebe`, so `phoebe boot` re-reads config edits without a rebuild. Nested
(`repos/`) and workspace (linked children) both use that directory mount; see
[`workspace.md`](workspace.md) for workspace topology and the submodule
runbook.

All four mount points are created and chowned to the unprivileged `phoebe` user
**in the image**, because Docker seeds a fresh named volume from the image's
contents at that path — ownership included. A mount point the image does not
declare is created `root:root` and is unwritable to the workload. See the
scaffolded-file invariants in [`upgrading.md`](upgrading.md#scaffolded-file-invariants).

## The origin-hub git model

All local git state lives in the private clone; work units never operate on it
directly. Instead, each unit runs in its own **git worktree** created off the
clone (`src/git-model.ts`):

1. `ensureClone` clones `repoUrl` into `/data/repo` once; later cycles reuse it.
2. Each cycle `git fetch origin` refreshes the clone.
3. For a unit, `prepareWorktree` removes any stale worktree for the branch and
   adds a fresh one:
   - **Issues** — a new branch `<branchPrefix>issue-<n>` reset to the resolved
     base ref (`origin/main`, a blocker's branch when stacked, etc.).
   - **Conflicts / checks / reviews** — a worktree on the PR's existing head
     branch (local first, falling back to `origin/<branch>`).
4. The agent works inside the worktree; the engine counts new commits with
   `git rev-list --count <base>..HEAD`.
5. If there are new commits, `pushBranch` pushes straight to `origin`; the
   worktree is then removed in a `finally`.

Worktree directory names are derived from the branch, lowercased with
non-alphanumerics collapsed to `-`, so they are filesystem-safe and collision-
resistant. A failed unit never kills the daemon: `prepareWorktree` clears any
stale worktree on the next attempt.

## The agent child and its locked-down environment

The chosen provider runs as a **direct child process** of the engine, not a
nested container. Providers live in `src/providers/`; three are supported —
`cursor`, `claude`, and `codex` — each wrapping its CLI's argv and stream-JSON
output schema (`src/providers/providers.ts`). Provider and model are chosen per
run from `config.defaultProvider` / `config.defaultModels`, overridable with
`PHOEBE_AGENT` / `PHOEBE_MODEL`.

The child sees a **deliberately narrow env allowlist** (`src/agent-env.ts`):
`PATH`, `HOME`, `GH_TOKEN`, the git identity vars, `CI=true`, and **only the
active provider's API key**. The other providers' keys are never passed, so a
prompt-injected agent cannot exfiltrate the whole keyring.

Prompts are rendered from templates (`src/prompt.ts`): `{{KEY}}` placeholders
are substituted from config-derived args plus per-callsite args, and `` !`cmd` ``
shell blocks that appear in the _raw_ template are executed in the worktree and
spliced in. Shell blocks arriving via substituted values are treated as data,
never executed — a marker pass runs before substitution to guarantee it.

## Engine updates and crash-loop fallback

`phoebe boot` (`bootstrap/boot.ts`) is the container's long-lived main process,
and it stays in charge for the life of the container. There is no shell
supervisor and no engine self-update: the process that _chooses_ which engine
commit runs is the one that watches for a better one, so both live in the
bootstrapper.

**Reconcile.** Every `PHOEBE_RECONCILE_INTERVAL_MS` (default 60s) boot samples
the repository declaration, the generated base when `PHOEBE_BASE_CONFIG` is
set, and — for a `github` source tracking a branch — where that branch points
now (`git ls-remote`). When any input has moved away from what the running
engine was launched from, boot `SIGTERM`s the engine, which drains (finishes the
current work unit, starts no new one, exits 0), then re-resolves every config
layer and relaunches. An invalid changed base leaves the engine stopped while
boot reports the resolution error and retries; it never starts a partially
resolved replacement. The resolved non-secret configuration is handed to the
child as an immutable launch snapshot, preventing an edit between boot's source
selection and the engine's startup from mixing two authored states. Same
container, no interrupted unit. Comparing against the _launch_ rather than the
previous sample means a missed poll still converges and one change never
relaunches twice.

When a generated base is active, boot verifies the materialized engine carries
the version-1 `src/bootstrap-config-protocol.json` marker before spawning it.
This makes an older pinned engine an explicit compatibility error; without a
generated base, older refs remain runnable as before.

**Crash-loop fallback.** Following a branch means eventually following it onto a
commit that will not boot, so every launch passes the crash-loop guard
(`bootstrap/crash-loop.ts`). After `CRASH_LOOP_THRESHOLD` (3) consecutive _fast_
crashes of one engine SHA — a run that exits non-zero inside `HEALTHY_RUN_MS`
(60s) — boot quarantines that commit and materializes the **last SHA that ran
healthily** instead; the ref-watch then stops reading the branch tip as a change
for as long as it still points at the bad commit. Once the branch advances past
it (a fix landed), the quarantine lapses and reconcile resumes normally.

A finished run is judged three ways, not two: **healthy** (it outlived the
window, or exited 0 unprompted), **crash** (a fast non-zero exit of its own
accord), or **inconclusive** — boot cut it short for a reconcile or a container
stop, or a signal killed it. An inconclusive run moves nothing; treating one as
healthy would let a container stop landing mid-crash-loop promote the bad commit
and disarm the fallback for good. A commit that outlives the window is banked as
last-good **while it is still running**, so an engine up for weeks that is then
killed outright still leaves a fallback target behind.

The record — last-good SHA, quarantined SHA, crash count — is JSON in
`paths.stateDir` (`engine-crash-loop.json`), so it survives the container restart
a crash-looping engine causes. The guard is inert unless the engine ref is a
**moving branch** (a local mount has no commit to pin; a pinned SHA or tag means
the operator chose that exact commit, and quietly serving a different one would
be worse than crash-looping visibly) and inert with nothing known-good yet — a
first boot straight onto a broken ref exits and lets the container's restart
policy make the failure visible. See
[`configuration.md`](configuration.md#crash-loop-fallback).

## One cycle, end to end

```
reclaim stale `processingLabel` leases (#15; container + non-dry-run only)
      │
      ▼
gather work data for each kind in workOrder
      │
      ▼
selectFirstWorkUnit(workOrder) ──► first kind with a workable unit wins
      │
      ├─ nothing  ──► --run-once: exit · daemon: sleep pollInterval, repeat
      │
      ▼
execution gate (host = refuse · --dry-run = print · container = execute)
      │
      ▼
prepare worktree ─► install ─► run agent ─► count commits ─► push ─► open/update PR
      │
      ▼
--run-once: exit · daemon: repeat
```

The persistent daemon repeats this forever, idling `PHOEBE_POLL_INTERVAL_MS`
(default 300000) between empty cycles. `--run-once` works at most one unit of
the first one-shot-eligible kind (only `issues`) and exits — the janitor kinds
(`conflicts`, `checks`, `reviews`) are persistent-mode only.

For the `issues` kind specifically, "run agent" is bracketed by a claim: the
engine posts a lease marker comment and flips `readyLabel` → `processingLabel`
before the worktree is even prepared, and refreshes the marker's heartbeat
while the agent runs. If the runtime dies mid-run, the lease's heartbeat goes
stale and the next boot/cycle's reclaim step (above) flips the label back to
`readyLabel` — see [`configuration.md`](configuration.md) for the
`leaseTtlMs`/`PHOEBE_LEASE_TTL_MS` TTL and issue #15 for the full design.

## Provenance: the port and its hardening commits

The engine in `src/` was ported into this repo from
`JesusFilm/youtube-studio` (`apps/phoebe`) under issue #1 / PR #9. Issue #1's
acceptance criterion, echoed in the PR #9 description, was that "`src/` [be]
ported verbatim (behaviour-preserving)".

That "verbatim" framing is not literally true, and this note records why so the
history reads honestly. Two commits landed on the port branch during review as
responses to CodeRabbit findings — legitimate fixes, but genuine behaviour
changes on top of the verbatim copy:

- **`3b7951b`** — _fix: harden daemon against hangs, leaks, and bad input (PR #9
  review)_ — child-process timeouts, prompt-template resolution, and other
  hang/leak fixes rewriting ~470 lines of `src/main.ts`.
- **`86f2fce`** — _fix: bound resource resolution and watermark only observed
  review activity (PR #9 review)_ — bounds `resolvePackageFile`'s ancestor walk
  at the `node_modules` package boundary, and watermarks the pre-run thread
  snapshot so review feedback posted concurrently with a run is not silently
  marked handled.

PR #9 was squash-merged as `7a97fb2`, so these two commits are not individually
reachable from `main`; they survive only on the merged `phoebe/issue-1` branch.
The takeaway for anyone reading the port's history: the engine was ported
faithfully, but `src/main.ts` in particular was hardened at review and is not a
byte-for-byte copy of the youtube-studio original.
