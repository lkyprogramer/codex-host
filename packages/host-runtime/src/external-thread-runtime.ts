import { awaitWithSignal } from "./abortable-read.js";
import { validateOpenedHarnessSession } from "./harness-session-validation.js";
import { ManagedHarnessSession, type ResumeOptions } from "./managed-harness-session.js";
import { randomUUID } from "node:crypto";

import type {
  HarnessAdapter,
  HarnessModelRef,
  HarnessResult,
  HarnessSession,
  HarnessSessionState,
  HostThreadSnapshot,
  HostUsage,
  TurnCompletedEvent,
} from "@codexhost/harness-adapter";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  decodeExternalTransportSelection,
  encodeExternalTransportSelection,
  mapExternalThreadHarnessError,
  type CodexTurnProjector,
  type ExternalConfigurationSelection,
  type ExternalHarnessId,
  type ExternalThreadRpcError,
  type JsonObject,
} from "@codexhost/protocol-core";
import { HarnessOutputChannel } from "@codexhost/harness-adapter";
import {
  permissionModeFixedAtCreate,
  hostThreadIdSchema,
  type HarnessId,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  type HostInteractionId,
  type HostTurnId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import {
  externalThreadValue,
  type ExternalThreadRepository,
} from "./external-thread-repository.js";
import { DELEGATION_THREAD_ID_ENV } from "./delegation-types.js";
import { SessionStateObserver } from "./session-state-observer.js";
import { ThreadChangeHub } from "./thread-change-hub.js";

export interface TurnProjectionGate {
  promise: Promise<void>;
  resolve(): void;
}

export interface ExternalThread {
  id: StoredThreadRecordV1["hostThreadId"];
  cwd: string;
  harnessId: ExternalHarnessId;
  session: HarnessSession;
  outputTask: Promise<void>;
  requestedModel?: HarnessModelRef;
  requestedThinkingOptionId?: HarnessThinkingOptionId;
  requestedPermissionModeId?: HarnessPermissionModeId;
  record: StoredThreadRecordV1;
  sessionId: string;
  stateObserver: SessionStateObserver;
  thread: JsonObject;
  transportModelId: string;
  turns: JsonObject[];
  historyHydrated: boolean;
  running: boolean;
  activeTurnId: HostTurnId | null;
  latestUsage: HostUsage | null;
  usageTurnId: HostTurnId | null;
  projectedTurns: Map<HostTurnId, { projector: CodexTurnProjector; started?: true }>;
  responseGates: Map<HostTurnId, TurnProjectionGate>;
  ephemeralTurnIds: Set<HostTurnId>;
  persistenceError: Error | null;
  finalizing: boolean;
  ignoredInteractionIds: Set<HostInteractionId>;
  changes: ThreadChangeHub;
  attentionChanges: ThreadChangeHub;
}

export type ExternalThreadLocation =
  | { kind: "official" }
  | {
      kind: "external";
      record: StoredThreadRecordV1;
      thread: ExternalThread | null;
    }
  | { kind: "error"; error: ExternalThreadRpcError };

export type ExternalThreadResolution =
  | { kind: "official" }
  | { kind: "external"; thread: ExternalThread; historyFresh: boolean }
  | { kind: "error"; error: ExternalThreadRpcError };

function nativeTurnKey(turn: HostThreadSnapshot["turns"][number]): string {
  const ref = turn.nativeTurnRef;
  return `${ref.harnessId}\u0000${ref.nativeSessionId}\u0000${ref.nativeTurnKey}\u0000${ref.formatVersion}`;
}

function mergeReadonlySnapshot(
  previous: HostThreadSnapshot,
  next: HostThreadSnapshot,
): HostThreadSnapshot {
  const nextByTurn = new Map(next.turns.map((turn) => [nativeTurnKey(turn), turn] as const));
  const retainedKeys = new Set<string>();
  const turns = previous.turns.map((turn) => {
    const key = nativeTurnKey(turn);
    retainedKeys.add(key);
    const update = nextByTurn.get(key);
    if (!update) return turn;
    const itemsById = new Map(update.items.map((item) => [item.item.itemId, item] as const));
    const retainedItemIds = new Set<string>();
    const items = turn.items.map((item) => {
      retainedItemIds.add(item.item.itemId);
      return itemsById.get(item.item.itemId) ?? item;
    });
    for (const item of update.items) {
      if (!retainedItemIds.has(item.item.itemId)) items.push(item);
    }
    return {
      ...turn,
      ...update,
      input: update.input.length > 0 ? update.input : turn.input,
      items,
      ...((update.checkpoint ?? turn.checkpoint)
        ? { checkpoint: update.checkpoint ?? turn.checkpoint }
        : {}),
      ...((update.model ?? turn.model) ? { model: update.model ?? turn.model } : {}),
    };
  });
  for (const turn of next.turns) {
    if (!retainedKeys.has(nativeTurnKey(turn))) turns.push(turn);
  }
  return {
    turns,
    ...((next.state ?? previous.state) ? { state: next.state ?? previous.state } : {}),
  };
}

class ReadonlySnapshotSession implements HarnessSession {
  readonly capabilities = {
    configuration: {
      selectModel: false,
      selectThinkingOption: false,
      selectPermissionMode: false,
      permissionModeScope: "live" as const,
    },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
    subagents: { observe: false, readTranscript: false },
  };
  readonly initialState;
  readonly initialUsage = null;
  readonly outputs: AsyncIterable<never>;
  readonly #channel = new HarnessOutputChannel<never>();
  readonly #readSnapshot: () => Promise<HarnessResult<HostThreadSnapshot>>;
  #lastSnapshot: HostThreadSnapshot;

  constructor(
    readonly harnessId: HarnessId,
    nativeRef: NativeSessionRef,
    initialSnapshot: HostThreadSnapshot,
    readSnapshot: () => Promise<HarnessResult<HostThreadSnapshot>>,
  ) {
    this.initialState = { nativeRef };
    this.#lastSnapshot = initialSnapshot;
    this.#readSnapshot = readSnapshot;
    this.outputs = this.#channel.outputs;
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    const result = await this.#readSnapshot();
    if (!result.ok) return result;
    this.#lastSnapshot = mergeReadonlySnapshot(this.#lastSnapshot, result.value);
    return { ok: true, value: this.#lastSnapshot };
  }

  async execute(): Promise<never> {
    throw new Error("Readonly Subagent Thread cannot execute commands");
  }

  async close(): Promise<void> {
    this.#channel.end();
  }
}

class ExternalThreadOpenError extends Error {
  constructor(readonly rpcError: ExternalThreadRpcError) {
    super(rpcError.message);
    this.name = "ExternalThreadOpenError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const EXTERNAL_READ_TIMEOUT_MS = 10_000;
// Cold restore and post-suspend history resume spawn a native process. Cursor
// ACP authenticate + session/load commonly exceed the snapshot-refresh budget.
const EXTERNAL_RESTORE_TIMEOUT_MS = 60_000;
const DEFAULT_IDLE_SUSPEND_TIMEOUT_MS = 60_000;

interface IdleSuspendTimer {
  abort: AbortController;
  attempts: number;
  timer: ReturnType<typeof setTimeout>;
}

interface ResumedNativeSession {
  session: HarnessSession;
  record: StoredThreadRecordV1;
  turns: JsonObject[];
  state: HarnessSessionState;
  transportModelId: string;
}

export class ExternalThreadRuntime {
  readonly #refreshes = new Map<
    ExternalThread,
    {
      pending: Promise<ExternalThreadRpcError | null>;
      signal: AbortSignal;
      abort: AbortController;
    }
  >();
  readonly #adapters: Map<ExternalHarnessId, HarnessAdapter>;
  readonly #consumeOutputs: (thread: ExternalThread) => Promise<void>;
  readonly #diagnose: (error: unknown) => void;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #repository: ExternalThreadRepository;
  readonly #restores = new Map<string, Promise<ExternalThread>>();
  /** Threads whose previous Session is still closing; see `retire`. */
  readonly #retiring = new Map<string, Promise<void>>();
  readonly #threads = new Map<string, ExternalThread>();
  readonly #idleTimers = new Map<ExternalThread, IdleSuspendTimer>();
  readonly #idleUnknownReported = new Set<ExternalThread>();
  readonly #epoch: string;
  readonly #historyReadTimeoutMs: number;
  readonly #historyRestoreTimeoutMs: number;
  readonly #idleSuspendTimeoutMs: number;
  readonly #canSuspend: (thread: ExternalThread) => boolean;

  constructor(input: {
    adapters: Map<ExternalHarnessId, HarnessAdapter>;
    environment?: NodeJS.ProcessEnv;
    repository: ExternalThreadRepository;
    consumeOutputs(thread: ExternalThread): Promise<void>;
    diagnose(error: unknown): void;
    epoch?: string;
    historyReadTimeoutMs?: number;
    historyRestoreTimeoutMs?: number;
    idleSuspendTimeoutMs?: number;
    canSuspend?(thread: ExternalThread): boolean;
  }) {
    this.#adapters = input.adapters;
    this.#environment = input.environment ?? process.env;
    this.#repository = input.repository;
    this.#consumeOutputs = input.consumeOutputs;
    this.#diagnose = input.diagnose;
    this.#epoch = input.epoch ?? randomUUID();
    this.#historyReadTimeoutMs = input.historyReadTimeoutMs ?? EXTERNAL_READ_TIMEOUT_MS;
    this.#historyRestoreTimeoutMs = input.historyRestoreTimeoutMs ?? EXTERNAL_RESTORE_TIMEOUT_MS;
    this.#idleSuspendTimeoutMs = input.idleSuspendTimeoutMs ?? DEFAULT_IDLE_SUSPEND_TIMEOUT_MS;
    this.#canSuspend =
      input.canSuspend ??
      ((thread) =>
        !thread.running && thread.activeTurnId === null && thread.responseGates.size === 0);
  }

  get epoch(): string {
    return this.#epoch;
  }

  get(threadId: string): ExternalThread | undefined {
    return this.#threads.get(threadId);
  }

  values(): ExternalThread[] {
    return [...this.#threads.values()];
  }

  remove(threadId: string): void {
    const thread = this.#threads.get(threadId);
    if (thread) {
      this.#clearIdleTimer(thread);
      this.#idleUnknownReported.delete(thread);
    }
    this.#threads.delete(threadId);
  }

  /**
   * Removes `thread` and closes its Session. Until that close settles, a
   * restore of the same Thread waits for it: starting a second native process
   * for a Session whose first one may still run would let both write to it.
   * The returned promise is the close itself, for callers that report it.
   */
  retire(thread: ExternalThread): Promise<void> {
    if (this.#threads.get(thread.id) === thread) this.remove(thread.id);
    const closing = Promise.resolve().then(() => thread.session.close());
    const settled = closing.then(
      () => undefined,
      () => undefined,
    );
    const previous = this.#retiring.get(thread.id);
    const barrier: Promise<void> = (
      previous ? Promise.all([previous, settled]).then(() => undefined) : settled
    ).finally(() => {
      if (this.#retiring.get(thread.id) === barrier) this.#retiring.delete(thread.id);
    });
    this.#retiring.set(thread.id, barrier);
    return closing;
  }

  clear(): void {
    for (const refresh of this.#refreshes.values()) refresh.abort.abort();
    for (const thread of this.#idleTimers.keys()) this.#clearIdleTimer(thread);
    this.#refreshes.clear();
    this.#idleUnknownReported.clear();
    this.#threads.clear();
    this.#restores.clear();
  }

  register(input: {
    record: StoredThreadRecordV1;
    session: HarnessSession;
    sessionId: string;
    thread: JsonObject;
    turns: JsonObject[];
    requestedModel?: HarnessModelRef;
    requestedThinkingOptionId?: HarnessThinkingOptionId;
    requestedPermissionModeId?: HarnessPermissionModeId;
    transportModelId?: string;
    restoredState?: HarnessSessionState;
  }): ExternalThread {
    const harnessId = input.record.harnessId as ExternalHarnessId;
    if (!this.#adapters.has(harnessId)) {
      throw new Error(`External Harness '${input.record.harnessId}' is not registered`);
    }
    const initialState = input.restoredState ?? input.session.initialState;
    const effectiveModel = input.requestedModel ?? initialState.effectiveModel;
    const effectiveThinkingOptionId =
      input.requestedThinkingOptionId ?? initialState.effectiveThinkingOptionId;
    const effectivePermissionModeId =
      input.requestedPermissionModeId ?? initialState.effectivePermissionModeId;
    const observerState: HarnessSessionState = {
      ...initialState,
      ...(effectiveModel ? { effectiveModel } : {}),
      ...(effectiveThinkingOptionId ? { effectiveThinkingOptionId } : {}),
      ...(effectivePermissionModeId ? { effectivePermissionModeId } : {}),
    };
    const externalThread: ExternalThread = {
      id: input.record.hostThreadId,
      cwd: input.record.cwd,
      harnessId,
      session: input.session,
      outputTask: Promise.resolve(),
      ...(effectiveModel ? { requestedModel: effectiveModel } : {}),
      ...(effectiveThinkingOptionId
        ? { requestedThinkingOptionId: effectiveThinkingOptionId }
        : {}),
      ...(effectivePermissionModeId
        ? { requestedPermissionModeId: effectivePermissionModeId }
        : {}),
      record: input.record,
      sessionId: input.sessionId,
      stateObserver: new SessionStateObserver(observerState),
      thread: input.thread,
      transportModelId: input.transportModelId ?? input.record.transportModelId,
      turns: input.turns,
      historyHydrated: true,
      running: false,
      activeTurnId: null,
      latestUsage: input.session.initialUsage,
      usageTurnId: null,
      projectedTurns: new Map(),
      responseGates: new Map(),
      ephemeralTurnIds: new Set(),
      persistenceError: null,
      finalizing: false,
      ignoredInteractionIds: new Set(),
      changes: new ThreadChangeHub(this.#epoch),
      attentionChanges: new ThreadChangeHub(`${this.#epoch}:attention`),
    };
    externalThread.session = new ManagedHarnessSession({
      session: input.session,
      resume: (options) => this.#resumeSuspendedSession(externalThread, options),
      onActivity: () => this.#touchIdleTimer(externalThread),
      onFault: (error) => {
        this.#clearIdleTimer(externalThread);
        this.#diagnose(error);
      },
    }) as unknown as HarnessSession;
    externalThread.outputTask = this.#consumeOutputs(externalThread);
    this.#threads.set(externalThread.id, externalThread);
    this.#touchIdleTimer(externalThread);
    return externalThread;
  }

  markIdle(thread: ExternalThread): void {
    if (this.#threads.get(thread.id) !== thread) return;
    this.#touchIdleTimer(thread);
  }

  async replace(
    current: ExternalThread,
    input: {
      record: StoredThreadRecordV1;
      session: HarnessSession;
      sessionId: string;
      thread: JsonObject;
      turns: JsonObject[];
      restoredState?: HarnessSessionState;
    },
  ): Promise<ExternalThread> {
    if (
      current.running ||
      this.#threads.get(current.id) !== current ||
      input.record.hostThreadId !== current.id
    ) {
      throw new Error("External Thread runtime cannot replace an active or stale Session");
    }
    try {
      await current.session.close();
      await current.outputTask;
    } catch (error) {
      this.#diagnose(error);
      throw new Error("External Thread replacement could not close the current native Session", {
        cause: error,
      });
    }
    await this.#retireSubagents(current.id);
    this.remove(current.id);
    return this.register(input);
  }

  #clearIdleTimer(thread: ExternalThread): void {
    const idle = this.#idleTimers.get(thread);
    if (!idle) return;
    this.#idleTimers.delete(thread);
    clearTimeout(idle.timer);
    idle.abort.abort();
  }

  #touchIdleTimer(thread: ExternalThread): void {
    this.#clearIdleTimer(thread);
    this.#idleUnknownReported.delete(thread);
    this.#armIdleTimer(thread, 0);
  }

  #armIdleTimer(thread: ExternalThread, attempts: number): void {
    if (
      this.#threads.get(thread.id) !== thread ||
      !thread.session.resourceLifecycle ||
      !this.#canSuspend(thread)
    ) {
      return;
    }
    const abort = new AbortController();
    const delay = Math.min(this.#idleSuspendTimeoutMs * Math.max(1, 2 ** attempts), 5 * 60_000);
    const timer = setTimeout(() => {
      void this.#suspendWhenIdle(thread, abort);
    }, delay);
    timer.unref?.();
    this.#idleTimers.set(thread, { abort, attempts, timer });
  }

  async #suspendWhenIdle(thread: ExternalThread, abort: AbortController): Promise<void> {
    const idle = this.#idleTimers.get(thread);
    if (!idle || idle.abort !== abort) return;
    clearTimeout(idle.timer);
    if (
      abort.signal.aborted ||
      this.#threads.get(thread.id) !== thread ||
      !this.#canSuspend(thread)
    ) {
      this.#clearIdleTimer(thread);
      return;
    }
    const lifecycle = thread.session.resourceLifecycle;
    if (!lifecycle) {
      this.#clearIdleTimer(thread);
      return;
    }
    let result: Awaited<ReturnType<typeof lifecycle.suspend>> | undefined;
    try {
      // The managed Session serializes this call with all wake operations. Do
      // not race it with cancellation: a late native stop must settle first.
      result = await lifecycle.suspend(abort.signal);
    } catch (error) {
      this.#diagnose(error);
    } finally {
      if (this.#idleTimers.get(thread) === idle) this.#idleTimers.delete(thread);
    }
    if (result?.status === "releaseFailed") {
      // Unlike an undecided attempt, a failed release can leave native
      // processes running: report every one.
      this.#diagnose(
        `External Thread '${thread.id}' idle release failed${result.reason ? `: ${result.reason}` : ""}`,
      );
    }
    if (
      (result?.status === "busy" ||
        result?.status === "unknown" ||
        result?.status === "releaseFailed") &&
      !abort.signal.aborted &&
      this.#threads.get(thread.id) === thread &&
      this.#canSuspend(thread)
    ) {
      if (result.status === "unknown" && !this.#idleUnknownReported.has(thread)) {
        this.#idleUnknownReported.add(thread);
        this.#diagnose(
          `External Thread '${thread.id}' idle resource suspension is unknown; retrying`,
        );
      }
      this.#armIdleTimer(thread, result.status === "busy" ? 0 : idle.attempts + 1);
    }
  }

  async #retireSubagents(parentId: string): Promise<void> {
    const ancestors = new Map<string, Promise<StoredThreadRecordV1 | null>>();
    const descendant = async (record: StoredThreadRecordV1 | null): Promise<boolean> => {
      const visited = new Set<string>();
      let ownerId = record?.subagent?.parentHostThreadId;
      while (ownerId && !visited.has(ownerId)) {
        if (ownerId === parentId) return true;
        visited.add(ownerId);
        let ancestor = ancestors.get(ownerId);
        if (!ancestor) {
          ancestor = this.#repository.find(ownerId);
          ancestors.set(ownerId, ancestor);
        }
        ownerId = (await ancestor)?.subagent?.parentHostThreadId;
      }
      return false;
    };
    // A descendant may be open without its intermediate parent loaded. Follow
    // stored ancestry, including in-flight restores, not just loaded children.
    for (const [id, restoring] of [...this.#restores]) {
      if (await descendant(await this.#repository.find(id))) {
        await restoring.catch(this.#diagnose);
      }
    }
    for (const child of this.#threads.values()) {
      if (!(await descendant(child.record))) continue;
      try {
        await child.session.close();
        await child.outputTask;
      } catch (error) {
        this.#diagnose(error);
        throw new Error("External Subagent Session could not close during parent retirement", {
          cause: error,
        });
      }
      this.remove(child.id);
    }
  }

  async locate(threadId: string): Promise<ExternalThreadLocation> {
    const loaded = this.#threads.get(threadId);
    if (loaded) return { kind: "external", record: loaded.record, thread: loaded };
    let record: StoredThreadRecordV1 | null;
    try {
      record = await this.#repository.find(threadId);
    } catch {
      return {
        kind: "error",
        error: { code: -32081, message: "External Thread ownership could not be read" },
      };
    }
    if (!record) {
      const parsed = hostThreadIdSchema.safeParse(threadId);
      const delegation = parsed.success
        ? await this.#repository.getDelegationByChild(parsed.data)
        : null;
      if (delegation) {
        return {
          kind: "error",
          error: {
            code: -32079,
            message: "External Delegation exists but its Thread is not ready",
          },
        };
      }
      return { kind: "official" };
    }
    if (record.state !== "ready" || !record.nativeSessionRef) {
      return { kind: "external", record, thread: loaded ?? null };
    }
    return { kind: "external", record, thread: null };
  }

  async resolve(threadId: string): Promise<ExternalThreadResolution> {
    const location = await this.locate(threadId);
    if (location.kind !== "external") return location;
    if (location.thread) {
      return { kind: "external", thread: location.thread, historyFresh: false };
    }
    const { record } = location;
    if (record.state !== "ready" || !record.nativeSessionRef) {
      const delegation = await this.#repository.getDelegationByChild(record.hostThreadId);
      return {
        kind: "error",
        error: {
          code: -32079,
          message: delegation
            ? "External Delegation outcome is unknown; inspect or reconcile before retrying"
            : "External Native Session is unavailable",
        },
      };
    }
    let restoring = this.#restores.get(threadId);
    if (!restoring) {
      const restored = this.#threads.get(threadId);
      if (restored) return { kind: "external", thread: restored, historyFresh: false };
      const retiring = this.#retiring.get(threadId);
      restoring = (
        retiring ? retiring.then(() => this.#restore(record)) : this.#restore(record)
      ).finally(() => {
        this.#restores.delete(threadId);
      });
      this.#restores.set(threadId, restoring);
    }
    try {
      return {
        kind: "external",
        thread: await awaitWithSignal(
          restoring,
          AbortSignal.timeout(this.#historyRestoreTimeoutMs),
        ),
        historyFresh: true,
      };
    } catch (error) {
      return {
        kind: "error",
        error:
          error instanceof ExternalThreadOpenError
            ? error.rpcError
            : error instanceof Error && error.name === "TimeoutError"
              ? { code: -32081, message: "External Thread history read timed out" }
              : { code: -32076, message: "External Thread recovery failed" },
      };
    }
  }

  async refresh(thread: ExternalThread): Promise<ExternalThreadRpcError | null> {
    let refresh = this.#refreshes.get(thread);
    if (!refresh) {
      const abort = new AbortController();
      const resumeBudget =
        thread.session instanceof ManagedHarnessSession && thread.session.nativeSuspended
          ? this.#historyRestoreTimeoutMs
          : this.#historyReadTimeoutMs;
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(resumeBudget)]);
      const latestTurn = thread.turns.at(-1);
      const activeTurn = thread.activeTurnId;
      const current = () =>
        this.#threads.get(thread.id) === thread &&
        !thread.running &&
        thread.activeTurnId === activeTurn &&
        thread.turns.at(-1) === latestTurn;
      const pending = Promise.resolve()
        .then(async () => {
          const snapshot = await thread.session.readSnapshot();
          signal.throwIfAborted();
          if (!snapshot.ok) return mapExternalThreadHarnessError(snapshot.error, "read");
          if (!current()) return null;
          const aligned = await this.#repository.alignSnapshot(thread.record, snapshot.value);
          signal.throwIfAborted();
          if (!current()) return null;
          thread.record = aligned.record;
          thread.turns = aligned.turns;
          thread.historyHydrated = true;
          thread.thread = externalThreadValue({
            record: aligned.record,
            turns: aligned.turns,
            sessionId: thread.sessionId,
            running: thread.running,
          });
          return null;
        })
        .finally(() => this.#refreshes.delete(thread));
      refresh = { pending, signal, abort };
      this.#refreshes.set(thread, refresh);
    }
    try {
      // Keep one native read in flight even after timeout. Its late result cannot mutate history.
      return await awaitWithSignal(refresh.pending, refresh.signal);
    } catch (error) {
      return {
        code: -32081,
        message:
          error instanceof Error && error.name === "TimeoutError"
            ? "External Thread history read timed out"
            : "External Thread history could not be read",
      };
    }
  }

  async persistTerminalIdentity(
    thread: ExternalThread,
    event: TurnCompletedEvent,
  ): Promise<Error | null> {
    if (thread.persistenceError) return thread.persistenceError;
    if (!event.nativeTurnRef) {
      return event.outcome.status === "succeeded"
        ? new Error("Successful external Turn has no Native Turn identity")
        : null;
    }
    try {
      thread.record = await this.#repository.persistTurn(
        thread.record,
        event.turnId,
        event.nativeTurnRef,
        event.outcome.checkpoint,
      );
      return null;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(errorMessage(error));
      thread.persistenceError = failure;
      thread.stateObserver.fault(failure);
      this.#diagnose("External Turn identity could not be persisted");
      return failure;
    }
  }

  async #resumeSuspendedSession(
    thread: ExternalThread,
    options?: ResumeOptions,
  ): Promise<HarnessSession> {
    const record = await this.#repository.find(thread.id);
    if (
      !record ||
      record.state !== "ready" ||
      !record.nativeSessionRef ||
      record.subagent ||
      this.#threads.get(thread.id) !== thread
    ) {
      throw new Error("External Thread is no longer available for native Session resume");
    }
    const managed = thread.session;
    if (!(managed instanceof ManagedHarnessSession)) {
      throw new Error("External Thread does not retain a managed native Session");
    }
    const resumed = await this.#openResumedNativeSession(
      record,
      (session) => managed.validateResumedSession(session),
      {
        skipSnapshot: options?.skipSnapshot === true,
        ...(options?.historyOnly ? { historyOnly: true } : {}),
      },
    );
    if (this.#threads.get(thread.id) !== thread) {
      await resumed.session.close().catch(() => undefined);
      throw new Error("External Thread was removed while its native Session was resuming");
    }
    if (!options?.skipSnapshot) {
      thread.record = resumed.record;
      thread.turns = resumed.turns;
      thread.transportModelId = resumed.transportModelId;
      thread.historyHydrated = true;
      thread.thread = externalThreadValue({
        record: resumed.record,
        turns: resumed.turns,
        sessionId: thread.sessionId,
        running: thread.running,
      });
    }
    thread.stateObserver.update(resumed.state);
    managed.updateObservedState(resumed.state);
    if (resumed.state.effectiveModel) thread.requestedModel = resumed.state.effectiveModel;
    if (resumed.state.effectiveThinkingOptionId) {
      thread.requestedThinkingOptionId = resumed.state.effectiveThinkingOptionId;
    }
    if (resumed.state.effectivePermissionModeId) {
      thread.requestedPermissionModeId = resumed.state.effectivePermissionModeId;
    }
    return resumed.session;
  }

  async #openResumedNativeSession(
    record: StoredThreadRecordV1,
    validateResume?: (session: HarnessSession) => void,
    options?: { historyOnly?: boolean; skipSnapshot?: boolean },
  ): Promise<ResumedNativeSession> {
    const harnessId = record.harnessId as ExternalHarnessId;
    const adapter = this.#adapters.get(harnessId);
    if (!adapter || !record.nativeSessionRef) {
      throw new ExternalThreadOpenError({
        code: -32077,
        message: "External Harness is unavailable",
      });
    }
    const restoredSelection = decodeExternalTransportSelection(harnessId, record.transportModelId);
    const historyOnly = options?.historyOnly === true;
    const opened = await adapter.open({
      kind: "resume",
      cwd: record.cwd,
      environment: { ...this.#environment, [DELEGATION_THREAD_ID_ENV]: record.hostThreadId },
      nativeRef: record.nativeSessionRef as NativeSessionRef,
      knownTurnRefs: record.turnMappings.map(({ nativeTurnRef }) => nativeTurnRef),
      ...(historyOnly ? { historyOnly: true } : {}),
      ...(restoredSelection?.model ? { model: restoredSelection.model } : {}),
      ...(restoredSelection?.thinkingOptionId
        ? { thinkingOptionId: restoredSelection.thinkingOptionId }
        : {}),
      ...((record.executionPolicy || harnessId === "grok") && restoredSelection?.permissionModeId
        ? { permissionModeId: restoredSelection.permissionModeId }
        : {}),
      ...(record.executionPolicy ? { executionPolicy: record.executionPolicy } : {}),
    });
    if (!opened.ok) {
      throw new ExternalThreadOpenError(mapExternalThreadHarnessError(opened.error, "resume"));
    }
    const validated = await validateOpenedHarnessSession(record.harnessId, opened.value);
    if (!validated.ok) {
      throw new ExternalThreadOpenError(mapExternalThreadHarnessError(validated.error, "resume"));
    }
    const session = validated.value;
    try {
      validateResume?.(session);
      if (
        session.executionReady !== false &&
        restoredSelection?.permissionModeId &&
        session.initialState.effectivePermissionModeId !== restoredSelection.permissionModeId &&
        harnessId !== "opencode" &&
        !permissionModeFixedAtCreate(session.capabilities.configuration)
      ) {
        if (!session.capabilities.configuration.selectPermissionMode) {
          throw new ExternalThreadOpenError({
            code: -32076,
            message: "External Harness does not support restored Permission Mode selection",
          });
        }
        const selected = await session.execute({
          type: "permissionMode.select",
          permissionModeId: restoredSelection.permissionModeId,
        });
        if (!selected.ok) {
          throw new ExternalThreadOpenError(
            mapExternalThreadHarnessError(selected.error, "resume"),
          );
        }
      }
      if (options?.skipSnapshot) {
        const state = session.initialState;
        return {
          session,
          record,
          turns: [],
          state: {
            ...state,
            ...(restoredSelection?.model && !state.effectiveModel
              ? { effectiveModel: restoredSelection.model }
              : {}),
            ...(restoredSelection?.thinkingOptionId && !state.effectiveThinkingOptionId
              ? { effectiveThinkingOptionId: restoredSelection.thinkingOptionId }
              : {}),
            ...(restoredSelection?.permissionModeId && !state.effectivePermissionModeId
              ? { effectivePermissionModeId: restoredSelection.permissionModeId }
              : {}),
          },
          transportModelId: record.transportModelId,
        };
      }
      const snapshot = await session.readSnapshot();
      if (!snapshot.ok) {
        throw new ExternalThreadOpenError(mapExternalThreadHarnessError(snapshot.error, "read"));
      }
      let aligned = await this.#repository.alignSnapshot(record, snapshot.value);
      const restoredState = snapshot.value.state;
      const state = restoredState ?? session.initialState;
      const effectiveModel = restoredState
        ? restoredState.effectiveModel
        : restoredSelection?.model;
      const effectiveThinkingOptionId = restoredState
        ? restoredState.effectiveThinkingOptionId
        : restoredSelection?.thinkingOptionId;
      const effectivePermissionModeId = restoredState
        ? restoredState.effectivePermissionModeId
        : restoredSelection?.permissionModeId;
      let transportModelId = aligned.record.transportModelId;
      // OMP can silently replace an unavailable Model during resume, while OpenCode's
      // additive Permission API cannot reliably restore a stale mode. Persist live state so the
      // next restore does not reapply an obsolete transport token.
      if ((harnessId === "omp" || harnessId === "opencode") && effectiveModel) {
        const liveSelection: ExternalConfigurationSelection = {
          model: effectiveModel,
          ...(effectiveThinkingOptionId ? { thinkingOptionId: effectiveThinkingOptionId } : {}),
          ...(effectivePermissionModeId ? { permissionModeId: effectivePermissionModeId } : {}),
        };
        transportModelId = encodeExternalTransportSelection(harnessId, liveSelection);
        if (transportModelId !== aligned.record.transportModelId) {
          try {
            aligned = {
              ...aligned,
              record: await this.#repository.setTransportModelId(
                aligned.record.hostThreadId,
                transportModelId,
              ),
            };
          } catch (error) {
            this.#diagnose(error);
          }
        }
      }
      return {
        session,
        record: aligned.record,
        turns: aligned.turns,
        state: {
          ...state,
          ...(effectiveModel ? { effectiveModel } : {}),
          ...(effectiveThinkingOptionId ? { effectiveThinkingOptionId } : {}),
          ...(effectivePermissionModeId ? { effectivePermissionModeId } : {}),
        },
        transportModelId,
      };
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
  }

  async #restore(record: StoredThreadRecordV1): Promise<ExternalThread> {
    const harnessId = record.harnessId as ExternalHarnessId;
    const adapter = this.#adapters.get(harnessId);
    if (!adapter || !record.nativeSessionRef) {
      throw new ExternalThreadOpenError({
        code: -32077,
        message: "External Harness is unavailable",
      });
    }
    if (record.subagent) {
      const subagents = adapter.subagents;
      if (!subagents) {
        throw new ExternalThreadOpenError({
          code: -32077,
          message: "External Harness Subagent history is unavailable",
        });
      }
      const subagent = record.subagent;
      const parent = record.nativeSessionRef as NativeSessionRef;
      const snapshot = await subagents.readSnapshot({
        parent,
        nativeSubagentId: subagent.nativeSubagentId,
        cwd: record.cwd,
      });
      const latest = await this.#repository.find(record.hostThreadId);
      if (
        latest?.state === "ready" &&
        latest.nativeSessionRef &&
        JSON.stringify(latest.nativeSessionRef) !== JSON.stringify(parent)
      ) {
        return this.#restore(latest);
      }
      if (!snapshot.ok) {
        throw new ExternalThreadOpenError(mapExternalThreadHarnessError(snapshot.error, "read"));
      }
      const session = new ReadonlySnapshotSession(
        record.harnessId,
        record.nativeSessionRef as NativeSessionRef,
        snapshot.value,
        () =>
          subagents.readSnapshot({
            parent,
            nativeSubagentId: subagent.nativeSubagentId,
            cwd: record.cwd,
          }),
      );
      const aligned = await this.#repository.alignSnapshot(record, snapshot.value);
      const sessionId = await this.#repository.sessionTreeId(aligned.record);
      return this.register({
        record: aligned.record,
        session,
        sessionId,
        thread: externalThreadValue({ record: aligned.record, turns: aligned.turns, sessionId }),
        turns: aligned.turns,
        ...(snapshot.value.state ? { restoredState: snapshot.value.state } : {}),
      });
    }
    const resumed = await this.#openResumedNativeSession(record, undefined, { historyOnly: true });
    const sessionId = await this.#repository.sessionTreeId(resumed.record);
    return this.register({
      record: resumed.record,
      session: resumed.session,
      sessionId,
      thread: externalThreadValue({
        record: resumed.record,
        turns: resumed.turns,
        sessionId,
      }),
      turns: resumed.turns,
      ...(resumed.state.effectiveModel ? { requestedModel: resumed.state.effectiveModel } : {}),
      ...(resumed.state.effectiveThinkingOptionId
        ? { requestedThinkingOptionId: resumed.state.effectiveThinkingOptionId }
        : {}),
      ...(resumed.state.effectivePermissionModeId
        ? { requestedPermissionModeId: resumed.state.effectivePermissionModeId }
        : {}),
      restoredState: resumed.state,
      transportModelId: resumed.transportModelId,
    });
  }
}
