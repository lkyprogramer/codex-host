import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import { runAdapterConformance } from "@codexhost/harness-adapter/conformance";
import type { CursorSessionInfo } from "../src/transport.js";
import { CursorAdapter } from "../src/adapter.js";
import { CursorTransport } from "../src/transport.js";

const native = vi.hoisted(() => ({
  created: [] as Array<{ sessionId: string; environment: NodeJS.ProcessEnv }>,
  transports: new Map<CursorTransport, { closed: boolean }>(),
  turns: new Map<string, Array<{ id: string; text: string }>>(),
  pending: new Map<string, { text: string; resolve(value: { stopReason: "cancelled" }): void }>(),
  nextSession: 0,
}));

vi.mock("../src/native-history.js", () => ({
  readCursorNativeTurns: (sessionId: string) => structuredClone(native.turns.get(sessionId) ?? []),
}));

const sessionIds = [
  "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  "cccccccc-cccc-cccc-cccc-cccccccccccc",
] as const;

const info = (sessionId: string): CursorSessionInfo => ({
  sessionId,
  configOptions: [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "model[effort=high]",
      options: [{ value: "model[effort=high]", name: "Model" }],
    },
  ],
});

afterEach(() => {
  vi.restoreAllMocks();
  native.created = [];
  native.transports.clear();
  native.turns.clear();
  native.pending.clear();
  native.nextSession = 0;
});

function installNativeFixture() {
  vi.spyOn(CursorTransport.prototype, "open").mockImplementation(async function (
    this: CursorTransport,
    requestedSessionId?: string,
  ) {
    const sessionId = requestedSessionId ?? sessionIds[native.nextSession++];
    if (!sessionId) throw new Error("Cursor fixture exhausted native session identities");
    this.sessionId = sessionId;
    native.transports.set(this, { closed: false });
    if (!requestedSessionId) {
      native.created.push({
        sessionId,
        environment: { ...this.options.environment },
      });
    }
    if (!native.turns.has(sessionId)) native.turns.set(sessionId, []);
    if (requestedSessionId) {
      this.replay = (native.turns.get(sessionId) ?? []).map(({ text }) => ({
        sessionId,
        update: {
          sessionUpdate: "user_message_chunk" as const,
          content: { type: "text" as const, text },
        },
      }));
    }
    return info(sessionId);
  });
  vi.spyOn(CursorTransport.prototype, "prompt").mockImplementation(async function (
    this: CursorTransport,
    text: string,
  ) {
    if (text === "hold") {
      return new Promise<{ stopReason: "cancelled" }>((resolve) => {
        native.pending.set(this.sessionId, { text, resolve });
      });
    }
    native.turns.get(this.sessionId)?.push({ id: randomUUID(), text });
    return { stopReason: "end_turn" };
  });
  vi.spyOn(CursorTransport.prototype, "cancel").mockImplementation(async function (
    this: CursorTransport,
  ) {
    const pending = native.pending.get(this.sessionId);
    if (!pending) return;
    native.turns.get(this.sessionId)?.push({ id: randomUUID(), text: pending.text });
    native.pending.delete(this.sessionId);
    pending.resolve({ stopReason: "cancelled" });
  });
  vi.spyOn(CursorTransport.prototype, "close").mockImplementation(async function (
    this: CursorTransport,
  ) {
    const transport = native.transports.get(this);
    if (transport) transport.closed = true;
  });
}

describe("Cursor Adapter conformance", () => {
  it("drives the actual Adapter through create, cancel, resume, environment isolation, and cleanup", async () => {
    installNativeFixture();
    const receipt = await runAdapterConformance({
      createAdapter: () => new CursorAdapter({ environment: { BASE_ENVIRONMENT: "cursor" } }),
      cwd: process.cwd(),
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
      prompts: { first: "first", cancellable: "hold", followup: "followup" },
      probes: {
        assertEnvironmentIsolation: async () => {
          const sessions = native.created.slice(-2);
          expect(
            sessions.map((session) => session.environment.CODEXHOST_CONFORMANCE_SCOPE),
          ).toEqual(["primary", "isolated"]);
          expect(
            sessions.every((session) => session.environment.BASE_ENVIRONMENT === "cursor"),
          ).toBe(true);
        },
        readCleanup: async () => ({
          residue: [...native.transports.values()].every((transport) => transport.closed)
            ? "none"
            : "present",
        }),
      },
    });

    expect(receipt).toMatchObject({
      status: "incomplete",
      harnessId: "cursor-cli",
      scenarios: {
        inspect: { status: "passed" },
        create: { status: "passed" },
        environmentIsolation: { status: "passed" },
        firstTurn: { status: "passed" },
        concurrentTurn: { status: "passed" },
        cancel: { status: "passed" },
        identityReadback: { status: "passed" },
        resume: { status: "passed" },
        followup: { status: "passed" },
        fork: { status: "skipped" },
        rollback: { status: "skipped" },
        permissionAtCreate: { status: "skipped" },
        subagents: { status: "notCovered" },
        cleanup: { status: "passed" },
      },
      cleanup: { nativeReadback: "passed", residue: "none" },
    });
    expect(receipt.identityReadback.terminalTurns).toHaveLength(3);
  });
});
