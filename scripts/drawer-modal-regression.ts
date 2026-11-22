import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { SHEET_HISTORY_KEY } from "../src/lib/historyKeys.ts";
import { SECOND_TAP_MS } from "../src/lib/useSidebarLayout.ts";

declare global {
  interface Window {
    toggleClicks: number[];
    nativeCalls: string[];
  }
}


const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ovis-drawer-modal-"));
const app = join(root, "app");
await buildDemoApp(app);
const index = (await Bun.file(join(app, "index.html")).text()).replace(
  '<script type="module"',
  '<script src="/demo-transport.js"></script><script type="module"',
);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/") return new Response(index, { headers: { "content-type": "text/html" } });
  const file = Bun.file(join(app, path));
  return await file.exists() ? new Response(file) : new Response("not found", { status: 404 });
} });
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] }).catch((error: unknown) => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
  throw error;
});
const openPane = async (page: Page): Promise<void> => {
  // Once the document commits, the pane's connection is the readiness signal.
  await page.goto(`http://127.0.0.1:${server.port}/?pane=w1C%3Ap1&view=chat`, { waitUntil: "commit" });
  await page.locator(".conn-live").first().waitFor();
};
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await openPane(page);
  await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
  const drawer = page.locator("#workspace-drawer");
  await drawer.waitFor({ state: "visible" });
  assert.equal(await drawer.getAttribute("role"), "dialog", "the phone drawer exposes dialog semantics");
  assert.equal(await drawer.getAttribute("aria-modal"), "true", "the trapped phone drawer is modal");
  const owned = (await drawer.getAttribute("aria-owns"))?.split(" ") ?? [];
  assert.deepEqual(owned, ["drawer-toggle"], "the open drawer owns the header's toggle");
  for (const id of owned) assert.equal(await page.locator(`.app-header #${id}`).count(), 1, `the owned ${id} is the header's own control`);
  assert.equal(await page.locator(".app-header .new-workspace-button").count(), 0, "the header draws no + over the open drawer");
  const mark = page.locator(".app-header #drawer-toggle");
  assert.deepEqual(await mark.evaluate((node) => [node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("aria-expanded"), node.querySelector("img") !== null]),
    ["Open agent inbox", "Open agent inbox", null, true], "the open drawer's head is the Ovis mark, named and titled for the inbox");
  const namedClose = drawer.getByRole("button", { name: "Close workspace list", exact: true });
  assert.equal(await namedClose.count(), 1, "the drawer holds a named close for a screen reader");
  assert.deepEqual(await drawer.locator(".sidebar-footer > *").evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length > 0).map((node) => node.className)),
    ["sidebar-footer-row"], "the drawer's foot is the gear's row alone");
  const ringless = () => page.evaluate(() => document.activeElement?.id === "workspace-drawer" && document.querySelector(":focus-visible:not(#workspace-drawer)") === null);
  assert.equal(await ringless(), true, "the opened drawer holds the focus itself, with no control's ring");
  assert.equal(await page.locator(".pane-column").getAttribute("inert"), "", "the pane behind the drawer is inert");
  const drawerButtons = drawer.locator("button:visible");
  assert.ok(await drawerButtons.count() > 0, "the drawer has focusable controls");
  await drawerButtons.last().focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => {
    const active = document.activeElement;
    return active !== null && (active.matches(".drawer-toggle") || active.closest("#workspace-drawer") !== null);
  }), true, "Tab stays within the drawer and the header's toggle");
  const closed = async (): Promise<void> => {
    await page.locator("#workspace-drawer:not(.is-open)").waitFor({ state: "attached" });
    await page.waitForFunction((key) => history.state?.[key] === undefined, SHEET_HISTORY_KEY, { timeout: 5_000 });
  };
  await page.keyboard.press("Escape");
  await closed();
  await page.getByRole("button", { name: "Open workspace list", exact: true }).waitFor();
  assert.equal(await drawer.getAttribute("aria-modal"), null, "a closed drawer is not modal");
  const openByTap = async (): Promise<void> => {
    await page.getByRole("button", { name: "Open workspace list", exact: true }).tap();
    await page.locator("#workspace-drawer.is-open").waitFor();
    await page.waitForFunction((key) => typeof (history.state as Record<string, unknown> | null)?.[key] === "string", SHEET_HISTORY_KEY, { timeout: 5_000 });
  };
  await openByTap();
  await page.touchscreen.tap(380, 420);
  await closed();
  const here = page.url();
  await openByTap();
  await page.goBack();
  await closed();
  assert.equal(page.url(), here, "Back closes the drawer and stays on the pane");
  await openByTap();
  for (let step = 0; step < 3 && !await namedClose.evaluate((node) => node === document.activeElement); step++) await page.keyboard.press("Tab");
  assert.ok(((await namedClose.boundingBox())?.width ?? 0) > 1, "the named close is drawn while the keyboard is on it");
  await page.keyboard.press("Enter");
  await closed();
  await page.waitForFunction(() => document.activeElement?.id === "drawer-toggle", undefined, { timeout: 5_000 });
  const cdp = await context.newCDPSession(page);
  const swipe = async (from: number, to: number): Promise<void> => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from, y: 420 }] });
    for (let step = 1; step <= 12; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from + ((to - from) * step) / 12, y: 420 }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await swipe(6, 300);
  await page.locator("#workspace-drawer.is-open[aria-modal='true']").waitFor();
  assert.equal(await ringless(), true, "a drawer swiped open shows no control's focus ring");
  await swipe(300, 10);
  await closed();
  assert.equal(await drawer.getAttribute("aria-modal"), null, "a drawer swiped closed is not modal");
  assert.equal(await drawer.getAttribute("aria-owns"), null, "a closed drawer owns nothing of the header");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#workspace-drawer:not([role])").waitFor();
  assert.equal(await drawer.getAttribute("aria-modal"), null, "the desktop sidebar is not modal");
  await context.close();
  console.log("PASS phone drawer is a modal focus-trapped surface, headed by the Ovis mark, closed by a tap outside, a swipe, Back, Escape and its named close");

  {
    const guarded = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await guarded.newPage();
    await openPane(page);
    await page.evaluate((limit) => {
      window.toggleClicks = [];
      const first = 1_000;
      document.addEventListener("click", (event) => {
        if (!(event.target instanceof Element) || !event.target.closest("#drawer-toggle")) return;
        // Keep the taps real; fix the timestamps seen by the guard independently of browser load.
        const at = first + ([0, limit - 1, limit][window.toggleClicks.length] ?? limit);
        Object.defineProperty(event, "timeStamp", { value: at });
        window.toggleClicks.push(at);
      }, true);
    }, SECOND_TAP_MS);
    const toggle = page.locator(".app-header #drawer-toggle");
    await toggle.tap();
    await page.locator("#workspace-drawer.is-open").waitFor();
    await toggle.tap();
    await page.waitForFunction(() => window.toggleClicks.length === 2);
    const [opened, second] = await page.evaluate(() => window.toggleClicks) as [number, number];
    // the click's own handlers ran in its dispatch; the render a way in would cause is drawn by the next frame
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    assert.ok(second - opened < SECOND_TAP_MS, `the two taps landed ${Math.round(second - opened)} ms apart, not a double tap: the guard was not exercised`);
    assert.equal(await page.locator(".mode-inbox").count(), 0, `the second tap of a double tap (${Math.round(second - opened)} ms apart) on the mark's spot is not a way into the inbox`);
    assert.equal(await page.locator("#workspace-drawer.is-open").count(), 1, "and the drawer stays open");
    await toggle.tap();
    await page.locator(".mode-inbox").waitFor();
    assert.equal(new URL(page.url()).searchParams.get("app"), "inbox", "a tap on the mark past the double tap opens the agent inbox");
    await guarded.close();
    console.log(`PASS a double tap on the menu button (${Math.round(second - opened)} ms apart) opens the drawer and not the inbox; the mark opens it after ${SECOND_TAP_MS} ms`);
  }

  {
    const app = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await app.addInitScript(() => {
      window.nativeCalls = [];
      (window as unknown as { Capacitor: unknown }).Capacitor = {
        isNativePlatform: () => true, getPlatform: () => "ios",
        nativePromise: async (plugin: string, method: string) => { window.nativeCalls.push(`${plugin}.${method}`); return {}; },
      };
    });
    const page = await app.newPage();
    await openPane(page);
    await page.getByRole("button", { name: "Open workspace list", exact: true }).tap();
    await page.locator("#workspace-drawer.is-open").waitFor();
    assert.equal(await page.locator("#workspace-drawer .sidebar-footer-pc").count(), 0, "a phone's drawer has no Change PC row");
    await page.locator("#workspace-drawer .sidebar-footer-settings").tap();
    const change = page.locator(".settings-dialog .settings-change-pc");
    await change.waitFor();
    assert.equal((await change.textContent())?.trim(), "Change PC");
    await change.tap();
    await page.waitForFunction(() => window.nativeCalls.includes("HerdrShell.disconnect"), undefined, { timeout: 5_000 });
    const tablet = await app.newPage();
    await tablet.setViewportSize({ width: 700, height: 1000 });
    await openPane(tablet);
    await tablet.getByRole("button", { name: "Open workspace list", exact: true }).tap();
    await tablet.locator("#workspace-drawer.is-open").waitFor();
    assert.equal(await tablet.locator("#workspace-drawer .sidebar-footer-pc").count(), 0, "at 700px the drawer has no Change PC row");
    await tablet.locator("#workspace-drawer .sidebar-footer-settings").tap();
    await tablet.locator(".settings-dialog .settings-change-pc").waitFor();
    const wide = await app.newPage();
    await wide.setViewportSize({ width: 1440, height: 900 });
    await openPane(wide);
    await wide.locator("#workspace-drawer .sidebar-footer-pc").waitFor();
    await app.close();
    console.log("PASS in the phone app the drawer's foot is the gear alone, and the gear's Settings list ends in Change PC, which goes back to the app's list, at 390 and at 700; a wide window keeps its Change PC row");
  }
} finally {
  await browser.close();
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
