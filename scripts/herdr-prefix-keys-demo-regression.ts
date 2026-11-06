/** herdr's prefix keys (Settings → Shortcuts, off by default) on the real client against fictional demo panes. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { openSettingsFolds, openSettingsPage } from "./settings-page.ts";
import panes from "../site/demo/fixtures/panes.json";

const screenshotDir = process.env.HERDR_KEYS_SCREENSHOT_DIR;
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
const app = mkdtempSync(join(tmpdir(), "herdr-prefix-keys-demo-"));

/** Two frames after a key: whatever it was going to open has rendered by then. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function focusTerminal(page: Page): Promise<void> {
  await page.locator(".xterm-helper-textarea").first().focus();
  await page.waitForFunction(() => document.activeElement?.classList.contains("xterm-helper-textarea") === true);
}

const waiting = (page: Page) => page.locator(".header-note-text", { hasText: "herdr prefix: press a key" });

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));
  const prefix = "/herdr-web-ui/demo/app/";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true });
    try {
      const origin = `http://127.0.0.1:${server.port}${prefix}`;
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
      try {
        await context.addInitScript(() => {
          Object.defineProperty(navigator, "platform", { configurable: true, value: "Linux x86_64" });
          if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertsOn: false }));
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${origin}?pane=${encodeURIComponent(panes.api)}&view=terminal`);
        await page.locator(".conn-live").waitFor();
        const dialog = page.locator(".settings-dialog");

        // off by default: Ctrl+B and its key stay the terminal's
        await focusTerminal(page);
        await page.keyboard.press("Control+KeyB");
        await page.keyboard.press("KeyS");
        await settled(page);
        assert.equal(await dialog.count(), 0, "off: the prefix runs nothing");
        assert.equal(await waiting(page).count(), 0, "off: the header says nothing");

        // turned on: the Settings row lists the bindings read from this PC's herdr config
        await page.keyboard.press("Control+Shift+Comma");
        await openSettingsPage(page, "Shortcuts");
        // the opt-in sits under More settings
        await openSettingsFolds(page);
        const toggle = page.getByRole("switch", { name: "Use herdr's prefix keys", exact: true });
        assert.equal(await toggle.getAttribute("aria-checked"), "false");
        await toggle.click();
        const section = page.locator('[data-section="herdr-keys"]');
        const row = (label: string) => section.locator(".settings-row").filter({ has: page.locator(".settings-label").getByText(label, { exact: true }) });
        const binding = (label: string) => row(label).locator("kbd");
        await binding("Prefix").waitFor();
        assert.equal(await binding("Prefix").textContent(), "ctrl+b");
        assert.equal(await binding("Split pane right").textContent(), "prefix+v");
        assert.equal(await binding("Go to tab 1-9").textContent(), "prefix+1..9");
        assert.deepEqual(await binding("Command palette").allTextContents(), ["prefix+?", "prefix+w", "prefix+g"], "one row for the actions that open the palette");
        assert.equal(await row("Next workspace").count(), 0, "an action herdr leaves unbound is not listed");
        assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("ovis:settings") ?? "{}")).herdrPrefixKeys, true);
        await page.getByRole("button", { name: "Close settings", exact: true }).click();
        await dialog.waitFor({ state: "detached" });

        // the prefix waits for its key, said in the header; Escape leaves it
        await focusTerminal(page);
        await page.keyboard.press("Control+KeyB");
        await waiting(page).waitFor();
        if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "prefix-waiting-1280.png") });
        await page.keyboard.press("Escape");
        await waiting(page).waitFor({ state: "detached" });
        await page.keyboard.press("KeyS");
        await settled(page);
        assert.equal(await dialog.count(), 0, "after Escape a key is the terminal's again");

        // prefix, then a bound key: s opens Settings, ? the palette
        await page.keyboard.press("Control+KeyB");
        await page.keyboard.press("KeyS");
        await dialog.waitFor();
        await page.getByRole("button", { name: "Close settings", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        await focusTerminal(page);
        await page.keyboard.press("Control+KeyB");
        await page.keyboard.press("Shift+Slash");
        const palette = page.locator(".command-palette");
        await palette.waitFor();
        await page.keyboard.press("Escape");
        await palette.waitFor({ state: "detached" });

        // armed, the app's own shortcut stays the app's: the palette opens, the prefix is left
        await focusTerminal(page);
        await page.keyboard.press("Control+KeyB");
        await waiting(page).waitFor();
        await page.keyboard.press("Control+Shift+KeyK");
        await palette.waitFor();
        await waiting(page).waitFor({ state: "detached" });
        await page.keyboard.press("Escape");
        await palette.waitFor({ state: "detached" });

        // c opens a terminal tab at once; 1 goes back to the first tab in the strip
        await focusTerminal(page);
        const tabs = page.locator(".tab-strip-item");
        const before = await tabs.count();
        await page.keyboard.press("Control+KeyB");
        await page.keyboard.press("KeyC");
        await page.waitForFunction((count) => document.querySelectorAll(".tab-strip-item").length === count + 1, before);
        const active = () => page.locator(".tab-strip-item.is-active").evaluate((item) => [...document.querySelectorAll(".tab-strip-item")].indexOf(item));
        await page.waitForFunction((count) => document.querySelector(".tab-strip-item.is-active") === document.querySelectorAll(".tab-strip-item")[count], before);
        await focusTerminal(page);
        await page.keyboard.press("Control+KeyB");
        await page.keyboard.press("Digit1");
        await page.waitForFunction(() => document.querySelector(".tab-strip-item.is-active") === document.querySelectorAll(".tab-strip-item")[0]);
        assert.equal(await active(), 0);

        // a field keeps its keys: Ctrl+B in the chat's message box arms nothing
        await page.goto(`${origin}?pane=${encodeURIComponent(panes.api)}&view=chat`);
        await page.locator(".conn-live").waitFor();
        const box = page.locator(".pane-frame.is-current .composer-text");
        await box.waitFor();
        await box.focus();
        await page.keyboard.press("Control+KeyB");
        await page.keyboard.press("KeyS");
        await settled(page);
        assert.equal(await waiting(page).count(), 0, "a text field keeps Ctrl+B");
        assert.equal(await dialog.count(), 0, "a text field keeps the key after it");

        assert.deepEqual(errors, []);
      } finally { await context.close(); }

      // the Settings rows, at a desk's and a phone's width, light and dark
      if (screenshotDir) {
        for (const theme of ["light", "dark"] as const) {
          for (const width of [1280, 390]) {
            const shot = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 }, deviceScaleFactor: width === 390 ? 3 : 1, isMobile: width === 390, hasTouch: width === 390, locale: "en-US" });
            try {
              await shot.addInitScript((theme) => {
                localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertsOn: false, theme, herdrPrefixKeys: true }));
              }, theme);
              const page = await shot.newPage();
              // a link to the group opens the More settings fold it sits in
              await page.goto(`${origin}?pane=${encodeURIComponent(panes.api)}&view=terminal&settings=shortcuts&section=herdr-keys`);
              await page.locator(".settings-dialog").waitFor();
              const section = page.locator('[data-section="herdr-keys"]');
              await section.locator("kbd").first().waitFor();
              await section.scrollIntoViewIfNeeded();
              await page.screenshot({ path: join(screenshotDir, `settings-${width}-${theme}.png`) });
            } finally { await shot.close(); }
          }
        }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
console.log("herdr prefix keys demo regression passed");
