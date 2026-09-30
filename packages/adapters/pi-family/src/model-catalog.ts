import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  harnessThinkingOptionSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessThinkingOption,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

/** A Pi-family Harness: Pi, and Oh My Pi which forks it. */
export interface PiFamily {
  /** Names the Harness in errors, for example "Pi". */
  readonly label: string;
  /** Prefix of the persisted Model Ref identity; never changes for a Harness. */
  readonly modelRefPrefix: string;
  /** Names the owning Adapter in errors, for example "PiAdapter". */
  readonly adapterName: string;
}

export interface PiFamilyNativeModelRef {
  provider: string;
  id: string;
}

export interface PiFamilyNativeModel extends PiFamilyNativeModelRef {
  reasoning: boolean;
}

const DRAFT_THINKING_OPTION_IDS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(
  (id) => harnessThinkingOptionIdSchema.parse(id),
);

const THINKING_LABELS: Readonly<Record<string, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fallbackThinkingLabel(id: string): string {
  const label = id
    .split(/[._~-]+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
  return label || id;
}

/** The Model identity and catalog rules every Pi-family Harness shares. */
export function createPiFamilyModelCatalog(family: PiFamily) {
  function assertNativePart(value: string, name: string): void {
    if (value.trim().length === 0) throw new Error(`${family.label} ${name} must not be empty`);
  }

  function encodeModelRef(model: PiFamilyNativeModelRef): HarnessModelRef {
    assertNativePart(model.provider, "Model provider");
    assertNativePart(model.id, "Model id");
    const encoded = Buffer.from(JSON.stringify([model.provider, model.id]), "utf8").toString(
      "base64url",
    );
    return harnessModelRefSchema.parse({ id: `${family.modelRefPrefix}${encoded}` });
  }

  function decodeModelRef(ref: HarnessModelRef): PiFamilyNativeModelRef {
    const parsedRef = harnessModelRefSchema.parse(ref);
    if (!parsedRef.id.startsWith(family.modelRefPrefix)) {
      throw new Error(`Model Ref does not belong to ${family.adapterName}`);
    }
    const encoded = parsedRef.id.slice(family.modelRefPrefix.length);
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw new Error(`${family.label} Model Ref is malformed`);
    }
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== "string" ||
      typeof decoded[1] !== "string"
    ) {
      throw new Error(`${family.label} Model Ref has an invalid native identity`);
    }
    const native = { provider: decoded[0], id: decoded[1] };
    assertNativePart(native.provider, "Model provider");
    assertNativePart(native.id, "Model id");
    if (encodeModelRef(native).id !== parsedRef.id) {
      throw new Error(`${family.label} Model Ref is not canonical`);
    }
    return native;
  }

  function sameModel(
    left: PiFamilyNativeModelRef | null,
    right: PiFamilyNativeModelRef | null,
  ): boolean {
    return left === null
      ? right === null
      : right !== null && left.provider === right.provider && left.id === right.id;
  }

  function normalizeThinkingOptions(
    levels: readonly HarnessThinkingOptionId[],
  ): HarnessThinkingOption[] {
    return levels.map((id) =>
      harnessThinkingOptionSchema.parse({
        id,
        label: THINKING_LABELS[id] ?? fallbackThinkingLabel(id),
      }),
    );
  }

  function normalizeModelCatalog(
    nativeModels: readonly PiFamilyNativeModel[],
    effectiveModel: PiFamilyNativeModelRef | null,
    thinkingLevels: readonly HarnessThinkingOptionId[] | null,
    effectiveThinkingOptionId: HarnessThinkingOptionId | null,
  ): HarnessModelCatalog {
    const byRef = new Map<
      string,
      { model: HarnessModelCatalog["models"][number]; reasoning: boolean }
    >();
    for (const native of nativeModels) {
      const ref = encodeModelRef(native);
      const existing = byRef.get(ref.id);
      if (existing) {
        if (existing.reasoning !== native.reasoning) {
          throw new Error(
            `${family.label} duplicate Model entries disagree on reasoning capability`,
          );
        }
        continue;
      }
      byRef.set(ref.id, {
        model: {
          ref,
          label: `${native.provider} / ${native.id}`,
        },
        reasoning: native.reasoning,
      });
    }
    const defaultModel = effectiveModel ? encodeModelRef(effectiveModel) : undefined;
    if (defaultModel && !byRef.has(defaultModel.id)) {
      throw new Error(`${family.label} effective Model is absent from the available Model catalog`);
    }
    if (
      thinkingLevels &&
      effectiveThinkingOptionId &&
      !thinkingLevels.includes(effectiveThinkingOptionId)
    ) {
      throw new Error(
        `${family.label} effective Thinking option is absent from the available option catalog`,
      );
    }
    if (thinkingLevels && !effectiveThinkingOptionId) {
      throw new Error(`${family.label} did not report an effective Thinking option`);
    }

    const thinkingOptions = thinkingLevels
      ? normalizeThinkingOptions(DRAFT_THINKING_OPTION_IDS)
      : [];
    const allThinkingOptionIds = thinkingOptions.map(({ id }) => id);
    const offThinkingOptionId = thinkingOptions.find(({ id }) => id === "off")?.id;
    const models = [...byRef.values()]
      .map(({ model, reasoning }) => ({
        ...model,
        supportedThinkingOptionIds: reasoning
          ? allThinkingOptionIds
          : offThinkingOptionId
            ? [offThinkingOptionId]
            : [],
      }))
      .sort(
        (left, right) =>
          compareText(left.label, right.label) || compareText(left.ref.id, right.ref.id),
      );
    const defaultThinkingOptionId = thinkingOptions.find(
      ({ id }) => id === effectiveThinkingOptionId,
    )?.id;
    return harnessModelCatalogSchema.parse({
      models,
      ...(defaultModel ? { defaultModel } : {}),
      thinkingOptions,
      ...(defaultThinkingOptionId ? { defaultThinkingOptionId } : {}),
    });
  }

  return {
    encodeModelRef,
    decodeModelRef,
    sameModel,
    normalizeThinkingOptions,
    normalizeModelCatalog,
  };
}
