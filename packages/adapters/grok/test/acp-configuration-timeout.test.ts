import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { GrokAcpTransport, type GrokTransportError } from "../src/acp-transport.js";

/** An ACP agent that never answers the methods named in GROK_FIXTURE_SILENT. */
const fixture = `#!/usr/bin/env node
const silent = new Set((process.env.GROK_FIXTURE_SILENT || "").split(","));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined || silent.has(message.method)) continue;
    const result = message.method === "initialize"
      ? {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { close: true } },
          _meta: {
            modelState: {
              currentModelId: "grok-4.6",
              availableModels: [{ modelId: "grok-4.6", name: "Grok 4.6" }],
            },
          },
        }
      : message.method === "session/new"
        ? { sessionId: "fixture-session" }
        : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1000);
`;

async function withSilentAgent(
  silent: string,
  run: (transport: GrokAcpTransport, faults: GrokTransportError[]) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-config-timeout-"));
  const command = path.join(directory, "grok-fixture.cjs");
  await writeFile(command, fixture);
  await chmod(command, 0o755);
  const faults: GrokTransportError[] = [];
  const transport = new GrokAcpTransport({
    command,
    cwd: directory,
    commandTimeoutMs: 1_500,
    closeTimeoutMs: 500,
    environment: { ...process.env, HOME: directory, GROK_FIXTURE_SILENT: silent },
    onFault: (error) => faults.push(error),
  });
  try {
    await transport.open({
      kind: "create",
      permissionModeId: harnessPermissionModeIdSchema.parse("ask"),
    });
    await run(transport, faults);
  } finally {
    await transport.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("Grok configuration writes", () => {
  it("retires the connection when a Model write never answers", async () => {
    await withSilentAgent("session/set_model", async (transport, faults) => {
      await expect(transport.setModel("grok-4.6")).rejects.toThrow("timed out");
      await vi.waitFor(() => expect(faults).toHaveLength(1));
      expect(faults[0]).toMatchObject({ kind: "processExited" });
      expect(faults[0]?.message).toContain("the connection is retired");
    });
  });

  it("retires the connection when a Session mode write never answers", async () => {
    await withSilentAgent("session/set_mode", async (transport, faults) => {
      await expect(transport.setSessionMode("plan")).rejects.toThrow("timed out");
      await vi.waitFor(() => expect(faults).toHaveLength(1));
    });
  });
});
