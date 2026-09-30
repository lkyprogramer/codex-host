import {
  stripDelegationMentions as decodeDelegationMentions,
  decodeHarnessCommandMention as decodeCommandMention,
  type DelegationMention,
} from "@codexhost/shared-contracts";
import type { JsonObject, JsonValue } from "@codexhost/protocol-core";

export class ComposerMentionError extends Error {}

function stripDelegationMentions(text: string) {
  try {
    return decodeDelegationMentions(text);
  } catch (error) {
    throw new ComposerMentionError(error instanceof Error ? error.message : String(error));
  }
}
function decodeHarnessCommandMention(text: string) {
  try {
    return decodeCommandMention(text);
  } catch (error) {
    throw new ComposerMentionError(error instanceof Error ? error.message : String(error));
  }
}

export interface DelegationSkillReference {
  name: string;
  path: string;
}

function instruction(
  mentions: readonly DelegationMention[],
  available: (id: string) => boolean,
): string {
  for (const { harnessId } of mentions) {
    if (!available(harnessId))
      throw new ComposerMentionError(`Delegation Harness '${harnessId}' is unavailable`);
  }
  return `[codexhost delegation] The user selected ${mentions.map(({ harnessId }) => JSON.stringify(harnessId)).join(", ")} as delegation targets. Use the codexhost-delegation skill and the existing codexhost delegate workflow for each target. Preserve the requested task, model and permission constraints; do not substitute another Harness or bypass delegation admission.`;
}

export function rewriteDelegationMentionText(
  text: string,
  available: (id: string) => boolean,
): string {
  const result = stripDelegationMentions(text);
  return result.mentions.length === 0
    ? text
    : `${result.text}\n\n${instruction(result.mentions, available)}`;
}

/** Native Codex input metadata and attachments retain their exact objects. */
export function rewriteDelegationMentionInput(
  input: readonly JsonValue[],
  available: (id: string) => boolean,
  skill: DelegationSkillReference | null = null,
): JsonValue[] | null {
  const mentions: DelegationMention[] = [];
  const seen = new Set<string>();
  let lastText = -1;
  const rewritten = input.map((item, index) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      item.type !== "text" ||
      typeof item.text !== "string"
    )
      return item;
    if (decodeHarnessCommandMention(item.text).command)
      throw new ComposerMentionError("Command chips require an external Harness Thread");
    lastText = index;
    const result = stripDelegationMentions(item.text);
    for (const mention of result.mentions) {
      if (!seen.has(mention.harnessId)) {
        seen.add(mention.harnessId);
        mentions.push(mention);
      }
    }
    return result.mentions.length > 0 ? { ...item, text: result.text } : item;
  });
  if (mentions.length === 0) return null;
  const textItem = rewritten[lastText] as JsonObject;
  rewritten[lastText] = {
    ...textItem,
    text: `${String(textItem.text)}\n\n${instruction(mentions, available)}`,
  };
  if (
    skill &&
    !rewritten.some(
      (item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        item.type === "skill" &&
        item.name === skill.name,
    )
  ) {
    rewritten.push({ type: "skill", name: skill.name, path: skill.path });
  }
  return rewritten;
}
