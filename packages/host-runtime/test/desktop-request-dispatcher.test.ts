import { expect, it, vi } from "vitest";
import { DesktopRequestDispatcher } from "../src/desktop-request-dispatcher.js";

it("preserves same-Thread order while other Threads and control requests proceed", async () => {
  const dispatcher = new DesktopRequestDispatcher();
  const gate = Promise.withResolvers<undefined>();
  const calls: string[] = [];
  const failed = vi.fn(async () => undefined);
  dispatcher.dispatch(
    "one",
    async () => {
      calls.push("one-read");
      await gate.promise;
    },
    failed,
  );
  dispatcher.dispatch(
    "one",
    async () => {
      calls.push("one-write");
    },
    failed,
  );
  dispatcher.dispatch(
    "two",
    async () => {
      calls.push("two-read");
    },
    failed,
  );
  dispatcher.dispatch(
    undefined,
    async () => {
      calls.push("interrupt");
    },
    failed,
  );
  await vi.waitFor(() => expect(calls).toEqual(["one-read", "two-read", "interrupt"]));
  gate.resolve(undefined);
  await dispatcher.drain();
  expect(calls.at(-1)).toBe("one-write");
  expect(failed).not.toHaveBeenCalled();
});

it("does not strand a Thread after a failed request or failure reply", async () => {
  const dispatcher = new DesktopRequestDispatcher();
  const next = vi.fn(async () => undefined);
  const failed = vi.fn(async () => {
    throw new Error("reply failed");
  });
  dispatcher.dispatch(
    "one",
    async () => {
      throw new Error("read failed");
    },
    failed,
  );
  dispatcher.dispatch("one", next, failed);
  await dispatcher.drain();
  expect(failed).toHaveBeenCalledTimes(1);
  expect(next).toHaveBeenCalledTimes(1);
});
