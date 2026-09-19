/**
 * Print mode keeps its own permission gate: without `--yolo` a built-in mod
 * blocks `edit_file`, `write_file`, `shell_command`, `monitor_command` and
 * `kill_shell` outright, and `--permission-mode auto-accept` does not lift it.
 * Headless `confirmTool` also cannot reach a client, so the only honest live
 * choices are the CLI's read-only modes and the native bypass. codexhost adds
 * no approvals or allow/deny matching of its own.
 */
import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

export type CommandCodePermissionMode = "plan" | "read-only" | "bypass";

const MODE_IDS: ReadonlyMap<string, CommandCodePermissionMode> = new Map([
  ["plan", "plan"],
  ["read-only", "read-only"],
  ["bypass", "bypass"],
]);

export const COMMAND_CODE_DEFAULT_PERMISSION_MODE: CommandCodePermissionMode = "bypass";

export const COMMAND_CODE_DEFAULT_PERMISSION_MODE_ID = harnessPermissionModeIdSchema.parse(
  COMMAND_CODE_DEFAULT_PERMISSION_MODE,
);

export const COMMAND_CODE_PERMISSION_MODE_CATALOG: HarnessPermissionModeCatalog =
  harnessPermissionModeCatalogSchema.parse({
    modes: [
      {
        id: "bypass",
        label: "Skip permissions",
        description:
          "Run Command Code with --dangerously-skip-permissions. Every tool executes without approval; codexhost adds no tool gate.",
        dangerous: true,
      },
      {
        id: "read-only",
        label: "Read-only (headless gate)",
        description:
          "Print mode without --yolo: file edits, writes and shell commands are blocked by the CLI; reads, search and other tools run.",
      },
      {
        id: "plan",
        label: "Plan mode",
        description:
          "Native --permission-mode plan: read-only exploration and planning, no MCP tools.",
      },
    ],
    defaultModeId: COMMAND_CODE_DEFAULT_PERMISSION_MODE_ID,
  });

export function decodeCommandCodePermissionModeId(
  value: HarnessPermissionModeId,
): CommandCodePermissionMode {
  const mode = MODE_IDS.get(harnessPermissionModeIdSchema.parse(value));
  if (!mode) {
    throw new Error(
      `Command Code permission mode "${value}" is not available; choose Skip permissions, Read-only or Plan mode.`,
    );
  }
  return mode;
}

export function commandCodePermissionModeId(
  mode: CommandCodePermissionMode,
): HarnessPermissionModeId {
  return harnessPermissionModeIdSchema.parse(mode);
}

/** CLI flags that make print mode honour the selected mode. */
export function commandCodePermissionArguments(mode: CommandCodePermissionMode): string[] {
  switch (mode) {
    case "bypass":
      return ["--dangerously-skip-permissions"];
    case "plan":
      return ["--permission-mode", "plan"];
    case "read-only":
      return [];
  }
}
