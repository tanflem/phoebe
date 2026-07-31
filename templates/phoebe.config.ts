// Phoebe consumer config — scaffolded by `phoebe init`.
//
// Only the five fields at the top are required. Everything else has a shipped
// default (see the `PhoebeUserConfig` type); add overrides here only when you
// need them, and engine upgrades pick up new defaults automatically.
//
// This is a *type-only* import on purpose. The container mounts this file at
// /etc/phoebe and `phoebe boot` imports it before the engine exists, from a
// directory with no reachable `node_modules` — a value import of `{{CLI_BIN}}`
// (the `defineConfig` helper) could not resolve there under ESM. A type-only
// import is erased at runtime, so it type-checks in your editor and costs
// nothing in the container.

import type { PhoebeUserConfig } from "{{CLI_BIN}}";

const config: PhoebeUserConfig = {
  repoSlug: "{{REPO_SLUG}}",
  repoUrl: "{{REPO_URL}}",
  installCommand: "{{INSTALL_COMMAND}}",
  checkCommand: "{{CHECK_COMMAND}}",
  testCommand: "{{TEST_COMMAND}}",

  // Which agent CLI Phoebe runs by default: "claude", "cursor", or "codex".
  // Override for a single run with the PHOEBE_AGENT env var. The matching
  // provider key must be set in `.env` (see .env.example). `phoebe setup` picks
  // this for you.
  defaultProvider: "{{DEFAULT_PROVIDER}}",

  // Which engine `phoebe boot` runs. This is the upgrade knob: edit it and the
  // running container drains the engine and relaunches on the new code at the
  // next work-unit boundary — no rebuild, no restart.
  //
  //   ref: "main"      follow the tip — every push lands here. Guarded: a
  //                    commit that will not boot is quarantined after a few
  //                    fast crashes and `boot` pins back to the last one that
  //                    ran healthily, until the branch moves past it.
  //   ref: "v1.2.3"    pin a tag (or a full SHA). Exactly this commit, always.
  //                    No fallback — pinning means pinning.
  //
  // `repo` defaults to the upstream engine repo; set it to run a fork.
  // For a checkout on your own machine, see container/compose.local.yml.
  engine: { source: "github", ref: "main" },
};

export default config;
