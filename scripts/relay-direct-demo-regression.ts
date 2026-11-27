import assert from "node:assert/strict";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { appContext } from "./app-context.ts";
import { withDemoBrowser } from "./demo-browser.ts";
import { openSettingsFolds, openSettingsPage } from "./settings-page.ts";

async function run(browser: Browser, origin: string, width: number, theme: "light" | "dark", evidence: string | null): Promise<void> {
  const phone = width === 390;
  const tag = `${width} ${theme}`;
  const context = await appContext(browser, { viewport: { width, height: phone ? 844 : 900 }, ...(phone ? { deviceScaleFactor: 3, isMobile: true, hasTouch: true } : {}) });
  await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ language: "en", theme }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}?demo_relay=on`);
  await page.locator(".conn-live").waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Devices and PCs");
  await openSettingsFolds(page);
  const group = page.locator('[data-section="devices-more"]');
  const row = group.locator(".settings-row", { has: page.getByRole("switch", { name: "Direct connection" }) });
  const toggle = row.getByRole("switch", { name: "Direct connection" });
  await row.getByText("Direct connection", { exact: true }).waitFor();
  await row.getByText("Relay connections stay on the relay.", { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "false", `${tag}: off by default`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${tag}: no sideways scroll`);
  await row.scrollIntoViewIfNeeded();
  if (evidence) await group.screenshot({ path: join(evidence, `relay-direct-${width}-${theme}.png`) });

  await toggle.click();
  await row.getByText("The Ovis app on a phone that reaches this PC on the same Wi-Fi or over Tailscale moves to a direct connection: faster, and this PC listens for it on those addresses.", { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "true", `${tag}: turned on`);
  await row.getByText("Direct connection", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${tag}: no sideways scroll, on`);
  if (evidence) await group.screenshot({ path: join(evidence, `relay-direct-on-${width}-${theme}.png`) });
  await toggle.click();
  await row.getByText("Relay connections stay on the relay.", { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "false", `${tag}: turned off again`);
  assert.deepEqual(errors, [], `${tag}: no page errors`);
  await context.close();
  console.log(`PASS relay direct ${tag}`);
}

async function notices(browser: Browser, origin: string): Promise<void> {
  for (const [fixture, kind] of [["grace", "sign-in-grace"], ["data-limit", "data-limit"]] as const) {
    const context = await appContext(browser, { viewport: { width: 1280, height: 900 } });
    await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ language: "en" }));
    const page = await context.newPage();
    await page.goto(`${origin}?demo_relay_pass=${fixture}`);
    await page.locator(`[data-testid="relay-notice"][data-relay-notice="${kind}"]`).waitFor({ timeout: 15_000 });
    await context.close();
    console.log(`PASS relay notice ${fixture}`);
  }
}

await withDemoBrowser({ tempPrefix: "ovis-relay-direct-demo-" }, async ({ browser, baseUrl, evidence }) => {
  for (const [width, theme] of [[390, "light"], [390, "dark"], [1280, "light"], [1280, "dark"]] as const) await run(browser, baseUrl, width, theme, evidence);
  await notices(browser, baseUrl);
});
