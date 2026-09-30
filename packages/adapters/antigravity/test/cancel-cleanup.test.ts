import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessOutput } from "@codexhost/harness-adapter";
import type * as HarnessDiscovery from "@codexhost/harness-discovery";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { AntigravityAdapter } from "../src/index.js";

/** The first release of a Turn's process tree fails; later ones work. */
const release = vi.hoisted(() => ({ failNext: 1 }));

vi.mock("@codexhost/harness-discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof HarnessDiscovery>();
  return {
    ...actual,
    spawnOwnedProcess: (...args: Parameters<typeof actual.spawnOwnedProcess>) => {
      const owned = actual.spawnOwnedProcess(...args);
      const tree = owned.tree;
      if (!tree) return owned;
      return {
        ...owned,
        tree: {
          close: async () => {
            if (release.failNext > 0) {
              release.failNext -= 1;
              throw new Error("Owned process group did not exit within cleanup bounds");
            }
            return tree.close();
          },
        },
      };
    },
  };
});

describe.skipIf(process.platform === "win32")("Antigravity cancellation cleanup", () => {
  it("faults the Session and ends its outputs when the cancelled Turn cannot be stopped", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-cancel-"));
    const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-cancel-cwd-"));
    const command = path.join(directory, "agy");
    // Quota and Model probes answer at once; a Turn runs until it is stopped.
    await writeFile(
      command,
      `#!/usr/bin/env node
if (process.argv.includes("models") || process.argv.some((arg) => arg.includes("/usage"))) process.exit(0);
setInterval(() => {}, 1000);
`,
    );
    await chmod(command, 0o755);
    const adapter = new AntigravityAdapter({ command });
    try {
      const opened = await adapter.open({ kind: "create", cwd });
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      const outputs: HarnessOutput[] = [];
      const consumed = (async () => {
        for await (const output of session.outputs) outputs.push(output);
      })();
      const turnId = hostTurnIdSchema.parse("t-cancel-cleanup");
      const started = await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "run until cancelled" }],
      });
      expect(started.ok).toBe(true);

      const cancelled = await session.execute({ type: "turn.cancel", turnId });
      expect(cancelled).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("cancellation cleanup failed") },
      });
      // Outputs end instead of leaving the Host waiting on a closed Session.
      await consumed;
      const events = outputs.flatMap((output) =>
        output.kind === "event" ? [output.event.type] : [],
      );
      expect(events.slice(-2)).toEqual(["turn.completed", "session.faulted"]);
      expect(
        outputs.find((o) => o.kind === "event" && o.event.type === "turn.completed"),
      ).toMatchObject({
        event: { outcome: { status: "failed" } },
      });
    } finally {
      await adapter.close();
      await rm(directory, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
