import type { HarnessWorkLevel } from "@codexhost/harness-adapter";

/**
 * The native work that keeps a Grok Session from releasing. Each gate names
 * itself: the Host logs this reason, and a Thread that never releases is only
 * diagnosable if it says which native work held it open.
 */
export function grokWorkLevel(input: {
  activeTurn: boolean;
  configuring: boolean;
  backgroundSubagents: number;
}): HarnessWorkLevel {
  if (input.activeTurn) return { level: "busy", reason: "Grok Session still has an active Turn" };
  if (input.configuring) {
    return { level: "busy", reason: "Grok Session is writing native configuration" };
  }
  if (input.backgroundSubagents > 0) {
    return {
      level: "busy",
      reason: `Grok Session still has ${input.backgroundSubagents} native background Subagent(s)`,
    };
  }
  return { level: "idle" };
}

/** A Session Grok has not persisted yet cannot be resumed after a release. */
export function grokReleaseUndecided(verifiedTurns: number): string | null {
  return verifiedTurns < 1 ? "Grok has not persisted this Native Session yet" : null;
}
