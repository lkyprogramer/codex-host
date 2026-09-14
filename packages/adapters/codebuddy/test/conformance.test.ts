import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type {
  HarnessAdapter,
  HarnessOutput,
  HarnessSession,
  HostCommand,
} from "@codexhost/harness-adapter";
import { hostTurnIdSchema, type NativeTurnRef } from "@codexhost/shared-contracts";
import { CodeBuddyAdapter } from "../src/codebuddy-adapter.js";
import { fixture } from "./fixtures.js";
import {
  HarnessConformanceFailure,
  runAdapterConformance,
  serializeConformanceReceipt,
  type AdapterConformancePlan,
} from "@codexhost/harness-adapter/conformance";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function hideCreateNativeRef(adapter: HarnessAdapter): HarnessAdapter {
  return {
    harnessId: adapter.harnessId,
    inspect: (input) => adapter.inspect(input),
    close: () => adapter.close(),
    open: async (input) => {
      const opened = await adapter.open(input);
      if (!opened.ok || input.kind !== "create") return opened;
      const session = opened.value;
      return {
        ok: true,
        value: new Proxy(session, {
          get(target, key) {
            if (key === "initialState") {
              const state = { ...target.initialState };
              delete state.nativeRef;
              return state;
            }
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as HarnessSession,
      };
    },
  };
}

function mapSessionOutputs(
  session: HarnessSession,
  transform: (output: HarnessOutput) => HarnessOutput,
): HarnessSession {
  const outputs = {
    async *[Symbol.asyncIterator]() {
      for await (const output of session.outputs) yield transform(output);
    },
  };
  return new Proxy(session, {
    get(target, key) {
      if (key === "outputs") return outputs;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as HarnessSession;
}

function mapAdapterSessionOutputs(
  adapter: HarnessAdapter,
  transform: (input: Parameters<HarnessAdapter["open"]>[0], output: HarnessOutput) => HarnessOutput,
): HarnessAdapter {
  return {
    harnessId: adapter.harnessId,
    inspect: (input) => adapter.inspect(input),
    close: () => adapter.close(),
    open: async (input) => {
      const opened = await adapter.open(input);
      if (!opened.ok) return opened;
      return {
        ok: true,
        value: mapSessionOutputs(opened.value, (output) => transform(input, output)),
      };
    },
  };
}

function terminalWithWrongIdentity(output: HarnessOutput, turnId: string): HarnessOutput {
  if (
    output.kind !== "event" ||
    output.event.type !== "turn.completed" ||
    output.event.turnId !== turnId ||
    !output.event.nativeTurnRef
  )
    return output;
  return {
    kind: "event",
    event: {
      ...output.event,
      nativeTurnRef: {
        ...output.event.nativeTurnRef,
        harnessId: "wrong-harness",
      } as NativeTurnRef,
    },
  };
}

function settleWithin(promise: Promise<unknown>, timeoutMs: number) {
  return new Promise<
    { kind: "fulfilled" } | { kind: "rejected"; error: unknown } | { kind: "timedOut" }
  >((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "timedOut" }), timeoutMs);
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve({ kind: "fulfilled" });
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve({ kind: "rejected", error });
      },
    );
  });
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(timeoutMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
}

async function expectNoUnhandledRejection(execute: () => Promise<void>) {
  const rejections: unknown[] = [];
  const capture = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", capture);
  try {
    await execute();
    await delay(20);
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", capture);
  }
}

function plan(
  createAdapter: AdapterConformancePlan["createAdapter"],
  native = fixture(),
): AdapterConformancePlan {
  return {
    createAdapter,
    cwd: process.cwd(),
    evidence: {
      hostSha: null,
      pluginBundleSha256: null,
      nativeVersion: null,
      platform: process.platform,
      mode: "native-transport-fixture",
    },
    environment: {
      primary: { CODEXHOST_CONFORMANCE_SCOPE: "primary" },
      isolated: { CODEXHOST_CONFORMANCE_SCOPE: "isolated" },
      resume: { CODEXHOST_CONFORMANCE_SCOPE: "resume" },
    },
    prompts: {
      first: "conformance first turn",
      cancellable: "hold",
      followup: "conformance followup",
    },
    probes: {
      assertEnvironmentIsolation: async () => {
        const opened = native.clients.filter((client) => !client.context.ephemeral);
        expect(opened).toHaveLength(2);
        expect(
          opened.map((client) => client.context.environment.CODEXHOST_CONFORMANCE_SCOPE),
        ).toEqual(["primary", "isolated"]);
      },
      readCleanup: async () => ({
        residue: native.clients.every((client) => client.closed) ? "none" : "present",
      }),
    },
  };
}

describe("actual Adapter conformance receipt", () => {
  it("drives CodeBuddy through its controllable native transport fixture and writes a redacted receipt", async () => {
    const native = fixture();
    const createAdapter = () =>
      new CodeBuddyAdapter({
        ...native,
        environment: { BASE_ENVIRONMENT: "inherited" },
      });
    const receipt = await runAdapterConformance({
      createAdapter,
      cwd: process.cwd(),
      evidence: {
        hostSha: null,
        pluginBundleSha256: null,
        nativeVersion: null,
        platform: process.platform,
        mode: "native-transport-fixture",
      },
      environment: {
        primary: { CODEXHOST_CONFORMANCE_SCOPE: "primary" },
        isolated: { CODEXHOST_CONFORMANCE_SCOPE: "isolated" },
        resume: { CODEXHOST_CONFORMANCE_SCOPE: "resume" },
      },
      prompts: {
        first: "conformance first turn",
        cancellable: "hold",
        followup: "conformance followup",
      },
      probes: {
        assertEnvironmentIsolation: async () => {
          const opened = native.clients.filter((client) => !client.context.ephemeral);
          expect(opened).toHaveLength(2);
          expect(
            opened.map((client) => client.context.environment.CODEXHOST_CONFORMANCE_SCOPE),
          ).toEqual(["primary", "isolated"]);
          expect(
            opened.every((client) => client.context.environment.BASE_ENVIRONMENT === "inherited"),
          ).toBe(true);
        },
        readCleanup: async () => ({
          residue: native.clients.every((client) => client.closed) ? "none" : "present",
        }),
      },
    });

    expect(receipt).toMatchObject({
      formatVersion: 1,
      status: "incomplete",
      harnessId: "codebuddy",
      hostSha: null,
      pluginBundleSha256: null,
      nativeVersion: null,
      mode: "native-transport-fixture",
      scenarios: {
        inspect: { status: "passed" },
        create: { status: "passed" },
        firstTurn: { status: "passed" },
        concurrentTurn: { status: "passed" },
        cancel: { status: "passed" },
        identityReadback: { status: "passed" },
        resume: { status: "passed" },
        followup: { status: "passed" },
        fork: { status: "skipped" },
        rollback: { status: "skipped" },
        permissionAtCreate: { status: "skipped" },
        subagents: { status: "notCovered" },
        cleanup: { status: "passed" },
      },
      environment: {
        primaryKeys: ["CODEXHOST_CONFORMANCE_SCOPE"],
        isolatedKeys: ["CODEXHOST_CONFORMANCE_SCOPE"],
        resumeKeys: ["CODEXHOST_CONFORMANCE_SCOPE"],
        nativeIsolationReadback: "passed",
      },
      cleanup: { residue: "none", nativeReadback: "passed" },
    });
    expect(JSON.stringify(receipt)).not.toContain('"primary"');
    expect(JSON.stringify(receipt)).not.toContain('"isolated"');
    expect(JSON.stringify(receipt)).not.toContain('CODEXHOST_CONFORMANCE_SCOPE":"resume');
    expect(receipt.identityReadback.terminalTurns).toHaveLength(3);

    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-conformance-"));
    temporaryDirectories.push(outputDirectory);
    const outputPath = path.join(outputDirectory, "codebuddy-receipt.json");
    await writeFile(outputPath, serializeConformanceReceipt(receipt));
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(receipt);
  });

  it("accepts a lazy create identity once the first real native Turn provides readback", async () => {
    const native = fixture();
    const receipt = await runAdapterConformance(
      plan(() => hideCreateNativeRef(new CodeBuddyAdapter({ ...native })), native),
    );
    expect(receipt.status).toBe("incomplete");
    expect(receipt.identityReadback.createdSession).toMatchObject({
      harnessId: "codebuddy",
      nativeSessionId: "native-session",
    });
  });

  it("keeps a fully exercised lifecycle passed when every false capability is skipped", async () => {
    const native = fixture();
    const createAdapter = (): HarnessAdapter => {
      const base = new CodeBuddyAdapter({ ...native });
      return {
        harnessId: base.harnessId,
        inspect: (input) => base.inspect(input),
        close: () => base.close(),
        open: async (input) => {
          const opened = await base.open(input);
          if (!opened.ok) return opened;
          const session = opened.value;
          return {
            ok: true,
            value: new Proxy(session, {
              get(target, key) {
                if (key === "capabilities")
                  return {
                    ...target.capabilities,
                    history: {
                      ...target.capabilities.history,
                      fork: false,
                      rollbackLastTurn: false,
                    },
                    configuration: {
                      ...target.capabilities.configuration,
                      permissionModeScope: "live",
                    },
                    subagents: undefined,
                  };
                const value = Reflect.get(target, key, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }) as HarnessSession,
          };
        },
      };
    };
    const receipt = await runAdapterConformance(plan(createAdapter, native));

    expect(receipt).toMatchObject({
      status: "passed",
      scenarios: {
        fork: { status: "skipped" },
        rollback: { status: "skipped" },
        permissionAtCreate: { status: "skipped" },
        subagents: { status: "skipped" },
      },
    });
  });

  it("activates an isolated Session through the driver-owned single output consumer", async () => {
    const native = fixture();
    let isolatedOutputConsumers = 0;
    const createAdapter = (): HarnessAdapter => {
      const base = new CodeBuddyAdapter({ ...native });
      return {
        harnessId: base.harnessId,
        inspect: (input) => base.inspect(input),
        close: () => base.close(),
        open: async (input) => {
          const opened = await base.open(input);
          if (
            !opened.ok ||
            input.kind !== "create" ||
            input.environment?.CODEXHOST_CONFORMANCE_SCOPE !== "isolated"
          )
            return opened;
          const session = opened.value;
          const outputs = {
            [Symbol.asyncIterator]() {
              isolatedOutputConsumers += 1;
              return session.outputs[Symbol.asyncIterator]();
            },
          };
          return {
            ok: true,
            value: new Proxy(session, {
              get(target, key) {
                if (key === "outputs") return outputs;
                const value = Reflect.get(target, key, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }) as HarnessSession,
          };
        },
      };
    };
    const base = plan(createAdapter, native);
    const assertEnvironmentIsolation = base.probes?.assertEnvironmentIsolation;
    const readCleanup = base.probes?.readCleanup;
    if (!assertEnvironmentIsolation || !readCleanup)
      throw new Error("fixture requires environment and cleanup probes");
    const receipt = await runAdapterConformance({
      ...base,
      probes: {
        activateIsolated: async (session, output) => {
          const turnId = hostTurnIdSchema.parse("conformance-isolated");
          const accepted = await session.execute({
            type: "turn.start",
            turnId,
            input: [{ type: "text", text: "fixture isolated activation" }],
          });
          if (!accepted.ok) throw new Error(accepted.error.message);
          const terminal = await output.waitForTerminal(turnId);
          if (terminal.outcome.status !== "succeeded")
            throw new Error("isolated fixture Turn did not succeed");
        },
        assertEnvironmentIsolation,
        readCleanup,
      },
    });

    expect(receipt.environment.nativeActivation).toBe("executed");
    expect(isolatedOutputConsumers).toBe(1);
  });

  it("marks missing native cleanup readback incomplete while preserving completed lifecycle evidence", async () => {
    const native = fixture();
    const base = plan(() => new CodeBuddyAdapter({ ...native }), native);
    const assertEnvironmentIsolation = base.probes?.assertEnvironmentIsolation;
    if (!assertEnvironmentIsolation) throw new Error("fixture requires an environment probe");
    const receipt = await runAdapterConformance({
      ...base,
      probes: { assertEnvironmentIsolation },
    });

    expect(receipt).toMatchObject({
      status: "incomplete",
      scenarios: { firstTurn: { status: "passed" }, cleanup: { status: "passed" } },
      cleanup: { nativeReadback: "notCovered", residue: "unknown" },
    });
  });

  it("fails a receipt when the actual fixture emits duplicate terminals for one Host Turn", async () => {
    const native = fixture();
    const base = new CodeBuddyAdapter({ ...native });
    const adapter: HarnessAdapter = {
      harnessId: base.harnessId,
      inspect: (input) => base.inspect(input),
      close: () => base.close(),
      open: async (input) => {
        const opened = await base.open(input);
        if (
          !opened.ok ||
          input.kind !== "create" ||
          input.environment?.CODEXHOST_CONFORMANCE_SCOPE !== "primary"
        )
          return opened;
        const session = opened.value;
        const outputs = {
          async *[Symbol.asyncIterator]() {
            for await (const output of session.outputs) {
              yield output;
              if (
                output.kind === "event" &&
                output.event.type === "turn.completed" &&
                output.event.turnId === "conformance-first"
              )
                yield output;
            }
          },
        };
        return {
          ok: true,
          value: new Proxy(session, {
            get(target, key) {
              if (key === "outputs") return outputs;
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }) as HarnessSession,
        };
      },
    };
    let thrown: unknown;
    try {
      await runAdapterConformance(plan(() => adapter, native));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HarnessConformanceFailure);
    expect((thrown as HarnessConformanceFailure).receipt.status).toBe("failed");
  });

  it("rejects a lazy first terminal whose native identity belongs to another Harness", async () => {
    const native = fixture();
    const adapter = mapAdapterSessionOutputs(
      hideCreateNativeRef(new CodeBuddyAdapter({ ...native })),
      (input, output) =>
        input.kind === "create" && input.environment?.CODEXHOST_CONFORMANCE_SCOPE === "primary"
          ? terminalWithWrongIdentity(output, "conformance-first")
          : output,
    );
    let thrown: unknown;
    try {
      await runAdapterConformance(plan(() => adapter, native));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HarnessConformanceFailure);
    expect((thrown as HarnessConformanceFailure).receipt).toMatchObject({
      status: "failed",
      scenarios: { firstTurn: { status: "failed" } },
    });
  });

  it("times out a hanging native cleanup readback and returns a failed partial receipt", async () => {
    const native = fixture();
    const base = plan(() => new CodeBuddyAdapter({ ...native }), native);
    const assertEnvironmentIsolation = base.probes?.assertEnvironmentIsolation;
    if (!assertEnvironmentIsolation) throw new Error("fixture requires an environment probe");
    const outcome = await settleWithin(
      runAdapterConformance({
        ...base,
        timeoutMs: 50,
        probes: {
          assertEnvironmentIsolation,
          readCleanup: () => new Promise(() => {}),
        },
      }),
      300,
    );

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(HarnessConformanceFailure);
      expect((outcome.error as HarnessConformanceFailure).receipt).toMatchObject({
        status: "failed",
        cleanup: { nativeReadback: "failed", residue: "unknown" },
      });
    }
  });

  it("waits for isolated output termination during cleanup", async () => {
    const native = fixture();
    const base = new CodeBuddyAdapter({ ...native });
    const adapter: HarnessAdapter = {
      harnessId: base.harnessId,
      inspect: (input) => base.inspect(input),
      close: () => base.close(),
      open: async (input) => {
        const opened = await base.open(input);
        if (
          !opened.ok ||
          input.kind !== "create" ||
          input.environment?.CODEXHOST_CONFORMANCE_SCOPE !== "isolated"
        )
          return opened;
        const session = opened.value;
        const lateOutput = deferred<undefined>();
        const outputs = {
          async *[Symbol.asyncIterator]() {
            for await (const output of session.outputs) yield output;
            await lateOutput.promise;
            yield {
              kind: "event",
              event: { type: "session.usage.changed", usage: {} },
            } as HarnessOutput;
          },
        };
        return {
          ok: true,
          value: new Proxy(session, {
            get(target, key) {
              if (key === "outputs") return outputs;
              if (key === "close")
                return async () => {
                  await target.close();
                  lateOutput.resolve(undefined);
                };
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }) as HarnessSession,
        };
      },
    };
    let thrown: unknown;
    try {
      await runAdapterConformance({ ...plan(() => adapter, native), timeoutMs: 50 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HarnessConformanceFailure);
    expect((thrown as HarnessConformanceFailure).receipt).toMatchObject({
      status: "failed",
      cleanup: { resources: { isolatedOutput: "failed" } },
    });
  });

  it("closes a late actual Adapter when factory creation exceeds the deadline", async () => {
    const gate = deferred<undefined>();
    const base = new CodeBuddyAdapter({ ...fixture() });
    let lateAdapterCloseCalls = 0;
    const lateAdapter: HarnessAdapter = {
      harnessId: base.harnessId,
      inspect: (input) => base.inspect(input),
      open: (input) => base.open(input),
      close: () => {
        lateAdapterCloseCalls += 1;
        throw new Error("late factory close failed synchronously");
      },
    };
    const outcome = await settleWithin(
      runAdapterConformance({
        ...plan(async () => {
          await gate.promise;
          return lateAdapter;
        }),
        timeoutMs: 50,
        probes: { readCleanup: async () => ({ residue: "none" }) },
      }),
      300,
    );

    expect(outcome.kind).toBe("rejected");
    await expectNoUnhandledRejection(async () => {
      gate.resolve(undefined);
      await delay(5);
    });
    expect(lateAdapterCloseCalls).toBe(1);
  });

  it("times out a late actual open and closes the Session when it eventually resolves", async () => {
    const native = fixture();
    const gate = deferred<undefined>();
    let lateSessionCloseCalls = 0;
    const base = new CodeBuddyAdapter({ ...native });
    const adapter: HarnessAdapter = {
      harnessId: base.harnessId,
      inspect: (input) => base.inspect(input),
      close: () => base.close(),
      open: async (input) => {
        const opened = await base.open(input);
        if (
          !opened.ok ||
          input.kind !== "create" ||
          input.environment?.CODEXHOST_CONFORMANCE_SCOPE !== "primary"
        )
          return opened;
        const session = opened.value;
        const lateSession = new Proxy(session, {
          get(target, key) {
            if (key === "close")
              return () => {
                lateSessionCloseCalls += 1;
                throw new Error("late open close failed synchronously");
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as HarnessSession;
        await gate.promise;
        return { ok: true, value: lateSession };
      },
    };
    const outcome = await settleWithin(
      runAdapterConformance({ ...plan(() => adapter, native), timeoutMs: 50 }),
      300,
    );

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect((outcome.error as HarnessConformanceFailure).receipt).toMatchObject({
        status: "failed",
        scenarios: { create: { status: "failed", failure: { reason: "timeout:open:create" } } },
      });
    }
    await expectNoUnhandledRejection(async () => {
      gate.resolve(undefined);
      await delay(5);
    });
    expect(lateSessionCloseCalls).toBe(1);
  });

  it("times out a late execute and still closes its known native Session", async () => {
    const native = fixture();
    const gate = deferred<undefined>();
    const base = new CodeBuddyAdapter({ ...native });
    const adapter: HarnessAdapter = {
      harnessId: base.harnessId,
      inspect: (input) => base.inspect(input),
      close: () => base.close(),
      open: async (input) => {
        const opened = await base.open(input);
        if (
          !opened.ok ||
          input.kind !== "create" ||
          input.environment?.CODEXHOST_CONFORMANCE_SCOPE !== "primary"
        )
          return opened;
        const session = opened.value;
        return {
          ok: true,
          value: new Proxy(session, {
            get(target, key) {
              if (key === "execute")
                return async (command: HostCommand) => {
                  if (command.type !== "turn.start")
                    throw new Error("late execute fixture only accepts the first Turn");
                  const result = target.execute(command);
                  if (command.turnId === "conformance-first") await gate.promise;
                  return result;
                };
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }) as HarnessSession,
        };
      },
    };
    const outcome = await settleWithin(
      runAdapterConformance({ ...plan(() => adapter, native), timeoutMs: 50 }),
      300,
    );

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect((outcome.error as HarnessConformanceFailure).receipt).toMatchObject({
        status: "failed",
        scenarios: {
          firstTurn: { status: "failed", failure: { reason: "timeout:execute:firstTurn" } },
        },
        cleanup: { residue: "none" },
      });
    }
    expect(native.clients.every((client) => client.closed)).toBe(true);
    gate.resolve(undefined);
  });

  it("bounds inspect and calls Adapter close before returning its failed receipt", async () => {
    const base = new CodeBuddyAdapter({ clientFactory: fixture().clientFactory });
    let closeCalls = 0;
    const adapter: HarnessAdapter = {
      harnessId: base.harnessId,
      inspect: () => new Promise(() => {}),
      open: (input) => base.open(input),
      close: async () => {
        closeCalls += 1;
        await base.close();
      },
    };
    const outcome = await settleWithin(
      runAdapterConformance({
        ...plan(() => adapter),
        timeoutMs: 50,
        probes: { readCleanup: async () => ({ residue: "none" }) },
      }),
      300,
    );

    expect(outcome.kind).toBe("rejected");
    expect(closeCalls).toBe(1);
    if (outcome.kind === "rejected")
      expect((outcome.error as HarnessConformanceFailure).receipt.scenarios.inspect).toMatchObject({
        status: "failed",
        failure: { reason: "timeout:inspect" },
      });
  });

  it("bounds snapshot and Session close while continuing Adapter close and cleanup readback", async () => {
    const native = fixture();
    const base = new CodeBuddyAdapter({ ...native });
    const adapter: HarnessAdapter = {
      harnessId: base.harnessId,
      inspect: (input) => base.inspect(input),
      close: () => base.close(),
      open: async (input) => {
        const opened = await base.open(input);
        if (
          !opened.ok ||
          input.kind !== "create" ||
          input.environment?.CODEXHOST_CONFORMANCE_SCOPE !== "primary"
        )
          return opened;
        const session = opened.value;
        return {
          ok: true,
          value: new Proxy(session, {
            get(target, key) {
              if (key === "readSnapshot") return () => new Promise(() => {});
              if (key === "close") return () => new Promise<void>(() => {});
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }) as HarnessSession,
        };
      },
    };
    const outcome = await settleWithin(
      runAdapterConformance({ ...plan(() => adapter, native), timeoutMs: 50 }),
      350,
    );

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect((outcome.error as HarnessConformanceFailure).receipt).toMatchObject({
        status: "failed",
        scenarios: {
          identityReadback: {
            status: "failed",
            failure: { reason: "timeout:snapshot:identityReadback" },
          },
        },
        cleanup: {
          resources: { primarySession: "failed", primaryAdapter: "passed" },
          nativeReadback: "passed",
          residue: "none",
        },
      });
    }
    expect(native.clients.every((client) => client.closed)).toBe(true);
  });

  it("rejects a cancel terminal bound to another native Session", async () => {
    const native = fixture();
    const createAdapter = () =>
      mapAdapterSessionOutputs(new CodeBuddyAdapter({ ...native }), (input, output) =>
        input.kind === "create" && input.environment?.CODEXHOST_CONFORMANCE_SCOPE === "primary"
          ? terminalWithWrongIdentity(output, "conformance-cancel")
          : output,
      );
    let thrown: unknown;
    try {
      await runAdapterConformance(plan(createAdapter, native));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HarnessConformanceFailure);
    expect((thrown as HarnessConformanceFailure).receipt).toMatchObject({
      status: "failed",
      scenarios: { cancel: { status: "failed" } },
    });
  });

  it("rejects a followup terminal bound to another resumed native Session", async () => {
    const native = fixture();
    const createAdapter = () =>
      mapAdapterSessionOutputs(new CodeBuddyAdapter({ ...native }), (input, output) =>
        input.kind === "resume"
          ? terminalWithWrongIdentity(output, "conformance-followup")
          : output,
      );
    let thrown: unknown;
    try {
      await runAdapterConformance(plan(createAdapter, native));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HarnessConformanceFailure);
    expect((thrown as HarnessConformanceFailure).receipt).toMatchObject({
      status: "failed",
      scenarios: { followup: { status: "failed" } },
    });
  });

  it("returns a failed receipt after a real fixture close failure and still proves residue cleanup", async () => {
    const native = fixture();
    let openedSessions = 0;
    const createAdapter = () =>
      new CodeBuddyAdapter({
        environment: {},
        readHistory: native.readHistory,
        clientFactory: (options) => {
          const client = native.clientFactory(options);
          if (!options.ephemeral && ++openedSessions === 3) client.closeThrows = true;
          return client;
        },
      });
    let thrown: unknown;
    try {
      await runAdapterConformance(plan(createAdapter, native));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HarnessConformanceFailure);
    const receipt = (thrown as HarnessConformanceFailure).receipt;
    expect(receipt).toMatchObject({
      status: "failed",
      scenarios: { resume: { status: "failed" } },
      cleanup: {
        resources: { primarySession: "failed", primaryOutput: "passed" },
        nativeReadback: "passed",
        residue: "none",
      },
    });
    expect(native.clients.every((client) => client.closed)).toBe(true);
  });

  it("returns a receipt with null identity when inspect fails before a Session exists", async () => {
    const adapter = new CodeBuddyAdapter({
      clientFactory: () => {
        throw new Error("fixture native unavailable");
      },
    });
    let thrown: unknown;
    try {
      await runAdapterConformance({
        ...plan(() => adapter),
        probes: { readCleanup: async () => ({ residue: "none" }) },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HarnessConformanceFailure);
    expect((thrown as HarnessConformanceFailure).receipt).toMatchObject({
      status: "failed",
      capabilities: null,
      identityReadback: { createdSession: null, resumedSession: null, terminalTurns: [] },
      scenarios: { inspect: { status: "failed" }, cleanup: { status: "passed" } },
      cleanup: { resources: { primaryAdapter: "passed" }, nativeReadback: "passed" },
    });
  });
});
