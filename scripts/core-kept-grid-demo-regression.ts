/**
 * A herdr-core pane drawn by a page that does not size its pty: the window lost the focus, so the page keeps
 * whatever size the pty has, and another device sizes it. herdr-core's stream is the program's own bytes, drawn
 * for that pty, so the page takes the pty's grid (`pane-geometry`) as an observer does: in its own, a program's
 * full-width row wrapped, its cursor-up redraw landed a row short and the old frame's top stayed on screen,
 * one more copy at each redraw. Back in focus, or a click in the terminal when no focus event comes (a Mac
 * app's web view brought to the front), the page fits and sizes the pty again. herdr's own server draws
 * each attach at the attach's size, so there the page keeps its grid.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { withDemoBrowser } from "./demo-browser.ts";
import { appFaces } from "./app-faces.ts";
import { CLEAR_HISTORY } from "../server/herdr-core/attach-session.ts";

interface Frame { type: string; pane_id?: string; cols?: number; rows?: number; keep_size?: boolean }
interface GridFixture {
  sent: Frame[];
  focused: number;
  geometry(cols: number, rows: number): void;
  draw(data: string): void;
}
declare global { interface Window { gridFixture: GridFixture } }

function installGridFixture(clearHistory: string): void {
  const core = new URL(location.href).searchParams.get("server") === "core";
  const sockets: Array<WebSocket & { push(frame: Record<string, unknown>): void }> = [];
  let pane: string | null = null;
  let featured = false;
  let waiting: (() => void) | null = null;
  const own = (frame: Record<string, unknown>) => ({ ...frame, fixture: "grid" });
  const state: GridFixture = {
    sent: [],
    focused: 0,
    geometry: (cols, rows) => { for (const socket of sockets) if (pane) socket.push(own({ type: "pane-geometry", pane_id: pane, cols, rows })); },
    draw: (data) => { for (const socket of sockets) if (pane) socket.push(own({ type: "pty-data", pane_id: pane, data })); },
  };
  window.gridFixture = state;
  const Demo = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    const socket = new Demo(url, protocols) as (typeof sockets)[number];
    sockets.push(socket);
    const push = socket.push.bind(socket);
    socket.push = (frame) => {
      const listed = frame.type === "snapshot" || frame.type === "features";
      if (listed && Array.isArray(frame.features) && core) push({ ...frame, features: [...(frame.features as string[]), "terminal-history"] });
      else if (frame.type === "pty-data" || frame.type === "pane-geometry") {
        // the demo's own recording and sizes would move the screen under the test
        if (frame.fixture !== "grid") return;
        const { fixture: _, ...output } = frame;
        push(output);
      } else push(frame);
      if (listed) {
        featured = true;
        waiting?.();
        waiting = null;
      }
    };
    const send = socket.send.bind(socket);
    socket.send = (raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      if (frame.type === "attach" || frame.type === "resize") state.sent.push(frame);
      send(raw);
      if (frame.type === "attach" && frame.pane_id) {
        pane = frame.pane_id;
        const paint = () => socket.push(own({ type: "pty-data", pane_id: frame.pane_id, data: `${clearHistory}GRID-READY` }));
        if (featured) paint();
        else waiting = paint;
      }
    };
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Recorded, name, { value: Demo[name] });
  window.WebSocket = Recorded as unknown as typeof WebSocket;
}

interface Probe { grid: { cols: number; rows: number } }
const probe = (page: Page) => page.evaluate(() => {
  const host = document.querySelector(".pane-frame.is-current .pane-terminal") as (HTMLElement & { outputProbe?: () => Probe }) | null;
  return host?.outputProbe?.() ?? null;
});
const gridIs = (page: Page, cols: number, rows: number, step: string) => page.waitForFunction(([c, r]) => {
  const host = document.querySelector(".pane-frame.is-current .pane-terminal") as (HTMLElement & { outputProbe?: () => Probe }) | null;
  const grid = host?.outputProbe?.().grid;
  return grid?.cols === c && grid.rows === r;
}, [cols, rows] as const, { timeout: 5000 }).catch(async (cause: unknown) => {
  throw new Error(`${step}: the grid is ${JSON.stringify((await probe(page))?.grid)}, not ${cols}x${rows}`, { cause });
});
/** the rows libghostty draws for the pane */
const drawn = (page: Page) => page.evaluate(() => {
  const host = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal");
  const rows = host?.querySelectorAll(".ghostty-row") ?? [];
  return [...rows].map((row) => row.textContent ?? "");
});
const settled = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const sent = (page: Page) => page.evaluate(() => window.gridFixture.sent);

/** An inline TUI's frame and its redraw, for a pty `cols` wide: the block's bar fills the row, the redraw climbs two rows */
const frames = (cols: number): string => {
  const bar = "=".repeat(cols - 1);
  return `\x1b[2J\x1b[HBLOCK-1\r\n${bar}\r\nSTATUS-1` + `\x1b[2A\r\x1b[2KBLOCK-2\r\n\x1b[2K${bar}\r\n\x1b[2KSTATUS-2`;
};

const evidence = process.env["UI_EVIDENCE_DIR"];
await withDemoBrowser({ tempPrefix: "herdr-core-kept-grid-demo-", afterTransport: `\n<script>(${installGridFixture.toString()})(${JSON.stringify(CLEAR_HISTORY)})</script>` }, async ({ newContext, baseUrl }) => {
  for (const kind of ["core", "herdr"] as const) {
    const context = await newContext({ viewport: { width: 1280, height: 900 } });
    try {
      await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", terminalInputMode: "direct", alertsOn: false })));
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${baseUrl}?pane=${encodeURIComponent(panes.shell)}&view=terminal&server=${kind}`);
      await page.locator(".conn-live").waitFor();
      await appFaces(page);
      await page.waitForFunction(() => document.querySelector(".pane-frame.is-current .pane-terminal")?.textContent?.includes("GRID-READY"));
      await settled(page);
      const own = (await probe(page))?.grid;
      assert.ok(own, `${kind}: the test build's output probe answers`);
      assert.ok((await sent(page)).some((frame) => frame.type === "attach" && frame.keep_size !== true), `${kind}: the focused page sizes the pty it attaches`);

      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      const other = { cols: own.cols + 40, rows: own.rows - 10 };
      await page.evaluate(({ cols, rows }) => window.gridFixture.geometry(cols, rows), other);
      await page.evaluate((data) => window.gridFixture.draw(data), frames(other.cols));
      await page.waitForFunction(() => document.querySelector(".pane-frame.is-current .pane-terminal")?.textContent?.includes("STATUS-2"));
      await settled(page);
      if (evidence) await page.locator(".pane-frame.is-current .pane-terminal").screenshot({ path: join(evidence, `core-kept-grid-${kind}.png`) });
      if (kind === "core") {
        await gridIs(page, other.cols, other.rows, "core: a page that keeps the pty's size takes its grid");
        const blocks = (await drawn(page)).filter((row) => /BLOCK-\d/.test(row));
        assert.deepEqual(blocks.map((row) => row.trim()), ["BLOCK-2"], `core: the redraw replaces the old frame, no copy of it stays (${JSON.stringify(await drawn(page))})`);
      } else {
        await gridIs(page, own.cols, own.rows, "herdr: the page keeps its own grid");
      }

      const sizesAgain = async (how: string, act: () => Promise<void>): Promise<void> => {
        const resizesBefore = (await sent(page)).filter((frame) => frame.type === "resize").length;
        await act();
        await gridIs(page, own.cols, own.rows, `${kind}: ${how}, the page fits its own grid`);
        if (kind !== "core") return;
        await page.waitForFunction((before) => window.gridFixture.sent.filter((frame) => frame.type === "resize").length > before, resizesBefore);
        const last = (await sent(page)).filter((frame) => frame.type === "resize").at(-1);
        assert.deepEqual({ cols: last?.cols, rows: last?.rows }, own, `core: ${how}, the page sizes the pty to its grid`);
      };
      await sizesAgain("back in focus", async () => { await page.evaluate(() => window.dispatchEvent(new Event("focus"))); });

      await page.evaluate(({ cols, rows }) => window.gridFixture.geometry(cols, rows), other);
      await settled(page);
      await gridIs(page, own.cols, own.rows, `${kind}: a page that sizes the pty keeps its own grid when another device sizes it`);
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      if (kind === "core") await gridIs(page, other.cols, other.rows, "core: away, the page takes the grid it last heard of");
      const box = await page.locator(".pane-frame.is-current .pane-terminal").boundingBox();
      assert.ok(box);
      await page.evaluate(() => { window.gridFixture.focused = 0; window.addEventListener("focus", () => { window.gridFixture.focused++; }); });
      await sizesAgain("a click in the terminal with no focus event", () => page.mouse.click(box.x + 20, box.y + 20));
      assert.equal(await page.evaluate(() => window.gridFixture.focused), 0, `${kind}: the click came with no window focus event`);
      assert.deepEqual(errors, [], `${kind}: no page errors`);
      console.log(`PASS ${kind}: ${kind === "core" ? "a kept pty's grid is taken, then the page's own again" : "the page keeps its own grid"}`);
    } finally {
      await context.close();
    }
  }
});
