import type {
  HostAgentMessageItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostReasoningItem,
  HostThreadSnapshot,
  HostItem,
  HostToolOutput,
  HostFileChange,
  HistoricalTurnOutcome,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  jsonValueSchema,
  nativeCheckpointRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type HarnessModelRef,
  type HostItemId,
  type JsonObject,
  type JsonValue,
  type NativeCheckpointRef,
} from "@codexhost/shared-contracts";

import type { PiFamilyNativeModelRef } from "./model-catalog.js";

export interface PiFamilySessionHistory {
  entries: JsonObject[];
  leafId: string | null;
}

export interface PiFamilyHistoryState {
  sessionId: string;
  model: PiFamilyNativeModelRef | null;
  cwd?: string;
}

export interface PiFamilyEntry extends JsonObject {
  id: string;
  parentId: string | null;
  type: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text of a Pi-family message content value. */
export function piFamilyTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter(
      (part): part is Record<string, unknown> =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("");
}

function thinkingContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter(
      (part): part is Record<string, unknown> =>
        isRecord(part) && part.type === "thinking" && typeof part.thinking === "string",
    )
    .map((part) => part.thinking as string)
    .join("");
}

/** What distinguishes one Pi-family Harness's history. */
export interface PiFamilyHistory {
  readonly harnessId: HarnessId;
  /** Names the Harness in errors and outcomes, for example "Pi". */
  readonly label: string;
  /** Prefix of persisted history item ids, for example "pi-item-v1". */
  readonly itemIdPrefix: string;
  encodeModelRef(model: PiFamilyNativeModelRef): HarnessModelRef;
  /** The Host item for a completed tool call and its native output. */
  toolItem(
    call: { itemId: HostItemId; toolName: string; arguments: JsonValue },
    output: HostToolOutput | undefined,
  ): HostItem;
  /** Project only file changes backed by a successful persisted native result. */
  fileChanges?(
    call: { toolName: string; arguments: JsonValue },
    nativeMessage: Record<string, unknown>,
    cwd: string,
  ): HostFileChange[] | null;
}

/** History mapping every Pi-family Harness shares: branches, Turns, items, boundaries. */
export function createPiFamilyHistory(family: PiFamilyHistory) {
  function validatedEntry(value: JsonObject): PiFamilyEntry {
    if (
      typeof value.id !== "string" ||
      value.id.length === 0 ||
      (value.parentId !== null && typeof value.parentId !== "string") ||
      typeof value.type !== "string"
    ) {
      throw new Error(`${family.label} history contains an invalid Entry identity`);
    }
    return value as PiFamilyEntry;
  }

  function activeEntries(history: PiFamilySessionHistory): PiFamilyEntry[] {
    if (history.leafId === null) return [];
    const byId = new Map(
      history.entries.map((value) => {
        const entry = validatedEntry(value);
        return [entry.id, entry] as const;
      }),
    );
    const reversed: PiFamilyEntry[] = [];
    const visited = new Set<string>();
    let current: string | null = history.leafId;
    while (current !== null) {
      if (visited.has(current))
        throw new Error(`${family.label} history active branch contains a cycle`);
      visited.add(current);
      const entry = byId.get(current);
      if (!entry)
        throw new Error(`${family.label} history active branch references a missing Entry`);
      reversed.push(entry);
      current = entry.parentId;
    }
    return reversed.reverse();
  }

  function message(entry: PiFamilyEntry): Record<string, unknown> | null {
    return entry.type === "message" && isRecord(entry.message) ? entry.message : null;
  }

  function messageRole(entry: PiFamilyEntry): string | null {
    const value = message(entry)?.role;
    return typeof value === "string" ? value : null;
  }

  function itemId(entryId: string, kind: string, ordinal: number) {
    return hostItemIdSchema.parse(`${family.itemIdPrefix}-${entryId}-${kind}-${ordinal}`);
  }

  function assistantOutcome(entries: PiFamilyEntry[]): HistoricalTurnOutcome {
    const assistants = entries
      .map((entry) => message(entry))
      .filter((value): value is Record<string, unknown> => value?.role === "assistant");
    const final = assistants.at(-1);
    if (!final)
      return { status: "unknown", reason: `${family.label} history has no Assistant terminal` };
    const stopReason = final.stopReason;
    if (stopReason === "aborted") {
      return { status: "cancelled", reason: `${family.label} Assistant was aborted` };
    }
    if (stopReason === "error") {
      return {
        status: "failed",
        error: {
          code: "nativeFailure",
          message:
            typeof final.errorMessage === "string" && final.errorMessage.length > 0
              ? final.errorMessage
              : `${family.label} Assistant failed`,
          retryable: false,
        },
      };
    }
    if (typeof stopReason === "string" || piFamilyTextContent(final.content).length > 0) {
      return { status: "succeeded" };
    }
    return { status: "unknown", reason: `${family.label} Assistant terminal is not classifiable` };
  }

  function itemOutcome(outcome: HistoricalTurnOutcome): HostItemOutcome {
    if (outcome.status === "failed") return { status: "failed", error: outcome.error };
    if (outcome.status === "cancelled") {
      return {
        status: "cancelled",
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      };
    }
    return { status: "succeeded" };
  }

  function toolOutput(value: unknown): HostToolOutput | undefined {
    const text = piFamilyTextContent(value);
    return text.length > 0 ? { content: [{ type: "text", text }] } : undefined;
  }

  function snapshotItems(
    entries: PiFamilyEntry[],
    outcome: HistoricalTurnOutcome,
    cwd?: string,
  ): HostItemSnapshot[] {
    const snapshots: HostItemSnapshot[] = [];
    const toolCalls = new Map<
      string,
      { entryId: string; ordinal: number; name: string; arguments: JsonValue }
    >();
    for (const entry of entries) {
      const nativeMessage = message(entry);
      if (!nativeMessage) continue;
      const content = Array.isArray(nativeMessage.content) ? nativeMessage.content : [];
      if (nativeMessage.role === "assistant") {
        const text = piFamilyTextContent(content);
        const reasoning = thinkingContent(content);
        let projectedText = false;
        let projectedReasoning = false;
        for (const [ordinal, part] of content.entries()) {
          if (!isRecord(part)) continue;
          if (part.type === "thinking" && !projectedReasoning && reasoning.length > 0) {
            const item: HostReasoningItem = {
              type: "reasoning",
              itemId: itemId(entry.id, "reasoning", 0),
              text: reasoning,
            };
            snapshots.push({ item, outcome: itemOutcome(outcome) });
            projectedReasoning = true;
            continue;
          }
          if (part.type === "text" && !projectedText && text.length > 0) {
            const item: HostAgentMessageItem = {
              type: "agentMessage",
              itemId: itemId(entry.id, "assistant", 0),
              text,
            };
            snapshots.push({ item, outcome: itemOutcome(outcome) });
            projectedText = true;
            continue;
          }
          if (
            part.type !== "toolCall" ||
            typeof part.id !== "string" ||
            typeof part.name !== "string"
          ) {
            continue;
          }
          const parsedArguments = jsonValueSchema.safeParse(part.arguments);
          if (!parsedArguments.success) continue;
          toolCalls.set(part.id, {
            entryId: entry.id,
            ordinal,
            name: part.name,
            arguments: parsedArguments.data,
          });
        }
        continue;
      }
      if (
        nativeMessage.role !== "toolResult" ||
        typeof nativeMessage.toolCallId !== "string" ||
        typeof nativeMessage.toolName !== "string"
      ) {
        continue;
      }
      const call = toolCalls.get(nativeMessage.toolCallId);
      if (!call || call.name !== nativeMessage.toolName) continue;
      const output = toolOutput(nativeMessage.content);
      const item = family.toolItem(
        {
          itemId: itemId(call.entryId, "tool", call.ordinal),
          toolName: call.name,
          arguments: call.arguments,
        },
        output,
      );
      const toolSucceeded = nativeMessage.isError === false;
      snapshots.push({
        item,
        outcome: toolSucceeded
          ? { status: "succeeded" }
          : {
              status: "failed",
              error: {
                code: "nativeFailure",
                message: `${family.label} Tool '${call.name}' failed`,
                retryable: false,
              },
            },
      });
      if (toolSucceeded && cwd) {
        const changes = family.fileChanges?.(
          { toolName: call.name, arguments: call.arguments },
          nativeMessage,
          cwd,
        );
        if (changes?.length) {
          snapshots.push({
            item: {
              type: "fileChange",
              itemId: itemId(entry.id, "file-change", 0),
              sourceItemIds: [item.itemId],
              changes,
            },
            outcome: { status: "succeeded" },
          });
        }
      }
    }
    return snapshots;
  }

  function modelChange(entry: PiFamilyEntry): PiFamilyNativeModelRef | null {
    return entry.type === "model_change" &&
      typeof entry.provider === "string" &&
      typeof entry.modelId === "string"
      ? { provider: entry.provider, id: entry.modelId }
      : null;
  }

  function mapSnapshot(
    history: PiFamilySessionHistory,
    state: PiFamilyHistoryState,
  ): HostThreadSnapshot {
    const active = activeEntries(history);
    const turns: HostThreadSnapshot["turns"] = [];
    let effectiveModel = state.model;
    for (let index = 0; index < active.length;) {
      const model = modelChange(active[index] as PiFamilyEntry);
      if (model) {
        effectiveModel = model;
        index += 1;
        continue;
      }
      const user = active[index] as PiFamilyEntry;
      if (messageRole(user) !== "user") {
        index += 1;
        continue;
      }
      let end = index + 1;
      while (end < active.length && messageRole(active[end] as PiFamilyEntry) !== "user") end += 1;
      const entries = active.slice(index, end);
      const outcome = assistantOutcome(entries);
      const userText = piFamilyTextContent(message(user)?.content);
      const nativeTurnRef = nativeTurnRefSchema.parse({
        harnessId: family.harnessId,
        nativeSessionId: state.sessionId,
        nativeTurnKey: user.id,
        formatVersion: 1,
      });
      const checkpoint = nativeCheckpointRefSchema.parse({
        harnessId: family.harnessId,
        nativeSessionId: state.sessionId,
        checkpointId: user.id,
        formatVersion: 1,
      }) as NativeCheckpointRef;
      turns.push({
        nativeTurnRef,
        checkpoint,
        input: [{ type: "text", text: userText }],
        items: snapshotItems(entries, outcome, state.cwd),
        outcome,
        ...(effectiveModel ? { model: family.encodeModelRef(effectiveModel) } : {}),
      });
      for (const entry of entries) {
        const changed = modelChange(entry);
        if (changed) effectiveModel = changed;
      }
      index = end;
    }
    return { turns };
  }

  function resolveLastTurnBoundary(
    history: PiFamilySessionHistory,
  ): { lastUserEntryId: string; sourceTurnCount: number } | null {
    const users = activeEntries(history).filter((entry) => messageRole(entry) === "user");
    const last = users.at(-1);
    return last ? { lastUserEntryId: last.id, sourceTurnCount: users.length } : null;
  }

  function resolveForkBoundary(
    history: PiFamilySessionHistory,
    checkpointId: string,
  ): { targetTurnIndex: number; nextUserEntryId: string | null } {
    const active = activeEntries(history);
    const users = active.filter((entry) => messageRole(entry) === "user");
    const targetTurnIndex = users.findIndex((entry) => entry.id === checkpointId);
    if (targetTurnIndex < 0)
      throw new Error(`${family.label} Checkpoint is not on the active branch`);
    return {
      targetTurnIndex,
      nextUserEntryId: users[targetTurnIndex + 1]?.id ?? null,
    };
  }

  return { activeEntries, mapSnapshot, resolveLastTurnBoundary, resolveForkBoundary };
}
