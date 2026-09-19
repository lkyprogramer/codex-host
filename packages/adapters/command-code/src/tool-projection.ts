import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { createTwoFilesPatch } from "diff";

import type {
  HostCommandExecutionItem,
  HostFileChange,
  HostItem,
  HostToolExecutionItem,
  HostToolOutput,
} from "@codexhost/harness-adapter";
import type { HostItemId, JsonValue } from "@codexhost/shared-contracts";

import { isRecord } from "./stream-events.js";

/** Built-in shell tools whose `command` input reads best as a command card. */
const COMMAND_TOOLS = new Set(["shell_command", "powershell_command", "monitor_command"]);

/** Built-in tools that rewrite a workspace file named by `file_path`. */
const FILE_MUTATING_TOOLS = new Set(["edit_file", "write_file"]);

/** Files larger than this are not snapshotted; the tool then stays a plain Tool Execution. */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function isCommandCodeCommandTool(toolName: string): boolean {
  return COMMAND_TOOLS.has(toolName);
}

export function isCommandCodeFileMutatingTool(toolName: string): boolean {
  return FILE_MUTATING_TOOLS.has(toolName);
}

/** Absolute target of a file-mutating tool call, or null when the input is not usable. */
export function commandCodeToolTargetFile(input: unknown, cwd: string): string | null {
  if (!isRecord(input)) return null;
  const filePath = input.file_path;
  if (typeof filePath !== "string" || !filePath.trim() || filePath.includes("\0")) return null;
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);
}

export function displayPath(absolutePath: string, cwd: string): string {
  const relative = path.relative(path.resolve(cwd), absolutePath);
  const inside =
    relative.length > 0 &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`);
  return (inside ? relative : absolutePath).replaceAll("\\", "/");
}

/** Current file text, `null` when the file does not exist, `undefined` when it cannot be diffed. */
export async function snapshotCommandCodeFile(
  absolutePath: string,
): Promise<string | null | undefined> {
  try {
    const info = await stat(absolutePath);
    if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) return undefined;
    return await readFile(absolutePath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
      return null;
    }
    return undefined;
  }
}

export function commandCodeFileChange(input: {
  absolutePath: string;
  cwd: string;
  before: string | null;
  after: string | null;
}): HostFileChange | null {
  if (input.before === input.after) return null;
  const shown = displayPath(input.absolutePath, input.cwd);
  const kind = input.before === null ? "add" : input.after === null ? "delete" : "update";
  const oldHeader = kind === "add" ? "/dev/null" : `a/${shown}`;
  const newHeader = kind === "delete" ? "/dev/null" : `b/${shown}`;
  return {
    path: shown,
    kind,
    unifiedDiff: createTwoFilesPatch(
      oldHeader,
      newHeader,
      input.before ?? "",
      input.after ?? "",
      "",
      "",
      {
        context: 3,
      },
    ),
  };
}

/**
 * Reverses an `edit_file` call on the file's current text to recover the
 * pre-edit content. Reading the file before the tool runs races the CLI, which
 * executes right after `tool_running`; the tool input is exact, so undoing the
 * replacement is the reliable source. A `new_string` that also occurs earlier
 * in the file can pick the wrong occurrence; the snapshot then remains the fallback.
 */
export function reverseCommandCodeEdit(input: unknown, after: string): string | null {
  if (!isRecord(input)) return null;
  const { old_string: oldString, new_string: newString, replace_all: replaceAll } = input;
  if (typeof oldString !== "string" || typeof newString !== "string") return null;
  if (oldString === newString || !newString) return null;
  if (!after.includes(newString)) return null;
  return replaceAll === true
    ? after.replaceAll(newString, oldString)
    : after.replace(newString, oldString);
}

export interface CommandCodeMutation {
  toolName: string;
  input: unknown;
  absolutePath: string;
  cwd: string;
  /** Pre-execution snapshot, captured when the tool call was first seen. */
  before: Promise<string | null | undefined>;
}

/** Resolves a completed file-mutating tool call into a File Change, or null when no patch is provable. */
export async function resolveCommandCodeFileChange(
  mutation: CommandCodeMutation,
): Promise<HostFileChange | null> {
  const after = await snapshotCommandCodeFile(mutation.absolutePath);
  if (after === undefined) return null;
  let before: string | null | undefined;
  if (mutation.toolName === "edit_file" && after !== null) {
    before = reverseCommandCodeEdit(mutation.input, after);
  }
  before ??= await mutation.before;
  if (before === undefined) return null;
  return commandCodeFileChange({
    absolutePath: mutation.absolutePath,
    cwd: mutation.cwd,
    before,
    after,
  });
}

export function startCommandCodeToolItem(
  itemId: HostItemId,
  toolName: string,
  input: unknown,
  cwd: string,
): HostCommandExecutionItem | HostToolExecutionItem {
  if (isCommandCodeCommandTool(toolName) && isRecord(input) && typeof input.command === "string") {
    return { type: "commandExecution", itemId, command: input.command, cwd };
  }
  return { type: "toolExecution", itemId, toolName, arguments: jsonValue(input ?? {}) };
}

/** Flattens tool result content blocks (`text` / `image`) into Host tool output. */
export function commandCodeToolOutput(result: unknown, limit: number): HostToolOutput | null {
  const blocks = Array.isArray(result) ? result : result === undefined ? [] : [result];
  const content: HostToolOutput["content"] = [];
  let truncated = false;
  let remaining = limit;
  for (const block of blocks) {
    const text =
      typeof block === "string"
        ? block
        : isRecord(block) && block.type === "text" && typeof block.text === "string"
          ? block.text
          : null;
    if (text !== null) {
      if (!text) continue;
      if (remaining <= 0) {
        truncated = true;
        continue;
      }
      const slice = text.slice(0, remaining);
      if (slice.length < text.length) truncated = true;
      remaining -= slice.length;
      content.push({ type: "text", text: slice });
      continue;
    }
    if (
      isRecord(block) &&
      block.type === "image" &&
      isRecord(block.source) &&
      typeof block.source.media_type === "string" &&
      typeof block.source.data === "string"
    ) {
      content.push({
        type: "image",
        mimeType: block.source.media_type,
        base64Data: block.source.data,
      });
    }
  }
  if (content.length === 0) return null;
  return { content, ...(truncated ? { truncated: true } : {}) };
}

export function completeCommandCodeToolItem(
  item: HostCommandExecutionItem | HostToolExecutionItem,
  result: unknown,
  limit: number,
): HostItem {
  const output = commandCodeToolOutput(result, limit);
  if (item.type === "commandExecution") {
    const text = output?.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    return {
      ...item,
      ...(text ? { output: text } : {}),
      ...(output?.truncated ? { outputTruncated: true } : {}),
    };
  }
  return { ...item, ...(output ? { output } : {}) };
}
