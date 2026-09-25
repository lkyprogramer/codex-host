import {
  hostTurnIdSchema,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import type {
  HarnessAdapter,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  HarnessSessionCapabilities,
  HostThreadSnapshot,
} from "./text-session.js";
import {
  closedSessionRefusesWork,
  suspendAborted,
  suspendIdle,
  suspendWhileBusy,
} from "./conformance-lifecycle.js";
import { OutputCollector } from "./conformance-output.js";
import type { ConformanceTerminalReadback } from "./conformance-output.js";
import {
  buildConformanceReceipt,
  conformanceCleanupFailed,
  conformanceIncomplete,
  createConformanceCleanup,
  updateConformanceCleanupTotals,
} from "./conformance-receipt.js";
import type {
  ConformanceCleanupReadback,
  ConformanceEnvironment,
  ConformanceEvidence,
  ConformancePrompts,
  ConformanceReceipt,
  ConformanceScenarioReceipt,
  MutableConformanceCleanup,
} from "./conformance-receipt.js";

export { serializeConformanceReceipt } from "./conformance-receipt.js";
export type {
  ConformanceCleanupOutcome,
  ConformanceCleanupReadback,
  ConformanceEnvironment,
  ConformanceEvidence,
  ConformancePrompts,
  ConformanceReceipt,
  ConformanceScenarioReceipt,
  ConformanceScenarioStatus,
} from "./conformance-receipt.js";
export type { ConformanceTerminalReadback } from "./conformance-output.js";

export interface ConformanceCapabilityContext {
  readonly adapter: HarnessAdapter;
  readonly session: HarnessSession;
  readonly inspection: Extract<HarnessInspection, { status: "ready" }>;
  readonly createdSession: NativeSessionRef;
}

export interface ConformanceCapabilityScenarios {
  readonly fork?: (context: ConformanceCapabilityContext) => Promise<void>;
  readonly rollback?: (context: ConformanceCapabilityContext) => Promise<void>;
  readonly permissionAtCreate?: (context: ConformanceCapabilityContext) => Promise<void>;
  readonly subagents?: (context: ConformanceCapabilityContext) => Promise<void>;
}

export interface ConformanceOutputObserver {
  /** Waits for a terminal on the driver-owned, single-consumer Session output stream. */
  waitForTerminal(turnId: string): Promise<ConformanceTerminalReadback>;
}

export interface ConformanceProbes {
  /**
   * Optional native activation for lazy transports before isolated-environment readback.
   * The fixture starts its minimal Turn and uses `output.waitForTerminal`; only the driver
   * consumes `session.outputs`.
   */
  readonly activateIsolated?: (
    session: Omit<HarnessSession, "outputs">,
    output: ConformanceOutputObserver,
  ) => Promise<void>;
  /** Reads the actual native fixture after two independently opened Sessions. */
  readonly assertEnvironmentIsolation?: (input: {
    readonly primary: HarnessSession;
    readonly isolated: HarnessSession;
  }) => Promise<void>;
  /** Runs after every known Session and Adapter close attempt. */
  readonly readCleanup?: () => Promise<ConformanceCleanupReadback>;
}

export interface AdapterConformancePlan {
  /** Normally returns an Adapter from the real plugin Loader. Source-fixture tests may return the concrete Adapter. */
  readonly createAdapter: () => Promise<HarnessAdapter> | HarnessAdapter;
  readonly cwd: string;
  readonly evidence: ConformanceEvidence;
  readonly environment: ConformanceEnvironment;
  readonly prompts: ConformancePrompts;
  readonly probes?: ConformanceProbes;
  readonly capabilityScenarios?: ConformanceCapabilityScenarios;
  readonly timeoutMs?: number;
}

export class HarnessConformanceFailure extends Error {
  constructor(
    message: string,
    readonly receipt: ConformanceReceipt,
  ) {
    super(message);
    this.name = "HarnessConformanceFailure";
  }
}

class ConformanceTimeout extends Error {
  constructor(readonly operation: string) {
    super(`Timed out during ${operation}`);
    this.name = "ConformanceTimeout";
  }
}

type SessionKey = "primarySession" | "isolatedSession" | "resumedSession";
type OutputKey = "primaryOutput" | "isolatedOutput" | "resumedOutput";
type AdapterKey = "primaryAdapter" | "resumedAdapter";

const timerRuntime = globalThis as typeof globalThis & {
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
};

function scheduleTimeout(callback: () => void, delayMs: number): unknown {
  if (!timerRuntime.setTimeout)
    throw new Error("Harness conformance requires a timer-capable runtime");
  return timerRuntime.setTimeout(callback, delayMs);
}

function cancelTimeout(timer: unknown) {
  timerRuntime.clearTimeout?.(timer);
}

function boundedOperation<T>(
  operation: string,
  timeoutMs: number,
  execute: () => Promise<T> | T,
  onLateValue?: (value: T) => void | Promise<void>,
): Promise<T> {
  let timedOut = false;
  let timer: unknown;
  const work = Promise.resolve().then(execute);
  void work.then(
    (value) => {
      if (timedOut)
        void Promise.resolve()
          .then(() => onLateValue?.(value))
          .catch(() => {});
    },
    () => {},
  );
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = scheduleTimeout(() => {
      timedOut = true;
      reject(new ConformanceTimeout(operation));
    }, timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) cancelTimeout(timer);
  });
}

function closeLateSession(result: HarnessResult<HarnessSession>) {
  if (result.ok)
    void Promise.resolve()
      .then(() => result.value.close())
      .catch(() => {});
}

function closeLateAdapter(adapter: HarnessAdapter) {
  void Promise.resolve()
    .then(() => adapter.close())
    .catch(() => {});
}

function assertOk<T>(result: HarnessResult<T>, operation: string): T {
  if (!result.ok) throw new Error(`${operation} returned ${result.error.code}`);
  return result.value;
}

function assertSessionHarness(
  session: HarnessSession,
  adapterHarnessId: string,
  operation: string,
) {
  if (session.harnessId !== adapterHarnessId)
    throw new Error(`${operation} Session Harness identity differs from its Adapter`);
}

function assertNativeTurnIdentity(
  nativeTurnRef: NativeTurnRef,
  session: HarnessSession,
  adapterHarnessId: string,
  expectedSession: NativeSessionRef | undefined,
  operation: string,
) {
  assertSessionHarness(session, adapterHarnessId, operation);
  if (nativeTurnRef.harnessId !== adapterHarnessId)
    throw new Error(`${operation} native Turn Harness identity differs from its Adapter`);
  if (!expectedSession) return;
  if (
    nativeTurnRef.harnessId !== expectedSession.harnessId ||
    nativeTurnRef.nativeSessionId !== expectedSession.nativeSessionId ||
    nativeTurnRef.formatVersion !== expectedSession.formatVersion
  )
    throw new Error(`${operation} native Turn identity differs from its Session`);
}

function createdSessionRef(
  session: HarnessSession,
  output: OutputCollector,
  nativeTurnRef: NativeTurnRef,
  adapterHarnessId: string,
): NativeSessionRef {
  assertNativeTurnIdentity(nativeTurnRef, session, adapterHarnessId, undefined, "first turn");
  const stateRef = session.initialState.nativeRef ?? output.stateNativeRef();
  if (stateRef) {
    if (
      stateRef.harnessId !== adapterHarnessId ||
      stateRef.harnessId !== nativeTurnRef.harnessId ||
      stateRef.nativeSessionId !== nativeTurnRef.nativeSessionId ||
      stateRef.formatVersion !== nativeTurnRef.formatVersion
    )
      throw new Error("Session identity readback disagrees with the first native Turn identity");
    return stateRef;
  }
  return {
    harnessId: nativeTurnRef.harnessId,
    nativeSessionId: nativeTurnRef.nativeSessionId,
    formatVersion: nativeTurnRef.formatVersion,
  };
}

function resumeSessionRef(session: HarnessSession, adapterHarnessId: string): NativeSessionRef {
  assertSessionHarness(session, adapterHarnessId, "resume");
  const ref = session.initialState.nativeRef;
  if (!ref) throw new Error("resume did not expose a native Session identity");
  if (ref.harnessId !== adapterHarnessId)
    throw new Error("resume native Session Harness identity differs from its Adapter");
  return ref;
}

async function markCapability(
  scenarios: Record<string, ConformanceScenarioReceipt>,
  name: string,
  enabled: boolean,
  execute: ((context: ConformanceCapabilityContext) => Promise<void>) | undefined,
  context: ConformanceCapabilityContext,
  timeoutMs: number,
) {
  if (!enabled) {
    scenarios[name] = { status: "skipped", detail: "capability is not advertised" };
    return;
  }
  if (!execute) {
    scenarios[name] = {
      status: "notCovered",
      detail: "advertised capability needs an Adapter-native scenario",
    };
    return;
  }
  try {
    await boundedOperation(`capability:${name}`, timeoutMs, () => execute(context));
    scenarios[name] = { status: "passed" };
  } catch {
    scenarios[name] = { status: "failed", detail: "native capability scenario failed" };
    throw new Error(`${name} native capability scenario failed`);
  }
}

async function closeSession(
  session: HarnessSession | undefined,
  collector: OutputCollector | undefined,
  sessionKey: SessionKey,
  outputKey: OutputKey | undefined,
  cleanup: MutableConformanceCleanup,
  closed: Set<HarnessSession>,
  timeoutMs: number,
) {
  if (!session || closed.has(session)) return;
  closed.add(session);
  collector?.markCloseRequested();
  try {
    await boundedOperation(`close:${sessionKey}`, timeoutMs, () => session.close());
    cleanup.resources[sessionKey] = "passed";
  } catch {
    cleanup.resources[sessionKey] = "failed";
  }
  if (collector && outputKey) {
    try {
      await collector.ended(timeoutMs);
      cleanup.resources[outputKey] = "passed";
    } catch {
      cleanup.resources[outputKey] = "failed";
    }
  }
  updateConformanceCleanupTotals(cleanup);
}

async function closeAdapter(
  adapter: HarnessAdapter | undefined,
  key: AdapterKey,
  cleanup: MutableConformanceCleanup,
  closed: Set<HarnessAdapter>,
  timeoutMs: number,
) {
  if (!adapter || closed.has(adapter)) return;
  closed.add(adapter);
  try {
    await boundedOperation(`close:${key}`, timeoutMs, () => adapter.close());
    cleanup.resources[key] = "passed";
  } catch {
    cleanup.resources[key] = "failed";
  }
  updateConformanceCleanupTotals(cleanup);
}

function failureReason(error: unknown): string {
  return error instanceof ConformanceTimeout ? `timeout:${error.operation}` : "assertionFailed";
}

/**
 * Executes the minimum real-Adapter lifecycle without inventing optional native operations.
 * The caller supplies an actual plugin-loader factory or an Adapter with a controllable native
 * transport fixture; FakeHarness is intentionally unsuitable as execution evidence.
 */
export async function runAdapterConformance(
  plan: AdapterConformancePlan,
): Promise<ConformanceReceipt> {
  const timeoutMs = plan.timeoutMs ?? 5_000;
  const bounded = <T>(operation: string, execute: () => Promise<T>) =>
    boundedOperation(operation, timeoutMs, execute);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50)
    throw new Error("Conformance timeoutMs must be an integer of at least 50ms");
  if (JSON.stringify(plan.environment.primary) === JSON.stringify(plan.environment.isolated))
    throw new Error("Conformance primary and isolated environments must differ");

  const scenarios: Record<string, ConformanceScenarioReceipt> = {};
  const cleanup = createConformanceCleanup();
  const closedSessions = new Set<HarnessSession>();
  const closedAdapters = new Set<HarnessAdapter>();
  const terminalTurns: NativeTurnRef[] = [];
  let adapter: HarnessAdapter | undefined;
  let resumedAdapter: HarnessAdapter | undefined;
  let primary: HarnessSession | undefined;
  let isolated: HarnessSession | undefined;
  let resumed: HarnessSession | undefined;
  let primaryOutput: OutputCollector | undefined;
  let isolatedOutput: OutputCollector | undefined;
  let resumedOutput: OutputCollector | undefined;
  let createdSession: NativeSessionRef | null = null;
  let resumedSession: NativeSessionRef | null = null;
  let capabilities: HarnessSessionCapabilities | null = null;
  let inspectionCapabilities: HarnessSessionCapabilities | null = null;
  let harnessId = "unknown";
  let nativeIsolationReadback: ConformanceReceipt["environment"]["nativeIsolationReadback"] =
    "notCovered";
  let nativeActivation: ConformanceReceipt["environment"]["nativeActivation"] = "notRequested";
  let activeScenario = "adapterCreate";
  let lifecycleFailure = false;

  try {
    const primaryAdapter = await boundedOperation(
      "createAdapter",
      timeoutMs,
      () => plan.createAdapter(),
      closeLateAdapter,
    );
    adapter = primaryAdapter;
    harnessId = primaryAdapter.harnessId;
    scenarios.adapterCreate = { status: "passed" };

    activeScenario = "inspect";
    const inspection = await boundedOperation("inspect", timeoutMs, () =>
      primaryAdapter.inspect({ cwd: plan.cwd, refresh: true }),
    );
    if (inspection.status !== "ready") throw new Error(`inspect returned ${inspection.status}`);
    inspectionCapabilities = inspection.capabilities;
    scenarios.inspect = { status: "passed" };

    activeScenario = "create";
    const openedPrimary = await boundedOperation(
      "open:create",
      timeoutMs,
      () =>
        primaryAdapter.open({
          kind: "create",
          cwd: plan.cwd,
          environment: { ...plan.environment.primary },
        }),
      closeLateSession,
    );
    const primarySession = assertOk(openedPrimary, "create");
    primary = primarySession;
    assertSessionHarness(primarySession, harnessId, "create");
    const primaryCollector = new OutputCollector(primarySession);
    primaryOutput = primaryCollector;
    const primaryCapabilities = primarySession.capabilities;
    capabilities = primaryCapabilities;
    scenarios.create = { status: "passed" };

    activeScenario = "environmentIsolation";
    const openedIsolated = await boundedOperation(
      "open:isolated",
      timeoutMs,
      () =>
        primaryAdapter.open({
          kind: "create",
          cwd: plan.cwd,
          environment: { ...plan.environment.isolated },
        }),
      closeLateSession,
    );
    const isolatedSession = assertOk(openedIsolated, "isolated create");
    isolated = isolatedSession;
    assertSessionHarness(isolatedSession, harnessId, "isolated create");
    const isolatedCollector = new OutputCollector(isolatedSession);
    isolatedOutput = isolatedCollector;
    const activateIsolated = plan.probes?.activateIsolated;
    if (activateIsolated) {
      const isolatedOutputObserver: ConformanceOutputObserver = {
        waitForTerminal: (turnId) => isolatedCollector.terminal(turnId, timeoutMs),
      };
      nativeActivation = "failed";
      await boundedOperation("activateIsolated", timeoutMs, () =>
        activateIsolated(isolatedSession, isolatedOutputObserver),
      );
      nativeActivation = "executed";
    }

    activeScenario = "firstTurn";
    const firstTurnId = hostTurnIdSchema.parse("conformance-first");
    assertOk(
      await boundedOperation("execute:firstTurn", timeoutMs, () =>
        primarySession.execute({
          type: "turn.start",
          turnId: firstTurnId,
          input: [{ type: "text", text: plan.prompts.first }],
        }),
      ),
      "first turn",
    );
    const firstTerminal = await primaryCollector.terminal(firstTurnId, timeoutMs);
    if (firstTerminal.outcome.status !== "succeeded" || !firstTerminal.nativeTurnRef)
      throw new Error("first turn did not finish successfully with a native identity");
    const created = createdSessionRef(
      primarySession,
      primaryCollector,
      firstTerminal.nativeTurnRef,
      harnessId,
    );
    createdSession = created;
    terminalTurns.push(firstTerminal.nativeTurnRef);
    scenarios.firstTurn = { status: "passed" };

    activeScenario = "suspendAborted";
    scenarios.suspendAborted = await suspendAborted(primarySession, bounded);

    activeScenario = "environmentIsolation";
    const assertEnvironmentIsolation = plan.probes?.assertEnvironmentIsolation;
    if (assertEnvironmentIsolation) {
      await boundedOperation("assertEnvironmentIsolation", timeoutMs, () =>
        assertEnvironmentIsolation({ primary: primarySession, isolated: isolatedSession }),
      );
      nativeIsolationReadback = "passed";
      scenarios.environmentIsolation = { status: "passed" };
    } else {
      scenarios.environmentIsolation = {
        status: "notCovered",
        detail: "no native environment probe",
      };
    }
    await closeSession(
      isolatedSession,
      isolatedCollector,
      "isolatedSession",
      "isolatedOutput",
      cleanup,
      closedSessions,
      timeoutMs,
    );
    if (
      cleanup.resources.isolatedSession === "failed" ||
      cleanup.resources.isolatedOutput === "failed"
    )
      throw new Error("isolated Session cleanup failed");

    activeScenario = "concurrentTurn";
    const cancellableTurnId = hostTurnIdSchema.parse("conformance-cancel");
    assertOk(
      await boundedOperation("execute:cancellableTurn", timeoutMs, () =>
        primarySession.execute({
          type: "turn.start",
          turnId: cancellableTurnId,
          input: [{ type: "text", text: plan.prompts.cancellable }],
        }),
      ),
      "cancellable turn",
    );
    await primaryCollector.started(cancellableTurnId, timeoutMs);
    activeScenario = "suspendWhileBusy";
    scenarios.suspendWhileBusy = await suspendWhileBusy(primarySession, bounded);
    activeScenario = "concurrentTurn";
    const concurrent = await boundedOperation("execute:concurrentTurn", timeoutMs, () =>
      primarySession.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("conformance-concurrent"),
        input: [{ type: "text", text: plan.prompts.first }],
      }),
    );
    if (concurrent.ok || concurrent.error.code !== "sessionBusy")
      throw new Error("concurrent turn was not rejected while a native turn was active");
    scenarios.concurrentTurn = { status: "passed" };

    activeScenario = "cancel";
    assertOk(
      await boundedOperation("execute:cancel", timeoutMs, () =>
        primarySession.execute({ type: "turn.cancel", turnId: cancellableTurnId }),
      ),
      "cancel",
    );
    const cancelled = await primaryCollector.terminal(cancellableTurnId, timeoutMs);
    if (cancelled.outcome.status !== "cancelled")
      throw new Error("cancelled turn did not reach a cancelled terminal outcome");
    if (cancelled.nativeTurnRef) {
      assertNativeTurnIdentity(
        cancelled.nativeTurnRef,
        primarySession,
        harnessId,
        created,
        "cancel",
      );
      terminalTurns.push(cancelled.nativeTurnRef);
    }
    scenarios.cancel = { status: "passed" };

    activeScenario = "identityReadback";
    assertSnapshotContains(
      assertOk(
        await boundedOperation("snapshot:identityReadback", timeoutMs, () =>
          primarySession.readSnapshot(),
        ),
        "identity readback",
      ),
      firstTerminal.nativeTurnRef,
      "first turn",
    );
    scenarios.identityReadback = { status: "passed" };

    const capabilityContext: ConformanceCapabilityContext = {
      adapter: primaryAdapter,
      session: primarySession,
      inspection,
      createdSession: created,
    };
    activeScenario = "fork";
    await markCapability(
      scenarios,
      "fork",
      primaryCapabilities.history.fork,
      plan.capabilityScenarios?.fork,
      capabilityContext,
      timeoutMs,
    );
    activeScenario = "rollback";
    await markCapability(
      scenarios,
      "rollback",
      primaryCapabilities.history.rollbackLastTurn,
      plan.capabilityScenarios?.rollback,
      capabilityContext,
      timeoutMs,
    );
    activeScenario = "permissionAtCreate";
    await markCapability(
      scenarios,
      "permissionAtCreate",
      primaryCapabilities.configuration.permissionModeScope === "atCreate",
      plan.capabilityScenarios?.permissionAtCreate,
      capabilityContext,
      timeoutMs,
    );
    activeScenario = "subagents";
    await markCapability(
      scenarios,
      "subagents",
      primaryCapabilities.subagents?.observe === true ||
        primaryCapabilities.subagents?.readTranscript === true,
      plan.capabilityScenarios?.subagents,
      capabilityContext,
      timeoutMs,
    );

    activeScenario = "suspendIdle";
    scenarios.suspendIdle = await suspendIdle(primarySession, primaryCollector, bounded, timeoutMs);

    activeScenario = "resume";
    await closeSession(
      primarySession,
      primaryCollector,
      "primarySession",
      "primaryOutput",
      cleanup,
      closedSessions,
      timeoutMs,
    );
    await closeAdapter(primaryAdapter, "primaryAdapter", cleanup, closedAdapters, timeoutMs);
    if (
      cleanup.resources.primarySession === "failed" ||
      cleanup.resources.primaryOutput === "failed" ||
      cleanup.resources.primaryAdapter === "failed"
    )
      throw new Error("initial Adapter cleanup failed before resume");
    // Only a Session that closed cleanly has a refusal to check.
    activeScenario = "closedSessionRefusesWork";
    scenarios.closedSessionRefusesWork = await closedSessionRefusesWork(primarySession, bounded);
    activeScenario = "resume";

    const freshAdapter = await boundedOperation(
      "createAdapter:resume",
      timeoutMs,
      () => plan.createAdapter(),
      closeLateAdapter,
    );
    resumedAdapter = freshAdapter;
    if (freshAdapter.harnessId !== harnessId)
      throw new Error("fresh Adapter changed Harness identity before resume");
    const openedResumed = await boundedOperation(
      "open:resume",
      timeoutMs,
      () =>
        freshAdapter.open({
          kind: "resume",
          cwd: plan.cwd,
          nativeRef: created,
          environment: { ...plan.environment.resume },
        }),
      closeLateSession,
    );
    const resumedSessionValue = assertOk(openedResumed, "resume");
    resumed = resumedSessionValue;
    const resumedRef = resumeSessionRef(resumedSessionValue, harnessId);
    resumedSession = resumedRef;
    if (
      resumedRef.harnessId !== created.harnessId ||
      resumedRef.nativeSessionId !== created.nativeSessionId ||
      resumedRef.formatVersion !== created.formatVersion
    )
      throw new Error("resume changed the native Session identity");
    assertSnapshotContains(
      assertOk(
        await boundedOperation("snapshot:resume", timeoutMs, () =>
          resumedSessionValue.readSnapshot(),
        ),
        "resume readback",
      ),
      firstTerminal.nativeTurnRef,
      "resumed first turn",
    );
    scenarios.resume = { status: "passed" };

    const resumedCollector = new OutputCollector(resumedSessionValue);
    resumedOutput = resumedCollector;
    activeScenario = "followup";
    const followupTurnId = hostTurnIdSchema.parse("conformance-followup");
    assertOk(
      await boundedOperation("execute:followup", timeoutMs, () =>
        resumedSessionValue.execute({
          type: "turn.start",
          turnId: followupTurnId,
          input: [{ type: "text", text: plan.prompts.followup }],
        }),
      ),
      "followup turn",
    );
    const followup = await resumedCollector.terminal(followupTurnId, timeoutMs);
    if (followup.outcome.status !== "succeeded" || !followup.nativeTurnRef)
      throw new Error("followup turn did not finish successfully with a native identity");
    assertNativeTurnIdentity(
      followup.nativeTurnRef,
      resumedSessionValue,
      harnessId,
      resumedRef,
      "followup",
    );
    terminalTurns.push(followup.nativeTurnRef);
    scenarios.followup = { status: "passed" };
  } catch (error) {
    lifecycleFailure = true;
    scenarios[activeScenario] = {
      status: "failed",
      failure: { code: "CONFORMANCE_ASSERTION_FAILED", reason: failureReason(error) },
    };
  }

  await closeSession(
    resumed,
    resumedOutput,
    "resumedSession",
    "resumedOutput",
    cleanup,
    closedSessions,
    timeoutMs,
  );
  await closeAdapter(resumedAdapter, "resumedAdapter", cleanup, closedAdapters, timeoutMs);
  await closeSession(
    isolated,
    isolatedOutput,
    "isolatedSession",
    "isolatedOutput",
    cleanup,
    closedSessions,
    timeoutMs,
  );
  await closeSession(
    primary,
    primaryOutput,
    "primarySession",
    "primaryOutput",
    cleanup,
    closedSessions,
    timeoutMs,
  );
  await closeAdapter(adapter, "primaryAdapter", cleanup, closedAdapters, timeoutMs);
  if (plan.probes?.readCleanup) {
    try {
      const readback = await boundedOperation("readCleanup", timeoutMs, plan.probes.readCleanup);
      cleanup.nativeReadback = readback.residue === "none" ? "passed" : "failed";
      cleanup.residue = readback.residue;
    } catch {
      cleanup.nativeReadback = "failed";
      cleanup.residue = "unknown";
    }
  }
  const cleanupFailure = conformanceCleanupFailed(cleanup);
  const failed = lifecycleFailure || cleanupFailure;
  scenarios.cleanup = cleanupFailure
    ? {
        status: "failed",
        failure: { code: "CONFORMANCE_CLEANUP_FAILED", reason: "resourceCloseOrResidue" },
      }
    : { status: "passed" };
  const incomplete = !failed && conformanceIncomplete(scenarios, cleanup);
  const finalReceipt = buildConformanceReceipt({
    evidence: plan.evidence,
    environment: plan.environment,
    status: failed ? "failed" : incomplete ? "incomplete" : "passed",
    harnessId,
    capabilities,
    inspectionCapabilities,
    scenarios,
    createdSession,
    resumedSession,
    terminalTurns,
    nativeIsolationReadback,
    nativeActivation,
    cleanup,
  });
  if (failed) {
    const reason = scenarios[activeScenario]?.failure?.reason;
    throw new HarnessConformanceFailure(
      `Harness conformance failed at ${activeScenario}${reason ? `: ${reason}` : ""}`,
      finalReceipt,
    );
  }
  return finalReceipt;
}

function assertSnapshotContains(
  snapshot: HostThreadSnapshot,
  expected: NativeTurnRef,
  operation: string,
) {
  const found = snapshot.turns.some(
    (turn) =>
      turn.nativeTurnRef.harnessId === expected.harnessId &&
      turn.nativeTurnRef.nativeSessionId === expected.nativeSessionId &&
      turn.nativeTurnRef.nativeTurnKey === expected.nativeTurnKey &&
      turn.nativeTurnRef.formatVersion === expected.formatVersion,
  );
  if (!found) throw new Error(`${operation} is absent from native snapshot readback`);
}
