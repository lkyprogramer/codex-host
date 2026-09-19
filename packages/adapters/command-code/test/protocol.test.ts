import { harnessModelRefSchema, harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  accumulateCommandCodeUsage,
  commandCodeErrorMessage,
  commandCodeExitError,
  commandCodeHostUsage,
  commandCodeModelArguments,
  commandCodePermissionArguments,
  commandCodePrintArguments,
  commandCodeResultError,
  commandCodeTerminalDecision,
  decodeCommandCodeModelRef,
  decodeCommandCodePermissionModeId,
  encodeCommandCodeModelRef,
  parseCommandCodeModels,
  isCommandCodeAuthenticationText,
  parseCommandCodeStreamLine,
} from "../src/index.js";

/** Captured from `cmd -p --output-format json` (1.58.0) on an account without credits. */
const CAPTURED_FAILED_RUN = [
  '{"type":"event","event":{"type":"run_start","sessionId":"ea2dbcd5-7a47-4cda-8495-74d0dc3a23b2"}}',
  '{"type":"event","event":{"type":"turn_start","turnNumber":1}}',
  '{"type":"event","event":{"type":"message_start"}}',
  '{"type":"event","event":{"type":"model_request_start","model":"deepseek/deepseek-v4-flash"}}',
  '{"type":"event","event":{"type":"model_trace","traceId":"0bf571441cd1f601a9b3f37d4e2c0bf6"}}',
  '{"type":"event","event":{"type":"run_error","error":{"name":"TransportError","message":"POST /alpha/generate → 400 error: You have insufficient credits to make this request."}}}',
  '{"type":"event","event":{"type":"run_end","result":{"finalText":"","stopReason":"run_error","turnCount":1,"usage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0},"systemPromptTokens":null}}}',
  '{"type":"result","subtype":"error","sessionId":"ea2dbcd5-7a47-4cda-8495-74d0dc3a23b2","usage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0},"durationMs":1555,"finalText":"","error":"Error: You have insufficient credits to make this request. Please purchase more credits to continue using Command Code: https://commandcode.ai/billing"}',
];

/** Trimmed from `cmd --list-models` (1.58.0). */
const LIST_MODELS_OUTPUT = `Available models  ·  72 models

Open Source

deepseek/deepseek-v4-pro               hybrid-attention long-context reasoning
deepseek/deepseek-v4-flash             fast hybrid-attention reasoning (default)
inclusionai/ling-3.0-flash-sante:free  FREE health & medicine tuned lightweight-MoE, still strong on code

Anthropic

claude-sonnet-5                        best combo of speed & intelligence (recommended)
`;

describe("Command Code print protocol", () => {
  it("decodes the captured frames and drops the ones this Adapter does not model", () => {
    const parsed = CAPTURED_FAILED_RUN.map(parseCommandCodeStreamLine);
    expect(parsed.map((line) => (line?.type === "event" ? line.event.type : line?.type))).toEqual([
      "run_start",
      "turn_start",
      undefined,
      undefined,
      undefined,
      "run_error",
      "run_end",
      "result",
    ]);
    const result = parsed.at(-1);
    expect(result).toMatchObject({
      type: "result",
      subtype: "error",
      sessionId: "ea2dbcd5-7a47-4cda-8495-74d0dc3a23b2",
      durationMs: 1555,
    });
    const runError = parsed[5];
    expect(runError?.type === "event" && runError.event.type === "run_error").toBe(true);
    if (runError?.type === "event" && runError.event.type === "run_error") {
      expect(commandCodeErrorMessage(runError.event.error)).toMatch(/insufficient credits/u);
    }
  });

  it("rejects malformed lines instead of guessing", () => {
    expect(parseCommandCodeStreamLine("")).toBeNull();
    expect(parseCommandCodeStreamLine("session: abc")).toBeNull();
    expect(parseCommandCodeStreamLine('{"type":"event","event":{"type":"run_start"}}')).toBeNull();
    expect(parseCommandCodeStreamLine('{"type":"result","subtype":"weird"}')).toBeNull();
    expect(
      parseCommandCodeStreamLine('{"type":"event","event":{"type":"tool_running","toolName":"x"}}'),
    ).toBeNull();
    expect(
      parseCommandCodeStreamLine(
        '{"type":"event","event":{"type":"tool_completed","toolCallId":"c1","toolName":"read_file","result":[{"type":"text","text":"ok"}]}}',
      ),
    ).toMatchObject({ type: "event", event: { type: "tool_completed", toolCallId: "c1" } });
  });

  it("maps exits without a result line, argument rejections and authentication wording", () => {
    expect(commandCodeExitError(3, "")).toMatchObject({ code: "authenticationRequired" });
    expect(commandCodeExitError(10, "")).toMatchObject({
      code: "nativeFailure",
      retryable: false,
    });
    expect(commandCodeExitError(6, "network down")).toMatchObject({
      code: "nativeFailure",
      retryable: true,
      stderrTail: "network down",
    });
    expect(commandCodeExitError(1, "api_key=secret123 leaked")).toMatchObject({
      code: "processExited",
      stderrTail: "api_key=[redacted] leaked",
    });
    expect(
      commandCodeExitError(
        1,
        'Error: unknown model "totally/unknown-model".\nRun "cmd --list-models"',
      ),
    ).toMatchObject({
      code: "invalidRequest",
      retryable: false,
      message: 'Command Code rejected the run: Error: unknown model "totally/unknown-model".',
    });
    expect(commandCodeExitError(1, 'Unknown effort "medium". Supported: high, max.')).toMatchObject(
      {
        code: "invalidRequest",
        retryable: false,
      },
    );
    // Only the CLI's own wording is authentication; ordinary tool text is not.
    expect(
      isCommandCodeAuthenticationText('Error: Not authenticated. Please run "cmd login" first.'),
    ).toBe(true);
    expect(isCommandCodeAuthenticationText("You are not logged in")).toBe(true);
    expect(isCommandCodeAuthenticationText("failed to load credentials for MCP server")).toBe(
      false,
    );
    expect(isCommandCodeAuthenticationText("wrote design in docs/login-flow.md")).toBe(false);
    expect(commandCodeResultError({ type: "result", subtype: "max_turns" }, 8, "")).toMatchObject({
      code: "nativeFailure",
      retryable: false,
    });
    expect(
      commandCodeResultError(
        { type: "result", subtype: "error", error: "Error: Not authenticated." },
        3,
        "",
      ),
    ).toMatchObject({ code: "authenticationRequired", retryable: false });
    expect(
      commandCodeResultError(
        { type: "result", subtype: "error", error: "insufficient credits" },
        10,
        "",
      ),
    ).toMatchObject({ code: "nativeFailure", retryable: false });
    expect(
      commandCodeResultError({ type: "result", subtype: "error", error: "POST failed" }, 1, ""),
    ).toMatchObject({ code: "nativeFailure", retryable: true });
  });

  it("lets the exit code qualify a success result line", () => {
    const success = { type: "result", subtype: "success", finalText: "" } as const;
    expect(commandCodeTerminalDecision({ result: success, exitCode: 0, diagnostics: "" })).toEqual({
      status: "succeeded",
    });
    // The process outlived its grace period: the line alone decides.
    expect(
      commandCodeTerminalDecision({ result: success, exitCode: null, diagnostics: "" }),
    ).toEqual({ status: "succeeded" });
    expect(
      commandCodeTerminalDecision({
        result: success,
        exitCode: 9,
        diagnostics: "Error: No response",
      }),
    ).toMatchObject({ status: "failed", error: { code: "nativeFailure", retryable: false } });
    expect(
      commandCodeTerminalDecision({
        result: success,
        exitCode: 1,
        diagnostics: "Error: refused by policy\n",
      }),
    ).toMatchObject({
      status: "failed",
      error: { message: "Command Code did not complete the prompt: refused by policy" },
    });
    expect(
      commandCodeTerminalDecision({
        result: { type: "result", subtype: "error", error: "boom" },
        exitCode: 1,
        diagnostics: "",
      }),
    ).toMatchObject({ status: "failed", error: { message: "Command Code Turn failed: boom" } });
  });

  it("projects and accumulates print-mode usage", () => {
    expect(commandCodeHostUsage(undefined)).toBeNull();
    expect(commandCodeHostUsage({ inputTokens: "1" })).toBeNull();
    const first = commandCodeHostUsage({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    });
    expect(first).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 2,
      cacheWriteInputTokens: 1,
      totalTokens: 15,
    });
    expect(accumulateCommandCodeUsage(first, { inputTokens: 1, outputTokens: 1 })).toEqual({
      inputTokens: 11,
      outputTokens: 6,
      cachedInputTokens: 2,
      cacheWriteInputTokens: 1,
      totalTokens: 17,
    });
  });
});

describe("Command Code Model catalog", () => {
  it("parses the model table, keeps the CLI default and skips headings", () => {
    const catalog = parseCommandCodeModels(LIST_MODELS_OUTPUT);
    expect(catalog.models.map((model) => model.label)).toEqual([
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash",
      "inclusionai/ling-3.0-flash-sante:free",
      "claude-sonnet-5",
    ]);
    expect(catalog.defaultModel).toEqual(encodeCommandCodeModelRef("deepseek/deepseek-v4-flash"));
    expect(catalog.thinkingOptions).toEqual([]);
    for (const model of catalog.models) {
      expect(decodeCommandCodeModelRef(model.ref)).toBe(model.label);
    }
  });

  it("round-trips native IDs through transport-safe refs and rejects foreign refs", () => {
    const ref = encodeCommandCodeModelRef("inclusionai/ling-3.0-flash-sante:free");
    expect(harnessModelRefSchema.safeParse(ref).success).toBe(true);
    expect(decodeCommandCodeModelRef(ref)).toBe("inclusionai/ling-3.0-flash-sante:free");
    expect(() =>
      decodeCommandCodeModelRef(harnessModelRefSchema.parse({ id: "opencode-model-v1.abc" })),
    ).toThrow(/another Adapter/u);
    expect(() =>
      decodeCommandCodeModelRef(harnessModelRefSchema.parse({ id: "command-code-model-v1." })),
    ).toThrow(/malformed/u);
    expect(() => encodeCommandCodeModelRef("   ")).toThrow(/empty/u);
  });

  it("translates the selection into a -m flag and never into --effort", () => {
    expect(commandCodeModelArguments(undefined)).toEqual([]);
    expect(commandCodeModelArguments(encodeCommandCodeModelRef("claude-sonnet-5"))).toEqual([
      "-m",
      "claude-sonnet-5",
    ]);
  });
});

describe("Command Code print arguments", () => {
  it("builds a fresh run and a resume by transcript path only", () => {
    expect(commandCodePrintArguments({ permissionMode: "bypass", maxTurns: 100 })).toEqual([
      "-p",
      "--output-format",
      "json",
      "--skip-onboarding",
      "--trust",
      "--no-auto-update",
      "--max-turns",
      "100",
      "--dangerously-skip-permissions",
    ]);
    const resumed = commandCodePrintArguments({
      sessionFilePath: "/tmp/s.jsonl",
      permissionMode: "plan",
      maxTurns: 5,
    });
    expect(resumed).toEqual(
      expect.arrayContaining(["--session", "/tmp/s.jsonl", "--permission-mode", "plan"]),
    );
    expect(resumed).not.toContain("--resume");
    expect(resumed).not.toContain("--dangerously-skip-permissions");
    expect(commandCodePrintArguments({ permissionMode: "read-only", maxTurns: 5 })).not.toContain(
      "--permission-mode",
    );
  });
});

describe("Command Code permission modes", () => {
  it("decodes only the three native headless modes", () => {
    expect(decodeCommandCodePermissionModeId(harnessPermissionModeIdSchema.parse("plan"))).toBe(
      "plan",
    );
    expect(() =>
      decodeCommandCodePermissionModeId(harnessPermissionModeIdSchema.parse("auto-accept")),
    ).toThrow(/not available/u);
    expect(commandCodePermissionArguments("bypass")).toEqual(["--dangerously-skip-permissions"]);
    expect(commandCodePermissionArguments("plan")).toEqual(["--permission-mode", "plan"]);
    expect(commandCodePermissionArguments("read-only")).toEqual([]);
  });
});
