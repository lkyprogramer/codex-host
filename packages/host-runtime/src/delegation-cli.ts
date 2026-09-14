import { readFile, realpath } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";

import { delegationCliHelp, type DelegationCliCommand } from "./delegation-cli-help.js";
import { compactDelegationOutput } from "./delegation-cli-output.js";

export { DELEGATION_HELP } from "./delegation-cli-help.js";

import {
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
  DELEGATION_THREAD_ID_ENV,
  DelegationControlError,
  isDelegationExecutionPolicy,
  type DelegationControlErrorCode,
} from "./delegation-types.js";

import {
  observeThreads,
  parseObserveTargets,
  DEFAULT_OBSERVE_TIMEOUT_MS,
  MAX_OBSERVE_TIMEOUT_MS,
} from "./thread-observer.js";

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function normalizeThreadId(value: string): string {
  const prefix = "codex://threads/";
  const normalized = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  if (!normalized || normalized.includes("/") || normalized.includes("?")) {
    throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is invalid");
  }
  return normalized;
}

function positiveInteger(value: string | undefined, name: string, maximum?: number): number {
  const number = Number(value);
  if (!value || !Number.isSafeInteger(number) || number <= 0 || (maximum && number > maximum)) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `${name} must be a positive integer${maximum ? ` no greater than ${maximum}` : ""}`,
    );
  }
  return number;
}

function timeoutMsValue(value: string | undefined, name: string, maximum: number): number {
  const number = Number(value);
  if (!value || !Number.isSafeInteger(number) || number < 0 || number > maximum) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `${name} must be an integer between 0 and ${maximum}`,
    );
  }
  return number;
}

function options(arguments_: readonly string[]): {
  positionals: string[];
  options: Map<string, string>;
} {
  const positionals: string[] = [];
  const parsed = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument) continue;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (parsed.has(argument))
      throw new DelegationControlError("INVALID_ARGUMENT", `${argument} may only be provided once`);
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--"))
      throw new DelegationControlError("INVALID_ARGUMENT", `${argument} requires a value`);
    parsed.set(argument, value);
    index += 1;
  }
  return { positionals, options: parsed };
}

function value(parsed: ReturnType<typeof options>, name: string): string | undefined {
  return parsed.options.get(name);
}

function rejectUnknown(parsed: ReturnType<typeof options>, allowed: readonly string[]): void {
  const known = new Set([...allowed, "--format"]);
  for (const name of parsed.options.keys()) {
    if (!known.has(name))
      throw new DelegationControlError("INVALID_ARGUMENT", `Unknown option '${name}'`);
  }
}

async function requestRuntime(input: {
  environment: NodeJS.ProcessEnv;
  path: string;
  body: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<unknown> {
  const endpoint = input.environment[DELEGATION_RUNTIME_ENDPOINT_ENV];
  const token = input.environment[DELEGATION_RUNTIME_TOKEN_ENV];
  if (!endpoint || !token) {
    throw new DelegationControlError(
      "RUNTIME_UNREACHABLE",
      `${DELEGATION_RUNTIME_ENDPOINT_ENV} and ${DELEGATION_RUNTIME_TOKEN_ENV} are required`,
    );
  }
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(new URL(input.path, endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(input.body),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    throw new DelegationControlError(
      "RUNTIME_UNREACHABLE",
      "Host Runtime could not be reached. If this command runs inside native Codex, use a session sandbox that permits local Runtime connections or run the command explicitly outside the sandbox.",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const body = (await response.json()) as {
    error?: { code?: unknown; message?: unknown; details?: unknown };
  };
  if (!response.ok || body.error) {
    const code = typeof body.error?.code === "string" ? body.error.code : "INTERNAL_ERROR";
    const message =
      typeof body.error?.message === "string" ? body.error.message : "Runtime request failed";
    throw new DelegationControlError(
      code as DelegationControlErrorCode,
      message,
      body.error?.details as Record<string, unknown> | undefined,
    );
  }
  return body;
}

function writeJson(output: Writable, value: unknown): void {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function readUtf8(pathOrDash: string, stdin: Readable | undefined): Promise<string> {
  if (pathOrDash === "-") {
    if (!stdin) throw new DelegationControlError("INVALID_ARGUMENT", "stdin is not available");
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  try {
    return await readFile(pathOrDash, "utf8");
  } catch {
    throw new DelegationControlError("INVALID_ARGUMENT", `Could not read file '${pathOrDash}'`);
  }
}

export async function runDelegationCli(input: {
  arguments: string[];
  environment?: NodeJS.ProcessEnv;
  output?: Writable;
  diagnosticOutput?: Writable;
  fetchImpl?: typeof fetch;
  stdin?: Readable;
}): Promise<number> {
  const output = input.output ?? process.stdout;
  const diagnosticOutput = input.diagnosticOutput ?? process.stderr;
  const environment = input.environment ?? process.env;
  try {
    const [group, command, ...rest] = input.arguments;
    const help = delegationCliHelp(input.arguments);
    if (help !== undefined) {
      output.write(help);
      return 0;
    }
    const parsed = options(rest);
    const format = value(parsed, "--format") ?? "json";
    if (format !== "json" && format !== "compact") {
      throw new DelegationControlError("INVALID_ARGUMENT", "--format must be json or compact");
    }
    const writeResult = (
      name: DelegationCliCommand,
      body: unknown,
      view: "result" | "messages" = "result",
    ): void =>
      writeJson(output, format === "json" ? body : compactDelegationOutput(name, body, view));
    if (group === "harness" && command === "list") {
      rejectUnknown(parsed, []);
      if (parsed.positionals.length > 0) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "harness list accepts no positional arguments",
        );
      }
      writeResult(
        "harness list",
        await requestRuntime({
          environment,
          path: "/v1/harness/list",
          body: {},
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "harness" && command === "inspect") {
      rejectUnknown(parsed, ["--cwd", "--refresh"]);
      if (parsed.positionals.length !== 1) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "harness inspect requires one Harness identifier",
        );
      }
      const harnessId = parsed.positionals[0];
      if (!harnessId) {
        throw new DelegationControlError("INVALID_ARGUMENT", "Harness identifier is required");
      }
      const refresh = value(parsed, "--refresh");
      if (refresh !== undefined && refresh !== "true" && refresh !== "false") {
        throw new DelegationControlError("INVALID_ARGUMENT", "--refresh must be true or false");
      }
      writeResult(
        "harness inspect",
        await requestRuntime({
          environment,
          path: "/v1/harness/inspect",
          body: {
            harnessId,
            ...(value(parsed, "--cwd") ? { cwd: value(parsed, "--cwd") } : {}),
            ...(refresh !== undefined ? { refresh: refresh === "true" } : {}),
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "delegate" && command === "start") {
      rejectUnknown(parsed, [
        "--harness",
        "--task",
        "--task-file",
        "--cwd",
        "--model",
        "--thinking",
        "--execution-policy",
        "--parent-thread",
        "--request-id",
      ]);
      if (parsed.positionals.length > 0)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "delegate start accepts no positional arguments",
        );
      const harnessId = value(parsed, "--harness");
      const taskText = value(parsed, "--task");
      const taskFile = value(parsed, "--task-file");
      if (!harnessId) {
        throw new DelegationControlError("INVALID_ARGUMENT", "--harness is required");
      }
      if (taskText && taskFile) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--task and --task-file are mutually exclusive",
        );
      }
      const task =
        taskFile !== undefined
          ? await readUtf8(taskFile, input.stdin ?? process.stdin)
          : taskText === "-"
            ? await readUtf8("-", input.stdin ?? process.stdin)
            : taskText;
      if (!task)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--harness and --task, --task-file, or --task - are required",
        );
      const parentThread =
        value(parsed, "--parent-thread") ?? environment[DELEGATION_THREAD_ID_ENV];
      const executionPolicy = value(parsed, "--execution-policy");
      if (executionPolicy !== undefined && !isDelegationExecutionPolicy(executionPolicy)) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--execution-policy must be default or unattended-full-access",
        );
      }
      const cwdOption = value(parsed, "--cwd");
      const cwd = cwdOption ? await realpath(cwdOption) : undefined;
      writeResult(
        "delegate start",
        await requestRuntime({
          environment,
          path: "/v1/delegate/start",
          body: {
            harnessId,
            task,
            ...(cwd ? { cwd } : {}),
            ...(value(parsed, "--model") ? { model: { id: value(parsed, "--model") } } : {}),
            ...(value(parsed, "--thinking")
              ? { thinkingOptionId: value(parsed, "--thinking") }
              : {}),
            ...(executionPolicy ? { executionPolicy } : {}),
            ...(parentThread ? { parentThreadId: normalizeThreadId(parentThread) } : {}),
            ...(value(parsed, "--request-id") ? { requestId: value(parsed, "--request-id") } : {}),
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "delegate" && command === "reconcile") {
      const parsed = options(rest);
      rejectUnknown(parsed, ["--apply"]);
      if (parsed.positionals.length !== 1) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "delegate reconcile requires one Thread identifier",
        );
      }
      const threadId = parsed.positionals[0];
      if (!threadId) {
        throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
      }
      const apply = value(parsed, "--apply");
      if (apply !== undefined && apply !== "true" && apply !== "false") {
        throw new DelegationControlError("INVALID_ARGUMENT", "--apply must be true or false");
      }
      writeJson(
        output,
        await requestRuntime({
          environment,
          path: "/v1/delegate/reconcile",
          body: {
            threadId: normalizeThreadId(threadId),
            ...(apply !== undefined ? { apply: apply === "true" } : {}),
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "thread" && command === "send") {
      rejectUnknown(parsed, ["--message", "--message-file", "--request-id", "--expected-turn"]);
      if (parsed.positionals.length !== 1) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "thread send requires one Thread identifier",
        );
      }
      const threadId = parsed.positionals[0];
      const messageText = value(parsed, "--message");
      const messageFile = value(parsed, "--message-file");
      if (messageText && messageFile) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--message and --message-file are mutually exclusive",
        );
      }
      const message =
        messageFile !== undefined
          ? await readUtf8(messageFile, input.stdin ?? process.stdin)
          : messageText;
      if (!threadId || !message?.trim()) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "Thread identifier and --message or --message-file are required",
        );
      }
      writeResult(
        "thread send",
        await requestRuntime({
          environment,
          path: "/v1/thread/send",
          body: {
            threadId: normalizeThreadId(threadId),
            message,
            ...(value(parsed, "--request-id") ? { requestId: value(parsed, "--request-id") } : {}),
            ...(value(parsed, "--expected-turn")
              ? { expectedTurnId: value(parsed, "--expected-turn") }
              : {}),
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "thread" && command === "cancel") {
      rejectUnknown(parsed, ["--expected-turn"]);
      if (parsed.positionals.length !== 1) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "thread cancel requires one Thread identifier",
        );
      }
      const threadId = parsed.positionals[0];
      if (!threadId) {
        throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
      }
      writeResult(
        "thread cancel",
        await requestRuntime({
          environment,
          path: "/v1/thread/cancel",
          body: {
            threadId: normalizeThreadId(threadId),
            ...(value(parsed, "--expected-turn")
              ? { expectedTurnId: value(parsed, "--expected-turn") }
              : {}),
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "thread" && (command === "read" || command === "wait")) {
      rejectUnknown(parsed, ["--view", "--cursor", "--limit", "--timeout-ms"]);
      if (parsed.positionals.length !== 1)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          `thread ${command} requires one Thread identifier`,
        );
      const view = value(parsed, "--view") ?? "result";
      if (view !== "result" && view !== "messages")
        throw new DelegationControlError("INVALID_ARGUMENT", "--view must be result or messages");
      if (view === "result" && (value(parsed, "--cursor") || value(parsed, "--limit")))
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--cursor and --limit require --view messages",
        );
      if (command === "read" && value(parsed, "--timeout-ms"))
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--timeout-ms is valid only for thread wait",
        );
      const threadId = parsed.positionals[0];
      if (!threadId)
        throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
      const body = {
        threadId: normalizeThreadId(threadId),
        view,
        ...(value(parsed, "--cursor") ? { cursor: value(parsed, "--cursor") } : {}),
        ...(value(parsed, "--limit")
          ? { limit: positiveInteger(value(parsed, "--limit"), "--limit", MAX_LIMIT) }
          : {}),
        ...(command === "wait"
          ? {
              timeoutMs: value(parsed, "--timeout-ms")
                ? positiveInteger(value(parsed, "--timeout-ms"), "--timeout-ms")
                : DEFAULT_WAIT_TIMEOUT_MS,
            }
          : {}),
      };
      writeResult(
        command === "read" ? "thread read" : "thread wait",
        await requestRuntime({
          environment,
          path: command === "read" ? "/v1/thread/read" : "/v1/thread/wait",
          body,
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
        view,
      );
      return 0;
    }
    if (group === "thread" && command === "list") {
      rejectUnknown(parsed, ["--cwd", "--parent", "--limit", "--cursor", "--sort"]);
      if (parsed.positionals.length > 0)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "thread list accepts no positional arguments",
        );
      const sort = value(parsed, "--sort") ?? "created-desc";
      if (
        !new Set([
          "created-asc",
          "created-desc",
          "updated-asc",
          "updated-desc",
          "recency-asc",
          "recency-desc",
        ]).has(sort)
      )
        throw new DelegationControlError("INVALID_ARGUMENT", "--sort is invalid");
      const parentThread = value(parsed, "--parent");
      writeResult(
        "thread list",
        await requestRuntime({
          environment,
          path: "/v1/thread/list",
          body: {
            cwd: value(parsed, "--cwd") ?? process.cwd(),
            ...(parentThread ? { parentThreadId: normalizeThreadId(parentThread) } : {}),
            limit: value(parsed, "--limit")
              ? positiveInteger(value(parsed, "--limit"), "--limit", MAX_LIMIT)
              : DEFAULT_LIMIT,
            ...(value(parsed, "--cursor") ? { cursor: value(parsed, "--cursor") } : {}),
            sort,
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "thread" && command === "status") {
      const parsed = options(rest);
      rejectUnknown(parsed, []);
      if (parsed.positionals.length !== 1) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "thread status requires one Thread identifier",
        );
      }
      const threadId = parsed.positionals[0];
      if (!threadId) {
        throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
      }
      writeJson(
        output,
        await requestRuntime({
          environment,
          path: "/v1/thread/status",
          body: { threadId: normalizeThreadId(threadId) },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "thread" && command === "configuration") {
      const parsed = options(rest);
      rejectUnknown(parsed, []);
      if (parsed.positionals.length !== 1) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "thread configuration requires one Thread identifier",
        );
      }
      const threadId = parsed.positionals[0];
      if (!threadId) {
        throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
      }
      writeJson(
        output,
        await requestRuntime({
          environment,
          path: "/v1/thread/configuration",
          body: { threadId: normalizeThreadId(threadId) },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "thread" && command === "evidence") {
      const parsed = options(rest);
      rejectUnknown(parsed, ["--turn", "--item", "--cursor", "--limit", "--include-output"]);
      if (parsed.positionals.length !== 1) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "thread evidence requires one Thread identifier",
        );
      }
      const threadId = parsed.positionals[0];
      if (!threadId) {
        throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
      }
      const includeOutput = value(parsed, "--include-output");
      if (includeOutput !== undefined && includeOutput !== "true" && includeOutput !== "false") {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--include-output must be true or false",
        );
      }
      writeJson(
        output,
        await requestRuntime({
          environment,
          path: "/v1/thread/evidence",
          body: {
            threadId: normalizeThreadId(threadId),
            ...(value(parsed, "--turn") ? { turnId: value(parsed, "--turn") } : {}),
            ...(value(parsed, "--item") ? { itemId: value(parsed, "--item") } : {}),
            ...(value(parsed, "--cursor") ? { cursor: value(parsed, "--cursor") } : {}),
            ...(value(parsed, "--limit")
              ? { limit: positiveInteger(value(parsed, "--limit"), "--limit", MAX_LIMIT) }
              : {}),
            ...(includeOutput !== undefined ? { includeOutput: includeOutput === "true" } : {}),
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "thread" && command === "release") {
      const parsed = options(rest);
      rejectUnknown(parsed, ["--expected-turn"]);
      if (parsed.positionals.length !== 1) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "thread release requires one Thread identifier",
        );
      }
      const threadId = parsed.positionals[0];
      if (!threadId) {
        throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
      }
      writeJson(
        output,
        await requestRuntime({
          environment,
          path: "/v1/thread/release",
          body: {
            threadId: normalizeThreadId(threadId),
            ...(value(parsed, "--expected-turn")
              ? { expectedTurnId: value(parsed, "--expected-turn") }
              : {}),
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "thread" && command === "observe") {
      const parsed = options(rest);
      rejectUnknown(parsed, ["--targets-file", "--timeout-ms"]);
      if (parsed.positionals.length > 0)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "thread observe accepts no positional arguments",
        );
      const targetsFile = value(parsed, "--targets-file");
      if (!targetsFile)
        throw new DelegationControlError("INVALID_ARGUMENT", "--targets-file is required");
      let raw: unknown;
      try {
        raw = JSON.parse(await readUtf8(targetsFile, input.stdin ?? process.stdin));
      } catch (error) {
        if (error instanceof DelegationControlError) throw error;
        throw new DelegationControlError("INVALID_ARGUMENT", "targets-file must be JSON");
      }
      const targets = parseObserveTargets(raw);
      const timeoutMs =
        value(parsed, "--timeout-ms") !== undefined
          ? timeoutMsValue(value(parsed, "--timeout-ms"), "--timeout-ms", MAX_OBSERVE_TIMEOUT_MS)
          : DEFAULT_OBSERVE_TIMEOUT_MS;
      const controller = new AbortController();
      let cancelledCode = 0;
      const interrupt = () => {
        cancelledCode = 130;
        controller.abort();
      };
      const terminate = () => {
        cancelledCode = 143;
        controller.abort();
      };
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", terminate);
      try {
        const result = await observeThreads({
          targets,
          timeoutMs,
          signal: controller.signal,
          waitMany: (body, signal) =>
            requestRuntime({
              environment,
              path: "/v1/thread/wait-many",
              body: { ...body },
              signal,
              ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
            }),
        });
        writeJson(output, result);
        return cancelledCode;
      } finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", terminate);
      }
    }
    if (group === "thread" && command === "wait-many") {
      const parsed = options(rest);
      rejectUnknown(parsed, ["--targets-file", "--timeout-ms"]);
      if (parsed.positionals.length > 0) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "thread wait-many accepts no positional arguments",
        );
      }
      const targetsFile = value(parsed, "--targets-file");
      if (!targetsFile) {
        throw new DelegationControlError("INVALID_ARGUMENT", "--targets-file is required");
      }
      const raw = await readUtf8(targetsFile, input.stdin ?? process.stdin);
      let parsedTargets: unknown;
      try {
        parsedTargets = JSON.parse(raw);
      } catch {
        throw new DelegationControlError("INVALID_ARGUMENT", "targets-file must be JSON");
      }
      if (!Array.isArray(parsedTargets)) {
        throw new DelegationControlError("INVALID_ARGUMENT", "targets-file must be a JSON array");
      }
      writeJson(
        output,
        await requestRuntime({
          environment,
          path: "/v1/thread/wait-many",
          body: {
            targets: parsedTargets,
            timeoutMs: value(parsed, "--timeout-ms")
              ? timeoutMsValue(value(parsed, "--timeout-ms"), "--timeout-ms", 60_000)
              : DEFAULT_WAIT_TIMEOUT_MS,
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "Unknown delegation command. Run 'codexhost delegate --help'.",
    );
  } catch (error) {
    const normalized =
      error instanceof DelegationControlError
        ? error
        : new DelegationControlError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : String(error),
          );
    writeJson(diagnosticOutput, {
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.details ? { details: normalized.details } : {}),
      },
    });
    return 1;
  }
}
