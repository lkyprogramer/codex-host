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
  /** Where each Turn is in its grammar: started, then completed, once each. */
  readonly #turns = new Map<string, "started" | "completed">();

  constructor(session: HarnessSession) {
    void this.#collect(session);
  }

  async #collect(session: HarnessSession) {
    try {
      for await (const output of session.outputs) {
        this.outputs.push(output);
        if (this.#closeRequested) this.#protocolFailure ??= "output received after close";
        const violation = this.#turnGrammar(output);
        if (violation) this.#protocolFailure ??= violation;
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

  /**
   * A Turn starts once, carries items and interactions only while started,
   * and completes once; nothing of it may follow its terminal event.
   */
  #turnGrammar(output: HarnessOutput): string | undefined {
    if (output.kind === "interaction") {
      return this.#turns.get(output.interaction.turnId) === "started"
        ? undefined
        : "interaction outside its Turn";
    }
    const event = output.event;
    switch (event.type) {
      case "turn.started":
      case "turn.autonomous.started":
        if (this.#turns.has(event.turnId)) return "Turn started twice";
        this.#turns.set(event.turnId, "started");
        return undefined;
      case "item.started":
      case "item.updated":
      case "item.completed":
      case "interaction.closed":
        return this.#turns.get(event.turnId) === "started" ? undefined : "item outside its Turn";
      case "turn.completed": {
        const state = this.#turns.get(event.turnId);
        this.#turns.set(event.turnId, "completed");
        // A second terminal is reported as a duplicate below.
        return state === undefined ? "terminal event before its Turn started" : undefined;
      }
      default:
        return undefined;
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
