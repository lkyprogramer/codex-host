import { mkdtemp, rm } from "node:fs/promises";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";
import type {
  HarnessAdapter,
  HarnessResult,
  HarnessSession,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import { BrokeredHarnessAdapter, startHarnessBrokerServer } from "@codexhost/harness-broker";
import { MappingStore } from "@codexhost/mapping-store";
import {
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  type ExternalHarnessId,
  type JsonObject,
} from "@codexhost/protocol-core";
import { harnessIdSchema } from "@codexhost/shared-contracts";

import { AppServerHost } from "../src/index.js";

class FakeOfficialProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);

  constructor() {
    super();
    this.stdin.once("finish", () => {
      this.stdout.end();
      this.emit("exit", 0, null);
    });
  }
}

class JsonLineCollector {
  readonly messages: JsonObject[] = [];
  #buffer = "";

  constructor(stream: PassThrough) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let newline = this.#buffer.indexOf("\n");
      while (newline >= 0) {
        this.messages.push(JSON.parse(this.#buffer.slice(0, newline)) as JsonObject);
        this.#buffer = this.#buffer.slice(newline + 1);
        newline = this.#buffer.indexOf("\n");
      }
    });
  }

  async waitFor(predicate: (message: JsonObject) => boolean): Promise<JsonObject> {
    await vi.waitFor(() => expect(this.messages.some(predicate)).toBe(true), { timeout: 3_000 });
    const message = this.messages.find(predicate);
    if (!message) throw new Error("Expected Host output was not collected");
    return message;
  }
}

function writeRequest(stream: PassThrough, value: JsonObject): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function requestId(message: JsonObject, id: number): boolean {
  return message.id === id;
}

function turnEvent(message: JsonObject, eventMethod: string, turnId: string): boolean {
  if (message.method !== eventMethod) return false;
  const params = message.params as JsonObject | undefined;
  const turn = params?.turn as JsonObject | undefined;
  return turn?.id === turnId || params?.turnId === turnId;
}

describe("AppServerHost broker fault recovery", () => {
  it("retires an authentication-faulted broker Session and resumes the stored Thread once", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-broker-host-"));
    const descriptorPath = path.join(root, "broker.json");
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\codexhost-broker-host-${process.pid}`
        : path.join(root, "broker.sock");
    const harnessId = harnessIdSchema.parse("claude-code");
    const nativeRef = {
      harnessId,
      nativeSessionId: "broker-host-native-session",
      formatVersion: 1 as const,
    };
    const nativeFixture = new FakeHarnessAdapter(harnessId);
    const nativeSessions: FakeHarnessSession[] = [];
    const nativeOpen = vi.fn(
      async (input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> => {
        const session = new FakeHarnessSession(
          harnessId,
          nativeFixture.catalog,
          "model" in input ? input.model : undefined,
          nativeRef,
          { turns: [] },
          true,
          root,
          true,
          "thinkingOptionId" in input ? input.thinkingOptionId : undefined,
        );
        nativeSessions.push(session);
        return { ok: true, value: session };
      },
    );
    const native: HarnessAdapter = {
      harnessId,
      inspect: (input) => nativeFixture.inspect(input),
      open: nativeOpen,
      close: async () => {
        await Promise.all(nativeSessions.map((session) => session.close()));
      },
    };
    const server = await startHarnessBrokerServer({ descriptorPath, socketPath, adapter: native });
    const broker = new BrokeredHarnessAdapter({ harnessId, descriptorPath });
    const wrappers: HarnessSession[] = [];
    const brokerOpen = vi.spyOn(broker, "open").mockImplementation(async (input) => {
      const opened = await BrokeredHarnessAdapter.prototype.open.call(broker, input);
      if (opened.ok) wrappers.push(opened.value);
      return opened;
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const official = new FakeOfficialProcess();
    const mappingStore = new MappingStore({ directory: path.join(root, "mapping") });
    const host = new AppServerHost({
      stockCodexPath: "/synthetic/codex",
      arguments: ["app-server"],
      defaultAgent: "codex",
      desktopInput: input,
      desktopOutput: output,
      diagnosticOutput: new PassThrough(),
      environment: { CODEXHOST_DATA_DIR: path.join(root, "host-data") },
      mappingStore,
      externalAdapters: new Map<ExternalHarnessId, HarnessAdapter>([[harnessId, broker]]),
      spawnOfficial: (() => official) as unknown as typeof spawn,
    });
    const collector = new JsonLineCollector(output);
    const running = host.run();

    try {
      writeRequest(input, {
        id: 1,
        method: "thread/start",
        params: { model: CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID, cwd: root },
      });
      const started = await collector.waitFor((message) => requestId(message, 1));
      const startedThread = (started.result as JsonObject | undefined)?.thread as
        JsonObject | undefined;
      const threadId = startedThread?.id;
      if (typeof threadId !== "string") throw new Error("Host did not return the broker Thread ID");
      const firstWrapper = wrappers[0];
      const firstNative = nativeSessions[0];
      if (!firstWrapper || !firstNative) throw new Error("Broker create did not return a Session");
      const close = vi.spyOn(firstWrapper, "close");

      writeRequest(input, {
        id: 2,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "expired broker login" }] },
      });
      const startedTurn = await collector.waitFor((message) => requestId(message, 2));
      const turnId = (
        (startedTurn.result as JsonObject | undefined)?.turn as JsonObject | undefined
      )?.id;
      if (typeof turnId !== "string") throw new Error("Host did not return the first Turn ID");
      await collector.waitFor((message) => turnEvent(message, "turn/started", turnId));

      firstNative.failTurn({
        code: "authenticationRequired",
        message: "Synthetic broker authentication expired",
        retryable: true,
      });
      await expect(
        collector.waitFor((message) => turnEvent(message, "turn/completed", turnId)),
      ).resolves.toMatchObject({
        params: {
          turn: {
            status: "failed",
            error: { message: "Synthetic broker authentication expired" },
          },
        },
      });
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(
        collector.messages.filter((message) => turnEvent(message, "turn/completed", turnId)),
      ).toHaveLength(1);

      writeRequest(input, {
        id: 3,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "resume after authentication" }] },
      });
      const resumedTurn = await collector.waitFor((message) => requestId(message, 3));
      const resumedTurnId = (
        (resumedTurn.result as JsonObject | undefined)?.turn as JsonObject | undefined
      )?.id;
      if (typeof resumedTurnId !== "string")
        throw new Error("Host did not return the resumed Turn ID");
      await vi.waitFor(() => expect(brokerOpen).toHaveBeenCalledTimes(2));
      expect(brokerOpen).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "resume", nativeRef }),
      );
      const resumedNative = nativeSessions[1];
      if (!resumedNative) throw new Error("Broker did not create a fresh native resume Session");
      await collector.waitFor((message) => turnEvent(message, "turn/started", resumedTurnId));
      resumedNative.succeedTurn();
      await expect(
        collector.waitFor((message) => turnEvent(message, "turn/completed", resumedTurnId)),
      ).resolves.toMatchObject({ params: { turn: { status: "completed" } } });
    } finally {
      input.end();
      await running.catch(() => undefined);
      await broker.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
