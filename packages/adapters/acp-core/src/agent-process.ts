import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type ClientCapabilities,
  type InitializeResponse,
} from "@agentclientprotocol/sdk";
import { spawnOwnedProcess, type OwnedProcessTree } from "@codexhost/harness-discovery";

import { withDeadline } from "./deadline.js";

export interface AcpAgentStart {
  /** Names the Harness in operations and diagnostics, for example "Grok". */
  readonly label: string;
  readonly invocation: {
    command: string;
    arguments: string[];
    windowsVerbatimArguments: boolean;
  };
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly closeTimeoutMs: number;
  /** Bounds process startup and `initialize` each. */
  readonly startupTimeoutMs: number;
  readonly clientCapabilities: ClientCapabilities;
  /** The client side of the connection: how the agent's requests are answered. */
  readonly client: Client;
  /** The owned process exists: take it before anything else can fail. */
  onSpawned(child: ChildProcessWithoutNullStreams, tree: OwnedProcessTree | null): void;
  /** The connection exists; `initialize` has not answered yet. */
  onConnected(connection: ClientSideConnection): void;
  onStderr(chunk: string): void;
  /** Whether the caller is closing, so an exit is expected rather than a fault. */
  closing(): boolean;
  /** The native process failed after it started (exited, errored, or left processes behind). */
  onProcessFault(message: string): void;
  /** Rejection for a startup step that timed out, in the caller's error type. */
  timedOut(operation: string): Error;
  /** Rejection for an agent that negotiated a protocol version this client does not speak. */
  unsupportedProtocol(version: number): Error;
}

/**
 * Starts an ACP agent over stdio as an owned process and negotiates the
 * protocol: the mechanism every ACP Adapter shares. What the connection means
 * (Sessions, permissions, extensions, errors) stays with the caller.
 */
export async function startAcpAgent(start: AcpAgentStart): Promise<InitializeResponse> {
  const { child, tree } = spawnOwnedProcess(start.invocation.command, start.invocation.arguments, {
    cwd: start.cwd,
    env: { ...process.env, ...start.environment },
    windowsVerbatimArguments: start.invocation.windowsVerbatimArguments,
    closeTimeoutMs: start.closeTimeoutMs,
    onExitCleanupFailure: (error) =>
      start.onProcessFault(
        `${start.label} ACP owned process cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
  start.onSpawned(child, tree);
  child.stderr.on("data", (chunk: Buffer | string) => start.onStderr(chunk.toString()));
  await withDeadline(
    new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }),
    start.startupTimeoutMs,
    () => start.timedOut(`${start.label} CLI startup`),
  );
  const connection = new ClientSideConnection(
    () => start.client,
    ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ),
  );
  start.onConnected(connection);
  child.once("error", (error) => start.onProcessFault(error.message));
  child.once("exit", (code, signal) => {
    if (!start.closing()) {
      start.onProcessFault(`${start.label} ACP exited (code=${code}, signal=${signal})`);
    }
  });
  const initialize = await withDeadline(
    connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: start.clientCapabilities,
      clientInfo: { name: "codexhost", version: "0.1.6" },
    }),
    start.startupTimeoutMs,
    () => start.timedOut(`${start.label} ACP initialize`),
  );
  if (initialize.protocolVersion !== PROTOCOL_VERSION) {
    throw start.unsupportedProtocol(initialize.protocolVersion);
  }
  return initialize;
}
