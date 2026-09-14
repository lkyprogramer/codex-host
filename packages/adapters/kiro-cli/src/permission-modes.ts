import type {
  HarnessPermissionMode,
  HarnessPermissionModeCatalog,
  HarnessPermissionModeId,
} from "@codexhost/shared-contracts";
import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";

export const KIRO_DEFAULT_PERMISSION_MODE_ID = harnessPermissionModeIdSchema.parse("autopilot");
const KIRO_SUPERVISED_PERMISSION_MODE_ID = harnessPermissionModeIdSchema.parse("supervised");

export const KIRO_PERMISSION_MODES: HarnessPermissionMode[] = [
  {
    id: KIRO_DEFAULT_PERMISSION_MODE_ID,
    label: "Autopilot",
    description: "Automatic tool execution within native policy bounds",
  },
  {
    id: KIRO_SUPERVISED_PERMISSION_MODE_ID,
    label: "Supervised",
    description: "Manual review of tool approvals and file modifications",
  },
];

export const KIRO_PERMISSION_MODE_CATALOG: HarnessPermissionModeCatalog = {
  modes: KIRO_PERMISSION_MODES,
  defaultModeId: KIRO_DEFAULT_PERMISSION_MODE_ID,
};

export function isKiroPermissionMode(modeId: unknown): modeId is HarnessPermissionModeId {
  return (
    modeId === KIRO_DEFAULT_PERMISSION_MODE_ID || modeId === KIRO_SUPERVISED_PERMISSION_MODE_ID
  );
}

export function decodeKiroPermissionMode(modeId: HarnessPermissionModeId): "on" | "off" {
  if (modeId === KIRO_DEFAULT_PERMISSION_MODE_ID) return "on";
  if (modeId === KIRO_SUPERVISED_PERMISSION_MODE_ID) return "off";
  throw new Error(`Unknown Kiro permission mode '${modeId}'`);
}

export function encodeKiroPermissionMode(nativeValue: unknown): HarnessPermissionModeId {
  if (nativeValue === "off" || nativeValue === false) {
    return harnessPermissionModeIdSchema.parse("supervised");
  }
  return KIRO_DEFAULT_PERMISSION_MODE_ID;
}
