import {
  createPiFamilyHistory,
  nativePatchFileChange,
  type PiFamilyHistoryState,
  type PiFamilySessionHistory,
} from "@codexhost/adapter-pi-family";
import type { HostToolExecutionItem } from "@codexhost/harness-adapter";
import { harnessIdSchema } from "@codexhost/shared-contracts";

import { encodePiModelRef } from "./pi-model-catalog.js";

export type PiSessionHistory = PiFamilySessionHistory;
export type PiHistoryState = PiFamilyHistoryState;

const history = createPiFamilyHistory({
  harnessId: harnessIdSchema.parse("pi"),
  label: "Pi",
  itemIdPrefix: "pi-item-v1",
  encodeModelRef: encodePiModelRef,
  toolItem: (call, output): HostToolExecutionItem => ({
    type: "toolExecution",
    ...call,
    ...(output ? { output } : {}),
  }),
  fileChanges: (call, nativeMessage, cwd) =>
    nativePatchFileChange(call.toolName, nativeMessage, cwd),
});

export const activePiEntries = history.activeEntries;
export const mapPiSnapshot = history.mapSnapshot;
export const resolvePiLastTurnBoundary = history.resolveLastTurnBoundary;
export const resolvePiForkBoundary = history.resolveForkBoundary;
