import { describe, expect, it, vi } from "vitest";

import { HarnessSessionKernel, type HarnessSessionKernelHooks } from "../src/session-kernel.js";
import type { HarnessWorkLevel } from "../src/text-session.js";

const active = { aborted: false };

type KernelOverrides = Partial<Omit<HarnessSessionKernelHooks, "releaseFailure">> &
  (
    | { releaseFailure?: "retry" }
    | { releaseFailure: "fault"; publishReleaseFault(error: unknown): void }
  );

function kernel(overrides: KernelOverrides = {}) {
  let work: HarnessWorkLevel = { level: "idle" };
  const releaseNative = vi.fn(async (): Promise<void> => undefined);
  const released = vi.fn();
  const value = new HarnessSessionKernel({
    label: "Test Session",
    scope: "test-scope",
    workLevel: () => work,
    releaseNative,
    released,
    ...overrides,
  });
  return {
    value,
    releaseNative,
    released,
    setWork(next: HarnessWorkLevel) {
      work = next;
    },
  };
}

// Outputs allow one consumer: every check of a kernel reads its one iterator.
const iterators = new WeakMap<HarnessSessionKernel, AsyncIterator<unknown>>();

async function ended(value: HarnessSessionKernel): Promise<boolean> {
  let iterator = iterators.get(value);
  if (!iterator) {
    iterator = value.channel.outputs[Symbol.asyncIterator]();
    iterators.set(value, iterator);
  }
  const next = await Promise.race([
    iterator.next(),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20)),
  ]);
  return next !== "pending" && next.done === true;
}

describe("HarnessSessionKernel release", () => {
  it("declines untouched while native work runs, when undecided, or when aborted", async () => {
    const busy = kernel();
    busy.setWork({ level: "busy", reason: "a Turn runs" });
    await expect(busy.value.release(active)).resolves.toEqual({
      status: "busy",
      reason: "a Turn runs",
    });
    expect(busy.value.resourceLifecycle.workLevel?.()).toEqual({
      level: "busy",
      reason: "a Turn runs",
    });

    const undecided = kernel({ undecided: () => "nothing persisted yet" });
    await expect(undecided.value.release(active)).resolves.toEqual({
      status: "unknown",
      reason: "nothing persisted yet",
    });

    const aborted = kernel();
    await expect(aborted.value.release({ aborted: true })).resolves.toMatchObject({
      status: "unknown",
    });
    for (const { value, releaseNative } of [busy, undecided, aborted]) {
      expect(releaseNative).not.toHaveBeenCalled();
      expect(value.phase).toBe("open");
    }
  });

  it("leaves open before the first await, shares one attempt, and ends outputs", async () => {
    const { value, releaseNative, released } = kernel();
    const first = value.release(active);
    // Admission and the phase change are synchronous.
    expect(value.phase).toBe("releasing");
    expect(value.release(active)).toBe(first);
    await expect(first).resolves.toEqual({ status: "suspended", scope: "test-scope" });
    expect(releaseNative).toHaveBeenCalledOnce();
    expect(released).toHaveBeenCalledOnce();
    expect(value.phase).toBe("closed");
    expect(await ended(value)).toBe(true);
    // Released resources stay released.
    await expect(value.release(active)).resolves.toEqual({
      status: "suspended",
      scope: "test-scope",
    });
  });

  it("keeps the Session open and usable when the release fails", async () => {
    const releaseNative = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("group still alive"))
      .mockResolvedValue(undefined);
    const { value } = kernel({ releaseNative });
    await expect(value.release(active)).resolves.toEqual({
      status: "releaseFailed",
      reason: "Test Session release failed: group still alive",
    });
    expect(value.phase).toBe("open");
    expect(await ended(value)).toBe(false);
    await expect(value.release(active)).resolves.toMatchObject({ status: "suspended" });
  });

  it("faults a Session whose release cannot be partly undone", async () => {
    const published: unknown[] = [];
    const releaseNative = vi.fn(async () => {
      throw new Error("server stopped, transport still open");
    });
    const { value } = kernel({
      releaseNative,
      releaseFailure: "fault",
      publishReleaseFault: (error) => {
        published.push(error);
        value.channel.emit({
          kind: "event",
          event: {
            type: "session.faulted",
            error: { code: "internalError", message: "cleanup failed", retryable: false },
          },
        });
      },
    });
    await expect(value.release(active)).resolves.toEqual({
      status: "releaseFailed",
      reason: "Test Session release failed: server stopped, transport still open",
    });
    expect(published).toHaveLength(1);
    expect(value.phase).toBe("faulted");
    const iterator = value.channel.outputs[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { event: { type: "session.faulted" } },
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    // A faulted Session is not released again.
    await expect(value.release(active)).resolves.toMatchObject({ status: "unknown" });
    expect(releaseNative).toHaveBeenCalledOnce();
  });

  it("leaves a failed release that a close raced to the close, even when it would fault", async () => {
    let fail!: (error: Error) => void;
    const publishReleaseFault = vi.fn();
    const { value } = kernel({
      releaseNative: () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
      releaseFailure: "fault",
      publishReleaseFault,
    });
    const attempt = value.release(active);
    const closed = value.close(async () => undefined);
    fail(new Error("release failed"));
    await expect(attempt).resolves.toMatchObject({ status: "releaseFailed" });
    await closed;
    expect(publishReleaseFault).not.toHaveBeenCalled();
    expect(value.phase).toBe("closed");
  });

  it("re-admits after an asynchronous idle confirmation", async () => {
    let confirm!: () => void;
    const handle = kernel({
      confirmIdle: () =>
        new Promise((resolve) => {
          confirm = () => resolve(null);
        }),
    });
    const attempt = handle.value.release(active);
    // Nothing is released while the native side is asked.
    expect(handle.value.phase).toBe("open");
    handle.setWork({ level: "busy", reason: "a Turn started meanwhile" });
    confirm();
    await expect(attempt).resolves.toEqual({
      status: "busy",
      reason: "a Turn started meanwhile",
    });
    expect(handle.releaseNative).not.toHaveBeenCalled();
    expect(handle.value.phase).toBe("open");
  });

  it("lets a close that races a release own the end of outputs", async () => {
    let finish!: () => void;
    const { value, released } = kernel({
      releaseNative: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    const attempt = value.release(active);
    const closed = value.close(async () => undefined);
    expect(value.phase).toBe("closing");
    finish();
    await expect(attempt).resolves.toMatchObject({ status: "suspended" });
    await closed;
    expect(value.phase).toBe("closed");
    expect(released).toHaveBeenCalledOnce();
    expect(await ended(value)).toBe(true);
  });
});

describe("HarnessSessionKernel close and fault", () => {
  it("shares one close, and lets a failed close be retried before outputs end", async () => {
    const { value } = kernel();
    const closeNative = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("transport close failed"))
      .mockResolvedValue(undefined);
    const first = value.close(closeNative);
    expect(value.close(closeNative)).toBe(first);
    await expect(first).rejects.toThrow("transport close failed");
    expect(value.phase).toBe("closing");
    expect(await ended(value)).toBe(false);
    await value.close(closeNative);
    expect(closeNative).toHaveBeenCalledTimes(2);
    expect(value.phase).toBe("closed");
    expect(await ended(value)).toBe(true);
    await value.close(closeNative);
    expect(closeNative).toHaveBeenCalledTimes(2);
  });

  it("ends a Session whose final close failed, and keeps reporting that failure", async () => {
    const { value } = kernel({ closeFailure: "final" });
    const closeNative = vi.fn(async () => {
      throw new Error("process group remains");
    });
    await expect(value.close(closeNative)).rejects.toThrow("process group remains");
    expect(value.phase).toBe("closed");
    expect(await ended(value)).toBe(true);
    await expect(value.close(closeNative)).rejects.toThrow("process group remains");
    expect(closeNative).toHaveBeenCalledOnce();
  });

  it("reports a release through a final close that failed as ended", async () => {
    const handle = kernel({ closeFailure: "final" });
    const closeNative = async () => {
      throw new Error("process group remains");
    };
    handle.releaseNative.mockImplementation(() => handle.value.close(closeNative));
    await expect(handle.value.release(active)).resolves.toMatchObject({ status: "releaseFailed" });
    expect(handle.value.phase).toBe("closed");
    expect(await ended(handle.value)).toBe(true);
  });

  it("publishes a fault while outputs are open, then ends them", async () => {
    const { value } = kernel();
    const published: string[] = [];
    expect(
      value.fault(() => {
        value.channel.emit({
          kind: "event",
          event: {
            type: "session.faulted",
            error: { code: "processExited", message: "gone", retryable: false },
          },
        });
        published.push("fault");
      }),
    ).toBe(true);
    expect(published).toEqual(["fault"]);
    expect(value.phase).toBe("faulted");
    const iterator = value.channel.outputs[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    // Only an open Session faults.
    expect(value.fault(() => published.push("again"))).toBe(false);
    expect(published).toEqual(["fault"]);
  });
});
