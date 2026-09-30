import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTwoFilesPatch } from "diff";

import type { HarnessOutput, HostUsage } from "@codexhost/harness-adapter";
import { runAdapterConformance } from "@codexhost/harness-adapter/conformance";
import {
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  type HarnessThinkingOptionId,
  type HostTurnId,
} from "@codexhost/shared-contracts";

import {
  OmpAdapter,
  type OmpAdapterDependencies,
  type OmpTurnTransport,
} from "../src/omp-adapter.js";
import type {
  OmpCompactResult,
  OmpInteractionResponse,
  OmpRpcSessionOptions,
  OmpSessionHistory,
  OmpSessionState,
  OmpSubagentMessagesResult,
  OmpTurnEvent,
  OmpTurnResult,
} from "../src/omp-rpc-session.js";
import { OmpRpcFaultError } from "../src/omp-rpc-session.js";
import type { OmpNativeModel } from "../src/omp-model-catalog.js";
import { CodexTurnProjector, projectHistoricalTurn } from "@codexhost/protocol-core";

class FakeOmpTransport implements OmpTurnTransport {
  readonly subagentSubscription: "events" | "unsupported";
  state: OmpSessionState = {
    sessionId: "omp-parent",
    sessionFile: "/synthetic/omp-parent.jsonl",
    provider: "synthetic",
    modelId: "model",
    thinkingLevel: harnessThinkingOptionIdSchema.parse("high"),
    contextUsage: null,
    availableThinkingLevels: [harnessThinkingOptionIdSchema.parse("high")],
  };
  readonly stderrTail = "";
  history: OmpSessionHistory = { entries: [], leafId: null };
  onEvent: ((event: OmpTurnEvent) => void) | null = null;
  onSubagentEvent: ((event: OmpTurnEvent) => void) | null = null;
  readonly respondToInteraction = vi.fn(async (response: OmpInteractionResponse) => {
    this.onEvent?.({
      type: "interaction.closed",
      requestId: response.requestId,
      reason: "cancelled" in response ? "cancelled" : "responded",
    });
  });
  autoCompleteTurn = true;
  #resolveTurn: ((result: OmpTurnResult) => void) | null = null;

  constructor(subagentSubscription: "events" | "unsupported" = "events") {
    this.subagentSubscription = subagentSubscription;
  }

  async start(): Promise<void> {}

  async getAvailableModels(): Promise<OmpNativeModel[]> {
    return [{ provider: "synthetic", id: "model", reasoning: true }];
  }

  async getAvailableThinkingLevels(): Promise<HarnessThinkingOptionId[]> {
    return [harnessThinkingOptionIdSchema.parse("high")];
  }

  async getEntries(): Promise<OmpSessionHistory> {
    return structuredClone(this.history);
  }

  async getSubagentMessages(): Promise<OmpSubagentMessagesResult> {
    return {
      sessionFile: "/synthetic/subagent.jsonl",
      fromByte: 0,
      nextByte: 256,
      reset: false,
      entries: [
        {
          id: "subagent-user-1",
          parentId: null,
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Inspect the repository" }],
          },
        },
        {
          id: "subagent-assistant-1",
          parentId: "subagent-user-1",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I inspected it." }],
            stopReason: "stop",
          },
        },
      ],
      messages: [],
    };
  }

  async getSessionUsage(): Promise<HostUsage | null> {
    return null;
  }

  async fork(entryId: string): Promise<OmpSessionState> {
    void entryId;
    return this.state;
  }

  async verifySessionCwd(): Promise<void> {}

  async selectModel(): Promise<OmpSessionState> {
    return this.state;
  }

  async selectThinkingOption(): Promise<OmpSessionState> {
    return this.state;
  }

  async compact(): Promise<OmpCompactResult> {
    return { outcome: "succeeded" };
  }

  event(event: OmpTurnEvent): void {
    this.onEvent?.(event);
  }

  succeed(text: string): void {
    const ordinal =
      this.history.entries.filter(
        (entry) =>
          entry.type === "message" && (entry.message as { role?: unknown }).role === "user",
      ).length + 1;
    const userId = `user-${ordinal}`;
    const assistantId = `assistant-${ordinal}`;
    this.history = {
      entries: [
        ...this.history.entries,
        {
          id: userId,
          parentId: this.history.leafId,
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "edit" }] },
        },
        {
          id: assistantId,
          parentId: userId,
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
            stopReason: "stop",
          },
        },
      ],
      leafId: assistantId,
    };
    this.#resolveTurn?.({ text, cancelled: false });
  }

  runTurn(_text: string, onEvent: (event: OmpTurnEvent) => void): Promise<OmpTurnResult> {
    this.onEvent = onEvent;
    return new Promise((resolve) => {
      this.#resolveTurn = resolve;
      if (!this.autoCompleteTurn) return;
      queueMicrotask(() => {
        onEvent({
          type: "subagent.started",
          callId: "tool-1",
          nativeSubagentId: "subagent-1",
          description: "Inspect the repository",
          role: "task",
          background: false,
        });
        onEvent({
          type: "subagent.updated",
          callId: "tool-1",
          nativeSubagentId: "subagent-1",
          status: "running",
        });
        onEvent({
          type: "subagent.completed",
          callId: "tool-1",
          nativeSubagentId: "subagent-1",
          isError: false,
          resultSummary: "done",
        });
        this.succeed("done");
      });
    });
  }

  async abort(): Promise<void> {
    this.#resolveTurn?.({ text: "", cancelled: true });
  }

  async close(): Promise<void> {}
}

class RestartableOmpTransport extends FakeOmpTransport {
  closed = false;
  startError: Error | null = null;

  override async start(): Promise<void> {
    if (this.startError) throw this.startError;
  }

  override async close(): Promise<void> {
    this.closed = true;
  }
}

function historyTurn(input: {
  assistantId: string;
  parentId: string | null;
  text: string;
  userId: string;
}): OmpSessionHistory["entries"] {
  return [
    {
      id: input.userId,
      parentId: input.parentId,
      type: "message",
      message: { role: "user", content: [{ type: "text", text: input.text }] },
    },
    {
      id: input.assistantId,
      parentId: input.userId,
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${input.text} response` }],
        stopReason: "stop",
      },
    },
  ];
}

describe("OMP Adapter conformance", () => {
  it("records a controlled native-transport receipt across create, cancellation, and resume", async () => {
    const transportOptions: OmpRpcSessionOptions[] = [];
    const closes: Array<() => boolean> = [];
    let primaryTransport: FakeOmpTransport | undefined;
    let adapterNumber = 0;

    const createAdapter = (): OmpAdapter => {
      adapterNumber += 1;
      return new OmpAdapter(
        {},
        {
          createTransport: (options) => {
            const scope = options.environment?.CODEXHOST_CONFORMANCE_SCOPE;
            const transport = new FakeOmpTransport("events");
            const sessionId =
              scope === "primary" || scope === "resume"
                ? "omp-conformance-primary"
                : scope === "isolated"
                  ? "omp-conformance-isolated"
                  : `omp-conformance-inspection-${adapterNumber}`;
            transport.state = {
              ...transport.state,
              sessionId,
              sessionFile: `/synthetic/${sessionId}.jsonl`,
            };
            if (scope === "resume" && primaryTransport) {
              transport.history = structuredClone(primaryTransport.history);
            }
            const nativeRunTurn = transport.runTurn.bind(transport);
            transport.runTurn = (text, onEvent) => {
              transport.autoCompleteTurn = text !== "fixture cancellable";
              return nativeRunTurn(text, onEvent);
            };
            const nativeAbort = transport.abort.bind(transport);
            transport.abort = async () => {
              const ordinal =
                transport.history.entries.filter(
                  (entry) =>
                    entry.type === "message" &&
                    (entry.message as { role?: unknown }).role === "user",
                ).length + 1;
              const userId = `cancel-user-${ordinal}`;
              const assistantId = `cancel-assistant-${ordinal}`;
              transport.history = {
                entries: [
                  ...transport.history.entries,
                  {
                    id: userId,
                    parentId: transport.history.leafId,
                    type: "message",
                    message: {
                      role: "user",
                      content: [{ type: "text", text: "fixture cancellable" }],
                    },
                  },
                  {
                    id: assistantId,
                    parentId: userId,
                    type: "message",
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: "cancelled" }],
                      stopReason: "aborted",
                    },
                  },
                ],
                leafId: assistantId,
              };
              await nativeAbort();
            };
            if (scope === "primary") primaryTransport = transport;
            const close = vi.spyOn(transport, "close");
            closes.push(() => close.mock.calls.length > 0);
            transportOptions.push(options);
            return transport;
          },
        },
      );
    };

    const receipt = await runAdapterConformance({
      createAdapter,
      cwd: "/synthetic",
      evidence: {
        hostSha: null,
        pluginBundleSha256: null,
        nativeVersion: null,
        platform: process.platform,
        mode: "native-transport-fixture",
      },
      environment: {
        primary: { CODEXHOST_CONFORMANCE_SCOPE: "primary" },
        isolated: { CODEXHOST_CONFORMANCE_SCOPE: "isolated" },
        resume: { CODEXHOST_CONFORMANCE_SCOPE: "resume" },
      },
      prompts: {
        first: "fixture first",
        cancellable: "fixture cancellable",
        followup: "fixture followup",
      },
      probes: {
        assertEnvironmentIsolation: async () => {
          const scopes = transportOptions
            .map((options) => options.environment?.CODEXHOST_CONFORMANCE_SCOPE)
            .filter((scope): scope is string => scope !== undefined);
          expect(scopes).toEqual(expect.arrayContaining(["primary", "isolated"]));
        },
        readCleanup: async () => ({
          residue: closes.every((closed) => closed()) ? "none" : "present",
        }),
      },
    });

    expect(receipt).toMatchObject({
      status: "incomplete",
      harnessId: "omp",
      scenarios: {
        inspect: { status: "passed" },
        create: { status: "passed" },
        environmentIsolation: { status: "passed" },
        firstTurn: { status: "passed" },
        concurrentTurn: { status: "passed" },
        cancel: { status: "passed" },
        resume: { status: "passed" },
        followup: { status: "passed" },
        cleanup: { status: "passed" },
      },
      environment: { nativeActivation: "notRequested", nativeIsolationReadback: "passed" },
      cleanup: { residue: "none", nativeReadback: "passed" },
    });
  });
});

describe("OMP Adapter Session environment", () => {
  it("uses OMP's native yolo default without changing ordinary create semantics", async () => {
    const transport = new FakeOmpTransport();
    const createTransport = vi.fn(() => transport);
    const adapter = new OmpAdapter({}, { createTransport });
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await opened.value.execute({
      type: "turn.start",
      turnId: "permission-turn" as HostTurnId,
      input: [{ type: "text", text: "task" }],
    });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "yolo" }),
    );
    await adapter.close();
  });

  it("restarts an eagerly initialized OMP Session for a live Permission Mode selection", async () => {
    const transport = new RestartableOmpTransport();
    const createTransport = vi.fn(() => transport);
    const adapter = new OmpAdapter({}, { createTransport });
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      permissionModeId: harnessPermissionModeIdSchema.parse("always-ask"),
    });
    if (!opened.ok) throw new Error(opened.error.message);

    await expect(
      opened.value.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("write"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(createTransport).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ permissionMode: "always-ask" }),
    );
    expect(createTransport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ permissionMode: "write" }),
    );
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { state: { effectivePermissionModeId: "write" } },
    });
    await adapter.close();
  });

  it("advertises OMP Permission Modes and restarts a persisted Session to switch mode", async () => {
    const inspection = new RestartableOmpTransport();
    const initial = new RestartableOmpTransport();
    initial.state = {
      ...initial.state,
      sessionId: "omp-permission-session",
      sessionFile: "/synthetic/omp-permission-session.jsonl",
    };
    const replacement = new RestartableOmpTransport();
    replacement.state = { ...initial.state };
    const createTransport = vi
      .fn()
      .mockImplementationOnce(() => inspection)
      .mockImplementationOnce(() => initial)
      .mockImplementationOnce(() => replacement);
    const adapter = new OmpAdapter({}, { createTransport });

    await expect(adapter.inspect({ cwd: "/synthetic" })).resolves.toMatchObject({
      status: "ready",
      permissionModes: {
        defaultModeId: "yolo",
        modes: expect.arrayContaining([
          expect.objectContaining({ id: "always-ask" }),
          expect.objectContaining({ id: "write" }),
          expect.objectContaining({ id: "yolo", dangerous: true }),
        ]),
      },
      capabilities: { configuration: { selectPermissionMode: true } },
    });
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      permissionModeId: harnessPermissionModeIdSchema.parse("write"),
    });
    if (!opened.ok) throw new Error(opened.error.message);
    await opened.value.readSnapshot();
    await expect(
      opened.value.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("yolo"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(initial.closed).toBe(true);
    expect(createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionFile: "/synthetic/omp-permission-session.jsonl",
        permissionMode: "yolo",
      }),
    );
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { state: { effectivePermissionModeId: "yolo" } },
    });
    await adapter.close();
  });

  it("recovers the previous OMP Permission Mode when restart fails", async () => {
    const initial = new RestartableOmpTransport();
    initial.state = {
      ...initial.state,
      sessionId: "omp-permission-recovery",
      sessionFile: "/synthetic/omp-permission-recovery.jsonl",
    };
    const failedReplacement = new RestartableOmpTransport();
    failedReplacement.state = { ...initial.state };
    failedReplacement.startError = new Error("synthetic permission restart failure");
    const recovery = new RestartableOmpTransport();
    recovery.state = { ...initial.state };
    const createTransport = vi
      .fn()
      .mockImplementationOnce(() => initial)
      .mockImplementationOnce(() => failedReplacement)
      .mockImplementationOnce(() => recovery);
    const adapter = new OmpAdapter({}, { createTransport });
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      permissionModeId: harnessPermissionModeIdSchema.parse("write"),
    });
    if (!opened.ok) throw new Error(opened.error.message);
    await opened.value.readSnapshot();
    await expect(
      opened.value.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("yolo"),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "nativeFailure", message: "synthetic permission restart failure" },
    });
    expect(createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({ permissionMode: "write" }),
    );
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { state: { effectivePermissionModeId: "write" } },
    });
    await adapter.close();
  });

  it("passes per-Session delegation environment to the native transport", async () => {
    const transport = new FakeOmpTransport();
    const createTransport = vi.fn(() => transport);
    const adapter = new OmpAdapter({}, { createTransport });
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      environment: {
        CODEXHOST_CLI_PATH: "/opt/codexhost",
        CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
        CODEXHOST_RUNTIME_TOKEN: "token",
        CODEXHOST_THREAD_ID: "thread-1",
      },
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await opened.value.execute({
      type: "turn.start",
      turnId: "environment-turn" as HostTurnId,
      input: [{ type: "text", text: "task" }],
    });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({
          CODEXHOST_CLI_PATH: "/opt/codexhost",
          CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
          CODEXHOST_RUNTIME_TOKEN: "token",
          CODEXHOST_THREAD_ID: "thread-1",
        }),
      }),
    );
    await adapter.close();
  });

  it("passes per-Thread environment to the first native resume transport", async () => {
    const transport = new FakeOmpTransport();
    transport.state = {
      ...transport.state,
      sessionId: "omp-resume",
      sessionFile: "/synthetic/omp-resume.jsonl",
    };
    const createTransport = vi.fn(() => transport);
    const adapter = new OmpAdapter({}, { createTransport });
    const nativeRef = nativeSessionRefSchema.parse({
      harnessId: "omp",
      nativeSessionId: "omp-resume",
      locator: { sessionFile: "/synthetic/omp-resume.jsonl" },
      formatVersion: 1,
    });

    const opened = await adapter.open({
      kind: "resume",
      cwd: "/synthetic",
      nativeRef,
      environment: { CODEXHOST_THREAD_ID: "resume-thread" },
      executionPolicy: "unattended-full-access",
    });

    expect(opened).toMatchObject({ ok: true });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: { CODEXHOST_THREAD_ID: "resume-thread" },
        permissionMode: "yolo",
      }),
    );
    await adapter.close();
  });
});

describe("OMP Adapter inspection", () => {
  it("reports a missing executable as not installed", async () => {
    const transport = new FakeOmpTransport();
    vi.spyOn(transport, "start").mockRejectedValueOnce(
      Object.assign(new Error("spawn omp ENOENT"), { code: "ENOENT" }),
    );
    const close = vi.spyOn(transport, "close");
    const adapter = new OmpAdapter({}, { createTransport: () => transport });

    await expect(adapter.inspect({ cwd: "/synthetic" })).resolves.toMatchObject({
      status: "notInstalled",
      error: { code: "notInstalled", retryable: false, stage: "startup" },
    });
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("OMP create capability readback", () => {
  it("derives subagent observation from the create Session's native subscription without inspection", async () => {
    const createTransport = vi.fn(() => new FakeOmpTransport("events"));
    const adapter = new OmpAdapter({}, { createTransport });

    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });

    expect(opened).toMatchObject({
      ok: true,
      value: {
        capabilities: {
          subagents: { observe: true, readTranscript: true },
          autonomousTurns: { observe: true },
        },
      },
    });
    expect(createTransport).toHaveBeenCalledTimes(1);
    await adapter.close();
  });

  it("does not inherit a successful inspection subscription when create reports unsupported", async () => {
    const inspection = new FakeOmpTransport("events");
    const create = new FakeOmpTransport("unsupported");
    const createTransport = vi
      .fn()
      .mockImplementationOnce(() => inspection)
      .mockImplementationOnce(() => create);
    const adapter = new OmpAdapter({}, { createTransport });

    await expect(adapter.inspect({ cwd: "/synthetic" })).resolves.toMatchObject({
      status: "ready",
      capabilities: { subagents: { observe: true, readTranscript: true } },
    });
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });

    expect(opened).toMatchObject({
      ok: true,
      value: { capabilities: { subagents: { observe: false, readTranscript: true } } },
    });
    if (opened.ok) expect(opened.value.capabilities.autonomousTurns).toBeUndefined();
    await adapter.close();
  });

  it("keeps Adapter close pending over an eager create startup and never publishes that Session", async () => {
    const transport = new RestartableOmpTransport();
    let releaseStart!: () => void;
    let markStart!: () => void;
    const startEntered = new Promise<void>((resolve) => {
      markStart = resolve;
    });
    transport.start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseStart = resolve;
          markStart();
        }),
    );
    const close = vi.spyOn(transport, "close");
    const adapter = new OmpAdapter({}, { createTransport: () => transport });

    const opening = adapter.open({ kind: "create", cwd: "/synthetic" });
    await startEntered;
    let closeCompleted = false;
    const closing = adapter.close().then(() => {
      closeCompleted = true;
    });

    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
    expect(closeCompleted).toBe(false);

    releaseStart();
    await expect(closing).resolves.toBeUndefined();
    await expect(opening).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    expect(close).toHaveBeenCalledOnce();
    await expect(adapter.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("OMP Adapter Fork", () => {
  it("forks the requested completed prefix from the next OMP User Entry", async () => {
    const firstTurn = historyTurn({
      userId: "source-user-1",
      assistantId: "source-assistant-1",
      parentId: null,
      text: "first",
    });
    const secondTurn = historyTurn({
      userId: "source-user-2",
      assistantId: "source-assistant-2",
      parentId: "source-assistant-1",
      text: "second",
    });
    const transport = new FakeOmpTransport();
    transport.state = {
      ...transport.state,
      sessionId: "fork-startup",
      sessionFile: "/synthetic/fork-startup.jsonl",
    };
    transport.history = {
      entries: [...firstTurn, ...secondTurn],
      leafId: "source-assistant-2",
    };
    const fork = vi.fn(async (entryId: string) => {
      expect(entryId).toBe("source-user-2");
      transport.state = {
        ...transport.state,
        sessionId: "fork-derived",
        sessionFile: "/synthetic/fork-derived.jsonl",
      };
      transport.history = { entries: firstTurn, leafId: "source-assistant-1" };
      return transport.state;
    });
    transport.fork = fork;
    const verifySessionCwd = vi.fn(async () => undefined);
    transport.verifySessionCwd = verifySessionCwd;
    const createTransport = vi.fn(() => transport);
    const adapter = new OmpAdapter({}, { createTransport });
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "omp",
      nativeSessionId: "source-session",
      locator: { sessionFile: "/synthetic/source-session.jsonl" },
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: "omp",
      nativeSessionId: "source-session",
      checkpointId: "source-user-1",
      formatVersion: 1,
    });

    const opened = await adapter.open({
      kind: "fork",
      cwd: "/synthetic",
      sourceRef,
      checkpoint,
    });

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ forkSessionFile: "/synthetic/source-session.jsonl" }),
    );
    expect(fork).toHaveBeenCalledTimes(1);
    expect(verifySessionCwd).toHaveBeenCalledWith("/synthetic");
    expect(opened.value.initialState.nativeRef).toMatchObject({
      nativeSessionId: "fork-derived",
      locator: { sessionFile: "/synthetic/fork-derived.jsonl" },
    });
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            nativeTurnRef: { nativeSessionId: "fork-derived", nativeTurnKey: "source-user-1" },
            checkpoint: { nativeSessionId: "fork-derived", checkpointId: "source-user-1" },
          },
        ],
      },
    });
    await opened.value.close();
    await adapter.close();
  });
});

function outputs(session: { outputs: AsyncIterable<HarnessOutput> }): HarnessOutput[] {
  const values: HarnessOutput[] = [];
  void (async () => {
    for await (const output of session.outputs) values.push(output);
  })();
  return values;
}

async function nextOutput(iterator: AsyncIterator<HarnessOutput>): Promise<HarnessOutput> {
  const result = await iterator.next();
  if (result.done) throw new Error("Harness output stream ended unexpectedly");
  return result.value;
}

async function nextEvent(iterator: AsyncIterator<HarnessOutput>) {
  const output = await nextOutput(iterator);
  if (output.kind !== "event") throw new Error("Expected a Harness event output");
  return output.event;
}

describe("OMP Adapter Subagents", () => {
  it("projects native Subagent lifecycle into a Host delegation Item", async () => {
    const transport = new FakeOmpTransport();
    const dependencies: OmpAdapterDependencies = {
      createTransport: (options: OmpRpcSessionOptions) => {
        transport.onSubagentEvent = options.onSubagentEvent ?? null;
        return transport;
      },
    };
    const adapter = new OmpAdapter({}, dependencies);
    await expect(adapter.inspect({ cwd: "/synthetic" })).resolves.toMatchObject({
      status: "ready",
      capabilities: { subagents: { observe: true, readTranscript: true } },
    });
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.capabilities.subagents).toEqual({ observe: true, readTranscript: true });
    const observed = outputs(opened.value);
    const accepted = await opened.value.execute({
      type: "turn.start",
      turnId: "turn-1" as HostTurnId,
      input: [{ type: "text", text: "delegate" }],
    });
    expect(accepted).toEqual({ ok: true, value: { turnId: "turn-1" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event);
    const started = events.find(
      (event) => event.type === "item.started" && event.item.type === "subagentDelegation",
    );
    expect(started).toMatchObject({
      item: {
        type: "subagentDelegation",
        operation: "spawn",
        subagents: [{ nativeSubagentId: "subagent-1", status: "running" }],
      },
    });
    const completed = events.find(
      (event) =>
        event.type === "item.completed" && event.snapshot.item.type === "subagentDelegation",
    );
    expect(completed).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: {
          type: "subagentDelegation",
          subagents: [{ nativeSubagentId: "subagent-1", status: "completed" }],
        },
      },
    });
    expect(
      events
        .filter((event) => event.type === "subagent.state.changed")
        .map((event) => event.status),
    ).toEqual(["running", "running", "completed"]);
    transport.onSubagentEvent?.({
      type: "subagent.transcript.changed",
      callId: "tool-1",
      nativeSubagentId: "subagent-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const laterEvents = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event);
    expect(laterEvents).toContainEqual({
      type: "subagent.transcript.changed",
      nativeSubagentId: "subagent-1",
    });
    await opened.value.close();
    await adapter.close();
  });

  it("exposes only OMP compact as a Harness command", async () => {
    const transport = new FakeOmpTransport();
    const dependencies: OmpAdapterDependencies = {
      createTransport: () => transport,
    };
    const adapter = new OmpAdapter({}, dependencies);
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const commands = opened.value.commands;
    if (!commands) throw new Error("OMP Session did not expose commands");
    await expect(commands.list()).resolves.toEqual({
      ok: true,
      value: {
        commands: [
          {
            id: "omp.compact",
            invocation: "/compact",
            label: "Compact context",
            description: "Compact the current conversation context",
            argumentMode: "text",
          },
        ],
      },
    });
    await opened.value.close();
    await adapter.close();
  });

  it("reads a stable OMP Subagent transcript as a Child Host Thread", async () => {
    const transport = new FakeOmpTransport();
    const dependencies: OmpAdapterDependencies = {
      createTransport: () => transport,
    };
    const adapter = new OmpAdapter({}, dependencies);
    const parent = nativeSessionRefSchema.parse({
      harnessId: "omp",
      nativeSessionId: "omp-parent",
      locator: { sessionFile: "/synthetic/omp-parent.jsonl" },
      formatVersion: 1,
    });
    const result = await adapter.subagents.readSnapshot({
      parent,
      nativeSubagentId: "subagent-1",
      cwd: "/synthetic",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.turns).toHaveLength(1);
      expect(result.value.turns[0]?.input).toEqual([
        { type: "text", text: "Inspect the repository" },
      ]);
      expect(result.value.turns[0]?.items).toContainEqual({
        item: expect.objectContaining({ type: "agentMessage", text: "I inspected it." }),
        outcome: { status: "succeeded" },
      });
    }
    await adapter.close();
  });

  it("cold reads the child when a later parent record crosses the UTF-8 header bound", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-omp-child-"));
    try {
      const parentFile = path.join(root, "parent.jsonl");
      const childDirectory = path.join(root, "parent");
      const header = `${JSON.stringify({ type: "session", id: "parent", cwd: root })}\n`;
      await writeFile(
        parentFile,
        `${header}${"x".repeat(64 * 1024 - Buffer.byteLength(header) - 1)}😀\n`,
      );
      await mkdir(childDirectory);
      await writeFile(
        path.join(childDirectory, "scout.jsonl"),
        [
          { type: "session", id: "native-child", cwd: root },
          {
            type: "message",
            id: "user",
            parentId: null,
            message: { role: "user", content: [{ type: "text", text: "Inspect" }] },
          },
          {
            type: "message",
            id: "answer",
            parentId: "user",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Done" }],
              stopReason: "stop",
            },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      const createTransport = vi.fn();
      const adapter = new OmpAdapter({}, { createTransport: createTransport as never });
      const parent = nativeSessionRefSchema.parse({
        harnessId: "omp",
        nativeSessionId: "parent",
        locator: { sessionFile: parentFile },
        formatVersion: 1,
      });
      const result = await adapter.subagents.readSnapshot({
        parent,
        nativeSubagentId: "scout",
        cwd: root,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.turns).toHaveLength(1);
        expect(result.value.turns[0]?.input).toEqual([{ type: "text", text: "Inspect" }]);
      }
      expect(createTransport).not.toHaveBeenCalled();
      await adapter.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a child transcript symlink escape and an oversized transcript", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-omp-child-"));
    try {
      const parentFile = path.join(root, "parent.jsonl");
      const childDirectory = path.join(root, "parent");
      await writeFile(
        parentFile,
        `${JSON.stringify({ type: "session", id: "parent", cwd: root })}\n`,
      );
      await mkdir(childDirectory);
      const outside = path.join(root, "outside.jsonl");
      await writeFile(outside, "{}\n");
      await symlink(outside, path.join(childDirectory, "escape.jsonl"));
      await writeFile(path.join(childDirectory, "huge.jsonl"), Buffer.alloc(8 * 1024 * 1024 + 1));
      const createTransport = vi.fn();
      const adapter = new OmpAdapter({}, { createTransport: createTransport as never });
      const parent = nativeSessionRefSchema.parse({
        harnessId: "omp",
        nativeSessionId: "parent",
        locator: { sessionFile: parentFile },
        formatVersion: 1,
      });
      for (const [id, expected] of [
        ["escape", /symlink|symbolic|outside|ELOOP/i],
        ["huge", /exceeds the supported size/],
      ] as const) {
        const result = await adapter.subagents.readSnapshot({
          parent,
          nativeSubagentId: id,
          cwd: root,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toMatch(expected);
      }
      expect(createTransport).not.toHaveBeenCalled();
      await adapter.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses cold RPC only when the managed child file is absent, without inventing a child", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-omp-child-"));
    try {
      const parentFile = path.join(root, "parent.jsonl");
      await writeFile(
        parentFile,
        `${JSON.stringify({ type: "session", id: "parent", cwd: root })}\n`,
      );
      const transport = new FakeOmpTransport();
      const getSubagentMessages = vi
        .spyOn(transport, "getSubagentMessages")
        .mockRejectedValue(new Error("Unknown subagent"));
      const createTransport = vi.fn(() => transport);
      const adapter = new OmpAdapter({}, { createTransport });
      const parent = nativeSessionRefSchema.parse({
        harnessId: "omp",
        nativeSessionId: "parent",
        locator: { sessionFile: parentFile },
        formatVersion: 1,
      });
      const result = await adapter.subagents.readSnapshot({
        parent,
        nativeSubagentId: "missing",
        cwd: root,
      });
      expect(result.ok).toBe(false);
      expect(createTransport).toHaveBeenCalledOnce();
      expect(getSubagentMessages).toHaveBeenCalledWith({ subagentId: "missing" });
      await adapter.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a mismatched parent identity and path traversal before RPC", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-omp-child-"));
    try {
      const parentFile = path.join(root, "parent.jsonl");
      await writeFile(
        parentFile,
        `${JSON.stringify({ type: "session", id: "other-parent", cwd: root })}\n`,
      );
      const createTransport = vi.fn();
      const adapter = new OmpAdapter({}, { createTransport: createTransport as never });
      const parent = nativeSessionRefSchema.parse({
        harnessId: "omp",
        nativeSessionId: "parent",
        locator: { sessionFile: parentFile },
        formatVersion: 1,
      });
      for (const id of ["scout", "../escape", "..\\escape"]) {
        const result = await adapter.subagents.readSnapshot({
          parent,
          nativeSubagentId: id,
          cwd: root,
        });
        expect(result.ok).toBe(false);
      }
      expect(createTransport).not.toHaveBeenCalled();
      await adapter.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("materializes a background Subagent that starts after the parent Turn is idle", async () => {
    const transport = new FakeOmpTransport();
    const dependencies: OmpAdapterDependencies = {
      createTransport: (options: OmpRpcSessionOptions) => {
        transport.onSubagentEvent = options.onSubagentEvent ?? null;
        return transport;
      },
    };
    const adapter = new OmpAdapter({}, dependencies);
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const observed = outputs(opened.value);
    await opened.value.execute({
      type: "turn.start",
      turnId: "turn-parent" as HostTurnId,
      input: [{ type: "text", text: "start background work" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    transport.onSubagentEvent?.({
      type: "subagent.started",
      callId: "background-tool",
      nativeSubagentId: "background-subagent",
      description: "Continue the long task",
      role: "task",
      background: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const startedEvents = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event);
    const autonomous = startedEvents.find((event) => event.type === "turn.autonomous.started");
    expect(autonomous).toMatchObject({ type: "turn.autonomous.started" });
    expect(startedEvents).toContainEqual(
      expect.objectContaining({
        type: "item.started",
        item: expect.objectContaining({
          type: "subagentDelegation",
          subagents: [
            expect.objectContaining({
              nativeSubagentId: "background-subagent",
              status: "running",
              background: true,
            }),
          ],
        }),
      }),
    );

    transport.onSubagentEvent?.({
      type: "subagent.completed",
      callId: "background-tool",
      nativeSubagentId: "background-subagent",
      isError: false,
      resultSummary: "finished in background",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const completedEvents = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event);
    expect(completedEvents).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        snapshot: expect.objectContaining({
          item: expect.objectContaining({
            type: "subagentDelegation",
            subagents: [expect.objectContaining({ status: "completed" })],
          }),
        }),
      }),
    );
    expect(completedEvents.some((event) => event.type === "turn.completed")).toBe(true);
    await opened.value.close();
    await adapter.close();
  });

  it("keeps an autonomous Turn open until all background Subagents settle", async () => {
    const transport = new FakeOmpTransport();
    const dependencies: OmpAdapterDependencies = {
      createTransport: (options: OmpRpcSessionOptions) => {
        transport.onSubagentEvent = options.onSubagentEvent ?? null;
        return transport;
      },
    };
    const adapter = new OmpAdapter({}, dependencies);
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const observed = outputs(opened.value);
    await opened.value.execute({
      type: "turn.start",
      turnId: "turn-background-parent" as HostTurnId,
      input: [{ type: "text", text: "prime background subscription" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    transport.onSubagentEvent?.({
      type: "subagent.started",
      callId: "background-tool-1",
      nativeSubagentId: "background-subagent-1",
      description: "First background task",
      background: true,
    });
    transport.onSubagentEvent?.({
      type: "subagent.started",
      callId: "background-tool-2",
      nativeSubagentId: "background-subagent-2",
      description: "Second background task",
      background: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    transport.onSubagentEvent?.({
      type: "subagent.completed",
      callId: "background-tool-1",
      nativeSubagentId: "background-subagent-1",
      isError: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const afterFirst = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event);
    const autonomousTurnIds = afterFirst
      .filter(
        (event): event is Extract<typeof event, { type: "turn.autonomous.started" }> =>
          event.type === "turn.autonomous.started",
      )
      .map((event) => event.turnId);
    expect(
      afterFirst.filter(
        (event) => event.type === "turn.completed" && autonomousTurnIds.includes(event.turnId),
      ),
    ).toHaveLength(0);
    transport.onSubagentEvent?.({
      type: "subagent.completed",
      callId: "background-tool-2",
      nativeSubagentId: "background-subagent-2",
      isError: true,
      resultSummary: "failed",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const completed = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event)
      .filter(
        (event) => event.type === "turn.completed" && autonomousTurnIds.includes(event.turnId),
      );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ outcome: { status: "failed" } });
    await opened.value.close();
    await adapter.close();
  });

  it("projects OMP tool approval requests and returns the selected native option", async () => {
    const transport = new FakeOmpTransport();
    transport.autoCompleteTurn = false;
    const adapter = new OmpAdapter({}, { createTransport: () => transport });
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const iterator = opened.value.outputs[Symbol.asyncIterator]();
    await opened.value.execute({
      type: "turn.start",
      turnId: "turn-approval" as HostTurnId,
      input: [{ type: "text", text: "write" }],
    });
    const started = await nextEvent(iterator);
    if (started.type === "session.state.changed") await nextEvent(iterator);
    await nextEvent(iterator);

    transport.event({
      type: "interaction.requested",
      request: {
        requestId: "approval-1",
        method: "select",
        title: "Approve write?",
        options: ["Approve", "Deny"],
      },
    });
    const output = await nextOutput(iterator);
    expect(output.kind).toBe("interaction");
    if (output.kind !== "interaction") return;
    expect(output.interaction).toMatchObject({
      type: "approval",
      title: "Approve write?",
      actions: [
        { id: "allow-once", label: "Approve", effect: "allowOnce" },
        { id: "deny", label: "Deny", effect: "deny" },
      ],
    });
    await expect(
      opened.value.execute({
        type: "interaction.respond",
        interactionId: output.interaction.interactionId,
        response: { type: "approval", actionId: "allow-once" },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(transport.respondToInteraction).toHaveBeenCalledWith({
      requestId: "approval-1",
      value: "Approve",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      interactionId: output.interaction.interactionId,
      reason: "responded",
    });

    transport.succeed("changed");
    await opened.value.close();
    await adapter.close();
  });

  it("keeps a persisted OMP tool result paired with its native file change through replay", async () => {
    const transport = new FakeOmpTransport();
    const nativePath = "a\\b.txt";
    transport.history = {
      entries: [
        {
          id: "user-1",
          parentId: null,
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "edit file" }] },
        },
        {
          id: "assistant-1",
          parentId: "user-1",
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "edit-1",
                name: "edit",
                arguments: { input: `[${nativePath}#abc]\\nPUT >1:\\n+after\\n` },
              },
            ],
          },
        },
        {
          id: "result-1",
          parentId: "assistant-1",
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "edit-1",
            toolName: "edit",
            isError: false,
            content: [{ type: "text", text: "edited" }],
            details: {
              diff: createTwoFilesPatch(
                `a/${nativePath}`,
                `b/${nativePath}`,
                "before\n",
                "after\n",
              ),
            },
          },
        },
        {
          id: "assistant-2",
          parentId: "result-1",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
            stopReason: "stop",
          },
        },
      ],
      leafId: "assistant-2",
    };
    const adapter = new OmpAdapter({}, { createTransport: () => transport });
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!opened.ok) throw new Error(opened.error.message);
    const read = await opened.value.readSnapshot();
    if (!read.ok) throw new Error(read.error.message);
    const turn = read.value.turns[0];
    expect(turn).toBeDefined();
    if (!turn) return;
    const tool = turn.items.find(({ item }) => item.type === "commandExecution")?.item;
    const file = turn.items.find(({ item }) => item.type === "fileChange")?.item;
    expect(file).toMatchObject({
      type: "fileChange",
      sourceItemIds: [tool?.itemId],
      changes: [{ path: path.sep === "/" ? nativePath : "a/b.txt", kind: "update" }],
    });
    const projected = projectHistoricalTurn({
      turnId: hostTurnIdSchema.parse("replayed-omp-edit"),
      cwd: "/synthetic",
      snapshot: turn,
    });
    const fileCards = (projected.items as { type: string }[]).filter(
      (item) => item.type === "fileChange",
    );
    expect(fileCards).toHaveLength(1);
    expect(fileCards[0]).toMatchObject({
      changes: [{ path: path.sep === "/" ? nativePath : "a/b.txt" }],
    });
    await opened.value.close();
    await adapter.close();
  });

  it("projects a native Edit File Change from numbered details.diff without faulting the Session", async () => {
    const transport = new FakeOmpTransport();
    transport.autoCompleteTurn = false;
    const adapter = new OmpAdapter({}, { createTransport: () => transport });
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const iterator = opened.value.outputs[Symbol.asyncIterator]();
    const accepted = await opened.value.execute({
      type: "turn.start",
      turnId: "turn-edit" as HostTurnId,
      input: [{ type: "text", text: "edit" }],
    });
    expect(accepted).toEqual({ ok: true, value: { turnId: "turn-edit" } });
    const started = await nextEvent(iterator);
    if (started.type === "session.state.changed") {
      expect(await nextEvent(iterator)).toMatchObject({ type: "turn.started" });
    } else {
      expect(started).toMatchObject({ type: "turn.started" });
    }
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "agentMessage" },
    });

    transport.event({
      type: "tool.started",
      callId: "edit-1",
      toolName: "edit",
      arguments: {
        i: "Adding tiny test marker",
        input: "[docs/archive/README.md#6F1B]\nPUT >3:\n+\n+test-marker\n",
      },
    });
    const startedTool = await nextEvent(iterator);
    expect(startedTool).toMatchObject({
      type: "item.started",
      item: { type: "commandExecution", command: expect.stringContaining("edit") },
    });
    if (startedTool.type !== "item.started") throw new Error("Expected OMP tool Item");

    transport.event({
      type: "tool.completed",
      callId: "edit-1",
      toolName: "edit",
      result: {
        content: [{ type: "text", text: "edited" }],
        details: {
          diff: " 1|# Archive\n 2|\n 3|Current documents.\n+4|\n+5|test-marker",
          path: "docs/archive/README.md",
          oldText: "# Archive\n\nCurrent documents.\n",
          newText: "# Archive\n\nCurrent documents.\n\ntest-marker\n",
        },
      },
      isError: false,
    });
    const completedTool = await nextEvent(iterator);
    expect(completedTool).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "commandExecution", command: expect.stringContaining("edit") },
        outcome: { status: "succeeded" },
      },
    });
    const startedFile = await nextEvent(iterator);
    expect(startedFile).toMatchObject({
      type: "item.started",
      item: {
        type: "fileChange",
        sourceItemIds: [startedTool.item.itemId],
        changes: [
          {
            path: "docs/archive/README.md",
            kind: "update",
            unifiedDiff: expect.stringContaining("test-marker"),
          },
        ],
      },
    });
    const completedFile = await nextEvent(iterator);
    expect(completedFile).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "fileChange" }, outcome: { status: "succeeded" } },
    });
    if (
      completedTool.type !== "item.completed" ||
      startedFile.type !== "item.started" ||
      completedFile.type !== "item.completed"
    ) {
      throw new Error("Expected OMP tool and File Change events");
    }
    const turnId = hostTurnIdSchema.parse("turn-edit");
    const projector = new CodexTurnProjector({
      threadId: "omp-thread",
      turnId,
      cwd: "/synthetic",
      startedAtMs: 1,
    });
    projector.project({ type: "turn.started", turnId });
    for (const event of [startedTool, completedTool, startedFile, completedFile]) {
      projector.project(event);
    }
    const fileCards = (projector.pendingTurn()?.items as { type: string }[]).filter(
      (item) => item.type === "fileChange",
    );
    expect(fileCards).toHaveLength(1);
    expect(fileCards[0]).toMatchObject({ changes: [{ path: "docs/archive/README.md" }] });

    if (path.sep === "/") {
      const nativePath = "a\\b.txt";
      transport.event({
        type: "tool.started",
        callId: "edit-literal-backslash",
        toolName: "edit",
        arguments: { input: `[${nativePath}#abc]\\nPUT >1:\\n+after\\n` },
      });
      const literalTool = await nextEvent(iterator);
      expect(literalTool).toMatchObject({
        type: "item.started",
        item: { type: "commandExecution" },
      });
      if (literalTool.type !== "item.started")
        throw new Error("Expected OMP literal-backslash Edit");
      transport.event({
        type: "tool.completed",
        callId: "edit-literal-backslash",
        toolName: "edit",
        result: {
          content: [{ type: "text", text: "edited" }],
          details: {
            diff: createTwoFilesPatch(`a/${nativePath}`, `b/${nativePath}`, "before\n", "after\n"),
          },
        },
        isError: false,
      });
      const literalToolCompleted = await nextEvent(iterator);
      const literalFile = await nextEvent(iterator);
      const literalFileCompleted = await nextEvent(iterator);
      expect(literalFile).toMatchObject({
        type: "item.started",
        item: {
          type: "fileChange",
          sourceItemIds: [literalTool.item.itemId],
          changes: [{ path: nativePath, kind: "update" }],
        },
      });
      if (
        literalToolCompleted.type !== "item.completed" ||
        literalFile.type !== "item.started" ||
        literalFileCompleted.type !== "item.completed"
      ) {
        throw new Error("Expected OMP literal-backslash Edit events");
      }
      for (const event of [literalTool, literalToolCompleted, literalFile, literalFileCompleted]) {
        projector.project(event);
      }
      const projectedFiles = (projector.pendingTurn()?.items as { type: string }[]).filter(
        (item) => item.type === "fileChange",
      );
      expect(projectedFiles).toHaveLength(1);
      expect(projectedFiles[0]).toMatchObject({
        changes: [{ path: "docs/archive/README.md" }, { path: nativePath }],
      });
    }

    transport.succeed("changed");
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.completed" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await opened.value.close();
    await adapter.close();
  });

  it("releases the owned native transport after a Session fault", async () => {
    const transport = new FakeOmpTransport();
    const close = vi.spyOn(transport, "close");
    let onFault: OmpRpcSessionOptions["onFault"];
    const adapter = new OmpAdapter(
      {},
      {
        createTransport: (options) => {
          onFault = options.onFault;
          return transport;
        },
      },
    );
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!opened.ok) throw new Error(opened.error.message);
    await opened.value.readSnapshot();
    onFault?.(new OmpRpcFaultError("processExited", "synthetic process exit"));

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce(), { timeout: 100 });
    await adapter.close();
  });

  it("keeps a Session owned when native process cleanup rejects", async () => {
    const transport = new FakeOmpTransport();
    vi.spyOn(transport, "close").mockRejectedValue(new Error("owned group remains"));
    const adapter = new OmpAdapter({}, { createTransport: () => transport });
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!opened.ok) throw new Error(opened.error.message);

    await expect(opened.value.close()).rejects.toThrow("owned group remains");
    await expect(adapter.close()).rejects.toThrow("owned group remains");
  });
});
