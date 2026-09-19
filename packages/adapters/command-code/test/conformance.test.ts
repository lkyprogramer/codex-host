import { readFile } from "node:fs/promises";
import path from "node:path";

import { runAdapterConformance } from "@codexhost/harness-adapter/conformance";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { expect, it } from "vitest";

import { CommandCodeAdapter } from "../src/index.js";
import { fakeCommandCode } from "./fake-cli.js";

/**
 * Print-mode stand-in for the public conformance driver. Each process records
 * its start and exit with the Thread environment marker it was spawned with,
 * persists the v3 transcript with the CLI's timing so a fresh Adapter can
 * resume by ID, and holds open on the cancellable prompt until stopped.
 */
const CONFORMANCE_SCRIPT = String.raw`
const statusPath = process.env.CODEXHOST_CONFORMANCE_STATUS;
const marker = process.env.CODEXHOST_CONFORMANCE_ENV ?? "missing";
const record = (state, sessionId) => {
  if (statusPath) fs.appendFileSync(statusPath, JSON.stringify({ state, pid: process.pid, marker, sessionId }) + "\n");
};
process.on("SIGTERM", () => process.exit(130));
if (args.includes("--list-models")) {
  process.stdout.write("claude-sonnet-5                        best combo (default)\n");
  process.exit(0);
}
(async () => {
  const prompt = (await readPrompt()).trim();
  const sessionPath = flag("--session");
  const resumed = Boolean(sessionPath || flag("--resume"));
  const sessionId = sessionPath
    ? path.basename(sessionPath, ".jsonl")
    : flag("--resume") ?? "cc-conformance-" + marker + "-" + process.pid;
  process.on("exit", () => record("exit", sessionId));
  record("start", sessionId);
  const session = store(sessionId, process.cwd());
  session.prompt(prompt);
  emit({ type: "run_start", sessionId });
  emit({ type: "turn_start", turnNumber: resumed ? 2 : 1 });
  if (prompt.includes("fixture cancellable")) {
    setInterval(() => undefined, 1000);
    return;
  }
  emit({ type: "text_delta", delta: "fixture native response" });
  session.assistant("fixture native response");
  session.flush();
  result({ subtype: "success", sessionId, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1, finalText: "fixture native response" });
  process.exit(0);
})();
`;

interface StatusRecord {
  state: string;
  pid: number;
  marker: string;
  sessionId: string;
}

it("records a Command Code print-process fixture conformance receipt", async () => {
  const fake = await fakeCommandCode(CONFORMANCE_SCRIPT);
  const statusPath = path.join(fake.home, "native-processes.log");
  const readRecords = async (): Promise<StatusRecord[]> =>
    (await readFile(statusPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StatusRecord);
  const primaryEnvironment = {
    CODEXHOST_THREAD_ID: "conformance-primary",
    CODEXHOST_CONFORMANCE_ENV: "primary",
    CODEXHOST_CONFORMANCE_STATUS: statusPath,
  };
  try {
    const receipt = await runAdapterConformance({
      createAdapter: () =>
        new CommandCodeAdapter({ command: fake.command, environment: fake.environment }),
      cwd: fake.cwd,
      evidence: {
        hostSha: null,
        pluginBundleSha256: null,
        nativeVersion: null,
        platform: process.platform,
        mode: "native-process-fixture",
      },
      environment: {
        primary: primaryEnvironment,
        isolated: {
          ...primaryEnvironment,
          CODEXHOST_THREAD_ID: "conformance-isolated",
          CODEXHOST_CONFORMANCE_ENV: "isolated",
        },
        resume: { ...primaryEnvironment, CODEXHOST_CONFORMANCE_ENV: "resume" },
      },
      prompts: {
        first: "fixture first",
        cancellable: "fixture cancellable",
        followup: "fixture followup",
      },
      probes: {
        activateIsolated: async (session, output) => {
          const turnId = hostTurnIdSchema.parse("conformance-isolated");
          const started = await session.execute({
            type: "turn.start",
            turnId,
            input: [{ type: "text", text: "fixture isolated" }],
          });
          if (!started.ok) throw new Error(started.error.message);
          const terminal = await output.waitForTerminal(turnId);
          if (terminal.outcome.status !== "succeeded") {
            throw new Error("isolated Command Code fixture Turn did not succeed");
          }
        },
        assertEnvironmentIsolation: async () => {
          const records = await readRecords();
          const primary = records.find((r) => r.state === "start" && r.marker === "primary");
          const isolated = records.find((r) => r.state === "start" && r.marker === "isolated");
          expect(primary).toBeDefined();
          expect(isolated).toBeDefined();
          expect(primary?.sessionId).not.toBe(isolated?.sessionId);
          expect(primary?.pid).not.toBe(isolated?.pid);
        },
        readCleanup: async () => {
          const records = await readRecords();
          const started = records.filter((r) => r.state === "start");
          const exited = new Set(records.filter((r) => r.state === "exit").map((r) => r.pid));
          return {
            residue: started.every((r) => exited.has(r.pid)) ? "none" : "present",
          };
        },
      },
    });
    expect(receipt.harnessId).toBe("command-code");
    // Subagent observation has no fixture scenario yet, so the receipt stays incomplete.
    expect(receipt.status).toBe("incomplete");
    const created = receipt.identityReadback.createdSession?.nativeSessionId;
    expect(created).toMatch(/^cc-conformance-primary-/u);
    expect(receipt.identityReadback.resumedSession?.nativeSessionId).toBe(created);
    expect(receipt.scenarios).toMatchObject({
      firstTurn: { status: "passed" },
      environmentIsolation: { status: "passed" },
      concurrentTurn: { status: "passed" },
      cancel: { status: "passed" },
      identityReadback: { status: "passed" },
      resume: { status: "passed" },
      followup: { status: "passed" },
      cleanup: { status: "passed" },
      fork: { status: "skipped" },
      rollback: { status: "skipped" },
      subagents: { status: "notCovered" },
    });
    const resumeRun = (await readRecords()).find(
      (r) => r.state === "start" && r.marker === "resume",
    );
    expect(resumeRun?.sessionId).toBe(created);
  } finally {
    await fake.cleanup();
  }
}, 30_000);
