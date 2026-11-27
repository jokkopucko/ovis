/** Usage: UI_EVIDENCE_DIR=<dir> bun scripts/sidebar-declutter-demo-regression.ts */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { appContext } from "./app-context.ts";
import { withDemoBrowser } from "./demo-browser.ts";
import { openSettingsPage } from "./settings-page.ts";
import { closeSettings } from "./settings-pages-harness.ts";

// No herdr session is opened, and nothing leaves the loopback.
const evidence = process.env["UI_EVIDENCE_DIR"];
const patch = `(() => {
  const fetchDemo = window.fetch.bind(window), EventSourceDemo = window.EventSource;
  const params = new URLSearchParams(location.search);
  const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  let last = null;
  const roster = (original) => (params.get("pcs") === "2" ? ["local", "work"] : ["local"]).map((id) => {
    const machine = structuredClone(original.find((item) => item.id === "local"));
    if (params.get("pcs") === "2") { machine.id = id; machine.kind = id === "local" ? "local" : "ssh"; machine.name = id === "local" ? "Laptop" : "Work PC"; }
    if (id === "local" && params.has("offline")) { machine.state = "disconnected"; machine.error = null; }
    if (params.has("flat")) for (const workspace of machine.snapshot?.workspaces ?? []) delete workspace.worktree;
    return machine;
  });
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super(); this.inner = new EventSourceDemo(url, options); this.readyState = 1;
      this.inner.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "machines") { last = message.machines; message.machines = roster(last); }
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
      };
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onopen = (event) => this.onopen?.(event);
    }
    close() { this.inner.close(); this.readyState = 2; }
  };
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname === "/api/machines") { const value = await (await fetchDemo(input, init)).json(); last = value.machines; return json({ ...value, machines: roster(last) }); }
    const match = url.pathname.match(/^\\/api\\/machines\\/([^/]+)(\\/.*)$/);
    const machine = match ? decodeURIComponent(match[1]) : "local";
    const path = match ? "/api" + match[2] : url.pathname;
    if (match && path === "/api/session" && last) return json({ snapshot: roster(last).find((item) => item.id === machine).snapshot });
    if (match) return fetchDemo(path + url.search, init);
    return fetchDemo(input, init);
  };
})();`;

type Theme = "dark" | "light";
interface Scene { phone: boolean; theme: Theme }
const sceneName = (scene: Scene) => `${scene.phone ? 390 : 1440}-${scene.theme}`;
const rosterLabels = (page: Page): Promise<string[]> => page.evaluate(async () => {
  const { machines } = await (await fetch("/api/machines")).json() as { machines: { id: string; snapshot: { workspaces: { label: string }[] } | null }[] };
  return (machines.find((machine) => machine.id === "local")?.snapshot?.workspaces ?? []).map((workspace) => workspace.label).sort();
});

let url = "";

async function newPage(browser: Browser, scene: Scene, search: string, stored: Record<string, string> = {}, openSidebar = true): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await appContext(browser, scene.phone
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, colorScheme: scene.theme }
    : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: scene.theme });
  await context.addInitScript(({ settings, stored }) => {
    if (sessionStorage.getItem("declutter-seeded") !== null) return;
    sessionStorage.setItem("declutter-seeded", "1");
    localStorage.setItem("ovis:settings", JSON.stringify(settings));
    for (const [key, value] of Object.entries(stored)) localStorage.setItem(key, value);
  }, { settings: { language: "en", theme: scene.theme, defaultView: "chat" }, stored });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}?${search}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(".machine-list .machine-group").first().waitFor({ state: "attached" });
  if (scene.phone && openSidebar) {
    await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
    await page.locator(".sidebar.is-open").waitFor();
  }
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors };
}

const manifest: { file: string; state: string; viewport: number; theme: Theme }[] = [];
async function capture(page: Page, scene: Scene, state: string, wholePage = false): Promise<void> {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  const file = `sidebar-declutter-${sceneName(scene)}-${state}.png`;
  await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity).map((animation) => animation.finished.catch(() => undefined))));
  const style = ".droplet { visibility: hidden !important; }";
  if (scene.phone || wholePage) {
    await page.mouse.move(-50, -50);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: join(evidence, file), style });
  } else await page.locator(".sidebar").screenshot({ path: join(evidence, file), style });
  manifest.push({ file, state, viewport: scene.phone ? 390 : 1440, theme: scene.theme });
}

const headers = (page: Page) => page.locator(".machine-list .machine-header");
const newRow = (page: Page) => page.locator(".machine-list .machine-new-row");
const newPlus = (page: Page) => page.locator(".header-side .new-workspace-button");
const newWorkspace = (page: Page, scene: Scene) => scene.phone ? newRow(page) : newPlus(page);
const filterRow = (page: Page) => page.locator(".sidebar-filter");
const filterFocused = (page: Page) => page.evaluate(() => document.activeElement?.classList.contains("sidebar-filter-input") ?? false);
const focusHeld = (page: Page) => page.evaluate(() => { const active = document.activeElement; return active !== null && active !== document.body && active.isConnected ? active.className || active.tagName : null; });
const shownWorkspaces = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".machine-list .workspace-group")].filter((row) => !row.closest("[hidden]")).map((row) => row.querySelector(".workspace-name")?.textContent ?? "").sort());

/**
 * The phone's open drawer and the keyboard: it opens with the focus on its first control, never the filter's field,
 * which would raise the phone's keyboard on every open; Tab goes round the drawer and the header's toggle drawn
 * over its top row, so Shift+Tab reaches it and Tab still reaches the field; no + is found up there; Escape closes
 * it, the focus on its toggle.
 */
async function drawerKeyboard(page: Page): Promise<void> {
  const focused = () => page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active === null || active === document.body) return "nothing";
    if (active.classList.contains("sidebar-filter-input")) return "filter";
    if (active.closest("#workspace-drawer") !== null) return "drawer";
    if (active.classList.contains("new-workspace-button")) return "plus";
    return active.classList.contains("drawer-toggle") ? "toggle" : active.className || active.tagName;
  });
  assert.equal(await focused(), "drawer", "the opened drawer holds the focus on a control, not on the filter's field");
  const limit = await page.locator("#workspace-drawer").evaluate((drawer) => drawer.querySelectorAll("button, input, select, textarea, a[href], [tabindex]").length) + 2;
  const back: string[] = [];
  while (back.at(-1) !== "toggle" && back.length < limit) { await page.keyboard.press("Shift+Tab"); back.push(await focused()); }
  assert.equal(back.at(-1), "toggle", `Shift+Tab from the drawer reaches the header's toggle: ${back.join(" > ")}`);
  const ahead: string[] = [];
  while (ahead.at(-1) !== "filter" && ahead.length < limit) { await page.keyboard.press("Tab"); ahead.push(await focused()); }
  assert.ok(["drawer", "filter"].includes(ahead[0] ?? ""), `Tab from the toggle goes on into the drawer: ${ahead.join(" > ")}`);
  assert.equal(ahead.at(-1), "filter", `Tab still reaches the filter's field: ${ahead.join(" > ")}`);
  assert.ok(![...back, ...ahead].includes("plus"), `the keyboard finds no + in the top row over the drawer: ${[...back, ...ahead].join(" > ")}`);
  await page.keyboard.press("Escape");
  await page.locator(".sidebar.is-open").waitFor({ state: "detached" });
  assert.equal(await focused(), "toggle", "Escape closes the drawer and the focus is back on its toggle");
  await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
  await page.locator(".sidebar.is-open").waitFor();
}

async function loneHost(browser: Browser, scene: Scene): Promise<void> {
  // a fold stored while the Host had a header must not hide its workspaces now that nothing can open them
  const { context, page, errors } = await newPage(browser, scene, "", { "ovis:pc-collapsed:local": "1", "ovis:sidebar-filter-shown": "true" });
  try {
    assert.equal(await headers(page).count(), 0, `${sceneName(scene)}: a lone Host is drawn without its header`);
    const entry = newWorkspace(page, scene);
    await entry.waitFor();
    const LABELS = await rosterLabels(page);
    assert.equal(await page.locator('section.machine-group[aria-label="PC workstation"]').count(), 1, "the group still names its PC to a screen reader");
    assert.deepEqual(await shownWorkspaces(page), LABELS, "its workspaces start the list, unfolded, whatever fold was stored");
    const first = await page.locator(".machine-list .workspace-group").first().boundingBox();
    const list = await page.locator(".machine-list").boundingBox();
    assert.ok(first && list && first.y - list.y < 16, `the first workspace row is the list's first row (${first?.y} vs ${list?.y})`);
    if (scene.phone) {
      assert.equal(await newPlus(page).count(), 0, "a phone's drawer draws no + in its top row");
      const row = await entry.boundingBox(), last = await page.locator(".machine-list .workspace-header").last().boundingBox();
      assert.ok(row && last && row.y >= last.y + last.height - 1, `the New workspace row closes the list (${row?.y} under ${last && last.y + last.height})`);
      assert.ok(row.height >= 44, `the phone drawer's New workspace row is a finger's 44 px tall (${row.height})`);
      assert.notEqual((await entry.innerText()).trim(), "", "the row says what it does in words");
      await drawerKeyboard(page);
    } else {
      assert.equal((await entry.innerText()).trim(), "");
      assert.equal(await entry.getAttribute("aria-label"), "New workspace");
      assert.equal(await entry.getAttribute("title"), "New workspace");
      assert.equal(await newRow(page).count(), 0, "a desktop's one-line list draws no New workspace row");
    }
    await capture(page, scene, "lone-host");
    await entry.click();
    const dialog = page.getByRole("dialog", { name: /^New workspace/ });
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    if (scene.phone && await page.locator(".sidebar.is-open").count() === 0) {
      await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
      await page.locator(".sidebar.is-open").waitFor();
    }
    await page.locator(".sidebar-filter-input").fill(LABELS[0]!);
    await page.locator(".sidebar-filter-clear").waitFor();
    assert.equal(await newRow(page).count(), 0, "a filtered list draws no New workspace row");
    assert.ok((await shownWorkspaces(page)).includes(LABELS[0]!), "the filter still finds the lone Host's rows");
    await page.locator(".sidebar-filter-clear").click();
    await entry.waitFor();
    assert.deepEqual(errors, []);
    console.log(`PASS ${sceneName(scene)}: a lone Host has no header, never folds, and starts a workspace from ${scene.phone ? "the row closing its list" : "the + beside the logo"}`);
  } finally { await context.close(); }
}

/** A device that only watches, in a phone's drawer: the lone Host keeps its New workspace row, off, its + dimmed, and the header over the drawer says why. */
async function loneHostWatching(browser: Browser, scene: Scene): Promise<void> {
  const { context, page, errors } = await newPage(browser, scene, "demo_devices=watch");
  try {
    const row = newRow(page);
    await row.waitFor();
    assert.equal(await row.isDisabled(), true, "a watching device's New workspace row is off");
    const mark = Number(await row.locator(".sidebar-mark").evaluate((mark) => getComputedStyle(mark).opacity));
    assert.ok(mark < 1, `its + is dimmed (${mark})`);
    assert.equal(await page.locator(".app-header .context-watch").isVisible(), true, "the header over the drawer says the device only watches");
    await capture(page, scene, "lone-host-watching");
    assert.deepEqual(errors, []);
    console.log(`PASS ${sceneName(scene)}: a watching device's lone Host keeps its New workspace row, off`);
  } finally { await context.close(); }
}

async function loneHostOffline(browser: Browser, scene: Scene): Promise<void> {
  const { context, page, errors } = await newPage(browser, scene, "offline=1");
  try {
    const state = page.locator(".machine-list .machine-state:not(.visually-hidden)");
    await state.waitFor();
    assert.equal((await state.locator(".machine-state-word").innerText()).trim(), "Disconnected", "the state words stay without the header");
    assert.equal(await headers(page).count(), 0);
    assert.equal(await newRow(page).count(), 0, "an offline Host offers no New workspace row");
    await capture(page, scene, "lone-host-offline");
    assert.deepEqual(errors, []);
    console.log(`PASS ${sceneName(scene)}: an offline lone Host still says it is disconnected`);
  } finally { await context.close(); }
}

async function twoPcs(browser: Browser, scene: Scene): Promise<void> {
  {
    const { context, page, errors } = await newPage(browser, scene, "pcs=2");
    try {
      await page.waitForFunction(() => document.querySelectorAll(".machine-list .machine-header").length === 2);
      assert.equal(await newRow(page).count(), 0, "two PCs keep their own +");
      assert.deepEqual(await page.locator(".machine-list .machine-name").allInnerTexts(), ["Laptop", "Work PC"]);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  {
    const { context, page, errors } = await newPage(browser, scene, "pcs=2", { "ovis:hidden-pcs": JSON.stringify(["work"]) });
    try {
      await newWorkspace(page, scene).waitFor();
      assert.equal(await (scene.phone ? newPlus(page) : newRow(page)).count(), 0, scene.phone ? "a phone's drawer draws no + in its top row" : "a desktop's one-line list draws no New workspace row");
      assert.equal(await headers(page).count(), 0, "the Host shown alone of two has no header");
      assert.equal(await page.locator(".pcs-sidebar > :not(.machine-list)").count(), 0, "no PCs head or hidden count above the list");
      await capture(page, scene, "host-shown-of-two");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  {
    const { context, page, errors } = await newPage(browser, scene, "pcs=2", { "ovis:hidden-pcs": JSON.stringify(["local"]) });
    try {
      await page.waitForFunction(() => document.querySelectorAll(".machine-list .machine-header").length === 1);
      assert.equal((await page.locator(".machine-list .machine-name").innerText()).trim(), "Work PC", "a lone PC that is not the Host keeps its name");
      assert.equal(await page.locator(".machine-list .machine-manage").count(), 1, "and its manage menu");
      if (!scene.phone) await page.locator(".machine-list .machine-header").hover();
      await page.locator(".machine-list .machine-manage").click();
      const menu = page.locator(".row-menu, .row-sheet");
      await menu.waitFor();
      assert.ok((await menu.locator(".menu-item, .row-sheet-item").allInnerTexts()).some((label) => label.trim() === "Reconnect / setup"), "the menu lists the PC's actions");
      assert.equal(await menu.getByText("Hide on this device", { exact: true }).count(), 0, "and no Hide on this device for the last PC shown");
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      assert.equal(await newRow(page).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  {
    const { context, page, errors } = await newPage(browser, scene, "pcs=2&offline=1");
    try {
      const work = page.locator('section.machine-group[aria-label="PC Work PC"] .machine-header');
      await work.waitFor();
      if (!scene.phone) await work.hover();
      await work.locator(".machine-manage").click();
      await page.locator(".row-menu, .row-sheet").getByText("Hide on this device", { exact: true }).click();
      await work.waitFor({ state: "detached" });
      await page.waitForFunction(() => document.activeElement !== null && document.activeElement !== document.body && document.activeElement.closest(".sidebar") !== null, undefined, { timeout: 5000 })
        .catch(async () => assert.fail(`the focus fell to ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80) ?? "nothing")}`));
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  console.log(`PASS ${sceneName(scene)}: two PCs keep both headers; the Host shown alone of two has none; a lone remote PC keeps its own; hiding one keeps the focus in the sidebar`);
}

async function paletteFilter(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+Shift+K");
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
  await palette.getByRole("searchbox", { name: "Search panes and actions", exact: true }).fill("Filter workspaces");
  await palette.getByRole("option").filter({ hasText: "Filter workspaces and agents" }).first().click();
  await palette.waitFor({ state: "detached" });
  await filterRow(page).waitFor();
  await page.waitForFunction(() => document.activeElement?.classList.contains("sidebar-filter-input") ?? false);
}

async function filterHidden(browser: Browser, scene: Scene): Promise<void> {
  const { context, page, errors } = await newPage(browser, scene, "", { "ovis:sidebar-filter-shown": "false" }, false);
  try {
    if (scene.phone) {
      await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
      await page.locator(".sidebar.is-open").waitFor();
    }
    await newWorkspace(page, scene).waitFor();
    const LABELS = await rosterLabels(page);
    assert.equal(await filterRow(page).count(), 0, `${sceneName(scene)}: the filter row is out`);
    await capture(page, scene, "filter-off");
    if (scene.phone) {
      await page.mouse.click(page.viewportSize()!.width - 8, page.viewportSize()!.height / 2);
      await page.locator(".sidebar.is-open").waitFor({ state: "detached" });
    }
    await paletteFilter(page);
    if (scene.phone) await page.locator(".sidebar.is-open").waitFor();
    assert.equal(await page.locator(".sidebar-filter-clear").getAttribute("aria-label"), "Close filter", "an empty field the palette opened can be closed");
    await page.keyboard.type(LABELS[1]!);
    await page.waitForFunction((label) => [...document.querySelectorAll<HTMLElement>(".machine-list .workspace-group")].filter((row) => !row.closest("[hidden]")).some((row) => row.textContent?.includes(label)), LABELS[1]!);
    assert.ok((await shownWorkspaces(page)).length < LABELS.length, "typing filters the rows");
    await capture(page, scene, "filter-asked-typing");
    await page.locator(".sidebar-filter-clear").click();
    assert.equal(await page.locator(".sidebar-filter-input").inputValue(), "");
    assert.ok(await filterFocused(page), "the clear keeps the field, focused");
    await page.getByRole("button", { name: "Close filter", exact: true }).click();
    await filterRow(page).waitFor({ state: "detached" });
    assert.deepEqual(await shownWorkspaces(page), LABELS, "every row is back");
    assert.ok(await focusHeld(page), "Close filter gives the focus back, not to the body");
    if (!scene.phone) {
      await paletteFilter(page);
      await page.keyboard.type("zz");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".sidebar-filter-input").inputValue(), "", "Escape with words clears them");
      assert.ok(await filterFocused(page), "and keeps the field, focused");
      await page.evaluate(() => { const seen = window as unknown as { escapesSeen: number }; seen.escapesSeen = 0; window.addEventListener("keydown", (event) => { if (event.key === "Escape") seen.escapesSeen++; }); });
      await page.keyboard.press("Escape");
      await filterRow(page).waitFor({ state: "detached" });
      assert.ok(await focusHeld(page), "Escape in the empty field gives the focus back, not to the body");
      assert.equal(await page.evaluate(() => (window as unknown as { escapesSeen: number }).escapesSeen), 0, "the Escape that closed it goes no further");
      await paletteFilter(page);
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Close filter");
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.closest(".machine-list") !== null), true, "Tab goes on into the list: no PCs head between");
      assert.equal(await filterRow(page).count(), 1, "a row taking the focus keeps the field");
      await page.locator(".machine-list .workspace-select").nth(1).click();
      assert.equal(await filterRow(page).count(), 1, "a press on a row keeps it");
      const header = await page.locator("header.app-header.is-zoned").boundingBox();
      assert.ok(header, "the app header is drawn");
      await page.mouse.click(header.x + header.width / 2, header.y + header.height / 2);
      await filterRow(page).waitFor({ state: "detached" });
      assert.deepEqual(await shownWorkspaces(page), LABELS);
    } else {
      await paletteFilter(page);
      await page.mouse.click(page.viewportSize()!.width - 8, page.viewportSize()!.height / 2);
      await page.locator(".sidebar.is-open").waitFor({ state: "detached" });
      assert.equal(await filterRow(page).count(), 0);
    }
    assert.equal(await page.evaluate(() => localStorage.getItem("ovis:sidebar-filter-shown")), "false", "using it never turns the setting back on");
    assert.deepEqual(errors, []);
    console.log(`PASS ${sceneName(scene)}: Sidebar filter off leaves the field out, and the palette's Filter workspaces and agents opens and focuses it`);
  } finally { await context.close(); }
}

async function filterEdges(browser: Browser, scene: Scene): Promise<void> {
  {
    const { context, page, errors } = await newPage(browser, scene, "flat=1", { "ovis:sidebar-filter-shown": "true" });
    try {
      await filterRow(page).waitFor();
      await page.locator(".sidebar-filter-input").fill("zz");
      await page.locator(".sidebar-footer-settings").click();
      await openSettingsPage(page, "Appearance");
      await page.locator(".settings-dialog").getByRole("switch", { name: "Sidebar filter", exact: true }).click();
      await page.waitForFunction(() => localStorage.getItem("ovis:sidebar-filter-shown") === "false");
      await closeSettings(page);
      assert.equal(await page.locator(".sidebar-filter-input").inputValue(), "zz", "the field keeps its words");
      await page.getByRole("button", { name: "Clear filter", exact: true }).click();
      await page.getByRole("button", { name: "Close filter", exact: true }).click();
      await filterRow(page).waitFor({ state: "detached" });
      assert.ok(await page.evaluate(() => document.activeElement?.closest(".machine-list") !== null && document.activeElement.getClientRects().length > 0), `Close filter gives the focus to a row it can be seen on when its opener is gone (on ${await focusHeld(page)})`);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  const { context, page, errors } = await newPage(browser, scene, "", { "ovis:sidebar-filter-shown": "false" });
  try {
    await newPlus(page).waitFor();
    await paletteFilter(page);
    const row = page.locator(".machine-list .workspace-select").first();
    await row.focus();
    const rowBox = await row.boundingBox();
    await row.evaluate((element) => element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await page.waitForFunction(() => document.activeElement?.closest(".row-menu") !== null);
    assert.equal(await filterRow(page).count(), 1, "a row's menu taking the focus keeps the field");
    const menuBox = await page.locator(".row-menu").boundingBox();
    assert.ok(rowBox && menuBox && Math.abs(menuBox.y - rowBox.y - rowBox.height) < rowBox.height, `the menu sits under its row (${menuBox?.y} vs ${rowBox && rowBox.y + rowBox.height})`);
    await page.locator(".row-menu").getByRole("menuitem", { name: "Rename workspace", exact: true }).click();
    await page.locator(".workspace-rename-input").waitFor();
    assert.equal(await filterRow(page).count(), 1, "a press on a row's menu keeps the field");
    await page.keyboard.press("Escape");
    await page.locator(".workspace-rename-input").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Close filter", exact: true }).click();
    await filterRow(page).waitFor({ state: "detached" });
    await paletteFilter(page);
    await page.evaluate(() => document.querySelector<HTMLInputElement>(".sidebar-filter-input")!.blur());
    await filterRow(page).waitFor({ state: "detached" });
    await paletteFilter(page);
    await page.locator(".tab-strip-tab").first().evaluate((element) => element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await page.waitForFunction(() => document.activeElement?.closest(".row-menu") !== null);
    await filterRow(page).waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    await page.locator(".row-menu").waitFor({ state: "detached" });
    await paletteFilter(page);
    const late = await page.evaluate(async () => {
      const input = document.querySelector<HTMLInputElement>(".sidebar-filter-input")!;
      input.blur();
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "zz");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const committed = document.querySelector(".sidebar-filter-clear")?.getAttribute("aria-label") === "Clear filter";
      input.blur();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { committed, value: document.querySelector<HTMLInputElement>(".sidebar-filter-input")?.value ?? null };
    });
    assert.ok(late.committed, "the words were in the field before it lost the focus again");
    assert.equal(late.value, "zz", "a blur's late check keeps words typed after it");
    assert.deepEqual(errors, []);
    console.log(`PASS ${sceneName(scene)}: the asked-for field gives the focus to a row, keeps a row's menu as the sidebar and no tab's, and keeps later words`);
  } finally { await context.close(); }
}

async function filterSetting(browser: Browser, scene: Scene): Promise<void> {
  const { context, page, errors } = await newPage(browser, scene, "", {}, false);
  try {
    if (scene.phone) {
      await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
      await page.locator(".sidebar.is-open").waitFor();
    }
    await newWorkspace(page, scene).waitFor();
    assert.equal(await filterRow(page).count(), 0, "out by default");
    assert.equal(await page.evaluate(() => localStorage.getItem("ovis:sidebar-filter-shown")), null, "with nothing stored");
    await page.locator(".sidebar-footer-settings").click();
    await openSettingsPage(page, "Appearance");
    const toggle = page.locator(".settings-dialog").getByRole("switch", { name: "Sidebar filter", exact: true });
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await toggle.click();
    await page.waitForFunction(() => localStorage.getItem("ovis:sidebar-filter-shown") === "true");
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("ovis:settings") ?? "{}")).sidebarFilter, undefined, "kept out of ovis:settings");
    await capture(page, scene, "settings-appearance", true);
    await closeSettings(page);
    if (scene.phone && await page.locator(".sidebar.is-open").count() === 0) {
      await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
      await page.locator(".sidebar.is-open").waitFor();
    }
    await filterRow(page).waitFor();
    await page.reload();
    await page.locator(".machine-list .machine-group").first().waitFor({ state: "attached" });
    if (scene.phone && await page.locator(".sidebar.is-open").count() === 0) {
      await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
      await page.locator(".sidebar.is-open").waitFor();
    }
    await filterRow(page).waitFor();
    assert.deepEqual(errors, []);
    console.log(`PASS ${sceneName(scene)}: Settings → Appearance → Sidebar filter is off by default and turns the row on, kept after a reload`);
  } finally { await context.close(); }
}

await withDemoBrowser({ tempPrefix: "herdr-sidebar-declutter-", prefix: "/", afterTransport: '<script src="./sidebar-declutter.js"></script>' }, async ({ app, browser, baseUrl }) => {
  writeFileSync(join(app, "sidebar-declutter.js"), patch);
  url = baseUrl;
  for (const phone of [false, true]) for (const theme of ["dark", "light"] as const) {
    const scene: Scene = { phone, theme };
    await loneHost(browser, scene);
    if (phone) await loneHostWatching(browser, scene);
    await loneHostOffline(browser, scene);
    await twoPcs(browser, scene);
    await filterHidden(browser, scene);
    if (!phone) await filterEdges(browser, scene);
    await filterSetting(browser, scene);
  }
});
if (evidence) writeFileSync(join(evidence, "manifest.json"), JSON.stringify(manifest, null, 2));
