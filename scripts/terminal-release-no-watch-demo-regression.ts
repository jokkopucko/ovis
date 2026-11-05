/**
 * A pane let go of while the window is out of use (Settings → Use alongside herdr's own window) keeps
 * its last screen on a bridge that offers no read-only view (herdr-core lists no `watch`): there is
 * no view to start the screen again from, so nothing resets it. Coming back attaches again. Real
 * client and xterm on the demo's transport, whose features list no `watch`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import terminalFixture from "../site/demo/fixtures/terminal.json";

interface Fixture {
  sent: Array<{ type: string; pane_id?: string }>;
  sockets: Array<WebSocket & { push(frame: Record<string, unknown>): void }>;
}
interface Probe { inFlight: number; queued: number }
declare global { interface Window { releaseFixture: Fixture } }

/** Installed after the demo's transport: records what the client sends, and lets the test push frames. */
function installReleaseFixture(): void {
  const state: Fixture = { sent: [], sockets: [] };
  window.releaseFixture = state;
  const Demo = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    const socket = new Demo(url, protocols) as Fixture["sockets"][number];
    state.sockets.push(socket);
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

const MARK = "RELEASED-SCREEN-MARK";
const app = mkdtempSync(join(tmpdir(), "ovis-release-no-watch-demo-"));
let server: ReturnType<typeof Bun.serve> | null = null;
let browser: Browser | null = null;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n<script>(${installReleaseFixture.toString()})()</script>\n<script type="module"`));
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
  try {
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", defaultView: "terminal", terminalInputMode: "direct", alertsOn: false, releasePaneAway: true })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    const pane = await page.evaluate(async () => {
      const roster = await (await fetch("/api/machines")).json() as { machines: Array<{ id: string; snapshot?: { panes: Array<{ pane_id: string; agent?: string | null }> } }> };
      // a plain shell: an agent's pane opens in its chat, where the terminal draws nothing
      return roster.machines.find((machine) => machine.id === "local")?.snapshot?.panes.find((pane) => !pane.agent)?.pane_id ?? null;
    });
    assert.ok(pane, "the demo has a shell pane");
    await page.goto(`${url}?pane=${encodeURIComponent(pane)}`);
    const frame = page.locator(`[data-layout-pane="${pane}"]`);
    await frame.locator("[data-pane-content]").waitFor();
    const sentOf = (type: string) => page.evaluate(({ pane, type }) => window.releaseFixture.sent.filter((sent) => sent.type === type && sent.pane_id === pane).length, { pane, type });
    await page.waitForFunction((pane) => window.releaseFixture.sent.some((sent) => sent.type === "attach" && sent.pane_id === pane), pane, { timeout: 10_000 });
    // every write queued so far is parsed, and xterm drew the result
    const settled = () => page.waitForFunction(() => {
      const probe = (document.querySelector(".pane-frame.is-current .pane-terminal") as unknown as { outputProbe?: () => Probe } | null)?.outputProbe?.();
      return probe !== undefined && probe.inFlight === 0 && probe.queued === 0;
    }, undefined, { timeout: 10_000 });
    // the demo's shell replays a recording on attach, frame by frame: a mark pushed before its last
    // frame would be drawn over by the rest of it, so the mark waits until that frame was written
    const lastFrame = terminalFixture.frames.at(-1)!.data.slice(-512);
    await page.waitForFunction((tail) => {
      const probe = (document.querySelector(".pane-frame.is-current .pane-terminal") as unknown as { outputProbe?: () => Probe & { written: string } } | null)?.outputProbe?.();
      return probe !== undefined && probe.written.endsWith(tail);
    }, lastFrame, { timeout: 10_000 });
    await settled();
    // the attach draws a screen the test can recognise
    await page.evaluate(({ pane, data }) => {
      for (const socket of window.releaseFixture.sockets) socket.push({ type: "pty-data", pane_id: pane, data });
    }, { pane, data: `\x1b[2J\x1b[H${MARK}` });
    await frame.locator(".xterm-rows", { hasText: MARK }).waitFor({ state: "attached" });
    // the window is left: after RELEASE_AFTER_MS the tab lets go of the pane
    await page.evaluate(() => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
      window.dispatchEvent(new Event("blur"));
    });
    await page.waitForFunction((pane) => window.releaseFixture.sent.some((sent) => sent.type === "detach" && sent.pane_id === pane), pane, { timeout: 10_000 });
    // every write the release queued is parsed, and xterm drew the result
    await settled();
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    assert.equal(await sentOf("watch"), 0, "a bridge without watch is never asked for a view");
    assert.equal(await frame.locator(".xterm-rows", { hasText: MARK }).count(), 1, "the released pane keeps its last screen");
    // back in use: the pane is attached again
    const attaches = await sentOf("attach");
    await page.evaluate(() => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
      window.dispatchEvent(new Event("focus"));
    });
    await page.waitForFunction(({ pane, attaches }) => window.releaseFixture.sent.filter((sent) => sent.type === "attach" && sent.pane_id === pane).length > attaches, { pane, attaches }, { timeout: 10_000 });
    assert.deepEqual(errors, [], "no browser errors");
    console.log("PASS a pane released without watch keeps its screen, and attaches again on return");
  } finally { await context.close(); }
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
