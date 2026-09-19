import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { harnessIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  commandCodeSessionTurns,
  findCommandCodeSessionFile,
  latestCommandCodePromptId,
  readCommandCodeSessionFile,
} from "../src/index.js";

const harnessId = harnessIdSchema.parse("command-code");

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Shapes taken from a 1.58.0 transcript and the CLI's own replay code. */
const TRANSCRIPT =
  line({
    type: "session",
    version: 3,
    id: "s-1",
    timestamp: "2026-09-19T03:58:06.402Z",
    cwd: "/work",
  }) +
  line({
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: "2026-09-19T03:58:07.691Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "Read README" }],
      meta: { source: "user", createdAt: 1, messageId: "u1" },
    },
  }) +
  line({
    type: "message",
    id: "m2",
    parentId: "m1",
    timestamp: "2026-09-19T03:58:08.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "look at the file", signature: "" },
        {
          type: "tool_use",
          id: "call-1",
          name: "read_file",
          input: { file_path: "/work/README.md" },
        },
      ],
    },
  }) +
  line({
    type: "message",
    id: "m3",
    parentId: "m2",
    timestamp: "2026-09-19T03:58:09.000Z",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: "hello" }] },
      ],
      meta: { source: "tool" },
    },
  }) +
  // A compaction node on the chain, as the CLI writes after auto-compaction.
  line({
    type: "compaction",
    id: "k1",
    parentId: "m3",
    timestamp: "2026-09-19T03:58:09.500Z",
    summary: "compacted",
    firstKeptEntryId: "m1",
    tokensBefore: 10,
  }) +
  line({
    type: "message",
    id: "m4",
    parentId: "k1",
    timestamp: "2026-09-19T03:58:10.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "OK" }] },
  }) +
  // A rewound branch: this prompt was abandoned and must not replay.
  line({
    type: "message",
    id: "m5-abandoned",
    parentId: "m4",
    timestamp: "2026-09-19T03:58:11.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "abandoned" }],
      meta: { source: "user" },
    },
  }) +
  line({
    type: "message",
    id: "m6",
    parentId: "m4",
    timestamp: "2026-09-19T03:58:12.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "Second prompt" }],
      meta: { source: "user" },
    },
  }) +
  line({
    type: "model_change",
    id: "k2",
    parentId: "m6",
    timestamp: "2026-09-19T03:58:12.500Z",
    model: "claude-sonnet-5",
  }) +
  // A CLI-injected user message without a source is not a Turn boundary.
  line({
    type: "message",
    id: "m7",
    parentId: "k2",
    timestamp: "2026-09-19T03:58:13.000Z",
    message: { role: "user", content: [{ type: "text", text: "Insufficient credits" }], meta: {} },
  });

describe("Command Code session file", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it("replays the active branch across non-message nodes with tool outputs paired by tool_use_id", () => {
    const turns = commandCodeSessionTurns({
      content: TRANSCRIPT,
      harnessId,
      nativeSessionId: "s-1",
      toolOutputLimit: 3,
    });
    expect(turns).toHaveLength(2);
    const [first, second] = turns;
    expect(first?.nativeTurnRef.nativeTurnKey).toBe("m1");
    expect(first?.input).toEqual([{ type: "text", text: "Read README" }]);
    expect(first?.items.map(({ item }) => item.type)).toEqual([
      "reasoning",
      "toolExecution",
      "agentMessage",
    ]);
    expect(first?.items[1]?.item).toMatchObject({
      toolName: "read_file",
      arguments: { file_path: "/work/README.md" },
      output: { content: [{ type: "text", text: "hel" }], truncated: true },
    });
    expect(first).not.toHaveProperty("checkpoint");
    expect(first?.outcome).toEqual({ status: "succeeded" });
    expect(first?.startedAtMs).toBe(Date.parse("2026-09-19T03:58:07.691Z"));
    expect(second?.nativeTurnRef.nativeTurnKey).toBe("m6");
    expect(second?.outcome).toMatchObject({ status: "unknown" });
    expect(latestCommandCodePromptId(TRANSCRIPT)).toBe("m6");
  });

  it("finds a Session by ID across project directories and validates its header", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-cc-home-"));
    roots.push(home);
    const projects = path.join(home, ".commandcode", "projects");
    await mkdir(path.join(projects, "other-project"), { recursive: true });
    await mkdir(path.join(projects, "this-project"), { recursive: true });
    await writeFile(path.join(projects, "this-project", "s-1.jsonl"), TRANSCRIPT);
    await writeFile(path.join(projects, "other-project", "bad.jsonl"), "not json\n");
    const environment = { HOME: home, USERPROFILE: home };
    const found = await findCommandCodeSessionFile(environment, "s-1");
    expect(found).toMatchObject({
      path: path.join(projects, "this-project", "s-1.jsonl"),
      header: { id: "s-1", cwd: "/work", version: 3 },
    });
    expect(await findCommandCodeSessionFile(environment, "missing")).toBeNull();
    expect(await findCommandCodeSessionFile(environment, "../s-1")).toBeNull();
    expect(
      await readCommandCodeSessionFile(path.join(projects, "other-project", "bad.jsonl")),
    ).toBeNull();
    expect(await findCommandCodeSessionFile({ HOME: path.join(home, "nope") }, "s-1")).toBeNull();
  });
});
