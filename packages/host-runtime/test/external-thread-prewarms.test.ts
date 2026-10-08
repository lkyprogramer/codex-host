import type { HarnessWorkLevel } from "@codexhost/harness-adapter";
import { describe, expect, it, vi } from "vitest";

import { ExternalThreadPrewarms } from "../src/external-thread-prewarms.js";
import type { ExternalThread } from "../src/external-thread-runtime.js";

function prewarm(
  id: string,
  overrides: {
    close?: () => Promise<void>;
    workLevel?: HarnessWorkLevel;
    running?: boolean;
    turns?: number;
  } = {},
) {
  const close = vi.fn(overrides.close ?? (async () => undefined));
  const fault = vi.fn();
  const thread = {
    id,
    running: overrides.running ?? false,
    activeTurnId: null,
    turns: Array.from({ length: overrides.turns ?? 0 }, () => ({})),
    record: { turnMappings: [] },
    outputTask: Promise.resolve(),
    persistenceError: null as Error | null,
    stateObserver: { fault },
    session: {
      close,
      resourceLifecycle: {
        suspend: async () => ({ status: "unsupported" }),
        workLevel: () => overrides.workLevel ?? { level: "idle" },
      },
    },
  } as unknown as ExternalThread;
  return { thread, close, fault };
}

function host(...threads: ExternalThread[]) {
  const live = new Map<string, ExternalThread>(threads.map((thread) => [thread.id, thread]));
  const removed: string[] = [];
  return {
    get: (id: string) => live.get(id),
    remove: async (thread: ExternalThread) => {
      removed.push(thread.id);
      live.delete(thread.id);
    },
    removed,
  };
}

const turnStart = (threadId: string) => ({
  id: 1,
  method: "turn/start",
  params: { threadId, input: [] },
});

describe("External Thread prewarms", () => {
  it("closes and removes an unadopted, idle prewarm once", async () => {
    const prewarms = new ExternalThreadPrewarms();
    const { thread, close } = prewarm("draft");
    const options = host(thread);
    prewarms.register(thread);

    await expect(prewarms.discard("draft", options)).resolves.toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(options.removed).toEqual(["draft"]);
    await expect(prewarms.discard("draft", options)).resolves.toBe(false);
  });

  it("leaves a prewarm that user work adopted or native work occupies", async () => {
    const prewarms = new ExternalThreadPrewarms();
    const adopted = prewarm("adopted");
    const busy = prewarm("busy", { workLevel: { level: "busy", reason: "background task" } });
    const running = prewarm("running", { running: true });
    const historical = prewarm("historical", { turns: 1 });
    const options = host(adopted.thread, busy.thread, running.thread, historical.thread);
    for (const { thread } of [adopted, busy, running, historical]) prewarms.register(thread);

    expect(prewarms.observe(turnStart("adopted"))).toBeNull();
    // Reading the Thread does not adopt it.
    expect(prewarms.observe({ id: 2, method: "thread/read", params: { threadId: "busy" } })).toBe(
      null,
    );
    for (const id of ["adopted", "busy", "running", "historical"]) {
      await expect(prewarms.discard(id, options)).resolves.toBe(false);
    }
    for (const { close } of [adopted, busy, running, historical]) {
      expect(close).not.toHaveBeenCalled();
    }
    expect(options.removed).toEqual([]);
  });

  it("refuses user work in a prewarm whose close was not confirmed", async () => {
    const prewarms = new ExternalThreadPrewarms();
    const { thread, fault } = prewarm("draft", {
      close: async () => {
        throw new Error("process group is still alive");
      },
    });
    const options = host(thread);
    prewarms.register(thread);

    await expect(prewarms.discard("draft", options)).rejects.toThrow("still alive");
    expect(options.removed).toEqual([]);
    expect(fault).toHaveBeenCalledOnce();
    // Another native writer must not start while the first may still run.
    const refusal = prewarms.observe(turnStart("draft"));
    expect(refusal?.message).toBe("External prewarm close was not confirmed");
    expect((refusal?.cause as Error).message).toBe("process group is still alive");
  });

  it("refuses adoption while a discard is closing the prewarm", async () => {
    const prewarms = new ExternalThreadPrewarms();
    let finishClose!: () => void;
    const { thread } = prewarm("draft", {
      close: () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    });
    const options = host(thread);
    prewarms.register(thread);

    const discarding = prewarms.discard("draft", options);
    // A native command does not share the Thread's request queue with the discard.
    const command = {
      id: 3,
      method: "codexhost/thread/command/execute",
      params: { threadId: "draft", commandId: "compact" },
    };
    expect(prewarms.observe(command)?.message).toBe("External prewarm is being released");
    finishClose();
    await expect(discarding).resolves.toBe(true);
    expect(prewarms.observe(command)).toBeNull();
  });

  it("forgets a prewarm the Host replaced or removed", async () => {
    const prewarms = new ExternalThreadPrewarms();
    const { thread, close } = prewarm("draft");
    prewarms.register(thread);

    await expect(prewarms.discard("draft", host())).resolves.toBe(false);
    expect(close).not.toHaveBeenCalled();
    prewarms.register(thread);
    prewarms.clear();
    await expect(prewarms.discard("draft", host(thread))).resolves.toBe(false);
  });
});
