import type { CdpClient } from "./cdp-client.js";
import { createDraftPrewarmPolicyBridge } from "./renderer-draft-prewarm-runtime.js";
import { committedReactAncestors } from "./renderer-react-ownership.js";
import {
  discoverRendererHosts,
  requestManagerFromHookState,
  resolveRendererHostManager,
} from "./renderer-host-discovery.js";
import { installRendererHostRouting } from "./renderer-host-routing.js";
export { requestManagerFromHookState } from "./renderer-host-discovery.js";

interface InspectorEvaluator {
  evaluate<T>(expression: string): Promise<T>;
}

export interface RendererDraftPrewarmPolicyStatus {
  state: "ready";
  reason: "owned-request-bridge";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const REQUEST_MANAGER_WAIT_TIMEOUT_MS = 60_000;
const REQUEST_MANAGER_POLL_INTERVAL_MS = 25;

function directRendererInstaller(): string {
  return `(() => {
    const committedReactAncestors = ${committedReactAncestors.toString()};
    const requestManagerFromHookState = ${requestManagerFromHookState.toString()};
    const discoverRendererHosts = ${discoverRendererHosts.toString()};
    const resolveRendererHostManager = ${resolveRendererHostManager.toString()};
    const createDraftPrewarmPolicyBridge = ${createDraftPrewarmPolicyBridge.toString()};
    const discover = (root) => discoverRendererHosts(root, committedReactAncestors, requestManagerFromHookState);
    const discovery = discover(document);
    if (!window.__codexhostHostRoutingV1 && discovery.managers.length === 0 && discovery.registries.length === 0) {
      throw new Error('Renderer request manager is ambiguous');
    }
    const routing = (${installRendererHostRouting.toString()})(document, window, discover,
      (state, hostId) => resolveRendererHostManager(state, hostId, requestManagerFromHookState),
      createDraftPrewarmPolicyBridge, committedReactAncestors);
    routing.forComposer();
    return { state: 'ready', reason: 'owned-request-bridge' };
  })()`;
}

function mainProcessInstaller(rendererWebContentsId: number): string {
  return `async function () {
    const mainModule = process.mainModule;
    const electron = mainModule != null && typeof mainModule.require === 'function'
      ? mainModule.require('electron')
      : process.getBuiltinModule('module').createRequire(process.execPath)('electron');
    const contents = electron.webContents.fromId(${rendererWebContentsId});
    if (!contents || contents.isDestroyed() || contents.getType() !== 'window') {
      throw new Error('Owned Renderer is unavailable for draft prewarm policy');
    }
    return contents.executeJavaScript(${JSON.stringify(directRendererInstaller())});
  }`;
}

async function waitForDraftPrewarmPolicy(
  evaluate: (expression: string) => Promise<unknown>,
  expression: string,
): Promise<RendererDraftPrewarmPolicyStatus> {
  const deadline = Date.now() + REQUEST_MANAGER_WAIT_TIMEOUT_MS;
  while (true) {
    try {
      const value = await evaluate(expression);
      if (!isRecord(value) || value.state !== "ready" || value.reason !== "owned-request-bridge") {
        throw new Error("Renderer draft prewarm policy returned an invalid status");
      }
      return value as unknown as RendererDraftPrewarmPolicyStatus;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const remaining = deadline - Date.now();
      if (!message.includes("Renderer request manager is ambiguous") || remaining <= 0) throw error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(REQUEST_MANAGER_POLL_INTERVAL_MS, remaining));
      });
    }
  }
}

export function installRendererDraftPrewarmPolicyDirect(
  renderer: Pick<CdpClient, "evaluate"> | InspectorEvaluator,
): Promise<RendererDraftPrewarmPolicyStatus> {
  return waitForDraftPrewarmPolicy(
    (expression) => renderer.evaluate<unknown>(expression),
    directRendererInstaller(),
  );
}

export async function installRendererDraftPrewarmPolicy(
  inspector: Pick<CdpClient, "evaluate"> | InspectorEvaluator,
  rendererWebContentsId: number,
): Promise<RendererDraftPrewarmPolicyStatus> {
  if (!Number.isInteger(rendererWebContentsId) || rendererWebContentsId <= 0) {
    throw new Error("Renderer webContents ID must be a positive integer");
  }
  const installer = mainProcessInstaller(rendererWebContentsId);
  return waitForDraftPrewarmPolicy(
    (expression) => inspector.evaluate<unknown>(expression),
    `(${installer})()`,
  );
}
