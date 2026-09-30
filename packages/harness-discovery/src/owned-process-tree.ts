import { execFile, type ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export interface OwnedProcessTreeOptions {
  /** Must reflect the options used for the original spawn. */
  detached: boolean;
  /** Bound for both the graceful and forced shutdown phases. */
  closeTimeoutMs: number;
  /** Receives asynchronous cleanup failures observed after the leader exits. */
  onExitCleanupFailure?(error: unknown): void;
}

export interface OwnedProcessTree {
  close(): Promise<void>;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

/**
 * `gone` is proof the group is empty. `blocked` (EPERM) proves it still exists
 * without saying the signal landed: a group whose last member is an unreaped
 * zombie answers every signal that way, and so does one this process may not
 * signal. Neither is decided here; the bounded wait is what settles it.
 */
type GroupSignal = "delivered" | "blocked" | "gone";

function signalGroup(pid: number, signal: NodeJS.Signals | 0): GroupSignal {
  try {
    process.kill(-pid, signal);
    return "delivered";
  } catch (error) {
    if (isErrno(error, "ESRCH")) return "gone";
    if (isErrno(error, "EPERM")) return "blocked";
    throw error;
  }
}

async function waitForGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (signalGroup(pid, 0) !== "gone") {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await setTimeout(Math.min(10, remaining));
  }
  return true;
}

async function closeWindowsTree(
  child: ChildProcess,
  timeoutMs: number,
  leaderExited: boolean,
): Promise<void> {
  const pid = child.pid;
  if (!pid) throw new Error("Owned Windows process tree has no process id");
  if (leaderExited || child.exitCode !== null || child.signalCode !== null) {
    throw new Error("Owned Windows process tree cannot be confirmed after its root exited");
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("Windows SystemRoot is unavailable for owned process-tree cleanup");
  }
  // Asynchronous: a synchronous taskkill would stall every Thread on the Host
  // event loop for as long as the tree takes to die.
  try {
    await executeFile(
      path.win32.join(systemRoot, "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      { timeout: timeoutMs, windowsHide: true },
    );
  } catch (error) {
    const status = typeof error === "object" && error !== null ? Reflect.get(error, "code") : null;
    throw new Error(
      `Owned Windows process tree taskkill failed with status ${typeof status === "number" ? status : "unknown"}`,
      { cause: error },
    );
  }
}

class TrackedOwnedProcessTree implements OwnedProcessTree {
  readonly #child: ChildProcess;
  readonly #onExitCleanupFailure: ((error: unknown) => void) | undefined;
  readonly #pid: number;
  readonly #timeoutMs: number;
  #closePromise: Promise<void> | null = null;
  #closeFailed = false;
  #leaderExited = false;

  constructor(child: ChildProcess, options: OwnedProcessTreeOptions) {
    if (!child.pid) throw new Error("Owned process tree requires a process id");
    this.#child = child;
    this.#onExitCleanupFailure = options.onExitCleanupFailure;
    this.#pid = child.pid;
    this.#timeoutMs = options.closeTimeoutMs;
    child.once("exit", () => {
      this.#leaderExited = true;
      // Windows reaches a tree only through its living root, so a cleanup
      // started after the root exited can only fail; it would report a false
      // failure for every Harness that simply finished.
      if (process.platform === "win32") return;
      // The leader's exit is not proof that its detached group is empty. Start
      // cleanup at the observed exit boundary, while this tracker still owns
      // the exact spawn group; later callers share the same operation.
      void this.close().catch((error: unknown) => {
        if (this.#onExitCleanupFailure) this.#onExitCleanupFailure(error);
        else process.emitWarning(`Owned process tree cleanup failed: ${String(error)}`);
      });
    });
  }

  close(): Promise<void> {
    if (this.#closePromise && !(this.#closeFailed && this.#leaderUnreaped())) {
      return this.#closePromise;
    }
    this.#closeFailed = false;
    const closing = this.#close();
    this.#closePromise = closing;
    void closing.then(
      () => undefined,
      () => {
        this.#closeFailed = true;
      },
    );
    return closing;
  }

  /**
   * A failed cleanup may be retried only while Node has not reaped the
   * leader: until then its pid, and on POSIX its process-group id, cannot
   * belong to anyone else. Once it has been reaped the failure stays failed,
   * because replaying it would signal whatever owns that pid by then.
   */
  #leaderUnreaped(): boolean {
    return !this.#leaderExited && this.#child.exitCode === null && this.#child.signalCode === null;
  }

  async #close(): Promise<void> {
    if (process.platform === "win32") {
      await closeWindowsTree(this.#child, this.#timeoutMs, this.#leaderExited);
      return;
    }
    // This tracker is only made for a detached POSIX spawn. Its pid is the
    // owned process-group id, so no parent pid, process name, or global scan
    // is ever signalled. A leader can exit before its descendants do.
    if (signalGroup(this.#pid, "SIGTERM") === "gone") return;
    if (await waitForGroupExit(this.#pid, this.#timeoutMs)) return;
    const forced = signalGroup(this.#pid, "SIGKILL");
    if (forced === "gone") return;
    if (!(await waitForGroupExit(this.#pid, this.#timeoutMs))) {
      // A blocked signal is the most useful thing to say about a group that
      // outlived its budget; keep it out of the control flow but in the text.
      throw Object.assign(
        new Error(
          forced === "blocked"
            ? "Owned process group did not exit within cleanup bounds (EPERM)"
            : "Owned process group did not exit within cleanup bounds",
        ),
        forced === "blocked" ? { code: "EPERM" } : {},
      );
    }
  }
}

/**
 * Tracks exactly one process tree created by this Host. POSIX callers must
 * pass the same detached=true used at spawn; without it the child shares the
 * Host process group and is deliberately not eligible for group signalling.
 */
export function trackOwnedProcessTree(
  child: ChildProcess,
  options: OwnedProcessTreeOptions,
): OwnedProcessTree | null {
  if (!child.pid) return null;
  if (process.platform !== "win32" && !options.detached) return null;
  return new TrackedOwnedProcessTree(child, options);
}
