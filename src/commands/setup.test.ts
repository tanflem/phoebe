// `phoebe setup` argv parsing contract (#73) — moved verbatim from
// src/setup.test.ts when parseSetupArgs relocated to this module.

import { describe, expect, test } from "vite-plus/test";
import { parseSetupArgs } from "./setup.ts";

describe("parseSetupArgs", () => {
  test("defaults to the current directory", () => {
    expect(parseSetupArgs([])).toEqual({ targetDir: ".", help: false });
  });
  test("accepts a positional target directory", () => {
    expect(parseSetupArgs(["./agent"])).toEqual({ targetDir: "./agent", help: false });
  });
  test("--help / -h set help", () => {
    expect(parseSetupArgs(["--help"])).toEqual({ targetDir: ".", help: true });
    expect(parseSetupArgs(["-h"]).help).toBe(true);
  });
  test("rejects unknown flags and a second positional", () => {
    expect(() => parseSetupArgs(["--nope"])).toThrow(/Unknown flag/);
    expect(() => parseSetupArgs(["a", "b"])).toThrow(/at most one target directory/);
  });
});
