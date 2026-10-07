import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  spawnOwnedProcess,
  type OwnedProcess,
  type OwnedProcessTree,
} from "@codexhost/harness-discovery";
import type { Event } from "@opencode-ai/sdk/v2";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { describe, expect, it, vi } from "vitest";

import type { OpenCodeTransportListener } from "../src/protocol.js";
import {
  managedOpenCodeEnvironment,
  OpenCodeServerConnection,
  SdkOpenCodeTransport,
  type OpenCodeServerDependencies,
} from "../src/sdk-transport.js";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid = 91_337;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
}

/** Fakes own no OS process, so their tree must never signal a real pid. */
function owned(
  child: FakeChild,
  tree: OwnedProcessTree = { close: async () => undefined },
): OwnedProcess<ChildProcessWithoutNullStreams> {
  return { child: child as unknown as ChildProcessWithoutNullStreams, tree, anchored: false };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function stopOwnedFixtureGroup(child: ChildProcessWithoutNullStreams | undefined): void {
  if (!child?.pid || process.platform === "win32") return;
  try {
    // Anchored, SIGKILL ends the whole owned group; in the fallback it reaches
    // the leader only, and the caller also kills the fixture's child directly.
    child.kill("SIGKILL");
  } catch (error) {
    // ESRCH: already gone. EPERM: only an unreaped zombie is left.
    const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : null;
    if (code === "ESRCH" || code === "EPERM") return;
    throw error;
  }
}

function clientWith(overrides: Record<string, unknown> = {}): OpencodeClient {
  return {
    global: {
      health: async () => ({ data: { healthy: true, version: "1.18.25" }, error: undefined }),
    },
    ...overrides,
  } as unknown as OpencodeClient;
}

function requiredCwd(cwd: string | undefined): string {
  if (!cwd) throw new Error("Managed Server did not receive a startup directory");
  return cwd;
}

describe("OpenCode SDK transport", () => {
  it("keeps default permissions native and scopes unattended permissions to the supplied Server env", () => {
    const input = {
      PATH: "/synthetic/bin",
      CODEXHOST_THREAD_ID: "thread-child",
      CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1234",
      CODEXHOST_RUNTIME_TOKEN: "runtime-secret",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "provider/model", permission: "ask" }),
    };
    const defaultEnvironment = managedOpenCodeEnvironment(input, "default");
    expect(defaultEnvironment).toEqual(input);
    expect(defaultEnvironment).not.toBe(input);

    const unattendedEnvironment = managedOpenCodeEnvironment(input, "unattended-full-access");
    expect(unattendedEnvironment).toMatchObject({
      PATH: "/synthetic/bin",
      CODEXHOST_THREAD_ID: "thread-child",
      CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1234",
      CODEXHOST_RUNTIME_TOKEN: "runtime-secret",
    });
    expect(JSON.parse(unattendedEnvironment.OPENCODE_CONFIG_CONTENT ?? "{}")).toEqual({
      model: "provider/model",
      permission: "allow",
    });
    expect(input.OPENCODE_CONFIG_CONTENT).toContain('"ask"');
  });

  it("rejects malformed config before enabling unattended execution", () => {
    expect(() =>
      managedOpenCodeEnvironment({ OPENCODE_CONFIG_CONTENT: "not-json" }, "unattended-full-access"),
    ).toThrowError(/valid JSON OPENCODE_CONFIG_CONTENT/);
  });

  it("starts an authenticated loopback Server and restarts after an unexpected exit", async () => {
    const children: FakeChild[] = [];
    const clientOptions: Array<{
      baseUrl: string;
      directory?: string;
      headers: Record<string, string>;
    }> = [];
    const spawnCalls: Array<{
      command: string;
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
    }> = [];
    const dependencies: OpenCodeServerDependencies = {
      createClient: (options) => {
        clientOptions.push(options);
        return clientWith();
      },
      randomPassword: () => "synthetic-password",
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, cwd: options.cwd, env: options.env });
        const child = new FakeChild();
        child.pid += children.length;
        children.push(child);
        queueMicrotask(() => {
          child.stdout.write(
            `opencode server listening on http://127.0.0.1:${4_000 + children.length}\n`,
          );
        });
        return owned(child);
      },
      sleep: async () => undefined,
      assignPort: async () => 41_000 + spawnCalls.length + 1,
    };
    const connection = new OpenCodeServerConnection(
      { command: process.execPath, environment: { PATH: process.env.PATH } },
      dependencies,
    );

    await connection.client("/first");
    expect(spawnCalls).toHaveLength(1);
    const firstSpawn = spawnCalls[0];
    if (!firstSpawn) throw new Error("Managed Server did not spawn");
    expect(firstSpawn).toMatchObject({
      command: process.execPath,
      args: ["serve", "--hostname=127.0.0.1", "--port=41001"],
      env: {
        OPENCODE_SERVER_USERNAME: "codexhost",
        OPENCODE_SERVER_PASSWORD: "synthetic-password",
      },
    });
    expect(path.isAbsolute(requiredCwd(firstSpawn.cwd))).toBe(true);
    expect(requiredCwd(firstSpawn.cwd)).not.toBe("/first");
    expect(existsSync(requiredCwd(firstSpawn.cwd))).toBe(true);
    expect(clientOptions.at(-1)).toMatchObject({
      baseUrl: "http://127.0.0.1:4001",
      directory: "/first",
      headers: {
        Authorization: `Basic ${Buffer.from("codexhost:synthetic-password").toString("base64")}`,
      },
    });

    await connection.client("/second");
    expect(spawnCalls).toHaveLength(1);
    expect(clientOptions.at(-1)).toMatchObject({ directory: "/second" });

    const first = children[0] as FakeChild;
    first.exitCode = 1;
    first.emit("exit", 1, null);
    await connection.client("/second");
    expect(spawnCalls).toHaveLength(2);
    const secondSpawn = spawnCalls[1];
    if (!secondSpawn) throw new Error("Managed Server did not restart");
    expect(existsSync(requiredCwd(firstSpawn.cwd))).toBe(false);
    expect(requiredCwd(secondSpawn.cwd)).not.toBe(requiredCwd(firstSpawn.cwd));
    // A restarted Server gets its own loopback origin, never the previous one.
    expect(secondSpawn.args).toEqual(["serve", "--hostname=127.0.0.1", "--port=41002"]);
    expect(clientOptions.at(-1)).toMatchObject({
      baseUrl: "http://127.0.0.1:4002",
      directory: "/second",
    });

    const second = children[1] as FakeChild;
    second.exitCode = 0;
    await connection.close();
    expect(existsSync(requiredCwd(secondSpawn.cwd))).toBe(false);
  });

  it("retries a Server that exited before startup on a fresh port, at most three times", async () => {
    const ports: string[] = [];
    let nextPort = 42_000;
    const children: FakeChild[] = [];
    const exitEarly = (child: FakeChild): void => {
      child.exitCode = 1;
      child.emit("exit", 1, null);
    };
    const dependencies: OpenCodeServerDependencies = {
      createClient: () => clientWith(),
      randomPassword: () => "synthetic-password",
      spawn: (_command, args, options) => {
        ports.push(args.at(-1) ?? "");
        const child = new FakeChild();
        children.push(child);
        const attempt = children.length;
        // The first two Servers lose their assigned port before binding it.
        queueMicrotask(() =>
          attempt < 3
            ? exitEarly(child)
            : child.stdout.write(`opencode server listening on http://127.0.0.1:${nextPort}\n`),
        );
        return owned(child, {
          close: async () => {
            rmSync(options.cwd, { recursive: true, force: true });
          },
        });
      },
      sleep: async () => undefined,
      assignPort: async () => (nextPort += 1),
    };
    const connection = new OpenCodeServerConnection(
      { command: process.execPath, environment: { PATH: process.env.PATH } },
      dependencies,
    );

    await connection.client("/project");
    expect(ports).toEqual(["--port=42001", "--port=42002", "--port=42003"]);
    const started = children[2];
    if (!started) throw new Error("The third Server did not start");
    started.exitCode = 0;
    await connection.close();

    // A Server that never stays up fails after the third attempt.
    let failedSpawns = 0;
    const failing = new OpenCodeServerConnection(
      { command: process.execPath, environment: { PATH: process.env.PATH } },
      {
        ...dependencies,
        spawn: (_command, _args, options) => {
          failedSpawns += 1;
          const child = new FakeChild();
          queueMicrotask(() => exitEarly(child));
          return owned(child, {
            close: async () => {
              rmSync(options.cwd, { recursive: true, force: true });
            },
          });
        },
      },
    );
    await expect(failing.client("/project")).rejects.toMatchObject({ code: "processExited" });
    expect(failedSpawns).toBe(3);
  });

  it("keeps one Server owner when a caller arrives while a startup retries", async () => {
    const children: FakeChild[] = [];
    const closedTrees: number[] = [];
    let releaseFirstCleanup!: () => void;
    const firstCleanup = new Promise<void>((resolve) => {
      releaseFirstCleanup = resolve;
    });
    let port = 44_000;
    const connection = new OpenCodeServerConnection(
      { command: process.execPath, environment: { PATH: process.env.PATH } },
      {
        createClient: () => clientWith(),
        randomPassword: () => "synthetic-password",
        spawn: (_command, _args, options) => {
          const child = new FakeChild();
          const index = children.length;
          children.push(child);
          queueMicrotask(() => {
            if (index === 0) {
              // The first Server loses its port and exits before startup.
              child.exitCode = 1;
              child.emit("exit", 1, null);
            } else {
              child.stdout.write(`opencode server listening on http://127.0.0.1:${port}\n`);
            }
          });
          return owned(child, {
            close: async () => {
              // The first exited Server's group takes a while to be confirmed gone.
              if (index === 0) await firstCleanup;
              closedTrees.push(index);
              rmSync(options.cwd, { recursive: true, force: true });
            },
          });
        },
        sleep: async () => undefined,
        assignPort: async () => (port += 1),
      },
    );

    const first = connection.client("/first");
    await vi.waitFor(() => expect(children).toHaveLength(1));
    await vi.waitFor(() => expect(children[0]?.exitCode).toBe(1));
    // A second caller during the retry joins the pending startup instead of starting a Server.
    const second = connection.client("/second");
    releaseFirstCleanup();
    await Promise.all([first, second]);
    expect(children).toHaveLength(2);

    const started = children[1];
    if (!started) throw new Error("The retried Server did not start");
    started.exitCode = 0;
    await connection.close();
    // Every Server this connection spawned was stopped by it.
    expect(closedTrees.sort()).toEqual([0, 1]);
  });

  it("starts no Server once closed while its port is being assigned", async () => {
    let spawns = 0;
    let releasePort!: (port: number) => void;
    const connection = new OpenCodeServerConnection(
      { command: process.execPath, environment: { PATH: process.env.PATH } },
      {
        createClient: () => clientWith(),
        randomPassword: () => "synthetic-password",
        spawn: () => {
          spawns += 1;
          return owned(new FakeChild());
        },
        sleep: async () => undefined,
        assignPort: () =>
          new Promise<number>((resolve) => {
            releasePort = resolve;
          }),
      },
    );

    const starting = connection.client("/project");
    await vi.waitFor(() => expect(releasePort).toBeDefined());
    await connection.close();
    releasePort(45_001);
    await expect(starting).rejects.toMatchObject({ code: "unavailable" });
    expect(spawns).toBe(0);
  });

  it("stops retrying once closed while an exited Server is cleaned up", async () => {
    let spawns = 0;
    let ports = 0;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const connection = new OpenCodeServerConnection(
      { command: process.execPath, environment: { PATH: process.env.PATH } },
      {
        createClient: () => clientWith(),
        randomPassword: () => "synthetic-password",
        spawn: (_command, _args, options) => {
          spawns += 1;
          const child = new FakeChild();
          queueMicrotask(() => {
            child.exitCode = 1;
            child.emit("exit", 1, null);
          });
          return owned(child, {
            close: async () => {
              await cleanup;
              rmSync(options.cwd, { recursive: true, force: true });
            },
          });
        },
        sleep: async () => undefined,
        assignPort: async () => {
          ports += 1;
          return 46_000 + ports;
        },
      },
    );

    const starting = connection.client("/project");
    await vi.waitFor(() => expect(spawns).toBe(1));
    const closing = connection.close();
    releaseCleanup();
    await closing;
    await expect(starting).rejects.toMatchObject({ code: "unavailable" });
    // The closed connection asks for no further port, let alone another Server.
    expect(ports).toBe(1);
    expect(spawns).toBe(1);
  });

  it("reports a loopback port that cannot be assigned as unavailable", async () => {
    let spawns = 0;
    const connection = new OpenCodeServerConnection(
      { command: process.execPath, environment: { PATH: process.env.PATH } },
      {
        createClient: () => clientWith(),
        randomPassword: () => "synthetic-password",
        spawn: () => {
          spawns += 1;
          return owned(new FakeChild());
        },
        sleep: async () => undefined,
        assignPort: async () => {
          throw new Error("no loopback port");
        },
      },
    );

    await expect(connection.client("/project")).rejects.toMatchObject({
      code: "unavailable",
      message: "OpenCode Server could not get a loopback port",
    });
    expect(spawns).toBe(0);
  });

  it("never retries a Server whose exited process group could not be confirmed gone", async () => {
    let spawns = 0;
    let serverCwd: string | undefined;
    const connection = new OpenCodeServerConnection(
      { command: process.execPath, environment: { PATH: process.env.PATH } },
      {
        createClient: () => clientWith(),
        randomPassword: () => "synthetic-password",
        spawn: (_command, _args, options) => {
          spawns += 1;
          serverCwd = options.cwd;
          const child = new FakeChild();
          queueMicrotask(() => {
            child.exitCode = 1;
            child.emit("exit", 1, null);
          });
          return owned(child, {
            close: async () => {
              throw new Error("process group is still alive");
            },
          });
        },
        sleep: async () => undefined,
        assignPort: async () => 43_001,
      },
    );

    await expect(connection.client("/project")).rejects.toMatchObject({
      code: "processExited",
      message: expect.stringContaining("process cleanup also failed"),
    });
    // Starting another Server while this one may still run would leave two owners.
    expect(spawns).toBe(1);
    // The unconfirmed cleanup keeps the startup directory; the test removes it.
    if (serverCwd) rmSync(serverCwd, { recursive: true, force: true });
  });

  it("restarts a Server that exited while its health check was answered", async () => {
    const children: FakeChild[] = [];
    let answerFirstHealth!: () => void;
    const firstHealth = new Promise<void>((resolve) => {
      answerFirstHealth = resolve;
    });
    const baseUrls: string[] = [];
    let port = 47_000;
    const connection = new OpenCodeServerConnection(
      { command: process.execPath, environment: { PATH: process.env.PATH } },
      {
        createClient: (options) => {
          baseUrls.push(options.baseUrl);
          const first = baseUrls.length === 1;
          return clientWith({
            global: {
              health: async () => {
                // The first Server answers its health check, then is already gone.
                if (first) await firstHealth;
                return { data: { healthy: true, version: "1.18.25" }, error: undefined };
              },
            },
          });
        },
        randomPassword: () => "synthetic-password",
        spawn: (_command, _args, options) => {
          const child = new FakeChild();
          children.push(child);
          queueMicrotask(() =>
            child.stdout.write(`opencode server listening on http://127.0.0.1:${port}\n`),
          );
          return owned(child, {
            close: async () => {
              rmSync(options.cwd, { recursive: true, force: true });
            },
          });
        },
        sleep: async () => undefined,
        assignPort: async () => (port += 1),
      },
    );

    const client = connection.client("/project");
    await vi.waitFor(() => expect(baseUrls).toHaveLength(1));
    const first = children[0];
    if (!first) throw new Error("The first Server did not start");
    first.exitCode = 1;
    first.emit("exit", 1, null);
    answerFirstHealth();
    await client;
    // The dead Server was not handed out: the startup retried on a fresh Server.
    expect(children).toHaveLength(2);
    await connection.client("/project");
    expect(children).toHaveLength(2);
    const started = children[1];
    if (!started) throw new Error("The retried Server did not start");
    started.exitCode = 0;
    await connection.close();
  });

  it("starts outside a read-only project and forwards even a missing project directory", async () => {
    const project = mkdtempSync(path.join(tmpdir(), "codexhost-opencode-project-"));
    const missingProject = path.join(project, "missing");
    const clientDirectories: Array<string | undefined> = [];
    const child = new FakeChild();
    let serverCwd: string | undefined;
    const connection = new OpenCodeServerConnection(
      { command: process.execPath },
      {
        createClient: (options) => {
          clientDirectories.push(options.directory);
          return clientWith();
        },
        randomPassword: () => "synthetic-password",
        spawn: (_command, _args, options) => {
          serverCwd = options.cwd;
          queueMicrotask(() => {
            child.stdout.write("opencode server listening on http://127.0.0.1:4013\n");
          });
          return owned(child);
        },
        sleep: async () => undefined,
      },
    );
    try {
      chmodSync(project, 0o555);
      await connection.client(project);
      await connection.client(missingProject);
      expect(serverCwd).toBeDefined();
      expect(serverCwd).not.toBe(project);
      expect(serverCwd).not.toBe(missingProject);
      expect(existsSync(requiredCwd(serverCwd))).toBe(true);
      expect(clientDirectories).toEqual([undefined, project, missingProject]);
    } finally {
      await connection.close();
      chmodSync(project, 0o755);
      rmSync(project, { recursive: true });
    }
    expect(existsSync(requiredCwd(serverCwd))).toBe(false);
  });

  it("allows a later retry after startup fails before a child is available", async () => {
    let attempts = 0;
    const startupDirectories: string[] = [];
    const child = new FakeChild();
    const dependencies: OpenCodeServerDependencies = {
      createClient: () => clientWith(),
      randomPassword: () => "synthetic-password",
      spawn: (_command, _args, options) => {
        attempts += 1;
        startupDirectories.push(options.cwd);
        if (attempts === 1) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        queueMicrotask(() => {
          child.stdout.write("opencode server listening on http://127.0.0.1:4010\n");
        });
        return owned(child);
      },
      sleep: async () => undefined,
    };
    const connection = new OpenCodeServerConnection(
      { command: process.execPath, environment: { PATH: process.env.PATH } },
      dependencies,
    );

    await expect(connection.client()).rejects.toMatchObject({ code: "notInstalled" });
    expect(existsSync(requiredCwd(startupDirectories[0]))).toBe(false);
    await expect(connection.client()).resolves.toBeDefined();
    expect(attempts).toBe(2);
    expect(startupDirectories[1]).not.toBe(startupDirectories[0]);
    child.exitCode = 0;
    await connection.close();
    expect(existsSync(requiredCwd(startupDirectories[1]))).toBe(false);
  });

  it("bounds a stalled Server health check and releases its managed child", async () => {
    const child = new FakeChild();
    let serverCwd: string | undefined;
    const connection = new OpenCodeServerConnection(
      {
        command: process.execPath,
        environment: { PATH: process.env.PATH },
        startupTimeoutMs: 20,
        closeTimeoutMs: 20,
      },
      {
        createClient: () =>
          clientWith({ global: { health: async () => await new Promise<never>(() => undefined) } }),
        randomPassword: () => "synthetic-password",
        spawn: (_command, _args, options) => {
          serverCwd = options.cwd;
          queueMicrotask(() => {
            child.stdout.write("opencode server listening on http://127.0.0.1:4011\n");
          });
          return owned(child);
        },
        sleep: async () => undefined,
      },
    );

    await expect(connection.client()).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringMatching(/health check timed out/),
    });
    await expect(connection.close()).resolves.toBeUndefined();
    expect(existsSync(requiredCwd(serverCwd))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "escalates from SIGTERM to SIGKILL until the owned Server process group is gone",
    async () => {
      const fixturePath = path.join(import.meta.dirname, "fixtures", "process-group-server.mjs");
      let server: ChildProcessWithoutNullStreams | undefined;
      let fixtureChildPid: number | undefined;
      const connection = new OpenCodeServerConnection(
        {
          command: process.execPath,
          environment: { PATH: process.env.PATH },
          closeTimeoutMs: 200,
        },
        {
          createClient: () => clientWith(),
          randomPassword: () => "synthetic-password",
          spawn: (_command, _args, options) => {
            const process_ = spawnOwnedProcess(process.execPath, [fixturePath], options);
            server = process_.child;
            server.stdout.on("data", (chunk: Buffer | string) => {
              const match = chunk.toString().match(/fixture-child-pid=(\d+)/u);
              if (match?.[1]) fixtureChildPid = Number(match[1]);
            });
            return process_;
          },
          sleep: async () => undefined,
        },
      );

      try {
        await connection.client();
        await vi.waitFor(() => expect(fixtureChildPid).toBeTypeOf("number"));
        const childPid = fixtureChildPid;
        if (!childPid) throw new Error("Fixture child process id was not reported");
        expect(isAlive(childPid)).toBe(true);

        await expect(connection.close()).resolves.toBeUndefined();
        await vi.waitFor(() => expect(isAlive(childPid)).toBe(false), { timeout: 1_000 });
      } finally {
        stopOwnedFixtureGroup(server);
        if (fixtureChildPid && isAlive(fixtureChildPid)) process.kill(fixtureChildPid, "SIGKILL");
      }
    },
  );

  it("keeps Server admission closed while its process tree cannot be released", async () => {
    const child = new FakeChild();
    let serverCwd: string | undefined;
    let failures = 0;
    const release = vi.fn(async () => {
      if (failures++ < 2) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    });
    const connection = new OpenCodeServerConnection(
      { command: process.execPath, environment: { PATH: process.env.PATH }, closeTimeoutMs: 20 },
      {
        createClient: () => clientWith(),
        randomPassword: () => "synthetic-password",
        spawn: (_command, _args, options) => {
          serverCwd = options.cwd;
          queueMicrotask(() => {
            child.stdout.write("opencode server listening on http://127.0.0.1:4012\n");
          });
          return owned(child, { close: release });
        },
        sleep: async () => undefined,
      },
    );
    await connection.client();
    await expect(connection.close()).rejects.toMatchObject({ code: "EPERM" });
    await expect(connection.client()).rejects.toMatchObject({ code: "unavailable" });
    expect(existsSync(requiredCwd(serverCwd))).toBe(true);
    // The owned tree is asked again rather than a bare pid being guessed at.
    await expect(connection.close()).rejects.toMatchObject({ code: "EPERM" });
    expect(release).toHaveBeenCalledTimes(2);
    await expect(connection.close()).resolves.toBeUndefined();
    expect(existsSync(requiredCwd(serverCwd))).toBe(false);
  });

  it("checks SDK result errors while accepting the prompt_async 204 payload", async () => {
    const promptAsync = vi
      .fn()
      .mockResolvedValueOnce({ data: undefined, error: undefined })
      .mockResolvedValueOnce({ data: undefined, error: { message: "synthetic rejection" } });
    const connection = {
      stderrTail: "",
      client: async () => clientWith({ session: { promptAsync } }),
      close: async () => undefined,
    };
    const transport = new SdkOpenCodeTransport(connection, "/synthetic", { commandTimeoutMs: 100 });
    const input = { sessionID: "session-1", text: "hello" };

    await expect(transport.promptAsync(input)).resolves.toBeUndefined();
    expect(promptAsync).toHaveBeenNthCalledWith(
      1,
      expect.not.objectContaining({ messageID: expect.anything() }),
    );
    await expect(transport.promptAsync(input)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("lists native metadata and executes slash commands through the dedicated SDK endpoint", async () => {
    const list = vi.fn().mockResolvedValue({
      data: [{ name: "review", source: "command", template: "Review", hints: [] }],
      error: undefined,
    });
    const command = vi.fn().mockResolvedValue({
      data: {
        info: { id: "assistant-1", parentID: "user-1", sessionID: "session-1", role: "assistant" },
        parts: [],
      },
      error: undefined,
    });
    const transport = new SdkOpenCodeTransport(
      {
        stderrTail: "",
        client: async () => clientWith({ command: { list }, session: { command } }),
        close: async () => undefined,
      },
      "/synthetic",
      { commandTimeoutMs: 100 },
    );
    await expect(transport.commands()).resolves.toMatchObject([{ name: "review" }]);
    expect(list).toHaveBeenCalledWith({ directory: "/synthetic" }, {});
    await expect(
      transport.executeCommand({
        sessionID: "session-1",
        command: "review",
        arguments: " security ",
        model: { providerID: "provider", modelID: "model" },
      }),
    ).resolves.toMatchObject({ info: { id: "assistant-1" } });
    expect(command).toHaveBeenCalledWith(
      {
        sessionID: "session-1",
        command: "review",
        arguments: " security ",
        model: "provider/model",
      },
      {},
    );
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      transport.executeCommand({
        sessionID: "session-1",
        command: "review",
        arguments: "",
        signal: cancelled.signal,
      }),
    ).rejects.toMatchObject({ code: "invalidState" });
    expect(command).toHaveBeenCalledOnce();
  });

  it("updates Session metadata through the SDK", async () => {
    const update = vi.fn().mockResolvedValue({ data: { id: "session-1" }, error: undefined });
    const connection = {
      stderrTail: "",
      client: async () => clientWith({ session: { update } }),
      close: async () => undefined,
    };
    const transport = new SdkOpenCodeTransport(connection, "/synthetic", { commandTimeoutMs: 100 });

    await expect(
      transport.updateSessionMetadata("session-1", { "codexhost.selection.v1": { modelID: "m" } }),
    ).resolves.toMatchObject({ id: "session-1" });
    expect(update).toHaveBeenCalledWith({
      sessionID: "session-1",
      metadata: { "codexhost.selection.v1": { modelID: "m" } },
    });
  });

  it("creates and updates Session permissions through the SDK", async () => {
    const create = vi.fn().mockResolvedValue({ data: { id: "session-1" }, error: undefined });
    const update = vi.fn().mockResolvedValue({ data: { id: "session-1" }, error: undefined });
    const connection = {
      stderrTail: "",
      client: async () => clientWith({ session: { create, update } }),
      close: async () => undefined,
    };
    const transport = new SdkOpenCodeTransport(connection, "/synthetic", { commandTimeoutMs: 100 });
    const ask = [{ permission: "*", pattern: "*", action: "ask" }] as const;
    const allow = [{ permission: "*", pattern: "*", action: "allow" }] as const;

    await transport.createSession({ permission: [...ask] });
    await transport.updateSessionPermission("session-1", [...allow]);
    expect(create).toHaveBeenCalledWith({ permission: ask });
    expect(update).toHaveBeenCalledWith({ sessionID: "session-1", permission: allow });
  });

  it("fails closed when a data-bearing SDK response omits data", async () => {
    const connection = {
      stderrTail: "",
      client: async () =>
        clientWith({
          global: { health: async () => ({ data: undefined, error: undefined }) },
        }),
      close: async () => undefined,
    };
    const transport = new SdkOpenCodeTransport(connection, "/synthetic", { commandTimeoutMs: 100 });

    await expect(transport.health()).rejects.toMatchObject({ code: "protocolError" });
  });

  it("reconnects the SSE stream and emits a new server.connected boundary", async () => {
    let subscriptions = 0;
    const event = {
      subscribe: async (_input: unknown, options: { signal: AbortSignal }) => {
        subscriptions += 1;
        const ordinal = subscriptions;
        return {
          stream: (async function* (): AsyncGenerator<Event> {
            yield { id: `connected-${ordinal}`, type: "server.connected", properties: {} };
            if (ordinal === 1) return;
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          })(),
        };
      },
    };
    const connection = {
      stderrTail: "",
      client: async () => clientWith({ event }),
      close: async () => undefined,
    };
    const transport = new SdkOpenCodeTransport(connection, "/synthetic", {
      commandTimeoutMs: 100,
      reconnectAttempts: 2,
      reconnectDelayMs: 1,
    });
    const events: Event[] = [];
    const listener: OpenCodeTransportListener = {
      onEvent: (next) => events.push(next),
      onFault: vi.fn(),
    };

    await transport.subscribe(listener);
    await vi.waitFor(() =>
      expect(events.map(({ id }) => id)).toEqual(["connected-1", "connected-2"]),
    );
    expect(subscriptions).toBe(2);
    expect(listener.onFault).not.toHaveBeenCalled();
    await transport.close();
  });

  it("bounds a non-cooperative SSE shutdown, rejects late work, and permits a drain retry", async () => {
    let releaseSubscription: (() => void) | undefined;
    const subscribe = vi.fn(
      () =>
        new Promise<{ stream: AsyncIterable<Event> }>((resolve) => {
          releaseSubscription = () => resolve({ stream: (async function* () {})() });
        }),
    );
    const connection = {
      stderrTail: "",
      client: async () => clientWith({ event: { subscribe } }),
      close: async () => undefined,
    };
    const transport = new SdkOpenCodeTransport(connection, "/synthetic", { closeTimeoutMs: 20 });
    await transport.subscribe({ onEvent: vi.fn(), onFault: vi.fn() });

    await expect(transport.close()).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringMatching(/event stream shutdown timed out/),
    });
    await expect(transport.health()).rejects.toMatchObject({ code: "invalidState" });
    releaseSubscription?.();
    await expect(transport.close()).resolves.toBeUndefined();
  });
});
