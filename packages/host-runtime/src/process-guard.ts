/**
 * Process-level handling for failures no request owns.
 *
 * Harness plugins run inside the Host process. Without these handlers a
 * single stray rejection or throw from any plugin ends the Host, and with it
 * the official Codex app-server it proxies. A rejection nobody awaited is
 * reported and the Host keeps running: it left no half-updated state behind.
 * An uncaught exception may have, so the Host closes in order (every
 * registered Host stops and releases its Harness Sessions) and exits with a
 * failure, bounded by a deadline.
 */

/** How long an orderly shutdown after an uncaught exception may take. */
export const FATAL_SHUTDOWN_DEADLINE_MS = 30_000;
/**
 * After a run completes the process should end on its own. Anything still
 * holding the event loop past this (a native handle a Session leaked) is not
 * worth waiting for: process anchors end what the Host no longer watches.
 */
export const EXIT_AFTER_RUN_GRACE_MS = 5_000;

type Shutdown = () => void;

const shutdowns = new Set<Shutdown>();

/** Registers what an orderly shutdown stops; returns the unregistration. */
export function onFatalShutdown(shutdown: Shutdown): () => void {
  shutdowns.add(shutdown);
  return () => {
    shutdowns.delete(shutdown);
  };
}

interface GuardedProcess {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  on(event: "uncaughtException", listener: (error: Error) => void): unknown;
  off(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  off(event: "uncaughtException", listener: (error: Error) => void): unknown;
  exitCode?: number | string | null | undefined;
  exit(code?: number): never;
}

export interface ProcessGuardOptions {
  write(line: string): void;
  process?: GuardedProcess;
  fatalShutdownDeadlineMs?: number;
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Installs the handlers; returns their removal. */
export function installProcessGuard(options: ProcessGuardOptions): () => void {
  const target = options.process ?? (process as unknown as GuardedProcess);
  const deadline = options.fatalShutdownDeadlineMs ?? FATAL_SHUTDOWN_DEADLINE_MS;
  let shuttingDown = false;

  const onRejection = (reason: unknown): void => {
    options.write(`codexhost Host: unhandled rejection (continuing): ${describe(reason)}\n`);
  };
  const onException = (error: Error): void => {
    options.write(`codexhost Host: uncaught exception: ${describe(error)}\n`);
    target.exitCode = 1;
    if (shuttingDown) return;
    shuttingDown = true;
    options.write("codexhost Host: closing after an uncaught exception\n");
    setTimeout(() => {
      options.write("codexhost Host: orderly shutdown overran its deadline; exiting\n");
      target.exit(1);
    }, deadline).unref();
    for (const shutdown of [...shutdowns]) {
      try {
        shutdown();
      } catch (shutdownError) {
        options.write(`codexhost Host: shutdown step failed: ${describe(shutdownError)}\n`);
      }
    }
  };
  target.on("unhandledRejection", onRejection);
  target.on("uncaughtException", onException);
  return () => {
    target.off("unhandledRejection", onRejection);
    target.off("uncaughtException", onException);
  };
}

/** Sets the exit code and ends the process if a leaked handle keeps it alive. */
export function exitAfterRun(
  code: number,
  target: Pick<GuardedProcess, "exit" | "exitCode"> = process as unknown as GuardedProcess,
  graceMs = EXIT_AFTER_RUN_GRACE_MS,
): void {
  // A fatal failure during the run keeps its failing code.
  if (target.exitCode !== 1) target.exitCode = code;
  setTimeout(
    () => target.exit(typeof target.exitCode === "number" ? target.exitCode : code),
    graceMs,
  ).unref();
}
