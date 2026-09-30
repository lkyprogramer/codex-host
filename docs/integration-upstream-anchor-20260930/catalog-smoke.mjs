import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PiAdapter } from "/Users/luo/Documents/github/codex-host-merge-anchor/packages/adapters/pi/dist/index.js";
import { OpenCodeAdapter } from "/Users/luo/Documents/github/codex-host-merge-anchor/packages/adapters/opencode/dist/index.js";
const root = "/tmp/codexhost-merge-anchor-20260930/catalog";
const cwd = path.join(root, "workspace");
await mkdir(path.join(cwd, ".pi/skills/anchor-smoke"), { recursive: true });
await writeFile(
  path.join(cwd, ".pi/skills/anchor-smoke/SKILL.md"),
  "---\nname: anchor-smoke\ndescription: Integration catalog smoke only\n---\nRead the smoke marker.\n",
);
await mkdir(path.join(root, "pi-agent"), { recursive: true });
const common = {
  ...process.env,
  CODEXHOST_PROCESS_LEDGER_DIR: "/tmp/codexhost-merge-anchor-20260930/ledger",
  CODEXHOST_PROCESS_ANCHOR_PATH: process.env.CODEXHOST_PROCESS_ANCHOR_PATH,
};
const pi = new PiAdapter({
  command: "/Users/luo/.nvm/versions/node/v22.19.0/bin/pi",
  environment: { ...common, PI_CODING_AGENT_DIR: path.join(root, "pi-agent") },
});
const opencode = new OpenCodeAdapter({
  command: "/Users/luo/.opencode/bin/opencode",
  environment: {
    ...common,
    XDG_CONFIG_HOME: path.join(root, "opencode-config"),
    XDG_DATA_HOME: path.join(root, "opencode-data"),
    XDG_CACHE_HOME: path.join(root, "opencode-cache"),
    XDG_STATE_HOME: path.join(root, "opencode-state"),
    OPENCODE_TEST_HOME: path.join(root, "opencode-home"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      command: {
        anchor_smoke: { template: "Read-only catalog smoke.", description: "Anchor catalog smoke" },
      },
    }),
  },
});
const receipt = {};
for (const [name, adapter, match] of [
  ["pi", pi, "anchor-smoke"],
  ["opencode", opencode, "anchor_smoke"],
]) {
  try {
    const result = await adapter.inspectCommands({ cwd, signal: AbortSignal.timeout(25_000) });
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    assert.equal(result.value.source, "live");
    const fixtureCommandObserved = result.value.commands.some((command) =>
      command.invocation.includes(match),
    );
    assert(result.value.commands.length > 0, "native catalog is empty");
    if (name === "opencode") assert(fixtureCommandObserved, "OpenCode configured command missing");
    receipt[name] = {
      live: true,
      count: result.value.commands.length,
      fixtureCommandObserved,
      providerPrompts: 0,
    };
  } finally {
    await adapter.close();
  }
}
const sessionDir = path.join(root, "pi-agent/sessions");
let sessions = [];
try {
  sessions = await readdir(sessionDir, { recursive: true });
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
assert.equal(sessions.length, 0, "Pi inspection persisted a Session");
receipt.pi.noPersistedSession = true;
await writeFile(path.join(root, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt));
