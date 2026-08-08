// Tenant: JesusFilm/phoebe — Phoebe working its own repo, as one tenant of the
// nested multi-tenant dogfood (#77). Mirrors the flat dogfood's config
// (`.phoebe/phoebe.config.ts`) for this repo's pnpm + vite-plus toolchain, minus
// the `engine` field: engine source is shared and set once in the
// deployment-root config (../../../phoebe.config.ts), never per tenant (#60).
//
// Type-only import, resolved into this repo's own source since that is what the
// container runs; erased at runtime by Node's type-stripping.
import type { PhoebeUserConfig } from "../../../../src/config/types.ts";

const config: PhoebeUserConfig = {
  repoSlug: "JesusFilm/phoebe",
  repoUrl: "https://github.com/JesusFilm/phoebe.git",

  // pnpm + vite-plus (`vp`); the image enables corepack so the pinned pnpm is on
  // PATH. installCommand runs in each worktree; check/test/ready go to the agent.
  installCommand: "pnpm install --frozen-lockfile",
  checkCommand: "pnpm run check",
  testCommand: "pnpm run test",
  readyCommand: "pnpm run ready",

  // Cursor provider (composer-2.5 default). Requires CURSOR_API_KEY in THIS
  // tenant's .env — the supervisor scrubs every other tenant's secrets (#61).
  defaultProvider: "cursor",
};

export default config;
