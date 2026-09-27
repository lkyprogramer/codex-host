import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererHostRouting } from "./packages/desktop-control/src/renderer-host-routing.ts";
      import { discoverRendererHosts, resolveRendererHostManager } from "./packages/desktop-control/src/renderer-host-discovery.ts";
      import { createDraftPrewarmPolicyBridge } from "./packages/desktop-control/src/renderer-draft-prewarm-runtime.ts";
      import { committedReactAncestors } from "./packages/desktop-control/src/renderer-react-ownership.ts";
      import { installCurrentRendererAdapter } from "./packages/renderer-extension/src/versioned-renderer-adapter.ts";
      import { installRendererSettingsLifecycle } from "./packages/renderer-extension/src/renderer-settings-lifecycle.ts";
      import { installRendererBindingProbe } from "./packages/renderer-extension/src/renderer-binding-probe.ts";
      import { decodeHarnessPluginRoute } from "./packages/shared-contracts/src/index.ts";

      const updateCheck = {
        currentVersion: "1.2.2", installation: "npm", latestVersion: "1.2.3",
        updateAvailable: true, installationAvailable: true,
        releaseNotes: null, releaseNotesUrl: null, status: null, error: null,
      };

      globalThis.setupHostRouting = ({ withComposers = true, withProbe = false, conversation = false } = {}) => {
        document.body.replaceChildren();
        const app = document.createElement("div");
        app.id = "root";
        document.body.append(app);
        const calls = [];
        const entries = new Map();
        const usageByHost = new Map([["local", 11], ["remote-ssh-discovered:mac", 77]]);
        const plugin = id => ({ id, name: id, version: "1" });
        const capabilities = {
          configuration: { selectModel: false, selectThinkingOption: false,
            selectPermissionMode: false, permissionModeScope: "live" },
          history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
        };
        const registry = {
          getForHostId: hostId => entries.get(hostId),
          addManager() {},
          waitForManagerForHostId() {},
        };
        const rootFiber = { memoizedState: { memoizedState: registry }, child: null };
        rootFiber.stateNode = { current: rootFiber };
        Object.defineProperty(app, "__reactContainer$r3", { value: rootFiber });
        let lastHostFiber = null;
        let sequence = 0;
        const createManager = hostId => {
          const id = hostId + ":" + ++sequence;
          const notificationCallbacks = new Set();
          const requestClient = {
            hostId,
            sendRequest(method, params) {
              calls.push({ id, hostId, method, params });
              if (method === "codexhost/harness/plugins/list") return { plugins: withProbe
                ? hostId === "local" ? [plugin("pi"), plugin("grok")] : [plugin("pi")]
                : [] };
              if (method === "codexhost/harness/inspect") return {
                ...(hostId === "local" && params.harnessId === "pi"
                  ? { status: "notInstalled", error: {
                      code: "notInstalled", message: "Pi unavailable on local", retryable: false,
                    } }
                  : { status: "ready", catalog: { models: [], thinkingOptions: [] }, capabilities }),
              };
              if (method === "codexhost/thread/inspect") {
                const harnessId = hostId === "local" ? "grok" : "pi";
                return { owner: "external", harnessId,
                  transportModelId: hostId === "local" ? "codexhost/grok-native" : "codexhost/pi-native",
                  history: capabilities.history, locked: true,
                  usage: { cacheHitRatePercent: usageByHost.get(hostId) },
                };
              }
              if (method === "codexhost/thread/usage/inspect") return {
                threadId: params.threadId,
                usage: { cacheHitRatePercent: usageByHost.get(hostId) },
              };
              if (method === "codexhost/harness/commands/inspect") return { commands: [] };
              if (method === "codexhost/account/list" || method === "codexhost/account/refresh")
                return { accounts: [] };
              if (method === "codexhost/update/check") return updateCheck;
              if (method === "thread/start") return { thread: { id: id + ":thread" } };
              throw new Error("Unexpected native request " + method);
            },
            prewarmThreadStart: () => undefined,
            enqueueRequest: () => undefined,
            onResult: () => undefined,
            onError: () => undefined,
          };
          const manager = {
            id, getHostId: () => hostId, requestClient,
            sendRequest(method, params) { return requestClient.sendRequest(method, params); },
            addNotificationCallback(_methods, callback) {
              notificationCallbacks.add(callback);
              return () => notificationCallbacks.delete(callback);
            },
            emitUsage() {
              for (const callback of notificationCallbacks)
                callback({ method: "codexhost/thread/usage/updated", params: { threadId: "shared-thread" } });
            },
            callbacksSnapshot: () => [...notificationCallbacks],
            get callbackCount() { return notificationCallbacks.size; },
            prewarmedThreadManager: { discardAllPrewarmedThreads() {} },
            onNotification() {}, onRequest() {}, dispatchAppServerResponse() {},
          };
          entries.set(hostId, manager);
          return manager;
        };
        const addComposer = (hostId, name) => {
          const composer = document.createElement("div");
          composer.setAttribute("data-codex-composer-root", "true");
          composer.dataset.name = name;
          const editor = document.createElement("div");
          editor.setAttribute("data-codex-composer", "true");
          editor.setAttribute("contenteditable", "true");
          editor.setAttribute("role", "textbox");
          const hostFiber = { return: rootFiber, memoizedProps: { executionTargetHostId: hostId } };
          const draftId = "client-new-thread:" + name;
          const duplicateDraft = [draftId, draftId];
          const editorFiber = { return: hostFiber,
            updateQueue: { memoCache: { data: [duplicateDraft] } },
          };
          hostFiber.child = editorFiber;
          if (lastHostFiber) lastHostFiber.sibling = hostFiber;
          else rootFiber.child = hostFiber;
          lastHostFiber = hostFiber;
          Object.defineProperty(editor, "__reactFiber$r3", { value: editorFiber });
          const toolbar = document.createElement("div");
          const send = document.createElement("button");
          send.type = "submit";
          send.textContent = "Send";
          toolbar.append(send);
          composer.append(editor, toolbar);
          if (conversation && name !== "local-b") {
            const portal = document.createElement("div");
            portal.setAttribute("data-above-composer-portal", "true");
            portal.setAttribute("data-above-composer-conversation-id", "shared-thread");
            composer.append(portal);
          }
          app.append(composer);
          return composer;
        };
        const local = createManager("local");
        const remote = createManager("remote-ssh-discovered:mac");
        if (withComposers) {
          addComposer("local", "local-a");
          addComposer("remote-ssh-discovered:mac", "remote");
          addComposer("local", "local-b");
        }
        const routing = installRendererHostRouting(
          document, window, discoverRendererHosts, resolveRendererHostManager,
          createDraftPrewarmPolicyBridge, committedReactAncestors,
        );
        const adapter = installCurrentRendererAdapter();
        const probe = withProbe
          ? installRendererBindingProbe({ enabledAgents: ["codex", "pi", "grok"], defaultAgent: "codex" })
          : null;
        probe?.setAdapter(adapter.status, () => adapter.dispose(), adapter.applyAgent, adapter.modelControl);
        const state = { app, calls, entries, routing, adapter, local, remote, createManager,
          probe, usageByHost, decodeCarrier: decodeHarnessPluginRoute,
          composer: name => app.querySelector('[data-name="' + name + '"]'),
          unmountComposers: () => app.replaceChildren(),
          installSettings: () => installRendererSettingsLifecycle(window, {
            getUpdateClient: () => adapter.modelControl?.clientForHost?.("local") ?? null,
            getAccountClient: () => adapter.modelControl?.clientForHost?.("local") ?? null,
          }),
          dispose: () => { adapter.dispose(); routing.dispose(); },
        };
        globalThis.r3Routing = state;
        return state;
      };

      globalThis.setupButtonProbe = () => {
        document.body.replaceChildren();
        const composer = document.createElement("form");
        composer.setAttribute("data-codex-composer-root", "true");
        const editor = document.createElement("div");
        editor.setAttribute("data-codex-composer", "true");
        editor.setAttribute("contenteditable", "true");
        editor.setAttribute("role", "textbox");
        const modelState = { get: () => ({ isManuallyChanged: false, modelSettings: null, serviceTier: null }) };
        Object.defineProperty(editor, "__reactFiber$r3", { value: {
          updateQueue: { memoCache: { data: [
            [{}, {}, "client-new-thread:r3-button", modelState, null, modelState, modelState],
          ] } }, return: null,
        } });
        const toolbar = document.createElement("div");
        toolbar.dataset.toolbar = "old";
        const send = document.createElement("button");
        send.type = "submit";
        send.setAttribute("aria-label", "Send");
        send.textContent = "Send";
        toolbar.append(send);
        composer.append(editor, toolbar);
        document.body.append(composer);
        window.__codexhostDraftPrewarmPolicyV1 = {
          state: "ready", hostId: "local", select: () => true, clear: async () => undefined,
        };
        const binding = installRendererBindingProbe({ enabledAgents: ["codex", "pi"], defaultAgent: "pi" });
        const unavailable = async () => { throw new Error("unneeded fixture method"); };
        binding.setAdapter(
          { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
          undefined,
          () => true,
          {
            currentHostId: () => "local",
            clientForHost: () => null,
            inspectHarness: async () => ({
              status: "ready", catalog: {
                models: [{ ref: { id: "pi-model" }, label: "Pi Model" }],
                defaultModel: { id: "pi-model" }, thinkingOptions: [],
              },
              capabilities: { configuration: {
                selectModel: true, selectThinkingOption: false,
                selectPermissionMode: false, permissionModeScope: "live",
              }, history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true } },
            }),
            inspectHarnessCommands: async () => ({ commands: [{
              id: "pi.compact", invocation: "/compact", label: "Compact", argumentMode: "text",
            }] }),
            inspectThread: unavailable, forkThread: unavailable,
            inspectThreadUsage: unavailable, listThreadOwnership: unavailable,
            selectThreadModel: unavailable, selectThreadThinking: unavailable,
            selectThreadPermissionMode: unavailable, checkUpdate: unavailable,
            startUpdate: unavailable, readUpdateStatus: unavailable,
          },
        );
        let submissions = 0;
        composer.addEventListener("submit", event => { event.preventDefault(); submissions += 1; });
        const replaceButton = () => {
          const old = composer.querySelector('button[type="submit"]');
          const live = old.cloneNode(true);
          old.replaceWith(live);
          return { old, live };
        };
        const replaceFooter = () => {
          const old = composer.querySelector('[data-toolbar="old"]');
          const next = document.createElement("div");
          next.dataset.toolbar = "new";
          const live = document.createElement("button");
          live.type = "submit";
          live.setAttribute("aria-label", "Send");
          live.textContent = "Send";
          next.append(live);
          old.replaceWith(next);
          return { old, live };
        };
        globalThis.r3Button = { composer, editor, binding, replaceButton, replaceFooter,
          get submissions() { return submissions; }, dispose: () => binding.dispose() };
      };
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-host-routing-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  write: false,
});

const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Renderer Host routing E2E bundle was not generated");

test("routes local and remote Composers, then keeps live Host clients through Settings and reconnect", async ({
  page,
}, testInfo) => {
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => Reflect.get(globalThis, "setupHostRouting")());

  const initial = await page.evaluate(async () => {
    const state = Reflect.get(globalThis, "r3Routing");
    const localA = state.composer("local-a");
    const localB = state.composer("local-b");
    const remote = state.composer("remote");
    const localRoute = state.routing.forComposer(localA);
    const remoteRoute = state.routing.forComposer(remote);
    await state.adapter.modelControl.clientForHost("local").listHarnessPlugins();
    await state.adapter.modelControl
      .clientForHost("remote-ssh-discovered:mac")
      .listHarnessPlugins();
    state.adapter.applyAgent("pi", undefined, undefined, undefined, localA);
    state.adapter.applyAgent("grok", undefined, undefined, undefined, remote);
    localRoute.manager.requestClient.sendRequest("thread/start", { model: "native" });
    remoteRoute.manager.requestClient.sendRequest("thread/start", { model: "native" });
    return {
      status: state.adapter.status.state,
      sameLocal: state.routing.forComposer(localB) === localRoute,
      remoteDistinct: remoteRoute !== localRoute,
      noDefaultRoute: state.routing.forComposer() === null,
      sends: state.calls
        .filter((call: { method: string }) => call.method === "thread/start")
        .map((call: { hostId: string; params: { model: string } }) => ({
          hostId: call.hostId,
          harnessId: state.decodeCarrier(call.params.model)?.harnessId ?? null,
        })),
    };
  });
  expect(initial.status).toBe("ready");
  expect(initial.sameLocal).toBe(true);
  expect(initial.remoteDistinct).toBe(true);
  expect(initial.noDefaultRoute).toBe(true);
  expect(initial.sends).toEqual([
    { hostId: "local", harnessId: "pi" },
    { hostId: "remote-ssh-discovered:mac", harnessId: "grok" },
  ]);
  await page.screenshot({ path: testInfo.outputPath("r3-multiple-composers.png") });

  const afterSettings = await page.evaluate(async () => {
    const state = Reflect.get(globalThis, "r3Routing");
    const localClient = state.adapter.modelControl.clientForHost("local");
    state.unmountComposers();
    await localClient.listHarnessPlugins();
    await state.adapter.modelControl
      .clientForHost("remote-ssh-discovered:mac")
      .listHarnessPlugins();
    return {
      noComposerRoute: state.routing.forComposer() === null,
      noSendWithoutComposer: state.adapter.applyAgent("pi") === false,
      stableLocal: state.adapter.modelControl.clientForHost("local") === localClient,
    };
  });
  expect(afterSettings.noComposerRoute).toBe(true);
  expect(afterSettings.noSendWithoutComposer).toBe(true);
  expect(afterSettings.stableLocal).toBe(true);

  const reconnection = await page.evaluate(async () => {
    const state = Reflect.get(globalThis, "r3Routing");
    const old = state.adapter.modelControl.clientForHost("local");
    state.entries.delete("local");
    let staleRejected = false;
    try {
      await old.listHarnessPlugins();
    } catch {
      staleRejected = true;
    }
    const absent = state.adapter.modelControl.clientForHost("local") === null;
    const replacement = state.createManager("local");
    const live = state.adapter.modelControl.clientForHost("local");
    await live.listHarnessPlugins();
    let oldStillRejected = false;
    try {
      await old.listHarnessPlugins();
    } catch {
      oldStillRejected = true;
    }
    return {
      staleRejected,
      absent,
      oldStillRejected,
      replaced: live !== old,
      requestId: state.calls.at(-1)?.id,
      expectedId: replacement.id,
    };
  });
  expect(reconnection).toEqual({
    staleRejected: true,
    absent: true,
    oldStillRejected: true,
    replaced: true,
    requestId: reconnection.expectedId,
    expectedId: reconnection.expectedId,
  });
});

test("Settings lifecycle checks updates through the local Host with no Composer", async ({
  page,
}) => {
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => {
    const state = Reflect.get(globalThis, "setupHostRouting")({ withComposers: false });
    state.settings = state.installSettings();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Reflect.get(globalThis, "r3Routing").calls.filter(
            (call: { method: string }) => call.method === "codexhost/update/check",
          ).length,
      ),
    )
    .toBe(1);
  expect(await page.evaluate(() => Reflect.get(globalThis, "r3Routing").adapter.status.state)).toBe(
    "ready",
  );
});

test("adapter disposal clears the current Host carrier after a manager reconnect", async ({
  page,
}) => {
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: browserBundle });
  const result = await page.evaluate(() => {
    const state = Reflect.get(globalThis, "setupHostRouting")();
    const composer = state.composer("local-a");
    state.adapter.applyAgent("pi", undefined, undefined, undefined, composer);
    const old = state.routing.forComposer(composer);
    state.createManager("local");
    const replacement = state.routing.forComposer(composer);
    state.adapter.applyAgent("grok", undefined, undefined, undefined, composer);
    state.adapter.dispose();
    replacement.manager.requestClient.sendRequest("thread/start", { model: "native" });
    return {
      replaced: replacement !== old,
      submittedModel: state.calls.at(-1)?.params?.model,
    };
  });
  expect(result).toEqual({ replaced: true, submittedModel: "native" });
});

test("keeps remote Pi selectable when local Pi is unavailable and catalogs differ", async ({
  page,
}) => {
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => Reflect.get(globalThis, "setupHostRouting")({ withProbe: true }));
  const localPicker = page.locator('[data-name="local-a"] [data-codexhost-agent-control]');
  const remotePicker = page.locator('[data-name="remote"] [data-codexhost-agent-control]');
  await expect(localPicker).toHaveCount(1);
  await expect(remotePicker).toHaveCount(1);

  await localPicker.getByRole("button", { name: /Select Agent/u }).click();
  await expect(page.getByRole("menuitemradio", { name: /Pi/iu })).toBeDisabled();
  await expect(page.getByRole("menuitemradio", { name: /Grok/iu })).toBeEnabled();
  await page.keyboard.press("Escape");
  await remotePicker.getByRole("button", { name: /Select Agent/u }).click();
  await expect(page.getByRole("menuitemradio", { name: /Pi/iu })).toBeEnabled();
  await expect(page.getByRole("menuitemradio", { name: /Grok/iu })).toHaveCount(0);
  await page.getByRole("menuitemradio", { name: /Pi/iu }).click();
  await expect(remotePicker.getByRole("button", { name: /Select Agent/u })).toHaveAttribute(
    "aria-label",
    /Pi/iu,
  );
});

test("keeps same Thread Usage isolated by Host and drops retired notifications", async ({
  page,
}) => {
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() =>
    Reflect.get(globalThis, "setupHostRouting")({ withProbe: true, conversation: true }),
  );
  const localUsage = page.locator('[data-name="local-a"] [data-codexhost-usage-control]');
  const remoteUsage = page.locator('[data-name="remote"] [data-codexhost-usage-control]');
  await expect(localUsage).toContainText("CH 11%");
  await expect(remoteUsage).toContainText("CH 77%");

  await page.evaluate(() => {
    const state = Reflect.get(globalThis, "r3Routing");
    state.usageByHost.set("local", 33);
    state.local.emitUsage();
  });
  await expect(localUsage).toContainText("CH 33%");
  await expect(remoteUsage).toContainText("CH 77%");

  const oldCount = await page.evaluate(() => {
    const state = Reflect.get(globalThis, "r3Routing");
    state.oldRemote = state.remote;
    state.oldRemoteCallbacks = state.remote.callbacksSnapshot();
    state.remote = state.createManager("remote-ssh-discovered:mac");
    window.dispatchEvent(new Event("focus"));
    return state.oldRemoteCallbacks.length;
  });
  expect(oldCount).toBe(1);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, "r3Routing").remote.callbackCount))
    .toBe(1);
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "r3Routing").oldRemote.callbackCount),
  ).toBe(0);
  await page.evaluate(() => {
    const state = Reflect.get(globalThis, "r3Routing");
    state.usageByHost.set("remote-ssh-discovered:mac", 99);
    for (const callback of state.oldRemoteCallbacks)
      callback({ method: "codexhost/thread/usage/updated", params: { threadId: "shared-thread" } });
  });
  await expect(remoteUsage).toContainText("CH 77%");
  await page.evaluate(() => Reflect.get(globalThis, "r3Routing").remote.emitUsage());
  await expect(remoteUsage).toContainText("CH 99%");
  await expect(localUsage).toContainText("CH 33%");
});

test("a mounted menu survives a live Send replacement and follows its new button", async ({
  page,
}, testInfo) => {
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => Reflect.get(globalThis, "setupButtonProbe")());
  const trigger = page.locator("[data-codexhost-harness-command-control] > button");
  await expect(trigger).toBeEnabled();
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  await trigger.click();
  const menu = page.locator("[data-codexhost-delegation-mention-menu]");
  await expect(menu).toBeVisible();
  await page.evaluate(() => {
    const state = Reflect.get(globalThis, "r3Button");
    state.oldButton = state.replaceButton().old;
  });
  await expect(menu).toBeVisible();
  await expect(page.locator("[data-codexhost-harness-command-control]")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("r3-rebound-menu.png") });
  await page.evaluate(() => {
    const state = Reflect.get(globalThis, "r3Button");
    state.oldButton.click();
    state.composer.querySelector('button[type="submit"]').click();
  });
  expect(await page.evaluate(() => Reflect.get(globalThis, "r3Button").submissions)).toBe(1);
});

test("a mounted menu stays open when the native footer is replaced", async ({ page }) => {
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => Reflect.get(globalThis, "setupButtonProbe")());
  const trigger = page.locator("[data-codexhost-harness-command-control] > button");
  await expect(trigger).toBeEnabled();
  await trigger.click();
  const menu = page.locator("[data-codexhost-delegation-mention-menu]");
  await expect(menu).toBeVisible();
  await page.evaluate(() => Reflect.get(globalThis, "r3Button").replaceFooter());
  await expect(menu).toBeVisible();
  await expect(page.locator("[data-codexhost-harness-command-control]")).toHaveCount(1);
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(1);
});
