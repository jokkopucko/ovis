import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { chromePath } from "./chrome-path.ts";
import { buildDemoApp } from "./demo-build.ts";

export { panes };
export const PREFIX = "/herdr-web-ui/demo/app/";

const HOLD_TURN = `<script>(() => {
  const later = window.setTimeout;
  const held = [];
  window.__probe = { held, restore: () => { window.setTimeout = later; } };
  window.setTimeout = (callback, ms, ...rest) => { if (ms === 4500) { held.push(callback); return 0; } return later(callback, ms, ...rest); };
})();</script>`;
const BRIDGE = `<script>(() => {
  const probe = window.__probe;
  probe.restore();
  const DemoSocket = window.WebSocket, DemoEvents = window.EventSource;
  const sockets = [], streams = [];
  window.WebSocket = function (url, protocols) { const socket = new DemoSocket(url, protocols); sockets.push(socket); return socket; };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(window.WebSocket, name, { value: DemoSocket[name] });
  window.EventSource = function (url, init) { const stream = new DemoEvents(url, init); streams.push(stream); return stream; };
  probe.finishTurn = () => { const callback = probe.held.shift(); if (!callback) throw new Error("no held turn"); callback(); };
  probe.status = (paneId, status) => {
    const message = { type: "pane-status", pane_id: paneId, agent_status: status };
    const data = JSON.stringify({ type: "machine-message", machine_id: "local", message });
    for (const stream of streams) if (stream.readyState === 1) { stream.onmessage?.(new MessageEvent("message", { data })); stream.dispatchEvent(new MessageEvent("message", { data })); }
    for (const socket of sockets) if (socket.readyState === 1) socket.push(message);
  };
})();</script>`;
const STAGE = `<script>(() => {
  const stage = window.__probeStage || {};
  const demo = window.fetch;
  const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const pane = url.searchParams.get("pane_id") || "";
    const turns = stage.turns && stage.turns[pane];
    if (url.pathname === "/api/pane/conversation" && turns) return json({ source: "claude-transcript", history_id: "probe-" + pane, cursor: null, turns: url.searchParams.has("before") ? [] : turns });
    const prompt = stage.prompts && stage.prompts[pane];
    if (url.pathname === "/api/pane/prompt" && prompt) return json({ prompt, outcomes: [] });
    return demo(input, init);
  };
})();</script>`;

export interface Stage { turns?: Record<string, unknown[]>; prompts?: Record<string, unknown> }
export interface OpenOptions { pane: string; phone?: boolean; stage?: Stage; query?: string; clock?: boolean; ready?: string }
export interface Visit { context: BrowserContext; page: Page }
export interface Demo { open(options: OpenOptions): Promise<Visit>; close(): Promise<void> }

export async function startDemo(): Promise<Demo> {
  const app = mkdtempSync(join(tmpdir(), "ovis-is-probes-"));
  let server: ReturnType<typeof Bun.serve> | null = null;
  let browser: Browser | null = null;
  const close = async (): Promise<void> => {
    await browser?.close().catch(() => undefined);
    await server?.stop(true);
    rmSync(app, { recursive: true, force: true });
  };
  try {
    await buildDemoApp(app);
    const index = join(app, "index.html");
    writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `${HOLD_TURN}<script src="./demo-transport.js"></script>${BRIDGE}${STAGE}\n    <script type="module"`));
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (!path.startsWith(PREFIX)) return new Response("not found", { status: 404 });
      const file = path.slice(PREFIX.length) || "index.html";
      if (file.split("/").includes("..")) return new Response("bad path", { status: 400 });
      const body = Bun.file(join(app, file));
      return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
    } });
    const origin = `http://127.0.0.1:${server.port}`;
    const own = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    browser = own;
    const open = async ({ pane, phone = false, stage = {}, query = "", clock = false, ready = ".conn-live" }: OpenOptions): Promise<Visit> => {
      const context = await own.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, locale: "ko-KR", serviceWorkers: "block", ...(phone ? { isMobile: true, hasTouch: true } : {}) });
      await context.addInitScript((staged) => {
        if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "ko", theme: "light" }));
        (window as unknown as { __probeStage: unknown }).__probeStage = staged;
      }, stage);
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      if (clock) await page.clock.install();
      await page.goto(`${origin}${PREFIX}?pane=${encodeURIComponent(pane)}&view=chat${query}`);
      await page.locator(ready).first().waitFor({ state: "attached", timeout: 20_000 });
      return { context, page };
    };
    return { open, close };
  } catch (error) {
    await close();
    throw error;
  }
}
