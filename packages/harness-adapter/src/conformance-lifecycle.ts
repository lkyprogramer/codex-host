import { hostTurnIdSchema } from "@codexhost/shared-contracts";

import type { OutputCollector } from "./conformance-output.js";
import type { ConformanceScenarioReceipt } from "./conformance-receipt.js";
import type {
  HarnessIdleSuspendResult,
  HarnessSession,
  ModelSelectCommand,
  PermissionModeSelectCommand,
  ThinkingSelectCommand,
} from "./text-session.js";

/** A live configuration write a Session may be asked to apply. */
export type ConfigurationWrite =
  ModelSelectCommand | ThinkingSelectCommand | PermissionModeSelectCommand;

/**
 * Resource-lifecycle scenarios. Each checks one promise the Host relies on
 * when it releases native resources: an idle suspension never touches
 * active or aborted work, a successful one ends the Session's outputs, and
 * a closed Session refuses work instead of hanging or restarting a process.
 */

type Bounded = <T>(operation: string, execute: () => Promise<T>) => Promise<T>;

const ABORTED = { aborted: true } as const;
const ACTIVE = { aborted: false } as const;

function skipped(): ConformanceScenarioReceipt {
  return { status: "skipped", detail: "Session has no resource lifecycle" };
}

function describe(result: HarnessIdleSuspendResult): string {
  return result.status === "suspended" ? `suspended (${result.scope})` : result.status;
}

/** An aborted suspension must release nothing. */
export async function suspendAborted(
  session: HarnessSession,
  bounded: Bounded,
): Promise<ConformanceScenarioReceipt> {
  const lifecycle = session.resourceLifecycle;
  if (!lifecycle) return skipped();
  const result = await bounded("suspend:aborted", () => lifecycle.suspend(ABORTED));
  if (result.status === "suspended" || result.status === "releaseFailed")
    throw new Error(`aborted idle suspension released resources: ${describe(result)}`);
  return { status: "passed" };
}

/** A suspension while a Turn runs must not stop or release that work. */
export async function suspendWhileBusy(
  session: HarnessSession,
  bounded: Bounded,
): Promise<ConformanceScenarioReceipt> {
  const lifecycle = session.resourceLifecycle;
  if (!lifecycle) return skipped();
  const result = await bounded("suspend:busy", () => lifecycle.suspend(ACTIVE));
  if (result.status !== "busy" && result.status !== "unknown")
    throw new Error(`idle suspension during an active Turn returned ${describe(result)}`);
  return { status: "passed" };
}

/**
 * An idle suspension either declines or releases; a release ends outputs.
 * The resume scenario that follows then proves the released Session is
 * still resumable.
 */
export async function suspendIdle(
  session: HarnessSession,
  collector: OutputCollector,
  bounded: Bounded,
  timeoutMs: number,
): Promise<ConformanceScenarioReceipt> {
  const lifecycle = session.resourceLifecycle;
  if (!lifecycle) return skipped();
  const result = await bounded("suspend:idle", () => lifecycle.suspend(ACTIVE));
  if (result.status === "releaseFailed")
    throw new Error(`idle release failed${result.reason ? `: ${result.reason}` : ""}`);
  if (result.status !== "suspended")
    return { status: "passed", detail: `idle suspension declined: ${describe(result)}` };
  if (!result.scope.trim()) throw new Error("idle suspension reported an empty scope");
  collector.markCloseRequested();
  await collector.ended(timeoutMs);
  return { status: "passed", detail: describe(result) };
}

/** A closed Session answers again, and refuses new work, without hanging. */
export async function closedSessionRefusesWork(
  session: HarnessSession,
  bounded: Bounded,
): Promise<ConformanceScenarioReceipt> {
  await bounded("close:repeat", () => session.close());
  let accepted: boolean;
  try {
    const result = await bounded("execute:afterClose", () =>
      session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("conformance-after-close"),
        input: [{ type: "text", text: "must not run" }],
      }),
    );
    accepted = result.ok;
  } catch (error) {
    // Throwing refuses the Turn too; only hanging does not.
    if (error instanceof Error && error.name === "ConformanceTimeout") throw error;
    accepted = false;
  }
  if (accepted) throw new Error("a closed Session accepted a new Turn");
  return { status: "passed" };
}

/**
 * A configuration write the native side never answers must neither hang nor
 * be reported as applied, and the Session must then be retired (faulted or
 * ended): its native configuration is no longer known.
 */
export async function configurationTimeout(
  session: HarnessSession,
  collector: OutputCollector,
  stall: ((session: HarnessSession) => Promise<ConfigurationWrite>) | undefined,
  bounded: Bounded,
  timeoutMs: number,
): Promise<ConformanceScenarioReceipt> {
  const configuration = session.capabilities.configuration;
  const writable =
    configuration.selectModel ||
    configuration.selectThinkingOption ||
    (configuration.selectPermissionMode && configuration.permissionModeScope !== "atCreate");
  if (!writable) return { status: "skipped", detail: "Session has no live configuration write" };
  if (!stall) return { status: "notCovered", detail: "no native configuration-stall probe" };
  const command = await bounded("stallConfiguration", () => stall(session));
  let applied: boolean;
  // `execute` is overloaded per command; any configuration write returns a
  // result with the same `ok` shape.
  try {
    applied = (
      await bounded("execute:stalledConfiguration", () =>
        session.execute(command as ModelSelectCommand),
      )
    ).ok;
  } catch (error) {
    if (error instanceof Error && error.name === "ConformanceTimeout")
      throw new Error("a stalled configuration write never answered", { cause: error });
    // Throwing refuses the write too.
    applied = false;
  }
  if (applied)
    throw new Error("a configuration write the native side never answered was reported applied");
  await collector.retired(timeoutMs);
  return { status: "passed" };
}
