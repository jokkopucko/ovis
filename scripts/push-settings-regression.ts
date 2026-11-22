/** Browser UI with a stand-in push service: never sends a notification to a real device. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { alertsState, runMoreItem } from "./header-more.ts";
import { openSettingsPage } from "./settings-page.ts";

export async function checkPushSettings(browser: Browser, origin: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["notifications"] });
  const endpoint = "https://push.example/settings-test";
  let status = 204;
  let release: (() => void) | undefined;
  let hold: Promise<void> | undefined;
  const tests: string[] = [];
  let registrations = 0;
  let health = { registered: true, last_success_at: null as string | null, last_failure_at: null as string | null, last_failure: null as string | null };
  try {
    await context.addInitScript((endpoint) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      let subscription: object | null = null;
      const pushManager = {
        getSubscription: async () => subscription,
        subscribe: async (options: { applicationServerKey: Uint8Array }) => {
          subscription = {
            endpoint,
            options: { applicationServerKey: options.applicationServerKey.buffer },
            unsubscribe: async () => { subscription = null; return true; },
            toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
          };
          return subscription;
        },
      };
      Object.defineProperty(navigator.serviceWorker, "ready", { value: Promise.resolve({ pushManager }) });
      Object.defineProperty(navigator.serviceWorker, "getRegistration", { value: async () => ({ pushManager }) });
    }, endpoint);
    await context.route("**/api/push", (route) => route.fulfill({ json: { public_key: Buffer.alloc(65, 4).toString("base64url") } }));
    await context.route("**/api/push/subscribe", (route) => {
      registrations++;
      return route.fulfill({ status: 204 });
    });
    await context.route("**/api/push/test", async (route) => {
      tests.push(route.request().postDataJSON().endpoint);
      await hold;
      await route.fulfill(status === 204 ? { status } : { status, json: { error: { code: status === 404 ? "subscription_not_found" : "push_failed", message: "Test failure" } } });
    });
    await context.route("**/api/push/status", (route) => route.fulfill({ json: health }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await page.locator(".conn-live").waitFor();
    for (const deadline = Date.now() + 15_000; (await alertsState(page)) !== "On, pushed to this device";) {
      assert.ok(Date.now() < deadline, "alerts are pushed to this device");
      await page.waitForTimeout(100);
    }
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Alerts");
    const send = page.getByRole("button", { name: "Send test", exact: true });
    hold = new Promise<void>((resolve) => { release = resolve; });
    await send.click();
    assert.equal(await page.getByRole("button", { name: "Sending…", exact: true }).isDisabled(), true);
    release!();
    hold = undefined;
    await page.getByText("Test notification sent. Check this device for the alert.", { exact: true }).waitFor();
    assert.deepEqual(tests, [endpoint]);
    assert.equal(registrations, 1, "Send test must not repair the registration first");
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.getByRole("heading", { name: "Alerts", exact: true }).evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "push-test-desktop.png") });
    }

    status = 404;
    await send.click();
    await page.getByText("This device's push subscription is missing. Turn alerts on again.", { exact: true }).waitFor();
    status = 204;
    await page.getByRole("button", { name: "Turn alerts on again", exact: true }).click();
    await page.getByText("Test notification sent. Check this device for the alert.", { exact: true }).waitFor();
    assert.equal(registrations, 2, "explicit recovery registers this device again");

    status = 502;
    await send.click();
    await page.getByText("Could not send the test notification. Try again.", { exact: true }).waitFor();
    assert.equal(await send.isEnabled(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    await send.scrollIntoViewIfNeeded();
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "push-test-mobile.png") });
    assert.equal(await page.locator(".settings-dialog").evaluate((el) => el.scrollWidth <= el.clientWidth), true);

    health = { registered: false, last_success_at: "2026-10-20T08:12:00.000Z", last_failure_at: "2026-10-21T07:41:00.000Z", last_failure: "gone" };
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const notice = page.locator('[data-testid="push-health-notice"]');
    await notice.waitFor();
    assert.equal(await notice.getAttribute("data-problem"), "gone");
    assert.equal(await page.locator(".update-notice.is-alerts").count(), 1, "one notice, over the pane");
    await page.locator('[data-testid="push-health-hint"]').filter({ hasText: "The push service retired this device's subscription. Turn alerts on again to make a new one." }).waitFor();
    health = { registered: true, last_success_at: null, last_failure_at: null, last_failure: null };
    status = 204;
    const beforeRepair = registrations;
    await page.locator(".settings-dialog").getByRole("button", { name: "Turn alerts on again", exact: true }).click();
    await page.getByText("Test notification sent. Check this device for the alert.", { exact: true }).waitFor();
    await notice.waitFor({ state: "detached" });
    assert.equal(registrations, beforeRepair + 1, "the repair registers this device once");
    assert.equal(await page.locator(".update-notice.is-alerts").count(), 0);

    // A browser can lose its local subscription while the server still has the endpoint.
    await page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription())?.unsubscribe());
    const beforeMissing = tests.length;
    await send.click();
    await page.locator('[data-testid="push-health-hint"]').getByText("This device's push subscription is missing. Turn alerts on again.", { exact: true }).waitFor();
    assert.equal(tests.length, beforeMissing);
    await page.locator('[data-testid="push-health-notice"][data-problem="missing"]').waitFor();
    assert.equal(await page.locator(".update-notice.is-alerts").count(), 1);

    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await runMoreItem(page, "Alerts");
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Alerts");
    assert.equal(await send.isDisabled(), true, "testing must not turn alerts on implicitly");
    await page.getByRole("button", { name: "Turn alerts on again", exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log("PASS Settings push test: sent, stale/local missing subscription, recovery, failure, retired notice shared with Settings and cleared by its repair, off, mobile layout");
  } finally {
    release?.();
    await context.close();
  }
}
