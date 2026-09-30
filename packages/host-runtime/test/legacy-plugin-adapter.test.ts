import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import { validateHarnessSession } from "@codexhost/harness-adapter";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { legacyPluginAdapter } from "../src/legacy-plugin-adapter.js";

const id = harnessIdSchema.parse("legacy-agent");

async function open(adapter: FakeHarnessAdapter) {
  const opened = await legacyPluginAdapter(adapter).open({ kind: "create", cwd: "/synthetic" });
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}

describe("version 1 plugins through the current contract", () => {
  it("declares no native resources for a Session without a lifecycle", async () => {
    const session = await open(new FakeHarnessAdapter(id));
    expect(session.capabilities.resources).toEqual({ idleRelease: false, ownedJobs: false });
    expect(validateHarnessSession(id, session)).toMatchObject({ ok: true });
  });

  it("moves an Adapter-level owned-job stop onto the Session it opened", async () => {
    const adapter = new FakeHarnessAdapter(id);
    const stopOwnedJobs = vi.fn<(session: unknown) => Promise<{ quiescence: "confirmed" }>>(
      async () => ({ quiescence: "confirmed" }),
    );
    Object.assign(adapter, { stopOwnedJobs });
    const session = await open(adapter);

    expect(session.capabilities.resources).toEqual({ idleRelease: true, ownedJobs: true });
    expect(validateHarnessSession(id, session)).toMatchObject({ ok: true });
    await expect(session.resourceLifecycle?.suspend({ aborted: false })).resolves.toEqual({
      status: "unsupported",
    });
    await expect(session.resourceLifecycle?.stopOwnedJobs?.()).resolves.toEqual({
      quiescence: "confirmed",
    });
    // The Adapter still receives its own Session, not the declaring view.
    expect(stopOwnedJobs.mock.calls[0]?.[0]).toBeInstanceOf(FakeHarnessSession);
    await session.close();
  });
});
