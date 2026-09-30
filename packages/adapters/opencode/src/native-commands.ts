import { createHash } from "node:crypto";

import type { Command } from "@opencode-ai/sdk/v2";
import {
  harnessCommandCatalogSchema,
  harnessCommandDescriptorSchema,
  type HarnessCommandCatalog,
  type HarnessCommandDescriptor,
} from "@codexhost/shared-contracts";

const ID_PREFIX = "opencode.native.";

// Native commands that mutate Server/Session ownership, Desktop-owned settings,
// authentication, or work that can outlive the Host Turn are not admitted.
const EXCLUDED_COMMANDS = new Set([
  "clear",
  "exit",
  "fork",
  "new",
  "quit",
  "resume",
  "session",
  "sessions",
  "model",
  "models",
  "settings",
  "login",
  "logout",
  "mcp",
  "plugins",
  "share",
  "shell",
  "background",
  "jobs",
  "queue",
  "schedule",
  "steer",
]);

function nativeCommandId(name: string): string {
  return `${ID_PREFIX}${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
}

function normalizedName(name: string): string {
  return name.trim().replace(/^\//u, "");
}

export function openCodeNativeCommandCatalog(native: readonly Command[]): HarnessCommandCatalog {
  const commands: HarnessCommandDescriptor[] = [];
  const seen = new Set<string>();
  const kinds = new Map<string, "command" | "skill" | "ambiguous">();
  for (const command of native) {
    const name = normalizedName(command.name);
    const kind = command.source === "skill" ? "skill" : "command";
    const previous = kinds.get(name);
    kinds.set(name, previous && previous !== kind ? "ambiguous" : (previous ?? kind));
  }
  for (const command of native) {
    const name = normalizedName(command.name);
    // session.command accepts only a name, so an ambiguous command/skill pair
    // cannot be executed as the intended source even if one entry is filtered.
    if (!name || /\s/u.test(name) || seen.has(name) || kinds.get(name) === "ambiguous") continue;
    if (command.source !== "skill" && EXCLUDED_COMMANDS.has(name)) continue;
    const descriptor = {
      id: nativeCommandId(name),
      invocation: `/${name}`,
      label: name,
      ...(command.description?.trim() ? { description: command.description.trim() } : {}),
      argumentMode: "text" as const,
      kind: command.source === "skill" ? ("skill" as const) : ("command" as const),
    };
    const parsed = harnessCommandDescriptorSchema.safeParse(descriptor);
    if (!parsed.success) continue;
    seen.add(name);
    commands.push(parsed.data);
  }
  return harnessCommandCatalogSchema.parse({ commands, source: "live" });
}

export function openCodeNativeCommandName(
  catalog: HarnessCommandCatalog,
  commandId: string,
): string | null {
  if (!commandId.startsWith(ID_PREFIX)) return null;
  const descriptor = catalog.commands.find(({ id }) => id === commandId);
  return descriptor?.invocation.slice(1) ?? null;
}
