// Fleet config — Phoebe working the tanflem/phoebe fork.
//
// Type-only import, same as the shipped scaffold: this config is loaded from a
// container mount with no reachable `node_modules`, so a value import could not
// resolve under ESM. The scaffold's import resolves the published package; here
// it resolves this repo's own source, since that is what the container runs.
import type { PhoebeUserConfig } from "../src/config/types.ts";

const config: PhoebeUserConfig = {
  repoSlug: "tanflem/phoebe",
  repoUrl: "https://github.com/tanflem/phoebe.git",

  // This repo is pnpm + vite-plus (`vp`). The container enables corepack, so
  // `pnpm` resolves to the version pinned in package.json's `packageManager`.
  // installCommand is run by the engine (execSync) in each worktree;
  // check/test are rendered into the agent prompt and run by the agent.
  installCommand: "pnpm install --frozen-lockfile",
  checkCommand: "pnpm run check",
  testCommand: "pnpm run test",
  readyCommand: "pnpm run ready",

  // Fleet test with the Cursor provider (composer-2.5 default). Requires
  // CURSOR_API_KEY in the container env (see .env).
  defaultProvider: "cursor",

  // Run the engine from the host working tree mounted at /opt/phoebe-engine
  // (container/compose.yml) rather than a github checkout, so `boot` execs
  // exactly what is checked out. Only the bootstrapper reads this field; the
  // engine drops it in resolveConfiguration.
  engine: { source: "local" },
};

export default config;
