import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, realpath, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CursorAdapter } from "/Users/luo/Documents/github/codex-host-merge-anchor/packages/adapters/cursor-cli/dist/index.js";
import { cursorSessionDirectory } from "/Users/luo/Documents/github/codex-host-merge-anchor/packages/adapters/cursor-cli/dist/native-history.js";
const root = "/tmp/codexhost-merge-anchor-20260930/cursor";
const reuse = process.argv.includes("--reuse-source")
  ? JSON.parse(await readFile(path.join(root, "receipt.json"), "utf8"))
  : null;
await mkdir(path.join(root, "workspace"), { recursive: true });
const cwd = await realpath(path.join(root, "workspace"));
const environment = {
  ...process.env,
  CODEXHOST_PROCESS_LEDGER_DIR: "/tmp/codexhost-merge-anchor-20260930/ledger",
  CODEXHOST_PROCESS_ANCHOR_PATH: process.env.CODEXHOST_PROCESS_ANCHOR_PATH,
};
const adapter = new CursorAdapter({
  environment,
  command: "/Users/luo/.local/bin/agent",
  timeoutMs: 30_000,
});
const readers = new Map();
const completions = new Map();
const ownedSessions = [];
const capture = (session) => {
  const task = (async () => {
    for await (const output of session.outputs) {
      if (output.kind === "event" && output.event.type === "turn.completed")
        completions.get(output.event.turnId)?.resolve(output.event);
      if (output.kind === "interaction")
        throw new Error("No-tool smoke unexpectedly requested interaction");
    }
  })();
  readers.set(session, task);
  ownedSessions.push(session);
  return session;
};
const close = async (session) => {
  await session.close();
  await readers.get(session);
};
const run = async (session, text) => {
  const turnId = randomUUID();
  const terminal = Promise.withResolvers();
  completions.set(turnId, terminal);
  const accepted = await session.execute({
    type: "turn.start",
    turnId,
    input: [{ type: "text", text }],
  });
  assert(accepted.ok, accepted.ok ? "" : accepted.error.message);
  let timer;
  try {
    const event = await Promise.race([
      terminal.promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Turn deadline exceeded")), 60_000);
      }),
    ]);
    assert.equal(event.outcome.status, "succeeded");
    assert(event.nativeTurnRef);
    return event;
  } finally {
    clearTimeout(timer);
    completions.delete(turnId);
  }
};
const snapshot = async (session) => {
  const result = await session.readSnapshot();
  assert(result.ok, result.ok ? "" : result.error.message);
  return result.value;
};
const hashSource = async (ref) => {
  const directory = cursorSessionDirectory(ref.nativeSessionId, environment);
  const result = {};
  for (const name of ["store.db", "meta.json"])
    result[name] = createHash("sha256")
      .update(await readFile(path.join(directory, name)))
      .digest("hex");
  return result;
};
try {
  const inspection = await adapter.inspect({ cwd });
  assert.equal(inspection.status, "ready");
  assert(inspection.capabilities.history.fork);
  assert(inspection.capabilities.history.rollbackLastTurn);
  const selected =
    inspection.catalog.models.find((model) => model.label === "composer-2.5") ??
    inspection.catalog.models[0];
  assert(selected);
  const opened = await adapter.open(
    reuse
      ? { kind: "resume", cwd, nativeRef: reuse.sourceRef, historyOnly: true, environment }
      : { kind: "create", cwd, model: selected.ref, environment },
  );
  assert(opened.ok, opened.ok ? "" : opened.error.message);
  const source = capture(opened.value);
  if (!reuse) {
    await run(source, "Reply with exactly MERGE_ANCHOR_FIRST and use no tools.");
    await run(source, "Reply with exactly MERGE_ANCHOR_SECOND and use no tools.");
  }
  const sourceSnapshot = await snapshot(source);
  assert.equal(sourceSnapshot.turns.length, 2);
  const sourceRef = source.initialState.nativeRef;
  assert(sourceRef);
  const checkpoint = sourceSnapshot.turns[0].checkpoint;
  assert(checkpoint, "Native earlier Turn has no verified checkpoint");
  await close(source);
  const before = await hashSource(sourceRef);
  const forked = await adapter.open({
    kind: "fork",
    cwd,
    sourceRef,
    checkpoint,
    model: selected.ref,
    environment,
  });
  assert(forked.ok, forked.ok ? "" : forked.error.message);
  const fork = capture(forked.value);
  assert.notEqual(fork.initialState.nativeRef.nativeSessionId, sourceRef.nativeSessionId);
  const forkSnapshot = await snapshot(fork);
  assert.equal(forkSnapshot.turns.length, 1);
  assert.deepEqual(
    forkSnapshot.turns.map((turn) => turn.input),
    sourceSnapshot.turns.slice(0, 1).map((turn) => turn.input),
  );
  await run(fork, "Reply with exactly MERGE_ANCHOR_FORK_OK and use no tools.");
  const continued = await snapshot(fork);
  assert.equal(continued.turns.length, 2);
  const reply = continued.turns
    .at(-1)
    .items.filter((entry) => entry.item.type === "agentMessage")
    .map((entry) => entry.item.text)
    .join("");
  assert.equal(reply.trim(), "MERGE_ANCHOR_FORK_OK");
  await close(fork);
  const revised = await adapter.open({
    kind: "rollbackLastTurn",
    cwd,
    sourceRef,
    model: selected.ref,
    environment,
  });
  assert(revised.ok, revised.ok ? "" : revised.error.message);
  const revise = capture(revised.value);
  assert.notEqual(revise.initialState.nativeRef.nativeSessionId, sourceRef.nativeSessionId);
  const revisedSnapshot = await snapshot(revise);
  assert.equal(revisedSnapshot.turns.length, 1);
  assert.deepEqual(
    revisedSnapshot.turns.map((turn) => turn.input),
    sourceSnapshot.turns.slice(0, 1).map((turn) => turn.input),
  );
  await close(revise);
  assert.deepEqual(await hashSource(sourceRef), before, "Source files changed during derivation");
  const receipt = {
    passed: true,
    version: "2026.09.10-fd3934a",
    model: selected.ref,
    sourceRef,
    forkRef: fork.initialState.nativeRef,
    reviseRef: revise.initialState.nativeRef,
    sourceTurns: 2,
    forkRetainedTurns: 1,
    reviseRetainedTurns: 1,
    followupReply: reply.trim(),
    providerTurns: reuse ? 1 : 3,
    anchorPath: process.env.CODEXHOST_PROCESS_ANCHOR_PATH,
    sourceReused: Boolean(reuse),
    sourceFilesBefore: before,
    sourceFilesUnchanged: true,
  };
  await writeFile(path.join(root, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(
    JSON.stringify({
      passed: true,
      sourceTurns: 2,
      forkRetainedTurns: 1,
      reviseRetainedTurns: 1,
      followupReply: reply.trim(),
      providerTurns: reuse ? 1 : 3,
      sourceReused: Boolean(reuse),
      anchorPath: process.env.CODEXHOST_PROCESS_ANCHOR_PATH,
      sourceFilesUnchanged: true,
    }),
  );
} finally {
  await adapter.close();
  for (const task of readers.values()) await task.catch(() => undefined);
}
