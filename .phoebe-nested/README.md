# Nested dogfood: Phoebe supervising two repos at once

This directory runs Phoebe in its **nested / multi-tenant** layout — one
container supervising **two** repos on a single shared engine:

- **`JesusFilm/phoebe`** — this repo (as in the flat dogfood), and
- **`JesusFilm/youtube-studio`** — Phoebe's real internal consumer.

It is the sibling of the flat single-tenant dogfood (`.phoebe/`). The flat one
exercises a single engine child; this one exercises the **fleet path** the
multi-tenant work (#57) added — tenant discovery, the shared engine, the global
concurrency broker, per-tenant env-scrub, per-tenant state, and hot
add/remove/relaunch — as a live deployment rather than only in the unit suite
([#77](https://github.com/JesusFilm/phoebe/issues/77)).

The flat dogfood is untouched: the two deployments coexist, with their own Docker
project names and volumes.

## Layout

```text
.phoebe-nested/
├─ phoebe.config.ts          # deployment root — the SHARED engine source only (#60)
├─ .env.example              # supervisor token (installs the git credential helper)
├─ container/compose.yml     # reuses the flat dogfood image; points boot at this dir
├─ smoke.sh                  # boundary smoke (no secrets) — see below
└─ repos/                    # its presence selects nested mode (bootstrap/tenants.ts)
   └─ JesusFilm/
      ├─ phoebe/
      │  ├─ phoebe.config.ts # this tenant's repo + commands (no engine field)
      │  └─ .env.example     # this tenant's GH_TOKEN + CURSOR_API_KEY
      └─ youtube-studio/
         ├─ phoebe.config.ts
         └─ .env.example     # this tenant's GH_TOKEN + ANTHROPIC_API_KEY
```

The authoritative tenant identity is the `repos/<owner>/<repo>` path — the
filesystem enforces 1:1 repo↔config, and each child validates its loaded config's
`repoSlug` against it. All tenant data nests under one volume as
`/data/repos/<owner>/<repo>/{repo,worktrees,state}`.

## What's different from the flat dogfood

- **Nested, not flat.** `boot` sees `repos/` beside the root config and runs
  `superviseFleet` — one engine child per tenant on a shared engine — instead of
  the single-child fast path. The root `phoebe.config.ts` carries **only** the
  shared `engine` field; each tenant's repo/branch/command config lives in its
  own `repos/<slug>/phoebe.config.ts`, which carries **no** `engine` field.
- **Two-layer secrets.** The deployment-root `.env` holds one `GH_TOKEN`, used
  once by the supervisor to install the shared git credential helper. The real
  per-tenant secrets live in `repos/<slug>/.env`. The supervisor builds each
  child's env deny-by-default (`bootstrap/engine-child-env.ts`, #61): the root
  token and every _other_ tenant's `.env` are never visible to a child — so the
  phoebe tenant holds only `CURSOR_API_KEY`, youtube-studio only
  `ANTHROPIC_API_KEY`, and neither can read the other's.
- **Different providers on purpose.** phoebe → `cursor`, youtube-studio →
  `claude`. Beyond being realistic, it makes the env-scrub above observable: two
  tenants, two keyrings, structurally separated.
- **No new image.** `container/compose.yml` reuses the flat dogfood image
  verbatim (its build context _is_ `../../.phoebe/container`). The image carries
  no Phoebe code — bootstrapper and engine both come from the working-tree mount
  — so nested needs no Dockerfile of its own, and the one image both deployments
  run stays guarded by `src/container-image.test.ts`.

Everything else — the hardening, the `engine: { source: "local" }` run-from-the-
mount model, SIGTERM draining, reconcile-in-place — matches the flat dogfood
(`.phoebe/README.md`).

## What this dogfood exercises (#77)

The four signals the multi-tenant work must demonstrate, and where each is
proven:

| Signal                                                                            | Proven by                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Per-tenant tagging (#73)** — `[phoebe:<slug>]` unit events + status-v2 snapshot | A real run (far side of the GitHub boundary); unit-tested in `src/runtime-status.test.ts`. |
| **Concurrency cap (#59)** — one broker serializes work across both tenants        | A real run; unit-tested in `bootstrap/slot-broker.test.ts` + `supervise-fleet.test.ts`.    |
| **Per-tenant state (#62/#63)** — `state/<slug>/status-v2.json` + `phoebe list`    | The boundary smoke (`phoebe list` enumerates both tenants).                                |
| **Env-scrub isolation (#61)** — each child sees only its own tenant's secrets     | Structural at spawn; unit-tested in `bootstrap/engine-child-env.test.ts`.                  |

The **layout itself** — nested mode, exactly these two tenants, a shared local
engine, no stray per-tenant engine field — is pinned by
`src/nested-dogfood.test.ts`, which runs in CI with no Docker or token.

## Prerequisites

- Docker + Docker Compose, Node ≥ 24 on the host.
- For a **real** run (not the smoke): a `GH_TOKEN` and provider key **per
  tenant**, each in its own `repos/<slug>/.env` (copy the `.env.example`). The
  youtube-studio tenant's `install`/`check`/`test` commands are seeded from its
  toolchain — confirm them against that repo's scripts before a real run.

## The boundary smoke (no secrets)

```bash
./.phoebe-nested/smoke.sh
```

Boots the two-tenant fleet with a deliberately **invalid** token and asserts the
multi-tenant supervision chain walks end to end without any real secrets:

1. `boot` detects nested mode and announces it is supervising **2 tenants**;
2. each tenant gets its own engine child that reaches its first `gh` call, fails
   on the bad credentials, and is **reaped per-tenant by dir** — real per-tenant
   supervision (#60), not one shared failure;
3. `phoebe list` enumerates **both** tenants from the mounted `repos/` tree (#62/#63).

This is the flat dogfood's "verified to the GitHub boundary" check, one tier up.

## Driving it by hand

```bash
cd .phoebe-nested/container
# real run needs a root .env (GH_TOKEN) + per-tenant repos/<slug>/.env:
docker compose --env-file ../.env run --rm phoebe --dry-run   # selection preview
docker compose --env-file ../.env up -d                        # persistent, detached
docker compose --env-file ../.env logs -f
```

### Adding / removing a tenant live

The supervisor discovers tenants on each poll, so this needs no restart:

```bash
# host-side, against the mounted config tree:
node bootstrap/cli.ts add-repo JesusFilm/some-repo     # → scaffolds repos/JesusFilm/some-repo/
node bootstrap/cli.ts remove-repo JesusFilm/some-repo  # → drains + reaps that child only
```

## How far this has actually been run

Verified in real containers, with a deliberately invalid `GH_TOKEN` (via
`smoke.sh`). Every assertion passed:

- the runtime image built (a Docker-cache no-op — it _is_ the flat dogfood image);
- `phoebe list` enumerated **both** tenants from the mounted `repos/` tree, with
  no token (#62/#63);
- `boot` detected nested mode and announced it was **supervising 2 tenants**;
- each tenant got its own engine child, which reached its first `gh` call, failed
  on the bad credentials, and was **reaped per-tenant by its `repos/<slug>` dir** —
  proving real per-tenant supervision (#58/#60), not one shared failure.

So the whole multi-tenant chain up to the GitHub boundary is proven live:
discovery → shared-engine launch → one scrubbed child per tenant → per-tenant
reap. What still needs your secrets, on a first real run, is the **far side** of
that boundary — and with it the two signals that only fire there:

- a real work unit per tenant → the `[phoebe:<slug>]` unit-event tag +
  status-v2 snapshot `phoebe list` then reads live (#73);
- both tenants contending for the single concurrency slot, so the broker is seen
  serializing real work rather than just starting (#59).

Both are covered meanwhile by the unit suite (`runtime-status.test.ts`,
`slot-broker.test.ts`, `supervise-fleet.test.ts`), and the layout by
`nested-dogfood.test.ts`.
