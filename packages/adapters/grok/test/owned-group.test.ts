import { spawn } from "node:child_process";
import type * as NodeChildProcess from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

/** Flipped to model a `ps` read that fails or returns nothing. */
let readsStartToken = true;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return {
    ...actual,
    spawnSync: ((command: string, args: readonly string[], options: unknown) =>
      command === "ps" && !readsStartToken
        ? { stdout: "", stderr: "", status: 1, signal: null, pid: 0, output: [] }
        : (actual.spawnSync as (...input: unknown[]) => unknown)(
            command,
            args,
            options,
          )) as typeof actual.spawnSync,
  };
});

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
        // The handle saw this child exit and the live pid no longer matches
        // the recorded spawn: it belongs to someone else, who must not be
        // signalled, and this spawn's own group must already be gone.
        await expect(
          reclaimOwnedGroup(
            ref(pid, { startToken: "Thu Jan  1 00:00:00 1970", leaderExited: true }),
            300,
          ),
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
        await expect(
          reclaimOwnedGroup(ref(pid, { startToken: "", leaderExited: true }), 300),
        ).resolves.toBe(true);
        signalled = kill.mock.calls.filter(([target, signal]) => target === -pid && signal !== 0);
      } finally {
        kill.mockRestore();
      }
      expect(signalled).toEqual([]);
      expect(groupState(pid)).toBe("alive");
    },
  );

  it.skipIf(process.platform === "win32")(
    "reclaims a live leader the tracked handle has not seen exit",
    async () => {
      const { pid } = await startGroup();
      // Node has not reaped this child, so its pid cannot belong to anyone
      // else - no token comparison can override that.
      await expect(
        reclaimOwnedGroup(ref(pid, { startToken: "Thu Jan  1 00:00:00 1970" }), 300),
      ).resolves.toBe(false);
      expect(groupState(pid)).not.toBe("alive");
    },
  );

  it.skipIf(process.platform === "win32")(
    "never abandons a live group because the start token could not be read",
    async () => {
      const { pid } = await startGroup();
      readsStartToken = false;
      const kill = vi.spyOn(process, "kill");
      let signalled: unknown[][] = [];
      try {
        // An unreadable token is not evidence that the pid was recycled: the
        // group must stay owned and unconfirmed, never reported as released.
        await expect(
          reclaimOwnedGroup(ref(pid, { startToken: "recorded-at-spawn", leaderExited: true }), 300),
        ).resolves.toBe(true);
        signalled = kill.mock.calls.filter(([target, signal]) => target === -pid && signal !== 0);
      } finally {
        kill.mockRestore();
        readsStartToken = true;
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
