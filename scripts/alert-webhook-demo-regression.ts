/**
 * Settings → Alerts → Also send to on the unmodified app over the demo's fixture transport: a Discord
 * webhook saved, its URL gone from the field and shown only masked, a test sent, Telegram asking for a
 * chat id too, and Off removing the destination; at 390 and 1280, light and dark. Nothing is posted
 * anywhere: the demo keeps the destination in the page.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { appContext } from "./app-context.ts";
import { withDemoBrowser } from "./demo-browser.ts";
import { openSettingsPage } from "./settings-page.ts";

const EVIDENCE = process.env.UI_EVIDENCE_DIR;
const SECRET = "https://discord.com/api/webhooks/1/demo-secret-abcd";

async function run(browser: Browser, origin: string, width: number, theme: "light" | "dark"): Promise<void> {
  const phone = width === 390;
  const tag = `${width} ${theme}`;
  const context = await appContext(browser, { viewport: { width, height: phone ? 844 : 900 }, ...(phone ? { deviceScaleFactor: 3, isMobile: true, hasTouch: true } : {}) });
  await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ language: "en", theme }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await page.locator(".conn-live").waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Alerts");
  const group = page.locator('[data-section="alert-webhook"]');
  await group.waitFor();
  const destination = group.getByLabel("Also send to");
  assert.equal(await destination.inputValue(), "off", `${tag}: off until chosen`);
  assert.equal(await group.getByLabel("Webhook URL").count(), 0, `${tag}: no field while off`);

  await destination.selectOption("telegram");
  await group.getByLabel("Chat id").waitFor();
  assert.equal(await group.getByLabel("Bot token").getAttribute("type"), "password", `${tag}: the token is typed hidden`);

  await destination.selectOption("discord");
  const url = group.getByLabel("Webhook URL");
  await url.fill(SECRET);
  await group.getByRole("button", { name: "Save", exact: true }).click();
  await group.getByRole("status").filter({ hasText: "Saved" }).waitFor();
  assert.equal(await url.inputValue(), "", `${tag}: the URL leaves the field once saved`);
  assert.equal(await url.getAttribute("placeholder"), "discord.com/…", `${tag}: shown masked`);
  assert.equal((await group.innerText()).includes("demo-secret"), false, `${tag}: the secret is nowhere on the page`);
  // saved from this PC's localhost: the form says messages carry no link a phone opens yet
  await group.getByText("Messages have no link a phone can open yet.", { exact: false }).waitFor();

  await group.getByRole("button", { name: "Send a test", exact: true }).click();
  await group.getByRole("status").filter({ hasText: "Test sent. Check the destination." }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${tag}: no sideways scroll`);
  if (phone) assert.ok(((await group.getByRole("button", { name: "Save", exact: true }).boundingBox())?.height ?? 0) >= 44, `${tag}: Save is finger-sized`);
  await group.scrollIntoViewIfNeeded();
  if (EVIDENCE) await group.screenshot({ path: join(EVIDENCE, `alert-webhook-${width}-${theme}.png`) });

  await destination.selectOption("off");
  await group.getByRole("status").filter({ hasText: "Removed" }).waitFor();
  assert.equal(await group.getByLabel("Webhook URL").count(), 0, `${tag}: Off removes it`);
  assert.deepEqual(errors, [], `${tag}: no page errors`);
  await context.close();
  console.log(`PASS alert webhook ${tag}`);
}

await withDemoBrowser({ tempPrefix: "ovis-alert-webhook-demo-" }, async ({ browser, baseUrl: origin }) => {
  for (const [width, theme] of [[390, "light"], [390, "dark"], [1280, "light"], [1280, "dark"]] as const) await run(browser, origin, width, theme);
});
