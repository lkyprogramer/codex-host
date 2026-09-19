import { sanitizeDiagnosticTail, type HarnessError } from "@codexhost/harness-adapter";

import type { CommandCodeResultLine } from "./stream-events.js";

/** Documented print-mode exit codes (docs/headless). */
const EXIT_AUTH_ERROR = 3;
const EXIT_PERMISSION_DENIED = 4;
const EXIT_RATE_LIMITED = 5;
const EXIT_CONNECTION_ERROR = 6;
const EXIT_SERVER_ERROR = 7;
const EXIT_MAX_TURNS_REACHED = 8;
const EXIT_NO_RESPONSE = 9;
const EXIT_INSUFFICIENT_CREDITS = 10;
const EXIT_INTERRUPTED = 130;

export function isCommandCodeAuthenticationText(text: string): boolean {
  return /not (?:logged in|authenticated)|sign[ -]?in|log ?in|authenticat|credential/iu.test(text);
}

/** Maps a print-mode exit without a `result` line to a typed Harness error. */
export function commandCodeExitError(code: number | null, diagnostics: string): HarnessError {
  const detail = sanitizeDiagnosticTail(diagnostics.trim());
  const tail = detail ? { stderrTail: detail.slice(-4_000) } : {};
  switch (code) {
    case EXIT_AUTH_ERROR:
      return {
        code: "authenticationRequired",
        message: "Command Code is not authenticated; run `command-code login`",
        retryable: false,
        ...tail,
      };
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
        retryable: true,
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
  if (isCommandCodeAuthenticationText(native)) {
    return { code: "authenticationRequired", message: native, retryable: false };
  }
  const detail = sanitizeDiagnosticTail(diagnostics.trim());
  return {
    code: "nativeFailure",
    message: native ? `Command Code Turn failed: ${native}` : "Command Code Turn failed",
    retryable: !/insufficient credits/iu.test(native),
    ...(detail ? { stderrTail: detail.slice(-4_000) } : {}),
  };
}
