import type { NativeSessionRef, NativeTurnRef } from "@codexhost/shared-contracts";

import type { HarnessSessionCapabilities } from "./text-session.js";

export type ConformanceScenarioStatus = "passed" | "skipped" | "notCovered" | "failed";
export type ConformanceCleanupOutcome = "passed" | "failed" | "notAttempted";

export interface ConformanceScenarioReceipt {
  readonly status: ConformanceScenarioStatus;
  readonly detail?: string;
  readonly failure?: {
    readonly code: "CONFORMANCE_ASSERTION_FAILED" | "CONFORMANCE_CLEANUP_FAILED";
    readonly reason: string;
  };
}

export interface ConformanceReceipt {
  readonly formatVersion: 1;
  readonly status: "passed" | "incomplete" | "failed";
  readonly harnessId: string;
  readonly hostSha: string | null;
  readonly pluginBundleSha256: string | null;
  readonly nativeVersion: string | null;
  readonly platform: string;
  readonly mode: string;
  readonly capabilities: HarnessSessionCapabilities | null;
  readonly inspectionCapabilities: HarnessSessionCapabilities | null;
  readonly scenarios: Readonly<Record<string, ConformanceScenarioReceipt>>;
  readonly identityReadback: {
    readonly createdSession: NativeSessionRef | null;
    readonly resumedSession: NativeSessionRef | null;
    readonly terminalTurns: readonly NativeTurnRef[];
  };
  readonly environment: {
    readonly primaryKeys: readonly string[];
    readonly isolatedKeys: readonly string[];
    readonly resumeKeys: readonly string[];
    readonly nativeActivation: "executed" | "notRequested" | "failed";
    readonly nativeIsolationReadback: "passed" | "notCovered" | "failed";
  };
  readonly cleanup: {
    readonly sessionClose: ConformanceCleanupOutcome;
    readonly adapterClose: ConformanceCleanupOutcome;
    readonly outputTermination: ConformanceCleanupOutcome;
    readonly nativeReadback: "passed" | "notCovered" | "failed";
    readonly residue: "none" | "unknown" | "present";
    readonly resources: {
      readonly primarySession: ConformanceCleanupOutcome;
      readonly isolatedSession: ConformanceCleanupOutcome;
      readonly resumedSession: ConformanceCleanupOutcome;
      readonly primaryAdapter: ConformanceCleanupOutcome;
      readonly resumedAdapter: ConformanceCleanupOutcome;
      readonly primaryOutput: ConformanceCleanupOutcome;
      readonly isolatedOutput: ConformanceCleanupOutcome;
      readonly resumedOutput: ConformanceCleanupOutcome;
    };
  };
}

export interface ConformanceEvidence {
  readonly hostSha: string | null;
  readonly pluginBundleSha256: string | null;
  readonly nativeVersion: string | null;
  readonly platform: string;
  readonly mode: string;
}

export interface ConformancePrompts {
  readonly first: string;
  readonly cancellable: string;
  readonly followup: string;
}

export interface ConformanceEnvironment {
  readonly primary: Readonly<Record<string, string | undefined>>;
  readonly isolated: Readonly<Record<string, string | undefined>>;
  readonly resume: Readonly<Record<string, string | undefined>>;
}

export interface ConformanceCleanupReadback {
  readonly residue: "none" | "unknown" | "present";
}

export interface MutableConformanceCleanup {
  sessionClose: ConformanceCleanupOutcome;
  adapterClose: ConformanceCleanupOutcome;
  outputTermination: ConformanceCleanupOutcome;
  nativeReadback: "passed" | "notCovered" | "failed";
  residue: "none" | "unknown" | "present";
  resources: {
    primarySession: ConformanceCleanupOutcome;
    isolatedSession: ConformanceCleanupOutcome;
    resumedSession: ConformanceCleanupOutcome;
    primaryAdapter: ConformanceCleanupOutcome;
    resumedAdapter: ConformanceCleanupOutcome;
    primaryOutput: ConformanceCleanupOutcome;
    isolatedOutput: ConformanceCleanupOutcome;
    resumedOutput: ConformanceCleanupOutcome;
  };
}

export function createConformanceCleanup(): MutableConformanceCleanup {
  return {
    sessionClose: "notAttempted",
    adapterClose: "notAttempted",
    outputTermination: "notAttempted",
    nativeReadback: "notCovered",
    residue: "unknown",
    resources: {
      primarySession: "notAttempted",
      isolatedSession: "notAttempted",
      resumedSession: "notAttempted",
      primaryAdapter: "notAttempted",
      resumedAdapter: "notAttempted",
      primaryOutput: "notAttempted",
      isolatedOutput: "notAttempted",
      resumedOutput: "notAttempted",
    },
  };
}

function aggregate(values: readonly ConformanceCleanupOutcome[]): ConformanceCleanupOutcome {
  const attempted = values.filter((value) => value !== "notAttempted");
  if (!attempted.length) return "notAttempted";
  return attempted.includes("failed") ? "failed" : "passed";
}

export function updateConformanceCleanupTotals(cleanup: MutableConformanceCleanup) {
  cleanup.sessionClose = aggregate([
    cleanup.resources.primarySession,
    cleanup.resources.isolatedSession,
    cleanup.resources.resumedSession,
  ]);
  cleanup.adapterClose = aggregate([
    cleanup.resources.primaryAdapter,
    cleanup.resources.resumedAdapter,
  ]);
  cleanup.outputTermination = aggregate([
    cleanup.resources.primaryOutput,
    cleanup.resources.isolatedOutput,
    cleanup.resources.resumedOutput,
  ]);
}

export function conformanceCleanupFailed(cleanup: MutableConformanceCleanup): boolean {
  return (
    cleanup.sessionClose === "failed" ||
    cleanup.adapterClose === "failed" ||
    cleanup.outputTermination === "failed" ||
    cleanup.nativeReadback === "failed"
  );
}

export function conformanceIncomplete(
  scenarios: Readonly<Record<string, ConformanceScenarioReceipt>>,
  cleanup: MutableConformanceCleanup,
): boolean {
  return (
    Object.values(scenarios).some((scenario) => scenario.status === "notCovered") ||
    cleanup.nativeReadback === "notCovered" ||
    cleanup.residue === "unknown"
  );
}

export function buildConformanceReceipt(input: {
  evidence: ConformanceEvidence;
  environment: ConformanceEnvironment;
  status: ConformanceReceipt["status"];
  harnessId: string;
  capabilities: HarnessSessionCapabilities | null;
  inspectionCapabilities: HarnessSessionCapabilities | null;
  scenarios: Record<string, ConformanceScenarioReceipt>;
  createdSession: NativeSessionRef | null;
  resumedSession: NativeSessionRef | null;
  terminalTurns: NativeTurnRef[];
  nativeIsolationReadback: ConformanceReceipt["environment"]["nativeIsolationReadback"];
  nativeActivation: ConformanceReceipt["environment"]["nativeActivation"];
  cleanup: MutableConformanceCleanup;
}): ConformanceReceipt {
  return {
    formatVersion: 1,
    status: input.status,
    harnessId: input.harnessId,
    hostSha: input.evidence.hostSha,
    pluginBundleSha256: input.evidence.pluginBundleSha256,
    nativeVersion: input.evidence.nativeVersion,
    platform: input.evidence.platform,
    mode: input.evidence.mode,
    capabilities: input.capabilities,
    inspectionCapabilities: input.inspectionCapabilities,
    scenarios: input.scenarios,
    identityReadback: {
      createdSession: input.createdSession,
      resumedSession: input.resumedSession,
      terminalTurns: input.terminalTurns,
    },
    environment: {
      primaryKeys: Object.keys(input.environment.primary).sort(),
      isolatedKeys: Object.keys(input.environment.isolated).sort(),
      resumeKeys: Object.keys(input.environment.resume).sort(),
      nativeActivation: input.nativeActivation,
      nativeIsolationReadback: input.nativeIsolationReadback,
    },
    cleanup: input.cleanup,
  };
}

export function serializeConformanceReceipt(value: ConformanceReceipt): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
