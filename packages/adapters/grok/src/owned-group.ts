import { spawnSync } from "node:child_process";

/**
 * Ownership rules for the process group this Adapter spawned. A reclaim may
 * only signal a group it can still attribute to its own spawn, and may only
 * report a release it actually observed.
 */
export interface OwnedGroupRef {
  /** Process id of the spawned leader. */
  pid: number;
  /** Process group id on POSIX; the leader pid on Windows. */
  pgid: number;
  /** `ps -o lstart` of the leader at spawn time, or "" when unavailable. */
  startToken: string;
  /** True once the tracked ChildProcess handle reported its exit. */
  leaderExited: boolean;
}

/** What the recorded identity says about the pid this reclaim would signal. */
type Ownership = "ours" | "gone" | "unprovable";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM" ? true : false;
  }
}

export function processStartToken(pid: number): string {
  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.stdout.trim();
  } catch {
    return "";
  }
}

export function processGroupIsAlive(pgid: number): boolean {
  if (process.platform === "win32") return processIsAlive(Math.abs(pgid));
  try {
    process.kill(pgid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM" ? true : false;
  }
}

export function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(Math.abs(pgid)), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pgid, signal);
  } catch (error) {
    if (!isRecord(error)) throw error;
    // ESRCH: the group is gone. EPERM: it exists but cannot be signalled,
    // which is what a group down to an unreaped zombie answers. Neither is a
    // failure here; the caller's bounded liveness check decides.
    if (error.code !== "ESRCH" && error.code !== "EPERM") throw error;
  }
}

/**
 * A live leader pid is the only way this group id could have been recycled:
 * while any member survives, the kernel keeps the group id reserved, so a
 * leaderless group still belongs to this spawn. A live pid that no longer
 * matches the recorded start token therefore proves the opposite - the spawn
 * is gone and its id was handed to someone else, who must never be signalled.
 */
function ownership(owned: OwnedGroupRef): Ownership {
  if (!processIsAlive(owned.pid)) return "ours";
  if (!owned.startToken) return "unprovable";
  return processStartToken(owned.pid) === owned.startToken ? "ours" : "gone";
}

async function waitWhile(alive: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (Date.now() < deadline && alive()) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Bounded TERM then KILL of one owned group, resolving to true when the group
 * could not be confirmed gone. Never reports a release it cannot observe, and
 * never signals a pid it can no longer attribute to this spawn.
 */
export async function reclaimOwnedGroup(owned: OwnedGroupRef, timeoutMs: number): Promise<boolean> {
  const alive = () => processGroupIsAlive(owned.pgid);
  if (!alive()) return false;
  if (process.platform === "win32") {
    // Windows has no owned group: taskkill addresses the tree through the
    // living root. Once that root is gone the tree is unreachable and its
    // state unknowable, so this reports unconfirmed rather than success.
    if (owned.leaderExited || !processIsAlive(owned.pid)) return true;
    signalProcessGroup(owned.pgid, "SIGKILL");
    await waitWhile(alive, timeoutMs);
    return alive();
  }
  const owner = ownership(owned);
  // Neither a recycled pid nor an unprovable one may be signalled: one is
  // somebody else's process, the other cannot be told apart from it.
  if (owner === "gone") return false;
  if (owner === "unprovable") return true;
  signalProcessGroup(owned.pgid, "SIGTERM");
  await waitWhile(alive, timeoutMs);
  if (alive()) signalProcessGroup(owned.pgid, "SIGKILL");
  await waitWhile(alive, timeoutMs);
  return alive();
}
