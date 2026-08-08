// Type surface of the `phoebe-agent` bootstrapper package — the `types` entry.
// The runtime entry is index.mjs (plain JS, because Node 24 won't type-strip the
// installed package under node_modules); this file exists only to type a
// consumer's config authoring:
//
// ```ts
// import { defineConfig, type PhoebeUserConfig } from "phoebe-agent";
// export default defineConfig({ repoSlug: "...", ... });
// ```
//
// `defineConfig` is the identity typing helper; the config types are owned by
// the engine's config schema. The engine-source reader (engine-source.ts) is the
// bootstrapper's own internal concern — it is not part of the published surface
// yet, so it is not re-exported here.

export { defineConfig } from "./define-config.ts";
export type {
  EngineSourceField,
  PhoebeConfig,
  PhoebeUserConfig,
  PathsConfig,
  PromptFilesConfig,
  ProviderName,
  WorkspaceField,
} from "../src/config/types.ts";
