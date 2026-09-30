import type { Readable, Writable } from "node:stream";

import { jsonValueSchema, type JsonValue } from "@codexhost/shared-contracts";

const decoder = new TextDecoder("utf-8", { fatal: true });
const newline = Buffer.from("\n");

export async function* readLfFrames(
  stream: Readable,
  options: { maxFrameBytes?: number } = {},
): AsyncGenerator<Buffer<ArrayBufferLike>> {
  const limit = options.maxFrameBytes ?? Infinity;
  if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw new Error("Invalid protocol frame limit");
  }
  let fragments: Buffer<ArrayBufferLike>[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    let offset = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(0x0a, offset);
      const part = bytes.subarray(offset, end < 0 ? bytes.length : end);
      length += part.length;
      if (length > limit) throw new Error("Protocol frame exceeds its limit");
      if (end < 0) {
        fragments.push(part);
        break;
      }
      // Scan each incoming byte once and join a fragmented frame only when complete.
      const frame = fragments.length === 0 ? part : Buffer.concat([...fragments, part], length);
      fragments = [];
      length = 0;
      yield frame;
      offset = end + 1;
    }
  }
  if (length !== 0) {
    throw new Error("Protocol stream ended with an unterminated JSONL frame");
  }
}

export function parseJsonFrame(frame: Buffer<ArrayBufferLike>): JsonValue {
  if (frame.length === 0) {
    throw new Error("Protocol stream contained an empty JSONL frame");
  }
  try {
    return jsonValueSchema.parse(JSON.parse(decoder.decode(frame)));
  } catch {
    throw new Error("Protocol stream contained invalid JSONL");
  }
}

export function encodeJsonFrame(value: JsonValue): Buffer {
  return Buffer.from(`${JSON.stringify(jsonValueSchema.parse(value))}\n`, "utf8");
}

async function writeBytes(stream: Writable, bytes: Buffer<ArrayBufferLike>): Promise<void> {
  if (stream.write(bytes)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("Protocol stream closed before pending write drained"));
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

export function writeJsonFrame(stream: Writable, value: JsonValue): Promise<void> {
  return writeBytes(stream, encodeJsonFrame(value));
}

export function writeFrame(stream: Writable, frame: Buffer<ArrayBufferLike>): Promise<void> {
  return writeBytes(stream, Buffer.concat([frame, newline]));
}
