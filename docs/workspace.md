# Workspace mode: topology and operator runbook

How to run Phoebe at the root of a **workspace** whose child project repos are
linked as sub-repositories (git submodules preferred). Each child carries its
own in-tree Phoebe install; one container discovers them, and the multi-tenant
fleet supervisor (#57) runs one engine child per tenant.

Workspace mode is a **discovery source** only. The shared engine, per-tenant
children, fleet concurrency cap, env-scrub isolation, and reconcile loop are
the same machinery as the nested `repos/<owner>/<repo>/` layout. Nested
discovery is not removed — pick one mode per deployment (see [Mode selection](#mode-selection)).

For day-to-day labels and janitors, see [`operating.md`](operating.md). For the
nested add-repo path, see
[configuration.md → Multiple repos](configuration.md#multiple-repos-nested-tenants)
and [operating.md → Running many repos](operating.md#running-many-repos-in-one-container).

## Topology

```text
workspace-root/                         # bind-mounted :ro → /etc/phoebe
  phoebe.config.ts                      # engine + workspace: { depth } only
  .env                                  # deployment: engine-checkout GH_TOKEN, toggles
  .env.example
  .gitignore
  container/                            # Dockerfile, compose (deployment-owned)
  .git/                                 # must be on the mount (submodule origin metadata)
  .gitmodules                           # operator-owned; optional URL source only
  child-a/                              # submodule (or plain linked checkout)
    phoebe.config.ts                    # authoritative repoSlug, per-repo fields
    .env                                # this tenant's GH_TOKEN + provider key
    .env.example
    prompts/?                           # optional
  child-b/
    phoebe.config.ts
    .env
    …
```

| Layer              | Who owns it            | What it holds                                                                                                      |
| ------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Root**           | deployment / workspace | Shared `engine` + `workspace: { depth }`; deployment-level `.env`; `container/`                                    |
| **Child (tenant)** | each linked repo       | In-tree `phoebe.config.ts` + gitignored `.env` (+ optional `prompts/`); **no** `container/`                        |
| **Private clone**  | container volumes      | `/data/repos/<owner>/<repo>/` — each tenant still clones privately; the host submodule is **not** the working copy |

**One supervised engine child per tenant.** The bootstrapper walks the tree to
`workspace.depth` (default `1`), treats every directory with a root-level
`phoebe.config.ts` as a tenant, and never treats the workspace root itself as a
tenant. Bad children are skip-and-warned; a duplicate `repoSlug` aborts boot.

**Private clones.** Discovery reads config and secrets from the on-disk child
checkout; the engine still runs against a private clone under
`/data/repos/<owner>/<repo>/`. The host workspace is read-only discovery +
config — same isolation invariant as nested multi-tenant.

## Operator owns all git in the tree

**Phoebe never runs `git` in the workspace tree.** It does not `submodule add`,
`submodule update`, fetch, or commit there. The operator (or host CI) is
responsible for:

- `git init` the root when using submodules,
- `git submodule add <url> <dir>` for each child,
- `git submodule update --init` (and pin/bump submodule SHAs) **before** boot
  and whenever a child must appear as a real checkout.

An empty or unmaterialized child directory is skip-and-warned until the
checkout exists on disk. A `submodule update` that refreshes content moves
mtime; the fleet treats that as a changed tenant (existing mtime:size
fingerprint) and will respawn that child.

## Two-tier `.env` model

| Tier                  | Path                  | Contents                                                                                      | Who sees it                                                      |
| --------------------- | --------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Root (deployment)** | `workspace-root/.env` | Engine-checkout `GH_TOKEN`, default provider keys if used at boot, `PHOEBE_*` runtime toggles | Supervisor / compose; **not** handed wholesale to tenant engines |
| **Child (tenant)**    | `child/.env`          | That repo's `GH_TOKEN` + the active provider key                                              | That tenant's engine child only, after env-scrub                 |

**Config↔env binding is 1:1 by co-location**, same as nested: each child dir has
one `phoebe.config.ts` and one `.env`. The supervisor parses each child's `.env`
in-process and builds a deny-by-default env for that engine child
(`buildEngineChildEnv` — #61). The deployment engine-clone credential never
spreads into children; sibling tenants never receive each other's secrets in
env.

**On-disk residual (same as nested):** all children share one container uid, so
a prompt-injected agent can still _read_ another child's `.env` file off the
shared `/etc/phoebe` mount. Env-scrub is the runtime isolation boundary, not
filesystem ACL. Co-locate only repos in the same trust domain — see
[`trust.md`](trust.md#one-container--one-trust-domain).

## Nested `add-repo` ↔ workspace `init --tenant`

Two ways to put many repos under one container; same fleet underneath.

| Concern                  | Nested (`repos/`)                                              | Workspace                                                                |
| ------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Create deployment root   | `phoebe init` (then add tenants)                               | `phoebe init --workspace [dir]`                                          |
| Add a tenant skeleton    | `phoebe add-repo <owner/repo>` (mints `repos/<owner>/<repo>/`) | Operator: `git submodule add <url> <dir>` → `phoebe init --tenant <dir>` |
| Authoritative identity   | Path segment `<owner>/<repo>` (must match `repoSlug`)          | Child config `repoSlug` (origin cross-check is best-effort validation)   |
| Deployment secrets       | Root `.env`                                                    | Root `.env`                                                              |
| Per-tenant secrets       | `repos/<owner>/<repo>/.env`                                    | `<child>/.env`                                                           |
| Container templates      | Root `container/`                                              | Root `container/` (children never get `container/`)                      |
| Who runs git on the tree | Operator (optional clones for host review)                     | **Operator always** — submodules are operator-owned                      |

`add-repo` **mints a directory** under `repos/` from a slug. Workspace
`init --tenant` scaffolds an **already-linked** directory (you pass the path).
There is no `add-child` verb: submodule linking is git's job; Phoebe only
scaffolds the in-tree install.

## Mode selection

Detection ladder at boot (`bootstrap/tenants.ts`):

1. Root config has a `workspace: { depth? }` block → **workspace** mode  
   (if `repos/` also exists → workspace wins, with a warning; `repos/` is ignored).
2. Else a `repos/` directory is present → **nested** mode.
3. Else → **flat** (single-repo) mode.

Modes are mutually exclusive **per deployment**. Use nested when the deployment
owns tenant directories under `repos/`; use workspace when children are the
workspace's linked project checkouts.

## Operator runbook

End-to-end: create root → add children → materialize → boot.

### 1. Create the workspace root

```bash
npx --yes phoebe-agent init --workspace ./my-workspace
cd ./my-workspace
```

That scaffolds a bootable root:

- `phoebe.config.ts` with `engine` + `workspace: { depth: 1 }` (no per-repo
  install/check/test fields — those live on children),
- deployment `.env.example` (engine token + toggles; not tenant secrets),
- `.gitignore` (`.env`, `node_modules/`),
- `container/` (same single-deployment templates as #57).

Copy and fill the root `.env`, and pin the engine:

```bash
cp .env.example .env
# Edit .env: GH_TOKEN for the engine clone, optional PHOEBE_* toggles
# Edit phoebe.config.ts: engine.ref (e.g. "v0.1.0" or "main")
```

### 2. Make the root a git repo (if using submodules)

```bash
git init
# optional: first commit of the scaffold so submodule add has a parent tree
```

The workspace root need **not** be a git repository for discovery itself — only
for submodule workflow and so `.git` (including `.git/modules/…`) is present on
the host path that compose bind-mounts.

### 3. Per child: link, scaffold, secret

```bash
git submodule add https://github.com/acme/service-a.git service-a
npx --yes phoebe-agent init --tenant ./service-a
# Edit service-a/phoebe.config.ts if needed (repoSlug/repoUrl are prefilled from origin when present)
cp service-a/.env.example service-a/.env
# Fill service-a/.env: that repo's GH_TOKEN + provider key
```

Repeat for each child. `init --tenant` refuses if `phoebe.config.ts` already
exists (loud no-clobber). It does **not** create `container/` under the child.

### 4. Materialize checkouts before boot

```bash
git submodule update --init
# or: git submodule update --init --recursive
```

Without this, empty submodule dirs are skipped with a warning and are not
supervised until a real checkout appears.

### 5. Boot

From `container/`, same compose shape as flat/nested — whole parent dir mounted
`:ro` at `/etc/phoebe`, **including `.git`**:

```bash
cd container
docker compose --env-file ../.env build
docker compose --env-file ../.env run --rm phoebe --dry-run --run-once   # optional preview
docker compose --env-file ../.env up -d
```

`phoebe boot` then:

1. Selects workspace mode from the root `workspace` block,
2. Walks children to `depth`,
3. Hands the discovered set to the #57 fleet (one engine child per tenant,
   env-scrub, shared concurrency cap, reconcile re-walk every poll).

See the mount notes beside the scaffolded templates
(`container/README.md` when produced by `init --workspace`) for why `.git` must
stay on the mount and why submodules must be material before first boot.

## What stays the same as nested multi-tenant

- One container, one shared engine version (`engine` only on the root).
- `paths` still derive from each tenant's `repoSlug` under `/data/repos/…`.
- Fleet-wide `PHOEBE_MAX_CONCURRENT_AGENTS` (default 1).
- Log lines tagged `[phoebe:<owner>/<repo>]`.
- Trust domain: one container = co-locate only mutually trusted repos
  ([`trust.md`](trust.md#one-container--one-trust-domain)).

## Related work

| Topic                                                        | Where                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Discovery contract (depth, prune, skip-and-warn, duplicates) | #82, `bootstrap/tenants.ts`                                        |
| Mode ladder / coexistence with `repos/`                      | #83                                                                |
| Child in-tree layout                                         | #84                                                                |
| Origin cross-check / slug uniqueness                         | #85                                                                |
| Reconcile re-walk; operator owns git                         | #86                                                                |
| Mount model (`:ro`, include `.git`)                          | #87                                                                |
| Scaffold profiles / this runbook                             | #88                                                                |
| Nested operating commands                                    | [`operating.md`](operating.md#running-many-repos-in-one-container) |
