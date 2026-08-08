# Init, pin & upgrade

The contract between the published `phoebe-agent` package and a consumer repo:
what `phoebe init` scaffolds, which files you own, how the engine version is
pinned, and how upgrades roll out.

## The distribution model

You never vendor the engine source. The published `phoebe-agent` package is a
thin **bootstrapper**; `phoebe boot` — the container's main process — checks the
**engine** out separately from a git ref you name in your config. You keep only:

- a small `phoebe.config.ts` (see [`configuration.md`](configuration.md)),
- your `prompts/` overrides (or the shipped copies), and
- the container files `phoebe init` scaffolds.

Everything else — the orchestration loop, work-kind logic, git model, providers
— lives in the engine and upgrades as a unit.

## `phoebe init` — scaffold a consumer-owned runtime

```
npx --yes phoebe-agent init            # into the current directory
npx --yes phoebe-agent init ./phoebe   # into a subdirectory
```

It writes these files (all **consumer-owned** — commit them):

| File                          | Purpose                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `phoebe.config.ts`            | Consumer config starter — edit the five required fields.                                                      |
| `prompts/`                    | Copies of the shipped agent prompts. Edit to override; leave as-is to use defaults.                           |
| `.env.example`                | Documented env vars — copy to `.env` and fill secrets.                                                        |
| `.gitignore`                  | Phoebe entries **appended additively** (existing content untouched).                                          |
| `container/Dockerfile`        | Runtime image: Node 24 + git + `gh` + the `phoebe-agent` bootstrapper, run as the unprivileged `phoebe` user. |
| `container/compose.yml`       | The long-lived `phoebe boot` container + named volumes.                                                       |
| `container/compose.local.yml` | Dev-only overlay: run an engine checkout from your own machine.                                               |

**Existing files are left untouched**, so re-running `init` is safe and only
fills gaps. To regenerate one scaffolded file, delete it and re-run. Placeholder
tokens in the templates (the CLI bin name, your `installCommand`) are
substituted at scaffold time.

## Pinning the engine version

The engine version is a single knob, and it lives in `phoebe.config.ts` — not in
`.env` and not in the image:

```ts
engine: { source: "github", ref: "v0.1.0" },
```

`phoebe boot` reads that field, checks the engine out at that ref, and runs it.
Two shapes, with deliberately different guarantees:

| `ref`             | Behaviour                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| a tag or full SHA | Exactly that commit, always. No crash-loop fallback — pinning means pinning, and quietly serving different code than you asked for would be worse.   |
| a branch          | Follows the tip. Guarded: a commit that will not boot is quarantined after three fast crashes and boot pins back to the last one that ran healthily. |

**Pin an explicit released ref in a real deployment.** `main` is for
environments where you want every push, and accept the guard as the safety net.

`repo` defaults to the upstream engine repo; set it to run a fork. For an engine
checkout on your own machine, see `container/compose.local.yml`.

## Upgrading

Edit `engine.ref` in `phoebe.config.ts`.

Within one reconcile interval (`PHOEBE_RECONCILE_INTERVAL_MS`, default 60s) the
running `boot` notices the config changed, `SIGTERM`s the engine — which finishes
its current work unit and starts no new one — checks out the new ref, and
relaunches. Same container, no rebuild, no restart, no interrupted work unit.

> **How you write the file matters.** `compose.yml` bind-mounts
> `phoebe.config.ts` as a single file, which pins the host **inode**. A write
> that replaces the file — most editors' atomic save, and what `git pull` does —
> leaves the container looking at the old inode forever, so the watch never
> fires. Either edit in place, or follow the write with
> `docker compose --env-file ../.env up -d --force-recreate`, which is a normal
> deploy step anyway. Editing in place is what makes the no-restart path work.

Tracking a branch upgrades the same way with no edit at all: boot polls
`git ls-remote` and relaunches when the tip moves.

Rebuild the image only when the image itself changes — a new provider CLI, a
different base image, a new system package:

```bash
docker compose --env-file ../.env build
docker compose --env-file ../.env up -d
```

The `--env-file ../.env` is needed because the scaffolded `.env` lives at the
scaffold root while the compose files live in `container/`; Compose otherwise
only auto-loads a `.env` sitting next to the compose file.

### One-time: chown the volumes when moving to the unprivileged image

**This applies once, to deployments that ran an image built before the container
ran as a non-root user.** Skip it for a fresh install.

Docker seeds a named volume's ownership from the image **only when it creates
that volume**. Volumes your old root container already created keep their
`root:root` ownership through any number of rebuilds, so the new unprivileged
container starts and then fails on the first write — a `git clone` or lock
acquisition dying with `EACCES`, not an obvious permissions message at startup.

Fix it in place, without losing the clone, watermarks, or logs:

```bash
docker compose --env-file ../.env down
docker compose --env-file ../.env run --rm --user root \
  --entrypoint chown phoebe -R phoebe:phoebe /data
docker compose --env-file ../.env up -d
```

`--entrypoint chown` is needed because the image's `ENTRYPOINT` is `phoebe boot`;
everything after the service name is the argument list. To confirm it took:

```bash
docker compose --env-file ../.env run --rm --entrypoint stat phoebe -c '%U' /data/repo
# phoebe
```

Deleting the volumes (`down -v`) also works and is simpler, at the cost of
re-cloning the repo and losing the watermarks that stop already-handled work
from being reconsidered.

New engine defaults land automatically — because your `phoebe.config.ts` only
names fields you deliberately override, any field you left to the default picks
up the new default on upgrade. That is the point of the required-vs-optional
split in [`configuration.md`](configuration.md): a minimal config stays current.

Full mechanics — the reconcile loop, crash-loop thresholds, what each run
verdict means — are in
[`architecture.md`](architecture.md#engine-updates-and-crash-loop-fallback).

## Scaffolded-file invariants

A few properties the templates rely on — keep them intact when you customise:

- **The container marker.** Work-unit execution is refused unless
  `/.phoebe-container` exists (created by the image). Selection and `--dry-run`
  stay host-runnable; anything that mutates a clone or pushes runs only in the
  container.
- **`ENTRYPOINT` owns `phoebe boot`.** Compose's `command:` fully replaces
  `CMD` (it does not append to `ENTRYPOINT`), so the whole `phoebe boot`
  invocation lives in `ENTRYPOINT` and the compose files only ever contribute
  engine flags, which boot forwards to the engine (`--run-once`, `--dry-run`, or
  nothing for the persistent loop).
- **The config is type-only.** The scaffolded `phoebe.config.ts` is imported by
  `boot` from a container mount with no reachable `node_modules`, so every
  import in it must be `import type` — a value import cannot resolve there.
- **Config + prompts are mounted read-only.** `compose.yml` mounts
  `phoebe.config.ts` and `prompts/` into `/etc/phoebe` read-only, so boot
  re-reads edits **without a rebuild**. Note that a single-file bind mount pins
  the host inode: an editor that saves by renaming a new file over the old one
  is invisible inside the container, so edit in place or
  `docker compose up -d --force-recreate` afterwards.
- **The workload runs unprivileged.** The image creates a `phoebe` user
  (uid 10001) and ends with `USER phoebe`, so `boot`, the engine, the agent
  child, and your repo's install/check/test commands all run as it. Two things
  follow, and both bite quietly if you customise around them:
  - The four `/data` mount points are created **and chowned in the image**,
    before any volume exists. Docker seeds a fresh named volume from the image's
    contents at that path, ownership included — add a fifth volume without
    adding its directory to that `mkdir`/`chown` and Docker will create the
    mount point as `root:root`, leaving it unwritable.
  - Anything the workload writes must be under `/data` or `$HOME`
    (`/home/phoebe`, set explicitly because the engine forwards `HOME` to the
    agent child). Bind-mounted files must be readable by _other_ — a git
    checkout's default `0644` is; a `0600` config is not.
- **The provider CLI is pinned, not piped.** The scaffold installs Cursor's
  agent from a pinned, `sha256`-verified tarball rather than the
  `curl https://cursor.com/install | bash` one-liner Cursor documents, and
  symlinks it to `/usr/local/bin/agent` — on `PATH` for every user, so it still
  resolves after the privilege drop.

  The trade-off, since this is your file to change: piping the vendor installer
  into a shell means two builds of the same Dockerfile can produce different
  images, and neither records which agent version it got. Pinning costs you a
  version that goes stale until you bump it deliberately. Cursor publishes no
  checksums and no `latest` indirection, so the digests in the Dockerfile are
  **ours** — recorded from the artifact its installer fetched — and pin the
  build rather than attesting anything about the vendor. To bump: run the vendor
  installer once, read the version out of the download URL it prints, and
  `sha256sum` the `linux/x64` and `linux/arm64` tarballs. If you switch to Claude
  Code or Codex (the commented lines), both are npm packages — pin with
  `@version` there instead.

- **`.gitignore` edits are additive.** `init` only appends; it never rewrites
  your existing ignore rules.

## Upgrading a pre-multi-tenant deployment (clean break)

Multi-tenant Phoebe changed the on-disk layout: state now nests per repo under
two named volumes (`phoebe-data` → `/data/repos/<owner>/<repo>/{repo,worktrees,state}`,
`phoebe-engine` → `/data/engine`) instead of the old four (`phoebe-repo`,
`phoebe-worktrees`, `phoebe-state`, `phoebe-engine`). There is **no in-place
migration** — it is a clean break:

1. `phoebe init` a fresh deployment (or pull the new `container/` templates) so
   `compose.yml` declares the two volumes and mounts the deployment dir at
   `/etc/phoebe`. Your `phoebe.config.ts` is unchanged (a `paths` field, if you
   ever set one, is gone — paths are now derived from `repoSlug`).
2. `docker compose up -d`. The new volumes start **empty**; the engine re-clones
   its target lazily on the first work unit (a fresh clone, not a migration of
   the old volume). Nothing is copied across.
3. **Rollback** is `git revert` of the compose commit: the old differently-named
   volumes were never touched and persist until you `docker volume prune` them,
   so reverting brings the previous deployment straight back.

Going from **one repo to many** needs no re-init: `phoebe add-repo <owner/repo>`
per repo drops a tenant under `repos/` and the running supervisor picks it up on
the next poll (see [`configuration.md`](configuration.md) and
[`operating.md`](operating.md)). Read [`trust.md`](trust.md) first — co-locating
repos in one container means co-locating them in **one trust domain**.

## `state/<slug>/status.json` is retired

After this release, `state/<slug>/status.json` is neither written nor read —
the status-v2 snapshot (`status-v2.json`) is the only projection Phoebe
maintains. **No cleanup code ships.** Deleting a stale `status.json` on boot
would be deletion code that runs against a user's state volume, is needed for
exactly one release, and is dead weight forever after — a poor trade for a few
hundred bytes. Its presence is a harmless marker of which engine version last
wrote the tenant's state dir; remove it at leisure, or leave it, whichever you
prefer.

## First install

For the full, execute-top-to-bottom install runbook — prerequisites, secrets,
first one-shot, starting the daemon — see [`ai-install.md`](ai-install.md).
</content>
