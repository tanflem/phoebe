# Nested topology

**One container, many repos.** A single Phoebe deployment supervises several
repositories as isolated tenants — each with its own config, its own secrets, and
its own engine child — all sharing one engine version and one concurrency broker.
This is the [#57](https://github.com/JesusFilm/phoebe/issues/57)
`repos/<owner>/<repo>/` layout. Reach for it when **one host should serve a fleet
of repos** without standing up a container per repo.

Use a different topology when:

- you have **one repo, one deployment** → see [`../solo/`](../solo/) (the classic
  single-root layout);
- you run Phoebe at the **root of a workspace** of submodule-linked, self-configured
  child repos → see [`../workspace/`](../workspace/) (the
  [#81](https://github.com/JesusFilm/phoebe/issues/81) layout).

## What's here

```text
nested/
  phoebe.config.ts          ← DEPLOYMENT-ROOT: shared engine source only (Pick<…, "engine">)
  .env.example              ← supervisor's token + fleet knobs
  .gitignore                ← ignores .env and repos/**/.env
  repos/
    acme/widget/            ← tenant 1 (authored config + secrets template)
      phoebe.config.ts      ←   full config, NO engine field; defaultProvider: claude
      .env.example
    acme/gadget/            ← tenant 2 — a DIFFERENT provider, to show isolation
      phoebe.config.ts      ←   defaultProvider: cursor
      .env.example
```

The presence of `repos/` beside the root config is what selects nested mode. Add
or remove a tenant by adding or removing a `repos/<owner>/<repo>/` dir — the two
here (`acme/widget`, `acme/gadget`) are placeholders showing the multiplicity.

## What you author vs. what Phoebe creates

Each `repos/<owner>/<repo>/` dir a consumer commits holds **only** the two files
shown: a `phoebe.config.ts` and a `.env` (from the `.env.example` template). It is
**not** a working copy of the repo. At runtime Phoebe clones the real repository
privately into `/data/repos/<owner>/<repo>/` on the `phoebe-data` volume (the
origin hub, worktrees, and per-tenant state) — none of which is ever committed
here. So the committed tree stays tiny: config + secrets templates, nothing else.

## Two things the root config makes explicit

- **The root config is engine-only.** In nested mode the bootstrapper reads _just_
  the `engine` source from the deployment-root `phoebe.config.ts` — one engine
  version for the whole fleet. That is why it is typed `Pick<PhoebeUserConfig,
"engine">` (no `repoSlug`/commands: it describes no single repo), while each
  tenant is a full `PhoebeUserConfig` **minus** `engine`.
- **Secrets are per-tenant and scrubbed.** Every tenant's engine child sees only
  its own co-located `.env`; the supervisor scrubs all other tenants' secrets and
  the root token deny-by-default. That is why `widget` (claude) and `gadget`
  (cursor) can hold different provider keys with no cross-tenant leakage.

These configs are a **reference illustration**, not a runnable fixture. The
`acme/widget` + `acme/gadget` naming is fictional and shared across all three
examples so they read as one progression. Every config type-checks against the
live schema (`src/config/types.ts`) as part of the repo's `typecheck` — if the
schema changes underneath, this example fails CI rather than silently rotting.

## Learn more

- [`docs/configuration.md`](../../docs/configuration.md#multiple-repos-nested-tenants) — the nested layout, the 1:1 config↔env binding, and derived container paths.
- [`docs/ai-install.md`](../../docs/ai-install.md) — scaffolding and first boot.
