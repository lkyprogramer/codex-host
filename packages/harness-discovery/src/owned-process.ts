import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";

import { trackOwnedProcessTree, type OwnedProcessTree } from "./owned-process-tree.js";

/** Set by the Shim to the native anchor that owns every Harness process group. */
export const PROCESS_ANCHOR_PATH_ENV = "CODEXHOST_PROCESS_ANCHOR_PATH";

type StdioEntry = "pipe" | "ignore" | "inherit";

export interface OwnedProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: readonly [StdioEntry, StdioEntry, StdioEntry];
  windowsHide?: boolean;
  windowsVerbatimArguments?: boolean;
  /** Aborting ends the owned process tree, as `spawn`'s own option would. */
  signal?: AbortSignal;
  /** Bound for each of the graceful and forced shutdown phases. */
  closeTimeoutMs: number;
  /** Receives cleanup failures observed after the process leaves on its own. */
  onExitCleanupFailure?(error: unknown): void;
}

export interface OwnedProcess<Child extends ChildProcess = ChildProcess> {
  /** The Harness's stdio and exit status, whether or not it is anchored. */
  child: Child;
  /** Null only when the process could not be created at all. */
  tree: OwnedProcessTree | null;
  /** True when a native anchor owns the tree; false for Host-side tracking. */
  anchored: boolean;
}

const checkedAnchors = new Map<string, boolean>();

/**
 * The native anchor this Host may use, or null. Only the Host's own
 * environment counts: a Harness environment never selects process ownership.
 */
export function processAnchorPath(): string | null {
  if (process.platform === "win32") return null;
  const configured = process.env[PROCESS_ANCHOR_PATH_ENV];
  if (!configured || !path.isAbsolute(configured)) return null;
  let usable = checkedAnchors.get(configured);
  if (usable === undefined) {
    try {
      accessSync(configured, constants.X_OK);
      usable = true;
    } catch {
      usable = false;
      process.emitWarning(
        `Process anchor ${configured} is not executable; Harness processes fall back to Host-side tracking`,
      );
    }
    checkedAnchors.set(configured, usable);
  }
  return usable ? configured : null;
}

/**
 * The single way an Adapter starts a Harness process it owns. With the native
 * anchor, the process group is pinned until it is confirmed empty, survives
 * no Host death, and can be released again after a failed attempt. Without
 * it (Windows, or a build without the anchor) the Host-side tracker is used.
 */
export function spawnOwnedProcess(
  command: string,
  args: readonly string[],
  options: OwnedProcessOptions & { stdio?: readonly ["pipe", "pipe", "pipe"] },
): OwnedProcess<ChildProcessWithoutNullStreams>;
export function spawnOwnedProcess(
  command: string,
  args: readonly string[],
  options: OwnedProcessOptions,
): OwnedProcess;
export function spawnOwnedProcess(
  command: string,
  args: readonly string[],
  options: OwnedProcessOptions,
): OwnedProcess {
  const stdio = options.stdio ?? ["pipe", "pipe", "pipe"];
  const anchor = processAnchorPath();
  if (!anchor) {
    const detached = process.platform !== "win32";
    const child = spawn(command, [...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      detached,
      stdio: [...stdio],
      windowsHide: options.windowsHide ?? true,
      ...(options.windowsVerbatimArguments !== undefined
        ? { windowsVerbatimArguments: options.windowsVerbatimArguments }
        : {}),
    });
    const tree = trackOwnedProcessTree(child, {
      detached,
      closeTimeoutMs: options.closeTimeoutMs,
      ...(options.onExitCleanupFailure
        ? { onExitCleanupFailure: options.onExitCleanupFailure }
        : {}),
    });
    return { child, tree, anchored: false };
  }
  const graceMs = String(Math.max(1, Math.ceil(options.closeTimeoutMs)));
  const child = spawn(
    anchor,
    ["--exit-grace-ms", graceMs, "--lifeline-grace-ms", graceMs, "--", command, ...args],
    {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      // The anchor leads its own session, so terminal and Host-group signals
      // reach it only through the lifeline and its own handlers.
      detached: true,
      stdio: [...stdio, "pipe"],
      windowsHide: true,
    },
  );
  const control = child.stdio?.[3] as Duplex | null | undefined;
  if (!child.pid || !control) return { child, tree: null, anchored: true };
  return {
    child,
    tree: new AnchoredProcessTree(child, control, command, options),
    anchored: true,
  };
}

/** Longest control line accepted from the anchor; its messages are tiny. */
const MAX_CONTROL_LINE = 64 * 1024;
/** Slack beyond the anchor's own TERM and KILL windows before giving up on it. */
const ANCHOR_ANSWER_SLACK_MS = 5_000;

interface PendingRelease {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

class AnchoredProcessTree implements OwnedProcessTree {
  readonly #child: ChildProcess;
  readonly #command: string;
  readonly #control: Duplex;
  readonly #closeTimeoutMs: number;
  readonly #onExitCleanupFailure: ((error: unknown) => void) | undefined;
  #buffer = "";
  #released = false;
  /** Set once the anchor is gone without confirming; it can no longer help. */
  #lost: Error | null = null;
  #pending: PendingRelease | null = null;

  constructor(child: ChildProcess, control: Duplex, command: string, options: OwnedProcessOptions) {
    this.#child = child;
    this.#command = command;
    this.#control = control;
    this.#closeTimeoutMs = options.closeTimeoutMs;
    this.#onExitCleanupFailure = options.onExitCleanupFailure;
    control.setEncoding("utf8");
    control.on("data", (chunk: string) => this.#receive(chunk));
    // Writing after the anchor left fails with EPIPE; its close says enough.
    control.on("error", () => undefined);
    // The socket closes only after every message it carried was read, so a
    // release reported just before the anchor exited is never missed.
    control.once("close", () => this.#anchorGone());
    // The lifeline must never be what keeps a Host alive.
    (control as Duplex & { unref?(): void }).unref?.();
  }

  close(): Promise<void> {
    if (this.#released) return Promise.resolve();
    if (this.#lost) return Promise.reject(this.#lost);
    if (this.#pending) return this.#pending.promise;
    let resolve: () => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const timer = setTimeout(
      () => this.#settle(new Error("Process anchor did not answer a release request")),
      this.#closeTimeoutMs * 2 + ANCHOR_ANSWER_SLACK_MS,
    );
    timer.unref();
    this.#pending = { promise, resolve, reject, timer };
    this.#control.write(
      `${JSON.stringify({ op: "terminate", graceMs: Math.max(0, Math.ceil(this.#closeTimeoutMs)) })}\n`,
    );
    return promise;
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#handle(line);
      newline = this.#buffer.indexOf("\n");
    }
    if (this.#buffer.length > MAX_CONTROL_LINE) this.#buffer = "";
  }

  #handle(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const type = Reflect.get(message, "type");
    if (type === "released") {
      this.#released = true;
      this.#settle(null);
    } else if (type === "unconfirmed") {
      const live = Reflect.get(message, "live");
      const error = new Error(
        `Owned process group did not exit within cleanup bounds (${typeof live === "number" ? live : "some"} still running)`,
      );
      if (this.#pending) this.#settle(error);
      else this.#reportExitCleanupFailure(error);
    } else if (type === "spawnError") {
      // Nothing was created, so nothing is owned. Surface it the way `spawn`
      // reports a missing executable, which is what Adapters handle.
      this.#released = true;
      const code = Reflect.get(message, "code");
      const detail = Reflect.get(message, "message");
      const error = Object.assign(
        new Error(`spawn ${this.#command} ${typeof code === "string" ? code : "failed"}`),
        {
          ...(typeof code === "string" ? { code } : {}),
          syscall: `spawn ${this.#command}`,
          path: this.#command,
          ...(typeof detail === "string" ? { detail } : {}),
        },
      );
      this.#child.emit("error", error);
    }
  }

  #anchorGone(): void {
    if (this.#released) {
      this.#settle(null);
      return;
    }
    // Without its anchor the group id is no longer pinned; retrying would be
    // signalling by a bare pid again. Keep the failure instead.
    this.#lost = new Error(
      "Process anchor exited without confirming the process group was released",
    );
    if (this.#pending) this.#settle(this.#lost);
    else this.#reportExitCleanupFailure(this.#lost);
  }

  #settle(error: Error | null): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  }

  #reportExitCleanupFailure(error: Error): void {
    if (this.#onExitCleanupFailure) this.#onExitCleanupFailure(error);
    else process.emitWarning(`Owned process tree cleanup failed: ${error.message}`);
  }
}

export interface RunOwnedProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  /** The whole run, from spawn to exit. */
  timeoutMs: number;
  /** Combined stdout and stderr the run may produce before it is stopped. */
  maxOutputBytes: number;
  signal?: AbortSignal;
  /** Bound for each shutdown phase when the run has to be stopped. */
  closeTimeoutMs?: number;
}

export interface OwnedProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

const DEFAULT_RUN_CLOSE_TIMEOUT_MS = 2_000;

/**
 * Runs a short native command to completion. A run that times out, is
 * aborted, or produces too much output is stopped as a whole process tree,
 * not just its leader, before the promise rejects.
 */
export function runOwnedProcess(
  command: string,
  args: readonly string[],
  options: RunOwnedProcessOptions,
): Promise<OwnedProcessResult> {
  const { child, tree } = spawnOwnedProcess(command, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.windowsVerbatimArguments !== undefined
      ? { windowsVerbatimArguments: options.windowsVerbatimArguments }
      : {}),
    stdio: ["ignore", "pipe", "pipe"],
    closeTimeoutMs: options.closeTimeoutMs ?? DEFAULT_RUN_CLOSE_TIMEOUT_MS,
  });
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (): void => {
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const stop = (error: Error): void => {
      if (settled) return;
      finish();
      // No tree means nothing was created; its spawn error settles the run.
      const stopping = tree ? tree.close() : Promise.resolve();
      stopping.then(
        () => reject(error),
        (cleanupError: unknown) => reject(Object.assign(error, { cleanupError })),
      );
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > options.maxOutputBytes) {
        stop(Object.assign(new Error(`${command} exceeded its output limit`), { code: "ENOBUFS" }));
        return;
      }
      target.push(chunk);
    };
    const onAbort = (): void =>
      stop(Object.assign(new Error(`${command} was aborted`), { code: "ABORT_ERR" }));
    const timer = setTimeout(
      () =>
        stop(
          Object.assign(new Error(`${command} timed out after ${options.timeoutMs} ms`), {
            code: "ETIMEDOUT",
          }),
        ),
      options.timeoutMs,
    );
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.once("error", (error) => {
      if (settled) return;
      finish();
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      finish();
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
        signal,
      });
    });
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
