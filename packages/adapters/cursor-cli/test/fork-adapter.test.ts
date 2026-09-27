import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import type { ForkSessionInput, RollbackLastTurnSessionInput } from "@codexhost/harness-adapter";
import { CursorAdapter } from "../src/adapter.js";
import { CursorTransport, type CursorSessionInfo } from "../src/transport.js";
import { cursorCheckpoint } from "../src/fork-support.js";
import { cursorModelRef } from "../src/models.js";
import { forkCursorSession } from "../src/fork.js";
import type * as NativeHistory from "../src/native-history.js";
import type * as Fork from "../src/fork.js";
import type * as ForkSupport from "../src/fork-support.js";

const sourceId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const targetId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const native = vi.hoisted(() => ({
  source: [] as NativeHistory.CursorNativeTurn[],
  target: [] as NativeHistory.CursorNativeTurn[],
}));
vi.mock("../src/native-history.js", async (original) => ({
  ...(await original<typeof NativeHistory>()),
  readCursorNativeTurns: (id: string) =>
    structuredClone(id === targetId ? native.target : native.source),
}));
vi.mock("../src/fork.js", async (original) => ({
  ...(await original<typeof Fork>()),
  forkCursorSession: vi.fn(),
}));
vi.mock("../src/fork-support.js", async (original) => ({
  ...(await original<typeof ForkSupport>()),
  cursorForkAvailable: () => true,
}));

const sourceRef = nativeSessionRefSchema.parse({
  harnessId: "cursor-cli",
  nativeSessionId: sourceId,
  formatVersion: 1,
});
function info(sessionId: string): CursorSessionInfo {
  return {
    sessionId,
    configOptions: [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "model[effort=xhigh,fast=false]",
        options: [{ value: "model[effort=xhigh,fast=false]", name: "Model" }],
      },
    ],
  };
}
const adapters: CursorAdapter[] = [];
function fixture() {
  const adapter = new CursorAdapter({ environment: {} });
  adapters.push(adapter);
  const checkpoint = cursorCheckpoint(sourceId, native.source[0]?.id ?? randomUUID());
  const transaction = {
    sessionId: targetId,
    expected: structuredClone(native.source),
    sourceTurns: structuredClone(native.source),
    commit: vi.fn(),
    discard: vi.fn(async () => undefined),
  };
  vi.mocked(forkCursorSession).mockResolvedValue(transaction);
  const fork: ForkSessionInput = { kind: "fork", cwd: process.cwd(), sourceRef, checkpoint };
  return { adapter, transaction, fork };
}
beforeEach(() => {
  native.source = [{ id: randomUUID(), text: "first", rewindRoot: "a".repeat(64) }];
  native.target = structuredClone(native.source);
  vi.spyOn(CursorTransport.prototype, "open").mockImplementation(async function (
    this: CursorTransport,
    id,
  ) {
    this.sessionId = id ?? sourceId;
    this.replay = (this.sessionId === targetId ? native.target : native.source).map((turn) => ({
      sessionId: this.sessionId,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: turn.text } },
    }));
    return info(this.sessionId);
  });
  vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
  vi.spyOn(CursorTransport.prototype, "configure").mockImplementation(async (key, value) => ({
    configOptions: [
      {
        id: key,
        name: key,
        type: "select" as const,
        currentValue: value,
        options: [{ value, name: value }],
      },
    ],
  }));
});
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  vi.restoreAllMocks();
  vi.mocked(forkCursorSession).mockReset();
});

describe("Cursor native derivation admission", () => {
  it("adopts an independent head fork and retains the parameterized model", async () => {
    const f = fixture();
    const source = await f.adapter.open({ kind: "resume", cwd: f.fork.cwd, nativeRef: sourceRef });
    expect(source.ok).toBe(true);
    const result = await f.adapter.open(f.fork);
    expect(result.ok).toBe(true);
    if (!result.ok || !source.ok) return;
    expect(result.value.initialState.nativeRef?.nativeSessionId).toBe(targetId);
    expect(result.value.initialState.effectiveModel).toEqual(
      source.value.initialState.effectiveModel,
    );
    expect(result.value.capabilities.history).toMatchObject({
      fork: true,
      rollbackLastTurn: true,
      forkAcrossCwd: false,
    });
    expect(native.source).toHaveLength(1);
    expect(f.transaction.commit).toHaveBeenCalledOnce();
    expect(f.transaction.discard).not.toHaveBeenCalled();
  });
  it("revises the last native turn and keeps the source intact", async () => {
    const f = fixture();
    native.source.push({ id: randomUUID(), text: "second", rewindRoot: "b".repeat(64) });
    native.target = native.source.slice(0, 1);
    f.transaction.expected = structuredClone(native.target);
    f.transaction.sourceTurns = structuredClone(native.source);
    const input: RollbackLastTurnSessionInput = {
      kind: "rollbackLastTurn",
      cwd: f.fork.cwd,
      sourceRef,
    };
    const result = await f.adapter.open(input);
    expect(result.ok).toBe(true);
    expect(f.transaction.commit).toHaveBeenCalledOnce();
    expect(native.source).toHaveLength(2);
  });
  it("rejects a bad boundary and another cwd before native work", async () => {
    const f = fixture();
    const source = await f.adapter.open({ kind: "resume", cwd: f.fork.cwd, nativeRef: sourceRef });
    expect(source.ok).toBe(true);
    expect(
      await f.adapter.open({ ...f.fork, checkpoint: cursorCheckpoint(sourceId, randomUUID()) }),
    ).toMatchObject({ error: { code: "checkpointNotFound" } });
    expect(await f.adapter.open({ ...f.fork, cwd: "/elsewhere" })).toMatchObject({
      error: { code: "unsupported" },
    });
    expect(forkCursorSession).not.toHaveBeenCalled();
  });
  it("rejects an empty native source before creating a derived store", async () => {
    const f = fixture();
    native.source = [];
    expect(await f.adapter.open(f.fork)).toMatchObject({
      error: { code: "checkpointNotFound" },
    });
    expect(forkCursorSession).not.toHaveBeenCalled();
  });
  it("discards a derived native target when ACP adoption fails", async () => {
    const f = fixture();
    native.target = [{ id: randomUUID(), text: "wrong" }];
    const result = await f.adapter.open(f.fork);
    expect(result.ok).toBe(false);
    expect(f.transaction.commit).not.toHaveBeenCalled();
    expect(f.transaction.discard).toHaveBeenCalledOnce();
  });
  it("retains a derived store when ACP cleanup fails, so it is not deleted under a live owner", async () => {
    const f = fixture();
    native.target = [{ id: randomUUID(), text: "wrong" }];
    vi.spyOn(CursorTransport.prototype, "close").mockRejectedValue(
      new Error("owned process remains"),
    );
    const result = await f.adapter.open(f.fork);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: { diagnostic: "cursorNativeCleanupUnconfirmed" } });
    expect(f.transaction.discard).not.toHaveBeenCalled();
    adapters.splice(adapters.indexOf(f.adapter), 1);
    await expect(f.adapter.close()).rejects.toThrow("Cursor process cleanup failed");
  });
  it("retains the native target when a failed catalog attempt cannot close ACP", async () => {
    const f = fixture();
    vi.spyOn(CursorTransport.prototype, "open").mockRejectedValueOnce(
      new Error("Cursor model catalog unavailable"),
    );
    vi.spyOn(CursorTransport.prototype, "close").mockRejectedValue(
      new Error("owned process remains"),
    );
    const result = await f.adapter.open(f.fork);
    expect(result).toMatchObject({ error: { diagnostic: "cursorNativeCleanupUnconfirmed" } });
    expect(f.transaction.discard).not.toHaveBeenCalled();
    adapters.splice(adapters.indexOf(f.adapter), 1);
    await expect(f.adapter.close()).rejects.toThrow("Cursor process cleanup failed");
  });
  it("keeps the saved model for a cold native source", async () => {
    const f = fixture();
    const model = cursorModelRef("model[effort=xhigh,fast=false]");
    const result = await f.adapter.open({ ...f.fork, model });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.initialState.effectiveModel).toEqual(model);
    expect(CursorTransport.prototype.configure).toHaveBeenCalledWith(
      "model",
      "model[effort=xhigh,fast=false]",
    );
  });
  it("closes an in-flight ACP adoption when the Adapter closes", async () => {
    const f = fixture();
    let failOpen: ((error: Error) => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(CursorTransport.prototype, "open").mockImplementationOnce(async () => {
      entered?.();
      return new Promise<CursorSessionInfo>((_resolve, reject) => {
        failOpen = reject;
      });
    });
    vi.spyOn(CursorTransport.prototype, "close").mockImplementation(async () => {
      failOpen?.(new Error("ACP closed"));
    });
    const pending = f.adapter.open(f.fork);
    await started;
    await f.adapter.close();
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(f.transaction.discard).toHaveBeenCalledOnce();
  });
  it("aborts pending derivation on Adapter close", async () => {
    const f = fixture();
    let entered: (() => void) | undefined;
    vi.mocked(forkCursorSession).mockImplementationOnce(
      async (_source, _checkpoint, _options, signal) => {
        entered?.();
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        );
      },
    );
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = f.adapter.open(f.fork);
    await started;
    await f.adapter.close();
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(f.transaction.commit).not.toHaveBeenCalled();
  });
});
