import {
  createPiFamilyHistory,
  fileMutatingKind,
  piFamilyTextContent,
  reliableFileChange,
  synthesizeFileChange,
  type PiFamilyHistoryState,
  type PiFamilySessionHistory,
} from "@codexhost/adapter-pi-family";
import { harnessIdSchema, jsonValueSchema } from "@codexhost/shared-contracts";

import { encodeOmpModelRef } from "./omp-model-catalog.js";
import { projectOmpToolItem } from "./omp-tool-presentation.js";

export type OmpSessionHistory = PiFamilySessionHistory;
export type OmpHistoryState = PiFamilyHistoryState;

const history = createPiFamilyHistory({
  harnessId: harnessIdSchema.parse("omp"),
  label: "Omp",
  itemIdPrefix: "omp-item-v1",
  encodeModelRef: encodeOmpModelRef,
  // OMP shows shell-like tools as command executions with plain-text output.
  toolItem: (call, output) => ({
    ...projectOmpToolItem(call),
    ...(output ? { output: piFamilyTextContent(output.content) } : {}),
  }),
  fileChanges: (call, nativeMessage, cwd) => {
    const kind = fileMutatingKind(call.toolName);
    if (!kind || synthesizeFileChange(kind, call.arguments, cwd)) return null;
    const parsed = jsonValueSchema.safeParse(nativeMessage);
    return parsed.success
      ? reliableFileChange(call.toolName, call.arguments, parsed.data, cwd)
      : null;
  },
});

export const activeOmpEntries = history.activeEntries;
export const mapOmpSnapshot = history.mapSnapshot;
export const resolveOmpLastTurnBoundary = history.resolveLastTurnBoundary;
export const resolveOmpForkBoundary = history.resolveForkBoundary;
