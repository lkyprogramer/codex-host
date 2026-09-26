import type {
  HarnessAdapter,
  HarnessResult,
  HarnessSession,
  OpenSessionInput,
} from "@codexhost/harness-adapter";

import { DEFAULT_OPERATION_TIMEOUT_MS } from "./managed-harness-session.js";

/**
 * Opens a Session within `timeoutMs`. An adapter that never answers would
 * otherwise hold the request (a Desktop `thread/start`, a delegation start)
 * forever. A Session that opens after the deadline is closed at once: nobody
 * holds it, so nothing else would ever release its native process.
 */
export async function openWithin(
  adapter: HarnessAdapter,
  input: OpenSessionInput,
  timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  onLateCloseFailure: (error: unknown) => void = () => undefined,
): Promise<HarnessResult<HarnessSession>> {
  let expired = false;
  let timer: NodeJS.Timeout | undefined;
  const opening = Promise.resolve().then(() => adapter.open(input));
  const deadline = new Promise<HarnessResult<HarnessSession>>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve({
        ok: false,
        error: {
          code: "unavailable",
          message: `External Harness did not open a Session within ${timeoutMs} ms`,
          retryable: true,
        },
      });
    }, timeoutMs);
  });
  void opening.then(
    (result) => {
      if (expired && result.ok) {
        void Promise.resolve()
          .then(() => result.value.close())
          .catch(onLateCloseFailure);
      }
    },
    () => undefined,
  );
  try {
    return await Promise.race([opening, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
