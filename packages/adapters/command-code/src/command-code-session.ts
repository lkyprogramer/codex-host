import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

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
  type HostAgentMessageItem,
  type HostCommand,
  type HostEvent,
  type HostItem,
  type HostItemOutcome,
  type HostItemSnapshot,
  type HostReasoningItem,
  type HostSubagentDelegationItem,
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
  harnessThinkingOptionIdSchema,
  hostItemIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type HarnessThinkingOptionId,
  type HostItemId,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import {
  COMMAND_CODE_EFFORT_OPTIONS,
  decodeCommandCodeModelRef,
  isCommandCodeEffort,
} from "./model-catalog.js";
import {
  commandCodePermissionModeId,
  decodeCommandCodePermissionModeId,
  type CommandCodePermissionMode,
} from "./permission-modes.js";
import {
  commandCodeExitError,
  commandCodeResultError,
  isCommandCodeAuthenticationText,
} from "./print-errors.js";
import {
  commandCodePrintArguments,
  spawnCommandCodePrint,
  type CommandCodePrintProcess,
} from "./print-turn.js";
import { findCommandCodeSessionFile, latestCommandCodePromptId } from "./session-file.js";
import {
  commandCodeErrorMessage,
  type CommandCodeAgentEvent,
  type CommandCodeResultLine,
  type CommandCodeStreamLine,
} from "./stream-events.js";
import {
  commandCodeToolTargetFile,
  completeCommandCodeToolItem,
  isCommandCodeFileMutatingTool,
  resolveCommandCodeFileChange,
  snapshotCommandCodeFile,
  startCommandCodeToolItem,
  type CommandCodeMutation,
} from "./tool-projection.js";
import { accumulateCommandCodeUsage, commandCodeHostUsage } from "./usage.js";

export const COMMAND_CODE_HARNESS_ID = harnessIdSchema.parse("command-code");
const DIAGNOSTIC_LIMIT = 8_000;
const EXIT_GRACE_MS = 2_000;

export const COMMAND_CODE_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  // `--fork-session` derives a whole Session at its tail, not at a checkpoint,
  // and print mode has no rewind; neither matches the Host derivation contract.
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  turnControl: { steering: "restart", workModes: ["default"] },
  subagents: { observe: true, readTranscript: false },
};

interface ToolEntry {
  item: Extract<HostItem, { type: "commandExecution" | "toolExecution" }>;
  /** Deferred File Change: resolved once the tool reports completion. */
  mutation: CommandCodeMutation | null;
  started: boolean;
}

interface ActiveTurn {
  command: TurnStartCommand;
  process: CommandCodePrintProcess;
  cancellationRequested: boolean;
  receivedResult: boolean;
  interrupted: boolean;
  runError: string | null;
  diagnostics: string;
  agentItem: HostAgentMessageItem | null;
  reasoningItem: HostReasoningItem | null;
  compactionItem: HostItem | null;
  tools: Map<string, ToolEntry>;
  subagents: Map<string, HostSubagentDelegationItem>;
  completedItems: HostItemSnapshot[];
  runUsage: HostUsage | null;
  /** Serializes stream handling so async file snapshots keep Item order. */
  queue: Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

export class CommandCodeSession implements HarnessSession {
  readonly harnessId: HarnessId = COMMAND_CODE_HARNESS_ID;
  readonly capabilities = COMMAND_CODE_CAPABILITIES;
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null = null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly resourceLifecycle: HarnessResourceLifecycle;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #catalog: HarnessModelCatalog | undefined;
  readonly #cwd: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #executable: string;
  readonly #maxTurns: number;
  readonly #onClosed: () => void;
  readonly #toolOutputLimit: number;
  readonly #turns: HostTurnSnapshot[];
  #active: ActiveTurn | null = null;
  #closeTask: Promise<void> | null = null;
  #closed = false;
  #model: HarnessModelRef | undefined;
  #effort: HarnessThinkingOptionId | undefined;
  #nativeRef: NativeSessionRef | undefined;
  #permissionMode: CommandCodePermissionMode;
  #sessionFilePath: string | undefined;
  #usage: HostUsage | null = null;

  constructor(input: {
    catalog?: HarnessModelCatalog;
    cwd: string;
    environment: NodeJS.ProcessEnv;
    executable: string;
    maxTurns: number;
    model?: HarnessModelRef;
    effort?: HarnessThinkingOptionId;
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
    this.#effort = input.effort;
    this.#nativeRef = input.nativeRef;
    this.#permissionMode = input.permissionMode;
    this.#sessionFilePath = input.sessionFilePath;
    this.#toolOutputLimit = input.toolOutputLimit;
    this.#turns = input.turns;
    this.#onClosed = input.onClosed;
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
        return this.#selectThinking(command);
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
    if (active) {
      active.cancellationRequested = true;
      const stopping = active.process.stop();
      this.#completeTurn(active, { status: "cancelled", reason: "Session closed" });
      await stopping;
      await active.queue.catch(() => undefined);
    }
    this.#channel.end();
    this.#onClosed();
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
    if (this.#nativeRef && !this.#sessionFilePath) {
      const file = await findCommandCodeSessionFile(
        this.#environment,
        this.#nativeRef.nativeSessionId,
      );
      if (file) this.#sessionFilePath = file.path;
    }
    const arguments_ = commandCodePrintArguments({
      ...(this.#sessionFilePath ? { sessionFilePath: this.#sessionFilePath } : {}),
      ...(this.#nativeRef ? { nativeSessionId: this.#nativeRef.nativeSessionId } : {}),
      ...(this.#model ? { model: this.#model } : {}),
      ...(this.#effort ? { effort: this.#effort } : {}),
      permissionMode: this.#permissionMode,
      maxTurns: this.#maxTurns,
    });
    const active: ActiveTurn = {
      command,
      process: undefined as unknown as CommandCodePrintProcess,
      cancellationRequested: false,
      receivedResult: false,
      interrupted: false,
      runError: null,
      diagnostics: "",
      agentItem: null,
      reasoningItem: null,
      compactionItem: null,
      tools: new Map(),
      subagents: new Map(),
      completedItems: [],
      runUsage: null,
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
        onExit: (code) =>
          this.#enqueue(active, () => {
            if (this.#active !== active || active.receivedResult) return;
            if (active.cancellationRequested || active.interrupted) {
              this.#completeTurn(active, { status: "cancelled", reason: "Cancelled by user" });
              return;
            }
            const error =
              active.runError && isCommandCodeAuthenticationText(active.runError)
                ? ({
                    code: "authenticationRequired",
                    message: active.runError,
                    retryable: false,
                  } as const)
                : commandCodeExitError(code, active.diagnostics);
            this.#completeTurn(active, { status: "failed", error });
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
      active.receivedResult = true;
      await this.#handleResult(active, line);
      return;
    }
    await this.#handleEvent(active, line.event);
  }

  async #handleEvent(active: ActiveTurn, event: CommandCodeAgentEvent): Promise<void> {
    switch (event.type) {
      case "run_start":
        this.#bindNativeSession(active, event.sessionId);
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
        this.#closeReasoning(active);
        this.#appendAgentText(active, event.delta);
        return;
      case "thinking_delta":
        this.#appendReasoning(active, event.delta);
        return;
      case "thinking_end":
        this.#closeReasoning(active);
        return;
      case "tool_queued":
        this.#openTool(active, event.toolCallId, event.toolName, event.input);
        return;
      case "tool_running":
        this.#openTool(active, event.toolCallId, event.toolName, undefined);
        return;
      case "tool_completed":
        await this.#finishTool(active, event.toolCallId, event.toolName, event.result, null);
        return;
      case "tool_errored":
        await this.#finishTool(active, event.toolCallId, event.toolName, undefined, {
          code: "nativeFailure",
          message: `Command Code tool '${event.toolName}' failed${
            commandCodeErrorMessage(event.error) ? `: ${commandCodeErrorMessage(event.error)}` : ""
          }`,
          retryable: false,
        });
        return;
      case "tool_denied":
      case "tool_hook_blocked":
        await this.#finishTool(active, event.toolCallId, event.toolName, undefined, {
          code: "nativeFailure",
          message: `Command Code blocked tool '${event.toolName}' under its '${this.#permissionMode}' permission mode`,
          retryable: false,
        });
        return;
      case "subagent_start":
        this.#startSubagent(
          active,
          event.toolCallId,
          event.description ?? event.subagentType ?? "Subagent",
          event.background === true,
        );
        return;
      case "subagent_stop":
        this.#stopSubagent(active, event.toolCallId, { status: "succeeded" });
        return;
      case "compaction_start":
        this.#closeAgentText(active);
        active.compactionItem = { type: "contextCompaction", itemId: this.#newItemId() };
        this.#event({
          type: "item.started",
          turnId: active.command.turnId,
          item: active.compactionItem,
        });
        return;
      case "compaction_done":
        if (active.compactionItem) {
          this.#completeItem(active, active.compactionItem, { status: "succeeded" });
          active.compactionItem = null;
        }
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

  #bindNativeSession(active: ActiveTurn, sessionId: string): void {
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
    this.#nativeRef = nativeSessionRefSchema.parse({
      harnessId: this.harnessId,
      nativeSessionId: sessionId,
      formatVersion: 1,
    });
    this.#event({ type: "session.state.changed", state: this.#state() });
  }

  async #handleResult(active: ActiveTurn, result: CommandCodeResultLine): Promise<void> {
    if (this.#active !== active) return;
    if (result.sessionId) this.#bindNativeSession(active, result.sessionId);
    if (this.#active !== active) return;
    const usage = commandCodeHostUsage(result.usage);
    if (usage) {
      active.runUsage = usage;
      this.#publishUsage(active);
    }
    if (active.agentItem === null && result.finalText?.trim()) {
      this.#appendAgentText(active, result.finalText);
    }
    const nativeSessionId = this.#nativeRef?.nativeSessionId;
    const turnKey = nativeSessionId ? await this.#resolveTurnKey(nativeSessionId) : undefined;
    const nativeTurnRef =
      nativeSessionId && turnKey
        ? nativeTurnRefSchema.parse({
            harnessId: this.harnessId,
            nativeSessionId,
            nativeTurnKey: turnKey,
            formatVersion: 1,
          })
        : undefined;
    const checkpoint =
      nativeSessionId && turnKey
        ? nativeCheckpointRefSchema.parse({
            harnessId: this.harnessId,
            nativeSessionId,
            checkpointId: turnKey,
            formatVersion: 1,
          })
        : undefined;
    const withCheckpoint = checkpoint ? { checkpoint } : {};
    if (active.cancellationRequested || active.interrupted) {
      this.#completeTurn(
        active,
        { status: "cancelled", reason: "Cancelled by user", ...withCheckpoint },
        nativeTurnRef,
      );
    } else if (result.subtype === "success") {
      this.#completeTurn(active, { status: "succeeded", ...withCheckpoint }, nativeTurnRef);
    } else {
      this.#completeTurn(
        active,
        {
          status: "failed",
          error: commandCodeResultError(result, active.diagnostics),
          ...withCheckpoint,
        },
        nativeTurnRef,
      );
    }
  }

  /**
   * The CLI keys history by the stored prompt message, so the live Turn reads
   * the newest prompt ID back from the transcript; a fallback ordinal keeps the
   * Turn identifiable when the file is not readable.
   */
  async #resolveTurnKey(nativeSessionId: string): Promise<string> {
    if (!this.#sessionFilePath) {
      const file = await findCommandCodeSessionFile(this.#environment, nativeSessionId);
      if (file) this.#sessionFilePath = file.path;
    }
    if (this.#sessionFilePath) {
      try {
        const id = latestCommandCodePromptId(await readFile(this.#sessionFilePath, "utf8"));
        if (id) return id;
      } catch {
        /* fall through to the ordinal key */
      }
    }
    return `turn:${this.#turns.length + 1}`;
  }

  #openTool(active: ActiveTurn, toolCallId: string, toolName: string, input: unknown): void {
    const existing = active.tools.get(toolCallId);
    if (existing) {
      if (!existing.started && !existing.mutation) this.#emitToolStart(active, existing);
      return;
    }
    this.#closeReasoning(active);
    this.#closeAgentText(active);
    const item = startCommandCodeToolItem(this.#newItemId(), toolName, input, this.#cwd);
    const target = isCommandCodeFileMutatingTool(toolName)
      ? commandCodeToolTargetFile(input, this.#cwd)
      : null;
    const entry: ToolEntry = {
      item,
      mutation: target
        ? {
            toolName,
            input,
            absolutePath: target,
            cwd: this.#cwd,
            before: snapshotCommandCodeFile(target),
          }
        : null,
      started: false,
    };
    active.tools.set(toolCallId, entry);
    // A file edit only becomes a File Change once its patch is known; until
    // then it stays uncarded rather than showing an empty diff.
    if (!entry.mutation) this.#emitToolStart(active, entry);
  }

  #emitToolStart(active: ActiveTurn, entry: ToolEntry): void {
    entry.started = true;
    this.#event({ type: "item.started", turnId: active.command.turnId, item: entry.item });
  }

  async #finishTool(
    active: ActiveTurn,
    toolCallId: string,
    toolName: string,
    result: unknown,
    error: HarnessError | null,
  ): Promise<void> {
    let entry = active.tools.get(toolCallId);
    if (!entry) {
      this.#openTool(active, toolCallId, toolName, undefined);
      entry = active.tools.get(toolCallId);
      if (!entry) return;
    }
    active.tools.delete(toolCallId);
    const outcome: HostItemOutcome = error ? { status: "failed", error } : { status: "succeeded" };
    if (entry.mutation && !error) {
      const change = await resolveCommandCodeFileChange(entry.mutation);
      if (this.#active !== active) return;
      if (change) {
        const item: HostItem = { type: "fileChange", itemId: entry.item.itemId, changes: [change] };
        this.#event({ type: "item.started", turnId: active.command.turnId, item });
        this.#completeItem(active, item, outcome);
        return;
      }
    }
    if (!entry.started) this.#emitToolStart(active, entry);
    this.#completeItem(
      active,
      completeCommandCodeToolItem(entry.item, result, this.#toolOutputLimit),
      outcome,
    );
  }

  #startSubagent(
    active: ActiveTurn,
    toolCallId: string,
    description: string,
    background: boolean,
  ): void {
    if (active.subagents.has(toolCallId)) return;
    this.#closeAgentText(active);
    const item: HostSubagentDelegationItem = {
      type: "subagentDelegation",
      itemId: this.#newItemId(),
      operation: "spawn",
      subagents: [
        {
          subagentId: toolCallId,
          nativeSubagentId: toolCallId,
          description,
          background,
          status: "running",
        },
      ],
    };
    active.subagents.set(toolCallId, item);
    this.#event({ type: "item.started", turnId: active.command.turnId, item });
    this.#event({
      type: "subagent.state.changed",
      nativeSubagentId: toolCallId,
      status: "running",
    });
  }

  #stopSubagent(active: ActiveTurn, toolCallId: string, outcome: HostItemOutcome): void {
    const item = active.subagents.get(toolCallId);
    if (!item) return;
    active.subagents.delete(toolCallId);
    const status =
      outcome.status === "succeeded"
        ? "completed"
        : outcome.status === "failed"
          ? "failed"
          : "interrupted";
    const updated: HostSubagentDelegationItem = {
      ...item,
      subagents: item.subagents.map((state) => ({ ...state, status })),
    };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: item.itemId,
      update: { type: "subagents.replace", subagents: updated.subagents },
    });
    this.#event({ type: "subagent.state.changed", nativeSubagentId: toolCallId, status });
    this.#completeItem(active, updated, outcome);
  }

  #appendAgentText(active: ActiveTurn, text: string): void {
    if (!text) return;
    if (!active.agentItem) {
      active.agentItem = { type: "agentMessage", itemId: this.#newItemId(), text };
      this.#event({ type: "item.started", turnId: active.command.turnId, item: active.agentItem });
      return;
    }
    active.agentItem = { ...active.agentItem, text: active.agentItem.text + text };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.agentItem.itemId,
      update: { type: "text.append", text },
    });
  }

  #closeAgentText(active: ActiveTurn): void {
    if (!active.agentItem) return;
    this.#completeItem(active, active.agentItem, { status: "succeeded" });
    active.agentItem = null;
  }

  #appendReasoning(active: ActiveTurn, text: string): void {
    if (!text) return;
    if (!active.reasoningItem) {
      this.#closeAgentText(active);
      active.reasoningItem = { type: "reasoning", itemId: this.#newItemId(), text };
      this.#event({
        type: "item.started",
        turnId: active.command.turnId,
        item: active.reasoningItem,
      });
      return;
    }
    active.reasoningItem = { ...active.reasoningItem, text: active.reasoningItem.text + text };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.reasoningItem.itemId,
      update: { type: "text.append", text },
    });
  }

  #closeReasoning(active: ActiveTurn): void {
    if (!active.reasoningItem) return;
    this.#completeItem(active, active.reasoningItem, { status: "succeeded" });
    active.reasoningItem = null;
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
    const itemOutcome: HostItemOutcome =
      outcome.status === "failed"
        ? { status: "failed", error: outcome.error }
        : outcome.status === "cancelled"
          ? { status: "cancelled", ...(outcome.reason ? { reason: outcome.reason } : {}) }
          : { status: "succeeded" };
    this.#closeReasoning(active);
    if (active.agentItem) {
      this.#completeItem(active, active.agentItem, itemOutcome);
      active.agentItem = null;
    }
    for (const entry of active.tools.values()) {
      if (!entry.started) this.#emitToolStart(active, entry);
      this.#completeItem(active, entry.item, itemOutcome);
    }
    active.tools.clear();
    for (const toolCallId of [...active.subagents.keys()]) {
      this.#stopSubagent(active, toolCallId, itemOutcome);
    }
    if (active.compactionItem) {
      this.#completeItem(active, active.compactionItem, itemOutcome);
      active.compactionItem = null;
    }
    if (active.runUsage) {
      this.#usage = accumulateCommandCodeUsage(this.#usage, active.runUsage);
      active.runUsage = null;
    }
    if (nativeTurnRef) {
      this.#turns.push({
        nativeTurnRef,
        ...(outcome.checkpoint ? { checkpoint: outcome.checkpoint } : {}),
        input: active.command.input,
        items: active.completedItems,
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
      new Promise<void>((resolve) => setTimeout(resolve, EXIT_GRACE_MS).unref?.()),
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

  #completeItem(active: ActiveTurn, item: HostItem, outcome: HostItemOutcome): void {
    const snapshot = { item, outcome } satisfies HostItemSnapshot;
    active.completedItems.push(snapshot);
    this.#event({ type: "item.completed", turnId: active.command.turnId, snapshot });
  }

  async #cancel(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    const active = this.#active;
    if (!active || active.command.turnId !== command.turnId) {
      return { ok: false, error: invalidState("Command Code Turn is not active") };
    }
    active.cancellationRequested = true;
    try {
      await active.process.stop();
    } catch (error) {
      this.#closed = true;
      return {
        ok: false,
        error: {
          code: "nativeFailure",
          message: `Command Code cancellation cleanup failed: ${errorMessage(error)}`,
          retryable: false,
        },
      };
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

  #selectThinking(command: ThinkingSelectCommand): HarnessResult<ThinkingSelectCompleted> {
    if (this.#active) return this.#busy();
    const requested = harnessThinkingOptionIdSchema.safeParse(command.thinkingOptionId);
    if (!requested.success || !isCommandCodeEffort(requested.data)) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Command Code effort must be low, medium or high",
          retryable: false,
        },
      };
    }
    this.#effort = requested.data;
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
      ...(this.#effort ? { effectiveThinkingOptionId: this.#effort } : {}),
      availableThinkingOptions: [...COMMAND_CODE_EFFORT_OPTIONS],
      effectivePermissionModeId: commandCodePermissionModeId(this.#permissionMode),
    };
  }

  #event(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }

  #newItemId(): HostItemId {
    return hostItemIdSchema.parse(randomUUID());
  }
}
