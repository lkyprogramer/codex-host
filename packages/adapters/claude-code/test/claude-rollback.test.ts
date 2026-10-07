import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostTurnIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import type { HarnessSession } from "@codexhost/harness-adapter";

import { ClaudeCodeAdapter } from "../src/claude-code-adapter.js";
import { encodeClaudeModelRef } from "../src/model-catalog.js";
import { CLAUDE_DEFAULT_THINKING_OPTION_ID } from "../src/thinking-options.js";
import { CLAUDE_DEFAULT_PERMISSION_MODE_ID } from "../src/permission-modes.js";
import { ClaudePendingSessions } from "../src/pending-session.js";
import type {
  ClaudeAdapterDependencies,
  ClaudeTransportFactoryInput,
  ClaudeTurnTransport,
} from "../src/transport.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface NativeMessage {
  type: "user" | "assistant";
  uuid: string;
  session_id: string;
  message: { role: "user" | "assistant"; content: unknown };
  toolUseResult?: unknown;
}

function messages(sessionId: string, text: string): NativeMessage[] {
  return [
    {
      type: "user",
      uuid: randomUUID() as string,
      session_id: sessionId,
      message: { role: "user", content: text },
    },
    {
      type: "assistant",
      uuid: randomUUID() as string,
      session_id: sessionId,
      message: { role: "assistant", content: [{ type: "text", text: `${text} response` }] },
    },
  ];
}

async function fixture(turns = 1) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-rollback-"));
  cleanups.push(() => rm(directory, { force: true, recursive: true }));
  const environment = { CLAUDE_CONFIG_DIR: directory };
  const sourceRef = nativeSessionRefSchema.parse({
    harnessId: "claude-code",
    nativeSessionId: randomUUID(),
    formatVersion: 1,
  });
  const histories = new Map<string, NativeMessage[]>([
    [
      sourceRef.nativeSessionId,
      Array.from({ length: turns }, (_, i) =>
        messages(sourceRef.nativeSessionId, `prompt ${i + 1}`),
      ).flat(),
    ],
  ]);
  const transports: Array<ClaudeTurnTransport & { input: ClaudeTransportFactoryInput }> = [];
  const dependencies: ClaudeAdapterDependencies = {
    randomUUID,
    inspectInstallation: () => undefined,
    createInspector: () => ({
      inspect: async () => ({
        models: [{ value: "default", displayName: "Default", description: "Default" }],
        canSelectModel: true,
        canSelectPermissionMode: true,
      }),
      close: async () => undefined,
    }),
    deleteSession: vi.fn(async ({ sessionId }) => {
      histories.delete(sessionId);
    }),
    forkSession: vi.fn(async ({ sourceSessionId, checkpointId }) => {
      const id = randomUUID();
      const source = histories.get(sourceSessionId) ?? [];
      const prefix = source.slice(0, source.findIndex((m) => m.uuid === checkpointId) + 1);
      histories.set(
        id,
        prefix.map((m) => ({
          ...structuredClone(m),
          uuid: randomUUID() as string,
          session_id: id,
        })),
      );
      return { sessionId: id };
    }),
    getSessionInfo: async ({ sessionId }) =>
      histories.has(sessionId) ? { cwd: directory } : undefined,
    readSessionMessages: vi.fn(async ({ sessionId }) =>
      structuredClone(histories.get(sessionId) ?? []),
    ),
    readSubagentMessages: async () => [],
    createTransport: vi.fn((input) => {
      let permissionMode = input.permissionMode;
      const transport = {
        input,
        sessionId: input.sessionId,
        hasBackgroundTasks: false,
        start: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
        inspectAccount: vi.fn(async () => null),
        setAutonomousTurnHandler: () => undefined,
        setIdleTurnHandler: () => undefined,
        setThreadEventHandler: () => undefined,
        setIdleLive: () => undefined,
        getContextUsage: async () => null,
        getPermissionMode: () => permissionMode,
        setPermissionMode: async (mode) => {
          permissionMode = mode;
        },
        setModel: async () => undefined,
        setThinkingOption: async () => undefined,
        respondToInteraction: async () => undefined,
        compact: async () => ({ status: "succeeded" as const }),
        init: async () => ({ status: "succeeded" as const }),
        recap: async () => ({ status: "succeeded" as const }),
        runTurn: async (text, userMessageId, onEvent) => {
          const next = messages(input.sessionId, text);
          assert.ok(next[0]);
          assert.ok(next[1]);
          next[0].uuid = userMessageId;
          histories.set(input.sessionId, [...(histories.get(input.sessionId) ?? []), ...next]);
          onEvent({ type: "text.delta", messageId: next[1].uuid, delta: `${text} response` });
          onEvent({
            type: "message.completed",
            messageId: next[1].uuid,
            checkpointId: next[1].uuid,
          });
          return { status: "succeeded" };
        },
      } satisfies ClaudeTurnTransport & { input: ClaudeTransportFactoryInput };
      transports.push(transport);
      return transport;
    }),
  };
  const adapter = () => {
    const value = new ClaudeCodeAdapter({ environment, closeTimeoutMs: 50 }, dependencies);
    cleanups.push(() => value.close().catch(() => undefined));
    return value;
  };
  return { adapter, directory, environment, sourceRef, histories, dependencies, transports };
}

async function unwrap(result: ReturnType<ClaudeCodeAdapter["open"]>): Promise<HarnessSession> {
  const opened = await result;
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}

const model = encodeClaudeModelRef("sonnet");

describe("Claude last-Turn rollback", () => {
  it("restores lazy native configuration before selecting permission mode", async () => {
    const f = await fixture();
    const session = await unwrap(
      f.adapter().open({
        kind: "resume",
        cwd: f.directory,
        nativeRef: f.sourceRef,
        model,
        thinkingOptionId: CLAUDE_DEFAULT_THINKING_OPTION_ID,
      }),
    );
    await session.execute({
      type: "permissionMode.select",
      permissionModeId: CLAUDE_DEFAULT_PERMISSION_MODE_ID,
    });
    expect(await session.readSnapshot()).toMatchObject({
      ok: true,
      value: { state: { effectiveModel: model } },
    });
    expect(f.transports).toHaveLength(0);
  });

  it("keeps durable pending configuration authoritative over stale resume hints", async () => {
    const f = await fixture();
    const ref = await new ClaudePendingSessions(f.environment).create(f.directory, {
      effectiveModel: model,
    });
    const session = await unwrap(
      f.adapter().open({
        kind: "resume",
        cwd: f.directory,
        nativeRef: ref,
        model: encodeClaudeModelRef("default"),
      }),
    );
    expect(session.initialState.effectiveModel).toEqual(model);
  });

  it("reserves empty history, restores it in another Adapter and uses the same ID for edited input", async () => {
    const f = await fixture();
    const source = structuredClone(f.histories.get(f.sourceRef.nativeSessionId));
    const first = f.adapter();
    const replacement = await unwrap(
      first.open({ kind: "rollbackLastTurn", cwd: f.directory, sourceRef: f.sourceRef, model }),
    );
    expect(replacement.capabilities.history).toMatchObject({
      rollbackLastTurn: true,
    });
    const ref = nativeSessionRefSchema.parse(replacement.initialState.nativeRef);
    expect(ref.nativeSessionId).not.toBe(f.sourceRef.nativeSessionId);
    expect(await replacement.readSnapshot()).toMatchObject({
      ok: true,
      value: { turns: [], state: { nativeRef: ref, effectiveModel: model } },
    });
    await first.close();
    const second = f.adapter();
    const resumed = await unwrap(
      second.open({ kind: "resume", cwd: f.directory, nativeRef: ref, knownTurnRefs: [] }),
    );
    expect(await resumed.readSnapshot()).toMatchObject({ ok: true, value: { turns: [] } });
    expect(f.transports).toHaveLength(0);
    expect(
      await resumed.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse(randomUUID()),
        input: [{ type: "text", text: "edited" }],
      }),
    ).toMatchObject({ ok: true });
    await vi.waitFor(async () =>
      expect(await resumed.readSnapshot()).toMatchObject({
        ok: true,
        value: { turns: [{ input: [{ text: "edited" }] }] },
      }),
    );
    expect(f.transports[0]?.input).toMatchObject({
      openMode: "create",
      sessionId: ref.nativeSessionId,
      model: "sonnet",
    });
    await second.close();
    const third = f.adapter();
    const cold = await unwrap(third.open({ kind: "resume", cwd: f.directory, nativeRef: ref }));
    expect(await cold.readSnapshot()).toMatchObject({
      ok: true,
      value: { turns: [{ input: [{ text: "edited" }] }] },
    });
    expect(f.histories.get(f.sourceRef.nativeSessionId)).toEqual(source);
    f.histories.delete(ref.nativeSessionId);
    expect(await cold.readSnapshot()).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
  });

  it("keeps the full prior Turn through native Fork and preserves source history", async () => {
    const f = await fixture(2);
    const before = structuredClone(f.histories.get(f.sourceRef.nativeSessionId));
    const replacement = await unwrap(
      f
        .adapter()
        .open({ kind: "rollbackLastTurn", cwd: f.directory, sourceRef: f.sourceRef, model }),
    );
    expect(await replacement.readSnapshot()).toMatchObject({
      ok: true,
      value: {
        turns: [
          { input: [{ text: "prompt 1" }], items: [{ item: { text: "prompt 1 response" } }] },
        ],
      },
    });
    expect(f.histories.get(f.sourceRef.nativeSessionId)).toEqual(before);
    expect(f.dependencies.forkSession).toHaveBeenCalledOnce();
  });

  it("compares file-change provenance by retained Tool position after native Fork rekeys IDs", async () => {
    const f = await fixture(2);
    const original = f.histories.get(f.sourceRef.nativeSessionId);
    if (!original || original.length !== 4) throw new Error("Missing two-Turn Claude fixture");
    f.histories.set(f.sourceRef.nativeSessionId, [
      original[0] as NativeMessage,
      {
        type: "assistant",
        uuid: randomUUID(),
        session_id: f.sourceRef.nativeSessionId,
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "sample.txt" } },
          ],
        },
      },
      {
        type: "user",
        uuid: randomUUID(),
        session_id: f.sourceRef.nativeSessionId,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "edit-1", content: "edited" }],
        },
        toolUseResult: {
          filePath: path.join(f.directory, "sample.txt"),
          structuredPatch: [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
          ],
        },
      },
      ...original.slice(1),
    ]);
    const replacement = await unwrap(
      f.adapter().open({
        kind: "rollbackLastTurn",
        cwd: f.directory,
        sourceRef: f.sourceRef,
        model,
      }),
    );
    const source = await unwrap(
      f.adapter().open({ kind: "resume", cwd: f.directory, nativeRef: f.sourceRef }),
    );
    const sourceSnapshot = await source.readSnapshot();
    const forkSnapshot = await replacement.readSnapshot();
    if (!sourceSnapshot.ok || !forkSnapshot.ok) throw new Error("Missing Claude Fork history");
    const sourceItems = sourceSnapshot.value.turns[0]?.items.map(({ item }) => item);
    const forkItems = forkSnapshot.value.turns[0]?.items.map(({ item }) => item);
    expect(sourceItems?.map(({ type }) => type)).toEqual([
      "toolExecution",
      "fileChange",
      "agentMessage",
    ]);
    expect(forkItems?.map(({ type }) => type)).toEqual(sourceItems?.map(({ type }) => type));
    const sourceTool = sourceItems?.[0];
    const sourceChange = sourceItems?.[1];
    const forkTool = forkItems?.[0];
    const forkChange = forkItems?.[1];
    if (
      !sourceTool ||
      sourceChange?.type !== "fileChange" ||
      !forkTool ||
      forkChange?.type !== "fileChange"
    )
      throw new Error("Missing Claude File Change provenance");
    expect(sourceChange.sourceItemIds).toEqual([sourceTool.itemId]);
    expect(forkChange.sourceItemIds).toEqual([forkTool.itemId]);
    expect(forkTool.itemId).not.toBe(sourceTool.itemId);
  });

  it("persists configuration changes made before the first resend", async () => {
    const f = await fixture();
    const first = f.adapter();
    const session = await unwrap(
      first.open({ kind: "rollbackLastTurn", cwd: f.directory, sourceRef: f.sourceRef }),
    );
    await session.execute({ type: "model.select", model });
    await session.close();
    const resumed = await unwrap(
      f.adapter().open({
        kind: "resume",
        cwd: f.directory,
        nativeRef: nativeSessionRefSchema.parse(session.initialState.nativeRef),
      }),
    );
    expect(await resumed.readSnapshot()).toMatchObject({
      ok: true,
      value: {
        state: {
          effectiveModel: model,
          effectiveThinkingOptionId: CLAUDE_DEFAULT_THINKING_OPTION_ID,
          effectivePermissionModeId: CLAUDE_DEFAULT_PERMISSION_MODE_ID,
        },
      },
    });
  });

  it("does not pretend a claimed but missing transcript is an empty Session", async () => {
    const f = await fixture();
    const store = new ClaudePendingSessions(f.environment);
    const ref = await store.create(f.directory, {});
    await store.claim(ref, f.directory, "other-wrapper");
    const session = await unwrap(
      f.adapter().open({ kind: "resume", cwd: f.directory, nativeRef: ref }),
    );
    expect(await session.readSnapshot()).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
    await expect(store.claim(ref, f.directory, "third-wrapper")).rejects.toMatchObject({
      code: "EEXIST",
    });
    await expect(store.read(ref, path.join(f.directory, "other"))).rejects.toThrow();
  });

  it("propagates a failed Transport close to the history replacement caller", async () => {
    const f = await fixture(2);
    const session = await unwrap(
      f.adapter().open({ kind: "resume", cwd: f.directory, nativeRef: f.sourceRef }),
    );
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse(randomUUID()),
      input: [{ type: "text", text: "next" }],
    });
    assert.ok(f.transports[0]);
    vi.mocked(f.transports[0].close).mockRejectedValue(new Error("process still alive"));
    await expect(session.close()).rejects.toThrow("could not stop safely");
    await expect(session.close()).rejects.toThrow();
  });

  it("waits for the completed native message before deriving an immediate edit", async () => {
    const f = await fixture();
    const adapter = f.adapter();
    const session = await unwrap(
      adapter.open({ kind: "resume", cwd: f.directory, nativeRef: f.sourceRef }),
    );
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse(randomUUID()),
      input: [{ type: "text", text: "not flushed yet" }],
    });
    await vi.waitFor(() => expect(f.histories.get(f.sourceRef.nativeSessionId)).toHaveLength(4));
    const saved = f.histories.get(f.sourceRef.nativeSessionId);
    assert.ok(saved);
    f.histories.set(f.sourceRef.nativeSessionId, saved.slice(0, 2));
    const rollback = adapter.open({
      kind: "rollbackLastTurn",
      cwd: f.directory,
      sourceRef: f.sourceRef,
    });
    setTimeout(() => f.histories.set(f.sourceRef.nativeSessionId, saved), 10);
    const replacement = await unwrap(rollback);
    expect(await replacement.readSnapshot()).toMatchObject({
      ok: true,
      value: { turns: [{ input: [{ text: "prompt 1" }] }] },
    });
    expect(f.dependencies.forkSession).toHaveBeenCalledOnce();
  });

  it("allows only one competing wrapper to create the reserved native Session", async () => {
    const f = await fixture();
    const ref = await new ClaudePendingSessions(f.environment).create(f.directory, {});
    const sessions = await Promise.all(
      [f.adapter(), f.adapter()].map((adapter) =>
        unwrap(adapter.open({ kind: "resume", cwd: f.directory, nativeRef: ref })),
      ),
    );
    const results = await Promise.all(
      sessions.map((session) =>
        session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse(randomUUID()),
          input: [{ type: "text", text: "one owner" }],
        }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(f.transports).toHaveLength(1);
  });

  it("releases an unused reservation after startup fails and close succeeds", async () => {
    const f = await fixture();
    const store = new ClaudePendingSessions(f.environment);
    const ref = await store.create(f.directory, {});
    vi.mocked(f.dependencies.createTransport).mockImplementationOnce(() => {
      throw new Error("cannot spawn");
    });
    const session = await unwrap(
      f.adapter().open({ kind: "resume", cwd: f.directory, nativeRef: ref }),
    );
    expect(
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse(randomUUID()),
        input: [{ type: "text", text: "retry" }],
      }),
    ).toMatchObject({ ok: false });
    expect(await store.read(ref, f.directory)).toMatchObject({ started: false });
    expect(
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse(randomUUID()),
        input: [{ type: "text", text: "retry" }],
      }),
    ).toMatchObject({ ok: true });
    expect(f.transports).toHaveLength(1);
  });

  it("reports a failed release of an unused reservation and retries it on the next idle release", async () => {
    const f = await fixture();
    const store = new ClaudePendingSessions(f.environment);
    const ref = await store.create(f.directory, {});
    vi.mocked(f.dependencies.createTransport).mockImplementationOnce(() => {
      throw new Error("cannot spawn");
    });
    const release = vi
      .spyOn(ClaudePendingSessions.prototype, "release")
      .mockRejectedValueOnce(new Error("reservation is locked"))
      .mockRejectedValueOnce(new Error("reservation is locked"));
    try {
      const session = await unwrap(
        f.adapter().open({ kind: "resume", cwd: f.directory, nativeRef: ref }),
      );
      const lifecycle = session.resourceLifecycle;
      if (!lifecycle) throw new Error("Missing idle lifecycle");
      expect(
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse(randomUUID()),
          input: [{ type: "text", text: "cannot start" }],
        }),
      ).toMatchObject({ ok: false });
      expect(await store.read(ref, f.directory)).toMatchObject({ started: true });

      // The claim is the only native resource left: its failed release keeps
      // the Session open, and the Host's next idle tick retries it.
      await expect(lifecycle.suspend(new AbortController().signal)).resolves.toEqual({
        status: "releaseFailed",
        reason: "Claude Code Session release failed: Claude Code Session could not stop safely",
      });
      await expect(lifecycle.suspend(new AbortController().signal)).resolves.toEqual({
        status: "suspended",
        scope: "claude-sdk-session",
      });
      expect(release).toHaveBeenCalledTimes(3);
      expect(await store.read(ref, f.directory)).toMatchObject({ started: false });
      expect(f.transports).toHaveLength(0);
    } finally {
      release.mockRestore();
    }
  });

  it("starts on its own reservation when the release after a failed startup failed", async () => {
    const f = await fixture();
    const store = new ClaudePendingSessions(f.environment);
    const ref = await store.create(f.directory, {});
    vi.mocked(f.dependencies.createTransport).mockImplementationOnce(() => {
      throw new Error("cannot spawn");
    });
    const release = vi
      .spyOn(ClaudePendingSessions.prototype, "release")
      .mockRejectedValueOnce(new Error("reservation is locked"));
    try {
      const session = await unwrap(
        f.adapter().open({ kind: "resume", cwd: f.directory, nativeRef: ref }),
      );
      const start = (text: string) =>
        session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse(randomUUID()),
          input: [{ type: "text", text }],
        });
      expect(await start("cannot start")).toMatchObject({ ok: false });
      expect(await start("retry")).toMatchObject({ ok: true });
      expect(f.transports).toHaveLength(1);
      // Another wrapper still cannot take the reservation this Session holds.
      await expect(store.claim(ref, f.directory, "other-wrapper")).rejects.toMatchObject({
        code: "EEXIST",
      });
    } finally {
      release.mockRestore();
    }
  });

  it("keeps each reservation claim with the owner that took it", async () => {
    const f = await fixture();
    const store = new ClaudePendingSessions(f.environment);
    const ref = await store.create(f.directory, {});
    await store.claim(ref, f.directory, "owner");
    // A retry by the owner confirms its claim; anyone else is still refused.
    await store.claim(ref, f.directory, "owner");
    await expect(store.claim(ref, f.directory, "other")).rejects.toMatchObject({ code: "EEXIST" });
    // Releasing a claim that is not yours removes nothing.
    await store.release(ref, f.directory, "other");
    expect(await store.read(ref, f.directory)).toMatchObject({ started: true });
    await store.release(ref, f.directory, "owner");
    expect(await store.read(ref, f.directory)).toMatchObject({ started: false });
    // A claim that is already gone is released.
    await store.release(ref, f.directory, "owner");
    // A claim written before owner tokens belongs to no current owner.
    const claimFile = path.join(
      f.directory,
      "codexhost",
      "pending-sessions",
      ref.nativeSessionId,
      "started",
    );
    await writeFile(claimFile, "");
    await expect(store.claim(ref, f.directory, "owner")).rejects.toMatchObject({ code: "EEXIST" });
    await store.release(ref, f.directory, "owner");
    expect(await store.read(ref, f.directory)).toMatchObject({ started: true });
  });

  it("claims again when a failed release had already removed the claim", async () => {
    const f = await fixture();
    const store = new ClaudePendingSessions(f.environment);
    const ref = await store.create(f.directory, {});
    vi.mocked(f.dependencies.createTransport).mockImplementationOnce(() => {
      throw new Error("cannot spawn");
    });
    const original = ClaudePendingSessions.prototype.release;
    // The unlink lands, then the directory sync fails.
    const release = vi
      .spyOn(ClaudePendingSessions.prototype, "release")
      .mockImplementationOnce(async function (this: ClaudePendingSessions, ...input) {
        await original.apply(this, input);
        throw new Error("directory sync failed");
      });
    try {
      const session = await unwrap(
        f.adapter().open({ kind: "resume", cwd: f.directory, nativeRef: ref }),
      );
      const start = (text: string) =>
        session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse(randomUUID()),
          input: [{ type: "text", text }],
        });
      expect(await start("cannot start")).toMatchObject({ ok: false });
      expect(await store.read(ref, f.directory)).toMatchObject({ started: false });

      // The native input is submitted only under a claim this Session took again.
      expect(await start("retry")).toMatchObject({ ok: true });
      expect(await store.read(ref, f.directory)).toMatchObject({ started: true });
      await expect(store.claim(ref, f.directory, "other-wrapper")).rejects.toMatchObject({
        code: "EEXIST",
      });
      expect(f.transports).toHaveLength(1);
    } finally {
      release.mockRestore();
    }
  });

  it("loses a reservation another wrapper claimed after a failed release removed it", async () => {
    const f = await fixture();
    const store = new ClaudePendingSessions(f.environment);
    const ref = await store.create(f.directory, {});
    vi.mocked(f.dependencies.createTransport).mockImplementationOnce(() => {
      throw new Error("cannot spawn");
    });
    const original = ClaudePendingSessions.prototype.release;
    const release = vi
      .spyOn(ClaudePendingSessions.prototype, "release")
      .mockImplementationOnce(async function (this: ClaudePendingSessions, ...input) {
        await original.apply(this, input);
        throw new Error("directory sync failed");
      });
    try {
      const session = await unwrap(
        f.adapter().open({ kind: "resume", cwd: f.directory, nativeRef: ref }),
      );
      const lifecycle = session.resourceLifecycle;
      if (!lifecycle) throw new Error("Missing idle lifecycle");
      const start = (text: string) =>
        session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse(randomUUID()),
          input: [{ type: "text", text }],
        });
      expect(await start("cannot start")).toMatchObject({ ok: false });
      await store.claim(ref, f.directory, "other-wrapper");

      // Only one writer: this Session cannot start on the other wrapper's claim.
      expect(await start("contended")).toMatchObject({ ok: false });
      expect(f.transports).toHaveLength(0);
      // Its release leaves the other wrapper's claim in place.
      await expect(lifecycle.suspend(new AbortController().signal)).resolves.toEqual({
        status: "suspended",
        scope: "claude-sdk-session",
      });
      expect(await store.read(ref, f.directory)).toMatchObject({ started: true });
    } finally {
      release.mockRestore();
    }
  });

  it("keeps an interrupted preceding Turn without an assistant checkpoint", async () => {
    const f = await fixture(2);
    const source = f.histories.get(f.sourceRef.nativeSessionId);
    assert.ok(source?.[0]);
    f.histories.set(f.sourceRef.nativeSessionId, [source[0], ...source.slice(2)]);
    const replacement = await unwrap(
      f.adapter().open({ kind: "rollbackLastTurn", cwd: f.directory, sourceRef: f.sourceRef }),
    );
    expect(await replacement.readSnapshot()).toMatchObject({
      ok: true,
      value: { turns: [{ input: [{ text: "prompt 1" }], items: [] }] },
    });
  });

  it("rejects missing recovery metadata instead of silently recreating it", async () => {
    const f = await fixture();
    const store = new ClaudePendingSessions(f.environment);
    const ref = await store.create(f.directory, {});
    await store.discard(ref, f.directory);
    expect(
      await f.adapter().open({ kind: "resume", cwd: f.directory, nativeRef: ref }),
    ).toMatchObject({ ok: false, error: { code: "sessionNotFound" } });
    expect(f.transports).toHaveLength(0);
  });
});
