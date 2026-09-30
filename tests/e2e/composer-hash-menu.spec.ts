import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererDelegationMention } from "./packages/renderer-extension/src/renderer-delegation-mention.ts";
      import { mountRendererHarnessCommandControl } from "./packages/renderer-extension/src/renderer-harness-command-control.ts";

      globalThis.setupHashMenu = (textarea = false) => {
        const editor = document.createElement(textarea ? "textarea" : "div");
        if (!textarea) editor.contentEditable = "true";
        editor.setAttribute("data-test-editor", "");
        const toolbar = document.createElement("div");
        document.body.append(editor, toolbar);
        globalThis.selectedCommand = null;
        const commands = [
          { id: "pi.plan", invocation: "/plan", label: "Plan", argumentMode: "text" },
          { id: "pi.compact", invocation: "/compact", label: "Compact", argumentMode: "none" },
          { id: "pi.review", invocation: "/review", label: "Review", argumentMode: "text", kind: "skill" },
        ];
        let menu = null;
        const control = mountRendererHarnessCommandControl(toolbar, null, () => menu.openFor(editor));
        control.setCommands(commands, false, "live");
        menu = installRendererDelegationMention(document, {
          readTargets: () => [{ agent: "claude-code", label: "Claude Code" }],
          isComposerEditor: (element) => element === editor,
          readLocale: () => "en",
          anchorForEditor: () => editor,
          readCommands: () => ({
            harnessId: "pi",
            commands: control.snapshot().commands,
            disabledReason: (command) => command.id === "pi.compact" ? "Start a conversation" : null,
            select: (command) => { globalThis.selectedCommand = command.id; },
          }),
        });
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  write: false,
});
const bundle = outputFiles[0]?.text;
if (!bundle) throw new Error("Missing # menu fixture bundle");

test.beforeEach(async ({ page }) => {
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => Reflect.get(globalThis, "setupHashMenu")());
});

test("the button opens grouped choices and keyboard Escape restores typing", async ({ page }) => {
  const editor = page.locator("[data-test-editor]");
  const trigger = page.locator("[data-codexhost-harness-command-control] button");
  const menu = page.locator("[data-codexhost-delegation-mention-menu]");
  await trigger.click();
  await expect(editor).toHaveText("#");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Delegate to agent");
  await expect(menu).toContainText("Commands");
  await expect(menu).toContainText("Skills");
  await expect(menu.locator('[aria-disabled="true"] [data-command-id="pi.compact"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText("#");
});

test("filter and Enter insert a scoped skill carrier while preserving surrounding text", async ({
  page,
}) => {
  const editor = page.locator("[data-test-editor]");
  const menu = page.locator("[data-codexhost-delegation-mention-menu]");
  await editor.click();
  await page.keyboard.type("first #rev");
  await expect(menu.locator('[data-command-id="pi.review"]')).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(editor).toContainText("first");
  await expect(editor).toContainText("subagent://codexhost-command.pi%3Areview");
  await expect(editor).not.toContainText("#rev");
});

test("a delegation chip and a command chip can coexist in one draft", async ({ page }) => {
  const editor = page.locator("[data-test-editor]");
  const menu = page.locator("[data-codexhost-delegation-mention-menu]");
  await editor.click();
  await page.keyboard.type("#cl");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(editor).toContainText("subagent://codexhost.claude-code");
  await page.keyboard.type(" ask #plan");
  await expect(menu.locator('[data-command-id="pi.plan"]')).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(editor).toContainText("subagent://codexhost-command.pi%3Aplan");
  await expect(editor).toContainText("ask");
});

test("typed multiline code fences keep # inert until the fence closes", async ({ page }) => {
  const editor = page.locator("[data-test-editor]");
  const menu = page.locator("[data-codexhost-delegation-mention-menu]");
  await editor.click();
  await page.keyboard.type("```ts");
  await page.keyboard.press("Enter");
  await page.keyboard.type("#plan");
  await expect(menu).toBeHidden();
  await page.keyboard.press("Enter");
  await page.keyboard.type("````");
  await page.keyboard.press("Enter");
  await page.keyboard.type("#plan");
  await expect(menu).toBeVisible();
});

test("textarea button and typed # open the same menu and preserve surrounding text", async ({
  page,
}) => {
  await page.evaluate(() => {
    document.body.replaceChildren();
    Reflect.get(globalThis, "setupHashMenu")(true);
  });
  const editor = page.locator("textarea[data-test-editor]");
  const menu = page.locator("[data-codexhost-delegation-mention-menu]");
  await editor.fill("prior ");
  await editor.focus();
  await page.keyboard.type("#rev");
  await expect(menu.locator('[data-command-id="pi.review"]')).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(editor).toHaveValue(
    /prior \[@\/review\]\(subagent:\/\/codexhost-command\.pi%3Areview\) /u,
  );
  await page.locator("[data-codexhost-harness-command-control] button").click();
  await expect(menu).toBeVisible();
  await expect(editor).toHaveValue(/#$/u);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await page.keyboard.press("Backspace");
  await page.keyboard.type("#");
  await expect(menu).toBeVisible();
});
