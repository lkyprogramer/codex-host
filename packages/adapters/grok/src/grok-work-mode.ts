import type { HarnessWorkMode } from "@codexhost/harness-adapter";

export interface GrokNativeMode {
  id: string;
  name: string;
}

export interface GrokSessionModes {
  currentModeId: string | null;
  availableModes: GrokNativeMode[];
}

/** Grok ACP session/new does not send `modes`; these are the native session/set_mode ids. */
export const GROK_NATIVE_WORK_MODES: readonly GrokNativeMode[] = [
  { id: "default", name: "Default" },
  { id: "plan", name: "Plan" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAcpCurrentModeId(session: unknown): string | null {
  if (!isRecord(session) || !isRecord(session.modes)) return null;
  const currentModeId = session.modes.currentModeId;
  return typeof currentModeId === "string" && currentModeId.length > 0 ? currentModeId : null;
}

export function parseAcpAvailableModes(session: unknown): GrokNativeMode[] | null {
  if (
    !isRecord(session) ||
    !isRecord(session.modes) ||
    !Array.isArray(session.modes.availableModes)
  ) {
    return null;
  }
  const availableModes: GrokNativeMode[] = [];
  for (const entry of session.modes.availableModes) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) continue;
    const name = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id;
    availableModes.push({ id: entry.id, name });
  }
  return availableModes.length > 0 ? availableModes : null;
}

export function parseAcpSessionModes(session: unknown): GrokSessionModes | null {
  const currentModeId = parseAcpCurrentModeId(session);
  const availableModes = parseAcpAvailableModes(session);
  if (!currentModeId || !availableModes) return null;
  return { currentModeId, availableModes };
}

export function lastModeIdFromEvents(
  events: readonly { type: string; modeId?: string }[],
): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.type === "mode.update" &&
      typeof event.modeId === "string" &&
      event.modeId.length > 0
    ) {
      return event.modeId;
    }
  }
  return null;
}

export function grokSessionModesOrNative(
  session: unknown,
  options: { restore?: boolean; events?: readonly { type: string; modeId?: string }[] } = {},
): GrokSessionModes {
  const parsed = parseAcpSessionModes(session);
  const availableModes = parsed?.availableModes ??
    parseAcpAvailableModes(session) ?? [...GROK_NATIVE_WORK_MODES];
  const currentModeId =
    parsed?.currentModeId ??
    parseAcpCurrentModeId(session) ??
    lastModeIdFromEvents(options.events ?? []) ??
    (options.restore ? null : (GROK_NATIVE_WORK_MODES[0]?.id ?? null));
  return { currentModeId, availableModes };
}

export function isPlanNativeMode(mode: GrokNativeMode): boolean {
  return /\bplan\b/iu.test(mode.id) || /\bplan\b/iu.test(mode.name);
}

const DEFAULT_MODE_IDS = new Set(["default", "code", "agent", "normal", "build", "execute"]);

export function hostWorkModeForNativeId(
  available: readonly GrokNativeMode[],
  modeId: string | null | undefined,
): HarnessWorkMode | null {
  if (!modeId) return null;
  const mode = available.find((entry) => entry.id === modeId) ?? { id: modeId, name: modeId };
  if (isPlanNativeMode(mode)) return "plan";
  if (
    DEFAULT_MODE_IDS.has(mode.id.toLowerCase()) ||
    available.some((entry) => entry.id === modeId)
  ) {
    return "default";
  }
  return null;
}

export function nativeModeIdForHostWorkMode(
  available: readonly GrokNativeMode[],
  workMode: HarnessWorkMode,
): string | undefined {
  if (workMode === "plan") {
    return available.find((mode) => isPlanNativeMode(mode))?.id;
  }
  return (
    available.find((mode) => DEFAULT_MODE_IDS.has(mode.id.toLowerCase()))?.id ??
    available.find((mode) => !isPlanNativeMode(mode))?.id
  );
}
