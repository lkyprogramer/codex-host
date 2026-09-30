import path from "node:path";

import type { HarnessResult } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import {
  harnessCommandCatalogSchema,
  harnessIdSchema,
  type HarnessCommandCatalog,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type HarnessCommandCatalogError,
  WorkspaceCommandCatalogs,
} from "../src/workspace-command-catalog.js";

const builtin = harnessCommandCatalogSchema.parse({
  commands: [{ id: "help", invocation: "/help", label: "Builtin help", argumentMode: "none" }],
});
const native = harnessCommandCatalogSchema.parse({
  source: "live",
  commands: [
    { id: "help", invocation: "/other", label: "Colliding ID", argumentMode: "none" },
    {
      id: "other",
      invocation: "/help",
      label: "Colliding invocation",
      argumentMode: "none",
      kind: "skill",
    },
    { id: "review", invocation: "/review", label: "Review", argumentMode: "text", kind: "skill" },
  ],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(options: { timeoutMs?: number; ttlMs?: number } = {}) {
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const inspect = vi.fn<
    (input: { cwd: string; signal: AbortSignal }) => Promise<HarnessResult<HarnessCommandCatalog>>
  >(async () => ({
    ok: true as const,
    value: native,
  }));
  Object.assign(adapter, {
    commandCatalog: builtin,
    liveCommandCatalog: true,
    inspectCommands: inspect,
  });
  const catalogs = new WorkspaceCommandCatalogs({
    adapter: (id) => (id === "pi" ? adapter : undefined),
    ...options,
  });
  return { adapter, inspect, catalogs };
}

afterEach(() => vi.restoreAllMocks());

describe("WorkspaceCommandCatalogs", () => {
  it("returns static metadata without a cwd or live capability", async () => {
    const { adapter, inspect, catalogs } = fixture();
    expect(await catalogs.inspect("pi")).toEqual({ ...builtin, source: "static" });
    Object.assign(adapter, { liveCommandCatalog: false });
    expect(await catalogs.inspect("pi", "/one")).toEqual({ ...builtin, source: "static" });
    expect(inspect).not.toHaveBeenCalled();
    catalogs.close();
  });

  it("requires explicit live provenance before exposing dynamic commands", async () => {
    const { inspect, catalogs } = fixture();
    inspect.mockResolvedValueOnce({ ok: true, value: { commands: native.commands } });
    expect(await catalogs.inspect("pi", "/workspace")).toEqual({ ...builtin, source: "static" });
    catalogs.close();
  });

  it("probes cold, reuses hot cache, and preserves builtin collisions plus unrelated skills", async () => {
    const { inspect, catalogs } = fixture();
    const first = await catalogs.inspect("pi", "/workspace/../workspace");
    expect(first).toEqual({ commands: [builtin.commands[0], native.commands[2]], source: "live" });
    expect(await catalogs.inspect("pi", "/workspace")).toBe(first);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect.mock.calls[0]?.[0].cwd).toBe(path.resolve("/workspace"));
    catalogs.close();
  });

  it("isolates workspaces and refreshes expired metadata", async () => {
    const { inspect, catalogs } = fixture({ ttlMs: 20 });
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(100);
    await catalogs.inspect("pi", "/a");
    await catalogs.inspect("pi", "/b");
    now.mockReturnValue(121);
    await catalogs.inspect("pi", "/a");
    expect(inspect.mock.calls.map(([input]) => input.cwd)).toEqual(["/a", "/b", "/a"]);
    catalogs.close();
  });

  it("does not cache a native error and retains its retry details", async () => {
    const { inspect, catalogs } = fixture();
    const error = {
      code: "nativeFailure" as const,
      message: "native unavailable",
      retryable: true,
      diagnostic: "retry later",
    };
    inspect.mockResolvedValueOnce({ ok: false, error } as never);
    await expect(catalogs.inspect("pi", "/work")).rejects.toMatchObject({
      name: "HarnessCommandCatalogError",
      nativeError: error,
    } satisfies Partial<HarnessCommandCatalogError>);
    expect((await catalogs.inspect("pi", "/work")).source).toBe("live");
    expect(inspect).toHaveBeenCalledTimes(2);
    catalogs.close();
  });

  it("bounds a slow probe and retries after timeout", async () => {
    const { inspect, catalogs } = fixture({ timeoutMs: 10 });
    inspect.mockImplementationOnce(async () => new Promise<never>(() => undefined));
    await expect(catalogs.inspect("pi", "/work")).rejects.toMatchObject({ name: "TimeoutError" });
    expect((await catalogs.inspect("pi", "/work")).source).toBe("live");
    catalogs.close();
  });

  it("keeps a shared probe alive when one caller cancels", async () => {
    const { inspect, catalogs } = fixture();
    const firstProbe = deferred<{ ok: true; value: HarnessCommandCatalog }>();
    inspect.mockImplementationOnce(async () => firstProbe.promise);
    const controller = new AbortController();
    const cancelled = catalogs.inspect("pi", "/work", { signal: controller.signal });
    const remaining = catalogs.inspect("pi", "/work");
    controller.abort(new Error("caller cancelled"));
    await expect(cancelled).rejects.toThrow("caller cancelled");
    firstProbe.resolve({ ok: true, value: native });
    expect((await remaining).source).toBe("live");
    expect(inspect).toHaveBeenCalledTimes(1);
    catalogs.close();
  });

  it("invalidates refresh and close without publishing late probe results", async () => {
    const { inspect, catalogs } = fixture();
    const oldProbe = deferred<{ ok: true; value: HarnessCommandCatalog }>();
    inspect.mockImplementationOnce(async () => oldProbe.promise);
    const oldRead = catalogs.inspect("pi", "/work");
    const fresh = await catalogs.inspect("pi", "/work", { refresh: true });
    await expect(oldRead).rejects.toMatchObject({ name: "AbortError" });
    oldProbe.resolve({ ok: true, value: { commands: [], source: "live" } });
    expect(await catalogs.inspect("pi", "/work")).toBe(fresh);

    const closingProbe = deferred<{ ok: true; value: HarnessCommandCatalog }>();
    inspect.mockImplementationOnce(async () => closingProbe.promise);
    const closingRead = catalogs.inspect("pi", "/other");
    catalogs.close();
    await expect(closingRead).rejects.toMatchObject({ name: "AbortError" });
    closingProbe.resolve({ ok: true, value: native });
    await expect(catalogs.inspect("pi", "/other")).rejects.toMatchObject({ name: "AbortError" });
  });
});
