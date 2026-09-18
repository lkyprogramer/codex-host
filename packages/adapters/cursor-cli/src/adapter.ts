import path from "node:path";
import { cursorDiagnostic } from "./diagnostics.js";
import {
  HarnessOutputChannel,
  type HarnessAdapter,
  type HarnessError,
  type HarnessInspection,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionState,
  type HostCommand,
  type HostThreadSnapshot,
  type HarnessModelRef,
  type InspectHarnessInput,
  type OpenSessionInput,
  type TurnOutcome,
  type TurnStartCommand,
  type TurnStartAccepted,
  type TurnCancelCommand,
  type TurnCancelAccepted,
  type InteractionRespondCommand,
  type InteractionRespondAccepted,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type ThinkingSelectCommand,
  type ThinkingSelectCompleted,
  type PermissionModeSelectCommand,
  type PermissionModeSelectCompleted,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessPermissionModeIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import {
  CURSOR_CAPABILITIES,
  CURSOR_MODES,
  cursorCatalog,
  cursorModelRef,
  cursorNativeModel,
  cursorModels,
} from "./models.js";
import {
  CursorTransport,
  type CursorSessionInfo,
  type CursorTransportOptions,
} from "./transport.js";
import { readCursorNativeTurns, type CursorNativeTurn } from "./native-history.js";
import { CursorTurnOutput, cursorSnapshot } from "./projection.js";
import { CursorInteractions } from "./interactions.js";
import { type CursorSubagents, cursorTaskAddress } from "./subagents.js";
import type { HarnessSubagentCapability } from "@codexhost/harness-adapter";

export interface CursorAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
}
const EMPTY_CATALOG =
  /no parameterized models|no model catalog|no parameterized model directory|no model configuration/iu;
const READY_INSPECTION_CACHE_MS = 7 * 24 * 60 * 60_000;
const ERROR_INSPECTION_CACHE_MS = 5 * 60_000;

type CursorInspectionEntry = {
  close(): Promise<void>;
  expires: number;
  pending: boolean;
  result: Promise<HarnessInspection>;
};

// The model catalog is account-global and changes on a weekly cadence at most,
// while probing is expensive (full CLI startup plus remote metadata). Keep ready
// catalogs for a week; short error entries stay at five minutes so a failed
// login or install repair is noticed promptly. Explicit refresh always bypasses.
function inspectionCacheMs(inspection: HarnessInspection): number {
  if (inspection.status === "ready") return READY_INSPECTION_CACHE_MS;
  if (inspection.status === "notInstalled") return ERROR_INSPECTION_CACHE_MS;
  if (inspection.error.code === "authenticationRequired") return ERROR_INSPECTION_CACHE_MS;
  return 0;
}

export function isEmptyCursorCatalogError(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : error &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : cursorDiagnostic(error);
  return EMPTY_CATALOG.test(message);
}

export function cursorError(error: unknown): HarnessError {
  const message = cursorDiagnostic(error);
  const emptyCatalog = isEmptyCursorCatalogError(error) || EMPTY_CATALOG.test(message);
  const code = /not installed/iu.test(message)
    ? "notInstalled"
    : /not authenticated|authentication required|not logged in|login required|auth(?:entication)? (?:failed|expired)/iu.test(
          message,
        )
      ? "authenticationRequired"
      : /exited|closed/iu.test(message)
        ? "processExited"
        : "protocolError";
  return { code, message, retryable: emptyCatalog };
}
function rejected(code: HarnessError["code"], message: string): { ok: false; error: HarnessError } {
  return { ok: false, error: { code, message, retryable: false } };
}

async function openCursorCatalog(
  create: () => CursorTransport,
  sessionId?: string,
): Promise<{ transport: CursorTransport; info: CursorSessionInfo }> {
  const attempt = async (transport: CursorTransport) => {
    const info = await transport.open(sessionId);
    cursorCatalog(info);
    return { transport, info };
  };
  let transport = create();
  try {
    return await attempt(transport);
  } catch (error) {
    await transport.close().catch(() => undefined);
    if (!isEmptyCursorCatalogError(error)) throw error;
    transport = create();
    try {
      return await attempt(transport);
    } catch (retryError) {
      await transport.close().catch(() => undefined);
      throw retryError;
    }
  }
}
export class CursorAdapter implements HarnessAdapter {
  readonly subagents: HarnessSubagentCapability = {
    readSnapshot: async ({ parent, nativeSubagentId, cwd }) => {
      if (parent.harnessId !== this.harnessId || this.#closed)
        return rejected("invalidRequest", "Invalid Cursor parent");
      let replay: CursorTransport | undefined;
      try {
        cursorTaskAddress(nativeSubagentId);
        const session = [...this.#sessions].find(
          (s) => s.transport.sessionId === parent.nativeSessionId,
        );
        if (session && path.resolve(session.transport.options.cwd) !== path.resolve(cwd))
          return rejected("invalidRequest", "Cursor parent workspace does not match");
        const active = session?.subagentSnapshot(nativeSubagentId);
        if (active) return { ok: true, value: active };
        const options = session?.transport.options ?? this.transportOptions(cwd);
        const before = readCursorNativeTurns(parent.nativeSessionId, cwd, options.environment);
        replay = new CursorTransport(options);
        this.#ephemeralTransports.add(replay);
        await replay.open(parent.nativeSessionId, { historyOnly: true });
        const after = readCursorNativeTurns(parent.nativeSessionId, cwd, options.environment);
        if (JSON.stringify(before) !== JSON.stringify(after))
          throw new Error("Cursor native history changed during child read");
        return {
          ok: true,
          value: cursorSnapshot(parent.nativeSessionId, after, replay.replay, nativeSubagentId),
        };
      } catch (error) {
        return { ok: false, error: cursorError(error) };
      } finally {
        if (replay) {
          await replay.close();
          this.#ephemeralTransports.delete(replay);
        }
      }
    },
  };
  readonly harnessId = harnessIdSchema.parse("cursor-cli");
  readonly #sessions = new Set<CursorSession>();
  readonly #ephemeralTransports = new Set<CursorTransport>();
  readonly #openingTransports = new Set<CursorTransport>();
  /** Account-level catalog. cwd is only the ACP spawn directory, not a cache key. */
  #inspection: CursorInspectionEntry | undefined;
  #closed = false;
  #closePromise: Promise<void> | null = null;
  constructor(readonly options: CursorAdapterOptions = {}) {}
  transportOptions(cwd: string, environment?: NodeJS.ProcessEnv): CursorTransportOptions {
    return {
      cwd: path.resolve(cwd),
      environment: { ...(this.options.environment ?? process.env), ...environment },
      ...(this.options.command ? { command: this.options.command } : {}),
      ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
    };
  }
  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closed)
      return {
        status: "unavailable",
        error: { code: "unavailable", message: "Cursor adapter is closed", retryable: false },
      };
    const cached = this.#inspection;
    if (cached && (cached.pending || (!input.refresh && cached.expires > Date.now())))
      return cached.result;
    const probeCwd = path.resolve(input.cwd ?? process.cwd());
    const current = { transport: undefined as CursorTransport | undefined };
    const result = (async (): Promise<HarnessInspection> => {
      try {
        const opened = await openCursorCatalog(() => {
          current.transport = new CursorTransport(this.transportOptions(probeCwd));
          return current.transport;
        });
        current.transport = opened.transport;
        return {
          status: "ready",
          catalog: cursorCatalog(opened.info),
          capabilities: CURSOR_CAPABILITIES,
          permissionModes: CURSOR_MODES,
        };
      } catch (error) {
        const failure = cursorError(error);
        return {
          status: failure.code === "notInstalled" ? "notInstalled" : "unavailable",
          error: failure,
        };
      } finally {
        await current.transport?.close().catch(() => undefined);
      }
    })();
    const entry: CursorInspectionEntry = {
      close: () => current.transport?.close() ?? Promise.resolve(),
      expires: Number.POSITIVE_INFINITY,
      pending: true,
      result,
    };
    this.#inspection = entry;
    void result.then(
      (inspection) => {
        entry.pending = false;
        entry.expires = Date.now() + inspectionCacheMs(inspection);
      },
      () => {
        entry.pending = false;
        entry.expires = 0;
      },
    );
    return result;
  }
  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) return rejected("invalidState", "Cursor adapter is closed");
    if (input.kind !== "create" && input.kind !== "resume")
      return rejected("unsupported", "Cursor fork and rollback are not supported");
    if (input.thinkingOptionId)
      return rejected(
        "unsupported",
        "Cursor ACP exposes model variants, not an independent thinking selector",
      );
    if (input.kind === "resume" && input.nativeRef.harnessId !== this.harnessId)
      return rejected("invalidRequest", "Session belongs to another Harness");
    const options = {
      ...this.transportOptions(input.cwd, input.environment),
      // Native --force preserves explicit denies and team policy; never auto-answer callbacks.
      force:
        input.executionPolicy === "unattended-full-access" &&
        (!input.permissionModeId || input.permissionModeId === "agent"),
    };
    const historyOnly = input.kind === "resume" && input.historyOnly === true;
    let transport: CursorTransport | undefined;
    try {
      if (input.kind === "resume")
        readCursorNativeTurns(input.nativeRef.nativeSessionId, options.cwd, options.environment);
      const sessionId = input.kind === "resume" ? input.nativeRef.nativeSessionId : undefined;
      let info: CursorSessionInfo;
      if (historyOnly) {
        transport = new CursorTransport(options);
        this.#openingTransports.add(transport);
        info = await transport.open(sessionId, { historyOnly: true });
      } else {
        const opened = await openCursorCatalog(() => new CursorTransport(options), sessionId);
        transport = opened.transport;
        this.#openingTransports.add(transport);
        info = opened.info;
      }
      if (!transport) throw new Error("Cursor transport failed to open");
      if (!historyOnly && input.model) {
        let value: string;
        try {
          value = cursorNativeModel(info, input.model.id);
        } catch (error) {
          // The ref was offered from a cached catalog the live one no longer contains.
          this.#expireInspection();
          throw error;
        }
        const selected = await transport.configure("model", value);
        if (
          !selected.configOptions.some(
            (option) => option.id === "model" && option.currentValue === value,
          )
        ) {
          throw new Error("Cursor did not confirm requested model selection");
        }
        info = { ...info, configOptions: selected.configOptions };
      }
      const openedTransport = transport;
      const session = new CursorSession(
        openedTransport,
        info,
        () => {
          this.#sessions.delete(session);
        },
        input.kind === "create",
        historyOnly ? input.model : undefined,
      );
      if (input.kind === "resume") {
        const native = readCursorNativeTurns(
          openedTransport.sessionId,
          options.cwd,
          options.environment,
        );
        cursorSnapshot(openedTransport.sessionId, native, openedTransport.replay);
        if (
          input.knownTurnRefs?.some(
            (ref) =>
              ref.harnessId !== this.harnessId ||
              ref.nativeSessionId !== openedTransport.sessionId ||
              !native.some((turn) => turn.id === ref.nativeTurnKey),
          )
        )
          throw new Error("Saved Cursor turn identity no longer exists in native history");
      }
      if (!historyOnly && input.permissionModeId) {
        const selected = await session.execute({
          type: "permissionMode.select",
          permissionModeId: input.permissionModeId,
        });
        if (!selected.ok) throw new Error(selected.error.message);
      }
      if (this.#closed) {
        await session.close();
        this.#openingTransports.delete(transport);
        return rejected("invalidState", "Cursor adapter closed during session startup");
      }
      this.#sessions.add(session);
      this.#openingTransports.delete(transport);
      return { ok: true, value: session };
    } catch (error) {
      const failure = cursorError(error);
      if (failure.code === "authenticationRequired" || failure.code === "notInstalled")
        this.#expireInspection();
      try {
        if (transport) {
          await transport.close();
          this.#openingTransports.delete(transport);
        }
      } catch (cleanupError) {
        return { ok: false, error: cursorError(cleanupError) };
      }
      return { ok: false, error: failure };
    }
  }
  /**
   * A live session outcome that contradicts the settled cached inspection (login
   * lost, install removed, catalog drifted) must not stay hidden behind the long
   * ready TTL. In-flight probes are left alone so callers keep sharing them.
   */
  #expireInspection(): void {
    if (this.#inspection && !this.#inspection.pending) this.#inspection.expires = 0;
  }
  close(): Promise<void> {
    this.#closed = true;
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }
  async #close(): Promise<void> {
    const results = await Promise.allSettled([
      ...[...this.#sessions].map((session) => session.close()),
      ...[...this.#ephemeralTransports].map((transport) => transport.close()),
      ...[...this.#openingTransports].map((transport) => transport.close()),
      ...(this.#inspection ? [this.#inspection.close()] : []),
    ]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Cursor process cleanup failed");
  }
}

export class CursorSession implements HarnessSession {
  readonly harnessId = harnessIdSchema.parse("cursor-cli");
  readonly capabilities = CURSOR_CAPABILITIES;
  readonly initialUsage = null;
  readonly initialState: HarnessSessionState;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly outputs = this.#channel.outputs;
  readonly #interactions = new CursorInteractions((output) => this.#channel.emit(output));
  readonly #submitted = new Set<string>();
  #active: { command: TurnStartCommand; cancelled: boolean; task: Promise<void> } | undefined;
  #configuring = false;
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #fresh: boolean;
  readonly #replays = new Set<CursorTransport>();
  #subagentOutput: CursorSubagents | undefined;
  subagentSnapshot(callId: string): HostThreadSnapshot | undefined {
    try {
      return this.#subagentOutput?.snapshot(this.transport.sessionId, callId);
    } catch {
      return undefined;
    }
  }
  constructor(
    readonly transport: CursorTransport,
    readonly info: CursorSessionInfo,
    readonly onClose: () => void,
    created = true,
    fallbackModel?: HarnessModelRef,
  ) {
    this.#fresh = created;
    let currentModel: string | undefined;
    try {
      currentModel = cursorModels(info).current;
    } catch {
      currentModel = undefined;
    }
    if (!currentModel) {
      if (!this.transport.historyOnly) {
        throw new Error("Cursor did not report current model parameters; select an explicit model");
      }
      this.initialState = {
        nativeRef: nativeSessionRefSchema.parse({
          harnessId: "cursor-cli",
          nativeSessionId: transport.sessionId,
          formatVersion: 1,
        }),
        ...(fallbackModel ? { effectiveModel: fallbackModel } : {}),
        effectivePermissionModeId: harnessPermissionModeIdSchema.parse(
          info.modes?.currentModeId ?? "agent",
        ),
      };
      return;
    }
    this.initialState = {
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "cursor-cli",
        nativeSessionId: transport.sessionId,
        formatVersion: 1,
      }),
      effectiveModel: cursorModelRef(currentModel),
      effectivePermissionModeId: harnessPermissionModeIdSchema.parse(
        info.modes?.currentModeId ?? "agent",
      ),
    };
  }
  get executionReady(): boolean {
    return !this.transport.historyOnly;
  }
  #native(allowMissing = false) {
    return readCursorNativeTurns(
      this.transport.sessionId,
      this.transport.options.cwd,
      this.transport.options.environment,
      allowMissing,
    );
  }
  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed) return rejected("invalidState", "Cursor session is closed");
    if (this.#active || this.#configuring) return rejected("sessionBusy", "Cursor session is busy");
    this.#configuring = true;
    try {
      const before = this.#native(this.#fresh);
      if (before.length === 0 && this.#fresh)
        return { ok: true, value: { turns: [], state: structuredClone(this.initialState) } };
      if (this.transport.historyOnly) {
        return {
          ok: true,
          value: {
            ...cursorSnapshot(this.transport.sessionId, before, this.transport.replay),
            state: structuredClone(this.initialState),
          },
        };
      }
      const replay = new CursorTransport(this.transport.options);
      this.#replays.add(replay);
      try {
        await replay.open(this.transport.sessionId, { historyOnly: true });
        const after = this.#native();
        if (JSON.stringify(before) !== JSON.stringify(after))
          throw new Error("Cursor native history changed during snapshot read");
        return {
          ok: true,
          value: {
            ...cursorSnapshot(this.transport.sessionId, after, replay.replay),
            state: structuredClone(this.initialState),
          },
        };
      } finally {
        await replay.close();
        this.#replays.delete(replay);
      }
    } catch (error) {
      return { ok: false, error: cursorError(error) };
    } finally {
      this.#configuring = false;
    }
  }
  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  execute(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>>;
  async execute(
    command: HostCommand,
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
    if (this.#closed) return rejected("invalidState", "Cursor session is closed");
    if (command.type === "interaction.respond") return this.#interactions.respond(command);
    if (command.type === "turn.cancel") {
      if (!this.#active || this.#active.command.turnId !== command.turnId)
        return rejected("invalidState", "Cursor turn is not active");
      const active = this.#active;
      active.cancelled = true;
      this.#interactions.cancel();
      try {
        await this.transport.cancel();
      } catch {
        await this.transport.close();
      }
      const timer = setTimeout(() => {
        if (this.#active === active) void this.transport.close();
      }, 5_000);
      void active.task.finally(() => clearTimeout(timer));
      return { ok: true, value: { cancellationRequested: true } };
    }
    if (this.#active || this.#configuring) return rejected("sessionBusy", "Cursor session is busy");
    if (command.type === "turn.start") {
      if (this.#submitted.has(command.turnId))
        return rejected("invalidState", "Cursor turn was already submitted");
      if (
        !command.input.length ||
        command.input.some((part) => part.type !== "text") ||
        !command.input.some((part) => part.text.trim())
      )
        return rejected("invalidRequest", "Cursor requires nonempty text input");
      let before: CursorNativeTurn[];
      try {
        before = this.#native(this.#fresh);
      } catch (error) {
        return { ok: false, error: cursorError(error) };
      }
      this.#submitted.add(command.turnId);
      const active = { command, cancelled: false, task: Promise.resolve() };
      this.#active = active;
      active.task = this.#run(command, before);
      return { ok: true, value: { turnId: command.turnId } };
    }
    if (command.type === "thinking.select")
      return rejected(
        "unsupported",
        "Cursor ACP exposes model variants, not an independent thinking selector",
      );
    this.#configuring = true;
    try {
      const value =
        command.type === "model.select"
          ? cursorNativeModel(this.info, command.model.id)
          : command.permissionModeId;
      const configId = command.type === "model.select" ? "model" : "mode";
      if (configId === "mode" && !CURSOR_MODES.modes.some((mode) => mode.id === value))
        return rejected("invalidRequest", "Unknown Cursor execution mode");
      const result = await this.transport.configure(configId, value);
      if (
        !result.configOptions.some(
          (option) => option.id === configId && option.currentValue === value,
        )
      )
        throw new Error("Cursor did not confirm configuration selection");
      if (command.type === "model.select") this.initialState.effectiveModel = command.model;
      else this.initialState.effectivePermissionModeId = command.permissionModeId;
      this.#channel.emit({
        kind: "event",
        event: { type: "session.state.changed", state: { ...this.initialState } },
      });
      return { ok: true, value: { completed: true } };
    } catch (error) {
      if (this.transport.closed && !this.#closed) {
        this.#channel.emit({
          kind: "event",
          event: { type: "session.faulted", error: cursorError(error) },
        });
        await this.close();
      }
      return { ok: false, error: cursorError(error) };
    } finally {
      this.#configuring = false;
    }
  }
  async #run(command: TurnStartCommand, before: CursorNativeTurn[]) {
    let fault: HarnessError | undefined;
    const output = new CursorTurnOutput(
      command.turnId,
      (event) => this.#channel.emit({ kind: "event", event }),
      before.length,
    );
    this.#subagentOutput = output.subagents;
    this.#channel.emit({ kind: "event", event: { type: "turn.started", turnId: command.turnId } });
    let outcome: TurnOutcome = {
      status: "failed",
      error: { code: "nativeFailure", message: "Cursor turn failed", retryable: false },
    };
    let nativeTurnRef: ReturnType<typeof nativeTurnRefSchema.parse> | undefined;
    try {
      const result = await this.transport.prompt(
        command.input.map((part) => part.text).join("\n"),
        {
          update: (event) => output.update(event),
          permission: (request) => this.#interactions.permission(command.turnId, request),
          extension: (method, params) =>
            Promise.resolve(
              output.subagents.extension(method, params) ??
                this.#interactions.extension(command.turnId, method, params),
            ),
          notification: (method, params) => {
            output.subagents.extension(method, params);
          },
        },
      );
      outcome =
        this.#active?.cancelled || result.stopReason === "cancelled"
          ? { status: "cancelled" }
          : result.stopReason === "end_turn"
            ? { status: "succeeded" }
            : {
                status: "failed",
                error: {
                  code: "nativeFailure",
                  message: `Cursor stopped: ${result.stopReason}`,
                  retryable: false,
                },
              };
    } catch (error) {
      fault = cursorError(error);
      outcome = this.#active?.cancelled
        ? { status: "cancelled" }
        : { status: "failed", error: cursorError(error) };
    }
    try {
      const after = this.#native();
      const added = after.filter((turn) => !before.some((old) => old.id === turn.id));
      if (
        added.length !== 1 ||
        after.length !== before.length + 1 ||
        before.some((turn, index) => after[index]?.id !== turn.id) ||
        added[0]?.text !== command.input.map((part) => part.text).join("\n")
      )
        throw new Error("Cursor terminal has no unique, verified native turn identity");
      nativeTurnRef = nativeTurnRefSchema.parse({
        harnessId: "cursor-cli",
        nativeSessionId: this.transport.sessionId,
        nativeTurnKey: added[0].id,
        formatVersion: 1,
      });
      this.#fresh = false;
    } catch (error) {
      if (outcome.status === "succeeded") outcome = { status: "failed", error: cursorError(error) };
    }
    this.#interactions.cancel();
    output.finish(outcome);
    this.#active = undefined;
    this.#channel.emit({
      kind: "event",
      event: {
        type: "turn.completed",
        turnId: command.turnId,
        outcome,
        ...(nativeTurnRef ? { nativeTurnRef } : {}),
      },
    });
    if (fault && !this.#closed) {
      this.#channel.emit({ kind: "event", event: { type: "session.faulted", error: fault } });
      void this.close().catch(() => {});
    }
  }
  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }
  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const active = this.#active;
    if (active) active.cancelled = true;
    this.#interactions.cancel();
    try {
      const results = await Promise.allSettled([
        this.transport.close(),
        ...[...this.#replays].map((replay) => replay.close()),
      ]);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "Cursor Session process cleanup failed");
    } finally {
      this.#channel.end();
    }
    try {
      await active?.task;
    } finally {
      this.onClose();
    }
  }
}
