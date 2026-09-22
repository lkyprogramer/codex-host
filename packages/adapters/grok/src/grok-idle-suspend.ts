/** Lifecycle phase of a Grok Session, owned together with its admission rules. */
export type GrokSessionPhase = "open" | "closing" | "closed" | "faulted";

export type GrokIdleAdmission = { status: "busy" | "unknown"; reason: string } | null;

/** Rejects idle suspension before any native process is touched. */
export function grokIdleSuspendAdmission(input: {
  aborted: boolean;
  phase: GrokSessionPhase;
  activeTurn: boolean;
  configuring: boolean;
  backgroundSubagents: number;
  verifiedTurns: number;
}): GrokIdleAdmission {
  if (input.aborted) {
    return { status: "unknown", reason: "Grok idle suspension was aborted" };
  }
  if (input.phase !== "open") {
    return { status: "unknown", reason: "Grok Session is closed or faulted" };
  }
  // Each gate names itself: the Host logs this reason, and a Thread that never
  // suspends is only diagnosable if it says which native work held it open.
  if (input.activeTurn) {
    return { status: "busy", reason: "Grok Session still has an active Turn" };
  }
  if (input.configuring) {
    return { status: "busy", reason: "Grok Session is writing native configuration" };
  }
  if (input.backgroundSubagents > 0) {
    return {
      status: "busy",
      reason: `Grok Session still has ${input.backgroundSubagents} native background Subagent(s)`,
    };
  }
  if (input.verifiedTurns < 1) {
    return { status: "unknown", reason: "Grok has not persisted this Native Session yet" };
  }
  return null;
}
