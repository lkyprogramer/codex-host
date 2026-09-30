import path from "node:path";

import type { HostFileChange, HostItem } from "@codexhost/harness-adapter";
import type { HostItemId } from "@codexhost/shared-contracts";

import { openCodeFileIdentity } from "./file-change-verification.js";

function toolPath(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "file"]) {
    const field = record[key];
    if (typeof field === "string" && field.trim()) return field.trim();
  }
  for (const key of ["input", "arguments", "params"]) {
    const nested = toolPath(record[key]);
    if (nested) return nested;
  }
  return undefined;
}

/** Mark only previews whose file identity is proven to be covered by this native diff row. */
export function coverOpenCodeFileChanges(
  changes: HostFileChange[],
  items: readonly HostItem[],
  sessionDirectory: string,
  verifiedWorktree: string | undefined,
): HostFileChange[] {
  if (!verifiedWorktree) return changes;
  const toolFiles = items.flatMap((item) => {
    if (item.type !== "toolExecution") return [];
    const file = toolPath(item.arguments);
    if (!file) return [];
    const resolved = path.resolve(sessionDirectory, file);
    const identity = openCodeFileIdentity(resolved, verifiedWorktree);
    return identity ? [{ id: item.itemId, identity, resolved }] : [];
  });
  return changes.map((change) => {
    const identity = openCodeFileIdentity(change.path, verifiedWorktree);
    if (!identity) return change;
    const matching = toolFiles.filter((tool) => tool.identity === identity);
    const pathForDisplay = matching[0]?.resolved;
    if (!pathForDisplay) return change;
    // The projector compares paths in Session cwd coordinates. Keep only tools
    // sharing that coordinate; symlink aliases remain visible rather than being
    // silently suppressed under a path the pure projector cannot resolve.
    const coveredToolItemIds: HostItemId[] = matching
      .filter((tool) => tool.resolved === pathForDisplay)
      .map((tool) => tool.id);
    return { ...change, path: pathForDisplay, coveredToolItemIds };
  });
}
