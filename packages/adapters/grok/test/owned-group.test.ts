import { spawn } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { processStartToken, reclaimOwnedGroup, type OwnedGroupRef } from "../src/owned-group.js";

const spawned: number[] = [];

function groupState(pid: number): "alive" | "exiting" | "gone" {
  try {
    process.kill(-pid, 0);
    return "alive";
  } catch (error) {
    const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : null;
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "exiting";
    throw error;
  }
}

function leaderState(pid: number): "alive" | "gone" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : null;
    if (code === "ESRCH") return "gone";
    return "alive";
  }
}

function forceKillGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: already gone. EPERM: only a zombie remains.
  }
}

/** A detached leader plus one descendant that ignores SIGTERM. */
async function startGroup(): Promise<{ pid: number }> {
  const leader = spawn(
    process.execPath,
    [
      "-e",
      [
        "const {spawn}=require('node:child_process');",
        "spawn(process.execPath,['-e','process.on(\"SIGTERM\",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});",
        "process.on('SIGTERM',()=>{});",
        "setInterval(()=>{},1000);",
      ].join(""),
    ],
    { detached: true, stdio: "ignore" },
  );
  const pid = leader.pid;
  if (!pid) {
    leader.kill("SIGKILL");
    throw new Error("Detached fixture did not receive a process id");
  }
  spawned.push(pid);
  await new Promise((resolve) => setTimeout(resolve, 60));
  return { pid };
}

function ref(pid: number, overrides: Partial<OwnedGroupRef> = {}): OwnedGroupRef {
  return {
    pid,
    pgid: -pid,
    startToken: processStartToken(pid),
    leaderExited: false,
    ...overrides,
  };
}

describe("owned group reclaim", () => {
  afterEach(() => {
    for (const pid of spawned.splice(0)) forceKillGroup(pid);
  });

  it.skipIf(process.platform === "win32")(
    "escalates to SIGKILL for descendants that ignore SIGTERM",
    async () => {
      const { pid } = await startGroup();
      expect(groupState(pid)).toBe("alive");
      await expect(reclaimOwnedGroup(ref(pid), 300)).resolves.toBe(false);
      expect(groupState(pid)).not.toBe("alive");
    },
  );

  it.skipIf(process.platform === "win32")(
    "escalates TERM then KILL and reports a group that never exits",
    async () => {
      const kill = vi.spyOn(process, "kill").mockImplementation((target) => {
        // The leader was reaped, so the group id cannot have been recycled,
        // but the group itself never goes away.
        if (target === 4_242) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        if (target === -4_242) return true;
        throw new Error(`Unexpected signal target ${target}`);
      });
      let signalled: unknown[][] = [];
      try {
        await expect(
          reclaimOwnedGroup({ pid: 4_242, pgid: -4_242, startToken: "", leaderExited: true }, 30),
        ).resolves.toBe(true);
        signalled = kill.mock.calls.filter(([target, signal]) => target === -4_242 && signal !== 0);
      } finally {
        kill.mockRestore();
      }
      expect(signalled).toEqual([
        [-4_242, "SIGTERM"],
        [-4_242, "SIGKILL"],
      ]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "never signals a pid whose recorded start token no longer matches",
    async () => {
      const { pid } = await startGroup();
      const kill = vi.spyOn(process, "kill");
      let signalled: unknown[][] = [];
      try {
        // The live pid belongs to someone else now: this spawn's group must
        // already be gone, and the current owner must not be signalled.
        await expect(
          reclaimOwnedGroup(ref(pid, { startToken: "Thu Jan  1 00:00:00 1970" }), 300),
        ).resolves.toBe(false);
        signalled = kill.mock.calls.filter(([target, signal]) => target === -pid && signal !== 0);
      } finally {
        kill.mockRestore();
      }
      expect(signalled).toEqual([]);
      expect(groupState(pid)).toBe("alive");
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses to signal a live leader whose identity cannot be proven",
    async () => {
      const { pid } = await startGroup();
      const kill = vi.spyOn(process, "kill");
      let signalled: unknown[][] = [];
      try {
        await expect(reclaimOwnedGroup(ref(pid, { startToken: "" }), 300)).resolves.toBe(true);
        signalled = kill.mock.calls.filter(([target, signal]) => target === -pid && signal !== 0);
      } finally {
        kill.mockRestore();
      }
      expect(signalled).toEqual([]);
      expect(groupState(pid)).toBe("alive");
    },
  );

  it.skipIf(process.platform === "win32")(
    "still reclaims descendants after the leader exited, with no token to compare",
    async () => {
      const { pid } = await startGroup();
      process.kill(pid, "SIGKILL");
      await expect.poll(() => leaderState(pid), { timeout: 1_000 }).toBe("gone");
      // The leader is gone, so the group id cannot have been recycled: its
      // surviving descendants are still this spawn's and may be signalled.
      await expect(
        reclaimOwnedGroup(ref(pid, { startToken: "", leaderExited: true }), 300),
      ).resolves.toBe(false);
      expect(groupState(pid)).not.toBe("alive");
    },
  );
});
