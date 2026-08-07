import { describe, expect, test } from "vite-plus/test";
import { createPhoebeLog } from "./phoebe-log.ts";

describe("createPhoebeLog", () => {
  test("tags every printed line with the bound tenant, never bare", () => {
    const logged: string[] = [];
    const errored: string[] = [];
    const { phoebeLog, phoebeError } = createPhoebeLog("acme/widget", {
      log: (line) => logged.push(line),
      error: (line) => errored.push(line),
    });

    phoebeLog("Working #42.");
    phoebeError("Boom.");

    expect(logged).toEqual(["[phoebe:acme/widget] Working #42."]);
    expect(errored).toEqual(["[phoebe:acme/widget] Boom."]);
  });

  test("exposes the bound tag for message-building call sites that don't print directly", () => {
    const { tag } = createPhoebeLog("acme/widget");
    expect(tag).toBe("[phoebe:acme/widget]");
  });
});
