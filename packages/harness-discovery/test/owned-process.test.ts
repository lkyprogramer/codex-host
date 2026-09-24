import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PROCESS_ANCHOR_PATH_ENV,
  processAnchorPath,
  runOwnedProcess,
  spawnOwnedProcess,
} from "../src/owned-process.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const realAnchor = path.join(repositoryRoot, "target", "debug", "codexhost-anchor");
const leftovers: number[] = [];
let configuredAnchor: string | undefined;

function useAnchor(anchor: string | undefined): void {
  if (anchor === undefined) Reflect.deleteProperty(process.env, PROCESS_ANCHOR_PATH_ENV);
  else process.env[PROCESS_ANCHOR_PATH_ENV] = anchor;
}

function requireRealAnchor(): string {
  if (!existsSync(realAnchor)) {
    throw new Error(
      `Build the process anchor first: cargo build -p codexhost-anchor (${realAnchor})`,
    );
  }
  return realAnchor;
}

function alive(pid: number): boolean {
  let state = "";
  try {
    state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return false;
  }
  // kill(2) still reaches a zombie; only a live process counts here.
  return state !== "" && !state.startsWith("Z");
}

async function readLine(child: ChildProcess): Promise<string> {
  const stream = child.stdout;
  if (!stream) throw new Error("Fixture has no stdout");
  let buffered = "";
  for await (const chunk of stream) {
    buffered += String(chunk);
    const newline = buffered.indexOf("\n");
    if (newline !== -1) return buffered.slice(0, newline);
  }
  throw new Error(`Fixture ended before a line: ${buffered}`);
}

/** Resolves on `close` without the `error` listener `events.once` would add. */
function closed(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once("close", () => resolve()));
}

/** A Harness that starts a TERM-ignoring grandchild and reports its pid. */
const stubbornGrandchild = [
  "-e",
  [
    "const {spawn}=require('node:child_process');",
    "const c=spawn(process.execPath,['-e','process.on(\"SIGTERM\",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});",
    "process.stdout.write(c.pid+'\\n');",
    "setInterval(()=>{},1000);",
  ].join(""),
];

beforeEach(() => {
  configuredAnchor = process.env[PROCESS_ANCHOR_PATH_ENV];
});

afterEach(() => {
  useAnchor(configuredAnchor);
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

describe.skipIf(process.platform === "win32")("anchored Harness processes", () => {
  it("runs the Harness through the anchor with its own stdio and exit status", async () => {
    useAnchor(requireRealAnchor());
    const { child, tree, anchored } = spawnOwnedProcess(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout);process.stdin.on('end',()=>process.exit(5))"],
      { closeTimeoutMs: 500 },
    );
    expect(anchored).toBe(true);
    expect(tree).not.toBeNull();
    child.stdin.write("through the anchor\n");
    await expect(readLine(child)).resolves.toBe("through the anchor");
    child.stdin.end();
    const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    expect({ code, signal }).toEqual({ code: 5, signal: null });
    // Leaving on its own already released the group; close has nothing left.
    await expect(tree?.close()).resolves.toBeUndefined();
  });

  it("releases the whole group, escalating to KILL for a TERM-ignoring grandchild", async () => {
    useAnchor(requireRealAnchor());
    const { child, tree } = spawnOwnedProcess(process.execPath, stubbornGrandchild, {
      closeTimeoutMs: 200,
    });
    const grandchild = Number(await readLine(child));
    leftovers.push(grandchild);
    expect(alive(grandchild)).toBe(true);
    const exited = once(child, "exit");
    await expect(tree?.close()).resolves.toBeUndefined();
    expect(alive(grandchild)).toBe(false);
    const [, signal] = (await exited) as [number | null, NodeJS.Signals | null];
    expect(signal).toBe("SIGTERM");
  });

  it("reclaims what a Harness leaves behind when it exits on its own", async () => {
    useAnchor(requireRealAnchor());
    const { child } = spawnOwnedProcess(
      process.execPath,
      [
        "-e",
        [
          "const {spawn}=require('node:child_process');",
          "const c=spawn(process.execPath,['-e','process.on(\"SIGTERM\",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});",
          "process.stdout.write(c.pid+'\\n',()=>process.exit(0));",
        ].join(""),
      ],
      { closeTimeoutMs: 200 },
    );
    const grandchild = Number(await readLine(child));
    leftovers.push(grandchild);
    const [code] = (await once(child, "exit")) as [number | null];
    // The exit arrives only once the leftover grandchild is gone.
    expect(code).toBe(0);
    expect(alive(grandchild)).toBe(false);
  });

  it("routes kill to the anchor, so even SIGKILL releases the whole group", async () => {
    useAnchor(requireRealAnchor());
    const marker = path.join(os.tmpdir(), `codexhost-kill-${process.pid}-${Date.now()}`);
    const { child } = spawnOwnedProcess(
      process.execPath,
      [
        "-e",
        [
          "const {spawn}=require('node:child_process');",
          `const c=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(${JSON.stringify(marker)},"");setInterval(()=>{},1000)'],{stdio:'ignore'});`,
          "process.stdout.write(c.pid+'\\n');",
          "setInterval(()=>{},1000);",
        ].join(""),
      ],
      { closeTimeoutMs: 7_000 },
    );
    const grandchild = Number(await readLine(child));
    leftovers.push(grandchild);
    // Only once the grandchild ignores TERM does a SIGKILL have work to do.
    await expect.poll(() => existsSync(marker), { timeout: 5_000 }).toBe(true);
    const anchorPid = child.pid;
    // The Claude SDK's shutdown: SIGTERM, then SIGKILL well before a long
    // grace ends. Killing the anchor itself would abandon the grandchild.
    expect(child.kill("SIGTERM")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(grandchild)).toBe(true);
    expect(child.kill("SIGKILL")).toBe(true);
    const [, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    expect(signal).toBe("SIGTERM");
    expect(alive(grandchild)).toBe(false);
    if (anchorPid) expect(alive(anchorPid)).toBe(false);
    expect(child.kill("SIGKILL")).toBe(false);
    await rm(marker, { force: true });
  });

  it("reports a missing Harness exactly as a failed spawn does", async () => {
    useAnchor(requireRealAnchor());
    const { child, tree } = spawnOwnedProcess("/nonexistent/codexhost-harness", [], {
      closeTimeoutMs: 200,
    });
    const events: string[] = [];
    let failure: NodeJS.ErrnoException | undefined;
    child.on("spawn", () => events.push("spawn"));
    child.on("exit", () => events.push("exit"));
    child.on("error", (error: NodeJS.ErrnoException) => {
      failure = error;
      events.push("error");
    });
    await closed(child);
    events.push("close");
    expect(events).toEqual(["error", "close"]);
    expect(failure?.code).toBe("ENOENT");
    await expect(tree?.close()).resolves.toBeUndefined();
  });

  it("emits spawn only once the Harness exists", async () => {
    useAnchor(requireRealAnchor());
    const { child } = spawnOwnedProcess(process.execPath, ["-e", "process.exit(0)"], {
      closeTimeoutMs: 200,
    });
    const events: string[] = [];
    for (const event of ["spawn", "exit", "close"]) child.on(event, () => events.push(event));
    await closed(child);
    expect(events).toEqual(["spawn", "exit", "close"]);
  });

  it("turns an abort into a release of the whole group", async () => {
    useAnchor(requireRealAnchor());
    const controller = new AbortController();
    const { child } = spawnOwnedProcess(process.execPath, stubbornGrandchild, {
      closeTimeoutMs: 200,
      signal: controller.signal,
    });
    const grandchild = Number(await readLine(child));
    leftovers.push(grandchild);
    const failure = once(child, "error");
    controller.abort();
    const [error] = (await failure) as [NodeJS.ErrnoException];
    expect(error.name).toBe("AbortError");
    await once(child, "exit");
    expect(alive(grandchild)).toBe(false);
  });

  it("reports a Harness error nobody listens for instead of crashing the Host", async () => {
    useAnchor(requireRealAnchor());
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    try {
      const { child } = spawnOwnedProcess("/nonexistent/codexhost-harness", [], {
        closeTimeoutMs: 200,
      });
      await closed(child);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("Unhandled Harness process error"),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("ends the Harness tree when the Host dies without closing anything", async () => {
    const anchor = requireRealAnchor();
    const module = path.join(repositoryRoot, "packages/harness-discovery/dist/owned-process.js");
    if (!existsSync(module)) throw new Error(`Build harness-discovery first (${module})`);
    const host = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          `const { spawnOwnedProcess } = await import(${JSON.stringify(module)});`,
          `const { child } = spawnOwnedProcess(process.execPath, ${JSON.stringify(stubbornGrandchild)}, { closeTimeoutMs: 200 });`,
          "child.stdout.once('data', (chunk) => process.stdout.write(`${child.pid} ${String(chunk).trim()}\\n`));",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      ],
      {
        env: { ...process.env, [PROCESS_ANCHOR_PATH_ENV]: anchor },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    const [anchorPid, grandchild] = (await readLine(host)).split(" ").map(Number);
    if (!anchorPid || !grandchild) throw new Error("Host fixture did not report its tree");
    leftovers.push(anchorPid, grandchild);
    expect(alive(grandchild)).toBe(true);
    host.kill("SIGKILL");
    await once(host, "exit");
    await expect
      .poll(() => alive(grandchild) || alive(anchorPid), { timeout: 5_000, interval: 50 })
      .toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("owned runs", () => {
  it("returns output and exit status of a completed run", async () => {
    useAnchor(requireRealAnchor());
    await expect(
      runOwnedProcess(
        process.execPath,
        ["-e", "process.stdout.write('out');process.stderr.write('err');process.exit(4)"],
        { timeoutMs: 5_000, maxOutputBytes: 1024 },
      ),
    ).resolves.toEqual({ stdout: "out", stderr: "err", code: 4, signal: null });
  });

  it("stops the whole tree of a run that times out", async () => {
    useAnchor(requireRealAnchor());
    const file = path.join(os.tmpdir(), `codexhost-run-${process.pid}-${Date.now()}`);
    const run = runOwnedProcess(
      process.execPath,
      [
        "-e",
        [
          "const {spawn}=require('node:child_process');",
          "const c=spawn(process.execPath,['-e','process.on(\"SIGTERM\",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});",
          `require('node:fs').writeFileSync(${JSON.stringify(file)}, String(c.pid));`,
          "setInterval(()=>{},1000);",
        ].join(""),
      ],
      { timeoutMs: 500, maxOutputBytes: 1024, closeTimeoutMs: 200 },
    );
    await expect(run).rejects.toMatchObject({ code: "ETIMEDOUT" });
    const grandchild = Number(await readFile(file, "utf8"));
    leftovers.push(grandchild);
    await rm(file, { force: true });
    expect(alive(grandchild)).toBe(false);
  });

  it("stops a run that exceeds its output limit", async () => {
    useAnchor(requireRealAnchor());
    await expect(
      runOwnedProcess(
        process.execPath,
        ["-e", "setInterval(()=>process.stdout.write('x'.repeat(256)),5)"],
        { timeoutMs: 5_000, maxOutputBytes: 1024, closeTimeoutMs: 200 },
      ),
    ).rejects.toMatchObject({ code: "ENOBUFS" });
  });

  it("rejects a run whose executable does not exist", async () => {
    useAnchor(requireRealAnchor());
    await expect(
      runOwnedProcess("/nonexistent/codexhost-command", [], {
        timeoutMs: 5_000,
        maxOutputBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe.skipIf(process.platform === "win32")("anchor protocol", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-fake-anchor-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** A scripted anchor: `script` receives each command and a send function. */
  async function fakeAnchor(script: string): Promise<string> {
    const file = path.join(directory, `anchor-${Math.random().toString(16).slice(2)}.mjs`);
    await writeFile(
      file,
      [
        `#!${process.execPath}`,
        "import net from 'node:net';",
        "const control = new net.Socket({ fd: 3, readable: true, writable: true });",
        "const send = (message) => control.write(JSON.stringify(message) + '\\n');",
        "let requests = 0;",
        "let buffer = '';",
        "const onCommand = (command) => {",
        script,
        "};",
        "send({ type: 'ready', pid: process.pid, pgid: process.pid });",
        "control.on('data', (chunk) => {",
        "  buffer += chunk;",
        "  for (let i = buffer.indexOf('\\n'); i !== -1; i = buffer.indexOf('\\n')) {",
        "    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);",
        "    requests += 1; onCommand(JSON.parse(line));",
        "  }",
        "});",
        "control.on('end', () => process.exit(0));",
      ].join("\n"),
    );
    await chmod(file, 0o755);
    return file;
  }

  it("lets a release the anchor could not confirm be retried", async () => {
    useAnchor(
      await fakeAnchor(
        "if (requests === 1) send({ type: 'unconfirmed', live: 2 }); else { send({ type: 'released' }); setTimeout(() => process.exit(0), 10); }",
      ),
    );
    const { tree } = spawnOwnedProcess("harness", [], { closeTimeoutMs: 100 });
    await expect(tree?.close()).rejects.toThrow(
      "did not exit within cleanup bounds (2 still running)",
    );
    await expect(tree?.close()).resolves.toBeUndefined();
    await expect(tree?.close()).resolves.toBeUndefined();
  });

  it("shares one release between concurrent callers", async () => {
    useAnchor(
      await fakeAnchor(
        "setTimeout(() => { send({ type: 'released', requests }); process.exit(0); }, 50);",
      ),
    );
    const { tree } = spawnOwnedProcess("harness", [], { closeTimeoutMs: 100 });
    await expect(Promise.all([tree?.close(), tree?.close()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it("keeps the failure when the anchor dies without confirming, and never retries by pid", async () => {
    useAnchor(await fakeAnchor("process.exit(1);"));
    const { tree } = spawnOwnedProcess("harness", [], { closeTimeoutMs: 100 });
    await expect(tree?.close()).rejects.toThrow("exited without confirming");
    await expect(tree?.close()).rejects.toThrow("exited without confirming");
  });

  it("reports a Harness that could not be created the way spawn does", async () => {
    const file = path.join(directory, "spawn-error.mjs");
    await writeFile(
      file,
      [
        `#!${process.execPath}`,
        "import net from 'node:net';",
        "const control = new net.Socket({ fd: 3, readable: true, writable: true });",
        "control.end(JSON.stringify({ type: 'spawnError', code: 'ENOENT', message: 'No such file' }) + '\\n', () => process.exit(127));",
      ].join("\n"),
    );
    await chmod(file, 0o755);
    useAnchor(file);
    const { child, tree } = spawnOwnedProcess("missing-harness", [], { closeTimeoutMs: 100 });
    const [error] = (await once(child, "error")) as [NodeJS.ErrnoException];
    expect(error.code).toBe("ENOENT");
    expect(error.path).toBe("missing-harness");
    await expect(tree?.close()).resolves.toBeUndefined();
  });

  it("keeps the outcome of a round the Host asked for out of exit reports", async () => {
    useAnchor(await fakeAnchor("send({ type: 'unconfirmed', live: 1 });"));
    const onExitCleanupFailure = vi.fn();
    const { child } = spawnOwnedProcess("harness", [], {
      closeTimeoutMs: 100,
      onExitCleanupFailure,
    });
    await once(child, "spawn");
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onExitCleanupFailure).not.toHaveBeenCalled();
    child.stdin?.destroy();
    process.kill(child.pid ?? 0, "SIGKILL");
  });

  it("passes an anchor diagnostic to the Host", async () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    try {
      useAnchor(await fakeAnchor(""));
      const file = path.join(directory, "diagnostic.mjs");
      await writeFile(
        file,
        [
          `#!${process.execPath}`,
          "import net from 'node:net';",
          "const control = new net.Socket({ fd: 3, readable: true, writable: true });",
          "control.write(JSON.stringify({ type: 'ready', pid: process.pid, pgid: process.pid }) + '\\n');",
          "control.write(JSON.stringify({ type: 'diagnostic', message: 'cannot read /proc' }) + '\\n');",
          "control.on('end', () => process.exit(0));",
        ].join("\n"),
      );
      await chmod(file, 0o755);
      useAnchor(file);
      const { child } = spawnOwnedProcess("harness", [], { closeTimeoutMs: 100 });
      await expect
        .poll(
          () =>
            warning.mock.calls.some(([message]) => String(message).includes("cannot read /proc")),
          {
            timeout: 5_000,
          },
        )
        .toBe(true);
      process.kill(child.pid ?? 0, "SIGKILL");
    } finally {
      warning.mockRestore();
    }
  });

  it("reports cleanup that failed after the Harness left on its own", async () => {
    const file = path.join(directory, "exit-failure.mjs");
    await writeFile(
      file,
      [
        `#!${process.execPath}`,
        "import net from 'node:net';",
        "const control = new net.Socket({ fd: 3, readable: true, writable: true });",
        "control.write(JSON.stringify({ type: 'exit', code: 0 }) + '\\n');",
        "control.write(JSON.stringify({ type: 'unconfirmed', live: 1 }) + '\\n');",
        "control.on('end', () => process.exit(0));",
      ].join("\n"),
    );
    await chmod(file, 0o755);
    useAnchor(file);
    const onExitCleanupFailure = vi.fn();
    const { child } = spawnOwnedProcess("harness", [], {
      closeTimeoutMs: 100,
      onExitCleanupFailure,
    });
    await expect.poll(() => onExitCleanupFailure.mock.calls.length, { timeout: 5_000 }).toBe(1);
    expect(String(onExitCleanupFailure.mock.calls[0]?.[0])).toContain("1 still running");
    child.kill("SIGKILL");
  });
});

describe("process anchor selection", () => {
  it("falls back to Host-side tracking without a configured anchor", async () => {
    useAnchor(undefined);
    expect(processAnchorPath()).toBeNull();
    const { child, tree, anchored } = spawnOwnedProcess(
      process.execPath,
      ["-e", "process.exit(3)"],
      {
        closeTimeoutMs: 200,
      },
    );
    expect(anchored).toBe(false);
    expect(tree).not.toBeNull();
    const [code] = (await once(child, "exit")) as [number | null];
    expect(code).toBe(3);
  });

  it("rejects a close bound that is not a finite, non-negative number", () => {
    expect(() => spawnOwnedProcess(process.execPath, [], { closeTimeoutMs: Number.NaN })).toThrow(
      "closeTimeoutMs must be a finite, non-negative number",
    );
  });

  it("ignores a relative or unusable anchor path", () => {
    useAnchor("relative/codexhost-anchor");
    expect(processAnchorPath()).toBeNull();
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    try {
      useAnchor(path.join(os.tmpdir(), `codexhost-anchor-missing-${process.pid}-${Date.now()}`));
      expect(processAnchorPath()).toBeNull();
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });
});
