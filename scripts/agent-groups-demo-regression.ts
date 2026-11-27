import assert from "node:assert/strict";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { appContext } from "./app-context.ts";
import { withDemoBrowser } from "./demo-browser.ts";
import { openSettingsPage } from "./settings-page.ts";

async function run(browser: Browser, origin: string, width: number, theme: "light" | "dark", evidence: string | null): Promise<void> {
  const phone = width === 390;
  const tag = `${width} ${theme}`;
  const context = await appContext(browser, { viewport: { width, height: phone ? 844 : 900 }, ...(phone ? { deviceScaleFactor: 3, isMobile: true, hasTouch: true } : {}), colorScheme: theme });
  await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ language: "en", theme, agentNamedGroups: true, agentGroupNames: ["Agents", "Tasks"] }));
  // the Claude pane's row is the one moved: its turn stays at work, or on a slow runner the end the
  // demo times 4.5s in changes the row while its menu is open
  await context.addInitScript(() => Reflect.set(window, "__ovisDemoHoldTurn", true));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}?pane=${encodeURIComponent(panes.api)}`);
  await page.locator(".conn-live").waitFor();
  if (phone) {
    await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
    const toggle = page.locator(".agent-section-toggle");
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  }
  const row = page.locator(`.agents-sidebar .agent-item[data-pane="${panes.api}"]`);
  const item = (name: string) => page.getByRole(phone ? "button" : "menuitem", { name, exact: true });
  const menu = async (): Promise<void> => { await (phone ? row.locator(".row-menu-toggle").click() : row.locator(".agent-select").click({ button: "right" })); };
  const heading = page.locator('.agents-sidebar [data-named-group="Tasks"] button');

  assert.equal(await page.locator(".agent-named-group-label").count(), 0, `${tag}: no heading while nothing is grouped`);
  await menu();
  await item("Move to Tasks").click();
  await heading.waitFor();
  assert.equal(await heading.locator(".agent-section-count").textContent(), "1", `${tag}: the group counts its row`);
  await page.locator('.agents-sidebar [data-named-group=""]').waitFor();
  assert.equal(await row.isVisible(), true, `${tag}: the grouped row shows`);
  if (evidence) await page.screenshot({ path: join(evidence, `agent-groups-${width}-${theme}.png`) });
  await heading.click();
  await row.waitFor({ state: "hidden" });
  await heading.click();
  await row.waitFor({ state: "visible" });
  await menu();
  await item("Remove from Tasks").click();
  await page.locator(".agent-named-group-label").first().waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${tag}: no sideways scroll`);

  await page.goto(`${origin}?pane=${encodeURIComponent(panes.api)}&new=workspace`);
  const dialog = page.getByRole("dialog", { name: /^New workspace · / });
  await dialog.waitFor();
  const field = dialog.getByLabel("Group", { exact: true });
  assert.deepEqual(await field.locator("option").allTextContents(), ["No group", "Agents", "Tasks"], `${tag}: New workspace offers the groups`);
  await field.scrollIntoViewIfNeeded();
  if (evidence) await page.screenshot({ path: join(evidence, `agent-groups-dialog-${width}-${theme}.png`) });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });

  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Experimental");
  const toggle = page.locator(".settings-dialog").getByRole("switch", { name: "Named agent groups", exact: true });
  assert.equal(await toggle.getAttribute("aria-checked"), "true", `${tag}: the setting reads on`);
  const settingRow = toggle.locator("xpath=ancestor::*[contains(@class, 'settings-row')][1]");
  await settingRow.scrollIntoViewIfNeeded();
  if (evidence) await page.locator(".settings-dialog").screenshot({ path: join(evidence, `agent-groups-setting-${width}-${theme}.png`) });
  assert.deepEqual(errors, [], `${tag}: no page errors`);
  await context.close();
  console.log(`PASS agent groups ${tag}`);
}

await withDemoBrowser({ tempPrefix: "ovis-agent-groups-demo-", prefix: "/" }, async ({ browser, baseUrl, evidence }) => {
  for (const [width, theme] of [[390, "light"], [390, "dark"], [1280, "light"], [1280, "dark"]] as const) await run(browser, baseUrl, width, theme, evidence);
});
