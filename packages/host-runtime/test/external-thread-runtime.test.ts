import type {
  HarnessAdapter,
  HarnessInspection,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  encodeHarnessPluginRoute,
  harnessIdSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import {
  encodeClaudeTransportModel,
  encodeGrokTransportModel,
  encodeOmpTransportModel,
  encodeOpenCodeTransportModel,
  type ExternalHarnessId,
} from "@codexhost/protocol-core";
import { describe, expect, it, vi } from "vitest";

import type { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { ExternalThreadRuntime } from "../src/external-thread-runtime.js";

const harnessId = harnessIdSchema.parse("pi");
const hostThreadId = hostThreadIdSchema.parse("thread-1");

function record(): StoredThreadRecordV1 {
  return {
    formatVersion: 1,
    revision: 1,
    hostThreadId,
    createRequestId: "create-1",
    harnessId,
    state: "ready",
    nativeSessionRef: nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: "native-1",
      formatVersion: 1,
    }),
    cwd: "/synthetic",
    title: "Pi Thread",
    archived: false,
    transportModelId: "codexhost/pi-native",
    ephemeral: false,
    historyMode: "legacy",
    turnMappings: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T01:00:00.000Z",
  } as StoredThreadRecordV1;
}

describe("ExternalThreadRuntime register", () => {
  it("passes restored mode before a plugin resolves persisted execution policy", async () => {
    const id = harnessIdSchema.parse("policy-fixture");
    const permissionModeId = harnessPermissionModeIdSchema.parse("plan");
    const adapter = new FakeHarnessAdapter(
      id,
      undefined,
      true,
      true,
      null,
      harnessPermissionModeCatalogSchema.parse({
        defaultModeId: "plan",
        modes: [{ id: "plan", label: "Plan" }],
      }),
    );
    const created = await adapter.open({ kind: "create", cwd: "/synthetic", permissionModeId });
    if (!created.ok || !created.value.initialState.nativeRef)
      throw new Error("Missing fixture session");
    const stored: StoredThreadRecordV1 = {
      ...record(),
      harnessId: id,
      nativeSessionRef: created.value.initialState.nativeRef,
      executionPolicy: "unattended-full-access",
      transportModelId: encodeHarnessPluginRoute({ harnessId: id, permissionModeId }),
    };
    const open = vi.spyOn(adapter, "open");
    const execute = vi.spyOn(created.value, "execute");
    const runtime = new ExternalThreadRuntime({
      adapters: new Map([[id, adapter]]),
      repository: {
        find: async () => stored,
        alignSnapshot: async () => ({ record: stored, turns: [] }),
        sessionTreeId: async () => hostThreadId,
      } as unknown as ExternalThreadRepository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });
    try {
      expect((await runtime.resolve(hostThreadId)).kind).toBe("external");
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "resume",
          permissionModeId,
          executionPolicy: "unattended-full-access",
        }),
      );
      expect(execute).not.toHaveBeenCalled();
    } finally {
      runtime.clear();
      await adapter.close();
    }
  });
  it("exposes the requested create Model before the Session publishes state", async () => {
    const adapter = new FakeHarnessAdapter(harnessId);
    const model = adapter.catalog.models[1]?.ref;
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("low");
    if (!model) throw new Error("Fake catalog has no secondary Model");
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      model,
      thinkingOptionId,
    });
    if (!opened.ok) throw new Error(opened.error.message);
    Object.defineProperty(opened.value, "initialState", { configurable: true, value: {} });

    const runtime = new ExternalThreadRuntime({
      adapters: new Map([["pi", adapter]]),
      repository: { find: async () => null } as unknown as ExternalThreadRepository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });
    const thread = runtime.register({
      record: record(),
      session: opened.value,
      sessionId: hostThreadId,
      thread: { id: hostThreadId },
      turns: [],
      requestedModel: model,
      requestedThinkingOptionId: thinkingOptionId,
    });

    expect(thread.stateObserver.state).toMatchObject({
      effectiveModel: model,
      effectiveThinkingOptionId: thinkingOptionId,
    });
  });

  it("uses live OMP state instead of stale persisted configuration", async () => {
    const ompHarnessId = harnessIdSchema.parse("omp");
    const permissionModes = harnessPermissionModeCatalogSchema.parse({
      modes: [
        { id: "always-ask", label: "Always ask" },
        { id: "write", label: "Write" },
        { id: "yolo", label: "Full access" },
      ],
      defaultModeId: "yolo",
    });
    const catalog = new FakeHarnessAdapter(ompHarnessId).catalog;
    const adapter = new FakeHarnessAdapter(
      ompHarnessId,
      catalog,
      true,
      true,
      null,
      permissionModes,
    );
    const writeMode = harnessPermissionModeIdSchema.parse("write");
    const created = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      permissionModeId: writeMode,
    });
    if (!created.ok) throw new Error(created.error.message);

    const nativeRef = created.value.initialState.nativeRef;
    const actualModel = created.value.initialState.effectiveModel;
    const actualThinking = created.value.initialState.effectiveThinkingOptionId;
    const staleModel = adapter.catalog.models[1]?.ref;
    if (!nativeRef || !actualModel || !actualThinking || !staleModel) {
      throw new Error("Fake OMP Session did not expose the expected configuration state");
    }

    let stored: StoredThreadRecordV1 = {
      ...record(),
      harnessId: ompHarnessId,
      nativeSessionRef: nativeRef,
      transportModelId: encodeOmpTransportModel(
        staleModel,
        harnessThinkingOptionIdSchema.parse("low"),
      ),
      historyMode: "legacy",
    };
    const setTransportModelId = vi.fn(
      async (_threadId: string, transportModelId: string): Promise<StoredThreadRecordV1> => {
        stored = { ...stored, transportModelId };
        return stored;
      },
    );
    const repository = {
      find: async () => stored,
      alignSnapshot: async (current: StoredThreadRecordV1) => ({ record: current, turns: [] }),
      sessionTreeId: async () => hostThreadId,
      setTransportModelId,
    } as unknown as ExternalThreadRepository;
    const runtime = new ExternalThreadRuntime({
      adapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([["omp", adapter]]),
      repository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });

    const resolved = await runtime.resolve(hostThreadId);

    expect(resolved.kind).toBe("external");
    if (resolved.kind !== "external") return;
    expect(resolved.thread.stateObserver.state).toMatchObject({
      effectiveModel: actualModel,
      effectiveThinkingOptionId: actualThinking,
    });
    const effectiveTransportModelId = encodeOmpTransportModel(
      actualModel,
      actualThinking,
      writeMode,
    );
    expect(resolved.thread.record.transportModelId).toBe(effectiveTransportModelId);
    expect(setTransportModelId).toHaveBeenCalledWith(hostThreadId, effectiveTransportModelId);

    await adapter.close();
  });

  it("does not restore persisted Thinking when live OMP state omits it", async () => {
    const ompHarnessId = harnessIdSchema.parse("omp");
    const adapter = new FakeHarnessAdapter(ompHarnessId);
    const created = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!created.ok) throw new Error(created.error.message);

    const session = created.value;
    const nativeRef = session.initialState.nativeRef;
    const actualModel = session.initialState.effectiveModel;
    const staleThinking = harnessThinkingOptionIdSchema.parse("low");
    if (!nativeRef || !actualModel || !(session instanceof FakeHarnessSession)) {
      throw new Error("Fake OMP Session did not expose the expected configuration state");
    }
    session.setStateForSnapshot({ nativeRef, effectiveModel: actualModel });

    const staleTransportModelId = encodeOmpTransportModel(actualModel, staleThinking);
    const stored: StoredThreadRecordV1 = {
      ...record(),
      harnessId: ompHarnessId,
      nativeSessionRef: nativeRef,
      transportModelId: staleTransportModelId,
      historyMode: "legacy",
    } as StoredThreadRecordV1;
    const repository = {
      find: async () => stored,
      alignSnapshot: async (current: StoredThreadRecordV1) => ({ record: current, turns: [] }),
      sessionTreeId: async () => hostThreadId,
      setTransportModelId: async (_threadId: string, transportModelId: string) => ({
        ...stored,
        transportModelId,
      }),
    } as unknown as ExternalThreadRepository;
    const runtime = new ExternalThreadRuntime({
      adapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([["omp", adapter]]),
      repository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });

    const resolved = await runtime.resolve(hostThreadId);

    expect(resolved.kind).toBe("external");
    if (resolved.kind !== "external") return;
    expect(resolved.thread.stateObserver.state).toMatchObject({
      effectiveModel: actualModel,
    });
    expect(resolved.thread.stateObserver.state.effectiveThinkingOptionId).toBeUndefined();
    expect(resolved.thread.requestedThinkingOptionId).toBeUndefined();
    expect(resolved.thread.transportModelId).toBe(encodeOmpTransportModel(actualModel));

    await adapter.close();
  });

  it("keeps OMP restore successful when live selection persistence fails", async () => {
    const ompHarnessId = harnessIdSchema.parse("omp");
    const adapter = new FakeHarnessAdapter(ompHarnessId);
    const created = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!created.ok) throw new Error(created.error.message);

    const nativeRef = created.value.initialState.nativeRef;
    const actualModel = created.value.initialState.effectiveModel;
    const actualThinking = created.value.initialState.effectiveThinkingOptionId;
    const staleModel = adapter.catalog.models[1]?.ref;
    if (!nativeRef || !actualModel || !actualThinking || !staleModel) {
      throw new Error("Fake OMP Session did not expose the expected configuration state");
    }

    const staleTransportModelId = encodeOmpTransportModel(
      staleModel,
      harnessThinkingOptionIdSchema.parse("low"),
    );
    const setTransportModelId = vi.fn(async () => {
      throw new Error("synthetic mapping persistence failure");
    });
    const diagnose = vi.fn();
    const stored: StoredThreadRecordV1 = {
      ...record(),
      harnessId: ompHarnessId,
      nativeSessionRef: nativeRef,
      transportModelId: staleTransportModelId,
      historyMode: "legacy",
    } as StoredThreadRecordV1;
    const repository = {
      find: async () => stored,
      alignSnapshot: async (current: StoredThreadRecordV1) => ({ record: current, turns: [] }),
      sessionTreeId: async () => hostThreadId,
      setTransportModelId,
    } as unknown as ExternalThreadRepository;
    const runtime = new ExternalThreadRuntime({
      adapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([["omp", adapter]]),
      repository,
      consumeOutputs: async () => undefined,
      diagnose,
    });

    const resolved = await runtime.resolve(hostThreadId);

    expect(resolved.kind).toBe("external");
    if (resolved.kind !== "external") return;
    expect(resolved.thread.stateObserver.state).toMatchObject({
      effectiveModel: actualModel,
      effectiveThinkingOptionId: actualThinking,
    });
    expect(resolved.thread.record.transportModelId).toBe(staleTransportModelId);
    expect(resolved.thread.transportModelId).toBe(
      encodeOmpTransportModel(actualModel, actualThinking),
    );
    expect(setTransportModelId).toHaveBeenCalledOnce();
    expect(diagnose).toHaveBeenCalledWith(expect.any(Error));

    await adapter.close();
  });

  it("uses live OpenCode Permission Mode when the persisted selection is stale", async () => {
    const openCodeHarnessId = harnessIdSchema.parse("opencode");
    const permissionModes = harnessPermissionModeCatalogSchema.parse({
      modes: [
        { id: "default", label: "Default" },
        { id: "ask", label: "Ask" },
      ],
      defaultModeId: "default",
    });
    const defaultMode = harnessPermissionModeIdSchema.parse("default");
    const askMode = harnessPermissionModeIdSchema.parse("ask");
    const adapter = new FakeHarnessAdapter(
      openCodeHarnessId,
      undefined,
      true,
      true,
      null,
      permissionModes,
    );
    const model = adapter.catalog.defaultModel;
    if (!model) throw new Error("Fake OpenCode catalog has no default Model");
    const created = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      model,
      permissionModeId: askMode,
    });
    if (
      !created.ok ||
      !created.value.initialState.nativeRef ||
      !(created.value instanceof FakeHarnessSession)
    ) {
      throw new Error("Fake OpenCode Session did not open");
    }
    created.value.rejectNextPermissionModeSelection({
      code: "nativeFailure",
      message: "OpenCode did not confirm the requested Permission Mode",
      retryable: false,
    });
    const execute = vi.spyOn(created.value, "execute");
    const stored: StoredThreadRecordV1 = {
      ...record(),
      harnessId: openCodeHarnessId,
      nativeSessionRef: created.value.initialState.nativeRef,
      title: "OpenCode Thread",
      transportModelId: encodeOpenCodeTransportModel(model, defaultMode),
    } as StoredThreadRecordV1;
    const setTransportModelId = vi.fn(
      async (_threadId: string, transportModelId: string): Promise<StoredThreadRecordV1> => ({
        ...stored,
        transportModelId,
      }),
    );
    const repository = {
      find: async () => stored,
      alignSnapshot: async () => ({ record: stored, turns: [] }),
      sessionTreeId: async () => hostThreadId,
      setTransportModelId,
    } as unknown as ExternalThreadRepository;
    const runtime = new ExternalThreadRuntime({
      adapters: new Map([["opencode", adapter]]),
      repository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });

    const resolved = await runtime.resolve(hostThreadId);

    expect(resolved.kind).toBe("external");
    if (resolved.kind !== "external") throw new Error("OpenCode Thread did not restore");
    const liveThinking = created.value.initialState.effectiveThinkingOptionId;
    expect(execute).not.toHaveBeenCalled();
    expect(resolved.thread.stateObserver.state.effectivePermissionModeId).toBe(askMode);
    expect(resolved.thread.transportModelId).toBe(
      encodeOpenCodeTransportModel(model, askMode, liveThinking),
    );
    expect(setTransportModelId).toHaveBeenCalledWith(
      hostThreadId,
      encodeOpenCodeTransportModel(model, askMode, liveThinking),
    );

    await adapter.close();
  });

  it.each(["auto", "always-approve"] as const)(
    "restores a Grok Thread whose mapping stores %s Permission Mode",
    async (storedModeId) => {
      const grokHarnessId = harnessIdSchema.parse("grok");
      const permissionModes = harnessPermissionModeCatalogSchema.parse({
        modes: [
          { id: "ask", label: "Ask" },
          { id: "auto", label: "Auto" },
          { id: "always-approve", label: "Always approve", dangerous: true },
        ],
        defaultModeId: "ask",
      });
      const defaultMode = harnessPermissionModeIdSchema.parse("ask");
      const storedMode = harnessPermissionModeIdSchema.parse(storedModeId);
      const adapter = new FakeHarnessAdapter(
        grokHarnessId,
        undefined,
        true,
        true,
        null,
        permissionModes,
        false,
        "atCreate",
      );
      const model = adapter.catalog.defaultModel;
      if (!model) throw new Error("Fake Grok catalog has no default Model");
      const created = await adapter.open({
        kind: "create",
        cwd: "/synthetic",
        model,
        permissionModeId: defaultMode,
      });
      if (!created.ok || !created.value.initialState.nativeRef) {
        throw new Error("Fake Grok Session did not open");
      }
      const session = created.value;
      if (!(session instanceof FakeHarnessSession)) {
        throw new Error("Fake Grok Session did not expose snapshot state");
      }
      const stored: StoredThreadRecordV1 = {
        ...record(),
        harnessId: grokHarnessId,
        nativeSessionRef: created.value.initialState.nativeRef,
        title: "Grok Thread",
        transportModelId: encodeGrokTransportModel(model, storedMode),
      } as StoredThreadRecordV1;
      const execute = vi.spyOn(session, "execute");
      const repository = {
        find: async () => stored,
        alignSnapshot: async () => ({ record: stored, turns: [] }),
        sessionTreeId: async () => hostThreadId,
      } as unknown as ExternalThreadRepository;
      const open = vi.fn(async (input: OpenSessionInput) => {
        if (input.kind === "resume" && input.permissionModeId) {
          session.setStateForSnapshot({
            ...session.state,
            effectivePermissionModeId: input.permissionModeId,
          });
        }
        return adapter.open(input);
      });
      const restoringAdapter: HarnessAdapter = {
        harnessId: adapter.harnessId,
        inspect: (input): Promise<HarnessInspection> => adapter.inspect(input),
        open,
        close: () => adapter.close(),
      };
      const runtime = new ExternalThreadRuntime({
        adapters: new Map([["grok", restoringAdapter]]),
        environment: {
          CODEXHOST_CLI_PATH: "/opt/codexhost",
          CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
          CODEXHOST_RUNTIME_TOKEN: "token",
        },
        repository,
        consumeOutputs: async () => undefined,
        diagnose: () => undefined,
      });

      const resolved = await runtime.resolve(hostThreadId);

      expect(resolved.kind).toBe("external");
      if (resolved.kind !== "external") throw new Error("Grok Thread did not restore");
      expect(execute).not.toHaveBeenCalled();
      expect(session.capabilities.configuration.permissionModeScope).toBe("atCreate");
      expect(resolved.thread.stateObserver.state.effectivePermissionModeId).toBe(storedMode);
      expect(resolved.thread.record.transportModelId).toBe(
        encodeGrokTransportModel(model, storedMode),
      );
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({
          permissionModeId: storedMode,
          environment: expect.objectContaining({
            CODEXHOST_CLI_PATH: "/opt/codexhost",
            CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
            CODEXHOST_RUNTIME_TOKEN: "token",
            CODEXHOST_THREAD_ID: hostThreadId,
          }),
        }),
      );

      await adapter.close();
    },
  );
});

describe("deferred live resume", () => {
  it("restores history without opening a live Session until execute", async () => {
    const adapter = new FakeHarnessAdapter(harnessId);
    const nativeRef = nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: "native-history",
      formatVersion: 1,
    });
    const history = new FakeHarnessSession(harnessId, undefined, undefined, nativeRef);
    Object.defineProperty(history, "executionReady", { value: false });
    const live = new FakeHarnessSession(harnessId, undefined, undefined, nativeRef);
    const stored: StoredThreadRecordV1 = {
      ...record(),
      nativeSessionRef: nativeRef,
    };
    const order: string[] = [];
    const originalHistoryClose = history.close.bind(history);
    vi.spyOn(history, "close").mockImplementation(async () => {
      order.push("close-history");
      await originalHistoryClose();
    });
    const open = vi.fn(async (input: OpenSessionInput) => {
      if (input.kind === "resume" && input.historyOnly)
        return { ok: true as const, value: history };
      order.push("open-live");
      return { ok: true as const, value: live };
    });
    const restoringAdapter: HarnessAdapter = {
      harnessId: adapter.harnessId,
      inspect: (input) => adapter.inspect(input),
      open,
      close: () => adapter.close(),
    };
    const runtime = new ExternalThreadRuntime({
      adapters: new Map([["pi", restoringAdapter]]),
      repository: {
        find: async () => stored,
        alignSnapshot: async () => ({ record: stored, turns: [] }),
        sessionTreeId: async () => hostThreadId,
      } as unknown as ExternalThreadRepository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });
    const resolved = await runtime.resolve(hostThreadId);
    expect(resolved.kind).toBe("external");
    if (resolved.kind !== "external") throw new Error("Thread did not restore");
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ historyOnly: true }));
    expect(
      open.mock.calls.filter(([input]) => input.kind === "resume" && !input.historyOnly),
    ).toHaveLength(0);
    await resolved.thread.session.readSnapshot();
    expect(
      open.mock.calls.filter(([input]) => input.kind === "resume" && !input.historyOnly),
    ).toHaveLength(0);
    const started = await resolved.thread.session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-live"),
      input: [{ type: "text", text: "continue" }],
    });
    expect(started.ok).toBe(true);
    expect(
      open.mock.calls.some(([input]) => input.kind === "resume" && input.historyOnly !== true),
    ).toBe(true);
    expect(order).toEqual(["close-history", "open-live"]);
    expect(live.snapshotReads).toBe(0);
    await adapter.close();
  });

  it("replays Permission Mode when a live restore ignores historyOnly", async () => {
    const claudeHarnessId = harnessIdSchema.parse("claude-code");
    const permissionModes = harnessPermissionModeCatalogSchema.parse({
      modes: [
        { id: "default", label: "Default" },
        { id: "bypassPermissions", label: "Bypass" },
      ],
      defaultModeId: "default",
    });
    const defaultMode = harnessPermissionModeIdSchema.parse("default");
    const storedMode = harnessPermissionModeIdSchema.parse("bypassPermissions");
    const adapter = new FakeHarnessAdapter(
      claudeHarnessId,
      undefined,
      true,
      true,
      null,
      permissionModes,
    );
    const model = adapter.catalog.defaultModel;
    if (!model) throw new Error("Fake Claude catalog has no default Model");
    const created = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      model,
      permissionModeId: defaultMode,
    });
    if (!created.ok || !created.value.initialState.nativeRef) {
      throw new Error("Fake Claude Session did not open");
    }
    const session = created.value;
    const execute = vi.spyOn(session, "execute");
    const stored: StoredThreadRecordV1 = {
      ...record(),
      harnessId: claudeHarnessId,
      nativeSessionRef: created.value.initialState.nativeRef,
      title: "Claude Thread",
      transportModelId: encodeClaudeTransportModel(model, storedMode),
    } as StoredThreadRecordV1;
    const restoringAdapter: HarnessAdapter = {
      harnessId: adapter.harnessId,
      inspect: (input) => adapter.inspect(input),
      open: (input) => adapter.open(input),
      close: () => adapter.close(),
    };
    const runtime = new ExternalThreadRuntime({
      adapters: new Map([["claude-code", restoringAdapter]]),
      repository: {
        find: async () => stored,
        alignSnapshot: async () => ({ record: stored, turns: [] }),
        sessionTreeId: async () => hostThreadId,
      } as unknown as ExternalThreadRepository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });
    const resolved = await runtime.resolve(hostThreadId);
    expect(resolved.kind).toBe("external");
    expect(execute).toHaveBeenCalledWith({
      type: "permissionMode.select",
      permissionModeId: storedMode,
    });
    await adapter.close();
  });
});

describe("bounded native history", () => {
  it("shares a hung read, returns timeout, and discards its late result", async () => {
    const adapter = new FakeHarnessAdapter(harnessId);
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!opened.ok) throw new Error(opened.error.message);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = opened.value.readSnapshot.bind(opened.value);
    const read = vi.spyOn(opened.value, "readSnapshot").mockImplementation(async () => {
      await gate;
      return original();
    });
    const alignSnapshot = vi.fn();
    const runtime = new ExternalThreadRuntime({
      adapters: new Map([["pi", adapter]]),
      historyReadTimeoutMs: 20,
      repository: { alignSnapshot } as unknown as ExternalThreadRepository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });
    const thread = runtime.register({
      record: record(),
      session: opened.value,
      sessionId: hostThreadId,
      thread: { id: hostThreadId },
      turns: [],
    });
    try {
      const first = runtime.refresh(thread);
      const second = runtime.refresh(thread);
      expect(await first).toMatchObject({
        code: -32081,
        message: "External Thread history read timed out",
      });
      expect(await second).toMatchObject({ code: -32081 });
      expect(await runtime.refresh(thread)).toMatchObject({ code: -32081 });
      expect(read).toHaveBeenCalledTimes(1);
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(alignSnapshot).not.toHaveBeenCalled();
    } finally {
      release();
      runtime.clear();
      await adapter.close();
    }
  });
});

describe("idle native resource lifecycle", () => {
  it("suspends only an idle Session through the public lifecycle contract", async () => {
    const adapter = new FakeHarnessAdapter(harnessId);
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!opened.ok || !(opened.value instanceof FakeHarnessSession)) {
      throw new Error("Missing fake Session");
    }
    const session = opened.value;
    const suspend = vi.fn(async () => {
      await session.close();
      return { status: "suspended" as const, scope: "native-session" };
    });
    Object.defineProperty(session, "resourceLifecycle", {
      configurable: true,
      value: { suspend },
    });
    const runtime = new ExternalThreadRuntime({
      adapters: new Map([["pi", adapter]]),
      repository: {} as ExternalThreadRepository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
      idleSuspendTimeoutMs: 5,
    });
    try {
      runtime.register({
        record: record(),
        session,
        sessionId: hostThreadId,
        thread: { id: hostThreadId },
        turns: [],
      });
      await vi.waitFor(() => expect(suspend).toHaveBeenCalledOnce());
      expect(session.closed).toBe(true);
    } finally {
      runtime.clear();
      await adapter.close();
    }
  });

  it("does not suspend when Host-owned activity makes the Thread ineligible", async () => {
    const adapter = new FakeHarnessAdapter(harnessId);
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!opened.ok || !(opened.value instanceof FakeHarnessSession)) {
      throw new Error("Missing fake Session");
    }
    const session = opened.value;
    const suspend = vi.fn(async () => ({ status: "suspended" as const, scope: "native-session" }));
    Object.defineProperty(session, "resourceLifecycle", {
      configurable: true,
      value: { suspend },
    });
    const runtime = new ExternalThreadRuntime({
      adapters: new Map([["pi", adapter]]),
      repository: {} as ExternalThreadRepository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
      idleSuspendTimeoutMs: 5,
      canSuspend: () => false,
    });
    try {
      runtime.register({
        record: record(),
        session,
        sessionId: hostThreadId,
        thread: { id: hostThreadId },
        turns: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(suspend).not.toHaveBeenCalled();
      expect(session.closed).toBe(false);
    } finally {
      runtime.clear();
      await adapter.close();
    }
  });
});
