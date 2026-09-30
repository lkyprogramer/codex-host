import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CLAUDE_DEFAULT_MODEL_REF,
  decodeClaudeModelRef,
  encodeClaudeModelRef,
  mergeClaudeModelPickerOptions,
  normalizeClaudeModelCatalog,
  parseClaudeModelPickerSettings,
  readClaudeUserModelPicker,
  resolveClaudeConfigDirectory,
} from "../src/model-catalog.js";

function snapshot(models: unknown) {
  return { models, canSelectModel: true, canSelectPermissionMode: true };
}

describe("Claude Code runtime Model catalog", () => {
  it("round-trips canonical private Refs and reserves default for no override", () => {
    const alias = encodeClaudeModelRef("sonnet");
    expect(decodeClaudeModelRef(alias)).toBe("sonnet");
    expect(decodeClaudeModelRef(CLAUDE_DEFAULT_MODEL_REF)).toBeUndefined();
    expect(() => decodeClaudeModelRef({ id: "pi-model-v1.private" } as never)).toThrow(
      "another Adapter",
    );
    expect(() => decodeClaudeModelRef({ id: `${alias.id}=` } as never)).toThrow();
  });

  it("preserves default, aliases, and custom rows that resolve to one actual Model", () => {
    const normalized = normalizeClaudeModelCatalog(
      snapshot([
        {
          value: "default",
          displayName: "Default",
          description: "ignored",
          resolvedModel: "runtime-custom",
        },
        {
          value: "sonnet",
          displayName: "Family",
          description: "ignored",
          resolvedModel: "runtime-custom",
          supportsEffort: true,
          supportedEffortLevels: ["low", "adaptive-v2", "high", "adaptive-v2"],
        },
        {
          value: "custom-model",
          displayName: "Family",
          description: "ignored",
          resolvedModel: "runtime-custom",
          provider: { baseUrl: "https://private.invalid", apiKey: "secret" },
          price: 42,
        },
      ]),
    );

    expect(normalized.catalog.models).toHaveLength(3);
    expect(new Set(normalized.catalog.models.map(({ ref }) => ref.id)).size).toBe(3);
    expect(new Set(normalized.catalog.models.map(({ label }) => label)).size).toBe(3);
    expect(
      normalized.catalog.models.filter(
        ({ resolvedModelLabel }) => resolvedModelLabel === "runtime-custom",
      ),
    ).toHaveLength(3);
    expect(normalized.catalog.defaultModel).toEqual(CLAUDE_DEFAULT_MODEL_REF);
    expect(normalized.catalog.thinkingOptions).toEqual([
      { id: "off", label: "Off" },
      { id: "auto", label: "Auto" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Max" },
    ]);
    expect(normalized.catalog.defaultThinkingOptionId).toBe("auto");
    expect(
      normalized.catalog.models.find(({ label }) => label.startsWith("Family (sonnet"))
        ?.supportedThinkingOptionIds,
    ).toEqual(["off", "auto", "low", "medium", "high", "xhigh", "max"]);
    expect(JSON.stringify(normalized.catalog)).not.toMatch(/private|apiKey|price|supportsEffort/u);
  });

  it("uses deterministic bounded labels for long duplicate display names", () => {
    const displayName = "D".repeat(250);
    const normalized = normalizeClaudeModelCatalog(
      snapshot([
        { value: `a-${"x".repeat(100)}`, displayName },
        { value: `b-${"x".repeat(100)}`, displayName },
      ]),
    );
    const duplicateLabels = normalized.catalog.models
      .filter(({ ref }) => ref.id !== CLAUDE_DEFAULT_MODEL_REF.id)
      .map(({ label }) => label);

    expect(duplicateLabels).toHaveLength(2);
    expect(new Set(duplicateLabels).size).toBe(2);
    expect(duplicateLabels.every((label) => label.length <= 256)).toBe(true);
    expect(duplicateLabels).toEqual([...duplicateLabels].sort());
  });

  it("synthesizes only the dynamic default control when runtime omitted that row", () => {
    const normalized = normalizeClaudeModelCatalog(
      snapshot([
        {
          value: "custom-model",
          displayName: "Custom",
          description: "ignored",
          supportedEffortLevels: [{ future: true }],
        },
      ]),
    );

    expect(normalized.catalog.models.map(({ ref }) => decodeClaudeModelRef(ref))).toEqual([
      undefined,
      "custom-model",
    ]);
    expect(normalized.catalog.models[0]).toMatchObject({ label: "Default" });
    expect(normalized.catalog.models[0]).not.toHaveProperty("resolvedModelLabel");
    expect(normalized.catalog.models[1]).not.toHaveProperty("resolvedModelLabel");
  });

  it("rejects unavailable, empty, malformed, conflicting, and unbounded observations", () => {
    for (const value of [
      {
        models: [],
        canSelectModel: true,
        canSelectPermissionMode: true,
      },
      {
        models: "not-an-array",
        canSelectModel: true,
        canSelectPermissionMode: true,
      },
      snapshot([{ value: "", displayName: "Bad" }]),
      snapshot([{ value: "valid", displayName: "" }]),
      snapshot([
        { value: "same", displayName: "First" },
        { value: "same", displayName: "Second" },
      ]),
    ]) {
      expect(() => normalizeClaudeModelCatalog(value)).toThrow();
    }
    expect(() =>
      normalizeClaudeModelCatalog({
        models: [],
        canSelectModel: false,
        canSelectPermissionMode: false,
      }),
    ).toThrow("unavailable");
  });
});

describe("Claude Code user modelPicker", () => {
  const sdkModels = [
    { value: "default", displayName: "Default" },
    { value: "sonnet", displayName: "Sonnet" },
    { value: "opus", displayName: "Opus" },
  ];

  it("appends valid options, deduplicates native values, and preserves picker refs", () => {
    const settings = parseClaudeModelPickerSettings({
      options: [
        { model: " gateway/model[1m] ", label: "Gateway", behavesAs: "sonnet" },
        { model: "gateway/model[1m]", label: "Duplicate" },
        { model: "sonnet", label: "Duplicate SDK model" },
        { model: " ", label: "Invalid" },
      ],
    });
    const merged = mergeClaudeModelPickerOptions(sdkModels, settings);
    expect(merged).toEqual([
      ...sdkModels,
      { value: "gateway/model[1m]", displayName: "Gateway", resolvedModel: "sonnet" },
    ]);
    const catalog = normalizeClaudeModelCatalog(snapshot(merged)).catalog;
    const custom = catalog.models.find(({ label }) => label === "Gateway");
    expect(custom?.resolvedModelLabel).toBe("sonnet");
    expect(custom && decodeClaudeModelRef(custom.ref)).toBe("gateway/model[1m]");
  });

  it("replaces built-ins while retaining default and the native model value", () => {
    const settings = parseClaudeModelPickerSettings({
      replaceBuiltInOptions: true,
      options: [{ model: "gateway/model", label: "Gateway" }],
    });
    const catalog = normalizeClaudeModelCatalog(
      snapshot(mergeClaudeModelPickerOptions(sdkModels, settings)),
    ).catalog;
    expect(catalog.models.map(({ ref }) => decodeClaudeModelRef(ref))).toEqual([
      undefined,
      "gateway/model",
    ]);
  });

  it("treats an explicit empty list as replacement and leaves SDK models for invalid settings", () => {
    const empty = parseClaudeModelPickerSettings({
      replaceBuiltInOptions: true,
      options: [],
    });
    expect(mergeClaudeModelPickerOptions(sdkModels, empty)).toEqual([sdkModels[0]]);
    for (const value of [
      { replaceBuiltInOptions: true, options: [{ label: "missing model" }, null] },
      { replaceBuiltInOptions: true, options: [{ model: "x".repeat(400) }] },
      { replaceBuiltInOptions: true, options: "invalid" },
      { replaceBuiltInOptions: "invalid", options: [{ model: "gateway" }] },
      {},
    ]) {
      expect(
        mergeClaudeModelPickerOptions(sdkModels, parseClaudeModelPickerSettings(value)),
      ).toEqual(sdkModels);
    }
  });

  it("reads only a temporary custom config directory and ignores missing or malformed files", async () => {
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-claude-models-"));
    const environment = { CLAUDE_CONFIG_DIR: configDirectory };
    try {
      expect(resolveClaudeConfigDirectory(environment)).toBe(path.resolve(configDirectory));
      await expect(readClaudeUserModelPicker(environment)).resolves.toBeUndefined();
      await writeFile(path.join(configDirectory, "settings.json"), "{invalid-json");
      await expect(readClaudeUserModelPicker(environment)).resolves.toBeUndefined();
      await writeFile(
        path.join(configDirectory, "settings.json"),
        JSON.stringify({
          modelPicker: {
            replaceBuiltInOptions: true,
            options: [
              { model: "gateway/model", label: "Gateway" },
              { model: "gateway/model", label: "Duplicate" },
              { model: "  " },
            ],
          },
          apiKey: "never-projected",
        }),
      );
      const settings = await readClaudeUserModelPicker(environment);
      expect(settings).toEqual({
        replaceBuiltInOptions: true,
        options: [{ model: "gateway/model", label: "Gateway" }],
      });
      expect(JSON.stringify(settings)).not.toContain("never-projected");
    } finally {
      await rm(configDirectory, { recursive: true, force: true });
    }
  });
});
