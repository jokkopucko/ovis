/**
 * A phone's open surfaces keep clear of the screen's safe-area insets: the notch or Dynamic Island,
 * the rounded corners and the home indicator, on every side a phone puts them, landscape's left and
 * right included. Upright (390x844 under a 59px Dynamic Island and a 34px home indicator): the
 * search sheet, the header's More and tab sheets, Settings and a confirmation. A short screen (the
 * keyboard up): a sheet's top stays below the island. Landscape (844x390, 59px on either side and a
 * 21px indicator): Settings, a tab's menu and a confirmation. Every visible control of the open
 * surface lies inside the safe area, and the controls that close or answer it are drawn whole there
 * (a sheet's cap that cut them off would hide them from that check). An iPhone's keyboard (the layout
 * viewport stays, the visual one shrinks) keeps the search sheet and Settings below the island too.
 * Chromium has no phone insets of its own: CDP emulates them.
 * On demo fixtures; UI_EVIDENCE_DIR=<dir> keeps the screenshots.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openMoreGroup } from "./header-more.ts";

type Insets = { top: number; right: number; bottom: number; left: number };
type Screen = { label: string; width: number; height: number; insets: Insets };

const UPRIGHT: Screen = { label: "upright", width: 390, height: 844, insets: { top: 59, right: 0, bottom: 34, left: 0 } };
const SHORT: Screen = { label: "short", width: 390, height: 500, insets: { top: 59, right: 0, bottom: 0, left: 0 } };
const LANDSCAPE: Screen = { label: "landscape", width: 844, height: 390, insets: { top: 0, right: 59, bottom: 21, left: 59 } };

const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });

async function open(browser: Browser, origin: string, screen: Screen, run: (page: Page) => Promise<void>, keyboard = false): Promise<void> {
  const context = await browser.newContext({ viewport: { width: screen.width, height: screen.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: "en-US" });
  try {
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
    // an iPhone's keyboard: the visual viewport shrinks under a layout viewport that stays (lib/viewport.ts)
    if (keyboard) await context.addInitScript(() => {
      const viewport = window.visualViewport!;
      let height: number | null = null;
      Object.defineProperty(viewport, "height", { get: () => height ?? window.innerHeight });
      (window as Window & { raiseKeyboard?: (value: number) => void }).raiseKeyboard = (value) => {
        height = value;
        viewport.dispatchEvent(new Event("resize"));
      };
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const { top, right, bottom, left } = screen.insets;
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets: { top, topMax: top, right, rightMax: right, bottom, bottomMax: bottom, left, leftMax: left } } as never);
    await page.goto(`${origin}/?pane=${encodeURIComponent(panes.api)}`);
    await page.locator(".conn-live").waitFor();
    await run(page);
    assert.deepEqual(errors, [], `${screen.label}: no page errors`);
  } finally { await context.close(); }
}

/** The visible controls and text of `surface` that reach into an inset, clipped to their scroll boxes. */
async function outside(page: Page, surface: string, insets: Insets): Promise<string[]> {
  await page.locator(surface).last().waitFor();
  // a sheet rises for --dur-sheet: measure where it rests
  await page.waitForFunction((selector) => [...document.querySelectorAll(selector)].every((node) => node.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running")), surface);
  return page.evaluate(({ surface, insets }) => {
    const safe = { left: insets.left, top: insets.top, right: innerWidth - insets.right, bottom: innerHeight - insets.bottom };
    const found: string[] = [];
    for (const root of document.querySelectorAll(surface)) {
      for (const node of root.querySelectorAll("button, a[href], input, textarea, select, [role=button], [role=menuitem], [role=option], h1, h2, h3, label, p")) {
        const style = getComputedStyle(node);
        if (style.visibility === "hidden" || style.display === "none" || node.closest(".visually-hidden, [aria-hidden=true]")) continue;
        if (node.matches("h1, h2, h3, label, p") && !node.textContent?.trim()) continue;
        const box = node.getBoundingClientRect();
        let shown = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
        for (let up = node.parentElement; up; up = up.parentElement) {
          const clip = getComputedStyle(up);
          if (clip.overflowX === "visible" && clip.overflowY === "visible") continue;
          const edge = up.getBoundingClientRect();
          shown = { left: Math.max(shown.left, edge.left), top: Math.max(shown.top, edge.top), right: Math.min(shown.right, edge.right), bottom: Math.min(shown.bottom, edge.bottom) };
        }
        if (shown.right - shown.left < 1 || shown.bottom - shown.top < 1) continue;
        const sides = (["left", "top"] as const).filter((side) => shown[side] < safe[side] - 0.5)
          .concat((["right", "bottom"] as const).filter((side) => shown[side] > safe[side] + 0.5));
        if (sides.length === 0) continue;
        const name = (node.getAttribute("aria-label") ?? node.textContent ?? "").trim().slice(0, 40);
        found.push(`${node.tagName.toLowerCase()} "${name}" past the ${sides.join(" and ")} inset (${JSON.stringify(shown)})`);
      }
    }
    return found;
  }, { surface, insets });
}

/** Every surface is checked before the run fails, so one run names each one that reaches into an inset. */
const failures: string[] = [];
function clear(found: string[], what: string): void {
  for (const line of found) failures.push(`${what}: ${line}`);
}

/** `control` is drawn whole inside the safe area, scrolled into view if its list scrolls. */
async function reachable(control: Locator, insets: Insets, what: string): Promise<void> {
  const box = await control.evaluate((node, insets) => {
    node.scrollIntoView({ block: "nearest" });
    const own = node.getBoundingClientRect();
    let shown = { left: own.left, top: own.top, right: own.right, bottom: own.bottom };
    for (let up = node.parentElement; up; up = up.parentElement) {
      const clip = getComputedStyle(up);
      if (clip.overflowX === "visible" && clip.overflowY === "visible") continue;
      const edge = up.getBoundingClientRect();
      shown = { left: Math.max(shown.left, edge.left), top: Math.max(shown.top, edge.top), right: Math.min(shown.right, edge.right), bottom: Math.min(shown.bottom, edge.bottom) };
    }
    const whole = shown.right - shown.left >= own.width - 0.5 && shown.bottom - shown.top >= own.height - 0.5 && own.width > 0 && own.height > 0;
    const inside = own.left >= insets.left - 0.5 && own.top >= insets.top - 0.5
      && own.right <= innerWidth - insets.right + 0.5 && own.bottom <= innerHeight - insets.bottom + 0.5;
    return { whole, inside, own: { left: own.left, top: own.top, right: own.right, bottom: own.bottom } };
  }, insets);
  if (!box.whole || !box.inside) failures.push(`${what}: not drawn whole inside the safe area (${JSON.stringify(box)})`);
}

async function keep(page: Page, name: string): Promise<void> {
  if (evidence) await page.screenshot({ path: join(evidence, `phone-safe-area-${name}.png`) });
}

async function headerMore(page: Page, item?: string): Promise<void> {
  await page.locator(".header-more-button").click();
  if (!item) return;
  const menu = page.locator(".row-sheet, .row-menu");
  await menu.waitFor();
  // a phone's More holds the pane's and tab's actions under Pane and tab… (G-143)
  if (!(await menu.getByText(item, { exact: true }).isVisible())) await openMoreGroup(page, "pane");
  await menu.getByText(item, { exact: true }).click();
}

async function close(page: Page, surface: string): Promise<void> {
  await page.keyboard.press("Escape");
  await page.locator(surface).waitFor({ state: "detached" });
}

const app = mkdtempSync(join(tmpdir(), "ovis-safe-area-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n<script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    let file: string;
    try { file = decodeURIComponent(new URL(request.url).pathname.slice(1)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const origin = `http://127.0.0.1:${server.port}`;
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    await open(browser, origin, UPRIGHT, async (page) => {
      const label = UPRIGHT.label;
      await headerMore(page, "Search panes and actions");
      clear(await outside(page, ".palette-scrim", UPRIGHT.insets), `${label}: the search sheet clears the Dynamic Island`);
      await reachable(page.getByRole("button", { name: "Close command palette" }), UPRIGHT.insets, `${label}: the search sheet's close`);
      await keep(page, "upright-search");
      await close(page, ".palette-scrim");

      await headerMore(page);
      clear(await outside(page, ".row-sheet", UPRIGHT.insets), `${label}: the header's More sheet clears the insets`);
      await reachable(page.locator(".row-sheet-cancel"), UPRIGHT.insets, `${label}: the More sheet's Cancel`);
      await reachable(page.locator(".row-sheet .row-sheet-item").last(), UPRIGHT.insets, `${label}: the More sheet's last action`);
      await close(page, ".row-sheet");

      await page.locator(".app-header .context-tabs").click();
      clear(await outside(page, ".row-sheet", UPRIGHT.insets), `${label}: the title's tab sheet clears the insets`);
      await reachable(page.locator(".row-sheet-cancel"), UPRIGHT.insets, `${label}: the tab sheet's Cancel`);
      await close(page, ".row-sheet");

      await headerMore(page, "Close tab");
      clear(await outside(page, "[role=alertdialog]", UPRIGHT.insets), `${label}: a confirmation clears the insets`);
      await reachable(page.getByRole("alertdialog").getByRole("button", { name: "Close tab" }), UPRIGHT.insets, `${label}: the confirmation's Close tab`);
      await close(page, "[role=alertdialog]");

      await page.locator(".drawer-toggle").click();
      await page.locator(".sidebar").getByRole("button", { name: /^Settings/ }).first().click();
      clear(await outside(page, ".settings-dialog", UPRIGHT.insets), `${label}: Settings clears the insets`);
      await reachable(page.getByRole("button", { name: "Close settings" }), UPRIGHT.insets, `${label}: Settings' close`);
      await keep(page, "upright-settings");
    });

    await open(browser, origin, SHORT, async (page) => {
      for (const [name, surface, show] of [
        ["search", ".command-palette", () => headerMore(page, "Search panes and actions")],
        ["More", ".row-sheet", () => headerMore(page)],
        ["Settings", ".settings-dialog", async () => {
          await page.locator(".drawer-toggle").click();
          await page.locator(".sidebar").getByRole("button", { name: /^Settings/ }).first().click();
        }],
      ] as const) {
        await show();
        clear(await outside(page, surface, SHORT.insets), `${SHORT.label}: the ${name} sheet clears the island`);
        await reachable(page.locator(surface).getByRole("button", { name: /^(Close command palette|Close settings|Cancel)$/ }).last(), SHORT.insets, `${SHORT.label}: the ${name} sheet's close`);
        const top = await page.locator(surface).evaluate((node) => node.getBoundingClientRect().top);
        if (top < SHORT.insets.top) failures.push(`${SHORT.label}: the ${name} sheet starts under the island (${top} < ${SHORT.insets.top})`);
        if (name === "search") await keep(page, "short-search");
        await close(page, surface);
      }
    });

    await open(browser, origin, UPRIGHT, async (page) => {
      const label = "iPhone keyboard";
      const raise = async (field: Locator): Promise<void> => {
        await field.focus();
        await page.evaluate(() => (window as Window & { raiseKeyboard?: (value: number) => void }).raiseKeyboard?.(500));
        await page.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard"));
      };
      for (const [name, surface, field, show] of [
        ["search", ".command-palette", () => page.locator(".palette-search .input"), () => headerMore(page, "Search panes and actions")],
        ["Settings", ".settings-dialog", () => page.locator(".settings-search-input"), async () => {
          await page.locator(".drawer-toggle").click();
          await page.locator(".sidebar").getByRole("button", { name: /^Settings/ }).first().click();
        }],
      ] as const) {
        await show();
        await page.locator(surface).waitFor();
        await raise(field());
        const insets = { ...UPRIGHT.insets, bottom: 0 };
        clear(await outside(page, surface, insets), `${label}: the ${name} sheet clears the island`);
        await reachable(page.locator(surface).getByRole("button", { name: /^(Close command palette|Close settings)$/ }), insets, `${label}: the ${name} sheet's close`);
        const top = await page.locator(surface).evaluate((node) => node.getBoundingClientRect().top);
        if (top < UPRIGHT.insets.top) failures.push(`${label}: the ${name} sheet starts under the island (${top} < ${UPRIGHT.insets.top})`);
        if (name === "search") await keep(page, "keyboard-search");
        await page.evaluate(() => (window as Window & { raiseKeyboard?: (value: number) => void }).raiseKeyboard?.(window.innerHeight));
        await close(page, surface);
      }
    }, true);

    await open(browser, origin, LANDSCAPE, async (page) => {
      const label = LANDSCAPE.label;
      await page.locator(".sidebar").getByRole("button", { name: /^Settings/ }).first().click();
      clear(await outside(page, ".settings-dialog", LANDSCAPE.insets), `${label}: Settings clears the notch on either side and the home indicator`);
      await reachable(page.getByRole("button", { name: "Close settings" }), LANDSCAPE.insets, `${label}: Settings' close`);
      await reachable(page.locator(".settings-dialog .settings-tab").last(), LANDSCAPE.insets, `${label}: Settings' last page`);
      await keep(page, "landscape-settings");
      await close(page, ".settings-dialog");

      await page.locator(".tab-strip-menu").first().click();
      clear(await outside(page, ".row-menu", LANDSCAPE.insets), `${label}: a tab's menu ends above the home indicator`);
      await reachable(page.locator(".row-menu [role=menuitem]").last(), LANDSCAPE.insets, `${label}: the tab menu's last item`);
      await keep(page, "landscape-tab-menu");
      await page.locator(".row-menu").getByText("Close tab", { exact: true }).click();
      clear(await outside(page, "[role=alertdialog]", LANDSCAPE.insets), `${label}: a confirmation clears the insets`);
      await reachable(page.getByRole("alertdialog").getByRole("button", { name: "Close tab" }), LANDSCAPE.insets, `${label}: the confirmation's Close tab`);
      await close(page, "[role=alertdialog]");
    });
  } finally {
    await browser.close();
    await server.stop(true);
  }
  assert.deepEqual(failures, [], "every open surface keeps clear of the safe-area insets");
  console.log("PASS a phone's sheets, dialogs and menus keep clear of the safe-area insets, upright, short and landscape");
} finally {
  rmSync(app, { recursive: true, force: true });
}
