import path from "node:path";

import type { HarnessAdapter, HarnessError } from "@codexhost/harness-adapter";
import {
  harnessCommandCatalogSchema,
  mergeHarnessCommandCatalogs,
  type HarnessCommandCatalog,
} from "@codexhost/shared-contracts";

import { awaitWithSignal } from "./abortable-read.js";

const MAX_ENTRIES = 64;

export class HarnessCommandCatalogError extends Error {
  readonly nativeError: HarnessError;

  constructor(error: HarnessError) {
    super(error.message);
    this.name = "HarnessCommandCatalogError";
    this.nativeError = error;
  }
}

interface CatalogOptions {
  adapter: (harnessId: string) => HarnessAdapter | undefined;
  timeoutMs?: number;
  ttlMs?: number;
}

interface PendingCatalog {
  controller: AbortController;
  promise: Promise<HarnessCommandCatalog>;
  waiters: number;
  settled: boolean;
}

interface CacheEntry {
  catalog?: HarnessCommandCatalog;
  expiresAt?: number;
  pending?: PendingCatalog;
}

function abortError(message: string, name = "AbortError"): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** One instance belongs to one Host; native metadata inspection stays outside Session operation queues. */
export class WorkspaceCommandCatalogs {
  readonly #adapter: CatalogOptions["adapter"];
  readonly #timeoutMs: number;
  readonly #ttlMs: number;
  readonly #entries = new Map<string, CacheEntry>();
  #closed = false;

  constructor(options: CatalogOptions) {
    this.#adapter = options.adapter;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#ttlMs = options.ttlMs ?? 30_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new RangeError("timeoutMs must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 0) {
      throw new RangeError("ttlMs must be a nonnegative integer");
    }
  }

  async inspect(
    harnessId: string,
    cwd?: string,
    options: { refresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<HarnessCommandCatalog> {
    if (this.#closed) throw abortError("Workspace command catalogs are closed");
    if (options.signal?.aborted)
      throw options.signal.reason ?? abortError("Command inspection cancelled");
    const adapter = this.#adapter(harnessId);
    if (!adapter) throw new Error(`Harness '${harnessId}' is unavailable`);
    const builtin = harnessCommandCatalogSchema.parse(adapter.commandCatalog ?? { commands: [] });
    const staticCatalog = harnessCommandCatalogSchema.parse({ ...builtin, source: "static" });
    if (!cwd || !adapter.liveCommandCatalog) return staticCatalog;

    const normalizedCwd = path.resolve(cwd);
    const key = `${harnessId}\0${normalizedCwd}`;
    if (options.refresh) this.#invalidate(key);
    const cached = this.#entries.get(key);
    if (cached?.catalog && cached.expiresAt !== undefined && cached.expiresAt > Date.now()) {
      this.#touch(key, cached);
      return cached.catalog;
    }
    if (cached?.pending) {
      this.#touch(key, cached);
      return this.#waitFor(key, cached.pending, options.signal);
    }

    const controller = new AbortController();
    const pending: PendingCatalog = {
      controller,
      promise: undefined as unknown as Promise<HarnessCommandCatalog>,
      waiters: 0,
      settled: false,
    };
    const entry: CacheEntry = { pending };
    this.#touch(key, entry);
    this.#trim();
    pending.promise = this.#probe(adapter, normalizedCwd, builtin, staticCatalog, controller)
      .then((catalog) => {
        if (!controller.signal.aborted && this.#entries.get(key) === entry) {
          entry.catalog = catalog;
          entry.expiresAt = Date.now() + this.#ttlMs;
          delete entry.pending;
        }
        return catalog;
      })
      .catch((error: unknown) => {
        if (this.#entries.get(key) === entry) this.#entries.delete(key);
        throw error;
      })
      .finally(() => {
        pending.settled = true;
      });
    return this.#waitFor(key, pending, options.signal);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const key of this.#entries.keys()) this.#invalidate(key);
  }

  async #probe(
    adapter: HarnessAdapter,
    cwd: string,
    builtin: HarnessCommandCatalog,
    staticCatalog: HarnessCommandCatalog,
    controller: AbortController,
  ): Promise<HarnessCommandCatalog> {
    const signal = controller.signal;
    // Adapter inspection owns a separate, cancellable metadata transport.
    const timeout = setTimeout(() => {
      controller.abort(abortError("Harness command inspection timed out", "TimeoutError"));
    }, this.#timeoutMs);
    try {
      if (!adapter.inspectCommands) return staticCatalog;
      const result = await awaitWithSignal(adapter.inspectCommands({ cwd, signal }), signal);
      if (!result.ok) throw new HarnessCommandCatalogError(result.error);
      const native = harnessCommandCatalogSchema.parse(result.value);
      if (native.source !== "live") return staticCatalog;
      return harnessCommandCatalogSchema.parse(mergeHarnessCommandCatalogs(builtin, native));
    } finally {
      clearTimeout(timeout);
    }
  }

  async #waitFor(
    key: string,
    pending: PendingCatalog,
    signal?: AbortSignal,
  ): Promise<HarnessCommandCatalog> {
    pending.waiters += 1;
    try {
      return signal ? await awaitWithSignal(pending.promise, signal) : await pending.promise;
    } finally {
      pending.waiters -= 1;
      if (pending.waiters === 0 && !pending.settled) {
        this.#invalidate(key, pending);
      }
    }
  }

  #invalidate(key: string, only?: PendingCatalog): void {
    const entry = this.#entries.get(key);
    if (!entry || (only && entry.pending !== only)) return;
    this.#entries.delete(key);
    entry.pending?.controller.abort(abortError("Harness command inspection invalidated"));
  }

  #touch(key: string, entry: CacheEntry): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
  }

  #trim(): void {
    while (this.#entries.size > MAX_ENTRIES) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) return;
      this.#invalidate(oldest);
    }
  }
}
