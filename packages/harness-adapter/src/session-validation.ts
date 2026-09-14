import {
  harnessConfigurationStateSchema,
  harnessSessionCapabilitiesSchema,
  nativeSessionRefSchema,
  type HarnessId,
} from "@codexhost/shared-contracts";

import type { HarnessResult, HarnessSession } from "./text-session.js";
import { parseHostUsage } from "./usage.js";

function record(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(field: string): HarnessResult<never> {
  return {
    ok: false,
    error: {
      code: "protocolError",
      message: `Harness plugin returned an invalid Session (${field})`,
      retryable: false,
      stage: "sessionValidation",
    },
  };
}

/** Validate an untrusted plugin result without consuming outputs or changing method receivers.
 * The caller owns closing a rejected Session and removing its provisional Host mapping.
 */
export function validateHarnessSession(
  expectedHarnessId: HarnessId,
  value: unknown,
): HarnessResult<HarnessSession> {
  try {
    if (!record(value) || value.harnessId !== expectedHarnessId) return invalid("harnessId");
    const capabilities = harnessSessionCapabilitiesSchema.safeParse(value.capabilities);
    if (!capabilities.success) return invalid("capabilities");
    const initialState = value.initialState;
    if (!record(initialState)) return invalid("initialState");
    const { nativeRef, ...configuration } = initialState;
    if (!harnessConfigurationStateSchema.safeParse(configuration).success)
      return invalid("initialState");
    if (nativeRef !== undefined) {
      const ref = nativeSessionRefSchema.safeParse(nativeRef);
      if (!ref.success || ref.data.harnessId !== expectedHarnessId) return invalid("nativeRef");
    }
    const initialUsage = value.initialUsage;
    if (initialUsage !== null) {
      try {
        parseHostUsage(initialUsage);
      } catch {
        return invalid("initialUsage");
      }
    }
    const outputs = value.outputs;
    if (!record(outputs) || typeof outputs[Symbol.asyncIterator] !== "function") {
      return invalid("outputs");
    }
    for (const method of ["execute", "readSnapshot", "close"] as const) {
      if (typeof value[method] !== "function") return invalid(method);
    }
    const refreshUsage = value.refreshUsage;
    const lifecycle = value.resourceLifecycle;
    if (
      lifecycle !== undefined &&
      (!record(lifecycle) || typeof lifecycle.suspend !== "function")
    ) {
      return invalid("resourceLifecycle");
    }
    if (refreshUsage !== undefined && typeof refreshUsage !== "function") {
      return invalid("refreshUsage");
    }
    const commands = value.commands;
    if (
      commands !== undefined &&
      (!record(commands) ||
        typeof commands.list !== "function" ||
        typeof commands.execute !== "function")
    ) {
      return invalid("commands");
    }
    const steering = value.steering;
    const workMode = value.workMode;
    const currentWorkMode = record(workMode) ? workMode.current : undefined;
    if (steering !== undefined && (!record(steering) || typeof steering.interject !== "function"))
      return invalid("steering");
    if (
      workMode !== undefined &&
      (!record(workMode) ||
        typeof workMode.set !== "function" ||
        ![null, "default", "plan"].includes(currentWorkMode as string | null))
    ) {
      return invalid("workMode");
    }
    const turnControl = capabilities.data.turnControl;
    if (turnControl?.steering === "native" && steering === undefined) return invalid("steering");
    if (turnControl?.steering === "restart" && steering !== undefined) return invalid("steering");
    if (turnControl?.workModes.includes("plan") && workMode === undefined)
      return invalid("workMode");
    if (
      turnControl &&
      record(workMode) &&
      currentWorkMode !== null &&
      !turnControl.workModes.includes(currentWorkMode as "default" | "plan")
    ) {
      return invalid("workMode.current");
    }
    return { ok: true, value: value as unknown as HarnessSession };
  } catch {
    // Accessors and proxies are executable plugin code; never reflect their error payload.
    return invalid("propertyAccess");
  }
}
