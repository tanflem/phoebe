// Deployment-root config for the NESTED (multi-tenant) dogfood — Phoebe running
// two repos in one container: JesusFilm/phoebe + JesusFilm/youtube-studio (#77).
//
// This is the sibling of the flat single-tenant dogfood (`.phoebe/`). The flat
// one exercises one engine child; this one exercises the *fleet* path — tenant
// discovery, the shared engine, the concurrency broker, per-tenant env-scrub,
// and hot add/remove — end to end, not just in the unit suite.
//
// In nested mode the bootstrapper reads ONLY the shared `engine` source from
// this root file (#60/#63); each tenant's repo/branch/command config lives in
// its own repos/<owner>/<repo>/phoebe.config.ts. The presence of `repos/` beside
// this file is what selects nested mode (bootstrap/tenants.ts).
//
// Type-only import, like both scaffolds: this file is loaded from a container
// mount with no reachable `node_modules`, so a value import could not resolve.
import type { PhoebeUserConfig } from "../src/config/types.ts";

// Only `engine` is read from the deployment root; the five required per-repo
// fields live per-tenant, so the type is narrowed to say exactly that. The
// dogfood runs the engine straight from the working-tree mount at
// /opt/phoebe-engine (container/compose.yml), so the shared source is `local`.
const config: Pick<PhoebeUserConfig, "engine"> = {
  engine: { source: "local" },
};

export default config;
