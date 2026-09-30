import {
  createPiFamilyModelCatalog,
  type PiFamilyNativeModel,
  type PiFamilyNativeModelRef,
} from "@codexhost/adapter-pi-family";

export type PiNativeModelRef = PiFamilyNativeModelRef;
export type PiNativeModel = PiFamilyNativeModel;

const catalog = createPiFamilyModelCatalog({
  label: "Pi",
  modelRefPrefix: "pi-model-v1.",
  adapterName: "PiAdapter",
});

export const encodePiModelRef = catalog.encodeModelRef;
export const decodePiModelRef = catalog.decodeModelRef;
export const samePiModel = catalog.sameModel;
export const normalizePiThinkingOptions = catalog.normalizeThinkingOptions;
export const normalizePiModelCatalog = catalog.normalizeModelCatalog;
