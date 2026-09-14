import { randomUUID } from "node:crypto";

import type {
  HarnessResult,
  HarnessSession,
  RollbackLastTurnSessionInput,
} from "@codexhost/harness-adapter";
import {
  nativeSessionRefSchema,
  type HarnessId,
  type HarnessModelRef,
  type HarnessThinkingOptionId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import {
  antigravityHomeDirectory,
  cleanupDerivedAntigravitySession,
  cloneNativeDerivedSessionArtifacts,
} from "./fork.js";
import { AntigravityHistory, type AntigravityTurn } from "./history.js";
import type { AntigravityPermissionMode } from "./permission-modes.js";

function withCleanupDiagnostic(message: string, cleanupDiagnostic: string | undefined): string {
  return cleanupDiagnostic ? `${message}; derived cleanup failed: ${cleanupDiagnostic}` : message;
}

export interface RollbackAntigravityLastTurnOptions {
  harnessId: HarnessId;
  input: RollbackLastTurnSessionInput;
  adapterEnvironment: NodeJS.ProcessEnv;
  sourceSession?:
    | {
        history: AntigravityHistory;
        model?: HarnessModelRef | undefined;
        thinkingOptionId?: HarnessThinkingOptionId | undefined;
        permissionMode: AntigravityPermissionMode;
        isActive: boolean;
      }
    | undefined;
  createSession: (params: {
    history: AntigravityHistory;
    nativeRef: NativeSessionRef;
    model?: HarnessModelRef | undefined;
    thinkingOptionId?: HarnessThinkingOptionId | undefined;
    permissionMode: AntigravityPermissionMode;
    cwd: string;
    environment: NodeJS.ProcessEnv;
  }) => HarnessSession;
}

export async function rollbackAntigravityLastTurn(
  options: RollbackAntigravityLastTurnOptions,
): Promise<HarnessResult<HarnessSession>> {
  const { harnessId, input, adapterEnvironment, sourceSession, createSession } = options;

  const sourceRefParsed = nativeSessionRefSchema.safeParse(input.sourceRef);
  if (!sourceRefParsed.success || sourceRefParsed.data.harnessId !== harnessId) {
    return {
      ok: false,
      error: {
        code: "invalidRequest",
        message: "Antigravity cannot roll back another Harness Session",
        retryable: false,
      },
    };
  }
  const sourceRef = sourceRefParsed.data;

  if (sourceSession?.isActive) {
    return {
      ok: false,
      error: {
        code: "sessionBusy",
        message: "Antigravity Session cannot roll back while a Turn is active",
        retryable: true,
      },
    };
  }

  const sessionEnvironment = { ...adapterEnvironment, ...(input.environment ?? {}) };
  let sourceHistory: AntigravityHistory | null = sourceSession?.history ?? null;
  if (!sourceHistory) {
    sourceHistory = await AntigravityHistory.findByNativeSessionId(
      sessionEnvironment,
      sourceRef.nativeSessionId,
    );
  }
  if (!sourceHistory) {
    return {
      ok: false,
      error: {
        code: "sessionNotFound",
        message: "Antigravity source session history not found",
        retryable: false,
      },
    };
  }

  const sourceTurns = sourceHistory.snapshot();
  if (sourceTurns.length === 0) {
    return {
      ok: false,
      error: {
        code: "invalidState",
        message: "Antigravity Native Session has no Turn to roll back",
        retryable: false,
      },
    };
  }

  const truncatedTurns = sourceTurns.slice(0, -1);
  const derivedNativeSessionId = randomUUID();
  const mappedTurns: AntigravityTurn[] = truncatedTurns.map((turn) => ({
    ...turn,
    nativeTurnRef: {
      ...turn.nativeTurnRef,
      nativeSessionId: derivedNativeSessionId,
    },
    ...(turn.checkpoint
      ? {
          checkpoint: {
            ...turn.checkpoint,
            nativeSessionId: derivedNativeSessionId,
          },
        }
      : {}),
  }));

  const model = sourceSession?.model ?? sourceHistory.model;
  const thinkingOptionId = sourceSession?.thinkingOptionId ?? sourceHistory.thinkingOptionId;
  const permissionMode = sourceSession?.permissionMode ?? "dangerously-skip-permissions";

  const homedir = antigravityHomeDirectory(sessionEnvironment);
  const cleanupDerived = (): Promise<string | undefined> =>
    cleanupDerivedAntigravitySession({
      nativeSessionId: derivedNativeSessionId,
      homedir,
      environment: sessionEnvironment,
    });
  const nativeCopied = await cloneNativeDerivedSessionArtifacts({
    sourceSessionId: sourceRef.nativeSessionId,
    derivedSessionId: derivedNativeSessionId,
    retainedTurnsCount: mappedTurns.length,
    homedir,
  });
  if (!nativeCopied) {
    const cleanupDiagnostic = await cleanupDerived();
    return {
      ok: false,
      error: {
        code: "nativeFailure",
        message: withCleanupDiagnostic(
          "Antigravity Native rollback history could not be cloned and verified",
          cleanupDiagnostic,
        ),
        retryable: true,
      },
    };
  }

  let rolledBackHistory: AntigravityHistory;
  try {
    rolledBackHistory = await AntigravityHistory.createDerived({
      environment: sessionEnvironment,
      nativeSessionId: derivedNativeSessionId,
      turns: mappedTurns,
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
    });
  } catch {
    const cleanupDiagnostic = await cleanupDerived();
    return {
      ok: false,
      error: {
        code: "nativeFailure",
        message: withCleanupDiagnostic(
          "Antigravity derived history could not be recorded",
          cleanupDiagnostic,
        ),
        retryable: true,
      },
    };
  }

  const derivedNativeRef: NativeSessionRef = {
    harnessId,
    nativeSessionId: derivedNativeSessionId,
    formatVersion: 1,
  };

  let session: HarnessSession;
  try {
    session = createSession({
      history: rolledBackHistory,
      nativeRef: derivedNativeRef,
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      permissionMode,
      cwd: input.cwd,
      environment: sessionEnvironment,
    });
  } catch {
    const cleanupDiagnostic = await cleanupDerived();
    return {
      ok: false,
      error: {
        code: "nativeFailure",
        message: withCleanupDiagnostic(
          "Antigravity derived Session could not be opened",
          cleanupDiagnostic,
        ),
        retryable: true,
      },
    };
  }

  return { ok: true, value: session };
}
