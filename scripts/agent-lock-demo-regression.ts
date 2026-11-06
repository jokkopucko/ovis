/**
 * Lock agent on a pinned Agents row (#2432), on the unmodified app over the demo's fixture transport:
 * an unpinned row offers no lock; pinned, Lock agent hides Unpin agent and draws a lock on the row;
 * the open tab then offers no Close tab, and Unlock agent brings Unpin back. At 390 and 1280, light
 * and dark. No live session is read.
 *
 * The Agents list offers the lock only while Settings -> Experimental -> Lock pinned agents is on.
 *
 * UI_EVIDENCE_DIR: agent-lock-<390|1280>-<light|dark>.png (the row's menu while locked) and
 * agent-lock-setting-<390|1280>-<light|dark>.png (the setting's row).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";

const EVIDENCE = process.env.UI_EVIDENCE_DIR;

async function run(browser: Browser, origin: string, width: number, theme: "light" | "dark"): Promise<void> {
  const phone = width === 390;
  const tag = `${width} ${theme}`;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, ...(phone ? { deviceScaleFactor: 3, isMobile: true, hasTouch: true } : {}), locale: "en-US" });
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
  // a phone's row has its ⋯; a desktop's opens the same menu by a right-click
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
  await row.locator('[data-testid="agent-locked"]').waitFor();
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

async function main(): Promise<void> {
  const app = mkdtempSync(join(tmpdir(), "ovis-agent-lock-demo-"));
  try {
    await buildDemoApp(app);
    const index = join(app, "index.html");
    writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      let file: string;
      try { file = decodeURIComponent(new URL(request.url).pathname.slice(1)); } catch { return new Response("bad path", { status: 400 }); }
      if (!file || file.endsWith("/")) file += "index.html";
      if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
      const body = Bun.file(join(app, file));
      return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
    } });
    try {
      if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
      const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
      try {
        for (const [width, theme] of [[390, "light"], [390, "dark"], [1280, "light"], [1280, "dark"]] as const) await run(browser, `http://127.0.0.1:${server.port}/`, width, theme);
      } finally { await browser.close(); }
    } finally { await server.stop(true); }
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
}

await main();
