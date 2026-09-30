import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const screenshotDirectory = path.resolve(import.meta.dirname, "../../docs/upstream-r4/screenshots");
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createRendererModelClient } from "./packages/renderer-extension/src/renderer-model-client.ts";
      import { createDefaultRendererSettingsRegistry } from "./packages/renderer-extension/src/settings/pages.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";
      import { mountRendererSettingsShell } from "./packages/renderer-extension/src/settings/shell.ts";

      globalThis.setupResources = () => {
        const now = Date.UTC(2026, 8, 26, 10, 0);
        let connected = true;
        let rejectRequest = false;
        let pending = false;
        const pendingResolvers = [];
        let sessions = [];
        const calls = [];
        const messages = rendererSettingsMessages("en");
        const getClient = () => connected ? createRendererModelClient([{ sendRequest: async (method, params) => {
          calls.push({ method, params });
          if (rejectRequest) throw new Error("transport disconnected");
          if (pending) return new Promise(resolve => pendingResolvers.push(resolve));
          return { sessions };
        }}]) : null;
        const registry = createDefaultRendererSettingsRegistry(
          messages, () => null, () => null, () => null, () => null, undefined, getClient,
        );
        const shell = mountRendererSettingsShell(registry, document, messages);
        shell.openSettings(undefined, "resources");
        globalThis.resourcesFixture = {
          calls,
          now,
          setSessions(value) { sessions = value; },
          setConnected(value) { connected = value; },
          setRejectRequest(value) { rejectRequest = value; },
          setPending(value) { pending = value; },
          resolvePending(value) { for (const resolve of pendingResolvers.splice(0)) resolve({ sessions: value }); },
          open() { shell.openSettings(undefined, "resources"); },
          dispose() { shell.dispose(); },
        };
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "settings-resources-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  write: false,
});
const bundle = outputFiles[0]?.text ?? "";
if (!bundle) throw new Error("Resources settings fixture bundle missing");

async function setup(page: Page, width = 1280): Promise<void> {
  await page.setViewportSize({ width, height: 760 });
  await page.route("http://localhost/resources-test", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
  );
  await page.goto("http://localhost/resources-test");
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => Reflect.get(globalThis, "setupResources")());
  await expect(page.locator('.settings-resources-status[data-state="empty"]')).toBeVisible();
}

async function refresh(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Refresh" }).click();
}

test("shows cached local lifecycle observations and historical releases", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const fixture = Reflect.get(globalThis, "resourcesFixture");
    fixture.setSessions([
      {
        threadId: "thread-loaded",
        harnessId: "pi",
        running: true,
        resourceState: "loaded",
        lastActivityAt: fixture.now,
        lastRelease: { status: "busy", observedAt: fixture.now - 1000 },
      },
      {
        threadId: "thread-unknown",
        harnessId: "grok",
        running: false,
        resourceState: "unavailable",
        lastActivityAt: fixture.now,
        lastRelease: { status: "unknown", observedAt: fixture.now - 1000 },
      },
      {
        threadId: "thread-failed",
        harnessId: "claude-code",
        running: false,
        resourceState: "loaded",
        lastActivityAt: fixture.now,
        lastRelease: { status: "releaseFailed", observedAt: fixture.now - 1000 },
      },
      {
        threadId: "thread-suspended",
        harnessId: "pi",
        running: false,
        resourceState: "suspended",
        lastActivityAt: fixture.now,
        lastRelease: { status: "suspended", observedAt: fixture.now - 1000 },
      },
    ]);
  });
  await refresh(page);
  await expect(page.locator(".settings-resource-row")).toHaveCount(4);
  await expect(page.locator(".settings-resource-row").first()).toContainText(
    "Last release (historical): Busy",
  );
  await expect(page.locator(".settings-resource-row").nth(1)).toContainText("Unknown");
  await expect(page.locator(".settings-resource-row").nth(2)).toContainText("Release failed");
  await expect(page.locator(".settings-resource-row").nth(3)).toContainText(
    "Native resource released",
  );
  await expect(page.locator(".settings-page__content")).toContainText("Local Host only");
  const calls = await page.evaluate(() => Reflect.get(globalThis, "resourcesFixture").calls);
  expect(calls).toEqual([
    { method: "codexhost/resources/list", params: {} },
    { method: "codexhost/resources/list", params: {} },
  ]);
  expect(await page.getByRole("button").allTextContents()).not.toContain("Release");
});

test("shows empty, disconnected and failed reads without stale rows", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const fixture = Reflect.get(globalThis, "resourcesFixture");
    fixture.setSessions([
      {
        threadId: "thread-1",
        harnessId: "pi",
        running: true,
        resourceState: "loaded",
        lastActivityAt: fixture.now,
        lastRelease: null,
      },
    ]);
  });
  await refresh(page);
  await expect(page.locator(".settings-resource-row")).toHaveCount(1);
  await page.evaluate(() => Reflect.get(globalThis, "resourcesFixture").setConnected(false));
  await refresh(page);
  await expect(page.locator('.settings-resources-status[data-state="unavailable"]')).toBeVisible();
  await expect(page.locator(".settings-resource-row")).toHaveCount(0);
  mkdirSync(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDirectory, "resources-disconnected.png") });
  await page.evaluate(() => {
    const fixture = Reflect.get(globalThis, "resourcesFixture");
    fixture.setConnected(true);
    fixture.setRejectRequest(true);
  });
  await refresh(page);
  await expect(page.locator('.settings-resources-status[data-state="error"]')).toBeVisible();
  await expect(page.locator(".settings-resource-row")).toHaveCount(0);
});

test("refresh recovers while a request hangs and ignores late responses after close", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => Reflect.get(globalThis, "resourcesFixture").setPending(true));
  await refresh(page);
  await expect(page.locator('.settings-resources-status[data-state="loading"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh" })).toBeEnabled();
  await page.evaluate(() => Reflect.get(globalThis, "resourcesFixture").setConnected(false));
  await refresh(page);
  await expect(page.locator('.settings-resources-status[data-state="unavailable"]')).toBeVisible();
  await page.evaluate(() => {
    const fixture = Reflect.get(globalThis, "resourcesFixture");
    fixture.resolvePending([
      {
        threadId: "stale",
        harnessId: "pi",
        running: true,
        resourceState: "loaded",
        lastActivityAt: fixture.now,
        lastRelease: null,
      },
    ]);
  });
  await expect(page.locator(".settings-resource-row")).toHaveCount(0);
  await page.evaluate(() => {
    const fixture = Reflect.get(globalThis, "resourcesFixture");
    fixture.setConnected(true);
    fixture.setPending(false);
    fixture.setSessions([
      {
        threadId: "fresh",
        harnessId: "pi",
        running: false,
        resourceState: "historyOnly",
        lastActivityAt: fixture.now,
        lastRelease: null,
      },
    ]);
  });
  await refresh(page);
  await expect(page.locator(".settings-resource-row")).toContainText("fresh");

  await page.evaluate(() => Reflect.get(globalThis, "resourcesFixture").setPending(true));
  await refresh(page);
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.locator(".codexhost-settings-dialog")).not.toBeVisible();
  await page.evaluate(() => {
    const fixture = Reflect.get(globalThis, "resourcesFixture");
    fixture.resolvePending([
      {
        threadId: "late",
        harnessId: "pi",
        running: true,
        resourceState: "loaded",
        lastActivityAt: fixture.now,
        lastRelease: null,
      },
    ]);
    fixture.setPending(false);
    fixture.open();
  });
  await expect(page.locator(".settings-resource-row")).toContainText("fresh");
  await expect(page.locator(".settings-resource-row")).not.toContainText("late");
});

test("times out a nonresponsive Host read and permits retry", async ({ page }) => {
  await setup(page);
  await page.clock.install();
  await page.evaluate(() => Reflect.get(globalThis, "resourcesFixture").setPending(true));
  await refresh(page);
  await expect(page.locator('.settings-resources-status[data-state="loading"]')).toBeVisible();
  await page.clock.fastForward(15_001);
  await expect(page.locator('.settings-resources-status[data-state="error"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh" })).toBeEnabled();
  await page.evaluate(() => {
    const fixture = Reflect.get(globalThis, "resourcesFixture");
    fixture.resolvePending([
      {
        threadId: "late",
        harnessId: "pi",
        running: true,
        resourceState: "loaded",
        lastActivityAt: fixture.now,
        lastRelease: null,
      },
    ]);
    fixture.setPending(false);
    fixture.setSessions([
      {
        threadId: "retried",
        harnessId: "pi",
        running: false,
        resourceState: "historyOnly",
        lastActivityAt: fixture.now,
        lastRelease: null,
      },
    ]);
  });
  await expect(page.locator(".settings-resource-row")).toHaveCount(0);
  await refresh(page);
  await expect(page.locator(".settings-resource-row")).toContainText("retried");
});

test("keeps a long list usable in a narrow Chrome window", async ({ page }) => {
  await setup(page, 480);
  await page.evaluate(() => {
    const fixture = Reflect.get(globalThis, "resourcesFixture");
    fixture.setSessions(
      Array.from({ length: 35 }, (_, index) => ({
        threadId: `thread-${index}-with-a-long-identifier-0123456789`,
        harnessId: "claude-code",
        running: index === 0,
        resourceState: index === 0 ? "loaded" : "historyOnly",
        lastActivityAt: fixture.now,
        lastRelease: null,
      })),
    );
  });
  await refresh(page);
  await expect(page.locator(".settings-resource-row")).toHaveCount(35);
  const dimensions = await page.evaluate(() => {
    const root = document.querySelector("[data-codexhost-settings-shell]");
    const main = root?.shadowRoot?.querySelector(".settings-page");
    const list = root?.shadowRoot?.querySelector(".settings-resources-list");
    if (!(main instanceof HTMLElement) || !(list instanceof HTMLElement)) return null;
    return {
      horizontalOverflow: main.scrollWidth > main.clientWidth,
      verticalScroll: main.scrollHeight > main.clientHeight,
      listWidth: list.getBoundingClientRect().width,
    };
  });
  expect(dimensions).toMatchObject({ horizontalOverflow: false, verticalScroll: true });
  mkdirSync(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDirectory, "resources-narrow-long-list.png") });
});
