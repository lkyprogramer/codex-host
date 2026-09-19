import { randomUUID } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  harnessIdSchema,
  hostTurnIdSchema,
  hostInteractionIdSchema,
  harnessPermissionModeIdSchema,
  harnessInspectionSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { CursorAdapter, CursorSession, cursorError } from "../src/adapter.js";
import { CursorTransport, type CursorCallbacks } from "../src/transport.js";
import { cursorModelRef, cursorCatalog, cursorNativeModel } from "../src/models.js";
import { CursorInteractions } from "../src/interactions.js";
import { cursorSnapshot } from "../src/projection.js";

const native = vi.hoisted(() => ({ turns: [] as Array<{ id: string; text: string }> }));
vi.mock("../src/native-history.js", () => ({
  readCursorNativeTurns: () => structuredClone(native.turns),
}));
const info = {
  sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  configOptions: [
    {
      id: "model",
      name: "Model",
      type: "select" as const,
      currentValue: "model[effort=high]",
      options: [{ value: "model[effort=high]", name: "Model" }],
    },
  ],
};
const turnId = hostTurnIdSchema.parse("turn-one");
const start = {
  type: "turn.start" as const,
  turnId,
  input: [{ type: "text" as const, text: "hello" }],
};

class FakeTransport extends CursorTransport {
  override sessionId = info.sessionId;
  action: (
    text: string,
    callbacks: CursorCallbacks,
  ) => Promise<{ stopReason: "end_turn" | "cancelled" }> = async (text, callbacks) => {
    callbacks.update({
      sessionId: this.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
    });
    native.turns.push({ id: randomUUID(), text });
    return { stopReason: "end_turn" };
  };
  override async prompt(text: string, callbacks: CursorCallbacks) {
    return this.action(text, callbacks);
  }
  override async close() {}
  override async cancel() {}
  override async configure(configId: string, value: string) {
    return {
      configOptions: [
        {
          id: configId,
          name: configId,
          type: "select" as const,
          currentValue: value,
          options: [{ value, name: value }],
        },
      ],
    };
  }
}
function session() {
  const transport = new FakeTransport({ cwd: process.cwd(), environment: {} });
  const session = new CursorSession(transport, info, () => {});
  const output: HarnessOutput[] = [];
  const done = (async () => {
    for await (const item of session.outputs) output.push(item);
  })();
  return { transport, session, output, done };
}
afterEach(() => {
  vi.restoreAllMocks();
  native.turns = [];
});

describe("Cursor native configuration", () => {
  it("does not misclassify an authenticate-stage network failure as missing credentials", () => {
    expect(cursorError(new Error("Cursor ACP authenticate: [aborted] socket hang up")).code).toBe(
      "protocolError",
    );
    expect(cursorError(new Error("Cursor ACP authenticate: Authentication required")).code).toBe(
      "authenticationRequired",
    );
  });
  it("preserves and redacts string details from native internal errors", () => {
    const error = Object.assign(new Error("Internal error"), {
      data: { details: "[aborted] socket hang up; access_token=fixture-secret" },
    });
    expect(cursorError(error).message).toBe("[aborted] socket hang up; access_token=[redacted]");
    expect(
      cursorError(
        Object.assign(new Error("Internal error"), {
          data: { details: { credentials: "must not serialize" } },
        }),
      ).message,
    ).toBe("Internal error");
  });
  it("preserves native ACP diagnostic messages instead of only Invalid params", () => {
    const error = Object.assign(new Error("Invalid params"), {
      data: { message: "No current ACP model found for config option: effort" },
    });
    expect(cursorError(error).message).toContain(
      "No current ACP model found for config option: effort",
    );
  });
  it("requires confirmed current state or an explicit model before exposing a Session", async () => {
    vi.spyOn(CursorTransport.prototype, "open").mockImplementation(async function (
      this: CursorTransport,
    ) {
      this.sessionId = info.sessionId;
      const modelOption = info.configOptions[0];
      if (!modelOption) throw new Error("Missing fixture model");
      return { ...info, configOptions: [{ ...modelOption, currentValue: "" }] };
    });
    const configure = vi
      .spyOn(CursorTransport.prototype, "configure")
      .mockResolvedValue({ configOptions: info.configOptions });
    vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
    const adapter = new CursorAdapter();
    try {
      expect(await adapter.open({ kind: "create", cwd: process.cwd() })).toMatchObject({
        ok: false,
      });
      const result = await adapter.open({
        kind: "create",
        cwd: process.cwd(),
        model: cursorModelRef("model[effort=high]"),
      });
      expect(result).toMatchObject({ ok: true });
      expect(configure).toHaveBeenCalledWith("model", "model[effort=high]");
      if (result.ok)
        expect(result.value.initialState.effectiveModel).toEqual(
          cursorModelRef("model[effort=high]"),
        );
    } finally {
      await adapter.close();
    }
  });
  it.each(["create", "resume"] as const)("maps unattended %s to native force", async (kind) => {
    const open = vi.spyOn(CursorTransport.prototype, "open").mockImplementation(async function (
      this: CursorTransport,
    ) {
      this.sessionId = info.sessionId;
      return info;
    });
    vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
    const adapter = new CursorAdapter();
    try {
      const result = await adapter.open({
        kind,
        cwd: process.cwd(),
        executionPolicy: "unattended-full-access",
        nativeRef: {
          harnessId: harnessIdSchema.parse("cursor-cli"),
          nativeSessionId: info.sessionId,
          formatVersion: 1,
        },
      });
      expect(result.ok).toBe(true);
      expect((open.mock.instances[0] as CursorTransport).options.force).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("keeps native approvals for default policy and rejects independent thinking", async () => {
    const open = vi.spyOn(CursorTransport.prototype, "open").mockImplementation(async function (
      this: CursorTransport,
    ) {
      this.sessionId = info.sessionId;
      return info;
    });
    vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
    const adapter = new CursorAdapter();
    try {
      expect(
        await adapter.open({ kind: "create", cwd: process.cwd(), executionPolicy: "default" }),
      ).toMatchObject({ ok: true });
      expect((open.mock.instances[0] as CursorTransport).options.force).not.toBe(true);
      expect(
        await adapter.open({
          kind: "create",
          cwd: process.cwd(),
          thinkingOptionId: harnessThinkingOptionIdSchema.parse("xhigh"),
        }),
      ).toMatchObject({ error: { code: "unsupported" } });
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      await adapter.close();
    }
  });

  it.each([
    ["create", "agent", true],
    ["resume", "agent", true],
    ["create", "plan", false],
    ["resume", "plan", false],
    ["create", "ask", false],
    ["resume", "ask", false],
  ] as const)("maps %s mode %s independently from native force (%s)", async (kind, mode, force) => {
    const open = vi.spyOn(CursorTransport.prototype, "open").mockImplementation(async function (
      this: CursorTransport,
    ) {
      this.sessionId = info.sessionId;
      return info;
    });
    vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
    const configure = vi.spyOn(CursorTransport.prototype, "configure").mockResolvedValue({
      configOptions: [
        {
          id: "mode",
          name: "Mode",
          type: "select",
          currentValue: mode,
          options: [{ value: mode, name: mode }],
        },
      ],
    });
    const adapter = new CursorAdapter();
    try {
      const result = await adapter.open({
        kind,
        nativeRef: {
          harnessId: harnessIdSchema.parse("cursor-cli"),
          nativeSessionId: info.sessionId,
          formatVersion: 1,
        },
        cwd: process.cwd(),
        executionPolicy: "unattended-full-access",
        permissionModeId: harnessPermissionModeIdSchema.parse(mode),
      });
      expect(result.ok).toBe(true);
      expect((open.mock.instances[0] as CursorTransport).options.force).toBe(force);
      expect(configure).toHaveBeenCalledWith("mode", mode);
    } finally {
      await adapter.close();
    }
  });

  it("starts inspection cache expiry at completion, including slow native startup", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0),
      gate = Promise.withResolvers<typeof info>();
    const open = vi.spyOn(CursorTransport.prototype, "open").mockImplementation(() => gate.promise);
    vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
    const adapter = new CursorAdapter();
    try {
      const first = adapter.inspect();
      clock.mockReturnValue(400_000);
      gate.resolve(info);
      await first;
      await adapter.inspect();
      expect(open).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(400_000 + 7 * 24 * 60 * 60_000 - 1);
      await adapter.inspect();
      expect(open).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(400_000 + 7 * 24 * 60 * 60_000 + 1);
      await adapter.inspect();
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      await adapter.close();
    }
  });
  it.each([false, true])(
    "does not mutate a previously returned snapshot after mode changes (history=%s)",
    async (history) => {
      const f = session();
      vi.spyOn(CursorTransport.prototype, "open").mockImplementation(async function (
        this: CursorTransport,
      ) {
        this.replay = native.turns.map((turn) => ({
          sessionId: info.sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: turn.text },
          },
        }));
        return info;
      });
      try {
        if (history) {
          await f.session.execute(start);
          await vi.waitFor(() =>
            expect(
              f.output.some((x) => x.kind === "event" && x.event.type === "turn.completed"),
            ).toBe(true),
          );
        }
        const snapshot = await f.session.readSnapshot();
        if (!snapshot.ok) throw Error(snapshot.error.message);
        await f.session.execute({
          type: "permissionMode.select",
          permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
        });
        expect(snapshot.value.state?.effectivePermissionModeId).toBe("agent");
      } finally {
        await f.session.close();
        await f.done;
      }
    },
  );
  it("preserves the complete parameterized native model behind an opaque Host ref", () => {
    const ref = cursorModelRef("model[effort=high]");
    expect(ref.id).toMatch(/^[A-Za-z0-9._~-]+$/u);
    expect(cursorNativeModel(info, ref.id)).toBe("model[effort=high]");
    expect(() => cursorNativeModel(info, "unknown")).toThrow();
    expect(cursorCatalog(info).thinkingOptions).toEqual([]);
  });
  it.each([
    ["not logged in", "unavailable"],
    ["Cursor CLI is not installed", "notInstalled"],
  ])(
    "caches failed inspection (%s) for five minutes and retries on explicit refresh",
    async (message, status) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(0);
      const open = vi
        .spyOn(CursorTransport.prototype, "open")
        .mockRejectedValue(new Error(message));
      vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
      const adapter = new CursorAdapter();
      try {
        const first = await adapter.inspect();
        expect(harnessInspectionSchema.safeParse(first).success).toBe(true);
        expect(first.status).toBe(status);
        clock.mockReturnValue(5 * 60_000 - 1);
        expect(await adapter.inspect()).toEqual(first);
        expect(open).toHaveBeenCalledTimes(1);
        await adapter.inspect({ refresh: true });
        expect(open).toHaveBeenCalledTimes(2);
        clock.mockReturnValue(5 * 60_000 - 1 + 5 * 60_000 + 1);
        await adapter.inspect();
        expect(open).toHaveBeenCalledTimes(3);
      } finally {
        await adapter.close();
      }
    },
  );
  it("reuses a ready model catalog across working directories", async () => {
    const open = vi.spyOn(CursorTransport.prototype, "open").mockImplementation(async function (
      this: CursorTransport,
    ) {
      this.sessionId = info.sessionId;
      return info;
    });
    vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
    const adapter = new CursorAdapter();
    try {
      expect(await adapter.inspect({ cwd: "/synthetic/cursor-a" })).toMatchObject({
        status: "ready",
      });
      expect(await adapter.inspect({ cwd: "/synthetic/cursor-b" })).toMatchObject({
        status: "ready",
      });
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      await adapter.close();
    }
  });
  it.each([
    ["not logged in", true],
    ["Cursor CLI is not installed", true],
    ["Cursor ACP session/new: Internal error", false],
  ])(
    "expires a ready catalog when opening a session fails with %s (expires=%s)",
    async (message, expires) => {
      const open = vi
        .spyOn(CursorTransport.prototype, "open")
        .mockImplementationOnce(async function (this: CursorTransport) {
          this.sessionId = info.sessionId;
          return info;
        })
        .mockRejectedValueOnce(new Error(message))
        .mockImplementation(async function (this: CursorTransport) {
          this.sessionId = info.sessionId;
          return info;
        });
      vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
      const adapter = new CursorAdapter();
      try {
        expect(await adapter.inspect()).toMatchObject({ status: "ready" });
        const result = await adapter.open({
          kind: "create",
          cwd: process.cwd(),
          executionPolicy: "default",
        });
        expect(result.ok).toBe(false);
        expect(open).toHaveBeenCalledTimes(2);
        await adapter.inspect();
        expect(open).toHaveBeenCalledTimes(expires ? 3 : 2);
      } finally {
        await adapter.close();
      }
    },
  );
  it("expires a ready catalog when the requested model is missing from the live catalog", async () => {
    const open = vi.spyOn(CursorTransport.prototype, "open").mockImplementation(async function (
      this: CursorTransport,
    ) {
      this.sessionId = info.sessionId;
      return info;
    });
    const configure = vi.spyOn(CursorTransport.prototype, "configure");
    vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
    const adapter = new CursorAdapter();
    try {
      expect(await adapter.inspect()).toMatchObject({ status: "ready" });
      const result = await adapter.open({
        kind: "create",
        cwd: process.cwd(),
        executionPolicy: "default",
        model: cursorModelRef("retired-model[effort=high]"),
      });
      expect(result.ok).toBe(false);
      expect(configure).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledTimes(2);
      await adapter.inspect();
      expect(open).toHaveBeenCalledTimes(3);
    } finally {
      await adapter.close();
    }
  });
  it("does not cache an empty model catalog", async () => {
    const open = vi
      .spyOn(CursorTransport.prototype, "open")
      .mockRejectedValueOnce(new Error("Cursor returned no parameterized models"))
      .mockRejectedValueOnce(new Error("Cursor returned no parameterized models"))
      .mockImplementation(async function (this: CursorTransport) {
        this.sessionId = info.sessionId;
        return info;
      });
    vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
    const adapter = new CursorAdapter();
    try {
      const first = await adapter.inspect({ cwd: "/synthetic/cursor-empty-catalog" });
      expect(first.status).toBe("unavailable");
      expect(first.status === "unavailable" && first.error.retryable).toBe(true);
      expect(open).toHaveBeenCalledTimes(2);
      const second = await adapter.inspect({ cwd: "/synthetic/cursor-other" });
      expect(second.status).toBe("ready");
      expect(open).toHaveBeenCalledTimes(3);
    } finally {
      await adapter.close();
    }
  });
  it("retries inspect once when session/new returns no model catalog", async () => {
    const empty = {
      sessionId: info.sessionId,
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select" as const,
          currentValue: "",
          options: [],
        },
      ],
    };
    const open = vi
      .spyOn(CursorTransport.prototype, "open")
      .mockImplementationOnce(async function (this: CursorTransport) {
        this.sessionId = empty.sessionId;
        return empty;
      })
      .mockImplementation(async function (this: CursorTransport) {
        this.sessionId = info.sessionId;
        return info;
      });
    vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
    const adapter = new CursorAdapter();
    try {
      expect(await adapter.inspect()).toMatchObject({ status: "ready" });
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      await adapter.close();
    }
  });
  it("does not pin inspect when probe cleanup fails", async () => {
    const open = vi
      .spyOn(CursorTransport.prototype, "open")
      .mockRejectedValueOnce(new Error("Cursor ACP request timed out"))
      .mockImplementation(async function (this: CursorTransport) {
        this.sessionId = info.sessionId;
        return info;
      });
    vi.spyOn(CursorTransport.prototype, "close").mockRejectedValue(
      new Error("owned group remains"),
    );
    const adapter = new CursorAdapter();
    try {
      const first = await adapter.inspect();
      expect(first.status).toBe("unavailable");
      expect(await adapter.inspect()).toMatchObject({ status: "ready" });
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      await adapter.close().catch(() => undefined);
    }
  });
  it("does not cache a catalog timeout across inspects", async () => {
    const open = vi
      .spyOn(CursorTransport.prototype, "open")
      .mockRejectedValueOnce(new Error("Cursor ACP request timed out"))
      .mockImplementation(async function (this: CursorTransport) {
        this.sessionId = info.sessionId;
        return info;
      });
    vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
    const adapter = new CursorAdapter();
    try {
      const first = await adapter.inspect({ cwd: "/synthetic/cursor-timeout" });
      expect(first.status).toBe("unavailable");
      expect(open).toHaveBeenCalledTimes(1);
      expect(await adapter.inspect({ cwd: "/synthetic/cursor-timeout-b" })).toMatchObject({
        status: "ready",
      });
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      await adapter.close();
    }
  });
  it("retries session open once after Cursor returns an empty catalog", async () => {
    const open = vi
      .spyOn(CursorTransport.prototype, "open")
      .mockRejectedValueOnce(new Error("Cursor returned no parameterized models"))
      .mockImplementation(async function (this: CursorTransport) {
        this.sessionId = info.sessionId;
        return info;
      });
    vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
    const adapter = new CursorAdapter();
    try {
      const result = await adapter.open({ kind: "create", cwd: process.cwd() });
      expect(result.ok).toBe(true);
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      await adapter.close();
    }
  });
  it("resumes history without fetching the model catalog", async () => {
    const open = vi.spyOn(CursorTransport.prototype, "open").mockImplementation(async function (
      this: CursorTransport,
      sessionId,
    ) {
      this.sessionId = sessionId ?? info.sessionId;
      return info;
    });
    vi.spyOn(CursorTransport.prototype, "historyOnly", "get").mockReturnValue(true);
    vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
    const adapter = new CursorAdapter();
    try {
      const result = await adapter.open({
        kind: "resume",
        historyOnly: true,
        cwd: process.cwd(),
        nativeRef: {
          harnessId: harnessIdSchema.parse("cursor-cli"),
          nativeSessionId: info.sessionId,
          formatVersion: 1,
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.value.executionReady).toBe(false);
      expect(open).toHaveBeenCalledWith(info.sessionId, { historyOnly: true });
      open.mockClear();
      const snapshot = await result.value.readSnapshot();
      expect(snapshot.ok).toBe(true);
      expect(open).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
    }
  });
  it("retries session open once when session/new returns no model catalog", async () => {
    const empty = {
      sessionId: info.sessionId,
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select" as const,
          currentValue: "model[effort=high]",
          options: [],
        },
      ],
    };
    const open = vi
      .spyOn(CursorTransport.prototype, "open")
      .mockImplementationOnce(async function (this: CursorTransport) {
        this.sessionId = empty.sessionId;
        return empty;
      })
      .mockImplementation(async function (this: CursorTransport) {
        this.sessionId = info.sessionId;
        return info;
      });
    vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
    const adapter = new CursorAdapter();
    try {
      const result = await adapter.open({ kind: "create", cwd: process.cwd() });
      expect(result.ok).toBe(true);
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      await adapter.close();
    }
  });
  it("does not claim unconfirmed mode selection", async () => {
    const f = session();
    vi.spyOn(f.transport, "configure").mockResolvedValue({ configOptions: [] });
    expect(
      (
        await f.session.execute({
          type: "permissionMode.select",
          permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
        })
      ).ok,
    ).toBe(false);
    expect(f.session.initialState.effectivePermissionModeId).toBe("agent");
    await f.session.close();
    await f.done;
  });
  it("faults and ends outputs after a parameter configuration retires the transport", async () => {
    const f = session();
    vi.spyOn(f.transport, "configure").mockImplementation(async () => {
      await CursorTransport.prototype.close.call(f.transport);
      throw new Error("Native parameter rejected after base model changed");
    });
    expect(
      await f.session.execute({
        type: "model.select",
        model: cursorModelRef("model[effort=high]"),
      }),
    ).toMatchObject({ ok: false });
    await f.done;
    expect(
      f.output.filter(
        (output) => output.kind === "event" && output.event.type === "session.faulted",
      ),
    ).toHaveLength(1);
    expect(await f.session.execute(start)).toMatchObject({ error: { code: "invalidState" } });
  });
});

describe("Cursor turn lifecycle", () => {
  it("faults and closes a dead ACP session instead of accepting further turns", async () => {
    const f = session();
    f.transport.action = async () => {
      throw new Error("Cursor ACP process exited (1)");
    };
    const close = vi.spyOn(f.transport, "close");
    await f.session.execute(start);
    await vi.waitFor(() =>
      expect(f.output.some((x) => x.kind === "event" && x.event.type === "turn.completed")).toBe(
        true,
      ),
    );
    expect(
      (await f.session.execute({ ...start, turnId: hostTurnIdSchema.parse("after-exit") })).ok,
    ).toBe(false);
    expect(f.output.some((x) => x.kind === "event" && x.event.type === "session.faulted")).toBe(
      true,
    );
    expect(close).toHaveBeenCalled();
    await f.session.close();
    await f.done;
  });
  it("emits a single terminal with durable native identity and refuses duplicate submission", async () => {
    const f = session();
    expect((await f.session.execute(start)).ok).toBe(true);
    await vi.waitFor(() =>
      expect(f.output.some((x) => x.kind === "event" && x.event.type === "turn.completed")).toBe(
        true,
      ),
    );
    expect((await f.session.execute(start)).ok).toBe(false);
    await f.session.close();
    await f.done;
    const terminal = f.output.filter(
      (x) => x.kind === "event" && x.event.type === "turn.completed",
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({
      event: {
        outcome: { status: "succeeded" },
        nativeTurnRef: { nativeTurnKey: native.turns[0]?.id },
      },
    });
  });
  it.each([0, 2])("fails a nominal success when native history added %i turns", async (count) => {
    const f = session();
    f.transport.action = async (text) => {
      for (let index = 0; index < count; index++) native.turns.push({ id: randomUUID(), text });
      return { stopReason: "end_turn" };
    };
    await f.session.execute(start);
    await vi.waitFor(() =>
      expect(f.output.some((x) => x.kind === "event" && x.event.type === "turn.completed")).toBe(
        true,
      ),
    );
    await f.session.close();
    await f.done;
    expect(f.output).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "turn.completed",
          outcome: expect.objectContaining({ status: "failed" }),
        }),
      }),
    );
  });
  it("rejects a concurrent turn and closes pending approval on cancel", async () => {
    const f = session();
    f.transport.action = async (text, callbacks) => {
      const response = await callbacks.permission({
        sessionId: info.sessionId,
        toolCall: { toolCallId: "p", title: "shell" },
        options: [{ kind: "allow_once", optionId: "yes", name: "Allow" }],
      });
      expect(response).toEqual({ outcome: { outcome: "cancelled" } });
      native.turns.push({ id: randomUUID(), text });
      return { stopReason: "cancelled" };
    };
    await f.session.execute(start);
    expect((await f.session.execute({ ...start, turnId: hostTurnIdSchema.parse("two") })).ok).toBe(
      false,
    );
    expect((await f.session.execute({ type: "turn.cancel", turnId })).ok).toBe(true);
    await vi.waitFor(() =>
      expect(f.output.some((x) => x.kind === "event" && x.event.type === "turn.completed")).toBe(
        true,
      ),
    );
    await f.session.close();
    await f.done;
    expect(f.output).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({ type: "interaction.closed", reason: "cancelled" }),
      }),
    );
    expect(
      f.output.filter((x) => x.kind === "event" && x.event.type === "turn.completed"),
    ).toHaveLength(1);
  });
  it("reports process failure without a guessed native turn ID", async () => {
    const f = session();
    f.transport.action = async () => {
      throw new Error("Cursor ACP process exited");
    };
    await f.session.execute(start);
    await vi.waitFor(() =>
      expect(f.output.some((x) => x.kind === "event" && x.event.type === "turn.completed")).toBe(
        true,
      ),
    );
    await f.session.close();
    await f.done;
    const terminal = f.output.find((x) => x.kind === "event" && x.event.type === "turn.completed");
    expect(terminal).toMatchObject({
      event: { outcome: { status: "failed", error: { code: "processExited" } } },
    });
    expect(terminal && "event" in terminal && "nativeTurnRef" in terminal.event).toBe(false);
  });
});

describe("Cursor interactions", () => {
  it("binds permissions to the exact interaction and rejects unknown or repeated decisions", async () => {
    const outputs: HarnessOutput[] = [];
    const interactions = new CursorInteractions((x) => outputs.push(x));
    const waiting = interactions.permission(turnId, {
      sessionId: info.sessionId,
      toolCall: { toolCallId: "p", title: "shell" },
      options: [{ kind: "reject_once", optionId: "reject-once", name: "Reject" }],
    });
    const first = outputs[0];
    if (first?.kind !== "interaction") throw new Error("missing interaction");
    expect(
      interactions.respond({
        type: "interaction.respond",
        interactionId: hostInteractionIdSchema.parse("wrong"),
        response: { type: "approval", actionId: "reject-once" },
      }).ok,
    ).toBe(false);
    const command = {
      type: "interaction.respond" as const,
      interactionId: first.interaction.interactionId,
      response: { type: "approval" as const, actionId: "reject-once" },
    };
    expect(interactions.respond(command).ok).toBe(true);
    expect(interactions.respond(command).ok).toBe(false);
    expect(await waiting).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });
  });
  it("requires an explicit response for plans and questions, and cancels both on close", async () => {
    const outputs: HarnessOutput[] = [];
    const interactions = new CursorInteractions((x) => outputs.push(x));
    const plan = interactions.extension(turnId, "cursor/create_plan", { plan: "Do a thing" });
    const question = interactions.extension(turnId, "cursor/ask_question", {
      questions: [{ id: "q", prompt: "Which?", options: [{ id: "a", label: "A" }] }],
    });
    expect(outputs.filter((x) => x.kind === "interaction")).toHaveLength(2);
    interactions.cancel();
    expect(await plan).toEqual({ outcome: { outcome: "cancelled" } });
    expect(await question).toEqual({ outcome: { outcome: "cancelled" } });
  });
});

describe("Cursor replay identity", () => {
  const identity = { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", text: "hello" };
  const replay = [
    {
      sessionId: info.sessionId,
      update: {
        sessionUpdate: "user_message_chunk" as const,
        content: { type: "text" as const, text: "hello" },
      },
    },
    {
      sessionId: info.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk" as const,
        content: { type: "text" as const, text: "ok" },
      },
    },
  ];
  it("uses native identity and preserves unknown historical outcome", () => {
    const snapshot = cursorSnapshot(info.sessionId, [identity], replay);
    expect(snapshot.turns[0]).toMatchObject({
      nativeTurnRef: { nativeTurnKey: identity.id },
      outcome: { status: "unknown" },
    });
  });
  it("fails closed on count, prompt and session mismatch", () => {
    expect(() => cursorSnapshot(info.sessionId, [], replay)).toThrow();
    expect(() =>
      cursorSnapshot(info.sessionId, [{ ...identity, text: "other" }], replay),
    ).toThrow();
    expect(() => cursorSnapshot("other", [identity], replay)).toThrow();
  });
});

describe("Cursor idle suspension", () => {
  it("suspends a persisted idle Session and resumes the same native identity", async () => {
    const opens: Array<{ sessionId: string | undefined; options: unknown }> = [];
    vi.spyOn(CursorTransport.prototype, "open").mockImplementation(async function (
      this: CursorTransport,
      sessionId,
      options,
    ) {
      opens.push({ sessionId, options });
      this.sessionId = sessionId ?? info.sessionId;
      // session/load replays persisted prompts; session/new has nothing to replay.
      this.replay = sessionId
        ? native.turns.map((turn) => ({
            sessionId: this.sessionId,
            update: {
              sessionUpdate: "user_message_chunk" as const,
              content: { type: "text" as const, text: turn.text },
            },
          }))
        : [];
      return info;
    });
    vi.spyOn(CursorTransport.prototype, "prompt").mockImplementation(async (text) => {
      native.turns.push({ id: randomUUID(), text });
      return { stopReason: "end_turn" };
    });
    const close = vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
    const adapter = new CursorAdapter();
    try {
      const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      const lifecycle = session.resourceLifecycle;
      if (!lifecycle) throw new Error("Missing idle lifecycle");
      const output: HarnessOutput[] = [];
      const done = (async () => {
        for await (const item of session.outputs) output.push(item);
      })();
      expect((await session.execute(start)).ok).toBe(true);
      await vi.waitFor(() =>
        expect(output.some((x) => x.kind === "event" && x.event.type === "turn.completed")).toBe(
          true,
        ),
      );

      await expect(lifecycle.suspend(new AbortController().signal)).resolves.toEqual({
        status: "suspended",
        scope: "cursor-acp-session",
      });
      expect(close).toHaveBeenCalledTimes(1);
      await done;
      expect((await session.execute({ ...start, turnId: hostTurnIdSchema.parse("two") })).ok).toBe(
        false,
      );

      const nativeRef = session.initialState.nativeRef;
      if (!nativeRef) throw new Error("Missing Cursor native identity");
      const resumed = await adapter.open({ kind: "resume", cwd: process.cwd(), nativeRef });
      if (!resumed.ok) throw new Error(resumed.error.message);
      expect(resumed.value.initialState.nativeRef).toEqual(nativeRef);
      expect(resumed.value.executionReady).toBe(true);
      expect(opens.at(-1)).toMatchObject({ sessionId: nativeRef.nativeSessionId });
      await resumed.value.close();
    } finally {
      await adapter.close();
    }
  });
  it("keeps an unpersisted Session live and reports abort as unknown", async () => {
    const f = session();
    const close = vi.spyOn(f.transport, "close");
    await expect(
      f.session.resourceLifecycle.suspend(new AbortController().signal),
    ).resolves.toEqual({
      status: "unknown",
      reason: "Cursor has not persisted this Native Session yet",
    });
    const aborted = new AbortController();
    aborted.abort();
    await expect(f.session.resourceLifecycle.suspend(aborted.signal)).resolves.toEqual({
      status: "unknown",
      reason: "Cursor idle suspension was aborted",
    });
    expect(close).not.toHaveBeenCalled();
    await f.session.close();
    await f.done;
    await expect(
      f.session.resourceLifecycle.suspend(new AbortController().signal),
    ).resolves.toEqual({ status: "unknown", reason: "Cursor Session is closed or faulted" });
  });
  it("refuses suspension while a snapshot read holds a replay process", async () => {
    const f = session();
    expect((await f.session.execute(start)).ok).toBe(true);
    await vi.waitFor(() =>
      expect(f.output.some((x) => x.kind === "event" && x.event.type === "turn.completed")).toBe(
        true,
      ),
    );
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opening!: () => void;
    const opened = new Promise<void>((resolve) => {
      opening = resolve;
    });
    vi.spyOn(CursorTransport.prototype, "open").mockImplementation(async function (
      this: CursorTransport,
    ) {
      opening();
      await released;
      this.replay = native.turns.map((turn) => ({
        sessionId: info.sessionId,
        update: {
          sessionUpdate: "user_message_chunk" as const,
          content: { type: "text" as const, text: turn.text },
        },
      }));
      return info;
    });
    vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
    const snapshot = f.session.readSnapshot();
    await opened;
    await expect(
      f.session.resourceLifecycle.suspend(new AbortController().signal),
    ).resolves.toMatchObject({ status: "busy" });
    release();
    expect((await snapshot).ok).toBe(true);
    await expect(
      f.session.resourceLifecycle.suspend(new AbortController().signal),
    ).resolves.toEqual({ status: "suspended", scope: "cursor-acp-session" });
    await f.done;
  });
  it("refuses suspension while a Turn is running with a pending approval", async () => {
    const f = session();
    const close = vi.spyOn(f.transport, "close");
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.transport.action = async (text, callbacks) => {
      void callbacks.permission({
        sessionId: info.sessionId,
        toolCall: { toolCallId: "p", title: "shell" },
        options: [{ kind: "allow_once", optionId: "yes", name: "Allow" }],
      });
      await released;
      native.turns.push({ id: randomUUID(), text });
      return { stopReason: "end_turn" };
    };
    expect((await f.session.execute(start)).ok).toBe(true);
    await vi.waitFor(() => expect(f.output.some((x) => x.kind === "interaction")).toBe(true));
    await expect(
      f.session.resourceLifecycle.suspend(new AbortController().signal),
    ).resolves.toMatchObject({ status: "busy" });
    expect(close).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() =>
      expect(f.output.some((x) => x.kind === "event" && x.event.type === "turn.completed")).toBe(
        true,
      ),
    );
    await expect(
      f.session.resourceLifecycle.suspend(new AbortController().signal),
    ).resolves.toEqual({ status: "suspended", scope: "cursor-acp-session" });
    expect(close).toHaveBeenCalledTimes(1);
    await f.done;
  });
  it("does not report suspension when native process cleanup rejects", async () => {
    const f = session();
    expect((await f.session.execute(start)).ok).toBe(true);
    await vi.waitFor(() =>
      expect(f.output.some((x) => x.kind === "event" && x.event.type === "turn.completed")).toBe(
        true,
      ),
    );
    vi.spyOn(f.transport, "close").mockRejectedValue(new Error("owned group remains"));
    await expect(
      f.session.resourceLifecycle.suspend(new AbortController().signal),
    ).rejects.toBeInstanceOf(AggregateError);
    await f.done;
  });
});
describe("Cursor cleanup ownership", () => {
  it("keeps a Session owned when native process cleanup rejects", async () => {
    vi.spyOn(CursorTransport.prototype, "open").mockImplementation(async function (
      this: CursorTransport,
    ) {
      this.sessionId = info.sessionId;
      return info;
    });
    vi.spyOn(CursorTransport.prototype, "close").mockRejectedValue(
      new Error("owned group remains"),
    );
    const adapter = new CursorAdapter();
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw new Error(opened.error.message);

    await expect(opened.value.close()).rejects.toBeInstanceOf(AggregateError);
    await expect(adapter.close()).rejects.toBeInstanceOf(AggregateError);
  });
});
