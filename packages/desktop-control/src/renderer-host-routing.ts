import type { committedReactAncestors } from "./renderer-react-ownership.js";
import type {
  discoverRendererHosts,
  resolveRendererHostManager,
  RendererHostDiscovery,
  RendererHostRoot,
  RendererNativeRequestManager,
} from "./renderer-host-discovery.js";
import type {
  createDraftPrewarmPolicyBridge,
  DraftPrewarmPolicyTarget,
  RendererDraftBridgePolicy,
} from "./renderer-draft-prewarm-runtime.js";

export interface RendererHostRoute {
  readonly hostId: string;
  readonly manager: RendererNativeRequestManager;
  readonly policy: RendererDraftBridgePolicy;
}
export interface RendererHostRouting {
  forHost(hostId: string): RendererHostRoute | null;
  hostIdForComposer(composer?: RendererHostRoot): string | null;
  forComposer(composer?: RendererHostRoot): RendererHostRoute | null;
  committedAncestors: typeof committedReactAncestors;
  dispose(): void;
}

/** Cache owned hooks, while native registries remain authoritative for connection identity. */
export function installRendererHostRouting(
  root: RendererHostRoot,
  target: DraftPrewarmPolicyTarget,
  discover: typeof discoverRendererHosts,
  resolve: typeof resolveRendererHostManager,
  createPolicy: typeof createDraftPrewarmPolicyBridge,
  ancestors: typeof committedReactAncestors,
): RendererHostRouting {
  const installed = target.__codexhostHostRoutingV1 as RendererHostRouting | undefined;
  if (installed) return installed;
  (target.__codexhostDraftPrewarmPolicyV1 as RendererDraftBridgePolicy | undefined)?.dispose();
  let disposed = false;
  let previousDiscovery: RendererHostDiscovery | undefined;
  const connections = new Map<
    string,
    {
      route: RendererHostRoute;
      bridge: RendererNativeRequestManager["requestClient"];
      prewarmed: RendererNativeRequestManager["prewarmedThreadManager"];
    }
  >();
  const read = (composer?: RendererHostRoot): RendererHostDiscovery => {
    const discovery = discover(composer ?? root);
    if (!composer && (discovery.editorCount > 0 || discovery.registries.length > 0))
      previousDiscovery = discovery;
    return discovery;
  };
  const hostDiscovery = (): RendererHostDiscovery => {
    const discovery = read();
    // Retain registries while Settings replaces all Composers, but query their live entries.
    // Without a registry there is no independent evidence that an unmounted owner is live.
    return discovery.editorCount === 0 && previousDiscovery?.registries.length
      ? { ...previousDiscovery, managers: [] }
      : discovery;
  };
  const lookup = (
    hostId: string,
    discovery?: RendererHostDiscovery,
  ): RendererNativeRequestManager | null => {
    if (disposed) return null;
    try {
      return resolve(discovery ?? hostDiscovery(), hostId);
    } catch {
      return null;
    }
  };
  const retire = (hostId: string): void => {
    const entry = connections.get(hostId);
    connections.delete(hostId);
    entry?.route.policy.dispose();
  };
  const routeFor = (
    hostId: string,
    discovery?: RendererHostDiscovery,
  ): RendererHostRoute | null => {
    if (!hostId) return null;
    const manager = lookup(hostId, discovery);
    const previous = connections.get(hostId);
    if (
      manager &&
      previous?.route.manager === manager &&
      previous.bridge === manager.requestClient &&
      previous.prewarmed === manager.prewarmedThreadManager &&
      previous.route.policy.owns(
        manager,
        manager.requestClient,
        hostId,
        manager.prewarmedThreadManager,
      )
    )
      return previous.route;
    retire(hostId);
    if (!manager) return null;
    const bridge = manager.requestClient;
    const prewarmed = manager.prewarmedThreadManager;
    const policy = createPolicy(
      manager,
      bridge,
      hostId,
      target,
      prewarmed,
      () =>
        lookup(hostId) === manager &&
        manager.requestClient === bridge &&
        manager.prewarmedThreadManager === prewarmed,
    );
    const route = { hostId, manager, policy };
    connections.set(hostId, { route, bridge, prewarmed });
    return route;
  };
  const hostFor = (discovery: RendererHostDiscovery): string | null => {
    if (discovery.editorCount === 0) return null;
    if (!discovery.hostIds.length && discovery.registries.length) return null;
    const hosts = new Set(
      discovery.hostIds.length
        ? discovery.hostIds
        : discovery.managers.map(
            (manager) => manager.getHostId?.() ?? manager.requestClient.hostId,
          ),
    );
    const id = hosts.size === 1 ? hosts.values().next().value : undefined;
    return typeof id === "string" && id.length > 0 ? id : null;
  };
  const publish = (route: RendererHostRoute | null): void => {
    if (target.__codexhostDraftPrewarmPolicyV1 === route?.policy) return;
    Object.defineProperty(target, "__codexhostDraftPrewarmPolicyV1", {
      configurable: true,
      value: route?.policy,
    });
    if (typeof target.dispatchEvent === "function" && typeof CustomEvent === "function")
      target.dispatchEvent(new CustomEvent("codexhost:draft-prewarm-policy-changed"));
  };
  const routing: RendererHostRouting = {
    committedAncestors: ancestors,
    forHost: (hostId) => routeFor(hostId),
    hostIdForComposer(composer) {
      if (disposed) return null;
      try {
        return hostFor(read(composer));
      } catch {
        return null;
      }
    },
    forComposer(composer) {
      if (disposed) return null;
      let route: RendererHostRoute | null = null;
      try {
        const discovery = read(composer);
        const hostId = hostFor(discovery);
        route = hostId ? routeFor(hostId, discovery) : null;
      } catch {
        /* A transient/unmounted React owner cannot select a send route. */
      }
      if (!composer) publish(route);
      return route;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const hostId of connections.keys()) retire(hostId);
      previousDiscovery = undefined;
      if (target.__codexhostHostRoutingV1 === routing) {
        delete target.__codexhostHostRoutingV1;
        publish(null);
      }
    },
  };
  Object.defineProperty(target, "__codexhostHostRoutingV1", { configurable: true, value: routing });
  return routing;
}
