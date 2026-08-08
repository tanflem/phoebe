// `phoebe list` rendering contract (#73) — moved verbatim from
// src/cli.test.ts when formatTenantListing relocated to this module.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { parseStatusSnapshot, type StatusSnapshot } from "../status-contract.ts";
import type { TenantListing } from "../tenant-commands.ts";
import { formatTenantListing } from "./list.ts";

const fixtureRoot = join(import.meta.dirname, "..", "..", "contracts", "fixtures", "status-v2");

function fixtureSnapshot(name: string): StatusSnapshot {
  return parseStatusSnapshot(JSON.parse(readFileSync(join(fixtureRoot, `${name}.json`), "utf8")));
}

function listingWithStatus(
  status: TenantListing["status"],
  overrides: Partial<TenantListing> = {},
): TenantListing {
  return {
    slug: "acme/widget",
    configValid: true,
    envPresent: true,
    retainedData: true,
    status,
    queue: [],
    ...overrides,
  };
}

describe("formatTenantListing", () => {
  test("running with activeWork renders `working <kind> #<id>`", () => {
    const listing = listingWithStatus({ available: true, status: fixtureSnapshot("running") });
    expect(formatTenantListing(listing)).toContain("working issues #42");
  });

  test("starting / selecting / idle all render idle", () => {
    const idle = listingWithStatus({ available: true, status: fixtureSnapshot("idle") });
    expect(formatTenantListing(idle)).toContain("idle");

    const starting = listingWithStatus({
      available: true,
      status: fixtureSnapshot("crash-loop-fallback"),
    });
    expect(starting.status).toMatchObject({ status: { lifecycle: { state: "starting" } } });
    expect(formatTenantListing(starting)).toContain("idle");
  });

  test("draining renders `draining`", () => {
    const listing = listingWithStatus({
      available: true,
      status: fixtureSnapshot("graceful-drain"),
    });
    expect(formatTenantListing(listing)).toContain("draining");
  });

  test("stopped renders `stopped`", () => {
    const listing = listingWithStatus({ available: true, status: fixtureSnapshot("stopped") });
    expect(formatTenantListing(listing)).toContain("stopped");
  });

  test("failed renders `failed — <lifecycle.reason>`", () => {
    const listing = listingWithStatus({ available: true, status: fixtureSnapshot("failed") });
    expect(formatTenantListing(listing)).toContain(
      "failed — State volume unwritable after 3 retries.",
    );
  });

  test("unavailable/not-found renders `no status`", () => {
    const listing = listingWithStatus({
      available: false,
      reason: "not-found",
      message: "No status-v2 snapshot exists.",
    });
    expect(formatTenantListing(listing)).toContain("no status");
  });

  test("unavailable/corrupt renders `unreadable status`", () => {
    const listing = listingWithStatus({
      available: false,
      reason: "corrupt",
      message: "Could not decode status-v2.",
    });
    expect(formatTenantListing(listing)).toContain("unreadable status");
  });

  test("a capability-error snapshot renders the received version, not a silent `no status`", () => {
    const listing = listingWithStatus({
      available: false,
      reason: "unsupported-version",
      receivedVersion: "status-v3",
      message: "This runtime supports status-v2 but received status-v3.",
    });
    expect(formatTenantListing(listing)).toContain("status from a newer engine (status-v3)");
  });

  test("a capability error still lists with its other health columns intact", () => {
    const listing = listingWithStatus(
      {
        available: false,
        reason: "unsupported-version",
        receivedVersion: "status-v3",
        message: "This runtime supports status-v2 but received status-v3.",
      },
      { configValid: false, envPresent: true, retainedData: false },
    );
    const rendered = formatTenantListing(listing);
    expect(rendered).toContain("✗ config");
    expect(rendered).toContain("✓ env");
    expect(rendered).toContain("✗ data");
    expect(rendered).toContain("status from a newer engine (status-v3)");
  });

  test("no status (hold dir, no slug resolved) renders `no status`", () => {
    const listing = listingWithStatus(null);
    expect(formatTenantListing(listing)).toContain("no status");
  });
});
