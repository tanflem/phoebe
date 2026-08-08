// Contract tests for the shared `.env` parser (issue #63): the union of the
// two parsers it replaces — `export ` prefix stripping (from the supervisor's
// former bootstrap/engine-child-env.ts parser) and key validation (from
// `phoebe setup`'s former src/setup.ts parser).

import { describe, expect, test } from "vite-plus/test";
import { parseDotenv } from "./dotenv.ts";

describe("parseDotenv", () => {
  test("parses KEY=VALUE lines, ignoring blanks and comments", () => {
    const parsed = parseDotenv(
      ["# a comment", "", "GH_TOKEN=ghp_abc", "CURSOR_API_KEY=sk-123", "  # indented", ""].join(
        "\n",
      ),
    );
    expect(parsed).toEqual({ GH_TOKEN: "ghp_abc", CURSOR_API_KEY: "sk-123" });
  });

  test("strips surrounding quotes and an optional `export` prefix", () => {
    const parsed = parseDotenv(['export GH_TOKEN="ghp_x"', "OPENAI_KEY='sk-y'"].join("\n"));
    expect(parsed).toEqual({ GH_TOKEN: "ghp_x", OPENAI_KEY: "sk-y" });
  });

  test("keeps `=` inside values and trims key whitespace", () => {
    expect(parseDotenv("FOO = a=b=c")).toEqual({ FOO: "a=b=c" });
  });

  test("ignores malformed lines with no `=`", () => {
    expect(parseDotenv("not a pair\nGH_TOKEN=ok")).toEqual({ GH_TOKEN: "ok" });
  });

  test("drops keys that don't look like identifiers", () => {
    const parsed = parseDotenv(["1BAD=x", "a-b=x", "GH_TOKEN=ok"].join("\n"));
    expect(parsed).toEqual({ GH_TOKEN: "ok" });
  });

  test("applies `export` stripping and key validation together", () => {
    const parsed = parseDotenv(["export 1BAD=x", "export GH_TOKEN=ok"].join("\n"));
    expect(parsed).toEqual({ GH_TOKEN: "ok" });
  });
});
