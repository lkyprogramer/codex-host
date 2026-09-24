import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  type NewSessionResponse,
  type LoadSessionResponse,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { spawnOwnedProcess, type OwnedProcessTree } from "@codexhost/harness-discovery";
import { cursorDiagnostic } from "./diagnostics.js";
import { cursorInvocation } from "./command.js";
import {
  normalizeCursorAvailableModels,
  normalizeCursorParameterizedSession,
  parseCursorNativeModelVariant,
  type CursorAvailableModels,
} from "./model-parameters.js";

export interface CursorTransportOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
  force?: boolean;
}
export type CursorSessionInfo = NewSessionResponse | LoadSessionResponse;
export interface CursorCallbacks {
  update(value: SessionNotification): void;
  permission(value: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  extension(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  notification?(method: string, params: Record<string, unknown>): void;
}
const CLOSE_TIMEOUT_MS = 2_000;

function waitForLeaderExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      child.removeListener("exit", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once("exit", finish);
  });
}

export class CursorTransport {
  sessionId = "";
  replay: SessionNotification[] = [];
  #child: ChildProcessWithoutNullStreams | undefined;
  #ownedProcessTree: OwnedProcessTree | null = null;
  #closePromise: Promise<void> | undefined;
  #connection: ClientSideConnection | undefined;
  #callbacks: CursorCallbacks | undefined;
  #closed = false;
  #fault: Error | undefined;
  #modelDirectory: CursorAvailableModels | undefined;
  #nativeInfo: CursorSessionInfo | undefined;
  #historyOnly = false;
  get closed(): boolean {
    return this.#closed;
  }
  get historyOnly(): boolean {
    return this.#historyOnly;
  }
  #rejectFault!: (error: Error) => void;
  readonly #failed = new Promise<never>((_, reject) => {
    this.#rejectFault = reject;
  });

  constructor(readonly options: CursorTransportOptions) {
    void this.#failed.catch(() => undefined);
  }

  async #bounded<T>(work: Promise<T>, timeout = this.options.timeoutMs ?? 30_000): Promise<T> {
    if (this.#fault) throw this.#fault;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        this.#failed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Cursor ACP request timed out"));
            void this.close();
          }, timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async open(
    sessionId?: string,
    options: { historyOnly?: boolean } = {},
  ): Promise<CursorSessionInfo> {
    if (options.historyOnly && !sessionId)
      throw new Error("Cursor history replay requires a native session ID");
    if (this.#closed || this.#connection) throw new Error("Cursor transport cannot be reopened");
    this.#historyOnly = options.historyOnly === true;
    const invocation = cursorInvocation(
      this.options.environment,
      this.options.command,
      this.options.force,
    );
    const fault = (message: string) => {
      this.#fault = new Error(message);
      this.#rejectFault(this.#fault);
    };
    const { child, tree } = spawnOwnedProcess(invocation.command, invocation.arguments, {
      cwd: this.options.cwd,
      env: this.options.environment,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      closeTimeoutMs: CLOSE_TIMEOUT_MS,
      onExitCleanupFailure: (error) =>
        fault(`Cursor ACP owned process cleanup failed: ${String(error)}`),
    });
    this.#child = child;
    this.#ownedProcessTree = tree;
    child.on("error", () => fault("Cursor ACP process could not start"));
    child.on("exit", (code) => fault(`Cursor ACP process exited (${code ?? "signal"})`));
    child.stderr.resume(); // Native diagnostics may contain secrets; never copy them to Host events.
    this.#connection = new ClientSideConnection(
      () => ({
        sessionUpdate: (value) => {
          if (this.sessionId && value.sessionId !== this.sessionId) return;
          if (this.#callbacks) this.#callbacks.update(value);
          else if (this.replay.length < 100_000) this.replay.push(value);
          else throw new Error("Cursor replay exceeds the supported history limit");
        },
        requestPermission: (value) =>
          this.#callbacks && value.sessionId === this.sessionId
            ? this.#callbacks.permission(value)
            : Promise.resolve({ outcome: { outcome: "cancelled" } }),
        extMethod: (method, params) =>
          this.#callbacks
            ? this.#callbacks.extension(method, params)
            : Promise.resolve({ outcome: { outcome: "cancelled" } }),
        extNotification: async (method, params) => {
          this.#callbacks?.notification?.(method, params);
        },
      }),
      ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    );
    let stage = "initialize";
    try {
      const init = await this.#bounded(
        this.#connection.initialize({
          protocolVersion: 1,
          clientCapabilities: { _meta: { parameterizedModelPicker: true } },
          clientInfo: { name: "codexhost", version: "0.6.2" },
        }),
      );
      if (init.protocolVersion !== 1 || (sessionId && !init.agentCapabilities?.loadSession))
        throw new Error("Cursor does not support the required ACP session protocol");
      // Authentication is delegated to Cursor; its native login behavior is not emulated.
      stage = "authenticate";
      await this.#bounded(this.#connection.authenticate({ methodId: "cursor_login" }));
      stage = sessionId ? "session/load" : "session/new";
      this.sessionId = sessionId ?? "";
      const info = sessionId
        ? await this.#bounded(
            this.#connection.loadSession({ sessionId, cwd: this.options.cwd, mcpServers: [] }),
          )
        : await this.#bounded(
            this.#connection.newSession({ cwd: this.options.cwd, mcpServers: [] }),
          );
      if ("sessionId" in info && typeof info.sessionId === "string")
        this.sessionId = info.sessionId;
      if (!this.sessionId) throw new Error("Cursor returned no native session ID");
      this.#nativeInfo = info;
      // History consumers validate replay against native turn identities. They do
      // not select a model and must not depend on the remote model catalog.
      if (this.#historyOnly) return info;
      stage = "cursor/list_available_models";
      try {
        let directory = await this.#bounded(
          this.#connection.extMethod("cursor/list_available_models", {}),
        );
        // Cursor can return an empty directory after a failed metadata fetch.
        // Refetch this read-only query once; never retry model/parameter writes.
        if (Array.isArray(directory.models) && directory.models.length === 0) {
          directory = await this.#bounded(
            this.#connection.extMethod("cursor/list_available_models", {}),
          );
        }
        this.#modelDirectory = normalizeCursorAvailableModels(directory);
      } catch (error) {
        // Older Cursor releases expose only the original variant catalog.
        if (!(error && typeof error === "object" && "code" in error && error.code === -32601))
          throw error;
      }
      return this.#modelDirectory
        ? normalizeCursorParameterizedSession(info, this.#modelDirectory, {
            allowUnknownCurrent: true,
          })
        : info;
    } catch (error) {
      await this.close();
      throw new Error(`Cursor ACP ${stage}: ${cursorDiagnostic(error)}`, { cause: error });
    }
  }

  async configure(configId: string, value: string) {
    if (this.#historyOnly) throw new Error("Cursor history replay cannot configure a session");
    if (!this.#connection) throw new Error("Cursor session is not open");
    if (this.#modelDirectory && this.#nativeInfo) {
      let stage = configId;
      try {
        const selections: Array<[string, string]> =
          configId === "model"
            ? (() => {
                const selected = parseCursorNativeModelVariant(value);
                const currentModel = this.#nativeInfo?.configOptions?.find(
                  (option) => option.id === "model",
                )?.currentValue;
                const modelSelection: Array<[string, string]> =
                  currentModel === selected.modelId ? [] : [["model", selected.modelId]];
                return [...modelSelection, ...Object.entries(selected.parameters)];
              })()
            : [[configId, value]];
        for (const [id, selectedValue] of selections) {
          // Native readback is authoritative. Rewriting an already selected value
          // needlessly refetches Cursor's remote catalog and can fail a valid session.
          if (
            this.#nativeInfo.configOptions?.some(
              (option) => option.id === id && option.currentValue === selectedValue,
            )
          )
            continue;
          stage = id;
          const result = await this.#bounded(
            this.#connection.setSessionConfigOption({
              sessionId: this.sessionId,
              configId: id,
              value: selectedValue,
            }),
          );
          if (
            !result.configOptions.some(
              (option) => option.id === id && option.currentValue === selectedValue,
            )
          )
            throw new Error("Cursor did not confirm model parameter selection");
          this.#nativeInfo = { ...this.#nativeInfo, configOptions: result.configOptions };
        }
        const normalized = normalizeCursorParameterizedSession(
          this.#nativeInfo,
          this.#modelDirectory,
        );
        return { configOptions: normalized.configOptions ?? [] };
      } catch (error) {
        // A base model or earlier parameter may already have changed. Retire this
        // transport instead of continuing with stale Host configuration.
        await this.close();
        throw new Error(`Cursor ACP config '${stage}': ${cursorDiagnostic(error)}`, {
          cause: error,
        });
      }
    }
    return this.#bounded(
      this.#connection.setSessionConfigOption({ sessionId: this.sessionId, configId, value }),
    );
  }

  async prompt(text: string, callbacks: CursorCallbacks) {
    if (this.#historyOnly) throw new Error("Cursor history replay cannot prompt a session");
    if (!this.#connection || this.#closed || this.#callbacks)
      throw new Error("Cursor session is closed or busy");
    this.#callbacks = callbacks;
    try {
      // Native turns have no arbitrary wall-clock deadline; cancellation/close/process exit settle them.
      return await Promise.race([
        this.#connection.prompt({ sessionId: this.sessionId, prompt: [{ type: "text", text }] }),
        this.#failed,
      ]);
    } finally {
      this.#callbacks = undefined;
    }
  }

  async cancel() {
    if (this.#historyOnly) throw new Error("Cursor history replay cannot cancel a session");
    if (this.#connection && !this.#closed)
      await this.#bounded(this.#connection.cancel({ sessionId: this.sessionId }));
  }

  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#fault = new Error("Cursor session closed");
      this.#rejectFault(this.#fault);
    }
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    const processTree = this.#ownedProcessTree;
    if (!processTree) {
      throw new Error("Cursor ACP owned process tree is unavailable");
    }
    if (process.platform === "win32") {
      // taskkill must run while its root is still addressable; Windows has no
      // detached POSIX group that can be proven after the root exits.
      await processTree.close();
    } else {
      child.stdin.end();
      // The native CLI may exit before an MCP/tool descendant. Its leader exit
      // only bounds graceful shutdown; the tracked group is final authority.
      await waitForLeaderExit(child, 500);
      await processTree.close();
    }
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
  }
}
