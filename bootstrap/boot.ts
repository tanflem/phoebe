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
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installDrainSignal } from "../src/drain.ts";
import { defaultGit, type GitRunner } from "../src/git-model.ts";
import {
  BOOTSTRAP_RESOLVED_CONFIG_ENV,
  formatResolvedConfiguration,
  loadResolvedConfiguration,
  resolveBaseConfigPath,
  type ResolvedConfiguration,
} from "../src/config-resolution.ts";
import { loadUserConfig, resolveConfigPath } from "../src/load-config.ts";
import { createCrashGuard, type CrashGuard } from "./crash-loop.ts";
import type { ResolvedEngineSource } from "./engine-source.ts";
import { lsRemoteBranchSha, materializeGithubEngine } from "./github-engine.ts";
import { childEnv } from "./engine-child-env.ts";
import { attachBroker } from "./broker-ipc.ts";
import { parseDotenv } from "../src/dotenv.ts";
import { createSlotBroker, resolveMaxConcurrent } from "./slot-broker.ts";
import {
  discoverTenants,
  discoverWorkspaceTenants,
  isFatalWorkspaceDiscoveryError,
  isNestedDeployment,
  withTenantConfigDir,
  type DiscoveredTenant,
  type TenantSample,
} from "./tenants.ts";
import { readConfigDir } from "./config-dir.ts";
import { readWorkspaceField, type ResolvedWorkspace } from "./workspace-source.ts";
import { readFileSync } from "node:fs";
import {
  configFingerprint,
  deploymentConfigFingerprint,
  supervise,
  CHILD_RESPAWN_BACKOFF_MS,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_INTERVAL_MS,
  type DiscoverInput,
  type EngineExit,
  type LaunchedEngine,
  type SupervisedChild,
} from "./supervise.ts";
// Untyped plain-JS import (see spawn-engine.mjs / materialize.mjs for why the
// bootstrapper's child-process plumbing can't be TypeScript).
import { propagateExit, spawnEngine, spawnEngineChild } from "./spawn-engine.mjs";

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
  return loadResolvedConfiguration(configPath, {
    env,
    reloadKey: fingerprint ?? undefined,
  });
}

/**
 * Load the mounted `phoebe.config.ts` as the arbitrary record the workspace-mode
 * detection ladder treats it as — it only needs the `workspace` field, and the
 * engine validates the rest once it is materialized and run. The fingerprint
 * doubles as the ESM cache-bust key, so a re-read after an edit is genuinely a
 * re-read.
 */
async function loadMountedConfig(
  configPath: string,
  fingerprint: string | null,
): Promise<Record<string, unknown>> {
  const userConfig = await loadUserConfig(configPath, { reloadKey: fingerprint ?? undefined });
  return userConfig as unknown as Record<string, unknown>;
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
async function launchTarget(configPath: string, guard: CrashGuard): Promise<LaunchedEngine> {
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
 * Spawn flat's single, constant tenant — its own engine (#65: flat is a fleet
 * of one, so this is `children.spawn` for the flat wiring). Its env routes
 * through the same `childEnv` builder the nested/workspace fleet path uses
 * (#64): the base allowlist and deployment knobs are already a subset of
 * `process.env`, so passing `process.env` itself as `secrets` — flat's
 * trust-domain-is-the-whole-container secret source — reproduces today's plain
 * inherit exactly, plus this launch's provenance and resolved-config snapshot.
 */
function spawnSupervised(engine: LaunchedEngine, argv: readonly string[]): SupervisedChild {
  let settle!: (exit: EngineExit) => void;
  const exited = new Promise<EngineExit>((resolve) => {
    settle = resolve;
  });
  const env = childEnv({
    base: process.env,
    secrets: process.env,
    extraEnv: engineProvenanceEnv(engine),
  });
  const child = spawnEngine(engine.entry, argv, {
    env,
    onExit: (code: number | null, signal: NodeJS.Signals | null) => settle({ code, signal }),
    onSpawnError: (error: Error) => {
      console.error(`[phoebe] boot: engine failed to spawn — ${error.message}`);
      settle({ code: 1, signal: null });
    },
  });
  return { kill: (signal) => child.kill(signal), exited };
}

/**
 * The crash-loop guard for this container, rooted at the deployment-global
 * engine dir (`/data/engine`, the shared `phoebe-engine` volume — #60/#62). One
 * guard about one engine SHA for the whole fleet; its home is a container
 * constant (the engine checkout base), not a per-tenant path, so it no longer
 * depends on loading any config and cannot drift with a mid-flight config edit.
 */
function createBootCrashGuard(): CrashGuard {
  return createCrashGuard({
    engineDir: engineBaseDir(),
    log: (line) => console.error(line),
  });
}

/**
 * Read a tenant's co-located `.env` into a plain record for the #61 env scrub.
 * A missing/unreadable file is an empty record — the child then holds only the
 * allowlisted base + deployment knobs (fail-closed), which boot surfaces at the
 * first private-repo git call rather than here.
 */
function readTenantEnv(envPath: string): Record<string, string> {
  try {
    return parseDotenv(readFileSync(envPath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Supervise a nested or workspace multi-tenant deployment (#58/#59/#61/#91): a
 * shared engine (#60, materialized once by `launchTarget` from the top config's
 * `engine` field) with one child per tenant, a global concurrency broker across
 * them, and hot add/remove/change via the shared `supervise` loop (#65) — a
 * fleet child that dies on its own is always respawned with backoff, leaving
 * the shared engine and every sibling untouched (#60 §6).
 *
 * Each child is spawned with an IPC channel + the tenant's scrubbed env (#61)
 * and cwd (its config dir), and wired to the broker (#59). The crash-loop guard
 * still applies any existing engine fallback on each (re)launch; feeding the
 * guard fleet-aggregated crash verdicts (#60 §6) is a follow-up — nested live
 * validation is deferred to #77.
 *
 * `discover` is injected so nested mode can stay a pure filesystem scan while
 * workspace mode re-walks the tree and reloads each child's `repoSlug` (#91).
 */
function runFleet(opts: {
  configPath: string;
  guard: CrashGuard;
  stop: ReturnType<typeof installDrainSignal>;
  intervalMs: number;
  drainTimeoutMs: number;
  argv: readonly string[];
  discover: () => DiscoverInput<DiscoveredTenant>;
}): Promise<EngineExit> {
  const broker = createSlotBroker(resolveMaxConcurrent(process.env));

  const spawnFleetChild = (tenant: DiscoveredTenant, engine: LaunchedEngine): SupervisedChild => {
    const env = childEnv({
      base: process.env,
      secrets: readTenantEnv(tenant.envPath),
      extraEnv: engineProvenanceEnv(engine),
    });
    let settle!: (exit: EngineExit) => void;
    const exited = new Promise<EngineExit>((resolve) => {
      settle = resolve;
    });
    const label = tenant.slug ?? tenant.id;
    // The child's cwd is the tenant's asset dir (#98): `dirname(envPath)`, which
    // is `tenant.dir` unless `configDir` relocated the `.env` (e.g. into
    // `.phoebe/`). When relocated, cwd is not where the config lives, so pass
    // `--config` explicitly (the child's CLI resolves config from cwd otherwise
    // — and `--config` always wins). Relative `promptFiles` then resolve under
    // the asset dir. The default path (co-located) is byte-for-byte unchanged.
    const assetsDir = dirname(tenant.envPath);
    const relocated = assetsDir !== tenant.dir;
    const argv = relocated ? ["--config", tenant.configPath, ...opts.argv] : opts.argv;
    const child = spawnEngineChild(engine.entry, argv, {
      env,
      cwd: assetsDir,
      onExit: (code: number | null, signal: NodeJS.Signals | null) => settle({ code, signal }),
      onSpawnError: (error: Error) => {
        console.error(`[phoebe] boot: tenant ${label} failed to spawn — ${error.message}`);
        settle({ code: 1, signal: null });
      },
    });
    attachBroker({ owner: tenant.id, broker, child });
    return { kill: (signal) => child.kill(signal), exited };
  };

  return supervise<DiscoveredTenant>({
    launch: () => launchTarget(opts.configPath, opts.guard),
    children: { discover: opts.discover, spawn: spawnFleetChild },
    onChildGone: (run) => {
      console.error(
        `[phoebe] boot: tenant ${run.tenant.id} exited (${run.exit.code ?? run.exit.signal}) — ` +
          `respawning with backoff (per-tenant supervision; the shared engine is untouched).`,
      );
      return "respawn";
    },
    stop: opts.stop,
    intervalMs: opts.intervalMs,
    drainTimeoutMs: opts.drainTimeoutMs,
    onEngineChange: (reason) =>
      console.log(
        reason === "config"
          ? "[phoebe] boot: shared config changed — draining the fleet and relaunching every tenant."
          : "[phoebe] boot: tracked engine ref advanced — draining the fleet and relaunching every tenant.",
      ),
    onChildChange: ({ added, removed, changed }) =>
      console.log(
        `[phoebe] boot: tenant reconcile — +${added.length} added, -${removed.length} removed, ` +
          `~${changed.length} relaunched (no container restart).`,
      ),
    onLaunchError: (error) =>
      console.error(`[phoebe] boot: fleet (re)launch failed — ${describe(error)}. Retrying.`),
    onDiscoverError: (error) => {
      // A fatal identity clash (#92: duplicate workspace slug or origin) must
      // abort boot, not soft-skip like a transient `repos/` read error.
      if (isFatalWorkspaceDiscoveryError(error)) throw error;
      console.warn(
        `[phoebe] boot: tenant discovery failed — ${describe(error)}. ` +
          `Skipping the tenant axis this poll (the running fleet is left intact).`,
      );
    },
  });
}

/**
 * Nested-mode discover callback: filesystem scan + per-tenant fingerprints.
 * The sync scan builds tenants co-located; a second pass reads each tenant's
 * bootstrapper-only `configDir` (#98) and relocates its `.env` accordingly. A
 * config that will not load / a malformed `configDir` is **held**, not started —
 * the same skip-and-hold workspace discovery uses (#86), so a misconfigured
 * tenant surfaces loudly rather than silently running against the wrong `.env`.
 */
function nestedDiscover(configDir: string): () => DiscoverInput<DiscoveredTenant> {
  return async () => {
    const samples: TenantSample[] = [];
    const hold: string[] = [];
    for (const tenant of discoverTenants(configDir).tenants) {
      try {
        const resolved = withTenantConfigDir(tenant, await loadTenantConfigDir(tenant.configPath));
        samples.push({
          tenant: resolved,
          fingerprint: tenantFingerprint(resolved.configPath, resolved.envPath),
        });
      } catch (error) {
        console.warn(
          `[phoebe] boot: nested: holding ${tenant.id} — ${describe(error)} ` +
            `(not started until its configDir resolves).`,
        );
        hold.push(tenant.id);
      }
    }
    return { samples, hold };
  };
}

/**
 * Workspace-mode discover callback (#91): re-walk the tree every poll, load each
 * child's `repoSlug`, and report hold ids for mid-rewrite configs (#86).
 */
function workspaceDiscover(
  configDir: string,
  workspace: ResolvedWorkspace,
): () => DiscoverInput<DiscoveredTenant> {
  return async () => {
    const result = await discoverWorkspaceTenants(configDir, workspace.depth, {
      loadRepoSlug: loadTenantRepoSlug,
      loadConfigDir: loadTenantConfigDir,
      warn: (message) => console.warn(message),
    });
    return {
      samples: result.tenants.map((tenant) => ({
        tenant,
        fingerprint: tenantFingerprint(tenant.configPath, tenant.envPath),
      })),
      hold: result.holdIds,
    };
  };
}

/**
 * Load a workspace child config and return its authoritative `repoSlug`.
 * Throws when the file will not load or the slug is missing — the walker
 * treats that as skip-and-warn + hold.
 */
async function loadTenantRepoSlug(configPath: string): Promise<string> {
  const fingerprint = configFingerprint(configPath);
  if (fingerprint === null) {
    throw new Error(`config unreadable at ${configPath}`);
  }
  const user = await loadUserConfig(configPath, { reloadKey: fingerprint });
  const slug = user.repoSlug;
  if (typeof slug !== "string" || slug.trim().length === 0) {
    throw new Error(`missing or empty repoSlug in ${configPath}`);
  }
  return slug.trim();
}

/**
 * Load a tenant config and return its bootstrapper-only `configDir` (#98), or
 * "." when unset. Throws when the config will not load or the value is
 * malformed — the workspace walker treats that as skip-and-warn, nested falls
 * back to co-location. Reuses `loadUserConfig`'s fingerprint cache, so this does
 * not re-read a config the slug load already parsed this poll.
 */
async function loadTenantConfigDir(configPath: string): Promise<string> {
  const fingerprint = configFingerprint(configPath);
  if (fingerprint === null) {
    throw new Error(`config unreadable at ${configPath}`);
  }
  const user = await loadUserConfig(configPath, { reloadKey: fingerprint });
  return readConfigDir(user as unknown as Record<string, unknown>);
}

/**
 * One tenant's reconcile fingerprint: its config *and* its co-located `.env`,
 * so a secrets-only edit relaunches the child (the env scrub reads `.env` at
 * spawn, #61). A null config fingerprint stays null — "unknown", never a change
 * (`diffFleet`) — so a mid-rewrite config does not churn the child; a present
 * config with an absent `.env` is a stable `"<config>:"`.
 */
function tenantFingerprint(configPath: string, envPath: string): string | null {
  const config = configFingerprint(configPath);
  if (config === null) return null;
  return `${config}:${configFingerprint(envPath) ?? ""}`;
}

/**
 * `phoebe boot` entry. Loads the mounted config, resolves the engine source to a
 * runnable `src/cli.ts` — a local mount or a github checkout — execs the engine
 * as a long-lived child, and supervises it: reconcile relaunches on a config or
 * ref change, the crash-loop guard pins back to the last-good commit when the
 * tracked ref will not boot, and a container stop drains it and exits with its
 * status. Extra args after `boot` are forwarded to the engine (none ⇒ the
 * persistent loop).
 */
export async function runBoot(argv: readonly string[]): Promise<void> {
  // Before any engine git call (ensureClone, fetch/push, agent child): one
  // global github.com credential helper from GH_TOKEN. Survives reconcile
  // relaunches via ~/.gitconfig + the agent-env HOME/GH_TOKEN allowlist.
  setupGitCredentials({ token: process.env["GH_TOKEN"] });

  const configDir = process.cwd();
  const configPath = resolveConfigPath(undefined, configDir);
  const guard = createBootCrashGuard();
  const intervalMs = reconcileIntervalMs();
  const drainTimeoutMs = reconcileDrainTimeoutMs();

  // The container's stop request. A one-way latch, and the poll clock: a
  // SIGTERM mid-poll wakes the watch immediately instead of sleeping out the
  // interval. Holding these listeners also keeps boot alive across the moment
  // between an engine exiting and its replacement spawning, where the child's
  // own forwarders are not installed.
  const stop = installDrainSignal(process, ["SIGTERM", "SIGINT"]);

  // Detection ladder (#83/#91): loaded root config has a `workspace` block →
  // workspace mode (warn + ignore any `repos/`); else `repos/` → nested; else flat.
  // The root config is loaded here for the mode decision; `launchTarget` still
  // re-reads on each (re)launch for the engine source + cache bust.
  const rootFingerprint = configFingerprint(configPath);
  const rootConfig = await loadMountedConfig(configPath, rootFingerprint);
  const workspace = readWorkspaceField(rootConfig);

  if (workspace !== null) {
    if (isNestedDeployment(configDir)) {
      console.warn(
        "[phoebe] boot: workspace block present — ignoring `repos/` " +
          "(nested central layout is off for this deployment).",
      );
    }
    // Count tenants for the startup log (same walk the fleet will use).
    const initial = await discoverWorkspaceTenants(configDir, workspace.depth, {
      loadRepoSlug: loadTenantRepoSlug,
      warn: (message) => console.warn(message),
    });
    console.log(
      `[phoebe] boot: workspace mode — supervising ${initial.tenants.length} tenant(s) ` +
        `on one shared engine (depth ${workspace.depth}).`,
    );
    let fleetExit: EngineExit;
    try {
      fleetExit = await runFleet({
        configPath,
        guard,
        stop,
        intervalMs,
        drainTimeoutMs,
        argv,
        discover: workspaceDiscover(configDir, workspace),
      });
    } finally {
      stop.dispose();
    }
    propagateExit(fleetExit.code, fleetExit.signal);
    return;
  }

  // A `repos/` dir beside the top config selects nested/multi-tenant mode (#63):
  // supervise a shared engine with one child per tenant. Absent → the flat
  // single-tenant fast-path below, unchanged: one engine child, no scanning.
  const discovery = discoverTenants(configDir);
  if (discovery.mode === "nested") {
    console.log(
      `[phoebe] boot: nested deployment — supervising ${discovery.tenants.length} tenant(s) ` +
        `on one shared engine.`,
    );
    let fleetExit: EngineExit;
    try {
      fleetExit = await runFleet({
        configPath,
        guard,
        stop,
        intervalMs,
        drainTimeoutMs,
        argv,
        discover: nestedDiscover(configDir),
      });
    } finally {
      stop.dispose();
    }
    propagateExit(fleetExit.code, fleetExit.signal);
    return;
  }

  // Flat is a fleet of one (#65): the top config's own dir, run in place. Its
  // tenant fingerprint is constant (null) so the tenant axis never fires — the
  // engine axis (config/ref) is its only relaunch trigger, one edit is one
  // relaunch, not two.
  const flatTenant = discovery.tenants[0];

  let exit: EngineExit;
  try {
    exit = await supervise<DiscoveredTenant>({
      launch: () => launchTarget(configPath, guard),
      children: {
        discover: () => [{ tenant: flatTenant, fingerprint: null }],
        spawn: (_tenant, engine) => spawnSupervised(engine, argv),
      },
      onChildGone: (run) => {
        if (!guard.shouldRetry(run)) return { propagate: run.exit };
        console.log(
          `[phoebe] boot: relaunching the engine in ${Math.round(CHILD_RESPAWN_BACKOFF_MS / 1000)}s — ` +
            `a last-good engine commit is available to fall back to.`,
        );
        return "respawn";
      },
      onChildRun: (run) => guard.record(run),
      onChildTick: ({ engine, elapsedMs }) => {
        if (engine.sha !== null) guard.noteAlive(engine.sha, elapsedMs);
      },
      // Flat is always exactly one child (#65): on a stop, the container's own
      // exit is that one engine's exit, not a generic 0.
      onStop: (exits) => exits[0] ?? { code: 0, signal: null },
      stop,
      intervalMs,
      drainTimeoutMs,
      onEngineChange: (reason) =>
        console.log(
          reason === "config"
            ? "[phoebe] boot: mounted config changed — draining the engine (SIGTERM) and relaunching."
            : "[phoebe] boot: tracked ref advanced — draining the engine (ref-change signal) and relaunching.",
        ),
      onDrainTimeout: (reason) =>
        console.error(
          `[phoebe] boot: the engine did not finish draining for a ${reason} change within ` +
            `${Math.round(drainTimeoutMs / 1000)}s — escalating to SIGKILL so the ` +
            `upgrade is not wedged.`,
        ),
      onLaunchError: (error) =>
        console.error(
          `[phoebe] boot: could not launch the engine — ${describe(error)}. Retrying next poll.`,
        ),
      onSampleError: (error) =>
        console.warn(`[phoebe] boot: reconcile poll failed — ${describe(error)}. Ignoring.`),
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
