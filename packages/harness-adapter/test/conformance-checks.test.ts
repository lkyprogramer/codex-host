import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  closedSessionRefusesWork,
  suspendAborted,
  suspendIdle,
  suspendWhileBusy,
} from "../src/conformance-lifecycle.js";
import { OutputCollector } from "../src/conformance-output.js";
import type { HarnessIdleSuspendResult, HarnessOutput, HarnessSession } from "../src/index.js";

const turnId = hostTurnIdSchema.parse("turn-1");

function event(value: Record<string, unknown>): HarnessOutput {
  return { kind: "event", event: value } as unknown as HarnessOutput;
}

const started = event({ type: "turn.started", turnId });
const item = event({
  type: "item.started",
  turnId,
  item: { id: "item-1", type: "agentMessage", text: "" },
});
const completed = event({ type: "turn.completed", turnId, outcome: { status: "succeeded" } });

function sessionWith(outputs: HarnessOutput[]): HarnessSession {
  return {
    outputs: (async function* () {
      yield* outputs;
    })(),
  } as unknown as HarnessSession;
}

async function terminalOf(outputs: HarnessOutput[]): Promise<unknown> {
  const collector = new OutputCollector(sessionWith(outputs));
  return collector.terminal(turnId, 500);
}

describe("Turn grammar", () => {
  it("accepts a Turn that starts, carries items, and completes once", async () => {
    await expect(terminalOf([started, item, completed])).resolves.toMatchObject({
      outcome: { status: "succeeded" },
    });
  });

  it("accepts an interaction closed after its Turn completed", async () => {
    const closed = event({
      type: "interaction.closed",
      turnId,
      interactionId: "i-1",
      reason: "cancelled",
    });
    await expect(terminalOf([started, completed, closed])).resolves.toBeDefined();
  });

  it.each([
    [
      "an interaction closed before its Turn started",
      [
        event({ type: "interaction.closed", turnId, interactionId: "i-1", reason: "cancelled" }),
        started,
        completed,
      ],
      "interaction closed outside its Turn",
    ],
    ["an item before its Turn started", [item, started, completed], "item outside its Turn"],
    ["an item after its Turn completed", [started, completed, item], "item outside its Turn"],
    ["a terminal without a start", [completed], "terminal event before its Turn started"],
    ["a second start", [started, started, completed], "Turn started twice"],
  ])("rejects %s", async (_name, outputs, message) => {
    await expect(terminalOf(outputs)).rejects.toThrow(message);
  });
});

function withLifecycle(result: HarnessIdleSuspendResult, closed = false): HarnessSession {
  return {
    resourceLifecycle: { suspend: async () => result },
    close: async () => undefined,
    execute: async () =>
      closed
        ? { ok: false, error: { code: "invalidState", message: "closed", retryable: false } }
        : { ok: true, value: { turnId } },
  } as unknown as HarnessSession;
}

const bounded = <T>(_operation: string, execute: () => Promise<T>) => execute();

describe("resource lifecycle scenarios", () => {
  it("fails an aborted suspension that released resources", async () => {
    await expect(
      suspendAborted(withLifecycle({ status: "suspended", scope: "x" }), bounded),
    ).rejects.toThrow("aborted idle suspension released resources");
    await expect(suspendAborted(withLifecycle({ status: "unknown" }), bounded)).resolves.toEqual({
      status: "passed",
    });
  });

  it("fails a suspension that released an active Turn", async () => {
    await expect(
      suspendWhileBusy(withLifecycle({ status: "suspended", scope: "x" }), bounded),
    ).rejects.toThrow("during an active Turn returned suspended");
    await expect(suspendWhileBusy(withLifecycle({ status: "busy" }), bounded)).resolves.toEqual({
      status: "passed",
    });
  });

  it("fails an idle release that could not be confirmed", async () => {
    const collector = new OutputCollector(sessionWith([]));
    await expect(
      suspendIdle(
        withLifecycle({ status: "releaseFailed", reason: "group remains" }),
        collector,
        bounded,
        500,
      ),
    ).rejects.toThrow("idle release failed: group remains");
  });

  it("fails a closed Session that accepts a Turn", async () => {
    await expect(
      closedSessionRefusesWork(withLifecycle({ status: "unsupported" }), bounded),
    ).rejects.toThrow("a closed Session accepted a new Turn");
    await expect(
      closedSessionRefusesWork(withLifecycle({ status: "unsupported" }, true), bounded),
    ).resolves.toEqual({ status: "passed" });
  });
});
