import { describe, expect, it, vi } from "vitest";

import type { HarnessSession } from "@codexhost/harness-adapter";

import { applyRequestedWorkMode, requestedWorkMode } from "../src/external-work-mode.js";

describe("external work mode", () => {
  it("reads Desktop collaborationMode without treating it as a permission mode", () => {
    expect(requestedWorkMode({ collaborationMode: { mode: "plan" } })).toBe("plan");
    expect(requestedWorkMode({ collaborationMode: { mode: "planning" } })).toBe("plan");
    expect(requestedWorkMode({ collaborationMode: { mode: "default" } })).toBe("default");
    expect(requestedWorkMode({ collaborationMode: { mode: "code" } })).toBeUndefined();
    expect(requestedWorkMode({})).toBeUndefined();
  });

  it("skips set when Desktop omitted a work-mode selection", async () => {
    const set = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const session = { workMode: { current: "plan" as const, set } } as HarnessSession;
    await applyRequestedWorkMode(session, undefined);
    expect(set).not.toHaveBeenCalled();
  });

  it("fails closed when Plan is requested but the Session has no work-mode control", async () => {
    await expect(applyRequestedWorkMode({} as HarnessSession, "plan")).rejects.toThrow(
      "Planning mode is unavailable for this Harness",
    );
  });

  it("sets Plan only when it differs from the native current mode", async () => {
    const set = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const session = { workMode: { current: "default" as const, set } } as HarnessSession;
    await applyRequestedWorkMode(session, "plan");
    expect(set).toHaveBeenCalledWith("plan");
    set.mockClear();
    const alreadyPlan = { workMode: { current: "plan" as const, set } } as HarnessSession;
    await applyRequestedWorkMode(alreadyPlan, "plan");
    expect(set).not.toHaveBeenCalled();
  });
});
