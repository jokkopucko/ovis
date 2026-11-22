import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { tabCreate, tabRename, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

const TAB_LABELS = ["api", "web", "docs", "deploy", "review", "tests", "release-notes", "migrations", "infra", "billing",
  "search", "mobile", "analytics", "onboarding", "payments", "metrics", "support", "staging", "backups", "last-tab"];
const HEADER = ".header-tabs .tab-strip";
const HALF = '.pane-slot[data-side="left"] .tab-strip';
const TAB_MIN = 120;

async function headerRow(page: Page): Promise<{ tabs: { name: string; width: number; selected: boolean; closeShown: boolean }[]; more: string | null; overflow: number }> {
  return page.evaluate((selector) => {
    const row = document.querySelector<HTMLElement>(selector);
    const items = [...(row?.querySelectorAll<HTMLElement>(".tab-strip-item") ?? [])];
    return {
      tabs: items.map((item) => {
        const tab = item.querySelector<HTMLElement>('[role="tab"]');
        const close = item.querySelector<HTMLElement>(".tab-strip-close");
        return {
          name: tab?.querySelector(".tab-strip-label")?.textContent ?? "",
          width: item.getBoundingClientRect().width,
          selected: tab?.getAttribute("aria-selected") === "true",
          closeShown: !!close && getComputedStyle(close).display !== "none" && close.getBoundingClientRect().width > 0,
        };
      }),
      more: document.querySelector<HTMLElement>(".header-tabs .tab-strip-more")?.textContent ?? null,
      overflow: row ? row.scrollWidth - row.clientWidth : -1,
    };
  }, HEADER);
}

export async function checkTabOverflow(browser: Browser, origin: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-tab-overflow-")));
  let workspaceId: string | null = null;
  let fewId: string | null = null;
  try {
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-tab-overflow" });
    workspaceId = created.workspace.workspace_id;
    const first = created.root_pane.pane_id;
    let last = first;
    await tabRename(created.tab.tab_id, TAB_LABELS[0]!);
    for (const label of TAB_LABELS.slice(1)) last = (await tabCreate({ workspaceId, cwd: root, label })).root_pane.pane_id;
    const few = await workspaceCreate({ cwd: root, label: "ovis-test-tab-overflow-few" });
    fewId = few.workspace.workspace_id;

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    try {
      await context.addInitScript(() => {
        if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      });
      const page = await context.newPage();

      const rowSettled = async (when: string, open: string): Promise<Awaited<ReturnType<typeof headerRow>>> => {
        await page.locator(`${HEADER} [role="tab"][aria-selected="true"]`, { has: page.locator(".tab-strip-label", { hasText: new RegExp(`^${open}$`) }) }).waitFor({ timeout: 15_000 });
        await page.locator(".header-tabs .tab-strip-more").waitFor({ timeout: 5_000 })
          .catch(() => { throw new Error(`${when}: 20 tabs that do not fit show no More button in the header's row`); });
        await page.waitForFunction((selector) => {
          const node = document.querySelector(selector);
          return !!node && node.scrollWidth - node.clientWidth <= 1;
        }, HEADER, { timeout: 5_000 })
          .catch(() => { throw new Error(`${when}: the header's row still scrolls past its end`); });
        const row = await headerRow(page);
        const narrow = row.tabs.filter((tab) => tab.width < TAB_MIN - 0.5);
        assert.deepEqual(narrow, [], `${when}: no tab in the header's row is narrower than ${TAB_MIN}px`);
        assert.ok(row.overflow <= 1, `${when}: the header's row does not scroll (${row.overflow}px past its end)`);
        assert.ok(row.tabs.length >= 2 && row.tabs.length < TAB_LABELS.length, `${when}: some tabs are in the row and some are not (${row.tabs.length})`);
        assert.equal(row.more?.replace(/\D/g, ""), String(TAB_LABELS.length - row.tabs.length), `${when}: More counts the tabs left out of the row`);
        assert.ok(row.tabs.some((tab) => tab.selected && tab.name === open), `${when}: the open tab ${open} is in the row`);
        return row;
      };

      await page.goto(`${origin}/?pane=${encodeURIComponent(last)}`);
      const row = await rowSettled("20 tabs, the last open", "last-tab");
      await closeOnlyOnFullTabs(page);
      const hidden = TAB_LABELS.filter((label) => !row.tabs.some((tab) => tab.name === label));
      assert.ok(hidden.includes("metrics"), "metrics waits behind More");

      await page.locator(".header-tabs .tab-strip-more").click();
      const listed = await page.getByRole("menu").locator('[role="menuitem"] .menu-item-main').allTextContents();
      assert.deepEqual(listed.map((text) => text.trim()), hidden, "More lists the tabs left out of the row, in their order");
      const letter = [..."abcdefghijklmnopqrstuvwxyz"].find((first) => hidden.filter((name) => name.startsWith(first)).length >= 2);
      assert.ok(letter, `two tabs behind More share a first letter: ${hidden.join(", ")}`);
      await page.waitForFunction(() => document.activeElement?.closest(".row-menu") != null);
      const focusedTab = () => page.evaluate(() => document.activeElement?.querySelector(".menu-item-main")?.textContent?.trim() ?? "");
      let at = hidden.indexOf(await focusedTab());
      const walked: string[] = [], wanted: string[] = [];
      for (let press = 0; press <= hidden.filter((name) => name.startsWith(letter)).length; press += 1) {
        await page.keyboard.press(letter);
        walked.push(await focusedTab());
        at = [...hidden.keys()].map((step) => (at + 1 + step) % hidden.length).find((index) => hidden[index]!.startsWith(letter))!;
        wanted.push(hidden[at]!);
      }
      assert.deepEqual(walked, wanted, `"${letter}" pressed over More walks every tab it starts, in order`);
      await page.getByRole("menu").getByRole("menuitem").filter({ has: page.locator(".menu-item-main", { hasText: /^metrics$/ }) }).click();
      await rowSettled("metrics picked from More", "metrics");

      await page.setViewportSize({ width: 1024, height: 900 });
      await rowSettled("at 1024px", "metrics");
      await page.setViewportSize({ width: 1280, height: 900 });
      console.log("PASS the header's row keeps every tab at least 120px wide and its close only on a full-size tab; the tabs that do not fit are listed behind More, and one picked there opens in the row");

      const strip = page.locator(HALF);
      const overflowing = async (): Promise<void> => {
        await page.locator(`${HALF} [role="tab"]`, { has: page.locator(".tab-strip-label", { hasText: /^last-tab$/ }) }).waitFor({ state: "attached", timeout: 15_000 });
        await page.waitForFunction((selector) => {
          const node = document.querySelector(selector);
          return !!node && node.scrollWidth - node.clientWidth > 100;
        }, HALF, { timeout: 5_000 });
      };
      const scrollLeft = (): Promise<number> => strip.evaluate((node) => node.scrollLeft);
      const wheelScrolls = async (when: string): Promise<void> => {
        await strip.evaluate((node) => { node.scrollLeft = 0; });
        const box = await strip.boundingBox();
        assert.ok(box, `${when}: the strip is drawn`);
        await page.mouse.move(box.x + 60, box.y + box.height / 2);
        await page.mouse.wheel(0, 400);
        await page.waitForFunction((selector) => (document.querySelector(selector)?.scrollLeft ?? 0) > 0, HALF, { timeout: 5_000 })
          .catch(() => { throw new Error(`${when}: a vertical wheel over the overflowing strip left it unscrolled`); });
        const down = await scrollLeft();
        await page.mouse.wheel(0, -400);
        await page.waitForFunction(([selector, was]) => (document.querySelector(selector as string)?.scrollLeft ?? was) < (was as number), [HALF, down] as const, { timeout: 5_000 })
          .catch(() => { throw new Error(`${when}: a wheel turned up did not scroll the strip back`); });
        await page.mouse.wheel(0, 10_000);
        await page.waitForFunction((selector) => {
          const node = document.querySelector(selector);
          const end = [...(node?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].find((tab) => tab.querySelector(".tab-strip-label")?.textContent === "last-tab");
          const add = node?.querySelector(".tab-strip-add");
          if (!node || !end || !add) return false;
          const box = node.getBoundingClientRect();
          const item = end.getBoundingClientRect();
          return item.left >= box.left && item.right <= add.getBoundingClientRect().left + 1;
        }, HALF, { timeout: 5_000 })
          .catch(() => { throw new Error(`${when}: wheeling down to the strip's end left the last tab out of view`); });
      };
      const leftAlone = (selector: string, init: WheelEventInit): Promise<boolean> => page.locator(selector).first().evaluate((node, wheel) =>
        node.dispatchEvent(new WheelEvent("wheel", { ...wheel, bubbles: true, cancelable: true })), init);

      await page.evaluate((other) => {
        sessionStorage.setItem("ovis:split", JSON.stringify({ other: { machineId: "local", paneId: other }, bSide: "right", active: "a" }));
      }, few.root_pane.pane_id);
      await page.goto(`${origin}/?pane=${encodeURIComponent(first)}`);
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2, null, { timeout: 15_000 });
      await overflowing();
      await wheelScrolls("split half");
      // a wheel that counts in lines (Firefox's) or pages moves the strip as far as one in pixels would
      for (const [mode, delta, least] of [[1, 3, 30], [2, 1, 200]] as const) {
        const moved = await strip.evaluate((node, [deltaMode, deltaY]) => {
          node.scrollLeft = 0;
          node.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaMode, bubbles: true, cancelable: true }));
          return { moved: node.scrollLeft, room: node.scrollWidth - node.clientWidth };
        }, [mode, delta] as const);
        assert.ok(moved.moved >= Math.min(least, moved.room - 1), `a wheel in ${mode === 1 ? "lines" : "pages"} scrolls the strip (${moved.moved}px of ${moved.room})`);
      }
      assert.equal(await leftAlone(HALF, { deltaX: 120, deltaY: 10 }), true, "a sideways wheel or trackpad swipe is the browser's");
      // mostly down, a little sideways either way: turned into sideways scroll from deltaY alone, the
      // strip would move against the swipe's own sideways part (#2103)
      for (const deltaX of [20, -20]) assert.equal(await leftAlone(HALF, { deltaX, deltaY: 40 }), true, `a diagonal trackpad swipe (deltaX ${deltaX}) is the browser's`);
      assert.equal(await leftAlone(HALF, { deltaY: 120, ctrlKey: true }), true, "a pinch is the browser's");
      const fewStrip = '.pane-slot[data-side="right"] .tab-strip';
      assert.equal(await page.locator(fewStrip).evaluate((node) => node.scrollWidth <= node.clientWidth), true, "the one tab fits");
      assert.equal(await leftAlone(fewStrip, { deltaY: 120 }), true, "a strip whose tabs fit leaves the wheel alone");

      await page.locator('.pane-slot[data-side="right"]').getByRole("button", { name: "Close this half", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length <= 1, null, { timeout: 15_000 });
      await rowSettled("after a split closed", "api");
    } finally { await context.close(); }
    console.log("PASS a vertical mouse wheel scrolls a split half's overflowing tab strip sideways to its last tab (pixels, lines, pages), and leaves a sideways wheel, a diagonal swipe, a pinch and a strip that fits to the browser");
  } finally {
    if (workspaceId) await workspaceClose(workspaceId).catch(() => {});
    if (fewId) await workspaceClose(fewId).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

async function closeOnlyOnFullTabs(page: Page): Promise<void> {
  await page.locator(`${HEADER} .tab-strip-item:not(.is-active)`).first().hover();
  const hovered = await headerRow(page);
  for (const tab of hovered.tabs.filter((entry) => entry.closeShown)) assert.ok(tab.width >= TAB_MIN - 0.5, `${tab.name}: a close shows only on a full-size tab (${tab.width}px)`);
  assert.deepEqual(hovered.tabs.filter((tab) => tab.closeShown).map((tab) => tab.name), hovered.tabs.filter((tab) => tab.selected).map((tab) => tab.name), "only the open tab shows a close, whichever tab the pointer is over");
  await page.mouse.move(0, 400);
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "ovis-tab-overflow-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    await checkTabOverflow(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(state, { recursive: true, force: true });
  }
}
