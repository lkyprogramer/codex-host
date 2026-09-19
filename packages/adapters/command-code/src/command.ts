import path from "node:path";

import {
  resolveHarnessExecutable,
  targetPath,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export const COMMAND_CODE_COMMAND_ENV = "CODEXHOST_COMMAND_CODE_COMMAND";

/**
 * The npm package installs `cmd`, `cmdc` and `command-code` side by side. Only
 * the long name is unambiguous on every platform: `cmd` is the Windows shell
 * and `cmdc` exists purely as the Windows workaround for that clash.
 */
export const commandCodeDiscoverySpec: HarnessDiscoverySpec = {
  id: "command-code",
  command: "command-code",
  commandEnvironmentVariable: COMMAND_CODE_COMMAND_ENV,
  installRoots: {
    posix: ["~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"],
    windows: ["${APPDATA}/npm", "~/.local/bin"],
  },
};

export function resolveCommandCodeExecutable(
  input: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {},
): string | undefined {
  const platform = input.platform ?? process.platform;
  const resolution = resolveHarnessExecutable(commandCodeDiscoverySpec, {
    ...(input.command ? { command: input.command } : {}),
    environment: input.environment ?? process.env,
    ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
    platform,
  });
  if (!resolution) return undefined;
  return targetPath(platform).isAbsolute(resolution.executable)
    ? resolution.executable
    : path.resolve(resolution.executable);
}
