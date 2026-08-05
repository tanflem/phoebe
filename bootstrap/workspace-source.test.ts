// Workspace field reader (#83/#91): presence selects workspace mode; malformed
// values fail loudly; omitted depth defaults to 1.

import { describe, expect, test } from "vite-plus/test";
import { DEFAULT_WORKSPACE_DEPTH, readWorkspaceField } from "./workspace-source.ts";

describe("readWorkspaceField", () => {
  test("absent workspace → null (ladder falls through to nested/flat)", () => {
    expect(readWorkspaceField({})).toBeNull();
    expect(readWorkspaceField({ engine: { source: "local" } })).toBeNull();
  });

  test("empty block defaults depth to 1", () => {
    expect(readWorkspaceField({ workspace: {} })).toEqual({ depth: DEFAULT_WORKSPACE_DEPTH });
    expect(DEFAULT_WORKSPACE_DEPTH).toBe(1);
  });

  test("honours an explicit depth", () => {
    expect(readWorkspaceField({ workspace: { depth: 3 } })).toEqual({ depth: 3 });
  });

  test("rejects depth < 1", () => {
    expect(() => readWorkspaceField({ workspace: { depth: 0 } })).toThrow(/workspace/);
    expect(() => readWorkspaceField({ workspace: { depth: -1 } })).toThrow(/workspace/);
  });

  test("rejects non-integer depth", () => {
    expect(() => readWorkspaceField({ workspace: { depth: 1.5 } })).toThrow(/workspace/);
  });

  test("rejects a non-object workspace value", () => {
    expect(() => readWorkspaceField({ workspace: true })).toThrow(/workspace/);
    expect(() => readWorkspaceField({ workspace: "yes" })).toThrow(/workspace/);
    expect(() => readWorkspaceField({ workspace: [] })).toThrow(/workspace/);
  });
});
