# Dogfood runtime image — Phoebe working its own repo.
#
# Adapted from the `phoebe init` scaffold (templates/container/Dockerfile).
# The deviations from the shipped template are marked below; everything else
# is the same image the scaffold produces. In particular the hardening — the
# unprivileged user, the pre-owned /data mount points, and the pinned provider
# CLI — is NOT a permitted deviation, and `src/container-image.test.ts` asserts
# the two files stay in step on all three.

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

# Native stacked PRs (`stackMode: "native"`) need the `github/gh-stack` gh
# extension + `remote.pushDefault`/`rerere.enabled` git config. The engine
# installs both on first boot, guarded so the default image carries no gh-stack
# dependency. See the longer note in templates/container/Dockerfile for baking
# the extension in instead (must be installed as the `phoebe` user).

# The unprivileged user everything below the privilege drop runs as, and the
# two volume mount points, created *now* while we are still root. Docker seeds
# a fresh named volume from the image's contents at that path, ownership
# included — so a mount point that does not exist here is created root-owned
# and unwritable after the drop. The engine nests
# /data/repos/<owner>/<repo>/{repo,worktrees,state} under the phoebe-owned root.
RUN useradd --create-home --shell /bin/bash --uid 10001 --user-group phoebe \
 && mkdir -p /data/repos /data/engine \
 && chown -R phoebe:phoebe /data

# DOGFOOD DEVIATION: enable corepack so `pnpm` (pinned via package.json's
# `packageManager`) is on PATH for the engine's installCommand and the agent's
# check/test gates. This repo is a pnpm + vite-plus toolchain, not npm.
#
# corepack downloads the pinned pnpm on first use, which as root landed in
# /root/.cache. Point it somewhere the unprivileged user owns instead — an
# explicit path rather than $HOME/.cache so the failure mode (a read-only
# COREPACK_HOME) is one named path to check, not a home-directory guess.
#
# COREPACK_ENABLE_DOWNLOAD_PROMPT=0: that first-use download otherwise stops to
# ask "Do you want to continue? [Y/n]" on a TTY. The engine runs installCommand
# non-interactively, so the prompt has no one to answer it and boot hangs. Off
# means corepack fetches the pinned pnpm silently. (The version is still pinned
# via package.json's `packageManager`, so this suppresses the confirmation, not
# the pin — corepack won't fetch anything the repo hasn't already named.)
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable \
 && mkdir -p /opt/corepack \
 && chown phoebe:phoebe /opt/corepack

# Provider agent CLI, pinned and checksum-verified rather than installed by
# piping `https://cursor.com/install` into a shell — see the long note in
# templates/container/Dockerfile for why, and for how to bump the pin. The pins
# and the install block below must both match that file byte for byte
# (asserted in src/container-image.test.ts).
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

# DOGFOOD DEVIATION: no `npm install -g phoebe-agent`.
#
# The scaffold installs the bootstrapper from npm and lets it check the engine
# out from GitHub. Here BOTH come from the host working tree mounted at
# /opt/phoebe-engine (container/compose.yml), which is the entire point of the
# dogfood: run exactly what is checked out. That also sidesteps npm still only
# publishing the `phoebe-agent@0.0.0` stub, which has no `boot` at all.
#
# So the image carries no Phoebe code, and nothing here needs rebuilding when
# `src/` or `bootstrap/` changes. Compose overrides the entrypoint to run the
# mounted bootstrapper: `node /opt/phoebe-engine/bootstrap/cli.ts boot`.

# Consumer install command, kept as an ARG so it lands in the image metadata
# and can be inspected with `docker image inspect`. The engine re-runs the
# command inside each worktree; this is just documentation for operators.
ARG PHOEBE_INSTALL_COMMAND="pnpm install --frozen-lockfile"
LABEL phoebe.install-command="${PHOEBE_INSTALL_COMMAND}"

# Execution-gate marker: the engine refuses to mutate a clone, launch an agent,
# or push unless `/.phoebe-container` exists (src/execution-gate.ts). Without it
# the container refuses every non-dry-run unit.
RUN touch /.phoebe-container

# The privilege drop. Everything past this line runs unprivileged. Identical to
# the shipped template, and asserted so.
#
# DOGFOOD DEVIATION (consequence, not a difference in these lines): the working
# tree is mounted read-only at /opt/phoebe-engine and has to stay readable by
# *other* for this user to run the bootstrapper off it — a git checkout's
# default 0644/0755 is, so this costs nothing in practice.
ENV HOME=/home/phoebe
USER phoebe

# No ENTRYPOINT here: compose supplies it, because the bootstrapper this image
# runs lives on the mount rather than in the image (see the deviation above).
