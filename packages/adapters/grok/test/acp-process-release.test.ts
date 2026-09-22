import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";

import { GrokAcpTransport } from "../src/acp-transport.js";

const groups: number[] = [];

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ESRCH") {
      return;
    }
    throw error;
  }
}

const fixture = `#!/usr/bin/env node

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const log = process.env.GROK_FIXTURE_LOG;
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"], { stdio: "ignore" });
fs.appendFileSync(log, "leader " + process.pid + "\\n");
fs.appendFileSync(log, "child " + child.pid + "\\n");
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
    if (typeof message.method === "string") fs.appendFileSync(log, "method " + message.method + "\\n");
    if (message.id === undefined) continue;
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
      : message.method === "session/new" || message.method === "session/load"
        ? { sessionId: "fixture-session" }
        : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;

async function startFixture(): Promise<{
  directory: string;
  logPath: string;
  transport: GrokAcpTransport;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-idle-"));
  const logPath = path.join(directory, "methods.log");
  const command = path.join(directory, "grok-fixture.cjs");
  await writeFile(logPath, "");
  await writeFile(command, fixture);
  await chmod(command, 0o755);
  const transport = new GrokAcpTransport({
    command,
    cwd: directory,
    closeTimeoutMs: 300,
    commandTimeoutMs: 5_000,
    environment: {
      ...process.env,
      HOME: directory,
      GROK_FIXTURE_LOG: logPath,
    },
  });
  return { directory, logPath, transport };
}

function recorded(log: string): { methods: string[]; leader: number; child: number } {
  const methods: string[] = [];
  let leader = 0;
  let child = 0;
  for (const line of log.split("\n")) {
    if (line.startsWith("method ")) methods.push(line.slice("method ".length));
    if (line.startsWith("leader ")) leader = Number(line.slice("leader ".length));
    if (line.startsWith("child ")) child = Number(line.slice("child ".length));
  }
  return { methods, leader, child };
}

describe("Grok owned process release", () => {
  afterEach(() => {
    for (const pid of groups.splice(0)) killGroup(pid);
  });

  it.skipIf(process.platform === "win32")(
    "idle release reaps the process group without session/close",
    async () => {
      const { directory, logPath, transport } = await startFixture();
      try {
        const opened = await transport.open({
          kind: "create",
          permissionModeId: harnessPermissionModeIdSchema.parse("ask"),
        });
        expect(opened.sessionId).toBe("fixture-session");
        const before = recorded(await readFile(logPath, "utf8"));
        groups.push(before.leader);
        expect(groupAlive(before.leader)).toBe(true);
        await transport.releaseOwnedProcess();
        await expect.poll(() => groupAlive(before.leader), { timeout: 1_000 }).toBe(false);
        await expect
          .poll(() => spawnSync("ps", ["-p", String(before.child), "-o", "pid="]).status, {
            timeout: 1_000,
          })
          .not.toBe(0);
        const after = recorded(await readFile(logPath, "utf8"));
        expect(after.methods).toContain("initialize");
        expect(after.methods).toContain("session/new");
        expect(after.methods).not.toContain("session/close");
      } finally {
        await transport.close().catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "explicit close still sends session/close and reaps the group",
    async () => {
      const { directory, logPath, transport } = await startFixture();
      try {
        await transport.open({
          kind: "create",
          permissionModeId: harnessPermissionModeIdSchema.parse("ask"),
        });
        const before = recorded(await readFile(logPath, "utf8"));
        groups.push(before.leader);
        await transport.close();
        expect(groupAlive(before.leader)).toBe(false);
        expect(recorded(await readFile(logPath, "utf8")).methods).toContain("session/close");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
