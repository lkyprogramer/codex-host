/**
 * Projects one print run's AgentEvents into Host Items. The projection owns
 * every open Item of the Turn and knows nothing about the process, identity
 * or terminal decision; the Session drives it and closes it with the Turn's
 * outcome so no Item is left open.
 */
import { randomUUID } from "node:crypto";

import type {
  HarnessError,
  HostAgentMessageItem,
  HostEvent,
  HostItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostReasoningItem,
  HostSubagentDelegationItem,
} from "@codexhost/harness-adapter";
import { hostItemIdSchema, type HostItemId, type HostTurnId } from "@codexhost/shared-contracts";

import {
  commandCodeToolTargetFile,
  completeCommandCodeToolItem,
  isCommandCodeFileMutatingTool,
  resolveCommandCodeFileChange,
  snapshotCommandCodeFile,
  startCommandCodeToolItem,
  type CommandCodeMutation,
} from "./tool-projection.js";

interface ToolEntry {
  item: Extract<HostItem, { type: "commandExecution" | "toolExecution" }>;
  /** Deferred File Change: resolved once the tool reports completion. */
  mutation: CommandCodeMutation | null;
  started: boolean;
}

export class CommandCodeTurnProjection {
  readonly completedItems: HostItemSnapshot[] = [];
  /** Whether the run streamed any assistant text; decides if `finalText` is a fallback or a duplicate. */
  sawText = false;
  readonly #cwd: string;
  readonly #emit: (event: HostEvent) => void;
  readonly #toolOutputLimit: number;
  readonly #turnId: HostTurnId;
  readonly #tools = new Map<string, ToolEntry>();
  readonly #subagents = new Map<string, HostSubagentDelegationItem>();
  #agentItem: HostAgentMessageItem | null = null;
  #reasoningItem: HostReasoningItem | null = null;
  #compactionItem: HostItem | null = null;
  #closed = false;

  constructor(input: {
    turnId: HostTurnId;
    cwd: string;
    toolOutputLimit: number;
    emit(event: HostEvent): void;
  }) {
    this.#turnId = input.turnId;
    this.#cwd = input.cwd;
    this.#toolOutputLimit = input.toolOutputLimit;
    this.#emit = input.emit;
  }

  appendText(text: string): void {
    if (this.#closed || !text) return;
    this.sawText = true;
    this.closeReasoning();
    if (!this.#agentItem) {
      this.#agentItem = { type: "agentMessage", itemId: this.#newItemId(), text };
      this.#emit({ type: "item.started", turnId: this.#turnId, item: this.#agentItem });
      return;
    }
    this.#agentItem = { ...this.#agentItem, text: this.#agentItem.text + text };
    this.#emit({
      type: "item.updated",
      turnId: this.#turnId,
      itemId: this.#agentItem.itemId,
      update: { type: "text.append", text },
    });
  }

  /** The final answer echoed by the result line, used only when nothing streamed. */
  appendFinalText(text: string): void {
    if (this.sawText || !text.trim()) return;
    this.appendText(text);
  }

  appendReasoning(text: string): void {
    if (this.#closed || !text) return;
    if (!this.#reasoningItem) {
      this.#closeAgentText();
      this.#reasoningItem = { type: "reasoning", itemId: this.#newItemId(), text };
      this.#emit({ type: "item.started", turnId: this.#turnId, item: this.#reasoningItem });
      return;
    }
    this.#reasoningItem = { ...this.#reasoningItem, text: this.#reasoningItem.text + text };
    this.#emit({
      type: "item.updated",
      turnId: this.#turnId,
      itemId: this.#reasoningItem.itemId,
      update: { type: "text.append", text },
    });
  }

  closeReasoning(): void {
    if (!this.#reasoningItem) return;
    this.#completeItem(this.#reasoningItem, { status: "succeeded" });
    this.#reasoningItem = null;
  }

  openTool(toolCallId: string, toolName: string, input: unknown): void {
    if (this.#closed) return;
    const existing = this.#tools.get(toolCallId);
    if (existing) return;
    this.closeReasoning();
    this.#closeAgentText();
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
    this.#tools.set(toolCallId, entry);
    // A file edit only becomes a File Change once its patch is known; until
    // then it stays uncarded rather than showing an empty diff.
    if (!entry.mutation) this.#emitToolStart(entry);
  }

  async finishTool(
    toolCallId: string,
    toolName: string,
    result: unknown,
    error: HarnessError | null,
  ): Promise<void> {
    if (this.#closed) return;
    let entry = this.#tools.get(toolCallId);
    if (!entry) {
      this.openTool(toolCallId, toolName, undefined);
      entry = this.#tools.get(toolCallId);
      if (!entry) return;
    }
    this.#tools.delete(toolCallId);
    const outcome: HostItemOutcome = error ? { status: "failed", error } : { status: "succeeded" };
    if (entry.mutation && !error) {
      const change = await resolveCommandCodeFileChange(entry.mutation);
      if (this.#closed) return;
      if (change) {
        const item: HostItem = { type: "fileChange", itemId: entry.item.itemId, changes: [change] };
        this.#emit({ type: "item.started", turnId: this.#turnId, item });
        this.#completeItem(item, outcome);
        return;
      }
    }
    if (!entry.started) this.#emitToolStart(entry);
    this.#completeItem(
      completeCommandCodeToolItem(entry.item, result, this.#toolOutputLimit),
      outcome,
    );
  }

  startSubagent(toolCallId: string, description: string, background: boolean): void {
    if (this.#closed || this.#subagents.has(toolCallId)) return;
    this.#closeAgentText();
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
    this.#subagents.set(toolCallId, item);
    this.#emit({ type: "item.started", turnId: this.#turnId, item });
    this.#emit({ type: "subagent.state.changed", nativeSubagentId: toolCallId, status: "running" });
  }

  stopSubagent(toolCallId: string, outcome: HostItemOutcome): void {
    const item = this.#subagents.get(toolCallId);
    if (!item) return;
    this.#subagents.delete(toolCallId);
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
    this.#emit({
      type: "item.updated",
      turnId: this.#turnId,
      itemId: item.itemId,
      update: { type: "subagents.replace", subagents: updated.subagents },
    });
    this.#emit({ type: "subagent.state.changed", nativeSubagentId: toolCallId, status });
    this.#completeItem(updated, outcome);
  }

  startCompaction(): void {
    if (this.#closed || this.#compactionItem) return;
    this.#closeAgentText();
    this.#compactionItem = { type: "contextCompaction", itemId: this.#newItemId() };
    this.#emit({ type: "item.started", turnId: this.#turnId, item: this.#compactionItem });
  }

  endCompaction(): void {
    if (!this.#compactionItem) return;
    this.#completeItem(this.#compactionItem, { status: "succeeded" });
    this.#compactionItem = null;
  }

  /** Closes every open Item with the Turn's outcome; idempotent. */
  finish(outcome: HostItemOutcome): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#reasoningItem) {
      this.#completeItem(this.#reasoningItem, { status: "succeeded" });
      this.#reasoningItem = null;
    }
    if (this.#agentItem) {
      this.#completeItem(this.#agentItem, outcome);
      this.#agentItem = null;
    }
    for (const entry of this.#tools.values()) {
      if (!entry.started) this.#emitToolStart(entry);
      this.#completeItem(entry.item, outcome);
    }
    this.#tools.clear();
    for (const toolCallId of [...this.#subagents.keys()]) this.stopSubagent(toolCallId, outcome);
    if (this.#compactionItem) {
      this.#completeItem(this.#compactionItem, outcome);
      this.#compactionItem = null;
    }
  }

  #closeAgentText(): void {
    if (!this.#agentItem) return;
    this.#completeItem(this.#agentItem, { status: "succeeded" });
    this.#agentItem = null;
  }

  #emitToolStart(entry: ToolEntry): void {
    entry.started = true;
    this.#emit({ type: "item.started", turnId: this.#turnId, item: entry.item });
  }

  #completeItem(item: HostItem, outcome: HostItemOutcome): void {
    const snapshot = { item, outcome } satisfies HostItemSnapshot;
    this.completedItems.push(snapshot);
    this.#emit({ type: "item.completed", turnId: this.#turnId, snapshot });
  }

  #newItemId(): HostItemId {
    return hostItemIdSchema.parse(randomUUID());
  }
}
