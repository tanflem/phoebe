import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { PhoebeConfig, ProviderName } from "./config/index.ts";
import { digestValue, type DigestSet, type WorkOutcomeEvent } from "./status-contract.ts";

export type RuntimeContractContext = {
  repository: {
    slug: string;
    url: string;
    defaultBranch: string;
  };
  digests: DigestSet;
  provider: WorkOutcomeEvent["provider"];
  verificationCommands: readonly string[];
  quarantinedEngineSha?: string;
  secrets: readonly string[];
};

function promptDigest(config: PhoebeConfig, runtimeRoot: string): string {
  const prompts = Object.entries(config.promptFiles).map(([kind, configuredPath]) => {
    const path = isAbsolute(configuredPath) ? configuredPath : resolve(runtimeRoot, configuredPath);
    try {
      return { kind, content: readFileSync(path, "utf8") };
    } catch {
      return { kind, unavailable: true };
    }
  });
  return digestValue(prompts);
}

export function buildRuntimeContractContext(options: {
  config: PhoebeConfig;
  providerName: ProviderName;
  model: string;
  runtimeRoot: string;
  env?: NodeJS.ProcessEnv;
}): RuntimeContractContext {
  const env = options.env ?? process.env;
  const policy = {
    defaultBranch: options.config.defaultBranch,
    branchPrefix: options.config.branchPrefix,
    readyLabel: options.config.readyLabel,
    researchLabel: options.config.researchLabel,
    processingLabel: options.config.processingLabel,
    prScope: options.config.prScope,
    draftPrs: options.config.draftPrs,
    prOptOutLabel: options.config.prOptOutLabel,
    blockedByPattern: options.config.blockedByPattern,
    blockerSource: options.config.blockerSource,
    stackMode: options.config.stackMode,
    workOrder: options.config.workOrder,
  };
  const providerModel = {
    provider: options.providerName,
    model: options.model,
  };
  const digests: DigestSet = {
    engine: digestValue({
      source: env["PHOEBE_RUNNING_ENGINE_SOURCE"] ?? "direct",
      repo: env["PHOEBE_RUNNING_ENGINE_REPO"] ?? null,
      ref: env["PHOEBE_RUNNING_ENGINE_REF"] ?? null,
      sha: env["PHOEBE_RUNNING_ENGINE_SHA"] ?? null,
    }),
    bootstrap: digestValue({
      version: env["PHOEBE_BOOTSTRAP_VERSION"] ?? "direct",
    }),
    config: digestValue(options.config),
    policy: digestValue(policy),
    prompts: promptDigest(options.config, options.runtimeRoot),
    providerModel: digestValue(providerModel),
  };
  return {
    repository: {
      slug: options.config.repoSlug,
      url: options.config.repoUrl,
      defaultBranch: options.config.defaultBranch,
    },
    digests,
    provider: {
      name: options.providerName,
      model: options.model,
      digest: digests.providerModel,
    },
    verificationCommands: [
      options.config.checkCommand,
      options.config.testCommand,
      options.config.readyCommand,
    ],
    secrets: [
      env["GH_TOKEN"] ?? "",
      ...Object.values(options.config.providerEnv).map((name) => env[name] ?? ""),
    ],
    ...(env["PHOEBE_QUARANTINED_ENGINE_SHA"]
      ? { quarantinedEngineSha: env["PHOEBE_QUARANTINED_ENGINE_SHA"] }
      : {}),
  };
}
