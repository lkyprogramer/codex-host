import { HarnessOutputChannel } from "@codexhost/harness-adapter";

import { awaitWithSignal } from "./abortable-read.js";

import type {
  HarnessCommandCapability,
  HarnessErrorCode,
  HarnessIdleSuspendResult,
  HarnessIdleSuspendSignal,
  HarnessOutput,
  HarnessResourceLifecycle,
  HarnessResult,
  HarnessSession,
  HarnessSessionCapabilities,
  HarnessSessionState,
  HarnessSteeringControl,
  HarnessWorkMode,
  HarnessWorkModeControl,
  HostThreadSnapshot,
  InteractionRespondAccepted,
  InteractionRespondCommand,
  ModelSelectCompleted,
  ModelSelectCommand,
  PermissionModeSelectCompleted,
  PermissionModeSelectCommand,
  ThinkingSelectCompleted,
  ThinkingSelectCommand,
  TurnCancelAccepted,
  TurnCancelCommand,
  TurnStartAccepted,
  TurnStartCommand,
} from "@codexhost/harness-adapter";
import type { HarnessId, LoadedSessionResourceState } from "@codexhost/shared-contracts";

type SessionOperation<T> = (session: HarnessSession) => Promise<T>;

/**
 * How long one queued Harness operation (a read, a command, a resume, an idle
 * suspension) may take. Every operation shares one queue, so an adapter that
 * never answers would otherwise block every later operation, close included.
 */
export const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
/**
 * An idle suspension or an owned-job stop releases native processes and may
 * wait out a Harness's own cleanup grace, which is 2-3 s for every shipped
 * adapter (the anchor waits up to twice that plus a few seconds). The bound
 * is still short: every later operation, a user's wake included, queues
 * behind a release that hangs.
 */
export const DEFAULT_RELEASE_TIMEOUT_MS = 5 * 60_000;

/**
 * Delays before retrying a native close that failed. Adapters keep what they
 * could not release owned and retry it on the next close, so a transient
 * failure (a process slow to exit) usually clears on a later attempt.
 */
export const DEFAULT_CLOSE_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000];

const SUSPEND_STATUSES = new Set(["suspended", "busy", "unknown", "releaseFailed", "unsupported"]);

/**
 * A plugin built against a newer contract may report a status this Host does
 * not know. Treating it as `unknown` (nothing decided, retry later) keeps the
 * Session instead of faulting it over a vocabulary mismatch.
 */
function knownSuspendResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const status = (value as { status?: unknown }).status;
  if (typeof status !== "string" || SUSPEND_STATUSES.has(status)) return value;
  return {
    status: "unknown",
    reason: `Harness reported an unrecognised suspension status '${status}'`,
  };
}

interface PumpCompletion {
  promise: Promise<Error | null>;
  resolve(error: Error | null): void;
}

/** A resumed native Session that does not match the one it replaces. */
class ResumeIncompatibleError extends Error {
  override name = "ResumeIncompatibleError";
}

function incompatible(message: string): Error {
  return new ResumeIncompatibleError(`Resumed Harness Session is incompatible: ${message}`);
}

/** Why a resume failed: a mismatch is the adapter's state, not its process. */
function resumeFailureCode(error: Error): HarnessErrorCode {
  return error instanceof ResumeIncompatibleError ? "invalidState" : "nativeFailure";
}

/**
 * Structural equality of JSON-like values. Key order does not matter, unlike
 * comparing JSON.stringify output: two equal capability objects built in a
 * different order are the same capabilities.
 */
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null)
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
    );
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const otherKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  return (
    keys.length === otherKeys.length &&
    keys.every(
      (key) => Object.hasOwn(rightRecord, key) && sameValue(leftRecord[key], rightRecord[key]),
    )
  );
}

function sameNativeSessionIdentity(
  left: HarnessSessionState["nativeRef"],
  right: HarnessSessionState["nativeRef"],
): boolean {
  if (!left || !right) return left === right;
  return (
    left.harnessId === right.harnessId &&
    left.nativeSessionId === right.nativeSessionId &&
    left.formatVersion === right.formatVersion
  );
}

function unavailable<T>(message: string): HarnessResult<T> {
  return {
    ok: false,
    error: { code: "unavailable", message, retryable: true },
  };
}

function validSuspendResult(value: unknown): value is HarnessIdleSuspendResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as { status?: unknown; scope?: unknown; reason?: unknown };
  if (typeof result.status !== "string" || !SUSPEND_STATUSES.has(result.status)) {
    return false;
  }
  if (result.status === "suspended" && (typeof result.scope !== "string" || !result.scope.trim())) {
    return false;
  }
  return result.reason === undefined || typeof result.reason === "string";
}

/**
 * Keeps the Host-facing Session and its output consumer alive while an adapter
 * releases a resumable native process. Every Host operation is serialized with
 * suspension, so a wake cannot race an incomplete native cleanup.
 */
/** historyOnly resumes a suspended history-only Session without native execution. */
export interface ResumeOptions {
  skipSnapshot?: boolean;
  historyOnly?: boolean;
}

export class ManagedHarnessSession implements HarnessSession {
  readonly harnessId: HarnessId;
  readonly initialUsage;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #resume: (options?: ResumeOptions) => Promise<HarnessSession>;
  readonly #onActivity: () => void;
  readonly #onFault: (error: Error) => void;
  readonly #outputEndTimeoutMs: number;
  readonly #operationTimeoutMs: number;
  readonly #releaseTimeoutMs: number;
  readonly #closeRetryDelaysMs: readonly number[];
  readonly #initialCapabilities: HarnessSessionCapabilities;
  readonly #requiresResourceLifecycle: boolean;
  #admissionClosed = false;
  #closePromise: Promise<void> | null = null;
  #current: HarnessSession;
  #generation = 0;
  #lastState: HarnessSessionState;
  #operationTail: Promise<void> = Promise.resolve();
  #pendingPumpEnds = new Map<number, Error | null>();
  #pumpCompletions = new Map<number, PumpCompletion>();
  #suspendedOutputs = new Map<number, HarnessOutput[]>();
  #suspended: Extract<HarnessIdleSuspendResult, { status: "suspended" }> | null = null;
  #suspendingGeneration: number | null = null;
  #deferredLive: boolean;

  constructor(input: {
    session: HarnessSession;
    resume(options?: ResumeOptions): Promise<HarnessSession>;
    onActivity(): void;
    onFault(error: Error): void;
    outputEndTimeoutMs?: number;
    operationTimeoutMs?: number;
    releaseTimeoutMs?: number;
    closeRetryDelaysMs?: readonly number[];
  }) {
    this.harnessId = input.session.harnessId;
    this.initialUsage = input.session.initialUsage;
    this.#current = input.session;
    this.#lastState = input.session.initialState;
    this.#initialCapabilities = input.session.capabilities;
    this.#requiresResourceLifecycle = input.session.resourceLifecycle !== undefined;
    this.#resume = input.resume;
    this.#onActivity = input.onActivity;
    this.#onFault = input.onFault;
    this.#outputEndTimeoutMs = input.outputEndTimeoutMs ?? 5_000;
    this.#operationTimeoutMs = input.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    this.#releaseTimeoutMs = input.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
    this.#closeRetryDelaysMs = input.closeRetryDelaysMs ?? DEFAULT_CLOSE_RETRY_DELAYS_MS;
    this.#deferredLive = input.session.executionReady === false;
    this.outputs = this.#channel.outputs;
    this.#attach(input.session);
  }

  get capabilities(): HarnessSessionCapabilities {
    return this.#current.capabilities;
  }

  get initialState(): HarnessSessionState {
    return this.#lastState;
  }

  get commands(): HarnessCommandCapability | undefined {
    if (!this.#current.commands) return undefined;
    return {
      list: () => this.#useCommand((commands) => commands.list()),
      execute: (command) => this.#useCommand((commands) => commands.execute(command)),
    };
  }

  get workMode(): HarnessWorkModeControl | undefined {
    if (!this.#current.workMode) return undefined;
    const currentWorkMode = (): HarnessWorkMode | null => this.#current.workMode?.current ?? null;
    return {
      get current(): HarnessWorkMode | null {
        return currentWorkMode();
      },
      set: (mode) => this.#useWorkMode(mode),
    };
  }

  get steering(): HarnessSteeringControl | undefined {
    if (!this.#current.steering) return undefined;
    return {
      interject: (input) =>
        this.#use((session) => {
          const steering = session.steering;
          return steering
            ? steering.interject(input)
            : Promise.resolve(unavailable("External Harness no longer exposes native steering"));
        }),
    };
  }

  get resourceLifecycle(): HarnessResourceLifecycle | undefined {
    const lifecycle = this.#current.resourceLifecycle;
    if (!lifecycle) return undefined;
    return {
      suspend: (signal) => this.#suspend(signal),
      ...(lifecycle.workLevel
        ? {
            // A suspended Session runs nothing native until it resumes.
            workLevel: () =>
              this.#suspended
                ? { level: "idle" as const }
                : (this.#current.resourceLifecycle?.workLevel?.() ?? { level: "idle" as const }),
          }
        : {}),
      ...(lifecycle.stopOwnedJobs
        ? {
            // Never wakes a suspended Session only to stop its jobs.
            stopOwnedJobs: () =>
              this.withCurrentSession(async (current) => {
                const stop = current.resourceLifecycle?.stopOwnedJobs;
                if (!stop) throw new Error("Harness Session no longer stops owned jobs");
                return stop.call(current.resourceLifecycle);
              }),
          }
        : {}),
    };
  }

  /** Native process was released; the next Host read or execute must resume it. */
  get nativeSuspended(): boolean {
    return this.#suspended !== null;
  }

  /** Cached lifecycle facts only; observing never resumes or probes native resources. */
  get resourceState(): LoadedSessionResourceState {
    if (this.#admissionClosed) return "unavailable";
    if (this.#suspended) return "suspended";
    if (this.#suspendingGeneration !== null) return "suspending";
    return this.#deferredLive ? "historyOnly" : "loaded";
  }

  refreshUsage(): Promise<void> {
    return this.#read(async (session) => {
      await session.refreshUsage?.();
    });
  }

  readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    return this.#read(async (session) => {
      const result = await session.readSnapshot();
      if (result.ok && result.value.state) this.#observeState(result.value.state);
      return result;
    });
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  execute(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>>;
  execute(
    command:
      | TurnStartCommand
      | TurnCancelCommand
      | InteractionRespondCommand
      | ModelSelectCommand
      | ThinkingSelectCommand
      | PermissionModeSelectCommand,
  ): Promise<
    HarnessResult<
      | TurnStartAccepted
      | TurnCancelAccepted
      | InteractionRespondAccepted
      | ModelSelectCompleted
      | ThinkingSelectCompleted
      | PermissionModeSelectCompleted
    >
  > {
    if (command.type === "turn.cancel") return this.#cancel(command);
    return this.#use((session) => session.execute(command as TurnStartCommand));
  }

  /**
   * A cancellation skips the operation queue: waiting behind a slow read or
   * a configuration write would defeat its purpose. It goes to the current
   * native Session directly; a suspended or resuming Session has no running
   * Turn, so there is nothing for it to race.
   */
  async #cancel(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    this.#onActivity();
    if (this.#admissionClosed) {
      return {
        ok: false,
        error: {
          code: "invalidState",
          message: "Managed Harness Session is closed",
          retryable: false,
        },
      };
    }
    if (this.#suspended) {
      return {
        ok: false,
        error: {
          code: "invalidState",
          message: "No Turn is running in a suspended Harness Session",
          retryable: false,
        },
      };
    }
    return this.#current.execute(command);
  }

  /**
   * Resolves once the native Session confirmed its release, however long that
   * takes: callers that must not start a second native process for the same
   * Session wait on it. Callers with a budget bound their own wait. A failed
   * close is retried in the background on DEFAULT_CLOSE_RETRY_DELAYS_MS, each
   * failure reported; the promise rejects only when every attempt failed.
   * Outputs end after the first attempt, as before.
   */
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#admissionClosed = true;
    this.#closePromise = this.#enqueue(async () => {
      let failure: unknown;
      try {
        await this.#current.close();
        return;
      } catch (error) {
        failure = error;
      } finally {
        this.#pumpCompletions.clear();
        this.#pendingPumpEnds.clear();
        this.#suspendedOutputs.clear();
        this.#channel.end();
      }
      await this.#retryClose(failure);
    }, null);
    return this.#closePromise;
  }

  async #retryClose(failure: unknown): Promise<void> {
    let last = failure;
    for (const delay of this.#closeRetryDelaysMs) {
      const message = last instanceof Error ? last.message : String(last);
      this.#onFault(
        new Error(`Closing the native Session failed; retrying in ${delay} ms: ${message}`, {
          cause: last,
        }),
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delay).unref?.();
      });
      try {
        await this.#current.close();
        return;
      } catch (error) {
        last = error;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  /** Internal Host lease on the current native Session. It never wakes a suspended Session. */
  withCurrentSession<T>(operation: (session: HarnessSession) => Promise<T>): Promise<T> {
    return this.#enqueue(async () => {
      this.#assertOpen();
      if (this.#suspended) throw new Error("Managed Harness Session is suspended");
      return operation(this.#current);
    }, this.#releaseTimeoutMs);
  }

  /** Checks a candidate before Host persistence observes a resumed native Session. */
  validateResumedSession(session: HarnessSession): void {
    this.#validateResume(session);
  }

  /** Preserves a confirmed native state when resume needed an explicit Host read. */
  updateObservedState(state: HarnessSessionState): void {
    this.#observeState(state);
  }

  async #read<T>(operation: SessionOperation<T>): Promise<T> {
    this.#onActivity();
    return this.#enqueue(async () => {
      this.#assertOpen();
      // A read never upgrades a history-only Session to live; after suspension it
      // resumes with the same readiness so history stays local and cheap.
      const session = this.#deferredLive
        ? this.#suspended
          ? await this.#resumeIfNeeded({ historyOnly: true })
          : this.#current
        : await this.#resumeIfNeeded();
      return operation(session);
    });
  }

  async #use<T>(operation: SessionOperation<T>): Promise<T> {
    this.#onActivity();
    return this.#enqueue(async () => {
      this.#assertOpen();
      const session = await this.#resumeIfNeeded();
      return operation(session);
    });
  }

  async #useCommand<T>(operation: (commands: HarnessCommandCapability) => Promise<T>): Promise<T> {
    return this.#use((session) => {
      const commands = session.commands;
      return commands
        ? operation(commands)
        : Promise.resolve(unavailable("External Harness no longer exposes commands") as T);
    });
  }

  async #useWorkMode(mode: HarnessWorkMode): Promise<HarnessResult<void>> {
    return this.#use((session) => {
      const workMode = session.workMode;
      return workMode
        ? workMode.set(mode)
        : Promise.resolve(unavailable("Planning mode is unavailable for this Harness"));
    });
  }

  async #suspend(signal: HarnessIdleSuspendSignal): Promise<HarnessIdleSuspendResult> {
    return this.#enqueue(async () => {
      if (this.#admissionClosed) return { status: "unknown", reason: "Host Session is closed" };
      if (this.#suspended) return this.#suspended;
      if (signal.aborted) return { status: "unknown", reason: "Idle suspension was aborted" };
      const session = this.#current;
      const lifecycle = session.resourceLifecycle;
      if (!lifecycle) return { status: "unsupported" };
      const generation = this.#generation;
      const pump = this.#pumpCompletions.get(generation);
      if (!pump) return { status: "unknown", reason: "Harness output pump is unavailable" };
      this.#suspendingGeneration = generation;
      let result: HarnessIdleSuspendResult;
      try {
        // Do not race this call with the AbortSignal. The adapter sees cancellation
        // and the following wake remains queued until native cleanup settles.
        result = knownSuspendResult(await lifecycle.suspend(signal)) as HarnessIdleSuspendResult;
      } catch (error) {
        this.#suspendingGeneration = null;
        this.#flushSuspendedOutputs(generation);
        this.#fail(error instanceof Error ? error : new Error(String(error)), "nativeFailure");
        return { status: "unknown", reason: "Native idle suspension failed" };
      }
      if (!validSuspendResult(result)) {
        this.#suspendingGeneration = null;
        this.#flushSuspendedOutputs(generation);
        this.#fail(
          new Error("Harness returned an invalid idle suspension result"),
          "protocolError",
        );
        return { status: "unknown", reason: "Native idle suspension result is invalid" };
      }
      if (result.status === "suspended") {
        const activity = this.#flushSuspendedOutputs(generation);
        if (activity || this.#admissionClosed) {
          this.#suspendingGeneration = null;
          this.#fail(
            new Error("Native activity was observed during idle suspension"),
            "invalidState",
          );
          return { status: "unknown", reason: "Native activity was observed during suspension" };
        }
        // A successful lifecycle contract must end its old native output stream.
        // Do not wake the Session until that promise settles; otherwise an old
        // Server could publish late events into the resumed generation.
        let pumpFailure: Error | null;
        try {
          // A timeout faults this proxy and closes admission. It never permits
          // a queued wake to overtake an unfinished output generation.
          pumpFailure = await awaitWithSignal(
            pump.promise,
            AbortSignal.timeout(this.#outputEndTimeoutMs),
          );
        } catch {
          this.#suspendingGeneration = null;
          this.#pumpCompletions.delete(generation);
          this.#flushSuspendedOutputs(generation);
          this.#fail(
            new Error("Native idle suspension did not end its output stream"),
            "protocolError",
          );
          return { status: "unknown", reason: "Native output did not end after suspension" };
        }
        this.#suspendingGeneration = null;
        this.#pumpCompletions.delete(generation);
        const lateActivity = this.#flushSuspendedOutputs(generation);
        if (pumpFailure) {
          this.#fail(pumpFailure);
          return { status: "unknown", reason: "Native output ended with a failure" };
        }
        if (lateActivity || this.#admissionClosed) {
          this.#fail(
            new Error("Native activity was observed during idle suspension"),
            "invalidState",
          );
          return { status: "unknown", reason: "Native activity was observed during suspension" };
        }
        this.#suspended = result;
        this.#pendingPumpEnds.delete(generation);
        return result;
      }
      this.#suspendingGeneration = null;
      this.#flushSuspendedOutputs(generation);
      const ended = this.#pendingPumpEnds.get(generation);
      this.#pendingPumpEnds.delete(generation);
      if (ended !== undefined) {
        this.#fail(ended ?? new Error("External Harness output ended during rejected suspension"));
      }
      return result;
    }, this.#releaseTimeoutMs);
  }

  async #resumeIfNeeded(options?: { historyOnly?: boolean }): Promise<HarnessSession> {
    if (this.#deferredLive && !options?.historyOnly) {
      const previous = this.#current;
      const previousGeneration = this.#generation;
      this.#generation += 1;
      this.#pumpCompletions.delete(previousGeneration);
      this.#pendingPumpEnds.delete(previousGeneration);
      this.#suspendedOutputs.delete(previousGeneration);
      this.#deferredLive = false;
      this.#suspended = null;
      try {
        await previous.close();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.#fail(failure, resumeFailureCode(failure));
        throw failure;
      }
      let resumed: HarnessSession | undefined;
      try {
        resumed = await this.#resume({ skipSnapshot: true });
        this.#assertStillOpenAfterResume();
        this.#validateResume(resumed);
      } catch (error) {
        await resumed?.close().catch(() => undefined);
        const failure = error instanceof Error ? error : new Error(String(error));
        this.#fail(failure, resumeFailureCode(failure));
        throw failure;
      }
      this.#attach(resumed);
      return resumed;
    }
    if (!this.#suspended) return this.#current;
    let resumed: HarnessSession | undefined;
    try {
      resumed = await this.#resume(options?.historyOnly ? { historyOnly: true } : undefined);
      this.#assertStillOpenAfterResume();
      this.#validateResume(resumed);
    } catch (error) {
      await resumed?.close().catch(() => undefined);
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#fail(failure, resumeFailureCode(failure));
      throw failure;
    }
    this.#suspended = null;
    this.#deferredLive = resumed.executionReady === false;
    this.#attach(resumed);
    return resumed;
  }

  /**
   * A resume that outlived its deadline finishes after the Session faulted
   * and closed. Its new native Session must be closed, not attached: nothing
   * would ever close it otherwise.
   */
  #assertStillOpenAfterResume(): void {
    if (this.#admissionClosed) {
      throw new Error("Managed Harness Session closed while the native Session was resuming");
    }
  }

  #validateResume(session: HarnessSession): void {
    if (session.harnessId !== this.harnessId) throw incompatible("Harness identity changed");
    if (!sameValue(session.capabilities, this.#initialCapabilities)) {
      throw incompatible("capabilities changed");
    }
    const expectedNativeRef = this.#lastState.nativeRef;
    if (
      expectedNativeRef &&
      !sameNativeSessionIdentity(session.initialState.nativeRef, expectedNativeRef)
    ) {
      throw incompatible("native Session identity changed");
    }
    if (this.#requiresResourceLifecycle && !session.resourceLifecycle) {
      throw incompatible("native resource lifecycle is unavailable");
    }
    if (Boolean(session.commands) !== Boolean(this.#current.commands)) {
      throw incompatible("command capability changed");
    }
    if (Boolean(session.steering) !== Boolean(this.#current.steering)) {
      throw incompatible("native steering capability changed");
    }
    const previousWorkMode = this.#current.workMode;
    const resumedWorkMode = session.workMode;
    if (Boolean(previousWorkMode) !== Boolean(resumedWorkMode)) {
      throw incompatible("work mode capability changed");
    }
    if (
      previousWorkMode &&
      resumedWorkMode &&
      previousWorkMode.current !== resumedWorkMode.current
    ) {
      throw incompatible("work mode changed");
    }
  }

  #observeState(state: HarnessSessionState): void {
    this.#lastState = {
      ...state,
      ...(!state.nativeRef && this.#lastState.nativeRef
        ? { nativeRef: this.#lastState.nativeRef }
        : {}),
    };
  }

  #attach(session: HarnessSession): void {
    this.#current = session;
    const generation = ++this.#generation;
    let resolve!: (error: Error | null) => void;
    const promise = new Promise<Error | null>((done) => {
      resolve = done;
    });
    this.#pumpCompletions.set(generation, { promise, resolve });
    void this.#relay(session, generation);
  }

  async #relay(session: HarnessSession, generation: number): Promise<void> {
    let failure: Error | null = null;
    try {
      for await (const output of session.outputs) {
        if (this.#admissionClosed || generation !== this.#generation) {
          continue;
        }
        if (this.#suspendingGeneration === generation) {
          const buffered = this.#suspendedOutputs.get(generation) ?? [];
          buffered.push(output);
          this.#suspendedOutputs.set(generation, buffered);
          continue;
        }
        this.#forwardOutput(output);
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    this.#pumpCompletions.get(generation)?.resolve(failure);
    if (this.#admissionClosed || generation !== this.#generation) return;
    if (this.#suspendingGeneration === generation) {
      this.#pendingPumpEnds.set(generation, failure);
      return;
    }
    if (this.#suspended) return;
    this.#fail(failure ?? new Error("External Harness output ended before a terminal event"));
  }

  /**
   * Faults the Session. `code` says why: the native process was lost (the
   * default, when its output ended), it did not answer in time, it broke the
   * protocol, or its state no longer matched.
   */
  #fail(error: Error, code: HarnessErrorCode = "processExited"): void {
    if (this.#admissionClosed) return;
    this.#admissionClosed = true;
    this.#onFault(error);
    this.#channel.emit({
      kind: "event",
      event: {
        type: "session.faulted",
        error: { code, message: error.message, retryable: true },
      },
    });
    this.#channel.end();
    this.#pumpCompletions.clear();
    this.#pendingPumpEnds.clear();
    this.#suspendedOutputs.clear();
    void this.close().catch((cleanupError) => {
      this.#onFault(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
    });
  }

  #flushSuspendedOutputs(generation: number): boolean {
    const outputs = this.#suspendedOutputs.get(generation) ?? [];
    this.#suspendedOutputs.delete(generation);
    let activity = false;
    for (const output of outputs) {
      activity ||= this.#isNativeActivity(output);
      this.#forwardOutput(output);
      if (this.#admissionClosed) break;
    }
    return activity;
  }

  #isNativeActivity(output: HarnessOutput): boolean {
    return (
      output.kind === "interaction" ||
      (output.event.type !== "session.state.changed" &&
        output.event.type !== "session.usage.changed")
    );
  }

  #forwardOutput(output: HarnessOutput): void {
    if (output.kind === "event" && output.event.type === "session.state.changed") {
      this.#observeState(output.event.state);
    }
    this.#channel.emit(output);
    if (output.kind === "event" && output.event.type === "session.faulted") {
      this.#admissionClosed = true;
      void this.close().catch((cleanupError) => {
        this.#onFault(
          cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
        );
      });
    }
  }

  #assertOpen(): void {
    if (this.#admissionClosed) throw new Error("Managed Harness Session is closed");
  }

  /**
   * Runs `operation` after every earlier one. With a timeout, an operation
   * that does not settle in time faults the Session and frees the queue; its
   * late result is ignored, and the fault's close runs next.
   */
  #enqueue<T>(
    operation: () => Promise<T>,
    timeoutMs: number | null = this.#operationTimeoutMs,
  ): Promise<T> {
    const run = () => (timeoutMs === null ? operation() : this.#bounded(operation, timeoutMs));
    const pending = this.#operationTail.then(run, run);
    this.#operationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  #bounded<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`External Harness did not answer within ${timeoutMs} ms`);
        reject(error);
        this.#fail(error, "unavailable");
      }, timeoutMs);
      // Started synchronously, like an unbounded operation: callers that
      // fire and forget observe the adapter call at the same point.
      let started: Promise<T>;
      try {
        started = operation();
      } catch (error) {
        started = Promise.reject(error as Error);
      }
      started.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}
