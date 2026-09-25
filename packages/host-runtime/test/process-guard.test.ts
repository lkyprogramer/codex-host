import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { exitAfterRun, installProcessGuard, onFatalShutdown } from "../src/process-guard.js";

class FakeProcess extends EventEmitter {
  exitCode: number | undefined;
  exit = vi.fn((code?: number) => {
    this.exitCode = code;
    return undefined as never;
  });
}

describe("process guard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a stray rejection and keeps the Host running", () => {
    const target = new FakeProcess();
    const lines: string[] = [];
    const shutdown = vi.fn();
    const release = onFatalShutdown(shutdown);
    const remove = installProcessGuard({ write: (line) => lines.push(line), process: target });
    try {
      target.emit("unhandledRejection", new Error("plugin forgot to await"));
      expect(lines.join("")).toContain("unhandled rejection (continuing)");
      expect(lines.join("")).toContain("plugin forgot to await");
      expect(shutdown).not.toHaveBeenCalled();
      expect(target.exit).not.toHaveBeenCalled();
      expect(target.exitCode).toBeUndefined();
    } finally {
      remove();
      release();
    }
  });

  it("closes registered Hosts once after an uncaught exception and bounds the wait", () => {
    vi.useFakeTimers();
    const target = new FakeProcess();
    const lines: string[] = [];
    const shutdown = vi.fn();
    const release = onFatalShutdown(shutdown);
    const remove = installProcessGuard({
      write: (line) => lines.push(line),
      process: target,
      fatalShutdownDeadlineMs: 1_000,
    });
    try {
      target.emit("uncaughtException", new Error("plugin threw"));
      target.emit("uncaughtException", new Error("and again"));
      expect(shutdown).toHaveBeenCalledOnce();
      expect(target.exitCode).toBe(1);
      expect(target.exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(target.exit).toHaveBeenCalledWith(1);
      expect(lines.join("")).toContain("and again");
    } finally {
      remove();
      release();
    }
  });

  it("ends a finished run that a leaked handle keeps alive, keeping a fatal code", () => {
    vi.useFakeTimers();
    const target = new FakeProcess();
    exitAfterRun(0, target, 100, []);
    expect(target.exitCode).toBe(0);
    vi.advanceTimersByTime(100);
    expect(target.exit).toHaveBeenCalledWith(0);

    const failed = new FakeProcess();
    failed.exitCode = 1;
    exitAfterRun(0, failed, 100, []);
    vi.advanceTimersByTime(100);
    expect(failed.exit).toHaveBeenCalledWith(1);
  });

  it("waits for queued output before a forced exit, but not forever", () => {
    vi.useFakeTimers();
    const target = new FakeProcess();
    const output = { writableLength: 4096 };
    exitAfterRun(0, target, 100, [output]);
    vi.advanceTimersByTime(300);
    expect(target.exit).not.toHaveBeenCalled();
    output.writableLength = 0;
    vi.advanceTimersByTime(100);
    expect(target.exit).toHaveBeenCalledWith(0);

    const stuck = new FakeProcess();
    exitAfterRun(0, stuck, 100, [{ writableLength: 1 }]);
    vi.advanceTimersByTime(100 * 8);
    expect(stuck.exit).toHaveBeenCalledWith(0);
  });
});
