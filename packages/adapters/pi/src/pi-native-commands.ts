import { createHash } from "node:crypto";

import {
  harnessCommandCatalogSchema,
  harnessCommandDescriptorSchema,
  type HarnessCommandCatalog,
  type HarnessCommandDescriptor,
} from "@codexhost/shared-contracts";

import type { PiNativeCommand } from "./pi-rpc-session.js";

const ID_PREFIX = "pi.native.";

// These extension commands change native session/configuration ownership or
// manage background work that cannot be represented by a Host command Turn.
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
  "subagents-detach",
  "subagents-fleet",
  "subagents-generate-profiles",
  "subagents-inspect-rpc",
  "subagents-load-profile",
  "subagents-refresh-provider-models",
  "subagents-steer",
  "subagents-stop",
  "subagents-watchdog",
]);

function nativeCommandId(name: string): string {
  return `${ID_PREFIX}${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
}

function normalizedName(name: string): string {
  return name.trim().replace(/^\//u, "");
}

export function piNativeCommandCatalog(native: readonly PiNativeCommand[]): HarnessCommandCatalog {
  const commands: HarnessCommandDescriptor[] = [];
  const seen = new Set<string>();
  const sources = new Map<string, PiNativeCommand["source"] | "ambiguous">();
  for (const command of native) {
    const name = normalizedName(command.name);
    const previous = sources.get(name);
    sources.set(
      name,
      previous && previous !== command.source ? "ambiguous" : (previous ?? command.source),
    );
  }
  for (const command of native) {
    const name = normalizedName(command.name);
    // RPC prompt accepts only a name; a same-name entry from another source
    // cannot be targeted reliably even if one source would be excluded.
    if (!name || /\s/u.test(name) || seen.has(name) || sources.get(name) === "ambiguous") continue;
    // A skill can have an ordinary command's name. Only extension commands
    // are subject to native lifecycle exclusions; Pi resolves name collisions.
    if (command.source === "extension" && EXCLUDED_COMMANDS.has(name)) continue;
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

export function piNativeCommandPrompt(
  catalog: HarnessCommandCatalog,
  commandId: string,
  arguments_: unknown,
): string | null {
  if (!commandId.startsWith(ID_PREFIX)) return null;
  const descriptor = catalog.commands.find(({ id }) => id === commandId);
  if (!descriptor) return null;
  const text = typeof arguments_ === "string" ? arguments_ : "";
  return text.length > 0 ? `${descriptor.invocation} ${text}` : descriptor.invocation;
}
