import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HostThreadSnapshot } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import {
  harnessIdSchema,
  harnessThinkingOptionIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { expect, it, vi } from "vitest";

import { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { ExternalThreadRuntime } from "../src/external-thread-runtime.js";

it.each(["refresh", "resume"] as const)(
  "re-reads native history after a %s Snapshot loses its CAS",
  async (operation) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-snapshot-race-"));
    const store = new MappingStore({ directory });
    const repository = new ExternalThreadRepository(store);
    await repository.initialize();
    const harnessId = harnessIdSchema.parse("pi");
    const id = hostThreadIdSchema.parse("race-thread");
    const nativeRef = nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: "race-native",
      formatVersion: 1,
    });
    const adapter = new FakeHarnessAdapter(harnessId);
    const session = new FakeHarnessSession(harnessId, undefined, undefined, nativeRef);
    await store.createProvisional({
      hostThreadId: id,
      createRequestId: "race",
      harnessId,
      cwd: "/synthetic",
      title: "Race",
      transportModelId: "codexhost/pi-native",
      ephemeral: false,
      historyMode: "legacy",
    });
    const initial = await store.commitReady({
      hostThreadId: id,
      nativeSessionRef: nativeRef,
      turnMappings: [],
    });
    const turn = (key: string): HostThreadSnapshot["turns"][number] => ({
      nativeTurnRef: {
        harnessId,
        nativeSessionId: nativeRef.nativeSessionId,
        nativeTurnKey: key,
        formatVersion: 1,
      },
      input: [{ type: "text", text: key }],
      items: [],
      outcome: { status: "succeeded" },
    });
    const hostA = hostTurnIdSchema.parse("host-a");
    const hostB = hostTurnIdSchema.parse("host-b");
    const beforeRead = await repository.persistTurn(initial, hostA, turn("a").nativeTurnRef);
    const read = vi
      .spyOn(session, "readSnapshot")
      .mockImplementationOnce(async () => {
        const stale = { turns: [turn("a")] };
        await repository.persistTurn(beforeRead, hostB, turn("b").nativeTurnRef);
        return { ok: true, value: stale };
      })
      .mockImplementation(async () => ({
        ok: true,
        value: {
          turns: [turn("a"), turn("b")],
          state: {
            ...session.initialState,
            effectiveThinkingOptionId: harnessThinkingOptionIdSchema.parse("medium"),
          },
        },
      }));
    vi.spyOn(adapter, "open").mockResolvedValue({ ok: true, value: session });
    const runtime = new ExternalThreadRuntime({
      adapters: new Map([["pi", adapter]]),
      repository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });
    try {
      const thread =
        operation === "refresh"
          ? runtime.register({
              record: beforeRead,
              session,
              sessionId: id,
              thread: { id },
              turns: [],
            })
          : null;
      if (thread) {
        expect(await runtime.refresh(thread)).toBeNull();
        expect(thread.turns.map((turn) => turn.id)).toEqual([hostA, hostB]);
      } else {
        const restored = await runtime.resolve(id);
        expect(restored.kind).toBe("external");
        if (restored.kind !== "external") throw new Error("Thread did not restore");
        expect(restored.thread.turns.map((turn) => turn.id)).toEqual([hostA, hostB]);
        expect(restored.thread.stateObserver.state.effectiveThinkingOptionId).toBe("medium");
      }
      expect(read).toHaveBeenCalledTimes(2);
      expect(
        (await repository.find(id))?.turnMappings.map((mapping) => mapping.hostTurnId),
      ).toEqual([hostA, hostB]);
    } finally {
      runtime.clear();
      await session.close();
      await adapter.close();
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
