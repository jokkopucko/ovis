import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { openSettingsPage } from "./settings-page.ts";
import { rosterRead, rosterStream } from "./drained-route.ts";

async function openMoreSettings(page: Page): Promise<void> {
  const more = page.locator('.settings-body:not([hidden]) .settings-fold[data-fold="more"]');
  if (await more.getAttribute("open") === null) await more.locator(":scope > summary").click();
}

export async function checkWakeLock(browser: Browser, origin: string, paneId: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    await context.route("**/api/access", (route) => route.fulfill({ json: {
      port: 7317,
      tailscale: { state: "running", dns_name: "demo.example.ts.net", serving_url: null, serve_command: "tailscale serve -bg --https=7317 http://127.0.0.1:7317", serve_url: "https://demo.example.ts.net:7317" },
    } }));
    await context.addInitScript(() => {
      const stats = { requests: 0, releases: 0, refuse: false };
      Object.assign(window, { wakeLockStats: stats });
      Object.defineProperty(navigator, "wakeLock", { configurable: true, value: {
        request: async (type: string) => {
          if (type !== "screen") throw new Error("Only screen locks are allowed");
          stats.requests++;
          if (stats.refuse) throw new DOMException("Refused by browser", "NotAllowedError");
          return { release: async () => { stats.releases++; } };
        },
      } });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
    await page.locator(".conn-live").waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Devices and PCs");
    await openMoreSettings(page);
    const toggle = page.getByRole("switch", { name: "Keep screen on", exact: true });
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    assert.equal(await page.evaluate(() => (window as any).wakeLockStats.requests), 0);
    await toggle.click();
    await page.waitForFunction(() => (window as any).wakeLockStats.requests === 1);
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.getByRole("heading", { name: "This device", exact: true }).evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "keep-screen-on-mobile.png") });
    }

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(() => (window as any).wakeLockStats.releases === 1);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(() => (window as any).wakeLockStats.requests === 2);
    await toggle.click();
    await page.waitForFunction(() => (window as any).wakeLockStats.releases === 2);

    await toggle.click();
    await page.waitForFunction(() => (window as any).wakeLockStats.requests === 3);
    await page.reload();
    await page.waitForFunction(() => (window as any).wakeLockStats.requests === 1);
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Devices and PCs");
    await openMoreSettings(page);
    assert.equal(await toggle.getAttribute("aria-checked"), "true", "setting survives a reload");
    await toggle.click();
    await page.waitForFunction(() => (window as any).wakeLockStats.releases === 1);
    await page.evaluate(() => { (window as any).wakeLockStats.refuse = true; });
    await toggle.click();
    await page.waitForFunction(() => (window as any).wakeLockStats.requests === 2);
    await toggle.click();
    await page.evaluate(() => { Object.defineProperty(navigator, "wakeLock", { value: undefined }); });
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-checked"), "true", "unsupported browsers keep the preference without failing");

    await context.route(rosterStream, (route) => route.abort());
    // The app prefers roster events on the WebSocket. An unfiltered event can
    // repopulate the HTTP fixture before the wake lock effect runs.
    await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
      const upstream = socket.connectToServer();
      upstream.onMessage((data) => {
        if (JSON.parse(String(data)).type !== "machine-event") socket.send(data);
      });
    });
    await context.route(rosterRead, async (route) => {
      // full rows: a compact roster's agent_refs would name the panes emptied below
      const response = await route.fetch({ url: `${origin}/api/machines` });
      const body = await response.json();
      for (const machine of body.machines) {
        if (machine.snapshot) machine.snapshot = { ...machine.snapshot, panes: [], workspaces: [], focused_pane_id: null };
      }
      await route.fulfill({ json: body });
    });
    await Promise.all([
      page.waitForResponse((response) => rosterRead(new URL(response.url())) && response.ok()),
      page.reload(),
    ]);
    await page.locator(".pane-split").waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Devices and PCs");
    await openMoreSettings(page);
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    assert.equal(await page.locator(".pane-frame[data-layout-pane]").count(), 0, "the fixture has no panes");
    assert.equal(await page.evaluate(() => (window as any).wakeLockStats.requests), 0, "no pane, no screen lock");
    assert.deepEqual(errors, []);
    console.log("PASS screen wake lock: opt-in, hide/return, off, persistence, refusal, unsupported, no pane");
  } finally {
    await context.close();
  }
}
