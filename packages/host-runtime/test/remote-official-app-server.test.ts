import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  createLoopbackOfficialAppServerListener,
  createRemoteOfficialAppServerListener,
  remoteOfficialAppServerSocketPath,
} from "../src/remote-official-app-server.js";

class FakeOfficialListenerProcess extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  });
}

class StubbornOfficialListenerProcess extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((signal?: NodeJS.Signals) => {
    if (signal === "SIGKILL") queueMicrotask(() => this.emit("exit", null, "SIGKILL"));
    return true;
  });
}

async function privateSocket(socketPath: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return server;
}

function fakeRemoteListener(socketPath: string, waitUntilReady?: () => Promise<void>) {
  const child = new FakeOfficialListenerProcess();
  const spawnOfficial = vi.fn(
    () => child as unknown as ReturnType<typeof spawn> & ChildProcess,
  ) as unknown as typeof spawn;
  const listener = createRemoteOfficialAppServerListener({
    stockCodexPath: "/synthetic/codex",
    arguments: ["app-server", "--listen", `unix://${socketPath}`],
    socketPath,
    environment: { PATH: "/usr/bin" },
    diagnosticOutput: new PassThrough(),
    spawnOfficial,
    ...(waitUntilReady ? { waitUntilReady } : {}),
  });
  return { child, listener, spawnOfficial };
}

describe("shared remote official app-server", () => {
  it("uses a private sibling socket distinct from the Desktop control socket", () => {
    expect(
      remoteOfficialAppServerSocketPath(
        "/Users/developer/.codex/app-server-control/app-server-control.sock",
        "fixture1234",
      ),
    ).toBe("/Users/developer/.codex/app-server-control/.c-fixture1234.sock");
  });

  it("keeps the private sibling basename within the public socket path budget", () => {
    const publicSocket = "/Users/developer/.codex/app-server-control/app-server-control.sock";
    const privateSocket = remoteOfficialAppServerSocketPath(
      publicSocket,
      "12345678-1234-1234-1234-123456789abc",
    );

    expect(Buffer.byteLength(path.posix.basename(privateSocket))).toBeLessThanOrEqual(
      Buffer.byteLength(path.posix.basename(publicSocket)),
    );
  });

  it("starts one listener and keeps it alive until the remote Host closes", async () => {
    const child = new FakeOfficialListenerProcess();
    const spawnOfficial = vi.fn(
      () => child as unknown as ReturnType<typeof spawn> & ChildProcess,
    ) as unknown as typeof spawn;
    const waitUntilReady = vi.fn(async () => undefined);
    const listener = createRemoteOfficialAppServerListener({
      stockCodexPath: "/synthetic/codex",
      arguments: ["app-server", "--listen", "unix:///tmp/codexhost-official.sock"],
      socketPath: "/tmp/codexhost-official.sock",
      environment: { PATH: "/usr/bin" },
      diagnosticOutput: new PassThrough(),
      spawnOfficial,
      waitUntilReady,
    });

    await listener.listen();
    await listener.listen();

    expect(spawnOfficial).toHaveBeenCalledTimes(1);
    expect(spawnOfficial).toHaveBeenCalledWith(
      "/synthetic/codex",
      ["app-server", "--listen", "unix:///tmp/codexhost-official.sock"],
      expect.objectContaining({
        env: { PATH: "/usr/bin" },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      }),
    );
    expect(waitUntilReady).toHaveBeenCalledWith(
      "/tmp/codexhost-official.sock",
      expect.any(Promise),
    );
    expect(child.kill).not.toHaveBeenCalled();

    await listener.close();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(listener.closed).resolves.toEqual({ code: null, signal: "SIGTERM" });
  });

  it("escalates shutdown when the official listener ignores SIGTERM", async () => {
    const child = new StubbornOfficialListenerProcess();
    const listener = createRemoteOfficialAppServerListener({
      stockCodexPath: "/synthetic/codex",
      arguments: ["app-server", "--listen", "unix:///tmp/codexhost-official.sock"],
      socketPath: "/tmp/codexhost-official.sock",
      environment: { PATH: "/usr/bin" },
      diagnosticOutput: new PassThrough(),
      spawnOfficial: vi.fn(
        () => child as unknown as ReturnType<typeof spawn> & ChildProcess,
      ) as unknown as typeof spawn,
      waitUntilReady: vi.fn(async () => undefined),
      closeTimeoutMs: 1,
    });

    await listener.listen();
    await listener.close();

    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(listener.closed).resolves.toEqual({ code: null, signal: "SIGKILL" });
  });

  const unixIt = process.platform === "win32" ? it.skip : it;

  unixIt("does not spawn if close wins while the initial path check is pending", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codexhost-official-"));
    try {
      const { listener, spawnOfficial } = fakeRemoteListener(path.join(directory, "pending.sock"));
      const listening = listener.listen();
      await listener.close();

      await expect(listening).rejects.toThrow("already closed");
      expect(spawnOfficial).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  unixIt(
    "accepts an owned link to a private socket and removes only the link on close",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "codexhost-official-"));
      const socketPath = path.join(directory, "published.sock");
      const targetPath = path.join(directory, "daemon.sock");
      const server = await privateSocket(targetPath);
      try {
        const { listener } = fakeRemoteListener(socketPath, async () => {
          await symlink(targetPath, socketPath);
        });
        await listener.listen();
        expect((await lstat(socketPath)).isSymbolicLink()).toBe(true);

        await listener.close();
        await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await lstat(targetPath)).isSocket()).toBe(true);
      } finally {
        server.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  unixIt("cleans the owned link when close overlaps the post-ready identity check", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codexhost-official-"));
    const socketPath = path.join(directory, "published.sock");
    const targetPath = path.join(directory, "daemon.sock");
    const server = await privateSocket(targetPath);
    try {
      const fixture = fakeRemoteListener(socketPath, async () => {
        await symlink(targetPath, socketPath);
        void fixture.listener.close();
      });

      await expect(fixture.listener.listen()).rejects.toThrow("already closed");
      await fixture.listener.close();
      await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(targetPath)).isSocket()).toBe(true);
    } finally {
      server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  unixIt("keeps a pre-existing socket and rejects a non-socket path", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codexhost-official-"));
    const socketPath = path.join(directory, "published.sock");
    const server = await privateSocket(socketPath);
    try {
      const { listener } = fakeRemoteListener(socketPath);
      await listener.listen();
      await listener.close();
      expect((await lstat(socketPath)).isSocket()).toBe(true);

      const filePath = path.join(directory, "regular-file");
      await writeFile(filePath, "fixture");
      const rejected = fakeRemoteListener(filePath);
      await expect(rejected.listener.listen()).rejects.toThrow("not a socket");
      expect((await lstat(filePath)).isFile()).toBe(true);
    } finally {
      server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  unixIt("rejects a link to a non-private socket and removes its own link", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codexhost-official-"));
    const socketPath = path.join(directory, "published.sock");
    const targetPath = path.join(directory, "daemon.sock");
    const server = await privateSocket(targetPath);
    try {
      await chmod(targetPath, 0o660);
      const { listener } = fakeRemoteListener(socketPath, async () => {
        await symlink(targetPath, socketPath);
      });
      await expect(listener.listen()).rejects.toThrow("private socket");
      await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(targetPath)).isSocket()).toBe(true);
    } finally {
      server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  unixIt("rejects a link to a regular file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codexhost-official-"));
    const socketPath = path.join(directory, "published.sock");
    const targetPath = path.join(directory, "target-file");
    try {
      await writeFile(targetPath, "fixture", { mode: 0o600 });
      const { listener } = fakeRemoteListener(socketPath, async () => {
        await symlink(targetPath, socketPath);
      });
      await expect(listener.listen()).rejects.toThrow("private socket");
      await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(targetPath)).isFile()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  unixIt("rejects a link with a different owner", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codexhost-official-"));
    const socketPath = path.join(directory, "published.sock");
    const targetPath = path.join(directory, "daemon.sock");
    const server = await privateSocket(targetPath);
    try {
      await symlink(targetPath, socketPath);
      const otherUid = (process.getuid?.() ?? 0) + 1;
      const getuid = vi.spyOn(process, "getuid").mockReturnValue(otherUid);
      try {
        const { listener } = fakeRemoteListener(socketPath);
        await expect(listener.listen()).rejects.toThrow("link must belong to the current user");
        expect((await lstat(socketPath)).isSymbolicLink()).toBe(true);
      } finally {
        getuid.mockRestore();
      }
    } finally {
      server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  unixIt("removes an owned dangling link after failed startup", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codexhost-official-"));
    const socketPath = path.join(directory, "published.sock");
    try {
      const { child, listener } = fakeRemoteListener(socketPath, async () => {
        await symlink(path.join(directory, "missing.sock"), socketPath);
        throw new Error("fixture startup failure");
      });
      await expect(listener.listen()).rejects.toThrow("fixture startup failure");
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  unixIt("keeps a link replaced during failed-startup termination", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codexhost-official-"));
    const socketPath = path.join(directory, "published.sock");
    const replacementPath = path.join(directory, "replacement-link");
    try {
      await symlink(path.join(directory, "replacement.sock"), replacementPath);
      const { child, listener } = fakeRemoteListener(socketPath, async () => {
        await symlink(path.join(directory, "missing.sock"), socketPath);
        throw new Error("fixture startup failure");
      });
      const replacementMoved = Promise.withResolvers<undefined>();
      child.kill.mockImplementation(() => {
        void rename(replacementPath, socketPath).then(
          () => {
            replacementMoved.resolve(undefined);
            child.emit("exit", null, "SIGTERM");
          },
          (error: unknown) => {
            replacementMoved.reject(error);
            child.emit("exit", null, "SIGTERM");
          },
        );
        return true;
      });

      await expect(listener.listen()).rejects.toThrow("fixture startup failure");
      await replacementMoved.promise;
      expect((await lstat(socketPath)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  unixIt("preserves a replacement link when its inode differs from the owned link", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codexhost-official-"));
    const socketPath = path.join(directory, "published.sock");
    const targetPath = path.join(directory, "daemon.sock");
    const server = await privateSocket(targetPath);
    try {
      const { listener } = fakeRemoteListener(socketPath, async () => {
        await symlink(targetPath, socketPath);
      });
      await listener.listen();
      const replacementPath = path.join(directory, "replacement-link");
      await symlink(path.join(directory, "replacement.sock"), replacementPath);
      await rename(replacementPath, socketPath);

      await listener.close();
      expect((await lstat(socketPath)).isSymbolicLink()).toBe(true);
    } finally {
      server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("discovers one dynamic loopback listener and reuses it for every client", async () => {
    const child = new FakeOfficialListenerProcess();
    const spawnOfficial = vi.fn(
      () => child as unknown as ReturnType<typeof spawn> & ChildProcess,
    ) as unknown as typeof spawn;
    const listener = createLoopbackOfficialAppServerListener({
      stockCodexPath: "C:\\synthetic\\codex.exe",
      arguments: ["app-server", "--listen", "ws://127.0.0.1:0"],
      environment: { PATH: "C:\\Windows\\System32" },
      diagnosticOutput: new PassThrough(),
      spawnOfficial,
    });

    const first = listener.listen();
    child.stderr.write("codex app-server (WebSockets)\n");
    child.stderr.write("  listening on: ws://127.0.0.1:43821\n");

    await expect(first).resolves.toBe("ws://127.0.0.1:43821");
    await expect(listener.listen()).resolves.toBe("ws://127.0.0.1:43821");
    expect(spawnOfficial).toHaveBeenCalledTimes(1);
    expect(spawnOfficial).toHaveBeenCalledWith(
      "C:\\synthetic\\codex.exe",
      ["app-server", "--listen", "ws://127.0.0.1:0"],
      expect.objectContaining({
        env: { PATH: "C:\\Windows\\System32" },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      }),
    );

    await listener.close();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
