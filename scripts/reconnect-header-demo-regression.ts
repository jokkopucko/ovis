/**
 * A lost connection is said in words (src/lib/headerConnection.ts): Reconnecting… while it is lost,
 * Connected once it is back. On a phone (390, 412) in the header's title area, in the crumb's place,
 * then the crumb again: the word is whole and on the title's line, the header keeps its height, the title
 * stays and nothing in the line is animated. On a desktop (1280) in the status bar under the pane, whose
 * height and the header's stay put. On a tablet (800, touch) in the connection chip, its word drawn. Either way the draft typed before the loss is neither lost nor sent
 * by the return. The real client over owned demo fixtures; no live herdr session.
 * The demo's `?demo_connection=switch` loses and restores the connection when the page says so.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";

type LineFacts = { header: number; text: string; whole: boolean; onRow: boolean; inHeader: boolean; inView: boolean; title: boolean; still: boolean };
declare global { interface Window { herdrDemoLoseConnection(): void; herdrDemoRestoreConnection(): void; lineFacts(): LineFacts } }

const app = mkdtempSync(join(tmpdir(), "ovis-reconnect-header-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;
const DRAFT = "kept as a draft while away";
const MORE = ", and more typed offline";

/** The connection line's box against the title area: whole, inside it, on screen; and the title beside it
 *  whole, or as wide as the title area lets it be (not cut down to make room for the word). */
function measureLine(): LineFacts {
  {
    const header = document.querySelector<HTMLElement>(".app-header")!;
    const context = document.querySelector<HTMLElement>(".context")!;
    const line = document.querySelector<HTMLElement>(".context-connection")!;
    const title = document.querySelector<HTMLElement>(".context-title-text")!;
    const box = line.getBoundingClientRect();
    const row = context.getBoundingClientRect();
    const bar = header.getBoundingClientRect();
    const inBar = (rect: DOMRect) => rect.top >= bar.top - 1 && rect.bottom <= bar.bottom + 1;
    const style = getComputedStyle(line);
    return {
      header: header.getBoundingClientRect().height,
      text: line.innerText,
      whole: line.scrollWidth <= line.clientWidth + 1 && box.width > 0,
      onRow: box.top >= row.top - 1 && box.bottom <= row.bottom + 1 && box.left >= row.left - 1 && box.right <= row.right + 1,
      // the header's height is fixed: what counts is that the word and the title are drawn inside it
      inHeader: inBar(box) && inBar(title.getBoundingClientRect()),
      inView: box.right <= window.innerWidth,
      title: title.scrollWidth <= title.clientWidth + 1 || document.querySelector<HTMLElement>(".context-title")!.getBoundingClientRect().width >= row.width - 1,
      still: style.animationName === "none" && /^0s(, 0s)*$/.test(style.transitionDuration),
    };
  }
}

async function lineFacts(page: Page): Promise<LineFacts> {
  return page.evaluate(() => window.lineFacts());
}

/** Restores the connection and resolves with the line measured in the very mutation that draws Connected,
 *  so a slow run cannot miss its two seconds. */
async function restoreAndCatchConnected(page: Page): Promise<LineFacts> {
  return page.evaluate(() => new Promise<LineFacts>((resolve) => {
    const observer = new MutationObserver(() => {
      const line = document.querySelector(".context-connection");
      if (line?.classList.contains("is-connected")) { observer.disconnect(); resolve(window.lineFacts()); }
    });
    observer.observe(document.querySelector(".app-header")!, { subtree: true, childList: true, characterData: true, attributes: true });
    window.herdrDemoRestoreConnection();
    window.dispatchEvent(new Event("online"));
  }));
}

/** A tablet (a touch screen from 769px): the tabs are the header's row and no status bar is drawn, so
 *  the connection chip itself says reconnecting in words, and the draft waits. */
async function tabletChip(page: Page, width: number): Promise<void> {
  await page.locator(".app-header.has-tab-row").waitFor();
  assert.equal(await page.locator(".status-bar").count(), 0, `${width}: a touch screen draws no status bar`);
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill(DRAFT);
  await page.evaluate(() => window.herdrDemoLoseConnection());
  const word = page.locator(".app-header .conn-reconnecting .conn-text");
  await word.waitFor();
  await page.waitForFunction(() => document.querySelector(".app-header .conn-reconnecting .conn-text")?.textContent === "reconnecting");
  const box = await word.boundingBox();
  assert.ok(box !== null && box.width > 20 && box.height > 8, `${width}: the chip's word is drawn, not clipped away (${JSON.stringify(box)})`);
  if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `reconnect-header-${width}-reconnecting.png`) }); }
  await page.evaluate(() => { window.herdrDemoRestoreConnection(); window.dispatchEvent(new Event("online")); });
  await page.locator(".conn-live").waitFor({ state: "attached" });
  assert.equal(await composer.inputValue(), DRAFT, `${width}: the return sends nothing: the draft waits for the user`);
  console.log(`PASS ${width}: a tablet's chip says reconnecting in words, the draft kept`);
}

/** A desktop window: the status bar says the connection in words, its height and the header's unchanged,
 *  the draft kept and nothing sent; another pane on the same connected PC says nothing new. */
async function desktopStatusBar(page: Page, width: number): Promise<void> {
  const conn = page.locator(".status-bar .status-bar-conn");
  await conn.waitFor();
  await appFaces(page);
  assert.equal(await conn.getAttribute("data-state"), "live", `${width}: a page opening is not a reconnect`);
  assert.equal((await conn.innerText()).trim(), "Connected");
  const heights = () => page.evaluate(() => [".app-header", ".status-bar"].map((selector) => document.querySelector(selector)!.getBoundingClientRect().height));
  const before = await heights();
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill(DRAFT);
  await page.evaluate(() => window.herdrDemoLoseConnection());
  await page.locator(".status-bar-conn[data-state='reconnecting']").waitFor();
  assert.equal((await conn.innerText()).trim(), "Reconnecting…", `${width}: the status bar says it is reconnecting`);
  assert.deepEqual(await heights(), before, `${width}: the header and the status bar keep their heights`);
  assert.equal(await composer.inputValue(), DRAFT, `${width}: the draft stays while reconnecting`);
  await composer.press("End");
  await page.keyboard.insertText(MORE);
  if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `reconnect-header-${width}-reconnecting.png`) }); }
  await page.evaluate(() => { window.herdrDemoRestoreConnection(); window.dispatchEvent(new Event("online")); });
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.waitForFunction(() => document.querySelector(".status-bar-conn")?.getAttribute("data-state") !== "reconnecting");
  assert.equal((await conn.innerText()).trim(), "Connected", `${width}: back, the status bar says so`);
  assert.deepEqual(await heights(), before, `${width}: the heights still hold`);
  assert.equal(await composer.inputValue(), DRAFT + MORE, `${width}: the return sends nothing: the draft waits for the user`);
  assert.equal(await page.locator(".chat-turn-user", { hasText: DRAFT }).count(), 0, `${width}: and no message was sent`);
  // another pane on the same, connected PC: its terminal connecting is no reconnect either
  await page.locator(".status-bar-conn[data-state='live']").waitFor();
  await page.locator(".sidebar").getByText("Plan the config file", { exact: true }).click();
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  assert.equal(await conn.getAttribute("data-state"), "live", `${width}: a pane switch on a connected PC says nothing`);
  console.log(`PASS ${width}: Reconnecting… then Connected in the status bar, the draft kept`);
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => '<script src="./demo-transport.js"></script><script type="module"'));
  const prefix = "/herdr-web-ui/demo/app/";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
    try {
      for (const width of [390, 412, 800, 1280]) {
        const phone = width < 769;
        // 800: a touch screen wide enough for the header's tab row, with no status bar under the pane
        const tablet = width === 800;
        const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone || tablet, colorScheme: "dark", locale: "en-US" });
        try {
          await context.addInitScript(`window.lineFacts = ${measureLine.toString()};`);
          await context.addInitScript(() => {
            localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", darkTheme: "codex", defaultView: "chat", alertsOn: false }));
          });
          const page = await context.newPage();
          page.setDefaultTimeout(15000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}${prefix}?pane=${encodeURIComponent(panes.hermes)}&view=chat&demo_connection=switch`);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          if (tablet) { await tabletChip(page, width); assert.deepEqual(errors, []); continue; }
          if (!phone) { await desktopStatusBar(page, width); assert.deepEqual(errors, []); continue; }
          await page.locator(".context-title-text").waitFor();
          await appFaces(page);
          await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          assert.equal(await page.locator(".context-connection").count(), 0, `${width}: a page opening is not a reconnect`);
          // the crumb, not the session's line (.context-session) that shares its class
          const crumb = await page.locator(".context-sub:not(.context-session)").innerText();
          const height = await page.locator(".app-header").evaluate((node) => node.getBoundingClientRect().height);
          const composer = page.getByRole("textbox", { name: "Message", exact: true });
          await composer.fill(DRAFT);
          if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `reconnect-header-${width}-live.png`) }); }

          await page.evaluate(() => window.herdrDemoLoseConnection());
          await page.locator(".conn-reconnecting").waitFor({ state: "attached" });
          await page.locator(".context-connection.is-reconnecting").waitFor();
          const lost = await lineFacts(page);
          assert.equal(lost.text, "Reconnecting…", `${width}: the title area says it is reconnecting`);
          assert.ok(lost.whole && lost.onRow && lost.inView && lost.inHeader, `${width}: the word is whole, in the title area, inside the header, on screen (${JSON.stringify(lost)})`);
          assert.ok(lost.title, `${width}: the pane title keeps its room (${JSON.stringify(lost)})`);
          assert.equal(lost.header, height, `${width}: the header keeps its height`);
          assert.ok(lost.still, `${width}: the line is not animated`);
          assert.equal(await page.locator(".conn.conn-quiet").count(), 1, `${width}: the chip keeps only its dot while the title area says the word`);
          assert.equal(await composer.inputValue(), DRAFT, `${width}: the draft stays while reconnecting`);
          // typed while away too: it joins the draft, and the return does not send it
          await composer.press("End");
          await page.keyboard.insertText(MORE);
          assert.equal(await composer.inputValue(), DRAFT + MORE, `${width}: text typed while reconnecting joins the draft`);
          if (evidence) await page.screenshot({ path: join(evidence, `reconnect-header-${width}-reconnecting.png`) });

          const back = await restoreAndCatchConnected(page);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          assert.equal(back.text, "Connected", `${width}: back, the title area says so`);
          assert.ok(back.whole && back.onRow && back.inView && back.inHeader, `${width}: Connected is whole in the title area, inside the header (${JSON.stringify(back)})`);
          assert.equal(back.header, height, `${width}: the header still keeps its height`);
          assert.ok(back.title, `${width}: and the title its room (${JSON.stringify(back)})`);
          if (evidence) await page.screenshot({ path: join(evidence, `reconnect-header-${width}-connected.png`) });

          await page.locator(".context-connection").waitFor({ state: "detached" });
          assert.equal(await page.locator(".context-sub:not(.context-session)").innerText(), crumb, `${width}: then the crumb comes back`);
          assert.equal(await composer.inputValue(), DRAFT + MORE, `${width}: the return sends nothing: the draft waits for the user`);
          assert.equal(await page.locator(".chat-turn-user", { hasText: DRAFT }).count(), 0, `${width}: and no message was sent`);
          assert.deepEqual(errors, []);
          console.log(`PASS ${width}: Reconnecting… then Connected in the header's title area, the draft kept`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
