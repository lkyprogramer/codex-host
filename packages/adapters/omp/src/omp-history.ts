import {
  createPiFamilyHistory,
  piFamilyTextContent,
  type PiFamilyHistoryState,
  type PiFamilySessionHistory,
} from "@codexhost/adapter-pi-family";
import { harnessIdSchema } from "@codexhost/shared-contracts";

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
});

export const activeOmpEntries = history.activeEntries;
export const mapOmpSnapshot = history.mapSnapshot;
export const resolveOmpLastTurnBoundary = history.resolveLastTurnBoundary;
export const resolveOmpForkBoundary = history.resolveForkBoundary;
