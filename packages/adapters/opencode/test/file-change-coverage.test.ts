import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HostFileChange, HostItem } from "@codexhost/harness-adapter";
import { hostItemIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { coverOpenCodeFileChanges } from "../src/file-change-coverage.js";
import { verifiedOpenCodeWorktree } from "../src/file-change-verification.js";

const tool = (id: string, file: string): HostItem => ({
  type: "toolExecution",
  itemId: hostItemIdSchema.parse(id),
  toolName: "edit",
  arguments: { path: file, old_string: "old", new_string: "new" },
});
const change = (file: string): HostFileChange => ({
  path: file,
  kind: "update",
  unifiedDiff: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n",
});

describe("OpenCode native diff coverage", () => {
  it("marks only verified same-file tool previews in a partial native diff", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-coverage-"));
    try {
      const worktree = verifiedOpenCodeWorktree(directory, { directory, worktree: directory });
      expect(worktree).toBeDefined();
      const items = [tool("edit-a", "a.txt"), tool("edit-b", "b.txt")];
      const native = [change("a.txt")];
      const covered = coverOpenCodeFileChanges(native, items, directory, worktree);
      expect(covered).toMatchObject([
        { path: path.join(directory, "a.txt"), coveredToolItemIds: ["edit-a"] },
      ]);
      expect(items[0]).toMatchObject({ arguments: { path: "a.txt" } });
      expect(native[0]).toMatchObject({ path: "a.txt" });
      expect(coverOpenCodeFileChanges([], items, directory, worktree)).toEqual([]);
      expect(coverOpenCodeFileChanges(native, items, directory, undefined)).toEqual(native);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
