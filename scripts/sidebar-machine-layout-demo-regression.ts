/** Usage: bun scripts/sidebar-machine-layout-demo-regression.ts [--geometry-only] */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import { prepareMachineControlsDemo } from "./sidebar-machine-controls-fixture.ts";
import { serveDemo } from "./demo-server.ts";

const app = mkdtempSync(join(tmpdir(), "herdr-sidebar-machine-layout-"));
const evidenceDir = process.env.UI_EVIDENCE_DIR;
const geometryOnly = process.argv.includes("--geometry-only") || process.env.SIDEBAR_GEOMETRY_ONLY === "1";
const REMOTE_NAME = "Demo remote PC";
const MANAGED_NAME = "Managed demo PC";
const RENAME_LABEL: Record<string, string> = { en: "Rename…", ko: "이름 바꾸기…", ja: "名前を変更…", zh: "重命名…" };
const REMOVE_LABEL: Record<string, string> = { en: "Remove PC…", ko: "PC 제거…", ja: "PC を削除…", zh: "移除 PC…" };
const REMOVE_EXPLANATION = "Removes this registration. Remote sessions keep running.";

interface Scenario {
  name: string;
  language: "en" | "ko" | "ja" | "zh";
  theme: "dark" | "light";
  density: "comfortable" | "compact";
  viewport: { width: number; height: number };
  touch: boolean;
  desktopSidebar: boolean;
  sidebarWidth?: number;
  screenshots?: boolean;
}

const scenarios: Scenario[] = [
  { name: "en-desktop-240-dark", language: "en", theme: "dark", density: "comfortable", viewport: { width: 1280, height: 900 }, touch: false, desktopSidebar: true, screenshots: true },
  { name: "en-desktop-240-light", language: "en", theme: "light", density: "compact", viewport: { width: 1280, height: 900 }, touch: false, desktopSidebar: true, screenshots: true },
  { name: "en-desktop-520-light", language: "en", theme: "light", density: "comfortable", viewport: { width: 1280, height: 900 }, touch: false, desktopSidebar: true, sidebarWidth: 520, screenshots: true },
  { name: "en-phone-320-dark", language: "en", theme: "dark", density: "compact", viewport: { width: 320, height: 844 }, touch: true, desktopSidebar: false, screenshots: true },
  { name: "en-phone-320-light", language: "en", theme: "light", density: "comfortable", viewport: { width: 320, height: 844 }, touch: true, desktopSidebar: false, screenshots: true },
  { name: "ko-phone-320-dark", language: "ko", theme: "dark", density: "comfortable", viewport: { width: 320, height: 844 }, touch: true, desktopSidebar: false },
  { name: "ja-phone-390-light", language: "ja", theme: "light", density: "compact", viewport: { width: 390, height: 844 }, touch: true, desktopSidebar: false },
  { name: "zh-phone-320-dark", language: "zh", theme: "dark", density: "compact", viewport: { width: 320, height: 844 }, touch: true, desktopSidebar: false },
  { name: "ko-desktop-240-dark", language: "ko", theme: "dark", density: "compact", viewport: { width: 1280, height: 900 }, touch: false, desktopSidebar: true },
  { name: "ja-desktop-240-light", language: "ja", theme: "light", density: "comfortable", viewport: { width: 1280, height: 900 }, touch: false, desktopSidebar: true },
  { name: "zh-desktop-240-dark", language: "zh", theme: "dark", density: "comfortable", viewport: { width: 1280, height: 900 }, touch: false, desktopSidebar: true },
  { name: "en-phone-390-light", language: "en", theme: "light", density: "compact", viewport: { width: 390, height: 844 }, touch: true, desktopSidebar: false, screenshots: true },
  { name: "en-phone-390-dark", language: "en", theme: "dark", density: "comfortable", viewport: { width: 390, height: 844 }, touch: true, desktopSidebar: false, screenshots: true },
  { name: "en-landscape-844x390-dark", language: "en", theme: "dark", density: "comfortable", viewport: { width: 844, height: 390 }, touch: true, desktopSidebar: true },
];

const machineGroup = (page: Page, name: string): Locator => page.locator(".machine-group").filter({ has: page.locator(".machine-name", { hasText: name }) });
const renamingGroup = (page: Page): Locator => page.locator(".machine-group").filter({ has: page.locator(".machine-rename-input") });
const surface = (page: Page): Locator => page.locator(".row-menu, .row-sheet");
const items = (page: Page): Locator => surface(page).locator(".menu-item, .row-sheet-item");
const getHook = (page: Page, expression: string) => page.evaluate((key) => {
  const fixture = (window as unknown as { machineControlsFixture: { calls: Record<string, unknown>; roster: unknown[] } }).machineControlsFixture;
  let value: unknown = fixture;
  for (const part of key.split(".")) {
    if (typeof value !== "object" || value === null) return null;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}, expression);
const observedPc = (page: Page, observer: number, want: { name?: string; enabled?: boolean } | null) => page.waitForFunction(([index, fields]) => {
  const hooks = (window as unknown as { machineControlsFixture: { observerRoster(index: number): Array<{ id: string; name: string; enabled: boolean }> | null } }).machineControlsFixture;
  const roster = hooks.observerRoster(index as number);
  const pc = roster?.find((machine) => machine.id === "sidebar-fixture");
  if (fields === null) return roster !== null && roster !== undefined && pc === undefined;
  return pc !== undefined && Object.entries(fields as Record<string, unknown>).every(([key, value]) => (pc as unknown as Record<string, unknown>)[key] === value);
}, [observer, want] as const);
// an item by its whole label: "Connect" is also in "Disconnect" and "Reconnect / setup"
const item = (page: Page, label: string): Locator => items(page).filter({ hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) });

async function press(locator: Locator, scenario: Scenario): Promise<void> {
  if (scenario.touch) await locator.tap();
  else await locator.click();
}

async function openMenu(page: Page, group: Locator, scenario: Scenario): Promise<Locator> {
  if (!scenario.touch) await group.locator(".machine-header").hover();
  const manage = group.locator(".machine-manage");
  assert.equal(await manage.getAttribute("aria-haspopup"), scenario.viewport.width <= 640 ? "dialog" : "menu", `${scenario.name} the manage button says what it opens`);
  assert.equal(await manage.getAttribute("aria-expanded"), "false", `${scenario.name} the manage button is closed before the press`);
  await press(manage, scenario);
  await surface(page).waitFor({ state: "visible" });
  await surface(page).evaluate(async (menu) => { await Promise.all(menu.getAnimations({ subtree: true }).map((animation) => animation.finished)); });
  assert.equal(await manage.getAttribute("aria-expanded"), "true", `${scenario.name} the manage button says its menu is open`);
  return manage;
}

async function closeWithEscape(page: Page, manage: Locator, scenario: Scenario): Promise<void> {
  await page.keyboard.press("Escape");
  await surface(page).waitFor({ state: "detached" });
  assert.equal(await manage.evaluate((button) => document.activeElement === button), true, `${scenario.name} Escape gives the focus back to the manage button`);
  assert.equal(await manage.getAttribute("aria-expanded"), "false", `${scenario.name} the manage button says its menu is closed`);
}

async function itemLabels(page: Page): Promise<string[]> {
  return (await items(page).allInnerTexts()).map((text) => text.trim());
}

async function menuGeometry(page: Page, manage: Locator, scenario: Scenario): Promise<void> {
  const metrics = await page.evaluate(() => {
    const menu = document.querySelector(".row-menu, .row-sheet")!;
    const rect = (element: Element) => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }; };
    return {
      sheet: menu.classList.contains("row-sheet"),
      box: rect(menu),
      viewport: { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth },
      head: [...menu.querySelectorAll(".machine-menu-head > *")].map((element) => ({ className: element.className, text: element.textContent ?? "", ...rect(element), fits: element.scrollWidth <= element.clientWidth + 1 || element.classList.contains("machine-menu-name") })),
      items: [...menu.querySelectorAll(".menu-item, .row-sheet-item")].map((item) => {
        const label = item.querySelector(".menu-item-main, .row-sheet-label")!;
        return { text: label.textContent ?? "", ...rect(item), fits: label.scrollWidth <= label.clientWidth + 1 };
      }),
    };
  });
  const sheetExpected = scenario.viewport.width <= 640;
  assert.equal(metrics.sheet, sheetExpected, `${scenario.name} Manage PC is a ${sheetExpected ? "sheet" : "popover"} at ${scenario.viewport.width}px`);
  const { box, viewport } = metrics;
  assert.ok(box.left >= -1 && box.right <= viewport.width + 1 && box.top >= -1 && box.bottom <= viewport.height + 1, `${scenario.name} the menu fits the screen: ${JSON.stringify({ box, viewport })}`);
  assert.ok(viewport.scrollWidth <= viewport.width + 1, `${scenario.name} the page does not scroll sideways: ${JSON.stringify(viewport)}`);
  if (!metrics.sheet) {
    const button = await manage.boundingBox();
    assert.ok(button && (box.top >= button.y + button.height - 1 || box.bottom <= button.y + 1), `${scenario.name} the popover opens under or over its button: ${JSON.stringify({ box, button })}`);
  }
  assert.ok(metrics.head.length >= 2, `${scenario.name} the menu's head names the PC and its state: ${JSON.stringify(metrics.head)}`);
  for (const line of metrics.head) {
    assert.ok(line.left >= box.left - 1 && line.right <= box.right + 1, `${scenario.name} the head's ${line.className} fits the menu: ${JSON.stringify(line)}`);
    assert.ok(line.fits, `${scenario.name} the head's ${line.className} is not cut: ${JSON.stringify(line)}`);
  }
  for (const entry of metrics.items) {
    assert.ok(entry.left >= box.left - 1 && entry.right <= box.right + 1, `${scenario.name} ${entry.text} fits the menu: ${JSON.stringify(entry)}`);
    assert.ok(entry.fits, `${scenario.name} ${entry.text} is not cut: ${JSON.stringify(entry)}`);
    if (metrics.sheet) assert.ok(entry.height >= 44 - 1, `${scenario.name} ${entry.text} is touch-sized in the sheet: ${JSON.stringify(entry)}`);
  }
}

const OFF_ERROR = "ssh: connect to host a-long-fixture-hostname.tail1234.ts.net port 22: Connection refused";

// a PC it keeps failing to reach: Switched off with why, whole and beside or under Check again, which asks once
async function offRow(page: Page, group: Locator, scenario: Scenario): Promise<void> {
  const setRemote = (patch: Record<string, unknown>) => page.evaluate((fields) => (window as unknown as { machineControlsFixture: { setRemote(patch: unknown): void } }).machineControlsFixture.setRemote(fields), patch);
  await setRemote({ state: "reconnecting", error: OFF_ERROR });
  const row = group.locator(".machine-off");
  await row.waitFor({ state: "visible" });
  const button = row.locator(".machine-recheck");
  const fit = await row.evaluate((element) => {
    const box = (node: Element | null) => { const rect = node!.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; };
    const detail = element.querySelector<HTMLElement>(".machine-state-detail")!;
    const list = document.querySelector<HTMLElement>(".machine-list")!;
    return { row: box(element), words: box(element.querySelector(".machine-state")), button: box(element.querySelector(".machine-recheck")), sidebar: box(document.querySelector(".sidebar")), whole: detail.clientHeight > 0 && detail.scrollHeight <= detail.clientHeight + 1 && detail.getBoundingClientRect().right <= element.getBoundingClientRect().right + 1, list: { clientWidth: list.clientWidth, scrollWidth: list.scrollWidth } };
  });
  const apart = fit.button.left >= fit.words.right - 1 || fit.button.top >= fit.words.bottom - 1;
  assert.ok(apart, `${scenario.name} Check again lies beside or under the words, not over them: ${JSON.stringify(fit)}`);
  assert.ok(fit.button.left >= fit.sidebar.left - 1 && fit.button.right <= fit.sidebar.right + 1 && fit.words.right <= fit.sidebar.right + 1, `${scenario.name} the off row fits the sidebar: ${JSON.stringify(fit)}`);
  assert.ok(fit.list.scrollWidth <= fit.list.clientWidth + 1, `${scenario.name} the off row does not widen the PC list: ${JSON.stringify(fit)}`);
  assert.ok(fit.whole, `${scenario.name} why the PC is off is shown whole: ${JSON.stringify(fit)}`);
  // a 240 px sidebar has no room beside the words: Check again goes under them
  if (scenario.desktopSidebar && (scenario.sidebarWidth ?? 240) === 240) assert.ok(fit.button.top >= fit.words.bottom - 1, `${scenario.name} Check again wraps under the words in a narrow sidebar: ${JSON.stringify(fit)}`);
  if (scenario.screenshots && evidenceDir) await page.screenshot({ path: join(evidenceDir, `sidebar-machine-layout-${scenario.name}-off.png`) });
  const reads = await getHook(page, "calls.sessionReads") as number;
  await press(button, scenario);
  await page.waitForFunction((count) => (window as unknown as { machineControlsFixture: { calls: { sessionReads: number } } }).machineControlsFixture.calls.sessionReads === count, reads + 1);
  assert.equal(await button.getAttribute("aria-disabled"), "true", `${scenario.name} Check again is held after a press`);
  // Playwright waits for an aria-disabled button to be enabled, which would press it after the hold: the click is sent now
  await button.dispatchEvent("click");
  assert.equal(await getHook(page, "calls.sessionReads"), reads + 1, `${scenario.name} a second press while held asks nothing`);
  await button.focus();
  await setRemote({ state: "connected", error: null });
  await row.waitFor({ state: "detached" });
  assert.equal(await group.locator(".machine-title").evaluate((title) => document.activeElement === title), true, `${scenario.name} the PC answering hands the focus from Check again to the PC's name`);
  await setRemote({ state: "disconnected", error: null });
}

async function capture(page: Page, scenario: Scenario, state: "menu" | "renaming"): Promise<void> {
  if (!evidenceDir || !scenario.screenshots) return;
  await page.screenshot({ path: join(evidenceDir, `sidebar-machine-layout-${scenario.name}-${state}.png`) });
}

async function renameGeometry(page: Page, manage: Locator, scenario: Scenario): Promise<void> {
  const before = (await getHook(page, "calls.mutations") as unknown[]).length;
  await press(item(page, RENAME_LABEL[scenario.language]!), scenario);
  await surface(page).waitFor({ state: "detached" });
  const input = renamingGroup(page).locator(".machine-rename-input");
  await input.waitFor({ state: "visible" });
  assert.equal(await input.evaluate((element) => document.activeElement === element), true, `${scenario.name} the name's field takes the focus`);
  assert.equal(await input.inputValue(), REMOTE_NAME, `${scenario.name} the field starts with the PC's name`);
  assert.equal(await input.getAttribute("maxlength"), "100", `${scenario.name} the field takes up to 100 characters`);
  await input.fill("x".repeat(100));
  const fit = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".machine-list")!;
    const sidebar = document.querySelector(".sidebar")!.getBoundingClientRect();
    const field = document.querySelector(".machine-rename-input")!.getBoundingClientRect();
    return { list: { clientWidth: list.clientWidth, scrollWidth: list.scrollWidth }, sidebar: { left: sidebar.left, right: sidebar.right }, field: { left: field.left, right: field.right } };
  });
  assert.ok(fit.list.scrollWidth <= fit.list.clientWidth + 1, `${scenario.name} a 100-character name does not widen the PC list: ${JSON.stringify(fit)}`);
  assert.ok(fit.field.left >= fit.sidebar.left - 1 && fit.field.right <= fit.sidebar.right + 1, `${scenario.name} the name's field fits the sidebar: ${JSON.stringify(fit)}`);
  await capture(page, scenario, "renaming");
  await press(input, scenario);
  assert.equal(await renamingGroup(page).evaluate((group) => group.classList.contains("is-folded")), false, `${scenario.name} a press in the name's field does not fold the PC`);
  assert.equal(await input.evaluate((element) => document.activeElement === element), true, `${scenario.name} the field keeps the focus after a press in it`);
  await page.keyboard.press("Escape");
  await input.waitFor({ state: "detached" });
  assert.equal(await manage.evaluate((button) => document.activeElement === button), true, `${scenario.name} Escape in the field gives the focus back to the manage button`);
  if (!scenario.desktopSidebar) assert.equal(await page.locator(".sidebar.is-open").isVisible(), true, `${scenario.name} Escape in the field leaves the drawer out`);
  assert.equal((await getHook(page, "calls.mutations") as unknown[]).length, before, `${scenario.name} Escape sends no rename`);
  await machineGroup(page, REMOTE_NAME).waitFor({ state: "attached" });
}

async function withScenario(browser: Awaited<ReturnType<typeof chromium.launch>>, url: string, scenario: Scenario, fullBehavior: boolean): Promise<void> {
  const context = await browser.newContext({
    viewport: scenario.viewport,
    isMobile: scenario.touch,
    hasTouch: scenario.touch,
    locale: "en-US",
    deviceScaleFactor: 1,
  });
  const errors: string[] = [];
  try {
    await context.addInitScript((setting) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: setting.language, theme: setting.theme, density: setting.density, defaultView: "chat" }));
      if (setting.sidebarWidth !== null) localStorage.setItem("ovis:sidebar-width", String(setting.sidebarWidth));
    }, { language: scenario.language, theme: scenario.theme, density: scenario.density, sidebarWidth: scenario.desktopSidebar ? scenario.sidebarWidth ?? 240 : null });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    if (scenario.touch && !scenario.desktopSidebar) {
      await page.locator(".drawer-toggle").tap();
      await page.locator(".sidebar.is-open").waitFor({ state: "visible" });
    }
    const remoteGroup = machineGroup(page, REMOTE_NAME);
    await remoteGroup.waitFor({ state: "attached" });

    if (geometryOnly) {
      const manage = await openMenu(page, remoteGroup, scenario);
      await menuGeometry(page, manage, scenario);
      await renameGeometry(page, manage, scenario);
      console.log(`PASS ${scenario.name} geometry-only baseline`);
      assert.deepEqual(errors, [], `${scenario.name} has no uncaught browser errors`);
      return;
    }

    const host = machineGroup(page, "workstation");
    await host.waitFor({ state: "attached" });
    assert.equal(await host.locator(".machine-manage").count(), 0, `${scenario.name} local host has no Manage button`);
    assert.ok((await host.locator(".machine-kind").textContent() ?? "").trim().length > 0, `${scenario.name} local host has a localized kind label`);

    // a PC herdr manages keeps herdr's limits: its setup, its bridge update and its place here, and the hint says where the rest is
    const managed = machineGroup(page, MANAGED_NAME);
    const managedManage = await openMenu(page, managed, scenario);
    assert.ok((await surface(page).locator(".machine-menu-note").textContent() ?? "").trim().length > 0, `${scenario.name} herdr-managed restriction is explained in the active locale`);
    assert.equal(await items(page).count(), 3, `${scenario.name} herdr-managed PC offers setup, the bridge update and Hide: ${JSON.stringify(await itemLabels(page))}`);
    assert.equal(await item(page, RENAME_LABEL[scenario.language]!).count(), 0, `${scenario.name} herdr-managed PC has no Rename…`);
    assert.equal(await item(page, REMOVE_LABEL[scenario.language]!).count(), 0, `${scenario.name} herdr-managed PC has no Remove PC…`);
    await closeWithEscape(page, managedManage, scenario);

    const manage = await openMenu(page, remoteGroup, scenario);
    const labels = await itemLabels(page);
    assert.equal(labels.length, 6, `${scenario.name} an added PC offers six actions: ${JSON.stringify(labels)}`);
    assert.equal(labels[0], RENAME_LABEL[scenario.language], `${scenario.name} Rename… comes first`);
    assert.equal(labels.at(-1), REMOVE_LABEL[scenario.language], `${scenario.name} Remove PC… comes last`);
    assert.equal(await surface(page).locator(".is-danger").count(), 1, `${scenario.name} only Remove PC… is a danger item`);
    assert.equal((await surface(page).locator(".machine-menu-name").textContent())?.trim(), REMOTE_NAME, `${scenario.name} the menu's head names the PC`);
    await menuGeometry(page, manage, scenario);
    await capture(page, scenario, "menu");
    await renameGeometry(page, manage, scenario);
    await offRow(page, remoteGroup, scenario);
    if (!scenario.desktopSidebar) {
      const removeManage = await openMenu(page, remoteGroup, scenario);
      await press(item(page, REMOVE_LABEL[scenario.language]!), scenario);
      const dialog = page.locator(".confirm-dialog");
      await dialog.waitFor();
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      assert.equal(await page.locator(".sidebar.is-open").isVisible(), true, `${scenario.name} Escape on Remove PC's confirm leaves the drawer out`);
      assert.equal(await removeManage.evaluate((button) => document.activeElement === button), true, `${scenario.name} Escape on Remove PC's confirm gives the focus back to the manage button`);
      assert.equal(await getHook(page, "calls.deleteAttempts"), 0, `${scenario.name} Escape on Remove PC's confirm sends no DELETE`);
    }

    if (fullBehavior && !geometryOnly) {
      const observer = await page.evaluate(() => (window as unknown as { machineControlsFixture: { observe(): number } }).machineControlsFixture.observe());
      await observedPc(page, observer, {});

      await openMenu(page, remoteGroup, scenario);
      await item(page, "Disconnect").click();
      await surface(page).waitFor({ state: "detached" });
      await observedPc(page, observer, { enabled: false });
      await openMenu(page, remoteGroup, scenario);
      assert.deepEqual(await itemLabels(page), ["Rename…", "Connect", "Reconnect / setup", "Update bridge…", "Hide on this device", "Remove PC…"], "a disabled PC offers Connect in Disconnect's place");
      assert.equal(await item(page, "Reconnect / setup").getAttribute("aria-disabled"), "true", "setup waits while the PC is disabled");

      await item(page, "Rename…").click();
      const renamed = "Renamed fixture PC";
      const input = renamingGroup(page).locator(".machine-rename-input");
      await input.fill(`  ${renamed}  `);
      await input.press("Enter");
      const renamedGroup = machineGroup(page, renamed);
      await renamedGroup.waitFor();
      await observedPc(page, observer, { name: renamed });
      assert.equal(await renamedGroup.locator(".machine-manage").evaluate((button) => document.activeElement === button), true, "Enter gives the focus back to the manage button");
      const sent = (await getHook(page, "calls.mutations") as unknown[]).length;
      await openMenu(page, renamedGroup, scenario);
      await item(page, "Rename…").click();
      await renamingGroup(page).locator(".machine-rename-input").fill("Never sent");
      await renamingGroup(page).locator(".machine-rename-input").evaluate((element) => (element as HTMLElement).blur());
      await renamedGroup.waitFor();
      assert.equal((await getHook(page, "calls.mutations") as unknown[]).length, sent, "leaving the field sends no rename");

      await openMenu(page, renamedGroup, scenario);
      await item(page, "Connect").click();
      await observedPc(page, observer, { enabled: true });

      const renamedManage = await openMenu(page, renamedGroup, scenario);
      await item(page, "Remove PC…").click();
      const dialog = page.locator(".confirm-dialog");
      await dialog.waitFor();
      assert.equal(await dialog.getByRole("heading").textContent(), `Remove PC ${renamed}?`, "the dialog names the PC");
      assert.ok((await dialog.textContent() ?? "").includes(REMOVE_EXPLANATION), "the dialog says only the registration goes");
      assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).evaluate((button) => document.activeElement === button), true, "Cancel takes the focus, so Enter answers no");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      assert.equal(await renamedManage.evaluate((button) => document.activeElement === button), true, "a no gives the focus back to the manage button");
      assert.equal(await getHook(page, "calls.deleteAttempts"), 0, "asking sends no DELETE");

      await openMenu(page, renamedGroup, scenario);
      await item(page, "Remove PC…").click();
      const destructive = dialog.getByRole("button", { name: "Remove PC", exact: true });
      await page.evaluate(() => (window as unknown as { machineControlsFixture: { holdNextMutation(): void } }).machineControlsFixture.holdNextMutation());
      await destructive.click();
      await page.waitForFunction(() => (window as unknown as { machineControlsFixture: { calls: { deleteAttempts: number } } }).machineControlsFixture.calls.deleteAttempts === 1);
      assert.equal(await destructive.isDisabled(), true, "the pending DELETE disables confirmation while in flight");
      await destructive.evaluate((button) => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      assert.equal(await getHook(page, "calls.deleteAttempts"), 1, "duplicate clicks while busy issue no additional DELETE");
      await page.evaluate(() => (window as unknown as { machineControlsFixture: { releaseMutation(success: boolean): void } }).machineControlsFixture.releaseMutation(false));
      await dialog.getByRole("alert").waitFor();
      assert.match(await dialog.getByRole("alert").textContent() ?? "", /Fixture mutation rejected/);
      assert.equal(await renamedGroup.count(), 1, "failed removal retains the remote PC registration");
      assert.equal(await getHook(page, "calls.deleteCount"), 0, "failed DELETE does not increment the successful deletion count");
      assert.equal(await destructive.isDisabled(), false, "failed removal clears busy state");

      await destructive.click();
      await renamedGroup.waitFor({ state: "detached" });
      await dialog.waitFor({ state: "detached" });
      assert.equal(await getHook(page, "calls.deleteAttempts"), 2, "one retry sends exactly one additional DELETE");
      assert.equal(await getHook(page, "calls.deleteCount"), 1, "only the successful DELETE counts");
      await observedPc(page, observer, null);

      await openMenu(page, managed, scenario);
      await item(page, "Hide on this device").click();
      await managed.waitFor({ state: "detached" });
      assert.equal(await page.locator(".pcs-sidebar > :not(.machine-list)").count(), 0, "no PCs head or hidden count");
      await page.waitForFunction(() => document.activeElement?.closest(".machine-list") !== null, undefined, { timeout: 5000 })
        .catch(async () => assert.fail(`the focus fell to ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80) ?? "nothing")}`));
      assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem("ovis:hidden-pcs") ?? "[]")), ["sidebar-managed-fixture"], "the PC is hidden on this device only");
      console.log("PASS Manage PC menu: Disconnect/Connect, Rename… Enter and blur, Remove PC… confirm with busy suppression, failure recovery and one removal, Hide on this device");
    }

    console.log(`PASS ${scenario.name} Manage PC menu, its items and the rename field fit`);
    assert.deepEqual(errors, [], `${scenario.name} has no uncaught browser errors`);
  } finally {
    await context.close();
  }
}

let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
  await prepareMachineControlsDemo(app);
  server = serveDemo(app, { prefix: "/" });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const url = `http://127.0.0.1:${server.port}/`;
  for (const scenario of geometryOnly ? [scenarios[0]!] : scenarios) await withScenario(browser, url, scenario, scenario.name === "en-desktop-240-dark");
  console.log(`PASS sidebar machine layout regression${geometryOnly ? " (geometry-only)" : ""}`);
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
