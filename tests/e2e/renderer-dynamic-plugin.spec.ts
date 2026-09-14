import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererBindingProbe } from "./packages/renderer-extension/src/renderer-binding-probe.ts";

      const composer = document.createElement("div");
      composer.setAttribute("data-codex-composer-root", "true");
      const editor = document.createElement("div");
      editor.setAttribute("data-codex-composer", "true");
      editor.setAttribute("contenteditable", "true");
      editor.setAttribute("role", "textbox");
      const modelState = {
        atom: {}, get: () => ({ isManuallyChanged: false, modelSettings: null }), set: () => undefined,
      };
      Object.defineProperty(editor, "__reactFiber$dynamic", {
        configurable: true,
        value: {
          updateQueue: {
            memoCache: {
              data: [[undefined, modelState, modelState], [{}, {}, "client-new-thread:dynamic", modelState, undefined, modelState, modelState]],
            },
          },
          return: null,
        },
      });
      const toolbar = document.createElement("div");
      const send = document.createElement("button");
      send.type = "submit";
      toolbar.append(send);
      const portal = document.createElement("div");
      portal.setAttribute("data-above-composer-portal", "true");
      composer.append(editor, portal, toolbar);
      document.body.append(composer);

      window.__codexhostDraftPrewarmPolicyV1 = {
        state: "ready", hostId: "local", select: () => true, clear: async () => undefined,
      };
      globalThis.dynamicApplied = [];
      const binding = installRendererBindingProbe({ defaultAgent: "codex" });
      binding.setAdapter(
        { state: "ready", reason: "ready", modelUpdates: 0, hook: "model-state" },
        undefined,
        (agent, model, thinkingOptionId, permissionModeId) => {
          globalThis.dynamicApplied.push({ agent, model, thinkingOptionId, permissionModeId });
          return true;
        },
        {
          listHarnessPlugins: async () => ({
            plugins: [{
              id: "future-harness", name: "Future Harness", version: "1",
              icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLqWQAAAABJRU5ErkJggg==",
              links: { installation: "https://example.test/future" },
            }],
          }),
          inspectHarness: async () => ({
            status: "ready", catalog: { models: [], thinkingOptions: [] },
            capabilities: {
              configuration: {
                selectModel: false, selectThinkingOption: false, selectPermissionMode: false,
                permissionModeScope: "live",
              },
              history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
            },
          }),
          inspectThread: async () => { throw new Error("unused"); },
          forkThread: async () => { throw new Error("unused"); },
          inspectThreadUsage: async () => { throw new Error("unused"); },
          subscribeThreadUsage: () => () => undefined,
          listThreadOwnership: async () => ({ threads: [] }),
          inspectHarnessCommands: async () => ({ commands: [] }),
          inspectThreadCommands: async () => ({ commands: [] }),
          executeThreadCommand: async () => ({ status: "accepted" }),
          selectThreadModel: async () => ({}),
          selectThreadThinking: async () => ({}),
          selectThreadPermissionMode: async () => ({}),
          checkUpdate: async () => ({}), startUpdate: async () => ({}), readUpdateStatus: async () => ({}),
          listCodexAccounts: async () => ({ accounts: [] }), refreshCodexAccounts: async () => ({ accounts: [] }),
          createCodexAccount: async () => ({}), deleteCodexAccount: async () => ({}),
          activateCodexAccount: async () => ({}), startCodexAccountLogin: async () => ({}),
          cancelCodexAccountLogin: async () => ({}), subscribeCodexAccountLogin: () => () => undefined,
        },
      );
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-dynamic-plugin-e2e-entry.ts",
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
if (!browserBundle) throw new Error("Renderer dynamic plugin E2E bundle was not generated");

test("keeps default Codex transparent while switching an unknown fixed-model Harness", async ({
  page,
}) => {
  await page.route("https://codexhost.test/**", async (route) => {
    await route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" });
  });
  await page.goto("https://codexhost.test/");
  await page.addScriptTag({ content: browserBundle });

  await expect
    .poll(() =>
      page.evaluate(() => {
        const editor = document.querySelector("[data-codex-composer]");
        const send = document.querySelector('button[type="submit"]');
        if (!(editor instanceof HTMLElement) || !(send instanceof HTMLElement)) return null;
        const beforeInput = new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "x",
          inputType: "insertText",
        });
        const enter = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        });
        const click = new MouseEvent("click", { bubbles: true, cancelable: true });
        return {
          beforeInput: editor.dispatchEvent(beforeInput),
          enter: editor.dispatchEvent(enter),
          click: send.dispatchEvent(click),
        };
      }),
    )
    .toEqual({ beforeInput: true, enter: true, click: true });

  const picker = page.locator("[data-codexhost-agent-control]");
  await expect(picker.getByRole("button", { name: /Select Agent/u })).toBeVisible();
  await picker.getByRole("button", { name: /Select Agent/u }).click();
  await expect(picker.getByRole("menuitemradio", { name: "Future Harness" })).toBeVisible();
  await picker.getByRole("menuitemradio", { name: "Future Harness" }).click();

  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, "dynamicApplied")))
    .toContainEqual({
      agent: "future-harness",
      model: undefined,
      thinkingOptionId: undefined,
      permissionModeId: undefined,
    });
  await expect
    .poll(() =>
      page.evaluate(() => (Reflect.get(globalThis, "dynamicApplied") as unknown[]).length),
    )
    .toBeGreaterThanOrEqual(2);
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  await expect(picker).toContainText("Future Harness");

  expect(
    await page.evaluate(() => {
      const editor = document.querySelector("[data-codex-composer]");
      const send = document.querySelector('button[type="submit"]');
      const composer = document.querySelector("[data-codex-composer-root]");
      if (!(editor instanceof HTMLElement) || !(send instanceof HTMLElement) || !composer)
        return null;
      return {
        enter: editor.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Enter",
          }),
        ),
        click: send.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
        submit: composer.dispatchEvent(
          new SubmitEvent("submit", { bubbles: true, cancelable: true }),
        ),
      };
    }),
  ).toEqual({ enter: true, click: true, submit: true });
  expect(
    await page.evaluate(() =>
      (Reflect.get(globalThis, "dynamicApplied") as Array<{ agent: string }>).at(-1),
    ),
  ).toMatchObject({ agent: "future-harness" });

  await picker.getByRole("button", { name: /Select Agent/u }).click();
  await picker.getByRole("menuitemradio", { name: "Codex" }).dispatchEvent("click");
  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, "dynamicApplied")))
    .toContainEqual({
      agent: "codex",
      model: undefined,
      thinkingOptionId: undefined,
      permissionModeId: undefined,
    });
});
