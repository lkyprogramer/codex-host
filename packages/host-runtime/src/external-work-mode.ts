import type { HarnessSession, HarnessWorkMode } from "@codexhost/harness-adapter";
import type { JsonObject } from "@codexhost/protocol-core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requestedWorkMode(params: JsonObject): HarnessWorkMode | undefined {
  const collaboration = params.collaborationMode;
  if (!isRecord(collaboration) || typeof collaboration.mode !== "string") return undefined;
  const mode = collaboration.mode.trim().toLowerCase();
  if (mode.length === 0) return undefined;
  if (mode === "plan" || mode === "planning") return "plan";
  if (mode === "default") return "default";
  return undefined;
}

export async function applyRequestedWorkMode(
  session: HarnessSession,
  workMode: HarnessWorkMode | undefined,
): Promise<void> {
  if (workMode === undefined) return;
  const control = session.workMode;
  if (workMode === "plan" && !control) {
    throw new Error("Planning mode is unavailable for this Harness");
  }
  if (!control || control.current === workMode) return;
  const result = await control.set(workMode);
  if (!result.ok) throw new Error(result.error.message);
}
