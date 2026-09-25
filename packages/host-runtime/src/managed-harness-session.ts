import { HarnessOutputChannel } from "@codexhost/harness-adapter";

import { awaitWithSignal } from "./abortable-read.js";

import type {
  HarnessCommandCapability,
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
import type { HarnessId } from "@codexhost/shared-contracts";

type SessionOperation<T> = (session: HarnessSession) => Promise<T>;

/**
 * How long one queued Harness operation (a read, a command, a resume, an idle
 * suspension) may take. Every operation shares one queue, so an adapter that
 * never answers would otherwise block every later operation, close included.
 */
export const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;

interface PumpCompletion {
  promise: Promise<Error | null>;
  resolve(error: Error | null): void;
}

function incompatible(message: string): Error {
  return new Error(`Resumed Harness Session is incompatible: ${message}`);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
  if (
    result.status !== "suspended" &&
    result.status !== "busy" &&
    result.status !== "unknown" &&
    result.status !== "unsupported"
  ) {
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

export class ManagedHarnessSession {
  readonly harnessId: HarnessId;
  readonly initialUsage;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #resume: (options?: ResumeOptions) => Promise<HarnessSession>;
  readonly #onActivity: () => void;
  readonly #onFault: (error: Error) => void;
  readonly #outputEndTimeoutMs: number;
  readonly #operationTimeoutMs: number;
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
    return this.#current.resourceLifecycle
      ? { suspend: (signal) => this.#suspend(signal) }
      : undefined;
  }

  /** Native process was released; the next Host read or execute must resume it. */
  get nativeSuspended(): boolean {
    return this.#suspended !== null;
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
    return this.#use((session) => session.execute(command as TurnStartCommand));
  }

  /**
   * Resolves once the native Session confirmed its release, however long that
   * takes: callers that must not start a second native process for the same
   * Session wait on it. Callers with a budget bound their own wait.
   */
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#admissionClosed = true;
    this.#closePromise = this.#enqueue(async () => {
      try {
        await this.#current.close();
      } finally {
        this.#pumpCompletions.clear();
        this.#pendingPumpEnds.clear();
        this.#suspendedOutputs.clear();
        this.#channel.end();
      }
    }, null);
    return this.#closePromise;
  }

  /** Internal Host lease for legacy destructive release hooks. It never wakes a suspended Session. */
  withCurrentSession<T>(operation: (session: HarnessSession) => Promise<T>): Promise<T> {
    return this.#enqueue(async () => {
      this.#assertOpen();
      if (this.#suspended) throw new Error("Managed Harness Session is suspended");
      return operation(this.#current);
    });
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
        result = await lifecycle.suspend(signal);
      } catch (error) {
        this.#suspendingGeneration = null;
        this.#flushSuspendedOutputs(generation);
        this.#fail(error instanceof Error ? error : new Error(String(error)));
        return { status: "unknown", reason: "Native idle suspension failed" };
      }
      if (!validSuspendResult(result)) {
        this.#suspendingGeneration = null;
        this.#flushSuspendedOutputs(generation);
        this.#fail(new Error("Harness returned an invalid idle suspension result"));
        return { status: "unknown", reason: "Native idle suspension result is invalid" };
      }
      if (result.status === "suspended") {
        const activity = this.#flushSuspendedOutputs(generation);
        if (activity || this.#admissionClosed) {
          this.#suspendingGeneration = null;
          this.#fail(new Error("Native activity was observed during idle suspension"));
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
          this.#fail(new Error("Native idle suspension did not end its output stream"));
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
          this.#fail(new Error("Native activity was observed during idle suspension"));
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
    });
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
        this.#fail(failure);
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
        this.#fail(failure);
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
      this.#fail(failure);
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
    if (!sameJson(session.capabilities, this.#initialCapabilities)) {
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

  #fail(error: Error): void {
    if (this.#admissionClosed) return;
    this.#admissionClosed = true;
    this.#onFault(error);
    this.#channel.emit({
      kind: "event",
      event: {
        type: "session.faulted",
        error: { code: "processExited", message: error.message, retryable: true },
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
        this.#fail(error);
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
