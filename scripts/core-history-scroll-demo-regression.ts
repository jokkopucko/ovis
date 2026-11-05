/**
 * A herdr-core server's terminal history (#2663): its `terminal-history` feature keeps the scrollback in
 * xterm, so the wheel and a phone's swipe scroll back through the history its attach replays first, a
 * replay erases the last one's instead of doubling it, and nothing is typed to the program. herdr's
 * own server keeps none (its TUI does). Demo fixtures only: no herdr, hc or user state.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { appFaces } from "./app-faces.ts";

interface Frame { type: string; pane_id?: string; data?: string; features?: string[] }
interface HistoryFixture {
  inputs: Frame[];
  replay(): void;
}
declare global { interface Window { historyFixture: HistoryFixture } }

/** The demo serves the pane; only its feature list and the pane's bytes are replaced. */
function installHistoryFixture(): void {
  const core = new URL(location.href).searchParams.get("server") === "core";
  // what CoreAttachSession sends: an erased scrollback, then hc's history and screen
  const lines = Array.from({ length: 300 }, (_, index) => `HIST-${String(index + 1).padStart(3, "0")}`);
  // CLEAR_HISTORY byte for byte (this function runs in the page, so it cannot import it)
  const stream = `\x1b[?1049l\x1b[3J\x1b[H\x1b[2J${lines.join("\r\n")}`;
  const sockets: Array<WebSocket & { push(frame: Record<string, unknown>): void }> = [];
  let pane: string | null = null;
  // a server lists its features before any pane's bytes; the demo lists them in its snapshot, after
  let featured = false;
  let waiting: (() => void) | null = null;
  const state: HistoryFixture = {
    inputs: [],
    replay: () => { for (const socket of sockets) if (pane) socket.push({ type: "pty-data", fixture: "history", pane_id: pane, data: stream }); },
  };
  window.historyFixture = state;
  const Demo = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    const socket = new Demo(url, protocols) as (typeof sockets)[number];
    sockets.push(socket);
    const push = socket.push.bind(socket);
    socket.push = (frame) => {
      if ((frame.type === "snapshot" || frame.type === "features") && Array.isArray(frame.features) && core) {
        push({ ...frame, features: [...(frame.features as string[]), "terminal-history"] });
      } else if (frame.type === "snapshot" || frame.type === "features") push(frame);
      else if (frame.type === "pty-data") {
        // the demo's own recording would move the screen under the test
        if (frame.fixture !== "history") return;
        const { fixture: _, ...output } = frame;
        push(output);
      } else push(frame);
      if (frame.type === "snapshot" || frame.type === "features") {
        featured = true;
        waiting?.();
        waiting = null;
      }
    };
    const send = socket.send.bind(socket);
    socket.send = (raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      if (["input", "keys", "submit"].includes(frame.type)) state.inputs.push(frame);
      send(raw);
      if (frame.type === "attach" && frame.pane_id) {
        pane = frame.pane_id;
        const paint = () => socket.push({ type: "pty-data", fixture: "history", pane_id: frame.pane_id, data: stream });
        if (featured) paint();
        else waiting = paint;
      }
    };
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Recorded, name, { value: Demo[name] });
  window.WebSocket = Recorded as unknown as typeof WebSocket;
}

const settled = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
interface History { scrollback: number; length: number; viewportY: number; baseY: number }
/** the current pane's xterm buffer, from the test build's output probe */
const history = (page: Page) => page.evaluate(() => {
  const host = document.querySelector(".pane-frame.is-current .pane-terminal") as (HTMLElement & { outputProbe?: () => { history: History } }) | null;
  return host?.outputProbe?.().history ?? null;
});
/** waits for the view to scroll above `viewportY`, and says what it saw when it does not */
const scrolledAbove = async (page: Page, viewportY: number, at: { x: number; y: number }, step: string): Promise<void> => {
  try {
    await page.waitForFunction((last) => {
      const host = document.querySelector(".pane-frame.is-current .pane-terminal") as (HTMLElement & { outputProbe?: () => { history: History } }) | null;
      const now = host?.outputProbe?.().history;
      return now !== undefined && now.viewportY < last;
    }, viewportY, { timeout: 5000 });
  } catch (cause) {
    const seen = await page.evaluate(({ x, y }) => {
      const under = document.elementFromPoint(x, y);
      const host = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal");
      return { under: under ? `${under.tagName}.${[...under.classList].join(".")}` : null, path: under?.closest(".pane-terminal") ? "inside the pane" : "outside the pane",
        folded: host?.hasAttribute("data-folded"), adopted: host?.hasAttribute("data-adopted-grid"), hostScroll: host?.scrollTop, dropped: host?.dataset["touchWheelDropped"], inputs: window.historyFixture.inputs.length };
    }, at);
    throw new Error(`${step}: the view stayed at row ${viewportY}; history=${JSON.stringify(await history(page))} under=${JSON.stringify(seen)}`, { cause });
  }
};
const inputs = (page: Page) => page.evaluate(() => window.historyFixture.inputs);
const app = mkdtempSync(join(tmpdir(), "herdr-core-history-demo-"));

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n<script>(${installHistoryFixture.toString()})()</script>\n<script type="module"`));
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
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const kind of ["core", "herdr"] as const) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true, locale: "en-US" });
        try {
          await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", terminalInputMode: "direct", alertsOn: false })));
          const page = await context.newPage();
          page.setDefaultTimeout(10000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}${prefix}?pane=${encodeURIComponent(panes.shell)}&view=terminal&server=${kind}`);
          await page.locator(".conn-live").waitFor();
          await appFaces(page);
          await page.locator(".pane-frame.is-current .xterm-rows", { hasText: "HIST-300" }).waitFor();
          await settled(page);
          const shown = await history(page);
          assert.ok(shown, `${kind}: the test build's output probe answers`);
          if (kind === "core") {
            assert.ok(shown.scrollback > 0, "core: the browser keeps the scrollback");
            // the 300 replayed lines, less the screen's own rows, are history above it
            assert.ok(shown.baseY > 0 && shown.viewportY === shown.baseY, `core: the history sits above the screen, which shows the newest rows (${JSON.stringify(shown)})`);
            assert.ok(shown.length >= 300, `core: the buffer keeps all 300 replayed lines (${JSON.stringify(shown)})`);
          } else {
            assert.equal(shown.scrollback, 0, "herdr: its TUI keeps the scrollback, not the browser");
            assert.equal(shown.baseY, 0, "herdr: nothing is kept above the screen");
          }
          const terminal = page.locator(".pane-frame.is-current .pane-terminal");
          const box = await terminal.boundingBox();
          assert.ok(box);
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
          await page.mouse.wheel(0, -600);
          await settled(page);
          if (kind === "core") {
            await scrolledAbove(page, shown.viewportY, { x: box.x + box.width / 2, y: box.y + box.height / 3 }, "core: the wheel scrolls back");
            // back to the bottom: the newest rows again
            await page.mouse.wheel(0, 20000);
            await page.waitForFunction(() => {
              const host = document.querySelector(".pane-frame.is-current .pane-terminal") as (HTMLElement & { outputProbe?: () => { history: History } }) | null;
              const now = host?.outputProbe?.().history;
              return now !== undefined && now.viewportY === now.baseY;
            });
            // a reattach replays the history again: it replaces the scrollback rather than doubling it
            await page.evaluate(() => window.historyFixture.replay());
            await page.locator(".pane-frame.is-current .xterm-rows", { hasText: "HIST-300" }).waitFor();
            await settled(page);
            const replayed = await history(page);
            assert.equal(replayed?.length, shown.length, `core: a replayed history keeps its length (${JSON.stringify(shown)} -> ${JSON.stringify(replayed)})`);
          } else {
            assert.equal((await history(page))?.viewportY, 0, "herdr: the wheel moves no local history");
          }

          // a phone's swipe: a finger moving down shows older lines
          await page.setViewportSize({ width: 390, height: 844 });
          // the refit at the phone's size moves the bottom: the swipe starts from where it settles
          let phone: History | null = null;
          for (let tries = 0; tries < 20; tries++) {
            await page.waitForTimeout(100);
            const now = await history(page);
            if (now && phone && JSON.stringify(now) === JSON.stringify(phone)) break;
            phone = now;
          }
          assert.ok(phone);
          const phoneBox = await terminal.boundingBox();
          assert.ok(phoneBox);
          const cdp = await context.newCDPSession(page);
          const x = phoneBox.x + phoneBox.width / 2, y = phoneBox.y + phoneBox.height / 4;
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
          for (let step = 1; step <= 6; step++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + step * 40 }] });
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await settled(page);
          if (kind === "core") await scrolledAbove(page, phone.viewportY, { x, y }, "core: a swipe scrolls back");
          else assert.equal((await history(page))?.viewportY, 0, "herdr: a swipe moves no local history");
          // xterm types arrow keys for a wheel it cannot scroll: scrolling the history never does
          const arrows = ["\x1b[A", "\x1b[B", "\x1bOA", "\x1bOB"];
          const typed = (await inputs(page)).filter((frame) => arrows.some((arrow) => JSON.stringify(frame).includes(JSON.stringify(arrow).slice(1, -1))));
          if (kind === "core") assert.deepEqual(typed, [], "core: scrolling the history types nothing");
          assert.deepEqual(errors, [], `${kind}: no page errors`);
          console.log(`PASS ${kind}: ${kind === "core" ? "wheel, swipe and a replay keep the browser's history" : "no local history"}`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
