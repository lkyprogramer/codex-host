/**
 * Projects `command-code --list-models` into a Host Model Catalog.
 *
 * The CLI prints a human-readable table: a heading, blank-line separated
 * provider sections, then one `<id>  <description>` row per Model with the
 * configured default marked `(default)`. Native IDs contain `/` and `:`
 * (`deepseek/deepseek-v4-flash`, `…-sante:free`), which the transport-safe
 * Model Ref alphabet rejects, so each ID travels base64url-encoded behind a
 * versioned prefix and is decoded back before reaching `-m`.
 *
 * No Thinking options are offered: `--effort` is not a per-run parameter but a
 * write to the user's `~/.commandcode/config.json` (`reasoningEffort[model]`),
 * so a selection here would silently change every other Thread and the user's
 * own interactive sessions. Effort therefore follows the user's CLI config.
 */
import {
  HARNESS_MODEL_REF_MAX_LENGTH,
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
} from "@codexhost/shared-contracts";

const MODEL_REF_PREFIX = "command-code-model-v1.";

const MODEL_ROW_PATTERN = /^(?<id>[a-z0-9][a-z0-9._:/-]*)\s{2,}(?<description>\S.*)$/u;

const DEFAULT_MARKER_PATTERN = /\(default\)\s*$/iu;

const ANSI_PATTERN = /\u001B\[[0-9;]*[A-Za-z]/gu;

export function encodeCommandCodeModelRef(nativeModelId: string): HarnessModelRef {
  const id = nativeModelId.trim();
  if (!id) throw new Error("Command Code Model ID must not be empty");
  const ref = `${MODEL_REF_PREFIX}${Buffer.from(id, "utf8").toString("base64url")}`;
  if (ref.length > HARNESS_MODEL_REF_MAX_LENGTH) {
    throw new Error("Command Code Model ID is too long for a Model Ref");
  }
  return harnessModelRefSchema.parse({ id: ref });
}

export function decodeCommandCodeModelRef(ref: HarnessModelRef): string {
  const parsed = harnessModelRefSchema.parse(ref);
  if (!parsed.id.startsWith(MODEL_REF_PREFIX)) {
    throw new Error("Command Code Model Ref belongs to another Adapter");
  }
  const encoded = parsed.id.slice(MODEL_REF_PREFIX.length);
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  if (!decoded.trim() || Buffer.from(decoded, "utf8").toString("base64url") !== encoded) {
    throw new Error("Command Code Model Ref is malformed");
  }
  return decoded;
}

export function parseCommandCodeModels(output: string): HarnessModelCatalog {
  const models: HarnessModelCatalog["models"] = [];
  let defaultModel: HarnessModelRef | undefined;
  const seen = new Set<string>();
  for (const rawLine of output.replace(ANSI_PATTERN, "").split(/\r?\n/u)) {
    const match = MODEL_ROW_PATTERN.exec(rawLine.trim());
    if (!match?.groups) continue;
    const id = match.groups.id as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const ref = encodeCommandCodeModelRef(id);
    models.push({ ref, label: id, resolvedModelLabel: id });
    if (DEFAULT_MARKER_PATTERN.test(match.groups.description as string)) defaultModel ??= ref;
  }
  return harnessModelCatalogSchema.parse({
    models,
    ...(defaultModel ? { defaultModel } : {}),
    thinkingOptions: [],
  });
}

/** `-m` for the selected Model; the CLI resolves the listed display ID to its canonical form. */
export function commandCodeModelArguments(model: HarnessModelRef | undefined): string[] {
  return model ? ["-m", decodeCommandCodeModelRef(model)] : [];
}
