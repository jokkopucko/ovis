import assert from "node:assert/strict";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { appContext } from "./app-context.ts";
import { withDemoBrowser } from "./demo-browser.ts";
import { openSettingsPage } from "./settings-page.ts";

const EVIDENCE = process.env.UI_EVIDENCE_DIR;

async function run(browser: Browser, origin: string, width: number, theme: "light" | "dark"): Promise<void> {
  const phone = width === 390;
  const tag = `${width} ${theme}`;
  const context = await appContext(browser, { viewport: { width, height: phone ? 844 : 900 }, ...(phone ? { deviceScaleFactor: 3, isMobile: true, hasTouch: true } : {}) });
  await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ language: "en", theme, agentLocks: true }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}?pane=${encodeURIComponent(panes.api)}`);
  await page.locator(".conn-live").waitFor();
  const openList = async (): Promise<void> => {
    if (!phone) return;
    await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
    const toggle = page.locator(".agent-section-toggle");
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  };
  await openList();
  const row = page.locator(`.agents-sidebar .agent-item[data-pane="${panes.api}"]`);
  const item = (name: string) => page.getByRole(phone ? "button" : "menuitem", { name, exact: true });
  const menu = async (): Promise<void> => { await (phone ? row.locator(".row-menu-toggle").click() : row.locator(".agent-select").click({ button: "right" })); };
  const dismiss = async (): Promise<void> => {
    if (phone) { await page.locator(".row-sheet-cancel").click(); await page.locator(".row-sheet").waitFor({ state: "detached" }); }
    else await page.keyboard.press("Escape");
  };

  await menu();
  await item("Pin agent").waitFor();
  assert.equal(await item("Lock agent").count(), 0, `${tag}: an unpinned row offers no lock`);
  await item("Pin agent").click();
  await menu();
  await item("Lock agent").click();
  await row.locator('[data-testid="agent-locked"]').waitFor({ state: "attached" });
  if (!phone) await row.hover();
  await row.locator('[data-testid="agent-locked"]').waitFor({ state: "visible" });
  await menu();
  await item("Unlock agent").waitFor();
  assert.equal(await item("Unpin agent").count(), 0, `${tag}: a locked row keeps its pin`);
  if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `agent-lock-${width}-${theme}.png`) });
  await dismiss();

  if (!phone) {
    const tab = page.locator('[role="tab"][aria-selected="true"]');
    await tab.click({ button: "right" });
    await item("New tab with agent…").waitFor();
    assert.equal(await item("Close tab").count(), 0, `${tag}: the locked agent's tab offers no Close tab`);
    await page.keyboard.press("Escape");
  }

  await menu();
  await item("Unlock agent").click();
  await menu();
  await item("Unpin agent").waitFor();
  assert.equal(await row.locator('[data-testid="agent-locked"]').count(), 0, `${tag}: unlocked, the lock goes`);
  await dismiss();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${tag}: no sideways scroll`);

  if (phone) await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Experimental");
  const toggle = page.locator(".settings-dialog").getByRole("switch", { name: "Lock pinned agents", exact: true });
  assert.equal(await toggle.getAttribute("aria-checked"), "true", `${tag}: the setting reads on`);
  const settingRow = toggle.locator("xpath=ancestor::*[contains(@class, 'settings-row')][1]");
  await settingRow.scrollIntoViewIfNeeded();
  if (EVIDENCE) await settingRow.screenshot({ path: join(EVIDENCE, `agent-lock-setting-${width}-${theme}.png`) });
  assert.deepEqual(errors, [], `${tag}: no page errors`);
  await context.close();
  console.log(`PASS agent lock ${tag}`);
}

await withDemoBrowser({ tempPrefix: "ovis-agent-lock-demo-", prefix: "/" }, async ({ browser, baseUrl }) => {
  for (const [width, theme] of [[390, "light"], [390, "dark"], [1280, "light"], [1280, "dark"]] as const) await run(browser, baseUrl, width, theme);
});
