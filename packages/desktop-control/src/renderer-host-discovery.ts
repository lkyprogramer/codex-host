import { committedReactAncestors } from "./renderer-react-ownership.js";
import type {
  RendererHostRequestBridge,
  RendererHostRequestManager,
  RendererPrewarmedThreadManager,
} from "./renderer-draft-prewarm-runtime.js";

export interface RendererNativeRequestManager extends RendererHostRequestManager {
  sendRequest(method: string, params: unknown, options?: unknown): unknown;
  getHostId?(): unknown;
  requestClient: RendererHostRequestBridge & { hostId?: unknown };
  prewarmedThreadManager: RendererPrewarmedThreadManager;
}
export interface RendererHostRegistry {
  getForHostId(hostId: string): unknown;
}
export interface RendererHostRoot {
  querySelectorAll(selector: string): Iterable<RendererHostRoot>;
  parentElement?: RendererHostRoot | null;
  matches?(selector: string): boolean;
}
export interface RendererHostDiscovery {
  editorCount: number;
  hostIds: string[];
  managers: RendererNativeRequestManager[];
  registries: RendererHostRegistry[];
}

/** Self-contained for Controller injection. A registry lookup must use an explicit Host. */
export function requestManagerFromHookState(
  value: unknown,
  hostId?: string,
): RendererNativeRequestManager | null {
  const record = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const manager = (v: unknown): RendererNativeRequestManager | null => {
    if (!record(v) || !record(v.requestClient) || !record(v.prewarmedThreadManager)) return null;
    return typeof v.sendRequest === "function" &&
      typeof v.requestClient.sendRequest === "function" &&
      typeof v.requestClient.prewarmThreadStart === "function" &&
      typeof v.requestClient.enqueueRequest === "function" &&
      typeof v.prewarmedThreadManager.discardAllPrewarmedThreads === "function"
      ? (v as unknown as RendererNativeRequestManager)
      : null;
  };
  if (!record(value)) return null;
  const direct = manager(value) ?? manager(value.manager);
  if (direct) return direct;
  if (
    hostId &&
    typeof value.addManager === "function" &&
    typeof value.getForHostId === "function" &&
    typeof value.waitForManagerForHostId === "function"
  )
    return manager(value.getForHostId(hostId));
  return null;
}

export function discoverRendererHosts(
  root: RendererHostRoot,
  ancestors: typeof committedReactAncestors = committedReactAncestors,
  managerFrom: typeof requestManagerFromHookState = requestManagerFromHookState,
): RendererHostDiscovery {
  const selector = '[data-codex-composer], [contenteditable="true"][role="textbox"]';
  const editors = root.matches?.(selector) ? [root] : [...root.querySelectorAll(selector)];
  const fibers = new Set<Record<string, unknown>>();
  const hostIds = new Set<string>();
  const managers = new Set<RendererNativeRequestManager>();
  const registries = new Set<RendererHostRegistry>();
  for (const editor of editors) {
    let current: RendererHostRoot | null = editor;
    let fiber: unknown;
    while (current && !fiber) {
      const key = Object.getOwnPropertyNames(current).find((name) =>
        name.startsWith("__reactFiber$"),
      );
      if (key) fiber = Object.getOwnPropertyDescriptor(current, key)?.value;
      current = current.parentElement ?? null;
    }
    for (const ancestor of ancestors(fiber)) {
      fibers.add(ancestor);
      const props = ancestor.memoizedProps as Record<string, unknown> | null;
      for (const key of ["executionTargetHostId", "permissionsHostId"]) {
        const id = props?.[key];
        if (typeof id === "string" && id) hostIds.add(id);
      }
    }
  }
  // On initial Settings startup there may never have been an editor. Read the
  // published application root for registries; it does not establish a Composer route.
  if (editors.length === 0) {
    for (const element of root.querySelectorAll("#root, [data-reactroot]")) {
      const key = Object.getOwnPropertyNames(element).find((name) =>
        name.startsWith("__reactContainer$"),
      );
      if (!key) continue;
      const pointer = Object.getOwnPropertyDescriptor(element, key)?.value;
      const publishedRoot = ancestors(pointer).at(-1);
      const pending = publishedRoot ? [publishedRoot] : [];
      while (pending.length > 0 && fibers.size < 20_000) {
        const fiber = pending.pop();
        if (!fiber || fibers.has(fiber)) continue;
        fibers.add(fiber);
        for (const key of ["child", "sibling"]) {
          const next = fiber[key];
          if (next && typeof next === "object") pending.push(next as Record<string, unknown>);
        }
      }
    }
  }
  for (const fiber of fibers) {
    let hook = fiber.memoizedState as { memoizedState?: unknown; next?: unknown } | null;
    for (let index = 0; hook && index < 120; index++) {
      const value = hook.memoizedState;
      const manager = managerFrom(value);
      if (manager) managers.add(manager);
      if (
        value &&
        typeof value === "object" &&
        "getForHostId" in value &&
        typeof value.getForHostId === "function" &&
        "addManager" in value &&
        typeof value.addManager === "function" &&
        "waitForManagerForHostId" in value &&
        typeof value.waitForManagerForHostId === "function"
      )
        registries.add(value as RendererHostRegistry);
      hook = hook.next && typeof hook.next === "object" ? hook.next : null;
    }
  }
  return {
    editorCount: editors.length,
    hostIds: [...hostIds],
    managers: [...managers],
    registries: [...registries],
  };
}

export function resolveRendererHostManager(
  discovery: RendererHostDiscovery,
  hostId: string,
  managerFrom: typeof requestManagerFromHookState = requestManagerFromHookState,
): RendererNativeRequestManager | null {
  if (!hostId) return null;
  const candidates = discovery.registries.length
    ? discovery.registries.map((registry) => managerFrom(registry.getForHostId(hostId)))
    : discovery.managers;
  const matches = new Set(
    candidates.filter(
      (manager) =>
        manager &&
        (manager.getHostId?.() ?? manager.requestClient.hostId) === hostId &&
        (manager.requestClient.hostId === undefined || manager.requestClient.hostId === hostId),
    ),
  );
  return matches.size === 1 ? (matches.values().next().value ?? null) : null;
}
