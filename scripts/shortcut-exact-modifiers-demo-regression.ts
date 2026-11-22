import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { openSettingsPage } from "./settings-page.ts";
import panes from "../site/demo/fixtures/panes.json";
import { serveDemo } from "./demo-server.ts";

const screenshotDir = process.env.SHORTCUT_SCREENSHOT_DIR;
const app = mkdtempSync(join(tmpdir(), "herdr-exact-shortcuts-demo-"));

async function stored(page: Page): Promise<Record<string, string | null>> {
  return await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").shortcutOverrides ?? {});
}

async function record(page: Page, name: string, chord: string): Promise<string> {
  await page.getByRole("button", { name: `Record shortcut for ${name}`, exact: true }).click();
  await page.keyboard.press(chord);
  const description = page.locator(".settings-row", { has: page.getByRole("button", { name: `Record shortcut for ${name}`, exact: true }) }).locator(".settings-description");
  return await description.count() === 0 ? "" : (await description.textContent()) ?? "";
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));
  const prefix = "/herdr-web-ui/demo/app/";
  const server = serveDemo(app, { prefix });
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1180, height: 760 }, locale: "en-US" });
      try {
        await context.addInitScript(() => {
          Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
          if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", alertsOn: false }));
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        const origin = `http://127.0.0.1:${server.port}${prefix}`;
        await page.goto(`${origin}?pane=${encodeURIComponent(panes.api)}&view=chat`);
        await page.locator(".conn-live").waitFor();
        await page.keyboard.press("Meta+Shift+Comma");
        await openSettingsPage(page, "Shortcuts");

        await record(page, "Scroll pane up", "Meta+PageUp");
        assert.equal((await stored(page))["scroll-up"], "meta+PageUp");
        const scrollUp = page.getByRole("combobox", { name: "Scroll pane up", exact: true });
        assert.equal(await scrollUp.inputValue(), "meta+PageUp");
        assert.equal(await scrollUp.locator("option:checked").textContent(), "⌘+PageUp");

        const nextPane = page.getByRole("combobox", { name: "Next pane", exact: true });
        assert.equal(await nextPane.locator("option[value='End']").count(), 0, "the list does not offer End");
        await record(page, "Next pane", "Meta+Shift+End");
        assert.equal((await stored(page))["next-pane"], "End");
        assert.equal(await nextPane.inputValue(), "End");
        assert.match((await nextPane.locator("option:checked").textContent()) ?? "", /End/);

        // macOS Option is read by its key, not by the character it types
        await record(page, "Toggle sidebar", "Meta+Alt+KeyB");
        assert.equal((await stored(page))["toggle-sidebar"], "alt+meta+b");

        const warning = await record(page, "Command palette", "Control+KeyK");
        assert.match(warning, /⌃\+K is a terminal key/);
        assert.equal(await page.getByRole("combobox", { name: "Command palette", exact: true }).count(), 0, "the list gives way to the confirmation");
        if (screenshotDir) await page.locator(".settings-dialog").screenshot({ path: join(screenshotDir, "exact-shortcut-confirm.png") });
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        assert.equal(Object.hasOwn(await stored(page), "palette"), false, "Cancel saves nothing");
        await record(page, "Command palette", "Control+KeyK");
        await page.getByRole("button", { name: "Save anyway", exact: true }).click();
        assert.equal((await stored(page)).palette, "ctrl+k");
        const paletteRow = await page.locator(".settings-row", { has: page.getByRole("button", { name: "Record shortcut for Command palette", exact: true }) }).locator(".settings-description").textContent();
        assert.match(paletteRow ?? "", /⌃\+K is a terminal key/, "a saved terminal key keeps its note");

        // refused: a chord the browser keeps, one already assigned, and one without Ctrl, Alt or ⌘
        assert.match(await record(page, "Find in terminal", "Meta+KeyW"), /keeps that shortcut/);
        await page.keyboard.press("Control+KeyK");
        assert.equal(await page.locator(".settings-row", { has: page.getByRole("button", { name: "Record shortcut for Find in terminal", exact: true }) }).locator(".settings-description").textContent(), "Already assigned");
        await page.keyboard.press("Shift+KeyG");
        assert.match((await page.locator(".settings-row", { has: page.getByRole("button", { name: "Record shortcut for Find in terminal", exact: true }) }).locator(".settings-description").textContent()) ?? "", /Hold ⌘, Ctrl or ⌥/);
        await page.keyboard.press("Escape");
        assert.equal(Object.hasOwn(await stored(page), "find"), false);
        if (screenshotDir) await page.locator(".settings-dialog").screenshot({ path: join(screenshotDir, "exact-shortcut-list.png") });

        const hungarianE = () => page.evaluate(() => (document.activeElement ?? window).dispatchEvent(new KeyboardEvent("keydown", { key: "É", code: "Semicolon", metaKey: true, shiftKey: true, bubbles: true, cancelable: true })));
        await page.getByRole("button", { name: "Record shortcut for Settings", exact: true }).click();
        await hungarianE();
        assert.equal((await stored(page)).settings, ";");

        await page.getByRole("button", { name: "Close settings", exact: true }).click();
        const palette = page.locator(".command-palette");
        // dispatched in the page: a shortcut that ran has already prevented it when dispatchEvent returns
        const chord = (key: string, code: string) => page.evaluate(([key, code]) => (document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent("keydown", { key, code, metaKey: true, shiftKey: true, bubbles: true, cancelable: true })), [key, code] as const);
        assert.equal(await chord("K", "KeyK"), true, "the moved palette no longer answers Mod+Shift+K");
        await page.keyboard.press("Control+KeyK");
        await palette.waitFor();
        assert.equal(await palette.locator(".palette-shortcut[aria-label='⌥ + ⌘ + B']").count(), 1, "the palette shows an exact chord as recorded");
        await page.keyboard.press("Escape");
        await palette.waitFor({ state: "detached" });

        await hungarianE();
        await page.locator(".settings-dialog").waitFor();
        await page.getByRole("button", { name: "Close settings", exact: true }).click();

        await hungarianE();
        await openSettingsPage(page, "Shortcuts");
        const recorded = await record(page, "Rename tab", "Meta+Shift+KeyY");
        assert.equal((await stored(page))["rename-tab"], "y", recorded);
        await page.getByRole("button", { name: "Close settings", exact: true }).click();
        const tabName = page.locator(".tab-strip-item.is-active .tab-strip-rename");
        const tabLabel = (await page.locator('.tab-strip-item.is-active [role="tab"]').textContent()) ?? "";
        await page.keyboard.press("Meta+Shift+KeyY");
        await tabName.waitFor();
        assert.equal(await tabName.evaluate((input) => input === document.activeElement), true, "the name field has the focus");
        if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "rename-tab-shortcut.png") });
        await page.keyboard.press("Escape");
        await tabName.waitFor({ state: "detached" });
        assert.equal(await page.locator('.tab-strip-item.is-active [role="tab"]').textContent(), tabLabel, "Escape keeps the name");
        const openTab = () => document.querySelector<HTMLElement>('.tab-strip-item.is-active [role="tab"]')?.dataset["tabId"] ?? null;
        const firstTab = await page.evaluate(openTab);
        await page.keyboard.press("Meta+Shift+End");
        await page.waitForFunction((before) => (document.querySelector<HTMLElement>('.tab-strip-item.is-active [role="tab"]')?.dataset["tabId"] ?? null) !== before, firstTab);
        await page.keyboard.press("Meta+Shift+ArrowUp");
        await page.waitForFunction((before) => (document.querySelector<HTMLElement>('.tab-strip-item.is-active [role="tab"]')?.dataset["tabId"] ?? null) === before, firstTab);
        assert.equal(await page.locator(".tab-strip-rename").count(), 0, "coming back to the pane does not reopen the name field");
        await page.keyboard.press("Meta+Shift+KeyY");
        await tabName.waitFor();
        await page.keyboard.type("Renamed by shortcut");
        await page.keyboard.press("Meta+Shift+KeyY");
        await page.keyboard.press("Enter");
        await tabName.waitFor({ state: "detached" });
        assert.match((await page.locator('.tab-strip-item.is-active [role="tab"]').textContent()) ?? "", /Renamed by shortcut/, "Enter renames the tab");
        await page.waitForFunction(async () => (await (await fetch("/api/session")).json()).snapshot.tabs.some((tab: { label: string }) => tab.label === "Renamed by shortcut"));
        await page.keyboard.press("Control+KeyK");
        await palette.waitFor();
        await page.keyboard.type("rename tab");
        await page.getByRole("option", { name: /Rename tab/ }).first().click();
        await tabName.waitFor();
        assert.equal(await tabName.evaluate((input) => input === document.activeElement), true, "the palette action focuses the name field");
        await page.keyboard.press("Escape");

        const composer = page.locator(".composer-text").first();
        await composer.fill("draft");
        await composer.evaluate((box: HTMLTextAreaElement) => box.setSelectionRange(0, 0));
        assert.equal(await chord("End", "End"), true, "\u2318\u21e7End in a message box with text after the caret stays with the text");
        await composer.fill("");
        assert.equal(await chord("End", "End"), false, "with the box empty, \u2318\u21e7End runs Next pane");

        await page.reload();
        await page.locator(".conn-live").waitFor();
        await page.locator(".composer-text").first().focus();
        await page.keyboard.press("Control+KeyK");
        await palette.waitFor();
        assert.deepEqual(errors, []);
        console.log("PASS exact shortcuts: Hungarian É by position, safe chord saved, terminal key confirm/cancel, refusals, dispatch, released default, reload");
      } finally { await context.close(); }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
