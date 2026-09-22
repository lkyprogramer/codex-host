import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";

import { GrokAcpTransport } from "../src/acp-transport.js";

const groups: number[] = [];

function groupState(pid: number): "alive" | "exiting" | "gone" {
  try {
    process.kill(-pid, 0);
    return "alive";
  } catch (error) {
    const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : null;
    if (code === "ESRCH") return "gone";
    // EPERM means the group is down to an unreaped zombie: not alive, not yet
    // released by the kernel.
    if (code === "EPERM") return "exiting";
    throw error;
  }
}

function killGroup(pid: number): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: already gone. EPERM: only a zombie remains.
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
process.on("SIGTERM", () => {
  fs.appendFileSync(log, "sigterm\\n");
  process.exit(0);
});
process.stdin.on("end", () => {
  fs.appendFileSync(log, "stdin-end\\n");
  process.exit(0);
});
setInterval(() => {}, 1000);
`;

async function trackFixtureGroup(logPath: string): Promise<void> {
  const leader = recorded(await readFile(logPath, "utf8").catch(() => "")).leader;
  if (leader) groups.push(leader);
}

async function startFixture(overrides: { closeTimeoutMs?: number } = {}): Promise<{
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
    closeTimeoutMs: overrides.closeTimeoutMs ?? 1_000,
    commandTimeoutMs: 5_000,
    environment: {
      ...process.env,
      HOME: directory,
      GROK_FIXTURE_LOG: logPath,
    },
  });
  return { directory, logPath, transport };
}

function recorded(log: string): {
  methods: string[];
  leader: number;
  child: number;
  signals: string[];
} {
  const methods: string[] = [];
  const signals: string[] = [];
  let leader = 0;
  let child = 0;
  for (const line of log.split("\n")) {
    if (line.startsWith("method ")) methods.push(line.slice("method ".length));
    if (line.startsWith("leader ")) leader = Number(line.slice("leader ".length));
    if (line.startsWith("child ")) child = Number(line.slice("child ".length));
    if (line === "sigterm" || line === "stdin-end") signals.push(line);
  }
  return { methods, leader, child, signals };
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
        expect(groupState(before.leader)).toBe("alive");
        await transport.releaseOwnedProcess();
        await expect.poll(() => groupState(before.leader), { timeout: 2_000 }).toBe("gone");
        await expect
          .poll(() => spawnSync("ps", ["-p", String(before.child), "-o", "pid="]).status, {
            timeout: 1_000,
          })
          .not.toBe(0);
        const after = recorded(await readFile(logPath, "utf8"));
        expect(after.methods).toContain("initialize");
        expect(after.methods).toContain("session/new");
        expect(after.methods).not.toContain("session/close");
        expect(after.methods.filter((method) => method.includes("delete"))).toEqual([]);
        // The leader finishes on stdin EOF inside its bounded window, so its
        // Native Session files are never interrupted by a signal.
        expect(after.signals).toEqual(["stdin-end"]);
      } finally {
        await trackFixtureGroup(logPath);
        await transport.close().catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "retries a failed idle release and confirms the same spawn group",
    async () => {
      const { directory, logPath, transport } = await startFixture({ closeTimeoutMs: 0 });
      try {
        await transport.open({
          kind: "create",
          permissionModeId: harnessPermissionModeIdSchema.parse("ask"),
        });
        const before = recorded(await readFile(logPath, "utf8"));
        groups.push(before.leader);
        // A zero budget observes no exit, so the first release fails even
        // though it already escalated to SIGKILL.
        await expect(transport.releaseOwnedProcess()).rejects.toThrow();
        await expect.poll(() => groupState(before.leader), { timeout: 2_000 }).toBe("gone");
        // The tracker refuses to be replayed, so the retry has to prove the
        // same spawn is gone by identity instead of reporting unknown forever.
        await expect(transport.releaseOwnedProcess()).resolves.toBeUndefined();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "confirms the owned group itself when a close already ran",
    async () => {
      const { directory, logPath, transport } = await startFixture();
      try {
        await transport.open({
          kind: "create",
          permissionModeId: harnessPermissionModeIdSchema.parse("ask"),
        });
        const before = recorded(await readFile(logPath, "utf8"));
        groups.push(before.leader);
        // A close tolerates an unconfirmed tree. A release that rides on it
        // must still probe the owned group instead of inheriting that result.
        await transport.close();
        const kill = vi.spyOn(process, "kill");
        let probes: unknown[][] = [];
        try {
          await expect(transport.releaseOwnedProcess()).resolves.toBeUndefined();
          probes = kill.mock.calls.filter(([target]) => target === -before.leader);
        } finally {
          kill.mockRestore();
        }
        expect(probes.length).toBeGreaterThan(0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("refuses to report an idle release without an owned process", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "grok-idle-unowned-"));
    const transport = new GrokAcpTransport({ cwd: directory, closeTimeoutMs: 100 });
    try {
      // Nothing was spawned, so there is no owned process to account for.
      await expect(transport.releaseOwnedProcess()).rejects.toThrow(/ownership handle/);
      await expect(transport.close()).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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
        await transport.close();
        await expect.poll(() => groupState(before.leader), { timeout: 2_000 }).toBe("gone");
        expect(recorded(await readFile(logPath, "utf8")).methods).toContain("session/close");
      } finally {
        await trackFixtureGroup(logPath);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
