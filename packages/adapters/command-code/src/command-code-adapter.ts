import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";

import {
  sanitizeDiagnosticTail,
  type HarnessAdapter,
  type HarnessError,
  type HarnessInspection,
  type HarnessResult,
  type HarnessSession,
  type HostTurnSnapshot,
  type InspectHarnessInput,
  type OpenSessionInput,
} from "@codexhost/harness-adapter";
import { commandInvocation } from "@codexhost/harness-discovery";
import {
  nativeSessionRefSchema,
  type HarnessId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import { resolveCommandCodeExecutable } from "./command.js";
import {
  COMMAND_CODE_CAPABILITIES,
  COMMAND_CODE_HARNESS_ID,
  CommandCodeSession,
  invalidState,
} from "./command-code-session.js";
import {
  decodeCommandCodeModelRef,
  isCommandCodeEffort,
  parseCommandCodeModels,
} from "./model-catalog.js";
import {
  COMMAND_CODE_DEFAULT_PERMISSION_MODE,
  COMMAND_CODE_PERMISSION_MODE_CATALOG,
  decodeCommandCodePermissionModeId,
  type CommandCodePermissionMode,
} from "./permission-modes.js";
import { commandCodeExitError } from "./print-errors.js";
import { COMMAND_CODE_DEFAULT_MAX_TURNS } from "./print-turn.js";
import {
  canonicalCommandCodePath,
  commandCodeSessionTurns,
  findCommandCodeSessionFile,
  sameCommandCodeCwd,
  type CommandCodeSessionFile,
} from "./session-file.js";

export interface CommandCodeAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  inspectTimeoutMs?: number;
  maxTurns?: number;
  toolOutputLimit?: number;
}

const DEFAULT_INSPECT_TIMEOUT_MS = 20_000;
const DEFAULT_TOOL_OUTPUT_LIMIT = 64_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unsupported(message: string): HarnessError {
  return { code: "unsupported", message, retryable: false };
}

async function runBuffered(
  executable: string,
  arguments_: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const invocation = commandInvocation(executable, arguments_, environment);
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.arguments, {
      cwd,
      env: environment,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command Code timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

export class CommandCodeAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = COMMAND_CODE_HARNESS_ID;
  readonly #command: string | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #inspectTimeoutMs: number;
  readonly #maxTurns: number;
  readonly #sessions = new Set<CommandCodeSession>();
  readonly #toolOutputLimit: number;
  #closed = false;
  #closeTask: Promise<void> | null = null;
  #inspection: Extract<HarnessInspection, { status: "ready" }> | null = null;
  #inspectionInFlight: Promise<HarnessInspection> | null = null;

  constructor(options: CommandCodeAdapterOptions = {}) {
    this.#command = options.command;
    this.#environment = options.environment ?? process.env;
    this.#inspectTimeoutMs = options.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS;
    this.#maxTurns = options.maxTurns ?? COMMAND_CODE_DEFAULT_MAX_TURNS;
    this.#toolOutputLimit = options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT;
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closed) {
      return { status: "unavailable", error: invalidState("Command Code Adapter is closed") };
    }
    if (this.#inspectionInFlight) return this.#inspectionInFlight;
    // The Model catalog is account-wide, so a cached reading serves every cwd.
    if (!input.refresh && this.#inspection) return this.#inspection;
    const inspection = this.#inspectNative().then((result) => {
      if (result.status === "ready") this.#inspection = result;
      return result;
    });
    this.#inspectionInFlight = inspection;
    return inspection.finally(() => {
      if (this.#inspectionInFlight === inspection) this.#inspectionInFlight = null;
    });
  }

  async #inspectNative(): Promise<HarnessInspection> {
    const executable = this.#executable();
    if (!executable) {
      return {
        status: "notInstalled",
        error: {
          code: "notInstalled",
          message: "Command Code (command-code) is not installed",
          retryable: false,
        },
      };
    }
    try {
      // `--list-models` has no cwd side effects; the home directory keeps it away
      // from any workspace the CLI might otherwise treat as a project.
      const { stdout, stderr, code } = await runBuffered(
        executable,
        ["--list-models", "--no-auto-update"],
        os.homedir(),
        this.#environment,
        this.#inspectTimeoutMs,
      );
      if (code !== 0) {
        return {
          status: "error",
          error: { ...commandCodeExitError(code, stderr), stage: "model-catalog" },
        };
      }
      const catalog = parseCommandCodeModels(stdout);
      if (catalog.models.length === 0) {
        return {
          status: "error",
          error: {
            code: "protocolError",
            message: "Command Code listed no Models",
            retryable: true,
            stage: "model-catalog",
            ...(stderr.trim() ? { stderrTail: sanitizeDiagnosticTail(stderr).slice(-4_000) } : {}),
          },
        };
      }
      return {
        status: "ready",
        catalog,
        permissionModes: COMMAND_CODE_PERMISSION_MODE_CATALOG,
        capabilities: COMMAND_CODE_CAPABILITIES,
      };
    } catch (error) {
      return {
        status: "error",
        error: {
          code: "nativeFailure",
          message: errorMessage(error),
          retryable: true,
          stage: "model-catalog",
        },
      };
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) return { ok: false, error: invalidState("Command Code Adapter is closed") };
    if (input.kind === "fork") {
      return { ok: false, error: unsupported("Command Code does not support checkpoint Fork") };
    }
    if (input.kind === "rollbackLastTurn") {
      return { ok: false, error: unsupported("Command Code does not support last-Turn rollback") };
    }
    if (!input.cwd) {
      return {
        ok: false,
        error: { code: "invalidRequest", message: "Command Code requires cwd", retryable: false },
      };
    }
    let permissionMode: CommandCodePermissionMode = COMMAND_CODE_DEFAULT_PERMISSION_MODE;
    if (input.permissionModeId) {
      try {
        permissionMode = decodeCommandCodePermissionModeId(input.permissionModeId);
      } catch (error) {
        return {
          ok: false,
          error: { code: "invalidRequest", message: errorMessage(error), retryable: false },
        };
      }
    }
    const executable = this.#executable();
    if (!executable) {
      return {
        ok: false,
        error: { code: "notInstalled", message: "Command Code is not installed", retryable: false },
      };
    }
    // Tool targets arrive symlink-resolved, so the Session cwd must match that form.
    const cwd = await canonicalCommandCodePath(input.cwd);
    const environment = { ...this.#environment, ...(input.environment ?? {}) };
    let catalog = this.#inspection?.catalog;
    if (!catalog && !(input.kind === "resume" && input.historyOnly)) {
      const inspection = await this.inspect({ cwd });
      if (inspection.status === "ready") catalog = inspection.catalog;
    }
    if (input.model) {
      try {
        decodeCommandCodeModelRef(input.model);
      } catch (error) {
        return {
          ok: false,
          error: { code: "invalidRequest", message: errorMessage(error), retryable: false },
        };
      }
    }
    if (input.thinkingOptionId && !isCommandCodeEffort(input.thinkingOptionId)) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Command Code effort must be low, medium or high",
          retryable: false,
        },
      };
    }

    let nativeRef: NativeSessionRef | undefined;
    let sessionFile: CommandCodeSessionFile | null = null;
    let turns: HostTurnSnapshot[] = [];
    if (input.kind === "resume") {
      const parsed = nativeSessionRefSchema.safeParse(input.nativeRef);
      if (!parsed.success || parsed.data.harnessId !== this.harnessId) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Command Code cannot resume another Harness Session",
            retryable: false,
          },
        };
      }
      nativeRef = parsed.data;
      sessionFile = await findCommandCodeSessionFile(environment, nativeRef.nativeSessionId);
      if (!sessionFile) {
        return {
          ok: false,
          error: {
            code: "sessionNotFound",
            message: "Command Code Session transcript was not found under ~/.commandcode/projects",
            retryable: false,
          },
        };
      }
      if (!(await sameCommandCodeCwd(sessionFile.header.cwd, cwd))) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Command Code Session belongs to a different working directory",
            retryable: false,
          },
        };
      }
      try {
        turns = commandCodeSessionTurns({
          content: await readFile(sessionFile.path, "utf8"),
          harnessId: this.harnessId,
          nativeSessionId: nativeRef.nativeSessionId,
          toolOutputLimit: this.#toolOutputLimit,
        });
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "nativeFailure",
            message: `Command Code Session transcript could not be read: ${errorMessage(error)}`,
            retryable: true,
          },
        };
      }
    }
    const session = new CommandCodeSession({
      ...(catalog ? { catalog } : {}),
      cwd,
      environment,
      executable,
      maxTurns: this.#maxTurns,
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinkingOptionId ? { effort: input.thinkingOptionId } : {}),
      ...(nativeRef ? { nativeRef } : {}),
      permissionMode,
      ...(sessionFile ? { sessionFilePath: sessionFile.path } : {}),
      toolOutputLimit: this.#toolOutputLimit,
      turns,
      onClosed: () => this.#sessions.delete(session),
    });
    this.#sessions.add(session);
    return { ok: true, value: session };
  }

  close(): Promise<void> {
    if (this.#closeTask) return this.#closeTask;
    this.#closed = true;
    this.#inspection = null;
    this.#closeTask = Promise.allSettled(
      [...this.#sessions].map((session) => session.close()),
    ).then((results) => {
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length) {
        throw new AggregateError(
          failures.map((result) => result.reason),
          "Command Code resource cleanup failed",
        );
      }
    });
    return this.#closeTask;
  }

  #executable(): string | undefined {
    return resolveCommandCodeExecutable({
      ...(this.#command ? { command: this.#command } : {}),
      environment: this.#environment,
    });
  }
}
