import type { JsonRpcRequest, JsonValue } from "@codexhost/shared-contracts";

/**
 * Makes a failed Desktop request handler still answer its request; otherwise Codex Desktop waits
 * for that reply forever. A request already answered, or handed to native Codex (which answers it
 * from then on), is left alone, so it is never answered twice.
 *
 * Each `run` keeps its own guard: work a handler detaches runs under a guard of its own, and an
 * answer marks every guard open for that request ID.
 */
export class DesktopReplyGuards {
  readonly #guards = new Map<unknown, Set<{ answered: boolean }>>();
  readonly #failed: (request: JsonRpcRequest, error: unknown, answered: boolean) => Promise<void>;

  /**
   * `failed` sees every handler failure; it must answer the request when `answered` is false,
   * and must not answer it again when it is true.
   */
  constructor(
    failed: (request: JsonRpcRequest, error: unknown, answered: boolean) => Promise<void>,
  ) {
    this.#failed = failed;
  }

  async run(request: JsonRpcRequest, work: () => Promise<void>): Promise<void> {
    const guard = { answered: false };
    let guards = this.#guards.get(request.id);
    if (!guards) {
      guards = new Set();
      this.#guards.set(request.id, guards);
    }
    guards.add(guard);
    try {
      await work();
    } catch (error) {
      await this.#failed(request, error, guard.answered);
    } finally {
      guards.delete(guard);
      if (guards.size === 0) this.#guards.delete(request.id);
    }
  }

  /** The request was answered, or handed to native Codex. */
  markAnswered(id: unknown): void {
    for (const guard of this.#guards.get(id) ?? []) guard.answered = true;
  }

  /** Notes a message written to Desktop: a response answers its request. */
  noteWritten(value: JsonValue): void {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      if ("id" in value && !("method" in value)) this.markAnswered(value.id);
    }
  }
}
