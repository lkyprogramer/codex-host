import { describe, expect, it, vi } from "vitest";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import { FakeHarnessSession } from "../src/testing.js";
import { validateHarnessSession } from "../src/session-validation.js";

const id = harnessIdSchema.parse("test-plugin");
const session = () => new FakeHarnessSession(id);

describe("plugin Session boundary", () => {
  it("preserves the instance and does not acquire its output iterator", () => {
    const value = session();
    const iterator = vi.spyOn(value.outputs, Symbol.asyncIterator);
    expect(validateHarnessSession(id, value)).toEqual({ ok: true, value });
    expect(iterator).not.toHaveBeenCalled();
  });

  it.each([
    { harnessId: "another-plugin" },
    { capabilities: {} },
    {
      initialState: {
        nativeRef: { harnessId: "another-plugin", nativeSessionId: "n", formatVersion: 1 },
      },
    },
    { initialState: { effectiveThinkingOptionId: "missing", availableThinkingOptions: [] } },
    { initialUsage: { totalTokens: -1 } },
    { outputs: [] },
    { execute: undefined },
    { close: undefined },
    { commands: { list() {} } },
    { steering: {} },
    { resourceLifecycle: {} },
    { resourceLifecycle: { suspend: true } },
    { workMode: { current: "unsupported", set() {} } },
  ])("rejects malformed Session %#", (override) => {
    const value = Object.create(session()) as object;
    for (const [key, candidate] of Object.entries(override)) {
      Object.defineProperty(value, key, { value: candidate });
    }
    expect(validateHarnessSession(id, value)).toMatchObject({
      ok: false,
      error: { code: "protocolError", retryable: false },
    });
  });

  it("rejects native steering declared without its control", () => {
    const value = session();
    value.capabilities.turnControl = { steering: "native", workModes: ["default"] };
    expect(validateHarnessSession(id, value)).toMatchObject({ ok: false });
  });

  it("contains throwing plugin getters without exposing their payload", () => {
    const value = Object.defineProperty({}, "harnessId", {
      get() {
        throw new Error("private-native-payload");
      },
    });
    const result = validateHarnessSession(id, value);
    expect(result).toMatchObject({ ok: false, error: { code: "protocolError" } });
    expect(JSON.stringify(result)).not.toContain("private-native-payload");
  });
});
