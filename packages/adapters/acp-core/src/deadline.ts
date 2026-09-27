/**
 * Races `promise` against a deadline. `timedOut` builds the rejection, in the
 * caller's own error type, and may act on the timeout first (for example
 * retire a connection whose native state is now unknown).
 */
export function withDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
  timedOut: () => Error,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(timedOut()), milliseconds);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}
