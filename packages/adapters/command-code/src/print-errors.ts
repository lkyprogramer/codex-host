import { sanitizeDiagnosticTail, type HarnessError } from "@codexhost/harness-adapter";

import type { CommandCodeResultLine } from "./stream-events.js";

/** Documented print-mode exit codes (docs/headless). */
export const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;
const EXIT_AUTH_ERROR = 3;
const EXIT_PERMISSION_DENIED = 4;
const EXIT_RATE_LIMITED = 5;
const EXIT_CONNECTION_ERROR = 6;
const EXIT_SERVER_ERROR = 7;
const EXIT_MAX_TURNS_REACHED = 8;
const EXIT_NO_RESPONSE = 9;
const EXIT_INSUFFICIENT_CREDITS = 10;
const EXIT_INTERRUPTED = 130;

/**
 * Only the CLI's own authentication wording counts; generic words such as
 * "login" or "credential" also appear in ordinary tool and MCP errors.
 */
export function isCommandCodeAuthenticationText(text: string): boolean {
  return /\bnot (?:authenticated|logged in)\b|\brun "?cmd login"?|\bauthentication (?:required|failed|expired)\b|\bplease (?:log|sign) in\b/iu.test(
    text,
  );
}

/** Argument rejections the CLI reports before starting a run; deterministic, never retryable. */
function isCommandCodeArgumentRejection(text: string): boolean {
  return /\bunknown (?:model|effort)\b|\bhas no adjustable reasoning effort\b|\bunknown option\b|\bmissing required argument\b/iu.test(
    text,
  );
}

function diagnosticFields(diagnostics: string): { stderrTail?: string } {
  const detail = sanitizeDiagnosticTail(diagnostics.trim());
  return detail ? { stderrTail: detail.slice(-4_000) } : {};
}

function firstDiagnosticLine(diagnostics: string): string {
  return (
    diagnostics
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

/** Maps a print-mode exit without a `result` line to a typed Harness error. */
export function commandCodeExitError(code: number | null, diagnostics: string): HarnessError {
  const tail = diagnosticFields(diagnostics);
  if (isCommandCodeAuthenticationText(diagnostics) || code === EXIT_AUTH_ERROR) {
    return {
      code: "authenticationRequired",
      message: "Command Code is not authenticated; run `command-code login`",
      retryable: false,
      ...tail,
    };
  }
  if (isCommandCodeArgumentRejection(diagnostics)) {
    return {
      code: "invalidRequest",
      message: `Command Code rejected the run: ${sanitizeDiagnosticTail(firstDiagnosticLine(diagnostics))}`,
      retryable: false,
      ...tail,
    };
  }
  switch (code) {
    case EXIT_INSUFFICIENT_CREDITS:
      return {
        code: "nativeFailure",
        message: "Command Code reported insufficient credits",
        retryable: false,
        ...tail,
      };
    case EXIT_PERMISSION_DENIED:
      return {
        code: "nativeFailure",
        message: "Command Code denied the requested operation",
        retryable: false,
        ...tail,
      };
    case EXIT_RATE_LIMITED:
    case EXIT_CONNECTION_ERROR:
    case EXIT_SERVER_ERROR:
      return {
        code: "nativeFailure",
        message: `Command Code could not reach its service (exit ${code})`,
        retryable: true,
        ...tail,
      };
    case EXIT_MAX_TURNS_REACHED:
      return {
        code: "nativeFailure",
        message: "Command Code stopped at its --max-turns limit",
        retryable: false,
        ...tail,
      };
    case EXIT_NO_RESPONSE:
      return {
        code: "nativeFailure",
        message: "Command Code produced no response",
        retryable: false,
        ...tail,
      };
    case EXIT_INTERRUPTED:
      return {
        code: "processExited",
        message: "Command Code was interrupted",
        retryable: true,
        ...tail,
      };
    default:
      return {
        code: "processExited",
        message: `Command Code exited before a result line (code ${String(code)})`,
        retryable: true,
        ...tail,
      };
  }
}

/** The structured `result.error` text is shown verbatim; authentication wording is typed. */
export function commandCodeResultError(
  result: CommandCodeResultLine,
  exitCode: number | null,
  diagnostics: string,
): HarnessError {
  const native = result.error?.trim() ?? "";
  if (result.subtype === "max_turns") {
    return {
      code: "nativeFailure",
      message: "Command Code stopped at its --max-turns limit before finishing",
      retryable: false,
    };
  }
  if (exitCode === EXIT_AUTH_ERROR || isCommandCodeAuthenticationText(native)) {
    return {
      code: "authenticationRequired",
      message: native || "Command Code is not authenticated; run `command-code login`",
      retryable: false,
    };
  }
  return {
    code: "nativeFailure",
    message: native ? `Command Code Turn failed: ${native}` : "Command Code Turn failed",
    retryable: !(exitCode === EXIT_INSUFFICIENT_CREDITS || /insufficient credits/iu.test(native)),
    ...diagnosticFields(diagnostics),
  };
}

export type CommandCodeTerminalDecision =
  { status: "succeeded" } | { status: "failed"; error: HarnessError };

/**
 * A `result` line alone does not settle a run: the CLI still writes
 * `subtype: "success"` when the Model produced nothing (exit 9) or when the
 * prompt was refused (exit 1), and the error path always prints a result line
 * before exiting with its documented code. The exit code therefore qualifies
 * the line; `null` means the process was still running when the bound expired.
 */
export function commandCodeTerminalDecision(input: {
  result: CommandCodeResultLine;
  exitCode: number | null;
  diagnostics: string;
}): CommandCodeTerminalDecision {
  const { result, exitCode, diagnostics } = input;
  if (result.subtype !== "success") {
    return { status: "failed", error: commandCodeResultError(result, exitCode, diagnostics) };
  }
  if (exitCode === EXIT_SUCCESS || exitCode === null) return { status: "succeeded" };
  if (exitCode === EXIT_NO_RESPONSE) {
    return {
      status: "failed",
      error: {
        code: "nativeFailure",
        message: "Command Code produced no response",
        retryable: false,
        ...diagnosticFields(diagnostics),
      },
    };
  }
  if (exitCode === EXIT_ERROR) {
    const reason = firstDiagnosticLine(diagnostics).replace(/^Error:\s*/iu, "");
    return {
      status: "failed",
      error: {
        code: "nativeFailure",
        message: reason
          ? `Command Code did not complete the prompt: ${sanitizeDiagnosticTail(reason)}`
          : "Command Code did not complete the prompt",
        retryable: false,
        ...diagnosticFields(diagnostics),
      },
    };
  }
  return { status: "failed", error: commandCodeExitError(exitCode, diagnostics) };
}
