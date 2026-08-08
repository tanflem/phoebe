// The config seam's public face — the only file outside `src/config/` may
// import from. Everything else here (the roster, `applyEnvOverlay`,
// `parseBaseConfigDocument`, `validateUserConfig`, `resolveConfig`, and the
// roster's shipped defaults) is implementation.
//
// Four verbs carry the whole contract:
//   - `resolveConfiguration` — pure; the test surface.
//   - `loadConfiguration` — the filesystem path (boot, the engine CLI, `phoebe
//     config resolve`, `phoebe status` all funnel through this).
//   - `formatResolvedConfiguration` / `parseResolvedConfigurationSnapshot` —
//     the boot → engine snapshot pair.
//
// Plus the hand-written types/enum consts every layer of the seam shares, and
// a handful of filesystem-path helpers (`resolveConfigPath`,
// `resolveBaseConfigPath`, `loadUserConfig`) that callers outside this
// directory need before they can call the verbs above — e.g. the CLI resolves
// `--config` to an absolute path first so it can print a precise "file not
// found" message, and `phoebe boot` reads the mounted config directly to
// watch bootstrapper-only fields (`engine`, `configDir`) the resolved shape
// drops.

export type {
  BlockerSource,
  EngineSourceField,
  IssueSourceConfig,
  PathsConfig,
  PhoebeConfig,
  PhoebeUserConfig,
  PromptFilesConfig,
  ProviderName,
  ResolvedEngineSource,
  StackMode,
  WorkKindName,
  WorkspaceField,
} from "./types.ts";

export {
  BLOCKER_SOURCES,
  PROVIDER_NAMES,
  STACK_MODES,
  WORK_KIND_NAMES,
  validateEngineSourceField,
  validateWorkOrder,
} from "./types.ts";

export type { ResolvedConfiguration } from "./snapshot.ts";
export {
  BOOTSTRAP_RESOLVED_CONFIG_ENV,
  formatResolvedConfiguration,
  parseResolvedConfigurationSnapshot,
} from "./snapshot.ts";

export { resolveConfiguration } from "./resolve.ts";

export {
  loadConfiguration,
  loadUserConfig,
  resolveBaseConfigPath,
  resolveConfigPath,
} from "./load.ts";
