import type {
  HarnessAdapter,
  HarnessOwnedJobsResult,
  HarnessResourceLifecycle,
  HarnessSession,
} from "@codexhost/harness-adapter";
import type { HarnessSessionCapabilities } from "@codexhost/shared-contracts";

type LegacyOwnedJobs = (session: HarnessSession) => Promise<HarnessOwnedJobsResult>;

/**
 * Presents a plugin built against Adapter API version 1 through the current
 * contract. Version 1 declared no native resources: its Sessions release on
 * idle when they implement `resourceLifecycle`, and an Adapter-level
 * `stopOwnedJobs(session)` stops their owned jobs. The Host reads only the
 * declarations this derives.
 */
export function legacyPluginAdapter(adapter: HarnessAdapter): HarnessAdapter {
  const stopOwnedJobs = (adapter as { stopOwnedJobs?: unknown }).stopOwnedJobs;
  const legacyOwnedJobs =
    typeof stopOwnedJobs === "function"
      ? (stopOwnedJobs as LegacyOwnedJobs).bind(adapter)
      : undefined;
  return new Proxy(adapter, {
    get(target, property) {
      if (property === "open") {
        return async (...input: Parameters<HarnessAdapter["open"]>) => {
          const opened = await target.open(...input);
          return opened.ok
            ? { ok: true as const, value: declaredSession(opened.value, legacyOwnedJobs) }
            : opened;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function declaredSession(
  session: HarnessSession,
  legacyOwnedJobs: LegacyOwnedJobs | undefined,
): HarnessSession {
  // An invalid Session is left as is for validation to reject.
  if (typeof session !== "object" || session === null) return session;
  if ((session.capabilities as { resources?: unknown } | undefined)?.resources) return session;
  return new Proxy(session, {
    get(target, property) {
      if (property === "capabilities") {
        const capabilities: HarnessSessionCapabilities = target.capabilities;
        const lifecycle = legacyOwnedJobs !== undefined || target.resourceLifecycle !== undefined;
        return {
          ...capabilities,
          resources: { idleRelease: lifecycle, ownedJobs: legacyOwnedJobs !== undefined },
        };
      }
      if (property === "resourceLifecycle") {
        const lifecycle = target.resourceLifecycle;
        if (!legacyOwnedJobs) return lifecycle;
        const withOwnedJobs: HarnessResourceLifecycle = {
          // Version 1 stopped owned jobs whether or not the Session also
          // released on idle.
          suspend: lifecycle
            ? (signal) => lifecycle.suspend(signal)
            : () => Promise.resolve({ status: "unsupported" }),
          stopOwnedJobs: () => legacyOwnedJobs(target),
        };
        return withOwnedJobs;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
