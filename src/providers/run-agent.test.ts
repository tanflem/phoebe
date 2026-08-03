import { describe, expect, test } from "vite-plus/test";
import { runAgent, type AgentChild, type SpawnAgent } from "./run-agent.ts";
import { PROVIDERS } from "./providers.ts";

type Listener = (...args: never[]) => void;

function makeFakeChild(): {
  child: AgentChild;
  written: string[];
  ended: () => boolean;
  emitStdout: (data: string) => void;
  close: (code: number | null) => void;
} {
  const listeners = new Map<string, Listener[]>();
  const on = (key: string, listener: Listener): void => {
    listeners.set(key, [...(listeners.get(key) ?? []), listener]);
  };
  const emit = (key: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(key) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  };
  const written: string[] = [];
  let stdinEnded = false;
  const child: AgentChild = {
    stdout: { on: (event, l) => on(`stdout:${event}`, l as Listener) },
    stderr: { on: (event, l) => on(`stderr:${event}`, l as Listener) },
    stdin: {
      write: (data: string) => written.push(data),
      end: () => {
        stdinEnded = true;
      },
    },
    on: (event: string, l: Listener) => on(`child:${event}`, l),
  };
  return {
    child,
    written,
    ended: () => stdinEnded,
    emitStdout: (data) => emit("stdout:data", Buffer.from(data)),
    close: (code) => emit("child:close", code),
  };
}

describe("runAgent", () => {
  test("spawns the provider command with the given cwd and env, pipes stdin, maps exit code", async () => {
    const fake = makeFakeChild();
    let spawned: {
      file: string;
      args: readonly string[];
      cwd: string;
      env: Record<string, string>;
    } | null = null;
    const spawn: SpawnAgent = (file, args, opts) => {
      spawned = { file, args, ...opts };
      queueMicrotask(() => {
        fake.emitStdout(`${JSON.stringify({ type: "result", result: "finished" })}\n`);
        fake.close(0);
      });
      return fake.child;
    };

    const result = await runAgent({
      provider: PROVIDERS.claude,
      model: "claude-m",
      prompt: "the prompt",
      cwd: "/work/tree",
      env: { PATH: "/bin", CI: "true" },
      spawn,
      log: () => {},
    });

    expect(spawned!.file).toBe("claude");
    expect(spawned!.cwd).toBe("/work/tree");
    expect(spawned!.env).toEqual({ PATH: "/bin", CI: "true" });
    expect(fake.written.join("")).toBe("the prompt");
    expect(fake.ended()).toBe(true);
    expect(result).toEqual({ exitCode: 0, resultText: "finished" });
  });

  test("threads effort through to the provider command argv", async () => {
    const fake = makeFakeChild();
    let spawned: { args: readonly string[] } | null = null;
    const spawn: SpawnAgent = (_file, args) => {
      spawned = { args };
      queueMicrotask(() => fake.close(0));
      return fake.child;
    };

    await runAgent({
      provider: PROVIDERS.claude,
      model: "claude-m",
      effort: "xhigh",
      prompt: "p",
      cwd: "/w",
      env: {},
      spawn,
      log: () => {},
    });

    const effortIdx = spawned!.args.indexOf("--effort");
    expect(effortIdx).toBeGreaterThanOrEqual(0);
    expect(spawned!.args[effortIdx + 1]).toBe("xhigh");
  });

  test("keeps the last result across chunk-split lines and maps failure exit codes", async () => {
    const fake = makeFakeChild();
    const spawn: SpawnAgent = () => {
      queueMicrotask(() => {
        const line = JSON.stringify({ type: "result", result: "partial answer" });
        fake.emitStdout(line.slice(0, 10));
        fake.emitStdout(`${line.slice(10)}\n`);
        fake.close(3);
      });
      return fake.child;
    };

    const result = await runAgent({
      provider: PROVIDERS.claude,
      model: "m",
      prompt: "p",
      cwd: "/w",
      env: {},
      spawn,
      log: () => {},
    });

    expect(result).toEqual({ exitCode: 3, resultText: "partial answer" });
  });

  test("null exit code (signal kill) maps to failure", async () => {
    const fake = makeFakeChild();
    const spawn: SpawnAgent = () => {
      queueMicrotask(() => fake.close(null));
      return fake.child;
    };
    const result = await runAgent({
      provider: PROVIDERS.codex,
      model: "m",
      prompt: "p",
      cwd: "/w",
      env: {},
      spawn,
      log: () => {},
    });
    expect(result.exitCode).toBe(1);
  });
});
