# phoebe-agent

## 0.2.0

### Minor Changes

- 8bbfa25: Multi-tenant Phoebe: run one container that supervises many repos (map #57). A
  single deployment can now discover a fleet of tenants from
  `/etc/phoebe/repos/<owner>/<repo>/` — each with its own `phoebe.config.ts` and
  `.env` — and run one supervised engine child per tenant behind a global
  concurrency cap, per-tenant `[phoebe:<slug>]` log tagging, per-tenant
  `state/<slug>/status.json`, and `phoebe list`. Env-scrub isolation hands each
  child only its own secrets. The flat single-tenant layout still works
  unchanged; nested discovery is additive.
- 8bbfa25: Wire the poison-unit quarantine write path into the engine (#75/#80). A unit of
  work that repeatedly fails is now quarantined rather than retried indefinitely,
  keeping a poison ticket from stalling the fleet.
- 8bbfa25: Workspace discovery mode (map #81): run `phoebe` at the root of a workspace
  whose child repos are linked as submodules, each carrying its own in-tree
  Phoebe install (config + gitignored `.env`). Phoebe walks the tree, reads each
  child's config, and feeds the same tenant abstraction as multi-tenant mode —
  one supervised engine child per tenant, still cloning each repo privately (the
  local checkout is a discovery + config source only). A `workspace: { depth }`
  block in the root `phoebe.config.ts` selects the mode. Highlights:

  - Discover and supervise a fleet from the submodule tree, reconciling on every
    poll as children come and go.
  - Child `repoSlug` stays authoritative; the submodule `origin` is a best-effort
    cross-check, and duplicate slug/origin across the fleet is a fatal boot abort.
  - `phoebe list` and per-tenant status surface workspace tenants.
  - Two new scaffolder profiles: `phoebe init --workspace` (root) and
    `phoebe init --tenant` (child, prefilling `repoSlug`/`repoUrl` from the
    child's `origin`).
  - Topology docs and an operator runbook for the workspace layout.

### Patch Changes

- 8bbfa25: Bound `superviseFleet.drain` with a SIGKILL escalation (#79). Draining the fleet
  on shutdown no longer hangs indefinitely on a child that ignores SIGTERM — the
  supervisor escalates to SIGKILL after a bounded grace period.
- 8bbfa25: Let the conflict-resolution agent drop relocated or superseded hunks (#89)
  instead of forcing every hunk to apply, so a rebase whose changes have moved or
  already landed upstream resolves cleanly.
- 8bbfa25: Fix two container-boot blockers surfaced by dogfooding: the Corepack download
  prompt hanging boot, and the agent child's `0711` permissions preventing it from
  running.

## 0.1.1

### Patch Changes

- 9b8cb25: Authenticate git against private repos at boot. When `GH_TOKEN` is set,
  `phoebe boot` runs `gh auth setup-git --hostname github.com` once before
  supervising the engine, so `ensureClone`, engine fetch/push, and the agent
  child's own `git push`/`fetch` all authenticate via a live credential helper
  — no token is written to disk.
- bcbeefb: Stop two Phoebe instances on one host from sharing each other's clone. The
  scaffolded compose file lives in a directory named `container`, so Compose
  derived the same project name — and therefore the same "private" `/data/repo`,
  `/data/state`, … volumes — for every repo on the machine. `ensureClone` then
  adopted whatever clone was already there, so an instance could silently run its
  git work against the wrong repo while its `gh` calls used its own `repoSlug`.

  - The scaffold compose file now sets an explicit, overridable project name
    (`name: ${COMPOSE_PROJECT_NAME:-phoebe}`); `.env.example` documents setting
    `COMPOSE_PROJECT_NAME` uniquely per repo when sharing a host.
  - `ensureClone` now verifies an existing clone's `origin` matches the configured
    `repoUrl` and fails loudly on a mismatch instead of adopting a foreign clone.

## 0.1.0

### Minor Changes

- f185f7f: Run buildless on Node 24. The engine (`src/`) and the published bootstrapper now
  run from raw `.ts` via native type-stripping — no `dist/` build, no
  `tsconfig.build.json`; `tsc --noEmit` stays for typecheck only, and the package
  requires Node >= 24.

  Node 24 refuses to type-strip files under `node_modules`, so the two files Node
  resolves there — the `bin` and the `defineConfig` import entry — are a dumb JS
  launcher (`bootstrap/bin.mjs`) and a one-line runtime shim (`bootstrap/index.mjs`).
  The launcher copies the package out of `node_modules` (default under the OS temp
  dir, override with `PHOEBE_ENGINE_DIR`) and execs the real, still-TypeScript
  bootstrapper (`bootstrap/cli.ts`) from there. Consumer-facing behavior is
  unchanged — same `phoebe` / `phoebe-agent` commands, same `defineConfig` import —
  only the Node floor moved to 24.

- d76833c: `phoebe boot` now guards against a bad engine ref. Tracking a branch means
  eventually tracking it onto a commit that will not boot; after three consecutive
  fast crashes (a non-zero exit inside 60s) boot quarantines that commit and
  materializes the last engine SHA that ran healthily instead, keeping the
  container serving until the tracked ref moves past the bad commit — at which
  point the quarantine lapses and reconcile resumes normally.

  A run is judged three ways — healthy, crash, or inconclusive — so that a run boot
  itself ended (a reconcile drain, a container stop) moves nothing, and a commit
  that outlives the healthy window is banked as last-good while it is still
  running. The record (last-good SHA, quarantined SHA, crash count) is JSON in
  `paths.stateDir`, so a quarantine survives the container restart a crash-looping
  engine causes; an unwritable state dir is a warning, not a failure. The guard is
  inert unless the engine ref is a moving branch — a `local` mount has no commit to
  pin, and a pinned SHA or tag means the operator chose that exact commit — and
  inert until some commit has proven itself, so a first boot onto a broken ref
  still fails loudly.

- 2db8640: The engine's self-update machinery is gone, and `phoebe init` scaffolds the
  bootstrapper model. With `phoebe boot` owning engine updates, the engine no
  longer diffs its own code on every cycle and exits for a supervisor re-exec:
  `selfUpdatePaths` is removed from the config, and the shell `supervisor.sh` the
  scaffold used to write is removed with it.

  **The engine version moved out of the image and into the config.** It is now
  `engine: { source: "github", ref }` in `phoebe.config.ts`, and `PHOEBE_VERSION`
  is gone from the scaffolded compose and `.env`. Editing `ref` upgrades a running
  deployment: within one reconcile interval boot drains the engine at a work-unit
  boundary and relaunches it on the new commit — no image rebuild, no container
  restart. A tag or SHA pins exactly; a branch follows its tip, guarded by the
  crash-loop fallback.

  **If you already scaffolded a runtime** (nothing is published yet, so this
  breaks no released version), migrate it:

  - `selfUpdatePaths` is no longer a config field. Remove it — an unknown field is
    a type error.
  - Your `phoebe.config.ts` must import **nothing at runtime**. Replace
    `import { defineConfig } from "phoebe-agent"` with
    `import type { PhoebeUserConfig } from "phoebe-agent"` and a plain default
    export. Boot loads the config from the container mount, where no
    `node_modules` is reachable, so a value import fails to resolve.
  - Add an `engine` field (it defaults to `{ source: "github", ref: "main" }` —
    pin it) and set `PHOEBE_ENGINE_DIR` at a persistent volume so engine checkouts
    survive a restart.
  - Re-scaffold `container/`: the Dockerfile's `ENTRYPOINT` is now
    `["/usr/bin/tini", "--", "phoebe", "boot"]`, `compose.yml` describes the
    long-lived container directly, and `compose.daemon.yml` is replaced by a
    dev-only `compose.local.yml` for running an engine checkout from your host.

- c303d65: First public release of the `phoebe-agent` CLI: the configurable AFK coding-agent
  engine, distributed as a pinned CLI with `phoebe init` scaffolding and container
  templates. Installable via `npx phoebe-agent`.

### Patch Changes

- 8327a35: Introduce nominal (branded) types for git SHAs, branch refs, and PR numbers
  (`Sha`, `BranchRef`, `PrNumber`) with `asSha` / `asBranchRef` / `asPrNumber`
  constructors applied at the `gh`/config trust boundary. These were previously
  bare `string` / `number` that could pass each other's parameter slot silently.
  Internal-only hardening — no consumer-facing API or runtime behaviour change.
