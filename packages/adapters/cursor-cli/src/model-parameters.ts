import type { CursorSessionInfo } from "./transport.js";

export const MAX_CURSOR_PARAMETERIZED_MODEL_VARIANTS = 512;

export interface CursorModelParameterValue {
  value: string;
  name: string;
}

export interface CursorModelParameter {
  id: string;
  name: string;
  values: readonly CursorModelParameterValue[];
}

export interface CursorAvailableModel {
  value: string;
  name: string;
  parameters: readonly CursorModelParameter[];
}

export interface CursorAvailableModels {
  models: readonly CursorAvailableModel[];
}

export interface CursorNativeModelVariant {
  modelId: string;
  parameters: Record<string, string>;
}

export interface CursorParameterizedModelOption {
  value: string;
  name: string;
}

export interface CursorParameterizedSessionOptions {
  allowUnknownCurrent?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, description: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(description);
  return value.trim();
}

function parameterKey(value: string): string {
  if (/[\[\],=]/u.test(value) || value === "__proto__" || value === "constructor") {
    throw new Error("Cursor model parameter key is invalid");
  }
  return value;
}

function parameterValue(value: string): string {
  if (/[\[\],]/u.test(value)) throw new Error("Cursor model parameter value is invalid");
  return value;
}

function flattenedOptions(value: unknown): CursorModelParameterValue[] {
  if (!Array.isArray(value)) throw new Error("Cursor model parameter has no finite select options");
  const flattened: CursorModelParameterValue[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) throw new Error("Cursor model parameter option is invalid");
    if (typeof entry.value === "string") {
      flattened.push({
        value: parameterValue(text(entry.value, "Cursor model parameter option value is invalid")),
        name: text(entry.name, "Cursor model parameter option name is invalid"),
      });
      continue;
    }
    flattened.push(...flattenedOptions(entry.options));
  }
  if (!flattened.length) throw new Error("Cursor model parameter has no finite select options");
  const values = new Set<string>();
  for (const option of flattened) {
    if (values.has(option.value))
      throw new Error("Cursor model parameter has duplicate option values");
    values.add(option.value);
  }
  return flattened;
}

function sortedParameters(parameters: readonly CursorModelParameter[]): CursorModelParameter[] {
  return [...parameters].sort((left, right) => left.id.localeCompare(right.id));
}

function knownParameterValue(
  model: CursorAvailableModel,
  parameter: CursorModelParameter,
  value: string,
): string {
  if (!parameter.values.some((candidate) => candidate.value === value)) {
    throw new Error(
      `Cursor parameter '${parameter.id}' value is unavailable for model '${model.value}'`,
    );
  }
  return value;
}

/** Parses both old order-preserving carriers and new canonical native model variants. */
export function parseCursorNativeModelVariant(value: string): CursorNativeModelVariant {
  const start = value.indexOf("[");
  const rawModelId = start === -1 ? value : value.slice(0, start);
  const modelId = text(rawModelId, "Cursor native model identifier is invalid");
  if (/[\[\],]/u.test(modelId)) throw new Error("Cursor native model identifier is invalid");
  if (start === -1) {
    if (value.includes("]")) throw new Error("Cursor native model variant is invalid");
    return { modelId, parameters: {} };
  }
  if (!value.endsWith("]") || value.indexOf("[", start + 1) !== -1) {
    throw new Error("Cursor native model variant is invalid");
  }
  const content = value.slice(start + 1, -1);
  const parameters: Record<string, string> = {};
  if (content) {
    for (const entry of content.split(",")) {
      const separator = entry.indexOf("=");
      if (separator <= 0) throw new Error("Cursor native model parameter is invalid");
      const key = parameterKey(entry.slice(0, separator).trim());
      const parameter = parameterValue(
        text(entry.slice(separator + 1), "Cursor native model parameter is invalid"),
      );
      if (Object.hasOwn(parameters, key))
        throw new Error(`Cursor native model variant has duplicate parameter '${key}'`);
      parameters[key] = parameter;
    }
  }
  return {
    modelId,
    parameters: Object.fromEntries(
      Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

export function formatCursorNativeModelVariant(value: CursorNativeModelVariant): string {
  const modelId = text(value.modelId, "Cursor native model identifier is invalid");
  if (/[\[\],]/u.test(modelId)) throw new Error("Cursor native model identifier is invalid");
  const parameters = Object.entries(value.parameters)
    .map(
      ([key, parameter]) =>
        [
          parameterKey(key),
          parameterValue(text(parameter, "Cursor native model parameter is invalid")),
        ] as const,
    )
    .sort(([left], [right]) => left.localeCompare(right));
  if (new Set(parameters.map(([key]) => key)).size !== parameters.length) {
    throw new Error("Cursor native model variant has duplicate parameter");
  }
  return `${modelId}[${parameters.map(([key, parameter]) => `${key}=${parameter}`).join(",")}]`;
}

/** Validates Cursor's private finite model directory without assigning any missing defaults. */
export function normalizeCursorAvailableModels(value: unknown): CursorAvailableModels {
  if (!isRecord(value) || !Array.isArray(value.models))
    throw new Error("Cursor returned no parameterized model directory");
  const values = new Set<string>();
  const models = value.models.map((entry): CursorAvailableModel => {
    if (!isRecord(entry)) throw new Error("Cursor parameterized model directory entry is invalid");
    const parsed = parseCursorNativeModelVariant(
      text(entry.value, "Cursor parameterized model identifier is invalid"),
    );
    if (Object.keys(parsed.parameters).length) {
      throw new Error("Cursor parameterized model directory must use base model identifiers");
    }
    if (values.has(parsed.modelId))
      throw new Error("Cursor parameterized model directory has duplicate models");
    values.add(parsed.modelId);
    if (!Array.isArray(entry.configOptions))
      throw new Error("Cursor parameterized model directory has invalid config options");
    const parameterIds = new Set<string>();
    const parameters = entry.configOptions.map((option): CursorModelParameter => {
      if (!isRecord(option) || option.type !== "select") {
        throw new Error("Cursor model parameter must be a finite select option");
      }
      const id = parameterKey(text(option.id, "Cursor model parameter identifier is invalid"));
      if (parameterIds.has(id))
        throw new Error("Cursor parameterized model has duplicate parameter identifiers");
      parameterIds.add(id);
      return {
        id,
        name: text(option.name, "Cursor model parameter name is invalid"),
        values: flattenedOptions(option.options),
      };
    });
    return {
      value: parsed.modelId,
      name: text(entry.name, "Cursor parameterized model name is invalid"),
      parameters,
    };
  });
  if (!models.length) throw new Error("Cursor returned no parameterized models");
  return { models };
}

export function expandCursorParameterizedModels(
  directory: CursorAvailableModels,
): CursorParameterizedModelOption[] {
  const result: CursorParameterizedModelOption[] = [];
  for (const model of directory.models) {
    let combinations: Array<Record<string, CursorModelParameterValue>> = [{}];
    for (const parameter of sortedParameters(model.parameters)) {
      if (!parameter.values.length)
        throw new Error("Cursor model parameter has no finite select options");
      if (
        combinations.length >
        Math.floor(MAX_CURSOR_PARAMETERIZED_MODEL_VARIANTS / parameter.values.length)
      ) {
        throw new Error("Cursor parameterized model catalog exceeds the supported variant limit");
      }
      combinations = combinations.flatMap((combination) =>
        parameter.values.map((value) => ({ ...combination, [parameter.id]: value })),
      );
    }
    if (result.length + combinations.length > MAX_CURSOR_PARAMETERIZED_MODEL_VARIANTS) {
      throw new Error("Cursor parameterized model catalog exceeds the supported variant limit");
    }
    const parameters = sortedParameters(model.parameters);
    for (const combination of combinations) {
      const selected = Object.fromEntries(
        parameters.map((parameter) => [parameter.id, combination[parameter.id]?.value ?? ""]),
      );
      if (Object.values(selected).some((value) => !value)) {
        throw new Error("Cursor parameterized model catalog has an incomplete variant");
      }
      const labels = parameters.map((parameter) => {
        const selectedValue = combination[parameter.id];
        if (!selectedValue)
          throw new Error("Cursor parameterized model catalog has an incomplete variant");
        return `${parameter.name}: ${selectedValue.name}`;
      });
      result.push({
        value: formatCursorNativeModelVariant({ modelId: model.value, parameters: selected }),
        name: labels.length ? `${model.name} (${labels.join(", ")})` : model.name,
      });
    }
  }
  return result;
}

function currentModelOption(info: CursorSessionInfo) {
  const option = info.configOptions?.find((candidate) => candidate.id === "model");
  if (!option || option.type !== "select")
    throw new Error("Cursor returned no model configuration");
  return option;
}

function currentParameters(
  info: CursorSessionInfo,
  model: CursorAvailableModel,
  parsed: CursorNativeModelVariant,
  allowUnknownCurrent: boolean,
): Record<string, string> | undefined {
  const known = new Map(model.parameters.map((parameter) => [parameter.id, parameter]));
  for (const key of Object.keys(parsed.parameters)) {
    if (!known.has(key)) {
      throw new Error(`Cursor current Model has unknown parameter '${key}'`);
    }
  }
  const current: Record<string, string> = {};
  let missing = false;
  for (const parameter of model.parameters) {
    const fromModelCarrier = parsed.parameters[parameter.id];
    const sessionOption = info.configOptions?.find((candidate) => candidate.id === parameter.id);
    const fromSession =
      sessionOption && sessionOption.type === "select" ? sessionOption.currentValue : undefined;
    const value = fromModelCarrier ?? fromSession;
    if (value === undefined) {
      if (allowUnknownCurrent) {
        missing = true;
        continue;
      }
      throw new Error(
        `Cursor Session did not report a current value for Cursor parameter '${parameter.id}'`,
      );
    }
    if (
      fromModelCarrier !== undefined &&
      fromSession !== undefined &&
      fromModelCarrier !== fromSession
    ) {
      throw new Error(`Cursor current Model disagrees with parameter '${parameter.id}'`);
    }
    current[parameter.id] = knownParameterValue(model, parameter, value);
  }
  return missing ? undefined : current;
}

/**
 * Replaces Cursor's base-only ACP model selector with only variants backed by
 * the native finite directory. Current parameters must come from the Session,
 * never from directory defaults.
 */
export function normalizeCursorParameterizedSession(
  info: CursorSessionInfo,
  directory: CursorAvailableModels,
  options: CursorParameterizedSessionOptions = {},
): CursorSessionInfo {
  const configOptions = info.configOptions;
  if (!configOptions) throw new Error("Cursor returned no model configuration");
  const option = currentModelOption(info);
  const expanded = expandCursorParameterizedModels(directory);
  if (!option.currentValue.trim()) {
    if (!options.allowUnknownCurrent) throw new Error("Cursor native model identifier is invalid");
    return {
      ...info,
      configOptions: configOptions.map((candidate) =>
        candidate.id === "model" && candidate.type === "select"
          ? { ...candidate, currentValue: "", options: expanded }
          : candidate,
      ),
    };
  }
  const current = parseCursorNativeModelVariant(option.currentValue);
  const model = directory.models.find((candidate) => candidate.value === current.modelId);
  if (!model) throw new Error("Cursor current Model is absent from the native parameter directory");
  const parameters = currentParameters(info, model, current, options.allowUnknownCurrent === true);
  const currentValue = parameters
    ? formatCursorNativeModelVariant({ modelId: model.value, parameters })
    : "";
  if (currentValue && !expanded.some((candidate) => candidate.value === currentValue)) {
    throw new Error("Cursor current Model is not a native parameterized variant");
  }
  return {
    ...info,
    configOptions: configOptions.map((candidate) =>
      candidate.id === "model" && candidate.type === "select"
        ? { ...candidate, currentValue, options: expanded }
        : candidate,
    ),
  };
}
