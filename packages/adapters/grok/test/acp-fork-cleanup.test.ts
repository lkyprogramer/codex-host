import { describe, expect, it, vi } from "vitest";

import { GrokTransportError, loadForkedGrokSession } from "../src/acp-transport.js";

describe("Grok ACP provisional Fork cleanup", () => {
  it("deletes the derived native Session when load fails without changing source history", async () => {
    const sourceHistory = [{ prompt: "source prompt", answer: "source answer" }];
    const nativeHistories = new Map<string, unknown[]>([
      ["source-session", structuredClone(sourceHistory)],
      ["derived-session", structuredClone(sourceHistory)],
    ]);
    const load = vi.fn(async () => {
      throw new Error("synthetic ACP session/load timeout");
    });
    const deleteSession = vi.fn(async () => {
      nativeHistories.delete("derived-session");
    });

    await expect(
      loadForkedGrokSession({ sessionId: "derived-session", load, deleteSession }),
    ).rejects.toMatchObject({
      name: "GrokTransportError",
      kind: "unavailable",
      message:
        "Grok Fork succeeded as derived-session but session/load failed; derived Session was deleted",
    });

    expect(load).toHaveBeenCalledOnce();
    expect(deleteSession).toHaveBeenCalledOnce();
    expect(nativeHistories.get("derived-session")).toBeUndefined();
    expect(nativeHistories.get("source-session")).toEqual(sourceHistory);
  });

  it("keeps load failure typed and surfaces one cleanup diagnostic when delete also fails", async () => {
    const load = vi.fn(async () => {
      throw new Error("synthetic ACP session/load timeout");
    });
    const deleteSession = vi.fn(async () => {
      throw new Error("synthetic ACP session/delete timeout");
    });

    await expect(
      loadForkedGrokSession({ sessionId: "derived-session", load, deleteSession }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof GrokTransportError &&
        error.kind === "unavailable" &&
        error.message.includes("session/load and derived Session cleanup failed") &&
        error.diagnostic === "Derived Session cleanup failed: synthetic ACP session/delete timeout"
      );
    });
    expect(deleteSession).toHaveBeenCalledOnce();
  });
});
