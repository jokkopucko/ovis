import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// #1457: a compact-height phone (including the iPhone Duo's outer display, or a phone with its
// keyboard up) drops a lone tab's row, and the chat then puts the glass header over the pane. The
// pane then draws no ellipsis under the header's own: the header's More menu carries the pane's and
// the tab's actions (#2622), and a banner (View only) starts below the header.
type SocketsWindow = Window & { glassSockets: WebSocket[] };

/** Keeps the demo's sockets, so the check can turn this connection into a view-only one. */
function recordSockets(): void {
  const sockets: WebSocket[] = [];
  (window as SocketsWindow).glassSockets = sockets;
  const Demo = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    const socket = new Demo(url, protocols);
    sockets.push(socket);
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Recorded, name, { value: Demo[name] });
  window.WebSocket = Recorded as unknown as typeof WebSocket;
}

const evidence = process.env.UI_EVIDENCE_DIR;
const app = mkdtempSync(join(tmpdir(), "ovis-glass-header-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n<script>(${recordSockets.toString()})()</script>\n<script type="module"`));

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    if (!(await body.exists())) return new Response("not found", { status: 404 });
    // Chromium on Linux has no phone status bar: give the header a phone's top inset, as the
    // installed app has, so the header's height under glass is the one a phone draws.
    if (file.endsWith(".css")) return new Response((await body.text()).replace(/env\(safe-area-inset-top(?:,\s*0px)?\)/g, "32px"), { headers: { "content-type": "text/css" } });
    return new Response(body);
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      try {
        await context.addInitScript(() => {
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
          const viewport = window.visualViewport!;
          let height = 795;
          Object.defineProperty(viewport, "height", { get: () => height });
          (window as Window & { glassViewport?: (value: number) => void }).glassViewport = (value) => {
            height = value;
            viewport.dispatchEvent(new Event("resize"));
          };
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.api)}`);
        await page.locator(".conn-live").waitFor();
        // A short phone draws no tab row for a workspace's only tab: close the pane's sibling tabs.
        const closed = await page.evaluate(async (id) => {
          const { snapshot } = await (await fetch("/api/session")).json() as { snapshot: { panes: { pane_id: string; tab_id: string; workspace_id: string }[]; tabs: { tab_id: string; workspace_id: string }[] } };
          const own = snapshot.panes.find((pane) => pane.pane_id === id)!;
          const others = snapshot.tabs.filter((tab) => tab.workspace_id === own.workspace_id && tab.tab_id !== own.tab_id);
          for (const tab of others) {
            const response = await fetch("/api/tab/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tab_id: tab.tab_id }) });
            if (!response.ok) throw new Error(`tab close ${response.status}`);
          }
          return others.length;
        }, panes.api);
        assert.ok(closed > 0, "the demo pane's workspace had another tab to close");
        await page.waitForFunction(() => document.querySelectorAll(".tab-strip-item").length === 1);

        await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
        const message = page.getByRole("textbox", { name: "Message", exact: true });
        await message.waitFor();

        // The iPhone Duo's 466x678-point outer display is compact even before its keyboard opens.
        // A regular-height phone below still keeps the row in the same one-tab state.
        await page.setViewportSize({ width: 466, height: 678 });
        await page.locator(".tab-strip").waitFor({ state: "detached" });
        assert.notEqual(await page.locator(".app-header").evaluate((node) => getComputedStyle(node).backdropFilter), "none",
          "the Duo outer display gives a lone-tab chat its glass header");
        await checkMenus(page, "duo-outer");
        // with the row out, its New tab entries stay in reach: the header's own menu carries them
        const sheet = page.locator(".row-sheet, .row-menu");
        await openMore(page);
        await sheet.getByText("New tab with agent\u2026", { exact: true }).click();
        await page.locator("#new-session-title").waitFor();
        await page.keyboard.press("Escape");
        await page.locator("#new-session-title").waitFor({ state: "detached" });
        // and the tab is named in a dialog, the row's inline field being gone with it
        await openMore(page);
        await sheet.getByText("Rename tab", { exact: true }).click();
        const tabName = page.getByRole("textbox", { name: "Tab name", exact: true });
        await tabName.fill("Duo tab");
        await tabName.press("Enter");
        await tabName.waitFor({ state: "detached" });
        // the palette's Rename tab (and its shortcut) opens the same dialog where the row is left out
        await openMore(page);
        await sheet.getByText("Search panes and actions", { exact: true }).click();
        const search = page.getByRole("searchbox", { name: "Search panes and actions", exact: true });
        await search.fill(">rename tab");
        await search.press("Enter");
        await tabName.waitFor();
        // an Escape that ends an IME composition leaves the dialog open
        await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true })));
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await tabName.count(), 1, "a composing Escape does not close the Rename tab dialog");
        await page.keyboard.press("Escape");
        await tabName.waitFor({ state: "detached" });
        // Move to workspace\u2026 lists the other workspaces in a second menu (the move itself is the last step)
        await openMore(page);
        await sheet.getByText("Move to workspace\u2026", { exact: true }).click();
        await sheet.getByText("Move Duo tab to", { exact: true }).waitFor();
        assert.ok(await sheet.locator(".row-sheet-item:not(.row-sheet-cancel)").count() > 0, "the second menu lists the other workspaces");
        await closeMenu(page);
        // Close tab asks first, as the row's does for a workspace's last tab
        await openMore(page);
        await sheet.getByText("Close tab", { exact: true }).click();
        const closeDialog = page.getByRole("alertdialog", { name: "Close tab Duo tab?" });
        await closeDialog.waitFor();
        await page.keyboard.press("Escape");
        await closeDialog.waitFor({ state: "detached" });
        // a landscape phone (wider than the sheet's breakpoint) draws the workspaces as a popover at the
        // header's More, all on screen, and Escape gives the focus back to that button
        await page.setViewportSize({ width: 667, height: 375 });
        await page.locator(".tab-strip").waitFor({ state: "detached" });
        await openMore(page);
        await sheet.getByText("Move to workspace\u2026", { exact: true }).click();
        const destinations = page.getByRole("menu", { name: "Move Duo tab to" });
        await destinations.waitFor();
        const box = await destinations.boundingBox();
        assert.ok(box && box.y >= 0 && box.y + box.height <= 375, `the workspaces menu is on screen (${JSON.stringify(box)})`);
        await page.keyboard.press("Escape");
        await destinations.waitFor({ state: "detached" });
        assert.ok(await page.locator(".header-more-button").evaluate((node) => node === document.activeElement), "Escape gives the focus back to the header's More");

        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator(".tab-strip").waitFor();
        await page.locator(".tab-strip-label", { hasText: "Duo tab" }).waitFor();
        assert.equal(await page.locator(".pane-frame.is-single .pane-frame-menu").isVisible(), false,
          "upright, the lone tab keeps its row, whose menu carries the pane's actions");
        // where the row is drawn, the header's menu stays as it was: the pane's and the tab's actions are the row's
        await openMore(page);
        assert.equal(await sheet.getByText("New terminal", { exact: true }).count(), 0, "upright, the header's menu does not repeat the row's");
        await closeMenu(page);
        // the row's own name field, opened upright, stays while a keyboard shortens the screen past the cutoff
        await page.locator(".tab-strip-menu").click();
        await sheet.getByText("Rename tab", { exact: true }).click();
        await tabName.fill("half typed");
        await page.setViewportSize({ width: 390, height: 650 });
        await page.waitForFunction(() => window.matchMedia("(max-width: 768px) and (max-height: 700px)").matches);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator(".tab-strip-rename").inputValue(), "half typed", "the row's name field keeps what was typed when the row would step out");
        await page.locator(".tab-strip-rename").press("Escape");
        await page.locator(".tab-strip").waitFor({ state: "detached" });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator(".tab-strip").waitFor();

        // the report's own moment: the message box focused and the keyboard up. Android shrinks the
        // layout viewport with it, under the 700px that drops a lone tab's row (TabStrip's cramped).
        await message.click();
        await page.setViewportSize({ width: 390, height: 470 });
        await page.evaluate(() => (window as Window & { glassViewport?: (value: number) => void }).glassViewport?.(470));
        await page.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard"));
        await page.locator(".tab-strip").waitFor({ state: "detached" });
        assert.notEqual(await page.locator(".app-header").evaluate((node) => getComputedStyle(node).backdropFilter), "none",
          "the chat of a lone tab with no row puts the glass header over the pane");
        await checkMenus(page, "chat-keyboard");

        // a view-only connection draws its "View only" banner at the pane's top right, below the glass header
        await page.evaluate(() => (window as SocketsWindow).glassSockets.at(-1)!.send(JSON.stringify({ type: "role", mode: "observe" })));
        await page.locator(".terminal-banner-observe").waitFor();
        await page.locator(".tab-strip").waitFor({ state: "detached" });
        await checkMenus(page, "chat-keyboard-view-only");
        const header = await page.locator(".app-header").boundingBox();
        if (!header) throw new Error("the glass header has a box");
        const banners = await page.locator(".terminal-banners > :not(.visually-hidden)").evaluateAll((nodes) => nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height, text: node.textContent?.trim() ?? "" };
        }).filter((box) => box.width > 0 && box.height > 0));
        assert.ok(banners.some((banner) => banner.text === "View only"), `the View only banner is drawn (${JSON.stringify(banners)})`);
        for (const banner of banners) {
          assert.ok(banner.y >= header.y + header.height - 0.5, `the banner "${banner.text}" ${JSON.stringify(banner)} starts below the glass header (bottom ${header.y + header.height})`);
        }
        // the move from the header's menu: the lone tab joins another workspace, and the view goes with its pane
        const before = new URL(page.url()).searchParams.get("ws");
        await openMore(page);
        await sheet.getByText("Move to workspace\u2026", { exact: true }).click();
        await sheet.getByText("Move Duo tab to", { exact: true }).waitFor();
        await sheet.locator(".row-sheet-item:not(.row-sheet-cancel)").first().click();
        await page.waitForFunction((was) => new URL(location.href).searchParams.get("ws") !== was, before);
        await page.locator(".tab-strip-label", { hasText: "Duo tab" }).waitFor();
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
  console.log("PASS phone glass header: with no tab row the header's More menu carries the pane's and the tab's actions, and no banner starts under the header");
} finally {
  rmSync(app, { recursive: true, force: true });
}

/** Opens the header's More menu (a sheet at phone width) and waits for it. */
async function openMore(page: Page): Promise<void> {
  await page.locator(".header-more-button").click();
  await page.locator(".row-sheet, .row-menu").waitFor();
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.locator(".row-sheet, .row-menu").waitFor({ state: "detached" });
}

/** With no row, the lone pane draws no ellipsis of its own: the header's is the one menu, and it carries the pane's and the tab's actions. */
async function checkMenus(page: Page, label: string): Promise<void> {
  assert.equal(await page.locator(".pane-frame.is-single .pane-frame-menu").count(), 0, `${label}: the lone pane draws no second ellipsis under the header's`);
  await openMore(page);
  const sheet = page.locator(".row-sheet, .row-menu");
  for (const item of ["Search panes and actions", "Rename pane", "Close pane", "New terminal", "New tab with agent\u2026", "Rename tab", "Move to workspace\u2026", "Close tab"]) {
    assert.equal(await sheet.getByText(item, { exact: true }).count(), 1, `${label}: the header's menu offers ${item}`);
  }
  assert.equal(await sheet.getByText("Split right", { exact: true }).count(), 0,
    `${label}: a canvas showing one pane at a time offers no split, as the row's menu does`);
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, `phone-glass-header-${label}.png`) });
  }
  await closeMenu(page);
}
