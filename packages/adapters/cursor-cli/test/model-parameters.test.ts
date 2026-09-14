import { describe, expect, it } from "vitest";

import {
  expandCursorParameterizedModels,
  formatCursorNativeModelVariant,
  normalizeCursorAvailableModels,
  normalizeCursorParameterizedSession,
  parseCursorNativeModelVariant,
} from "../src/model-parameters.js";
import { cursorCatalog, cursorModelRef, cursorNativeModel } from "../src/models.js";
import type { CursorSessionInfo } from "../src/transport.js";

const directory = normalizeCursorAvailableModels({
  models: [
    { value: "default", name: "Auto", configOptions: [] },
    {
      value: "grok-4.6",
      name: "Cursor Grok 4.6",
      configOptions: [
        {
          id: "fast",
          name: "Fast",
          type: "select",
          currentValue: "true",
          options: [
            { value: "false", name: "Off" },
            { value: "true", name: "Fast" },
          ],
        },
        {
          id: "effort",
          name: "Effort",
          type: "select",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "xhigh", name: "Extra High" },
          ],
        },
      ],
    },
  ],
});

function session(
  configOptions: NonNullable<CursorSessionInfo["configOptions"]>,
): CursorSessionInfo {
  return { sessionId: "cursor-session", configOptions };
}

describe("Cursor parameterized Models", () => {
  it("parses legacy bracket carriers and emits canonical parameter order", () => {
    expect(parseCursorNativeModelVariant("grok-4.6[fast=true,effort=xhigh]")).toEqual({
      modelId: "grok-4.6",
      parameters: { effort: "xhigh", fast: "true" },
    });
    expect(parseCursorNativeModelVariant("default")).toEqual({
      modelId: "default",
      parameters: {},
    });
    expect(
      formatCursorNativeModelVariant({
        modelId: "grok-4.6",
        parameters: { fast: "false", effort: "xhigh" },
      }),
    ).toBe("grok-4.6[effort=xhigh,fast=false]");
    expect(() => parseCursorNativeModelVariant("grok-4.6[fast=true,fast=false]")).toThrow(
      "duplicate parameter",
    );
    expect(() => parseCursorNativeModelVariant("grok-4.6[fast]")).toThrow("parameter is invalid");
  });

  it("accepts only finite native select axes and preserves their declared choices", () => {
    expect(directory).toEqual({
      models: [
        { value: "default", name: "Auto", parameters: [] },
        {
          value: "grok-4.6",
          name: "Cursor Grok 4.6",
          parameters: [
            {
              id: "fast",
              name: "Fast",
              values: [
                { value: "false", name: "Off" },
                { value: "true", name: "Fast" },
              ],
            },
            {
              id: "effort",
              name: "Effort",
              values: [
                { value: "low", name: "Low" },
                { value: "xhigh", name: "Extra High" },
              ],
            },
          ],
        },
      ],
    });
    expect(() =>
      normalizeCursorAvailableModels({
        models: [
          {
            value: "grok-4.6",
            name: "Cursor Grok 4.6",
            configOptions: [
              {
                id: "effort",
                name: "Effort",
                type: "select",
                options: [{ value: "xhigh", name: "Extra High" }],
              },
              {
                id: "effort",
                name: "Other effort",
                type: "select",
                options: [{ value: "high", name: "High" }],
              },
            ],
          },
        ],
      }),
    ).toThrow("duplicate parameter");
  });

  it("expands the native Cartesian product in deterministic canonical form", () => {
    expect(expandCursorParameterizedModels(directory)).toEqual([
      { value: "default[]", name: "Auto" },
      {
        value: "grok-4.6[effort=low,fast=false]",
        name: "Cursor Grok 4.6 (Effort: Low, Fast: Off)",
      },
      {
        value: "grok-4.6[effort=low,fast=true]",
        name: "Cursor Grok 4.6 (Effort: Low, Fast: Fast)",
      },
      {
        value: "grok-4.6[effort=xhigh,fast=false]",
        name: "Cursor Grok 4.6 (Effort: Extra High, Fast: Off)",
      },
      {
        value: "grok-4.6[effort=xhigh,fast=true]",
        name: "Cursor Grok 4.6 (Effort: Extra High, Fast: Fast)",
      },
    ]);
    expect(() =>
      expandCursorParameterizedModels(
        normalizeCursorAvailableModels({
          models: [
            {
              value: "too-many",
              name: "Too many",
              configOptions: [
                {
                  id: "choice",
                  name: "Choice",
                  type: "select",
                  options: Array.from({ length: 513 }, (_, index) => ({
                    value: String(index),
                    name: String(index),
                  })),
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow("exceeds");
  });

  it("normalizes a Session only when every declared native parameter has an observed value", () => {
    const normalized = normalizeCursorParameterizedSession(
      session([
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "grok-4.6",
          options: [{ value: "grok-4.6", name: "Cursor Grok 4.6" }],
        },
        { id: "effort", name: "Effort", type: "select", currentValue: "xhigh", options: [] },
        { id: "fast", name: "Fast", type: "select", currentValue: "false", options: [] },
      ]),
      directory,
    );
    const option = normalized.configOptions?.find((candidate) => candidate.id === "model");
    expect(option).toMatchObject({
      currentValue: "grok-4.6[effort=xhigh,fast=false]",
      options: expect.arrayContaining([
        expect.objectContaining({ value: "grok-4.6[effort=xhigh,fast=false]" }),
      ]),
    });

    expect(() =>
      normalizeCursorParameterizedSession(
        session([
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "grok-4.6",
            options: [{ value: "grok-4.6", name: "Cursor Grok 4.6" }],
          },
          { id: "effort", name: "Effort", type: "select", currentValue: "xhigh", options: [] },
        ]),
        directory,
      ),
    ).toThrow("did not report a current value for Cursor parameter 'fast'");
  });

  it("keeps an incomplete bootstrap current Model unknown without inventing directory defaults", () => {
    const bootstrap = session([
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "grok-4.6",
        options: [{ value: "grok-4.6", name: "Cursor Grok 4.6" }],
      },
    ]);
    const normalized = normalizeCursorParameterizedSession(bootstrap, directory, {
      allowUnknownCurrent: true,
    });
    const option = normalized.configOptions?.find((candidate) => candidate.id === "model");
    expect(option).toMatchObject({
      currentValue: "",
      options: expect.arrayContaining([
        expect.objectContaining({ value: "grok-4.6[effort=xhigh,fast=false]" }),
      ]),
    });
    expect(cursorCatalog(normalized)).not.toHaveProperty("defaultModel");
    expect(() => normalizeCursorParameterizedSession(bootstrap, directory)).toThrow(
      "did not report a current value",
    );
  });

  it("matches old opaque refs with equivalent bracket parameter order", () => {
    const normalized = normalizeCursorParameterizedSession(
      session([
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "grok-4.6[fast=true,effort=xhigh]",
          options: [{ value: "grok-4.6", name: "Cursor Grok 4.6" }],
        },
      ]),
      directory,
    );
    expect(
      cursorNativeModel(normalized, cursorModelRef("grok-4.6[fast=true,effort=xhigh]").id),
    ).toBe("grok-4.6[effort=xhigh,fast=true]");
    expect(() =>
      cursorNativeModel(normalized, cursorModelRef("grok-4.6[effort=xhigh,obsolete=true]").id),
    ).toThrow("native catalog");
  });
});
