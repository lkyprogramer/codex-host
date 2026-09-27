/** Native agentMention carriers shared by Composer and Host admission. */
export const DELEGATION_MENTION_PATH_PREFIX = "subagent://codexhost.";
export const HARNESS_COMMAND_MENTION_PATH_PREFIX = "subagent://codexhost-command.";
const HARNESS_ID = /^[a-z0-9][a-z0-9-]*$/u;
const LINKS = /\[@([^\]\r\n]+)\]\(<?(subagent:\/\/codexhost(?:-command)?\.[^)\s>]+)>?\)/gu;

export interface DelegationMention {
  harnessId: string;
  label: string;
}

function label(value: string): string {
  return (
    value
      .replace(/[[\]()\r\n]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim() || "agent"
  );
}

function escaped(text: string, offset: number): boolean {
  let slashes = 0;
  for (let i = offset - 1; i >= 0 && text[i] === "\\"; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/** Mark Markdown code before interpreting executable carriers. */
function codeOffsets(text: string): Uint8Array {
  const code = new Uint8Array(text.length);
  let fence: { character: string; length: number } | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const end = Math.min(text.length, offset + line.length + 1);
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    const markerText = marker?.[1];
    if (fence) {
      code.fill(1, offset, end);
      if (
        markerText &&
        markerText[0] === fence.character &&
        markerText.length >= fence.length &&
        !marker[2]?.trim()
      )
        fence = null;
    } else if (markerText && !(markerText[0] === "`" && marker?.[2]?.includes("`"))) {
      fence = { character: markerText[0] ?? "`", length: markerText.length };
      code.fill(1, offset, end);
    } else if (/^(?: {4}| {0,3}\t)/u.test(line)) {
      code.fill(1, offset, end);
    }
    offset = end;
  }
  const ticks = [...text.matchAll(/`+/gu)];
  for (let index = 0; index < ticks.length; index += 1) {
    const open = ticks[index];
    if (!open) continue;
    if (code[open.index] || escaped(text, open.index)) continue;
    let closed = false;
    let closeIndex = index + 1;
    while (closeIndex < ticks.length) {
      const close = ticks[closeIndex];
      if (!close) break;
      if (code[close.index]) break;
      if (close[0].length === open[0].length) {
        code.fill(1, open.index, close.index + close[0].length);
        index = closeIndex;
        closed = true;
        break;
      }
      closeIndex += 1;
    }
    // While composing, an unfinished code span must remain inert as well.
    if (!closed) {
      const boundary = ticks[closeIndex]?.index ?? text.length;
      code.fill(1, open.index, boundary);
      index = closeIndex - 1;
    }
  }
  return code;
}

/** Shared by the typed # trigger and Host carrier admission. */
export function isComposerCodePosition(text: string, offset: number): boolean {
  return codeOffsets(text)[offset] === 1;
}

function chips(text: string): Array<{ start: number; end: number; label: string; path: string }> {
  const code = codeOffsets(text);
  return [...text.matchAll(LINKS)]
    .filter((match) => !code[match.index] && !escaped(text, match.index))
    .map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      label: match[1] ?? "",
      path: match[2] ?? "",
    }));
}

export function delegationMentionPath(harnessId: string): string {
  if (!HARNESS_ID.test(harnessId)) throw new Error("Invalid delegation Harness ID");
  return DELEGATION_MENTION_PATH_PREFIX + harnessId;
}
export function formatDelegationMentionLink(mention: DelegationMention): string {
  return `[@${label(mention.label)}](${delegationMentionPath(mention.harnessId)})`;
}
export function stripDelegationMentions(text: string): {
  text: string;
  mentions: DelegationMention[];
} {
  const mentions: DelegationMention[] = [];
  const seen = new Set<string>();
  let result = "";
  let cursor = 0;
  for (const chip of chips(text)) {
    if (!chip.path.startsWith(DELEGATION_MENTION_PATH_PREFIX)) continue;
    const harnessId = chip.path.slice(DELEGATION_MENTION_PATH_PREFIX.length);
    if (!HARNESS_ID.test(harnessId)) throw new Error("Invalid delegation Harness ID");
    if (!seen.has(harnessId)) {
      seen.add(harnessId);
      mentions.push({ harnessId, label: chip.label });
    }
    result += text.slice(cursor, chip.start) + `@${chip.label}`;
    cursor = chip.end;
  }
  return { text: result + text.slice(cursor), mentions };
}

/** Scope prevents a retained chip being sent under a different Harness after reconnect. */
export function harnessCommandMentionPath(invocation: string, harnessId: string): string {
  if (!HARNESS_ID.test(harnessId) || !/^\/[^\s/][^\s]*$/u.test(invocation)) {
    throw new Error("Invalid Harness command carrier");
  }
  const encoded = encodeURIComponent(`${harnessId}:${invocation.slice(1)}`).replace(
    /[()]/gu,
    (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return HARNESS_COMMAND_MENTION_PATH_PREFIX + encoded;
}
export function formatHarnessCommandMentionLink(
  input: DelegationMention & { invocation: string },
): string {
  return `[@${label(input.label)}](${harnessCommandMentionPath(input.invocation, input.harnessId)})`;
}
export function decodeHarnessCommandMention(
  text: string,
  expectedHarnessId?: string,
): {
  text: string;
  command: { harnessId: string; invocation: string } | null;
} {
  const commands = chips(text).filter((chip) =>
    chip.path.startsWith(HARNESS_COMMAND_MENTION_PATH_PREFIX),
  );
  if (commands.length > 1) throw new Error("Only one command or skill chip can be sent per Turn");
  const chip = commands[0];
  if (!chip) return { text, command: null };
  let value: string;
  try {
    value = decodeURIComponent(chip.path.slice(HARNESS_COMMAND_MENTION_PATH_PREFIX.length));
  } catch {
    throw new Error("Invalid Harness command carrier encoding");
  }
  const colon = value.indexOf(":");
  if (colon <= 0) throw new Error("Invalid Harness command carrier scope");
  const harnessId = value.slice(0, colon);
  const invocation = `/${value.slice(colon + 1)}`;
  // Validate without normalizing any argument bytes.
  harnessCommandMentionPath(invocation, harnessId);
  if (expectedHarnessId !== undefined && harnessId !== expectedHarnessId) {
    throw new Error("Command chip belongs to another Harness");
  }
  const rest = text.slice(0, chip.start) + text.slice(chip.end);
  return {
    text: invocation + (rest && !/^\s/u.test(rest) ? " " : "") + rest,
    command: { harnessId, invocation },
  };
}
export function restoreHarnessCommandMentions(text: string, expectedHarnessId?: string): string {
  return decodeHarnessCommandMention(text, expectedHarnessId).text;
}
