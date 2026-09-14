import { randomUUID } from "node:crypto";
import { access, copyFile, cp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from "node:sqlite";

import type { ForkSessionInput, HarnessResult, HarnessSession } from "@codexhost/harness-adapter";
import {
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  type HarnessId,
  type HarnessModelRef,
  type HarnessThinkingOptionId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import { AntigravityHistory, type AntigravityTurn } from "./history.js";
import type { AntigravityPermissionMode } from "./permission-modes.js";

export function nativeConversationDbPath(nativeSessionId: string, homedir = os.homedir()): string {
  return path.join(homedir, ".gemini", "antigravity-cli", "conversations", `${nativeSessionId}.db`);
}

export function nativeBrainDirPath(nativeSessionId: string, homedir = os.homedir()): string {
  return path.join(homedir, ".gemini", "antigravity-cli", "brain", nativeSessionId);
}

function nativeConversationSummariesDbPath(homedir: string): string {
  return path.join(homedir, ".gemini", "antigravity-cli", "conversation_summaries.db");
}

export function antigravityHomeDirectory(environment: NodeJS.ProcessEnv): string {
  return environment.HOME?.trim() || environment.USERPROFILE?.trim() || os.homedir();
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function cleanupFailureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendCleanupDiagnostic(message: string, cleanupDiagnostic: string | undefined): string {
  return cleanupDiagnostic ? `${message}; derived cleanup failed: ${cleanupDiagnostic}` : message;
}

export async function cloneNativeConversationDb(
  sourceSessionId: string,
  derivedSessionId: string,
  retainedTurnsCountOrHomedir?: number | string,
  homedirOption = os.homedir(),
): Promise<boolean> {
  let retainedTurnsCount: number | undefined;
  let homedir = homedirOption;
  if (typeof retainedTurnsCountOrHomedir === "string") {
    homedir = retainedTurnsCountOrHomedir;
  } else if (typeof retainedTurnsCountOrHomedir === "number") {
    retainedTurnsCount = retainedTurnsCountOrHomedir;
  }

  const sourceDb = nativeConversationDbPath(sourceSessionId, homedir);
  const targetDb = nativeConversationDbPath(derivedSessionId, homedir);
  const fail = async (): Promise<boolean> => {
    await removeNativeDerivedSessionArtifacts(derivedSessionId, homedir);
    return false;
  };
  try {
    await mkdir(path.dirname(targetDb), { recursive: true });
    await copyFile(sourceDb, targetDb);
  } catch {
    return fail();
  }

  let DatabaseSync: typeof DatabaseSyncType;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return fail();
  }

  try {
    const db = new DatabaseSync(targetDb);
    try {
      const trajectory = db.prepare("SELECT cascade_id FROM trajectory_meta LIMIT 1").get() as
        { cascade_id?: unknown } | undefined;
      if (!trajectory || typeof trajectory.cascade_id !== "string") {
        throw new Error("Antigravity Native conversation has no trajectory metadata");
      }
      db.prepare("UPDATE trajectory_meta SET cascade_id = ?").run(derivedSessionId);
      if (retainedTurnsCount !== undefined) {
        if (retainedTurnsCount === 0) {
          db.prepare("DELETE FROM steps").run();
        } else {
          // In agy, each turn begins with a user_input step (step_type = 14).
          const rows = db
            .prepare("SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx ASC")
            .all() as Array<{ idx: number }>;
          const cutoff = rows[retainedTurnsCount];
          if (!cutoff || rows.length < retainedTurnsCount) {
            throw new Error("Antigravity Native conversation cannot retain the requested history");
          }
          db.prepare("DELETE FROM steps WHERE idx >= ?").run(cutoff.idx);
        }
        const retained = db
          .prepare("SELECT count(*) AS count FROM steps WHERE step_type = 14")
          .get() as { count?: number } | undefined;
        if (retained?.count !== retainedTurnsCount) {
          throw new Error("Antigravity Native conversation history verification failed");
        }
        for (const table of [
          "gen_metadata",
          "executor_metadata",
          "parent_references",
          "battle_mode_infos",
        ]) {
          try {
            db.prepare(`DELETE FROM ${table} WHERE idx >= ?`).run(retainedTurnsCount);
          } catch {
            // These tables are version-dependent auxiliary metadata. The core
            // trajectory and step prefix above are the required clone contract.
          }
        }
      }
    } finally {
      db.close();
    }
  } catch {
    return fail();
  }

  // Register in conversation_summaries.db so `agy` trajectory lookup succeeds.
  try {
    const summariesDbPath = nativeConversationSummariesDbPath(homedir);
    // Some supported agy builds create the per-conversation database before
    // the summaries catalog. When the catalog exists it is part of the clone
    // transaction and must validate; its absence is not synthesized here.
    if (!(await exists(summariesDbPath))) return true;
    const sumDb = new DatabaseSync(summariesDbPath);
    try {
      const cur = sumDb.prepare("SELECT * FROM conversation_summaries WHERE conversation_id = ?");
      const row = cur.get(sourceSessionId) as Record<string, unknown> | undefined;
      if (!row) throw new Error("Antigravity Native conversation summary is unavailable");
      {
        let remainingStepCount = 0;
        const countDb = new DatabaseSync(targetDb);
        try {
          const countRow = countDb.prepare("SELECT count(*) as c FROM steps").get() as
            { c: number } | undefined;
          if (!countRow || !Number.isSafeInteger(countRow.c)) {
            throw new Error("Antigravity Native conversation step count is invalid");
          }
          remainingStepCount = countRow.c;
        } finally {
          countDb.close();
        }

        const cols = Object.keys(row);
        const newRow: Record<string, unknown> = {
          ...row,
          conversation_id: derivedSessionId,
          last_modified_time: new Date().toISOString(),
          ...(retainedTurnsCount !== undefined ? { step_count: remainingStepCount } : {}),
        };
        const placeholders = cols.map(() => "?").join(", ");
        const values = cols.map((col) => newRow[col] as SQLInputValue);
        sumDb
          .prepare(
            `INSERT OR REPLACE INTO conversation_summaries (${cols.map((c) => `\`${c}\``).join(", ")}) VALUES (${placeholders})`,
          )
          .run(...values);
        const registered = sumDb
          .prepare("SELECT conversation_id FROM conversation_summaries WHERE conversation_id = ?")
          .get(derivedSessionId) as { conversation_id?: unknown } | undefined;
        if (registered?.conversation_id !== derivedSessionId) {
          throw new Error("Antigravity Native conversation summary verification failed");
        }
      }
    } finally {
      sumDb.close();
    }
  } catch {
    return fail();
  }

  return exists(targetDb);
}

export const copyNativeConversationDbIfExists = cloneNativeConversationDb;

export async function copyNativeBrainDirIfExists(
  sourceSessionId: string,
  derivedSessionId: string,
  homedir = os.homedir(),
): Promise<boolean> {
  const sourceBrain = nativeBrainDirPath(sourceSessionId, homedir);
  const targetBrain = nativeBrainDirPath(derivedSessionId, homedir);
  try {
    await cp(sourceBrain, targetBrain, {
      recursive: true,
      filter: (source) => path.basename(source) !== ".system_generated",
    });
    return true;
  } catch {
    return false;
  }
}

export async function removeNativeDerivedSessionArtifacts(
  nativeSessionId: string,
  homedir: string,
): Promise<string | undefined> {
  const results = await Promise.allSettled([
    rm(nativeConversationDbPath(nativeSessionId, homedir), { force: true }),
    rm(nativeBrainDirPath(nativeSessionId, homedir), { recursive: true, force: true }),
    removeNativeConversationSummary(nativeSessionId, homedir),
  ]);
  const diagnostics = results.flatMap((result) =>
    result.status === "rejected" ? [cleanupFailureDetail(result.reason)] : [],
  );
  return diagnostics.length > 0 ? diagnostics.join("; ") : undefined;
}

export async function cleanupDerivedAntigravitySession(input: {
  nativeSessionId: string;
  homedir: string;
  environment: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const [nativeCleanup, sidecarCleanup] = await Promise.allSettled([
    removeNativeDerivedSessionArtifacts(input.nativeSessionId, input.homedir),
    AntigravityHistory.removeDerived({
      environment: input.environment,
      nativeSessionId: input.nativeSessionId,
    }),
  ]);
  const diagnostics: string[] = [];
  if (nativeCleanup.status === "fulfilled") {
    if (nativeCleanup.value) diagnostics.push(nativeCleanup.value);
  } else {
    diagnostics.push(cleanupFailureDetail(nativeCleanup.reason));
  }
  if (sidecarCleanup.status === "rejected") {
    diagnostics.push(cleanupFailureDetail(sidecarCleanup.reason));
  }
  return diagnostics.length > 0 ? diagnostics.join("; ") : undefined;
}

async function removeNativeConversationSummary(
  nativeSessionId: string,
  homedir: string,
): Promise<void> {
  const summariesDbPath = nativeConversationSummariesDbPath(homedir);
  if (!(await exists(summariesDbPath))) return;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(summariesDbPath);
  try {
    db.prepare("DELETE FROM conversation_summaries WHERE conversation_id = ?").run(nativeSessionId);
  } finally {
    db.close();
  }
}

export async function cloneNativeDerivedSessionArtifacts(input: {
  sourceSessionId: string;
  derivedSessionId: string;
  retainedTurnsCount: number;
  homedir: string;
}): Promise<boolean> {
  const sourceDb = nativeConversationDbPath(input.sourceSessionId, input.homedir);
  const sourceBrain = nativeBrainDirPath(input.sourceSessionId, input.homedir);
  const sourceDbExists = await exists(sourceDb);
  const sourceBrainExists = await exists(sourceBrain);
  if (!sourceDbExists) return !sourceBrainExists;
  const copiedDb = await cloneNativeConversationDb(
    input.sourceSessionId,
    input.derivedSessionId,
    input.retainedTurnsCount,
    input.homedir,
  );
  if (!copiedDb) return false;
  if (!sourceBrainExists) return true;
  const copiedBrain = await copyNativeBrainDirIfExists(
    input.sourceSessionId,
    input.derivedSessionId,
    input.homedir,
  );
  return copiedBrain && (await exists(nativeBrainDirPath(input.derivedSessionId, input.homedir)));
}

export interface ForkAntigravitySessionOptions {
  harnessId: HarnessId;
  input: ForkSessionInput;
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

export async function forkAntigravitySession(
  options: ForkAntigravitySessionOptions,
): Promise<HarnessResult<HarnessSession>> {
  const { harnessId, input, adapterEnvironment, sourceSession, createSession } = options;

  const sourceRefParsed = nativeSessionRefSchema.safeParse(input.sourceRef);
  if (!sourceRefParsed.success || sourceRefParsed.data.harnessId !== harnessId) {
    return {
      ok: false,
      error: {
        code: "invalidRequest",
        message: "Antigravity cannot fork another Harness Session",
        retryable: false,
      },
    };
  }
  const sourceRef = sourceRefParsed.data;

  const checkpointParsed = nativeCheckpointRefSchema.safeParse(input.checkpoint);
  if (
    !checkpointParsed.success ||
    checkpointParsed.data.harnessId !== harnessId ||
    checkpointParsed.data.nativeSessionId !== sourceRef.nativeSessionId
  ) {
    return {
      ok: false,
      error: {
        code: "checkpointNotFound",
        message: "Antigravity Checkpoint does not belong to the source Native Session",
        retryable: false,
      },
    };
  }
  const checkpoint = checkpointParsed.data;

  if (sourceSession?.isActive) {
    return {
      ok: false,
      error: {
        code: "sessionBusy",
        message: "Antigravity Session cannot fork while a Turn is active",
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
  const boundaryIndex = sourceTurns.findIndex(
    (turn) =>
      turn.checkpoint?.checkpointId === checkpoint.checkpointId ||
      turn.nativeTurnRef.nativeTurnKey === checkpoint.checkpointId,
  );
  if (boundaryIndex === -1) {
    return {
      ok: false,
      error: {
        code: "checkpointNotFound",
        message: `Antigravity Checkpoint '${checkpoint.checkpointId}' not found in source Session history`,
        retryable: false,
      },
    };
  }

  const retainedTurns = sourceTurns.slice(0, boundaryIndex + 1);
  const derivedNativeSessionId = randomUUID();
  const copiedTurns: AntigravityTurn[] = retainedTurns.map((turn) => ({
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
    retainedTurnsCount: retainedTurns.length,
    homedir,
  });
  if (!nativeCopied) {
    const cleanupDiagnostic = await cleanupDerived();
    return {
      ok: false,
      error: {
        code: "nativeFailure",
        message: appendCleanupDiagnostic(
          "Antigravity Native fork history could not be cloned and verified",
          cleanupDiagnostic,
        ),
        retryable: true,
      },
    };
  }

  let forkedHistory: AntigravityHistory;
  try {
    forkedHistory = await AntigravityHistory.createDerived({
      environment: sessionEnvironment,
      nativeSessionId: derivedNativeSessionId,
      turns: copiedTurns,
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
    });
  } catch {
    const cleanupDiagnostic = await cleanupDerived();
    return {
      ok: false,
      error: {
        code: "nativeFailure",
        message: appendCleanupDiagnostic(
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
      history: forkedHistory,
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
        message: appendCleanupDiagnostic(
          "Antigravity derived Session could not be opened",
          cleanupDiagnostic,
        ),
        retryable: true,
      },
    };
  }

  return { ok: true, value: session };
}
