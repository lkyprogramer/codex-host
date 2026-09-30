import { describe, expect, it } from "vitest";
import { hostTurnIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";

import { ClaudeCodeAdapter } from "@codexhost/adapter-claude-code";
type ClaudeAdapterDependencies = NonNullable<ConstructorParameters<typeof ClaudeCodeAdapter>[1]>;
import { projectHistoricalTurn } from "../src/index.js";

const cwd = "/synthetic";
const sessionId = "00000000-0000-4000-8000-000000000013";

describe("Claude native patch history projection", () => {
  it("projects a persisted Edit through Adapter.readSnapshot into one file card", async () => {
    const transcript = [
      {
        type: "user",
        uuid: "prompt",
        session_id: sessionId,
        message: { role: "user", content: "edit sample.txt" },
      },
      {
        type: "assistant",
        uuid: "tool-message",
        session_id: sessionId,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "edit-1",
              name: "Edit",
              input: { file_path: "sample.txt", old_string: "old", new_string: "new" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "result-message",
        session_id: sessionId,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "edit-1", content: "edited" }],
        },
        toolUseResult: {
          filePath: `${cwd}/sample.txt`,
          structuredPatch: [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "answer",
        session_id: sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      },
    ];
    const dependencies: ClaudeAdapterDependencies = {
      randomUUID: () => sessionId,
      inspectInstallation: () => undefined,
      createInspector: () => {
        throw new Error("Unexpected Claude inspection");
      },
      createTransport: () => {
        throw new Error("Unexpected Claude transport");
      },
      deleteSession: async () => undefined,
      forkSession: async () => {
        throw new Error("Unexpected Claude Fork");
      },
      getSessionInfo: async () => ({ cwd }),
      readSessionMessages: async () => transcript,
      readSubagentMessages: async () => [],
    };
    const adapter = new ClaudeCodeAdapter(
      { environment: { CLAUDE_CONFIG_DIR: `${cwd}/claude-fixture` } },
      dependencies,
    );
    try {
      const opened = await adapter.open({
        kind: "resume",
        cwd,
        nativeRef: nativeSessionRefSchema.parse({
          harnessId: "claude-code",
          nativeSessionId: sessionId,
          formatVersion: 1,
        }),
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const snapshot = await opened.value.readSnapshot();
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      const turn = snapshot.value.turns[0];
      if (!turn) throw new Error("Missing historical Claude Turn");
      const tool = turn.items[0]?.item;
      const change = turn.items[1]?.item;
      if (!tool || change?.type !== "fileChange") throw new Error("Missing native patch");
      expect(change.sourceItemIds).toEqual([tool.itemId]);

      const projected = projectHistoricalTurn({
        turnId: hostTurnIdSchema.parse("claude-edit"),
        cwd,
        snapshot: turn,
      });
      const cards = (projected.items as Array<{ type: string; changes?: unknown[] }>).filter(
        (item) => item.type === "fileChange",
      );
      expect(cards).toHaveLength(1);
      expect(cards[0]?.changes).toHaveLength(1);
      expect(JSON.stringify(cards[0])).toContain("-old");
      expect(JSON.stringify(cards[0])).toContain("+new");
    } finally {
      await adapter.close();
    }
  });
});
