import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { CommandCodeAdapter } from "./command-code-adapter.js";
export type { CommandCodeAdapterOptions } from "./command-code-adapter.js";
export { COMMAND_CODE_CAPABILITIES } from "./command-code-session.js";
export { COMMAND_CODE_COMMAND_ENV, resolveCommandCodeExecutable } from "./command.js";
export {
  COMMAND_CODE_EFFORT_OPTIONS,
  commandCodeModelArguments,
  decodeCommandCodeModelRef,
  encodeCommandCodeModelRef,
  parseCommandCodeModels,
} from "./model-catalog.js";
export {
  COMMAND_CODE_PERMISSION_MODE_CATALOG,
  commandCodePermissionArguments,
  decodeCommandCodePermissionModeId,
} from "./permission-modes.js";
export type { CommandCodePermissionMode } from "./permission-modes.js";
export {
  commandCodeExitError,
  commandCodeResultError,
  isCommandCodeAuthenticationText,
} from "./print-errors.js";
export { COMMAND_CODE_DEFAULT_MAX_TURNS, commandCodePrintArguments } from "./print-turn.js";
export type { CommandCodePrintPlan } from "./print-turn.js";
export {
  commandCodeSessionTurns,
  findCommandCodeSessionFile,
  latestCommandCodePromptId,
  readCommandCodeSessionFile,
} from "./session-file.js";
export { commandCodeErrorMessage, parseCommandCodeStreamLine } from "./stream-events.js";
export type { CommandCodeAgentEvent, CommandCodeStreamLine } from "./stream-events.js";
export {
  commandCodeFileChange,
  commandCodeToolOutput,
  completeCommandCodeToolItem,
  startCommandCodeToolItem,
} from "./tool-projection.js";
export { accumulateCommandCodeUsage, commandCodeHostUsage } from "./usage.js";

export const packageMetadata = {
  name: "@codexhost/adapter-command-code",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
