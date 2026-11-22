import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { serveDemo } from "./demo-server.ts";

/** What the page did with one contextmenu event, read after every handler and React's commit ran. */
interface Seen { target: string; defaultPrevented: boolean; reachedWindow: boolean; paneMenu: boolean; active: string }
declare global { interface Window { __contextmenus: Seen[] } }

const app = mkdtempSync(join(tmpdir(), "herdr-context-menu-inputs-demo-"));
const PANE_MENU = '[role="menu"][aria-label^="Pane actions for "], [role="dialog"][aria-label^="Pane actions for "]';

async function rightClick(page: Page, target: Locator): Promise<Seen> {
  const before = await page.evaluate(() => window.__contextmenus.length);
  await target.click({ button: "right" });
  await page.waitForFunction((count) => window.__contextmenus.length > count, before);
  return page.evaluate(() => window.__contextmenus[window.__contextmenus.length - 1]!);
}

async function dismissPaneMenu(page: Page): Promise<void> {
  const menu = page.locator(PANE_MENU);
  if (await menu.count() === 0) return;
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));
  const prefix = "/herdr-web-ui/demo/app/";
  const server = serveDemo(app, { prefix });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
      await context.addInitScript((paneMenuSelector) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", terminalInputMode: "line", alertsOn: false }));
        const name = (node: EventTarget | null): string => node instanceof Element
          ? node.tagName.toLowerCase() + (typeof node.className === "string" && node.className ? `.${node.className.split(" ")[0]}` : "") : String(node);
        window.__contextmenus = [];
        let latest: Seen | null = null;
        // the window's capture listener runs before any of the app's; a macrotask reads the event after
        // every handler in both phases and React's synchronous commit (a microtask would run between listeners)
        window.addEventListener("contextmenu", (event) => {
          const entry: Seen = { target: name(event.target), defaultPrevented: false, reachedWindow: false, paneMenu: false, active: "" };
          latest = entry;
          setTimeout(() => {
            entry.defaultPrevented = event.defaultPrevented;
            entry.paneMenu = document.querySelector(paneMenuSelector) !== null;
            entry.active = name(document.activeElement);
            window.__contextmenus.push(entry);
          }, 0);
        }, true);
        window.addEventListener("contextmenu", () => { if (latest) latest.reachedWindow = true; });
      }, PANE_MENU);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const origin = `http://127.0.0.1:${server.port}${prefix}`;
      const frame = page.locator(".pane-frame.is-current");
      const seen: Record<string, Seen> = {};

      await page.goto(`${origin}?pane=${encodeURIComponent(panes.api)}&view=chat`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      const composer = frame.locator(".composer-text");
      await composer.waitFor();
      await composer.click();
      await page.keyboard.type("their own text");
      await composer.evaluate((node: HTMLTextAreaElement) => { node.setSelectionRange(6, 9); node.blur(); });
      seen.composer = await rightClick(page, composer);
      await dismissPaneMenu(page);

      await page.goto(`${origin}?pane=${encodeURIComponent(panes.shell)}&view=terminal`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      const line = frame.locator(".terminal-input-text");
      await line.waitFor();
      await line.click();
      await page.keyboard.type("echo own text");
      await line.evaluate((node: HTMLTextAreaElement) => node.blur());
      seen.terminalLine = await rightClick(page, line);
      await dismissPaneMenu(page);

      await frame.locator(".xterm-screen").click();
      await page.keyboard.press("Control+Shift+F");
      const query = frame.locator(".find-bar input");
      await query.waitFor();
      await page.keyboard.type("own query");
      await query.evaluate((node: HTMLInputElement) => node.blur());
      seen.findQuery = await rightClick(page, query);
      await dismissPaneMenu(page);
      await frame.getByRole("button", { name: "Close search", exact: true }).click();
      await query.waitFor({ state: "detached" });

      seen.screen = await rightClick(page, frame.locator(".xterm-screen"));
      const menu = page.locator(PANE_MENU);
      await menu.waitFor();

      await menu.getByRole("menuitem", { name: "Rename pane", exact: true }).click();
      const rename = page.getByRole("dialog", { name: /^Rename pane( · |$)/ });
      await rename.waitFor();
      seen.renameInput = await rightClick(page, rename.locator("input"));
      await page.keyboard.press("Escape");
      await rename.waitFor({ state: "detached" });

      console.log(JSON.stringify(seen, null, 2));
      const failures: string[] = [];
      const expect = (ok: boolean, message: string): void => { if (!ok) failures.push(message); };
      expect(!seen.composer!.defaultPrevented && !seen.composer!.paneMenu, `a right-click in the chat composer is the browser's menu, not the pane menu: ${JSON.stringify(seen.composer)}`);
      expect(seen.composer!.active === "textarea.composer-text", `the right-click focuses the composer as the browser does: active ${seen.composer!.active}`);
      expect(!seen.terminalLine!.defaultPrevented && !seen.terminalLine!.paneMenu, `a right-click in the terminal's input line is the browser's menu, not the pane menu: ${JSON.stringify(seen.terminalLine)}`);
      expect(seen.terminalLine!.active === "textarea.terminal-input-text", `the right-click focuses the input line as the browser does: active ${seen.terminalLine!.active}`);
      expect(!seen.findQuery!.defaultPrevented && !seen.findQuery!.paneMenu, `a right-click in the find bar's field is the browser's menu, not the pane menu: ${JSON.stringify(seen.findQuery)}`);
      expect(seen.findQuery!.active === "input.input", `the right-click focuses the find field as the browser does: active ${seen.findQuery!.active}`);
      expect(seen.screen!.defaultPrevented && seen.screen!.paneMenu, `a right-click on the pane itself is still the pane menu: ${JSON.stringify(seen.screen)}`);
      expect(!seen.renameInput!.defaultPrevented && !seen.renameInput!.paneMenu, `a text field outside a pane frame keeps the browser's menu: ${JSON.stringify(seen.renameInput)}`);
      assert.deepEqual(errors, []);
      assert.deepEqual(failures, [], `FAIL\n${failures.join("\n")}`);
      console.log("PASS a right-click in a pane's text fields is the browser's menu; on the pane itself it is the pane menu");
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
