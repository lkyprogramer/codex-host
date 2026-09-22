/** Lifecycle phase of a Grok Session, owned together with its admission rules. */
export type GrokSessionPhase = "open" | "closing" | "closed" | "faulted";

export type GrokIdleAdmission = { status: "busy" | "unknown"; reason: string } | null;

/** Rejects idle suspension before any native process is touched. */
export function grokIdleSuspendAdmission(input: {
  aborted: boolean;
  phase: GrokSessionPhase;
  busy: boolean;
  verifiedTurns: number;
}): GrokIdleAdmission {
  if (input.aborted) {
    return { status: "unknown", reason: "Grok idle suspension was aborted" };
  }
  if (input.phase !== "open") {
    return { status: "unknown", reason: "Grok Session is closed or faulted" };
  }
  if (input.busy) {
    return {
      status: "busy",
      reason: "Grok Session still has native work or a background subagent",
    };
  }
  if (input.verifiedTurns < 1) {
    return { status: "unknown", reason: "Grok has not persisted this Native Session yet" };
  }
  return null;
}
