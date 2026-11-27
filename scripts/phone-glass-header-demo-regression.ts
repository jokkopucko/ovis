import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { withDemoBrowser } from "./demo-browser.ts";
import { openMoreGroup } from "./header-more.ts";
import { openLens } from "./header-lens.ts";

type SocketsWindow = Window & { glassSockets: WebSocket[] };

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
const serve = (app: string) => Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
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

await withDemoBrowser({ tempPrefix: "ovis-glass-header-demo-", serve, afterTransport: `\n<script>(${recordSockets.toString()})()</script>` }, async ({ newContext, baseUrl }) => {
  const context = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await context.addInitScript(() => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
  localStorage.setItem("ovis:phone-tabs", JSON.stringify("header"));
      const viewport = window.visualViewport!;
      let height = 795;
      Object.defineProperty(viewport, "height", { get: () => height });
      (window as Window & { glassViewport?: (value: number) => void }).glassViewport = (value) => {
        height = value;
        viewport.dispatchEvent(new Event("resize"));
      };
    });
    // the running session below is the Claude pane's turn: it stays at work, or on a slow runner the
    // demo ends it (4.5s in) before the header is read
    await context.addInitScript(() => Reflect.set(window, "__ovisDemoHoldTurn", true));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseUrl}?pane=${encodeURIComponent(panes.api)}`);
    await page.locator(".conn-live").waitFor();
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
    await page.waitForFunction(() => document.querySelector(".header-tabs-count") === null);
    await page.evaluate(async () => {
      const { snapshot } = await (await fetch("/api/session")).json() as { snapshot: { panes: { pane_id: string; agent: string | null; agent_status: string }[] } };
      const idle = snapshot.panes.find((pane) => pane.agent && pane.agent_status === "idle");
      if (!idle) throw new Error("the demo has an idle agent to finish");
      const hooks = (window as unknown as { __herdrDemoOrder: { status(pane: string, status: string): void } }).__herdrDemoOrder;
      hooks.status(idle.pane_id, "done");
    });
    await page.locator('.sidebar .sidebar-status[data-status="done"]').first().waitFor({ state: "attached" });
    await page.locator('.sidebar .sidebar-status[data-status="working"]').first().waitFor({ state: "attached" });
    assert.equal(await page.locator(".app-header .header-counts, .app-header .header-count").count(), 0, "a phone's header counts no running or finished sessions");

    await openLens(page, "chat");
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await message.waitFor();

    // The iPhone Duo's 466x678-point outer display is compact even before its keyboard opens.
    await page.setViewportSize({ width: 466, height: 678 });
    await page.locator(".pane-slot .tab-strip").waitFor({ state: "detached" });
    assert.notEqual(await page.locator(".app-header").evaluate((node) => getComputedStyle(node).backdropFilter), "none",
      "the Duo outer display gives a lone-tab chat its glass header");
    await checkMenus(page, "duo-outer");
    const sheet = page.locator(".row-sheet, .row-menu");
    await page.locator(".app-header .header-tabs-sheet").click();
    await sheet.getByText("New tab with agent\u2026", { exact: true }).click();
    await page.locator("#new-session-title").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#new-session-title").waitFor({ state: "detached" });
    await openPaneMenu(page);
    await sheet.getByText("Rename tab", { exact: true }).click();
    const tabName = page.getByRole("textbox", { name: "Tab name", exact: true });
    await tabName.fill("Duo tab");
    await tabName.press("Enter");
    await tabName.waitFor({ state: "detached" });
    await openMore(page);
    await sheet.getByText("Search panes and actions", { exact: true }).click();
    const search = page.getByRole("searchbox", { name: "Search panes and actions", exact: true });
    await search.fill(">rename tab");
    await search.press("Enter");
    await tabName.waitFor();
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true })));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await tabName.count(), 1, "a composing Escape does not close the Rename tab dialog");
    await page.keyboard.press("Escape");
    await tabName.waitFor({ state: "detached" });
    await openPaneMenu(page);
    await sheet.getByText("Move to workspace\u2026", { exact: true }).click();
    await sheet.getByText("Move Duo tab to", { exact: true }).waitFor();
    assert.ok(await sheet.locator(".row-sheet-item:not(.row-sheet-cancel)").count() > 0, "the second menu lists the other workspaces");
    await closeMenu(page);
    await openPaneMenu(page);
    await sheet.getByText("Close tab", { exact: true }).click();
    const closeDialog = page.getByRole("alertdialog", { name: "Close tab Duo tab?" });
    await closeDialog.waitFor();
    await page.keyboard.press("Escape");
    await closeDialog.waitFor({ state: "detached" });
    await page.setViewportSize({ width: 667, height: 375 });
    await page.locator(".pane-slot .tab-strip").waitFor({ state: "detached" });
    await openPaneMenu(page);
    await sheet.getByText("Move to workspace\u2026", { exact: true }).click();
    const destinations = page.getByRole("menu", { name: "Move Duo tab to" });
    await destinations.waitFor();
    const box = await destinations.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 375, `the workspaces menu is on screen (${JSON.stringify(box)})`);
    await page.keyboard.press("Escape");
    await destinations.waitFor({ state: "detached" });
    assert.ok(await page.locator(".header-more-button").evaluate((node) => node === document.activeElement), "Escape gives the focus back to the header's More");

    await page.setViewportSize({ width: 700, height: 900 });
    await tabRowShown(page);
    await page.locator(".tab-strip-label", { hasText: "Duo tab" }).waitFor();
    assert.equal(await page.locator(".pane-frame.is-single .pane-frame-menu").isVisible(), false,
      "upright, the lone tab keeps its row, whose menu carries the pane's actions");
    await openMore(page);
    assert.equal(await sheet.getByText("New terminal", { exact: true }).count(), 0, "upright, the header's menu does not repeat the row's");
    await closeMenu(page);
    await page.locator(".tab-strip-menu").click();
    await sheet.getByText("Rename tab", { exact: true }).click();
    await tabName.fill("half typed");
    await page.setViewportSize({ width: 700, height: 650 });
    await page.waitForFunction(() => window.matchMedia("(max-width: 768px) and (max-height: 700px)").matches);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator(".tab-strip-rename").inputValue(), "half typed", "the row's name field keeps what was typed when the row would step out");
    await page.locator(".tab-strip-rename").press("Escape");
    await page.locator(".pane-slot .tab-strip").waitFor({ state: "detached" });
    await page.setViewportSize({ width: 700, height: 900 });
    await tabRowShown(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".pane-slot .tab-strip").waitFor({ state: "detached" });
    await checkMenus(page, "phone");

    // Android shrinks the layout viewport with the keyboard up
    await message.click();
    await page.setViewportSize({ width: 390, height: 470 });
    await page.evaluate(() => (window as Window & { glassViewport?: (value: number) => void }).glassViewport?.(470));
    await page.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard"));
    await page.locator(".pane-slot .tab-strip").waitFor({ state: "detached" });
    assert.notEqual(await page.locator(".app-header").evaluate((node) => getComputedStyle(node).backdropFilter), "none",
      "the chat of a lone tab with no row puts the glass header over the pane");
    await checkMenus(page, "chat-keyboard");

    await page.evaluate(() => (window as SocketsWindow).glassSockets.at(-1)!.send(JSON.stringify({ type: "role", mode: "observe" })));
    await page.locator(".terminal-banner-observe").waitFor();
    await page.locator(".pane-slot .tab-strip").waitFor({ state: "detached" });
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
    const before = new URL(page.url()).searchParams.get("ws");
    await openPaneMenu(page);
    await sheet.getByText("Move to workspace\u2026", { exact: true }).click();
    await sheet.getByText("Move Duo tab to", { exact: true }).waitFor();
    await sheet.locator(".row-sheet-item:not(.row-sheet-cancel)").first().click();
    await page.waitForFunction((was) => new URL(location.href).searchParams.get("ws") !== was, before);
    await page.locator(".app-header .header-tabs-sheet").click();
    await sheet.getByText("Duo tab", { exact: true }).waitFor();
    await closeMenu(page);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
console.log("PASS phone glass header: with no tab row the header's More menu carries the pane's and the tab's actions, and no banner starts under the header");

// The row's own inputs (App.tsx and TabStrip.tsx read them): when it does not come back after a resize, the
// failure says which one still holds it away.
async function tabRowShown(page: Page): Promise<void> {
  await page.locator(".pane-slot .tab-strip").waitFor().catch(async (error: Error) => {
    const seen = await page.evaluate(() => ({
      viewport: [innerWidth, innerHeight],
      cramped: matchMedia("(max-width: 768px) and (max-height: 700px)").matches,
      sheet: matchMedia("(max-width: 640px)").matches,
      wide: matchMedia("(min-width: 769px)").matches,
      keyboard: document.documentElement.hasAttribute("data-keyboard"),
      address: location.search,
      slots: document.querySelectorAll(".pane-slot").length,
      tabs: document.querySelectorAll('[role="tab"]').length,
      strips: [...document.querySelectorAll(".tab-strip")].map((strip) => ({
        inSlot: strip.closest(".pane-slot") !== null,
        inHeader: strip.closest(".header-tabs") !== null,
        box: [strip.getBoundingClientRect().width, strip.getBoundingClientRect().height],
      })),
      alerts: [...document.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent?.trim()),
    })).catch(() => null);
    // a page that is gone gives no snapshot: the wait's own error is the failure then
    if (seen === null) throw error;
    throw new Error(`${error.message}\nthe tab row's inputs: ${JSON.stringify(seen)}`, { cause: error });
  });
}

async function openMore(page: Page): Promise<void> {
  await page.locator(".header-more-button").click();
  await page.locator(".row-sheet, .row-menu").waitFor();
}

async function openPaneMenu(page: Page): Promise<void> {
  await openMore(page);
  await openMoreGroup(page, "pane");
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.locator(".row-sheet, .row-menu").waitFor({ state: "detached" });
}

async function checkMenus(page: Page, label: string): Promise<void> {
  assert.equal(await page.locator(".pane-frame.is-single .pane-frame-menu").count(), 0, `${label}: the lone pane draws no second ellipsis under the header's`);
  const listed = await page.locator(".app-header .header-tabs-sheet").isVisible();
  const sheet = page.locator(".row-sheet, .row-menu");
  const newTab = ["New terminal", "New tab with agent\u2026"];
  if (listed) {
    await page.locator(".app-header .header-tabs-sheet").click();
    for (const item of newTab) assert.equal(await sheet.getByText(item, { exact: true }).count(), 1, `${label}: the title's list offers ${item}`);
    await closeMenu(page);
  }
  await openMore(page);
  assert.equal(await sheet.getByText("Search panes and actions", { exact: true }).count(), 1, `${label}: the header's menu offers Search panes and actions`);
  await openMoreGroup(page, "pane");
  for (const item of ["Rename pane", "Close pane", ...(listed ? [] : newTab), "Rename tab", "Move to workspace\u2026", "Close tab"]) {
    assert.equal(await sheet.getByText(item, { exact: true }).count(), 1, `${label}: the header's menu offers ${item}`);
  }
  for (const item of listed ? newTab : []) assert.equal(await sheet.getByText(item, { exact: true }).count(), 0, `${label}: More leaves ${item} to the title's list`);
  assert.equal(await sheet.getByText("Split right", { exact: true }).count(), 0,
    `${label}: a canvas showing one pane at a time offers no split, as the row's menu does`);
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, `phone-glass-header-${label}.png`) });
  }
  await closeMenu(page);
}
