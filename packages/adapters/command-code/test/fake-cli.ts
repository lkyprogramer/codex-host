import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface FakeCommandCode {
  command: string;
  cwd: string;
  home: string;
  /** Every argv the stand-in received, one JSON array per line. */
  callLog: string;
  environment: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

/**
 * Stand-in for the `command-code` binary. `commandInvocation` wraps `.cmd`
 * through cmd.exe on Windows, so a batch shim delegates to Node there and a
 * shebang script runs directly elsewhere. `HOME` points at a private
 * directory so the Adapter's session-file lookup never touches the real
 * `~/.commandcode`.
 */
export async function fakeCommandCode(script: string): Promise<FakeCommandCode> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-command-code-"));
  const cwd = path.join(directory, "workspace");
  const home = path.join(directory, "home");
  await mkdir(cwd);
  await mkdir(home);
  const callLog = path.join(directory, "calls.jsonl");
  const jsPath = path.join(directory, "command-code.cjs");
  const body = `${FAKE_PRELUDE}\n${script}`;
  await writeFile(jsPath, body);
  let command: string;
  if (process.platform === "win32") {
    command = path.join(directory, "command-code.cmd");
    await writeFile(command, `@node "${jsPath}" %*\r\n`);
  } else {
    command = path.join(directory, "command-code");
    await writeFile(command, `#!/usr/bin/env node\n${body}`);
    await chmod(command, 0o755);
  }
  return {
    command,
    cwd,
    home,
    callLog,
    environment: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEXHOST_FAKE_CALL_LOG: callLog,
    },
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

/** Shared helpers available to every fake script. */
const FAKE_PRELUDE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (process.env.CODEXHOST_FAKE_CALL_LOG) {
  fs.appendFileSync(process.env.CODEXHOST_FAKE_CALL_LOG, JSON.stringify(args) + "\n");
}
const emit = (event) => process.stdout.write(JSON.stringify({ type: "event", event }) + "\n");
const result = (line) => process.stdout.write(JSON.stringify({ type: "result", ...line }) + "\n");
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const readPrompt = () =>
  new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
const home = process.env.HOME;
const projectDir = path.join(home, ".commandcode", "projects", "fixture-project");
/** Appends a v3 transcript the way the CLI does: header first, then message nodes. */
const writeSession = (sessionId, cwd, entries) => {
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, sessionId + ".jsonl");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd }) + "\n",
    );
  }
  for (const entry of entries) fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  return file;
};
const lastMessageId = (file) => {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").slice(1);
  const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
  return last ? last.id : null;
};
`;
