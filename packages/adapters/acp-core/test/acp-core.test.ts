import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import { startAcpAgent, withDeadline, type AcpAgentStart } from "../src/index.js";

/** An ACP agent that answers initialize with FIXTURE_VERSION, or never, then exits on request. */
const agent = `#!/usr/bin/env node
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method !== "initialize" || process.env.FIXTURE_SILENT) continue;
    const protocolVersion = Number(process.env.FIXTURE_VERSION);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion, agentCapabilities: {} } }) + "\\n");
    if (process.env.FIXTURE_EXIT_AFTER_INITIALIZE) setTimeout(() => process.exit(3), 50);
  }
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1000);
`;

async function withAgent(
  environment: NodeJS.ProcessEnv,
  run: (start: AcpAgentStart, events: { faults: string[]; spawned: boolean[] }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "acp-core-"));
  const command = path.join(directory, "agent.cjs");
  await writeFile(command, agent);
  await chmod(command, 0o755);
  const events = { faults: [] as string[], spawned: [] as boolean[] };
  let closing = false;
  let child: ChildProcessWithoutNullStreams | undefined;
  const start: AcpAgentStart = {
    label: "Fixture",
    invocation: { command, arguments: [], windowsVerbatimArguments: false },
    cwd: directory,
    environment: { ...environment },
    closeTimeoutMs: 1_000,
    startupTimeoutMs: 2_000,
    clientCapabilities: {},
    client: {
      sessionUpdate: async () => undefined,
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    },
    onSpawned: (spawned) => {
      child = spawned;
      events.spawned.push(true);
    },
    onConnected: () => undefined,
    onStderr: () => undefined,
    closing: () => closing,
    onProcessFault: (message) => events.faults.push(message),
    timedOut: (operation) => new Error(`${operation} timed out`),
    unsupportedProtocol: (version) => new Error(`unsupported protocol ${version}`),
  };
  try {
    await run(start, events);
  } finally {
    closing = true;
    child?.stdin.end();
    child?.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("startAcpAgent", () => {
  it("hands over the owned process before negotiating, then returns the agreement", async () => {
    await withAgent({ FIXTURE_VERSION: String(PROTOCOL_VERSION) }, async (start, events) => {
      const onConnected = vi.fn();
      const initialize = await startAcpAgent({ ...start, onConnected });
      expect(initialize.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(events.spawned).toEqual([true]);
      expect(onConnected).toHaveBeenCalledOnce();
      expect(events.faults).toEqual([]);
    });
  });

  it("refuses an agent that negotiates another protocol version", async () => {
    await withAgent({ FIXTURE_VERSION: "99" }, async (start) => {
      await expect(startAcpAgent(start)).rejects.toThrow("unsupported protocol 99");
    });
  });

  it("reports an agent that exits while the caller is not closing", async () => {
    await withAgent(
      { FIXTURE_VERSION: String(PROTOCOL_VERSION), FIXTURE_EXIT_AFTER_INITIALIZE: "1" },
      async (start, events) => {
        await startAcpAgent(start);
        await vi.waitFor(() =>
          expect(events.faults).toEqual(["Fixture ACP exited (code=3, signal=null)"]),
        );
      },
    );
  });

  it("bounds an initialize the agent never answers", async () => {
    await withAgent({ FIXTURE_SILENT: "1" }, async (start) => {
      await expect(startAcpAgent({ ...start, startupTimeoutMs: 200 })).rejects.toThrow(
        "Fixture ACP initialize timed out",
      );
    });
  });
});

describe("withDeadline", () => {
  it("settles with the promise, or rejects with the caller's error once", async () => {
    await expect(withDeadline(Promise.resolve(7), 1_000, () => new Error("late"))).resolves.toBe(7);
    const timedOut = vi.fn(() => new Error("deadline passed"));
    await expect(withDeadline(new Promise(() => undefined), 20, timedOut)).rejects.toThrow(
      "deadline passed",
    );
    expect(timedOut).toHaveBeenCalledOnce();
  });
});
