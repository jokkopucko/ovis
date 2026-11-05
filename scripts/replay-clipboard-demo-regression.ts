/**
 * OSC 52 in replayed output (the screen a new attach is handed, `pty-data` with `replay: true`)
 * never writes the clipboard; live copies still do, once each. Runs the real client and its
 * patched xterm on the demo's fixture transport: no herdr, no user state, loopback only.
 *
 * Every frame carries an ACK offset, and each step waits for its frame's ACK, which the client
 * sends from that frame's xterm write callback: the fixture records the clipboard calls and the
 * terminal's parse state at that moment (the test-hook build's `outputProbe`). For a write still
 * pending at a reconnect, reset or dispose, the fixture holds xterm's own parse of it (`hold`) and
 * releases it once the new output has begun.
 * UI_EVIDENCE_DIR=<dir> also saves screenshots; REPLAY_CLIPBOARD_REPORT=<file> writes the results.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices, type Browser, type BrowserContext, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

interface Step { data: string; replay?: true }
interface Probe { open: boolean; id: number; idComplete: boolean; parsingReplay: boolean; replayOscOpen: boolean; retired: boolean; queued: number; inFlight: number; peakInFlight: number; writes: number; written: string; frameSettled: boolean }
interface Ack { type: string; pane_id: string; stream_id: string; offset: number; socket: number; copies: number; probe: Probe | null }
interface Fixture {
  copies: string[];
  deny: boolean;
  /** new sockets never open: the app stays on its reconnecting screen */
  holdConnect: boolean;
  acks: Ack[];
  sent: Array<{ type: string; pane_id?: string; mode?: string; socket: number }>;
  sockets: Array<WebSocket & { push(frame: Record<string, unknown>): void }>;
  /** a pane the roster (`/api/machines`) says herdr could not restore */
  unrestored: string | null;
  /**
   * Pushes these frames while xterm's parse of the first is held: it stays in flight, unparsed,
   * and the rest wait queued in the client until `release` runs that parse.
   */
  hold(paneId: string, steps: Step[]): void;
  release(): void;
  frames(paneId: string, steps: Step[], wait?: boolean): Promise<{ pushed: Array<Step & { offset: number }>; acks: Ack[] }>;
  restore(): void;
}
declare global { interface Window { replayFixture: Fixture } }

const ESC = "\x1b", BEL = "\x07", CAN = "\x18", SUB = "\x1a", NUL = "\x00";
const HISTORY = "aGlzdG9yeQ=="; // "history"
const LIVE = "bGl2ZQ=="; // "live"
const LIVE_COPY = `${ESC}]52;c;${LIVE}${BEL}`;
const evidence = process.env["UI_EVIDENCE_DIR"];
const reportPath = process.env["REPLAY_CLIPBOARD_REPORT"];
const report: Record<string, unknown[]> = { "live-copy-after-replay": [], "split-origin": [], "reconnect-replay": [] };

/** Installed before the app: a task-owned clipboard recorder and the demo socket's frame seam. */
function installReplayFixture(): void {
  const state = { copies: [], deny: false, acks: [], sent: [], sockets: [], unrestored: null } as unknown as Fixture;
  const waiters: Array<(ack: Ack) => void> = [];
  const offsets = new Map<string, number>();
  window.replayFixture = state;
  const clipboard = navigator.clipboard;
  Object.defineProperty(clipboard, "writeText", {
    configurable: true, writable: true,
    value: (text: string) => {
      state.copies.push(String(text));
      return state.deny ? Promise.reject(new DOMException("blocked by the fixture", "NotAllowedError")) : Promise.resolve();
    },
  });
  state.restore = () => { delete (clipboard as unknown as Record<string, unknown>)["writeText"]; };
  // the demo's roster, with the `unrestored` pane marked as herdr could not restore it
  const demoFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await demoFetch(input, init);
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (state.unrestored === null || new URL(href, location.href).pathname !== "/api/machines") return response;
    const body = await response.json() as { machines: Array<{ snapshot?: { panes: Array<{ pane_id: string }> } }> };
    for (const machine of body.machines) if (machine.snapshot) machine.snapshot.panes = machine.snapshot.panes.map((pane) => pane.pane_id === state.unrestored ? { ...pane, restore_error: "held by the fixture" } : pane);
    return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
  };
  // xterm parses each write from a setTimeout(_innerWrite) of its own: the gate keeps that one callback
  state.hold = (paneId, steps) => {
    const schedule = window.setTimeout;
    let held: (() => void) | null = null;
    window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (!held && typeof callback === "function" && callback.toString().includes("._innerWrite(")) {
        held = () => callback(...args);
        return 0;
      }
      return schedule(callback, delay, ...args);
    }) as typeof window.setTimeout;
    try { void state.frames(paneId, steps, false); } finally { window.setTimeout = schedule; }
    if (!held) throw new Error("xterm scheduled no parse for the held frames");
    state.release = held;
  };
  const probe = (): Probe | null => (document.querySelector(".pane-frame.is-current .pane-terminal") as unknown as { outputProbe?: () => Probe } | null)?.outputProbe?.() ?? null;
  const Demo = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    if (state.holdConnect) {
      const pending = Object.assign(new EventTarget(), {
        readyState: 0, url: String(url), protocol: "", extensions: "", bufferedAmount: 0, binaryType: "blob",
        onopen: null, onclose: null, onmessage: null, onerror: null,
        send() {}, push() {}, close() { pending.readyState = 3; },
      });
      return pending;
    }
    const socket = new Demo(url, protocols) as Fixture["sockets"][number];
    state.sockets.push(socket);
    const push = socket.push.bind(socket);
    // the demo's own recordings would interleave with the frames under test
    socket.push = (frame) => {
      if (frame.type !== "pty-data" && frame.type !== "watch-data") return push(frame);
      if (frame.fixture !== "replay-clipboard") return;
      const { fixture: _, ...output } = frame;
      push(output);
    };
    const send = socket.send.bind(socket);
    socket.send = (raw) => {
      const frame = JSON.parse(String(raw)) as Ack;
      if (frame.type === "pty-ack") {
        // sent from the frame's write callback: the clipboard and the parse state as that frame left them
        const ack = { ...frame, socket: state.sockets.indexOf(socket), copies: state.copies.length, probe: probe() };
        state.acks.push(ack);
        for (const waiter of [...waiters]) waiter(ack);
      } else state.sent.push({ ...frame, socket: state.sockets.indexOf(socket) });
      send(raw);
    };
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Recorded, name, { value: Demo[name] });
  window.WebSocket = Recorded as unknown as typeof WebSocket;
  state.frames = (paneId, steps, wait = true) => new Promise((resolve, reject) => {
    const index = state.sockets.length - 1;
    const socket = state.sockets[index]!;
    const stream = `replay-clipboard-${index}`;
    let offset = offsets.get(stream) ?? 0;
    const pushed = steps.map((step) => ({ ...step, offset: offset += new TextEncoder().encode(step.data).length }));
    offsets.set(stream, offset);
    const seen: Ack[] = [];
    const done = () => { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(timer); };
    const waiter = (ack: Ack) => {
      if (ack.stream_id !== stream || ack.socket !== index) return;
      seen.push(ack);
      if (ack.offset >= offset) { done(); resolve({ pushed, acks: seen }); }
    };
    const timer = setTimeout(() => { done(); reject(new Error(`no ACK reached ${offset} on ${stream}; saw ${JSON.stringify(seen.map((ack) => ack.offset))}`)); }, 5000);
    // subscribed before the first push
    waiters.push(waiter);
    for (const step of pushed) socket.push({ type: "pty-data", fixture: "replay-clipboard", pane_id: paneId, data: step.data, flow: { stream_id: stream, offset: step.offset }, ...(step.replay ? { replay: true } : {}) });
    if (!wait) { done(); resolve({ pushed, acks: seen }); }
  });
}

const fixture = <T>(page: Page, run: (state: Fixture) => T | Promise<T>): Promise<T> =>
  page.evaluate(`(${run.toString()})(window.replayFixture)`) as Promise<T>;
const probeOf = (page: Page): Promise<Probe> => page.locator(".pane-frame.is-current .pane-terminal").evaluate((host) => (host as unknown as { outputProbe(): Probe }).outputProbe());

async function frames(page: Page, steps: Step[], pane = panes.shell): Promise<{ pushed: Array<Step & { offset: number }>; acks: Ack[] }> {
  return page.evaluate(([paneId, list]) => window.replayFixture.frames(paneId, list), [pane, steps] as const);
}

/** A clean terminal and clipboard between cases: CAN ends whatever OSC is open without dispatching it. */
async function resetCase(page: Page, pane = panes.shell): Promise<void> {
  await frames(page, [{ data: `${CAN}${ESC}c` }], pane);
  const probe = await probeOf(page);
  assert.equal(probe.replayOscOpen, false, "the reset leaves no replayed OSC pending");
  assert.equal(probe.open, false);
  await fixture(page, (state) => { state.copies.length = 0; state.deny = false; });
}

interface Case { name: string; group: "live-copy-after-replay" | "split-origin"; steps: Step[]; copies: string[]; copiesAfter?: number[]; probes?: Array<Partial<Probe>> }
const R = (data: string): Step => ({ data, replay: true });
const L = (data: string): Step => ({ data });

const CASES: Case[] = [
  { name: "replay-open-52 then live ST and live copy", group: "live-copy-after-replay", steps: [R(`${ESC}]52;c;${HISTORY}`), L(`${ESC}[0m${ESC}]52;c;${LIVE}${BEL}`)], copies: ["live"], copiesAfter: [0, 1], probes: [{ open: true, id: 52, idComplete: true, replayOscOpen: true }, { open: false, replayOscOpen: false }] },
  { name: "wholly live copy with ST split ESC | backslash", group: "live-copy-after-replay", steps: [L(`${ESC}]52;c;${LIVE}${ESC}`), L("\\")], copies: ["live"], copiesAfter: [1, 1] },
  { name: "whole historical copy inside the replay", group: "live-copy-after-replay", steps: [R(`${ESC}[2J${ESC}[Hrestored${ESC}]52;c;${HISTORY}${BEL}`), L(LIVE_COPY)], copies: ["live"], copiesAfter: [0, 1] },
  { name: "replay 052 completed by live BEL", group: "split-origin", steps: [R(`${ESC}]052;c;${HISTORY}`), L(BEL)], copies: [], probes: [{ open: true, id: 52, idComplete: true, replayOscOpen: true }, { open: false, replayOscOpen: false }] },
  { name: "replay 5<NUL>2 completed by live BEL", group: "split-origin", steps: [R(`${ESC}]5${NUL}2;c;${HISTORY}`), L(BEL)], copies: [], probes: [{ open: true, id: 52, idComplete: true, replayOscOpen: true }] },
  ...[["CAN", CAN], ["SUB", SUB]].flatMap(([label, abort]) => [
    { name: `replay-open-52, ${label} and live copy in one live frame (fail-closed edge)`, group: "split-origin" as const, steps: [R(`${ESC}]52;c;${HISTORY}`), L(`${abort}${LIVE_COPY}`)], copies: [], probes: [{ replayOscOpen: true }, { open: false, replayOscOpen: false }] },
    { name: `replay-open-52, ${label}, live copy in the next frame`, group: "split-origin" as const, steps: [R(`${ESC}]52;c;${HISTORY}`), L(abort!), L(LIVE_COPY)], copies: ["live"], copiesAfter: [0, 0, 1], probes: [{ replayOscOpen: true }, { open: false, replayOscOpen: false }, { replayOscOpen: false }] },
  ]),
  { name: "replay selector 5 completed as 53, live copy in that frame (fail-closed edge)", group: "split-origin", steps: [R(`${ESC}]5`), L(`3;eA==${BEL}${LIVE_COPY}`)], copies: [], probes: [{ open: true, id: 5, idComplete: false, replayOscOpen: true }, { replayOscOpen: false }] },
  { name: "replay selector 5 completed as 53, live copy in the next frame", group: "split-origin", steps: [R(`${ESC}]5`), L(`3;eA==${BEL}`), L(LIVE_COPY)], copies: ["live"], copiesAfter: [0, 0, 1], probes: [{ replayOscOpen: true }, { open: false, replayOscOpen: false }, {}] },
  { name: "partial identifier: ESC ] only", group: "split-origin", steps: [R(`${ESC}]`), L(CAN)], copies: [], probes: [{ open: true, id: -1, idComplete: false, replayOscOpen: true }, { open: false, replayOscOpen: false }] },
  { name: "partial identifier: 05", group: "split-origin", steps: [R(`${ESC}]05`), L(CAN)], copies: [], probes: [{ open: true, id: 5, idComplete: false, replayOscOpen: true }, { replayOscOpen: false }] },
  { name: "partial identifier: 52 before its separator", group: "split-origin", steps: [R(`${ESC}]52`), L(`;c;${HISTORY}${BEL}`)], copies: [], probes: [{ open: true, id: 52, idComplete: false, replayOscOpen: true }, { replayOscOpen: false }] },
  { name: "complete identifier 53 is not kept", group: "split-origin", steps: [R(`${ESC}]53;`), L(`eA==${BEL}${LIVE_COPY}`)], copies: ["live"], probes: [{ open: true, id: 53, idComplete: true, replayOscOpen: false }, {}] },
  { name: "C1 OSC is left to xterm", group: "split-origin", steps: [R(`\x9d52;c;${HISTORY}`), L(BEL), L(LIVE_COPY)], copies: ["live"] },
  { name: "query is not answered", group: "split-origin", steps: [L(`${ESC}]52;c;?${BEL}`), L(`${ESC}]52;c;${BEL}`)], copies: [] },
  { name: "malformed payload, then a permitted live copy", group: "split-origin", steps: [L(`${ESC}]52;c;%%%${BEL}`), L(`${ESC}]52${BEL}`), L(LIVE_COPY)], copies: ["live"], copiesAfter: [0, 0, 1] },
];

async function runCase(page: Page, test: Case): Promise<Record<string, unknown>> {
  await resetCase(page);
  const before = await probeOf(page);
  const { pushed, acks } = await frames(page, test.steps);
  const after = await probeOf(page);
  const copies = await fixture(page, (state) => [...state.copies]);
  const expected = test.steps.map((step) => step.data).join("");
  const result = {
    name: test.name, steps: test.steps.map((step) => ({ replay: step.replay === true, data: JSON.stringify(step.data), bytes: new TextEncoder().encode(step.data).length })),
    copies, copiesAfter: acks.map((ack) => ack.copies), offsets: pushed.map((step) => step.offset), acked: acks.map((ack) => ack.offset),
    oscStringState: acks.map((ack) => ack.probe && { open: ack.probe.open, id: ack.probe.id, idComplete: ack.probe.idComplete, replayOscOpen: ack.probe.replayOscOpen, parsingReplay: ack.probe.parsingReplay }),
    writes: after.writes - before.writes, peakInFlight: after.peakInFlight, bytesUnchanged: after.written.endsWith(expected),
  };
  assert.deepEqual(copies, test.copies, `${test.name}: clipboard calls`);
  assert.deepEqual(result.acked, result.offsets, `${test.name}: one ACK per whole frame, at its own offset`);
  assert.equal(result.writes, test.steps.length, `${test.name}: each frame is one xterm write`);
  assert.equal(after.peakInFlight, 1, `${test.name}: never more than one xterm write outstanding`);
  assert.equal(after.queued, 0);
  assert.ok(result.bytesUnchanged, `${test.name}: the frames reach xterm byte for byte`);
  if (test.copiesAfter) assert.deepEqual(result.copiesAfter, test.copiesAfter, `${test.name}: clipboard calls after each frame`);
  for (const [index, want] of (test.probes ?? []).entries()) {
    const got = acks[index]?.probe;
    assert.ok(got, `${test.name}: a parse state after frame ${index}`);
    for (const [key, value] of Object.entries(want)) assert.equal(got[key as keyof Probe], value, `${test.name}: frame ${index} ${key}`);
    assert.equal(got.parsingReplay, false, `${test.name}: the replay flag ends at its frame's callback`);
  }
  report[test.group]!.push(result);
  return result;
}

const settings = (extra: Record<string, unknown>) => JSON.stringify({ language: "en", theme: "dark", defaultView: "terminal", terminalInputMode: "direct", alertsOn: false, paneClipboard: true, ...extra });

async function openPage(context: BrowserContext, url: string, pane = panes.shell): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  Object.assign(page, { errors });
  await page.goto(`${url}?pane=${encodeURIComponent(pane)}&view=terminal`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.waitForFunction((paneId) => window.replayFixture.sent.some((frame) => frame.type === "attach" && frame.pane_id === paneId), pane);
  await page.waitForFunction(() => typeof (document.querySelector(".pane-frame.is-current .pane-terminal") as unknown as { outputProbe?: unknown } | null)?.outputProbe === "function");
  return page;
}
const pageErrors = (page: Page): string[] => (page as unknown as { errors: string[] }).errors;

async function newContext(browser: Browser, url: string, options: { phone?: boolean; theme?: "light" | "dark"; language?: string; extra?: Record<string, unknown> } = {}): Promise<BrowserContext> {
  const base = options.phone ? devices["iPhone 14"] : { viewport: { width: 1440, height: 900 } };
  const context = await browser.newContext({ ...base, locale: options.language === "ko" ? "ko-KR" : "en-US" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(url).origin });
  await context.addInitScript((value) => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", value); }, settings({ theme: options.theme ?? "dark", language: options.language ?? "en", ...options.extra }));
  return context;
}

const LONG = "unbroken-" + "x".repeat(260);
const RESTORED = `${ESC}[2J${ESC}[H${ESC}[1;32mrestored screen${ESC}[0m from before this attach\r\n${ESC}[33m$ ${ESC}[0mcat notes.txt\r\n${LONG}\r\n${ESC}]52;c;${HISTORY}${BEL}${ESC}[36mrelease $ ${ESC}[0m`;

async function shot(page: Page, name: string): Promise<string | null> {
  if (!evidence) return null;
  const file = join(evidence, `${name}.png`);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({ path: file });
  return file;
}

const app = mkdtempSync(join(tmpdir(), "herdr-replay-clipboard-demo-"));
let server: ReturnType<typeof Bun.serve> | null = null;
let browser: Browser | null = null;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  // after the demo's transport, whose socket the fixture wraps
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n<script>(${installReplayFixture.toString()})()</script>\n<script type="module"`));
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
  if (evidence) mkdirSync(evidence, { recursive: true });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });

  // the corpus, one case at a time on one terminal
  {
    const context = await newContext(browser, url);
    try {
      const page = await openPage(context, url);
      for (const test of CASES) {
        await runCase(page, test);
        console.log(`PASS ${test.group}: ${test.name}`);
      }
      // an older bridge sends no replay origin: its replay cannot be told from live output
      await resetCase(page);
      await frames(page, [L(`${ESC}]52;c;${HISTORY}${BEL}`)]);
      const omitted = await fixture(page, (state) => [...state.copies]);
      assert.deepEqual(omitted, ["history"], "an unmarked frame is live output (the documented limit for older bridges)");
      report["reconnect-replay"]!.push({ name: "older bridge omits replay: treated as live (documented limit)", copies: omitted });
      // permission off: no copy at all, live or replayed; on again, the next live copy works
      await page.evaluate(() => localStorage.setItem("ovis:settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("ovis:settings")!), paneClipboard: false })));
      await page.reload();
      await page.waitForFunction(() => window.replayFixture?.sent.some((frame) => frame.type === "attach"));
      await page.waitForFunction(() => typeof (document.querySelector(".pane-frame.is-current .pane-terminal") as unknown as { outputProbe?: unknown } | null)?.outputProbe === "function");
      await frames(page, [R(RESTORED), L(LIVE_COPY)]);
      const off = await fixture(page, (state) => [...state.copies]);
      assert.deepEqual(off, [], "permission off: no clipboard call");
      await page.evaluate(() => localStorage.setItem("ovis:settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("ovis:settings")!), paneClipboard: true })));
      await page.reload();
      await page.waitForFunction(() => window.replayFixture?.sent.some((frame) => frame.type === "attach"));
      await page.waitForFunction(() => typeof (document.querySelector(".pane-frame.is-current .pane-terminal") as unknown as { outputProbe?: unknown } | null)?.outputProbe === "function");
      await frames(page, [R(RESTORED), L(LIVE_COPY)]);
      const on = await fixture(page, (state) => [...state.copies]);
      assert.deepEqual(on, ["live"], "permission on again: the next live copy, and not the replayed one");
      // the browser refuses the write: one attempt, said in the banner, and replay still asks nothing
      await fixture(page, (state) => { state.copies.length = 0; state.deny = true; });
      await frames(page, [L(LIVE_COPY)]);
      await page.locator(".terminal-banner", { hasText: "clipboard write blocked by the browser" }).waitFor();
      await frames(page, [R(`${ESC}]52;c;${HISTORY}${BEL}`)]);
      const denied = await fixture(page, (state) => [...state.copies]);
      assert.deepEqual(denied, ["live"], "a denied live copy is tried once; the replayed one never");
      report["reconnect-replay"]!.push({ name: "permission off, then on", off, on }, { name: "browser denies the write", copies: denied, banner: "clipboard write blocked by the browser" });
      assert.deepEqual(pageErrors(page), []);
      await fixture(page, (state) => state.restore());
      console.log("PASS permission off/on, denied write, older-bridge limit");
    } finally { await context.close(); }
  }

  // reconnect, a second tab, a pane switch with whole writes queued, an observer
  {
    const context = await newContext(browser, url);
    try {
      const page = await openPage(context, url);
      // a replayed OSC is left open, then the connection drops
      await frames(page, [R(`${ESC}]52;c;${HISTORY}`)]);
      assert.equal((await probeOf(page)).replayOscOpen, true);
      const sockets = await fixture(page, (state) => state.sockets.length);
      await fixture(page, (state) => state.sockets.at(-1)!.close());
      await page.waitForFunction((count) => window.replayFixture.sent.some((frame) => frame.type === "attach" && frame.socket >= count), sockets);
      const reopened = await probeOf(page);
      // the reconnect's replay closes the old OSC under its own flag; neither part copies
      const { acks } = await frames(page, [R(`${ESC}\\${ESC}[2J${ESC}[Hrestored after reconnect${ESC}]52;c;${HISTORY}${BEL}`), L(LIVE_COPY)]);
      const reconnect = await fixture(page, (state) => ({ copies: [...state.copies], acks: state.acks.map((ack) => `${ack.socket}:${ack.offset}`) }));
      assert.deepEqual(reconnect.copies, ["live"], "reconnect: no historical copy, the live one once");
      assert.equal(new Set(reconnect.acks).size, reconnect.acks.length, "no duplicate ACK across the reconnect");
      assert.equal(acks[0]!.probe!.replayOscOpen, false, "the replayed OSC is gone after the new replay");
      report["reconnect-replay"]!.push({ name: "reconnect", replayOscOpenAfterDisconnect: reopened.replayOscOpen, oscOpenAfterDisconnect: reopened.open, copies: reconnect.copies, acks: reconnect.acks, afterReplay: acks.map((ack) => ack.probe && { open: ack.probe.open, replayOscOpen: ack.probe.replayOscOpen }) });
      console.log("PASS reconnect");

      // a second tab of the same app: its own attach replays history, and copies nothing
      const second = await openPage(context, url);
      await frames(second, [R(RESTORED), R(`${ESC}]52;c;${HISTORY}`), L(BEL)]);
      const tabs = { second: await fixture(second, (state) => [...state.copies]), first: await fixture(page, (state) => [...state.copies]) };
      assert.deepEqual(tabs, { second: [], first: ["live"] }, "a second tab's replay copies nothing in either tab");
      report["reconnect-replay"]!.push({ name: "second tab", ...tabs });
      await second.close();
      console.log("PASS second tab");

      // whole frames queued in the client when the pane switches: none of the old pane's history copies,
      // no frame is acknowledged twice, and the next pane starts clean
      await resetCase(page);
      const oldHost = await page.locator(".pane-frame.is-current .pane-terminal").evaluateHandle((host) => host);
      const switched = await page.evaluate(([shell, web]) => {
        const state = window.replayFixture;
        void state.frames(shell, [{ data: `${"\x1b"}]52;c;aGlzdG9yeQ==`, replay: true }, { data: "\x07" }, { data: "after the switch" }], false);
        const { inFlight, queued } = (document.querySelector(".pane-frame.is-current .pane-terminal") as unknown as { outputProbe(): Probe }).outputProbe();
        (document.querySelector(`.workspace-select[data-pane="${web}"]`) as HTMLElement).click();
        return { acks: state.acks.length, inFlight, queued };
      }, [panes.shell, panes.web] as const);
      assert.deepEqual({ inFlight: switched.inFlight, queued: switched.queued }, { inFlight: 1, queued: 2 }, "pane switch: one write pending and two queued when it happens");
      await page.waitForFunction((paneId) => window.replayFixture.sent.some((frame) => frame.type === "attach" && frame.pane_id === paneId), panes.web);
      // the barrier is the old terminal's own: every frame it held is written or dropped, its callbacks run
      await page.waitForFunction((host) => {
        const probe = (host as unknown as { outputProbe(): Probe }).outputProbe();
        return probe.queued === 0 && probe.inFlight === 0;
      }, oldHost);
      const old = await oldHost.evaluate((host) => ({ connected: host.isConnected, current: host === document.querySelector(".pane-frame.is-current .pane-terminal"), probe: (host as unknown as { outputProbe(): Probe }).outputProbe() }));
      const switchCopies = await fixture(page, (state) => [...state.copies]);
      const lateAcks = await fixture(page, (state) => state.acks.map((ack) => `${ack.socket}:${ack.stream_id}:${ack.offset}`));
      assert.deepEqual(switchCopies, [], "pane switch: the old pane's queued history copies nothing");
      assert.equal(new Set(lateAcks).size, lateAcks.length, "pane switch: no frame acknowledged twice");
      assert.equal(old.probe.queued, 0);
      assert.equal(old.probe.peakInFlight, 1);
      const next = await frames(page, [R(RESTORED), L(LIVE_COPY)], panes.web);
      const afterSwitch = await fixture(page, (state) => [...state.copies]);
      assert.deepEqual(afterSwitch, ["live"], "the next pane's live copy works after its own replay");
      assert.equal(next.acks.at(-1)!.probe!.replayOscOpen, false);
      report["reconnect-replay"]!.push({ name: "pane switch with whole writes queued", acksBeforeSwitch: switched, oldTerminal: { mounted: old.connected, reusedForNextPane: old.current, replayOscOpen: old.probe.replayOscOpen, queued: old.probe.queued, peakInFlight: old.probe.peakInFlight }, copies: switchCopies, acks: lateAcks, nextPane: afterSwitch });
      console.log(`PASS pane switch (${old.current ? "same terminal, reset" : old.connected ? "old terminal kept as a cached tab" : "old terminal disposed"})`);

      // an observer: history replayed to it copies nothing, and it sends no input of its own
      const sentBefore = await fixture(page, (state) => state.sent.length);
      await fixture(page, (state) => state.sockets.at(-1)!.send(JSON.stringify({ type: "role", mode: "observe" })));
      await page.locator(".pane-frame.is-current .terminal-banner").filter({ has: page.locator("svg.lucide-eye") }).waitFor();
      await fixture(page, (state) => { state.copies.length = 0; });
      await frames(page, [R(`${ESC}]52;c;${HISTORY}${BEL}`), L("observed output\r\n")], panes.web);
      const observed = await fixture(page, (state) => ({ copies: [...state.copies], sent: state.sent.map((frame) => frame.type) }));
      assert.deepEqual(observed.copies, []);
      assert.deepEqual(observed.sent.slice(sentBefore).filter((type) => ["input", "keys", "resize", "submit"].includes(type)), [], "an observer sends no input");
      report["reconnect-replay"]!.push({ name: "observer", copies: observed.copies, framesSent: observed.sent.slice(sentBefore) });
      console.log("PASS observer");

      // the terminal is disposed while a replayed OSC is open in it: four other tabs push its pane out
      // of the cached ones (paneTabCache.ts). Eviction releases the attach; the disposed terminal
      // keeps no flag, and nothing copies.
      await page.locator(`.workspace-select[data-pane="${panes.shell}"]`).click();
      await page.locator(`.pane-frame.is-current[data-layout-pane="${panes.shell}"] .pane-terminal`).waitFor({ state: "attached" });
      await resetCase(page);
      const disposedHost = await page.locator(".pane-frame.is-current .pane-terminal").evaluateHandle((host) => host);
      await frames(page, [R(`${ESC}]52;c;${HISTORY}`)]);
      const atDispose = await probeOf(page);
      assert.equal(atDispose.replayOscOpen, true);
      const acksBefore = await fixture(page, (state) => state.acks.length);
      for (const pane of [panes.web, panes.flaky, panes.omp, panes.cli]) {
        await page.locator(`.workspace-select[data-pane="${pane}"]`).click();
        await page.locator(`.pane-frame.is-current[data-layout-pane="${pane}"]`).waitFor({ state: "attached" });
      }
      await page.waitForFunction((host) => !host.isConnected, disposedHost);
      const disposed = await disposedHost.evaluate((host) => (host as unknown as { outputProbe(): Probe }).outputProbe());
      const disposeAcks = await fixture(page, (state) => state.acks.map((ack) => `${ack.socket}:${ack.stream_id}:${ack.offset}`));
      const disposeCopies = await fixture(page, (state) => [...state.copies]);
      assert.equal(disposed.queued, 0, "nothing is left queued in a disposed terminal");
      assert.equal(disposed.replayOscOpen, false, "dispose forgets the replayed OSC");
      assert.equal(disposed.parsingReplay, false);
      assert.equal(disposed.peakInFlight, 1);
      assert.equal(disposeAcks.length, acksBefore, "a disposed terminal acknowledges nothing more");
      assert.equal(new Set(disposeAcks).size, disposeAcks.length, "no frame acknowledged twice");
      assert.deepEqual(disposeCopies, [], "a disposed terminal copies nothing");
      report["reconnect-replay"]!.push({ name: "dispose with a replayed OSC open", beforeDispose: { open: atDispose.open, id: atDispose.id, replayOscOpen: atDispose.replayOscOpen }, disposedTerminal: { queued: disposed.queued, replayOscOpen: disposed.replayOscOpen, parsingReplay: disposed.parsingReplay, writes: disposed.writes, peakInFlight: disposed.peakInFlight }, acksAfterDispose: disposeAcks.length - acksBefore, copies: disposeCopies });
      console.log("PASS dispose");
      assert.deepEqual(pageErrors(page), []);
      await fixture(page, (state) => state.restore());
    } finally { await context.close(); }
  }

  // A write still pending when its output ends: xterm holds the first frame unparsed and the rest
  // wait in the client. After a reconnect, a reset or a dispose, nothing from before copies, no frame
  // is acknowledged again, and the new output is not marked ready by an old callback.
  {
    const STALE_COPY = `${ESC}]52;c;c3RhbGU=${BEL}`; // "stale"
    const PENDING = [
      { name: "replayed OSC in flight, its live end and a live copy queued", steps: [R(`${ESC}]52;c;${HISTORY}`), L(BEL), L(STALE_COPY)], replayOscOpen: true },
      { name: "live copy in flight, another queued", steps: [L(STALE_COPY), L(STALE_COPY)], replayOscOpen: false },
      // the old output's live OSC 52 is still open when it is retired: the new output's first live
      // frame ends it, and that copy is the old output's
      { name: "live OSC 52 left open in flight, a live copy queued", steps: [L(`${ESC}]52;c;c3RhbGU=`), L(STALE_COPY)], replayOscOpen: true, next: [L(`${BEL}${LIVE_COPY}`)] },
      // the queued frame that is dropped opened a synchronized update (DEC mode 2026) xterm never
      // parsed: the frame gate (lib/inputRow.ts FrameGate) forgets it, so the new output's frames settle
      { name: "a frame opening a synchronized update queued", steps: [L("pending"), L(`${ESC}[?2026hhalf a frame`)], replayOscOpen: false },
    ];
    // These cases exercise retirement on detach. The alongside-herdr setting still detaches
    // on a pane switch; terminal-switch-regression covers the default live cache.
    const context = await newContext(browser, url, { extra: { releasePaneAway: true } });
    try {
      const page = await openPage(context, url);
      const acked = (): Promise<string[]> => fixture(page, (state) => state.acks.map((ack) => `${ack.socket}:${ack.stream_id}:${ack.offset}`));
      const settled = (host: unknown): Promise<unknown> => page.waitForFunction((element) => {
        const probe = (element as { outputProbe(): Probe }).outputProbe();
        return probe.inFlight === 0 && probe.queued === 0;
      }, host);
      const hold = async (steps: Step[]): Promise<Probe> => {
        await page.evaluate(([paneId, list]) => window.replayFixture.hold(paneId, list), [panes.shell, steps] as const);
        const probe = await probeOf(page);
        assert.equal(probe.inFlight, 1, "one write is pending in xterm");
        assert.equal(probe.queued, steps.length - 1, "the other frames wait in the client");
        assert.equal(probe.retired, false);
        return probe;
      };
      const ready = (): Promise<number> => page.locator(".pane-frame.is-current [data-pane-content]").count();

      for (const test of PENDING) {
        await resetCase(page);
        const host = await page.locator(".pane-frame.is-current .pane-terminal").evaluateHandle((element) => element);
        const before = await acked();
        const held = await hold(test.steps);
        const sockets = await fixture(page, (state) => state.sockets.length);
        await fixture(page, (state) => state.sockets.at(-1)!.close());
        const retired = await probeOf(page);
        assert.deepEqual({ queued: retired.queued, inFlight: retired.inFlight, retired: retired.retired }, { queued: 0, inFlight: 1, retired: true }, `${test.name}: the disconnect drops the queued frames and retires the pending one`);
        await page.waitForFunction(([count, paneId]) => window.replayFixture.sent.some((frame) => frame.type === "attach" && frame.pane_id === paneId && frame.socket >= count), [sockets, panes.shell] as const);
        await fixture(page, (state) => state.release());
        await settled(host);
        const after = await probeOf(page);
        const copies = await fixture(page, (state) => [...state.copies]);
        const acks = await acked();
        const readyAfterOld = await ready();
        assert.deepEqual(copies, [], `${test.name}: nothing from before the reconnect copies`);
        assert.deepEqual(acks, before, `${test.name}: no old frame is acknowledged after the reconnect`);
        assert.equal(after.writes, held.writes, `${test.name}: only the pending frame reached xterm`);
        assert.equal(after.replayOscOpen, test.replayOscOpen, `${test.name}: a replayed OSC the old frame left open stays guarded`);
        assert.equal(readyAfterOld, 0, `${test.name}: the old frame's callback does not mark the new output ready`);
        // the new connection's own replay and live copy, as after any reconnect
        const next = await frames(page, test.next ?? [R(`${ESC}\\${ESC}[2J${ESC}[Hrestored after reconnect${ESC}]52;c;${HISTORY}${BEL}`), L(LIVE_COPY)]);
        const nextCopies = await fixture(page, (state) => [...state.copies]);
        assert.deepEqual(nextCopies, ["live"], `${test.name}: the new output's live copy works`);
        assert.deepEqual(next.acks.map((ack) => ack.offset), next.pushed.map((step) => step.offset), `${test.name}: one ACK per new frame`);
        assert.equal(await ready(), 1, `${test.name}: the new output marks itself ready`);
        const settledNext = (await probeOf(page)).frameSettled;
        assert.equal(settledNext, true, `${test.name}: the new output's frames settle, whatever the dropped frames opened`);
        report["reconnect-replay"]!.push({ name: `pending write at reconnect: ${test.name}`, pending: { inFlight: held.inFlight, queued: held.queued }, afterDisconnect: { queued: retired.queued, inFlight: retired.inFlight, retired: retired.retired }, copies, acksAfterDisconnect: acks.length - before.length, writesAfterRelease: after.writes - held.writes, replayOscOpen: after.replayOscOpen, readyFromOldCallback: readyAfterOld > 0, nextCopies, frameSettled: settledNext });
        console.log(`PASS pending write at reconnect: ${test.name}`);
      }

      // the same with nothing pending: the old output's live OSC 52 was parsed whole and left open
      {
        await resetCase(page);
        await frames(page, [L(`${ESC}]52;c;c3RhbGU=`)]);
        const open = await probeOf(page);
        assert.deepEqual({ open: open.open, id: open.id, inFlight: open.inFlight, queued: open.queued, replayOscOpen: open.replayOscOpen }, { open: true, id: 52, inFlight: 0, queued: 0, replayOscOpen: false }, "a live OSC 52 is open and nothing is pending");
        const sockets = await fixture(page, (state) => state.sockets.length);
        await fixture(page, (state) => state.sockets.at(-1)!.close());
        await page.waitForFunction(([count, paneId]) => window.replayFixture.sent.some((frame) => frame.type === "attach" && frame.pane_id === paneId && frame.socket >= count), [sockets, panes.shell] as const);
        const retired = await probeOf(page);
        assert.equal(retired.replayOscOpen, true, "the old output's open OSC is guarded after the reconnect");
        const next = await frames(page, [L(`${BEL}${LIVE_COPY}`)]);
        const copies = await fixture(page, (state) => [...state.copies]);
        assert.deepEqual(copies, ["live"], "the old output's OSC 52 copies nothing; the new live copy once");
        assert.deepEqual(next.acks.map((ack) => ack.offset), next.pushed.map((step) => step.offset));
        report["reconnect-replay"]!.push({ name: "live OSC 52 left open at reconnect, nothing pending", beforeDisconnect: { open: open.open, id: open.id }, replayOscOpenAfterReconnect: retired.replayOscOpen, copies });
        console.log("PASS open live OSC at reconnect, nothing pending");
      }

      // reset: herdr could not restore the pane, so its terminal is reset to no pane, with a write pending
      {
        await resetCase(page);
        const host = await page.locator(".pane-frame.is-current .pane-terminal").evaluateHandle((element) => element);
        const before = await acked();
        const held = await hold(PENDING[0]!.steps);
        const detaches = await page.evaluate((paneId) => window.replayFixture.sent.filter((frame) => frame.type === "detach" && frame.pane_id === paneId).length, panes.shell);
        // the roster is read again on session-changed, and now says herdr could not restore the pane
        await page.evaluate((paneId) => {
          const state = window.replayFixture;
          state.unrestored = paneId;
          state.sockets.at(-1)!.push({ type: "session-changed" });
        }, panes.shell);
        await page.waitForFunction(([paneId, count]) => window.replayFixture.sent.filter((frame) => frame.type === "detach" && frame.pane_id === paneId).length > count, [panes.shell, detaches] as const);
        const reset = await host.evaluate((element) => ({ mounted: element.isConnected, probe: (element as unknown as { outputProbe(): Probe }).outputProbe() }));
        assert.equal(reset.mounted, true, "the same terminal is reset, not replaced");
        assert.deepEqual({ queued: reset.probe.queued, inFlight: reset.probe.inFlight, retired: reset.probe.retired }, { queued: 0, inFlight: 1, retired: true }, "the reset drops the queued frames and retires the pending one");
        await fixture(page, (state) => state.release());
        await settled(host);
        const after = await host.evaluate((element) => (element as unknown as { outputProbe(): Probe }).outputProbe());
        const copies = await fixture(page, (state) => [...state.copies]);
        const acks = await acked();
        assert.deepEqual(copies, [], "reset: nothing from before copies");
        assert.deepEqual(acks, before, "reset: no old frame is acknowledged after the reset");
        assert.equal(after.writes, held.writes, "reset: only the pending frame reached xterm");
        report["reconnect-replay"]!.push({ name: "pending write at reset (pane restore error)", pending: { inFlight: held.inFlight, queued: held.queued }, afterReset: { queued: reset.probe.queued, inFlight: reset.probe.inFlight, retired: reset.probe.retired }, copies, acksAfterReset: acks.length - before.length, writesAfterRelease: after.writes - held.writes });
        // the pane is restored again: its terminal attaches afresh
        const attaches = await page.evaluate((paneId) => window.replayFixture.sent.filter((frame) => frame.type === "attach" && frame.pane_id === paneId).length, panes.shell);
        await page.evaluate(() => {
          const state = window.replayFixture;
          state.unrestored = null;
          state.sockets.at(-1)!.push({ type: "session-changed" });
        });
        await page.waitForFunction(([paneId, count]) => window.replayFixture.sent.filter((frame) => frame.type === "attach" && frame.pane_id === paneId).length > count, [panes.shell, attaches] as const);
        console.log("PASS pending write at reset");
      }

      // pane switch: the old pane's tab is cached, so its terminal stays mounted and lets go of its
      // attach while its write is pending; the parse is released only after the next pane attached
      {
        await page.locator(`.pane-frame.is-current[data-layout-pane="${panes.shell}"] .pane-terminal`).waitFor({ state: "attached" });
        await resetCase(page);
        const host = await page.locator(".pane-frame.is-current .pane-terminal").evaluateHandle((element) => element);
        const before = await acked();
        const count = (type: string, paneId: string): Promise<number> => page.evaluate(([kind, id]) => window.replayFixture.sent.filter((frame) => frame.type === kind && frame.pane_id === id).length, [type, paneId] as const);
        const detaches = await count("detach", panes.shell);
        const attaches = await count("attach", panes.web);
        const held = await hold(PENDING[0]!.steps);
        await page.locator(`.workspace-select[data-pane="${panes.web}"]`).click();
        await page.waitForFunction(([id, seen]) => window.replayFixture.sent.filter((frame) => frame.type === "attach" && frame.pane_id === id).length > seen, [panes.web, attaches] as const);
        await page.waitForFunction(([id, seen]) => window.replayFixture.sent.filter((frame) => frame.type === "detach" && frame.pane_id === id).length > seen, [panes.shell, detaches] as const);
        const cached = await host.evaluate((element) => ({ mounted: element.isConnected, current: element === document.querySelector(".pane-frame.is-current .pane-terminal"), probe: (element as unknown as { outputProbe(): Probe }).outputProbe() }));
        assert.deepEqual({ mounted: cached.mounted, current: cached.current }, { mounted: true, current: false }, "pane switch: the old terminal is kept as a cached tab");
        assert.deepEqual({ queued: cached.probe.queued, inFlight: cached.probe.inFlight, retired: cached.probe.retired }, { queued: 0, inFlight: 1, retired: true }, "pane switch: letting go of the attach drops the queued frames and retires the pending one");
        await fixture(page, (state) => state.release());
        await settled(host);
        const after = await host.evaluate((element) => (element as unknown as { outputProbe(): Probe }).outputProbe());
        const copies = await fixture(page, (state) => [...state.copies]);
        const acks = await acked();
        assert.deepEqual(copies, [], "pane switch: nothing the old pane had pending copies");
        assert.deepEqual(acks, before, "pane switch: no old frame is acknowledged after the detach");
        assert.equal(after.writes, held.writes, "pane switch: only the pending frame reached xterm");
        assert.equal(after.replayOscOpen, true, "pane switch: the replayed OSC the old frame left open stays guarded");
        const next = await frames(page, [R(RESTORED), L(LIVE_COPY)], panes.web);
        const nextCopies = await fixture(page, (state) => [...state.copies]);
        assert.deepEqual(nextCopies, ["live"], "pane switch: the next pane's live copy works");
        assert.deepEqual(next.acks.map((ack) => ack.offset), next.pushed.map((step) => step.offset), "pane switch: one ACK per new frame");
        report["reconnect-replay"]!.push({ name: "pending write at a pane switch to a cached tab", pending: { inFlight: held.inFlight, queued: held.queued }, afterDetach: { mounted: cached.mounted, current: cached.current, queued: cached.probe.queued, inFlight: cached.probe.inFlight, retired: cached.probe.retired }, copies, acksAfterDetach: acks.length - before.length, writesAfterRelease: after.writes - held.writes, replayOscOpen: after.replayOscOpen, nextCopies });
        // back to the shell: its cached terminal attaches again
        const reattaches = await count("attach", panes.shell);
        await page.locator(`.workspace-select[data-pane="${panes.shell}"]`).click();
        await page.waitForFunction(([id, seen]) => window.replayFixture.sent.filter((frame) => frame.type === "attach" && frame.pane_id === id).length > seen, [panes.shell, reattaches] as const);
        console.log("PASS pending write at a pane switch");
      }

      // dispose: four other tabs push the pane out of the cached ones while its write is pending
      {
        await page.locator(`.pane-frame.is-current[data-layout-pane="${panes.shell}"] .pane-terminal`).waitFor({ state: "attached" });
        await resetCase(page);
        const host = await page.locator(".pane-frame.is-current .pane-terminal").evaluateHandle((element) => element);
        const before = await acked();
        const held = await hold(PENDING[0]!.steps);
        for (const pane of [panes.web, panes.flaky, panes.omp, panes.cli]) {
          await page.locator(`.workspace-select[data-pane="${pane}"]`).click();
          await page.locator(`.pane-frame.is-current[data-layout-pane="${pane}"]`).waitFor({ state: "attached" });
        }
        await page.waitForFunction((element) => !element.isConnected, host);
        const disposed = await host.evaluate((element) => (element as unknown as { outputProbe(): Probe }).outputProbe());
        assert.deepEqual({ queued: disposed.queued, inFlight: disposed.inFlight, replayOscOpen: disposed.replayOscOpen, parsingReplay: disposed.parsingReplay }, { queued: 0, inFlight: 1, replayOscOpen: false, parsingReplay: false }, "dispose drops the queued frames and both flags");
        await fixture(page, (state) => state.release());
        const after = await host.evaluate((element) => (element as unknown as { outputProbe(): Probe }).outputProbe());
        const copies = await fixture(page, (state) => [...state.copies]);
        const acks = await acked();
        assert.deepEqual(copies, [], "dispose: nothing from before copies");
        assert.deepEqual(acks, before, "dispose: no old frame is acknowledged after the dispose");
        assert.equal(after.writes, held.writes, "dispose: only the pending frame reached xterm");
        report["reconnect-replay"]!.push({ name: "pending write at dispose", pending: { inFlight: held.inFlight, queued: held.queued }, afterDispose: { queued: disposed.queued, inFlight: disposed.inFlight, replayOscOpen: disposed.replayOscOpen, parsingReplay: disposed.parsingReplay }, copies, acksAfterDispose: acks.length - before.length, writesAfterRelease: after.writes - held.writes, inFlightAfterRelease: after.inFlight });
        console.log("PASS pending write at dispose");
      }
      assert.deepEqual(pageErrors(page), []);
      await fixture(page, (state) => state.restore());
    } finally { await context.close(); }
  }

  // screenshots: restored screen, live copy, refused write, permission off, observe-only, reconnecting
  if (evidence) {
    const combos = [
      { size: 390, phone: true, theme: "light", language: "en" }, { size: 390, phone: true, theme: "dark", language: "en" },
      { size: 1440, phone: false, theme: "light", language: "en" }, { size: 1440, phone: false, theme: "dark", language: "en" },
      { size: 390, phone: true, theme: "light", language: "ko" },
    ] as const;
    for (const combo of combos) {
      const name = (state: string) => `replay-clipboard-${combo.size}-${combo.theme}${combo.language === "ko" ? "-ko" : ""}-${state}`;
      const context = await newContext(browser, url, { phone: combo.phone, theme: combo.theme, language: combo.language });
      try {
        const page = await openPage(context, url);
        await frames(page, [R(RESTORED)]);
        assert.deepEqual(await fixture(page, (state) => [...state.copies]), []);
        await shot(page, name("replay-restored"));
        await frames(page, [L(LIVE_COPY)]);
        await page.locator(".terminal-banner", { hasText: "copied to clipboard" }).waitFor();
        await shot(page, name("live-copy"));
        if (combo.language === "en") {
          await fixture(page, (state) => { state.deny = true; });
          await frames(page, [L(`${ESC}]52;c;${LIVE}${BEL}`)]);
          await page.locator(".terminal-banner", { hasText: "clipboard write blocked by the browser" }).waitFor();
          await shot(page, name("denied"));
          await page.evaluate(() => localStorage.setItem("ovis:settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("ovis:settings")!), paneClipboard: false })));
          await page.reload();
          await page.waitForFunction(() => window.replayFixture?.sent.some((frame) => frame.type === "attach"));
          await page.waitForFunction(() => typeof (document.querySelector(".pane-frame.is-current .pane-terminal") as unknown as { outputProbe?: unknown } | null)?.outputProbe === "function");
          await frames(page, [R(RESTORED), L(LIVE_COPY)]);
          assert.deepEqual(await fixture(page, (state) => [...state.copies]), []);
          assert.equal(await page.locator(".terminal-banner", { hasText: "clipboard" }).count(), 0, "permission off says nothing");
          await shot(page, name("permission-off"));
          await fixture(page, (state) => state.sockets.at(-1)!.send(JSON.stringify({ type: "role", mode: "observe" })));
          await page.locator(".pane-frame.is-current .terminal-banner").filter({ has: page.locator("svg.lucide-eye") }).waitFor();
          await frames(page, [R(RESTORED)]);
          await shot(page, name("observe-only"));
          // the reconnect overlay, held while the fixture keeps the next socket from opening
          await fixture(page, (state) => { state.holdConnect = true; state.sockets.at(-1)!.close(); });
          await page.getByText("Reconnecting to Ovis…").waitFor();
          await shot(page, name("reconnecting"));
        }
        assert.deepEqual(pageErrors(page), []);
        await fixture(page, (state) => state.restore());
      } finally { await context.close(); }
    }
  }
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 1));
  console.log("PASS replay clipboard: corpus, permission, denial, reconnect, second tab, pane switch, observer");
} finally {
  await browser?.close();
  await server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
