import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { shownRows } from "./shown-rows.ts";
import { serveDemo } from "./demo-server.ts";

// The pty is shared with every device, so a hidden pane must not size it: a PC drawing the split would
// see that pane at the phone's size.
const app = mkdtempSync(join(tmpdir(), "herdr-phone-split-grid-demo-"));

interface Frame { type: string; pane_id: string; cols?: number; rows?: number; keep_size?: boolean }
type Recorded = { sent: Frame[]; recordedSockets: WebSocket[] };
const frames = (page: Page, pane: string): Promise<Frame[]> =>
  page.evaluate((id) => (window as unknown as Recorded).sent.filter((frame) => frame.pane_id === id), pane);

const layout = async (page: Page, path: string, body: Record<string, unknown>): Promise<{ pane?: { pane_id?: string } }> => {
  const [status, json] = await page.evaluate(async ([url, payload]) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    return [response.status, await response.json().catch(() => ({}))] as const;
  }, [path, JSON.stringify(body)] as const);
  assert.equal(status, 200, `${path} answered ${status}`);
  return json as { pane?: { pane_id?: string } };
};

const sent = (page: Page): Promise<void> => page.evaluate(() => { (window as unknown as Recorded).sent = []; });
const lastOf = async (page: Page, pane: string, type: string): Promise<Frame | undefined> => (await frames(page, pane)).filter((frame) => frame.type === type).at(-1);

async function reconnect(page: Page, panesHeld: string[]): Promise<Frame[]> {
  await sent(page);
  await page.evaluate(() => (window as unknown as Recorded).recordedSockets.at(-1)!.close());
  await page.waitForFunction((ids) => ids.every((id) => (window as unknown as Recorded).sent.some((frame) => frame.pane_id === id && frame.type === "attach")), panesHeld, { timeout: 15_000 });
  await page.waitForTimeout(1_000);
  return page.evaluate(() => (window as unknown as Recorded).sent);
}

async function pinchAcross(context: BrowserContext, page: Page, pane: string, during: () => Promise<void>): Promise<void> {
  const box = (await page.locator(`.pane-frame[data-layout-pane="${pane}"] .pane-terminal`).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const pair = (distance: number) => [{ x: cx - distance / 2, y: cy, id: 1 }, { x: cx + distance / 2, y: cy, id: 2 }];
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pair(100) });
  for (let step = 1; step <= 8; step++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pair(100 + 54 * step / 8) });
  await page.locator(`.pane-frame[data-layout-pane="${pane}"] .terminal-font-size`).waitFor();
  await during();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

async function showOther(page: Page, pane: string): Promise<void> {
  const menu = await page.locator(".tab-strip-menu").count() > 0 ? ".tab-strip-menu" : ".header-more-button";
  await page.locator(menu).evaluate((node) => (node as HTMLElement).click());
  await page.locator(`.row-sheet-item[data-item="pane:${pane}"]`).evaluate((node) => (node as HTMLElement).click());
  await page.locator(`.pane-frame:not(.is-hidden)[data-layout-pane="${pane}"]`).waitFor();
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  // the demo's socket is a class of its own that no browser event reports: note every frame it sends
  const record = `<script>(() => {
    const Demo = window.WebSocket;
    window.sent = [];
    window.recordedSockets = [];
    const Recorded = function (url, protocols) {
      const socket = new Demo(url, protocols);
      window.recordedSockets.push(socket);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") { const frame = JSON.parse(data); if (frame.type === "resize" || frame.type === "attach") window.sent.push(frame); }
        send(data);
      };
      return socket;
    };
    for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(Recorded, name, { value: Demo[name] });
    window.WebSocket = Recorded;
  })();</script>`;
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${record}\n    <script type="module"`));
  const server = serveDemo(app);
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      await context.addInitScript(() => {
        if (!localStorage.getItem("ovis:settings")) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal" }));
      if (!localStorage.getItem("ovis:phone-tabs")) localStorage.setItem("ovis:phone-tabs", JSON.stringify("header"));
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.shell)}&view=terminal`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      const made = await layout(page, "/api/pane/split", { pane_id: panes.shell, direction: "right", focus: true });
      assert.ok(made.pane?.pane_id, JSON.stringify(made));
      await page.locator(".pane-frame.is-hidden").waitFor({ state: "attached" });
      const shell = await page.locator(".pane-frame.is-hidden").getAttribute("data-layout-pane") as string;
      const sibling = await page.locator(".pane-frame:not(.is-hidden)").getAttribute("data-layout-pane") as string;
      await page.locator(shownRows(`.pane-frame:not(.is-hidden)[data-layout-pane="${sibling}"]`)).waitFor();
      await page.waitForTimeout(1_000);
      await page.evaluate(() => { (window as unknown as Recorded).sent = []; });
      await page.setViewportSize({ width: 700, height: 390 });
      await page.waitForFunction((id) => (window as unknown as Recorded).sent.some((frame) => frame.pane_id === id && frame.type === "resize"), sibling, { timeout: 10_000 });
      await page.waitForTimeout(1_000); // fixed wait: no resize frame may be sent for the hidden pane
      assert.deepEqual(await frames(page, shell), [], "the hidden pane sends no resize");

      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction((id) => (window as unknown as Recorded).sent.filter((frame) => frame.pane_id === id && frame.type === "resize").at(-1)?.cols! < 60, sibling, { timeout: 10_000 });
      await page.waitForTimeout(1_000); // fixed wait: no resize frame may be sent for the still hidden pane
      assert.deepEqual(await frames(page, shell), [], "the hidden pane still sends no resize");

      const phoneGrid = (await lastOf(page, sibling, "resize"))!;

      let again = await reconnect(page, [shell, sibling]);
      assert.equal(again.find((frame) => frame.pane_id === shell && frame.type === "attach")?.keep_size, true, `the hidden pane reattaches keeping the pty's size: ${JSON.stringify(again)}`);
      assert.notEqual(again.find((frame) => frame.pane_id === sibling && frame.type === "attach")?.keep_size, true, "the shown pane reattaches at its own size");
      assert.deepEqual(again.filter((frame) => frame.pane_id === shell && frame.type === "resize"), [], "nor does the reconnect resize the hidden pane");

      await sent(page);
      await page.locator(".header-more-button").tap();
      const sheet = page.getByRole("dialog");
      await sheet.waitFor();
      await sheet.locator(`.row-sheet-item[data-item="pane:${shell}"]`).tap();
      await page.locator(`.pane-frame:not(.is-hidden)[data-layout-pane="${shell}"]`).waitFor();
      await page.waitForFunction((id) => (window as unknown as Recorded).sent.some((frame) => frame.pane_id === id && frame.type === "resize"), shell, { timeout: 10_000 });
      const taken = (await lastOf(page, shell, "resize"))!;
      assert.deepEqual([taken.cols, taken.rows], [phoneGrid.cols, phoneGrid.rows], "the pane shown again takes the pty at the phone's size");
      await page.waitForTimeout(1_000); // fixed wait: the pane now behind may not send a resize
      assert.equal(await lastOf(page, sibling, "resize"), undefined, "the pane gone behind it sends no resize");

      again = await reconnect(page, [shell, sibling]);
      assert.equal(again.find((frame) => frame.pane_id === sibling && frame.type === "attach")?.keep_size, true, `the pane now hidden reattaches keeping the pty's size: ${JSON.stringify(again)}`);
      assert.notEqual(again.find((frame) => frame.pane_id === shell && frame.type === "attach")?.keep_size, true, "the pane now shown reattaches at its own size");

      await sent(page);
      await pinchAcross(context, page, shell, async () => {
        await showOther(page, sibling);
        await page.waitForTimeout(500);
        await sent(page);
      });
      await page.waitForTimeout(1_000); // fixed wait: a pinch ended behind a sibling may not send a resize
      assert.deepEqual((await frames(page, shell)).filter((frame) => frame.type === "resize"), [], "a pinch ended behind a sibling sizes no pty");
      again = await reconnect(page, [shell, sibling]);
      assert.equal(again.find((frame) => frame.pane_id === shell && frame.type === "attach")?.keep_size, true, "and leaves the hidden pane keeping the pty's size");
      assert.deepEqual(errors, []);
      console.log(`PASS a phone's hidden split pane sizes nothing, on a reconnect or a pinch that ends behind its sibling either, and takes the pty (${phoneGrid.cols}x${phoneGrid.rows}) once shown`);
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
