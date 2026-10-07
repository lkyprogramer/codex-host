import type { JsonRpcRequest } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { DesktopReplyGuards } from "../src/desktop-reply-guard.js";

const request = (id: number): JsonRpcRequest => ({ id, method: "codexhost/test", params: {} });

function guards() {
  const failures: Array<{ id: unknown; message: string; answered: boolean }> = [];
  const value = new DesktopReplyGuards(async (failed, error, answered) => {
    failures.push({
      id: failed.id,
      message: error instanceof Error ? error.message : String(error),
      answered,
    });
  });
  return { value, failures };
}

describe("Desktop reply guards", () => {
  it("answers a failed request that nobody answered", async () => {
    const { value, failures } = guards();
    await value.run(request(1), async () => {
      throw new Error("handler failed");
    });
    expect(failures).toEqual([{ id: 1, message: "handler failed", answered: false }]);
  });

  it("reports a failure after an answer without answering again", async () => {
    const { value, failures } = guards();
    await value.run(request(2), async () => {
      value.noteWritten({ id: 2, result: {} });
      throw new Error("failed after answering");
    });
    expect(failures).toEqual([{ id: 2, message: "failed after answering", answered: true }]);
  });

  it("treats a request handed to native Codex as answered", async () => {
    const { value, failures } = guards();
    await value.run(request(3), async () => {
      value.markAnswered(3);
      throw new Error("failed after forwarding");
    });
    expect(failures).toEqual([{ id: 3, message: "failed after forwarding", answered: true }]);
  });

  it("does not count notifications, Host requests or other IDs as answers", async () => {
    const { value, failures } = guards();
    await value.run(request(4), async () => {
      value.noteWritten({ method: "thread/started", params: { id: 4 } });
      value.noteWritten({ id: 4, method: "item/permissions/requestApproval", params: {} });
      value.noteWritten({ id: 5, result: {} });
      throw new Error("still unanswered");
    });
    expect(failures).toEqual([{ id: 4, message: "still unanswered", answered: false }]);
  });

  it("keeps a guard for detached work after its handler returned", async () => {
    const { value, failures } = guards();
    let detached: Promise<void> | undefined;
    let fail!: (error: Error) => void;
    await value.run(request(6), async () => {
      // The handler returns at once; the detached work answers later or fails.
      detached = value.run(
        request(6),
        () =>
          new Promise<void>((_resolve, reject) => {
            fail = reject;
          }),
      );
    });
    expect(failures).toEqual([]);
    fail(new Error("detached work failed"));
    await detached;
    expect(failures).toEqual([{ id: 6, message: "detached work failed", answered: false }]);
  });

  it("marks every open guard of a request answered", async () => {
    const { value, failures } = guards();
    let outerFail!: (error: Error) => void;
    const outer = value.run(
      request(7),
      () =>
        new Promise<void>((_resolve, reject) => {
          outerFail = reject;
        }),
    );
    await value.run(request(7), async () => {
      value.noteWritten({ id: 7, error: { code: -32602, message: "answered" } });
    });
    outerFail(new Error("outer failed"));
    await outer;
    expect(failures).toEqual([{ id: 7, message: "outer failed", answered: true }]);
  });

  it("forgets a finished request, so a later request with its ID starts unanswered", async () => {
    const { value, failures } = guards();
    await value.run(request(8), async () => {
      value.noteWritten({ id: 8, result: {} });
    });
    // An answer for a request no guard covers marks nothing.
    value.markAnswered(8);
    const failed = vi.fn(async () => {
      throw new Error("reused ID failed");
    });
    await value.run(request(8), failed);
    expect(failures).toEqual([{ id: 8, message: "reused ID failed", answered: false }]);
  });
});
