import type { ChildProcessWithoutNullStreams } from "node:child_process";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolves once the leader exits, or after `timeoutMs` when it does not. */
export function waitForLeaderExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      child.removeListener("exit", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once("exit", finish);
  });
}

export function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function assistantText(value: unknown): string | null {
  if (!isRecord(value) || value.role !== "assistant" || !Array.isArray(value.content)) return null;
  return value.content
    .filter(
      (content): content is Record<string, unknown> =>
        isRecord(content) && content.type === "text" && typeof content.text === "string",
    )
    .map((content) => content.text as string)
    .join("");
}

export function assistantMessageId(value: unknown): string | null {
  if (!isRecord(value) || value.role !== "assistant") return null;
  return nonBlankString(value.responseId) ? value.responseId : null;
}

export function extractReasoningText(content: unknown): string | null {
  if (!isRecord(content)) return null;
  const type = String(content.type ?? "");
  if (type === "thinking" || type === "reasoning" || type === "thought") {
    const text = content.thinking ?? content.reasoning ?? content.text ?? content.delta;
    return typeof text === "string" ? text : null;
  }
  return null;
}

export function assistantReasoning(value: unknown): string | null {
  if (!isRecord(value) || value.role !== "assistant" || !Array.isArray(value.content)) return null;
  return value.content
    .map(extractReasoningText)
    .filter((text): text is string => typeof text === "string")
    .join("");
}
