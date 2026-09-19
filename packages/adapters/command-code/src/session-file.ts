/**
 * Command Code persists every Session as
 * `<home>/.commandcode/projects/<cwd-slug>/<sessionId>.jsonl`: a `session`
 * header (`version: 3`, `id`, `cwd`) followed by `message` nodes that form a
 * tree through `parentId` (rewind and fork branch it). The file is the CLI's
 * own history and the Adapter's source of truth for Native identity; it is
 * never written here.
 *
 * Only the record shapes observed in 1.58.0 files and the CLI's replay code are
 * decoded: real prompts are `user` messages with `meta.source: "user"`, tool
 * results are `user` messages with `meta.source: "tool"`, and assistant content
 * uses `text`, `thinking` and `tool_use` blocks. Anything else is skipped rather
 * than guessed.
 */
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  HostItem,
  HostItemSnapshot,
  HostTextInput,
  HostToolOutput,
  HostTurnSnapshot,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type HostItemId,
  type JsonValue,
} from "@codexhost/shared-contracts";

import { isRecord } from "./stream-events.js";

export const COMMAND_CODE_DIRECTORY_NAME = ".commandcode";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;

export interface CommandCodeSessionHeader {
  id: string;
  cwd: string;
  version: number;
  parentSession?: string;
}

export interface CommandCodeSessionFile {
  path: string;
  header: CommandCodeSessionHeader;
}

interface StoredMessage {
  id: string;
  parentId: string | null;
  role: string;
  content: unknown;
  source: string | undefined;
  timestampMs: number | undefined;
}

/** Same precedence as the CLI (`HOME ?? USERPROFILE ?? homedir()`), including an empty `HOME`. */
export function commandCodeHomeDirectory(environment: NodeJS.ProcessEnv): string {
  return environment.HOME ?? environment.USERPROFILE ?? os.homedir();
}

export function commandCodeProjectsDirectory(environment: NodeJS.ProcessEnv): string {
  return path.join(commandCodeHomeDirectory(environment), COMMAND_CODE_DIRECTORY_NAME, "projects");
}

export function isCommandCodeSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value) && value.length <= 256;
}

function parseHeader(line: string | undefined): CommandCodeSessionHeader | null {
  if (!line) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed.type !== "session" ||
    typeof parsed.id !== "string" ||
    !parsed.id ||
    typeof parsed.cwd !== "string" ||
    typeof parsed.version !== "number"
  ) {
    return null;
  }
  return {
    id: parsed.id,
    cwd: parsed.cwd,
    version: parsed.version,
    ...(typeof parsed.parentSession === "string" ? { parentSession: parsed.parentSession } : {}),
  };
}

/** Whole transcript text, or null when missing, not a file or beyond the size bound. */
export async function readCommandCodeTranscript(filePath: string): Promise<string | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > MAX_SESSION_FILE_BYTES) return null;
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Reads and validates the header of a known session file; null when absent or foreign. */
export async function readCommandCodeSessionFile(
  filePath: string,
): Promise<CommandCodeSessionFile | null> {
  const content = await readCommandCodeTranscript(filePath);
  if (content === null) return null;
  const header = parseHeader(content.split(/\r?\n/u, 1)[0]);
  return header ? { path: filePath, header } : null;
}

/**
 * Locates a Session by ID across every project directory. The CLI derives the
 * directory from a slug of the cwd, and reproducing that slug is not needed to
 * find a file whose basename is already the exact Session ID.
 */
export async function findCommandCodeSessionFile(
  environment: NodeJS.ProcessEnv,
  sessionId: string,
): Promise<CommandCodeSessionFile | null> {
  if (!isCommandCodeSessionId(sessionId)) return null;
  const projects = commandCodeProjectsDirectory(environment);
  let directories: string[];
  try {
    directories = (await readdir(projects, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  for (const directory of directories) {
    const candidate = path.join(projects, directory, `${sessionId}.jsonl`);
    const file = await readCommandCodeSessionFile(candidate);
    if (file && file.header.id === sessionId) return file;
  }
  return null;
}

/** Symlink-resolved absolute path, as the CLI itself reports `process.cwd()` and tool targets. */
export async function canonicalCommandCodePath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

/** The CLI records `process.cwd()`, i.e. a symlink-resolved path, so both sides are canonicalized. */
export async function sameCommandCodeCwd(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    canonicalCommandCodePath(left),
    canonicalCommandCodePath(right),
  ]);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

interface StoredEntry {
  id: string;
  parentId: string | null;
  message: StoredMessage | null;
}

/**
 * Every transcript record after the header carries `id` / `parentId`, and the
 * CLI threads non-message records (`compaction`, `model_change`,
 * `effort_change`, `session_info`, `custom`, `label`) into the same chain.
 * They must stay in the walk or the branch breaks at the first compaction.
 */
function storedEntry(value: unknown): StoredEntry | null {
  if (!isRecord(value) || value.type === "session" || typeof value.id !== "string") return null;
  const parentId = typeof value.parentId === "string" ? value.parentId : null;
  if (value.type !== "message") return { id: value.id, parentId, message: null };
  const message = value.message;
  if (!isRecord(message) || typeof message.role !== "string") {
    return { id: value.id, parentId, message: null };
  }
  const meta = isRecord(message.meta) ? message.meta : undefined;
  const timestampMs =
    typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
  return {
    id: value.id,
    parentId,
    message: {
      id: value.id,
      parentId,
      role: message.role,
      content: message.content,
      source: typeof meta?.source === "string" ? meta.source : undefined,
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : undefined,
    },
  };
}

function storedEntries(content: string): StoredEntry[] {
  const entries: StoredEntry[] = [];
  for (const line of content.split(/\r?\n/u).slice(1)) {
    if (!line.trim()) continue;
    try {
      const entry = storedEntry(JSON.parse(line));
      if (entry) entries.push(entry);
    } catch {
      continue;
    }
  }
  return entries;
}

/** Messages on the active branch: the chain from the newest entry back to the root. */
function activeBranchMessages(entries: StoredEntry[]): StoredMessage[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: StoredMessage[] = [];
  const visited = new Set<string>();
  let current = entries.at(-1);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.message) branch.push(current.message);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return branch.reverse();
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        isRecord(block) && block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function toolOutput(content: unknown, limit: number): HostToolOutput | undefined {
  const text = contentText(content);
  if (!text) return undefined;
  return {
    content: [{ type: "text", text: text.slice(0, limit) }],
    ...(text.length > limit ? { truncated: true } : {}),
  };
}

interface TurnAccumulator {
  prompt: StoredMessage;
  items: HostItemSnapshot[];
  toolItems: Map<string, HostItem & { type: "toolExecution" }>;
  sawAssistant: boolean;
  lastTimestampMs: number | undefined;
}

/**
 * Item identity derived from the stored entry and block position, so a
 * re-read of the same transcript yields the same IDs.
 */
function historyItemId(entryId: string, ordinal: number): HostItemId {
  return hostItemIdSchema.parse(`command-code-item-v1-${entryId}-${ordinal}`);
}

/**
 * Replays the active branch as Host Turns. Outcomes are not recorded in the
 * file: a Turn that produced assistant content is reported as succeeded, an
 * unanswered prompt as unknown.
 */
export function commandCodeSessionTurns(input: {
  content: string;
  harnessId: HarnessId;
  nativeSessionId: string;
  toolOutputLimit: number;
}): HostTurnSnapshot[] {
  const turns: HostTurnSnapshot[] = [];
  let current: TurnAccumulator | null = null;
  const finish = (): void => {
    if (!current) return;
    const turnKey = current.prompt.id;
    turns.push({
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId: input.harnessId,
        nativeSessionId: input.nativeSessionId,
        nativeTurnKey: turnKey,
        formatVersion: 1,
      }),
      input: [{ type: "text", text: contentText(current.prompt.content) } satisfies HostTextInput],
      items: current.items,
      outcome: current.sawAssistant
        ? { status: "succeeded" }
        : { status: "unknown", reason: "Command Code recorded no assistant response" },
      ...(current.prompt.timestampMs !== undefined
        ? { startedAtMs: current.prompt.timestampMs }
        : {}),
      ...(current.lastTimestampMs !== undefined ? { completedAtMs: current.lastTimestampMs } : {}),
    });
    current = null;
  };
  for (const message of activeBranchMessages(storedEntries(input.content))) {
    if (message.role === "user" && message.source === "user") {
      finish();
      current = {
        prompt: message,
        items: [],
        toolItems: new Map(),
        sawAssistant: false,
        lastTimestampMs: undefined,
      };
      continue;
    }
    if (!current) continue;
    if (message.timestampMs !== undefined) current.lastTimestampMs = message.timestampMs;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      current.sawAssistant = true;
      for (const [ordinal, block] of message.content.entries()) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          current.items.push({
            item: {
              type: "agentMessage",
              itemId: historyItemId(message.id, ordinal),
              text: block.text,
            },
            outcome: { status: "succeeded" },
          });
        } else if (
          block.type === "thinking" &&
          typeof block.thinking === "string" &&
          block.thinking.trim()
        ) {
          current.items.push({
            item: {
              type: "reasoning",
              itemId: historyItemId(message.id, ordinal),
              text: block.thinking,
            },
            outcome: { status: "succeeded" },
          });
        } else if (
          block.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          const item: HostItem & { type: "toolExecution" } = {
            type: "toolExecution",
            itemId: historyItemId(message.id, ordinal),
            toolName: block.name,
            arguments: jsonValue(block.input ?? {}),
          };
          current.toolItems.set(block.id, item);
          current.items.push({ item, outcome: { status: "succeeded" } });
        }
      }
      continue;
    }
    if (message.role === "user" && message.source === "tool" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          !isRecord(block) ||
          block.type !== "tool_result" ||
          typeof block.tool_use_id !== "string"
        )
          continue;
        const item = current.toolItems.get(block.tool_use_id);
        if (!item) continue;
        const output = toolOutput(block.content, input.toolOutputLimit);
        if (output) item.output = output;
      }
    }
  }
  finish();
  return turns;
}

/** Identity of the newest prompt on the active branch, used as the live Turn key. */
export function latestCommandCodePromptId(content: string): string | undefined {
  return activeBranchMessages(storedEntries(content))
    .reverse()
    .find((message) => message.role === "user" && message.source === "user")?.id;
}
