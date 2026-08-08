// Tenant: JesusFilm/youtube-studio — Phoebe's real internal consumer, run here as
// the second tenant of the nested multi-tenant dogfood (#77). Same pnpm +
// vite-plus toolchain family as this repo. No `engine` field: the engine source
// is shared, set once in the deployment-root config (#60).
//
// The install/check/test commands are seeded from youtube-studio's own toolchain
// (pnpm + `vp`); confirm them against that repo's scripts before a real run. They
// are NOT exercised by the boundary smoke — with a dummy token every tenant's
// engine child stops at its first `gh` call, before any install.
//
// Deliberately a DIFFERENT provider from the phoebe tenant (cursor): this tenant
// authenticates with ANTHROPIC_API_KEY, the phoebe tenant with CURSOR_API_KEY,
// and the supervisor's per-tenant env-scrub (#61) means neither child can ever
// read the other's key at all.
import type { PhoebeUserConfig } from "../../../../src/config/types.ts";

const config: PhoebeUserConfig = {
  repoSlug: "JesusFilm/youtube-studio",
  repoUrl: "https://github.com/JesusFilm/youtube-studio.git",

  installCommand: "pnpm install --frozen-lockfile",
  checkCommand: "vp check",
  testCommand: "vp run -r test",
  readyCommand: "pnpm run ready",

  defaultProvider: "claude",
};

export default config;
