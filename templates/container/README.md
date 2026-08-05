# Container mount — workspace root

The compose file binds the **entire deployment directory** (the parent of
`container/`) into the container at `/etc/phoebe` **read-only**:

```yaml
volumes:
  - ..:/etc/phoebe:ro
working_dir: /etc/phoebe
```

That mount model is deliberate and shared with the nested (`repos/`) layout:
one directory mount so `phoebe boot` re-walks the tree every poll and sees
children come and go without a recreate.

## Workspace specifics

### Include `.git`

Keep `.git` on the host path that gets mounted. Do **not** exclude it from the
bind mount (e.g. no `:ro` pair that stops at the working tree only). Submodule
`origin` URLs used for the child-origin cross-check live under:

```text
.git/modules/<child>/config
```

Without `.git` on the mount that check has nothing to read.

### Materialize submodules before boot

Phoebe never runs `git` in the workspace tree. Empty or unmaterialized submodule
directories are **skip-and-warned** tenants: boot continues, that child is not
supervised until the checkout exists.

Before `docker compose up`:

```bash
git submodule update --init --recursive
```

Then start the container from `container/` as usual (with `--env-file ../.env`).

### What lands on the mount

| Path | Role |
| ---- | ---- |
| `phoebe.config.ts` | Root only: `engine` + `workspace: { depth }` |
| `<child>/phoebe.config.ts` | Authoritative per-tenant config (`repoSlug`, …) |
| `<child>/.env` | Per-tenant secrets (gitignored on the host) |
| `.git/` | Submodule metadata for origin validation |
| `container/` | Image + compose (this directory) |

The root `.env` holds **deployment** secrets (`GH_TOKEN` for the engine
checkout, default provider keys, runtime toggles). Per-child secrets live in
each child's `.env`; the fleet env-scrub hands each engine child only its own.

### Read-only means host checkouts are never written

The local (submodule) tree is discovery + config only. Each tenant is still
cloned privately under `/data/repos/<owner>/<repo>/`. The `:ro` flag is the
hard guarantee that the host workspace is never a working copy.
