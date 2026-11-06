/**
 * A page this PC serves, opened from the command palette by its address (#2363), on the unmodified
 * app over the demo's fixture transport: with Settings -> Web links on In the app, Open a page on
 * this PC… starts the query as `localhost:`, the typed port leads the list, and Enter shows the
 * page beside the pane (a popup on a phone, which Back closes and the palette's own closing does
 * not). With the setting left on In a new tab, the palette offers neither row. At 390 and 1280,
 * light and dark. A throwaway page on another loopback port stands in for a local tool's web UI.
 * No live session is read.
 *
 * UI_EVIDENCE_DIR: local-page-palette-<390|1280>-<light|dark>.png (the typed address) and
 * local-page-panel-<...>.png (the page shown).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const EVIDENCE = process.env.UI_EVIDENCE_DIR;

const TOOL_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Git graph</title>
<style>body{font:14px system-ui,sans-serif;margin:0;padding:16px;background:#fff;color:#1f2328}li{padding:6px 0;border-bottom:1px solid #d0d7de;list-style:none}code{color:#0969da}</style></head>
<body><h1>Git graph</h1><ul><li><code>5b51cbe</code> fix(chat): a search pick opens one of two answers</li><li><code>3a0c1d2</code> feat: tabs keep their order</li><li><code>9e8f7a6</code> docs: development notes</li></ul></body></html>`;

async function run(browser: Browser, origin: string, port: number, width: number, theme: "light" | "dark"): Promise<void> {
  const phone = width === 390;
  const tag = `${width} ${theme}`;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, ...(phone ? { deviceScaleFactor: 3, isMobile: true, hasTouch: true } : {}), locale: "en-US", colorScheme: theme });
  await context.addInitScript((settings) => {
    localStorage.setItem("ovis:settings", settings);
  }, JSON.stringify({ language: "en", theme, webLinks: "panel", fileOpen: "panel" }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}?pane=${encodeURIComponent(panes.api)}`);
  await page.locator(".conn-live").waitFor();
  const before = page.url();

  await page.keyboard.press("ControlOrMeta+Shift+K");
  const search = page.getByRole("dialog", { name: "Command palette" }).getByRole("searchbox", { name: "Search panes and actions", exact: true });
  await search.waitFor();
  await search.fill(">open a page");
  await page.getByRole("option", { name: "Open a page on this PC…", exact: true }).click();
  assert.equal(await search.inputValue(), "localhost:", `${tag}: the row starts the address and keeps the palette open`);
  await search.pressSequentially(`${port}/#/graph`);
  const row = page.getByRole("option", { name: `Open localhost:${port}/#/graph`, exact: true });
  await row.waitFor();
  assert.equal(await page.getByRole("option").first().textContent(), `Open localhost:${port}/#/graph`, `${tag}: the address leads the list`);
  if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `local-page-palette-${width}-${theme}.png`) });
  await search.press("Enter");

  // the page is reached under the app's own host, as a clicked link's is (lib/webPanel.ts panelUrl)
  const pageUrl = `http://127.0.0.1:${port}/#/graph`;
  const frame = page.frameLocator(".web-panel-page");
  await frame.getByRole("heading", { name: "Git graph" }).waitFor();
  await page.getByRole("dialog", { name: "Command palette" }).waitFor({ state: "detached" });
  assert.equal(await page.locator(".web-panel-page").getAttribute("src"), pageUrl, `${tag}: the panel frames the typed page`);
  if (phone) {
    // the palette's sheet left its history entry on closing: the popup holds the entry now, and stays
    await page.waitForFunction(() => window.history.state?.["ovis:web-panel"] !== undefined);
    await page.getByRole("dialog", { name: `127.0.0.1:${port}`, exact: true }).waitFor();
  } else {
    assert.equal(await page.getByRole("dialog").count(), 0, `${tag}: a wide window docks the page beside the pane`);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${tag}: no sideways scroll`);
  if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `local-page-panel-${width}-${theme}.png`) });
  if (phone) {
    // a second page from the palette over the popup: the palette's entry becomes the new page's, and
    // its closing does not step back onto the first page's entry
    await page.keyboard.press("ControlOrMeta+Shift+K");
    await search.fill(`localhost:${port}/second`);
    await search.press("Enter");
    await page.getByRole("dialog", { name: "Command palette" }).waitFor({ state: "detached" });
    await page.waitForFunction(() => window.history.state?.["ovis:web-panel"]?.url?.endsWith("/second") === true && window.history.state?.["ovis:sheet"] === undefined);
    assert.equal(await page.locator(".web-panel-page").getAttribute("src"), `http://127.0.0.1:${port}/second`, `${tag}: the second page replaces the first in the popup`);
    await page.goBack();
    await page.waitForFunction((first) => document.querySelector(".web-panel-page")?.getAttribute("src") === first, pageUrl);
    await page.goBack();
    await page.locator(".web-panel-popup").waitFor({ state: "detached" });
    assert.equal(page.url(), before, `${tag}: Back goes through the pages and closes the popup in the app`);

    // Close page over two stacked pages leaves both of their entries: the first does not come back (#3054)
    for (const path of ["/#/graph", "/second"]) {
      await page.keyboard.press("ControlOrMeta+Shift+K");
      await search.fill(`localhost:${port}${path}`);
      await search.press("Enter");
      await page.getByRole("dialog", { name: "Command palette" }).waitFor({ state: "detached" });
      await page.waitForFunction((end) => window.history.state?.["ovis:web-panel"]?.url?.endsWith(end) === true && window.history.state?.["ovis:sheet"] === undefined, path);
    }
    await page.getByRole("button", { name: "Close page", exact: true }).click();
    await page.locator(".web-panel-popup").waitFor({ state: "detached" });
    await page.waitForFunction(() => window.history.state?.["ovis:web-panel"] === undefined);
    assert.equal(await page.locator(".web-panel-popup").count(), 0, `${tag}: Close page closes the popup over two pages`);
    assert.equal(page.url(), before, `${tag}: Close page goes back to the pane`);

    // the pane's own entry: a close that leaves an entry of the page's behind lands above it
    const paneEntry = await page.evaluate(() => (window as unknown as { navigation: { currentEntry: { index: number } } }).navigation.currentEntry.index);
    const closePage = async (what: string): Promise<void> => {
      await page.getByRole("button", { name: "Close page", exact: true }).click();
      await page.waitForFunction((index) => (window as unknown as { navigation: { currentEntry: { index: number } } }).navigation.currentEntry.index <= index, paneEntry, { timeout: 5_000 })
        .catch(() => assert.fail(`${tag}: ${what} goes back to the pane's entry`));
      await page.locator(".web-panel-popup").waitFor({ state: "detached" });
      assert.equal(page.url(), before, `${tag}: ${what} goes back to the pane`);
    };

    // a reload with the palette open over the page: the palette's entry, a copy of the page's, is
    // one more of the page's, and Close page goes back past it too (#3058)
    await page.keyboard.press("ControlOrMeta+Shift+K");
    await search.fill(`localhost:${port}/#/graph`);
    await search.press("Enter");
    await page.getByRole("dialog", { name: "Command palette" }).waitFor({ state: "detached" });
    await page.waitForFunction(() => window.history.state?.["ovis:web-panel"] !== undefined && window.history.state?.["ovis:sheet"] === undefined);
    await page.keyboard.press("ControlOrMeta+Shift+K");
    await search.waitFor();
    await page.waitForFunction(() => typeof window.history.state?.["ovis:sheet"] === "string");
    await page.reload();
    await page.locator(".conn-live").waitFor();
    await page.getByRole("dialog", { name: `127.0.0.1:${port}`, exact: true }).waitFor();
    await closePage("Close page after a reload under the palette");

    // a file docked over two stacked pages takes their entry over: closing it goes back past both (#3058)
    for (const path of ["/#/graph", "/second"]) {
      await page.keyboard.press("ControlOrMeta+Shift+K");
      await search.fill(`localhost:${port}${path}`);
      await search.press("Enter");
      await page.getByRole("dialog", { name: "Command palette" }).waitFor({ state: "detached" });
      await page.waitForFunction((end) => window.history.state?.["ovis:web-panel"]?.url?.endsWith(end) === true && window.history.state?.["ovis:sheet"] === undefined, path);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(() => window.history.state?.["ovis:web-panel-docked"] === true);
    await page.locator(".header-files-button").click();
    // the demo's folder lists nothing and serves no file: its Documents tab names README.md, served here
    // as Markdown so it stays docked (files-documents-demo-regression.ts serves its documents the same way)
    await page.evaluate(() => {
      const demoFetch = window.fetch;
      window.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
        const asked = url.searchParams.get("path") ?? "";
        const text = "# README\n\nDocked over the page.\n";
        if (asked.endsWith("/README.md") && url.pathname.endsWith("/fs/stat")) return Response.json({ path: asked, name: "README.md", kind: "text", mime: "text/markdown", size: text.length, modified: new Date().toISOString() });
        if (asked.endsWith("/README.md") && url.pathname.endsWith("/fs/file")) return new Response(text, { headers: { "content-type": "text/markdown" } });
        return demoFetch(input, init);
      };
    });
    await page.locator(".files-dialog-tabs").getByRole("button", { name: "Documents", exact: true }).click();
    await page.locator(".md-docs .md-docs-item", { hasText: "README.md" }).click();
    const viewer = page.locator("aside.file-panel .file-viewer-docked");
    await viewer.waitFor();
    await page.locator(".web-panel").waitFor({ state: "detached" });
    await viewer.getByRole("button", { name: "Close" }).click();
    await page.waitForFunction((index) => (window as unknown as { navigation: { currentEntry: { index: number } } }).navigation.currentEntry.index <= index, paneEntry, { timeout: 5_000 })
      .catch(() => assert.fail(`${tag}: closing a file docked over two pages goes back to the pane's entry`));
    await viewer.waitFor({ state: "detached" });
    assert.equal(await page.locator(".web-panel").count(), 0, `${tag}: no page comes back when the docked file closes`);
    assert.equal(page.url(), before, `${tag}: closing the docked file goes back to the pane`);

    // a page opened over a file docked over two stacked pages takes the file's entry over: Close page
    // goes back past both pages too (#3058)
    await page.setViewportSize({ width, height: 844 });
    for (const path of ["/#/graph", "/second"]) {
      await page.keyboard.press("ControlOrMeta+Shift+K");
      await search.fill(`localhost:${port}${path}`);
      await search.press("Enter");
      await page.getByRole("dialog", { name: "Command palette" }).waitFor({ state: "detached" });
      await page.waitForFunction((end) => window.history.state?.["ovis:web-panel"]?.url?.endsWith(end) === true && window.history.state?.["ovis:sheet"] === undefined, path);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(() => window.history.state?.["ovis:web-panel-docked"] === true);
    await page.locator(".header-files-button").click();
    await page.locator(".files-dialog-tabs").getByRole("button", { name: "Documents", exact: true }).click();
    await page.locator(".md-docs .md-docs-item", { hasText: "README.md" }).click();
    await viewer.waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+K");
    await search.fill(`localhost:${port}/second`);
    await search.press("Enter");
    await page.getByRole("dialog", { name: "Command palette" }).waitFor({ state: "detached" });
    await page.locator(".web-panel").waitFor();
    await viewer.waitFor({ state: "detached" });
    await closePage("Close page over a docked file over two pages");
    assert.equal(await page.locator(".web-panel").count(), 0, `${tag}: no page comes back when the page over the docked file closes`);
    await page.setViewportSize({ width, height: 844 });
  } else {
    await page.getByRole("button", { name: "Close page", exact: true }).click();
    await page.locator(".web-panel").waitFor({ state: "detached" });
  }
  assert.equal(await page.locator(".conn-live").count(), 1, `${tag}: the app stays connected`);

  // over Files (a dialog or sheet, not docked) the page would open under it: the palette offers none there
  await page.keyboard.press("ControlOrMeta+Shift+K");
  await search.fill(">browse files");
  await page.getByRole("option", { name: "Browse files", exact: true }).click();
  const files = page.locator(".files-dialog");
  await files.first().waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+K");
  await search.fill(`localhost:${port}`);
  await page.getByText("No matching panes or actions", { exact: true }).waitFor();
  assert.equal(await page.getByRole("option", { name: `Open localhost:${port}`, exact: true }).count(), 0, `${tag}: no page row over Files`);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Command palette" }).waitFor({ state: "detached" });
  await page.keyboard.press("Escape");
  await files.first().waitFor({ state: "detached" });

  // nor over Settings
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await page.locator(".settings-dialog").waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+K");
  await search.fill(`localhost:${port}`);
  await page.getByText("No matching panes or actions", { exact: true }).waitFor();
  assert.equal(await page.getByRole("option", { name: `Open localhost:${port}`, exact: true }).count(), 0, `${tag}: no page row over Settings`);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Command palette" }).waitFor({ state: "detached" });
  await page.keyboard.press("Escape");
  await page.locator(".settings-dialog").waitFor({ state: "detached" });

  // a status filter is about panes: it leaves the page out, as it does the actions
  await page.keyboard.press("ControlOrMeta+Shift+K");
  await search.fill(`localhost:${port}`);
  await page.getByRole("option", { name: `Open localhost:${port}`, exact: true }).waitFor();
  await page.locator('.palette-filter[data-status="idle"]').click();
  await page.locator('.palette-filter[data-status="idle"][aria-checked="true"]').waitFor();
  assert.equal(await page.getByRole("option", { name: `Open localhost:${port}`, exact: true }).count(), 0, `${tag}: no page row under a status filter`);
  // Open a page on this PC… starts the address with every pane again, so the typed port is offered
  await search.fill(">open a page");
  await page.getByRole("option", { name: "Open a page on this PC…", exact: true }).click();
  await page.locator('.palette-filter[data-status="all"][aria-checked="true"]').waitFor();
  await search.pressSequentially(String(port));
  await page.getByRole("option", { name: `Open localhost:${port}`, exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Command palette" }).waitFor({ state: "detached" });

  if (!phone) {
    // any other dialog over the pane, such as a workspace's Earlier sessions, leaves the page out too
    await page.locator(".workspace-select").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Earlier sessions…", exact: true }).click();
    const history = page.getByRole("dialog", { name: /^Earlier sessions/ });
    await history.waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+K");
    await search.fill(`localhost:${port}`);
    await page.getByText("No matching panes or actions", { exact: true }).waitFor();
    assert.equal(await page.getByRole("option", { name: `Open localhost:${port}`, exact: true }).count(), 0, `${tag}: no page row over Earlier sessions`);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Command palette" }).waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    await history.waitFor({ state: "detached" });
  }
  assert.deepEqual(errors, [], `${tag}: no page errors`);
  await context.close();
  console.log(`PASS local page from the palette ${tag}`);
}

/** Web links left on In a new tab, the default: the palette names no page. */
async function runDefault(browser: Browser, origin: string, port: number): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  const page = await context.newPage();
  await page.goto(`${origin}?pane=${encodeURIComponent(panes.api)}`);
  await page.locator(".conn-live").waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+K");
  const search = page.getByRole("dialog", { name: "Command palette" }).getByRole("searchbox", { name: "Search panes and actions", exact: true });
  await search.fill(">");
  await page.getByRole("option", { name: "Refresh", exact: true }).waitFor();
  assert.equal(await page.getByRole("option", { name: "Open a page on this PC…", exact: true }).count(), 0, "default: no row starts an address");
  await search.fill(`localhost:${port}`);
  await page.getByText("No matching panes or actions", { exact: true }).waitFor();
  assert.equal(await page.getByRole("option", { name: `Open localhost:${port}`, exact: true }).count(), 0, "default: a typed address opens nothing");
  await context.close();
  console.log("PASS local page from the palette: off while Web links open in a new tab");
}

async function main(): Promise<void> {
  const app = mkdtempSync(join(tmpdir(), "ovis-local-page-demo-"));
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
    const tool = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(TOOL_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }) });
    try {
      if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
      const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
      try {
        const origin = `http://127.0.0.1:${server.port}/`;
        for (const [width, theme] of [[390, "light"], [390, "dark"], [1280, "light"], [1280, "dark"]] as const) await run(browser, origin, tool.port, width, theme);
        await runDefault(browser, origin, tool.port);
      } finally { await browser.close(); }
    } finally {
      await server.stop(true);
      await tool.stop(true);
    }
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
}

await main();
