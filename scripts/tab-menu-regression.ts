/** Native tab/pane menus and the live split canvas, on panes owned by this regression. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Locator, Page } from "playwright-core";
import type { PaneLayoutSnapshot, PaneSplit } from "../shared/protocol.ts";
import { paneFocus, paneRead, paneRename, paneSplit, paneZoom, sessionSnapshot, tabClose, tabCreate, tabMove, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { sheetsSettled } from "./sheets-settled.ts";
import { routeDrained } from "./drained-route.ts";
import { chromePath } from "./chrome-path.ts";

const TAB = "Tab 1";
const evidence = process.env.UI_EVIDENCE_DIR;
const frameSelector = (id: string) => `[data-layout-pane=${JSON.stringify(id)}]`;
const frame = (page: Page, id: string) => page.locator(frameSelector(id));
const screen = (page: Page, id: string) => frame(page, id).locator(".xterm-screen");

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await Bun.sleep(25);
  }
}
async function rect(locator: Locator, label: string) {
  const found = await locator.boundingBox();
  assert.ok(found, `${label} is visible`);
  return { top: found.y, bottom: found.y + found.height, left: found.x, right: found.x + found.width, width: found.width, height: found.height };
}
async function screenshot(page: Page, name: string): Promise<void> {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, `tab-menu-${name}.png`), animations: "disabled" });
}
async function layout(tabId: string): Promise<PaneLayoutSnapshot> {
  const found = (await sessionSnapshot()).layouts.find((candidate) => candidate.tab_id === tabId);
  assert.ok(found, "the owned tab has a layout");
  return found;
}
async function openApp(page: Page, origin: string, paneId: string): Promise<void> {
  await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
  await page.locator(".conn-live").waitFor();
  // a phone's header title lists the tabs in place of the row
  if ((page.viewportSize()?.width ?? Infinity) <= 640) await page.locator(".app-header .context-tabs").waitFor();
  else await page.getByRole("tab", { name: TAB, exact: true }).waitFor();
  await screen(page, paneId).waitFor();
}
// the browser's selection only: picking a pane in the web leaves herdr's focus where it is
async function currentPane(page: Page, paneId: string): Promise<void> {
  await page.locator(`${frameSelector(paneId)}.is-current`).waitFor();
}
async function paneMenu(page: Page, paneId: string): Promise<Locator> {
  await screen(page, paneId).click({ button: "right", position: { x: 32, y: 32 } });
  const menu = page.getByRole("menu", { name: /^Pane actions for / });
  await menu.waitFor();
  await until(() => menu.evaluate((node) => node.contains(document.activeElement)), "the pane menu takes keyboard focus");
  return menu;
}

async function checkDesktop(browser: Browser, origin: string, first: string, second: string, tabId: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false })));
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    const input: Array<{ type: string; pane_id: string; text?: string; keys?: string[] }> = [];
    const attaches: string[] = [];
    const detaches: string[] = [];
    const ready = new Set<string>();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === "input" || message.type === "keys") input.push(message);
        if (message.type === "attach") attaches.push(message.pane_id);
        if (message.type === "detach") detaches.push(message.pane_id);
      });
      socket.on("framereceived", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === "input-ready" && message.ready !== false) ready.add(message.pane_id);
      });
    });
    await paneFocus(first);
    await openApp(page, origin, first);
    await screen(page, second).waitFor();
    await until(() => ready.has(first) && ready.has(second), "both split terminals accept input");
    assert.equal(await page.locator(".pane-frame:visible").count(), 2, "both panes are shown simultaneously");
    const left = await rect(frame(page, first), "the first pane");
    const right = await rect(frame(page, second), "the second pane");
    assert.ok(left.right <= right.left + 2 && Math.abs(left.top - right.top) < 2, "the panes follow herdr's right split");
    const firstTerm = await frame(page, first).locator(".xterm").elementHandle();
    const secondTerm = await frame(page, second).locator(".xterm").elementHandle();

    // The menu remains a real Tab stop without taking Shift+F10 away from terminal programs.
    const paneButton = frame(page, first).locator(".pane-frame-menu");
    assert.equal(await paneButton.evaluate((node) => getComputedStyle(node).opacity), "0");
    await frame(page, first).focus();
    // the title is the pane's first Tab stop (Enter or Space on it focuses the pane's input), the menu the next
    await page.keyboard.press("Tab");
    assert.equal(await frame(page, first).locator('.pane-frame-title [role="button"]').evaluate((node) => node === document.activeElement), true, "Tab reaches the pane's title first");
    assert.equal(await paneButton.evaluate((node) => getComputedStyle(node).opacity), "0", "the title's focus leaves the menu button hidden");
    await page.keyboard.press("Tab");
    assert.equal(await paneButton.evaluate((node) => node === document.activeElement), true, "Tab reaches the pane menu");
    assert.equal(await paneButton.evaluate((node) => getComputedStyle(node).opacity), "1", "keyboard focus reveals the button");
    await screenshot(page, "keyboard-pane-button");
    await page.keyboard.press("Enter");
    const keyboardMenu = page.getByRole("menu", { name: /^Pane actions for / });
    await keyboardMenu.waitFor();
    await keyboardMenu.getByRole("menuitem", { name: "Rename pane", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await keyboardMenu.waitFor({ state: "detached" });

    // Both search bars stay mounted, but a new request must never focus the old sibling's bar.
    for (const target of [second, first]) {
      await frame(page, target).locator(".pane-frame-title").click();
      await currentPane(page, target);
      await page.keyboard.press("ControlOrMeta+Shift+F");
      await frame(page, target).locator('.find-bar input').waitFor();
    }
    assert.equal(await frame(page, first).locator('.find-bar input').evaluate((node) => node === document.activeElement), true, "search focus stays on the newly requested pane");
    for (const target of [second, first]) await frame(page, target).getByRole("button", { name: "Close search", exact: true }).click();

    const tab = page.getByRole("tab", { name: TAB, exact: true });
    const strip = page.locator(".tab-strip");
    const stripMenu = strip.locator(".tab-strip-item.is-active .tab-strip-menu");
    const opacity = (locator: Locator) => locator.evaluate((node) => getComputedStyle(node).opacity);
    const pointerOffStrip = () => page.mouse.move(640, 600);
    assert.equal(await strip.locator(".tab-strip-panes").count(), 0, "tabs render no chevrons");
    // the header's row is a browser's tab strip: only the open tab shows its close at rest
    assert.equal(await strip.locator(".tab-strip-close:visible").count(), 1, "only the open tab shows its close at rest");
    // The selected tab's menu button holds its place hidden until the pointer is over the strip or
    // the tab has keyboard focus, and opens the trimmed menu a touch screen's button does.
    await pointerOffStrip();
    assert.equal(await strip.locator(".tab-strip-menu:visible").count(), 0, "a desktop tab's menu button stays hidden at rest");
    await strip.hover();
    await stripMenu.waitFor({ state: "visible" });
    await until(async () => await opacity(stripMenu) === "1", "the pointer over the strip fades the selected tab's menu button in");
    assert.equal(await strip.locator(".tab-strip-menu:visible").count(), 1, "only the selected tab shows a menu button");
    assert.equal(await stripMenu.getAttribute("aria-haspopup"), "menu");
    await screenshot(page, "desktop-hover-button");
    await pointerOffStrip();
    await stripMenu.waitFor({ state: "hidden" });
    await strip.hover();
    await stripMenu.waitFor({ state: "visible" });
    await stripMenu.click();
    const tabMenu = page.getByRole("menu", { name: TAB, exact: true });
    // as paneMenu above: the menu takes the focus a frame after it opens, and Escape comes after that
    const tabMenuFocused = () => until(() => tabMenu.evaluate((node) => node.contains(document.activeElement)), "the tab menu takes keyboard focus");
    await tabMenu.waitFor();
    await tabMenuFocused();
    assert.deepEqual((await tabMenu.getByRole("menuitem").allTextContents()).filter((item) => item !== "Clear pane name"),
      ["Rename pane", "Split right", "Split down", "Zoom pane", "Close pane", "New tab with agent…", "Rename tab", "Close tab"], "the button's menu carries the open pane's actions and the tab's (the + is a shell tab, so the agent's dialog stays here)");
    await page.keyboard.press("Escape");
    await tabMenu.waitFor({ state: "detached" });
    assert.equal(await tab.evaluate((node) => node === document.activeElement), true, "the button's menu returns focus to the tab");
    // Escape leaves keyboard focus on the tab, which keeps its button in view until the focus moves on.
    await frame(page, first).locator(".xterm-helper-textarea").focus();
    await pointerOffStrip();
    await stripMenu.waitFor({ state: "hidden" });
    await page.locator(".tab-strip-add").focus();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await tab.evaluate((node) => node === document.activeElement), true, "Shift+Tab from the + lands on the selected tab");
    await stripMenu.waitFor({ state: "visible" });
    await until(async () => await opacity(stripMenu) === "1", "keyboard focus on the tab reveals its menu button");
    await screenshot(page, "desktop-keyboard-button");
    await page.keyboard.press("Tab");
    assert.equal(await stripMenu.evaluate((node) => node === document.activeElement), true, "Tab reaches the menu button");
    await page.keyboard.press("Enter");
    await tabMenu.waitFor();
    await tabMenuFocused();
    await tabMenu.getByRole("menuitem", { name: "Rename tab", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await tabMenu.waitFor({ state: "detached" });
    assert.equal(await tab.evaluate((node) => node === document.activeElement), true, "Escape returns focus to the tab");
    // Reduced motion takes the fade away, and with it the delay that kept the button in view while
    // the focus crossed from the tab to it: the same keyboard route must hold without any transition.
    await page.emulateMedia({ reducedMotion: "reduce" });
    try {
      await frame(page, first).locator(".xterm-helper-textarea").focus();
      await pointerOffStrip();
      await stripMenu.waitFor({ state: "hidden" });
      assert.equal(await stripMenu.evaluate((node) => getComputedStyle(node).transitionDuration), "0s", "reduced motion leaves the menu button no transition");
      await page.locator(".tab-strip-add").focus();
      await page.keyboard.press("Shift+Tab");
      assert.equal(await tab.evaluate((node) => node === document.activeElement), true, "reduced motion: Shift+Tab from the + lands on the selected tab");
      await stripMenu.waitFor({ state: "visible" });
      await page.keyboard.press("Tab");
      assert.equal(await stripMenu.evaluate((node) => node === document.activeElement), true, "reduced motion: Tab reaches the menu button");
      assert.equal(await opacity(stripMenu), "1", "reduced motion: the focused menu button is in view");
      await screenshot(page, "desktop-keyboard-button-reduced");
      await page.keyboard.press("Enter");
      await tabMenu.waitFor();
      await tabMenuFocused();
      await tabMenu.getByRole("menuitem", { name: "Rename tab", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await tabMenu.waitFor({ state: "detached" });
      assert.equal(await tab.evaluate((node) => node === document.activeElement), true, "reduced motion: Escape returns focus to the tab");
    } finally { await page.emulateMedia({ reducedMotion: null }); }
    await frame(page, first).locator(".xterm-helper-textarea").focus();
    await pointerOffStrip();
    await stripMenu.waitFor({ state: "hidden" });
    await tab.click({ button: "right" });
    await tabMenu.waitFor();
    assert.deepEqual(await tabMenu.getByRole("menuitem").allTextContents(), ["New tab with agent…", "Rename tab", "Close tab"], "right-click keeps the full tab menu: only tab actions");
    assert.equal(await tabMenu.locator(".layout-map").count(), 0, "the canvas replaces the miniature pane picker");
    await page.keyboard.press("Escape");
    await tabMenu.waitFor({ state: "detached" });

    // The tab row retains a keyboard route to the context menu after removing its desktop buttons.
    for (const key of ["Shift+F10", "ContextMenu"]) {
      await tab.focus();
      await page.keyboard.press(key);
      await tabMenu.waitFor();
      assert.deepEqual(await tabMenu.getByRole("menuitem").allTextContents(), ["New tab with agent…", "Rename tab", "Close tab"]);
      await page.keyboard.press("Escape");
      await tabMenu.waitFor({ state: "detached" });
      assert.equal(await tab.evaluate((node) => node === document.activeElement), true, `${key}: dismissal returns focus to the tab`);
    }

    // Narrow windows keep an explicit route in view, even with a mouse. Back on a desktop it waits hidden again.
    await page.setViewportSize({ width: 700, height: 800 });
    const narrowMenu = page.getByRole("button", { name: `Actions for ${TAB}`, exact: true });
    await narrowMenu.waitFor();
    assert.equal(await strip.locator(".tab-strip-menu:visible").count(), 1);
    await until(async () => await page.locator(".pane-frame:visible").count() === 1, "a narrow window shows the split tab's open pane alone");
    await narrowMenu.click();
    await tabMenu.waitFor();
    await tabMenuFocused();
    const narrowItems = await tabMenu.getByRole("menuitem").allTextContents();
    assert.deepEqual(narrowItems.slice(0, 2).sort(), ["canvas-first", "canvas-second"], "a narrow window's tab menu lists the tab's panes first");
    assert.deepEqual(narrowItems.slice(-3), ["New tab with agent…", "Rename tab", "Close tab"], "the strip's + is a shell tab: the menu keeps the agent's dialog");
    assert.deepEqual(narrowItems.slice(2, -3).filter((item) => item !== "Clear pane name"),
      ["Rename pane", "Close pane"], "the touch menu carries the open pane's actions but no split or zoom, between its panes and the tab's");
    await page.setViewportSize({ width: 1280, height: 800 });
    await tabMenu.waitFor({ state: "detached" });
    await pointerOffStrip();
    await narrowMenu.waitFor({ state: "hidden" });
    assert.equal(await tab.evaluate((node) => node === document.activeElement), true, "the resize closes the menu and restores a visible tab");
    // the strip moves between the header (from 769px) and the pane as the window is resized: a focused
    // tab's focus goes with it to the open tab of the strip drawn now, both ways
    const openTabFocused = (label: string) => until(async () => await page.evaluate(() => {
      const active = document.activeElement;
      return active?.getAttribute("role") === "tab" && active.getAttribute("aria-selected") === "true" && active.isConnected;
    }), label);
    await tab.focus();
    await page.setViewportSize({ width: 700, height: 800 });
    await page.locator(".pane-slot .tab-strip").waitFor();
    await openTabFocused("narrowed, the pane's strip has the focused open tab");
    assert.equal(await page.evaluate(() => document.activeElement?.closest(".header-tabs") === null), true, "the focus left the header's strip with it");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator(".header-tabs .tab-strip").waitFor();
    await openTabFocused("widened again, the header's strip has the focused open tab");
    await pointerOffStrip();

    // Right-click targets an inactive tab without activating it; Close removes only that target.
    const nativeTab = (await sessionSnapshot()).tabs.find((candidate) => candidate.tab_id === tabId)!;
    const target = await tabCreate({ workspaceId: nativeTab.workspace_id, label: "menu-target" });
    const inactive = page.getByRole("tab", { name: "menu-target", exact: true });
    await inactive.waitFor();
    await strip.hover();
    assert.equal(await strip.locator(".tab-strip-item:not(.is-active) .tab-strip-menu").count(), 0, "an unselected tab draws no menu button, hovered or not");
    await pointerOffStrip();
    const order = () => strip.getByRole("tab").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset["tabId"]));
    const originalOrder = [tabId, target.tab.tab_id];
    const movedOrder = [target.tab.tab_id, tabId];
    const firstTab = strip.locator(`[data-tab-id=${JSON.stringify(tabId)}]`);
    const movePaths: string[] = [];
    page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/tab/move")) movePaths.push(request.url()); });
    const dragInactiveBeforeFirst = async (release = true) => {
      const from = await rect(inactive, "inactive reorder source");
      const to = await rect(firstTab, "first reorder target");
      await page.mouse.move(from.left + from.width / 2, from.top + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.left + 2, to.top + to.height / 2, { steps: 8 });
      if (release) await page.mouse.up();
    };
    await frame(page, first).locator(".xterm-helper-textarea").focus();
    await dragInactiveBeforeFirst();
    await until(async () => JSON.stringify(await order()) === JSON.stringify(movedOrder), "a drag changes native tab order");
    assert.deepEqual((await sessionSnapshot()).tabs.filter((entry) => entry.workspace_id === nativeTab.workspace_id).map((entry) => entry.tab_id), movedOrder);
    await currentPane(page, first);
    assert.equal((await sessionSnapshot()).focused_pane_id, first, "dragging an inactive tab preserves native pane focus");
    assert.equal(await frame(page, first).locator(".xterm-helper-textarea").evaluate((node) => node === document.activeElement), true, "dragging preserves terminal keyboard focus");
    await until(async () => await strip.getAttribute("aria-busy") === "false", "the move is acknowledged");
    await inactive.focus();
    await page.keyboard.press("Alt+Shift+ArrowRight");
    await until(async () => JSON.stringify(await order()) === JSON.stringify(originalOrder), "focus-local reorder moves right");
    assert.equal(await inactive.evaluate((node) => node === document.activeElement), true, "keyboard reorder retains the same tab button");
    await until(async () => await strip.getAttribute("aria-busy") === "false", "keyboard order acknowledged");

    // A second explicit gesture during an in-flight request is not queued behind it.
    let releaseMove!: () => void;
    const gate = new Promise<void>((resolve) => { releaseMove = resolve; });
    let heldMoves = 0;
    await page.route("**/api/tab/move", async (route) => { heldMoves += 1; await gate; await route.continue(); });
    try {
      await inactive.focus();
      await page.keyboard.press("Alt+Shift+ArrowLeft");
      await until(() => heldMoves === 1, "first move reaches the bridge");
      assert.equal(await strip.getAttribute("aria-busy"), "true");
      await page.keyboard.press("Alt+Shift+ArrowLeft");
      releaseMove();
      await until(async () => JSON.stringify(await order()) === JSON.stringify(movedOrder) && await strip.getAttribute("aria-busy") === "false", "held move settles");
      assert.equal(heldMoves, 1, "only one request was sent, with no delayed gesture queued");
    } finally { releaseMove(); await page.unroute("**/api/tab/move"); }
    await inactive.focus();
    await page.keyboard.press("Alt+Shift+ArrowRight");
    await until(async () => JSON.stringify(await order()) === JSON.stringify(originalOrder) && await strip.getAttribute("aria-busy") === "false", "original order restored after serialization check");

    // Control the ACK/snapshot order: while the request waits, an unrelated native tab is
    // published. Then acknowledge the requested order before applying it to the native fixture.
    // The old unrelated snapshot must not open the gate for another insertion coordinate.
    let acknowledge!: (tabs: Awaited<ReturnType<typeof sessionSnapshot>>["tabs"]) => void;
    const acknowledgedTabs = new Promise<Awaited<ReturnType<typeof sessionSnapshot>>["tabs"]>((resolve) => { acknowledge = resolve; });
    let raceRequests = 0;
    await page.route("**/api/tab/move", async (route) => {
      raceRequests += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, tabs: await acknowledgedTabs }) });
    });
    let raceTab: string | null = null;
    try {
      await inactive.focus();
      await page.keyboard.press("Alt+Shift+ArrowLeft");
      await until(() => raceRequests === 1, "the reorder request waits before acknowledgement");
      const extra = await tabCreate({ workspaceId: nativeTab.workspace_id, label: "unrelated-before-ack" });
      raceTab = extra.tab.tab_id;
      await page.getByRole("tab", { name: "unrelated-before-ack", exact: true }).waitFor();
      const beforeAck = (await sessionSnapshot()).tabs.filter((entry) => entry.workspace_id === nativeTab.workspace_id);
      const expected = [beforeAck.find((entry) => entry.tab_id === target.tab.tab_id)!, ...beforeAck.filter((entry) => entry.tab_id !== target.tab.tab_id)];
      const response = page.waitForResponse((entry) => entry.request().method() === "POST" && new URL(entry.url()).pathname.endsWith("/tab/move"));
      acknowledge(expected);
      await (await response).finished();
      // Wait for the response's React commit, not for a guessed duration.
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      assert.equal(await strip.getAttribute("aria-busy"), "true", "an unrelated pre-ACK snapshot does not acknowledge the move");
      await inactive.focus();
      await page.keyboard.press("Alt+Shift+ArrowLeft");
      assert.equal(raceRequests, 1, "a gesture is not sent using that stale order");
      assert.deepEqual(await order(), [tabId, target.tab.tab_id, raceTab], "the HTTP response alone does not paint an optimistic order");
      await tabMove(target.tab.tab_id, 0);
      await until(async () => JSON.stringify(await order()) === JSON.stringify(expected.map((entry) => entry.tab_id)) && await strip.getAttribute("aria-busy") === "false", "the expected native snapshot acknowledges the request");
      await currentPane(page, first);
    } finally {
      acknowledge([]);
      await page.unroute("**/api/tab/move");
      if (raceTab) await tabClose(raceTab);
      await tabMove(target.tab.tab_id, 2);
    }
    await until(async () => JSON.stringify(await order()) === JSON.stringify(originalOrder), "original order restored after ACK race check");

    const beforeCancel = movePaths.length;
    await dragInactiveBeforeFirst(false);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.equal(await strip.locator(".is-dragging, .is-drop-before, .is-drop-after").count(), 0);
    assert.equal(movePaths.length, beforeCancel, "Escape cancels before any mutation is sent");
    assert.deepEqual(await order(), originalOrder);

    // A rejected move never paints a fictitious order or changes the selected tab.
    await page.route("**/api/tab/move", (route) => route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: { code: "test_refusal", message: "reorder test refused" } }) }));
    await inactive.focus();
    await page.keyboard.press("Alt+Shift+ArrowLeft");
    await strip.getByRole("alert").filter({ hasText: "reorder test refused" }).waitFor();
    assert.deepEqual(await order(), originalOrder);
    await currentPane(page, first);
    await page.unroute("**/api/tab/move");

    // A topology change while pressed invalidates the original insertion coordinates.
    await dragInactiveBeforeFirst(false);
    const extra = await tabCreate({ workspaceId: nativeTab.workspace_id, label: "cancel-drag" });
    await page.getByRole("tab", { name: "cancel-drag", exact: true }).waitFor();
    const beforeStaleRelease = movePaths.length;
    await page.mouse.up();
    assert.equal(movePaths.length, beforeStaleRelease, "a stale drag is not sent after a tab appears");
    await tabClose(extra.tab.tab_id);
    await page.getByRole("tab", { name: "cancel-drag", exact: true }).waitFor({ state: "detached" });
    await currentPane(page, first);
    await frame(page, first).locator(".xterm-helper-textarea").focus();
    await inactive.click({ button: "right" });
    const inactiveMenu = page.getByRole("menu", { name: "menu-target", exact: true });
    await inactiveMenu.waitFor();
    assert.equal(await tab.getAttribute("aria-selected"), "true", "the open tab does not change when another tab is right-clicked");
    assert.equal((await sessionSnapshot()).focused_pane_id, first, "the menu does not change native focus");
    await page.keyboard.press("Escape");
    await inactiveMenu.waitFor({ state: "detached" });
    assert.equal(await frame(page, first).locator(".xterm-helper-textarea").evaluate((node) => node === document.activeElement), true, "right-click dismissal restores terminal input");
    await inactive.click({ button: "right" });
    await inactiveMenu.waitFor();
    const closingTab = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/tab/close"));
    await inactiveMenu.getByRole("menuitem", { name: "Close tab", exact: true }).click();
    const closeTabResponse = await closingTab;
    assert.equal(closeTabResponse.status(), 200);
    assert.deepEqual(closeTabResponse.request().postDataJSON(), { tab_id: target.tab.tab_id });
    await inactive.waitFor({ state: "detached" });
    await currentPane(page, first);
    assert.equal(await strip.getByRole("tab").count(), 1, "closing an inactive tab preserves the original tab");
    // the header's row is a browser's tab strip: only the open tab draws its close, even under the pointer, and a
    // resting tab's middle click closes it alone, at once, as a browser's does
    const closable = await tabCreate({ workspaceId: nativeTab.workspace_id, label: "close-x" });
    const closableTab = page.getByRole("tab", { name: "close-x", exact: true });
    await closableTab.hover();
    assert.equal(await strip.locator(".tab-strip-item:not(.is-active)").filter({ has: closableTab }).locator(".tab-strip-close:visible").count(), 0, "a hovered resting tab draws no close");
    const closingByX = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/tab/close"));
    await closableTab.click({ button: "middle" });
    assert.deepEqual((await closingByX).request().postDataJSON(), { tab_id: closable.tab.tab_id });
    await closableTab.waitFor({ state: "detached" });
    assert.equal(await tab.getAttribute("aria-selected"), "true", "closing another tab by its close keeps the open tab");
    assert.equal(await strip.getByRole("tab").count(), 1);

    // Closing through Delete must return keyboard focus with the native removal, even when
    // its HTTP acknowledgement arrives later than the new snapshot.
    const keyboardTarget = await tabCreate({ workspaceId: nativeTab.workspace_id, label: "keyboard-close-target" });
    const keyboardTab = strip.locator(`[data-tab-id=${JSON.stringify(keyboardTarget.tab.tab_id)}]`);
    await keyboardTab.waitFor();
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    let closeAnswered = false;
    await page.route("**/api/tab/close", async (route) => {
      const response = await route.fetch();
      await closeGate;
      await route.fulfill({ response });
      closeAnswered = true;
    });
    try {
      await firstTab.focus();
      await page.keyboard.press("ArrowRight");
      assert.equal(await keyboardTab.evaluate((node) => node === document.activeElement), true);
      await page.keyboard.press("Delete");
      await keyboardTab.waitFor({ state: "detached" });
      assert.equal(closeAnswered, false, "the close acknowledgement remains held");
      await until(() => firstTab.evaluate((node) => node === document.activeElement), "native tab removal returns focus before its HTTP acknowledgement");
      await currentPane(page, first);
      assert.equal(await strip.getByRole("tab").count(), 1);
      releaseClose();
      await until(() => closeAnswered, "the close acknowledgement is delivered");
      assert.equal(await firstTab.evaluate((node) => node === document.activeElement), true, "acknowledgement preserves the surviving tab's focus");
    } finally { releaseClose(); await page.unroute("**/api/tab/close"); }


    // An inactive pane is a menu target, not a focus change. Menu arrows and Escape never type.
    await frame(page, first).locator(".xterm-helper-textarea").focus();
    await currentPane(page, first);
    const beforeMenuInput = input.length;
    assert.equal(await frame(page, second).locator(".pane-frame-menu").evaluate((node) => getComputedStyle(node).opacity), "0", "the pane ellipsis stays visually hidden without keyboard focus");
    let menu = await paneMenu(page, second);
    assert.equal(await frame(page, first).evaluate((node) => node.classList.contains("is-current")), true);
    assert.equal((await sessionSnapshot()).focused_pane_id, first, "right-click leaves native focus on the first pane");
    await menu.getByRole("menuitem", { name: "Swap with focused pane", exact: true }).waitFor();
    const menuBox = await rect(menu, "the pane menu");
    assert.ok(menuBox.left >= 0 && menuBox.right <= 1280 && menuBox.top >= 0 && menuBox.bottom <= 800, "the pointer menu stays inside the screen");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert.equal(await frame(page, first).locator(".xterm-helper-textarea").evaluate((node) => node === document.activeElement), true, "Escape restores the previous input focus");
    // Moving the pointer onto a mouse-reporting app can produce an unpressed SGR motion
    // before the right click. The menu must intercept presses, releases and keyboard input.
    const menuInput = input.slice(beforeMenuInput).filter((message) => message.type !== "input" || !/^\x1b\[<35;\d+;\d+M$/.test(message.text ?? ""));
    assert.deepEqual(menuInput, [], "opening and navigating a pane menu sends no button or keyboard input");

    if (process.platform === "darwin") {
      await frame(page, second).locator(".pane-frame-head").click({ modifiers: ["Control"] });
      menu = page.getByRole("menu", { name: /^Pane actions for / });
      await menu.waitFor();
      assert.equal((await sessionSnapshot()).focused_pane_id, first, "Mac Control-click preserves native focus");
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
    }

    menu = await paneMenu(page, second);
    const swap = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/pane/swap"));
    await menu.getByRole("menuitem", { name: "Swap with focused pane", exact: true }).click();
    const swapped = await swap;
    assert.equal(swapped.status(), 200);
    assert.deepEqual(swapped.request().postDataJSON(), { pane_id: first, target_pane_id: second });
    await until(async () => (await rect(frame(page, first), "first after swap")).left > (await rect(frame(page, second), "second after swap")).left, "the actual pane contents swap positions");
    await currentPane(page, first);

    // Real shell output proves input is addressed to the clicked pane, not merely painted there.
    for (const [target, other, marker] of [[first, second, "CANVAS_FIRST_INPUT"], [second, first, "CANVAS_SECOND_INPUT"]] as const) {
      await frame(page, target).locator(".pane-frame-title").click();
      await currentPane(page, target);
      assert.equal(await frame(page, target).locator(".xterm-helper-textarea").evaluate((node) => node === document.activeElement), true, "a frame title selects its terminal for typing");
      const start = input.length;
      await page.keyboard.type(`printf '${marker}\\n'`);
      await page.keyboard.press("Enter");
      await until(async () => (await paneRead({ paneId: target, source: "visible" })).text.includes(marker), `the target shell received ${marker}`);
      await until(() => input.slice(start).some((message) => message.pane_id === target), "the typed frames are observed");
      assert.ok(input.slice(start).every((message) => message.pane_id === target), "every typed frame belongs to the target pane");
      assert.equal((await paneRead({ paneId: other, source: "visible" })).text.includes(marker), false, "the sibling shell receives none of the marker");
    }

    menu = await paneMenu(page, second);
    const splitting = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/pane/split"));
    await menu.getByRole("menuitem", { name: "Split down", exact: true }).click();
    const splitResponse = await splitting;
    assert.equal(splitResponse.status(), 200);
    assert.deepEqual(splitResponse.request().postDataJSON(), { pane_id: second, direction: "down", focus: true });
    const third = ((await splitResponse.json()) as PaneSplit).pane.pane_id;
    await screen(page, third).waitFor();
    await until(() => ready.has(third), "the newly split terminal accepts input");
    await currentPane(page, third);
    assert.equal(await page.locator(".pane-frame:visible").count(), 3, "a split adds a live third pane");
    assert.equal(await frame(page, first).locator(".xterm").evaluate((node, old) => node === old, firstTerm), true, "splitting keeps the first terminal mounted");
    assert.equal(await frame(page, second).locator(".xterm").evaluate((node, old) => node === old, secondTerm), true, "splitting keeps the second terminal mounted");

    const vertical = page.locator('.pane-divider[aria-orientation="vertical"]');
    assert.equal(await page.getByRole("separator", { name: "Resize split", exact: true }).count(), 2);
    const beforeRatio = (await layout(tabId)).splits.find((split) => /_root$/.test(split.id))!.ratio;
    const grip = await rect(vertical, "the root divider");
    const canvas = await rect(page.locator(".pane-canvas"), "the canvas");
    const movedRatio = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/layout/ratio"));
    // Avoid the horizontal divider's intersection with this vertical root divider.
    await page.mouse.move(grip.left + grip.width / 2, grip.top + grip.height / 4);
    await page.mouse.down();
    await page.mouse.move(grip.left + grip.width / 2 + canvas.width * 0.12, grip.top + grip.height / 4, { steps: 5 });
    await page.mouse.up();
    const ratioResponse = await movedRatio;
    assert.equal(ratioResponse.status(), 200);
    assert.deepEqual(ratioResponse.request().postDataJSON().path, []);
    await until(async () => (await layout(tabId)).splits.find((split) => /_root$/.test(split.id))!.ratio > beforeRatio + 0.08, "divider dragging changes herdr's root ratio");
    await until(async () => Number(await vertical.getAttribute("aria-valuenow")) > Math.round(beforeRatio * 100) + 8, "the visible divider follows herdr");
    await screenshot(page, "canvas-three-panes");

    const attachedBeforeZoom = attaches.length;
    const detachedBeforeZoom = detaches.length;
    menu = await paneMenu(page, third);
    await menu.getByRole("menuitem", { name: "Zoom pane", exact: true }).click();
    await until(async () => (await layout(tabId)).zoomed && await page.locator(".pane-frame:visible").count() === 1, "the selected pane zooms");
    await currentPane(page, third);
    assert.equal(await page.locator(".pane-frame").count(), 3, "zoom keeps sibling mounts");
    assert.equal(await page.locator(".pane-divider").count(), 0, "zoom hides split dividers");
    menu = await paneMenu(page, third);
    await menu.getByRole("menuitem", { name: "Unzoom pane", exact: true }).click();
    await until(async () => !(await layout(tabId)).zoomed && await page.locator(".pane-frame:visible").count() === 3, "unzoom restores the split canvas");
    await currentPane(page, third);
    assert.equal(attaches.length, attachedBeforeZoom, "zoom does not reattach terminals");
    assert.equal(detaches.length, detachedBeforeZoom, "zoom does not detach sibling terminals");
    assert.equal(await frame(page, first).locator(".xterm").evaluate((node, old) => node === old, firstTerm), true);
    assert.equal(await frame(page, second).locator(".xterm").evaluate((node, old) => node === old, secondTerm), true);
    // A closed selected pane is absent from the roster before App's confirmation read answers.
    // Keep that read pending: the surviving terminals must not disappear or lose their leases.
    let releaseSelection!: () => void;
    const selectionGate = new Promise<void>((resolve) => { releaseSelection = resolve; });
    let selectionReads = 0;
    const unrouteSelection = await routeDrained(page, "**/api/session", async (route) => {
      selectionReads += 1;
      const response = await route.fetch();
      await selectionGate;
      await route.fulfill({ response });
    });
    const survivingAttaches = () => attaches.filter((id) => id === first || id === second).length;
    const survivingDetaches = () => detaches.filter((id) => id === first || id === second).length;
    const beforeCloseAttaches = survivingAttaches();
    const beforeCloseDetaches = survivingDetaches();
    try {
      menu = await paneMenu(page, third);
      await menu.getByRole("menuitem", { name: "Close pane", exact: true }).click();
      await frame(page, third).waitFor({ state: "detached" });
      await until(() => selectionReads > 0, "the missing selected pane awaits confirmation");
      await page.locator('.pane-canvas[aria-busy="true"]').waitFor();
      assert.equal(await page.locator(".pane-frame:visible").count(), 2, "closing a pane keeps the surviving split while selection is pending");
      assert.equal(await frame(page, first).locator(".xterm").evaluate((node, old) => node === old, firstTerm), true, "the first sibling survives the pending selection");
      assert.equal(await frame(page, second).locator(".xterm").evaluate((node, old) => node === old, secondTerm), true, "the second sibling survives the pending selection");
      assert.equal(survivingAttaches(), beforeCloseAttaches, "the surviving panes do not reattach while selection is pending");
      assert.equal(survivingDetaches(), beforeCloseDetaches, "the surviving panes do not detach while selection is pending");
      releaseSelection();
      await page.locator('.pane-canvas[aria-busy="true"]').waitFor({ state: "detached" });
      // the selection moves as herdr's TUI focus would (lib/paneAfterClose.ts): to the pane selected
      // before the closed one, not to herdr's own focus, which the browser's picks never moved
      await currentPane(page, second);
      assert.equal(await page.locator(".pane-frame:visible").count(), 2, "closing a pane restores the surviving split");
      assert.equal(await frame(page, first).locator(".xterm").evaluate((node, old) => node === old, firstTerm), true, "the first terminal remains the same after confirmation");
      assert.equal(await frame(page, second).locator(".xterm").evaluate((node, old) => node === old, secondTerm), true, "the second terminal remains the same after confirmation");
      assert.equal(survivingAttaches(), beforeCloseAttaches);
      assert.equal(survivingDetaches(), beforeCloseDetaches);
    } finally {
      releaseSelection();
      await unrouteSelection();
      await firstTerm?.dispose();
      await secondTerm?.dispose();
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

async function checkPhone(browser: Browser, origin: string, first: string, second: string, viewport: { width: number; height: number }): Promise<void> {
  // Opening a pane URL restores the browser selection; it does not change herdr focus.
  // Start from a known native focus before checking that a reorder preserves it.
  await paneFocus(first);
  const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false })));
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openApp(page, origin, first);
    await screen(page, second).waitFor({ state: "attached" });
    assert.equal(await page.locator(".pane-frame:visible").count(), 1, "a phone shows the split tab's open pane alone");
    assert.equal(await frame(page, first).isVisible(), true, "the open pane is the one shown");
    assert.equal(await page.locator(".pane-frame").count(), 2, "its sibling stays mounted");
    assert.equal(await page.locator(".pane-divider").count(), 0, "a phone draws no split boundary");
    // a phone's header title lists the tabs: no row, and More is the open tab's and pane's menu
    assert.equal(await page.locator(".tab-strip").count(), 0, "the phone draws no tab row");
    const titleBox = await rect(page.locator(".context.has-tabs"), "the header's title");
    assert.ok(titleBox.width >= 44 && titleBox.height >= 44, "the title that lists the tabs is a touch-sized target");
    const touchMenu = page.locator(".header-more-button");
    const touchBox = await rect(touchMenu, "the header's More");
    assert.ok(touchBox.width >= 40 && touchBox.height >= 40, "More remains a touch-sized target");
    await touchMenu.tap();
    const tabSheet = page.getByRole("dialog", { name: "More", exact: true });
    await tabSheet.waitFor();
    // herdr's own pane order stands (the desktop check above swapped the two)
    const all = await tabSheet.locator(".row-sheet-item .row-sheet-label").allTextContents();
    const at = all.findIndex((item) => item === "canvas-first" || item === "canvas-second");
    const phoneItems = all.slice(at);
    assert.deepEqual(phoneItems.slice(0, 2).sort(), ["canvas-first", "canvas-second"], "the split tab's panes lead its actions in More on a phone");
    // the pane's and the tab's actions fold into More's last item, opening a sheet of their own (G-143)
    assert.deepEqual(phoneItems.slice(2), ["Pane and tab…"], "More ends in Pane and tab… on a phone");
    const paneSheet = page.getByRole("dialog", { name: "Pane and tab…", exact: true });
    const openPaneSheet = async (): Promise<void> => {
      await tabSheet.getByRole("button", { name: "Pane and tab…", exact: true }).tap();
      await paneSheet.waitFor();
      await sheetsSettled(page);
    };
    await sheetsSettled(page);
    await openPaneSheet();
    const actions = await paneSheet.locator(".row-sheet-item .row-sheet-label").allTextContents();
    assert.deepEqual(actions.slice(-2), ["Rename tab", "Close tab"], "the tab's own actions close the list; New tab is the title list's");
    assert.deepEqual(actions.slice(0, -2).filter((item) => item !== "Clear pane name"),
      ["Rename pane", "Close pane"], "the open pane's actions, less split and zoom, come before the tab's");
    await paneSheet.getByRole("button", { name: "Cancel", exact: true }).tap();
    await paneSheet.waitFor({ state: "detached" });
    await touchMenu.tap();
    await tabSheet.waitFor();
    assert.equal(await tabSheet.getByRole("button", { name: "canvas-first", exact: true }).getAttribute("aria-current"), "true", "the open pane is marked");
    // More is a phone's way to the other pane, and picking one leaves herdr's layout alone.
    await sheetsSettled(page);
    await tabSheet.getByRole("button", { name: "canvas-second", exact: true }).tap();
    await currentPane(page, second);
    await until(async () => await frame(page, second).isVisible() && !(await frame(page, first).isVisible()), "the picked pane replaces the open one");
    assert.equal((await sessionSnapshot()).layouts.find((entry) => entry.panes.some((pane) => pane.pane_id === first))?.zoomed, false, "showing one pane on a phone does not zoom herdr's layout");
    await touchMenu.tap();
    await tabSheet.waitFor();
    await sheetsSettled(page);
    await tabSheet.getByRole("button", { name: "canvas-first", exact: true }).tap();
    await currentPane(page, first);
    await touchMenu.tap();
    await tabSheet.waitFor();
    await sheetsSettled(page);
    const sheetBox = await rect(tabSheet, "the phone's More");
    assert.ok(sheetBox.top >= 0 && sheetBox.bottom <= viewport.height + 1);
    // the item names the tab it renames beside its words (the sheet's hint)
    await openPaneSheet();
    await paneSheet.getByRole("button", { name: /^Rename tab/ }).tap();
    const name = page.getByRole("textbox", { name: "Tab name", exact: true });
    await name.waitFor();
    await page.keyboard.press("Escape");
    await name.waitFor({ state: "detached" });
    // the title's list moves the open tab, as the row's menu does
    const tabList = page.getByRole("dialog", { name: "Tabs of ovis-test-tab-menu", exact: true });
    const listTabs = async (): Promise<void> => {
      await page.locator(".app-header .context-tabs").tap();
      await tabList.waitFor();
      await sheetsSettled(page);
    };
    const owner = (await sessionSnapshot()).panes.find((pane) => pane.pane_id === first)!;
    const sibling = await tabCreate({ workspaceId: owner.workspace_id, label: "touch-reorder" });
    try {
      await page.locator(".context-position").waitFor({ state: "attached" });
      await listTabs();
      await tabList.getByRole("button", { name: "Move tab right", exact: true }).tap();
      await until(async () => (await sessionSnapshot()).tabs.filter((entry) => entry.workspace_id === owner.workspace_id)[0]?.tab_id === sibling.tab.tab_id, "the title's list reorders native tabs");
      await currentPane(page, first);
      await listTabs();
      // the move offered once the first is acknowledged: the open tab is now the second
      await tabList.getByRole("button", { name: "Move tab left", exact: true }).tap();
      await until(async () => (await sessionSnapshot()).tabs.filter((entry) => entry.workspace_id === owner.workspace_id)[0]?.tab_id === owner.tab_id, "the title's list restores original order");
    } finally { await tabClose(sibling.tab.tab_id); }
    await page.locator(".context-position").waitFor({ state: "detached" });
    assert.equal(await frame(page, first).locator(".pane-frame-menu").isVisible(), false, "the lone pane draws no ellipsis beside More");
    await touchMenu.tap();
    await tabSheet.waitFor();
    await sheetsSettled(page);
    await openPaneSheet();
    const cancel = paneSheet.getByRole("button", { name: "Cancel", exact: true });
    assert.ok((await rect(cancel, "Cancel")).bottom <= viewport.height + 1, "Cancel remains reachable");
    await paneSheet.locator(".row-sheet-items").evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const close = paneSheet.getByRole("button", { name: "Close tab", exact: true });
    assert.ok((await rect(close, "Close tab")).bottom <= (await rect(cancel, "Cancel")).top + 1, "the menu's last action is reachable after scrolling");
    await screenshot(page, `canvas-phone-${viewport.width}`);
    await cancel.tap();
    await paneSheet.waitFor({ state: "detached" });
    // A zoom originating in another client must be reversible from the phone.
    // The phone hears of it from its pushed roster; a sheet opened before that came lists Zoom, so
    // the sheet is opened again until it offers Unzoom.
    await paneZoom(first, "on");
    const unzoom = paneSheet.getByRole("button", { name: "Unzoom pane", exact: true });
    await until(async () => {
      await touchMenu.tap();
      await tabSheet.waitFor();
      await openPaneSheet();
      if (await unzoom.isVisible()) return true;
      await cancel.tap();
      await paneSheet.waitFor({ state: "detached" });
      return false;
    }, "the phone's More offers Unzoom for a zoom made elsewhere");
    await sheetsSettled(page);
    await screenshot(page, `unzoom-phone-${viewport.width}`);
    const unzoomed = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/pane/zoom"));
    await unzoom.tap();
    assert.equal((await unzoomed).status(), 200);
    await paneSheet.waitFor({ state: "detached" });
    // The HTTP acknowledgement can precede the unzoomed browser snapshot. While the menu
    // still offers Unzoom, App redirects a sibling pick back to the zoomed pane. More's items are
    // read when it renders, so it is opened again until the snapshot has taken Unzoom away.
    await until(async () => {
      await touchMenu.tap();
      await tabSheet.waitFor();
      await openPaneSheet();
      const gone = !(await unzoom.isVisible());
      await cancel.tap();
      await paneSheet.waitFor({ state: "detached" });
      return gone;
    }, "the phone's More stops offering Unzoom once the zoom is gone");
    await touchMenu.tap();
    await tabSheet.waitFor();
    await sheetsSettled(page);
    await tabSheet.getByRole("button", { name: "canvas-second", exact: true }).tap();
    await currentPane(page, second);
    await frame(page, second).waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "the canvas never overflows the phone sideways");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

async function checkTouchTablet(browser: Browser, origin: string, first: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false })));
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await openApp(page, origin, first);
    assert.equal(await page.locator(".tab-strip-menu:visible").count(), 1, "a wide touch screen retains the explicit menu");
    const button = page.getByRole("button", { name: `Actions for ${TAB}`, exact: true });
    const size = await rect(button, "the tablet's tab menu");
    assert.ok(size.width >= 40 && size.height >= 40, "the tablet menu remains touch-sized above the mobile breakpoint");
    await button.tap();
    const menu = page.getByRole("menu", { name: TAB, exact: true });
    await menu.waitFor();
    const tabletItems = await menu.getByRole("menuitem").allTextContents();
    // a wide touch screen shows both panes, so the menu has no pane list: the open pane's actions lead it
    assert.deepEqual(tabletItems.filter((item) => item !== "Clear pane name"),
      ["Rename pane", "Split right", "Split down", "Zoom pane", "Close pane", "New tab with agent…", "Rename tab", "Close tab"], "a wide touch canvas keeps split and zoom in its menu");
    await screenshot(page, "tablet-menu");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
  } finally { await context.close(); }
}

export async function checkTabMenu(browser: Browser, origin: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-tab-menu-")));
  let workspaceId: string | null = null;
  try {
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-tab-menu" });
    workspaceId = created.workspace.workspace_id;
    const first = created.root_pane.pane_id;
    const second = (await paneSplit(first, "right", false)).pane_id;
    await paneRename(first, "canvas-first");
    await paneRename(second, "canvas-second");
    await checkDesktop(browser, origin, first, second, created.root_pane.tab_id);
    // A phone's title lists the tabs at both sizes; compact-height lone tabs wider than a phone are
    // exercised in phone-glass-header-demo-regression.ts.
    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 720 }]) await checkPhone(browser, origin, first, second, viewport);
    await checkTouchTablet(browser, origin, first);
    console.log("PASS native tab drag/keyboard/touch reorder, cancellation and failure handling, desktop context and keyboard tab menus, touch menu buttons, inactive-tab close, simultaneous split terminals, focus and input isolation, swap, split, divider drag, zoom and phone sheets");
  } finally {
    if (workspaceId) await workspaceClose(workspaceId).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "ovis-tab-menu-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try { await checkTabMenu(browser, `http://127.0.0.1:${server.port}`); }
  finally { await browser.close(); server.stop(); rmSync(state, { recursive: true, force: true }); }
}
