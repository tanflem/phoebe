// Explicit env allowlist for agent child processes. The agent sees PATH, HOME,
// git identity, the GitHub token, and the *active* provider's API key — never
// the other providers' keys, so a prompt-injected agent can't exfiltrate the
// whole keyring.

import type { PhoebeConfig, ProviderName } from "./config/index.ts";

const BASE_ALLOWLIST = [
  "PATH",
  "HOME",
  "GH_TOKEN",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

export function buildAgentEnv(opts: {
  parentEnv: Record<string, string | undefined>;
  provider: ProviderName;
  providerEnv: PhoebeConfig["providerEnv"];
}): Record<string, string> {
  const { parentEnv, provider, providerEnv } = opts;
  const env: Record<string, string> = { CI: "true" };
  for (const key of [...BASE_ALLOWLIST, providerEnv[provider]]) {
    const value = parentEnv[key];
    if (value !== undefined && value !== "") {
      env[key] = value;
    }
  }
  return env;
}
