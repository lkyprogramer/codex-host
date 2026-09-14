import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { trackOwnedProcessTree } from "../src/index.js";

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function killFixtureGroup(pid: number | undefined): void {
  if (!pid || process.platform === "win32") return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ESRCH")
      return;
    throw error;
  }
}

describe("owned process tree", () => {
  const leaderCode = [
    "const {spawn}=require('node:child_process');",
    "spawn(process.execPath,['-e','process.on(\"SIGTERM\",()=>{});setInterval(()=>{},1_000)'],{stdio:'ignore'});",
    "process.on('SIGTERM',()=>process.exit(0));",
    "setInterval(()=>{},1_000);",
  ].join("");

  it.skipIf(process.platform === "win32")(
    "reclaims descendants when the owned detached leader exits after SIGTERM",
    async () => {
      const leader = spawn(process.execPath, ["-e", leaderCode], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const leaderPid = leader.pid;
      if (!leaderPid) {
        leader.kill("SIGKILL");
        throw new Error("Detached fixture did not receive a process id");
      }
      const tracker = trackOwnedProcessTree(leader, { detached: true, closeTimeoutMs: 200 });
      if (!tracker) throw new Error("Expected detached fixture to be tracked");
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        expect(isProcessGroupAlive(leaderPid)).toBe(true);

        await expect(tracker.close()).resolves.toBeUndefined();
        await expect.poll(() => isProcessGroupAlive(leaderPid), { timeout: 1_000 }).toBe(false);
      } finally {
        killFixtureGroup(leaderPid);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses to track a child that shares the Host group",
    () => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      try {
        expect(trackOwnedProcessTree(child, { detached: false, closeTimeoutMs: 10 })).toBeNull();
      } finally {
        child.kill();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "treats an EPERM group probe as still alive instead of throwing from the poll path",
    async () => {
      const child = Object.assign(new EventEmitter(), {
        pid: 91_337,
        exitCode: null,
        signalCode: null,
      }) as unknown as ChildProcess;
      const tracker = trackOwnedProcessTree(child, { detached: true, closeTimeoutMs: 10 });
      if (!tracker) throw new Error("Expected synthetic detached child to be tracked");
      let probes = 0;
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -91_337 && signal === "SIGTERM") {
          return true;
        }
        if (pid === -91_337 && signal === 0) {
          probes += 1;
          if (probes === 1) throw Object.assign(new Error("exiting"), { code: "EPERM" });
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        throw new Error(`Unexpected signal ${pid} ${String(signal)}`);
      });
      try {
        await expect(tracker.close()).resolves.toBeUndefined();
      } finally {
        kill.mockRestore();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "reclaims a remaining descendant when the tracked leader exits before close",
    async () => {
      const leader = spawn(process.execPath, ["-e", leaderCode], {
        detached: true,
        stdio: "ignore",
      });
      const leaderPid = leader.pid;
      if (!leaderPid) {
        leader.kill("SIGKILL");
        throw new Error("Detached fixture did not receive a process id");
      }
      const tracker = trackOwnedProcessTree(leader, { detached: true, closeTimeoutMs: 200 });
      if (!tracker) throw new Error("Expected detached fixture to be tracked");
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        expect(isProcessGroupAlive(leaderPid)).toBe(true);

        process.kill(leaderPid, "SIGTERM");
        await expect.poll(() => isProcessGroupAlive(leaderPid), { timeout: 1_000 }).toBe(false);
      } finally {
        killFixtureGroup(leaderPid);
      }
    },
  );
});
