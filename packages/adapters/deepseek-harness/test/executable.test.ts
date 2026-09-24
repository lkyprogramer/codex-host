import { accessSync, constants, statSync, type Stats } from "node:fs";
import type * as filesystem from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deepSeekProcessInvocation, resolveDeepSeekCommand } from "../src/executable.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof filesystem>()),
  accessSync: vi.fn(),
  statSync: vi.fn(),
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
const entries = new Map<string, "file" | "directory">();

function platform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

beforeEach(() => {
  entries.clear();
  vi.mocked(accessSync).mockImplementation((file) => {
    if (!entries.has(String(file))) throw new Error("ENOENT");
  });
  vi.mocked(statSync).mockImplementation(
    (file) =>
      ({
        isFile: () => entries.get(String(file)) === "file",
      }) as Stats,
  );
});

afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("DeepSeek executable helpers", () => {
  it("honors explicit executable identity and skips directories on POSIX PATH", () => {
    platform("linux");
    entries.set("/bin/dsh", "file");
    entries.set("./custom/dsh", "file");
    entries.set("relative\\dsh", "file");
    expect(resolveDeepSeekCommand("/missing/dsh", { PATH: "/bin" })).toBeNull();
    expect(resolveDeepSeekCommand("./custom/dsh", { PATH: "/bin" })).toEqual({
      command: "./custom/dsh",
      arguments: [],
      kind: "configured",
    });
    expect(resolveDeepSeekCommand("relative\\dsh", {})).toEqual({
      command: "relative\\dsh",
      arguments: [],
      kind: "configured",
    });
    entries.set("/first/dsh", "directory");
    expect(resolveDeepSeekCommand(undefined, { PATH: '  :"/first": /bin : /last ' })).toEqual({
      command: "/bin/dsh",
      arguments: [],
      kind: "dsh",
    });
    expect(accessSync).toHaveBeenCalledWith("/bin/dsh", constants.X_OK);
  });

  it("uses local offline npx only when dsh is absent", () => {
    platform("linux");
    entries.set("/bin/npx", "file");
    expect(resolveDeepSeekCommand(undefined, { PATH: "/bin" })).toEqual({
      command: "/bin/npx",
      arguments: ["--offline", "--no-install", "@deepseek-ai/dsh"],
      kind: "npx",
    });
    expect(resolveDeepSeekCommand(undefined, {})).toBeNull();
  });

  it("uses Windows case-insensitive environment names, PATHEXT and quoted PATH entries", () => {
    platform("win32");
    entries.set(String.raw`C:\npm\dsh.CMD`, "file");
    expect(
      resolveDeepSeekCommand(undefined, { Path: ' ; "C:\\npm" ; ', PATHEXT: " .EXE ; ; .CMD " }),
    ).toEqual({ command: String.raw`C:\npm\dsh.CMD`, arguments: [], kind: "dsh" });
    expect(accessSync).toHaveBeenCalledWith(String.raw`C:\npm\dsh.CMD`, constants.F_OK);
    entries.set(String.raw`C:\npm\custom.exe`, "file");
    expect(resolveDeepSeekCommand("custom.exe", { PATH: String.raw`C:\npm` })).toEqual({
      command: String.raw`C:\npm\custom.exe`,
      arguments: [],
      kind: "configured",
    });
    entries.delete(String.raw`C:\npm\dsh.CMD`);
    entries.set(String.raw`C:\npm\npx.cmd`, "file");
    expect(resolveDeepSeekCommand(undefined, { PATH: String.raw`C:\npm` })).toMatchObject({
      command: String.raw`C:\npm\npx.cmd`,
      kind: "npx",
    });
  });

  it("quotes Windows shims and preserves direct native invocations", () => {
    const args = ["web", "a b", "100%", 'a"b'];
    expect(
      deepSeekProcessInvocation("dsh.cmd", args, { COMSPEC: "custom-cmd.exe" }, "win32"),
    ).toEqual({
      command: "custom-cmd.exe",
      windowsVerbatimArguments: true,
      arguments: ["/d", "/v:off", "/s", "/c", '""dsh.cmd" "web" "a b" "100%%" "a""b""'],
    });
    expect(deepSeekProcessInvocation("dsh.bat", [], {}, "win32").command).toBe("cmd.exe");
    expect(deepSeekProcessInvocation("dsh.exe", args, {}, "win32")).toEqual({
      command: "dsh.exe",
      arguments: args,
      windowsVerbatimArguments: false,
    });
    expect(deepSeekProcessInvocation("dsh.cmd", args, {}, "linux")).toEqual({
      command: "dsh.cmd",
      arguments: args,
      windowsVerbatimArguments: false,
    });
    expect(deepSeekProcessInvocation("dsh", [], {}).windowsVerbatimArguments).toBe(false);
  });
});
