# Core-repo onboarding

How an **owner-operator** in [`JesusFilm/core`](https://github.com/JesusFilm/core)
runs a local Phoebe container against the **published** `phoebe-agent` engine.

`core` is an **Nx monorepo** built with **pnpm**, and it does **not** carry
`vp` — so this is the plain "install the CLI, scaffold a runtime, point it at the
repo" path, with the toolchain commands filled in for Nx-affected. Nothing here
overrides engine behaviour beyond the toolchain: the **full default `workOrder`**
runs, PR maintenance stays at **phoebe-only scope**, the **engine-default labels**
are used verbatim, and the **shipped prompts** are left untouched.

This document is a worked instance of the general runbooks — read it alongside
[`ai-install.md`](ai-install.md) (the generic install), [`upgrading.md`](upgrading.md)
(the init/pin/upgrade contract), and [`configuration.md`](configuration.md) (every
field). It only pins down the `core`-specific choices.

## The shape of this deployment

Every decision below maps to a config field (or to a deliberate non-choice — a
field left at its shipped default). See [`configuration.md`](configuration.md) for
the field reference.

| Decision                            | Field                                              | Value for `core`                                                                    |
| ----------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Target repo                         | `repoSlug`                                         | `JesusFilm/core` (override — required)                                              |
| Clone URL                           | `repoUrl`                                          | `https://github.com/JesusFilm/core.git` (override — required)                       |
| Install                             | `installCommand`                                   | pnpm frozen install (override — required)                                           |
| Check gate (prettier-fix)           | `checkCommand`                                     | Nx-affected lint + typecheck, prettier in **write** mode (override — required)      |
| Test gate                           | `testCommand`                                      | Nx-affected test (override — required)                                              |
| Ready gate                          | `readyCommand`                                     | check + test (override — default is npm-shaped)                                     |
| Work order                          | `workOrder`                                        | **default** `["conflicts","checks","reviews","issues","research"]`                  |
| PR-scan scope                       | `prScope`                                          | **default** `"phoebe"` — Phoebe maintains only its own branches                     |
| Ready / processing / opt-out labels | `readyLabel` / `processingLabel` / `prOptOutLabel` | **defaults** `ready-for-agent` / `processing` / `ready-for-human`, created verbatim |
| Research label                      | `researchLabel`                                    | **default** `wayfinder:research` — the `research` kind's ticket label               |
| Provider + model                    | `defaultProvider` / `defaultModels`                | operator-chosen at runtime via `.env` (see below) — config left at defaults         |
| Prompts                             | `promptFiles`                                      | **defaults** — the scaffolded `prompts/` are left unedited                          |

Net effect: the committed `phoebe.config.ts` names **only the toolchain fields**.
Everything that governs _what Phoebe does_ — order of work kinds, which PRs it
touches, the labels it reads, the prompts it runs — stays on the engine defaults,
so a `phoebe-agent` upgrade picks up any new defaults automatically
([why a minimal config stays current](upgrading.md#upgrading)).

## 1. Prerequisites

Same as [`ai-install.md`](ai-install.md#prerequisites) — on the host that will run
the container:

- Node.js ≥ 24 and `git`, `gh`, Docker + Docker Compose.
- A GitHub token in `GH_TOKEN` (the fine-grained PAT below).
- The API key for the provider you choose (§4).

No pnpm or Nx is needed **on the host** — the install/check/test commands run
_inside_ the container, which installs its own toolchain from the repo.

## 2. Operator GitHub token — a fine-grained PAT

Phoebe acts entirely as the token's identity: it clones, pushes `phoebe/`
branches, opens/updates PRs, and reads/writes issue labels and comments. Mint a
**fine-grained** personal access token scoped to the single repo. Phoebe is built
to work under a fine-grained PAT — it reads check state from the REST Actions API
rather than the GraphQL rollup precisely because fine-grained PATs cannot read the
rollup ([work-kinds.md](work-kinds.md#checks--fix-failing-ci)).

Create it at **Settings → Developer settings → Fine-grained tokens**:

- **Resource owner:** `JesusFilm` (the token must be **approved by an org owner** —
  fine-grained PATs against org repos require organization approval before they
  work).
- **Repository access:** _Only select repositories_ → `JesusFilm/core`.
- **Repository permissions:**

  | Permission    | Access         | Why                                                              |
  | ------------- | -------------- | ---------------------------------------------------------------- |
  | Metadata      | Read (auto)    | Mandatory for every other permission.                            |
  | Contents      | Read and write | Clone the repo, push branches.                                   |
  | Pull requests | Read and write | Open/update PRs, post PR comments & watermarks.                  |
  | Issues        | Read and write | Read `readyLabel`, swap in `processingLabel`, comment.           |
  | Actions       | Read           | `gh run list` — the check-state source for the `checks` janitor. |

  Leave everything else _No access_. Add **Workflows: Read and write** only if you
  expect the agent to edit files under `.github/workflows/` (GitHub blocks pushing
  workflow changes otherwise).

Set an expiry you can live with and rotate it into `.env` when it lapses. Store it
only in `GH_TOKEN` (§5) — never commit it.

## 3. The labels (engine defaults, verbatim)

Phoebe only ever picks up issues carrying `readyLabel` and only hands PRs back on
`prOptOutLabel`; it applies `processingLabel` to claim an issue, and
`phoebe:quarantined` to a poison unit. Nothing to create by hand: the engine
ensures every label it writes (`gh label create --force`) once at boot, so a
fresh `JesusFilm/core` gets `ready-for-agent`, `processing`,
`wayfinder:research`, `ready-for-human`, and `phoebe:quarantined` on first run.

Only the **names** matter — if the config overrides a label away from its
default, use the overridden name when applying it by hand (`readyLabel` on an
issue, `prOptOutLabel` on a PR). See [`operating.md`](operating.md) for how a
human then drives Phoebe with these labels.

## 4. Scaffold the runtime into a committed `phoebe/`

Keep the runtime out of the repo root — scaffold it into a `phoebe/`
subdirectory and **commit it** (it is consumer-owned by design,
[upgrading.md](upgrading.md#phoebe-init--scaffold-a-consumer-owned-runtime)):

```bash
cd core                      # repo root
npx --yes phoebe-agent init ./phoebe
```

That produces a committed tree:

```
core/
  phoebe/
    phoebe.config.ts         # edit (§5)
    prompts/                 # LEAVE AS-IS — zero overrides
    .env.example             # copy to .env (§6, gitignored)
    .gitignore               # Phoebe entries appended additively
    container/
      Dockerfile
      compose.yml
      compose.local.yml
```

Commit `phoebe.config.ts`, the untouched `prompts/`, `container/`, and the
appended `.gitignore`. **Do not edit `prompts/`** — leaving the shipped copies in
place is the "zero prompt overrides" posture, and it means prompt improvements
shipped by future engine releases are the ones you'd copy in deliberately, not a
stale fork you have to reconcile.

`init` never touches existing files, so re-running it later only fills gaps.

## 5. `phoebe.config.ts` — Nx-affected toolchain, nothing else

Edit `core/phoebe/phoebe.config.ts` to name **only the toolchain fields**. The
check step runs prettier in **write** mode so formatting drift is auto-fixed and
committed rather than failing the gate:

```ts
import type { PhoebeUserConfig } from "phoebe-agent";

const config: PhoebeUserConfig = {
  repoSlug: "JesusFilm/core",
  repoUrl: "https://github.com/JesusFilm/core.git",

  // pnpm, lockfile-exact — the container installs the repo toolchain.
  installCommand: "pnpm install --frozen-lockfile",

  // Nx-affected lint + typecheck, with prettier in WRITE mode so formatting is
  // fixed in place (not merely checked). `--base` is the branch worktrees base
  // off; see configuration.md for defaultBranch.
  checkCommand:
    "pnpm nx format:write --base=origin/main && pnpm nx affected -t lint typecheck --base=origin/main",

  // Nx-affected tests only — the whole point of affected is to skip the rest.
  testCommand: "pnpm nx affected -t test --base=origin/main",

  // The all-in-one gate the agent runs before pushing. The shipped default is
  // `npm run ready`, which core does not have, so point it at check + test.
  readyCommand:
    "pnpm nx format:write --base=origin/main && pnpm nx affected -t lint typecheck test --base=origin/main",

  // Which engine `phoebe boot` checks out and runs. Pin a released tag.
  engine: { source: "github", ref: "v0.1.0" },
};

export default config;
```

Notes:

- **Type-only import.** The container mounts this file into `/etc/phoebe`, where
  a value import of `phoebe-agent` cannot resolve; `import type` is erased before
  the file runs. See [configuration.md](configuration.md#the-config-file).

- **`--base=origin/main`.** Nx-affected diffs against a base ref; issue worktrees
  are branched off `origin/main` (the `defaultBranch`), so that is the correct
  comparison point. If you change `defaultBranch`, change these to match.
- **Adjust target names to `core`'s real Nx targets.** `lint`, `typecheck`, and
  `test` are the conventional names; confirm them against `core`'s project
  configuration and swap in whatever the repo actually defines.
- **Toolchain fields plus `engine`, nothing else.** `engine` is not a toolchain
  setting — it is the deployment's lifecycle knob (which engine commit runs, and
  how you upgrade), so it is named deliberately. Everything else — `workOrder`,
  `prScope`, the three labels, providers/models, paths, `promptFiles` — is
  omitted and resolves to the engine defaults shown in the
  [shape table](#the-shape-of-this-deployment).

## 6. Provider selection and secrets (`.env`)

Provider is an **operator-local** choice, not a repo-wide one — so make it in
`.env` rather than the committed config. Copy the scaffolded example and fill it
in:

```bash
cd core/phoebe
cp .env.example .env
```

Set:

- **`GH_TOKEN`** — the fine-grained PAT from §2.
- **The provider key** matching the provider you pick — only that one is read; the
  agent child never sees the others ([architecture.md](architecture.md#the-agent-child-and-its-locked-down-environment)).
- **`PHOEBE_AGENT` + `PHOEBE_MODEL`** — the operator's provider choice, without
  touching the committed config:

  | Provider | `PHOEBE_AGENT` | Key env var (`providerEnv`) | Example `PHOEBE_MODEL` (`defaultModels`) |
  | -------- | -------------- | --------------------------- | ---------------------------------------- |
  | Cursor   | `cursor`       | `CURSOR_API_KEY`            | `composer-2.5`                           |
  | Claude   | `claude`       | `ANTHROPIC_API_KEY`         | `claude-sonnet-4-6`                      |
  | Codex    | `codex`        | `OPENAI_KEY`                | `gpt-5.4-mini`                           |

  Leaving `PHOEBE_AGENT` unset falls back to `defaultProvider` (`cursor`). Setting
  it in `.env` keeps the choice local to this operator's box — a different operator
  can run the same committed runtime under a different provider.

The engine version is **not** an env var: it is `engine.ref` in
`phoebe.config.ts`. Pin an explicit released tag for a real deployment
([upgrading.md](upgrading.md#pinning-the-engine-version)).

`.env` is gitignored by the scaffolded `.gitignore` — keep it that way.

## 7. Build, preview, and run

The `.env` sits at `core/phoebe/.env` while the compose files live in
`core/phoebe/container/`, so pass `--env-file ../.env` on every Compose command
(otherwise Compose misses `GH_TOKEN` and the provider key):

```bash
cd core/phoebe/container
docker compose --env-file ../.env build

# Preview the unit Phoebe would pick — host-safe, executes nothing:
docker compose --env-file ../.env run --rm phoebe --dry-run --run-once

# Start the persistent daemon (all work kinds, poll loop):
docker compose --env-file ../.env up -d
```

`--dry-run --run-once` is the safe first step: it prints the selected unit without
booting execution. The janitor kinds (`conflicts`, `checks`, `reviews`) only run
in the **persistent daemon**; `--run-once` handles at most one `issues` unit
([work-kinds.md](work-kinds.md#the-poll-loop-and-workorder)).

## 8. Day-to-day and upgrades

- **Drive it from GitHub.** Add `ready-for-agent` to queue an issue; `Blocked by
#N` in a body to sequence dependents; `ready-for-human` (or mark a non-Phoebe PR
  draft) to take a PR back. Full operator manual: [`operating.md`](operating.md).
- **Upgrade** by editing `engine.ref` in `phoebe.config.ts` — the running
  container drains the engine and relaunches on the new ref within a reconcile
  interval, no rebuild and no restart. Edit it **in place**: the config is
  bind-mounted as a single file, so a save-by-rename (or a `git pull`) needs
  `docker compose --env-file ../.env up -d --force-recreate` to be picked up. The
  minimal config means new engine defaults land automatically
  ([upgrading.md](upgrading.md#upgrading)).
