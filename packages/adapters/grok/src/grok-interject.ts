export const GROK_INTERJECT_METHOD = "_x.ai/interject";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseGrokInterjectResponse(raw: unknown): { queued: boolean } | null {
  const payload = isRecord(raw) && "result" in raw && isRecord(raw.result) ? raw.result : raw;
  if (!isRecord(payload)) return null;
  if (payload.status === "queued" || payload.queued === true) return { queued: true };
  if (payload.status === "rejected" || payload.queued === false) return { queued: false };
  return null;
}
