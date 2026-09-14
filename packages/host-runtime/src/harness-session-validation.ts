import {
  validateHarnessSession,
  type HarnessResult,
  type HarnessSession,
} from "@codexhost/harness-adapter";
import type { HarnessId } from "@codexhost/shared-contracts";

/** The plugin result is untrusted until its public Session contract is checked. */
export async function validateOpenedHarnessSession(
  expectedHarnessId: HarnessId,
  value: unknown,
  options: {
    closeTimeoutMs?: number;
    onCleanupFailure?: () => void;
  } = {},
): Promise<HarnessResult<HarnessSession>> {
  const validated = validateHarnessSession(expectedHarnessId, value);
  if (validated.ok) return validated;
  await closeRejectedHarnessSession(value, options);
  return validated;
}

async function closeRejectedHarnessSession(
  value: unknown,
  options: { closeTimeoutMs?: number; onCleanupFailure?: () => void },
): Promise<void> {
  try {
    if (
      typeof value === "object" &&
      value !== null &&
      "close" in value &&
      typeof (value as { close?: unknown }).close === "function"
    ) {
      const close = Promise.resolve().then(() => (value as { close(): Promise<unknown> }).close());
      const timeoutMs = options.closeTimeoutMs ?? 1_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        close.then(
          () => false,
          () => true,
        ),
        new Promise<true>((resolve) => {
          timer = setTimeout(() => resolve(true), timeoutMs);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (!timedOut) return;
      options.onCleanupFailure?.();
    }
  } catch {
    // A malformed plugin Session must never block provisional mapping cleanup.
    options.onCleanupFailure?.();
  }
}
