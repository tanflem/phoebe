// `defineConfig` is a strict identity function — a typing helper only. It must
// return its input by reference and accept the bootstrapper-only `engine` and
// `workspace` fields.

import { describe, expect, test } from "vite-plus/test";
import type { PhoebeUserConfig } from "../src/config/index.ts";
import { defineConfig } from "./define-config.ts";

describe("defineConfig", () => {
  test("returns the input by reference (identity)", () => {
    const input: PhoebeUserConfig = {
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
      installCommand: "npm ci",
      checkCommand: "npm run check",
      testCommand: "npm test",
    };
    expect(defineConfig(input)).toBe(input);
  });

  test("accepts an engine source field", () => {
    const input: PhoebeUserConfig = {
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
      installCommand: "npm ci",
      checkCommand: "npm run check",
      testCommand: "npm test",
      engine: { source: "github", ref: "v1.0.0" },
    };
    expect(defineConfig(input).engine).toEqual({ source: "github", ref: "v1.0.0" });
  });

  test("accepts a workspace discovery field", () => {
    const input: PhoebeUserConfig = {
      repoSlug: "acme/widget",
      repoUrl: "https://github.com/acme/widget.git",
      installCommand: "npm ci",
      checkCommand: "npm run check",
      testCommand: "npm test",
      workspace: { depth: 2 },
    };
    expect(defineConfig(input).workspace).toEqual({ depth: 2 });
  });
});
