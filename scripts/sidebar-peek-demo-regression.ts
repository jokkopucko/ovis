import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { PEEK_CLOSE_MS, PEEK_OPEN_MS } from "../src/lib/sidebarPeek.ts";
import { installClock } from "./app-context.ts";
import { withDemoBrowser } from "./demo-browser.ts";
import { openSettingsPage } from "./settings-page.ts";

// Only the disposable demo build is served; no live session is read.
const evidence = process.env["UI_EVIDENCE_DIR"];

const sidebar = (page: Page) => page.locator("#workspace-drawer");
const peeking = (page: Page) => page.locator("#workspace-drawer.is-peek");
const toggle = (page: Page) => page.locator(".sidebar-toggle");
const paneWidth = async (page: Page): Promise<number> => (await page.locator(".pane-column").first().boundingBox())!.width;
const focused = (page: Page): Promise<string> => page.evaluate(() => {
  const element = document.activeElement;
  return element === null ? "none" : `${element.tagName}.${element.className}`;
});
const away = async (page: Page): Promise<void> => {
  await page.mouse.move(900, 20, { steps: 4 });
  await page.mouse.move(900, 500, { steps: 4 });
};
const onToggle = async (page: Page): Promise<void> => {
  const box = (await toggle(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
};

await withDemoBrowser({ tempPrefix: "herdr-sidebar-peek-", prefix: "/" }, async ({ newContext, baseUrl }) => {
  const url = (sidebarParam: string) => `${baseUrl}?pane=${encodeURIComponent(panes.shell)}${sidebarParam}`;
  for (const theme of ["dark", "light"] as const) {
    {
      const context = await newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await installClock(page);
        await context.addInitScript((value) => { if (localStorage.getItem("ovis:settings") === null) { localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: value })); localStorage.setItem("ovis:sidebar-filter-shown", "true"); } }, theme);
        // the row opened from the peek is the Claude pane's: its turn stays at work, or on a slow runner
        // the end the demo times 4.5s in folds that row away first
        await context.addInitScript(() => Reflect.set(window, "__ovisDemoHoldTurn", true));

        await page.goto(url("&sidebar=hidden"));
        await page.locator(".app.sidebar-collapsed").waitFor();
        await away(page);
        await onToggle(page);
        await page.clock.runFor(PEEK_OPEN_MS * 4);
        assert.equal(await peeking(page).count(), 0, "off by default, no peek");
        assert.equal(await sidebar(page).isVisible(), false, "the collapsed sidebar stays hidden");

        await toggle(page).click();
        await page.locator(".sidebar-footer-settings").click();
        await openSettingsPage(page, "Appearance");
        const setting = page.locator(".settings-dialog").getByRole("switch", { name: "Show the sidebar on hover", exact: true });
        assert.equal(await setting.getAttribute("aria-checked"), "false", "off by default in Settings");
        await setting.click();
        await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").sidebarPeek === true);
        if (evidence) {
          mkdirSync(evidence, { recursive: true });
          await setting.evaluate((element) => element.scrollIntoView({ block: "center" }));
          await page.locator(".settings-dialog").screenshot({ path: join(evidence, `sidebar-peek-settings-1280-${theme}.png`) });
        }
        await page.keyboard.press("Escape");
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await toggle(page).click();
        await page.locator(".app.sidebar-collapsed").waitFor();
        await away(page);
        const widthBefore = await paneWidth(page);
        const focusBefore = await focused(page);
        await onToggle(page);
        await page.clock.runFor(PEEK_OPEN_MS);
        await peeking(page).waitFor();
        assert.equal(await page.locator(".app.sidebar-collapsed").count(), 1, "the sidebar is still collapsed");
        assert.equal(await paneWidth(page), widthBefore, "the pane keeps its width");
        assert.equal(await focused(page), focusBefore, "the focus stays where it was");
        const box = (await sidebar(page).boundingBox())!;
        const header = (await page.locator(".app-header").boundingBox())!;
        assert.equal(box.x, 0, "from the window's left edge");
        assert.ok(Math.abs(box.y - (header.y + header.height)) <= 1, "right under the header");
        assert.ok(box.width >= 240 && box.width <= 640, `at its open width (${box.width}px)`);
        assert.equal(await sidebar(page).locator(".sidebar-footer-row > .sidebar-footer-settings + .sidebar-footer-inbox").getAttribute("title"), "Inbox", "the peek's foot holds Inbox beside the gear");
        if (evidence) await page.screenshot({ path: join(evidence, `sidebar-peek-1280-${theme}.png`) });

        await page.goto(url("&sidebar=hidden"));
        await page.locator(".app.sidebar-collapsed").waitFor();
        await away(page);
        await onToggle(page);
        await page.clock.runFor(PEEK_OPEN_MS);
        await peeking(page).waitFor();
        const filter = page.locator("#workspace-drawer .sidebar-filter-input");
        await filter.focus();
        await away(page);
        await page.clock.runFor(PEEK_CLOSE_MS * 3);
        assert.equal(await peeking(page).count(), 1, "a field focused before the pointer came in holds it too");
        await page.keyboard.press("Escape");
        await peeking(page).waitFor({ state: "detached" });
        assert.equal(await toggle(page).evaluate((element) => element === document.activeElement), true, "the focus goes back to the toggle, not to the page");
        await onToggle(page);
        await page.clock.runFor(PEEK_OPEN_MS);
        await peeking(page).waitFor();

        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
        await page.clock.runFor(PEEK_CLOSE_MS * 3);
        assert.equal(await peeking(page).count(), 1, "the trip from the toggle into the sidebar keeps it");
        const row = page.locator(`.agent-list .agent-item[data-pane="${panes.api}"] .agent-select`);
        await row.hover();
        await row.click();
        await page.locator(`.agent-list .agent-item[data-pane="${panes.api}"].is-selected`).waitFor();
        assert.equal(await peeking(page).count(), 1, "picking a row keeps the sidebar while the pointer is on it");

        await page.locator(".machine-list .workspace-header").first().click({ button: "right" });
        await page.getByRole("menuitem", { name: "Rename workspace", exact: true }).click();
        const rename = page.locator(".workspace-rename-input");
        await rename.waitFor();
        await rename.pressSequentially("-x");
        await away(page);
        await page.clock.runFor(PEEK_CLOSE_MS * 3);
        assert.equal(await peeking(page).count(), 1, "kept while a name is typed in it");
        assert.equal(await rename.evaluate((element) => element === document.activeElement), true, "and the field keeps the focus");
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
        await page.keyboard.press("Escape");
        await rename.waitFor({ state: "detached" });
        await page.clock.runFor(PEEK_CLOSE_MS * 3);
        assert.equal(await peeking(page).count(), 1, "the rename's Escape leaves the peek");

        await page.evaluate(() => { const foreign = document.createElement("div"); foreign.id = "foreign-dialog"; foreign.setAttribute("role", "dialog"); document.body.append(foreign); });
        await away(page);
        await page.clock.runFor(PEEK_CLOSE_MS);
        await peeking(page).waitFor({ state: "detached" });
        await page.evaluate(() => document.getElementById("foreign-dialog")?.remove());
        await onToggle(page);
        await page.clock.runFor(PEEK_OPEN_MS);
        await peeking(page).waitFor();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });

        const rows = page.locator(".machine-list [draggable=true]");
        const from = (await rows.nth(0).boundingBox())!;
        const over = (await rows.nth(1).boundingBox())!;
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2, { steps: 4 });
        await page.mouse.down();
        await page.mouse.move(over.x + over.width / 2, over.y + over.height / 2, { steps: 8 });
        await page.clock.runFor(PEEK_CLOSE_MS * 3);
        assert.equal(await peeking(page).count(), 1, "kept under a drag");
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2, { steps: 8 });
        await page.mouse.up();
        await page.clock.runFor(PEEK_CLOSE_MS * 3);
        assert.equal(await peeking(page).count(), 1, "and after the drop, with the pointer still on it");

        await away(page);
        await page.clock.runFor(PEEK_CLOSE_MS);
        await peeking(page).waitFor({ state: "detached" });
        assert.equal(await sidebar(page).isVisible(), false, "hidden again");
        assert.equal(await paneWidth(page), widthBefore, "and the pane never moved");

        await onToggle(page);
        await page.clock.runFor(PEEK_OPEN_MS);
        await peeking(page).waitFor();
        await page.keyboard.press("Escape");
        await peeking(page).waitFor({ state: "detached" });
        await page.clock.runFor(PEEK_OPEN_MS * 4);
        assert.equal(await peeking(page).count(), 0, "Escape's dismissal holds until the pointer comes back");

        await away(page);
        await onToggle(page);
        await page.clock.runFor(PEEK_OPEN_MS);
        await peeking(page).waitFor();
        await toggle(page).click();
        await page.locator(".app:not(.sidebar-collapsed)").waitFor();
        await away(page);
        await page.clock.runFor(PEEK_CLOSE_MS * 3);
        assert.equal(await peeking(page).count(), 0, "an open sidebar is no peek");
        assert.equal(await sidebar(page).isVisible(), true, "and it stays open when the pointer leaves");
        assert.ok(await paneWidth(page) < widthBefore, "the pinned sidebar takes its column back");
        assert.deepEqual(errors, []);
        console.log(`PASS desktop ${theme}: off by default; on, the toggle's hover shows the sidebar over the pane without moving it or the focus, the trip in keeps it, a row opens its pane, a keyboard-focused field or a drag in it holds it, leaving or Escape hides it and a click keeps it open`);
      } finally { await context.close(); }
    }

    {
      const context = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: theme });
      try {
        await context.addInitScript((value) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: value, sidebarPeek: true })), theme);
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url(""));
        assert.equal(await toggle(page).isVisible(), false, "a phone has no collapse toggle to rest on");
        await page.getByRole("button", { name: "Open workspace list", exact: true }).tap();
        await page.locator("#workspace-drawer.is-open").waitFor();
        assert.equal(await peeking(page).count(), 0, "the drawer is no peek");
        await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
        if (evidence) await page.screenshot({ path: join(evidence, `sidebar-peek-390-${theme}.png`) });
        assert.deepEqual(errors, []);
        console.log(`PASS phone ${theme}: with the setting on, the drawer opens and closes by tap as before`);
      } finally { await context.close(); }
    }
  }
});
