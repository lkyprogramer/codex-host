import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createRendererSettingsPageRegistry } from "./packages/renderer-extension/src/settings/core.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";
      import { createDefaultRendererSettingsPages } from "./packages/renderer-extension/src/settings/pages.ts";
      import { mountRendererSettingsShell } from "./packages/renderer-extension/src/settings/shell.ts";

      globalThis.setupUpdates = ({ releaseUrl = null } = {}) => {
        let status = null;
        let currentReleaseUrl = releaseUrl;
        let resolveStart;
        const startCompletion = new Promise(resolve => { resolveStart = resolve; });
        const calls = { check: 0, start: 0, status: 0 };
        const client = {
          checkUpdate: async () => {
            calls.check += 1;
            return {
              currentVersion: "1.2.2",
              installation: "npm",
              latestVersion: "1.2.3",
              updateAvailable: true,
              installationAvailable: true,
              releaseNotes: "Release notes",
              releaseNotesUrl: currentReleaseUrl,
              status,
              error: null,
            };
          },
          startUpdate: () => {
            calls.start += 1;
            return startCompletion;
          },
          readUpdateStatus: async () => {
            calls.status += 1;
            return { status };
          },
        };
        const messages = rendererSettingsMessages("en");
        const updatesPage = createDefaultRendererSettingsPages(messages, () => client)
          .find(page => page.id === "updates");
        if (!updatesPage) throw new Error("Production Updates page is missing");
        const registry = createRendererSettingsPageRegistry([updatesPage]);
        const shell = mountRendererSettingsShell(registry, document, messages);
        shell.openSettings(undefined, "updates");
        globalThis.updatesFixture = {
          calls,
          setStatus: (phase, error = null) => {
            status = phase === null ? null : {
              version: "1.2.3",
              installation: "npm",
              phase,
              updatedAt: Date.now(),
              ...(phase === "downloading" ? { downloadedBytes: 50, totalBytes: 100 } : {}),
              error,
            };
          },
          setReleaseUrl: url => { currentReleaseUrl = url; },
          completeStart: () => resolveStart({ status: {
            version: "1.2.3", installation: "npm", phase: "prepared", updatedAt: Date.now(), error: null,
          } }),
          armClose: () => {
            globalThis.updatesFixture.closed = new Promise(resolve =>
              shell.dialog.addEventListener("close", () => resolve(true), { once: true }));
          },
          open: () => shell.openSettings(undefined, "updates"),
          dispose: () => shell.dispose(),
        };
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "settings-update-e2e-entry.ts",
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
if (!bundle) throw new Error("Update settings fixture bundle missing");

async function setup(page: Page, releaseUrl: string | null = null): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("http://localhost/updates-test", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
  );
  await page.goto("http://localhost/updates-test");
  await page.clock.install({ time: new Date("2026-09-26T10:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-26T10:00:00Z"));
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    (url) => Reflect.get(globalThis, "setupUpdates")({ releaseUrl: url }),
    releaseUrl,
  );
  await expect(page.locator('.settings-update-panel[data-update-state="available"]')).toBeVisible();
}

async function callCount(page: Page, key: "check" | "start" | "status"): Promise<number> {
  return page.evaluate((name) => Reflect.get(globalThis, "updatesFixture").calls[name], key);
}

async function closeSettings(page: Page): Promise<void> {
  await page.evaluate(() => Reflect.get(globalThis, "updatesFixture").armClose());
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.evaluate(() => Reflect.get(globalThis, "updatesFixture").closed);
  await expect(page.locator(".codexhost-settings-dialog")).not.toBeVisible();
}

test("keeps a timed-out start pending, observes background progress, and stops polling while closed", async ({
  page,
}, testInfo) => {
  await setup(page);
  const panel = page.locator(".settings-update-panel");
  await panel.getByRole("button", { name: "Update", exact: true }).evaluate((element) => {
    const button = element as HTMLButtonElement;
    button.click();
    button.click();
  });
  expect(await callCount(page, "start")).toBe(1);

  await page.clock.runFor(15_000);
  await expect(panel).toHaveAttribute("data-update-state", "pending");
  await expect(panel).toContainText("Preparing update");
  expect(await callCount(page, "start")).toBe(1);

  await page.evaluate(() => Reflect.get(globalThis, "updatesFixture").setStatus("prepared"));
  await page.clock.runFor(750);
  await expect(panel).toHaveAttribute("data-update-state", "prepared");
  await page.evaluate(() => Reflect.get(globalThis, "updatesFixture").setStatus("downloading"));
  await page.clock.runFor(750);
  await expect(panel).toHaveAttribute("data-update-state", "downloading");
  await expect(panel.locator("progress")).toHaveJSProperty("value", 50);
  await page.screenshot({ path: testInfo.outputPath("updates-downloading.png") });

  await closeSettings(page);
  const readsBeforeClosed = await callCount(page, "status");
  await page.clock.runFor(3_000);
  expect(await callCount(page, "status")).toBe(readsBeforeClosed);
  await page.evaluate(() => Reflect.get(globalThis, "updatesFixture").open());
  await expect(panel).toHaveAttribute("data-update-state", "downloading");
  await page.evaluate(() => Reflect.get(globalThis, "updatesFixture").setStatus("succeeded"));
  await page.clock.runFor(750);
  await expect(panel).toHaveAttribute("data-update-state", "succeeded");
  await expect(panel).toContainText("Update installed successfully");
  await page.evaluate(() => Reflect.get(globalThis, "updatesFixture").completeStart());
  await expect(panel).toHaveAttribute("data-update-state", "succeeded");
  expect(await callCount(page, "start")).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("updates-succeeded.png") });
});

test("shows only a checked release URL after failure and intercepts its navigation", async ({
  page,
}, testInfo) => {
  await setup(page);
  const releaseLink = page.locator(".settings-update-controls > .settings-update-actions a");
  await expect(releaseLink).toBeHidden();
  await expect(releaseLink).not.toHaveAttribute("href", /.+/u);
  await page.screenshot({ path: testInfo.outputPath("updates-no-release-url.png") });

  const checkedReleaseUrl = "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.2.3";
  await closeSettings(page);
  await page.evaluate((url) => {
    Reflect.get(globalThis, "updatesFixture").setReleaseUrl(url);
    Reflect.get(globalThis, "updatesFixture").open();
  }, checkedReleaseUrl);
  await expect(releaseLink).toBeVisible();
  await expect(releaseLink).toHaveAttribute("href", checkedReleaseUrl);

  await page
    .locator(".settings-update-panel")
    .getByRole("button", { name: "Update", exact: true })
    .click();
  await page.clock.runFor(15_000);
  await page.evaluate(() =>
    Reflect.get(globalThis, "updatesFixture").setStatus("failed", "download failed"),
  );
  await page.clock.runFor(750);
  await expect(page.locator(".settings-update-panel")).toHaveAttribute(
    "data-update-state",
    "failed",
  );
  await expect(page.locator(".settings-update-panel")).toContainText("download failed");
  await expect(releaseLink).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("updates-failed-release.png") });

  const navigations: string[] = [];
  await page.context().route("https://github.com/**", (route) => {
    navigations.push(route.request().url());
    return route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Release intercepted</title>",
    });
  });
  const popupPromise = page.context().waitForEvent("page");
  await releaseLink.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(checkedReleaseUrl);
  expect(navigations).toEqual([checkedReleaseUrl]);
  expect(await callCount(page, "start")).toBe(1);
  await popup.close();
});
