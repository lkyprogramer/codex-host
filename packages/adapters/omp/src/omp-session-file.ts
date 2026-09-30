import { createReadStream } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import readline from "node:readline";

import type { JsonObject } from "@codexhost/shared-contracts";

import type { OmpSessionHistory } from "./omp-history.js";

const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

interface OmpSessionHeader {
  type: "session";
  id: string;
  cwd: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function historyEntry(value: unknown): JsonObject | null {
  if (
    !isRecord(value) ||
    value.type === "title" ||
    value.type === "session" ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    (value.parentId !== null && typeof value.parentId !== "string") ||
    typeof value.type !== "string"
  ) {
    return null;
  }
  return value as JsonObject;
}

export async function readOmpSessionHistory(sessionFile: string): Promise<OmpSessionHistory> {
  const entries: JsonObject[] = [];
  let leafId: string | null = null;
  const lines = readline.createInterface({
    input: createReadStream(sessionFile, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    for await (const line of lines) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = historyEntry(parsed);
      if (!entry) continue;
      entries.push(entry);
      leafId = entry.id as string;
    }
  } finally {
    lines.close();
  }
  return { entries, leafId };
}

/** Read a fixed byte snapshot of a child file. A changing or incomplete file is never reported as complete. */
export async function readOmpBoundedSessionHistory(
  handle: FileHandle,
  initialSize: number,
  maxBytes: number,
): Promise<OmpSessionHistory> {
  if (!Number.isSafeInteger(initialSize) || initialSize < 0 || initialSize > maxBytes) {
    throw new Error("Omp Subagent transcript exceeds the supported size");
  }
  const entries: JsonObject[] = [];
  let leafId: string | null = null;
  let offset = 0;
  let pending = Buffer.alloc(0);
  const chunk = Buffer.allocUnsafe(64 * 1024);
  while (offset < initialSize) {
    const { bytesRead } = await handle.read(
      chunk,
      0,
      Math.min(chunk.length, initialSize - offset),
      offset,
    );
    if (bytesRead === 0) throw new Error("Omp Subagent transcript changed while reading");
    offset += bytesRead;
    pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
    let newline: number;
    while ((newline = pending.indexOf(0x0a)) >= 0) {
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(utf8Decoder.decode(line));
      } catch {
        throw new Error("Omp Subagent transcript contains an invalid JSONL record");
      }
      const entry = historyEntry(parsed);
      if (entry) {
        entries.push(entry);
        leafId = entry.id as string;
      } else if (!isRecord(parsed) || (parsed.type !== "title" && parsed.type !== "session")) {
        throw new Error("Omp Subagent transcript contains an invalid history entry");
      }
    }
  }
  const finalSize = (await handle.stat()).size;
  if (finalSize > maxBytes) throw new Error("Omp Subagent transcript exceeds the supported size");
  if (finalSize !== initialSize || pending.length !== 0) {
    throw new Error("Omp Subagent transcript changed or is incomplete");
  }
  if (leafId === null) throw new Error("Omp Subagent transcript has no history entries");
  return { entries, leafId };
}

async function readOmpSessionHeader(sessionFile: string): Promise<OmpSessionHeader> {
  const handle = await open(sessionFile, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_SESSION_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const contents = buffer.subarray(0, bytesRead);
    const lastNewline = contents.lastIndexOf(0x0a);
    if (lastNewline < 0 && bytesRead === buffer.length) {
      throw new Error("Omp Session header exceeds the supported size");
    }
    // At the byte bound, the final record may end mid UTF-8 code point.
    // Decode only complete lines there; a smaller file may have no trailing newline.
    const completeRecords =
      bytesRead === buffer.length ? contents.subarray(0, lastNewline + 1) : contents;
    const contentsText = utf8Decoder.decode(completeRecords);
    for (const line of contentsText.split("\n")) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(parsed) || parsed.type !== "session") continue;
      if (
        typeof parsed.id !== "string" ||
        parsed.id.length === 0 ||
        typeof parsed.cwd !== "string" ||
        parsed.cwd.length === 0
      ) {
        throw new Error("Omp Session header is invalid");
      }
      return { type: "session", id: parsed.id, cwd: parsed.cwd };
    }
    throw new Error("Omp Session header is invalid");
  } finally {
    await handle.close();
  }
}

export async function verifyOmpSessionIdentity(
  sessionFile: string,
  sessionId: string,
): Promise<void> {
  const header = await readOmpSessionHeader(sessionFile);
  if (header.id !== sessionId) {
    throw new Error("Omp parent Session header identity does not match its Native Session Ref");
  }
}

export async function verifyOmpSessionCwd(input: {
  sessionFile: string | null;
  sessionId: string;
  expectedCwd: string;
}): Promise<void> {
  if (!input.sessionFile) throw new Error("Omp Fork Session has no persisted Session file");
  const header = await readOmpSessionHeader(input.sessionFile);
  if (header.id !== input.sessionId) {
    throw new Error("Omp Fork Session header identity does not match RPC state");
  }
  const [actualCwd, expectedCwd] = await Promise.all([
    realpath(header.cwd),
    realpath(input.expectedCwd),
  ]);
  if (actualCwd !== expectedCwd) {
    throw new Error("Omp Fork Session did not bind the requested cwd");
  }
}
