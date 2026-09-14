import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";

/** Cursor RPC errors use both data.message and data.details for native failures. */
export function cursorDiagnostic(error: unknown): string {
  const data = error && typeof error === "object" && "data" in error ? error.data : undefined;
  const diagnostics: string[] = [];
  if (data && typeof data === "object") {
    for (const key of ["message", "details"] as const) {
      const value = key in data ? (data as Record<string, unknown>)[key] : undefined;
      if (typeof value === "string" && value.trim() && !diagnostics.includes(value))
        diagnostics.push(value);
    }
  }
  return sanitizeDiagnosticTail(
    diagnostics.length
      ? diagnostics.join(": ")
      : error instanceof Error
        ? error.message
        : "Cursor operation failed",
  );
}
