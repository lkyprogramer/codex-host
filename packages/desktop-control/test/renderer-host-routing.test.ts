import { describe, expect, it, vi } from "vitest";

import {
  createDraftPrewarmPolicyBridge,
  type DraftPrewarmPolicyTarget,
} from "../src/renderer-draft-prewarm-runtime.js";
import {
  discoverRendererHosts,
  resolveRendererHostManager,
  type RendererHostRoot,
  type RendererNativeRequestManager,
} from "../src/renderer-host-discovery.js";
import { installRendererHostRouting } from "../src/renderer-host-routing.js";
import { committedReactAncestors } from "../src/renderer-react-ownership.js";

type Fiber = Record<string, unknown>;

function nativeManager(hostId: string) {
  const directSend = vi.fn((method: string, params: unknown) => ({ hostId, method, params }));
  const requestClient = {
    hostId,
    sendRequest: directSend,
    prewarmThreadStart: vi.fn(),
    enqueueRequest: vi.fn(),
    onResult: vi.fn(),
    onError: vi.fn(),
  };
  const manager: RendererNativeRequestManager = {
    getHostId: () => hostId,
    sendRequest: vi.fn(),
    requestClient,
    prewarmedThreadManager: { discardAllPrewarmedThreads: vi.fn() },
    onNotification: vi.fn(),
    onRequest: vi.fn(),
    dispatchAppServerResponse: vi.fn(),
  };
  return { manager, requestClient, directSend };
}

function reactFixture() {
  const entries = new Map<string, RendererNativeRequestManager>();
  const registry = {
    getForHostId: (hostId: string) => entries.get(hostId),
    addManager: vi.fn(),
    waitForManagerForHostId: vi.fn(),
  };
  const editors: RendererHostRoot[] = [];
  const rootFiber: Fiber = { memoizedState: { memoizedState: registry } };
  rootFiber.stateNode = { current: rootFiber };
  let lastHostFiber: Fiber | null = null;
  const root: RendererHostRoot = {
    querySelectorAll(selector) {
      return selector.startsWith("[data-codex-composer]") ? editors : [];
    },
  };
  const addComposer = (hostId?: string): RendererHostRoot => {
    const hostFiber: Fiber = {
      return: rootFiber,
      memoizedProps: hostId ? { executionTargetHostId: hostId } : {},
    };
    const editorFiber: Fiber = { return: hostFiber };
    hostFiber.child = editorFiber;
    if (lastHostFiber) lastHostFiber.sibling = hostFiber;
    else rootFiber.child = hostFiber;
    lastHostFiber = hostFiber;
    const editor: RendererHostRoot = { querySelectorAll: () => [], matches: () => true };
    Object.defineProperty(editor, "__reactFiber$fixture", { value: editorFiber });
    editors.push(editor);
    return editor;
  };
  const target: DraftPrewarmPolicyTarget = {};
  const routing = installRendererHostRouting(
    root,
    target,
    discoverRendererHosts,
    resolveRendererHostManager,
    createDraftPrewarmPolicyBridge,
    committedReactAncestors,
  );
  return { root, editors, entries, registry, addComposer, target, routing };
}

describe("Renderer Host routing", () => {
  it("keeps local and remote Composer requests on their exact Host", () => {
    const fixture = reactFixture();
    const local = nativeManager("local");
    const remote = nativeManager("remote-ssh-discovered:mac");
    fixture.entries.set("local", local.manager);
    fixture.entries.set("remote-ssh-discovered:mac", remote.manager);
    const localEditorA = fixture.addComposer("local");
    const remoteEditor = fixture.addComposer("remote-ssh-discovered:mac");
    const localEditorB = fixture.addComposer("local");

    const localRoute = fixture.routing.forComposer(localEditorA);
    const remoteRoute = fixture.routing.forComposer(remoteEditor);
    expect(localRoute?.manager).toBe(local.manager);
    expect(remoteRoute?.manager).toBe(remote.manager);
    expect(fixture.routing.forComposer(localEditorB)).toBe(localRoute);
    expect(fixture.routing.forHost("local")).toBe(localRoute);
    expect(fixture.routing.forHost("local")).toBe(localRoute);
    expect(fixture.routing.forComposer()).toBeNull();

    expect(local.requestClient.sendRequest("thread/read", { threadId: "local-thread" })).toEqual({
      hostId: "local",
      method: "thread/read",
      params: { threadId: "local-thread" },
    });
    expect(remote.requestClient.sendRequest("thread/read", { threadId: "remote-thread" })).toEqual({
      hostId: "remote-ssh-discovered:mac",
      method: "thread/read",
      params: { threadId: "remote-thread" },
    });
    expect(local.directSend).toHaveBeenCalledOnce();
    expect(remote.directSend).toHaveBeenCalledOnce();
    fixture.routing.dispose();
  });

  it("keeps a live registry entry across Settings without a Composer", () => {
    const fixture = reactFixture();
    const local = nativeManager("local");
    fixture.entries.set("local", local.manager);
    fixture.addComposer("local");
    const route = fixture.routing.forHost("local");
    fixture.editors.length = 0;

    expect(fixture.routing.forComposer()).toBeNull();
    expect(fixture.routing.hostIdForComposer()).toBeNull();
    expect(fixture.routing.forHost("local")).toBe(route);
    expect(route?.policy.requestTarget()).toBe(local.manager);
    fixture.routing.dispose();
  });

  it("revokes the old policy when the registry disconnects or replaces a manager", () => {
    const fixture = reactFixture();
    const first = nativeManager("local");
    fixture.entries.set("local", first.manager);
    fixture.addComposer("local");
    const oldRoute = fixture.routing.forHost("local");
    const staleSend = first.requestClient.sendRequest;
    fixture.editors.length = 0;
    fixture.entries.delete("local");

    expect(fixture.routing.forHost("local")).toBeNull();
    expect(() => oldRoute?.policy.requestTarget()).toThrow("no longer current");
    expect(() => staleSend("thread/read", { threadId: "old" })).toThrow("no longer current");

    const replacement = nativeManager("local");
    fixture.entries.set("local", replacement.manager);
    const newRoute = fixture.routing.forHost("local");
    expect(newRoute?.manager).toBe(replacement.manager);
    expect(newRoute).not.toBe(oldRoute);
    expect(replacement.requestClient.sendRequest("thread/read", { threadId: "new" })).toEqual({
      hostId: "local",
      method: "thread/read",
      params: { threadId: "new" },
    });
    expect(first.directSend).not.toHaveBeenCalled();
    fixture.routing.dispose();
  });

  it("revokes an old request client when the same manager adopts a new client", () => {
    const fixture = reactFixture();
    const original = nativeManager("local");
    fixture.entries.set("local", original.manager);
    fixture.addComposer("local");
    const oldRoute = fixture.routing.forHost("local");
    const staleSend = original.requestClient.sendRequest;
    const nextClient = nativeManager("local");
    original.manager.requestClient = nextClient.requestClient;

    expect(() => staleSend("thread/read", { threadId: "old" })).toThrow("no longer current");
    const newRoute = fixture.routing.forHost("local");
    expect(newRoute).not.toBe(oldRoute);
    expect(() => oldRoute?.policy.requestTarget()).toThrow("no longer current");
    expect(nextClient.requestClient.sendRequest("thread/read", { threadId: "new" })).toEqual({
      hostId: "local",
      method: "thread/read",
      params: { threadId: "new" },
    });
    expect(original.directSend).not.toHaveBeenCalled();
    fixture.routing.dispose();
  });

  it("finds a published root registry without an editor but does not infer a Composer route", () => {
    const manager = nativeManager("local");
    const registry = {
      getForHostId: (hostId: string) => (hostId === "local" ? manager.manager : undefined),
      addManager: vi.fn(),
      waitForManagerForHostId: vi.fn(),
    };
    const rootFiber: Fiber = {};
    rootFiber.stateNode = { current: rootFiber };
    rootFiber.child = { return: rootFiber, memoizedState: { memoizedState: registry } };
    const reactRoot: RendererHostRoot = { querySelectorAll: () => [] };
    Object.defineProperty(reactRoot, "__reactContainer$fixture", { value: rootFiber });
    const root: RendererHostRoot = {
      querySelectorAll(selector) {
        return selector === "#root, [data-reactroot]" ? [reactRoot] : [];
      },
    };
    const discovery = discoverRendererHosts(root);
    expect(discovery.editorCount).toBe(0);
    expect(discovery.registries).toEqual([registry]);
    const routing = installRendererHostRouting(
      root,
      {},
      discoverRendererHosts,
      resolveRendererHostManager,
      createDraftPrewarmPolicyBridge,
      committedReactAncestors,
    );
    expect(routing.forHost("local")?.manager).toBe(manager.manager);
    expect(routing.forComposer()).toBeNull();
    routing.dispose();
  });

  it("does not guess local when a Composer has no Host property and a registry exists", () => {
    const fixture = reactFixture();
    const local = nativeManager("local");
    fixture.entries.set("local", local.manager);
    const editor = fixture.addComposer();
    expect(fixture.routing.hostIdForComposer(editor)).toBeNull();
    expect(fixture.routing.forComposer(editor)).toBeNull();
    expect(fixture.routing.forHost("local")?.manager).toBe(local.manager);
    fixture.routing.dispose();
  });
});
