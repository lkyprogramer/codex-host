/**
 * One Host Turn is one `command-code -p` process. Print mode has no long-lived
 * transport: the prompt goes in on stdin, AgentEvent frames stream out on
 * stdout, the final `result` line closes the run, and the next Turn resumes
 * the persisted Session by transcript path.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";

import type { HarnessModelRef, HarnessThinkingOptionId } from "@codexhost/shared-contracts";
import {
  commandInvocation,
  trackOwnedProcessTree,
  type OwnedProcessTree,
} from "@codexhost/harness-discovery";

import { commandCodeModelArguments } from "./model-catalog.js";
import {
  commandCodePermissionArguments,
  type CommandCodePermissionMode,
} from "./permission-modes.js";
import { parseCommandCodeStreamLine, type CommandCodeStreamLine } from "./stream-events.js";

export const COMMAND_CODE_DEFAULT_MAX_TURNS = 100;

export interface CommandCodePrintPlan {
  /** Transcript of the Session to continue; a new Session starts when absent. */
  sessionFilePath?: string;
  /** Continue by ID when the transcript path is not known. */
  nativeSessionId?: string;
  /** Derive a new Session from the resumed one instead of appending to it. */
  forkSession?: boolean;
  model?: HarnessModelRef;
  effort?: HarnessThinkingOptionId;
  permissionMode: CommandCodePermissionMode;
  maxTurns: number;
}

/**
 * Builds the print-mode argument list. The prompt is deliberately not an
 * argument: stdin has no length limit and cannot be mistaken for a flag.
 */
export function commandCodePrintArguments(plan: CommandCodePrintPlan): string[] {
  const arguments_ = [
    "-p",
    "--output-format",
    "json",
    "--skip-onboarding",
    "--trust",
    "--no-auto-update",
    "--max-turns",
    String(plan.maxTurns),
  ];
  if (plan.sessionFilePath) arguments_.push("--session", plan.sessionFilePath);
  else if (plan.nativeSessionId) arguments_.push("--resume", plan.nativeSessionId);
  if (plan.forkSession && (plan.sessionFilePath || plan.nativeSessionId)) {
    arguments_.push("--fork-session");
  }
  arguments_.push(...commandCodeModelArguments(plan.model, plan.effort));
  arguments_.push(...commandCodePermissionArguments(plan.permissionMode));
  return arguments_;
}

export interface CommandCodePrintProcess {
  readonly process: ChildProcessByStdio<Writable, Readable, Readable>;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Graceful-then-forced shutdown of the whole owned process tree. */
  stop(): Promise<void>;
}

export interface SpawnCommandCodePrintInput {
  executable: string;
  arguments: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  prompt: string;
  onLine(line: CommandCodeStreamLine): void;
  /** Non-protocol stdout lines and stderr chunks, for diagnostics. */
  onDiagnostic(text: string): void;
  onError(error: Error): void;
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
}

export function spawnCommandCodePrint(input: SpawnCommandCodePrintInput): CommandCodePrintProcess {
  const invocation = commandInvocation(input.executable, input.arguments, input.environment);
  const detached = process.platform !== "win32";
  const child = spawn(invocation.command, invocation.arguments, {
    cwd: input.cwd,
    env: input.environment,
    detached,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const processTree: OwnedProcessTree | null =
    process.platform === "win32"
      ? null
      : trackOwnedProcessTree(child, { detached, closeTimeoutMs: 2_000 });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.on("error", () => undefined);
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => input.onDiagnostic(chunk));
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const parsed = parseCommandCodeStreamLine(line);
    if (parsed) input.onLine(parsed);
    else if (line.trim()) input.onDiagnostic(`${line}\n`);
  });
  child.once("error", (error) => input.onError(error));
  child.once("close", (code, signal) => input.onExit(code, signal));
  if (child.stdin.writable) child.stdin.end(input.prompt);
  return {
    process: child,
    exited,
    stop: () => {
      if (processTree) return processTree.close();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      return Promise.resolve();
    },
  };
}
