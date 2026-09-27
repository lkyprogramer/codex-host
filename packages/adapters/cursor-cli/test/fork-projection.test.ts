import { describe, expect, it } from "vitest";
import { cursorSnapshot } from "../src/projection.js";
import type { CursorNativeTurn } from "../src/native-history.js";

const sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
function snapshot(turns: CursorNativeTurn[]) {
  return cursorSnapshot(
    sessionId,
    turns,
    turns.map((turn) => ({
      sessionId,
      update: {
        sessionUpdate: "user_message_chunk" as const,
        content: { type: "text" as const, text: turn.text },
      },
    })),
  );
}
describe("Cursor native fork checkpoint projection", () => {
  it("exposes only a boundary that the next Turn can rewind to, plus the head", () => {
    const turns = [
      { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", text: "first" },
      { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", text: "second", rewindRoot: "a".repeat(64) },
      { id: "dddddddd-dddd-dddd-dddd-dddddddddddd", text: "third" },
    ];
    const projected = snapshot(turns).turns;
    expect(projected[0]?.checkpoint?.checkpointId).toBe(turns[0]?.id);
    expect(projected[1]?.checkpoint).toBeUndefined();
    expect(projected[2]?.checkpoint?.checkpointId).toBe(turns[2]?.id);
  });
});
