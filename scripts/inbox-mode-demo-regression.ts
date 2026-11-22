import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { SECOND_TAP_MS } from "../src/lib/useSidebarLayout.ts";
import type { Machine } from "../shared/machines.ts";
import type { AgentStatus } from "../shared/protocol.ts";
import { SHEET_HISTORY_KEY } from "../src/lib/historyKeys.ts";
import { KO } from "../src/lib/i18n.ko.ts";
import { serveDemo } from "./demo-server.ts";
import type { TerminalTimerTestWindow } from "../src/lib/paneTerminalShared.ts";

declare global {
  interface Window {
    inboxFixture: {
      rosters: number;
      readonly rosterOpen: boolean;
      readonly pendingTerminalTimers: number;
      historyPending(paneId: string): boolean;
      publish(): Promise<void>;
      /** sets a pane's state as herdr would: its pane-status event, then the roster */
      set(paneId: string, status: AgentStatus, finish?: number): Promise<void>;
      resizes: { pane: string; cols: number; rows: number }[];
      frames: { type: string; pane: string; cols?: number; rows?: number }[];
      /**
       * loses the roster's event stream, and gives it back, as a browser's EventSource does while it reconnects: the
       * demo carries the roster on its stand-in for the stream, which its own connection switch does not reach
       */
      dropRoster(): void;
      restoreRoster(): void;
      failRoster(failing: boolean): void;
      holdRoster(holding: boolean): void;
      rosterReads: number;
    };
    inboxShells: string[];
    herdrDemoLoseConnection(): void;
    herdrDemoRestoreConnection(): void;
  }
}

// Holds the demo's agents still, whatever its own timers do: Codex waits for an answer, Claude works
// (the demo would finish it 4.5s in), the flaky-test agent is done and not looked at, the rest are idle.
// Loaded after demo-transport.js and before the app; what it forces survives a reload.
function installInboxFixture(): void {
  const key = "inbox-mode-regression:forced";
  const stored = sessionStorage.getItem(key);
  const state: { epoch: string; forced: Record<string, { status: AgentStatus; finish: number }> } = stored ? JSON.parse(stored) : {
    epoch: `inbox-fixture-${Date.now()}`,
    forced: {
      "w1D:p1": { status: "blocked", finish: 0 },
      "w1C:p1": { status: "working", finish: 0 },
      "w1H:p1": { status: "done", finish: 1 },
      "w1J:p1": { status: "idle", finish: 0 },
      "w1K:p1": { status: "idle", finish: 0 },
      "w1L:p1": { status: "idle", finish: 0 },
    },
  };
  const save = (): void => sessionStorage.setItem(key, JSON.stringify(state));
  save();
  const patch = (machines: Machine[]): Machine[] => {
    for (const machine of machines) {
      const snapshot = machine.snapshot;
      if (!snapshot) continue;
      snapshot.finish_epoch = `${state.epoch}:${machine.id}`;
      for (const pane of snapshot.panes) {
        const forced = state.forced[pane.pane_id];
        if (forced) { pane.agent_status = forced.status; pane.finish_id = forced.finish; }
      }
      for (const agent of snapshot.agents) {
        const forced = state.forced[agent.pane_id];
        if (forced) agent.agent_status = forced.status;
      }
    }
    return machines;
  };
  const sources = new Set<EventSource>();
  const opened = new Set<EventSource>();
  let rosterDropped = false;
  let rosterFails = new URLSearchParams(location.search).get("inbox_fail") === "roster";
  let rosterHeld: (() => void)[] | null = null;
  const historyReads = new Set<{ paneId: string | null }>();
  const fetchDemo = window.fetch;
  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.pathname === "/api/pane/conversation") {
      const read = { paneId: url.searchParams.get("pane_id") };
      historyReads.add(read);
      try { return await fetchDemo(input, init); }
      finally { historyReads.delete(read); }
    }
    if (url.pathname === "/api/machines") window.inboxFixture.rosterReads++;
    if (url.pathname === "/api/machines" && rosterHeld !== null) await new Promise<void>((go) => rosterHeld!.push(go));
    if (rosterFails && url.pathname === "/api/machines") return Response.json({ error: { code: "internal", message: "The roster could not be read" } }, { status: 500 });
    const response = await fetchDemo(input, init);
    if (url.pathname !== "/api/machines" || !response.ok) return response;
    const body = await response.json();
    return Response.json({ ...body, machines: patch(body.machines) });
  }, fetchDemo);
  const DemoSource = window.EventSource;
  window.EventSource = class extends DemoSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      sources.add(this);
      const close = this.close.bind(this);
      this.close = () => { sources.delete(this); opened.delete(this); close(); };
      let onOpen: EventSource["onopen"] = null;
      Object.defineProperty(this, "onopen", {
        get: () => (event: Event) => {
          if (rosterDropped) return;
          opened.add(this);
          onOpen?.call(this, event);
        },
        set: (handler: EventSource["onopen"]) => { onOpen = handler; },
      });
      let receive: EventSource["onmessage"] = null;
      Object.defineProperty(this, "onmessage", {
        get: () => (event: MessageEvent<string>) => {
          if (rosterDropped) return;
          const body = JSON.parse(event.data);
          if (body.type === "machines" && rosterFails) return;
          if (body.type === "machines") { body.machines = patch(body.machines); window.inboxFixture.rosters++; }
          if (body.type === "machine-message" && body.message.type === "pane-status") {
            body.message.finish_epoch = `${state.epoch}:${body.machine_id}`;
            const forced = state.forced[body.message.pane_id];
            if (forced) { body.message.agent_status = forced.status; body.message.finish_id = forced.finish; }
          }
          receive?.call(this, new MessageEvent("message", { data: JSON.stringify(body) }));
        },
        set: (handler: EventSource["onmessage"]) => { receive = handler; },
      });
    }
  };
  const send = (body: unknown): void => {
    for (const source of sources) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify(body) }));
  };
  // the demo's socket is a class of its own that no browser event reports: each size the app asks of a pty is noted
  const DemoSocket = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    const socket = new DemoSocket(url, protocols);
    const sendFrame = socket.send.bind(socket);
    socket.send = (data: Parameters<WebSocket["send"]>[0]): void => {
      if (typeof data === "string") {
        const frame = JSON.parse(data);
        if (frame.type === "resize") window.inboxFixture.resizes.push({ pane: frame.pane_id, cols: frame.cols, rows: frame.rows });
        if (["attach", "detach", "resize", "release-size"].includes(frame.type)) window.inboxFixture.frames.push({ type: frame.type, pane: frame.pane_id, cols: frame.cols, rows: frame.rows });
      }
      sendFrame(data);
    };
    return socket;
  } as unknown as typeof WebSocket;
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Recorded, name, { value: DemoSocket[name] });
  window.WebSocket = Recorded;

  // The app marks fits, delayed releases and view holds at their source. Hidden terminal
  // viewports also schedule one-second polls; those must not keep the quiet check waiting.
  const pendingTerminalTimers = new Set<number>();
  const timers: TerminalTimerTestWindow = window;
  const clearTimer = timers.clearTimeout.bind(window);
  timers.__herdrTestTerminalTimeout = (run, delay) => {
    const id = timers.setTimeout(() => {
      pendingTerminalTimers.delete(id);
      run();
    }, delay);
    pendingTerminalTimers.add(id);
    return id;
  };
  timers.clearTimeout = (id) => {
    if (id !== undefined) pendingTerminalTimers.delete(id);
    clearTimer(id);
  };
  window.inboxFixture = {
    rosters: 0,
    get rosterOpen() { return opened.size > 0; },
    get pendingTerminalTimers() { return pendingTerminalTimers.size; },
    historyPending(paneId) { return [...historyReads].some((read) => read.paneId === paneId); },
    resizes: [],
    frames: [],
    async publish() {
      const { machines } = await (await fetch("/api/machines")).json();
      send({ type: "machines", machines });
    },
    async set(paneId, status, finish = 0) {
      state.forced[paneId] = { status, finish };
      save();
      send({ type: "machine-message", machine_id: "local", message: { type: "pane-status", pane_id: paneId, agent_status: status, finish_id: finish, finish_epoch: `${state.epoch}:local` } });
      await this.publish();
    },
    dropRoster() {
      // Until restored, the fake stream ignores every message and open, including send() from set() and publish().
      rosterDropped = true;
      for (const source of opened) { Object.assign(source, { readyState: 0 }); source.onerror?.(new Event("error")); }
      opened.clear();
    },
    restoreRoster() {
      rosterDropped = false;
      for (const source of sources) { Object.assign(source, { readyState: 1 }); source.onopen?.(new Event("open")); }
    },
    failRoster(failing) { rosterFails = failing; },
    holdRoster(holding) {
      if (holding) { rosterHeld ??= []; return; }
      const held = rosterHeld ?? [];
      rosterHeld = null;
      for (const go of held) go();
    },
    rosterReads: 0,
  };
}

// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const BLOCKED = "w1D:p1";
const WORKING = "w1C:p1";
const DONE = "w1H:p1";
const IDLE = ["w1J:p1", "w1K:p1", "w1L:p1"];
const BLOCKED_TITLE = "Guard the export button";
const WORKING_TITLE = "Idempotent payments";
const ABSENT = [".inbox-filters", ".inbox-chip", ".inbox-place", ".inbox-title", ".inbox-dot", ".tab-strip", ".context-tabs", ".view-switch", ".status-bar", "#drawer-toggle", "#workspace-drawer", ".sidebar-toggle", ".pane-split.is-split"];
const PHONE = { width: 390, height: 844 };
const app = mkdtempSync(join(tmpdir(), "ovis-inbox-mode-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
/**
 * The part of the script that runs, so each part fits the browser lane's limit for one script (600 s): `themes` (this
 * file, both themes), `panes` (scripts/inbox-mode-panes-demo-regression.ts) and `rail`
 * (scripts/inbox-mode-rail-demo-regression.ts), each from its own browser and app.
 */
const part = process.env["INBOX_MODE_PART"] ?? "themes";
if (!["themes", "panes", "rail"].includes(part)) throw new Error(`INBOX_MODE_PART is themes, panes or rail, not ${part}`);
const errors: string[] = [];
const failures: string[] = [];

type Settings = Record<string, unknown>;
interface Box { x: number; y: number; w: number; h: number; right: number; bottom: number }
interface Row { pane: string | null; machine: string | null; state: string | null; name: string; words: string | null; mark: string | null; markLabel: string | null; asking: boolean; time: string | null; datetime: string | null; buttons: number; current: string | null }
interface Address { app: string | null; pane: string | null; machine: string | null }

const rows = (page: Page): Promise<Row[]> => page.locator(".mode-inbox .inbox-item").evaluateAll((items) => items.map((item) => {
  const mark = item.querySelector(".inbox-state.is-drawn .sidebar-status");
  return {
    pane: item.getAttribute("data-pane"), machine: item.getAttribute("data-machine"), state: item.getAttribute("data-state"),
    name: item.querySelector(".inbox-name")?.textContent ?? "", words: item.querySelector(".inbox-words")?.textContent ?? null,
    mark: mark?.getAttribute("data-status") ?? null, markLabel: mark?.getAttribute("aria-label") ?? null, asking: item.classList.contains("is-asking"),
    time: item.querySelector("time.inbox-time")?.textContent ?? null, datetime: item.querySelector("time.inbox-time")?.getAttribute("datetime") ?? null,
    buttons: item.querySelectorAll("button").length, current: item.querySelector(".inbox-row")?.getAttribute("aria-current") ?? null,
  };
}));
const box = (page: Page, selector: string): Promise<Box> => page.locator(selector).first().evaluate((node) => {
  const r = node.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
});
const summaryShown = (page: Page) => page.waitForFunction((pane) => {
  const item = document.querySelector(`.mode-inbox .inbox-item[data-pane="${pane}"]`);
  return Boolean(item?.querySelector(".inbox-words")?.textContent?.trim()) && item?.querySelector("time.inbox-time") !== null;
}, DONE, { timeout: 15_000 });
const rowCount = (page: Page, count: number) => page.waitForFunction((n) => document.querySelectorAll(".mode-inbox .inbox-item").length === n, count, { timeout: 30_000 });
const questionShown = (page: Page) => page.waitForFunction((pane) =>
  /Allow command\?/.test(document.querySelector(`.mode-inbox .inbox-item[data-machine="local"][data-pane="${pane}"] .inbox-words`)?.textContent ?? ""), BLOCKED, { timeout: 15_000 });
const address = (page: Page): Promise<Address> => page.evaluate(() => {
  const query = new URL(location.href).searchParams;
  return { app: query.get("app"), pane: query.get("pane"), machine: query.get("machine") };
});
/** The address says `want`, for each parameter given. The app writes its address after it has drawn, so this waits for it. */
async function addressIs(page: Page, want: Partial<Address>, what: string): Promise<void> {
  const said = await page.waitForFunction((fields) => {
    const query = new URL(location.href).searchParams;
    return Object.entries(fields).every(([name, value]) => query.get(name) === value);
  }, want, { timeout: 5_000 }).then(() => true, () => false);
  if (!said) assert.fail(`${what}: the address says ${JSON.stringify(await address(page))}, wanted ${JSON.stringify(want)}`);
}
const historyLength = (page: Page): Promise<number> => page.evaluate(() => history.length);
const frames = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
async function terminalSettled(page: Page, attached?: number): Promise<void> {
  if (attached !== undefined) {
    await page.waitForFunction((count) => {
      const drawn = [...document.querySelectorAll("[data-layout-pane]")].filter((node) => (node.querySelector(".xterm-screen")?.getBoundingClientRect().width ?? 0) > 0);
      return drawn.length >= count && drawn.every((node) => {
        const frame = window.inboxFixture.frames.filter((frame) => frame.pane === node.getAttribute("data-layout-pane") && ["attach", "detach"].includes(frame.type)).at(-1);
        return frame?.type === "attach" && (frame.cols ?? 0) > 0 && (frame.rows ?? 0) > 0;
      });
    }, attached, { timeout: 15_000 });
  }
  // Finish transitions before delivering the final layout to the app's resize observers.
  await page.evaluate(() => Promise.allSettled(document.getAnimations()
    .filter((animation) => animation.playState === "running" && Number.isFinite(animation.effect?.getComputedTiming().endTime))
    .map((animation) => animation.finished)).then(() => undefined));
  await page.evaluate(() => new Promise<void>((resolve) => {
    const observer = new ResizeObserver(() => { observer.disconnect(); resolve(); });
    observer.observe(document.documentElement);
  }));
  await page.waitForFunction(() => window.inboxFixture.pendingTerminalTimers === 0, undefined, { timeout: 5_000 });
}
const row = (page: Page, pane: string, machine = "local") => page.locator(`.mode-inbox .inbox-item[data-machine="${machine}"][data-pane="${pane}"] .inbox-row`);
const near = (got: number, want: number, by: number, what: string): void => assert.ok(Math.abs(got - want) <= by, `${what}: ${got}, wanted ${want} within ${by}`);
const sameBox = (got: Box, want: Box, what: string): void => {
  for (const side of ["x", "y", "w", "h"] as const) near(got[side], want[side], 0.5, `${what} (${side})`);
};
interface RailButton { kind: string; name: string | null; title: string | null; current: string | null; pressed: string | null; popup: string | null; expanded: string | null; glyph: string | null; box: Box }
const railButtons = (page: Page): Promise<RailButton[]> => page.locator(".inbox-rail button").evaluateAll((nodes) => nodes.map((node) => {
  const r = node.getBoundingClientRect();
  return {
    kind: [...node.classList].find((name) => name.startsWith("inbox-rail-") && name !== "inbox-rail-item") ?? "",
    name: node.getAttribute("aria-label"), title: node.getAttribute("title"), current: node.getAttribute("aria-current"), pressed: node.getAttribute("aria-pressed"),
    popup: node.getAttribute("aria-haspopup"), expanded: node.getAttribute("aria-expanded"),
    glyph: node.querySelector("img.ovis-mark") ? "ovis-mark" : [...(node.querySelector("svg")?.classList ?? [])].find((name) => name.startsWith("lucide-")) ?? null,
    box: { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom },
  };
}));
const railNames = async (page: Page): Promise<(string | null)[]> => (await railButtons(page)).map((button) => button.name);
async function railCounts(page: Page, count: number, what: string): Promise<void> {
  const said = await page.waitForFunction((n) => {
    const button = document.querySelector(".inbox-rail .inbox-rail-waiting");
    return button?.getAttribute("aria-label") === `${n} waiting for you` && button.querySelector(".header-more-dot.is-waiting")?.getAttribute("data-count") === String(n);
  }, count, { timeout: 10_000 }).then(() => true, () => false);
  if (!said) assert.fail(`${what}: the rail's buttons are ${JSON.stringify(await railNames(page))}`);
}
interface TopRow { list: Box; rail: Box; controls: { kind: string; box: Box; hit: boolean; glyph: number[] }[]; sideways: number[] }
const topRow = (page: Page): Promise<TopRow> => page.evaluate(() => {
  const boxOf = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
  const list = document.querySelector<HTMLElement>(".inbox-column .mode-inbox")!;
  const scroller = list.querySelector<HTMLElement>(".inbox-scroll")!;
  return {
    list: boxOf(list), rail: boxOf(document.querySelector(".inbox-column .inbox-rail")!),
    controls: [...list.querySelectorAll(".inbox-top > :is(button, .inbox-search)")].filter((node) => node.getClientRects().length > 0).map((node) => {
      const at = boxOf(node);
      const glyph = node.querySelector(":scope > svg")?.getBoundingClientRect();
      return {
        kind: [...node.classList].find((name) => name.startsWith("inbox-") && name !== "inbox-round") ?? "", box: at,
        hit: document.elementFromPoint(at.x + at.w / 2, at.y + at.h / 2)?.closest(".inbox-top > *") === node, glyph: glyph ? [glyph.width, glyph.height] : [],
      };
    }),
    sideways: [list.scrollWidth - list.clientWidth, scroller.scrollWidth - scroller.clientWidth, document.documentElement.scrollWidth - document.documentElement.clientWidth],
  };
});
function topRowFits(top: TopRow, what: string): void {
  const places = `${top.controls.map((each) => `${each.kind} ${each.box.x} to ${each.box.right}`).join(", ")}, in a list from ${top.list.x} to ${top.list.right} after a rail that ends at ${top.rail.right}`;
  assert.ok(top.controls.length >= 2, `${what}: the top row holds its controls: ${places}`);
  let edge = Math.max(top.list.x, top.rail.right);
  for (const each of top.controls) {
    assert.ok(each.box.x >= edge - 0.1 && each.box.right <= top.list.right + 0.1, `${what}: ${each.kind} is inside the list, after the rail and the control before it: ${places}`);
    assert.ok(each.hit, `${what}: ${each.kind} is hit at its middle: ${places}`);
    edge = each.box.right;
  }
  assert.deepEqual(top.sideways, [0, 0, 0], `${what}: neither the list, its rows nor the page scrolls sideways`);
}
async function listScreen(page: Page): Promise<void> {
  await page.locator(".mode-inbox").waitFor();
  await page.locator(".app-header").waitFor({ state: "detached" });
  await addressIs(page, { app: "inbox", pane: null }, "the list's address says the mode and names no pane");
}
async function openThread(page: Page, pane: string, machine = "local"): Promise<void> {
  await row(page, pane, machine).tap();
  await page.locator(".mode-inbox").waitFor({ state: "detached" });
  await page.locator("#inbox-back").waitFor();
  await page.locator(".thread-title").waitFor();
  await addressIs(page, { app: "inbox", pane }, "a thread's address names its pane and keeps the mode");
}
async function backToList(page: Page): Promise<void> {
  await page.locator("#inbox-back").tap();
  await page.locator(".mode-inbox").waitFor();
}
async function openSheet(page: Page, button: string): Promise<void> {
  await page.locator(button).tap();
  await page.locator(".row-sheet").waitFor();
}
/**
 * A sheet that closed is gone from the page and from the history: one closed by an item that went nowhere, or by
 * Cancel, steps back off its own entry a moment later (lib/sheetHistory.ts). A press that pushed an entry before
 * that step landed would put it after the sheet's, and the step would land back on the sheet's. The next press
 * comes after the step.
 */
async function sheetClosed(page: Page): Promise<void> {
  await page.locator(".row-sheet").waitFor({ state: "detached" });
  await page.waitForFunction((key) => (history.state as Record<string, unknown> | null)?.[key] === undefined, SHEET_HISTORY_KEY, { timeout: 5_000 });
}
async function pickFilter(page: Page, choice: "all" | "blocked" | "working" | "done"): Promise<void> {
  await openSheet(page, ".inbox-filter-toggle");
  await page.locator(`.row-sheet [data-item="${choice}"]`).tap();
  await sheetClosed(page);
}
async function openDrawerForMark(page: Page): Promise<void> {
  await page.evaluate(() => {
    const heard = (event: MouseEvent): void => {
      if (!(event.target as Element | null)?.closest("#drawer-toggle")) return;
      document.removeEventListener("click", heard, true);
      (window as unknown as { drawerOpenedAt: number }).drawerOpenedAt = event.timeStamp;
    };
    document.addEventListener("click", heard, true);
  });
  await page.locator("#drawer-toggle").tap();
  await page.locator(".sidebar.is-open").waitFor();
  await page.waitForFunction((secondTapMs) => {
    const at = (window as unknown as { drawerOpenedAt?: number }).drawerOpenedAt;
    return at !== undefined && performance.now() - at >= secondTapMs;
  }, SECOND_TAP_MS, { timeout: 5_000 });
}
const OVIS_MARK = ".header-side .sidebar-brand.is-entry";
async function enterFromMore(page: Page): Promise<void> {
  await openSheet(page, ".header-more-button");
  await page.locator('.row-sheet [data-item="enter-inbox"]').tap();
  await sheetClosed(page);
  await listScreen(page);
}
async function terminalBox(page: Page): Promise<Box> {
  await page.waitForFunction(() => {
    const mount = document.querySelector(".terminal-stack:not(.is-chat) .pane-terminal .xterm-screen");
    return mount !== null && mount.getBoundingClientRect().width > 0;
  }, undefined, { timeout: 15_000 });
  await frames(page);
  return box(page, ".terminal-stack:not(.is-chat) .pane-terminal");
}
async function paneHiddenUnderList(page: Page, what: string): Promise<void> {
  const slots = await page.evaluate(() => [...document.querySelectorAll(".pane-slot")].map((node) => getComputedStyle(node).visibility));
  assert.ok(slots.length >= 1 && slots.every((visibility) => visibility === "hidden"), `${what}: ${slots.join()}`);
}
async function shot(page: Page, name: string): Promise<void> {
  if (!evidence) return;
  await appFaces(page);
  await page.screenshot({ path: join(evidence, name), animations: "disabled" });
}

async function withPage(browser: Browser, base: string, settings: Settings, path: string, what: string, run: (page: Page) => Promise<void>, viewport: { width: number; height: number } = PHONE, touch: boolean = viewport.width < 769, locale = "en-US"): Promise<void> {
  const context = await browser.newContext({ viewport, isMobile: touch, hasTouch: touch, locale });
  try {
    await context.addInitScript((seed) => {
      // the blank page the tab began on, which Back out of the app returns to, has no storage to seed
      if (location.protocol === "about:") return;
      if (sessionStorage.getItem("inbox-mode-regression:seeded")) return;
      sessionStorage.setItem("inbox-mode-regression:seeded", "1");
      const { phoneInbox, ...settings } = seed;
      localStorage.setItem("ovis:settings", JSON.stringify(settings));
      if (phoneInbox === true) localStorage.setItem("ovis:phone-inbox", JSON.stringify(true));
    }, settings);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`${what}: ${error.message}`));
    try {
      await page.goto(base + path);
      await run(page);
    } catch (error) {
      failures.push(what);
      console.log(`FAIL ${what}: ${error instanceof Error ? error.message : String(error)}`);
      if (evidence) await page.screenshot({ path: join(evidence, `inbox-mode-failure-${failures.length}.png`) }).catch(() => undefined);
    }
  } finally {
    await context.close();
  }
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(join(app, "inbox-fixture.js"), `(${installInboxFixture.toString()})();`);
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script src="./inbox-fixture.js"></script>\n    <script type="module"'));
  const server = serveDemo(app, { prefix: "/" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      if (evidence) mkdirSync(evidence, { recursive: true });
      for (const theme of part === "themes" ? ["light", "dark"] : []) {
        const off: Settings = { language: "en", theme };
        const on: Settings = { language: "en", theme, phoneInbox: true };
        const pass = (step: number, what: string) => console.log(`PASS ${theme} (${step}) ${what}`);
        const block = (what: string): string => `${theme}: ${what}`;

        await withPage(browser, base, off, "/", block("the entry in More, the list, a thread, the way out"), async (page) => {
          await page.locator(".pane-slot").first().waitFor();
          await page.locator("#drawer-toggle").waitFor();
          assert.equal(await page.locator(".mode-inbox").count(), 0, "a fresh device opens the classic app");
          await page.waitForFunction(() => new URL(location.href).searchParams.get("pane") !== null);
          await addressIs(page, { app: null }, "the classic app's address has no mode");
          const entries = await historyLength(page);
          await openSheet(page, ".header-more-button");
          const last = page.locator(".row-sheet .row-sheet-item").last();
          assert.equal(await last.getAttribute("data-item"), "enter-inbox", "More's last item is the way in");
          assert.equal((await last.locator(".row-sheet-label").textContent())?.trim(), "Open agent inbox");
          await shot(page, `inbox-mode-entry-390-${theme}.png`);
          await last.tap();
          await sheetClosed(page);
          await listScreen(page);
          assert.equal(await historyLength(page), entries + 1, "entering is one entry: the sheet's own was taken over");
          await paneHiddenUnderList(page, "the pane stays mounted under the list, hidden");
          pass(1, "More's last item, Open agent inbox, opens the list as the screen by one history entry, the pane mounted and hidden under it");

          await rowCount(page, 6);
          await questionShown(page);
          await summaryShown(page);
          await appFaces(page);
          for (const selector of ABSENT) assert.equal(await page.locator(selector).filter({ visible: true }).count(), 0, `the mode draws no ${selector}`);
          assert.equal(await page.locator(".mode-inbox :is(h1, h2, h3, h4, h5, h6, [role='heading'])").count(), 0, "the list has no heading");
          assert.equal(await page.locator(".mode-inbox").getAttribute("aria-label"), "Agent inbox");
          assert.equal(await page.locator(".mode-inbox .inbox-top button").count(), 2, "exactly two controls at the top");
          const { width, height } = page.viewportSize()!;
          const [more, add, filter, search] = await Promise.all([box(page, ".inbox-more"), box(page, ".inbox-add"), box(page, ".inbox-filter-toggle"), box(page, ".inbox-search-input")]);
          for (const [name, control] of [["More", more], ["New workspace", add], ["the filter", filter]] as const) assert.deepEqual([control.w, control.h], [44, 44], `${name} is 44 by 44`);
          near(more.x, 18, 2, "More's inset"); near(width - add.right, 18, 2, "New workspace's inset");
          near(more.y, 8, 0.5, "More under the top edge"); near(add.y, 8, 0.5, "New workspace under the top edge");
          near(filter.x, 18, 2, "the filter's inset"); near(width - search.right, 18, 2, "the search field's inset");
          assert.equal(search.h, 44, "the search field is 44 tall");
          near(search.x - filter.right, 12, 2, "between the filter and the search field");
          near(height - filter.bottom, 12, 2, "under the foot");
          near(search.w, width - 92, 2, "the search field's width");
          const boxes = await page.locator(".mode-inbox .inbox-item").evaluateAll((items) => items.map((item) => {
            const r = item.querySelector(".inbox-row")!.getBoundingClientRect();
            const a = item.querySelector(".inbox-avatar")!.getBoundingClientRect();
            const b = item.querySelector(".inbox-body")!.getBoundingClientRect();
            const words = item.querySelector(".inbox-words")!;
            return { top: r.top, height: r.height, avatar: [a.left, a.width, a.height], text: b.left - a.right, wordsHeight: words.getBoundingClientRect().height, wordsSize: getComputedStyle(words).fontSize, nameSize: getComputedStyle(item.querySelector(".inbox-name")!).fontSize };
          }));
          near(boxes[0]!.top - more.bottom, 16, 4, "the first row under the top controls");
          for (const item of boxes) {
            near(item.height, 80, 2, "a row's height");
            assert.deepEqual(item.avatar, [22, 44, 44], "the mark is 44px, 22px in");
            near(item.text, 16, 2, "from the mark to the text");
            assert.deepEqual([item.nameSize, item.wordsSize], ["16px", "15px"]);
            assert.ok(item.wordsHeight < 30, `the words are one line: ${item.wordsHeight}px`);
          }
          const drawn = await rows(page);
          assert.deepEqual(drawn.map((item) => item.pane), [BLOCKED, WORKING, DONE, ...drawn.slice(3).map((item) => item.pane)]);
          assert.deepEqual(new Set(drawn.slice(3).map((item) => item.pane)), new Set(IDLE));
          assert.deepEqual(drawn.map((item) => item.mark), ["blocked", "working", "done", null, null, null], "each state its own mark, none for a ready agent");
          assert.deepEqual(drawn.slice(0, 3).map((item) => item.markLabel), ["Needs you", "Working", "Done"], "a state's mark is named in the words its chip and the filters use");
          assert.deepEqual(drawn.map((item) => item.asking), [true, false, true, false, false, false], "the rows that ask for a look draw their words stronger");
          assert.deepEqual(drawn.map((item) => item.buttons), [1, 1, 1, 1, 1, 1], "a row is one button and holds no other");
          assert.match(drawn[0]!.words ?? "", /Allow command\?/);
          assert.ok((drawn[2]!.words ?? "").trim() !== "", "the done row says what its agent last said");
          assert.match(drawn[2]!.time ?? "", /^(<1m|\d+[mhd])$/, "the done row says how long it has been done");
          assert.ok(drawn[2]!.datetime !== null && !Number.isNaN(Date.parse(drawn[2]!.datetime)), "the done row's time carries a datetime");
          await shot(page, `inbox-mode-list-390-${theme}.png`);
          pass(2, "the list: no title and nothing the mode leaves out, two 44px round controls at the top and a round filter and a search pill at the foot on their insets, six 80px rows with a 44px mark, a 16px name and one 15px line, the waiting row first with its question, each state's own mark and none on the ready rows");

          await openSheet(page, ".inbox-filter-toggle");
          assert.equal(await page.locator('.row-sheet [role="menu"] [role="menuitemradio"]').count(), 4, "the four filters are one menu of radio items");
          assert.equal(await page.locator('.row-sheet [role="menuitemradio"][aria-checked="true"]').getAttribute("data-item"), "all");
          const focusedItem = (want: string | null, why: string): Promise<unknown> => page.waitForFunction((item) => {
            const at = document.activeElement;
            return item === null ? at?.classList.contains("row-sheet-cancel") === true : at?.getAttribute("data-item") === item;
          }, want, { timeout: 5_000 }).catch(() => { throw new Error(`the sheet's focus is not on ${want ?? "Cancel"}: ${why}`); });
          await focusedItem("all", "the sheet opens on the chosen filter");
          await page.keyboard.press("ArrowDown");
          await focusedItem("blocked", "ArrowDown moves to the next filter");
          await page.keyboard.press("ArrowUp");
          await page.keyboard.press("ArrowUp");
          await focusedItem("done", "ArrowUp from the first filter goes round to the last");
          assert.equal(await page.locator('.row-sheet [role="menuitemradio"][aria-checked="true"]').getAttribute("data-item"), "all", "the arrows choose nothing");
          await page.keyboard.press("ArrowUp");
          await focusedItem("working", "ArrowUp moves to the filter before");
          await page.keyboard.press("Tab");
          await focusedItem(null, "Tab from a middle filter leaves the four for Cancel");
          await page.keyboard.press("Tab");
          await focusedItem("all", "Tab comes back to the filters on the chosen one");
          await page.keyboard.press("Shift+Tab");
          await focusedItem(null, "Shift+Tab leaves the four filters for Cancel");
          await page.keyboard.press("Shift+Tab");
          await focusedItem("all", "Shift+Tab from Cancel comes back to the chosen filter, not the last one");
          await page.locator('.row-sheet [data-item="working"]').tap();
          await sheetClosed(page);
          await rowCount(page, 1);
          assert.equal((await rows(page))[0]!.pane, WORKING);
          assert.equal(await page.locator(".inbox-filter-toggle.is-on").getAttribute("aria-label"), "Filter by state: Working");
          await openSheet(page, ".inbox-filter-toggle");
          assert.equal(await page.locator('.row-sheet [role="menuitemradio"][aria-checked="true"]').getAttribute("data-item"), "working");
          await focusedItem("working", "the sheet opens on the chosen filter, not the first one");
          await page.locator('.row-sheet [data-item="all"]').tap();
          await sheetClosed(page);
          await rowCount(page, 6);
          assert.equal(await page.locator(".inbox-filter-toggle").getAttribute("aria-label"), "Filter by state");
          pass(3, "the filter's button opens All, Needs you, Working and Done as a menu of radio items that the arrows walk and Tab takes as one stop; Working narrows the list to its row and fills the button, All draws the six again");

          const field = page.locator(".inbox-search-input");
          await field.fill("export");
          await rowCount(page, 1);
          assert.equal(await page.locator(".mode-inbox .inbox-item .inbox-name").textContent(), BLOCKED_TITLE);
          await page.locator(".inbox-search-clear").tap();
          await rowCount(page, 6);
          assert.equal(await field.inputValue(), "");
          await field.fill("zzqq no such agent");
          await page.locator(".inbox-empty").waitFor();
          assert.equal(await page.locator(".inbox-empty").textContent(), "No results");
          await page.locator(".inbox-search-clear").tap();
          await rowCount(page, 6);
          pass(4, "search: export leaves one row, clearing it draws six, a query with no match says No results");

          await pickFilter(page, "blocked");
          await rowCount(page, 1);
          await openThread(page, BLOCKED);
          await page.locator(".prompt-card").first().waitFor();
          assert.equal((await page.locator(".thread-name").textContent())?.replace(/^Codex: /, ""), BLOCKED_TITLE);
          assert.equal(await page.locator(".thread-state").textContent(), "Needs you");
          for (const selector of ABSENT) assert.equal(await page.locator(selector).count(), 0, `a thread draws no ${selector}`);
          const dock = await page.evaluate(() => {
            const card = document.querySelector(".prompt-dock .prompt-card")!.getBoundingClientRect();
            const composer = document.querySelector(".composer-surface")!.getBoundingClientRect();
            return { above: card.bottom <= composer.top + 1, left: card.left - composer.left, right: card.right - composer.right };
          });
          assert.ok(dock.above && Math.abs(dock.left) <= 1 && Math.abs(dock.right) <= 1, `the prompt card is docked above the composer on its column: ${JSON.stringify(dock)}`);
          for (const selector of ["#inbox-back", ".lens-toggle", ".header-more-button"]) {
            const control = await box(page, selector);
            assert.ok(control.w >= 44 && control.h >= 44, `${selector} is a finger's size: ${control.w} by ${control.h}`);
            assert.equal(await page.locator(selector).evaluate((node) => node.classList.contains("is-outlined")), false, `${selector} has no box of its own`);
          }
          assert.equal(await page.locator(".header-more-dot.is-waiting").count(), 0, "More counts no waiting agent but the others");
          assert.doesNotMatch(await page.locator(".header-more-button").getAttribute("aria-label") ?? "", /waiting for you/);
          await shot(page, `inbox-mode-thread-390-${theme}.png`);
          pass(5, "a tap on the waiting row opens its chat under Back, the agent's name over Needs you, the monitor button and More as one family of plain buttons, the prompt card docked above the composer, and no count on More for the thread's own question");

          const lens = page.locator(".lens-toggle");
          assert.equal(await lens.getAttribute("aria-label"), "Show the terminal");
          await lens.tap();
          await page.locator('.lens-toggle[data-view="terminal"]').waitFor();
          assert.equal(await lens.getAttribute("aria-label"), "Show the chat");
          const inMode = await terminalBox(page);
          await shot(page, `inbox-mode-terminal-390-${theme}.png`);
          await lens.tap();
          await page.locator('.lens-toggle[data-view="chat"]').waitFor();
          await page.locator(".prompt-card").first().waitFor();

          await backToList(page);
          assert.equal(await page.evaluate(() => document.activeElement?.closest(".inbox-item")?.getAttribute("data-pane") ?? null), BLOCKED, "Back from a thread gives the focus to that thread's row");
          assert.equal(await page.locator(".inbox-filter-toggle.is-on").getAttribute("aria-label"), "Filter by state: Needs you");
          await rowCount(page, 1);
          await paneHiddenUnderList(page, "the opened pane stays mounted under the list, hidden");
          // six rows barely scroll on an 844px phone: the scroll is kept on a shorter one, where it has room to
          await pickFilter(page, "all");
          await rowCount(page, 6);
          await page.setViewportSize({ width: 390, height: 560 });
          const scroller = page.locator(".inbox-scroll");
          await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight; });
          await page.waitForFunction(() => (document.querySelector(".inbox-scroll")?.scrollTop ?? 0) > 0);
          const top = await scroller.evaluate((node) => node.scrollTop);
          const end = await page.evaluate(() => ({ row: [...document.querySelectorAll(".mode-inbox .inbox-item")].at(-1)!.getBoundingClientRect().bottom, foot: document.querySelector(".inbox-filter-toggle")!.getBoundingClientRect().top }));
          assert.ok(end.row <= end.foot, `at the list's end the last row ends above the foot's controls: row ${end.row}, foot ${end.foot}`);
          const lastPane = await page.locator(".mode-inbox .inbox-item").last().getAttribute("data-pane");
          assert.ok(lastPane !== null);
          await openThread(page, lastPane);
          await backToList(page);
          await questionShown(page);
          const kept = await page.waitForFunction((at) => Math.abs((document.querySelector(".inbox-scroll")?.scrollTop ?? -9) - at) <= 1, top, { timeout: 5_000 }).then(() => true, () => false);
          const now = await scroller.evaluate((node) => ({ top: node.scrollTop, range: node.scrollHeight - node.clientHeight }));
          assert.ok(kept, `the list scrolled to its end (${Math.round(top)}px) came back at ${Math.round(now.top)}px of ${Math.round(now.range)}px`);
          pass(6, `the monitor button shows the terminal in the thread's place and gives the chat back; Back returns to the list with its filter and its scroll (${Math.round(top)}px) kept, the pane mounted and hidden, the last row clear of the foot`);

          await page.setViewportSize(PHONE);
          await openSheet(page, ".inbox-more");
          assert.deepEqual(await page.locator(".row-sheet .row-sheet-item").evaluateAll((items) => items.map((item) => item.getAttribute("data-item"))), ["exit-inbox", "palette", "alerts", "settings"], "the list's More begins with the way out and the palette, and holds the app's items");
          assert.equal((await page.locator('.row-sheet [data-item="exit-inbox"] .row-sheet-label').textContent())?.trim(), "Back to Ovis");
          assert.equal(await page.locator('.row-sheet [data-item="exit-inbox"] img.ovis-mark').count(), 1, "Back to Ovis is drawn with the app's own mark, as at the column's foot");
          await shot(page, `inbox-mode-more-390-${theme}.png`);
          const inModeEntries = await historyLength(page);
          await page.locator('.row-sheet [data-item="exit-inbox"]').tap();
          await page.locator(".mode-inbox").waitFor({ state: "detached" });
          await page.locator("#drawer-toggle").waitFor();
          await sheetClosed(page);
          await addressIs(page, { app: null, pane: lastPane }, "Back to Ovis from the list leaves the mode's address and opens the pane under the list");
          assert.equal(await historyLength(page), inModeEntries, "leaving is one entry: the sheet's own was taken over");
          await page.goBack();
          await listScreen(page);
          await page.goForward();
          await page.locator("#drawer-toggle").waitFor();
          await addressIs(page, { app: null, pane: lastPane }, "Forward returns to the classic app on that pane");
          await page.goto(`${base}/?pane=${encodeURIComponent(BLOCKED)}&view=terminal`);
          const classic = await terminalBox(page);
          near(inMode.w, classic.w, 1, "the terminal's width in the mode against classic's");
          near(inMode.h, classic.h, 1, "the terminal's height in the mode against classic's");
          pass(7, `Back to Ovis, first in the list's More, opens the classic app on the pane under the list by one entry that Back undoes; a thread's terminal is the size classic's is (${Math.round(classic.w)} by ${Math.round(classic.h)})`);
        });

        await withPage(browser, base, off, "/?app=inbox", block("Back, Forward and reloads from the list's own address"), async (page) => {
          await listScreen(page);
          assert.equal(await page.locator(".pane-slot").count(), 0, "nothing is mounted for a pane under a cold list");
          await rowCount(page, 6);
          await openThread(page, WORKING);
          await page.goBack();
          await listScreen(page);
          await page.goForward();
          await page.locator("#inbox-back").waitFor();
          await page.locator(".mode-inbox").waitFor({ state: "detached" });
          await addressIs(page, { app: "inbox", pane: WORKING }, "Forward shows the thread again");
          pass(8, "the system Back shows the list and Forward the thread again");

          await page.reload();
          await page.locator("#inbox-back").waitFor();
          await page.locator(".thread-title").waitFor();
          assert.equal(await page.locator(".mode-inbox").count(), 0);
          await addressIs(page, { app: "inbox", pane: WORKING }, "a reload in a thread keeps the thread");
          await backToList(page);
          await page.reload();
          await listScreen(page);
          await rowCount(page, 6);
          pass(9, "a reload in a thread keeps the thread, and on the list the list");
        });

        await withPage(browser, base, off, "/?app=inbox", block("Back on a list opened by its own address"), async (page) => {
          await listScreen(page);
          await rowCount(page, 6);
          await page.goBack({ waitUntil: "commit" });
          await page.waitForURL("about:blank");
          pass(10, "opened by its own address, Back on the list leaves the app");
        });

        await withPage(browser, base, off, `/?app=inbox&pane=${encodeURIComponent(BLOCKED)}`, block("a thread opened by its own address"), async (page) => {
          await page.locator("#inbox-back").waitFor();
          await page.locator(".thread-title").waitFor();
          await page.locator(".pane-slot").first().waitFor();
          assert.equal(await page.locator(".mode-inbox").count(), 0, "an address naming a pane opens its thread");
          const entries = await historyLength(page);
          await backToList(page);
          await rowCount(page, 6);
          await addressIs(page, { app: "inbox", pane: null }, "the header's Back opens the list in the thread's place");
          assert.equal(await historyLength(page), entries, "the header's Back adds no entry");
          pass(11, "a cold address of a thread shows the thread, and the header's Back opens the list in its place, adding no entry");
        });

        await withPage(browser, base, off, `/?pane=${encodeURIComponent(BLOCKED)}`, block("the classic app's More header as on main"), async (page) => {
          await openSheet(page, ".header-more-button");
          const roles = await page.locator(".row-sheet .header-more-crumb").evaluate((crumb) => { const path = crumb.querySelector(".header-more-path"); return { crumb: getComputedStyle(crumb).overflowY, cap: getComputedStyle(crumb).maxHeight, path: path ? getComputedStyle(path).overflowY : null, mode: crumb.classList.contains("is-inbox") }; });
          assert.ok(roles.crumb === "auto" && roles.cap !== "none" && roles.path !== "auto" && !roles.mode, `classic's More header scrolls as a whole, as on main: ${JSON.stringify(roles)}`);
          console.log("PASS the classic app's More header scrolls as a whole, capped at six lines, as on main");
        });
        await withPage(browser, base, off, `/?pane=${encodeURIComponent(BLOCKED)}`, block("the way out from a thread, and Back through the mode to where it was entered"), async (page) => {
          await page.locator(".pane-slot").first().waitFor();
          await enterFromMore(page);
          await rowCount(page, 6);
          await openThread(page, WORKING);
          assert.equal(await page.locator('.header-more-dot.is-waiting[data-count="1"]').count(), 1, "More counts the other agent that waits");
          assert.match(await page.locator(".header-more-button").getAttribute("aria-label") ?? "", /1 waiting for you/);
          await openSheet(page, ".header-more-button");
          const items = await page.locator(".row-sheet .row-sheet-item").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-item")));
          assert.deepEqual(items.slice(0, 2), ["exit-inbox", "palette"], `a thread's More begins with the way out and the palette: ${items.join()}`);
          const header = await page.locator(".row-sheet .header-more-crumb").evaluate((node) => ({ content: node.scrollHeight, box: node.clientHeight, lines: node.childElementCount }));
          assert.ok(header.lines >= 3 && header.content <= header.box, `More's header holds its ${header.lines} lines without scrolling: ${header.content}px in ${header.box}px`);
          const roles = await page.locator(".row-sheet .header-more-crumb").evaluate((crumb) => { const path = crumb.querySelector(".header-more-path"); return { crumb: getComputedStyle(crumb).overflowY, path: path ? getComputedStyle(path).overflowY : null }; });
          assert.ok(roles.crumb === "visible" && (roles.path === null || roles.path === "auto"), `a thread's More header is no scroller, only its path is: ${JSON.stringify(roles)}`);
          assert.equal(items[2], "next-waiting", `then the next agent that waits: ${items.join()}`);
          assert.ok(!items.includes("open-drawer"), `the mode has no drawer to open: ${items.join()}`);
          assert.deepEqual(items.slice(-2), ["alerts", "settings"], `the app's items end a thread's More: ${items.join()}`);
          await shot(page, `inbox-mode-thread-more-390-${theme}.png`);
          await page.locator('.row-sheet [data-item="exit-inbox"]').tap();
          await page.locator("#drawer-toggle").waitFor();
          await page.locator(".context-title-text").waitFor();
          await sheetClosed(page);
          await addressIs(page, { app: null, pane: WORKING }, "left from a thread, the classic app opens on that thread's pane");
          await page.goBack();
          await page.locator(".thread-title").waitFor();
          await addressIs(page, { app: "inbox", pane: WORKING }, "Back returns to the thread");
          await page.goBack();
          await listScreen(page);
          await page.goBack();
          await page.locator("#drawer-toggle").waitFor();
          await addressIs(page, { app: null, pane: BLOCKED }, "Back on the list returns to the pane the mode was entered from");
          pass(12, "over a thread More counts the other agent that waits and offers it after Back to Ovis; Back to Ovis from a thread opens that thread's pane in the classic app; Back then returns to the thread, to the list, and to the pane the mode was entered from");
        });

        await withPage(browser, base, off, "/", block("the Ovis mark at the drawer's head, and no drawer in the mode"), async (page) => {
          await page.locator(".pane-slot").first().waitFor();
          await openDrawerForMark(page);
          assert.equal(await page.locator(".sidebar.is-open .inbox-foot-entry").count(), 0, "the drawer's foot has no Open agent inbox: the mark at its head is the way in");
          const mark = page.locator(".app-header #drawer-toggle.is-mark");
          assert.deepEqual([await mark.getAttribute("aria-label"), await mark.getAttribute("title")], ["Open agent inbox", "Open agent inbox"]);
          await shot(page, `inbox-mode-drawer-entry-390-${theme}.png`);
          await mark.tap();
          await listScreen(page);
          await rowCount(page, 6);
          await page.locator("#workspace-drawer, .scrim.is-open").waitFor({ state: "detached" });
          await page.waitForFunction(() => Boolean(document.elementFromPoint(4, 420)?.closest(".mode-inbox")), undefined, { timeout: 5_000 });
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 4, y: 420 }] });
          for (let x = 24; x <= 304; x += 40) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: 422 }] });
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await frames(page);
          assert.equal(await page.locator("#workspace-drawer, .scrim.is-open").count(), 0, "a swipe from the edge opens no drawer in the mode");
          await page.locator(".mode-inbox").waitFor();
          pass(13, "the open drawer's head is the Ovis mark, named Open agent inbox, which opens the list, and its foot has no row for it; in the mode a swipe from the left edge opens no drawer");
        });

        await withPage(browser, base, off, "/?app=inbox", block("New workspace from the list"), async (page) => {
          await rowCount(page, 6);
          await page.locator(".inbox-add").tap();
          const dialog = page.getByRole("dialog").filter({ hasText: "New workspace" }).first();
          await dialog.waitFor();
          await page.goBack();
          await dialog.waitFor({ state: "detached" });
          await listScreen(page);
          await rowCount(page, 6);
          pass(14, "New workspace opens its dialog from the list, and the system Back closes it onto the list");
        });

        await withPage(browser, base, off, "/?demo_devices=watch&app=inbox", block("a watching device"), async (page) => {
          await rowCount(page, 6);
          assert.equal(await page.locator(".inbox-add").count(), 0);
          assert.equal(await page.locator(".mode-inbox .inbox-top button").count(), 1, "a watching device keeps More alone at the top");
          pass(15, "a device that only watches may use the mode and is offered no New workspace");
        });

        await withPage(browser, base, on, "/", block("a phone that starts in the inbox"), async (page) => {
          await listScreen(page);
          await rowCount(page, 6);
          assert.equal(await page.locator(".pane-slot").count(), 0);
          await page.goBack({ waitUntil: "commit" });
          await page.waitForURL("about:blank");
          pass(16, "with Start in the agent inbox on a phone on, a phone's cold start is the mode's list, and Back leaves the app");
        });

        await withPage(browser, base, on, `/?pane=${encodeURIComponent(BLOCKED)}`, block("a phone that starts in the inbox, on an address naming a pane"), async (page) => {
          await page.locator("#inbox-back").waitFor();
          await page.locator(".thread-title").waitFor();
          await addressIs(page, { app: "inbox", pane: BLOCKED }, "the pane's address opens its thread in the mode");
          await backToList(page);
          await rowCount(page, 6);
          pass(17, "with the setting on, an address naming a pane opens that pane's thread in the mode, the list behind its Back");
        });

        await withPage(browser, base, on, "/", block("the setting on a wide window"), async (page) => {
          await page.locator(".pane-slot").first().waitFor();
          await page.locator(".agents-sidebar .agent-item").first().waitFor();
          assert.equal(await page.locator(".mode-inbox").count(), 0);
          await addressIs(page, { app: null }, "a wide window with the setting on starts in the classic app");
          pass(18, "at 1280x900 with the setting on the app starts in the classic shell");
        }, { width: 1280, height: 900 });

        await withPage(browser, base, off, "/", block("the Settings row"), async (page) => {
          await page.locator(".context-title-text").waitFor();
          await page.locator("#drawer-toggle").tap();
          await page.locator(".sidebar").getByRole("button", { name: /^Settings/ }).first().tap();
          const settings = page.locator(".settings-dialog");
          await settings.waitFor();
          await settings.locator(".settings-search-input").first().fill("Agent inbox");
          const toggle = settings.getByRole("switch", { name: "Start in the agent inbox on a phone" });
          await toggle.tap();
          await page.waitForFunction(() => document.querySelector('.settings-dialog [role="switch"][aria-label="Start in the agent inbox on a phone"]')?.getAttribute("aria-checked") === "true");
          await page.getByRole("button", { name: "Close settings" }).tap();
          await settings.waitFor({ state: "detached" });
          assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:phone-inbox") ?? "null")), true);
          assert.equal(await page.locator(".mode-inbox").count(), 0, "the setting says where the device starts: the page it was turned on in stays as it is");
          await page.goto(`${base}/`);
          await listScreen(page);
          await rowCount(page, 6);
          pass(19, "the Settings row stores the device's choice and leaves the page as it is; the next cold start is the mode's list");
        });

        await withPage(browser, base, { ...off, shortcutOverrides: { "close-pane": "ctrl+alt+x", "new-tab": "ctrl+alt+u" } }, "/?app=inbox", block("the keys the mode withholds"), async (page) => {
          await rowCount(page, 6);
          await openThread(page, WORKING);
          await page.locator(".pane-slot").first().waitFor();
          const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          const newTab = page.locator(".new-session-modal");
          const confirm = page.locator(".confirm-dialog");
          await blur();
          await page.keyboard.press("Control+Alt+u");
          await page.keyboard.press("Control+Alt+x");
          await frames(page);
          assert.deepEqual([await newTab.count(), await confirm.count()], [0, 0], "in a thread the keys make no tab and ask to close no pane");
          await backToList(page);
          await blur();
          await page.keyboard.press("Control+Alt+u");
          await page.keyboard.press("Control+Alt+x");
          await frames(page);
          assert.deepEqual([await newTab.count(), await confirm.count()], [0, 0], "on the list the keys do nothing");
          assert.equal(await page.locator(`.mode-inbox .inbox-item[data-pane="${WORKING}"]`).count(), 1, "the pane under the list is still in the roster");
          await openSheet(page, ".inbox-more");
          await page.locator('.row-sheet [data-item="exit-inbox"]').tap();
          await page.locator("#drawer-toggle").waitFor();
          await sheetClosed(page);
          await blur();
          await page.keyboard.press("Control+Alt+x");
          await confirm.waitFor();
          await page.keyboard.press("Escape");
          await confirm.waitFor({ state: "detached" });
          pass(20, "keys bound to Close pane and New tab do nothing in the mode, in a thread as on the list, and act again once the classic app is back");
        });

        await withPage(browser, base, { ...off, keepScreenOn: true }, "/?app=inbox", block("Keep screen on"), async (page) => {
          await page.context().addInitScript(() => {
            const lock = { held: 0 };
            Object.defineProperty(window, "wakeLockHeld", { get: () => lock.held });
            Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async () => {
              lock.held += 1;
              let released = false;
              return { release: async () => { if (!released) { released = true; lock.held -= 1; } } };
            } } });
          });
          await page.reload();
          await rowCount(page, 6);
          const held = (count: number) => page.waitForFunction((n) => (window as unknown as { wakeLockHeld: number }).wakeLockHeld === n, count, { timeout: 5_000 });
          await frames(page);
          assert.equal(await page.evaluate(() => (window as unknown as { wakeLockHeld: number }).wakeLockHeld), 0, "a cold list holds no lock");
          await openThread(page, WORKING);
          await held(1);
          await backToList(page);
          await held(0);
          pass(21, "Keep screen on holds a lock in a thread and lets it go on the list");
        });

        await withPage(browser, base, off, "/?app=inbox", block("finishes under the list"), async (page) => {
          await rowCount(page, 6);
          await openThread(page, WORKING);
          await page.locator(".pane-slot").first().waitFor();
          await backToList(page);
          await page.evaluate((pane) => window.inboxFixture.set(pane, "done", 2), WORKING);
          await page.waitForFunction((pane) => document.querySelector(`.mode-inbox .inbox-item[data-pane="${pane}"]`)?.getAttribute("data-state") === "done", WORKING);
          const seen = await page.evaluate(() => window.inboxFixture.rosters);
          await page.evaluate(() => window.inboxFixture.publish());
          await page.waitForFunction((count) => window.inboxFixture.rosters > count, seen);
          await frames(page);
          const after = await rows(page);
          for (const pane of [WORKING, DONE]) {
            const item = after.find((candidate) => candidate.pane === pane);
            assert.equal(item?.mark, "done", `${pane} still draws the done mark after the roster came again: ${JSON.stringify(item)}`);
          }
          pass(22, "a finish under the list, of the pane it covers and of one never opened, is still marked done after a roster republish");
        });

        await withPage(browser, base, off, "/?app=inbox", block("two PCs, and a list that scrolls"), async (page) => {
          await rowCount(page, 6);
          await page.evaluate(() => (window as unknown as { __herdrDemoOrder: { addPc: () => string } }).__herdrDemoOrder.addPc());
          await rowCount(page, 12);
          const names: Record<string, string> = await page.evaluate(async () => Object.fromEntries((await (await fetch("/api/machines")).json()).machines.map((machine: Machine) => [machine.id, machine.name])));
          for (const item of await rows(page)) assert.ok((item.words ?? "").startsWith(`${names[item.machine!]} \u00b7 `), `a row of ${item.machine} leads its words with its PC: ${item.words}`);
          const places = () => page.evaluate(() => Object.fromEntries([".inbox-more", ".inbox-add", ".inbox-filter-toggle", ".inbox-search-input"].map((selector) => {
            const r = document.querySelector(selector)!.getBoundingClientRect();
            return [selector, [r.left, r.top, r.right, r.bottom]];
          })));
          const scroller = page.locator(".inbox-scroll");
          const atTop = await places();
          const range = await scroller.evaluate((node) => node.scrollHeight - node.clientHeight);
          assert.ok(range > 0, `twelve rows scroll: ${range}`);
          await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight; });
          await page.waitForFunction(() => { const node = document.querySelector(".inbox-scroll")!; return Math.abs(node.scrollTop - (node.scrollHeight - node.clientHeight)) <= 1; });
          await frames(page);
          assert.deepEqual(await places(), atTop, "the floating controls stay put while the list scrolls");
          const end = await page.evaluate(() => ({ row: [...document.querySelectorAll(".mode-inbox .inbox-item")].at(-1)!.getBoundingClientRect().bottom, foot: document.querySelector(".inbox-filter-toggle")!.getBoundingClientRect().top }));
          assert.ok(end.row <= end.foot, `at the list's end the last row ends above the foot's controls: row ${end.row}, foot ${end.foot}`);
          await scroller.evaluate((node) => { node.scrollTop = 0; });
          await openThread(page, WORKING, "laptop");
          await addressIs(page, { machine: "laptop", pane: WORKING, app: "inbox" }, "the other PC's row opens that PC's pane");
          assert.match(await page.locator(".thread-state").textContent() ?? "", new RegExp(`^${names["laptop"]} \u00b7 `), "with several PCs a thread says which PC before its state");
          pass(23, `with two PCs holding the same pane ids each row leads its words with its PC, and the other PC's row opens that PC's pane; over twelve rows (${Math.round(range)}px of scroll) the floating controls stay put and the last row ends ${Math.round(end.foot - end.row)}px above the foot`);
        });

        for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
          const at = `${viewport.width}`;
          await withPage(browser, base, off, `/?pane=${encodeURIComponent(WORKING)}&view=terminal`, block(`the list beside the thread at ${at}`), async (page) => {
            await page.locator(".app-header.is-zoned").waitFor();
            const classic = { sidebar: await box(page, "#workspace-drawer"), pane: await box(page, ".pane-column"), terminal: await terminalBox(page) };
            const entries = await historyLength(page);
            assert.equal(await page.locator("#workspace-drawer .inbox-foot-entry").count(), 0, "the sidebar's foot has no Open agent inbox beside the mark");
            await page.locator(".header-more-button").click();
            await page.locator(".row-menu").waitFor();
            assert.equal(await page.locator('.row-menu [data-item="enter-inbox"]').count(), 0, "More has no Open agent inbox beside the mark");
            await page.keyboard.press("Escape");
            await page.locator(".row-menu").waitFor({ state: "detached" });
            await page.locator(OVIS_MARK).click();
            await page.locator(".inbox-column .mode-inbox").waitFor();
            await page.locator(".app-header").waitFor({ state: "detached" });
            await rowCount(page, 6);
            await questionShown(page);
            await appFaces(page);
            await addressIs(page, { app: "inbox", pane: null }, "the wide list's address says the mode and names no pane");
            assert.equal(await historyLength(page), entries + 1, "entering is one entry");
            assert.equal(await page.locator(".inbox-unchosen").textContent(), "Choose one from the list to open its chat here.");
            assert.equal(await page.locator('.mode-inbox .inbox-row[aria-current="true"]').count(), 0, "no row is open while no agent is chosen");
            for (const selector of [".tab-strip", ".view-switch", ".status-bar", "#drawer-toggle", "#workspace-drawer", ".sidebar-toggle", ".header-files-button", ".pane-split.is-split", ".mode-inbox time.inbox-time"]) {
              assert.equal(await page.locator(selector).count(), 0, `the wide mode draws no ${selector}`);
            }
            assert.equal(await page.locator(".header-more-dot").count(), await page.locator(".inbox-rail .header-more-dot").count(), "the wide mode draws no .header-more-dot but the rail's");
            assert.equal(await page.locator('.inbox-rail .inbox-rail-waiting .header-more-dot.is-waiting[data-count="1"]').count(), 1, "the rail counts the one agent that waits");
            const column = await box(page, ".inbox-column");
            const pane = await box(page, ".pane-column");
            assert.deepEqual([column.x, column.w], [classic.sidebar.x, classic.sidebar.w], "the column is as wide as classic's sidebar");
            assert.deepEqual([pane.x, pane.w], [classic.pane.x, classic.pane.w], "the pane is as wide as in classic");
            const [rail, list] = await Promise.all([box(page, ".inbox-column .inbox-rail"), box(page, ".inbox-column .mode-inbox")]);
            assert.deepEqual([rail.x, rail.y, rail.w, rail.h], [column.x, 0, 58, viewport.height], "the rail is 58px wide at the column's start, from the window's top to its foot");
            near(list.x, rail.right, 0.5, "the list begins where the rail ends"); near(list.right, column.right, 1, "the list ends at the column's seam");
            const [search, filter, add] = await Promise.all([box(page, ".mode-inbox .inbox-search"), box(page, ".inbox-filter-toggle"), box(page, ".inbox-add")]);
            assert.equal(await page.locator(".mode-inbox .inbox-search-toggle").isVisible(), false, "a list with the room for its field draws no Search button");
            assert.equal(await page.locator(".inbox-rail svg.lucide-search").count(), 0, "the rail draws no magnifier");
            for (const control of [filter, add]) assert.deepEqual([control.w, control.h], [34, 34], "a round control is 34px under a fine pointer");
            near(search.x - list.x, 16, 1, "the search field from the list's start");
            near(filter.x - search.right, 10, 2, "between the field and the filter"); near(add.x - filter.right, 10, 2, "between the column's top controls");
            near(column.right - add.right, 16, 1, "the top controls from the column's edge");
            for (const control of [search, filter, add]) near(control.y, 12, 2, "from the top");
            for (const selector of [".mode-inbox .inbox-foot", ".inbox-column .inbox-more", ".inbox-exit"]) assert.equal(await page.locator(selector).count(), 0, `the wide mode draws no ${selector}`);
            const exit = await box(page, ".inbox-rail .inbox-rail-exit");
            assert.deepEqual([exit.x, exit.y, exit.w, exit.h], [12, 12, 34, 34], "Back to Ovis at the rail's top, 12px from its top and from its sides");
            const wideRows = await page.locator(".mode-inbox .inbox-item").evaluateAll((items) => items.map((item) => {
              const r = item.querySelector(".inbox-row")!.getBoundingClientRect();
              const a = item.querySelector(".inbox-avatar")!.getBoundingClientRect();
              return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, radius: getComputedStyle(item.querySelector(".inbox-row")!).borderRadius, avatar: [a.width, a.height, a.left - r.left], nameSize: getComputedStyle(item.querySelector(".inbox-name")!).fontSize, wordsSize: getComputedStyle(item.querySelector(".inbox-words")!).fontSize };
            }));
            near(wideRows[0]!.top - add.bottom, 16, 2, "the first row under the top controls");
            wideRows.forEach((item, index) => {
              near(item.bottom - item.top, 56, 2, "a wide row's height");
              near(item.left - list.x, 12, 1, "a row's inset at the list's start, after the rail"); near(column.right - item.right, 12, 1, "a row's inset at the column's end");
              assert.equal(item.radius, "12px");
              assert.deepEqual(item.avatar, [32, 32, 8], "the mark is 32px, 8px inside the row");
              assert.deepEqual([item.nameSize, item.wordsSize], ["14px", "13px"]);
              if (index > 0) near(item.top - wideRows[index - 1]!.bottom, 4, 1, "between two rows");
            });

            await row(page, BLOCKED).click();
            await page.locator(".thread-chip").waitFor();
            await page.locator(".prompt-card").first().waitFor();
            await appFaces(page);
            await addressIs(page, { app: "inbox", pane: BLOCKED }, "a row opens its thread beside the list");
            assert.deepEqual((await rows(page)).filter((item) => item.current === "true").map((item) => item.pane), [BLOCKED], "exactly the open thread's row is current");
            assert.equal(await page.locator(".mode-inbox .inbox-item.is-current .inbox-name").evaluate((node) => getComputedStyle(node).fontWeight), "600");
            assert.equal(await page.locator(".thread-chip-state").textContent(), "Needs you");
            const threadEntries = await historyLength(page);
            const [chip, lens, paneMore] = await Promise.all([box(page, ".thread-chip"), box(page, ".thread-top .lens-toggle"), box(page, ".thread-top .header-more-button")]);
            const middle = (control: Box): number => control.y + control.h / 2;
            for (const control of [filter, add, exit, chip, lens, paneMore]) near(middle(control), middle(search), 1, "the top controls, the rail's first button and the chip on one centre line");
            near(chip.x + chip.w / 2, pane.x + pane.w / 2, 2, "the chip on the pane's middle");
            near(lens.y, 12, 2, "the pane's controls from its top"); near(pane.right - paneMore.right, 12, 2, "the pane's controls from its end");
            const lane = await page.evaluate(() => {
              const transcript = document.querySelector(".chat-transcript")!.getBoundingClientRect();
              const composer = document.querySelector(".composer-surface")!.getBoundingClientRect();
              const card = document.querySelector(".prompt-dock .prompt-card")!.getBoundingClientRect();
              return { left: transcript.left, right: transcript.right, composer: [composer.left, composer.right], card: [card.left, card.right], above: card.bottom <= composer.top + 1 };
            });
            near(lane.left - pane.x, pane.right - lane.right, 1, "the transcript's lane centred in the pane");
            near(lane.composer[0]!, lane.left, 1, "the composer on the transcript's column"); near(lane.composer[1]!, lane.right, 1, "the composer on the transcript's column");
            near(lane.card[0]!, lane.composer[0]!, 1, "the prompt card on the composer's column"); near(lane.card[1]!, lane.composer[1]!, 1, "the prompt card on the composer's column");
            assert.ok(lane.above, "the prompt card is docked above the composer");
            await shot(page, `inbox-mode-two-pane-${at}-${theme}.png`);

            await row(page, WORKING).click();
            await page.waitForFunction((title) => (document.querySelector(".thread-chip-name")?.textContent ?? "").endsWith(title), WORKING_TITLE);
            await addressIs(page, { app: "inbox", pane: WORKING }, "another row opens in the thread's place");
            assert.equal(await historyLength(page), threadEntries, "a second row adds no entry");
            assert.deepEqual((await rows(page)).filter((item) => item.current === "true").map((item) => item.pane), [WORKING]);

            const monitor = page.locator(".thread-top .lens-toggle");
            assert.equal(await monitor.getAttribute("aria-label"), "Show the terminal");
            await monitor.click();
            await page.locator('.thread-top .lens-toggle[data-view="terminal"]').waitFor();
            const terminal = await terminalBox(page);
            near(terminal.w, classic.terminal.w, 1, "the terminal's width against classic's"); near(terminal.h, classic.terminal.h, 1, "the terminal's height against classic's");
            await monitor.click();
            await page.locator('.thread-top .lens-toggle[data-view="chat"]').waitFor();

            assert.equal(await page.locator(".header-more-dot").count(), await page.locator(".inbox-rail .header-more-dot").count(), "beside the list More carries no count: the only one drawn is the rail's");
            assert.equal(await page.locator('.inbox-rail .inbox-rail-waiting .header-more-dot.is-waiting[data-count="1"]').count(), 1, "the rail counts the agent that waits other than the open thread's");
            assert.equal(await page.locator(".thread-top .header-more-button").getAttribute("aria-label"), "More");
            await page.locator(".thread-top .header-more-button").click();
            await page.locator(".row-menu").waitFor();
            const threadItems = await page.locator(".row-menu [data-item]").evaluateAll((items) => items.map((item) => item.getAttribute("data-item")));
            assert.ok(threadItems.includes("copy-link") && threadItems.includes("files"), `the pane's More holds the thread's items: ${threadItems.join()}`);
            assert.equal(threadItems[0], "palette", `the pane's More begins with the palette: ${threadItems.join()}`);
            for (const item of ["exit-inbox", "settings", "alerts", "next-waiting"]) assert.ok(!threadItems.includes(item), `the pane's More has no ${item}: ${threadItems.join()}`);
            await page.keyboard.press("Escape");
            await page.locator(".row-menu").waitFor({ state: "detached" });
            assert.equal(await page.locator(".inbox-column .inbox-more").count(), 0, "the column draws no More");
            assert.deepEqual(await railNames(page), ["Back to Ovis", "Agent inbox", "1 waiting for you", "Alerts", "Settings", "PC workstation · Connected"],
              "the rail holds the way out and the app's items the column's More held, without a second one of any, and no magnifier");

            await page.locator(".mode-inbox .inbox-search-input").click();
            await page.keyboard.type("export");
            await rowCount(page, 1);
            for (const selector of [".mode-inbox .inbox-filter-toggle", ".mode-inbox .inbox-add"]) assert.equal(await page.locator(selector).isVisible(), true, `with a query, ${selector} stays in the row`);
            await page.keyboard.press("Escape");
            await rowCount(page, 6);
            await page.keyboard.press("Escape");
            assert.equal(await page.locator(".mode-inbox .inbox-search-input").isVisible(), true, "an empty Escape leaves the always-shown field");
            assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("inbox-search-input") === true), true, "and the focus in it");

            await page.setViewportSize({ width: 600, height: viewport.height });
            await page.locator("#inbox-back").waitFor();
            assert.equal((await page.locator(".thread-name").textContent())?.replace(/^Claude Code: /, ""), WORKING_TITLE);
            assert.equal(await page.locator(".mode-inbox").count(), 0);
            await page.locator("textarea.composer-text").first().click();
            await page.waitForFunction(() => document.activeElement?.classList.contains("composer-text") === true);
            await page.setViewportSize(viewport);
            await page.locator(".thread-chip").waitFor();
            await page.locator(".inbox-column .mode-inbox").waitFor();
            assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("composer-text") === true), true, "a list drawn again for a wider window takes no focus from the composer");
            await addressIs(page, { app: "inbox", pane: WORKING }, "a window narrowed and widened keeps the thread");

            await page.goBack();
            await page.locator(".inbox-unchosen").waitFor();
            assert.equal(await page.locator('.mode-inbox .inbox-row[aria-current="true"]').count(), 0);
            await page.goForward();
            await page.locator(".thread-chip").waitFor();
            const wayOut = page.locator(".inbox-rail .inbox-rail-exit");
            assert.deepEqual(await wayOut.evaluate((node) => [node.tagName, node.getAttribute("aria-label"), node.getAttribute("title"), node.querySelectorAll("img.ovis-mark").length]), ["BUTTON", "Back to Ovis", "Back to Ovis", 1],
              "the Ovis mark at the rail's top is a button named, and titled, Back to Ovis");
            const leaving = await historyLength(page);
            await wayOut.click();
            await page.locator(".app-header.is-zoned").waitFor();
            await page.locator("#workspace-drawer").waitFor();
            assert.equal(await page.locator(".mode-inbox").count(), 0);
            assert.equal(await page.locator(".inbox-rail").count(), 0, "the rail leaves with the mode");
            await addressIs(page, { app: null, pane: WORKING }, "Back to Ovis at the rail's top opens the thread's pane in the classic app");
            assert.equal(await historyLength(page), leaving + 1, "leaving is one entry");
            await page.goBack();
            await page.locator(".inbox-column .inbox-rail").waitFor();
            await page.locator(".thread-chip").waitFor();
            await addressIs(page, { app: "inbox", pane: WORKING }, "Back from the classic app returns to the thread the mode was left on");
            await page.goForward();
            await page.locator(".app-header.is-zoned").waitFor();
            await page.locator(OVIS_MARK).click();
            await page.locator(".inbox-column .mode-inbox").waitFor();
            pass(viewport.width === 1440 ? 24 : 25, `at ${at}: entered by the Ovis mark (More and the sidebar's foot offering no second way), the column is classic's sidebar (${column.w}px) and the pane classic's (${pane.w}px), the rail (${rail.w}px) cut out of the column and the list (${Math.round(list.w)}px) beside it; 34px round controls on one centre line with the rail's first button and the chip, the filter among them and no foot; 56px rows 4px apart with the open one current, the lane and the composer on one column; another row takes the thread's entry; the terminal is classic's size (${Math.round(terminal.w)} by ${Math.round(terminal.h)}); the one More is the pane's, and the rail holds the way out, the app's items and the count; the open search field takes the top row; a narrowed window keeps the thread; the Ovis mark at the rail's top leads out by one entry that Back undoes, and the Ovis mark at the sidebar's head leads in`);
          }, viewport);
        }

        if (errors.length > 0) {
          failures.push(block("page errors"));
          console.log(`FAIL ${block("page errors")}: ${errors.join("; ")}`);
          errors.length = 0;
        } else pass(26, "no page error");
      }
      const light: Settings = { language: "en", theme: "light" };
      const desktop = { width: 1440, height: 900 };
      if (part === "panes") {
        const terminalAt = `/?pane=${encodeURIComponent(BLOCKED)}&view=terminal`;
        for (const setup of [
          { name: "a phone", viewport: PHONE, path: terminalAt },
          { name: "a wide window", viewport: { width: 1440, height: 900 }, path: terminalAt },
          { name: "a wide window with the classic sidebar collapsed", viewport: { width: 1440, height: 900 }, path: `${terminalAt}&sidebar=hidden` },
        ]) {
          await withPage(browser, base, { language: "en", theme: "light" }, setup.path, `the mode sizes no terminal on ${setup.name}`, async (page) => {
            const wide = setup.viewport.width >= 769;
            const terminal = ".terminal-stack:not(.is-chat) .pane-terminal";
            const sized = (): Promise<Window["inboxFixture"]["resizes"]> => page.evaluate(() => window.inboxFixture.resizes.slice());
            await page.locator(".app-header.is-zoned").waitFor();
            const classic = await terminalBox(page);
            if (setup.path.endsWith("sidebar=hidden")) assert.equal(classic.x, 0, "the classic sidebar is collapsed: the pane begins at the window's edge");
            await terminalSettled(page, 1);
            const before = (await sized()).length;

            if (wide) {
              if (setup.path.endsWith("sidebar=hidden")) {
                await page.locator(".header-more-button").click();
                await page.locator('.row-menu [data-item="enter-inbox"]').click();
              } else await page.locator(OVIS_MARK).click();
              await page.locator(".inbox-column .mode-inbox").waitFor();
            } else await enterFromMore(page);
            await rowCount(page, 6);
            await paneHiddenUnderList(page, "the pane is mounted under the list, hidden");
            await terminalSettled(page);
            assert.deepEqual((await sized()).slice(before), [], "the list over the pane sends its pty no size");
            sameBox(await box(page, terminal), classic, "under the list the terminal keeps the box it had");

            if (wide) await page.locator(".inbox-rail .inbox-rail-exit").click();
            else {
              await openSheet(page, ".inbox-more");
              await page.locator('.row-sheet [data-item="exit-inbox"]').tap();
            }
            await page.locator(".mode-inbox").waitFor({ state: "detached" });
            await page.locator(".app-header.is-zoned").waitFor();
            if (!wide) await sheetClosed(page);
            await terminalSettled(page);
            assert.deepEqual((await sized()).slice(before), [], "leaving the mode sends the pane's pty no size");
            sameBox(await terminalBox(page), classic, "back in the classic app the terminal has the box it had");
            console.log(`PASS the mode sizes no terminal on ${setup.name}: entered and left with the pane showing its terminal (${Math.round(classic.w)} by ${Math.round(classic.h)}), its pty is sent no size and its box stays`);
          }, setup.viewport);
        }

        for (const setup of [
          { name: "a classic split", path: `/?pane=${encodeURIComponent(WORKING)}&view=terminal`, split: { other: { machineId: "local", paneId: BLOCKED }, bSide: "right", active: "a" }, panes: 2 },
          { name: "a tab herdr split", path: `/?pane=${encodeURIComponent(WORKING)}&view=terminal`, split: null, panes: 2 },
        ]) {
          await withPage(browser, base, { language: "en", theme: "light" }, setup.path, `a split under the list: ${setup.name}`, async (page) => {
            const frames = (): Promise<Window["inboxFixture"]["frames"]> => page.evaluate(() => window.inboxFixture.frames.slice());
            const screens = (): Promise<Record<string, Box>> => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("[data-layout-pane]")].flatMap((frame) => {
              const screen = frame.querySelector(".xterm-screen");
              if (!screen) return [];
              const box = screen.getBoundingClientRect();
              return box.width > 0 ? [[frame.getAttribute("data-layout-pane"), { x: box.x, y: box.y, w: box.width, h: box.height, right: box.right, bottom: box.bottom }]] : [];
            })));
            if (setup.split !== null) {
              await page.evaluate((split) => sessionStorage.setItem("ovis:split", JSON.stringify(split)), setup.split);
              await page.reload();
            }
            await page.locator(".app-header.is-zoned").waitFor();
            if (setup.split === null) {
              await page.keyboard.press("Control+Shift+K");
              await page.getByRole("searchbox", { name: "Search panes and actions", exact: true }).fill("Split pane right");
              await page.getByRole("option", { name: "Split pane right", exact: true }).click();
            }
            await page.waitForFunction((count) => [...document.querySelectorAll("[data-layout-pane] .xterm-screen")].filter((screen) => screen.getBoundingClientRect().width > 0).length === count, setup.panes, { timeout: 15_000 });
            await terminalSettled(page, setup.panes);
            const classic = await screens();
            const panes = Object.keys(classic);
            assert.equal(panes.length, setup.panes, `classic draws the split's ${setup.panes} terminals: ${panes.join(", ")}`);
            const before = (await frames()).length;

            await page.locator(OVIS_MARK).click();
            await page.locator(".inbox-column .mode-inbox").waitFor();
            await rowCount(page, 6);
            await paneHiddenUnderList(page, "the split's panes are mounted under the list, hidden");
            assert.deepEqual(Object.keys(await screens()).sort(), [...panes].sort(), "every pane of the split is still mounted under the list");
            await terminalSettled(page);
            assert.deepEqual((await frames()).slice(before), [], "entering the mode detaches no terminal, attaches none and sends no size or release");

            await page.locator(".inbox-rail .inbox-rail-exit").click();
            await page.locator(".mode-inbox").waitFor({ state: "detached" });
            await page.locator(".app-header.is-zoned").waitFor();
            await terminalSettled(page);
            assert.deepEqual((await frames()).slice(before), [], "leaving the mode from the list detaches no terminal, attaches none and sends no size or release");
            const after = await screens();
            for (const pane of panes) sameBox(after[pane] ?? { x: -1, y: -1, w: -1, h: -1, right: -1, bottom: -1 }, classic[pane]!, `the split's pane ${pane} has the box, and the grid, it had`);
            console.log(`PASS ${setup.name} under the list: its ${panes.length} panes stay mounted, and entering the mode and leaving it from the list send no attach, detach, size or release; each pane keeps its grid`);
          }, { width: 1440, height: 900 });
        }

        await withPage(browser, base, { language: "en", theme: "light" }, `/?pane=${encodeURIComponent(WORKING)}&view=terminal`, "a tab herdr split through a thread's terminal and back", async (page) => {
          await page.locator(".app-header.is-zoned").waitFor();
          await page.keyboard.press("Control+Shift+K");
          await page.getByRole("searchbox", { name: "Search panes and actions", exact: true }).fill("Split pane right");
          await page.getByRole("option", { name: "Split pane right", exact: true }).click();
          await page.waitForFunction(() => [...document.querySelectorAll("[data-layout-pane] .xterm-screen")].filter((screen) => screen.getBoundingClientRect().width > 0).length === 2, undefined, { timeout: 15_000 });
          await terminalSettled(page, 2);
          const other = await page.evaluate((working) => [...document.querySelectorAll("[data-layout-pane]")].map((frame) => frame.getAttribute("data-layout-pane")).find((pane) => pane !== null && pane !== working) ?? "", WORKING);
          const held = (await page.evaluate(() => window.inboxFixture.frames.slice())).filter((frame) => frame.pane === other && (frame.type === "attach" || frame.type === "resize")).at(-1);
          assert.ok(other !== "" && held !== undefined, `the tab's other pane (${other}) holds the pty's size in classic`);
          await page.locator(OVIS_MARK).click();
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await row(page, WORKING).click();
          await page.locator(".thread-chip").waitFor();
          await page.locator(".thread-top .lens-toggle").click();
          await page.locator('.thread-top .lens-toggle[data-view="terminal"]').waitFor();
          await page.goBack();
          await page.locator(".inbox-unchosen").waitFor();
          await terminalSettled(page);
          const before = await page.evaluate(() => window.inboxFixture.frames.length);
          await page.locator(".inbox-rail .inbox-rail-exit").click();
          await page.locator(".mode-inbox").waitFor({ state: "detached" });
          await page.locator(".app-header.is-zoned").waitFor();
          const resized = await page.waitForFunction(({ before, other }) => window.inboxFixture.frames.slice(before).some((frame) => frame.type === "resize" && frame.pane === other), { before, other }, { timeout: 5_000 }).then(() => true, () => false);
          assert.ok(resized, `Back to Ovis makes the tab's other pane (${other}) ask for its grid again`);
          await terminalSettled(page);
          const sent = (await page.evaluate((count) => window.inboxFixture.frames.slice(count), before)).filter((frame) => frame.pane === other);
          assert.deepEqual(sent, [{ type: "resize", pane: other, cols: held!.cols, rows: held!.rows }], `leaving, the tab's other pane asks once for the grid it held before the mode (${held!.cols} by ${held!.rows})`);
          console.log(`PASS a tab herdr split through a thread's terminal and Back: Back to Ovis gives the tab's other pane (${other}) its hold back at ${held!.cols} by ${held!.rows}, asked once`);
        }, { width: 1440, height: 900 });

        await withPage(browser, base, { language: "en", theme: "light" }, `/?pane=${encodeURIComponent(WORKING)}&view=terminal`, "a classic split's thread at the pane area's width", async (page) => {
          await page.evaluate((other) => sessionStorage.setItem("ovis:split", JSON.stringify({ other: { machineId: "local", paneId: other }, bSide: "right", active: "a" })), BLOCKED);
          await page.reload();
          await page.locator(".app-header.is-zoned").waitFor();
          await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2, undefined, { timeout: 15_000 });
          await terminalSettled(page, 2);
          const half = await page.evaluate((pane) => window.inboxFixture.frames.filter((frame) => frame.pane === pane && (frame.type === "attach" || frame.type === "resize")).at(-1)!, WORKING);
          await page.locator(OVIS_MARK).click();
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await rowCount(page, 6);
          await row(page, WORKING).click();
          await page.locator(".thread-chip").waitFor();
          await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 1, undefined, { timeout: 5_000 });
          const [slot, area] = await Promise.all([box(page, ".pane-slot"), box(page, ".pane-split")]);
          sameBox(slot, area, "the thread's slot is the pane area's box");
          const before = (await page.evaluate(() => window.inboxFixture.frames.length));
          await page.locator(".thread-top .lens-toggle").click();
          await page.locator('.thread-top .lens-toggle[data-view="terminal"]').waitFor();
          const thread = await terminalBox(page);
          near(thread.w, area.w, 1, "the thread's terminal is as wide as the pane area");
          await page.waitForFunction((count) => window.inboxFixture.frames.slice(count).some((frame) => frame.type === "resize"), before, { timeout: 10_000 });
          const asked = await page.evaluate((count) => window.inboxFixture.frames.slice(count).filter((frame) => frame.type === "resize").at(-1)!, before);
          assert.equal(asked.pane, WORKING, "the thread's pane is the one sized");
          assert.ok(asked.cols! > half.cols! * 1.8, `the grid asked for is the whole area's: ${asked.cols} columns, the half had ${half.cols}`);
          console.log(`PASS a row's thread opened from a classic split is drawn at the pane area's width (${Math.round(area.w)}px) and its terminal sized to it (${asked.cols} by ${asked.rows})`);
        }, { width: 1440, height: 900 });

        for (const opened of [WORKING, BLOCKED]) {
        await withPage(browser, base, { language: "en", theme: "light" }, `/?pane=${encodeURIComponent(WORKING)}&view=terminal`, `a classic split through a thread of ${opened} and back`, async (page) => {
          const halves = (): Promise<Record<string, string>> => page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".pane-slot")].map((slot) => [slot.getAttribute("data-slot"), [...slot.querySelectorAll("[data-layout-pane]")].map((frame) => `${frame.getAttribute("data-layout-pane")}${frame.classList.contains("is-hidden") ? " (hidden)" : ""}`).join(" + ")])));
          await page.locator(".app-header.is-zoned").waitFor();
          const area = page.locator(".pane-split");
          const areaBox = (await area.boundingBox())!;
          const right = { clientX: areaBox.x + areaBox.width * 0.75, clientY: areaBox.y + areaBox.height / 2 };
          const data = await page.evaluateHandle(() => new DataTransfer());
          await page.locator(`.pane-select[title^="${BLOCKED} —"]`).dispatchEvent("dragstart", { dataTransfer: data });
          await page.locator(".split-drop.is-visible").waitFor({ state: "attached" });
          await area.dispatchEvent("dragover", { dataTransfer: data, ...right });
          await page.locator('.split-drop.is-visible[data-edge="right"]').waitFor({ state: "attached" });
          await area.dispatchEvent("drop", { dataTransfer: data, ...right });
          await data.dispose();
          await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2, undefined, { timeout: 15_000 });
          await terminalSettled(page, 2);
          const classicBoxes = new Map<string, Box>();
          for (const slot of ["a", "b"]) classicBoxes.set(slot, await box(page, `.pane-slot[data-slot="${slot}"]`));
          const classicHalves = await halves();
          assert.deepEqual(classicHalves, { a: WORKING, b: BLOCKED }, "classic draws the split's two halves, each its own pane");
          assert.equal(await page.locator(".pane-slot.is-active").getAttribute("data-slot"), "b", "the dropped half is the active one");
          await page.locator(OVIS_MARK).click();
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await rowCount(page, 6);
          await row(page, opened).click();
          await page.locator(".thread-chip").waitFor();
          const before = await page.evaluate(() => window.inboxFixture.frames.length);
          await page.goBack();
          await page.locator(".inbox-unchosen").waitFor();
          await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2, undefined, { timeout: 5_000 });
          await page.locator(".inbox-rail .inbox-rail-exit").click();
          await page.locator(".mode-inbox").waitFor({ state: "detached" });
          await page.locator(".app-header.is-zoned").waitFor();
          await terminalSettled(page);
          const sent = (await page.evaluate((count) => window.inboxFixture.frames.slice(count), before)).filter((frame) => frame.type === "resize" || frame.type === "release-size");
          assert.deepEqual(sent, [], "after the Back, nothing sends a size or a release");
          assert.deepEqual(await halves(), classicHalves, "each half shows its own pane, as before the mode, and holds no other");
          for (const [slot, was] of classicBoxes) sameBox(await box(page, `.pane-slot[data-slot="${slot}"]`), was, `half ${slot} has the box it had before the mode`);
          console.log(`PASS a classic split through the thread of ${opened} and Back: each half shows its own pane after Back to Ovis, both halves keep their classic boxes, and nothing sends a size or release`);
        }, { width: 1440, height: 900 });
        }

        await withPage(browser, base, { language: "en", theme: "light" }, `${terminalAt}&sidebar=hidden`, "a thread's terminal is sized to the thread's box", async (page) => {
          const sized = (): Promise<Window["inboxFixture"]["resizes"]> => page.evaluate(() => window.inboxFixture.resizes.slice());
          const sizedAfter = async (count: number, what: string): Promise<Window["inboxFixture"]["resizes"]> => {
            const came = await page.waitForFunction((sent) => window.inboxFixture.resizes.length > sent, count, { timeout: 10_000 }).then(() => true, () => false);
            assert.ok(came, `${what}: no size was sent to the pane's pty`);
            await terminalSettled(page);
            return (await sized()).slice(count);
          };
          const screenWidth = (): Promise<number> => page.locator(".terminal-stack:not(.is-chat) .pane-terminal .xterm-screen").evaluate((node) => node.getBoundingClientRect().width);
          await page.locator(".app-header.is-zoned").waitFor();
          const classic = await terminalBox(page);
          assert.equal(classic.x, 0, "the classic sidebar is collapsed: the pane begins at the window's edge");
          await terminalSettled(page, 1);
          const atLoad = await sized();
          const loaded = await page.evaluate((pane) => window.inboxFixture.frames.filter((frame) => frame.pane === pane && (frame.type === "attach" || frame.type === "resize")).at(-1) ?? null, BLOCKED);
          assert.ok(loaded?.cols !== undefined && loaded.rows !== undefined, "the classic app attached the pane with its grid as the page loaded");
          const grid = { pane: BLOCKED, cols: loaded.cols, rows: loaded.rows };
          const cell = await screenWidth() / grid.cols;
          const before = atLoad.length;

          assert.equal(await page.locator(".header-side .sidebar-brand").count(), 0, "a collapsed sidebar draws no Ovis mark");
          await page.locator(".header-more-button").click();
          await page.locator('.row-menu [data-item="enter-inbox"]').click();
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await rowCount(page, 6);
          await paneHiddenUnderList(page, "the pane is mounted under the list, hidden");
          await terminalSettled(page);
          assert.deepEqual((await sized()).slice(before), [], "the list over the pane sends its pty no size");
          await row(page, BLOCKED).click();
          await page.locator(".thread-chip").waitFor();
          await terminalSettled(page);
          assert.deepEqual((await sized()).slice(before), [], "a thread opened on its chat sends its pty no size");

          await page.locator(".thread-top .lens-toggle").click();
          await page.locator('.thread-top .lens-toggle[data-view="terminal"]').waitFor();
          const thread = await terminalBox(page);
          const column = await box(page, ".inbox-column");
          near(thread.w, classic.w - column.w, 1, "the thread's terminal is narrower than classic's by the column");
          const shown = await sizedAfter(before, "the terminal shown in the thread");
          const threadGrid = { pane: BLOCKED, cols: Math.round(await screenWidth() / cell), rows: grid.rows };
          assert.ok(threadGrid.cols < grid.cols, `the thread's grid has fewer columns than classic's: ${threadGrid.cols}, classic ${grid.cols}`);
          assert.deepEqual(shown, [threadGrid], "showing the terminal in the thread asks once, for the grid the thread draws");

          await page.locator(".inbox-rail .inbox-rail-exit").click();
          await page.locator(".mode-inbox").waitFor({ state: "detached" });
          await page.locator(".app-header.is-zoned").waitFor();
          assert.deepEqual(await sizedAfter(before + 1, "the classic app after the thread"), [grid], "Back to Ovis from the thread asks once, for classic's grid");
          sameBox(await terminalBox(page), classic, "back in the classic app the terminal has the box it had");
          console.log(`PASS with the classic sidebar collapsed, a thread's terminal is sized to the thread's box (${threadGrid.cols} by ${threadGrid.rows}) when the monitor button shows it and to classic's (${grid.cols} by ${grid.rows}) on Back to Ovis; the list over the pane and the thread's chat send no size`);
        }, { width: 1440, height: 900 });

        const phoneOn: Settings = { language: "en", theme: "light", phoneInbox: true };
        await withPage(browser, base, phoneOn, "/", "a phone that starts in the inbox and went back to Ovis", async (page) => {
          await listScreen(page);
          await openSheet(page, ".inbox-more");
          await page.locator('.row-sheet [data-item="exit-inbox"]').tap();
          await page.locator(".mode-inbox").waitFor({ state: "detached" });
          await page.locator("#drawer-toggle").waitFor();
          await sheetClosed(page);
          await addressIs(page, { app: null }, "Back to Ovis leaves the mode's address");
          await page.waitForFunction(() => document.activeElement?.id === "drawer-toggle", undefined, { timeout: 5_000 });
          await page.reload();
          await page.locator("#drawer-toggle").waitFor();
          await page.locator(".context-title-text").waitFor();
          assert.equal(await page.locator(".mode-inbox").count(), 0, "a reload of the classic app the phone went back to does not start the mode again");
          await addressIs(page, { app: null }, "the reloaded address is still the classic app's");
          console.log("PASS with Start in the agent inbox on a phone on, a phone that went Back to Ovis is still in the classic app after a reload");
        });

        await withPage(browser, base, light, "/?app=inbox", "the focus after Back to Ovis on a wide window", async (page) => {
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await rowCount(page, 6);
          await row(page, WORKING).click();
          await page.locator(".thread-chip").waitFor();
          await page.locator(".inbox-rail .inbox-rail-exit").click();
          await page.locator(".mode-inbox").waitFor({ state: "detached" });
          await page.locator(".app-header.is-zoned").waitFor();
          await page.waitForFunction(() => document.activeElement?.classList.contains("sidebar-toggle") === true, undefined, { timeout: 5_000 });
          console.log("PASS Back to Ovis leaves the focus on the classic header's toggle: the drawer's on a phone, the sidebar's on a wide window");
        }, desktop);

        for (const [pointer, viewport, touch] of [["coarse", PHONE, true], ["coarse", { width: 430, height: 932 }, true], ["fine", { width: 430, height: 900 }, false]] as const) {
          await withPage(browser, base, light, "/?app=inbox", `the focus after Enter on a row, at ${viewport.width} under a ${pointer} pointer`, async (page) => {
            await listScreen(page);
            await rowCount(page, 6);
            assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), touch, `the pointer is ${pointer}`);
            await row(page, WORKING).focus();
            await page.keyboard.press("Enter");
            await page.locator("#inbox-back").waitFor();
            await page.locator(".thread-title").waitFor();
            const landed = await page.waitForFunction((coarse) => coarse ? document.activeElement?.id === "inbox-back" : document.activeElement?.classList.contains("composer-text") === true, touch, { timeout: 5_000 }).then(() => true, () => false);
            const at = await page.evaluate(() => `${document.activeElement?.tagName.toLowerCase()}${document.activeElement?.id ? `#${document.activeElement.id}` : ""}.${document.activeElement?.className}`);
            assert.ok(landed, `the focus is in the thread, on ${touch ? "its Back button" : "the composer"}: it is on ${at}`);
            console.log(`PASS at ${viewport.width} under a ${pointer} pointer, Enter on a row opens its thread with the focus on ${touch ? "the header's Back" : "the composer"}`);
          }, viewport, touch);
        }

        for (const [pointer, viewport, touch] of [["fine", { width: 480, height: 900 }, false], ["coarse", PHONE, true]] as const) {
          await withPage(browser, base, light, `/?pane=${encodeURIComponent(WORKING)}&view=chat`, `the focus after Enter on the row of the pane classic showed, at ${viewport.width} under a ${pointer} pointer`, async (page) => {
            const press = (selector: string) => touch ? page.locator(selector).tap() : page.locator(selector).click();
            await page.locator(".app-header.is-zoned").waitFor();
            await press(".header-more-button");
            await press('.row-sheet [data-item="enter-inbox"]');
            await sheetClosed(page);
            await listScreen(page);
            await rowCount(page, 6);
            await row(page, WORKING).focus();
            await page.keyboard.press("Enter");
            await page.locator("#inbox-back").waitFor();
            const inThread = (coarse: boolean) => coarse ? document.activeElement?.id === "inbox-back" : document.activeElement?.classList.contains("composer-text") === true;
            const landed = await page.waitForFunction(inThread, touch, { timeout: 5_000 }).then(() => true, () => false);
            // Let the inbox's focus frame and its nested Back fallback run even if the composer
            // focused first, then drain the resize fits queued by the thread layout.
            await frames(page);
            await terminalSettled(page);
            const at = await page.evaluate(() => `${document.activeElement?.tagName.toLowerCase()}#${document.activeElement?.id}.${document.activeElement?.className}`);
            assert.ok(landed && await page.evaluate(inThread, touch), `the focus is on ${touch ? "the thread's Back" : "the composer"} and stays: it is on ${at}`);
            console.log(`PASS entered from the classic app at ${viewport.width} under a ${pointer} pointer, Enter on the row of the pane classic showed puts the focus on ${touch ? "the thread's Back" : "the composer"}`);
          }, viewport, touch);
        }

        for (const lane of [
          { at: "390 under a coarse pointer", viewport: PHONE, touch: true, acts: ["Enter"] },
          { at: "390 under a coarse pointer", viewport: PHONE, touch: true, acts: ["press"] },
          { at: "390 under a coarse pointer", viewport: PHONE, touch: true, acts: ["another", "press"] },
          { at: "480 under a fine pointer", viewport: { width: 480, height: 900 }, touch: false, acts: ["Enter"] },
          { at: "480 under a fine pointer", viewport: { width: 480, height: 900 }, touch: false, acts: ["press"] },
          { at: "1440", viewport: desktop, touch: false, acts: ["press", "press"] },
        ] as const) {
          const wide = lane.viewport.width >= 769;
          const what = `the transcript's end as the pane classic showed is opened by its own row (${lane.acts.join(", Back, ")}), at ${lane.at}`;
          await withPage(browser, base, light, `/?pane=${encodeURIComponent(WORKING)}&view=chat`, what, async (page) => {
            const press = (target: ReturnType<typeof row>) => lane.touch ? target.tap() : target.click();
            const view = `[data-layout-pane="${WORKING}"] .chat-view`;
            const transcript = () => page.evaluate((selector) => {
              const node = document.querySelector<HTMLElement>(selector);
              const drawn = [...document.querySelectorAll(".chat-new-messages")].filter((control) => control.getClientRects().length > 0 && getComputedStyle(control).visibility === "visible");
              return node === null ? null : { short: Math.round(node.scrollHeight - node.clientHeight - node.scrollTop), controls: drawn.map((control) => control.getAttribute("aria-label") ?? control.textContent) };
            }, view);
            const atEnd = () => page.waitForFunction((selector) => {
              const node = document.querySelector<HTMLElement>(selector);
              return node !== null && node.querySelector("[data-chat-row]") !== null && node.clientHeight > 0 && node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
            }, view, { timeout: 5_000 }).then(() => true, () => false);
            await page.locator(".app-header.is-zoned").waitFor();
            // the demo ends the agent's turn on its own a few seconds in (the fixture holds its state): its last words are in
            // the transcript before the list covers it, so nothing grows it while it is read
            await page.waitForFunction((selector) => document.querySelector(selector)?.textContent?.includes("6 tests pass") === true, view, { timeout: 15_000 });
            assert.ok(await atEnd(), "the classic app's chat follows its transcript's end");
            if (wide) {
              await page.locator(OVIS_MARK).click();
              await page.locator(".inbox-column .mode-inbox").waitFor();
              await page.locator(".thread-chip").waitFor();
              await addressIs(page, { app: "inbox", pane: WORKING }, "a wide window's way in opens the pane's thread");
              await page.goBack();
              await page.locator(".inbox-unchosen").waitFor();
              await paneHiddenUnderList(page, "Back from the thread, the pane is mounted under the list, hidden");
            } else {
              await press(page.locator(".header-more-button"));
              await page.locator(".row-sheet").waitFor();
              await press(page.locator('.row-sheet [data-item="enter-inbox"]'));
              await sheetClosed(page);
              await listScreen(page);
            }
            await rowCount(page, 6);
            await frames(page);
            const covered = await transcript();
            assert.ok(covered !== null && covered.short <= 1, `under the list the transcript stands at its end: ${JSON.stringify(covered)}`);
            let opened = 0;
            for (const [index, act] of lane.acts.entries()) {
              if (index > 0) {
                await page.goBack();
                if (wide) await page.locator(".inbox-unchosen").waitFor(); else await listScreen(page);
                await rowCount(page, 6);
              }
              const pane = act === "another" ? BLOCKED : WORKING;
              if (act === "Enter") { await row(page, pane).focus(); await page.keyboard.press("Enter"); }
              else await press(row(page, pane));
              await page.locator(wide ? ".thread-chip" : "#inbox-back").waitFor();
              await addressIs(page, { app: "inbox", pane }, "the row's thread is drawn");
              if (pane !== WORKING) continue;
              opened += 1;
              const reached = await atEnd();
              // Give the thread's layout and effects a turn. Same-pane reopens can keep their
              // history with no new fetch, so wait for a loaded scroller and no pending read.
              await frames(page);
              await page.waitForFunction(({ selector, paneId }) => {
                const chat = document.querySelector(`${selector}[data-conversation-source="claude-transcript"]`);
                return chat !== null && chat.clientHeight > 0 && !window.inboxFixture.historyPending(paneId);
              }, { selector: view, paneId: pane }, { timeout: 5_000 });
              // Let the returned history render and the timeline handle its resize and scroll events.
              await frames(page);
              const shown = await transcript();
              assert.ok(reached && shown !== null && shown.short <= 1 && shown.controls.length === 0, `opened by ${act} (${opened}), the thread's transcript is at its end with no Jump to latest: ${JSON.stringify(shown)}`);
            }
            console.log(`PASS ${what}: under the list and in each thread at its end, with no Jump to latest`);
          }, lane.viewport, lane.touch);
        }

        await withPage(browser, base, light, `/?pane=${encodeURIComponent(WORKING)}&view=terminal`, "the thread's controls in the band over its terminal under a coarse pointer at 1440", async (page) => {
          assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true, "the pointer is coarse");
          await page.locator(".app-header.is-zoned").waitFor();
          await page.locator(OVIS_MARK).click();
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await row(page, WORKING).click();
          await page.locator(".thread-chip").waitFor();
          await page.locator(".thread-top .lens-toggle").click();
          await page.locator('.thread-top .lens-toggle[data-view="terminal"]').waitFor();
          const band = await box(page, ".thread-top");
          const [header, touch] = await page.evaluate(() => ["--header-h", "--touch-target-header"].map((name) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)))) as [number, number];
          near(band.h, header, 0.5, "the band is the classic header's height");
          for (const control of [".thread-top .lens-toggle", ".thread-top .header-more-button", ".thread-chip"]) {
            const at = await box(page, control);
            near(at.h, touch, 0.5, `${control} takes the header's touch size`);
            near(at.y + at.h / 2, band.y + band.h / 2, 0.5, `${control} sits on the band's middle`);
          }
          console.log(`PASS under a coarse pointer at 1440 the thread's controls over its terminal are the header's touch size (${touch}px) on the middle of the ${band.h}px band`);
        }, { width: 1440, height: 900 }, true);

        await withPage(browser, base, light, "/?app=inbox", "the command palette from the list's More", async (page) => {
          await listScreen(page);
          await rowCount(page, 6);
          await openSheet(page, ".inbox-more");
          assert.equal((await page.locator('.row-sheet [data-item="palette"] .row-sheet-label').textContent())?.trim(), "Search panes and actions");
          await page.locator('.row-sheet [data-item="palette"]').tap();
          await page.locator(".command-palette").waitFor();
          await page.locator(".row-sheet").waitFor({ state: "detached" });
          assert.equal(await page.locator(".mode-inbox").count(), 1, "the palette opens over the list");
          await page.goBack();
          await page.locator(".command-palette").waitFor({ state: "detached" });
          await listScreen(page);
          console.log("PASS Search panes and actions in the list's More opens the command palette over the list on a phone, and Back closes it");
        });

        for (const viewport of [PHONE, desktop]) {
          const at = viewport.width >= 769 ? "a wide window" : "a phone";
          await withPage(browser, base, light, "/?app=inbox", `the first paint of the mode's own address on ${at}`, async (page) => {
            await page.context().addInitScript(() => {
              const shells: string[] = [];
              window.inboxShells = shells;
              const note = (): void => {
                const root = document.getElementById("root");
                if (!root || root.childElementCount === 0) return;
                const has = (selector: string): boolean => root.querySelector(selector) !== null;
                const shell = has(".boot") ? "boot" : `${has(".app.is-inbox") ? "mode" : "classic"}${has(".app-header") ? " with a header" : ""}${has(".sidebar:not(.inbox-column)") ? " with the sidebar" : ""}`;
                if (shells.at(-1) !== shell) shells.push(shell);
              };
              new MutationObserver(note).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
            });
            const cold = await page.context().newPage();
            cold.on("pageerror", (error) => errors.push(`the first paint on ${at}: ${error.message}`));
            try {
              await cold.goto(`${base}/?app=inbox`);
              await cold.locator(".mode-inbox .inbox-item").first().waitFor();
              const shells = await cold.evaluate(() => window.inboxShells);
              assert.deepEqual(shells.filter((shell) => shell !== "boot"), ["mode"], `every shell the page drew is the mode's own: ${shells.join(", then ")}`);
            } finally { await cold.close(); }
            console.log(`PASS a cold load of the mode's own address on ${at} draws the mode's shell from its first paint: no classic header or sidebar`);
          }, viewport);
        }

        for (const theme of ["light", "dark"]) {
          await withPage(browser, base, { language: "en", theme }, "/?app=inbox", `${theme}: a press is a step past hover on a wide window`, async (page) => {
            await page.locator(".inbox-column .mode-inbox").waitFor();
            await rowCount(page, 6);
            await row(page, WORKING).click();
            await page.locator(".thread-chip").waitFor();
            const token = (value: string) => page.evaluate((css) => {
              const probe = document.createElement("span");
              probe.style.background = css;
              document.querySelector(".inbox-column")!.append(probe);
              const colour = getComputedStyle(probe).backgroundColor;
              probe.remove();
              return colour;
            }, value);
            const fills = (selector: string, colour: string, what: string) => page.waitForFunction(({ selector, colour }) =>
              getComputedStyle(document.querySelector(selector)!).backgroundColor === colour, { selector, colour }, { timeout: 5_000 }).catch(() => { throw new Error(`${what}: ${selector} is not ${colour}`); });
            const sideHover = await token("var(--side-hover)"), rowPress = await token("color-mix(in srgb, var(--side-selected), var(--border-strong))");
            const hover = await token("var(--bg-hover)"), strong = await token("var(--border-strong)");
            /** a computed colour's three channels, of 255: Chrome writes a mixed colour as color(srgb …), each of 1 */
            const channels = (colour: string): number[] => {
              const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(colour);
              return srgb ? srgb.slice(1, 4).map((value) => Number(value) * 255) : (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
            };
            const apart = (one: string, other: string): number => {
              const [a, b] = [channels(one), channels(other)];
              return Math.round(Math.max(...a.map((value, at) => Math.abs(value - b[at]!))));
            };
            // a press reads as a press: well past the 7 of 255 a row's press once stood from its hover in light
            for (const [press, over, what] of [[rowPress, sideHover, "a row's"], [strong, hover, "a round control's"]] as const) {
              assert.ok(apart(press, over) >= 15, `${what} press stands ${apart(press, over)} of 255 from its hover (${press} against ${over})`);
            }
            for (const [selector, over, pressed] of [
              [`.mode-inbox .inbox-item[data-pane="${BLOCKED}"] .inbox-row`, sideHover, rowPress],
              [".inbox-rail .inbox-rail-exit", sideHover, rowPress],
              [".inbox-column .inbox-filter-toggle", hover, strong],
              [".thread-top .header-more-button", hover, strong],
            ] as const) {
              const at = await box(page, selector);
              await page.mouse.move(at.x + at.w / 2, at.y + at.h / 2);
              await fills(selector, over, "under the pointer");
              await page.mouse.down();
              await fills(selector, pressed, "under a press");
              await page.mouse.move(at.x + at.w / 2, 450);
              await page.mouse.up();
            }
            await addressIs(page, { app: "inbox", pane: WORKING }, "no press opened anything");
            console.log(`PASS ${theme}: on a wide window a row and Back to Ovis take the open row's press under a press (${apart(rowPress, sideHover)} of 255 past hover), a round control its strong edge's colour (${apart(strong, hover)} past hover)`);
          }, desktop);
        }

        // Playwright hides Chrome's scrollbars in headless, and overlay scrollbars take no room: this browser keeps
        // Chrome's own, as a mouse user's Chrome on Windows and Linux shows them.
        const withBars = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"], ignoreDefaultArgs: ["--hide-scrollbars"] });
        try {
          await withPage(withBars, base, light, "/?app=inbox", "the column's rows under a scrollbar that takes room", async (page) => {
            await page.locator(".inbox-column .mode-inbox").waitFor();
            await rowCount(page, 6);
            const measure = () => page.evaluate(() => {
              const column = document.querySelector(".inbox-column")!.getBoundingClientRect();
              const rail = document.querySelector(".inbox-column .inbox-rail")!.getBoundingClientRect();
              const list = document.querySelector(".inbox-column .mode-inbox")!.getBoundingClientRect();
              const scroller = document.querySelector<HTMLElement>(".inbox-column .inbox-scroll")!;
              const rows = [...scroller.querySelectorAll(".inbox-row")].map((node) => node.getBoundingClientRect());
              return {
                bar: scroller.offsetWidth - scroller.clientWidth, scrolls: scroller.scrollHeight > scroller.clientHeight, sideways: scroller.scrollWidth - scroller.clientWidth,
                start: rows.map((rect) => rect.left - list.left), end: rows.map((rect) => column.right - rect.right), width: rows.map((rect) => rect.width), listStart: list.left - rail.right,
              };
            });
            const tall = await measure();
            assert.deepEqual([tall.scrolls, tall.bar], [false, 0], "six rows do not scroll in a 900px window");
            await page.setViewportSize({ width: desktop.width, height: 400 });
            await page.waitForFunction(() => { const scroller = document.querySelector(".inbox-column .inbox-scroll")!; return scroller.scrollHeight > scroller.clientHeight; });
            const short = await measure();
            assert.ok(short.bar > 0, `this browser's scrollbar takes room: ${short.bar}px`);
            for (const [name, facts] of [["without a scrollbar", tall], ["under a scrollbar", short]] as const) {
              assert.equal(facts.listStart, 0, `the list begins where the rail ends ${name}`);
              for (const inset of [...facts.start, ...facts.end]) near(inset, 12, 0.5, `a row's inset from the list's start and the column's end ${name}`);
            }
            assert.deepEqual(short.width, tall.width, "the rows are as wide under the scrollbar as without it");
            assert.equal(short.sideways, 0, "nothing scrolls sideways");
            console.log(`PASS under a scrollbar that takes room (${short.bar}px) the column's rows keep their 12px insets and their width (${Math.round(tall.width[0]!)}px): the scrollbar stands in the end inset`);
          }, desktop);

          await withPage(withBars, base, light, "/?app=inbox", "the column's scrollbar under the resize grip", async (page) => {
            await page.locator(".inbox-column .mode-inbox").waitFor();
            await rowCount(page, 6);
            await page.setViewportSize({ width: desktop.width, height: 400 });
            await page.waitForFunction(() => { const list = document.querySelector<HTMLElement>(".inbox-column .inbox-scroll"); return list !== null && list.scrollHeight > list.clientHeight; });
            const edge = () => page.evaluate(() => {
              const list = document.querySelector<HTMLElement>(".inbox-column .inbox-scroll")!;
              const box = list.getBoundingClientRect();
              const border = parseFloat(getComputedStyle(list).borderRightWidth) || 0;
              const grip = document.querySelector(".inbox-column .sidebar-resizer")!.getBoundingClientRect();
              return {
                top: box.top, right: box.right - border, bar: list.offsetWidth - list.clientWidth - list.clientLeft - border, scrolled: list.scrollTop,
                column: Math.round(document.querySelector(".inbox-column")!.getBoundingClientRect().width), grip: { left: grip.left, right: grip.right },
              };
            });
            const landsOn = (x: number, y: number, want: "grip" | "list") => page.waitForFunction(([px, py, target]) => {
              const element = document.elementFromPoint(px as number, py as number);
              const on = element?.closest(".sidebar-resizer") ? "grip" : element?.closest(".inbox-column .inbox-scroll") ? "list" : "other";
              return on === target;
            }, [x, y, want] as const, { timeout: 5_000 }).then(() => true, () => false);
            const start = await edge();
            assert.ok(start.bar > 0 && start.grip.left < start.right - start.bar, `the grip's box reaches over the list's ${start.bar}px scrollbar (grip from ${start.grip.left}px, scrollbar ${start.right - start.bar}-${start.right}px)`);
            const barX = start.right - start.bar / 2;
            const barY = start.top + start.bar + 10;
            await page.mouse.move(barX - 60, barY);
            await page.mouse.move(barX, barY, { steps: 4 });
            assert.ok(await landsOn(barX, barY, "list"), "a mouse resting on the list's scrollbar under the grip reaches the list");
            await page.mouse.down();
            await page.mouse.move(barX, barY + 60, { steps: 6 });
            await page.mouse.up();
            await page.waitForFunction(() => document.querySelector<HTMLElement>(".inbox-column .inbox-scroll")!.scrollTop > 0, undefined, { timeout: 5_000 });
            const scrolled = await edge();
            assert.equal(scrolled.column, start.column, "dragging the scrollbar leaves the column's width");
            const stripX = start.right + (start.grip.right - start.right) / 2;
            await page.mouse.move(stripX, barY, { steps: 3 });
            assert.ok(await landsOn(stripX, barY, "grip"), "the strip beside the scrollbar is the grip's");
            await page.mouse.down();
            await page.mouse.move(stripX + 30, barY, { steps: 3 });
            await page.mouse.up();
            await page.waitForFunction((was) => Math.round(document.querySelector(".inbox-column")!.getBoundingClientRect().width) !== was, start.column, { timeout: 5_000 });
            const resized = await edge();
            assert.equal(resized.column, start.column + 30, "the strip beside the scrollbar resizes the column");
            console.log(`PASS the column's list scrollbar (${start.bar}px) under the resize grip scrolls the list by a drag (column stays ${start.column}px), and the strip beside it resizes the column to ${resized.column}px`);
          }, desktop);
        } finally { await withBars.close(); }

        // herdr tells no time of a state change: a wait is timed from when this device saw it begin (the stamps the
        // Agents list reads, lib/agentStateSince.ts), and one no page of the device saw begin from the agent's last
        // message (the summary's time of its last words).
        const lastMessageAt = (page: Page, pane: string): Promise<string | null> => page.evaluate(async (id) => {
          const answer = await (await fetch(`/api/pane/summary?pane_id=${encodeURIComponent(id)}`)).json() as { summaries: Record<string, { at: string | null } | null> };
          return answer.summaries[id]?.at ?? null;
        }, pane);
        const spokeThen = (drawn: string | null | undefined, spoke: string | null): boolean =>
          drawn !== null && drawn !== undefined && spoke !== null && Math.abs(Date.parse(drawn) - Date.parse(spoke)) <= 2_000;
        await withPage(browser, base, light, `/?pane=${encodeURIComponent(DONE)}&view=chat`, "the time of a wait the page saw begin", async (page) => {
          await page.locator(".context-title-text").waitFor();
          const seen = await page.evaluate(() => window.inboxFixture.rosters);
          const began = await page.evaluate(() => Date.now());
          await page.evaluate((pane) => window.inboxFixture.set(pane, "blocked"), WORKING);
          await page.waitForFunction((count) => window.inboxFixture.rosters > count, seen);
          await enterFromMore(page);
          await rowCount(page, 6);
          await page.waitForFunction((pane) => document.querySelector(`.mode-inbox .inbox-item[data-pane="${pane}"]`)?.getAttribute("data-state") === "blocked", WORKING);
          const waiting = (await rows(page)).filter((item) => item.state === "blocked");
          assert.deepEqual(new Set(waiting.map((item) => item.pane)), new Set([BLOCKED, WORKING]), "two agents wait");
          const own = waiting.find((item) => item.pane === WORKING);
          assert.ok(own?.datetime !== null && own?.datetime !== undefined && Date.parse(own.datetime) >= began - 1_000, `the wait this page saw begin, in the classic app, is timed from its beginning: ${JSON.stringify(own)}`);
          await page.waitForFunction((pane) => document.querySelector(`.mode-inbox .inbox-item[data-pane="${pane}"] time.inbox-time`) !== null, BLOCKED, { timeout: 15_000 });
          const before = (await rows(page)).find((item) => item.pane === BLOCKED);
          const spoke = await lastMessageAt(page, BLOCKED);
          assert.ok(spokeThen(before?.datetime, spoke), `the wait that began before the page opened is timed from the agent's last message (${spoke}): ${JSON.stringify(before)}`);
          console.log(`PASS a row times the wait this page saw begin from its beginning (${own!.time}), and one that began before the page opened from the agent's last message (${before!.time})`);
        });

        await withPage(browser, base, light, "/?app=inbox", "every row's time on a cold load", async (page) => {
          await listScreen(page);
          await rowCount(page, 6);
          const timed = await page.waitForFunction(() => [...document.querySelectorAll(".mode-inbox .inbox-item")].every((item) => item.querySelector("time.inbox-time") !== null), undefined, { timeout: 15_000 }).then(() => true, () => false);
          const drawn = await rows(page);
          assert.ok(timed, `every row draws a time: ${JSON.stringify(drawn.map((item) => [item.pane, item.time]))}`);
          const waiting = drawn.find((item) => item.pane === BLOCKED);
          const spoke = await lastMessageAt(page, BLOCKED);
          assert.ok(waiting?.state === "blocked" && spokeThen(waiting.datetime, spoke), `the waiting row is timed from its last message (${spoke}): ${JSON.stringify(waiting)}`);
          console.log(`PASS on a cold load every row draws a time, the waiting row its last message's (${waiting!.time})`);
        });

        for (const [route, path] of [["entered from a pane", `/?pane=${encodeURIComponent(WORKING)}&view=chat&demo_connection=switch`], ["opened cold, no pane mounted", "/?app=inbox&demo_connection=switch"]] as const)
        for (const viewport of [PHONE, desktop]) {
          const wide = viewport.width >= 769;
          const at = `${wide ? "a wide window" : "a phone"}, ${route}`;
          await withPage(browser, base, light, path, `the list while the connection is lost, on ${at}`, async (page) => {
            const line = page.locator(".mode-inbox .inbox-top .inbox-connection");
            const pc = page.locator(".inbox-rail .inbox-rail-pcs");
            const dot = pc.locator(".inbox-rail-dot");
            const status = page.locator(wide ? '.inbox-rail > [role="status"]' : '.mode-inbox .inbox-top [role="status"]');
            if (route === "entered from a pane") {
              await page.locator(".conn-live").waitFor({ state: "attached" });
              if (wide) {
                await page.locator(OVIS_MARK).click();
                await page.locator(".inbox-column .mode-inbox").waitFor();
                await page.locator(".thread-chip").waitFor();
                await addressIs(page, { app: "inbox", pane: WORKING }, "a wide window's way in opens the pane's thread");
                await page.goBack();
                await page.locator(".inbox-unchosen").waitFor();
                await paneHiddenUnderList(page, "Back from the thread, the pane is mounted under the list, hidden");
              } else await enterFromMore(page);
            } else {
              await page.locator(".mode-inbox").waitFor();
              assert.deepEqual([await page.locator(".pane-slot").count(), await page.locator(".conn-live").count()], [0, 0], "a cold load of the list mounts no pane, and no pane's connection says anything");
            }
            await rowCount(page, 6);
            assert.equal(await line.count(), 0, "connected, the list draws no line");
            if (wide) {
              assert.equal(await page.locator('.mode-inbox .inbox-top [role="status"]').count(), 0, "the wide list has no line for the connection, drawn or only said");
              assert.deepEqual([await dot.count(), await pc.getAttribute("aria-label"), await pc.getAttribute("title")], [0, "PC workstation · Connected", "PC workstation · Connected"],
                "connected, the rail's PC draws no dot and says so in its name and its tooltip");
            }
            assert.equal(await status.count() >= 1, true, "the status line is in the document before it has a word");
             await page.waitForFunction(() => window.inboxFixture.rosterOpen, undefined, { timeout: 15_000 });
            await page.evaluate(() => { window.herdrDemoLoseConnection(); window.inboxFixture.dropRoster(); });
            if (wide) {
              await dot.waitFor();
              assert.equal(await line.count(), 0, "lost, the wide list draws no line: the rail's PC says it");
              const lost = await pc.evaluate((button) => {
                const mark = button.querySelector(".inbox-rail-dot")!;
                const glyph = button.querySelector("svg")!.getBoundingClientRect();
                const box = mark.getBoundingClientRect();
                const style = getComputedStyle(mark);
                const probe = document.createElement("span");
                probe.style.cssText = "position: absolute; color: var(--status-reconnecting); width: var(--dot-size)";
                button.parentElement!.append(probe);
                const want = { fill: getComputedStyle(probe).color, size: getComputedStyle(probe).width };
                probe.remove();
                return {
                  state: mark.className, hidden: mark.getAttribute("aria-hidden"), fill: style.backgroundColor, size: [`${box.width}px`, `${box.height}px`], want,
                  ring: style.outlineColor, on: getComputedStyle(button).backgroundColor, pulse: style.animationName,
                  corner: [box.left + box.width / 2 - glyph.right, box.top + box.height / 2 - glyph.bottom],
                  name: button.getAttribute("aria-label"), title: button.getAttribute("title"), said: button.closest(".inbox-rail")!.querySelector('[role="status"]')?.textContent ?? null,
                };
              });
              assert.deepEqual([lost.name, lost.title, lost.said], ["PC workstation · Reconnecting…", "PC workstation · Reconnecting…", "Reconnecting…"], "lost, the rail's PC says Reconnecting… in its name and its tooltip, and its status line says it");
              assert.deepEqual([lost.state, lost.hidden], ["inbox-rail-dot is-reconnecting", "true"], "its dot is drawn for the lost connection, as a drawing: the name says the word");
              assert.deepEqual([lost.fill, lost.size], [lost.want.fill, [lost.want.size, lost.want.size]], "the dot is --status-reconnecting at --dot-size");
              assert.equal(lost.ring, lost.on, "the dot is ringed with the fill its button stands on");
              assert.equal(lost.pulse, "pulse", "the dot pulses, as the header's connection dot does while it reconnects");
              for (const offset of lost.corner) assert.ok(Math.abs(offset) <= 4, `the dot hangs on the glyph's lower end corner: it is ${lost.corner.join(", ")}px from it`);
            } else {
              await line.waitFor();
              assert.equal(await line.getAttribute("role"), "status", "the line is a status");
              const drawn = await line.evaluate((node) => {
                const box = node.getBoundingClientRect();
                const style = getComputedStyle(node);
                const probe = document.createElement("span");
                probe.style.cssText = "color: var(--text-dim); font-size: var(--fs-xs)";
                node.parentElement!.append(probe);
                const want = { color: getComputedStyle(probe).color, size: getComputedStyle(probe).fontSize };
                probe.remove();
                const control = document.querySelector(".mode-inbox .inbox-top .inbox-round");
                const disc = control?.getBoundingClientRect();
                const surface = (of: CSSStyleDeclaration) => ({ fill: of.backgroundColor, edge: `${of.borderTopWidth} ${of.borderTopStyle} ${of.borderTopColor}`, shadow: of.boxShadow });
                return {
                  centre: box.left + box.width / 2, left: box.left, size: style.fontSize, color: style.color, want,
                  middle: box.top + box.height / 2, height: box.height, radius: Number.parseFloat(style.borderTopLeftRadius),
                  surface: surface(style), round: control ? surface(getComputedStyle(control)) : null, discMiddle: disc ? disc.top + disc.height / 2 : null,
                };
              });
              assert.deepEqual([drawn.color, drawn.size], [drawn.want.color, drawn.want.size], "the line is --text-dim at --fs-xs");
              assert.deepEqual(drawn.surface, drawn.round, "a phone's line is drawn on the round controls' surface: their fill, hairline edge and shadow");
              assert.notEqual(drawn.surface.shadow, "none", "the pill casts the controls' shadow");
              assert.ok(drawn.radius >= drawn.height / 2, `the pill is fully round: a radius of ${drawn.radius} for a height of ${drawn.height}`);
              assert.ok(drawn.discMiddle !== null, "a round control stands in a phone's top row");
              near(drawn.middle, drawn.discMiddle, 0.5, "the pill stands on the round controls' centre line");
              near(drawn.centre, viewport.width / 2, 1, "the line is centred between the two top controls");
            }
            // Connected is said for two seconds: caught in the mutation that draws it, so a slow run cannot miss it. A
            // connection that never comes back fails the step by a deadline, and the page's observer goes either way
            const back = await page.evaluate(([zone, word]) => new Promise<{ said: string; dot: string | null; name: string | null }>((resolve, reject) => {
              const top = document.querySelector(zone!)!;
              const deadline = window.setTimeout(() => { observer.disconnect(); reject(new Error("the list never said Connected within 15 s")); }, 15_000);
              const observer = new MutationObserver(() => {
                const said = top.querySelector(word!)?.textContent ?? "";
                if (said !== "Connected") return;
                observer.disconnect();
                window.clearTimeout(deadline);
                resolve({ said, dot: top.querySelector(".inbox-rail-dot")?.className ?? null, name: top.querySelector(".inbox-rail-pcs")?.getAttribute("aria-label") ?? null });
              });
              observer.observe(top, { subtree: true, childList: true, characterData: true, attributes: true });
              window.herdrDemoRestoreConnection();
              window.inboxFixture.restoreRoster();
              window.dispatchEvent(new Event("online"));
            }), wide ? [".inbox-rail", '[role="status"]'] : [".mode-inbox .inbox-top", ".inbox-connection"]);
            assert.equal(back.said, "Connected", "back, the line says so");
            if (wide) {
              assert.deepEqual([back.dot, back.name], ["inbox-rail-dot is-connected", "PC workstation · Connected"], "back, the rail's PC draws the connected dot for as long as the word is said");
              await dot.waitFor({ state: "detached" });
              assert.equal(await line.count(), 0, "and the wide list drew no line at any point");
            } else await line.waitFor({ state: "detached" });
            console.log(wide
              ? `PASS on ${at} the rail's PC says Reconnecting… in its name, its tooltip and its status line, and draws its pulsing dot, while the connection is lost on the list alone; Connected with the connected dot when it is back, and then no dot; the wide list draws no line`
              : `PASS on ${at} the list says Reconnecting… in one quiet line (a round pill on the round controls' surface and centre line) while the connection is lost, Connected when it is back, and then nothing`);
          }, viewport);
        }

        await withPage(browser, base, light, `/?pane=${encodeURIComponent(WORKING)}&view=chat&demo_connection=switch`, "one word for a lost connection beside a wide thread", async (page) => {
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await page.locator(OVIS_MARK).click();
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await rowCount(page, 6);
          await row(page, WORKING).click();
          await page.locator(".thread-chip").waitFor();
           await page.waitForFunction(() => window.inboxFixture.rosterOpen, undefined, { timeout: 15_000 });
          await page.evaluate(() => { window.herdrDemoLoseConnection(); window.inboxFixture.dropRoster(); });
          await page.locator(".thread-chip-state.is-reconnecting").waitFor();
          // the roster's stream is lost by itself, apart from the chip's own connection, and can be told later: the
          // rail's own word for it is waited for before the rail is read
          const told = await page.waitForFunction(() => document.querySelector(".inbox-rail .inbox-rail-pcs")?.getAttribute("aria-label") === "PC workstation · Reconnecting…", undefined, { timeout: 15_000 }).then(() => true, () => false);
          assert.ok(told, `the rail's PC says the connection is lost: it is named ${await page.locator(".inbox-rail .inbox-rail-pcs").getAttribute("aria-label")}`);
          assert.equal(await page.locator(".inbox-column .inbox-top .inbox-connection").count(), 0, "the column does not say what the thread's chip says");
          assert.deepEqual(await page.locator(".inbox-rail").evaluate((rail) => [rail.querySelectorAll(".inbox-rail-dot").length, rail.querySelector('[role="status"]')?.textContent ?? null, rail.querySelector(".inbox-rail-pcs")?.getAttribute("aria-label") ?? null]),
            [0, "", "PC workstation · Reconnecting…"], "the rail's PC draws no dot and announces nothing while the thread's chip says the same word");
          console.log("PASS on a wide window a lost connection is said once, by the thread's chip: the list draws no line and the rail's PC no dot while they would say the same word");
        }, desktop);

        for (const [viewport, language] of [[PHONE, "en"], [desktop, "en"], [desktop, "ko"]] as const) {
          const wide = viewport.width >= 769;
          const at = `${wide ? "a wide window" : "a phone"}${language === "en" ? "" : ` in ${language}`}`;
          await withPage(browser, base, { ...light, language }, "/?app=inbox&inbox_fail=roster", `the list whose load failed, on ${at}`, async (page) => {
            const failure = page.locator('.mode-inbox [role="alert"]');
            await failure.waitFor();
            assert.equal(await page.locator(".mode-inbox .inbox-empty").count(), 0, "a failed load is not said to be loading");
            const said = await failure.evaluate((alert) => [".inbox-failed-line", ".inbox-failed-cause"].map((selector) => {
              const line = alert.querySelector(selector);
              return { words: line?.textContent?.trim() ?? "", size: line ? parseFloat(getComputedStyle(line).fontSize) : 0 };
            }));
            const [line, own] = said as [{ words: string; size: number }, { words: string; size: number }];
            assert.equal(line.words, language === "ko" ? KO["Couldn't load the list."] : "Couldn't load the list.", "the failure says what happened in the app's words");
            assert.ok(own.words.length > 0 && own.size < line.size, `the read's own message is under it, smaller (${own.size}px under ${line.size}px)`);
            const cause = own.words;
            const retry = page.locator(".mode-inbox .inbox-failed").getByRole("button");
            assert.equal(await retry.count(), 1, "the failure has one button");
            const ready = await box(page, ".mode-inbox .inbox-retry");
            if (!wide) assert.ok(ready.h >= 44, "Retry is a touch target on a phone");
            await page.evaluate(() => window.inboxFixture.holdRoster(true));
            await retry.focus();
            await page.keyboard.press("Enter");
            await page.locator('.mode-inbox .inbox-retry[aria-disabled="true"][aria-busy="true"]').waitFor();
            await page.keyboard.press("Enter");
            await retry.click({ force: true });
            const onItsWay = await page.evaluate(() => {
              const button = document.querySelector(".mode-inbox .inbox-retry")!;
              const words = document.querySelector(".mode-inbox .inbox-failed-words")!;
              return {
                focused: document.activeElement === button, busy: button.getAttribute("aria-disabled"),
                said: [...button.querySelectorAll(".inbox-retry-words > span")].filter((span) => getComputedStyle(span).visibility === "visible").map((span) => span.textContent),
                role: words.getAttribute("role"), line: words.querySelector(".inbox-failed-line")?.textContent, message: getComputedStyle(words.querySelector(".inbox-failed-cause")!).visibility,
                alerts: document.querySelectorAll('.mode-inbox [role="alert"]').length,
              };
            });
            assert.deepEqual(onItsWay, { focused: true, busy: "true", said: [language === "ko" ? KO["Retrying…"] : "Retrying…"], role: "status", line: language === "ko" ? KO["Loading…"] : "Loading…", message: "hidden", alerts: 0 },
              "on its way, Retry says so and keeps the focus, and the loading words stand where the failure was");
            sameBox(await box(page, ".mode-inbox .inbox-retry"), ready, "Retry keeps its box while its read is on its way");
            await page.evaluate(() => window.inboxFixture.holdRoster(false));
            await page.locator('.mode-inbox .inbox-retry:not([aria-disabled])').waitFor();
            await failure.waitFor();
            sameBox(await box(page, ".mode-inbox .inbox-retry"), ready, "Retry keeps its box once its read has failed");
            assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("inbox-retry")), true, "the focus is still on Retry");
            // the failure ends and Retry is pressed in one task: no background read can come between, and the read the
            // press makes is counted as it is made
            const asked = await page.evaluate(() => {
              window.inboxFixture.failRoster(false);
              const before = window.inboxFixture.rosterReads;
              document.querySelector<HTMLButtonElement>(".mode-inbox .inbox-retry")!.click();
              return window.inboxFixture.rosterReads - before;
            });
            assert.ok(asked > 0, `Retry asks for the roster (${asked} reads)`);
            await rowCount(page, 6);
            assert.equal(await failure.count(), 0, "loaded, the list has no failure to say");
            const focusAt = await page.evaluate(() => { const at = document.activeElement; return at === null || at === document.body ? "the page's body" : `${at.tagName.toLowerCase()}.${String(at.className)}`; });
            assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".mode-inbox")), true, `the rows drawn, the focus is on the list: it is on ${focusAt}`);
            console.log(`PASS on ${at} a list whose load failed says so in the app's words, its read's message (${cause}) smaller under them, and one Retry, which says it is on its way in the box it had while its read is held, keeps the focus, and loads the rows with the focus on the list`);
            // the language is shared and the demo's follows the browser's: a Korean browser is what makes the page Korean
          }, viewport, viewport.width < 769, language === "ko" ? "ko-KR" : "en-US");
        }

        await withPage(browser, base, light, `/?pane=${encodeURIComponent(WORKING)}&view=chat&file=README.md`, "entering the mode with a file open over the pane", async (page) => {
          await page.locator(".file-viewer").waitFor();
          await page.keyboard.press("Control+Shift+K");
          await page.locator(".command-palette .palette-search input").fill(">open agent inbox");
          await page.locator(".command-palette .menu-item-main", { hasText: "Open agent inbox" }).waitFor();
          await page.keyboard.press("Enter");
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await page.locator(".file-viewer").waitFor({ state: "detached" });
          await page.locator(".thread-chip").waitFor();
          assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get("file")), null, "the thread's address names no file");
          await addressIs(page, { app: "inbox", pane: WORKING }, "the mode opens on the pane's thread");
          await page.goBack();
          await page.locator(".inbox-unchosen").waitFor();
          await page.goBack();
          await page.locator(".file-viewer").waitFor();
          await page.locator(".mode-inbox").waitFor({ state: "detached" });
          assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get("file")), "README.md");
          await addressIs(page, { app: null, pane: WORKING }, "Back returns to the pane the file is open on");
          console.log("PASS entering the mode with a file open over the pane closes the viewer and opens the pane's thread; Back is the list, and Back again shows the pane with its file");
        }, desktop);

        await withPage(browser, base, light, "/?app=inbox", "the system Back with the pane's More open in a wide thread", async (page) => {
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await rowCount(page, 6);
          await row(page, WORKING).click();
          await page.locator(".thread-chip").waitFor();
          await page.locator(".thread-top .header-more-button").click();
          await page.locator(".row-menu").waitFor();
          await page.goBack();
          await page.locator(".inbox-unchosen").waitFor();
          await page.locator(".row-menu").waitFor({ state: "detached" });
          assert.equal(await page.locator(".inbox-column .inbox-more").count(), 0, "the column draws no More");
          assert.deepEqual(await page.locator(".inbox-column [aria-haspopup]").evaluateAll((nodes) => [...new Set(nodes.map((node) => node.getAttribute("aria-expanded")))]), ["false"],
            "no control of the column claims the menu the pane's More left");
          await addressIs(page, { app: "inbox", pane: null }, "Back from the thread is the list's address");
          console.log("PASS the system Back from a wide thread with the pane's More open closes the menu with its button, and shows the list with no agent chosen");
        }, desktop);

      }
      if (part === "rail") {
        for (const gone of [
          { what: "its workspace still open", path: `/?app=inbox&ws=w1C-checkout-api&pane=${encodeURIComponent("w1C:p9")}&view=chat`, note: "That link's chat is closed" },
          { what: "its workspace closed too", path: `/?app=inbox&pane=${encodeURIComponent("w9Z:p9")}&view=chat`, note: "That link's workspace is closed" },
          { what: "its PC not set up here", path: `/?app=inbox&machine=not-here&pane=${encodeURIComponent(WORKING)}&view=chat`, note: "That link's PC is not set up here" },
        ]) {
          for (const viewport of [PHONE, desktop]) {
            const at = viewport.width >= 769 ? "a wide window" : "a phone";
            await withPage(browser, base, light, gone.path, `a thread's address whose pane is gone, ${gone.what}, on ${at}`, async (page) => {
              await page.locator(".header-note").getByText(gone.note).waitFor();
              await page.locator(".mode-inbox").waitFor();
              await rowCount(page, 6);
              if (viewport.width >= 769) {
                await page.locator(".inbox-unchosen").waitFor();
                assert.equal(await page.locator('.mode-inbox .inbox-row[aria-current="true"]').count(), 0, "no row is the open one");
              } else assert.equal(await page.locator(".app-header").count(), 0, "the list is the screen: no thread's header");
              await addressIs(page, { app: "inbox", pane: null }, "the address is the list's");
              console.log(`PASS an address of the mode whose pane is gone (${gone.what}) opens the list on ${at}, under the note "${gone.note}"`);
            }, viewport);
          }
        }

        await withPage(browser, base, light, `/?pane=${encodeURIComponent(WORKING)}&view=terminal`, "the Ovis mark at the top left enters the mode", async (page) => {
          await page.locator(".app-header.is-zoned").waitFor();
          const classic = await terminalBox(page);
          await terminalSettled(page, 1);
          const sent = async (since: number): Promise<Window["inboxFixture"]["frames"]> => (await page.evaluate(() => window.inboxFixture.frames.slice())).slice(since)
            .filter((frame) => frame.type === "attach" || frame.type === "detach" || frame.type === "resize" || frame.type === "release-size");
          const before = await page.evaluate(() => window.inboxFixture.frames.length);
          const mark = page.locator(".header-side .sidebar-brand");
          assert.deepEqual(await mark.evaluate((node) => [node.tagName, node.getAttribute("aria-label"), node.getAttribute("title")]), ["BUTTON", "Open agent inbox", "Open agent inbox"],
            "the Ovis mark at the top left is a button named, and titled, for the way in");
          assert.ok((await mark.boundingBox())!.height < 44, "with a mouse the mark keeps its slim box");
          const entries = await historyLength(page);
          await mark.click();
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await page.locator(".inbox-unchosen").waitFor();
          await addressIs(page, { app: "inbox", pane: null }, "a click on the Ovis mark enters the mode on its list");
          assert.equal(await historyLength(page), entries + 1, "entering is one entry");
          assert.equal(await page.locator('.mode-inbox .inbox-row[aria-current="true"]').count(), 0, "no row is open: the pane showed its terminal");
          await terminalSettled(page);
          assert.deepEqual(await sent(before), [], "entering from a pane on its terminal sends no attach, detach, size or release");
          await page.locator(".inbox-rail .inbox-rail-exit").click();
          await page.locator(".app-header.is-zoned").waitFor();
          await page.locator('.view-switch .lens-option.is-terminal[aria-pressed="true"]').waitFor();
          await addressIs(page, { app: null, pane: WORKING }, "Back to Ovis shows the pane the classic app was on");
          sameBox(await terminalBox(page), classic, "back in the classic app the terminal has the box it had");
          await terminalSettled(page);
          assert.deepEqual(await sent(before), [], "Back to Ovis sends no attach, detach, size or release");
          const again = await historyLength(page);
          await mark.focus();
          await page.keyboard.press("Enter");
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await page.locator(".inbox-unchosen").waitFor();
          assert.equal(await historyLength(page), again + 1, "Enter on the mark enters by one entry");
          console.log("PASS at 1440 the Ovis mark at the sidebar's head is a button named Open agent inbox: a click, and Enter on it, enter the mode by one entry; from a pane on its terminal on the list with nothing chosen, and neither the way in nor Back to Ovis, which shows the terminal in its box, sends any pane an attach, detach, size or release");
        }, desktop);
        await withPage(browser, base, light, `/?pane=${encodeURIComponent(WORKING)}&view=chat`, "the Ovis mark under a finger from 769px", async (page) => {
          await page.locator(".app-header.is-zoned").waitFor();
          const target = (await page.locator(".header-side .sidebar-brand").boundingBox())!;
          assert.ok(target.height >= 44 && target.width >= 44, `under a coarse pointer the mark is a 44px target: ${Math.round(target.width)} by ${Math.round(target.height)}`);
          console.log(`PASS at 1024 under a coarse pointer the Ovis mark is a ${Math.round(target.width)} by ${Math.round(target.height)} target`);
        }, { width: 1024, height: 768 }, true);

        await withPage(browser, base, light, `/?pane=${encodeURIComponent(WORKING)}&view=chat`, "the classic app and the mode are one place", async (page) => {
          const composer = page.locator("textarea.composer-text").first();
          const draftIs = (text: string): Promise<boolean> => page.waitForFunction((want) => document.querySelector<HTMLTextAreaElement>("textarea.composer-text")?.value === want, text, { timeout: 5_000 }).then(() => true, () => false);
          const scrolledTo = (selector: string, top: number): Promise<boolean> => page.waitForFunction(([where, at]) => {
            const node = document.querySelector(where as string);
            return node !== null && Math.abs(node.scrollTop - (at as number)) <= 2;
          }, [selector, top] as const, { timeout: 5_000 }).then(() => true, () => false);
          const scrollOf = (selector: string): Promise<number> => page.locator(selector).first().evaluate((node) => node.scrollTop);
          const thread = `[data-layout-pane="${BLOCKED}"] .chat-view`;
          const draftX = "a draft typed in the classic app";
          const draftY = "a draft typed in the thread";
          await page.locator(".app-header.is-zoned").waitFor();
          await page.evaluate(() => (window as unknown as { __herdrDemoOrder: { addPc: () => string } }).__herdrDemoOrder.addPc());
          for (const pane of IDLE) await page.evaluate((idle) => window.inboxFixture.set(idle, "done"), pane);
          await composer.fill(draftX);
          await page.locator('.view-switch .lens-option.is-chat[aria-pressed="true"]').waitFor();
          const framesBefore = await page.evaluate(() => window.inboxFixture.frames.length);

          await page.locator(OVIS_MARK).click();
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await addressIs(page, { app: "inbox", pane: WORKING }, "entering opens the thread of the pane the classic app was on");
          await page.locator(".thread-chip").waitFor();
          assert.ok(await draftIs(draftX), `the thread has the draft typed in the classic app: it has "${await composer.inputValue()}"`);
          await terminalSettled(page);
          assert.deepEqual((await page.evaluate((count) => window.inboxFixture.frames.slice(count), framesBefore)).filter((frame) => frame.type === "resize" || frame.type === "release-size"), [],
            "entering on the pane's chat sends no size or release");

          await row(page, BLOCKED).click();
          await addressIs(page, { app: "inbox", pane: BLOCKED }, "a row opens its thread");
          await composer.fill(draftY);
          await page.waitForFunction((selector) => { const node = document.querySelector(selector); return node !== null && node.scrollHeight - node.clientHeight > 100; }, thread, { timeout: 15_000 });
          await page.locator(thread).evaluate((node) => { node.scrollTop = Math.round((node.scrollHeight - node.clientHeight) / 2); });
          await frames(page);
          const threadTop = await scrollOf(thread);
          await page.locator(".inbox-filter-toggle").click();
          await page.locator('.row-menu [data-item="done"]').click();
          await rowCount(page, 8);
          const filterLabel = await page.locator(".inbox-filter-toggle").getAttribute("aria-label");
          const list = ".inbox-scroll";
          assert.ok(await page.locator(list).evaluate((node) => node.scrollHeight - node.clientHeight > 40), "the filtered list scrolls on this window");
          await page.locator(list).evaluate((node) => { node.scrollTop = node.scrollHeight; });
          await frames(page);
          const listTop = await scrollOf(list);

          await page.locator(".inbox-rail .inbox-rail-exit").click();
          await page.locator(".app-header.is-zoned").waitFor();
          await addressIs(page, { app: null, pane: BLOCKED }, "Back to Ovis shows the thread's pane in the classic app");
          assert.ok(await draftIs(draftY), `the classic app's composer has the thread's draft: it has "${await composer.inputValue()}"`);

          await page.locator(OVIS_MARK).click();
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await addressIs(page, { app: "inbox", pane: BLOCKED }, "entering again opens the thread that was left");
          assert.ok(await draftIs(draftY), `the thread's draft waits in its composer: it has "${await composer.inputValue()}"`);
          assert.ok(await scrolledTo(thread, threadTop), `the thread is where it was left (${threadTop}px): it is at ${await scrollOf(thread)}px`);
          assert.equal(await page.locator(".inbox-filter-toggle").getAttribute("aria-label"), filterLabel, "the list's filter is as it was left");
          await rowCount(page, 8);
          assert.ok(await scrolledTo(list, listTop), `the list is where it was left (${listTop}px): it is at ${await scrollOf(list)}px`);

          await page.reload();
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await addressIs(page, { app: "inbox", pane: BLOCKED }, "a reload keeps the thread");
          await page.locator(".thread-chip").waitFor();
          assert.equal(await page.locator(".inbox-filter-toggle").getAttribute("aria-label"), filterLabel, "a reload keeps the list's filter");
          assert.ok(await draftIs(draftY), `a reload keeps the thread's draft in its composer: it has "${await composer.inputValue()}"`);
          console.log(`PASS classic and the mode are one place: entering opens the classic pane's thread with its draft; Back to Ovis shows the thread's pane with its draft; entering again keeps the thread, its draft, its scroll (${threadTop}px), the filter and the list's scroll (${listTop}px); a reload keeps the thread, its draft and the filter`);
        }, { width: 1440, height: 480 });

        // ---- a chat pane not drawn alone, or under a peek: the way in opens the list and sends nothing ----
        // Its thread alone would hide or unmount what else the classic app draws (a herdr split's sibling, the app's own
        // split's other half), or end a terminal peek: each gives up or asks a pty's size. So the way in opens the list,
        // as the mode always did, and nothing is sent for any pane from before it through an untouched Back to Ovis.
        const FLAKY = "w1H:p1";
        const drawnScreens = (page: Page): Promise<Record<string, Box>> => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("[data-layout-pane]")].flatMap((frame) => {
          const screen = frame.querySelector(".xterm-screen");
          if (!screen) return [];
          const box = screen.getBoundingClientRect();
          return box.width > 0 ? [[frame.getAttribute("data-layout-pane"), { x: box.x, y: box.y, w: box.width, h: box.height, right: box.right, bottom: box.bottom }]] : [];
        })));
        for (const setup of [
          { name: "a herdr tab split, the selected pane on its chat beside a terminal", path: `/?pane=${encodeURIComponent(WORKING)}&view=chat`, pane: WORKING },
          { name: "the classic app's split, the active half on its chat, the other on its terminal", path: `/?pane=${encodeURIComponent(WORKING)}&view=chat`, pane: WORKING },
          { name: "a terminal peek over a chat pane", path: `/?pane=${encodeURIComponent(FLAKY)}&view=chat`, pane: FLAKY },
        ]) {
          await withPage(browser, base, light, setup.path, `the way in from ${setup.name} opens the list`, async (page) => {
            await page.locator(".app-header.is-zoned").waitFor();
            const chatOn = page.locator('.view-switch .lens-option.is-chat[aria-pressed="true"]');
            if (setup.name.startsWith("a herdr")) {
              await page.keyboard.press("Control+Shift+K");
              await page.getByRole("searchbox", { name: "Search panes and actions", exact: true }).fill("Split pane right");
              await page.getByRole("option", { name: "Split pane right", exact: true }).click();
              await page.waitForFunction(() => document.querySelectorAll("[data-layout-pane]").length === 2, undefined, { timeout: 15_000 });
              await page.locator(`[data-layout-pane="${WORKING}"] .chat-view`).click({ position: { x: 20, y: 20 } });
            } else if (setup.name.startsWith("the classic")) {
              await page.evaluate((split) => sessionStorage.setItem("ovis:split", JSON.stringify(split)), { other: { machineId: "local", paneId: BLOCKED }, bSide: "right", active: "a" });
              await page.reload();
              await page.locator(".app-header.is-zoned").waitFor();
              await page.locator('.pane-slot[data-slot="b"]').click({ position: { x: 40, y: 80 } });
              await addressIs(page, { pane: BLOCKED }, "the other half is the selected pane");
              await page.locator(".view-switch .lens-option.is-terminal").click();
              await page.locator('.view-switch .lens-option.is-terminal[aria-pressed="true"]').waitFor();
              await page.locator('.pane-slot[data-slot="a"] .chat-view').click({ position: { x: 20, y: 20 } });
            } else {
              await page.getByRole("textbox", { name: "Message", exact: true }).fill("/btw is the retry test flaky on CI too?");
              await page.getByRole("button", { name: "Send message", exact: true }).click();
              await page.locator(`.terminal-stack.is-chat.is-peek[data-pane-owner="${FLAKY}"]`).waitFor({ timeout: 15_000 });
            }
            await addressIs(page, { app: null, pane: setup.pane }, "the classic app is on the pane");
            if (!setup.name.startsWith("a terminal")) await chatOn.waitFor();
            await page.waitForFunction(() => [...document.querySelectorAll(".xterm-screen")].some((screen) => screen.getBoundingClientRect().width > 0), undefined, { timeout: 15_000 });
            await terminalSettled(page, 1);
            const classic = await drawnScreens(page);
            const before = await page.evaluate(() => window.inboxFixture.frames.length);

            await page.locator(OVIS_MARK).click();
            await page.locator(".inbox-column .mode-inbox").waitFor();
            await page.locator(".inbox-unchosen").waitFor();
            await addressIs(page, { app: "inbox", pane: null }, "the way in opens the list");
            assert.equal(await page.locator('.mode-inbox .inbox-row[aria-current="true"]').count(), 0, "no row is open");
            await terminalSettled(page);
            await page.locator(".inbox-rail .inbox-rail-exit").click();
            await page.locator(".mode-inbox").waitFor({ state: "detached" });
            await page.locator(".app-header.is-zoned").waitFor();
            await terminalSettled(page);
            assert.deepEqual(await page.evaluate((count) => window.inboxFixture.frames.slice(count), before), [], "from before the way in through Back to Ovis no attach, detach, size or release is sent for any pane");
            await addressIs(page, { app: null, pane: setup.pane }, "Back to Ovis shows the pane it was on");
            if (setup.name.startsWith("a terminal")) await page.locator(`.terminal-stack.is-chat.is-peek[data-pane-owner="${FLAKY}"]`).waitFor({ timeout: 5_000 });
            const after = await drawnScreens(page);
            assert.deepEqual(Object.keys(after).sort(), Object.keys(classic).sort(), "the classic app draws the terminals it drew");
            for (const [pane, was] of Object.entries(classic)) sameBox(after[pane]!, was, `${pane} has the box, and the grid, it had`);
            console.log(`PASS the way in from ${setup.name} opens the list with nothing chosen; from before it through Back to Ovis no attach, detach, size or release is sent, and the classic app draws what it drew${setup.name.startsWith("a terminal") ? ", the peek still up" : ""}`);
          }, desktop);
        }

        await withPage(browser, base, light, `/?pane=${encodeURIComponent(WORKING)}&view=chat`, "a phone entered again onto the thread it was left on: its Back is the list", async (page) => {
          await page.locator(".app-header.is-zoned").waitFor();
          await enterFromMore(page);
          await rowCount(page, 6);
          await openThread(page, BLOCKED);
          await openSheet(page, ".header-more-button");
          await page.locator('.row-sheet [data-item="exit-inbox"]').tap();
          await page.locator("#drawer-toggle").waitFor();
          await addressIs(page, { app: null, pane: BLOCKED }, "Back to Ovis from the thread shows its pane in the classic app");
          const entries = await historyLength(page);
          await openSheet(page, ".header-more-button");
          await page.locator('.row-sheet [data-item="enter-inbox"]').tap();
          await page.locator("#inbox-back").waitFor();
          await page.locator(".thread-title").waitFor();
          await addressIs(page, { app: "inbox", pane: BLOCKED }, "entering again opens the thread the mode was left on");
          assert.equal(await historyLength(page), entries + 2, "the way in is the list's entry and the thread's");
          await page.locator("#inbox-back").tap();
          await listScreen(page);
          assert.equal(await historyLength(page), entries + 2, "the thread's Back steps back onto the list's entry");
          await page.goBack();
          await page.locator("#drawer-toggle").waitFor();
          await addressIs(page, { app: null }, "the system Back from that list leaves the mode");
          console.log("PASS on a phone, entering again opens the thread the mode was left on; its Back is the list, still the mode's, and the system Back from there is the classic app");
        }, PHONE, true);

        await withPage(browser, base, light, `/?pane=${encodeURIComponent(WORKING)}&view=terminal`, "a pane with no row in the list: the way in opens the list", async (page) => {
          await page.locator(".app-header.is-zoned").waitFor();
          await page.keyboard.press("Control+Shift+K");
          await page.getByRole("searchbox", { name: "Search panes and actions", exact: true }).fill("Split pane right");
          await page.getByRole("option", { name: "Split pane right", exact: true }).click();
          await page.waitForFunction(() => [...document.querySelectorAll("[data-layout-pane] .xterm-screen")].filter((screen) => screen.getBoundingClientRect().width > 0).length === 2, undefined, { timeout: 15_000 });
          const shell = await page.evaluate((working) => [...document.querySelectorAll("[data-layout-pane]")].map((frame) => frame.getAttribute("data-layout-pane")).find((pane) => pane !== null && pane !== working) ?? "", WORKING);
          await page.locator(`[data-layout-pane="${shell}"] .xterm-screen`).click();
          await addressIs(page, { pane: shell }, "the shell's pane is the one the classic app is on");
          await page.locator(OVIS_MARK).click();
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await page.locator(".inbox-unchosen").waitFor();
          assert.equal(await page.locator(".thread-chip").count(), 0, "no thread is opened for a pane with no row");
          await page.locator(".inbox-rail .inbox-rail-exit").click();
          await page.locator(".app-header.is-zoned").waitFor();
          await addressIs(page, { app: null, pane: shell }, "Back to Ovis shows the shell's pane as it was");
          console.log(`PASS a pane with no row in the list (${shell}, a shell) is entered on the list with nothing chosen, and Back to Ovis shows it again`);
        }, desktop);

        for (const setup of [
          { name: "dragged to its least width", stored: "240", viewport: desktop, width: 240 },
          { name: "at its default width", stored: null, viewport: desktop, width: 320 },
          { name: "capped at half an 800px window", stored: "520", viewport: { width: 800, height: 900 }, width: 400 },
        ]) for (const coarse of [false, true]) {
          const pointer = coarse ? "a coarse pointer" : "a fine pointer";
          await withPage(browser, base, light, `/?pane=${encodeURIComponent(WORKING)}&view=terminal`, `the sidebar ${setup.name} under ${pointer}`, async (page) => {
            const sent = (): Promise<Window["inboxFixture"]["frames"]> => page.evaluate(() => window.inboxFixture.frames.slice());
            const enter = async (): Promise<void> => {
              await page.locator(OVIS_MARK).click();
              await page.locator(".inbox-column .mode-inbox").waitFor();
              await rowCount(page, 6);
            };
            const leave = async (): Promise<void> => {
              await page.locator(".inbox-rail .inbox-rail-exit").click();
              await page.locator(".mode-inbox").waitFor({ state: "detached" });
              await page.locator(".app-header.is-zoned").waitFor();
            };
            assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), coarse, `the pointer is ${coarse ? "coarse" : "fine"}`);
            await page.evaluate((stored) => { if (stored === null) localStorage.removeItem("ovis:sidebar-width"); else localStorage.setItem("ovis:sidebar-width", stored); }, setup.stored);
            await page.reload();
            await page.locator(".app-header.is-zoned").waitFor();
            const classic = { sidebar: await box(page, "#workspace-drawer"), pane: await box(page, ".pane-column"), terminal: await terminalBox(page) };
            assert.deepEqual([classic.sidebar.x, classic.sidebar.w], [0, setup.width], `the classic sidebar is ${setup.width}px wide`);
            await terminalSettled(page, 1);
            const before = (await sent()).length;

            await enter();
            await paneHiddenUnderList(page, "the pane is mounted under the list, hidden");
            const control = coarse ? 44 : 34;
            const [column, pane] = await Promise.all([box(page, ".inbox-column"), box(page, ".pane-column")]);
            assert.deepEqual([column.x, column.w], [classic.sidebar.x, classic.sidebar.w], "the column is the classic sidebar's width: no wider for its rail");
            assert.deepEqual([pane.x, pane.w], [classic.pane.x, classic.pane.w], "the pane has the box the classic shell gives it");
            const top = await topRow(page);
            assert.deepEqual([top.rail.x, top.rail.w], [0, control + 24], "the rail is cut out of the column");
            near(top.list.x, top.rail.right, 0.5, "the list begins where the rail ends"); near(top.list.right, column.right, 1, "the list ends at the column's seam");
            // the list's top controls are whole, inside it, and reached by the keyboard after the rail: its search field where
            // the list has the room for it (256px and more), else the Search button that opens it
            topRowFits(top, `in a ${Math.round(top.list.w)}px list`);
            const roomy = top.list.w >= 256;
            assert.deepEqual(top.controls.map((each) => each.kind === "inbox-search" ? [each.kind] : [each.kind, each.box.w, each.box.h]),
              [roomy ? ["inbox-search"] : ["inbox-search-toggle", control, control], ["inbox-filter-toggle", control, control], ["inbox-add", control, control]],
              `in a ${Math.round(top.list.w)}px list the top row is ${roomy ? "the search field" : "Search"}, the filter and New workspace, the round ones at their ${control}px`);
            if (roomy) {
              // the reason for the list's least width for an always-shown field: the field holds its own placeholder
              const [room, words] = await page.evaluate(() => {
                const input = document.querySelector<HTMLInputElement>(".mode-inbox .inbox-search-input")!;
                const style = getComputedStyle(input);
                const pen = document.createElement("canvas").getContext("2d")!;
                pen.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
                return [input.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight), pen.measureText(input.placeholder).width];
              });
              assert.ok(room >= words, `the always-shown field holds its placeholder: ${room}px of room for ${words.toFixed(1)}px of words`);
            }
            const tight = coarse && setup.width === 240;
            near(column.right - top.controls[2]!.box.right, tight ? 12 : 16, 1, "the top controls from the column's edge");
            near(top.controls[1]!.box.x - top.controls[0]!.box.right, tight ? 8 : 10, 1, "between the top controls");
            await page.locator(".inbox-rail .inbox-rail-pcs").focus();
            const reached: string[] = [];
            for (let press = 0; press < 3; press++) {
              await page.keyboard.press("Tab");
              reached.push(await page.evaluate(() => [...(document.activeElement?.classList ?? [])].find((name) => name.startsWith("inbox-") && name !== "inbox-round") ?? ""));
            }
            assert.deepEqual(reached, [roomy ? "inbox-search-input" : "inbox-search-toggle", "inbox-filter-toggle", "inbox-add"], "Tab goes from the rail's last button through the top row");

            await leave();
            await terminalSettled(page);
            assert.deepEqual((await sent()).slice(before), [], "the way in and the way out from the list send no attach, detach, size or release");
            sameBox(await terminalBox(page), classic.terminal, "left from the list, the terminal has the box it had");

            await enter();
            await row(page, WORKING).click();
            await page.locator(".thread-chip").waitFor();
            await page.locator(".thread-top .lens-toggle").click();
            await page.locator('.thread-top .lens-toggle[data-view="terminal"]').waitFor();
            const thread = await terminalBox(page);
            near(thread.x, classic.terminal.x, 1, "the thread's terminal begins where classic's does");
            near(thread.w, classic.terminal.w, 1, "the thread's terminal is as wide as classic's"); near(thread.h, classic.terminal.h, 1, "the thread's terminal is as tall as classic's");
            await terminalSettled(page);
            const shown = (await sent()).length;

            await leave();
            await addressIs(page, { app: null, pane: WORKING }, "the rail's mark opens the thread's pane in the classic app");
            sameBox(await terminalBox(page), classic.terminal, "left from the thread, the terminal has the box it had");
            await terminalSettled(page);
            assert.deepEqual((await sent()).slice(shown), [], "leaving by the rail's mark from a thread that shows its terminal sends no attach, detach, size or release");
            console.log(`PASS with the sidebar ${setup.name} (${column.w}px) under ${pointer} the mode's column is the classic sidebar's and the pane the classic shell's (${pane.w}px from ${pane.x}); the rail (${top.rail.w}px) is cut out of it, and the list's three ${control}px top controls are whole inside the ${Math.round(top.list.w)}px it leaves, hit at their middles and reached by Tab, nothing scrolling sideways; the way in and out from the list sends nothing for the pane, a thread's terminal is classic's size (${Math.round(thread.w)} by ${Math.round(thread.h)}), and leaving by the rail's mark while it is shown sends no attach, detach, size or release`);
          }, setup.viewport, coarse);
        }

        // ---- a list too narrow for its top controls ----
        // A phone on its side has a side safe area, which the rail takes out of the column: with the sidebar at its least
        // width the list is then narrower than three 44px controls. They shrink together and stay round, never under the
        // 24px of a pointer's least target, so none stands over another or over the rail. The safe area is the browser's
        // own override of it (the devtools protocol), as wide as an iPhone's on its side in either of its sizes.
        for (const safe of [47, 59]) {
          await withPage(browser, base, light, "/?app=inbox", `the top controls in a list narrowed by a ${safe}px side safe area`, async (page) => {
            const session = await page.context().newCDPSession(page);
            await session.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, topMax: 0, left: safe, leftMax: safe, bottom: 0, bottomMax: 0, right: 0, rightMax: 0 } });
            await page.evaluate(() => localStorage.setItem("ovis:sidebar-width", "240"));
            await page.reload();
            await page.locator(".inbox-column .mode-inbox").waitFor();
            await rowCount(page, 6);
            assert.equal(await page.evaluate(() => {
              const probe = document.createElement("div");
              probe.style.cssText = "position: absolute; padding-left: env(safe-area-inset-left, 0px)";
              document.body.append(probe);
              const inset = getComputedStyle(probe).paddingLeft;
              probe.remove();
              return inset;
            }), `${safe}px`, "the browser reports the side safe area");
            const top = await topRow(page);
            assert.deepEqual([top.rail.x, top.rail.w, Math.round(top.list.w)], [0, 68 + safe, 171 - safe], "the rail takes the safe area out of the column, and the list has what is left");
            topRowFits(top, `in a ${171 - safe}px list`);
            assert.deepEqual(top.controls.map((each) => each.kind), ["inbox-search-toggle", "inbox-filter-toggle", "inbox-add"], "the row still holds its three controls");
            const size = top.controls[0]!.box.w;
            for (const each of top.controls) {
              near(each.box.h, each.box.w, 0.1, `${each.kind} is round`); near(each.box.w, size, 0.1, "the three controls are one size");
              assert.ok(each.box.w < 44 && each.box.w >= 24, `${each.kind} is smaller than 44px and no smaller than a pointer's least target: ${each.box.w}px`);
              assert.deepEqual(each.glyph, [16, 16], `${each.kind}'s glyph keeps its size`);
            }
            await page.locator(".mode-inbox .inbox-search-toggle").click();
            await page.locator(".mode-inbox .inbox-search-input").waitFor();
            const open = await topRow(page);
            topRowFits(open, `with the search field open in a ${171 - safe}px list`);
            assert.deepEqual(open.controls.map((each) => each.kind), ["inbox-search", "inbox-search-toggle"], "the open field and its button are the row");
            const button = open.controls[1]!.box;
            near(button.h, button.w, 0.1, "the field's button is round");
            assert.ok(button.w <= 44 && button.w >= 24, `the field's button is no larger than 44px and no smaller than a pointer's least target: ${button.w}px`);
            assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("inbox-search-input") === true), true, "the folded field opens with the focus in it");
            await page.keyboard.press("Escape");
            await page.locator(".mode-inbox .inbox-search").waitFor({ state: "hidden" });
            await page.waitForFunction(() => document.activeElement?.classList.contains("inbox-search-toggle") === true, undefined, { timeout: 5_000 });
            const folded = await topRow(page);
            assert.deepEqual(folded.controls.map((each) => each.kind), ["inbox-search-toggle", "inbox-filter-toggle", "inbox-add"], "folded again, the row is Search, the filter and New workspace");
            console.log(`PASS in a list narrowed to ${171 - safe}px by a ${safe}px side safe area, under a coarse pointer with the sidebar at its least width, the three top controls shrink together to ${size.toFixed(1)}px, round, with their glyphs whole, inside the list and clear of the rail and of each other; an open search field (${Math.round(open.controls[0]!.box.w)}px) stands beside its ${button.w.toFixed(1)}px button; nothing scrolls sideways`);
          }, desktop, true);
        }

        // A window's own controls over the row's start ask the row for what of them the rail does not already cover:
        // nothing while they are narrower than the rail, the rest of them while they are wider, where the row's controls
        // shrink clear of them. Only an iPad's home-screen app in a window has such controls, so the page is told of them
        // here as lib/viewport.ts tells it there: the mark on the root and the controls' width.
        for (const [reserved, what] of [[40, "narrower than the rail"], [136, "wider than the rail"]] as const) {
          await withPage(browser, base, light, "/?app=inbox", `the top controls beside a window's own controls ${what}`, async (page) => {
            await page.evaluate(() => localStorage.setItem("ovis:sidebar-width", "240"));
            await page.reload();
            await page.locator(".inbox-column .mode-inbox").waitFor();
            await rowCount(page, 6);
            await page.evaluate((width) => {
              document.documentElement.toggleAttribute("data-window-controls", true);
              document.documentElement.style.setProperty("--window-controls-w", `${width}px`);
            }, reserved);
            await frames(page);
            const top = await topRow(page);
            topRowFits(top, `beside ${reserved}px of window controls`);
            assert.deepEqual(top.controls.map((each) => each.kind), ["inbox-search-toggle", "inbox-filter-toggle", "inbox-add"], "the row still holds its three controls");
            const first = top.controls[0]!.box;
            assert.ok(first.x >= reserved, `the first control is clear of the window's controls: it begins at ${first.x}px, they end at ${reserved}px`);
            near(first.x - top.list.x, 12 + Math.max(0, reserved - top.rail.w), 1, "the row's start inset is its own and what of the window's controls reaches past the rail");
            for (const each of top.controls) {
              near(each.box.h, each.box.w, 0.1, `${each.kind} is round`); near(each.box.w, first.w, 0.1, "the three controls are one size");
              if (reserved <= top.rail.w) assert.equal(each.box.w, 44, `${each.kind} is whole: the rail covers the window's controls`);
              else assert.ok(each.box.w < 44 && each.box.w >= 24, `${each.kind} is smaller than 44px and no smaller than a pointer's least target: ${each.box.w}px`);
            }
            console.log(`PASS beside ${reserved}px of a window's own controls (${what}, ${top.rail.w}px), under a coarse pointer with the sidebar at its least width, the list's three top controls are ${first.w.toFixed(1)}px, round, inside the list from ${first.x}px on, clear of those controls, of the rail and of each other`);
          }, desktop, true);
        }
        for (const theme of ["light", "dark"]) {
          await withPage(browser, base, { language: "en", theme }, "/?app=inbox", `${theme}: the rail's buttons, their names, their places and how they are drawn`, async (page) => {
            await page.locator(".inbox-column .mode-inbox").waitFor();
            await rowCount(page, 6);
            await row(page, WORKING).click();
            await page.locator(".thread-chip").waitFor();
            const { height } = page.viewportSize()!;
            await page.mouse.move(700, 450);
            assert.deepEqual(await page.locator(".inbox-column").evaluate((column) => {
              const [first, second] = [...column.children];
              return [first?.tagName, first?.className, first?.getAttribute("aria-label"), second?.classList.contains("mode-inbox")];
            }), ["NAV", "inbox-rail", "Inbox mode", true], "the rail is a navigation named Inbox mode, the column's first part, before the list");
            const buttons = await railButtons(page);
            assert.deepEqual(buttons.map(({ kind, name, current, pressed, popup, expanded, glyph }) => [kind, name, current, pressed, popup, expanded, glyph]), [
              ["inbox-rail-exit", "Back to Ovis", null, null, null, null, "ovis-mark"],
              ["inbox-rail-place", "Agent inbox", "page", null, null, null, "lucide-inbox"],
              ["inbox-rail-waiting", "1 waiting for you", null, null, null, null, "lucide-circle-question-mark"],
              ["inbox-rail-alerts", "Alerts", null, "true", null, null, "lucide-bell"],
              ["inbox-rail-settings", "Settings", null, null, null, null, "lucide-settings"],
              ["inbox-rail-pcs", "PC workstation · Connected", null, null, "menu", "false", "lucide-monitor"],
            ], "the rail's six buttons from the Ovis mark down to the PC: each one's name, its state and its glyph; no magnifier");
            const titles = buttons.map((button) => button.title ?? "");
            assert.deepEqual([titles[0], titles[1], titles[2], titles[5]], ["Back to Ovis", "Agent inbox", "Open the next session waiting for you", "PC workstation · Connected"],
              "a tooltip says its button's name, and the count's says what its press does");
            assert.match(titles[4]!, /^Settings \(.+\)$/, "Settings' tooltip has its shortcut");
            assert.match(titles[3]!, /^Alerts on in the app\. /, "the bell's tooltip is the sentence that says how this device's alerts stand");
            assert.deepEqual(buttons.map(({ box: at }) => [at.x, at.y, at.w, at.h]), [
              [12, 12, 34, 34], [12, 62, 34, 34],
              [12, height - 172, 34, 34], [12, height - 130, 34, 34], [12, height - 88, 34, 34], [12, height - 46, 34, 34],
            ], "34px buttons 12px from the rail's sides: the mark at its top, the place under it, four at its foot, 8px apart");

            const token = (property: "background-color" | "color", value: string): Promise<string> => page.evaluate(([name, css]) => {
              const probe = document.createElement("span");
              probe.style.position = "absolute";
              probe.style.setProperty(name, css);
              document.querySelector(".inbox-rail")!.append(probe);
              const computed = getComputedStyle(probe).getPropertyValue(name);
              probe.remove();
              return computed;
            }, [property, value] as const);
            const fill = {
              rest: await token("background-color", "var(--bg-nav)"), hover: await token("background-color", "var(--side-hover)"),
              current: await token("background-color", "var(--side-selected)"), press: await token("background-color", "color-mix(in srgb, var(--side-selected), var(--border-strong))"),
            };
            const ink = { rest: await token("color", "var(--text-dim)"), hover: await token("color", "var(--text)"), strong: await token("color", "var(--text-strong)") };
            const drawn = (kind: string) => page.locator(`.inbox-rail .${kind}`).evaluate((node) => {
              const style = getComputedStyle(node);
              const glyph = node.querySelector("svg");
              return { fill: style.backgroundColor, ink: style.color, edge: style.borderTopColor, outline: style.outlineStyle, shadow: style.boxShadow, stroke: glyph ? getComputedStyle(glyph).strokeWidth : null };
            });
            const draws = async (kind: string, wantFill: string, wantInk: string, what: string): Promise<void> => {
              const settled = await page.waitForFunction(([selector, a, b]) => {
                const style = getComputedStyle(document.querySelector(selector)!);
                return style.backgroundColor === a && style.color === b;
              }, [`.inbox-rail .${kind}`, wantFill, wantInk] as const, { timeout: 5_000 }).then(() => true, () => false);
              if (!settled) assert.fail(`${what}: .${kind} is drawn ${JSON.stringify(await drawn(kind))}, wanted the fill ${wantFill} and the glyph ${wantInk}`);
            };
            const centre = async (kind: string): Promise<{ x: number; y: number }> => { const at = await box(page, `.inbox-rail .${kind}`); return { x: at.x + at.w / 2, y: at.y + at.h / 2 }; };

            for (const kind of ["inbox-rail-exit", "inbox-rail-waiting", "inbox-rail-alerts", "inbox-rail-settings", "inbox-rail-pcs"]) {
              await draws(kind, fill.rest, ink.rest, "at rest a button stands on the rail's own surface, its glyph dim");
            }
            await draws("inbox-rail-place", fill.current, ink.strong, "the current place has the selection's fill and a strong glyph");
            const place = await drawn("inbox-rail-place");
            assert.deepEqual([place.edge, place.outline, place.shadow], ["rgba(0, 0, 0, 0)", "none", "none"], "the current place has no edge, outline or shadow: its fill and its glyph say it");
            assert.deepEqual([place.stroke, (await drawn("inbox-rail-settings")).stroke], ["2.5px", "2px"], "the current place's glyph is drawn heavier than the others'");

            const settings = await centre("inbox-rail-settings");
            await page.mouse.move(settings.x, settings.y);
            await draws("inbox-rail-settings", fill.hover, ink.hover, "under the pointer a button takes the sidebar's hover fill and a stronger glyph");
            await page.mouse.down();
            await draws("inbox-rail-settings", fill.press, ink.strong, "under a press it takes the list row's own press");
            assert.equal((await drawn("inbox-rail-settings")).edge, "rgba(0, 0, 0, 0)", "a press draws no accent edge");
            await page.mouse.move(700, 450);
            await page.mouse.up();
            await draws("inbox-rail-settings", fill.rest, ink.rest, "let go off it, the button is at rest again");
            const here = await centre("inbox-rail-place");
            await page.mouse.move(here.x, here.y);
            await frames(page);
            await draws("inbox-rail-place", fill.current, ink.strong, "the pointer adds nothing to the current place");
            await page.mouse.down();
            await draws("inbox-rail-place", fill.press, ink.strong, "a press on the current place is the row's own too");
            await page.mouse.move(700, 450);
            await page.mouse.up();
            await draws("inbox-rail-place", fill.current, ink.strong, "let go off it, the current place is as it was");

            await page.locator(".inbox-rail .inbox-rail-place").focus();
            await page.keyboard.press("Tab");
            const ring = await page.evaluate(() => {
              const at = document.activeElement as HTMLElement;
              const probe = document.createElement("span");
              probe.style.cssText = "position: absolute; outline: var(--ring)";
              at.parentElement!.append(probe);
              const outline = (style: CSSStyleDeclaration): string => `${style.outlineWidth} ${style.outlineStyle} ${style.outlineColor}`;
              const own = getComputedStyle(at);
              const facts = { on: at.className, seen: at.matches(":focus-visible"), ring: outline(own), want: outline(getComputedStyle(probe)), reach: Number.parseFloat(own.outlineWidth) + Number.parseFloat(own.outlineOffset) };
              probe.remove();
              return facts;
            });
            assert.deepEqual([ring.on.includes("inbox-rail-waiting"), ring.seen, ring.ring], [true, true, ring.want], "Tab from the place is on the count, which draws the app's focus ring");
            assert.ok(ring.reach > 0 && ring.reach <= 12, `the ring fits inside the rail's insets: it reaches ${ring.reach}px past the button`);

            const answers = await page.evaluate(() => {
              const kindAt = (x: number, y: number): string | null => {
                const button = document.elementFromPoint(x, y)?.closest(".inbox-rail button");
                return button ? [...button.classList].find((name) => name.startsWith("inbox-rail-") && name !== "inbox-rail-item") ?? null : null;
              };
              const end = document.querySelector(".inbox-rail")!.getBoundingClientRect().right;
              return {
                // a pixel in from each corner: a point on the window's last half pixel is outside it for the browser
                corners: [kindAt(1, 1), kindAt(1, innerHeight - 1)],
                sides: [...document.querySelectorAll(".inbox-rail button")].map((node) => { const r = node.getBoundingClientRect(); const middle = r.top + r.height / 2; return [kindAt(1, middle), kindAt(end - 2, middle)]; }),
              };
            });
            assert.deepEqual(answers.corners, ["inbox-rail-exit", "inbox-rail-pcs"], "the window's top and bottom start corners press the rail's first and last buttons");
            assert.deepEqual(answers.sides, buttons.map(({ kind }) => [kind, kind]), "each button answers from the window's start edge to the rail's end");
            assert.equal(await page.locator(".command-palette").count(), 0, "no press that was let go off its button opened anything");
            await addressIs(page, { app: "inbox", pane: WORKING }, "the thread is as it was");
            console.log(`PASS ${theme}: the rail is a navigation named Inbox mode before the list, with six 34px buttons named Back to Ovis, Agent inbox (the current page), 1 waiting for you, Alerts (pressed), Settings and PC workstation · Connected (a menu's button), each with its tooltip; at rest a button stands on the rail's surface, the current place on the selection's fill with a heavier glyph and no edge; the pointer and a press change a button's fill and glyph only, and add nothing to the current place but the press; the keyboard's focus draws the app's ring; each button answers from the window's edge to the rail's end, the window's corners included`);
          }, desktop);
        }
        await withPage(browser, base, light, "/?app=inbox", "the rail in the keyboard's order, and under its keys", async (page) => {
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await rowCount(page, 6);
          await row(page, WORKING).click();
          await page.locator(".thread-chip").waitFor();
          const stop = (): Promise<string> => page.evaluate(() => {
            const at = document.activeElement;
            if (at === null || at === document.body) return "nothing";
            const own = (prefix: string, shared: string): string | undefined => [...at.classList].find((name) => name.startsWith(prefix) && name !== shared);
            if (at.closest(".inbox-rail")) return own("inbox-rail-", "inbox-rail-item") ?? "the rail";
            const item = at.closest(".mode-inbox .inbox-item");
            if (item) return `row ${item.getAttribute("data-pane")}`;
            if (at.closest(".mode-inbox")) return own("inbox-", "inbox-round") ?? "the list";
            if (at.classList.contains("sidebar-resizer")) return "the resize grip";
            return at.closest(".pane-column") ? "the thread" : `elsewhere (${at.className})`;
          });
          const focused = async (kind: string, what: string): Promise<void> => {
            const there = await page.waitForFunction((name) => document.activeElement?.classList.contains(name) === true, kind, { timeout: 5_000 }).then(() => true, () => false);
            if (!there) assert.fail(`${what}: the focus is on ${await stop()}`);
          };
          await page.locator(".inbox-rail .inbox-rail-exit").focus();
          const stops = [await stop()];
          while (stops.length < 40 && /^(inbox-|row |the resize grip$)/.test(stops.at(-1)!)) {
            await page.keyboard.press("Tab");
            stops.push(await stop());
          }
          const listed = (await rows(page)).map((item) => `row ${item.pane}`);
          assert.equal(listed.length, 6);
          assert.deepEqual(stops, ["inbox-rail-exit", "inbox-rail-place", "inbox-rail-waiting", "inbox-rail-alerts", "inbox-rail-settings", "inbox-rail-pcs",
            "inbox-search-input", "inbox-filter-toggle", "inbox-add", ...listed, "the resize grip", "the thread"],
            "Tab goes down the rail from the Ovis mark to the PC, then to the list's top row and its rows, the column's resize grip, and the thread");
          await page.locator(".inbox-rail .inbox-rail-place").focus();
          await page.keyboard.press("Shift+Tab");
          assert.equal(await stop(), "inbox-rail-exit", "Shift+Tab goes back up the rail");

          const pcs = page.locator(".inbox-rail .inbox-rail-pcs");
          const menu = page.locator('.row-menu[role="menu"][aria-label="PCs"]');
          await pcs.focus();
          await page.keyboard.press("Space");
          await menu.waitFor();
          assert.equal(await pcs.getAttribute("aria-expanded"), "true", "the PC's button says its menu is open");
          await page.keyboard.press("Escape");
          await menu.waitFor({ state: "detached" });
          await focused("inbox-rail-pcs", "the list of PCs closed gives the focus back to its button");
          assert.equal(await pcs.getAttribute("aria-expanded"), "false", "and its button says the menu is closed");

          const leaving = await historyLength(page);
          await page.locator(".inbox-rail .inbox-rail-exit").focus();
          await page.keyboard.press("Enter");
          await page.locator(".app-header.is-zoned").waitFor();
          assert.equal(await page.locator(".inbox-rail").count(), 0, "the rail leaves with the mode");
          await addressIs(page, { app: null, pane: WORKING }, "Enter on the Ovis mark opens the thread's pane in the classic app");
          assert.equal(await historyLength(page), leaving + 1, "leaving is one entry");
          await page.goBack();
          await page.locator(".inbox-column .inbox-rail").waitFor();
          await page.locator(".thread-chip").waitFor();
          await addressIs(page, { app: "inbox", pane: WORKING }, "Back returns to the thread the mode was left on");
          await page.locator(".inbox-rail .inbox-rail-settings").focus();
          await page.keyboard.press("Enter");
          await page.locator(".settings-dialog").waitFor();
          await page.keyboard.press("Escape");
          await page.locator(".settings-dialog").waitFor({ state: "detached" });
          await focused("inbox-rail-settings", "Settings closed gives the focus back to the rail's gear");
          console.log(`PASS the keyboard's order is the rail's six buttons from the Ovis mark down to the PC, the list's search field, filter and New workspace, its ${listed.length} rows, the column's resize grip, then the thread, and Shift+Tab goes back; Enter and Space press a rail button; Settings and the list of PCs give the focus back to their buttons; Enter on the Ovis mark leaves the mode by one entry that Back undoes`);
        }, desktop);
        await withPage(browser, base, light, "/?app=inbox", "the palette from the pane's More with the list alone", async (page) => {
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await rowCount(page, 6);
          assert.equal(await page.locator(".thread-chip").count(), 0, "no thread is open");
          await page.locator(".thread-top .header-more-button").click();
          await page.locator(".row-menu").waitFor();
          assert.deepEqual(await page.locator(".row-menu [data-item]").evaluateAll((items) => items.map((item) => item.getAttribute("data-item"))), ["palette"],
            "the More over the empty pane holds the palette alone");
          assert.equal(await page.locator(".thread-top .header-more-button").getAttribute("aria-expanded"), "true", "its button says its menu is open");
          await page.locator('.row-menu [data-item="palette"]').click();
          await page.locator(".command-palette").waitFor();
          await page.keyboard.press("Escape");
          await page.locator(".command-palette").waitFor({ state: "detached" });
          await addressIs(page, { app: "inbox", pane: null }, "the list is still alone");
          console.log("PASS with the list alone beside an empty pane the pane's More holds Search panes and actions alone, which opens the command palette");
        }, desktop);

        await withPage(browser, base, light, "/?app=inbox", "the rail's presses: the palette, alerts, Settings and the list of PCs", async (page) => {
          // this device has answered the browser's question about notifications, with no: Alerts is then a plain switch
          await page.context().addInitScript(() => { Object.defineProperty(Notification, "permission", { configurable: true, get: () => "denied" }); });
          await page.reload();
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await rowCount(page, 6);
          await row(page, WORKING).click();
          await page.locator(".thread-chip").waitFor();
          const rail = (kind: string) => page.locator(`.inbox-rail .inbox-rail-${kind}`);
          const stays = (what: string): Promise<void> => addressIs(page, { app: "inbox", pane: WORKING }, what);
          const focusedOn = async (kind: string, what: string): Promise<void> => {
            const there = await page.waitForFunction((name) => document.activeElement?.classList.contains(name) === true, `inbox-rail-${kind}`, { timeout: 5_000 }).then(() => true, () => false);
            if (!there) assert.fail(`${what}: the focus is on ${await page.evaluate(() => document.activeElement?.className ?? "nothing")}`);
          };

          assert.equal(await rail("palette").count(), 0, "the rail draws no magnifier");
          await page.locator(".thread-top .header-more-button").click();
          await page.locator('.row-menu [data-item="palette"]').click();
          await page.locator(".command-palette").waitFor();
          assert.equal(await page.locator(".inbox-column .inbox-rail").count(), 1, "the palette opens over the mode");
          await page.keyboard.press("Escape");
          await page.locator(".command-palette").waitFor({ state: "detached" });
          await stays("the palette opened and put away leaves the thread open");

          const bell = () => rail("alerts").evaluate((node) => [node.getAttribute("aria-label"), node.getAttribute("aria-pressed"), node.getAttribute("title"), [...node.querySelector("svg")!.classList].find((name) => name.startsWith("lucide-")) ?? null]);
          const switched = async (pressed: string, stored: boolean, what: string): Promise<void> => {
            const done = await page.waitForFunction(([want, kept]) =>
              document.querySelector(".inbox-rail .inbox-rail-alerts")?.getAttribute("aria-pressed") === want && JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").alertsOn === kept,
            [pressed, stored] as const, { timeout: 5_000 }).then(() => true, () => false);
            if (!done) assert.fail(`${what}: the bell is ${JSON.stringify(await bell())}, and the device has stored ${await page.evaluate(() => localStorage.getItem("ovis:settings"))}`);
          };
          const on = ["Alerts", "true", "Alerts on in the app. Tap to turn them off", "lucide-bell"];
          assert.deepEqual(await bell(), on, "on, the bell is pressed, and its tooltip says how this device's alerts stand");
          await rail("alerts").click();
          await switched("false", false, "a press turns this device's alerts off");
          assert.deepEqual(await bell(), ["Alerts", "false", "Alerts off on this device. Tap to turn them on", "lucide-bell-off"], "off, the bell is another glyph and not pressed, under the same name");
          assert.equal(await page.locator(".thread-top .header-more-dot").count(), 0, "the pane's More draws no mark for alerts that are off: the rail's bell says it");
          await rail("alerts").click();
          await switched("true", true, "a second press turns them on again");
          assert.deepEqual(await bell(), on, "on again, the bell is as it was");

          await rail("settings").click();
          await page.locator(".settings-dialog").waitFor();
          await page.keyboard.press("Escape");
          await page.locator(".settings-dialog").waitFor({ state: "detached" });
          await focusedOn("settings", "Settings closed gives the focus back to the rail's gear");
          await stays("Settings opened and closed leaves the thread open");

          const pcs = rail("pcs");
          const menu = page.locator('.row-menu[role="menu"][aria-label="PCs"]');
          const listed = () => menu.locator("[data-item]").evaluateAll((items) => items.map((item) => [item.getAttribute("data-item"), item.getAttribute("role"), item.querySelector(".menu-item-main")?.textContent ?? null, item.querySelector(".menu-item-hint")?.textContent ?? null, item.getAttribute("aria-current")]));
          await pcs.click();
          await menu.waitFor();
          assert.equal(await pcs.getAttribute("aria-expanded"), "true", "the PC's button says its menu is open");
          assert.deepEqual(await listed(), [["local", "menuitem", "workstation", "Connected", "true"]], "the list of PCs holds the one PC, connected, marked as the one the app is on");
          await menu.locator('[data-item="local"]').click();
          await menu.waitFor({ state: "detached" });
          await stays("the row of the PC the app is on leaves the thread as it is");
          assert.equal(await page.locator(".thread-chip").count(), 1, "and its thread open");

          await page.evaluate(() => (window as unknown as { __herdrDemoOrder: { addPc: () => string } }).__herdrDemoOrder.addPc());
          await rowCount(page, 12);
          const summed = await page.waitForFunction(() => document.querySelector(".inbox-rail .inbox-rail-pcs")?.getAttribute("aria-label") === "PCs, 2 of 2 connected", undefined, { timeout: 5_000 }).then(() => true, () => false);
          assert.ok(summed, `with two PCs the button says how many are connected: it says ${await pcs.getAttribute("aria-label")}`);
          assert.equal(await pcs.getAttribute("title"), "PCs, 2 of 2 connected", "in its tooltip too");
          await pcs.click();
          await menu.waitFor();
          assert.deepEqual(await listed(), [["local", "menuitem", "workstation", "Connected", "true"], ["laptop", "menuitem", "laptop", "Connected", null]], "the list holds both PCs, the one the app is on marked");
          await menu.locator('[data-item="laptop"]').click();
          await menu.waitFor({ state: "detached" });
          await page.locator(".inbox-unchosen").waitFor();
          assert.equal(await page.locator('.mode-inbox .inbox-row[aria-current="true"]').count(), 0, "the other PC is opened with no thread of it chosen");
          await rowCount(page, 12);
          await pcs.click();
          await menu.waitFor();
          assert.deepEqual((await listed()).map((item) => [item[0], item[4]]), [["local", null], ["laptop", "true"]], "the PC the app is now on is the one marked");
          await page.keyboard.press("Escape");
          await menu.waitFor({ state: "detached" });
          console.log("PASS the rail's magnifier opens the command palette over the mode; its bell switches this device's alerts off and on, by glyph, pressed state, tooltip and stored choice, the pane's More drawing no mark for it; its gear opens Settings, which gives the focus back; its PC opens the list of PCs with each one's name and state, the one the app is on marked, and with two PCs says 2 of 2 connected and opens the other PC with no thread chosen");
        }, desktop);
        await withPage(browser, base, light, "/?app=inbox", "the rail's place takes the list to its top and gives it the keyboard", async (page) => {
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await rowCount(page, 6);
          await row(page, WORKING).click();
          await page.locator(".thread-chip").waitFor();
          const list = ".inbox-column .inbox-scroll";
          const top = (): Promise<number> => page.locator(list).evaluate((node) => node.scrollTop);
          assert.ok(await page.locator(list).evaluate((node) => node.scrollHeight - node.clientHeight > 40), "six rows scroll on this short window");
          await page.locator(list).evaluate((node) => { node.scrollTop = node.scrollHeight; });
          await frames(page);
          const scrolled = await top();
          assert.ok(scrolled > 40, `the list is scrolled down: ${scrolled}px`);
          const place = page.locator(".inbox-rail .inbox-rail-place");
          assert.equal(await place.getAttribute("aria-current"), "page", "the place is the current one");
          await place.click();
          const atTop = await page.waitForFunction((selector) => document.querySelector(selector)!.scrollTop === 0, list, { timeout: 5_000 }).then(() => true, () => false);
          assert.ok(atTop, `the place takes the list to its top: it is at ${await top()}px`);
          assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".inbox-column .mode-inbox")), true, "the keyboard's focus is on the list");
          await page.keyboard.press("Tab");
          assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("inbox-search-input") === true), true, "the next Tab is the list's first control, its search field");
          assert.equal(await place.getAttribute("aria-current"), "page", "the place is still the current one");
          await addressIs(page, { app: "inbox", pane: WORKING }, "the place opens nothing and closes nothing");
          assert.equal(await page.locator(".thread-chip").count(), 1, "the open thread stays beside the list");
          await frames(page);
          assert.equal(await top(), 0, "the list stays at its top");
          console.log(`PASS the rail's place, the current page, takes a list scrolled ${Math.round(scrolled)}px down to its top and puts the keyboard's focus on the list, whose first control the next Tab reaches; the open thread and the address stay as they were`);
        }, { width: 1440, height: 360 });
        await withPage(browser, base, light, "/?app=inbox", "the rail's count of the agents that wait, coming and going", async (page) => {
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await rowCount(page, 6);
          await questionShown(page);
          const waiting = page.locator(".inbox-rail .inbox-rail-waiting");
          const under = async (): Promise<number[]> => (await railButtons(page)).filter((button) => ["inbox-rail-alerts", "inbox-rail-settings", "inbox-rail-pcs"].includes(button.kind)).map((button) => button.box.y);
          const without = ["Back to Ovis", "Agent inbox", "Alerts", "Settings", "PC workstation · Connected"];
          await railCounts(page, 1, "on the list alone the agent that waits is counted");
          assert.deepEqual(await waiting.evaluate((node) => {
            const pill = node.querySelector(".header-more-dot")!;
            return [node.getAttribute("title"), pill.getAttribute("aria-hidden"), getComputedStyle(pill, "::after").content];
          }), ["Open the next session waiting for you", "true", '"1"'], "the count is the app's waiting pill, hidden from a screen reader: the button's name says the number, its tooltip what a press does");
          const places = await under();
          assert.equal(places.length, 3);

          await waiting.click();
          await page.locator(".thread-chip").waitFor();
          await addressIs(page, { app: "inbox", pane: BLOCKED }, "the count's press opens the agent that waits");
          await waiting.waitFor({ state: "detached" });
          assert.deepEqual(await railNames(page), without, "with no other agent waiting the rail draws no count");
          assert.deepEqual(await under(), places, "nothing under the count moves when it goes");

          await page.evaluate((pane) => window.inboxFixture.set(pane, "blocked"), WORKING);
          await railCounts(page, 1, "another agent begins to wait");
          await page.evaluate((pane) => window.inboxFixture.set(pane, "blocked"), DONE);
          await railCounts(page, 2, "a second one begins to wait");
          assert.deepEqual(await under(), places, "nothing under the count moves when it comes");

          await waiting.click();
          const opened = await page.waitForFunction(([one, other]) => {
            const pane = new URL(location.href).searchParams.get("pane");
            return pane === one || pane === other ? pane : null;
          }, [WORKING, DONE] as const, { timeout: 5_000 }).then((handle) => handle.jsonValue(), () => null);
          assert.ok(opened !== null, `the count's press opens one of the two others that wait: the address says ${JSON.stringify(await address(page))}`);
          await railCounts(page, 2, "from the thread it opened the count is of the two others");

          for (const pane of [BLOCKED, WORKING, DONE]) await page.evaluate((id) => window.inboxFixture.set(id, "idle"), pane);
          await waiting.waitFor({ state: "detached" });
          assert.deepEqual(await railNames(page), without, "with nobody waiting the rail draws no count");
          assert.deepEqual(await under(), places, "and the buttons under it are where they were");
          console.log(`PASS the rail's count is the app's waiting pill under a name that says the number: 1 on the list alone, gone once its press has opened that agent's thread, back at 1 and then 2 as other agents begin to wait, still 2 from the thread its press opened (${opened}), and gone when nobody waits; Alerts, Settings and the PC never move`);
        }, desktop);

        // ---- the rail's count, and an agent that waits behind a tab's zoom ----
        // The rail counts the agents its press can open. One that waits in a pane its tab's zoom hides keeps its row,
        // which says that it waits, but no jump reaches it: it is not counted, and with no other one waiting the rail
        // draws no count. The demo's herdr splits the waiting agent's tab and zooms it onto the new pane, as herdr does.
        await withPage(browser, base, light, "/?app=inbox", "the rail's count and an agent that waits behind a tab's zoom", async (page) => {
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await rowCount(page, 6);
          await questionShown(page);
          const waiting = page.locator(".inbox-rail .inbox-rail-waiting");
          const herdr = (path: string, body: Record<string, unknown>): Promise<{ ok?: boolean; pane?: { pane_id?: string } }> =>
            page.evaluate(async ([to, sent]) => (await fetch(to, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sent) })).json(), [path, body] as const);
          const waits = (pane: string): Promise<boolean> => page.evaluate((id) => document.querySelector(`.mode-inbox .inbox-item[data-pane="${id}"]`)?.getAttribute("data-state") === "blocked", pane);
          const filterTo = async (choice: string, count: number): Promise<void> => {
            await page.locator(".mode-inbox .inbox-filter-toggle").click();
            await page.locator(`.row-menu [data-item="${choice}"]`).click();
            await page.locator(".row-menu").waitFor({ state: "detached" });
            await rowCount(page, count);
          };
          await page.evaluate((pane) => window.inboxFixture.set(pane, "blocked"), WORKING);
          await railCounts(page, 2, "on the list alone both agents that wait are counted");

          const made = (await herdr("/api/pane/split", { pane_id: BLOCKED, direction: "right" })).pane?.pane_id ?? "";
          assert.ok(made !== "", "the demo's herdr split the waiting agent's tab");
          assert.equal((await herdr("/api/pane/zoom", { pane_id: made, mode: "on" })).ok, true, "and zoomed it onto the new pane");
          await railCounts(page, 1, "the agent behind the zoom is not counted: one is left to open");
          await rowCount(page, 6);
          assert.equal(await waits(BLOCKED), true, "the agent behind the zoom keeps its row, which says that it waits");
          await filterTo("done", 1);
          await railCounts(page, 1, "filtered to Done the count stays");
          await filterTo("all", 6);

          await waiting.click();
          await page.locator(".thread-chip").waitFor();
          await addressIs(page, { app: "inbox", pane: WORKING }, "the count's press opens the agent in reach");
          await waiting.waitFor({ state: "detached" });
          assert.equal(await waits(BLOCKED), true, "the agent behind the zoom still waits in its row, and is not counted");
          // a press on that agent's own row opens the pane its tab is zoomed onto, the one herdr shows, as every pick of a
          // pane a zoom hides does; the thread that was open is one row away
          await row(page, BLOCKED).click();
          await addressIs(page, { app: "inbox", pane: made }, "the hidden agent's row opens the pane its tab is zoomed onto");
          await row(page, WORKING).click();
          await addressIs(page, { app: "inbox", pane: WORKING }, "the thread that was open is opened again by its row");
          assert.equal(await waiting.count(), 0, "and there is still no agent in reach to count");

          assert.equal((await herdr("/api/pane/zoom", { pane_id: made, mode: "off" })).ok, true, "herdr takes the zoom off");
          await railCounts(page, 1, "with the zoom gone the agent is counted");
          await waiting.click();
          await addressIs(page, { app: "inbox", pane: BLOCKED }, "and the count's press opens it");
          await railCounts(page, 1, "the agent whose thread was left is the one counted now");
          console.log(`PASS the rail counts what its press can open: 2 with two agents waiting on the list alone, 1 once herdr zooms one's tab onto another pane (${made}), whose row still says it waits, the same under a filter; the press opens the agent in reach and the count goes while the other still waits, its own row opening the pane its tab is zoomed onto; with the zoom off that agent is counted and the press opens it`);
        }, desktop);

        await withPage(browser, base, light, "/?app=inbox", "the rail's count over two PCs that hold the same pane ids", async (page) => {
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await rowCount(page, 6);
          await page.evaluate(() => (window as unknown as { __herdrDemoOrder: { addPc: () => string } }).__herdrDemoOrder.addPc());
          await rowCount(page, 12);
          const waiting = page.locator(".inbox-rail .inbox-rail-waiting");
          await railCounts(page, 2, "on the list alone the agent that waits on each PC is counted");
          await waiting.click();
          await page.locator(".thread-chip").waitFor();
          await addressIs(page, { app: "inbox", machine: null, pane: BLOCKED }, "the first press opens the waiting agent of the PC the app is on");
          await railCounts(page, 1, "the open thread's own agent is left out, the other PC's agent of the same id is not");
          await waiting.click();
          await addressIs(page, { app: "inbox", machine: "laptop", pane: BLOCKED }, "the next press opens the other PC's agent");
          await railCounts(page, 1, "from there the first PC's agent is the one counted");
          await waiting.click();
          await addressIs(page, { app: "inbox", machine: null, pane: BLOCKED }, "and the next press comes round to it");
          console.log("PASS with two PCs that hold the same pane ids the rail counts the agent that waits on each (2 on the list alone, 1 from either one's thread), and its presses open the first PC's, then the other PC's, then the first again");
        }, desktop);
        await withPage(browser, base, light, "/?app=inbox", "no rail under 769px: a window narrowed and widened again", async (page) => {
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await rowCount(page, 6);
          const shape = () => page.evaluate(() => {
            const count = (selector: string): number => document.querySelectorAll(selector).length;
            const rail = document.querySelector(".inbox-rail")?.getBoundingClientRect();
            const list = document.querySelector(".mode-inbox")!.getBoundingClientRect();
            return {
              wide: count(".app.is-inbox-wide"), rail: rail ? [rail.left, rail.width] : null, list: [list.left, Math.round(list.width)],
              more: count(".mode-inbox .inbox-more"), foot: count(".mode-inbox .inbox-foot"), filter: count(".mode-inbox .inbox-foot .inbox-filter-toggle"),
              search: document.querySelector(".mode-inbox .inbox-search-toggle, .mode-inbox .inbox-search-input")?.getAttribute("aria-label") ?? null,
              sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          });
          const wide = { wide: 1, rail: [0, 58], list: [58, 261], more: 0, foot: 0, filter: 0, search: "Search agents", sideways: 0 };
          assert.deepEqual(await shape(), wide, "at 769px the rail is drawn and the list is beside it, with no More and no foot of its own");
          await page.setViewportSize({ width: 768, height: 900 });
          await page.locator(".inbox-rail").waitFor({ state: "detached" });
          assert.deepEqual(await shape(), { wide: 0, rail: null, list: [0, 768], more: 1, foot: 1, filter: 1, search: "Search", sideways: 0 },
            "at 768px no rail is drawn: the list is the screen, with its own More, its foot and its filter, and its search is the one search");
          await rowCount(page, 6);
          await page.setViewportSize({ width: 769, height: 900 });
          await page.locator(".inbox-column .inbox-rail").waitFor();
          assert.deepEqual(await shape(), wide, "widened to 769px again, the rail is back");
          console.log("PASS at 769px the rail (58px) is drawn before a 261px list that has no More and no foot; at 768px no rail is drawn and the list is the 768px screen with its own More, foot, filter and Search; at 769px again the rail is back");
        }, { width: 769, height: 900 }, false);

        await withPage(browser, base, light, "/?app=inbox", "no rail on an upright phone", async (page) => {
          await listScreen(page);
          await rowCount(page, 6);
          const drawn = (): Promise<number[]> => page.evaluate(() => [".inbox-rail", ".app.is-inbox-wide", ".mode-inbox .inbox-more", ".mode-inbox .inbox-add", ".mode-inbox .inbox-foot .inbox-filter-toggle", '.mode-inbox .inbox-foot .inbox-search-input[aria-label="Search"]']
            .map((selector) => document.querySelectorAll(selector).length));
          assert.deepEqual(await drawn(), [0, 0, 1, 1, 1, 1], "a phone draws no rail: its list has More and New workspace at its top, its filter and its search at its foot");
          await openThread(page, WORKING);
          assert.equal(await page.locator(".inbox-rail").count(), 0, "nor over a thread, which is the screen there");
          console.log("PASS an upright phone draws no rail, on its list (More and New workspace at the top, the filter and Search at the foot) or over a thread");
        });
        await withPage(browser, base, light, `/?pane=${encodeURIComponent(WORKING)}&view=chat`, "the rail under a coarse pointer at 1440", async (page) => {
          assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true, "the pointer is coarse");
          await page.locator(".app-header.is-zoned").waitFor();
          const classic = { sidebar: await box(page, "#workspace-drawer"), pane: await box(page, ".pane-column") };
          await page.locator(OVIS_MARK).click();
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await page.locator(".thread-chip").waitFor();
          await rowCount(page, 6);
          const { height } = page.viewportSize()!;
          const [column, rail, list, pane] = await Promise.all([box(page, ".inbox-column"), box(page, ".inbox-column .inbox-rail"), box(page, ".inbox-column .mode-inbox"), box(page, ".pane-column")]);
          assert.deepEqual([rail.x, rail.y, rail.w, rail.h], [0, 0, 68, height], "under a coarse pointer the rail is 68px wide, from the window's top to its foot");
          assert.deepEqual([column.x, column.w], [classic.sidebar.x, classic.sidebar.w], "the column is still the classic sidebar's width");
          assert.deepEqual([pane.x, pane.w], [classic.pane.x, classic.pane.w], "and the pane has the classic shell's box");
          near(list.x, rail.right, 0.5, "the list begins where the rail ends");
          assert.deepEqual((await railButtons(page)).map(({ kind, box: at }) => [kind, at.x, at.y, at.w, at.h]), [
            ["inbox-rail-exit", 12, 12, 44, 44], ["inbox-rail-place", 12, 72, 44, 44],
            ["inbox-rail-waiting", 12, height - 212, 44, 44], ["inbox-rail-alerts", 12, height - 160, 44, 44], ["inbox-rail-settings", 12, height - 108, 44, 44], ["inbox-rail-pcs", 12, height - 56, 44, 44],
          ], "its six buttons are 44px, 12px from the rail's sides, 8px apart");
          const tops = await Promise.all([".inbox-search-toggle", ".inbox-filter-toggle", ".inbox-add"].map((selector) => box(page, `.mode-inbox ${selector}`)));
          for (const each of tops) assert.deepEqual([each.w, each.h, each.y], [44, 44, 12], "the list's top controls are 44px too, on the line of the rail's first button");
          // a pixel in from each corner: a point on the window's last half pixel is outside it for the browser
          assert.deepEqual(await page.evaluate(() => [[1, 1], [1, innerHeight - 1]].map(([x, y]) => {
            const button = document.elementFromPoint(x!, y!)?.closest(".inbox-rail button");
            return button ? [...button.classList].find((name) => name.startsWith("inbox-rail-") && name !== "inbox-rail-item") ?? null : null;
          })), ["inbox-rail-exit", "inbox-rail-pcs"], "the window's top and bottom start corners press the rail's first and last buttons");
          console.log(`PASS under a coarse pointer at 1440 the rail is 68px wide with six 44px buttons, the column the classic sidebar's (${column.w}px) and the pane the classic shell's (${pane.w}px from ${pane.x}), the list (${Math.round(list.w)}px) beside it with 44px top controls on the rail's first button's line, and the window's two start corners press the first and the last button`);
        }, { width: 1440, height: 900 }, true);
        await withPage(browser, base, light, "/?app=inbox&demo_connection=switch", "the rail's PC with two PCs, connected and with the connection lost", async (page) => {
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await rowCount(page, 6);
          await page.evaluate(() => (window as unknown as { __herdrDemoOrder: { addPc: () => string } }).__herdrDemoOrder.addPc());
          await rowCount(page, 12);
          const pc = page.locator(".inbox-rail .inbox-rail-pcs");
          const dot = pc.locator(".inbox-rail-dot");
          const menu = page.locator('.row-menu[role="menu"][aria-label="PCs"]');
          const named = async (name: string, what: string): Promise<void> => {
            const said = await page.waitForFunction((want) => {
              const button = document.querySelector(".inbox-rail .inbox-rail-pcs");
              return button?.getAttribute("aria-label") === want && button.getAttribute("title") === want;
            }, name, { timeout: 15_000 }).then(() => true, () => false);
            if (!said) assert.fail(`${what}: the PC's button is named ${await pc.getAttribute("aria-label")}`);
          };
          await named("PCs, 2 of 2 connected", "with two PCs the button says how many are connected");
          assert.equal(await dot.count(), 0, "connected, no dot is drawn, for one PC or for several");
          await page.waitForFunction(() => window.inboxFixture.rosterOpen, undefined, { timeout: 15_000 });
          await page.evaluate(() => { window.herdrDemoLoseConnection(); window.inboxFixture.dropRoster(); });
          await named("PCs · Reconnecting…", "lost, the button says so of the PCs");
          await pc.locator(".inbox-rail-dot.is-reconnecting").waitFor();
          assert.equal(await dot.count(), 1, "one dot is drawn for the page's connection, never one a PC");
          assert.equal(await page.locator('.inbox-rail > [role="status"]').textContent(), "Reconnecting…", "and the rail's status line says the word");
          await pc.click();
          await menu.waitFor();
          assert.deepEqual(await menu.locator("[data-item]").evaluateAll((items) => items.map((item) => [item.getAttribute("data-item"), item.querySelector(".menu-item-hint")?.textContent ?? null])),
            [["local", "Reconnecting…"], ["laptop", "Reconnecting…"]], "each PC's row says Reconnecting… while the page has lost its stream");
          await page.keyboard.press("Escape");
          await menu.waitFor({ state: "detached" });
          await page.evaluate(() => { window.herdrDemoRestoreConnection(); window.inboxFixture.restoreRoster(); window.dispatchEvent(new Event("online")); });
          await named("PCs, 2 of 2 connected", "back, the button counts the connected PCs again");
          await dot.waitFor({ state: "detached" });
          console.log("PASS with two PCs the rail's PC is named PCs, 2 of 2 connected and draws no dot; with the connection lost on the list alone it is named PCs · Reconnecting…, draws the one reconnecting dot, says the word in its status line and in each PC's row of its list; back, it counts the connected PCs again and then draws no dot");
        }, desktop);
      }
      if (errors.length > 0) {
        failures.push("page errors after the themes");
        console.log(`FAIL page errors after the themes: ${errors.join("; ")}`);
      }
      assert.deepEqual(failures, [], "every block passes");
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
