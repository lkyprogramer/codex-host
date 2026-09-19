import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { HarnessOutput, HarnessSession, HostEvent } from "@codexhost/harness-adapter";
import {
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { CommandCodeAdapter, encodeCommandCodeModelRef } from "../src/index.js";
import { fakeCommandCode, type FakeCommandCode } from "./fake-cli.js";

/**
 * Emulates print mode: `--list-models` prints the built-in table (no login
 * needed, as in the real CLI); `-p` reads the prompt from stdin, persists a v3
 * transcript under the fake HOME with the CLI's timing (first assistant
 * message or the final flush), streams AgentEvent frames chosen by keywords in
 * the prompt, prints the `result` line and exits with the matching code.
 */
const PRINT_MODE_SCRIPT = String.raw`
process.on("SIGTERM", () => process.exit(130));
if (args.includes("--list-models")) {
  process.stdout.write("Available models  ·  2 models\n\nOpen Source\n\n");
  process.stdout.write("deepseek/deepseek-v4-flash             fast reasoning (default)\n");
  process.stdout.write("claude-sonnet-5                        best combo\n");
  process.exit(0);
}
if (!args.includes("-p") || flag("--output-format") !== "json") {
  process.stderr.write("fixture expects print mode with json output\n");
  process.exit(1);
}
if (args.includes("--resume") || args.includes("--fork-session") || args.includes("--effort")) {
  process.stderr.write("fixture: unexpected argument form\n");
  process.exit(1);
}
if (flag("-m") === "totally/unknown-model") {
  process.stderr.write('Error: unknown model "totally/unknown-model".\nRun "cmd --list-models" to see all available models\n');
  process.exit(1);
}
(async () => {
  const prompt = (await readPrompt()).trim();
  const cwd = process.cwd();
  const sessionPath = flag("--session");
  if (sessionPath && !fs.existsSync(sessionPath)) {
    process.stderr.write("Error: session file not found\n");
    process.exit(1);
  }
  const sessionId = sessionPath
    ? path.basename(sessionPath, ".jsonl")
    : "fake-" + Math.random().toString(36).slice(2, 10);
  if (prompt.includes("fail-auth")) {
    // Early failure: no run_start, no transcript, result line without sessionId.
    process.stderr.write('Error: Not authenticated. Please run "cmd login" first.\n');
    result({ subtype: "error", usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1, finalText: "", error: 'Error: Not authenticated. Please run "cmd login" first.' });
    process.exit(3);
  }
  const session = store(sessionId, cwd);
  session.prompt(prompt);
  emit({ type: "run_start", sessionId });
  emit({ type: "turn_start", turnNumber: 1 });
  if (prompt.includes("hang")) {
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.includes("think")) {
    emit({ type: "thinking_start" });
    emit({ type: "thinking_delta", delta: "plan" });
    emit({ type: "thinking_delta", delta: "ning" });
    emit({ type: "thinking_end" });
  }
  if (prompt.includes("sayfirst")) {
    emit({ type: "text_delta", delta: "I'll update the file now." });
  }
  if (prompt.includes("read")) {
    emit({ type: "tool_queued", toolCallId: "c-read", toolName: "read_file", input: { file_path: path.join(cwd, "README.md") } });
    emit({ type: "tool_running", toolCallId: "c-read", toolName: "read_file", description: "Read README.md" });
    emit({ type: "tool_completed", toolCallId: "c-read", toolName: "read_file", result: [{ type: "text", text: "hello probe file" }] });
  }
  if (prompt.includes("notqueued")) {
    emit({ type: "tool_running", toolCallId: "c-late", toolName: "glob" });
    emit({ type: "tool_completed", toolCallId: "c-late", toolName: "glob", result: [{ type: "text", text: "a.ts" }] });
  }
  if (prompt.includes("shell")) {
    emit({ type: "tool_queued", toolCallId: "c-sh", toolName: "shell_command", input: { command: "echo hi" } });
    emit({ type: "tool_running", toolCallId: "c-sh", toolName: "shell_command" });
    emit({ type: "tool_completed", toolCallId: "c-sh", toolName: "shell_command", result: [{ type: "text", text: "hi\n" }] });
  }
  if (prompt.includes("edit")) {
    const target = path.join(cwd, "target.txt");
    emit({ type: "tool_queued", toolCallId: "c-edit", toolName: "edit_file", input: { file_path: target, old_string: "alpha", new_string: "beta" } });
    emit({ type: "tool_running", toolCallId: "c-edit", toolName: "edit_file" });
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("alpha", "beta"));
    emit({ type: "tool_completed", toolCallId: "c-edit", toolName: "edit_file", result: [{ type: "text", text: "Edited target.txt" }] });
  }
  if (prompt.includes("blocked")) {
    emit({ type: "tool_queued", toolCallId: "c-blocked", toolName: "write_file", input: { file_path: path.join(cwd, "nope.txt"), content: "x" } });
    emit({ type: "tool_hook_blocked", toolCallId: "c-blocked", toolName: "write_file", hookOutput: "blocked" });
  }
  if (prompt.includes("subagent")) {
    emit({ type: "subagent_start", toolCallId: "c-agent", subagentType: "explore", description: "Find callers", background: false });
    emit({ type: "subagent_progress", toolCallId: "c-agent", subagentType: "explore", toolName: "grep", tokensUsed: 10 });
    emit({ type: "subagent_stop", toolCallId: "c-agent", subagentType: "explore", tokensUsed: 42 });
  }
  if (prompt.includes("compact")) {
    emit({ type: "compaction_start" });
    session.compaction();
    emit({ type: "compaction_done", tokensSaved: 100 });
  }
  const finalText = prompt.includes("sayfirst") ? "I'll update the file now." : prompt.includes("noresponse") ? "" : "Hello";
  if (!prompt.includes("sayfirst") && !prompt.includes("noresponse")) {
    emit({ type: "text_delta", delta: "Hel" });
    emit({ type: "text_delta", delta: "lo" });
  }
  emit({ type: "turn_end", turnNumber: 1, hadToolCalls: true, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  if (finalText) session.assistant(finalText);
  if (prompt.includes("error")) {
    emit({ type: "run_error", error: { name: "TransportError", message: "boom" } });
    session.flush();
    result({ subtype: "error", sessionId, usage: { inputTokens: 10, outputTokens: 5 }, durationMs: 5, finalText: "", error: "Error: boom" });
    process.exit(1);
  }
  const usage = { inputTokens: 12, outputTokens: 6, cacheReadTokens: 1, cacheWriteTokens: 0 };
  emit({ type: "run_end", result: { finalText, stopReason: "end_turn", turnCount: 1, usage } });
  session.flush();
  result({ subtype: "success", sessionId, stopReason: "end_turn", usage, durationMs: 7, finalText });
  if (prompt.includes("noresponse")) {
    process.stderr.write("Error: No response from the model\n");
    process.exit(9);
  }
  if (prompt.includes("refused")) {
    process.stderr.write("Error: This prompt was refused by policy\n");
    process.exit(1);
  }
  process.exit(0);
})();
`;

type Collected = { events: HostEvent[]; interactions: number };

async function collectTurn(
  outputs: AsyncIterator<HarnessOutput>,
  turnId: string,
): Promise<Collected> {
  const collected: Collected = { events: [], interactions: 0 };
  for (;;) {
    const next = await outputs.next();
    if (next.done) throw new Error("outputs ended before the Turn completed");
    if (next.value.kind === "interaction") {
      collected.interactions += 1;
      continue;
    }
    collected.events.push(next.value.event);
    if (next.value.event.type === "turn.completed" && next.value.event.turnId === turnId) {
      return collected;
    }
  }
}

function terminal(events: HostEvent[]): Extract<HostEvent, { type: "turn.completed" }> {
  const event = events.at(-1);
  if (event?.type !== "turn.completed") throw new Error("missing terminal");
  return event;
}

function completedItems(events: HostEvent[]) {
  return events
    .filter(
      (event): event is Extract<HostEvent, { type: "item.completed" }> =>
        event.type === "item.completed",
    )
    .map(({ snapshot }) => snapshot);
}

async function calls(fixture: FakeCommandCode): Promise<string[][]> {
  return (await readFile(fixture.callLog, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

async function runTurn(
  session: HarnessSession,
  outputs: AsyncIterator<HarnessOutput>,
  id: string,
  text: string,
): Promise<Collected> {
  const turnId = hostTurnIdSchema.parse(id);
  const started = await session.execute({
    type: "turn.start",
    turnId,
    input: [{ type: "text", text }],
  });
  if (!started.ok) throw new Error(started.error.message);
  return collectTurn(outputs, turnId);
}

describe("Command Code Adapter", () => {
  const fixtures: FakeCommandCode[] = [];
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.cleanup();
  });
  async function fixture(script = PRINT_MODE_SCRIPT): Promise<FakeCommandCode> {
    const created = await fakeCommandCode(script);
    fixtures.push(created);
    return created;
  }
  function open(fake: FakeCommandCode) {
    return new CommandCodeAdapter({ command: fake.command, environment: fake.environment });
  }

  it("reports notInstalled for an explicit missing command instead of searching PATH", async () => {
    const adapter = new CommandCodeAdapter({
      command: path.join("/definitely", "missing", "command-code"),
      environment: { PATH: "" },
    });
    try {
      expect(await adapter.inspect()).toMatchObject({ status: "notInstalled" });
      expect(await adapter.open({ kind: "create", cwd: process.cwd() })).toMatchObject({
        ok: false,
        error: { code: "notInstalled" },
      });
    } finally {
      await adapter.close();
    }
  });

  it("inspects the built-in Model catalog once without any Thinking options", async () => {
    const fake = await fixture();
    const adapter = open(fake);
    try {
      const inspection = await adapter.inspect({ cwd: fake.cwd });
      expect(inspection.status).toBe("ready");
      if (inspection.status !== "ready") return;
      expect(inspection.catalog.models.map(({ label }) => label)).toEqual([
        "deepseek/deepseek-v4-flash",
        "claude-sonnet-5",
      ]);
      expect(inspection.catalog.defaultModel).toEqual(
        encodeCommandCodeModelRef("deepseek/deepseek-v4-flash"),
      );
      expect(inspection.catalog.thinkingOptions).toEqual([]);
      expect(inspection.capabilities.configuration.selectThinkingOption).toBe(false);
      expect(inspection.permissionModes?.defaultModeId).toBe("bypass");
      expect(inspection.capabilities.history).toEqual({
        fork: false,
        forkAcrossCwd: false,
        rollbackLastTurn: false,
      });
      await adapter.inspect({ cwd: fake.cwd });
      expect((await calls(fake)).filter((args) => args.includes("--list-models"))).toHaveLength(1);
    } finally {
      await adapter.close();
    }
  });

  it("runs a Turn per print process, binds identity once the transcript exists and keys the Turn by the stored prompt", async () => {
    const fake = await fixture();
    await writeFile(path.join(fake.cwd, "target.txt"), "alpha\n");
    const adapter = open(fake);
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd: fake.cwd,
        model: encodeCommandCodeModelRef("claude-sonnet-5"),
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      expect(session.initialState.nativeRef).toBeUndefined();
      const outputs = session.outputs[Symbol.asyncIterator]();
      const turnId = hostTurnIdSchema.parse("turn-1");
      expect(
        await session.execute({
          type: "turn.start",
          turnId,
          input: [
            { type: "text", text: "think, read, notqueued, shell, edit and subagent please" },
          ],
        }),
      ).toEqual({ ok: true, value: { turnId } });
      expect(
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("turn-2"),
          input: [{ type: "text", text: "second" }],
        }),
      ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
      expect(
        await session.execute({
          type: "thinking.select",
          thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
        }),
      ).toMatchObject({ ok: false, error: { code: "unsupported" } });

      const { events, interactions } = await collectTurn(outputs, turnId);
      expect(interactions).toBe(0);
      const completed = completedItems(events);
      expect(completed.map(({ item }) => item.type)).toEqual([
        "reasoning",
        "toolExecution",
        "toolExecution",
        "commandExecution",
        "fileChange",
        "subagentDelegation",
        "agentMessage",
      ]);
      expect(completed[0]?.item).toMatchObject({ text: "planning" });
      expect(completed[1]?.item).toMatchObject({
        toolName: "read_file",
        output: { content: [{ type: "text", text: "hello probe file" }] },
      });
      // A tool reported only from `tool_running` still gets an Item.
      expect(completed[2]?.item).toMatchObject({ toolName: "glob", arguments: {} });
      expect(completed[3]?.item).toMatchObject({ command: "echo hi", output: "hi\n" });
      const fileChange = completed[4]?.item;
      expect(fileChange?.type === "fileChange" && fileChange.changes[0]).toMatchObject({
        path: "target.txt",
        kind: "update",
      });
      expect(fileChange?.type === "fileChange" ? fileChange.changes[0]?.unifiedDiff : "").toMatch(
        /-alpha\n\+beta/u,
      );
      expect(completed[5]?.item).toMatchObject({
        subagents: [{ nativeSubagentId: "c-agent", status: "completed" }],
      });
      expect(completed[6]?.item).toMatchObject({ text: "Hello" });

      // Identity is published only once the transcript is on disk: after every
      // Item has started and before the terminal, never at `run_start`.
      const stateIndex = events.findIndex((event) => event.type === "session.state.changed");
      expect(stateIndex).toBeGreaterThan(
        events.findLastIndex((event) => event.type === "item.started"),
      );
      expect(stateIndex).toBeLessThan(events.length - 1);
      const stateChange = events[stateIndex];
      expect(
        stateChange?.type === "session.state.changed" &&
          stateChange.state.nativeRef?.nativeSessionId,
      ).toMatch(/^fake-/u);
      expect(terminal(events)).toMatchObject({
        outcome: { status: "succeeded" },
        nativeTurnRef: { nativeTurnKey: expect.stringMatching(/^p-/u) },
      });
      expect(terminal(events).outcome).not.toHaveProperty("checkpoint");
      const usage = events
        .filter(
          (event): event is Extract<HostEvent, { type: "session.usage.changed" }> =>
            event.type === "session.usage.changed",
        )
        .at(-1);
      expect(usage?.usage).toEqual({
        inputTokens: 12,
        outputTokens: 6,
        cachedInputTokens: 1,
        cacheWriteInputTokens: 0,
        totalTokens: 18,
      });

      const snapshot = await session.readSnapshot();
      expect(snapshot.ok && snapshot.value.turns).toHaveLength(1);
      expect(snapshot.ok && snapshot.value.state?.effectivePermissionModeId).toBe("bypass");

      const [printCall] = (await calls(fake)).filter((args) => args.includes("-p"));
      expect(printCall).toEqual(
        expect.arrayContaining([
          "--output-format",
          "json",
          "--skip-onboarding",
          "--trust",
          "--no-auto-update",
          "-m",
          "claude-sonnet-5",
          "--dangerously-skip-permissions",
        ]),
      );
      expect(printCall).not.toContain("--session");
      expect(printCall).not.toContain("--effort");

      // The follow-up Turn continues the persisted transcript by path and gets its own key.
      const second = await runTurn(session, outputs, "turn-2", "again");
      const firstKey = terminal(events).nativeTurnRef?.nativeTurnKey;
      expect(terminal(second.events)).toMatchObject({ outcome: { status: "succeeded" } });
      expect(terminal(second.events).nativeTurnRef?.nativeTurnKey).not.toBe(firstKey);
      const [, secondCall] = (await calls(fake)).filter((args) => args.includes("-p"));
      expect(secondCall?.[secondCall.indexOf("--session") + 1]).toMatch(/fake-[a-z0-9]+\.jsonl$/u);
      await session.close();
      expect((await outputs.next()).done).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("does not repeat streamed text from the result line's finalText", async () => {
    const fake = await fixture();
    const adapter = open(fake);
    try {
      const opened = await adapter.open({ kind: "create", cwd: fake.cwd });
      if (!opened.ok) throw new Error(opened.error.message);
      const outputs = opened.value.outputs[Symbol.asyncIterator]();
      const { events } = await runTurn(opened.value, outputs, "sayfirst", "sayfirst then read");
      expect(completedItems(events).map(({ item }) => item.type)).toEqual([
        "agentMessage",
        "toolExecution",
      ]);
      expect(terminal(events).outcome).toEqual({ status: "succeeded" });
    } finally {
      await adapter.close();
    }
  });

  it("keeps a transcript-less first Turn from binding identity when cancelled", async () => {
    const fake = await fixture();
    const adapter = open(fake);
    try {
      const opened = await adapter.open({ kind: "create", cwd: fake.cwd });
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      const outputs = session.outputs[Symbol.asyncIterator]();
      const turnId = hostTurnIdSchema.parse("hanging");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "hang" }],
      });
      const first = await outputs.next();
      expect(first.value).toMatchObject({ kind: "event", event: { type: "turn.started" } });
      await expect(session.resourceLifecycle?.suspend({ aborted: false })).resolves.toMatchObject({
        status: "busy",
      });
      expect(await session.execute({ type: "turn.cancel", turnId })).toEqual({
        ok: true,
        value: { cancellationRequested: true },
      });
      const { events } = await collectTurn(outputs, turnId);
      expect(events.some((event) => event.type === "session.state.changed")).toBe(false);
      expect(terminal(events)).toMatchObject({ outcome: { status: "cancelled" } });
      expect(terminal(events)).not.toHaveProperty("nativeTurnRef");
      expect(await session.execute({ type: "turn.cancel", turnId })).toMatchObject({
        ok: false,
        error: { code: "invalidState" },
      });
      // Nothing native survived, so there is nothing to suspend to.
      await expect(session.resourceLifecycle?.suspend({ aborted: false })).resolves.toMatchObject({
        status: "unsupported",
      });
      // The next Turn starts a fresh run rather than resuming a ghost.
      const retry = await runTurn(session, outputs, "retry", "read");
      expect(terminal(retry.events)).toMatchObject({
        outcome: { status: "succeeded" },
        nativeTurnRef: { nativeTurnKey: expect.stringMatching(/^p-/u) },
      });
      // The hung run may have been stopped before it logged its argv; the retry must not resume.
      const printCalls = (await calls(fake)).filter((args) => args.includes("-p"));
      expect(printCalls.at(-1)).not.toContain("--session");
      await expect(session.resourceLifecycle?.suspend({ aborted: false })).resolves.toMatchObject({
        status: "suspended",
      });
      expect((await outputs.next()).done).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("qualifies a success result line by the exit code", async () => {
    const fake = await fixture();
    const adapter = open(fake);
    try {
      const opened = await adapter.open({ kind: "create", cwd: fake.cwd });
      if (!opened.ok) throw new Error(opened.error.message);
      const outputs = opened.value.outputs[Symbol.asyncIterator]();
      const silent = await runTurn(opened.value, outputs, "silent", "noresponse");
      expect(terminal(silent.events)).toMatchObject({
        outcome: {
          status: "failed",
          error: { code: "nativeFailure", retryable: false, message: /produced no response/u },
        },
      });
      const refused = await runTurn(opened.value, outputs, "refused", "refused");
      expect(terminal(refused.events)).toMatchObject({
        outcome: {
          status: "failed",
          error: {
            code: "nativeFailure",
            retryable: false,
            message: "Command Code did not complete the prompt: This prompt was refused by policy",
          },
        },
      });
      // The streamed answer of a refused run is still delivered, as a failed Item.
      expect(completedItems(refused.events).at(-1)).toMatchObject({
        item: { type: "agentMessage", text: "Hello" },
        outcome: { status: "failed" },
      });
    } finally {
      await adapter.close();
    }
  });

  it("types authentication and structured errors and never borrows the previous Turn's key", async () => {
    const fake = await fixture();
    const adapter = open(fake);
    try {
      const opened = await adapter.open({ kind: "create", cwd: fake.cwd });
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      const outputs = session.outputs[Symbol.asyncIterator]();
      const first = await runTurn(session, outputs, "first", "read");
      const firstKey = terminal(first.events).nativeTurnRef?.nativeTurnKey;
      expect(firstKey).toMatch(/^p-/u);

      // Login expired on an existing Session: result line without sessionId, exit 3, no prompt persisted.
      const auth = await runTurn(session, outputs, "auth", "fail-auth");
      expect(terminal(auth.events)).toMatchObject({
        outcome: { status: "failed", error: { code: "authenticationRequired" } },
      });
      expect(terminal(auth.events)).not.toHaveProperty("nativeTurnRef");

      const failing = await runTurn(session, outputs, "error", "error");
      expect(terminal(failing.events)).toMatchObject({
        outcome: {
          status: "failed",
          error: { code: "nativeFailure", message: "Command Code Turn failed: Error: boom" },
        },
        nativeTurnRef: { nativeTurnKey: expect.stringMatching(/^p-/u) },
      });
      expect(terminal(failing.events).nativeTurnRef?.nativeTurnKey).not.toBe(firstKey);
      // Streamed text before the failure is still delivered as a failed Item.
      expect(
        failing.events.find(
          (event) => event.type === "item.completed" && event.snapshot.item.type === "agentMessage",
        ),
      ).toMatchObject({ snapshot: { outcome: { status: "failed" } } });
      const snapshot = await session.readSnapshot();
      expect(snapshot.ok && snapshot.value.turns.map((turn) => turn.outcome.status)).toEqual([
        "succeeded",
        "failed",
      ]);
    } finally {
      await adapter.close();
    }
  });

  it("reports a rejected model argument as invalidRequest rather than a retryable crash", async () => {
    const fake = await fixture();
    const adapter = open(fake);
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd: fake.cwd,
        model: encodeCommandCodeModelRef("totally/unknown-model"),
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const outputs = opened.value.outputs[Symbol.asyncIterator]();
      const { events } = await runTurn(opened.value, outputs, "bad-model", "hi");
      expect(terminal(events)).toMatchObject({
        outcome: {
          status: "failed",
          error: { code: "invalidRequest", retryable: false, message: /unknown model/u },
        },
      });
    } finally {
      await adapter.close();
    }
  });

  it("surfaces a native permission block as a failed Tool Item under the read-only mode", async () => {
    const fake = await fixture();
    const adapter = open(fake);
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd: fake.cwd,
        permissionModeId: harnessPermissionModeIdSchema.parse("read-only"),
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      const outputs = session.outputs[Symbol.asyncIterator]();
      const { events } = await runTurn(session, outputs, "blocked", "blocked");
      expect(
        events.find(
          (event) =>
            event.type === "item.completed" && event.snapshot.item.type === "toolExecution",
        ),
      ).toMatchObject({
        snapshot: {
          item: { toolName: "write_file" },
          outcome: { status: "failed", error: { message: expect.stringMatching(/read-only/u) } },
        },
      });
      const [printCall] = (await calls(fake)).filter((args) => args.includes("-p"));
      expect(printCall).not.toContain("--dangerously-skip-permissions");
      expect(printCall).not.toContain("--permission-mode");
      expect(
        await session.execute({
          type: "permissionMode.select",
          permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
        }),
      ).toEqual({ ok: true, value: { completed: true } });
      expect(
        await session.execute({
          type: "permissionMode.select",
          permissionModeId: harnessPermissionModeIdSchema.parse("auto-accept"),
        }),
      ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    } finally {
      await adapter.close();
    }
  });

  it("resumes from the transcript, replays history across a compaction and rejects a foreign or relocated Session", async () => {
    const fake = await fixture();
    const adapter = open(fake);
    let nativeSessionId = "";
    try {
      const opened = await adapter.open({ kind: "create", cwd: fake.cwd });
      if (!opened.ok) throw new Error(opened.error.message);
      const outputs = opened.value.outputs[Symbol.asyncIterator]();
      await runTurn(opened.value, outputs, "first", "read");
      const compacted = await runTurn(opened.value, outputs, "second", "compact");
      expect(completedItems(compacted.events).map(({ item }) => item.type)).toEqual([
        "contextCompaction",
        "agentMessage",
      ]);
      const snapshot = await opened.value.readSnapshot();
      nativeSessionId = snapshot.ok ? (snapshot.value.state?.nativeRef?.nativeSessionId ?? "") : "";
      expect(nativeSessionId).toMatch(/^fake-/u);
    } finally {
      await adapter.close();
    }

    const nativeRef = nativeSessionRefSchema.parse({
      harnessId: "command-code",
      nativeSessionId,
      formatVersion: 1,
    });
    // History-only opens need the transcript, not the CLI.
    const offline = new CommandCodeAdapter({
      command: path.join("/definitely", "missing", "command-code"),
      environment: fake.environment,
    });
    try {
      const resumed = await offline.open({
        kind: "resume",
        nativeRef,
        cwd: fake.cwd,
        historyOnly: true,
      });
      if (!resumed.ok) throw new Error(resumed.error.message);
      const replay = await resumed.value.readSnapshot();
      // The compaction node sits on the parentId chain; both prompts must still replay.
      expect(replay.ok && replay.value.turns.map((turn) => turn.input[0]?.text)).toEqual([
        "read",
        "compact",
      ]);
      expect(replay.ok && replay.value.turns[0]?.items.map(({ item }) => item.type)).toEqual([
        "agentMessage",
      ]);
      expect(resumed.value.initialState.nativeRef).toEqual(nativeRef);
      expect(
        await resumed.value.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("offline"),
          input: [{ type: "text", text: "hi" }],
        }),
      ).toMatchObject({ ok: false, error: { code: "notInstalled" } });
    } finally {
      await offline.close();
    }

    const fresh = open(fake);
    try {
      expect(
        await fresh.open({ kind: "resume", nativeRef, cwd: path.join(fake.cwd, "..") }),
      ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
      expect(
        await fresh.open({
          kind: "resume",
          nativeRef: { ...nativeRef, nativeSessionId: "fake-missing" },
          cwd: fake.cwd,
        }),
      ).toMatchObject({ ok: false, error: { code: "sessionNotFound" } });
      expect(
        await fresh.open({
          kind: "resume",
          nativeRef: nativeSessionRefSchema.parse({
            harnessId: "antigravity",
            nativeSessionId,
            formatVersion: 1,
          }),
          cwd: fake.cwd,
        }),
      ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
      expect(
        await fresh.open({
          kind: "fork",
          sourceRef: nativeRef,
          checkpoint: {
            harnessId: nativeRef.harnessId,
            nativeSessionId,
            checkpointId: "x",
            formatVersion: 1,
          },
          cwd: fake.cwd,
        }),
      ).toMatchObject({ ok: false, error: { code: "unsupported" } });
      expect(
        await fresh.open({ kind: "rollbackLastTurn", sourceRef: nativeRef, cwd: fake.cwd }),
      ).toMatchObject({ ok: false, error: { code: "unsupported" } });
    } finally {
      await fresh.close();
    }
  });

  it("fails the Turn when the CLI resumes a different Session than the Native Ref", async () => {
    const fake = await fixture(
      PRINT_MODE_SCRIPT.replace(
        'emit({ type: "run_start", sessionId });',
        'emit({ type: "run_start", sessionId: "someone-else" });',
      ),
    );
    const adapter = open(fake);
    try {
      const projects = path.join(fake.home, ".commandcode", "projects", "seeded");
      await mkdir(projects, { recursive: true });
      await writeFile(
        path.join(projects, "fake-seeded.jsonl"),
        `${JSON.stringify({ type: "session", version: 3, id: "fake-seeded", timestamp: "2026-09-19T00:00:00.000Z", cwd: fake.cwd })}\n`,
      );
      const opened = await adapter.open({
        kind: "resume",
        nativeRef: nativeSessionRefSchema.parse({
          harnessId: "command-code",
          nativeSessionId: "fake-seeded",
          formatVersion: 1,
        }),
        cwd: fake.cwd,
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const outputs = opened.value.outputs[Symbol.asyncIterator]();
      const { events } = await runTurn(opened.value, outputs, "mismatch", "hi");
      expect(terminal(events)).toMatchObject({
        outcome: { status: "failed", error: { code: "sessionNotFound" } },
      });
    } finally {
      await adapter.close();
    }
  });
});
