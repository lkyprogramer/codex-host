import {
  createPiFamilyModelCatalog,
  type PiFamilyNativeModel,
  type PiFamilyNativeModelRef,
} from "@codexhost/adapter-pi-family";

export type OmpNativeModelRef = PiFamilyNativeModelRef;
export type OmpNativeModel = PiFamilyNativeModel;

const catalog = createPiFamilyModelCatalog({
  label: "Omp",
  modelRefPrefix: "omp-model-v1.",
  adapterName: "OmpAdapter",
});

export const encodeOmpModelRef = catalog.encodeModelRef;
export const decodeOmpModelRef = catalog.decodeModelRef;
export const sameOmpModel = catalog.sameModel;
export const normalizeOmpThinkingOptions = catalog.normalizeThinkingOptions;
export const normalizeOmpModelCatalog = catalog.normalizeModelCatalog;
