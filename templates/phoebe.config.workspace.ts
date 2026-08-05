// Workspace-root Phoebe config — scaffolded by `phoebe init --workspace`.
//
// Only `engine` and `workspace` are read from the deployment root. Per-repo
// config and secrets live in-tree on each child (scaffold with
// `phoebe init --tenant <dir>` after linking the child). The presence of the
// `workspace` block is what selects workspace discovery mode
// (`bootstrap/tenants.ts`): `phoebe boot` walks children under this root and
// treats each as a tenant — the root itself is never a tenant.
//
// Type-only import on purpose: the container mounts this file at /etc/phoebe
// and `phoebe boot` imports it before the engine exists, from a directory with
// no reachable `node_modules` — a value import of `{{CLI_BIN}}` could not
// resolve there under ESM.

import type { PhoebeUserConfig } from "{{CLI_BIN}}";

// Only these two fields are read from the deployment root; the five required
// per-repo fields live on each child. `Pick` says exactly that.
const config: Pick<PhoebeUserConfig, "engine" | "workspace"> = {
  // Which engine `phoebe boot` runs (shared across every child tenant).
  // Edit `ref` and the running container drains and relaunches on the new code
  // at the next work-unit boundary — no rebuild, no restart.
  //
  //   ref: "main"      follow the tip (crash-loop guard may pin back)
  //   ref: "v1.2.3"    pin a tag or full SHA
  //
  // `repo` defaults to the upstream engine repo; set it to run a fork.
  // For a checkout on your own machine, see container/compose.local.yml.
  engine: { source: "github", ref: "main" },

  // Workspace discovery: scan this many directory levels under the root for
  // children that carry a root-level `phoebe.config.ts`. Default is 1
  // (immediate children only). The root declaring this block is never itself
  // a tenant.
  workspace: { depth: 1 },
};

export default config;
