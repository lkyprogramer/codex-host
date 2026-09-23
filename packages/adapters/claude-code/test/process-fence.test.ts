import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { closeClaudeProcessGroup } from "../src/process-fence.js";

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function reapedLeader(pid: number): ChildProcess {
  return { pid, exitCode: 0, signalCode: null } as unknown as ChildProcess;
}

function liveLeader(pid: number): ChildProcess {
  return { pid, exitCode: null, signalCode: null } as unknown as ChildProcess;
}

describe.skipIf(process.platform === "win32")("Claude process group fence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never signals a reaped leader's pid that now names another live process", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation((target) => {
      // The pid was handed out again, so the kernel proves the owned group is empty.
      if (target === 4_242) return true;
      throw new Error(`Unexpected signal target ${target}`);
    });
    await expect(closeClaudeProcessGroup(reapedLeader(4_242), 30)).resolves.toBeUndefined();
    expect(kill.mock.calls.filter(([target]) => target === -4_242)).toEqual([]);
  });

  it("still reclaims the group of a reaped leader whose pid is unused", async () => {
    let groupAlive = true;
    const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target === 4_242) throw errno("ESRCH");
      if (target !== -4_242) throw new Error(`Unexpected signal target ${target}`);
      if (!groupAlive) throw errno("ESRCH");
      if (signal === "SIGTERM") groupAlive = false;
      return true;
    });
    await expect(closeClaudeProcessGroup(reapedLeader(4_242), 30)).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledWith(-4_242, "SIGTERM");
  });

  it("waits out an EPERM group instead of failing the shutdown", async () => {
    let blockedProbes = 3;
    vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target !== -4_242) throw new Error(`Unexpected signal target ${target}`);
      // A group down to unreaped zombies refuses every signal until it is reaped.
      if (signal === "SIGTERM") throw errno("EPERM");
      if (blockedProbes-- > 0) throw errno("EPERM");
      throw errno("ESRCH");
    });
    await expect(closeClaudeProcessGroup(liveLeader(4_242), 200)).resolves.toBeUndefined();
  });

  it("names EPERM when a delivered KILL leaves a group that refuses probes", async () => {
    vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target !== -4_242) throw new Error(`Unexpected signal target ${target}`);
      // Both signals land, but only zombies remain and every probe is refused.
      if (signal === "SIGTERM" || signal === "SIGKILL") return true;
      throw errno("EPERM");
    });
    await expect(closeClaudeProcessGroup(liveLeader(4_242), 20)).rejects.toThrow(
      "Claude SDK process group did not exit (EPERM)",
    );
  });

  it("reports a group that keeps refusing signals past its bounds", async () => {
    vi.spyOn(process, "kill").mockImplementation((target) => {
      if (target !== -4_242) throw new Error(`Unexpected signal target ${target}`);
      throw errno("EPERM");
    });
    await expect(closeClaudeProcessGroup(liveLeader(4_242), 20)).rejects.toThrow(
      "Claude SDK process group did not exit (EPERM)",
    );
  });
});
