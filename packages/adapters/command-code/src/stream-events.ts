/**
 * Command Code `-p --output-format json` protocol shapes.
 *
 * Print mode writes one NDJSON frame per line: `{"type":"event","event":<AgentEvent>}`
 * for each native AgentEvent, then exactly one `{"type":"result",...}` line before
 * the process exits. Event names and payload fields were taken from the CLI bundle
 * (1.58.0) and the documented headless reference; shapes that the real CLI has not
 * yet been observed to emit are decoded leniently and unknown events are ignored.
 */

export interface CommandCodeUsage {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
}

export interface CommandCodeRunStartEvent {
  type: "run_start";
  sessionId: string;
}

export interface CommandCodeTurnStartEvent {
  type: "turn_start";
  turnNumber: number;
}

export interface CommandCodeTurnEndEvent {
  type: "turn_end";
  turnNumber: number;
  hadToolCalls?: boolean;
  usage?: CommandCodeUsage;
}

export interface CommandCodeTextDeltaEvent {
  type: "text_delta";
  delta: string;
}

export interface CommandCodeThinkingEvent {
  type: "thinking_start" | "thinking_end";
}

export interface CommandCodeThinkingDeltaEvent {
  type: "thinking_delta";
  delta: string;
}

/** Tool call identity shared by every tool lifecycle frame. */
export interface CommandCodeToolEventBase {
  toolCallId: string;
  toolName: string;
}

export interface CommandCodeToolQueuedEvent extends CommandCodeToolEventBase {
  type: "tool_queued";
  input?: unknown;
}

export interface CommandCodeToolRunningEvent extends CommandCodeToolEventBase {
  type: "tool_running";
  description?: string;
}

export interface CommandCodeToolUpdateEvent extends CommandCodeToolEventBase {
  type: "tool_update";
  partial?: unknown;
}

export interface CommandCodeToolCompletedEvent extends CommandCodeToolEventBase {
  type: "tool_completed";
  /** Tool result content blocks (`{type:"text",text}` / `{type:"image",...}`). */
  result?: unknown;
}

export interface CommandCodeToolErroredEvent extends CommandCodeToolEventBase {
  type: "tool_errored";
  error?: unknown;
}

export interface CommandCodeToolDeniedEvent extends CommandCodeToolEventBase {
  type: "tool_denied";
}

export interface CommandCodeToolHookBlockedEvent extends CommandCodeToolEventBase {
  type: "tool_hook_blocked";
  hookOutput?: unknown;
}

export interface CommandCodeSubagentStartEvent {
  type: "subagent_start";
  toolCallId: string;
  subagentType?: string;
  description?: string;
  background?: boolean;
}

export interface CommandCodeSubagentProgressEvent {
  type: "subagent_progress";
  toolCallId: string;
  subagentType?: string;
  toolName?: string;
  tokensUsed?: number;
}

export interface CommandCodeSubagentStopEvent {
  type: "subagent_stop";
  toolCallId: string;
  subagentType?: string;
  tokensUsed?: number;
}

export interface CommandCodeCompactionEvent {
  type: "compaction_start" | "compaction_done";
  tokensSaved?: number;
}

export interface CommandCodeInterruptedEvent {
  type: "interrupted";
}

export interface CommandCodeRunErrorEvent {
  type: "run_error";
  error?: { name?: unknown; message?: unknown } | string;
}

export interface CommandCodeRunEndEvent {
  type: "run_end";
  result?: {
    finalText?: unknown;
    stopReason?: unknown;
    turnCount?: unknown;
    usage?: CommandCodeUsage;
  };
}

export interface CommandCodeNoticeEvent {
  type: "notice";
  level?: string;
  message?: string;
}

export type CommandCodeAgentEvent =
  | CommandCodeRunStartEvent
  | CommandCodeTurnStartEvent
  | CommandCodeTurnEndEvent
  | CommandCodeTextDeltaEvent
  | CommandCodeThinkingEvent
  | CommandCodeThinkingDeltaEvent
  | CommandCodeToolQueuedEvent
  | CommandCodeToolRunningEvent
  | CommandCodeToolUpdateEvent
  | CommandCodeToolCompletedEvent
  | CommandCodeToolErroredEvent
  | CommandCodeToolDeniedEvent
  | CommandCodeToolHookBlockedEvent
  | CommandCodeSubagentStartEvent
  | CommandCodeSubagentProgressEvent
  | CommandCodeSubagentStopEvent
  | CommandCodeCompactionEvent
  | CommandCodeInterruptedEvent
  | CommandCodeRunErrorEvent
  | CommandCodeRunEndEvent
  | CommandCodeNoticeEvent;

export type CommandCodeResultSubtype = "success" | "error" | "max_turns";

/** The final stdout line of a print run; `sessionId` is omitted on early failures. */
export interface CommandCodeResultLine {
  type: "result";
  subtype: CommandCodeResultSubtype;
  sessionId?: string;
  stopReason?: string;
  usage?: CommandCodeUsage;
  durationMs?: number;
  finalText?: string;
  error?: string;
}

export type CommandCodeStreamLine =
  { type: "event"; event: CommandCodeAgentEvent } | CommandCodeResultLine;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const TOOL_EVENT_TYPES = new Set([
  "tool_queued",
  "tool_running",
  "tool_update",
  "tool_completed",
  "tool_errored",
  "tool_denied",
  "tool_hook_blocked",
]);

const SUBAGENT_EVENT_TYPES = new Set(["subagent_start", "subagent_progress", "subagent_stop"]);

const PAYLOAD_FREE_EVENT_TYPES = new Set([
  "thinking_start",
  "thinking_end",
  "compaction_start",
  "compaction_done",
  "interrupted",
  "notice",
  "run_error",
  "run_end",
]);

function decodeAgentEvent(value: unknown): CommandCodeAgentEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const type = value.type;
  if (type === "run_start") {
    return nonEmptyString(value.sessionId) ? { type, sessionId: value.sessionId } : null;
  }
  if (type === "turn_start" || type === "turn_end") {
    return typeof value.turnNumber === "number"
      ? (value as unknown as CommandCodeTurnStartEvent | CommandCodeTurnEndEvent)
      : null;
  }
  if (type === "text_delta" || type === "thinking_delta") {
    return typeof value.delta === "string"
      ? (value as unknown as CommandCodeTextDeltaEvent | CommandCodeThinkingDeltaEvent)
      : null;
  }
  if (TOOL_EVENT_TYPES.has(type)) {
    return nonEmptyString(value.toolCallId) && typeof value.toolName === "string"
      ? (value as unknown as CommandCodeAgentEvent)
      : null;
  }
  if (SUBAGENT_EVENT_TYPES.has(type)) {
    return nonEmptyString(value.toolCallId) ? (value as unknown as CommandCodeAgentEvent) : null;
  }
  if (PAYLOAD_FREE_EVENT_TYPES.has(type)) return value as unknown as CommandCodeAgentEvent;
  return null;
}

function decodeResultLine(value: Record<string, unknown>): CommandCodeResultLine | null {
  const subtype = value.subtype;
  if (subtype !== "success" && subtype !== "error" && subtype !== "max_turns") return null;
  return {
    type: "result",
    subtype,
    ...(nonEmptyString(value.sessionId) ? { sessionId: value.sessionId } : {}),
    ...(typeof value.stopReason === "string" ? { stopReason: value.stopReason } : {}),
    ...(isRecord(value.usage) ? { usage: value.usage as CommandCodeUsage } : {}),
    ...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}),
    ...(typeof value.finalText === "string" ? { finalText: value.finalText } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

/** Returns null for blank lines, non-JSON diagnostics and frames this Adapter does not model. */
export function parseCommandCodeStreamLine(line: string): CommandCodeStreamLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.type === "result") return decodeResultLine(parsed);
  if (parsed.type !== "event") return null;
  const event = decodeAgentEvent(parsed.event);
  return event ? { type: "event", event } : null;
}

/** Reads the human-readable message from a `run_error` payload or a tool error. */
export function commandCodeErrorMessage(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!isRecord(value)) return null;
  const message = value.message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}
