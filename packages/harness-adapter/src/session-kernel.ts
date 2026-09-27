import { HarnessOutputChannel } from "./output-channel.js";
import type {
  HarnessIdleSuspendResult,
  HarnessIdleSuspendSignal,
  HarnessOutput,
  HarnessResourceLifecycle,
  HarnessWorkLevel,
} from "./text-session.js";

/**
 * - `open`: accepts work.
 * - `releasing`: an idle release was admitted; nothing new may start, and a
 *   failed release returns the Session to `open`.
 * - `closing` / `closed`: closed by the Host, or released for good.
 * - `faulted`: the native side failed; outputs ended.
 */
export type HarnessSessionPhase = "open" | "releasing" | "closing" | "closed" | "faulted";

/** A release declined before anything was touched. */
type Declined = { status: "busy" | "unknown"; reason: string };

export interface HarnessSessionKernelHooks {
  /** Names the Session in the reasons the Host logs, for example "Grok Session". */
  readonly label: string;
  /** What `suspended` reports as released, for example "grok-acp-session". */
  readonly scope: string;
  /** Native work that forbids a release now. Synchronous and side-effect free. */
  workLevel(): HarnessWorkLevel;
  /** Why a release cannot be decided now (for example nothing persisted yet), or null. */
  undecided?(): string | null;
  /**
   * Confirms with the native side that it is idle, when local state cannot
   * tell. Null means idle; anything else declines the release untouched.
   */
  confirmIdle?(signal: HarnessIdleSuspendSignal): Promise<Declined | null>;
  /** Gives the native resources back. Throwing keeps them owned: `releaseFailed`. */
  releaseNative(): Promise<void>;
  /** After a confirmed release, once outputs ended. */
  released?(): void;
  /**
   * What a failed native close leaves. `retry` (the default): the Session
   * stays closing with outputs open, and a later close tries again. `final`:
   * the Session is closed, outputs end, and every close reports that failure.
   */
  readonly closeFailure?: "retry" | "final";
}

/**
 * The lifecycle core every Session shares: its phase, its output channel, and
 * an idle release with one set of semantics. Admission and the phase change
 * happen before the first await, so no late native event can publish after
 * the Host was told the Session released.
 */
export class HarnessSessionKernel {
  readonly channel = new HarnessOutputChannel<HarnessOutput>();
  readonly resourceLifecycle: HarnessResourceLifecycle;
  readonly #hooks: HarnessSessionKernelHooks;
  #phase: HarnessSessionPhase = "open";
  // An attempt in flight, or the one that released: those resources stay
  // released. A declined or failed attempt clears it for the next one.
  #release: Promise<HarnessIdleSuspendResult> | null = null;
  #close: Promise<void> | null = null;

  constructor(hooks: HarnessSessionKernelHooks) {
    this.#hooks = hooks;
    this.resourceLifecycle = {
      suspend: (signal) => this.release(signal),
      workLevel: () => (this.#phase === "open" ? hooks.workLevel() : { level: "idle" }),
    };
  }

  get phase(): HarnessSessionPhase {
    return this.#phase;
  }

  get open(): boolean {
    return this.#phase === "open";
  }

  release(signal: HarnessIdleSuspendSignal): Promise<HarnessIdleSuspendResult> {
    if (this.#release) return this.#release;
    const declined = this.#admission(signal);
    if (declined) return Promise.resolve(declined);
    const attempt = this.#attemptRelease(signal);
    this.#release = attempt;
    void attempt.then((result) => {
      if (result.status !== "suspended" && this.#release === attempt) this.#release = null;
    });
    return attempt;
  }

  /**
   * Closes the Session: marks it closing, runs `closeNative`, then ends
   * outputs. Concurrent calls share one close; a failure follows
   * `closeFailure`. A faulted Session still closes its native side.
   */
  close(closeNative: () => Promise<void>): Promise<void> {
    if (this.#close) return this.#close;
    if (this.#phase === "closed") return Promise.resolve();
    this.#phase = "closing";
    const final = this.#hooks.closeFailure === "final";
    const closing = (async () => {
      try {
        await closeNative();
      } catch (error) {
        if (final) this.#end();
        throw error;
      }
      this.#end();
    })();
    this.#close = closing;
    if (!final) {
      void closing.catch(() => {
        if (this.#close === closing) this.#close = null;
      });
    }
    return closing;
  }

  /**
   * Faults an open Session: `publish` runs while outputs are still open (to
   * finish the active Turn and report the fault), then outputs end. Returns
   * false, doing nothing, when the Session is no longer open.
   */
  fault(publish: () => void): boolean {
    if (this.#phase !== "open") return false;
    this.#phase = "faulted";
    try {
      publish();
    } finally {
      this.channel.end();
    }
    return true;
  }

  #end(): void {
    this.#phase = "closed";
    this.channel.end();
  }

  #admission(signal: HarnessIdleSuspendSignal): Declined | null {
    const label = this.#hooks.label;
    if (signal.aborted) return { status: "unknown", reason: `${label} idle release was aborted` };
    if (this.#phase !== "open") {
      return { status: "unknown", reason: `${label} is ${this.#phase}` };
    }
    const work = this.#hooks.workLevel();
    if (work.level === "busy") return { status: "busy", reason: work.reason };
    const undecided = this.#hooks.undecided?.();
    return undecided ? { status: "unknown", reason: undecided } : null;
  }

  async #attemptRelease(signal: HarnessIdleSuspendSignal): Promise<HarnessIdleSuspendResult> {
    if (this.#hooks.confirmIdle) {
      const declined = await this.#hooks.confirmIdle(signal);
      if (declined) return declined;
      // The native check awaited: everything local may have moved meanwhile.
      const moved = this.#admission(signal);
      if (moved) return moved;
    }
    this.#phase = "releasing";
    try {
      await this.#hooks.releaseNative();
    } catch (error) {
      // The resources stay owned and the Session usable; the Host retries.
      if (this.#phase === "releasing") this.#phase = "open";
      return {
        status: "releaseFailed",
        reason: `${this.#hooks.label} release failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    // A close that raced the release already ended outputs.
    if (this.#phase === "releasing") {
      this.#phase = "closed";
      this.channel.end();
    }
    this.#hooks.released?.();
    return { status: "suspended", scope: this.#hooks.scope };
  }
}
