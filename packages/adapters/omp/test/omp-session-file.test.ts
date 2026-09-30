import { appendFile, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readOmpBoundedSessionHistory, verifyOmpSessionCwd } from "../src/omp-session-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("OMP session files", () => {
  it("finds the session header after OMP's title record", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-omp-session-"));
    temporaryDirectories.push(directory);
    const sessionFile = path.join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "title", title: "" })}\n${JSON.stringify({
        type: "session",
        id: "omp-session",
        cwd: directory,
      })}\n`,
    );

    await expect(
      verifyOmpSessionCwd({
        sessionFile,
        sessionId: "omp-session",
        expectedCwd: directory,
      }),
    ).resolves.toBeUndefined();
  });

  it("reports an append after the bounded file snapshot instead of a complete child history", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-omp-session-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "child.jsonl");
    await writeFile(
      file,
      `${JSON.stringify({ type: "message", id: "user", parentId: null, message: { role: "user" } })}\n`,
    );
    const handle = await open(file, "r");
    try {
      const initialSize = (await handle.stat()).size;
      await appendFile(
        file,
        `${JSON.stringify({ type: "message", id: "assistant", parentId: "user", message: { role: "assistant" } })}\n`,
      );
      await expect(
        readOmpBoundedSessionHistory(handle, initialSize, 8 * 1024 * 1024),
      ).rejects.toThrow(/changed/);
    } finally {
      await handle.close();
    }
  });
});
