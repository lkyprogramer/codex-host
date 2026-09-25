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

  it("does not fault when a deferred history Session ends before live resume", async () => {
    const history = session();
    Object.defineProperty(history, "executionReady", { value: false });
    const live = session();
    const onFault = vi.fn();
    const resume = vi.fn(async (options?: { skipSnapshot?: boolean }) => {
      expect(options).toEqual({ skipSnapshot: true });
      return live;
    });
    const managed = new ManagedHarnessSession({
      session: history,
      resume,
      onActivity: () => undefined,
      onFault,
    });
    const outputs = managed.outputs[Symbol.asyncIterator]();
    const started = await managed.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-live"),
      input: [{ type: "text", text: "continue" }],
    });
    expect(started.ok).toBe(true);
    expect(history.closed).toBe(true);
    expect(onFault).not.toHaveBeenCalled();
    live.succeedTurn();
    let faulted = false;
    for (let index = 0; index < 8; index += 1) {
      const next = await outputs.next();
      if (next.done) break;
      if (next.value.kind === "event" && next.value.event.type === "session.faulted") {
        faulted = true;
        break;
      }
      if (next.value.kind === "event" && next.value.event.type === "turn.completed") break;
    }
    expect(faulted).toBe(false);
    await managed.close();
  });

  it("resumes a suspended history Session as history for reads and live only for execution", async () => {
    const history = session();
    Object.defineProperty(history, "executionReady", { value: false });
    lifecycle(history);
    const historyAgain = session();
    Object.defineProperty(historyAgain, "executionReady", { value: false });
    lifecycle(historyAgain);
    const live = session();
    lifecycle(live);
    const resume = vi.fn(async (options?: { skipSnapshot?: boolean; historyOnly?: boolean }) =>
      options?.historyOnly ? historyAgain : live,
    );
    const managed = new ManagedHarnessSession({
      session: history,
      resume,
      onActivity: () => undefined,
      onFault: () => undefined,
    });
    const outputs = managed.outputs[Symbol.asyncIterator]();

    await expect(managed.resourceLifecycle?.suspend(new AbortController().signal)).resolves.toEqual(
      { status: "suspended", scope: "native-session" },
    );
    expect(managed.nativeSuspended).toBe(true);
    expect(history.closed).toBe(true);

    await expect(managed.readSnapshot()).resolves.toMatchObject({ ok: true });
    expect(managed.nativeSuspended).toBe(false);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenLastCalledWith({ historyOnly: true });
    expect(live.closed).toBe(false);
    await expect(managed.readSnapshot()).resolves.toMatchObject({ ok: true });
    expect(resume).toHaveBeenCalledTimes(1);

    const started = await managed.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-live"),
      input: [{ type: "text", text: "continue" }],
    });
    expect(started.ok).toBe(true);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenLastCalledWith({ skipSnapshot: true });
    expect(historyAgain.closed).toBe(true);
    live.succeedTurn();
    for (let index = 0; index < 8; index += 1) {
      const next = await outputs.next();
      if (next.done) break;
      if (next.value.kind === "event" && next.value.event.type === "session.faulted") {
        throw new Error("history resume must not fault the Session");
      }
      if (next.value.kind === "event" && next.value.event.type === "turn.completed") break;
    }
    await managed.close();
  });

  it("treats a live Session returned by a history resume as live", async () => {
    const history = session();
    Object.defineProperty(history, "executionReady", { value: false });
    lifecycle(history);
    const live = session();
    lifecycle(live);
    const resume = vi.fn(async () => live);
    const managed = new ManagedHarnessSession({
      session: history,
      resume,
      onActivity: () => undefined,
      onFault: () => undefined,
    });
    managed.outputs[Symbol.asyncIterator]();
    await managed.resourceLifecycle?.suspend(new AbortController().signal);
    await expect(managed.readSnapshot()).resolves.toMatchObject({ ok: true });
    expect(resume).toHaveBeenLastCalledWith({ historyOnly: true });

    const started = await managed.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-live"),
      input: [{ type: "text", text: "continue" }],
    });
    expect(started.ok).toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(live.closed).toBe(false);
    await managed.close();
  });

  it("faults instead of opening a live Session when history cleanup fails", async () => {
    const history = session();
    Object.defineProperty(history, "executionReady", { value: false });
    let closes = 0;
    vi.spyOn(history, "close").mockImplementation(async () => {
      closes += 1;
      if (closes === 1) throw new Error("owned group remains");
    });
    const resume = vi.fn(async () => session());
    const onFault = vi.fn();
    const managed = new ManagedHarnessSession({
      session: history,
      resume,
      onActivity: () => undefined,
      onFault,
    });
    await expect(
      managed.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-live"),
        input: [{ type: "text", text: "continue" }],
      }),
    ).rejects.toThrow("owned group remains");
    expect(resume).not.toHaveBeenCalled();
    expect(onFault).toHaveBeenCalledOnce();
    await managed.close().catch(() => undefined);
  });

  it("faults and frees the queue when an adapter never answers an operation", async () => {
    const initial = session();
    Object.defineProperty(initial, "readSnapshot", {
      configurable: true,
      value: () => new Promise(() => undefined),
    });
    const onFault = vi.fn();
    const managed = new ManagedHarnessSession({
      session: initial,
      resume: async () => session(),
      onActivity: () => undefined,
      onFault,
      operationTimeoutMs: 20,
    });
    const outputs = managed.outputs[Symbol.asyncIterator]();

    await expect(managed.readSnapshot()).rejects.toThrow("did not answer within 20 ms");
    await expect(outputs.next()).resolves.toMatchObject({
      value: { kind: "event", event: { type: "session.faulted" } },
    });
    // The close queued behind the stuck read still runs.
    await managed.close();
    expect(initial.closed).toBe(true);
    expect(onFault).toHaveBeenCalledOnce();
  });

  it("closes a native Session whose resume finished after the deadline", async () => {
    const initial = session();
    lifecycle(initial);
    let finishResume!: (value: FakeHarnessSession) => void;
    const late = session();
    // Fully compatible, so only the closed-Session check can refuse it.
    lifecycle(late);
    const managed = new ManagedHarnessSession({
      session: initial,
      resume: () =>
        new Promise<FakeHarnessSession>((resolve) => {
          finishResume = resolve;
        }),
      onActivity: () => undefined,
      onFault: () => undefined,
      operationTimeoutMs: 20,
    });
    await expect(
      managed.resourceLifecycle?.suspend(new AbortController().signal),
    ).resolves.toMatchObject({ status: "suspended" });

    await expect(managed.readSnapshot()).rejects.toThrow("did not answer within 20 ms");
    await managed.close();
    finishResume(late);
    // Attached to nothing, the late native Session would never be closed.
    await vi.waitFor(() => expect(late.closed).toBe(true));
  });

  it("keeps a Session whose release failed but stayed open, and faults one that closed", async () => {
    const open = session();
    Object.defineProperty(open, "resourceLifecycle", {
      configurable: true,
      value: { suspend: async () => ({ status: "releaseFailed", reason: "group remains" }) },
    });
    const keptFault = vi.fn();
    const kept = new ManagedHarnessSession({
      session: open,
      resume: async () => session(),
      onActivity: () => undefined,
      onFault: keptFault,
    });
    await expect(kept.resourceLifecycle?.suspend(new AbortController().signal)).resolves.toEqual({
      status: "releaseFailed",
      reason: "group remains",
    });
    // Still usable: the Host retries the release on its idle backoff.
    await expect(kept.readSnapshot()).resolves.toMatchObject({ ok: true });
    expect(keptFault).not.toHaveBeenCalled();
    await kept.close();

    const closed = session();
    Object.defineProperty(closed, "resourceLifecycle", {
      configurable: true,
      value: {
        suspend: async () => {
          // Like Cursor and Kiro: the adapter closed itself before the
          // release failed, which ends its outputs.
          await closed.close();
          return { status: "releaseFailed", reason: "group remains" };
        },
      },
    });
    const lostFault = vi.fn();
    const lost = new ManagedHarnessSession({
      session: closed,
      resume: async () => session(),
      onActivity: () => undefined,
      onFault: lostFault,
    });
    await expect(
      lost.resourceLifecycle?.suspend(new AbortController().signal),
    ).resolves.toMatchObject({ status: "releaseFailed" });
    await vi.waitFor(() => expect(lostFault).toHaveBeenCalledOnce());
  });
});
