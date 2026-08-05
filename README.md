# Phoebe

**Phoebe is an AFK coding agent.** It polls a GitHub repository for ready-to-work
issues, works each one on its own branch in an isolated git worktree, runs your
project's gates, and opens a pull request. Between new issues it sweeps open PRs
for merge conflicts, failing CI, and unresolved review feedback — so work keeps
moving without a human babysitting every branch.

Phoebe runs as a **single Docker container** that is both orchestrator and
execution environment. Your host checkout is never touched: the container owns a
private clone and pushes branches directly to origin. Every repo-specific value
lives behind one config file, so the same engine drives any repository.

> ⚠️ **Early scaffold.** This repository is being stood up as the public home of
> Phoebe's engine, extracted from [`JesusFilm/youtube-studio`](https://github.com/JesusFilm/youtube-studio).
> The engine, CLI packaging, `phoebe init` scaffolder, CI, and first npm release
> land as the tracked execution issues on this repo. Until `phoebe-agent@0.1.0`
> is published, treat everything here as work in progress.

## Distribution

The engine is published to npm as **`phoebe-agent`** (unscoped) and consumed as a
pinned CLI — you never vendor the engine source into your repo, only a small
config file, your prompt overrides, and the container files `phoebe init`
scaffolds for you.

## Quickstart

From the root of the repo you want Phoebe to work, the interactive wizard
scaffolds everything and fills in `phoebe.config.ts` and `.env` for you:

```bash
npx --yes phoebe-agent setup      # scaffold + interactive Q&A → ready-to-run config & .env
```

`setup` detects your git remote for the repo fields, asks for your install/check/
test commands, lets you pick the agent provider (`claude`/`cursor`/`codex`), and
prompts for your `GH_TOKEN` and provider key (input masked). It never overwrites
files you've edited, so it's safe to re-run to reconfigure. When it finishes you
can go straight to `docker compose build` — no hand-editing.

Prefer to fill things in yourself? `phoebe init` writes the same scaffold with
generic placeholders and no prompts:

```bash
npx --yes phoebe-agent init      # scaffold config, prompts, .env.example, container/
```

Then edit the five required fields in `phoebe.config.ts`, pin the engine with
`engine: { source: "github", ref: "v0.1.0" }`, and copy `.env.example` to `.env`
and fill in your `GH_TOKEN` and provider key. Either way, the scaffolded `.env`
lives at the repo root while the compose files live in `container/`, so pass
`--env-file ../.env` when you run Compose from there:

```bash
cd container
docker compose --env-file ../.env build
docker compose --env-file ../.env run --rm phoebe --dry-run --run-once   # preview one unit
docker compose --env-file ../.env up -d                                  # start the daemon
```

The container's main process is `phoebe boot`: it checks the engine out at the
ref your config names, runs it, and keeps supervising it. Upgrading is an edit to
`engine.ref` — no rebuild, no restart. (The deployment dir is bind-mounted as a
directory, so an in-place edit or a `git pull` is picked up on the next poll.)

**Multiple repos in one container.** You don't need one Phoebe per repo — run
`phoebe add-repo <owner/repo>` per repo and the same container supervises each as
a tenant (`repos/<owner>/<repo>/`), with a fleet-wide concurrency cap. Read
[`docs/trust.md`](docs/trust.md) first: co-locating repos means co-locating them
in one trust domain. See [`docs/configuration.md`](docs/configuration.md) and
[`docs/operating.md`](docs/operating.md).

The full, execute-top-to-bottom version — prerequisites, secrets, verification —
is [`docs/ai-install.md`](docs/ai-install.md).

## Configuration at a glance

Only five fields are required; everything else falls back to a shipped default.
Deployments may also set `PHOEBE_BASE_CONFIG` to an absolute path containing a
strict, versioned JSON base layer. The repository declaration remains
authoritative, and existing `PHOEBE_*` field overrides remain highest
precedence.

```ts
import type { PhoebeUserConfig } from "phoebe-agent";

const config: PhoebeUserConfig = {
  repoSlug: "your-org/your-repo",
  repoUrl: "https://github.com/your-org/your-repo.git",
  installCommand: "npm ci",
  checkCommand: "npm run check",
  testCommand: "npm test",
  engine: { source: "github", ref: "v0.1.0" },
};

export default config;
```

| Field             | Default                                  | What it controls                                |
| ----------------- | ---------------------------------------- | ----------------------------------------------- |
| `repoSlug`        | _required_                               | GitHub `owner/repo` for every `gh` call.        |
| `repoUrl`         | _required_                               | Clone URL for the container's private clone.    |
| `installCommand`  | _required_                               | Dependency install run in each worktree.        |
| `checkCommand`    | _required_                               | Lint/type gate.                                 |
| `testCommand`     | _required_                               | Test gate.                                      |
| `defaultBranch`   | `main`                                   | Branch PRs target and worktrees base off.       |
| `branchPrefix`    | `phoebe/`                                | Prefix for agent branches.                      |
| `readyLabel`      | `ready-for-agent`                        | Label marking issues Phoebe may pick up.        |
| `researchLabel`   | `wayfinder:research`                     | Label marking wayfinder research tickets.       |
| `prOptOutLabel`   | `ready-for-human`                        | Label that hands a PR back to a human.          |
| `workOrder`       | conflicts→checks→reviews→issues→research | Order the work kinds are tried.                 |
| `defaultProvider` | `cursor`                                 | Agent CLI to drive (`cursor`/`claude`/`codex`). |

See [`docs/configuration.md`](docs/configuration.md) for the complete field
reference, generated-base contract, merge rules, and `PHOEBE_*` environment
overlay. Run `phoebe config resolve --json` to print the canonical non-secret
effective configuration without starting the engine.

## Documentation

Docs live under [`docs/`](docs/):

- [`docs/architecture.md`](docs/architecture.md) — topology, worktree isolation, engine updates and crash-loop fallback, named volumes.
- [`docs/configuration.md`](docs/configuration.md) — full config-field reference and env overlay.
- [`docs/work-kinds.md`](docs/work-kinds.md) — issues / conflicts / checks / reviews / research mechanics, PR-scan scope, poll loop.
- [`docs/operating.md`](docs/operating.md) — controlling Phoebe as a human (labels, drafts, watermarks).
- [`docs/status-contract.md`](docs/status-contract.md) — the local `status-v2` snapshot and replayable `events-v1` outcome journal.
- [`docs/upgrading.md`](docs/upgrading.md) — the init / pin / upgrade contract.
- [`docs/ai-install.md`](docs/ai-install.md) — a deterministic, agent-followable install runbook.
- [`docs/releasing.md`](docs/releasing.md) — the Changesets + npm trusted-publishing release flow.
- [`docs/phoebe-core-onboarding.md`](docs/phoebe-core-onboarding.md) — worked onboarding for `JesusFilm/core` (Nx + pnpm, no vp).
- [`docs/trust.md`](docs/trust.md) — contributor trust list (`vouch`) for this repo, and how it relates to `ready-for-agent`. Governance for this repository, not a package feature.

Agents landing in this repo should start at [`AGENTS.md`](AGENTS.md).

## History & attribution

Phoebe was designed, built, and dogfooded inside
[`JesusFilm/youtube-studio`](https://github.com/JesusFilm/youtube-studio), which
remains its reference consumer. Its execution loop was first prototyped on
[Sandcastle](https://github.com/mattpocock/sandcastle) (`@ai-hero/sandcastle`, by
Matt Pocock) — the sandbox-per-run design proved the loop end-to-end and its
provider wrappers are the design ancestor of `src/providers/`. The dependency was
removed when the host-spawns-sandboxes topology was replaced by the single
persistable container. This repository starts with fresh history; the full design
record lives in the youtube-studio issue tracker.

## License

[MIT](LICENSE) © JesusFilm
