import { FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import {
  harnessIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { ManagedHarnessSession } from "../src/managed-harness-session.js";

const harnessId = harnessIdSchema.parse("opencode");
const nativeRef = nativeSessionRefSchema.parse({
  harnessId,
  nativeSessionId: "native-session",
  formatVersion: 1,
});

function session(ref = nativeRef): FakeHarnessSession {
  return new FakeHarnessSession(harnessId, undefined, undefined, ref);
}

function lifecycle(
  current: FakeHarnessSession,
  result: unknown = { status: "suspended", scope: "native-session" },
): void {
  Object.defineProperty(current, "resourceLifecycle", {
    configurable: true,
    value: {
      suspend: async () => {
        await current.close();
        return result;
      },
    },
  });
}

describe("ManagedHarnessSession", () => {
  it("keeps Host outputs open across an owned native suspension and serially resumes", async () => {
    const initial = session();
    lifecycle(initial);
    const resumed = session();
    lifecycle(resumed);
    const resume = vi.fn(async () => resumed);
    const managed = new ManagedHarnessSession({
      session: initial,
      resume,
      onActivity: () => undefined,
      onFault: () => undefined,
    });
    const outputs = managed.outputs[Symbol.asyncIterator]();

    await expect(managed.resourceLifecycle?.suspend(new AbortController().signal)).resolves.toEqual(
      {
        status: "suspended",
        scope: "native-session",
      },
    );
    expect(initial.closed).toBe(true);

    await expect(managed.readSnapshot()).resolves.toMatchObject({ ok: true });
    expect(resume).toHaveBeenCalledOnce();
    expect(resumed.closed).toBe(false);

    const next = outputs.next();
    resumed.publishUsage(null);
    await expect(next).resolves.toMatchObject({ done: false, value: { kind: "event" } });
    await managed.close();
  });

  it("accepts a suspended result only after its delayed old output generation ends", async () => {
    const initial = session();
    Object.defineProperty(initial, "resourceLifecycle", {
      configurable: true,
      value: {
        suspend: async () => {
          setTimeout(() => {
            void initial.close();
          }, 1);
          return { status: "suspended", scope: "native-session" };
        },
      },
    });
    const resumed = session();
    lifecycle(resumed);
    const onFault = vi.fn();
    const managed = new ManagedHarnessSession({
      session: initial,
      resume: async () => resumed,
      onActivity: () => undefined,
      onFault,
      outputEndTimeoutMs: 50,
    });

    await expect(managed.resourceLifecycle?.suspend(new AbortController().signal)).resolves.toEqual(
      {
        status: "suspended",
        scope: "native-session",
      },
    );
    expect(onFault).not.toHaveBeenCalled();
    await expect(managed.resourceLifecycle?.suspend(new AbortController().signal)).resolves.toEqual(
      {
        status: "suspended",
        scope: "native-session",
      },
    );
    await expect(managed.readSnapshot()).resolves.toMatchObject({ ok: true });
    await managed.close();
  });

  it("forwards native activity observed during a busy suspension attempt", async () => {
    const initial = session();
    const turnId = hostTurnIdSchema.parse("native-race-turn");
    Object.defineProperty(initial, "resourceLifecycle", {
      configurable: true,
      value: {
        suspend: async () => {
          await initial.execute({
            type: "turn.start",
            turnId,
            input: [{ type: "text", text: "native autonomous work" }],
          });
          await Promise.resolve();
          return { status: "busy" };
        },
      },
    });
    const resume = vi.fn(async () => session());
    const managed = new ManagedHarnessSession({
      session: initial,
      resume,
      onActivity: () => undefined,
      onFault: () => undefined,
    });
    const outputs = managed.outputs[Symbol.asyncIterator]();
    const first = outputs.next();

    await expect(managed.resourceLifecycle?.suspend(new AbortController().signal)).resolves.toEqual(
      {
        status: "busy",
      },
    );
    await expect(first).resolves.toMatchObject({
      done: false,
      value: { kind: "event", event: { type: "turn.started", turnId } },
    });
    expect(resume).not.toHaveBeenCalled();

    initial.succeedTurn();
    let completed = false;
    for (let index = 0; index < 3; index += 1) {
      const next = await outputs.next();
      if (next.done || next.value.kind !== "event") continue;
      if (next.value.event.type === "turn.completed" && next.value.event.turnId === turnId) {
        completed = true;
        break;
      }
    }
    expect(completed).toBe(true);
    await managed.close();
  });

  it("uses a native identity published after create as the resume fence", async () => {
    const initial = session();
    Object.defineProperty(initial, "initialState", { configurable: true, value: {} });
    lifecycle(initial);
    const resumed = session();
    lifecycle(resumed);
    const managed = new ManagedHarnessSession({
      session: initial,
      resume: async () => resumed,
      onActivity: () => undefined,
      onFault: () => undefined,
    });
    const model = initial.state.effectiveModel;
    if (!model) throw new Error("Fixture Session has no Model");

    await expect(managed.execute({ type: "model.select", model })).resolves.toMatchObject({
      ok: true,
    });
    await vi.waitFor(() => expect(managed.initialState.nativeRef).toEqual(nativeRef));
    await expect(
      managed.resourceLifecycle?.suspend(new AbortController().signal),
    ).resolves.toMatchObject({
      status: "suspended",
    });
    await expect(managed.readSnapshot()).resolves.toMatchObject({ ok: true });
    await managed.close();
  });

  it("rejects a resumed Session whose published native identity differs", async () => {
    const initial = session();
    Object.defineProperty(initial, "initialState", { configurable: true, value: {} });
    lifecycle(initial);
    const wrongRef = nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: "other-native-session",
      formatVersion: 1,
    });
    const resumed = session(wrongRef);
    lifecycle(resumed);
    const onFault = vi.fn();
    const managed = new ManagedHarnessSession({
      session: initial,
      resume: async () => resumed,
      onActivity: () => undefined,
      onFault,
    });
    const model = initial.state.effectiveModel;
    if (!model) throw new Error("Fixture Session has no Model");

    await managed.execute({ type: "model.select", model });
    await vi.waitFor(() => expect(managed.initialState.nativeRef).toEqual(nativeRef));
    await managed.resourceLifecycle?.suspend(new AbortController().signal);
    await expect(managed.readSnapshot()).rejects.toThrow("native Session identity changed");
    expect(onFault).toHaveBeenCalledOnce();
  });

  it("fails closed when an adapter returns a malformed suspension result", async () => {
    const initial = session();
    lifecycle(initial, { status: "suspended", scope: "" });
    const onFault = vi.fn();
    const managed = new ManagedHarnessSession({
      session: initial,
      resume: async () => session(),
      onActivity: () => undefined,
      onFault,
    });
    const outputs = managed.outputs[Symbol.asyncIterator]();

    await expect(
      managed.resourceLifecycle?.suspend(new AbortController().signal),
    ).resolves.toMatchObject({
      status: "unknown",
    });
    await expect(outputs.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "event", event: { type: "session.faulted" } },
    });
    expect(onFault).toHaveBeenCalledOnce();
    expect(initial.closed).toBe(true);
  });

  it("faults instead of letting a claimed suspension block later Host operations forever", async () => {
    const initial = session();
    Object.defineProperty(initial, "resourceLifecycle", {
      configurable: true,
      value: { suspend: async () => ({ status: "suspended", scope: "native-session" }) },
    });
    const onFault = vi.fn();
    const managed = new ManagedHarnessSession({
      session: initial,
      resume: async () => session(),
      onActivity: () => undefined,
      onFault,
      outputEndTimeoutMs: 5,
    });
    const outputs = managed.outputs[Symbol.asyncIterator]();

    await expect(
      managed.resourceLifecycle?.suspend(new AbortController().signal),
    ).resolves.toMatchObject({
      status: "unknown",
    });
    await expect(outputs.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "event", event: { type: "session.faulted" } },
    });
    await vi.waitFor(() => expect(initial.closed).toBe(true));
    expect(onFault).toHaveBeenCalledOnce();
  });
});
