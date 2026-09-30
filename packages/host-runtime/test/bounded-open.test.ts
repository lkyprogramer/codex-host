import type { HarnessAdapter, HarnessResult, HarnessSession } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { openWithin } from "../src/bounded-open.js";

const harnessId = harnessIdSchema.parse("pi");

function adapterOpening(open: () => Promise<HarnessResult<HarnessSession>>): HarnessAdapter {
  const base = new FakeHarnessAdapter(harnessId);
  return {
    harnessId: base.harnessId,
    inspect: (input) => base.inspect(input),
    open,
    close: () => base.close(),
  };
}

describe("openWithin", () => {
  it("passes an open that answers in time through", async () => {
    const session = new FakeHarnessSession(harnessId);
    const result = await openWithin(
      adapterOpening(async () => ({ ok: true, value: session })),
      { kind: "create", cwd: "/synthetic" },
      1_000,
    );
    expect(result).toMatchObject({ ok: true, value: session });
    expect(session.closed).toBe(false);
  });

  it("answers a hung open with a retryable error instead of waiting forever", async () => {
    const started = Date.now();
    const result = await openWithin(
      adapterOpening(() => new Promise(() => undefined)),
      { kind: "create", cwd: "/synthetic" },
      20,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: true },
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("closes a Session that opens after the deadline, since nobody holds it", async () => {
    const late = new FakeHarnessSession(harnessId);
    let finish!: (result: HarnessResult<HarnessSession>) => void;
    const result = await openWithin(
      adapterOpening(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
      { kind: "create", cwd: "/synthetic" },
      20,
    );
    expect(result.ok).toBe(false);
    finish({ ok: true, value: late });
    await vi.waitFor(() => expect(late.closed).toBe(true));
  });
});
