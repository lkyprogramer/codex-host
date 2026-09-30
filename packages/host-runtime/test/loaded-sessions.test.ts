import { describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  harnessIdSchema,
  hostThreadIdSchema,
  loadedSessionsResultSchema,
} from "@codexhost/shared-contracts";
import type { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { ExternalThreadRuntime } from "../src/external-thread-runtime.js";
import { ManagedHarnessSession } from "../src/managed-harness-session.js";

const harnessId = harnessIdSchema.parse("pi");
const threadId = hostThreadIdSchema.parse("resource-thread");
const record = {
  hostThreadId: threadId,
  harnessId,
  cwd: "/private-workspace",
  transportModelId: "codexhost/pi-native",
} as StoredThreadRecordV1;

describe("loaded Session observations", () => {
  it.each(["busy", "unknown", "releaseFailed", "unsupported", "suspended"] as const)(
    "reports %s without probing or exporting native diagnostics",
    async (status) => {
      const adapter = new FakeHarnessAdapter(harnessId);
      const opened = await adapter.open({ kind: "create", cwd: record.cwd });
      if (!opened.ok || !(opened.value instanceof FakeHarnessSession))
        throw new Error("Missing fixture Session");
      const session = opened.value;
      const read = vi.spyOn(session, "readSnapshot");
      const suspend = vi.fn(async () => {
        if (status === "suspended") await session.close();
        return { status, scope: "native-session", reason: "private native error /secret/path" };
      });
      Object.defineProperty(session, "resourceLifecycle", { value: { suspend } });
      const runtime = new ExternalThreadRuntime({
        adapters: new Map([["pi", adapter]]),
        repository: {} as ExternalThreadRepository,
        consumeOutputs: async () => undefined,
        diagnose: () => undefined,
        idleSuspendTimeoutMs: 10,
      });
      try {
        expect(runtime.loadedSessions()).toEqual({ sessions: [] });
        const thread = runtime.register({
          record,
          session,
          sessionId: "native-private",
          thread: { id: threadId, title: "private-title" },
          turns: [],
        });
        const initial = runtime.loadedSessions();
        expect(initial.sessions[0]).toMatchObject({
          running: false,
          resourceState: "loaded",
          lastRelease: null,
        });
        thread.running = true;
        expect(runtime.loadedSessions().sessions[0]?.running).toBe(true);
        thread.running = false;
        await vi.waitFor(() =>
          expect(runtime.loadedSessions().sessions[0]?.lastRelease?.status).toBe(status),
        );
        const calls = suspend.mock.calls.length;
        const snapshot = loadedSessionsResultSchema.parse(runtime.loadedSessions());
        expect(snapshot.sessions[0]?.resourceState).toBe(
          status === "suspended" ? "suspended" : "loaded",
        );
        expect(snapshot.sessions[0]?.lastActivityAt).toBe(initial.sessions[0]?.lastActivityAt);
        expect(JSON.stringify(snapshot)).not.toMatch(/private|secret|scope|reason|cwd/u);
        expect(read).not.toHaveBeenCalled();
        expect(suspend).toHaveBeenCalledTimes(calls);
        const lastRelease = snapshot.sessions[0]?.lastRelease;
        if (!lastRelease) throw new Error("Missing release observation");
        lastRelease.status = "unknown";
        expect(runtime.loadedSessions().sessions[0]?.lastRelease?.status).toBe(status);
        runtime.remove(threadId);
        expect(runtime.loadedSessions()).toEqual({ sessions: [] });
      } finally {
        runtime.clear();
        await adapter.close();
      }
    },
  );

  it("observes history-only and in-progress suspension without waking the Session", async () => {
    const native = new FakeHarnessSession(harnessId);
    Object.defineProperty(native, "executionReady", { value: false });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.defineProperty(native, "resourceLifecycle", {
      value: {
        suspend: async () => {
          await waiting;
          await native.close();
          return { status: "suspended", scope: "native-session" };
        },
      },
    });
    const resume = vi.fn(async () => native);
    const managed = new ManagedHarnessSession({
      session: native,
      resume,
      onActivity: () => undefined,
      onFault: () => undefined,
    });
    try {
      expect(managed.resourceState).toBe("historyOnly");
      const lifecycle = managed.resourceLifecycle;
      if (!lifecycle) throw new Error("Missing fixture lifecycle");
      const pending = lifecycle.suspend(new AbortController().signal);
      await vi.waitFor(() => expect(managed.resourceState).toBe("suspending"));
      expect(resume).not.toHaveBeenCalled();
      release();
      await pending;
      expect(managed.resourceState).toBe("suspended");
      expect(resume).not.toHaveBeenCalled();
    } finally {
      release();
      await managed.close();
    }
    expect(managed.resourceState).toBe("unavailable");
  });
});
