import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KiroAcpTransport, type KiroTransportEvent } from "../src/acp-transport.js";
import type * as KiroCommand from "../src/command.js";

/** An in-memory ACP peer that also reports a Session other than its own. */
const peer = vi.hoisted(() => ({ stdin: null as PassThrough | null }));

vi.mock("../src/command.js", async (original) => ({
  ...(await original<typeof KiroCommand>()),
  resolveKiroExecutable: () => process.execPath,
}));

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof ChildProcess>()),
  spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null,
    });
    peer.stdin = child.stdin;
    const send = (message: unknown) => child.stdout.write(JSON.stringify(message) + "\n");
    const chunk = (sessionId: string, text: string) =>
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      });
    let pending = "";
    child.stdin.on("data", (data: Buffer) => {
      pending += data.toString();
      for (;;) {
        const index = pending.indexOf("\n");
        if (index < 0) break;
        const request = JSON.parse(pending.slice(0, index));
        pending = pending.slice(index + 1);
        if (request.id === undefined) continue;
        let result: unknown = {};
        if (request.method === "initialize")
          result = { protocolVersion: 1, authMethods: [], agentCapabilities: {} };
        if (request.method === "session/new") result = { sessionId: "native" };
        if (request.method === "session/load") {
          // Replay of the loaded Session, interleaved with another one.
          chunk("other", "foreign replay");
          chunk("native", "own replay");
          result = {};
        }
        if (request.method === "session/prompt") {
          chunk("other", "foreign");
          chunk("native", "own");
          result = { stopReason: "end_turn" };
        }
        send({ jsonrpc: "2.0", id: request.id, result });
      }
    });
    child.stdin.once("finish", () => {
      child.exitCode = 0;
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", 0, null);
    });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  },
}));

// The in-memory peer has no OS process to own or signal.
vi.mock("@codexhost/harness-discovery", async (importOriginal) => {
  const { spawn } = await import("node:child_process");
  return {
    ...(await importOriginal()),
    spawnOwnedProcess: (command: string, args: readonly string[]) => ({
      child: spawn(command, [...args]),
      tree: { close: async () => undefined },
      anchored: false,
    }),
  };
});

function texts(events: readonly KiroTransportEvent[]): string[] {
  return events.flatMap((event) => (event.type === "agent.text" ? [event.text] : []));
}

let transport: KiroAcpTransport;
beforeEach(() => {
  transport = new KiroAcpTransport({ cwd: process.cwd() });
});
afterEach(async () => {
  await transport.close().catch(() => undefined);
});

describe("Kiro ACP Session updates", () => {
  it("drops a Turn update another Session reports", async () => {
    await transport.open({ kind: "create" });
    const events: KiroTransportEvent[] = [];
    await transport.runTurn(
      "hello",
      (event) => events.push(event),
      async () => ({ outcome: { outcome: "cancelled" } }),
      async () => ({ action: "dismissed" }),
    );
    expect(texts(events)).toEqual(["own"]);
  });

  it("replays only the Session being loaded", async () => {
    const opened = await transport.open({ kind: "resume", sessionId: "native" });
    expect(texts(opened.replay)).toEqual(["own replay"]);
  });
});

describe("Kiro ACP cancellation", () => {
  it("reports a cancellation it could not deliver", async () => {
    await transport.open({ kind: "create" });
    peer.stdin?.destroy();
    await expect(transport.cancel()).rejects.toThrow("could not deliver the cancellation");
  });
});
