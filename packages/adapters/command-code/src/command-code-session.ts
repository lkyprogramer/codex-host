import {
  HarnessOutputChannel,
  type HarnessError,
  type HarnessIdleSuspendResult,
  type HarnessIdleSuspendSignal,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessOutput,
  type HarnessResourceLifecycle,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HostCommand,
  type HostEvent,
  type HostItemOutcome,
  type HostThreadSnapshot,
  type HostTurnSnapshot,
  type HostUsage,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type PermissionModeSelectCommand,
  type PermissionModeSelectCompleted,
  type ThinkingSelectCommand,
  type ThinkingSelectCompleted,
  type TurnCancelAccepted,
  type TurnCancelCommand,
  type TurnOutcome,
  type TurnStartAccepted,
  type TurnStartCommand,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessModelRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import { decodeCommandCodeModelRef } from "./model-catalog.js";
import {
  commandCodePermissionModeId,
  decodeCommandCodePermissionModeId,
  type CommandCodePermissionMode,
} from "./permission-modes.js";
import {
  commandCodeExitError,
  commandCodeTerminalDecision,
  isCommandCodeAuthenticationText,
} from "./print-errors.js";
import {
  commandCodePrintArguments,
  spawnCommandCodePrint,
  type CommandCodePrintProcess,
} from "./print-turn.js";
import {
  findCommandCodeSessionFile,
  latestCommandCodePromptId,
  readCommandCodeTranscript,
} from "./session-file.js";
import {
  commandCodeErrorMessage,
  type CommandCodeAgentEvent,
  type CommandCodeResultLine,
  type CommandCodeStreamLine,
} from "./stream-events.js";
import { CommandCodeTurnProjection } from "./turn-projection.js";
import { accumulateCommandCodeUsage, commandCodeHostUsage } from "./usage.js";

export const COMMAND_CODE_HARNESS_ID = harnessIdSchema.parse("command-code");
const DIAGNOSTIC_LIMIT = 8_000;
/** How long a run may linger after its result line before the line alone decides the Turn. */
const RESULT_EXIT_GRACE_MS = 5_000;
const STOP_GRACE_MS = 2_000;

export const COMMAND_CODE_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    // `--effort` writes the user's global per-Model default; see model-catalog.ts.
    selectThinkingOption: false,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  // `--fork-session` derives a whole Session at its tail, not at a checkpoint,
  // and print mode has no rewind; neither matches the Host derivation contract.
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  turnControl: { steering: "restart", workModes: ["default"] },
  subagents: { observe: true, readTranscript: false },
};

interface ActiveTurn {
  command: TurnStartCommand;
  projection: CommandCodeTurnProjection;
  process: CommandCodePrintProcess;
  cancellationRequested: boolean;
  interrupted: boolean;
  result: CommandCodeResultLine | null;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  resultTimer: NodeJS.Timeout | null;
  runError: string | null;
  diagnostics: string;
  runUsage: HostUsage | null;
  /** Identity reported by `run_start` on the create path, held back until the transcript exists. */
  pendingSessionId: string | null;
  /** Newest stored prompt before this run; only a newer one proves this Turn was persisted. */
  priorPromptId: string | undefined;
  /** Serializes stream handling so async file snapshots keep Item order. */
  queue: Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

/** Newest prompt ID in the transcript; `null` when the transcript is missing or unreadable. */
async function latestPromptIdOf(filePath: string | undefined): Promise<string | undefined | null> {
  if (!filePath) return undefined;
  const content = await readCommandCodeTranscript(filePath);
  return content === null ? null : latestCommandCodePromptId(content);
}

export class CommandCodeSession implements HarnessSession {
  readonly harnessId: HarnessId = COMMAND_CODE_HARNESS_ID;
  readonly capabilities = COMMAND_CODE_CAPABILITIES;
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null = null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly resourceLifecycle: HarnessResourceLifecycle;
  /** False for a history-only open without the CLI; the Host resumes live before executing. */
  readonly executionReady: boolean;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #catalog: HarnessModelCatalog | undefined;
  readonly #cwd: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #executable: string | undefined;
  readonly #maxTurns: number;
  readonly #onClosed: () => void;
  readonly #toolOutputLimit: number;
  readonly #turns: HostTurnSnapshot[];
  #active: ActiveTurn | null = null;
  #closeTask: Promise<void> | null = null;
  #closed = false;
  #model: HarnessModelRef | undefined;
  #nativeRef: NativeSessionRef | undefined;
  #permissionMode: CommandCodePermissionMode;
  #sessionFilePath: string | undefined;
  #usage: HostUsage | null = null;

  constructor(input: {
    catalog?: HarnessModelCatalog;
    cwd: string;
    environment: NodeJS.ProcessEnv;
    /** Undefined only for a history-only open; starting a Turn then reports notInstalled. */
    executable: string | undefined;
    maxTurns: number;
    model?: HarnessModelRef;
    nativeRef?: NativeSessionRef;
    permissionMode: CommandCodePermissionMode;
    sessionFilePath?: string;
    toolOutputLimit: number;
    turns: HostTurnSnapshot[];
    onClosed(): void;
  }) {
    this.#catalog = input.catalog;
    this.#cwd = input.cwd;
    this.#environment = input.environment;
    this.#executable = input.executable;
    this.#maxTurns = input.maxTurns;
    this.#model = input.model;
    this.#nativeRef = input.nativeRef;
    this.#permissionMode = input.permissionMode;
    this.#sessionFilePath = input.sessionFilePath;
    this.#toolOutputLimit = input.toolOutputLimit;
    this.#turns = input.turns;
    this.#onClosed = input.onClosed;
    this.executionReady = input.executable !== undefined;
    this.initialState = this.#state();
    this.outputs = this.#channel.outputs;
    this.resourceLifecycle = { suspend: (signal) => this.#suspend(signal) };
  }

  get nativeRef(): NativeSessionRef | undefined {
    return this.#nativeRef;
  }

  get isActive(): boolean {
    return this.#active !== null;
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed) return { ok: false, error: invalidState("Command Code Session is closed") };
    return { ok: true, value: { turns: [...this.#turns], state: this.#state() } };
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
    if (this.#closed) return { ok: false, error: invalidState("Command Code Session is closed") };
    switch (command.type) {
      case "turn.cancel":
        return this.#cancel(command);
      case "model.select":
        return this.#selectModel(command);
      case "thinking.select":
        return {
          ok: false,
          error: {
            code: "unsupported",
            message:
              "Command Code effort is not selectable per Thread; it follows the CLI's per-Model config",
            retryable: false,
          },
        };
      case "permissionMode.select":
        return this.#selectPermissionMode(command);
      case "interaction.respond":
        // Print mode auto-answers permissions and questions inside the CLI.
        return { ok: false, error: invalidState("Command Code has no open interaction") };
      case "turn.start":
        return this.#start(command);
    }
  }

  close(): Promise<void> {
    this.#closeTask ??= this.#close();
    return this.#closeTask;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    const active = this.#active;
    try {
      if (active) {
        active.cancellationRequested = true;
        const stopping = active.process.stop();
        this.#completeTurn(active, { status: "cancelled", reason: "Session closed" });
        await stopping;
        await active.queue.catch(() => undefined);
      }
    } finally {
      // Outputs must end even when the process group could not be confirmed
      // gone; the rejection still reaches the Adapter's cleanup aggregate.
      this.#channel.end();
      this.#onClosed();
    }
  }

  async #suspend(signal: HarnessIdleSuspendSignal): Promise<HarnessIdleSuspendResult> {
    if (this.#closed) return { status: "unsupported", reason: "Session is closed" };
    if (this.#active) return { status: "busy", reason: "Command Code Turn is running" };
    if (!this.#nativeRef) {
      return { status: "unsupported", reason: "No Native Session to resume yet" };
    }
    if (signal.aborted) return { status: "unknown", reason: "Suspension aborted" };
    // Between Turns nothing native is alive; ending outputs is the whole release.
    await this.close();
    return { status: "suspended", scope: "print-process" };
  }

  async #start(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>> {
    if (this.#active) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Command Code Turn is already running",
          retryable: true,
        },
      };
    }
    if (!this.#executable) {
      return {
        ok: false,
        error: { code: "notInstalled", message: "Command Code is not installed", retryable: false },
      };
    }
    const text = command.input
      .map(({ text: part }) => part)
      .join("\n")
      .trim();
    if (!text) {
      return {
        ok: false,
        error: { code: "invalidRequest", message: "Command Code Turn is empty", retryable: false },
      };
    }
    const transcriptMissing: HarnessError = {
      code: "sessionNotFound",
      message:
        "Command Code Session transcript was not found under ~/.commandcode/projects; the Session cannot be continued",
      retryable: false,
    };
    if (this.#nativeRef && !this.#sessionFilePath) {
      const file = await findCommandCodeSessionFile(
        this.#environment,
        this.#nativeRef.nativeSessionId,
      );
      const interrupted = this.#notStartable();
      if (interrupted) return { ok: false, error: interrupted };
      if (!file) return { ok: false, error: transcriptMissing };
      this.#sessionFilePath = file.path;
    }
    // A transcript deleted between Turns must not become a retryable CLI error.
    const priorPromptId = await latestPromptIdOf(this.#sessionFilePath);
    const interrupted = this.#notStartable();
    if (interrupted) return { ok: false, error: interrupted };
    if (priorPromptId === null) return { ok: false, error: transcriptMissing };
    const arguments_ = commandCodePrintArguments({
      ...(this.#sessionFilePath ? { sessionFilePath: this.#sessionFilePath } : {}),
      ...(this.#model ? { model: this.#model } : {}),
      permissionMode: this.#permissionMode,
      maxTurns: this.#maxTurns,
    });
    const projection = new CommandCodeTurnProjection({
      turnId: command.turnId,
      cwd: this.#cwd,
      toolOutputLimit: this.#toolOutputLimit,
      emit: (event) => this.#event(event),
    });
    const active: ActiveTurn = {
      command,
      projection,
      process: undefined as unknown as CommandCodePrintProcess,
      cancellationRequested: false,
      interrupted: false,
      result: null,
      exit: null,
      resultTimer: null,
      runError: null,
      diagnostics: "",
      runUsage: null,
      pendingSessionId: null,
      priorPromptId,
      queue: Promise.resolve(),
    };
    try {
      active.process = spawnCommandCodePrint({
        executable: this.#executable,
        arguments: arguments_,
        cwd: this.#cwd,
        environment: this.#environment,
        prompt: text,
        onLine: (line) => this.#enqueue(active, () => this.#handleLine(active, line)),
        onDiagnostic: (chunk) => {
          active.diagnostics = (active.diagnostics + chunk).slice(-DIAGNOSTIC_LIMIT);
        },
        onError: (error) =>
          this.#enqueue(active, () => {
            if (this.#active !== active) return;
            this.#completeTurn(active, {
              status: "failed",
              error: { code: "nativeFailure", message: error.message, retryable: true },
            });
          }),
        onExit: (code, signal) =>
          this.#enqueue(active, async () => {
            active.exit = { code, signal };
            await this.#finalize(active);
          }),
      });
    } catch (error) {
      return {
        ok: false,
        error: { code: "nativeFailure", message: errorMessage(error), retryable: true },
      };
    }
    this.#active = active;
    this.#event({ type: "turn.started", turnId: command.turnId });
    return { ok: true, value: { turnId: command.turnId } };
  }

  /** Re-checked after every await in `#start`: close and cancel-failure are not serialized by the Host. */
  #notStartable(): HarnessError | null {
    if (this.#closed) return invalidState("Command Code Session is closed");
    if (this.#active) {
      return {
        code: "sessionBusy",
        message: "Command Code Turn is already running",
        retryable: true,
      };
    }
    return null;
  }

  #enqueue(active: ActiveTurn, work: () => Promise<void> | void): void {
    active.queue = active.queue.then(work).catch((error: unknown) => {
      if (this.#active !== active) return;
      this.#completeTurn(active, {
        status: "failed",
        error: { code: "internalError", message: errorMessage(error), retryable: false },
      });
    });
  }

  async #handleLine(active: ActiveTurn, line: CommandCodeStreamLine): Promise<void> {
    if (this.#active !== active) return;
    if (line.type === "result") {
      this.#handleResult(active, line);
      return;
    }
    await this.#handleEvent(active, line.event);
  }

  async #handleEvent(active: ActiveTurn, event: CommandCodeAgentEvent): Promise<void> {
    const projection = active.projection;
    switch (event.type) {
      case "run_start":
        this.#observeSessionId(active, event.sessionId);
        return;
      case "turn_end": {
        const usage = commandCodeHostUsage(event.usage);
        if (usage) {
          active.runUsage = accumulateCommandCodeUsage(active.runUsage, usage);
          this.#publishUsage(active);
        }
        return;
      }
      case "text_delta":
        projection.appendText(event.delta);
        return;
      case "thinking_delta":
        projection.appendReasoning(event.delta);
        return;
      case "thinking_end":
        projection.closeReasoning();
        return;
      case "tool_queued":
        projection.openTool(event.toolCallId, event.toolName, event.input);
        return;
      case "tool_running":
        projection.openTool(event.toolCallId, event.toolName, undefined);
        return;
      case "tool_completed":
        await projection.finishTool(event.toolCallId, event.toolName, event.result, null);
        return;
      case "tool_errored": {
        const detail = commandCodeErrorMessage(event.error);
        await projection.finishTool(event.toolCallId, event.toolName, undefined, {
          code: "nativeFailure",
          message: `Command Code tool '${event.toolName}' failed${detail ? `: ${detail}` : ""}`,
          retryable: false,
        });
        return;
      }
      case "tool_denied":
        // Emitted for unknown tool names as well as for risk-marked tools that a
        // headless run cannot ask approval for.
        await projection.finishTool(event.toolCallId, event.toolName, undefined, {
          code: "nativeFailure",
          message: `Command Code did not run tool '${event.toolName}' (denied or unknown in a headless run)`,
          retryable: false,
        });
        return;
      case "tool_hook_blocked": {
        const reason = commandCodeErrorMessage(event.hookOutput);
        await projection.finishTool(event.toolCallId, event.toolName, undefined, {
          code: "nativeFailure",
          message: `Command Code blocked tool '${event.toolName}' before execution${
            this.#permissionMode === "bypass" ? "" : ` (permission mode '${this.#permissionMode}')`
          }${reason ? `: ${reason}` : ""}`,
          retryable: false,
        });
        return;
      }
      case "subagent_start":
        projection.startSubagent(
          event.toolCallId,
          event.description ?? event.subagentType ?? "Subagent",
          event.background === true,
        );
        return;
      case "subagent_stop":
        projection.stopSubagent(event.toolCallId, { status: "succeeded" });
        return;
      case "compaction_start":
        projection.startCompaction();
        return;
      case "compaction_done":
        projection.endCompaction();
        return;
      case "interrupted":
        active.interrupted = true;
        return;
      case "run_error":
        active.runError = commandCodeErrorMessage(event.error);
        return;
      case "run_end": {
        const usage = commandCodeHostUsage(event.result?.usage);
        if (usage) {
          active.runUsage = usage;
          this.#publishUsage(active);
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * A resumed Session must be continued by the CLI under the same ID. A
   * created Session only learns its ID here; publishing it before the
   * transcript exists would leave the Thread pointing at nothing if this
   * first run is cancelled before the CLI persists anything.
   */
  #observeSessionId(active: ActiveTurn, sessionId: string): void {
    if (this.#nativeRef) {
      if (this.#nativeRef.nativeSessionId === sessionId) return;
      this.#completeTurn(active, {
        status: "failed",
        error: {
          code: "sessionNotFound",
          message: "Command Code resumed a different Session than the Thread's Native Ref",
          retryable: false,
        },
      });
      void active.process.stop().catch(() => undefined);
      return;
    }
    active.pendingSessionId ??= sessionId;
  }

  #handleResult(active: ActiveTurn, result: CommandCodeResultLine): void {
    if (this.#active !== active || active.result) return;
    active.result = result;
    if (result.sessionId) this.#observeSessionId(active, result.sessionId);
    if (this.#active !== active) return;
    const usage = commandCodeHostUsage(result.usage);
    if (usage) {
      active.runUsage = usage;
      this.#publishUsage(active);
    }
    if (result.finalText) active.projection.appendFinalText(result.finalText);
    if (active.exit) {
      // Exit was observed first (never expected from the stream order, but the
      // Turn must still reach its terminal).
      this.#enqueue(active, () => this.#finalize(active));
      return;
    }
    // The exit code qualifies the result line, so wait for it — but not forever.
    active.resultTimer = setTimeout(() => {
      this.#enqueue(active, async () => {
        if (this.#active !== active || active.exit) return;
        void active.process.stop().catch(() => undefined);
        await this.#finalize(active);
      });
    }, RESULT_EXIT_GRACE_MS);
    active.resultTimer.unref?.();
  }

  async #finalize(active: ActiveTurn): Promise<void> {
    if (this.#active !== active) return;
    if (active.resultTimer) {
      clearTimeout(active.resultTimer);
      active.resultTimer = null;
    }
    const exitCode = active.exit?.code ?? null;
    let outcome: TurnOutcome;
    if (active.cancellationRequested) {
      outcome = { status: "cancelled", reason: "Cancelled by user" };
    } else if (active.interrupted) {
      outcome = { status: "cancelled", reason: "Interrupted by Command Code" };
    } else if (active.result) {
      const decision = commandCodeTerminalDecision({
        result: active.result,
        exitCode,
        diagnostics: active.diagnostics,
      });
      outcome =
        decision.status === "succeeded"
          ? { status: "succeeded" }
          : { status: "failed", error: decision.error };
    } else if (active.runError && isCommandCodeAuthenticationText(active.runError)) {
      outcome = {
        status: "failed",
        error: { code: "authenticationRequired", message: active.runError, retryable: false },
      };
    } else {
      outcome = { status: "failed", error: commandCodeExitError(exitCode, active.diagnostics) };
    }
    const nativeTurnRef = await this.#resolveNativeTurnRef(active);
    if (this.#active !== active) return;
    this.#completeTurn(active, outcome, nativeTurnRef);
  }

  /**
   * Binds a created Session once its transcript is on disk and keys the Turn
   * by the prompt the CLI stored for it. A run that never persisted its prompt
   * (early failure, cancelled before the first Model reply) yields no Turn
   * identity rather than borrowing the previous Turn's.
   */
  async #resolveNativeTurnRef(active: ActiveTurn): Promise<NativeTurnRef | undefined> {
    if (!this.#nativeRef && active.pendingSessionId) {
      const file = await findCommandCodeSessionFile(this.#environment, active.pendingSessionId);
      if (this.#active !== active) return undefined;
      if (!file) return undefined;
      this.#nativeRef = nativeSessionRefSchema.parse({
        harnessId: this.harnessId,
        nativeSessionId: active.pendingSessionId,
        formatVersion: 1,
      });
      this.#sessionFilePath = file.path;
      this.#event({ type: "session.state.changed", state: this.#state() });
    }
    if (!this.#nativeRef) return undefined;
    const promptId = await latestPromptIdOf(this.#sessionFilePath);
    if (this.#active !== active) return undefined;
    if (!promptId || promptId === active.priorPromptId) return undefined;
    return nativeTurnRefSchema.parse({
      harnessId: this.harnessId,
      nativeSessionId: this.#nativeRef.nativeSessionId,
      nativeTurnKey: promptId,
      formatVersion: 1,
    });
  }

  #publishUsage(active: ActiveTurn): void {
    const usage = active.runUsage
      ? accumulateCommandCodeUsage(this.#usage, active.runUsage)
      : this.#usage;
    this.#event({
      type: "session.usage.changed",
      usage,
      observedForTurnId: active.command.turnId,
    });
  }

  #completeTurn(active: ActiveTurn, outcome: TurnOutcome, nativeTurnRef?: NativeTurnRef): void {
    if (this.#active !== active) return;
    this.#active = null;
    if (active.resultTimer) {
      clearTimeout(active.resultTimer);
      active.resultTimer = null;
    }
    const itemOutcome: HostItemOutcome =
      outcome.status === "failed"
        ? { status: "failed", error: outcome.error }
        : outcome.status === "cancelled"
          ? { status: "cancelled", ...(outcome.reason ? { reason: outcome.reason } : {}) }
          : { status: "succeeded" };
    active.projection.finish(itemOutcome);
    if (active.runUsage) {
      this.#usage = accumulateCommandCodeUsage(this.#usage, active.runUsage);
      active.runUsage = null;
    }
    if (nativeTurnRef) {
      this.#turns.push({
        nativeTurnRef,
        input: active.command.input,
        items: active.projection.completedItems,
        outcome:
          outcome.status === "failed"
            ? { status: "failed", error: outcome.error }
            : outcome.status === "cancelled"
              ? { status: "cancelled", ...(outcome.reason ? { reason: outcome.reason } : {}) }
              : { status: "succeeded" },
        ...(this.#model ? { model: this.#model } : {}),
      });
    }
    // The process is already gone on the normal path; bound the wait otherwise.
    void Promise.race([
      active.process.exited,
      new Promise<void>((resolve) => setTimeout(resolve, STOP_GRACE_MS).unref?.()),
    ])
      .then(() => active.process.stop())
      .catch(() => undefined);
    this.#event({
      type: "turn.completed",
      turnId: active.command.turnId,
      outcome,
      ...(nativeTurnRef ? { nativeTurnRef } : {}),
    });
  }

  async #cancel(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    const active = this.#active;
    if (!active || active.command.turnId !== command.turnId) {
      return { ok: false, error: invalidState("Command Code Turn is not active") };
    }
    // Once the result line is in, the native Turn has finished: the request is
    // accepted, the native outcome stands, and the run is left to exit on its
    // own (bounded by the result grace timer) rather than signalled into a
    // misleading exit 130.
    if (active.result) return { ok: true, value: { cancellationRequested: true } };
    active.cancellationRequested = true;
    try {
      await active.process.stop();
    } catch (error) {
      this.#closed = true;
      const failure: HarnessError = {
        code: "nativeFailure",
        message: `Command Code cancellation cleanup failed: ${errorMessage(error)}`,
        retryable: false,
      };
      // The process could not be confirmed stopped: end the Session rather
      // than leaving a Turn that can never reach a terminal.
      this.#completeTurn(active, { status: "failed", error: failure });
      this.#event({ type: "session.faulted", error: failure });
      this.#channel.end();
      this.#onClosed();
      return { ok: false, error: failure };
    }
    return { ok: true, value: { cancellationRequested: true } };
  }

  #busy(): HarnessResult<never> {
    return {
      ok: false,
      error: { code: "sessionBusy", message: "Command Code Turn is running", retryable: true },
    };
  }

  #selectModel(command: ModelSelectCommand): HarnessResult<ModelSelectCompleted> {
    if (this.#active) return this.#busy();
    const model = harnessModelRefSchema.safeParse(command.model);
    if (!model.success) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Command Code Model Ref is invalid",
          retryable: false,
        },
      };
    }
    try {
      decodeCommandCodeModelRef(model.data);
    } catch (error) {
      return {
        ok: false,
        error: { code: "invalidRequest", message: errorMessage(error), retryable: false },
      };
    }
    if (this.#catalog && !this.#catalog.models.some(({ ref }) => ref.id === model.data.id)) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Model is not in the Command Code catalog",
          retryable: false,
        },
      };
    }
    this.#model = model.data;
    this.#event({ type: "session.state.changed", state: this.#state() });
    return { ok: true, value: { completed: true } };
  }

  #selectPermissionMode(
    command: PermissionModeSelectCommand,
  ): HarnessResult<PermissionModeSelectCompleted> {
    if (this.#active) return this.#busy();
    try {
      this.#permissionMode = decodeCommandCodePermissionModeId(command.permissionModeId);
    } catch (error) {
      return {
        ok: false,
        error: { code: "invalidRequest", message: errorMessage(error), retryable: false },
      };
    }
    this.#event({ type: "session.state.changed", state: this.#state() });
    return { ok: true, value: { completed: true } };
  }

  #state(): HarnessSessionState {
    return {
      ...(this.#nativeRef ? { nativeRef: this.#nativeRef } : {}),
      ...(this.#model
        ? {
            effectiveModel: this.#model,
            resolvedModelLabel: decodeCommandCodeModelRef(this.#model),
          }
        : {}),
      effectivePermissionModeId: commandCodePermissionModeId(this.#permissionMode),
    };
  }

  #event(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }
}
