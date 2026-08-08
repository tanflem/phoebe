// `phoebe serve` (#24): argv parsing, disk discovery across --state-dir
// roots, HTML rendering (escaping, staleness, bad states), and a real HTTP
// round-trip against startServeServer.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  collectServeSnapshot,
  DEFAULT_SERVE_PORT,
  formatAge,
  parseServeArgs,
  renderServePage,
  startServeServer,
} from "./serve.ts";
import { STATUS_SNAPSHOT_FILE } from "./status-store.ts";

const fixtureRoot = join(import.meta.dirname, "..", "contracts", "fixtures", "status-v2");

function installFixture(stateDir: string, name: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, STATUS_SNAPSHOT_FILE),
    readFileSync(join(fixtureRoot, `${name}.json`)),
  );
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phoebe-serve-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseServeArgs", () => {
  test("defaults port and falls back to the resolved data base", () => {
    expect(parseServeArgs([], {})).toEqual({
      help: false,
      port: DEFAULT_SERVE_PORT,
      stateDirs: ["/data/repos"],
    });
  });

  test("accepts --port and repeated --state-dir", () => {
    expect(parseServeArgs(["--port", "9999", "--state-dir", "/a", "--state-dir=/b"])).toEqual({
      help: false,
      port: 9999,
      stateDirs: ["/a", "/b"],
    });
  });

  test("--help short-circuits without requiring a valid rest", () => {
    expect(parseServeArgs(["--help"]).help).toBe(true);
  });

  test("rejects a non-numeric port", () => {
    expect(() => parseServeArgs(["--port", "nope"])).toThrow(/integer 0-65535/);
  });

  test("rejects an out-of-range port", () => {
    expect(() => parseServeArgs(["--port", "70000"])).toThrow(/integer 0-65535/);
  });

  test("rejects an unknown flag", () => {
    expect(() => parseServeArgs(["--bogus"])).toThrow(/Unknown flag/);
  });

  test("rejects --state-dir with no value", () => {
    expect(() => parseServeArgs(["--state-dir"])).toThrow(/requires a directory path/);
  });
});

describe("formatAge", () => {
  const base = Date.parse("2026-08-08T00:00:00.000Z");

  test("seconds", () => {
    expect(formatAge("2026-08-08T00:00:00.000Z", base + 5_000)).toBe("5s ago");
  });

  test("minutes", () => {
    expect(formatAge("2026-08-08T00:00:00.000Z", base + 90_000)).toBe("1m ago");
  });

  test("hours and minutes", () => {
    expect(formatAge("2026-08-08T00:00:00.000Z", base + (2 * 60 + 5) * 60_000)).toBe("2h 5m ago");
  });

  test("days and hours", () => {
    expect(formatAge("2026-08-08T00:00:00.000Z", base + (3 * 24 + 1) * 3_600_000)).toBe(
      "3d 1h ago",
    );
  });

  test("invalid updatedAt reads as unknown, not a crash", () => {
    expect(formatAge("not-a-date", base)).toBe("unknown age (invalid updatedAt)");
  });
});

describe("collectServeSnapshot", () => {
  test("discovers every <owner>/<repo> tenant under a state-dir root", () => {
    installFixture(join(dir, "acme", "widget", "state"), "running");
    installFixture(join(dir, "acme", "gadget", "state"), "idle");

    const [result] = collectServeSnapshot([dir]);
    expect(result?.readable).toBe(true);
    expect(result?.tenants.map((t) => t.slug)).toEqual(["acme/gadget", "acme/widget"]);
    expect(result?.tenants.every((t) => t.status.available)).toBe(true);
  });

  test("a tenant dir with no state subdir yet reads as not-found, not an omission", () => {
    mkdirSync(join(dir, "acme", "fresh"), { recursive: true });

    const [result] = collectServeSnapshot([dir]);
    expect(result?.tenants).toHaveLength(1);
    const status = result?.tenants[0]?.status;
    expect(status).toEqual({
      available: false,
      reason: "not-found",
      message: expect.stringContaining("No status-v2 snapshot"),
    });
  });

  test("a corrupt snapshot file reads as corrupt", () => {
    const stateDir = join(dir, "acme", "broken", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, STATUS_SNAPSHOT_FILE), "{ not json");

    const [result] = collectServeSnapshot([dir]);
    expect(result?.tenants[0]?.status).toMatchObject({ available: false, reason: "corrupt" });
  });

  test("an unsupported schema version is distinguished from not-found", () => {
    const stateDir = join(dir, "acme", "future", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, STATUS_SNAPSHOT_FILE),
      JSON.stringify({ schemaVersion: "status-v99" }),
    );

    const [result] = collectServeSnapshot([dir]);
    expect(result?.tenants[0]?.status).toMatchObject({
      available: false,
      reason: "unsupported-version",
      receivedVersion: "status-v99",
    });
  });

  test("an unreadable state-dir root is reported, not silently empty", () => {
    const missing = join(dir, "does-not-exist");
    const [result] = collectServeSnapshot([missing]);
    expect(result).toMatchObject({ root: missing, readable: false });
    expect(result?.error).toBeTruthy();
    expect(result?.tenants).toEqual([]);
  });

  test("covers tenants across multiple state dirs independently", () => {
    const dirB = mkdtempSync(join(tmpdir(), "phoebe-serve-b-"));
    try {
      installFixture(join(dir, "acme", "widget", "state"), "running");
      installFixture(join(dirB, "acme", "widget", "state"), "failed");

      const results = collectServeSnapshot([dir, dirB]);
      expect(results).toHaveLength(2);
      expect(results[0]?.tenants[0]?.slug).toBe("acme/widget");
      expect(results[1]?.tenants[0]?.slug).toBe("acme/widget");
      expect(results[0]?.root).not.toBe(results[1]?.root);
    } finally {
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});

describe("renderServePage", () => {
  const now = Date.parse("2026-07-30T12:10:00.000Z");

  test("renders lifecycle, active work link, queue chain, and age for a healthy tenant", () => {
    installFixture(join(dir, "owner", "repo", "state"), "running");
    const html = renderServePage(collectServeSnapshot([dir]), now);

    expect(html).toContain("owner/repo");
    expect(html).toContain("running");
    expect(html).toContain('<a href="https://github.com/owner/repo/issues/42">issues #42</a>');
    // queue-linear-chain isn't used here; `running` fixture's queue is 42 → 47 → 50(blocked)
    expect(html).toContain('<a href="https://github.com/owner/repo/issues/47">#47</a>');
    expect(html).toContain("blocked by #47");
    expect(html).toContain("9m ago"); // updatedAt 12:00:05, rendered at 12:10:00
  });

  test("renders an explicit bad state for a missing snapshot, never an omission", () => {
    mkdirSync(join(dir, "owner", "empty"), { recursive: true });
    const html = renderServePage(collectServeSnapshot([dir]), now);

    expect(html).toContain("owner/empty");
    expect(html).toContain("no status snapshot yet");
    expect(html).toContain("age: unknown");
  });

  test("renders an explicit bad state for a corrupt snapshot", () => {
    const stateDir = join(dir, "owner", "broken", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, STATUS_SNAPSHOT_FILE), "{ not json");
    const html = renderServePage(collectServeSnapshot([dir]), now);

    expect(html).toContain("owner/broken");
    expect(html).toContain("corrupt snapshot");
  });

  test("surfaces an unreadable state-dir root as a visible error, not a quiet zero", () => {
    const missing = join(dir, "nope");
    const html = renderServePage(collectServeSnapshot([missing]), now);

    expect(html).toContain(missing);
    expect(html).toContain("state-dir-errors");
  });

  test("marks a stale snapshot distinctly from a fresh one", () => {
    installFixture(join(dir, "owner", "repo", "state"), "running"); // updatedAt 12:00:05
    const fresh = renderServePage(
      collectServeSnapshot([dir]),
      Date.parse("2026-07-30T12:00:10.000Z"),
    );
    const stale = renderServePage(
      collectServeSnapshot([dir]),
      Date.parse("2026-07-30T13:00:10.000Z"),
    );

    expect(fresh).not.toContain('class="age stale"');
    expect(stale).toContain('class="age stale"');
  });

  test("HTML-escapes a lifecycle failure reason so it cannot break out of the page", () => {
    const stateDir = join(dir, "owner", "repo", "state");
    mkdirSync(stateDir, { recursive: true });
    const snapshot = JSON.parse(readFileSync(join(fixtureRoot, "failed.json"), "utf8"));
    snapshot.lifecycle.reason = '<script>alert("x")</script>';
    writeFileSync(join(stateDir, STATUS_SNAPSHOT_FILE), JSON.stringify(snapshot));

    const html = renderServePage(collectServeSnapshot([dir]), now);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  test("shows the last outcome (success or failure) with its age", () => {
    installFixture(join(dir, "owner", "repo", "state"), "stopped"); // lastSuccess reviews:9
    const html = renderServePage(collectServeSnapshot([dir]), now);
    expect(html).toContain("success");
  });

  test("renders an explicit message when no tenants are found anywhere", () => {
    const html = renderServePage(collectServeSnapshot([dir]), now);
    expect(html).toContain("No tenants found");
  });
});

describe("startServeServer (HTTP)", () => {
  test("serves the fleet page on GET / and 404s elsewhere", async () => {
    installFixture(join(dir, "owner", "repo", "state"), "idle");
    const server = startServeServer({ port: 0, stateDirs: [dir] });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    const address = server.address();
    if (address === null || typeof address !== "object")
      throw new Error("expected a bound TCP address");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const root = await fetch(`${base}/`);
      expect(root.status).toBe(200);
      expect(root.headers.get("content-type")).toContain("text/html");
      const body = await root.text();
      expect(body).toContain("owner/repo");
      expect(body).toContain("Phoebe fleet");

      const missing = await fetch(`${base}/other`);
      expect(missing.status).toBe(404);

      const posted = await fetch(`${base}/`, { method: "POST" });
      expect(posted.status).toBe(405);
    } finally {
      server.close();
    }
  });

  test("re-reads disk on every request (no store)", async () => {
    const server = startServeServer({ port: 0, stateDirs: [dir] });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    const address = server.address();
    if (address === null || typeof address !== "object")
      throw new Error("expected a bound TCP address");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const before = await (await fetch(`${base}/`)).text();
      expect(before).toContain("No tenants found");

      installFixture(join(dir, "owner", "repo", "state"), "idle");

      const after = await (await fetch(`${base}/`)).text();
      expect(after).toContain("owner/repo");
    } finally {
      server.close();
    }
  });
});
