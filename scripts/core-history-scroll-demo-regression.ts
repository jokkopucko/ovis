/**
 * A herdr-core server's terminal history (#2663): its `terminal-history` feature keeps the scrollback in
 * the terminal, so the wheel and a phone's swipe scroll back through the history its attach replays first, a
 * replay erases the last one's instead of doubling it, and nothing is typed to the program. herdr's
 * own server keeps none (its TUI does).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { withDemoBrowser } from "./demo-browser.ts";
import { appFaces } from "./app-faces.ts";
import { CLEAR_HISTORY } from "../server/herdr-core/attach-session.ts";
import { SUPPORTED_ENTRIES } from "../src/lib/themes.generated.ts";
import { openLens } from "./header-lens.ts";

interface Frame { type: string; pane_id?: string; data?: string; features?: string[] }
interface HistoryFixture {
  inputs: Frame[];
  replay(): void;
  /** the pty taken to another device's grid, as the server tells a viewer that does not drive it */
  geometry(cols: number, rows: number): void;
  output(data: string): void;
}
declare global { interface Window { historyFixture: HistoryFixture } }

function installHistoryFixture(clearHistory: string): void {
  const core = new URL(location.href).searchParams.get("server") === "core";
  const lines = Array.from({ length: 300 }, (_, index) => `HIST-${String(index + 1).padStart(3, "0")}`);
  const stream = `${clearHistory}${lines.join("\r\n")}`;
  const sockets: Array<WebSocket & { push(frame: Record<string, unknown>): void }> = [];
  let pane: string | null = null;
  // a server lists its features before any pane's bytes; the demo lists them in its snapshot, after
  let featured = false;
  let waiting: (() => void) | null = null;
  const state: HistoryFixture = {
    inputs: [],
    replay: () => { for (const socket of sockets) if (pane) socket.push({ type: "pty-data", fixture: "history", pane_id: pane, data: stream }); },
    geometry: (cols, rows) => { for (const socket of sockets) if (pane) socket.push({ type: "pane-geometry", pane_id: pane, cols, rows }); },
    output: (data) => { for (const socket of sockets) if (pane) socket.push({ type: "pty-data", fixture: "history", pane_id: pane, data }); },
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

/** the rows libghostty draws for the pane */
const drawn = (page: Page) => page.evaluate(() => {
  const host = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal");
  const rows = host?.querySelectorAll(".ghostty-row") ?? [];
  return [...rows].map((row) => row.textContent ?? "");
});
const topShown = async (page: Page) => Math.min(...(await drawn(page)).flatMap((row) => /HIST-(\d{3})/.exec(row)?.[1] ?? []).map(Number));
const showsNewest = (page: Page) => page.waitForFunction(() => {
  const host = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal");
  const rows = host?.querySelectorAll(".ghostty-row") ?? [];
  return [...rows].some((row) => row.textContent?.includes("HIST-300"));
});
const settled = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
interface History { scrollback: number; length: number; viewportY: number; baseY: number }
const history = (page: Page) => page.evaluate(() => {
  const host = document.querySelector(".pane-frame.is-current .pane-terminal") as (HTMLElement & { outputProbe?: () => { history: History } }) | null;
  return host?.outputProbe?.().history ?? null;
});
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
const atBottom = (page: Page) => page.waitForFunction(() => {
  const host = document.querySelector(".pane-frame.is-current .pane-terminal") as (HTMLElement & { outputProbe?: () => { history: History } }) | null;
  const now = host?.outputProbe?.().history;
  return now !== undefined && now.viewportY === now.baseY;
});
const evidence = process.env["UI_EVIDENCE_DIR"];

await withDemoBrowser({ tempPrefix: "herdr-core-history-demo-", afterTransport: `\n<script>(${installHistoryFixture.toString()})(${JSON.stringify(CLEAR_HISTORY)})</script>` }, async ({ newContext, baseUrl }) => {
  for (const kind of ["core", "herdr"] as const) {
    const context = await newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true });
    try {
      await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", terminalInputMode: "direct", alertsOn: false })));
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${baseUrl}?pane=${encodeURIComponent(panes.shell)}&view=terminal&server=${kind}`);
      await page.locator(".conn-live").waitFor();
      await appFaces(page);
      await showsNewest(page);
      await settled(page);
      const shown = await history(page);
      assert.ok(shown, `${kind}: the test build's output probe answers`);
      if (kind === "core") {
        assert.ok(shown.scrollback > 0, "core: the browser keeps the scrollback");
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
      const topBefore = await topShown(page);
      await page.mouse.wheel(0, -600);
      await settled(page);
      if (kind === "core") {
        await scrolledAbove(page, shown.viewportY, { x: box.x + box.width / 2, y: box.y + box.height / 3 }, "core: the wheel scrolls back");
        await page.waitForFunction((before) => {
          const host = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal");
          const rows = host?.querySelectorAll(".ghostty-row") ?? [];
          return [...rows].some((row) => Number(/HIST-(\d{3})/.exec(row.textContent ?? "")?.[1] ?? Infinity) < before);
        }, topBefore, { timeout: 5000 }).catch(async (cause: unknown) => {
          throw new Error(`core: the wheel moved the view but the rows drawn still start at HIST-${topBefore}:`, { cause });
        });
        const jump = page.locator(".pane-frame.is-current .terminal-jump-bottom");
        await jump.waitFor();
        await jump.click();
        await page.waitForFunction(() => {
          const host = document.querySelector(".pane-frame.is-current .pane-terminal") as (HTMLElement & { outputProbe?: () => { history: History } }) | null;
          const now = host?.outputProbe?.().history;
          return now !== undefined && now.viewportY === now.baseY;
        });
        await jump.waitFor({ state: "detached" });
        await page.mouse.wheel(0, -600);
        await jump.waitFor();
        await jump.focus();
        const sentBefore = (await inputs(page)).length;
        await page.keyboard.press("Enter");
        await jump.waitFor({ state: "detached" });
        assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea") ?? false), false, "core: the press leaves the terminal unfocused");
        assert.equal((await inputs(page)).length, sentBefore, "core: the press types nothing");
        await page.mouse.wheel(0, 20000);
        await page.waitForFunction(() => {
          const host = document.querySelector(".pane-frame.is-current .pane-terminal") as (HTMLElement & { outputProbe?: () => { history: History } }) | null;
          const now = host?.outputProbe?.().history;
          return now !== undefined && now.viewportY === now.baseY;
        });
        await page.evaluate(() => window.historyFixture.replay());
        await showsNewest(page);
        await settled(page);
        const replayed = await history(page);
        assert.equal(replayed?.length, shown.length, `core: a replayed history keeps its length (${JSON.stringify(shown)} -> ${JSON.stringify(replayed)})`);
      } else {
        assert.equal((await history(page))?.viewportY, 0, "herdr: the wheel moves no local history");
      }

      await page.setViewportSize({ width: 390, height: 844 });
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
  for (const theme of ["dark", "light"] as const) {
    const context = await newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
    try {
      await context.addInitScript((value) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: value, alertsOn: false })), theme);
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${baseUrl}?pane=${encodeURIComponent(panes.api)}&view=terminal&server=core`);
      await page.locator(".conn-live").waitFor();
      await appFaces(page);
      await showsNewest(page);
      await settled(page);
      const box = (await page.locator(".pane-frame.is-current .pane-terminal").boundingBox())!;
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 3 };
      await page.mouse.move(at.x, at.y);
      const start = (await history(page))!;
      await page.mouse.wheel(0, -600);
      await scrolledAbove(page, start.viewportY, at, `${theme}: read up before the switch`);
      const jump = page.locator(".pane-frame.is-current .terminal-jump-bottom");
      await jump.waitFor();
      const still = await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
      const measure = () => page.evaluate(async ({ entries, mode }) => {
        const root = document.documentElement;
        const was = { theme: root.dataset["theme"], palette: root.dataset["palette"] };
        const rgb = (color: string): number[] => {
          const probe = document.createElement("canvas").getContext("2d")!;
          probe.fillStyle = color;
          probe.fillRect(0, 0, 1, 1);
          return [...probe.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        const lum = (c: number[]): number => { const [r, g, b] = c.map((v) => v / 255).map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
        const ratio = (a: string, b: string): number => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
        const jump = document.querySelector(".pane-frame.is-current .terminal-jump-bottom")!;
        const found: { entry: string; edge: number }[] = [];
        for (const entry of entries.filter((each) => each.mode === mode)) {
          root.dataset["theme"] = entry.mode;
          root.dataset["palette"] = entry.id;
          const edge = getComputedStyle(jump).borderTopColor;
          const ground = getComputedStyle(root).getPropertyValue("--term-bg").trim();
          found.push({ entry: `${entry.id} ${entry.mode}`, edge: Math.round(ratio(edge, ground) * 100) / 100 });
        }
        root.dataset["theme"] = was.theme;
        if (was.palette === undefined) delete root.dataset["palette"]; else root.dataset["palette"] = was.palette;
        return found;
      }, { entries: SUPPORTED_ENTRIES.map((entry) => ({ id: entry.id, mode: entry.mode })), mode: theme });
      const resting = await measure();
      await jump.hover();
      const hovered = await measure();
      await page.mouse.move(at.x, at.y);
      await still.evaluate((node) => node.remove());
      const contrasts = resting.map((each, index) => ({ entry: each.entry, edge: Math.min(each.edge, hovered[index]!.edge), rest: each.edge, hover: hovered[index]!.edge }));
      if (evidence) await page.screenshot({ path: join(evidence, `terminal-jump-bottom-1440-${theme}.png`) });
      await page.locator(".view-switch .lens-option.is-chat").click();
      await page.locator('.view-switch .lens-option.is-chat[aria-pressed="true"]').waitFor();
      await page.locator(".view-switch .lens-option.is-terminal").click();
      await page.locator('.view-switch .lens-option.is-terminal[aria-pressed="true"]').waitFor();
      await atBottom(page).catch(async (cause: unknown) => { throw new Error(`${theme}: back on the terminal the view is not at its newest rows: ${JSON.stringify(await history(page))}`, { cause }); });
      await jump.waitFor({ state: "detached" });
      const landed = (await history(page))!;
      await page.mouse.move(at.x, at.y);
      await page.mouse.wheel(0, -600);
      await scrolledAbove(page, landed.viewportY, at, `${theme}: read up after the switch`);
      const readUp = (await history(page))!;
      await settled(page);
      assert.equal((await history(page))!.viewportY, readUp.viewportY, `${theme}: after the switch the reader's own scroll stands`);
      await page.mouse.move(box.x + 40, box.y + box.height / 4);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 4 + 60, { steps: 6 });
      await page.mouse.up();
      const selectionRows = () => page.evaluate(() => document.querySelectorAll(".pane-frame.is-current .xterm-selection div").length);
      assert.ok(await selectionRows() > 0, `${theme}: a drag selects rows of the history`);
      await page.locator(".view-switch .lens-option.is-chat").click();
      await page.locator('.view-switch .lens-option.is-chat[aria-pressed="true"]').waitFor();
      await page.locator(".view-switch .lens-option.is-terminal").click();
      await page.locator('.view-switch .lens-option.is-terminal[aria-pressed="true"]').waitFor();
      await settled(page);
      assert.ok(await selectionRows() > 0, `${theme}: the selection is still there back on the terminal`);
      assert.equal((await history(page))!.viewportY, readUp.viewportY, `${theme}: a switch with a selection being made leaves the view on its rows`);
      const faint = contrasts.filter((each) => each.edge < 3);
      assert.deepEqual(faint, [], `${theme}: the way to the bottom stands out from the terminal in every theme, at rest and hovered (edge contrast ${JSON.stringify(contrasts)})`);
      assert.deepEqual(errors, [], `${theme}: no page errors`);
      console.log(`PASS ${theme}: from the chat back to the terminal shows its newest rows once (not under a selection being made), and the way to the bottom stands out over every theme's terminal (${contrasts.map((each) => `${each.entry} ${each.edge}`).join(", ")})`);
    } finally {
      await context.close();
    }
  }
  {
    // another device drives the pty at its own grid while the chat covers this one: back on the terminal, the
    // grid fitted to this page lands at the newest rows and output that follows keeps it there
    const context = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    try {
      await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertsOn: false })));
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${baseUrl}?pane=${encodeURIComponent(panes.shell)}&view=terminal&server=core`);
      await page.locator(".conn-live").waitFor();
      await appFaces(page);
      await showsNewest(page);
      await settled(page);
      // a long session (#4688: 50k lines, the scrollback full), then rows longer than the phone's grid: the desktop's
      // wide grid holds each on one row, the phone's wraps it
      await page.evaluate(() => window.historyFixture.output(Array.from({ length: 50_000 }, (_, line) => `\r\nLONG-${line + 1}`).join("")));
      await settled(page);
      await page.evaluate(() => window.historyFixture.output(Array.from({ length: 200 }, (_, line) => `\r\nWIDE-${String(line + 1).padStart(3, "0")} ${"w".repeat(70)}`).join("")));
      await settled(page);
      for (let round = 1; round <= 10; round++) {
        await openLens(page, "chat", "tap");
        await page.locator('.app-header .lens-toggle[data-view="chat"]').waitFor();
        await page.evaluate(() => window.historyFixture.geometry(120, 42));
        await settled(page);
        await openLens(page, "terminal", "tap");
        await page.locator('.app-header .lens-toggle[data-view="terminal"]').waitFor();
        await settled(page);
        await page.evaluate((n) => window.historyFixture.output(Array.from({ length: 5 }, (_, line) => `\r\nNEW-${n}-${line + 1}`).join("")), round);
        await page.waitForFunction((last) => {
          const host = document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal");
          const rows = host?.querySelectorAll(".ghostty-row") ?? [];
          return [...rows].some((row) => row.textContent?.trim() === last);
        }, `NEW-${round}-5`).catch(async (cause: unknown) => {
          throw new Error(`round ${round}: the newest output is not in view after the switch: ${JSON.stringify(await history(page))} ${JSON.stringify(await drawn(page))}`, { cause });
        });
        await settled(page);
        const now = (await history(page))!;
        assert.equal(now.viewportY, now.baseY, `round ${round}: after a switch back from another device's grid the view stays at the newest rows (${JSON.stringify(now)})`);
        assert.equal(await page.locator(".pane-frame.is-current .terminal-jump-bottom").count(), 0, `round ${round}: no Jump to bottom at the newest rows`);
      }
      assert.deepEqual(errors, [], "no page errors");
      console.log("PASS core: back from the chat to a grid another device sized, the terminal lands at its newest rows and follows the output after it");
    } finally {
      await context.close();
    }
  }
});
