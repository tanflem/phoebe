// `phoebe status --json` argv parsing contract (#73) — moved verbatim from
// src/cli.test.ts when parseStatusArgs relocated to this module.

import { describe, expect, test } from "vite-plus/test";
import { parseStatusArgs } from "./status.ts";

describe("parseStatusArgs", () => {
  test("requires the machine-readable projection and accepts a config path", () => {
    expect(parseStatusArgs(["--json", "--config", "cfg.ts"])).toEqual({
      configPath: "cfg.ts",
      help: false,
    });
  });

  test("allows help without --json", () => {
    expect(parseStatusArgs(["--help"])).toEqual({
      configPath: undefined,
      help: true,
    });
  });

  test("rejects missing --json and unknown arguments", () => {
    expect(() => parseStatusArgs([])).toThrow(/requires --json/);
    expect(() => parseStatusArgs(["--json", "--events"])).toThrow(/Unknown status argument/);
  });
});
