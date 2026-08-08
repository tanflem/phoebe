// Phoebe consumer config for JesusFilm/phoebe. It doubles as the fixture that
// src/test-setup.ts installs into src/resolved-config.ts before any test module
// loads, AND as this repo's tenant entry when it is a member of the workspace
// deployment one directory up (../phoebe.config.ts scans for it). Real consumers
// install `phoebe-agent` and export their own config; the shape is identical:
//
// ```ts
// import { defineConfig } from "phoebe-agent";
// export default defineConfig({
//   repoSlug: "your-org/your-repo",
//   repoUrl: "https://github.com/your-org/your-repo.git",
//   installCommand: "npm ci",
//   checkCommand: "npm run check",
//   testCommand: "npm test",
// });
// ```
//
// Only five fields are required (repo slug, clone URL, install/check/test
// commands). Everything else is optional and filled from the roster's shipped
// defaults (see src/config/) by `resolveConfiguration()`. Add entries here only
// when overriding a shipped default; `PHOEBE_*` env vars provide one-off
// overrides for a subset of scalar fields (see src/config/resolve.ts).

import { defineConfig } from "./bootstrap/define-config.ts";

export const config = defineConfig({
  repoSlug: "JesusFilm/phoebe",
  repoUrl: "https://github.com/JesusFilm/phoebe.git",

  // This repo is pnpm + vite-plus (`vp`); the container enables corepack so the
  // pinned pnpm is on PATH. installCommand runs in each worktree; check/test/
  // ready go to the agent.
  installCommand: "pnpm install --frozen-lockfile",
  checkCommand: "pnpm run check",
  testCommand: "pnpm run test",
  readyCommand: "pnpm run ready",

  // Cursor provider (composer-2.5 default); requires CURSOR_API_KEY in this
  // tenant's .env — the supervisor scrubs every other tenant's secrets.
  defaultProvider: "cursor",

  // As a workspace tenant, reuse this repo's standalone `.phoebe/` folder: the
  // supervisor reads `.env` (and cwd-relative prompts) from `.phoebe/` instead
  // of the repo root, so nothing is duplicated. The flat/standalone `.phoebe/`
  // deployment ignores this (configDir only applies to fleet tenants), so solo
  // still works unchanged. Requires engine >= v0.3.0.
  configDir: ".phoebe",
});

export default config;
