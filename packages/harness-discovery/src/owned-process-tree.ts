import { spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

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

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (isErrno(error, "ESRCH")) return false;
    // EPERM from the existence probe still proves a group exists. Actual
    // signal failures are observable cleanup failures, never success.
    if (signal === 0 && isErrno(error, "EPERM")) return true;
    throw error;
  }
}

async function waitForGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (signalGroup(pid, 0)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await setTimeout(Math.min(10, remaining));
  }
  return true;
}

function closeWindowsTree(child: ChildProcess, timeoutMs: number, leaderExited: boolean): void {
  const pid = child.pid;
  if (!pid) throw new Error("Owned Windows process tree has no process id");
  if (leaderExited || child.exitCode !== null || child.signalCode !== null) {
    throw new Error("Owned Windows process tree cannot be confirmed after its root exited");
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("Windows SystemRoot is unavailable for owned process-tree cleanup");
  }
  const result = spawnSync(
    path.win32.join(systemRoot, "System32", "taskkill.exe"),
    ["/PID", String(pid), "/T", "/F"],
    {
      stdio: "ignore",
      timeout: timeoutMs,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Owned Windows process tree taskkill failed with status ${result.status ?? "unknown"}`,
    );
  }
}

class TrackedOwnedProcessTree implements OwnedProcessTree {
  readonly #child: ChildProcess;
  readonly #onExitCleanupFailure: ((error: unknown) => void) | undefined;
  readonly #pid: number;
  readonly #timeoutMs: number;
  #closePromise: Promise<void> | null = null;
  #leaderExited = false;

  constructor(child: ChildProcess, options: OwnedProcessTreeOptions) {
    if (!child.pid) throw new Error("Owned process tree requires a process id");
    this.#child = child;
    this.#onExitCleanupFailure = options.onExitCleanupFailure;
    this.#pid = child.pid;
    this.#timeoutMs = options.closeTimeoutMs;
    child.once("exit", () => {
      this.#leaderExited = true;
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
    if (this.#closePromise) return this.#closePromise;
    const closing = this.#close();
    this.#closePromise = closing;
    void closing.then(
      () => undefined,
      () => undefined,
    );
    return closing;
  }

  async #close(): Promise<void> {
    if (process.platform === "win32") {
      closeWindowsTree(this.#child, this.#timeoutMs, this.#leaderExited);
      return;
    }
    // This tracker is only made for a detached POSIX spawn. Its pid is the
    // owned process-group id, so no parent pid, process name, or global scan
    // is ever signalled. A leader can exit before its descendants do.
    if (!signalGroup(this.#pid, "SIGTERM")) return;
    if (await waitForGroupExit(this.#pid, this.#timeoutMs)) return;
    if (!signalGroup(this.#pid, "SIGKILL")) return;
    if (!(await waitForGroupExit(this.#pid, this.#timeoutMs))) {
      throw new Error("Owned process group did not exit within cleanup bounds");
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
