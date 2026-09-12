import { describe, expect, it } from "vitest";

import {
  grokSessionModesOrNative,
  hostWorkModeForNativeId,
  lastModeIdFromEvents,
  nativeModeIdForHostWorkMode,
  parseAcpCurrentModeId,
  parseAcpSessionModes,
} from "../src/grok-work-mode.js";

describe("Grok work mode mapping", () => {
  const available = [
    { id: "code", name: "Code" },
    { id: "plan", name: "Plan" },
  ];

  it("parses ACP session modes and ignores empty catalogs", () => {
    expect(
      parseAcpSessionModes({
        sessionId: "s",
        modes: { currentModeId: "code", availableModes: available },
      }),
    ).toEqual({ currentModeId: "code", availableModes: available });
    expect(parseAcpSessionModes({ sessionId: "s" })).toBeNull();
    expect(
      parseAcpSessionModes({ modes: { currentModeId: "code", availableModes: [] } }),
    ).toBeNull();
  });

  it("maps Host plan/default onto advertised native mode IDs", () => {
    expect(nativeModeIdForHostWorkMode(available, "plan")).toBe("plan");
    expect(nativeModeIdForHostWorkMode(available, "default")).toBe("code");
    expect(hostWorkModeForNativeId(available, "plan")).toBe("plan");
    expect(hostWorkModeForNativeId(available, "code")).toBe("default");
    expect(nativeModeIdForHostWorkMode([{ id: "code", name: "Code" }], "plan")).toBeUndefined();
  });

  it("falls back to native default/plan when session/new omits modes", () => {
    expect(grokSessionModesOrNative({ sessionId: "s" })).toEqual({
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan" },
      ],
    });
  });

  it("does not invent currentModeId default on restore, and prefers native id or last mode.update", () => {
    expect(grokSessionModesOrNative({ sessionId: "s" }, { restore: true })).toEqual({
      currentModeId: null,
      availableModes: [
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan" },
      ],
    });
    expect(parseAcpCurrentModeId({ modes: { currentModeId: "plan" } })).toBe("plan");
    expect(
      grokSessionModesOrNative({ modes: { currentModeId: "plan" } }, { restore: true }),
    ).toMatchObject({ currentModeId: "plan" });
    expect(
      lastModeIdFromEvents([
        { type: "mode.update", modeId: "default" },
        { type: "agent.text" },
        { type: "mode.update", modeId: "plan" },
      ]),
    ).toBe("plan");
    expect(
      grokSessionModesOrNative(
        { sessionId: "s" },
        { restore: true, events: [{ type: "mode.update", modeId: "plan" }] },
      ),
    ).toMatchObject({ currentModeId: "plan" });
  });
});
