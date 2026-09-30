import {
  decodeHarnessCommandMention,
  stripDelegationMentions,
  type HarnessCommandCatalog,
  type HarnessCommandDescriptor,
} from "@codexhost/shared-contracts";

export function decodeExternalComposerText(
  text: string,
  harnessId: string,
): { text: string; explicitCommand: boolean } {
  const decoded = decodeHarnessCommandMention(text, harnessId);
  if (decoded.command && stripDelegationMentions(text).mentions.length > 0) {
    throw new Error("Command and delegation chips cannot be combined in one Turn");
  }
  return { text: decoded.text, explicitCommand: decoded.command !== null };
}

export function matchExternalCommand(
  text: string,
  catalog: HarnessCommandCatalog,
): {
  descriptor: HarnessCommandDescriptor;
  arguments?: { text: string };
} | null {
  const candidate = text.trimStart();
  for (const descriptor of catalog.commands.toSorted(
    (left, right) => right.invocation.length - left.invocation.length,
  )) {
    if (candidate === descriptor.invocation) return { descriptor };
    if (!candidate.startsWith(descriptor.invocation)) continue;
    const remainder = candidate.slice(descriptor.invocation.length);
    if (!/^\s/u.test(remainder)) continue;
    // Consume one grammar separator only. Remaining indentation, tabs and trailing spaces are arguments.
    const argumentText = remainder.slice(1);
    if (descriptor.argumentMode === "none") {
      if (argumentText.trim())
        throw new Error(`Command '${descriptor.invocation}' does not accept arguments`);
      return { descriptor };
    }
    return { descriptor, ...(argumentText.length ? { arguments: { text: argumentText } } : {}) };
  }
  return null;
}
