/** More tabs than a browser's HTTP/1.1 connections per host take machine events over their terminal socket; tests use isolated app state. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import { createServer } from "../server/index.ts";

const TABS = 8;
const stateDir = mkdtempSync(join(tmpdir(), "ovis-machine-browser-"));
const previous = process.env["OVIS_MACHINE_EVENTS_WS"];
delete process.env["OVIS_MACHINE_EVENTS_WS"];
const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false });
const base = `http://127.0.0.1:${server.port}`;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const context = await browser.newContext();
  let sse = 0;
  context.on("request", (request) => { if (new URL(request.url()).pathname === "/api/machines/events") sse++; });
  await context.addInitScript(() => {
    const status = { documents: 0, preference: -1 };
    Object.assign(window, { machineEventTest: status });
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data));
          if (frame.type !== "machine-event") return;
          if (frame.event.type === "machines") status.documents++;
          if (frame.event.type === "preferences") status.preference = frame.event.preferences.revision;
        });
      }
    };
  });
  const pages = [];
  for (let i = 0; i < TABS; i++) {
    const page = await context.newPage(); pages.push(page);
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => (window as unknown as { machineEventTest: { documents: number } }).machineEventTest.documents > 0);
  }
  assert.equal(sse, 0, "machine events must not open any HTTP event stream");
  // every tab can still make a plain request: no long-lived stream holds a connection slot
  const latencies = await Promise.all(pages.map((page) => page.evaluate(async () => {
    const start = performance.now();
    const response = await fetch("/api/health", { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`health answered ${response.status}`);
    return performance.now() - start;
  })));
  const change = await context.request.put(base + "/api/preferences", { data: { settings: { language: "ko" } }, headers: { origin: base } });
  assert.equal(change.status(), 200);
  const revision = (await change.json()).revision;
  await Promise.all(pages.map((page) => page.waitForFunction((revision) =>
    (window as unknown as { machineEventTest: { preference: number } }).machineEventTest.preference === revision, revision)));
  const report = { tabs: pages.length, sseRequests: sse, preferenceRevisionDeliveredToAll: revision, healthMaxMs: Math.round(Math.max(...latencies)) };
  console.log(JSON.stringify(report));
  writeFileSync(process.env["MACHINE_EVENTS_REPORT"] ?? join(tmpdir(), "ovis-machine-events-browser-report.json"), JSON.stringify(report, null, 2));
  await context.close();
} finally {
  await browser?.close(); server.stop(); rmSync(stateDir, { recursive: true, force: true });
  if (previous === undefined) delete process.env["OVIS_MACHINE_EVENTS_WS"]; else process.env["OVIS_MACHINE_EVENTS_WS"] = previous;
}
