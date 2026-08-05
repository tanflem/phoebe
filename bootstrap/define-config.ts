// `defineConfig` — the identity typing helper consumers import from
// `phoebe-agent` to author their `phoebe.config.ts`:
//
// ```ts
// import { defineConfig } from "phoebe-agent";
// export default defineConfig({ repoSlug: "...", ... });
// ```
//
// It lives in the bootstrapper (the published package surface) rather than the
// engine because the bootstrapper is what a consumer installs. The config shape
// itself (`PhoebeUserConfig`, including the bootstrapper-only `engine` and
// `workspace` fields) is owned by the engine's config schema; this is only the
// typing helper. The value is never read at runtime beyond being forwarded —
// the whole benefit is editor autocomplete and a compile-time check that only
// known fields appear.

import type { PhoebeUserConfig } from "../src/config-schema.ts";

export function defineConfig(config: PhoebeUserConfig): PhoebeUserConfig {
  return config;
}
