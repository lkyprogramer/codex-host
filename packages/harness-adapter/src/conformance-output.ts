import type { NativeSessionRef, NativeTurnRef } from "@codexhost/shared-contracts";

import type { HarnessOutput, HarnessSession, TurnOutcome } from "./text-session.js";

const timerRuntime = globalThis as typeof globalThis & {
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
};

function scheduleTimeout(callback: () => void, delayMs: number): unknown {
  if (!timerRuntime.setTimeout)
    throw new Error("Harness conformance requires a timer-capable runtime");
  return timerRuntime.setTimeout(callback, delayMs);
}

export interface ConformanceTerminalReadback {
  readonly outcome: TurnOutcome;
  readonly nativeTurnRef?: NativeTurnRef;
}

export class OutputCollector {
  readonly outputs: HarnessOutput[] = [];
  #ended = false;
  #closeRequested = false;
  #failure: unknown;
  #protocolFailure: string | undefined;
  readonly #terminals = new Map<string, number>();

  constructor(session: HarnessSession) {
    void this.#collect(session);
  }

  async #collect(session: HarnessSession) {
    try {
      for await (const output of session.outputs) {
        this.outputs.push(output);
        if (this.#closeRequested) this.#protocolFailure ??= "output received after close";
        if (output.kind === "event" && output.event.type === "turn.completed") {
          const count = (this.#terminals.get(output.event.turnId) ?? 0) + 1;
          this.#terminals.set(output.event.turnId, count);
          if (count > 1) this.#protocolFailure ??= "duplicate terminal event";
        }
      }
    } catch (error) {
      this.#failure = error;
    } finally {
      this.#ended = true;
    }
  }

  async terminal(turnId: string, timeoutMs: number): Promise<ConformanceTerminalReadback> {
    const terminal = await this.#waitFor(() => {
      const output = this.outputs.find(
        (candidate) =>
          candidate.kind === "event" &&
          candidate.event.type === "turn.completed" &&
          candidate.event.turnId === turnId,
      );
      if (!output || output.kind !== "event" || output.event.type !== "turn.completed")
        return undefined;
      return {
        outcome: output.event.outcome,
        ...(output.event.nativeTurnRef ? { nativeTurnRef: output.event.nativeTurnRef } : {}),
      };
    }, timeoutMs);
    await Promise.resolve();
    this.#assertHealthy();
    if ((this.#terminals.get(turnId) ?? 0) !== 1)
      throw new Error("expected exactly one terminal event for Host Turn");
    return terminal;
  }

  markCloseRequested() {
    this.#closeRequested = true;
  }

  async ended(timeoutMs: number): Promise<void> {
    await this.#waitFor(() => (this.#ended ? true : undefined), timeoutMs);
    this.#assertHealthy();
  }

  async started(turnId: string, timeoutMs: number): Promise<void> {
    await this.#waitFor(
      () =>
        this.outputs.some(
          (candidate) =>
            candidate.kind === "event" &&
            candidate.event.type === "turn.started" &&
            candidate.event.turnId === turnId,
        )
          ? true
          : undefined,
      timeoutMs,
    );
  }

  stateNativeRef(): NativeSessionRef | undefined {
    for (let index = this.outputs.length - 1; index >= 0; index--) {
      const output = this.outputs[index];
      if (output?.kind === "event" && output.event.type === "session.state.changed")
        return output.event.state.nativeRef;
    }
    return undefined;
  }

  #assertHealthy() {
    if (this.#failure) throw new Error("Harness output iteration failed");
    if (this.#protocolFailure) throw new Error(this.#protocolFailure);
  }

  async #waitFor<T>(read: () => T | undefined, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.#assertHealthy();
      const value = read();
      if (value !== undefined) return value;
      if (this.#ended) throw new Error("Harness output ended before the expected terminal event");
      await new Promise<void>((resolve) => scheduleTimeout(resolve, 5));
    }
    this.#assertHealthy();
    throw new Error("Timed out waiting for a Harness terminal event");
  }
}
