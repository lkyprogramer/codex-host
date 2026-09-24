import { randomBytes } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";

import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";
import {
  spawnOwnedProcess,
  type OwnedProcess,
  type OwnedProcessTree,
} from "@codexhost/harness-discovery";

import {
  OpenCodeExecutableError,
  openCodeServerInvocation,
  resolveOpenCodeExecutable,
} from "./command.js";
import { OpenCodeTransportError } from "./protocol.js";

export interface OpenCodeServerOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  commandTimeoutMs?: number;
  closeTimeoutMs?: number;
  reconnectDelayMs?: number;
  reconnectAttempts?: number;
}

interface SpawnOptions {
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  closeTimeoutMs: number;
  onExitCleanupFailure(error: unknown): void;
}

export interface OpenCodeServerDependencies {
  createClient(options: {
    baseUrl: string;
    directory?: string;
    headers: Record<string, string>;
  }): OpencodeClient;
  randomPassword(): string;
  spawn(
    command: string,
    args: string[],
    options: SpawnOptions,
  ): OwnedProcess<ChildProcessWithoutNullStreams>;
  sleep(milliseconds: number): Promise<void>;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;
const SERVER_USERNAME = "codexhost";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingExecutable(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function classifySdkError(error: unknown, operation: string): OpenCodeTransportError {
  if (error instanceof OpenCodeTransportError) return error;
  const text = errorText(error);
  const lower = text.toLowerCase();
  if (lower.includes("unauthorized") || lower.includes("authentication")) {
    return new OpenCodeTransportError(
      "authenticationRequired",
      `OpenCode ${operation} requires authentication`,
      { cause: error },
    );
  }
  return new OpenCodeTransportError("unavailable", `OpenCode ${operation} failed: ${text}`, {
    cause: error,
  });
}

function responseData<T>(response: { data: T | undefined; error: unknown }, operation: string): T {
  if (response.error !== undefined) throw classifySdkError(response.error, operation);
  if (!("data" in response) || response.data === undefined) {
    throw new OpenCodeTransportError(
      "protocolError",
      `OpenCode ${operation} response did not contain data`,
    );
  }
  return response.data as T;
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, operation: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new OpenCodeTransportError("unavailable", `${operation} timed out`)),
        milliseconds,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export interface OpenCodeServerConnectionLike {
  readonly stderrTail: string;
  client(cwd?: string): Promise<OpencodeClient>;
  close(): Promise<void>;
}

export function managedOpenCodeEnvironment(
  environment: Record<string, string | undefined> | undefined,
  executionPolicy: "default" | "unattended-full-access" = "default",
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...(environment ?? process.env) };
  const undefinedKeys = Object.entries(merged)
    .filter(([, value]) => value === undefined)
    .map(([key]) => key);
  for (const key of undefinedKeys) {
    Reflect.deleteProperty(merged, key);
  }
  if (executionPolicy === "unattended-full-access") {
    const existing = merged.OPENCODE_CONFIG_CONTENT;
    let config: Record<string, unknown> = {};
    if (existing !== undefined) {
      try {
        const parsed: unknown = JSON.parse(existing);
        if (!isRecord(parsed)) throw new Error("OpenCode config content must be an object");
        config = { ...parsed };
      } catch (error) {
        throw new OpenCodeTransportError(
          "unavailable",
          "OpenCode unattended execution requires valid JSON OPENCODE_CONFIG_CONTENT",
          { cause: error },
        );
      }
    }
    // This environment belongs to one managed Server only. Never use the
    // shared process-wide `always` reply; `allow` is the native config action
    // applied before this dedicated Server accepts any Session.
    merged.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...config, permission: "allow" });
  }
  return merged;
}

export class OpenCodeServerConnection implements OpenCodeServerConnectionLike {
  readonly #closeTimeoutMs: number;
  readonly #dependencies: OpenCodeServerDependencies;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #options: OpenCodeServerOptions;
  readonly #startupTimeoutMs: number;
  #child: ChildProcessWithoutNullStreams | null = null;
  #ownedProcessTree: OwnedProcessTree | null = null;
  #childStopPromise: Promise<void> | null = null;
  #childStopping: ChildProcessWithoutNullStreams | null = null;
  #closed = false;
  #closing = false;
  #closePromise: Promise<void> | null = null;
  #connection: Promise<{ baseUrl: string; authorization: string }> | null = null;
  #stderrTail = "";

  constructor(
    options: OpenCodeServerOptions = {},
    dependencies: OpenCodeServerDependencies = {
      createClient: (input) => createOpencodeClient(input),
      randomPassword: () => randomBytes(32).toString("base64url"),
      spawn: (command, args, spawnOptions) => spawnOwnedProcess(command, args, spawnOptions),
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    },
  ) {
    this.#options = options;
    this.#environment = options.environment ?? process.env;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#dependencies = dependencies;
  }

  get stderrTail(): string {
    return this.#stderrTail;
  }

  async client(cwd?: string): Promise<OpencodeClient> {
    const connection = await this.#connect();
    this.#assertOpen();
    return this.#dependencies.createClient({
      baseUrl: connection.baseUrl,
      ...(cwd ? { directory: cwd } : {}),
      headers: { Authorization: connection.authorization },
    });
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    const closing = this.#performClose();
    this.#closePromise = closing;
    void closing.then(
      () => {
        if (this.#closePromise === closing) this.#closed = true;
      },
      () => {
        // Keep admission closed and retain the ownership handle. The tracked
        // group will keep reporting its verified cleanup failure instead of
        // later guessing that a recycled pid is still ours.
        if (this.#closePromise === closing) this.#closePromise = null;
      },
    );
    return closing;
  }

  #assertOpen(): void {
    if (this.#closing || this.#closed) {
      throw new OpenCodeTransportError("unavailable", "OpenCode Server connection is closing");
    }
  }

  #connect(): Promise<{ baseUrl: string; authorization: string }> {
    try {
      this.#assertOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    if (!this.#connection) {
      const connection = this.#start();
      this.#connection = connection;
      void connection.catch(() => {
        if (this.#connection === connection) this.#connection = null;
      });
    }
    return this.#connection;
  }

  async #start(): Promise<{ baseUrl: string; authorization: string }> {
    const startedAt = Date.now();
    const staleChild = this.#child;
    if (staleChild) await this.#stopChild(staleChild);
    this.#assertOpen();
    let executable: string;
    try {
      executable = resolveOpenCodeExecutable({
        ...(this.#options.command ? { command: this.#options.command } : {}),
        environment: this.#environment,
      });
    } catch (error) {
      if (error instanceof OpenCodeExecutableError) {
        throw new OpenCodeTransportError("notInstalled", error.message, { cause: error });
      }
      throw error;
    }
    const password = this.#dependencies.randomPassword();
    const environment = {
      ...this.#environment,
      OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
      OPENCODE_SERVER_PASSWORD: password,
    };
    const invocation = openCodeServerInvocation(executable, environment);
    let owned: OwnedProcess<ChildProcessWithoutNullStreams>;
    try {
      owned = this.#dependencies.spawn(invocation.command, invocation.arguments, {
        env: environment,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        closeTimeoutMs: this.#closeTimeoutMs,
        onExitCleanupFailure: (error) => {
          this.#stderrTail = sanitizeDiagnosticTail(
            `${this.#stderrTail}OpenCode Server process cleanup failed: ${errorText(error)}\n`,
          );
        },
      });
    } catch (error) {
      throw new OpenCodeTransportError(
        isMissingExecutable(error) ? "notInstalled" : "unavailable",
        isMissingExecutable(error)
          ? "OpenCode CLI is not installed"
          : "OpenCode Server failed to start",
        { cause: error },
      );
    }
    const child = owned.child;
    this.#child = child;
    this.#ownedProcessTree = owned.tree;
    child.once("exit", () => {
      if (this.#child !== child) return;
      this.#connection = null;
      // The tracker starts cleanup at the exit boundary. Keep the child and
      // its owned tree until that shared close has verified the group is gone.
      void this.#stopChild(child).catch((error: unknown) => {
        this.#stderrTail = sanitizeDiagnosticTail(
          `${this.#stderrTail}OpenCode Server process cleanup failed: ${errorText(error)}\n`,
        );
      });
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.#stderrTail = sanitizeDiagnosticTail(`${this.#stderrTail}${chunk.toString()}`);
    });
    const address = new Promise<string>((resolve, reject) => {
      let output = "";
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        callback();
      };
      child.stdout.on("data", (chunk: Buffer | string) => {
        output += chunk.toString();
        const lines = output.split(/\r?\n/u);
        output = lines.pop() ?? "";
        for (const line of lines) {
          const match = line.match(
            /^opencode server listening on (http:\/\/127\.0\.0\.1:\d+)\s*$/u,
          );
          const baseUrl = match?.[1];
          if (baseUrl) finish(() => resolve(baseUrl));
        }
      });
      child.once("error", (error) =>
        finish(() =>
          reject(
            new OpenCodeTransportError(
              isMissingExecutable(error) ? "notInstalled" : "unavailable",
              isMissingExecutable(error)
                ? "OpenCode CLI is not installed"
                : `OpenCode Server failed to start: ${error.message}`,
              { cause: error },
            ),
          ),
        ),
      );
      child.once("exit", (code, signal) =>
        finish(() =>
          reject(
            new OpenCodeTransportError(
              "processExited",
              `OpenCode Server exited before startup completed (${signal ?? code ?? "unknown"})`,
            ),
          ),
        ),
      );
    });
    try {
      const baseUrl = await withTimeout(address, this.#startupTimeoutMs, "OpenCode Server startup");
      const authorization = `Basic ${Buffer.from(`${SERVER_USERNAME}:${password}`, "utf8").toString("base64")}`;
      const client = this.#dependencies.createClient({
        baseUrl,
        headers: { Authorization: authorization },
      });
      const remainingStartupMs = Math.max(1, this.#startupTimeoutMs - (Date.now() - startedAt));
      const health = responseData<{ healthy: true; version: string }>(
        await withTimeout(
          client.global.health(),
          remainingStartupMs,
          "OpenCode Server health check",
        ),
        "health check",
      );
      if (health.healthy !== true || typeof health.version !== "string") {
        throw new OpenCodeTransportError(
          "protocolError",
          "OpenCode Server returned an invalid health response",
        );
      }
      return { baseUrl, authorization };
    } catch (error) {
      try {
        await this.#stopChild(child);
      } catch (cleanupError) {
        throw new OpenCodeTransportError(
          "processExited",
          `OpenCode Server startup failed and process cleanup also failed: ${errorText(cleanupError)}`,
          {
            cause: new AggregateError(
              [error, cleanupError],
              "OpenCode Server startup cleanup failed",
            ),
          },
        );
      }
      throw classifySdkError(error, "Server startup");
    }
  }

  async #stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.#childStopping === child && this.#childStopPromise) return this.#childStopPromise;
    const processTree = this.#child === child ? this.#ownedProcessTree : null;
    if (!processTree) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      throw new OpenCodeTransportError(
        "processExited",
        "OpenCode Server ownership handle is unavailable",
      );
    }
    const stopping = processTree.close();
    this.#childStopping = child;
    this.#childStopPromise = stopping;
    void stopping.then(
      () => {
        if (this.#childStopping !== child || this.#childStopPromise !== stopping) return;
        this.#childStopping = null;
        this.#childStopPromise = null;
        if (this.#child === child) {
          this.#child = null;
          this.#ownedProcessTree = null;
        }
      },
      () => {
        if (this.#childStopping !== child || this.#childStopPromise !== stopping) return;
        this.#childStopping = null;
        this.#childStopPromise = null;
      },
    );
    return stopping;
  }

  async #performClose(): Promise<void> {
    const child = this.#child;
    if (child) await this.#stopChild(child);
    this.#connection = null;
  }
}
