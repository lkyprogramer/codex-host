import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { HarnessOutput, HostEvent } from "@codexhost/harness-adapter";
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
 * Emulates print mode: `--list-models` prints the table; `-p` reads the prompt
 * from stdin, persists a v3 transcript under the fake HOME the way the CLI
 * does, streams AgentEvent frames chosen by keywords in the prompt and ends
 * with the `result` line.
 */
const PRINT_MODE_SCRIPT = String.raw`
process.on("SIGTERM", () => process.exit(130));
if (args.includes("--list-models")) {
  if (process.env.CODEXHOST_FAKE_AUTH_FAIL) {
    process.stderr.write("Error: not logged in\n");
    process.exit(3);
  }
  process.stdout.write("Available models  ·  2 models\n\nOpen Source\n\n");
  process.stdout.write("deepseek/deepseek-v4-flash             fast reasoning (default)\n");
  process.stdout.write("claude-sonnet-5                        best combo\n");
  process.exit(0);
}
if (!args.includes("-p") || flag("--output-format") !== "json") {
  process.stderr.write("fixture expects print mode with json output\n");
  process.exit(1);
}
(async () => {
  const prompt = (await readPrompt()).trim();
  const cwd = process.cwd();
  const sessionPath = flag("--session");
  const sessionId = sessionPath
    ? path.basename(sessionPath, ".jsonl")
    : flag("--resume") ?? "fake-" + Math.random().toString(36).slice(2, 10);
  if (prompt.includes("fail-auth")) {
    process.stderr.write("Error: not authenticated\n");
    process.exit(3);
  }
  const file = writeSession(sessionId, cwd, [
    { type: "message", id: "p-" + Date.now().toString(36), parentId: lastMessageIdOrNull(sessionId), timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: prompt }], meta: { source: "user" } } },
  ]);
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
  if (prompt.includes("read")) {
    emit({ type: "tool_queued", toolCallId: "c-read", toolName: "read_file", input: { file_path: path.join(cwd, "README.md") } });
    emit({ type: "tool_running", toolCallId: "c-read", toolName: "read_file", description: "Read README.md" });
    emit({ type: "tool_completed", toolCallId: "c-read", toolName: "read_file", result: [{ type: "text", text: "hello probe file" }] });
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
    emit({ type: "tool_hook_blocked", toolCallId: "c-blocked", toolName: "write_file", hookOutput: { block: true } });
  }
  if (prompt.includes("subagent")) {
    emit({ type: "subagent_start", toolCallId: "c-agent", subagentType: "explore", description: "Find callers", background: false });
    emit({ type: "subagent_progress", toolCallId: "c-agent", subagentType: "explore", toolName: "grep", tokensUsed: 10 });
    emit({ type: "subagent_stop", toolCallId: "c-agent", subagentType: "explore", tokensUsed: 42 });
  }
  emit({ type: "text_delta", delta: "Hel" });
  emit({ type: "text_delta", delta: "lo" });
  emit({ type: "turn_end", turnNumber: 1, hadToolCalls: true, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  writeSession(sessionId, cwd, [
    { type: "message", id: "a-" + Date.now().toString(36), parentId: lastMessageId(file), timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } },
  ]);
  if (prompt.includes("error")) {
    emit({ type: "run_error", error: { name: "TransportError", message: "boom" } });
    result({ subtype: "error", sessionId, usage: { inputTokens: 10, outputTokens: 5 }, durationMs: 5, finalText: "", error: "Error: boom" });
    process.exit(1);
  }
  emit({ type: "run_end", result: { finalText: "Hello", stopReason: "end_turn", turnCount: 1, usage: { inputTokens: 12, outputTokens: 6, cacheReadTokens: 1, cacheWriteTokens: 0 } } });
  result({ subtype: "success", sessionId, stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 6, cacheReadTokens: 1, cacheWriteTokens: 0 }, durationMs: 7, finalText: "Hello" });
  process.exit(0);
})();
function lastMessageIdOrNull(sessionId) {
  const file = path.join(projectDir, sessionId + ".jsonl");
  return fs.existsSync(file) ? lastMessageId(file) : null;
}
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

async function calls(fixture: FakeCommandCode): Promise<string[][]> {
  return (await readFile(fixture.callLog, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
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

  it("inspects the Model catalog once and types an unauthenticated listing", async () => {
    const fake = await fixture();
    const adapter = new CommandCodeAdapter({
      command: fake.command,
      environment: fake.environment,
    });
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
    const failing = new CommandCodeAdapter({
      command: fake.command,
      environment: { ...fake.environment, CODEXHOST_FAKE_AUTH_FAIL: "1" },
    });
    try {
      expect(await failing.inspect()).toMatchObject({
        status: "error",
        error: { code: "authenticationRequired", stage: "model-catalog" },
      });
    } finally {
      await failing.close();
    }
  });

  it("runs a Turn per print process, projects the stream and keys the Turn by the stored prompt", async () => {
    const fake = await fixture();
    await writeFile(path.join(fake.cwd, "target.txt"), "alpha\n");
    const adapter = new CommandCodeAdapter({
      command: fake.command,
      environment: fake.environment,
    });
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd: fake.cwd,
        model: encodeCommandCodeModelRef("claude-sonnet-5"),
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
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
          input: [{ type: "text", text: "think, read, shell, edit and subagent please" }],
        }),
      ).toEqual({ ok: true, value: { turnId } });
      expect(
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("turn-2"),
          input: [{ type: "text", text: "second" }],
        }),
      ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });

      const { events, interactions } = await collectTurn(outputs, turnId);
      expect(interactions).toBe(0);
      const completed = events.filter(
        (event): event is Extract<HostEvent, { type: "item.completed" }> =>
          event.type === "item.completed",
      );
      expect(completed.map(({ snapshot }) => snapshot.item.type)).toEqual([
        "reasoning",
        "toolExecution",
        "commandExecution",
        "fileChange",
        "subagentDelegation",
        "agentMessage",
      ]);
      expect(completed[0]?.snapshot.item).toMatchObject({ text: "planning" });
      expect(completed[1]?.snapshot.item).toMatchObject({
        toolName: "read_file",
        output: { content: [{ type: "text", text: "hello probe file" }] },
      });
      expect(completed[2]?.snapshot.item).toMatchObject({ command: "echo hi", output: "hi\n" });
      const fileChange = completed[3]?.snapshot.item;
      expect(fileChange?.type === "fileChange" && fileChange.changes[0]).toMatchObject({
        path: "target.txt",
        kind: "update",
      });
      expect(fileChange?.type === "fileChange" ? fileChange.changes[0]?.unifiedDiff : "").toMatch(
        /-alpha\n\+beta/u,
      );
      expect(completed[4]?.snapshot.item).toMatchObject({
        subagents: [{ nativeSubagentId: "c-agent", status: "completed" }],
      });
      expect(completed[5]?.snapshot.item).toMatchObject({ text: "Hello" });
      expect(events.filter((event) => event.type === "subagent.state.changed")).toHaveLength(2);

      const stateChange = events.find(
        (event): event is Extract<HostEvent, { type: "session.state.changed" }> =>
          event.type === "session.state.changed",
      );
      expect(stateChange?.state.nativeRef?.nativeSessionId).toMatch(/^fake-/u);
      const terminal = events.at(-1);
      expect(terminal).toMatchObject({
        type: "turn.completed",
        outcome: { status: "succeeded" },
        nativeTurnRef: { nativeTurnKey: expect.stringMatching(/^p-/u) },
      });
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
          "--effort",
          "high",
          "--dangerously-skip-permissions",
        ]),
      );
      expect(printCall).not.toContain("--session");

      // The follow-up Turn continues the persisted transcript by path.
      const followUp = hostTurnIdSchema.parse("turn-2");
      expect(
        await session.execute({
          type: "turn.start",
          turnId: followUp,
          input: [{ type: "text", text: "again" }],
        }),
      ).toMatchObject({ ok: true });
      const second = await collectTurn(outputs, followUp);
      expect(second.events.at(-1)).toMatchObject({ outcome: { status: "succeeded" } });
      const [, secondCall] = (await calls(fake)).filter((args) => args.includes("-p"));
      expect(secondCall).toEqual(expect.arrayContaining(["--session"]));
      expect(secondCall?.[secondCall.indexOf("--session") + 1]).toMatch(/fake-[a-z0-9]+\.jsonl$/u);
      expect(secondCall).not.toContain("--fork-session");
      await session.close();
      expect((await outputs.next()).done).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("cancels by stopping the print process and reports a cancelled terminal", async () => {
    const fake = await fixture();
    const adapter = new CommandCodeAdapter({
      command: fake.command,
      environment: fake.environment,
    });
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
      // Wait for the native identity before cancelling, as the Host does.
      for (;;) {
        const next = await outputs.next();
        if (next.done) throw new Error("ended early");
        if (next.value.kind === "event" && next.value.event.type === "session.state.changed") break;
      }
      expect(session.resourceLifecycle?.suspend({ aborted: false })).resolves.toMatchObject({
        status: "busy",
      });
      expect(await session.execute({ type: "turn.cancel", turnId })).toEqual({
        ok: true,
        value: { cancellationRequested: true },
      });
      const { events } = await collectTurn(outputs, turnId);
      expect(events.at(-1)).toMatchObject({
        type: "turn.completed",
        outcome: { status: "cancelled" },
      });
      expect(await session.execute({ type: "turn.cancel", turnId })).toMatchObject({
        ok: false,
        error: { code: "invalidState" },
      });
      await expect(session.resourceLifecycle?.suspend({ aborted: false })).resolves.toMatchObject({
        status: "suspended",
      });
      expect((await outputs.next()).done).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("types an authentication exit without a result line and a structured result error", async () => {
    const fake = await fixture();
    const adapter = new CommandCodeAdapter({
      command: fake.command,
      environment: fake.environment,
    });
    try {
      const opened = await adapter.open({ kind: "create", cwd: fake.cwd });
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      const outputs = session.outputs[Symbol.asyncIterator]();
      const auth = hostTurnIdSchema.parse("auth");
      await session.execute({
        type: "turn.start",
        turnId: auth,
        input: [{ type: "text", text: "fail-auth" }],
      });
      expect((await collectTurn(outputs, auth)).events.at(-1)).toMatchObject({
        outcome: { status: "failed", error: { code: "authenticationRequired" } },
      });
      const failing = hostTurnIdSchema.parse("error");
      await session.execute({
        type: "turn.start",
        turnId: failing,
        input: [{ type: "text", text: "error" }],
      });
      const { events } = await collectTurn(outputs, failing);
      expect(events.at(-1)).toMatchObject({
        outcome: {
          status: "failed",
          error: { code: "nativeFailure", message: "Command Code Turn failed: Error: boom" },
        },
        nativeTurnRef: { nativeTurnKey: expect.stringMatching(/^p-/u) },
      });
      // Streamed text before the failure is still delivered as a failed Item.
      expect(
        events.find(
          (event) => event.type === "item.completed" && event.snapshot.item.type === "agentMessage",
        ),
      ).toMatchObject({ snapshot: { outcome: { status: "failed" } } });
    } finally {
      await adapter.close();
    }
  });

  it("surfaces a native permission block as a failed Tool Item under the read-only mode", async () => {
    const fake = await fixture();
    const adapter = new CommandCodeAdapter({
      command: fake.command,
      environment: fake.environment,
    });
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd: fake.cwd,
        permissionModeId: harnessPermissionModeIdSchema.parse("read-only"),
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      const outputs = session.outputs[Symbol.asyncIterator]();
      const turnId = hostTurnIdSchema.parse("blocked");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "blocked" }],
      });
      const { events } = await collectTurn(outputs, turnId);
      const blocked = events.find(
        (event) => event.type === "item.completed" && event.snapshot.item.type === "toolExecution",
      );
      expect(blocked).toMatchObject({
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

  it("resumes from the transcript, replays history and rejects a foreign or relocated Session", async () => {
    const fake = await fixture();
    const adapter = new CommandCodeAdapter({
      command: fake.command,
      environment: fake.environment,
    });
    let nativeSessionId = "";
    try {
      const opened = await adapter.open({ kind: "create", cwd: fake.cwd });
      if (!opened.ok) throw new Error(opened.error.message);
      const outputs = opened.value.outputs[Symbol.asyncIterator]();
      const turnId = hostTurnIdSchema.parse("first");
      await opened.value.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "read" }],
      });
      await collectTurn(outputs, turnId);
      const snapshot = await opened.value.readSnapshot();
      nativeSessionId = snapshot.ok ? (snapshot.value.state?.nativeRef?.nativeSessionId ?? "") : "";
      expect(nativeSessionId).toMatch(/^fake-/u);
    } finally {
      await adapter.close();
    }

    const fresh = new CommandCodeAdapter({ command: fake.command, environment: fake.environment });
    try {
      const nativeRef = nativeSessionRefSchema.parse({
        harnessId: "command-code",
        nativeSessionId,
        formatVersion: 1,
      });
      const resumed = await fresh.open({
        kind: "resume",
        nativeRef,
        cwd: fake.cwd,
        historyOnly: true,
      });
      if (!resumed.ok) throw new Error(resumed.error.message);
      const replay = await resumed.value.readSnapshot();
      expect(replay.ok && replay.value.turns.map((turn) => turn.input[0]?.text)).toEqual(["read"]);
      expect(replay.ok && replay.value.turns[0]?.items.map(({ item }) => item.type)).toEqual([
        "agentMessage",
      ]);
      expect(resumed.value.initialState.nativeRef).toEqual(nativeRef);
      // History-only opens never spawn the CLI.
      expect((await calls(fake)).filter((args) => args.includes("--list-models"))).toHaveLength(1);
      await resumed.value.close();

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
    const adapter = new CommandCodeAdapter({
      command: fake.command,
      environment: fake.environment,
    });
    try {
      // Seed a transcript for the Session we claim to resume.
      const projects = path.join(fake.home, ".commandcode", "projects", "seeded");
      await import("node:fs/promises").then(({ mkdir }) => mkdir(projects, { recursive: true }));
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
      const turnId = hostTurnIdSchema.parse("mismatch");
      await opened.value.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "hi" }],
      });
      expect((await collectTurn(outputs, turnId)).events.at(-1)).toMatchObject({
        outcome: { status: "failed", error: { code: "sessionNotFound" } },
      });
    } finally {
      await adapter.close();
    }
  });
});
