import { describe, expect, it, vi } from "vitest";
import {
  createRendererHostClients,
  type RendererHostRoute,
  type RendererHostRouting,
} from "../src/renderer-host-clients.js";

function route(
  hostId: string,
  sendRequest: (method: string, params: unknown) => Promise<unknown> = vi.fn(async () => ({
    plugins: [],
  })),
) {
  return {
    hostId,
    manager: { sendRequest },
    policy: { state: "ready", hostId, select: vi.fn(), clear: vi.fn() },
  } as unknown as RendererHostRoute;
}

describe("Renderer Host clients", () => {
  it("reads resource observations through the current local route only", async () => {
    const sendOld = vi.fn(async () => ({ sessions: [] }));
    const sendNew = vi.fn(async () => ({ sessions: [] }));
    const oldRoute = route("local", sendOld);
    const replacement = route("local", sendNew);
    let current: RendererHostRoute | null = oldRoute;
    const clients = createRendererHostClients(
      () => ({ forHost: () => current }) as unknown as RendererHostRouting,
    );
    const stale = clients.forHost("local");
    await expect(stale?.listLoadedSessions?.()).resolves.toEqual({ sessions: [] });
    current = replacement;
    await expect(stale?.listLoadedSessions?.()).rejects.toThrow("unavailable for Host local");
    const live = clients.forHost("local");
    await expect(live?.listLoadedSessions?.()).resolves.toEqual({ sessions: [] });
    current = null;
    expect(clients.forHost("local")).toBeNull();
    await expect(live?.listLoadedSessions?.()).rejects.toThrow("unavailable for Host local");
    expect(sendOld).toHaveBeenCalledExactlyOnceWith("codexhost/resources/list", {});
    expect(sendNew).toHaveBeenCalledExactlyOnceWith("codexhost/resources/list", {});
    clients.dispose();
  });

  it("keeps distinct Host clients available without a Composer", async () => {
    const local = route("local");
    const remote = route("remote");
    const routes = new Map([
      ["local", local],
      ["remote", remote],
    ]);
    const routing = {
      forHost: (hostId: string) => routes.get(hostId) ?? null,
      forComposer: () => null,
    } as RendererHostRouting;
    const clients = createRendererHostClients(() => routing);
    const localClient = clients.forHost("local");
    const remoteClient = clients.forHost("remote");

    expect(localClient).not.toBeNull();
    expect(remoteClient).not.toBeNull();
    expect(localClient).not.toBe(remoteClient);
    await expect(localClient?.listHarnessPlugins?.()).resolves.toEqual({ plugins: [] });
    await expect(remoteClient?.listHarnessPlugins?.()).resolves.toEqual({ plugins: [] });
    expect(local.manager.sendRequest).toHaveBeenCalledOnce();
    expect(remote.manager.sendRequest).toHaveBeenCalledOnce();
    clients.dispose();
  });

  it("rejects new requests through a replaced or disconnected manager", async () => {
    const oldRoute = route("local");
    const replacement = route("local");
    let current: RendererHostRoute | null = oldRoute;
    const routing = { forHost: () => current } as unknown as RendererHostRouting;
    const clients = createRendererHostClients(() => routing);
    const stale = clients.forHost("local");
    current = replacement;
    const live = clients.forHost("local");

    await expect(stale?.listHarnessPlugins?.()).rejects.toThrow("unavailable for Host local");
    await expect(live?.listHarnessPlugins?.()).resolves.toEqual({ plugins: [] });
    current = null;
    expect(clients.forHost("local")).toBeNull();
    await expect(live?.listHarnessPlugins?.()).rejects.toThrow("unavailable for Host local");
    expect(oldRoute.manager.sendRequest).not.toHaveBeenCalled();
    expect(replacement.manager.sendRequest).toHaveBeenCalledOnce();
    clients.dispose();
  });
});
