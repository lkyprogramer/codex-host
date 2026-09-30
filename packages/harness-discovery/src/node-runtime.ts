import path from "node:path";

/**
 * Guarantees the harness child process can resolve `node`, which a
 * `#!/usr/bin/env node` entrypoint needs and a GUI-launched PATH rarely has.
 * Existing PATH entries keep priority over the Host runtime directory.
 */
export function withNodeRuntimeOnPath(
  environment: NodeJS.ProcessEnv,
  runtimeExecutable = process.execPath,
  platform = process.platform,
): NodeJS.ProcessEnv {
  const pathKey = Object.keys(environment).find((name) => name.toLowerCase() === "path") ?? "PATH";
  const delimiter = platform === "win32" ? ";" : ":";
  const runtimeDirectory = (platform === "win32" ? path.win32 : path).dirname(runtimeExecutable);
  const directories = (environment[pathKey] ?? "").split(delimiter).filter(Boolean);
  const equal =
    platform === "win32" ? (value: string) => value.toLowerCase() : (value: string) => value;
  if (!directories.some((directory) => equal(directory) === equal(runtimeDirectory))) {
    directories.push(runtimeDirectory);
  }
  return { ...environment, [pathKey]: directories.join(delimiter) };
}
