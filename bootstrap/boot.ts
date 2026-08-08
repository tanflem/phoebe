// `phoebe boot` — the container's long-lived main process.
//
// The bootstrapper's job at boot is small: read the mounted consumer config,
// resolve where the engine source lives, and exec that engine as a long-running
// child (its normal persistent poll loop). Stop signals are forwarded to the
// child so a container `SIGTERM` reaches the engine and triggers its graceful
// drain (src/drain.ts); the child's exit is propagated so the container exits
// with the engine's status.
//
// Two engine sources are wired: `local` — a host→container mount at
// `/opt/phoebe-engine` (the dev-only `compose.local.yml` overlay, #40) — and
// `github` — a git checkout of the engine repo at a ref (github-engine.ts, #41).
//
// Boot then stays in charge for the life of the container: the supervision loop
// (supervise.ts, #42/#65) polls the mounted config and the tracked ref, and when
// either moves it drains the engine(s), re-resolves the source, and relaunches —
// same container, no interrupted work unit. Flat is supervised as a fleet of one
// (#65) so nested/workspace's hot add/remove/change and flat's single-engine
// crash-loop retry are the same loop, not two. Following a branch also means
// eventually following it onto a commit that will not boot, so every launch
// passes through the crash-loop guard (crash-loop.ts, #43): a tip that dies fast
// enough times is quarantined and boot materializes the last commit that ran
// healthily instead. This module is the wiring; the loop lives in supervise.ts,
// the fallback policy in crash-loop.ts, and everything impure is passed in from
// here.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installDrainSignal } from "../src/drain.ts";
import { defaultGit, type GitRunner } from "../src/git-model.ts";
import {
  BOOTSTRAP_RESOLVED_CONFIG_ENV,
  formatResolvedConfiguration,
  loadConfiguration,
  resolveBaseConfigPath,
  type ResolvedConfiguration,
} from "../src/config/index.ts";
import { createCrashGuard, type CrashGuard } from "./crash-loop.ts";
import { resolveDeployment } from "./deployment.ts";
import type { ResolvedEngineSource } from "./engine-source.ts";
import { lsRemoteBranchSha, materializeGithubEngine } from "./github-engine.ts";
import {
  deploymentConfigFingerprint,
  supervise,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_INTERVAL_MS,
  type EngineExit,
  type LaunchedEngine,
} from "./supervise.ts";
// Untyped plain-JS import (see spawn-engine.mjs / materialize.mjs for why the
// bootstrapper's child-process plumbing can't be TypeScript).
import { propagateExit } from "./spawn-engine.mjs";

/** Where the local-engine compose overlay mounts the engine for `source: "local"`. */
export const LOCAL_ENGINE_DIR = "/opt/phoebe-engine";
export const BASE_CONFIG_PROTOCOL_MARKER = "bootstrap-config-protocol.json";

/**
 * A base-configured bootstrapper must not start an engine too old to consume
 * its immutable resolution snapshot. The marker travels with capable engine
 * source trees and makes incompatibility a pre-spawn error instead of silently
 * running different bootstrapper and engine configurations.
 */
export function assertBaseConfigProtocol(
  engineEntry: string,
  baseConfigPath: string | undefined,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): void {
  if (baseConfigPath === undefined) return;
  const markerPath = join(dirname(engineEntry), BASE_CONFIG_PROTOCOL_MARKER);
  let supported = false;
  try {
    const marker = JSON.parse(read(markerPath)) as { schemaVersion?: unknown };
    supported = marker.schemaVersion === 1;
  } catch {
    // The common case is a pre-feature engine tree with no marker. All marker
    // failures mean the same thing operationally: do not start this engine.
  }
  if (!supported) {
    throw new Error(
      `Engine at ${engineEntry} does not support PHOEBE_BASE_CONFIG ${baseConfigPath}. ` +
        `Select an engine ref with ${BASE_CONFIG_PROTOCOL_MARKER} schemaVersion 1.`,
    );
  }
}

/**
 * Runs `gh` with the given argv. Injectable so boot's credential-helper setup is
 * unit-tested without a real `gh` binary or a writable `~/.gitconfig`.
 */
export type GhRunner = (args: readonly string[]) => void;

export const defaultGh: GhRunner = (args) => {
  execFileSync("gh", args, { stdio: "inherit" });
};

/**
 * Configure a global git credential helper from `GH_TOKEN` so every later git
 * call against github.com authenticates — the engine's `ensureClone` /
 * `fetchOrigin` / `pushBranch`, and the agent child's own `git push`/`fetch`.
 *
 * Uses `gh auth setup-git --hostname github.com`, which writes a
 * `!gh auth git-credential` helper into `~/.gitconfig`. That helper reads
 * `GH_TOKEN` live per call, so no secret is written to disk and token rotation
 * keeps working. Only `github.com` is configured (Phoebe is github-only).
 *
 * Skipped when no token is present (public/anonymous path unchanged). A failed
 * setup warns and continues — a missing helper is better diagnosed at the first
 * private-repo clone than by aborting the container here.
 */
export function setupGitCredentials(deps: {
  token: string | undefined;
  gh?: GhRunner;
  warn?: (message: string) => void;
}): void {
  if (!deps.token) return;
  const gh = deps.gh ?? defaultGh;
  const warn = deps.warn ?? ((message) => console.warn(message));
  try {
    gh(["auth", "setup-git", "--hostname", "github.com"]);
  } catch (error) {
    warn(
      `[phoebe] boot: could not configure git credentials — ${describe(error)}. ` +
        `Continuing without a credential helper.`,
    );
  }
}

/**
 * Resolve a `local` engine source to the mounted engine's `src/cli.ts`, failing
 * loudly if it is absent — a missing/empty mount means a misconfigured
 * container, not a fallback. Checking the entry file (not just the directory)
 * catches a mounted-but-empty volume too. `github` is handled separately
 * (materializeGithubEngine), so this only ever sees `local`.
 *
 * `exists`/`localEngineDir` are injectable so the decision is unit-tested
 * without a real filesystem.
 */
export function resolveEngineEntry(
  _source: { source: "local" },
  deps: { localEngineDir?: string; exists?: (path: string) => boolean } = {},
): string {
  const exists = deps.exists ?? existsSync;
  const dir = deps.localEngineDir ?? LOCAL_ENGINE_DIR;
  const entry = join(dir, "src", "cli.ts");
  if (!exists(entry)) {
    throw new Error(
      `engine.source is "local" but no engine is mounted at ${dir} (missing ${entry}). ` +
        `Mount the engine there (container/compose.local.yml) before \`phoebe boot\`.`,
    );
  }
  return entry;
}

/**
 * Base directory the github source clones the engine into. Reuses
 * `PHOEBE_ENGINE_DIR` (the same knob bin.mjs materializes under); point it at a
 * persistent volume so github clones survive restarts and later boots fetch
 * instead of re-cloning. Defaults to a per-user temp dir for local dev.
 */
function engineBaseDir(): string {
  return process.env["PHOEBE_ENGINE_DIR"] ?? join(tmpdir(), "phoebe-agent");
}

/**
 * How often the reconcile watch samples the config and the tracked ref.
 * `PHOEBE_RECONCILE_INTERVAL_MS` tightens it for dogfooding (the default is a
 * minute, which is a long time to wait when demonstrating a relaunch).
 */
function reconcileIntervalMs(): number {
  const raw = Number(process.env["PHOEBE_RECONCILE_INTERVAL_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS;
}

/**
 * How long a drain (config/ref change, or a tenant add/remove/change) gets
 * before boot escalates to SIGKILL (#23/#79). `PHOEBE_RECONCILE_DRAIN_TIMEOUT_MS`
 * overrides for a deployment whose `runTimeoutMs` (the engine's own whole-unit
 * budget) is raised past the default bound — flat and nested/workspace alike.
 */
function reconcileDrainTimeoutMs(): number {
  const raw = Number(process.env["PHOEBE_RECONCILE_DRAIN_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DRAIN_TIMEOUT_MS;
}

/**
 * Load the mounted `phoebe.config.ts` as the arbitrary record the bootstrapper
 * treats it as — it owns only one field (`engine`), and the engine validates the
 * rest once it is materialized and run. The fingerprint doubles as the ESM
 * cache-bust key, so a re-read after an edit is genuinely a re-read.
 *
 * Exported (not file-private) so the base-config/runtime contract test can
 * resolve through the same entry point boot itself uses.
 */
export function loadBootConfiguration(
  configPath: string,
  env: NodeJS.ProcessEnv,
  fingerprint: string | null,
): Promise<ResolvedConfiguration> {
  return loadConfiguration({
    repositoryPath: configPath,
    env,
    reloadKey: fingerprint ?? undefined,
  });
}

/**
 * Read the config and turn the engine source it names into something runnable —
 * the whole of a (re)launch. Called once at boot and again for every reconcile,
 * so an edited config is genuinely re-read (hence the fingerprint as the ESM
 * cache-bust key) and a moved ref is genuinely re-fetched.
 *
 * The tracked ref's tip is materialized first even when a fallback is in force:
 * the tip is what the guard's verdict is *about*, so resolving it is how boot
 * notices both that the quarantine still applies and that the branch has moved
 * past it. A fallback then checks out the last-good commit in the same clone.
 */
export async function launchTarget(configPath: string, guard: CrashGuard): Promise<LaunchedEngine> {
  const baseConfigPath = resolveBaseConfigPath(process.env);
  const fingerprint = deploymentConfigFingerprint(configPath, baseConfigPath);
  const resolved = await loadBootConfiguration(configPath, process.env, fingerprint);
  const source = resolved.engine;
  const resolvedConfiguration = formatResolvedConfiguration(resolved);
  const token = process.env["GH_TOKEN"];
  const sample = () => ({
    config: deploymentConfigFingerprint(configPath, baseConfigPath),
    remoteSha: watchedRefSha(source, token),
  });

  if (source.source === "local") {
    const entry = resolveEngineEntry(source);
    assertBaseConfigProtocol(entry, baseConfigPath);
    console.log(`[phoebe] boot: engine source "local" — exec ${entry} (long-running).`);
    return {
      entry,
      source,
      sha: null,
      config: fingerprint,
      guarded: false,
      quarantinedSha: null,
      sample,
      resolvedConfiguration,
    };
  }

  const guarded = isMovingBranch(source, token);
  const baseDir = engineBaseDir();
  let { entry, sha } = materializeGithubEngine(source, { baseDir, token });

  let quarantinedSha: string | null = null;
  const pin = guarded && sha !== null ? guard.fallbackFor(sha) : null;
  if (pin !== null) {
    quarantinedSha = sha;
    ({ entry, sha } = materializeGithubEngine({ ...source, ref: pin }, { baseDir, token }));
  }
  assertBaseConfigProtocol(entry, baseConfigPath);

  const provenance =
    quarantinedSha !== null
      ? `${source.repo}@${source.ref} → last-good ${sha} (crash-loop fallback from ${quarantinedSha})`
      : `${source.repo}@${source.ref}${sha ? ` (${sha})` : ""}`;
  console.log(
    `[phoebe] boot: engine source "github" ${provenance} — exec ${entry} (long-running).`,
  );

  return {
    entry,
    source,
    sha,
    config: fingerprint,
    guarded,
    quarantinedSha,
    sample,
    resolvedConfiguration,
  };
}

/**
 * Does the crash-loop guard apply to this source? Only a moving branch is
 * guarded: a local mount has no commit to pin, and a pinned SHA or tag means the
 * operator chose that exact commit — quietly serving a different one would be
 * worse than crash-looping visibly. `lsRemoteBranchSha` answers precisely that
 * question (it yields a tip only for a branch) and short-circuits a pinned SHA
 * without touching the network.
 *
 * A remote that will not answer leaves the guard off for this launch rather than
 * failing it: materializing is about to make the same call, and its error is the
 * one worth surfacing.
 */
export function isMovingBranch(
  source: ResolvedEngineSource,
  token: string | undefined,
  git: GitRunner = defaultGit,
): boolean {
  if (source.source === "local") return false;
  try {
    return lsRemoteBranchSha(source, { token, git }) !== null;
  } catch (error) {
    console.warn(
      `[phoebe] boot: could not check whether ${source.repo}@${source.ref} is a moving branch — ` +
        `${describe(error)}. Crash-loop fallback is off for this launch.`,
    );
    return false;
  }
}

/**
 * The ref half of a poll: where the tracked branch points now, or null when
 * there is nothing to watch (a local mount, or a pinned SHA/tag — which the
 * ref-watch leaves alone by design).
 */
function watchedRefSha(source: ResolvedEngineSource, token: string | undefined): string | null {
  if (source.source === "local") return null;
  return lsRemoteBranchSha(source, { token });
}

/**
 * Spawn the engine and expose it as the supervisor's child handle. Both a normal
 * exit and a spawn failure settle `exited` — the failure as a non-zero exit — so
 * the supervisor always sees the child resolve and decides what to do (a
 * first-launch failure is fatal, a relaunch failure retries). Without the
 * `onSpawnError` override, spawn-engine.mjs's default would `process.exit(1)`
 * here, bypassing boot's drain-latch teardown and leaving `exited` pending.
 */
function bootstrapVersion(): string {
  try {
    const parsed = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function observerEngineEnv(engine: {
  source?: ResolvedEngineSource;
  sha: string | null;
  quarantinedSha: string | null;
}): Record<string, string> {
  const source = engine.source;
  return {
    PHOEBE_RUNNING_ENGINE_SOURCE: source?.source ?? "direct",
    ...(source?.source === "github"
      ? {
          PHOEBE_RUNNING_ENGINE_REPO: source.repo,
          PHOEBE_RUNNING_ENGINE_REF: source.ref,
        }
      : {}),
    ...(engine.sha ? { PHOEBE_RUNNING_ENGINE_SHA: engine.sha } : {}),
    ...(engine.quarantinedSha ? { PHOEBE_QUARANTINED_ENGINE_SHA: engine.quarantinedSha } : {}),
    PHOEBE_BOOTSTRAP_VERSION: bootstrapVersion(),
  };
}

/**
 * The per-launch deployment-critical env every spawned engine child must get,
 * flat or nested alike: engine provenance (`observerEngineEnv`) plus the
 * atomic resolved-config snapshot (`BOOTSTRAP_RESOLVED_CONFIG_ENV`) so a child
 * consumes the launch snapshot instead of re-reading mutable config files
 * (#38). One function so the flat (`spawnSupervised`) and nested
 * (`spawnFleetChild`) spawn paths cannot drift apart on these vars again.
 */
export function engineProvenanceEnv(engine: {
  source?: ResolvedEngineSource;
  sha: string | null;
  quarantinedSha: string | null;
  resolvedConfiguration?: string;
}): Record<string, string> {
  return {
    ...(engine.resolvedConfiguration === undefined
      ? {}
      : { [BOOTSTRAP_RESOLVED_CONFIG_ENV]: engine.resolvedConfiguration }),
    ...observerEngineEnv(engine),
  };
}

/**
 * The crash-loop guard for this container, rooted at the deployment-global
 * engine dir (`/data/engine`, the shared `phoebe-engine` volume — #60/#62). One
 * guard about one engine SHA for the whole fleet; its home is a container
 * constant (the engine checkout base), not a per-tenant path, so it no longer
 * depends on loading any config and cannot drift with a mid-flight config edit.
 *
 * Exported so `deployment.ts` can create the one guard a launch (of any
 * topology) and its `onChildGone`/`onChildRun`/`onChildTick` policy share.
 */
export function createBootCrashGuard(): CrashGuard {
  return createCrashGuard({
    engineDir: engineBaseDir(),
    log: (line) => console.error(line),
  });
}

/**
 * `phoebe boot` entry — the composition root. Installs the stop latch, resolves
 * this deployment's topology (`bootstrap/deployment.ts`: workspace, nested, or
 * flat — the detection ladder, discover/spawn adapters, and `onChildGone`
 * policy all live there), runs the one shared supervision loop, and propagates
 * the result as this process's own exit. Extra args after `boot` are forwarded
 * to every engine child (none ⇒ its normal persistent loop).
 */
export async function runBoot(argv: readonly string[]): Promise<void> {
  // Before any engine git call (ensureClone, fetch/push, agent child): one
  // global github.com credential helper from GH_TOKEN. Survives reconcile
  // relaunches via ~/.gitconfig + the agent-env HOME/GH_TOKEN allowlist.
  setupGitCredentials({ token: process.env["GH_TOKEN"] });

  // The container's stop request. A one-way latch, and the poll clock: a
  // SIGTERM mid-poll wakes the watch immediately instead of sleeping out the
  // interval. Holding these listeners also keeps boot alive across the moment
  // between an engine exiting and its replacement spawning, where the child's
  // own forwarders are not installed.
  const stop = installDrainSignal(process, ["SIGTERM", "SIGINT"]);

  let exit: EngineExit;
  try {
    const deployment = await resolveDeployment({
      configDir: process.cwd(),
      env: process.env,
      argv,
    });
    exit = await supervise({
      ...deployment,
      stop,
      intervalMs: reconcileIntervalMs(),
      drainTimeoutMs: reconcileDrainTimeoutMs(),
    });
  } finally {
    // Drop the listeners before propagating: re-raising the engine's killing
    // signal must actually kill this process, and our own latch would swallow it.
    stop.dispose();
  }
  propagateExit(exit.code, exit.signal);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
