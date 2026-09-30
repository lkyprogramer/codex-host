import type {
  HarnessSessionCapabilities,
  ModelSelectCommand,
  PermissionModeSelectCommand,
  ThinkingSelectCommand,
} from "@codexhost/harness-adapter";
import type { ExternalConfigurationSelection } from "@codexhost/protocol-core";
import {
  permissionModeFixedAtCreate,
  threadModelSelectParamsSchema,
  threadPermissionModeSelectParamsSchema,
  threadThinkingSelectParamsSchema,
  type HarnessConfigurationState,
  type HarnessModelRef,
  type HostThreadId,
} from "@codexhost/shared-contracts";

/** The live configuration a Desktop request selects on an external Thread. */
export type ThreadConfigurationKind = "Model" | "Thinking" | "Permission Mode";

export type ThreadConfigurationCommand =
  ModelSelectCommand | ThinkingSelectCommand | PermissionModeSelectCommand;

interface ThreadConfigurationRequest {
  threadId: HostThreadId;
  command: ThreadConfigurationCommand;
}

interface ThreadConfigurationDescriptor {
  parse(params: unknown): ThreadConfigurationRequest | null;
  /** Why the Session cannot apply this selection, or null when it can. */
  refusal(configuration: HarnessSessionCapabilities["configuration"]): string | null;
  /** Whether the Session's reported state confirms the selection. */
  confirmed(state: HarnessConfigurationState): boolean;
  /** Reported when the Session's new state lacks the selected value. */
  unconfirmed: string;
}

export const threadConfigurationSelections: Readonly<
  Record<ThreadConfigurationKind, ThreadConfigurationDescriptor>
> = {
  Model: {
    parse(params) {
      const parsed = threadModelSelectParamsSchema.safeParse(params);
      return parsed.success
        ? {
            threadId: parsed.data.threadId,
            command: { type: "model.select", model: parsed.data.model },
          }
        : null;
    },
    refusal: (configuration) =>
      configuration.selectModel ? null : "External Harness does not support Model selection",
    confirmed: (state) => state.effectiveModel !== undefined,
    unconfirmed: "Harness Session did not report an effective Model",
  },
  Thinking: {
    parse(params) {
      const parsed = threadThinkingSelectParamsSchema.safeParse(params);
      return parsed.success
        ? {
            threadId: parsed.data.threadId,
            command: { type: "thinking.select", thinkingOptionId: parsed.data.thinkingOptionId },
          }
        : null;
    },
    refusal: (configuration) =>
      configuration.selectThinkingOption
        ? null
        : "External Harness does not support Thinking selection",
    confirmed: (state) => state.effectiveThinkingOptionId !== undefined,
    unconfirmed: "Harness Session did not report effective Thinking",
  },
  "Permission Mode": {
    parse(params) {
      const parsed = threadPermissionModeSelectParamsSchema.safeParse(params);
      return parsed.success
        ? {
            threadId: parsed.data.threadId,
            command: {
              type: "permissionMode.select",
              permissionModeId: parsed.data.permissionModeId,
            },
          }
        : null;
    },
    refusal(configuration) {
      if (!configuration.selectPermissionMode) {
        return "External Harness does not support Permission Mode selection";
      }
      return permissionModeFixedAtCreate(configuration)
        ? "Permission Mode is fixed at Session creation"
        : null;
    },
    confirmed: (state) => state.effectivePermissionModeId !== undefined,
    unconfirmed: "Harness Session did not report its current Permission Mode",
  },
};

/**
 * The selection a Thread persists once the Session confirmed a change: what
 * it confirmed, over what was selected before. A Session that does not report
 * its Model keeps the one requested or persisted earlier.
 */
export function confirmedThreadSelection(input: {
  previous: ExternalConfigurationSelection | null;
  state: HarnessConfigurationState;
  requestedModel: HarnessModelRef | undefined;
}): ExternalConfigurationSelection {
  const { previous, state } = input;
  const model = state.effectiveModel ?? input.requestedModel ?? previous?.model;
  return {
    ...(previous ?? {}),
    ...(model ? { model } : {}),
    ...(state.effectiveThinkingOptionId
      ? { thinkingOptionId: state.effectiveThinkingOptionId }
      : {}),
    ...(state.effectivePermissionModeId
      ? { permissionModeId: state.effectivePermissionModeId }
      : {}),
  };
}
