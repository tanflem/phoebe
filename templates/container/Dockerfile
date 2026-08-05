# Phoebe runtime image — scaffolded by `phoebe init`.
#
# Consumer-owned: commit this file, tweak it as you need. Phoebe treats the
# resulting image as both orchestrator and execution environment.
#
# The image carries the *bootstrapper* (`{{CLI_BIN}}` from npm), not the engine.
# `phoebe boot` is the container's long-lived main process: it reads the mounted
# `phoebe.config.ts`, materializes the engine from the source named there
# (`engine: { source: "github", ref }` by default), execs it, and keeps
# supervising it — relaunching on a config or ref change, falling back to the
# last engine commit that ran healthily if a new one will not boot, and draining
# it gracefully on `SIGTERM`. So changing engine version is a config edit, not
# an image rebuild; this image only changes when the toolchain around it does.
#
# What ships in this image:
#   * Node.js 24 + git + GitHub CLI (`gh`) — the runtime the engine drives.
#   * A globally installed `{{CLI_BIN}}` (the bootstrapper).
#   * Your agent provider's CLI.
#
# What lives on named volumes (see compose.yml):
#   * /data/repos   — All tenant data, nested per repo as
#                     /data/repos/<owner>/<repo>/{repo,worktrees,state}.
#   * /data/engine  — The shared engine checkout + crash-loop record, so a
#                     restart fetches instead of cloning.
#
# The workload runs as the unprivileged `phoebe` user, not root — see the
# privilege-drop block below for the two things that constrains.

FROM node:24-bookworm-slim

# gh CLI + git + tini for signal handling; keep the layer small.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git gnupg tini \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Native stacked PRs (config `stackMode: "native"` / `PHOEBE_STACK_MODE=native`)
# additionally need the `github/gh-stack` gh extension plus `remote.pushDefault`
# and `rerere.enabled` git config. The engine installs the extension and sets
# that config on first boot, guarded so the default (`banner`) image pulls in no
# gh-stack dependency and needs no build-time network/auth. If you run native
# mode and prefer the extension baked in (offline-boot repos, air-gapped CI),
# add it here as the `phoebe` user AFTER the privilege drop below — extensions
# live in the user's gh config dir, so installing it as root here would hide it
# from the workload — e.g. `RUN gh extension install github/gh-stack`.

# The unprivileged user everything below the privilege drop runs as, and the
# two volume mount points, created *now* while we are still root.
#
# The ordering matters and is not cosmetic: Docker seeds a **fresh named volume
# from the image's contents at that path, ownership included**. If /data/repos
# does not exist in the image, Docker creates the mount point as root:root and
# the first `git clone` fails with EACCES. Creating and chowning them here is
# what makes the volumes writable after the drop — and because the whole
# /data/repos tree is then phoebe-owned, the engine's runtime
# `mkdir -p /data/repos/<owner>/<repo>/{repo,worktrees,state}` nests freely.
#
# (`node:24` already ships a uid-1000 `node` user. We add our own so the name
# in `ps`, in log output, and on the volumes says what it is, and so the uid is
# stable if the base image ever renumbers `node`. The uid is a literal rather
# than a build ARG because nothing needs to vary it — everything Phoebe writes
# lives on named volumes, which take their ownership from this image, not from
# any host uid. Change it here if you have a reason to.)
RUN useradd --create-home --shell /bin/bash --uid 10001 --user-group phoebe \
 && mkdir -p /data/repos /data/engine \
 && chown -R phoebe:phoebe /data

# The bootstrapper. Unpinned on purpose: which *engine* you run is `engine.ref`
# in phoebe.config.ts, and this package is only the thin launcher around it.
# Pin it (`{{CLI_BIN}}@<version>`) if you want the launcher itself frozen too.
#
# Installed as root into /usr/local, which `phoebe` only ever reads: at boot it
# copies itself out to PHOEBE_ENGINE_DIR (/data/engine, owned by us) before
# running anything, because Node 24 refuses to type-strip TypeScript under a
# `node_modules/` path segment.
RUN npm install -g {{CLI_BIN}}

# Provider agent CLI. The engine spawns the selected provider's CLI as a child
# (`agent` for cursor, `claude`, or `codex`), so the one matching your
# `defaultProvider` / `PHOEBE_AGENT` must be on PATH — otherwise the run dies
# with `spawn <cli> ENOENT`. Default below installs Cursor. Swap or add the
# commented lines for the provider you actually run.
#
# This is deliberately NOT the `curl https://cursor.com/install | bash` one-liner
# Cursor documents. That pipes whatever the vendor serves at build time straight
# into a shell, so two builds of the same Dockerfile can produce different
# images and neither records which agent it got. Cursor publishes no checksums
# and no `latest` indirection, but its installer does resolve to a plain
# versioned artifact, which is what we pin to. The digests below are ours,
# computed on 2026-07-28 by fetching both architectures' tarballs from the URL
# below — they pin the build, they are not a vendor attestation.
#
# To bump: run the vendor installer once and read the version out of the
# DOWNLOAD_URL it echoes, then `sha256sum` the linux/x64 *and* linux/arm64
# tarballs. Both, even if you only build one — an unchecked digest for the other
# arch turns into a hard build failure the day someone builds on it.
ARG CURSOR_AGENT_VERSION=2026.07.23-e383d2b
ARG CURSOR_AGENT_SHA256_X64=702ad595213bee5df0268be9f80a19f29fcceaa2a42fc55e39f2b5199051f0c4
ARG CURSOR_AGENT_SHA256_ARM64=f40b99647cb24e0da885e97620a2048034f1fe8961910d573d827d77c4d26dcb
# Set by BuildKit; the fallback keeps the classic builder working.
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) cursor_arch=x64;   cursor_sha="${CURSOR_AGENT_SHA256_X64}" ;; \
      arm64) cursor_arch=arm64; cursor_sha="${CURSOR_AGENT_SHA256_ARM64}" ;; \
      *) echo "cursor-agent publishes no build for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/cursor-agent.tar.gz \
      "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/${cursor_arch}/agent-cli-package.tar.gz"; \
    echo "${cursor_sha}  /tmp/cursor-agent.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/cursor-agent; \
    tar --strip-components=1 -xzf /tmp/cursor-agent.tar.gz -C /opt/cursor-agent; \
    chmod 0711 /opt/cursor-agent/node; \
    rm /tmp/cursor-agent.tar.gz; \
    ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/agent; \
    ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent
# Both symlink names on purpose: the engine spawns `agent`, but the vendor
# installer we replaced also created `cursor-agent`, and Cursor's own docs use
# that name. Dropping it would make this a silent behaviour regression for
# anyone whose scripts follow those docs.
#
# `chmod 0711 …/node` is the multi-tenant secret-isolation guard (#61), and it
# is deliberately on `node`, not on the `cursor-agent` entry point. Every entry
# point the vendor ships — `cursor-agent`, `cursor-agent-svc`, `cursor-askpass`
# — is a *shell script* that just execs this bundled `node`; a shell script must
# stay readable by its interpreter, so chmod-ing the entry point 0711 only makes
# it fail to run (`bash: …/agent: Permission denied`, exit 126). `node` is the
# one binary that actually holds the agent's environment — GH_TOKEN and the
# active provider's API key (src/agent-env.ts) — in a long-lived process. Making
# it execute-only-to-others (root-owned 0711) means the unprivileged uid can
# exec it but not read it, so the kernel marks the exec AT_SECURE and the
# process non-dumpable: a same-uid sibling tenant cannot read its
# /proc/<pid>/environ and lift the keyring. One chmod covers all three entry
# points, since they funnel through this same `node`. Execute-only ELFs run
# fine (the loader maps the image; the readable .node addons load normally).
#
# The installer would have put these in ~/.local/bin and needed a PATH entry
# pointing into a home directory. /usr/local/bin is already on PATH for every
# user, so the agent child resolves `agent` after the privilege drop with no
# PATH edit — and no root-owned home directory leaks into its env
# (src/agent-env.ts forwards PATH and HOME to the agent verbatim).
#
# Swapping providers? Pin these too — an unpinned `npm install -g` has the same
# problem as the installer pipe above, just with a lockfile-shaped hole instead
# of a shell-shaped one. Check the registry for the current version:
# Claude Code:  RUN npm install -g @anthropic-ai/claude-code@<version>
# Codex:        RUN npm install -g @openai/codex@<version>

# Consumer install command, kept as an ARG so it lands in the image metadata
# and can be inspected with `docker image inspect`. The engine re-runs the
# command inside each worktree; this is just documentation for operators.
ARG PHOEBE_INSTALL_COMMAND="{{INSTALL_COMMAND}}"
LABEL phoebe.install-command="${PHOEBE_INSTALL_COMMAND}"

# Execution-gate marker: the engine refuses to mutate a clone, launch an agent,
# or push unless `/.phoebe-container` exists (src/execution-gate.ts). Without it
# the container refuses every non-dry-run unit. Root-owned and read-only to us
# on purpose — the gate is only ever tested for existence, never written.
RUN touch /.phoebe-container

# The privilege drop. Everything past this line — `boot`, the engine, the agent
# child, and your repo's install/check/test commands — runs unprivileged.
#
# Two things this constrains:
#   * Anything the workload writes must be under /data (the volumes above) or
#     $HOME. That covers the package manager and provider CLI caches, which is
#     why HOME is set explicitly rather than left to the runtime: the engine
#     forwards HOME to the agent child, and an unwritable one breaks the
#     provider CLI in ways that surface as unrelated errors.
#   * Files you bind-mount in (phoebe.config.ts, prompts/) must be readable by
#     *other* — the default 0644 from a git checkout is, but a 0600 file is not
#     and boot will fail to read its config.
ENV HOME=/home/phoebe
USER phoebe

# Compose's `command:` fully replaces `CMD` (it does not append to
# `ENTRYPOINT`), so the whole `phoebe boot` invocation must live in
# `ENTRYPOINT` — otherwise a compose `command: ["--run-once"]` would strip the
# bootstrapper away and tini would try to exec `--run-once` as a program.
# Keeping `CMD []` here means the compose files only ever contribute engine
# flags, which `boot` forwards to the engine it launches.
ENTRYPOINT ["/usr/bin/tini", "--", "phoebe", "boot"]
CMD []
