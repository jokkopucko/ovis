/**
 * A hidden recent tab's view, parsed on its return, is history: a query in it is not answered into
 * the pane and a copy request in it does not write the clipboard. Real client and xterm on the demo's
 * transport, which a fixture gives the `watch` feature and a view that only it feeds.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

interface Fixture {
  copies: string[];
  sent: Array<{ type: string; pane_id?: string; text?: string }>;
  sockets: Array<WebSocket & { push(frame: Record<string, unknown>): void }>;
}
declare global { interface Window { viewFixture: Fixture } }

/** Installed after the demo's transport: records what the client sends and copies, and keeps views open. */
function installViewFixture(): void {
  const state: Fixture = { copies: [], sent: [], sockets: [] };
  window.viewFixture = state;
  Object.defineProperty(navigator.clipboard, "writeText", {
    configurable: true, writable: true,
    value: (text: string) => { state.copies.push(String(text)); return Promise.resolve(); },
  });
  const Demo = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    const socket = new Demo(url, protocols) as Fixture["sockets"][number];
    state.sockets.push(socket);
    const push = socket.push.bind(socket);
    socket.push = (frame) => {
      // the demo has no herdr to watch: the bridge offers views here, and the fixture feeds them
      if (frame.type === "snapshot" && Array.isArray(frame.features)) return push({ ...frame, features: [...frame.features, "watch"] });
      if (frame.type === "watch-end") return;
      return push(frame);
    };
    const send = socket.send.bind(socket);
    socket.send = (raw) => {
      state.sent.push(JSON.parse(String(raw)));
      send(raw);
    };
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Recorded, name, { value: Demo[name] });
  window.WebSocket = Recorded as unknown as typeof WebSocket;
}

const ESC = "\x1b", BEL = "\x07";
const MARK = "VIEW-REPLAY-MARK";
// a cursor-position query, a copy request ("history") and a line to see the view parsed by
const VIEW = `${ESC}[6n${ESC}]52;c;aGlzdG9yeQ==${BEL}${MARK}\r\n`;
const evidence = process.env["UI_EVIDENCE_DIR"];
const app = mkdtempSync(join(tmpdir(), "ovis-view-replay-demo-"));
let server: ReturnType<typeof Bun.serve> | null = null;
let browser: Browser | null = null;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n<script>(${installViewFixture.toString()})()</script>\n<script type="module"`));
  const prefix = "/herdr-web-ui/demo/app/";
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
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
  const url = `http://127.0.0.1:${server.port}${prefix}`;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  for (const width of [1280, 390]) {
    const phone = width === 390;
    const context = await browser.newContext({ viewport: { width, height: phone ? 800 : 900 }, isMobile: phone, hasTouch: phone, colorScheme: "dark" });
    try {
      await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", defaultView: "terminal", terminalInputMode: "direct", alertsOn: false, paneClipboard: true, releasePaneAway: false })));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      // two tabs of one workspace on the demo's PC
      const pick = await page.evaluate(async () => {
        const roster = await (await fetch("/api/machines")).json() as { machines: Array<{ id: string; snapshot?: { panes: Array<{ pane_id: string; tab_id: string; workspace_id: string }> } }> };
        const panes = roster.machines.find((machine) => machine.id === "local")?.snapshot?.panes ?? [];
        for (const pane of panes) {
          const other = panes.find((item) => item.workspace_id === pane.workspace_id && item.tab_id !== pane.tab_id);
          if (other) return { a: pane.pane_id, b: other.pane_id, tabA: pane.tab_id, tabB: other.tab_id };
        }
        return null;
      });
      assert.ok(pick, "the demo has a workspace with two tabs");
      const { a, b, tabA, tabB } = pick;
      await page.goto(`${url}?pane=${encodeURIComponent(a)}`);
      const frame = (id: string) => page.locator(`[data-layout-pane="${id}"]`);
      await frame(a).locator("[data-pane-content]").waitFor();
      const sentSince = (start: number) => page.evaluate((start) => window.viewFixture.sent.slice(start), start);
      // left for the other tab, the first tab watches its pane
      await page.locator(`.tab-strip [role="tab"][data-tab-id="${tabB}"]`).click();
      await frame(b).locator("[data-pane-content]").waitFor();
      await page.waitForFunction((pane) => window.viewFixture.sent.some((sent) => sent.type === "watch" && sent.pane_id === pane), a, { timeout: 10_000 });
      await page.evaluate(({ pane, data }) => {
        for (const socket of window.viewFixture.sockets) socket.push({ type: "watch-data", pane_id: pane, data });
      }, { pane: a, data: VIEW });
      assert.equal(await frame(a).locator(".xterm-rows", { hasText: MARK }).count(), 0, "a hidden tab keeps its view unparsed");
      // back on the first tab: the view is drawn, its query unanswered and its copy request not run
      const back = await page.evaluate(() => window.viewFixture.sent.length);
      await page.locator(`.tab-strip [role="tab"][data-tab-id="${tabA}"]`).click();
      await frame(a).locator(".xterm-rows", { hasText: MARK }).waitFor({ state: "attached" });
      await page.waitForFunction(({ pane, start }) => window.viewFixture.sent.slice(start).some((sent) => sent.type === "attach" && sent.pane_id === pane), { pane: a, start: back }, { timeout: 10_000 });
      // the reply xterm would type is sent as the view parses: the attach's own output, parsed after it, settles that
      await frame(a).locator("[data-pane-content]").waitFor();
      const after = await sentSince(back);
      const replies = after.filter((sent) => (sent.type === "input" || sent.type === "keys") && /\x1b\[\d+;\d+R/.test(String(sent.text ?? "")));
      assert.deepEqual(replies, [], `${width}: a query in a hidden tab's view is not answered into the pane`);
      assert.deepEqual(await page.evaluate(() => window.viewFixture.copies), [], `${width}: a copy request in a hidden tab's view does not write the clipboard`);
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `view-replay-${width}.png`) });
      }
      assert.deepEqual(errors, [], "no browser errors");
      console.log(`PASS ${width}: a hidden tab's view is drawn on return without answering its queries or copying`);
      if (phone) continue;

      // A hidden page drops a recent tab's view, and the terminal reset it began with. Back on that
      // tab before its next view frame, the attach starts from a reset, as any tab's does: a mode the
      // old screen set (mouse tracking, which the replay's clear keeps) does not outlive it.
      const mouseMode = () => frame(a).locator(".xterm").evaluate((element) => element.classList.contains("enable-mouse-events"));
      await page.evaluate((pane) => {
        for (const socket of window.viewFixture.sockets) socket.push({ type: "pty-data", pane_id: pane, data: "\x1b[?1000h" });
      }, a);
      await page.waitForFunction((pane) => document.querySelector(`[data-layout-pane="${pane}"] .xterm`)?.classList.contains("enable-mouse-events"), a, { timeout: 10_000 });
      const leaving = await page.evaluate(() => window.viewFixture.sent.length);
      await page.locator(`.tab-strip [role="tab"][data-tab-id="${tabB}"]`).click();
      await frame(b).locator("[data-pane-content]").waitFor();
      await page.waitForFunction(({ pane, start }) => window.viewFixture.sent.slice(start).some((sent) => sent.type === "watch" && sent.pane_id === pane), { pane: a, start: leaving }, { timeout: 10_000 });
      const visibility = (hidden: boolean) => page.evaluate((hide) => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hide ? "hidden" : "visible" });
        Object.defineProperty(document, "hasFocus", { configurable: true, value: () => !hide });
        document.dispatchEvent(new Event("visibilitychange"));
      }, hidden);
      const hiding = await page.evaluate(() => window.viewFixture.sent.length);
      await visibility(true);
      await page.waitForFunction(({ pane, start }) => window.viewFixture.sent.slice(start).some((sent) => sent.type === "unwatch" && sent.pane_id === pane), { pane: a, start: hiding }, { timeout: 10_000 });
      await visibility(false);
      const returning = await page.evaluate(() => window.viewFixture.sent.length);
      await page.locator(`.tab-strip [role="tab"][data-tab-id="${tabA}"]`).click();
      await page.waitForFunction(({ pane, start }) => window.viewFixture.sent.slice(start).some((sent) => sent.type === "attach" && sent.pane_id === pane), { pane: a, start: returning }, { timeout: 10_000 });
      await frame(a).locator("[data-pane-content]").waitFor();
      await page.waitForFunction((pane) => document.querySelector(`[data-layout-pane="${pane}"] .xterm`)?.classList.contains("enable-mouse-events") === false, a, { timeout: 10_000 })
        .catch(() => undefined);
      assert.equal(await mouseMode(), false, `${width}: a recent tab whose view a hidden page dropped starts again from a reset`);
      assert.deepEqual(errors, [], "no browser errors");
      console.log(`PASS ${width}: a recent tab whose view a hidden page dropped attaches from a reset`);

      // The same holds for a view past its bound (dropped with its reset), and for a view started
      // again (the window left and back) whose first frame has not come by the return
      const returnsFromReset = async (label: string, away: () => Promise<void>) => {
        await page.evaluate((pane) => {
          for (const socket of window.viewFixture.sockets) socket.push({ type: "pty-data", pane_id: pane, data: "\x1b[?1000h" });
        }, a);
        await page.waitForFunction((pane) => document.querySelector(`[data-layout-pane="${pane}"] .xterm`)?.classList.contains("enable-mouse-events"), a, { timeout: 10_000 });
        const left = await page.evaluate(() => window.viewFixture.sent.length);
        await page.locator(`.tab-strip [role="tab"][data-tab-id="${tabB}"]`).click();
        await frame(b).locator("[data-pane-content]").waitFor();
        await page.waitForFunction(({ pane, start }) => window.viewFixture.sent.slice(start).some((sent) => sent.type === "watch" && sent.pane_id === pane), { pane: a, start: left }, { timeout: 10_000 });
        await away();
        const back = await page.evaluate(() => window.viewFixture.sent.length);
        await page.locator(`.tab-strip [role="tab"][data-tab-id="${tabA}"]`).click();
        await page.waitForFunction(({ pane, start }) => window.viewFixture.sent.slice(start).some((sent) => sent.type === "attach" && sent.pane_id === pane), { pane: a, start: back }, { timeout: 10_000 });
        await frame(a).locator("[data-pane-content]").waitFor();
        await page.waitForFunction((pane) => document.querySelector(`[data-layout-pane="${pane}"] .xterm`)?.classList.contains("enable-mouse-events") === false, a, { timeout: 10_000 })
          .catch(() => undefined);
        assert.equal(await mouseMode(), false, `${width}: ${label} starts again from a reset`);
        assert.deepEqual(errors, [], "no browser errors");
        console.log(`PASS ${width}: ${label} attaches from a reset`);
      };
      await returnsFromReset("a recent tab whose view outgrew its buffer", () => page.evaluate((pane) => {
        for (const socket of window.viewFixture.sockets) socket.push({ type: "watch-data", pane_id: pane, data: "x".repeat(600 * 1024) });
      }, a));
      await returnsFromReset("a recent tab back before its restarted view's first frame", async () => {
        const blurred = await page.evaluate(() => window.viewFixture.sent.length);
        await page.evaluate(() => {
          Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
          window.dispatchEvent(new Event("blur"));
        });
        await page.waitForFunction(({ pane, start }) => window.viewFixture.sent.slice(start).some((sent) => sent.type === "unwatch" && sent.pane_id === pane), { pane: a, start: blurred }, { timeout: 10_000 });
        const focused = await page.evaluate(() => window.viewFixture.sent.length);
        await page.evaluate(() => {
          Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
          window.dispatchEvent(new Event("focus"));
        });
        await page.waitForFunction(({ pane, start }) => window.viewFixture.sent.slice(start).some((sent) => sent.type === "watch" && sent.pane_id === pane), { pane: a, start: focused }, { timeout: 10_000 });
      });
    } finally { await context.close(); }
  }
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
