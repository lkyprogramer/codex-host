import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import os from "node:os";
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

const warnedAnchors = new Set<string>();

/**
 * The native anchor this Host may use, or null. Only the Host's own
 * environment counts: a Harness environment never selects process ownership.
 * It is checked on every spawn, so an anchor removed or replaced by an update
 * is never started as if it were the Harness.
 */
const warnedDiagnostics = new Set<string>();

/**
 * Anchor diagnostics describe the platform (no pid namespace here, an
 * unreadable process table), so every spawn would repeat them: report each
 * distinct one once per Host.
 */
function warnOnce(message: string): void {
  if (warnedDiagnostics.has(message)) return;
  warnedDiagnostics.add(message);
  process.emitWarning(message);
}

export function processAnchorPath(): string | null {
  if (process.platform === "win32") return null;
  const configured = process.env[PROCESS_ANCHOR_PATH_ENV];
  if (!configured || !path.isAbsolute(configured)) return null;
  try {
    accessSync(configured, constants.X_OK);
    return configured;
  } catch {
    if (!warnedAnchors.has(configured)) {
      warnedAnchors.add(configured);
      process.emitWarning(
        `Process anchor ${configured} is not executable; Harness processes fall back to Host-side tracking`,
      );
    }
    return null;
  }
}

/** The anchor clamps every grace to this; the Host's own timers follow it. */
const MAX_GRACE_MS = 600_000;

/** Milliseconds for the anchor protocol; a non-finite bound is a caller bug. */
function graceMilliseconds(closeTimeoutMs: number): number {
  if (!Number.isFinite(closeTimeoutMs) || closeTimeoutMs < 0) {
    throw new TypeError(`closeTimeoutMs must be a finite, non-negative number: ${closeTimeoutMs}`);
  }
  return Math.min(Math.ceil(closeTimeoutMs), MAX_GRACE_MS);
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
  const graceMs = graceMilliseconds(options.closeTimeoutMs);
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
  const child = spawn(
    anchor,
    [
      "--exit-grace-ms",
      String(graceMs),
      "--lifeline-grace-ms",
      String(graceMs),
      "--",
      command,
      ...args,
    ],
    {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      // The abort signal is handled by the tree below: Node would SIGKILL the
      // anchor itself, abandoning the group it owns.
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
    tree: new AnchoredProcessTree(child, control, command, graceMs, options),
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

/** Whether the anchor has reported the Harness's creation yet. */
type Start = "pending" | "ready" | "failed";

/**
 * Owns one anchored Harness on the Host side. The `child` handed to the
 * Adapter is the anchor, so this tree also makes it behave like the Harness:
 * `kill()` becomes a request to the anchor instead of a signal that would
 * kill the anchor and abandon the group; `spawn` is emitted only once the
 * Harness exists; and a Harness that could not be created reports exactly
 * what a failed `spawn` reports, `error` then `close`, with no `exit`.
 */
class AnchoredProcessTree implements OwnedProcessTree {
  readonly #child: ChildProcess;
  readonly #command: string;
  readonly #control: Duplex;
  readonly #graceMs: number;
  readonly #emit: ChildProcess["emit"];
  readonly #onExitCleanupFailure: ((error: unknown) => void) | undefined;
  #buffer = "";
  #start: Start = "pending";
  /** Lifecycle events Node raised before the anchor said what happened. */
  #held: Array<[string, unknown[]]> = [];
  #released = false;
  /** Set once the anchor is gone without confirming; it can no longer help. */
  #lost: Error | null = null;
  #pending: PendingRelease | null = null;
  /**
   * A close() round whose outcome is owed to that call, even after its timer
   * gave up. Rounds started by kill() have no caller waiting on them, so their
   * failures are reported like any other cleanup failure.
   */
  #closeOutcomeOwed = false;
  #stopWatchingAbort: () => void = () => undefined;

  constructor(
    child: ChildProcess,
    control: Duplex,
    command: string,
    graceMs: number,
    options: OwnedProcessOptions,
  ) {
    this.#child = child;
    this.#command = command;
    this.#control = control;
    this.#graceMs = graceMs;
    this.#onExitCleanupFailure = options.onExitCleanupFailure;
    this.#emit = child.emit.bind(child);
    child.emit = ((event: string | symbol, ...args: unknown[]) =>
      this.#route(event, args)) as ChildProcess["emit"];
    child.kill = ((signal?: NodeJS.Signals | number) => this.#kill(signal)) as ChildProcess["kill"];
    control.setEncoding("utf8");
    control.on("data", (chunk: string) => this.#receive(chunk));
    // Writing after the anchor left fails with EPIPE; its close says enough.
    control.on("error", () => undefined);
    // The socket closes only after every message it carried was read, so a
    // release reported just before the anchor exited is never missed.
    control.once("close", () => this.#anchorGone());
    // The lifeline must never be what keeps a Host alive.
    (control as Duplex & { unref?(): void }).unref?.();
    const signal = options.signal;
    if (signal) {
      // As Node does: stop the process, and report the abort only if that
      // stop took effect. A Harness already gone has nothing to abort.
      const abort = () => {
        this.#stopWatchingAbort();
        if (!child.kill()) return;
        this.#emitError(
          Object.assign(new Error("The operation was aborted", { cause: signal.reason }), {
            name: "AbortError",
            code: "ABORT_ERR",
          }),
        );
      };
      if (signal.aborted) {
        queueMicrotask(abort);
      } else {
        signal.addEventListener("abort", abort, { once: true });
        this.#stopWatchingAbort = () => signal.removeEventListener("abort", abort);
      }
    }
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
      this.#graceMs * 2 + ANCHOR_ANSWER_SLACK_MS,
    );
    timer.unref();
    this.#pending = { promise, resolve, reject, timer };
    this.#closeOutcomeOwed = true;
    this.#terminate(this.#graceMs);
    return promise;
  }

  #terminate(graceMs: number): void {
    this.#control.write(`${JSON.stringify({ op: "terminate", graceMs })}\n`);
  }

  /**
   * `kill()` on the Harness handle. SIGKILL means "now"; any other signal is
   * the graceful round. Either way the anchor ends the whole group and stays
   * alive until it is empty, so nothing can orphan the group by accident.
   */
  #kill(signal?: NodeJS.Signals | number): boolean {
    if (typeof signal === "string" && !(signal in os.constants.signals)) {
      throw Object.assign(new TypeError(`Unknown signal: ${signal}`), {
        code: "ERR_UNKNOWN_SIGNAL",
      });
    }
    if (this.#released || this.#lost) return false;
    if (signal === 0) return true;
    this.#terminate(signal === "SIGKILL" || signal === 9 ? 0 : this.#graceMs);
    Reflect.set(this.#child, "killed", true);
    return true;
  }

  #route(event: string | symbol, args: unknown[]): boolean {
    const lifecycle = event === "spawn" || event === "exit" || event === "close";
    if (!lifecycle) return this.#emit(event, ...args);
    if (this.#start === "pending") {
      this.#held.push([event as string, args]);
      return true;
    }
    if (this.#start === "failed" && (event === "spawn" || event === "exit")) return false;
    return this.#emit(event, ...args);
  }

  /** Releases held lifecycle events once the anchor said what happened. */
  #begin(start: Exclude<Start, "pending">, error?: Error): void {
    if (this.#start !== "pending") return;
    this.#start = start;
    if (error) this.#emitError(error);
    const held = this.#held;
    this.#held = [];
    for (const [event, args] of held) this.#route(event, args);
  }

  /** `error` with no listener would crash the Host; report it instead. */
  #emitError(error: Error): void {
    if (this.#child.listenerCount("error") > 0) this.#emit("error", error);
    else process.emitWarning(`Unhandled Harness process error: ${error.message}`);
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
    if (type === "ready") {
      this.#begin("ready");
    } else if (type === "released") {
      this.#released = true;
      this.#closeOutcomeOwed = false;
      this.#stopWatchingAbort();
      this.#settle(null);
    } else if (type === "unconfirmed") {
      const live = Reflect.get(message, "live");
      const error = new Error(
        `Owned process group did not exit within cleanup bounds (${typeof live === "number" ? live : "some"} still running)`,
      );
      this.#reportRoundFailure(error);
    } else if (type === "spawnError") {
      // Nothing was created, so nothing is owned.
      this.#released = true;
      this.#stopWatchingAbort();
      const code = Reflect.get(message, "code");
      const detail = Reflect.get(message, "message");
      this.#begin(
        "failed",
        Object.assign(
          new Error(`spawn ${this.#command} ${typeof code === "string" ? code : "failed"}`),
          {
            ...(typeof code === "string" ? { code } : {}),
            syscall: `spawn ${this.#command}`,
            path: this.#command,
            ...(typeof detail === "string" ? { detail } : {}),
          },
        ),
      );
    } else if (type === "diagnostic") {
      const detail = Reflect.get(message, "message");
      warnOnce(`Process anchor: ${typeof detail === "string" ? detail : "unknown"}`);
    } else if (type === "dryRun") {
      // CODEXHOST_PROCESS_ANCHOR_DRY_RUN=1: what the anchor would have ended.
      warnOnce(
        `Process anchor dry run: ${JSON.stringify({
          escapees: Reflect.get(message, "escapees"),
          rejected: Reflect.get(message, "rejected"),
        })}`,
      );
    }
  }

  #anchorGone(): void {
    this.#stopWatchingAbort();
    if (this.#start === "pending") {
      this.#begin("failed", new Error("Process anchor exited before the Harness started"));
    }
    if (this.#released) {
      this.#settle(null);
      return;
    }
    // Without its anchor the group id is no longer pinned; retrying would be
    // signalling by a bare pid again. Keep the failure instead.
    this.#lost = new Error(
      "Process anchor exited without confirming the process group was released",
    );
    this.#reportRoundFailure(this.#lost);
  }

  /**
   * A failed round reaches whoever owns it: the waiting close(), nobody when
   * a close() already gave up on it (its caller was told), and otherwise the
   * exit-cleanup report, whether the anchor or a kill() started the round.
   */
  #reportRoundFailure(error: Error): void {
    if (this.#pending) {
      this.#closeOutcomeOwed = false;
      this.#settle(error);
      return;
    }
    if (this.#closeOutcomeOwed) {
      this.#closeOutcomeOwed = false;
      return;
    }
    this.#reportExitCleanupFailure(error);
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
