import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runRemoteHostCli, setRemoteHostCliDependenciesForTest } from "../src/remote-host-cli.js";
import { installRemoteHost, type RemoteHostManifestV1 } from "../src/remote-host-install.js";
import { setRemoteHostLifecycleDependenciesForTest } from "../src/remote-host-lifecycle.js";

let restore: (() => void) | undefined;
let restoreLifecycle: (() => void) | undefined;
const statusManifest = {
  format: 1,
  wrapperPath: "/home/developer/.codexhost/bin/codex",
  profilePath: "/home/developer/.profile",
  stockCodexPath: "/runtime/codex",
  nodePath: "/runtime/node",
  shimPath: "/runtime/shim",
  hostRuntimePath: "/runtime/host.mjs",
  dataDirectory: "/home/developer/.codexhost",
} satisfies RemoteHostManifestV1;
afterEach(() => {
  restore?.();
  restore = undefined;
  restoreLifecycle?.();
  restoreLifecycle = undefined;
});

async function executable(filePath: string): Promise<string> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "fixture\n", "utf8");
  await chmod(filePath, 0o755);
  return filePath;
}

async function regularFile(filePath: string): Promise<string> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "fixture\n", { encoding: "utf8", mode: 0o600 });
  return filePath;
}

function textSink(): { output: Writable; text(): string } {
  const chunks: Buffer[] = [];
  return {
    output: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
    }),
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

describe("remote SSH Host CLI", () => {
  it("prints a bounded command summary", async () => {
    const stdout = textSink();
    const stderr = textSink();

    await expect(
      runRemoteHostCli({
        arguments: ["--help"],
        output: stdout.output,
        diagnosticOutput: stderr.output,
      }),
    ).resolves.toBe(0);
    expect(stdout.text()).toContain("codexhost remote install");
    expect(stdout.text()).toContain("codexhost remote start");
    expect(stdout.text()).toContain("codexhost remote stop");
    expect(stdout.text()).toContain("codexhost remote uninstall");
    expect(stderr.text()).toBe("");
  });

  it("reports an absent installation without mutating the host", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-cli-"));
    const stdout = textSink();
    const stderr = textSink();
    try {
      await expect(
        runRemoteHostCli({
          arguments: ["status"],
          environment: { HOME: home, SHELL: "/bin/zsh" },
          output: stdout.output,
          diagnosticOutput: stderr.output,
        }),
      ).resolves.toBe(0);
      expect(JSON.parse(stdout.text())).toMatchObject({
        state: "not-installed",
        runtime: { state: "stopped" },
      });
      expect(stderr.text()).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses lifecycle operations before installation", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-cli-"));
    const expectedMessage =
      process.platform === "win32"
        ? "Remote Host lifecycle must run on the macOS or Linux SSH host"
        : "Remote Host is not installed";
    try {
      for (const command of ["start", "stop"]) {
        const stdout = textSink();
        const stderr = textSink();
        await expect(
          runRemoteHostCli({
            arguments: [command],
            environment: { HOME: home, SHELL: "/bin/bash" },
            output: stdout.output,
            diagnosticOutput: stderr.output,
          }),
        ).resolves.toBe(1);
        expect(stdout.text()).toBe("");
        expect(stderr.text()).toContain(expectedMessage);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("fails closed on unknown commands and options", async () => {
    const stdout = textSink();
    const stderr = textSink();

    await expect(
      runRemoteHostCli({
        arguments: ["install", "--unknown", "value"],
        output: stdout.output,
        diagnosticOutput: stderr.output,
      }),
    ).resolves.toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("Unknown remote option '--unknown'");
  });

  it("stops only a verified managed listener before removing its installation", async () => {
    const operations: string[] = [];
    restore = setRemoteHostCliDependenciesForTest({
      inspect: async () => ({
        ...statusManifest,
        state: "ready",
        issues: [],
        runtime: {
          state: "running",
          protocol: "codexhost",
          socketPath: "/home/developer/.codex/app-server-control/app-server-control.sock",
        },
      }),
      stop: async () => {
        operations.push("stop");
        return {
          state: "stopped",
          changed: true,
          socketPath: "/home/developer/.codex/app-server-control/app-server-control.sock",
        };
      },
      uninstall: async () => {
        operations.push("uninstall");
      },
    });
    const stdout = textSink();
    const stderr = textSink();

    await expect(
      runRemoteHostCli({
        arguments: ["uninstall"],
        environment: { HOME: "/home/developer", SHELL: "/bin/sh" },
        output: stdout.output,
        diagnosticOutput: stderr.output,
      }),
    ).resolves.toBe(0);

    expect(operations).toEqual(["stop", "uninstall"]);
    expect(stderr.text()).toBe("");
  });

  it.each([
    ["conflict", "stock-codex"],
    ["unknown", "unknown"],
  ] as const)("refuses to remove files for a %s listener", async (state, protocol) => {
    const uninstall = vi.fn();
    const stop = vi.fn();
    restore = setRemoteHostCliDependenciesForTest({
      inspect: async () => ({
        ...statusManifest,
        state: "ready",
        issues: [],
        runtime: {
          state,
          protocol,
          socketPath: "/home/developer/.codex/app-server-control/app-server-control.sock",
        },
      }),
      stop,
      uninstall,
    });
    const stderr = textSink();

    await expect(
      runRemoteHostCli({
        arguments: ["uninstall"],
        environment: { HOME: "/home/developer", SHELL: "/bin/sh" },
        diagnosticOutput: stderr.output,
      }),
    ).resolves.toBe(1);

    expect(stop).not.toHaveBeenCalled();
    expect(uninstall).not.toHaveBeenCalled();
    expect(stderr.text()).toContain("not verified as codexhost-owned");
  });

  it.skipIf(process.platform === "win32")(
    "uninstalls a degraded installation only after lifecycle stop verifies ownership and socket closure",
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-cli-degraded-"));
      const profilePath = path.join(home, ".zshenv");
      const shimPath = await executable(path.join(home, "codexhost-shim"));
      const options = {
        home,
        profilePath,
        stockCodexPath: await executable(path.join(home, "stock-codex")),
        nodePath: await executable(path.join(home, "node")),
        shimPath,
        hostRuntimePath: await regularFile(path.join(home, "host-runtime.mjs")),
        platform: process.platform,
        environment: { HOME: home, SHELL: "/bin/zsh" },
      };
      await writeFile(profilePath, "before=1\n", "utf8");
      const installed = await installRemoteHost(options);
      await rm(shimPath);
      let socketPresent = true;
      const terminate = vi.fn(async (manifest, socket, role) => {
        expect(manifest).toMatchObject({ wrapperPath: installed.wrapperPath });
        expect(socket).toBe(
          path.join(home, ".codex", "app-server-control", "app-server-control.sock"),
        );
        expect(role).toBe("managed");
        socketPresent = false;
      });
      restoreLifecycle = setRemoteHostLifecycleDependenciesForTest({
        probeProtocol: async (_manifest, socket) => ({
          state: "running",
          protocol: "codexhost",
          socketPath: socket,
        }),
        runTerminator: terminate,
        socketExists: async () => socketPresent,
      });
      const stdout = textSink();
      const stderr = textSink();

      try {
        await expect(
          runRemoteHostCli({
            arguments: ["uninstall"],
            environment: options.environment,
            output: stdout.output,
            diagnosticOutput: stderr.output,
          }),
        ).resolves.toBe(0);

        expect(terminate).toHaveBeenCalledTimes(1);
        expect(await readFile(profilePath, "utf8")).toBe("before=1\n");
        await expect(lstat(installed.wrapperPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(stderr.text()).toBe("");
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});
