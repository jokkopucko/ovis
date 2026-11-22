import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { openSettingsPage } from "./settings-page.ts";
import panes from "../site/demo/fixtures/panes.json";
import { serveDemo } from "./demo-server.ts";

const app = mkdtempSync(join(tmpdir(), "herdr-input-focus-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));
  const prefix = "/herdr-web-ui/demo/app/";
  const server = serveDemo(app, { prefix });
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true });
    try {
      for (const touch of [true, false]) {
        const context = await browser.newContext({ viewport: { width: 1024, height: 600 }, hasTouch: touch, locale: "en-US" });
        try {
          await context.addInitScript(() => {
            Object.defineProperty(navigator, "platform", { configurable: true, value: "iPad" });
            if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", terminalInputMode: "line", alertsOn: false,
              shortcutOverrides: { "previous-pane": "1", "next-pane": "2" } }));
          });
          const page = await context.newPage();
          page.setDefaultTimeout(10000);
          const errors: string[] = [];
          page.on("pageerror", error => errors.push(error.message));
          const origin = `http://127.0.0.1:${server.port}${prefix}`;
          await page.goto(`${origin}?pane=${encodeURIComponent(panes.api)}&view=chat`);
          await page.locator(".conn-live").waitFor();
          await page.locator(".composer-text").first().waitFor();
          await page.keyboard.press("Meta+Shift+Digit2");
          await page.waitForFunction(previous => document.querySelector(".pane-frame.is-current")?.getAttribute("data-layout-pane") !== previous, panes.api);
          const wanted = !touch;
          await page.waitForFunction(wanted => !!document.querySelector(".pane-frame.is-current .composer-text:focus") === wanted, wanted);
          assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), touch);
          const frame = page.locator(".pane-frame.is-current");
          await frame.focus();
          await page.keyboard.press("Meta+Shift+E");
          const composer = frame.locator(".composer-text");
          assert.equal(await composer.evaluate(node => node === document.activeElement), true, "the focus chord targets the selected chat synchronously");
          await page.keyboard.type("Keyboard draft");
          assert.equal(await composer.inputValue(), "Keyboard draft");
          await composer.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 8));
          await frame.focus();
          await page.keyboard.press("Meta+Shift+E");
          assert.deepEqual(await composer.evaluate((node: HTMLTextAreaElement) => [node.value, node.selectionStart, node.selectionEnd]), ["Keyboard draft", 2, 8], "focusing preserves the draft and selection");
          await frame.focus();
          await frame.dispatchEvent("keydown", { key: "E", code: "KeyE", metaKey: true, shiftKey: true, isComposing: true, bubbles: true });
          assert.equal(await composer.evaluate(node => node === document.activeElement), false, "composing keys do not focus chat");
          await page.keyboard.press("Meta+Shift+Comma");
          await openSettingsPage(page, "Chat");
          await page.keyboard.press("Meta+Shift+E");
          assert.equal(await page.locator(".settings-dialog").evaluate(node => node.contains(document.activeElement)), true, "focus never leaves Settings");
          await openSettingsPage(page, "Shortcuts");
          const binding = page.getByRole("combobox", { name: "Focus pane input", exact: true });
          await binding.selectOption("g");
          await page.getByRole("button", { name: "Close settings", exact: true }).click();
          await frame.focus(); await page.keyboard.press("Meta+Shift+E");
          assert.equal(await composer.evaluate(node => node === document.activeElement), false, "reassignment releases the default");
          await page.keyboard.press("Meta+Shift+G");
          assert.equal(await composer.evaluate(node => node === document.activeElement), true);
          await page.reload(); await page.locator(".conn-live").waitFor();
          await frame.focus(); await page.keyboard.press("Meta+Shift+G");
          assert.equal(await frame.locator(".composer-text").evaluate(node => node === document.activeElement), true, "custom focus binding survives reload");
          await page.goto(`${origin}?pane=${encodeURIComponent(panes.shell)}&view=terminal`);
          const line = frame.locator(".terminal-input-text"); await line.waitFor();
          await frame.focus(); await page.keyboard.press("Meta+Shift+G");
          assert.equal(await line.evaluate(node => node === document.activeElement), true, "terminal line input can be focused");
          await page.keyboard.type("line draft"); assert.equal(await line.inputValue(), "line draft");
          await page.evaluate(() => {
            const settings = JSON.parse(localStorage.getItem("ovis:settings")!);
            localStorage.setItem("ovis:settings", JSON.stringify({ ...settings, terminalInputMode: "direct" }));
          });
          await page.reload(); await page.locator(".conn-live").waitFor();
          await frame.focus(); await page.keyboard.press("Meta+Shift+G");
          assert.equal(await frame.locator(".xterm-helper-textarea").evaluate(node => node === document.activeElement), true, "direct terminal input can be focused");
          await page.keyboard.press("Meta+Shift+Comma"); await openSettingsPage(page, "Shortcuts");
          await binding.selectOption("off");
          await page.getByRole("button", { name: "Close settings", exact: true }).click();
          await frame.focus(); await page.keyboard.press("Meta+Shift+G");
          assert.equal(await frame.locator(".xterm-helper-textarea").evaluate(node => node === document.activeElement), false, "disabled binding leaves focus in place");
          assert.deepEqual(errors, []);
          console.log(`PASS input focus: ${touch ? "touch" : "desktop"}, pane switch, chat draft/selection, modal and IME guards, terminal line/direct, reassign/disable/reload`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
