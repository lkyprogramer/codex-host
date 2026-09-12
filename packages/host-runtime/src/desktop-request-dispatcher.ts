/** Preserve per-Thread request order without blocking the shared Desktop transport. */
export class DesktopRequestDispatcher {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #pending = new Set<Promise<void>>();

  dispatch(
    key: string | undefined,
    run: () => Promise<void>,
    failed: (error: unknown) => Promise<void>,
  ): void {
    const previous = key ? this.#tails.get(key) : undefined;
    const pending = (previous?.catch(() => undefined) ?? Promise.resolve()).then(run).catch(failed);
    if (key) this.#tails.set(key, pending);
    this.#pending.add(pending);
    void pending
      .finally(() => {
        this.#pending.delete(pending);
        if (key && this.#tails.get(key) === pending) this.#tails.delete(key);
      })
      .catch(() => undefined);
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.#pending);
  }
}
