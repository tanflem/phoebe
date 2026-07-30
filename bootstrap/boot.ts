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
// Boot then stays in charge for the life of the container: the reconcile watch
// (reconcile.ts, #42) polls the mounted config and the tracked ref, and when
// either moves it drains the engine, re-resolves the source, and relaunches —
// same container, no interrupted work unit. Following a branch also means
// eventually following it onto a commit that will not boot, so every launch
// passes through the crash-loop guard (crash-loop.ts, #43): a tip that dies fast
// enough times is quarantined and boot materializes the last commit that ran
// healthily instead. This module is the wiring; the loop lives in reconcile.ts,
// the fallback policy in crash-loop.ts, and everything impure is passed in from
// here.

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installDrainSignal } from "../src/drain.ts";
import { defaultGit, type GitRunner } from "../src/git-model.ts";
import { loadUserConfig, resolveConfigPath } from "../src/load-config.ts";
import {
  crashLoopStatePath,
  createCrashGuard,
  readStateDir,
  DEFAULT_STATE_DIR,
  type CrashGuard,
  type CrashGuardEvent,
  type RunOutcome,
} from "./crash-loop.ts";
import { readEngineSource, type ResolvedEngineSource } from "./engine-source.ts";
import { lsRemoteBranchSha, materializeGithubEngine } from "./github-engine.ts";
import {
  configFingerprint,
  superviseEngine,
  CRASH_BACKOFF_MS,
  DEFAULT_RECONCILE_INTERVAL_MS,
  type EngineExit,
  type EngineRun,
  type LaunchedEngine,
  type SupervisedChild,
} from "./reconcile.ts";
// Untyped plain-JS import (see spawn-engine.mjs / materialize.mjs for why the
// bootstrapper's child-process plumbing can't be TypeScript).
import { propagateExit, spawnEngine } from "./spawn-engine.mjs";

/** Where the local-engine compose overlay mounts the engine for `source: "local"`. */
export const LOCAL_ENGINE_DIR = "/opt/phoebe-engine";

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
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RECONCILE_INTERVAL_MS;
}

/**
 * Load the mounted `phoebe.config.ts` as the arbitrary record the bootstrapper
 * treats it as — it owns only two fields (`engine`, `paths.stateDir`), and the
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
  const fingerprint = configFingerprint(configPath);
  const source = readEngineSource(await loadMountedConfig(configPath, fingerprint));
  const token = process.env["GH_TOKEN"];
  const sample = () => ({
    config: configFingerprint(configPath),
    remoteSha: watchedRefSha(source, token),
  });

  if (source.source === "local") {
    const entry = resolveEngineEntry(source);
    console.log(`[phoebe] boot: engine source "local" — exec ${entry} (long-running).`);
    return {
      entry,
      source,
      sha: null,
      config: fingerprint,
      guarded: false,
      quarantinedSha: null,
      sample,
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

  const provenance =
    quarantinedSha !== null
      ? `${source.repo}@${source.ref} → last-good ${sha} (crash-loop fallback from ${quarantinedSha})`
      : `${source.repo}@${source.ref}${sha ? ` (${sha})` : ""}`;
  console.log(
    `[phoebe] boot: engine source "github" ${provenance} — exec ${entry} (long-running).`,
  );

  return { entry, source, sha, config: fingerprint, guarded, quarantinedSha, sample };
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
export function observerEngineEnv(engine: LaunchedEngine): Record<string, string> {
  const sourceEnv: Record<string, string> =
    engine.source.source === "github"
      ? {
          PHOEBE_RUNNING_ENGINE_SOURCE: "github",
          PHOEBE_RUNNING_ENGINE_REPO: engine.source.repo,
          PHOEBE_RUNNING_ENGINE_REF: engine.source.ref,
        }
      : { PHOEBE_RUNNING_ENGINE_SOURCE: "local" };
  return {
    ...sourceEnv,
    ...(engine.sha ? { PHOEBE_RUNNING_ENGINE_SHA: engine.sha } : {}),
    ...(engine.quarantinedSha ? { PHOEBE_QUARANTINED_ENGINE_SHA: engine.quarantinedSha } : {}),
  };
}

function spawnSupervised(engine: LaunchedEngine, argv: readonly string[]): SupervisedChild {
  let settle!: (exit: EngineExit) => void;
  const exited = new Promise<EngineExit>((resolve) => {
    settle = resolve;
  });
  const child = spawnEngine(engine.entry, argv, {
    env: {
      ...process.env,
      ...observerEngineEnv(engine),
    },
    onExit: (code: number | null, signal: NodeJS.Signals | null) => settle({ code, signal }),
    onSpawnError: (error: Error) => {
      console.error(`[phoebe] boot: engine failed to spawn — ${error.message}`);
      settle({ code: 1, signal: null });
    },
  });
  return { kill: (signal) => child.kill(signal), exited };
}

/**
 * The crash-loop guard for this container, rooted at the engine's state dir
 * (`paths.stateDir`, a named volume). Resolved once from the config as it reads
 * at boot: the record has to be found again after the restart a crash-looping
 * engine causes, so where it lives must not drift with a mid-flight config edit.
 * A config that will not load falls back to the shipped default here and fails
 * properly on the first launch, where the error belongs.
 */
async function createBootCrashGuard(configPath: string): Promise<CrashGuard> {
  let stateDir = DEFAULT_STATE_DIR;
  try {
    stateDir = readStateDir(await loadMountedConfig(configPath, configFingerprint(configPath)));
  } catch {
    // launchTarget loads the same config a moment later and reports the failure.
  }
  return createCrashGuard({
    statePath: crashLoopStatePath(stateDir),
    onEvent: logCrashGuardEvent,
  });
}

/**
 * The guard's decisions, in an operator's terms. A container quietly serving
 * older code than its config asks for is exactly the confusion these lines
 * exist to prevent, so every fallback event names both commits.
 */
function logCrashGuardEvent(event: CrashGuardEvent): void {
  switch (event.kind) {
    case "crash":
      console.error(
        `[phoebe] boot: engine ${event.sha} exited ${event.exitCode} after ` +
          `${Math.round(event.elapsedMs / 1000)}s — fast crash ${event.failureCount}/${event.threshold}.`,
      );
      return;
    case "last-good":
      console.log(
        `[phoebe] boot: engine ${event.sha} ran healthily — recorded as the crash-loop fallback target.`,
      );
      return;
    case "fallback":
      console.error(
        `[phoebe] boot: engine ${event.quarantinedSha} crash-looped ${event.failureCount}× — ` +
          `falling back to last-good ${event.lastGoodSha}, and staying there until the tracked ` +
          `ref moves past the bad commit.`,
      );
      return;
    case "fallback-crashed":
      console.error(
        `[phoebe] boot: the last-good engine ${event.sha} crashed too ` +
          `(exit ${event.exitCode} after ${Math.round(event.elapsedMs / 1000)}s) — ` +
          `${event.quarantinedSha} stays quarantined and the container will exit.`,
      );
      return;
    case "recovered":
      console.log(
        `[phoebe] boot: tracked ref advanced to ${event.sha}, past quarantined ` +
          `${event.quarantinedSha} — crash-loop fallback lifted.`,
      );
      return;
    case "persist-failed":
      console.warn(
        `[phoebe] boot: could not write crash-loop state to ${event.path} — ` +
          `${describe(event.error)}. The fallback will not survive a container restart.`,
      );
      return;
  }
}

/**
 * A finished run as the crash-loop guard sees it, or null when there is no
 * commit to say anything about (a local mount). Note this is *not* gated on
 * `guarded`: what a pinned launch proved is still worth remembering — it only
 * must not cause a fallback — and recording it means an operator who later moves
 * that deployment onto a branch already has a target to fall back to.
 */
function runOutcome(run: EngineRun): RunOutcome | null {
  if (run.engine.sha === null) return null;
  return {
    sha: run.engine.sha,
    exitCode: run.exit.code,
    elapsedMs: run.elapsedMs,
    requestedStop: run.requestedStop,
  };
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
  const configPath = resolveConfigPath(undefined, process.cwd());
  const guard = await createBootCrashGuard(configPath);
  const intervalMs = reconcileIntervalMs();

  // The container's stop request. A one-way latch, and the poll clock: a
  // SIGTERM mid-poll wakes the watch immediately instead of sleeping out the
  // interval. Holding these listeners also keeps boot alive across the moment
  // between an engine exiting and its replacement spawning, where the child's
  // own forwarders are not installed.
  const stop = installDrainSignal(process, ["SIGTERM", "SIGINT"]);
  let exit: EngineExit;
  try {
    exit = await superviseEngine({
      launch: () => launchTarget(configPath, guard),
      spawn: (engine) => spawnSupervised(engine, argv),
      stop,
      intervalMs,
      onRunEnd: (run) => {
        const outcome = runOutcome(run);
        if (outcome !== null) guard.record(outcome);
      },
      onRunTick: ({ engine, elapsedMs }) => {
        if (engine.sha !== null) guard.noteAlive(engine.sha, elapsedMs);
      },
      relaunchAfterExit: (run) => {
        // Only a guarded launch retries: a pinned ref that crashes takes the
        // container down, exactly as it did before there was a guard.
        const outcome = run.engine.guarded ? runOutcome(run) : null;
        if (outcome === null || !guard.shouldRetry(outcome)) return false;
        console.log(
          `[phoebe] boot: relaunching the engine in ${Math.round(CRASH_BACKOFF_MS / 1000)}s — ` +
            `a last-good engine commit is available to fall back to.`,
        );
        return true;
      },
      onRelaunch: (reason) =>
        console.log(
          reason === "config"
            ? "[phoebe] boot: mounted config changed — draining the engine (SIGTERM) and relaunching."
            : "[phoebe] boot: tracked ref advanced — draining the engine (SIGTERM) and relaunching.",
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
