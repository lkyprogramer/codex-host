import { harnessIdSchema } from "@codexhost/shared-contracts";
import { expect, it, vi } from "vitest";

import { validateOpenedHarnessSession } from "../src/harness-session-validation.js";

it("returns the validation failure when malformed Session cleanup never settles", async () => {
  const cleanupFailed = vi.fn();
  const result = await validateOpenedHarnessSession(
    harnessIdSchema.parse("pi"),
    {
      harnessId: "pi",
      close: () => new Promise<void>(() => undefined),
    },
    { closeTimeoutMs: 5, onCleanupFailure: cleanupFailed },
  );

  expect(result).toMatchObject({ ok: false, error: { code: "protocolError" } });
  expect(cleanupFailed).toHaveBeenCalledOnce();
});

it.each([false, true])("reports rejected cleanup once (after timeout: %s)", async (late) => {
  const cleanupFailed = vi.fn();
  let rejectClose: ((error: Error) => void) | undefined;
  const close = late
    ? new Promise<void>((_resolve, reject) => {
        rejectClose = reject;
      })
    : Promise.reject(new Error("synthetic cleanup failure"));
  const result = await validateOpenedHarnessSession(
    harnessIdSchema.parse("pi"),
    { harnessId: "pi", close: () => close },
    { closeTimeoutMs: 5, onCleanupFailure: cleanupFailed },
  );
  rejectClose?.(new Error("late synthetic cleanup failure"));
  await Promise.resolve();
  expect(result).toMatchObject({ ok: false, error: { code: "protocolError" } });
  expect(cleanupFailed).toHaveBeenCalledOnce();
});
