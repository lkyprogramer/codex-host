import type { HostUsage } from "@codexhost/harness-adapter";

import type { CommandCodeUsage } from "./stream-events.js";

function safeToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Print mode reports token counters only; it does not expose the Model's
 * context window, so no context usage is derived.
 */
export function commandCodeHostUsage(value: CommandCodeUsage | undefined): HostUsage | null {
  if (!value) return null;
  const inputTokens = safeToken(value.inputTokens);
  const outputTokens = safeToken(value.outputTokens);
  const cachedInputTokens = safeToken(value.cacheReadTokens);
  const cacheWriteInputTokens = safeToken(value.cacheWriteTokens);
  const usage: HostUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
    ...(inputTokens !== undefined && outputTokens !== undefined
      ? { totalTokens: inputTokens + outputTokens }
      : {}),
  };
  return Object.keys(usage).length > 0 ? usage : null;
}

/** Turn counters accumulate across a Session; a later reading replaces the earlier one. */
export function accumulateCommandCodeUsage(
  previous: HostUsage | null,
  latest: HostUsage,
): HostUsage {
  const add = (key: keyof HostUsage): number | undefined => {
    const a = previous?.[key];
    const b = latest[key];
    if (a === undefined && b === undefined) return undefined;
    return (a ?? 0) + (b ?? 0);
  };
  const inputTokens = add("inputTokens");
  const outputTokens = add("outputTokens");
  const cachedInputTokens = add("cachedInputTokens");
  const cacheWriteInputTokens = add("cacheWriteInputTokens");
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
    ...(inputTokens !== undefined && outputTokens !== undefined
      ? { totalTokens: inputTokens + outputTokens }
      : {}),
  };
}
