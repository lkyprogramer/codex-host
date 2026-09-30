import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import type { OmpSessionHistory } from "./omp-history.js";
import { readOmpBoundedSessionHistory, verifyOmpSessionIdentity } from "./omp-session-file.js";

export const MAX_SUBAGENT_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

/** OMP persists a child at <parent-stem>/<child-id>.jsonl. Only ENOENT permits RPC fallback. */
export async function readOmpSubagentTranscript(input: {
  parentSessionFile: string;
  parentSessionId: string;
  nativeSubagentId: string;
}): Promise<OmpSessionHistory | null> {
  const { parentSessionFile, parentSessionId, nativeSubagentId } = input;
  if (
    nativeSubagentId.length === 0 ||
    nativeSubagentId === "." ||
    nativeSubagentId === ".." ||
    nativeSubagentId.includes("/") ||
    nativeSubagentId.includes("\\") ||
    nativeSubagentId.includes("\u0000") ||
    path.win32.basename(nativeSubagentId) !== nativeSubagentId
  ) {
    throw new Error("Omp Subagent ID is not a plain transcript file name");
  }
  if (!path.isAbsolute(parentSessionFile) || path.extname(parentSessionFile) !== ".jsonl") {
    return null;
  }

  let resolvedParent: string;
  try {
    resolvedParent = await realpath(parentSessionFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (path.extname(resolvedParent) !== ".jsonl") {
    throw new Error("Omp parent Session file resolves outside its native layout");
  }
  await verifyOmpSessionIdentity(resolvedParent, parentSessionId);
  const transcriptDirectory = resolvedParent.slice(0, -".jsonl".length);
  let directoryInfo;
  try {
    directoryInfo = await lstat(transcriptDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("Omp Subagent transcript directory is not a native directory");
  }
  const resolvedDirectory = await realpath(transcriptDirectory);
  if (resolvedDirectory !== transcriptDirectory) {
    throw new Error(
      "Omp Subagent transcript directory resolves outside its parent Session directory",
    );
  }
  const transcriptFile = path.join(transcriptDirectory, `${nativeSubagentId}.jsonl`);
  let handle;
  try {
    handle = await open(transcriptFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Omp Subagent transcript is not a regular file");
    const pathMetadata = await lstat(transcriptFile);
    if (
      pathMetadata.isSymbolicLink() ||
      pathMetadata.dev !== metadata.dev ||
      pathMetadata.ino !== metadata.ino
    ) {
      throw new Error("Omp Subagent transcript path changed while opening");
    }
    if (metadata.size > MAX_SUBAGENT_TRANSCRIPT_BYTES) {
      throw new Error("Omp Subagent transcript exceeds the supported size");
    }
    const resolvedTranscript = await realpath(transcriptFile);
    if (path.dirname(resolvedTranscript) !== transcriptDirectory) {
      throw new Error("Omp Subagent transcript resolves outside its parent Session directory");
    }
    return await readOmpBoundedSessionHistory(handle, metadata.size, MAX_SUBAGENT_TRANSCRIPT_BYTES);
  } finally {
    await handle.close();
  }
}
