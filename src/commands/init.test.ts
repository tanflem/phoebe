// `phoebe init` argv parsing contract (#73) — moved verbatim from
// src/cli.test.ts when parseInitArgs relocated to this module. Every argv
// accepted/rejected before this move is still accepted/rejected identically.

import { describe, expect, test } from "vite-plus/test";
import { parseInitArgs } from "./init.ts";

describe("parseInitArgs", () => {
  test("defaults to current directory and flat profile when no args given", () => {
    expect(parseInitArgs([])).toEqual({
      targetDir: ".",
      help: false,
      profile: "flat",
      withPrompts: false,
    });
  });

  test("accepts a positional target directory (flat)", () => {
    expect(parseInitArgs(["./my-agent"])).toEqual({
      targetDir: "./my-agent",
      help: false,
      profile: "flat",
      withPrompts: false,
    });
  });

  test("accepts --workspace with an optional directory", () => {
    expect(parseInitArgs(["--workspace"])).toEqual({
      targetDir: ".",
      help: false,
      profile: "workspace",
      withPrompts: false,
    });
    expect(parseInitArgs(["--workspace", "./ws"])).toEqual({
      targetDir: "./ws",
      help: false,
      profile: "workspace",
      withPrompts: false,
    });
    expect(parseInitArgs(["./ws", "--workspace"])).toEqual({
      targetDir: "./ws",
      help: false,
      profile: "workspace",
      withPrompts: false,
    });
  });

  test("accepts --tenant with an optional directory", () => {
    expect(parseInitArgs(["--tenant", "./child"])).toEqual({
      targetDir: "./child",
      help: false,
      profile: "tenant",
      withPrompts: false,
    });
  });

  test("accepts tenant overrides --slug / --url / --with-prompts", () => {
    expect(
      parseInitArgs([
        "--tenant",
        "./child",
        "--slug",
        "acme/widget",
        "--url",
        "git@example.com:acme/widget.git",
        "--with-prompts",
      ]),
    ).toEqual({
      targetDir: "./child",
      help: false,
      profile: "tenant",
      repoSlug: "acme/widget",
      repoUrl: "git@example.com:acme/widget.git",
      withPrompts: true,
    });
    expect(parseInitArgs(["--tenant", "--slug=acme/x", "--url=https://e/x.git"])).toEqual({
      targetDir: ".",
      help: false,
      profile: "tenant",
      repoSlug: "acme/x",
      repoUrl: "https://e/x.git",
      withPrompts: false,
    });
  });

  test("rejects tenant-only flags without --tenant", () => {
    expect(() => parseInitArgs(["--slug", "a/b"])).toThrow(/only valid with/);
    expect(() => parseInitArgs(["--workspace", "--with-prompts"])).toThrow(/only valid with/);
  });

  test("--workspace and --tenant are mutually exclusive", () => {
    expect(() => parseInitArgs(["--workspace", "--tenant"])).toThrow(/mutually exclusive/);
    expect(() => parseInitArgs(["--tenant", "--workspace", "./x"])).toThrow(/mutually exclusive/);
  });

  test("--help / -h set help without requiring a directory", () => {
    expect(parseInitArgs(["--help"])).toEqual({
      targetDir: ".",
      help: true,
      profile: "flat",
      withPrompts: false,
    });
    expect(parseInitArgs(["-h"]).help).toBe(true);
  });

  test("rejects unknown flags", () => {
    expect(() => parseInitArgs(["--forcee"])).toThrow(/Unknown flag/);
  });

  test("rejects a second positional argument", () => {
    expect(() => parseInitArgs(["a", "b"])).toThrow(/at most one target directory/);
  });
});
