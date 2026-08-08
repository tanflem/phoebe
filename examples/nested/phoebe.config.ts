// Reference illustration — nested topology, DEPLOYMENT-ROOT config.
//
// Nested = one container serving many repos as isolated tenants (the map #57
// `repos/<owner>/<repo>/` layout). The presence of the `repos/` directory beside
// this file is what selects nested mode (bootstrap/tenants.ts); each tenant's
// repo/branch/command config lives in its own repos/<owner>/<repo>/phoebe.config.ts.
//
// This root file is SHARED-ONLY: in nested mode the bootstrapper reads just the
// `engine` source from it (one engine version for the whole fleet — a tenant
// config that carries `engine` is ignored with a warning). So the type is
// narrowed to exactly the one field the root owns — `Pick<…, "engine">` — rather
// than the full five-required-field PhoebeUserConfig every tenant uses. That is
// the honest shape: this file has no repoSlug/commands because it describes no
// single repo.
//
// Convention (issue #115), same as every example: type-only import from the
// published `phoebe-agent` specifier — never a relative `../src/...` path. It
// still type-checks in-tree via this package's own `name` + `exports`
// self-reference, so the example can't silently rot against src/config/types.ts.

import type { PhoebeUserConfig } from "phoebe-agent";

const config: Pick<PhoebeUserConfig, "engine"> = {
  // Shared across the fleet: pin which engine version `phoebe boot` checks out
  // for every tenant. Omit ⇒ github/main (bleeding edge). See docs/configuration.md.
  engine: { source: "github", ref: "v0.1.0" },
};

export default config;
