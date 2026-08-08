# Solo topology

A single, self-configured repo — the classic single-deployment layout. One
`phoebe.config.ts` at the runtime root describes one repository, and Phoebe
works that repository's issues and PRs. This is the topology to reach for when
**one repo, one deployment** is all you need.

Use one of the multi-repo topologies instead when:

- you want **one container serving many repos** as isolated tenants → see
  [`../nested/`](../nested/) (the [#57](https://github.com/JesusFilm/phoebe/issues/57) `repos/<owner>/<repo>/` layout);
- you run Phoebe at the **root of a workspace** of self-configured child repos →
  see [`../workspace/`](../workspace/) (the [#81](https://github.com/JesusFilm/phoebe/issues/81) layout).

## What's here

| File               | Role                                                                           |
| ------------------ | ------------------------------------------------------------------------------ |
| `phoebe.config.ts` | The consumer config: five required fields plus a pinned `engine.ref`.          |
| `.env.example`     | The secrets template — copy to `.env` and fill in `GH_TOKEN` + a provider key. |

These are a **reference illustration**, not a runnable fixture: read them to see
the canonical shape, then scaffold your own with `npx --yes phoebe-agent init`.
The `acme/widget` naming is fictional and shared across all three examples so
they read as one progression.

The config type-checks against the live schema (`src/config/types.ts`) as part
of the repo's `typecheck` — if the schema changes underneath it, this example
fails CI rather than silently rotting.

## Learn more

- [`docs/configuration.md`](../../docs/configuration.md) — every `phoebe.config.ts` field and the `PHOEBE_*` env overlay.
- [`docs/ai-install.md`](../../docs/ai-install.md) — scaffolding and first boot end to end.
