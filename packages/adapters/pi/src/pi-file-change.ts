import { createTwoFilesPatch, parsePatch } from "diff";
import path from "node:path";

import type { HostFileChange } from "@codexhost/harness-adapter";
import type { JsonValue } from "@codexhost/shared-contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripDiffPrefix(pathString: string | undefined): string {
  if (typeof pathString !== "string" || pathString.length === 0) return "";
  return pathString.startsWith("a/") || pathString.startsWith("b/")
    ? pathString.slice(2)
    : pathString;
}

function displayPath(nativePath: string, cwd: string): { path: string; absolute: boolean } | null {
  const resolvedCwd = path.resolve(cwd);
  const resolvedPath = path.isAbsolute(nativePath)
    ? path.resolve(nativePath)
    : path.resolve(cwd, nativePath);
  const relative = path.relative(resolvedCwd, resolvedPath);
  const inside = relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`);
  const selected = inside ? relative : resolvedPath;
  const normalized = process.platform === "win32" ? selected.replaceAll("\\", "/") : selected;
  if (normalized.length === 0 || normalized === ".") return null;
  return { path: normalized, absolute: !inside };
}

export function fileMutatingKind(toolName: string): "edit" | "write" | null {
  const lower = toolName.toLowerCase().replaceAll(/[_-]/g, "");
  if (
    [
      "edit",
      "editfile",
      "fileedit",
      "strreplace",
      "searchreplace",
      "applypatch",
      "replace",
    ].includes(lower)
  ) {
    return "edit";
  }
  if (["write", "writefile", "filewrite", "create", "createfile"].includes(lower)) return "write";
  return null;
}

function nestedToolString(value: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.length > 0) return field;
  }
  for (const wrapper of ["input", "arguments", "params", "details"] as const) {
    const nested = nestedToolString(value[wrapper], keys);
    if (nested) return nested;
  }
  return undefined;
}

function patchFromResult(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  for (const key of ["patch", "diff", "unifiedDiff"] as const) {
    const field = result[key];
    if (typeof field === "string" && field.length > 0) return field;
  }
  if (isRecord(result.details)) {
    for (const key of ["patch", "diff", "unifiedDiff"] as const) {
      const field = result.details[key];
      if (typeof field === "string" && field.length > 0) return field;
    }
  }
  return undefined;
}

function fileChangeFromPatch(patch: string, cwd: string): HostFileChange[] | null {
  let parsed: ReturnType<typeof parsePatch>;
  try {
    parsed = parsePatch(patch);
  } catch {
    return null;
  }
  const file = parsed[0];
  if (parsed.length !== 1 || !file) return null;
  const oldFile = typeof file.oldFileName === "string" ? file.oldFileName : undefined;
  const newFile = typeof file.newFileName === "string" ? file.newFileName : undefined;
  if (!oldFile && !newFile) return null;
  const kind =
    oldFile === "/dev/null" || !oldFile
      ? "add"
      : newFile === "/dev/null" || !newFile
        ? "delete"
        : "update";
  const candidate = kind === "delete" ? oldFile : (newFile ?? oldFile);
  const rawPath = stripDiffPrefix(candidate);
  if (!rawPath || rawPath === "/dev/null") return null;
  const displayed = displayPath(rawPath, cwd);
  if (!displayed) return null;
  return [{ path: displayed.path, kind, unifiedDiff: patch }];
}

export function synthesizeFileChange(
  kind: "edit" | "write",
  args: unknown,
  cwd: string,
): HostFileChange[] | null {
  const filePath = nestedToolString(args, ["path", "file_path", "filePath", "file"]);
  if (!filePath) return null;
  const displayed = displayPath(filePath, cwd);
  if (!displayed) return null;
  if (kind === "write") {
    const content = nestedToolString(args, [
      "content",
      "new_string",
      "newString",
      "newText",
      "text",
    ]);
    if (content === undefined) return null;
    const oldHeader = "/dev/null";
    const newHeader = displayed.absolute ? displayed.path : `b/${displayed.path}`;
    return [
      {
        path: displayed.path,
        kind: "add",
        unifiedDiff: createTwoFilesPatch(oldHeader, newHeader, "", content, "", "", { context: 3 }),
      },
    ];
  }
  const oldText = nestedToolString(args, ["old_string", "oldString", "oldText", "old_text"]);
  const newText = nestedToolString(args, [
    "new_string",
    "newString",
    "newText",
    "new_text",
    "content",
  ]);
  if (oldText === undefined || newText === undefined) return null;
  const oldHeader = displayed.absolute ? displayed.path : `a/${displayed.path}`;
  const newHeader = displayed.absolute ? displayed.path : `b/${displayed.path}`;
  return [
    {
      path: displayed.path,
      kind: "update",
      unifiedDiff: createTwoFilesPatch(oldHeader, newHeader, oldText, newText, "", "", {
        context: 3,
      }),
    },
  ];
}

export function reliableFileChange(
  toolName: string,
  args: unknown,
  result: JsonValue,
  cwd: string,
): HostFileChange[] | null {
  const kind = fileMutatingKind(toolName);
  if (!kind) return null;
  const patch = patchFromResult(result);
  if (patch) {
    const fromPatch = fileChangeFromPatch(patch, cwd);
    if (fromPatch) return fromPatch;
  }
  return synthesizeFileChange(kind, args, cwd) ?? synthesizeFileChange(kind, result, cwd);
}

/** Persisted native patch evidence only; never synthesize missing history content. */
export function nativePatchFileChange(
  toolName: string,
  result: unknown,
  cwd: string,
): HostFileChange[] | null {
  if (!fileMutatingKind(toolName)) return null;
  const patch = patchFromResult(result);
  return patch ? fileChangeFromPatch(patch, cwd) : null;
}
