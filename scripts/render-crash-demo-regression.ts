import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { SHEET_HISTORY_KEY } from "../src/lib/historyKeys.ts";
import { buildDemoApp } from "./demo-build.ts";
import { DEMO_FILE_PREVIEW_SCRIPT } from "./demo-file-preview.ts";
import { chromePath } from "./chrome-path.ts";
import { serveDemo } from "./demo-server.ts";

// On the unmodified app over the demo's fixture transport: no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-render-crash-demo-"));

interface OpenOptions { phone?: boolean; clipboardRefused?: boolean }

async function open(browser: Browser, search: string, { phone = false, clipboardRefused = false }: OpenOptions = {}): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" }
    : { viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", fileOpen: "panel" })));
  // a plain-HTTP LAN address: no clipboard API, and the old copy command refused too
  if (clipboardRefused) await context.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    document.execCommand = () => false;
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/herdr-web-ui/demo/app/${search}`);
  return { page, close: () => context.close() };
}

const select = async (page: Page, paneId: string): Promise<void> => {
  const row = page.locator(`.pane-select[title^="${paneId} —"]`).first();
  await row.waitFor({ state: "attached" });
  await row.evaluate((node: HTMLElement) => node.click());
};

const startCrashing = (page: Page, region: string): Promise<void> => page.evaluate((name) => {
  const url = new URL(window.location.href);
  url.searchParams.set("crash", name);
  window.history.replaceState(window.history.state, "", url);
}, region);

const stopCrashing = (page: Page): Promise<void> => page.evaluate(() => {
  const url = new URL(window.location.href);
  url.searchParams.delete("crash");
  window.history.replaceState(window.history.state, "", url);
});

let port = 0;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, `<script src="./demo-transport.js"></script>${DEMO_FILE_PREVIEW_SCRIPT}\n    <script type="module"`));
  const server = serveDemo(app);
  port = server.port ?? 0;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const pane = `?pane=${encodeURIComponent(panes.omp)}&view=terminal`;

      {
        const { page, close } = await open(browser, pane);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.locator(".pane-frame.is-current").waitFor();
        await page.locator(".sidebar-shell").waitFor();
        assert.equal(await page.getByRole("alert").filter({ hasText: /can't be shown|Something went wrong/ }).count(), 0, "no notice on a page that did not throw");
        assert.deepEqual(errors, []);
        await close();
      }

      {
        const { page, close } = await open(browser, `${pane}&crash=root`);
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        const crash = page.locator(".app-crash");
        await crash.getByRole("heading", { name: "Something went wrong" }).waitFor();
        const reload = crash.getByRole("button", { name: "Reload app", exact: true });
        assert.equal(await reload.isVisible(), true, "Reload app is offered");
        await crash.getByRole("button", { name: "Copy details", exact: true }).click();
        await crash.getByRole("button", { name: "Copied", exact: true }).waitFor();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        assert.match(copied, /crash probe: root/, "the details carry the error");
        await crash.locator("summary").click();
        assert.match(await crash.locator("pre").innerText(), /crash probe: root/, "the details are on the page too");
        const reloaded = page.waitForEvent("load");
        await reload.click();
        await reloaded;
        await crash.getByRole("button", { name: "Reload app", exact: true }).waitFor();
        await close();
      }

      {
        const { page, close } = await open(browser, `${pane}&crash=sidebar`);
        const notice = page.locator("#workspace-drawer").getByRole("alert").filter({ hasText: "The sidebar can't be shown." });
        await notice.waitFor();
        await page.locator(".pane-frame.is-current").waitFor();
        assert.equal(await page.locator(".app-crash").count(), 0, "the page is not blanked");
        await stopCrashing(page);
        await notice.getByRole("button", { name: "Try again", exact: true }).click();
        await page.locator(".sidebar-shell").waitFor();
        assert.equal(await notice.count(), 0, "the notice gives way to the sidebar");
        await close();
      }

      {
        const { page, close } = await open(browser, `${pane}&crash=pane`);
        const notice = page.locator(".pane-slot").getByRole("alert").filter({ hasText: "This pane can't be shown." });
        await notice.waitFor();
        await page.locator(".sidebar-shell").waitFor();
        assert.equal(await page.locator(".app-crash").count(), 0, "the page is not blanked");
        await stopCrashing(page);
        await notice.getByRole("button", { name: "Try again", exact: true }).click();
        await page.locator(".pane-frame.is-current").waitFor();
        await close();
      }

      {
        const { page, close } = await open(browser, pane);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await startCrashing(page, "pane");
        await select(page, panes.web);
        await page.locator(".pane-slot").getByRole("alert").filter({ hasText: "This pane can't be shown." }).waitFor();
        await page.locator(".conn-reconnecting").waitFor({ state: "attached", timeout: 5000 });
        assert.equal(await page.locator(".conn-live").count(), 0, "no live connection is claimed for a pane that is not drawn");
        await close();
      }

      {
        const { page, close } = await open(browser, `${pane}&settings=appearance&crash=settings`);
        const dialog = page.getByRole("dialog", { name: "Settings" });
        await dialog.getByRole("alert").filter({ hasText: "Settings can't be shown." }).waitFor();
        await page.locator(".sidebar-shell").waitFor();
        await page.locator(".pane-frame.is-current").waitFor();
        const focusInDialog = (): Promise<boolean> => page.evaluate(() => document.activeElement?.closest("[role=dialog]") != null);
        await page.waitForFunction(() => document.activeElement?.closest("[role=dialog]") != null, undefined, { timeout: 5000 });
        await page.keyboard.press("Tab");
        assert.equal(await focusInDialog(), true, "Tab stays inside the dialog");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await focusInDialog(), true, "Shift+Tab stays inside the dialog");
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached", timeout: 5000 });
        assert.equal(await page.locator(".app-crash").count(), 0, "the page is not blanked");
        await close();
      }
      {
        const { page, close } = await open(browser, `${pane}&settings=appearance&crash=settings`);
        const dialog = page.getByRole("dialog", { name: "Settings" });
        await dialog.getByRole("alert").filter({ hasText: "Settings can't be shown." }).waitFor();
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        assert.equal(await page.locator(".app-crash").count(), 0, "the page is not blanked");
        await close();
      }

      {
        const { page, close } = await open(browser, `${pane}&file=README.md&crash=settings`);
        await page.locator("aside.file-panel .file-viewer").waitFor();
        await page.keyboard.press("ControlOrMeta+Shift+Comma");
        const dialog = page.getByRole("dialog", { name: "Settings" });
        await dialog.getByRole("alert").filter({ hasText: "Settings can't be shown." }).waitFor();
        const closeButton = dialog.getByRole("button", { name: "Close", exact: true });
        const box = await closeButton.boundingBox();
        assert.ok(box, "Close is laid out");
        const onTop = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[role=dialog][aria-label=Settings]") != null, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
        assert.equal(onTop, true, "the notice is drawn over the file preview");
        await closeButton.click();
        await dialog.waitFor({ state: "detached" });
        await page.locator("aside.file-panel .file-viewer").waitFor();
        await close();
      }

      for (const phone of [false, true]) {
        const { page, close } = await open(browser, pane, { phone });
        await page.locator(".pane-frame.is-current").waitFor();
        await page.goto(`http://127.0.0.1:${port}/herdr-web-ui/demo/app/${pane}&settings=appearance&crash=settings`);
        const dialog = page.getByRole("dialog", { name: "Settings" });
        await dialog.getByRole("alert").filter({ hasText: "Settings can't be shown." }).waitFor();
        await page.evaluate(() => { (window as unknown as { crashMarker: boolean }).crashMarker = true; });
        await page.evaluate(() => window.history.back());
        await dialog.waitFor({ state: "detached", timeout: 5000 });
        assert.equal(await page.evaluate(() => (window as unknown as { crashMarker?: boolean }).crashMarker === true), true, `Back stays on this page (${phone ? "phone" : "desktop"})`);
        assert.equal(await page.locator(".app-crash").count(), 0, "the page is not blanked");
        await close();
      }

      {
        const { page, close } = await open(browser, `${pane}&settings=appearance`, { phone: true });
        const dialog = page.getByRole("dialog", { name: "Settings" });
        await dialog.getByText("Density", { exact: true }).waitFor();
        await page.waitForFunction(() => (window.history.state as Record<string, { depth?: number } | undefined> | null)?.["ovis:settings"]?.depth === 2, undefined, { timeout: 5000 });
        const compact = dialog.getByText("Compact", { exact: true });
        // Arm the failure on the actual tap, before React handles the density change.
        // Setting the URL earlier lets a content-readiness or roster render replace the
        // button with the crash fallback before Playwright can dispatch that tap.
        await compact.evaluate((button) => button.addEventListener("click", () => {
          const url = new URL(window.location.href);
          url.searchParams.set("crash", "settings");
          window.history.replaceState(window.history.state, "", url);
          Object.assign(window, { crashMarker: true });
        }, { once: true, capture: true }));
        await compact.tap();
        await dialog.getByRole("alert").filter({ hasText: "Settings can't be shown." }).waitFor();
        await page.waitForFunction(() => (window.history.state as Record<string, { depth?: number } | undefined> | null)?.["ovis:settings"]?.depth === 1, undefined, { timeout: 5000 });
        await page.evaluate(() => window.history.back());
        await dialog.waitFor({ state: "detached", timeout: 5000 });
        assert.equal(await page.evaluate(() => "crashMarker" in window), true, "one Back closes the crashed nested page without navigating away");
        assert.equal(await page.locator(".app-crash").count(), 0, "the page is not blanked");
        await close();
      }

      {
        const { page, close } = await open(browser, `${pane}&crash=root`, { phone: true, clipboardRefused: true });
        const crash = page.locator(".app-crash");
        await crash.getByRole("heading", { name: "Something went wrong" }).waitFor();
        const reload = crash.getByRole("button", { name: "Reload app", exact: true });
        const box = await reload.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844, "Reload app is on the phone's screen");
        assert.equal(await crash.locator("details").evaluate((node: HTMLDetailsElement) => node.open), false, "the details start folded");
        await crash.getByRole("button", { name: "Copy details", exact: true }).tap();
        await crash.locator("details[open]").waitFor({ timeout: 5000 });
        assert.equal(await crash.getByRole("button", { name: "Copied", exact: true }).count(), 0, "nothing claims a copy that did not happen");
        assert.match(await page.evaluate(() => window.getSelection()?.toString() ?? ""), /crash probe: root/, "the details are selected for a long press");
        await close();
      }

      {
        const { page, close } = await open(browser, `${pane}&crash=pane`, { phone: true });
        const notice = page.locator(".pane-slot").getByRole("alert").filter({ hasText: "This pane can't be shown." });
        await notice.waitFor();
        assert.equal(await page.locator(".app-crash").count(), 0, "the page is not blanked");
        await page.getByRole("button", { name: "Open workspace list", exact: true }).tap();
        await page.locator("#workspace-drawer.is-open .sidebar-shell").waitFor();
        await page.waitForFunction((key) => typeof history.state?.[key] === "string", SHEET_HISTORY_KEY, { timeout: 5_000 });
        await page.touchscreen.tap(page.viewportSize()!.width - 8, page.viewportSize()!.height / 2);
        await page.locator("#workspace-drawer.is-open").waitFor({ state: "detached" });
        // The drawer's Back lands after it closes and can restore the crash flag from the entry underneath.
        await page.waitForFunction((key) => history.state?.[key] === undefined, SHEET_HISTORY_KEY, { timeout: 5_000 });
        await stopCrashing(page);
        await notice.getByRole("button", { name: "Try again", exact: true }).tap();
        await page.locator(".pane-frame.is-current").waitFor();
        await close();
      }
      console.log("PASS a render error shows a notice with Reload app at the root, and stays inside the sidebar, a pane slot or Settings, on a desktop and a phone");
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
