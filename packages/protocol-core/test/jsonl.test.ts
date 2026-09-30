import { PassThrough, Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { parseJsonFrame, readLfFrames, writeFrame } from "../src/index.js";

describe("Protocol Core strict JSONL", () => {
  it("preserves frame bytes across arbitrary chunks", async () => {
    const frames: Buffer[] = [];
    for await (const frame of readLfFrames(
      Readable.from([Buffer.from('{"a"'), Buffer.from(":1}\n")]),
    )) {
      frames.push(frame);
    }
    expect(frames).toEqual([Buffer.from('{"a":1}')]);

    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    const firstFrame = frames[0];
    if (!firstFrame) throw new Error("expected one JSONL frame");
    await writeFrame(output, firstFrame);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from('{"a":1}\n'));
  });

  it("preserves split UTF-8, adjacent frames, and empty frames", async () => {
    const input = Buffer.from('"中"\n\n{}\n');
    const frames = [];
    for await (const frame of readLfFrames(
      Readable.from([...input].map((b) => Buffer.from([b]))),
    )) {
      frames.push(frame);
    }
    expect(frames.map((frame) => frame.toString())).toEqual(['"中"', "", "{}"]);
    const first = frames[0];
    if (!first) throw new Error("Missing frame");
    expect(parseJsonFrame(first)).toBe("中");
  });

  it("copies a fragmented large frame only once", async () => {
    const block = Buffer.alloc(64 * 1024, 0x61);
    const join = vi.spyOn(Buffer, "concat");
    try {
      const frames = [];
      const chunks = [...Array.from({ length: 256 }, () => block), Buffer.from("\n{}\n")];
      for await (const frame of readLfFrames(Readable.from(chunks))) frames.push(frame);
      expect(frames.map((frame) => frame.length)).toEqual([16 * 1024 * 1024, 2]);
      expect(frames[0]?.equals(Buffer.alloc(16 * 1024 * 1024, 0x61))).toBe(true);
      expect(join).toHaveBeenCalledTimes(1);
    } finally {
      join.mockRestore();
    }
  });

  it("enforces an explicit limit per frame across chunk boundaries", async () => {
    const collect = async (chunks: string[], maxFrameBytes: number) => {
      const frames = [];
      for await (const frame of readLfFrames(Readable.from(chunks.map((s) => Buffer.from(s))), {
        maxFrameBytes,
      }))
        frames.push(frame.toString());
      return frames;
    };
    await expect(collect(["12", "34\n1234\n"], 4)).resolves.toEqual(["1234", "1234"]);
    await expect(collect(["12", "345\n"], 4)).rejects.toThrow("exceeds");
    await expect(collect(["12345"], 4)).rejects.toThrow("exceeds");
    for (const limit of [0, -1, 0.5, NaN]) {
      await expect(collect([], limit)).rejects.toThrow("Invalid protocol frame limit");
    }
  });

  it("rejects unterminated, empty, invalid UTF-8, and invalid JSON frames", async () => {
    await expect(async () => {
      for await (const frame of readLfFrames(Readable.from([Buffer.from("{}")]))) {
        expect(frame).toBeDefined();
      }
    }).rejects.toThrow("unterminated");
    expect(() => parseJsonFrame(Buffer.alloc(0))).toThrow("empty");
    expect(() => parseJsonFrame(Buffer.from([0xff]))).toThrow("invalid JSONL");
    expect(() => parseJsonFrame(Buffer.from("no-json"))).toThrow("invalid JSONL");
  });

  it("rejects a backpressured write when the stream closes before draining", async () => {
    const output = new PassThrough({ highWaterMark: 1 });
    const write = writeFrame(output, Buffer.from("{}"));

    output.destroy();

    const outcome = await Promise.race([
      write.catch((error: unknown) => error),
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 100);
      }),
    ]);
    expect(outcome).toBeInstanceOf(Error);
  });
});
