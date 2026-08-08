// Vitest setup file (wired via `test.setupFiles` in vite.config.ts).
//
// Installs a resolved config into the engine's runtime holder before any test
// module loads, so any test that imports engine modules (orchestrator, prompt,
// resolved-config) sees a fully-populated `config` — without dragging in the
// repo-root sample and without every test having to install the config itself.
//
// The values are the sample from ../phoebe.config.ts merged with the shipped
// defaults; tests that want a different config can call `setResolvedConfig`
// with their own value before the module under test triggers a read.

import { resolveConfiguration } from "./config/index.ts";
import { setResolvedConfig } from "./resolved-config.ts";
import { config as sampleUserConfig } from "../phoebe.config.ts";

setResolvedConfig(resolveConfiguration({ repository: sampleUserConfig }).config);
