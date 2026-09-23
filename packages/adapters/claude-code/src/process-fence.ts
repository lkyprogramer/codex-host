import { execFile, type ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

/**
 * `gone` is proof the owned group is empty. `blocked` (EPERM) proves it still
 * exists without saying the signal landed: macOS answers that way for a group
 * down to unreaped zombies. The bounded wait, not this call, settles it.
 */
type GroupSignal = "delivered" | "blocked" | "gone";

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
}

/**
 * The kernel never hands out a pid that still names a live process group. Once
 * the tracked leader has been reaped, a live process at its pid therefore
 * proves the owned group is already empty and the id belongs to someone else.
 */
function ownedGroupReleased(child: ChildProcess, pid: number): boolean {
  if (child.exitCode === null && child.signalCode === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function signalGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals | 0): GroupSignal {
  if (ownedGroupReleased(child, pid)) return "gone";
  try {
    process.kill(-pid, signal);
    return "delivered";
  } catch (error) {
    if (errorCode(error) === "ESRCH") return "gone";
    if (errorCode(error) === "EPERM") return "blocked";
    throw error;
  }
}

/** Resolves to the last probe: `gone` once the group is empty, otherwise what it answered. */
async function waitForGroupExit(
  child: ChildProcess,
  pid: number,
  timeoutMs: number,
): Promise<GroupSignal> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = signalGroup(child, pid, 0);
    if (probe === "gone" || Date.now() >= deadline) return probe;
    await setTimeout(10);
  }
}

/** The SDK spawn hook creates an owned process group on Unix, including wrapper children. */
export async function closeClaudeProcessGroup(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Claude process tree cannot be confirmed after its Windows root exited");
    const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!root || !path.win32.isAbsolute(root)) throw new Error("Windows SystemRoot is unavailable");
    await executeFile(
      path.win32.join(root, "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      {
        timeout: timeoutMs,
        windowsHide: true,
      },
    );
    return;
  }
  // Signal even after the wrapper exits: its group can still contain the native CLI or MCP child.
  if (signalGroup(child, pid, "SIGTERM") === "gone") return;
  if ((await waitForGroupExit(child, pid, timeoutMs)) === "gone") return;
  const forced = signalGroup(child, pid, "SIGKILL");
  if (forced === "gone") return;
  const last = await waitForGroupExit(child, pid, timeoutMs);
  if (last === "gone") return;
  // A delivered KILL followed by EPERM probes is a group down to zombies.
  throw new Error(
    forced === "blocked" || last === "blocked"
      ? "Claude SDK process group did not exit (EPERM)"
      : "Claude SDK process group did not exit",
  );
}
