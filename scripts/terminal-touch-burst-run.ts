/**
 * Attached-terminal touch scrolling, against panes owned by this script (a real herdr attach, the
 * real client and xterm). For identical slow, fast and flick swipes of one and two screens and a
 * reversal within one gesture it records the signed steps the swipe derives (wheelSteps plus
 * finalStep), the reports the application receives, herdr's native history offset, the client's
 * parsed and painted output, long tasks, animation-frame gaps and per-frame dispatch counts.
 *
 * The adoption predicates are strict, each held by any single measured pass:
 * (a) a fast or flick swipe's application steps < 0.90 * the slow swipe's for identical travel;
 * (b) a report of an earlier input generation is sent after a new touch, a key, a disconnect, a
 *     pane switch, the observe role or a lease release, each boundary established from its own
 *     event or acknowledgement;
 * (c) a fast two-screen swipe has a long task > 200 ms or a frame gap > 300 ms that the slow
 *     control of the same pass does not.
 *
 * The repair contract asserted here: every derived step arrives, in order, at most six reports
 * per animation frame, at most 64 waiting, a two-screen swipe drained within 300 ms of touchend,
 * only travel beyond 64 waiting reports dropped (the terminal's `data-touch-wheel-dropped` counts
 * them), nothing sent after any boundary, no observer input and no takeover.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadavg, tmpdir } from "node:os";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { herdrRpc, paneRead, paneScrollInfo, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";
import { shownRow, shownRows } from "./shown-rows.ts";
import { finalStep, HERDR_MOUSE_SCROLL_LINES, wheelSteps } from "../src/lib/wheelSteps.ts";
import { TOUCH_WHEEL_QUEUE_LIMIT, TOUCH_WHEEL_REPORTS_PER_FRAME } from "../src/lib/touchWheelPacer.ts";

const REPS = Number(process.env["TOUCH_BURST_REPS"] ?? 2);
const DRAIN_LIMIT_MS = 300;
const state = mkdtempSync(join(tmpdir(), "herdr-touch-burst-"));
const evidence = process.env["UI_EVIDENCE_DIR"] || join(state, "evidence");
const frames = join(evidence, "measure-frames");
mkdirSync(frames, { recursive: true });
const workspaces: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const waitOutput = (pane: string, value: string) => herdrRpc("pane.wait_for_output", {
  pane_id: pane, source: "recent", match: { type: "substring", value }, timeout_ms: 90000,
}, undefined, 92000).catch(async (error) => {
  const seen = await paneRead({ paneId: pane, source: "visible" }).then((read) => read.text, (failure) => String(failure));
  throw new Error(`${value} did not appear: ${error}\n${seen.slice(-1500)}`);
});

interface ProbeEvent { k: string; t: number; y?: number; wheels?: number; pane?: string; frame?: string; ft?: number }
interface Probe {
  events: ProbeEvent[];
  longtasks: Array<{ start: number; duration: number }>;
  frames: number[];
  lastPtyData: number;
  ptyFrames: number;
  lastPaint: number;
  hidden: boolean;
  /** the timestamp of the animation frame whose callback is running, shared by every callback of that frame */
  frameTime: number | null;
}
interface FrameHold { hold: boolean; step(): Promise<number>; release(): void }
declare global { interface Window { __burst: Probe; __frames: FrameHold; __socket?: WebSocket } }

/** Signed steps the client derives from the touchmove positions it saw, in order, plus finalStep; and the queue after each move. */
function derive(ys: number[], stepPixels: number): { steps: number[]; cumulative: number[] } {
  const steps: number[] = [];
  const cumulative: number[] = [];
  let pixels = 0;
  for (let i = 1; i < ys.length; i++) {
    const { steps: whole, rest } = wheelSteps(pixels + (ys[i - 1]! - ys[i]!), stepPixels);
    pixels = rest;
    for (let n = 0; n < Math.abs(whole); n++) steps.push(Math.sign(whole));
    cumulative.push(steps.length);
  }
  const last = finalStep(pixels, stepPixels);
  if (last !== 0) steps.push(last);
  cumulative.push(steps.length);
  return { steps, cumulative };
}

/** SGR wheel reports in a byte log, as signed steps: 64 (up, older) is -1, 65 is +1. */
function reported(log: string): number[] {
  return [...log.matchAll(/\x1b\[<(64|65);\d+;\d+M/g)].map((match) => (match[1] === "64" ? -1 : 1));
}

const nextFrame = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

interface Gesture { name: string; screens: number; speed: "slow" | "fast" | "flick"; reverse: boolean }
const gestures: Gesture[] = [];
for (const screens of [1, 2]) for (const speed of ["slow", "fast", "flick"] as const) gestures.push({ name: `${speed}-${screens}screen`, screens, speed, reverse: false });
for (const speed of ["slow", "fast"] as const) gestures.push({ name: `${speed}-reversal`, screens: 1, speed, reverse: true });

/** Finger positions for a gesture: down by `travel` (older history), and back up by half for a reversal. */
function path(gesture: Gesture, top: number, travel: number, cell: number): number[] {
  const legs = gesture.reverse ? [travel, -travel / 2] : [travel];
  const ys = [top];
  for (const leg of legs) {
    const from = ys.at(-1)!;
    const moves = gesture.speed === "flick" ? 1 : gesture.speed === "fast" ? 6 : Math.max(1, Math.ceil(Math.abs(leg) / (cell / 2)));
    for (let m = 1; m <= moves; m++) ys.push(from + (leg * m) / moves);
  }
  return ys;
}

/** The probe every page carries: input, wire frames, paints, long tasks, frames, and a frame clock the script can hold. */
async function instrument(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", defaultView: "terminal", terminalInputMode: "direct", alertsOn: false }));
    const probe: Probe = { events: [], longtasks: [], frames: [], lastPtyData: 0, ptyFrames: 0, lastPaint: 0, hidden: false, frameTime: null };
    window.__burst = probe;
    const now = () => performance.now();
    try {
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) probe.longtasks.push({ start: entry.startTime, duration: entry.duration }); }).observe({ type: "longtask", buffered: true });
    } catch { /* no long-task support: recorded as none */ }
    // The page's frame clock, held on request: while held, a callback waits until the script steps
    // or releases the clock. The probe's own frame log runs on the real clock.
    const realRequest = window.requestAnimationFrame.bind(window);
    const realCancel = window.cancelAnimationFrame.bind(window);
    // every page callback runs with its frame's timestamp on the probe: a report is counted in the
    // frame that sent it
    const tagged = (callback: FrameRequestCallback): FrameRequestCallback => (time) => {
      probe.frameTime = time;
      try { callback(time); } finally { probe.frameTime = null; }
    };
    let held: Array<{ id: number; callback: FrameRequestCallback }> = [];
    let heldId = 0;
    const hold: FrameHold = {
      hold: false,
      step: () => new Promise((resolve) => realRequest((time) => {
        const due = held;
        held = [];
        for (const { callback } of due) { probe.frameTime = time; try { callback(time); } finally { probe.frameTime = null; } }
        resolve(due.length);
      })),
      release() {
        hold.hold = false;
        const due = held;
        held = [];
        for (const { callback } of due) realRequest(tagged(callback));
      },
    };
    window.__frames = hold;
    window.requestAnimationFrame = (callback) => {
      if (!hold.hold) return realRequest(tagged(callback));
      heldId -= 1;
      held.push({ id: heldId, callback });
      return heldId;
    };
    window.cancelAnimationFrame = (id) => {
      if (id < 0) held = held.filter((entry) => entry.id !== id);
      else realCancel(id);
    };
    const frame = (t: number) => { probe.frames.push(t); if (probe.frames.length > 20000) probe.frames.splice(0, 10000); realRequest(frame); };
    realRequest(frame);
    // a document put away on request: the terminal's own visibility handling lets go of its pane
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (probe.hidden ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => probe.hidden });
    window.addEventListener("touchstart", () => { probe.events.push({ k: "touchstart", t: now() }); }, { capture: true });
    window.addEventListener("touchmove", (event) => { probe.events.push({ k: "touchmove", t: now(), y: event.touches[0]?.clientY }); }, { capture: true });
    window.addEventListener("touchend", () => { probe.events.push({ k: "touchend", t: now() }); }, { capture: true });
    window.addEventListener("keydown", (event) => { probe.events.push({ k: "keydown", t: now(), frame: event.key }); }, { capture: true });
    document.addEventListener("wheel", (event) => { if (!event.isTrusted) probe.events.push({ k: "wheel", t: now(), ft: probe.frameTime ?? undefined }); }, { capture: true });
    new MutationObserver((records) => {
      // the rows the user sees: libghostty's while it draws the pane (xterm's are hidden and not redrawn), else xterm's
      const painted = ".xterm-rows, .ghostty-text";
      if (records.some((record) => (record.target as Element).closest?.(painted) || record.target.parentElement?.closest(painted))) probe.lastPaint = now();
    }).observe(document, { subtree: true, childList: true, characterData: true });
    const watched = new WeakSet<WebSocket>();
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data) {
      window.__socket = this;
      if (!watched.has(this)) {
        watched.add(this);
        this.addEventListener("close", () => probe.events.push({ k: "close", t: now() }));
        this.addEventListener("message", (event) => {
          try {
            const message = JSON.parse(String(event.data)) as { type?: string; mode?: string; ready?: boolean; pane_id?: string };
            if (message.type === "role-ack") probe.events.push({ k: `role-${message.mode}`, t: now() });
            if (message.type === "input-ready" && message.ready !== false) probe.events.push({ k: "input-ready", t: now(), pane: message.pane_id });
            if (message.type === "pty-data") { probe.lastPtyData = now(); probe.ptyFrames += 1; }
          } catch { /* not a bridge frame */ }
        });
      }
      if (typeof data === "string") {
        try {
          const message = JSON.parse(data) as { type?: string; text?: string; pane_id?: string };
          if (message.type === "input") probe.events.push({ k: "send", t: now(), pane: message.pane_id, wheels: (message.text?.match(/\u001b\[<6[45];/g) ?? []).length });
          else if (message.type === "keys" || message.type === "attach" || message.type === "detach" || message.type === "role") probe.events.push({ k: message.type, t: now(), pane: message.pane_id, frame: data });
        } catch { /* not a bridge frame */ }
      }
      return send.call(this, data);
    };
  });
}

const wheelsSent = (events: ProbeEvent[]) => events.filter((event) => event.k === "send").reduce((sum, event) => sum + (event.wheels ?? 0), 0);

/**
 * Runs one part of this check. Each part is a browser script of its own, so that the browser lane's
 * workers share the check instead of one of them running all of it: the swipes in the application
 * (terminal-touch-burst-regression.ts); and the swipes over native history, then the overflow, the
 * boundaries and the observer (terminal-touch-burst-history-regression.ts). Those three follow the
 * history swipes because a boundary reads the shell pane where the last of them left it. Each part
 * makes both panes for itself, in workspaces named after it: the two run in the test session at once.
 */
export async function runTouchBurst(part: "application" | "history"): Promise<void> { try {
  // Given: an application that logs every input byte and answers each k, and a shell whose history herdr scrolls.
  const program = join(state, "wheel-app.mjs");
  const log = join(state, "input.bin");
  writeFileSync(program, `
import { appendFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(log)}, "");
process.stdin.setRawMode(true);
let marks = 0;
process.stdin.on("data", data => {
  appendFileSync(${JSON.stringify(log)}, data);
  for (const byte of data) if (byte === 0x6b) { marks += 1; process.stdout.write("MARK_" + marks + "_DONE\\r\\n"); }
});
process.stdout.write(Array.from({ length: 400 }, (_, n) => "app history " + n + "\\r\\n").join("") + "\\x1b[?1000h\\x1b[?1002h\\x1b[?1006hAPP_READY\\r\\n");
`);
  const appMade = await workspaceCreate({ cwd: state, label: `herdr-web-ui-test-touch-burst-${part}-app` });
  workspaces.push(appMade.workspace.workspace_id);
  const appPane = appMade.root_pane.pane_id;
  const appReady = waitOutput(appPane, "APP_READY");
  await herdrRpc("pane.send_input", { pane_id: appPane, text: `exec ${quote(process.execPath)} ${quote(program)}`, keys: ["enter"] });
  await appReady;
  const shellMade = await workspaceCreate({ cwd: state, label: `herdr-web-ui-test-touch-burst-${part}-shell` });
  workspaces.push(shellMade.workspace.workspace_id);
  const shellPane = shellMade.root_pane.pane_id;
  const shellReady = waitOutput(shellPane, "shell_ready");
  await herdrRpc("pane.send_input", { pane_id: shellPane, text: "for n in $(seq 1 3000); do printf 'history %04d\\n' $n; done; printf 'shell_%s\\n' ready; exec cat", keys: ["enter"] });
  await shellReady;

  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(state, "server"), tailscaleOwner: null, usage: new UsageService(undefined, []) });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "en-US" };
  const context = await browser.newContext(phone);
  await instrument(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  const takeovers: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (/takeover/i.test(request.url()) || /takeover/i.test(request.postData() ?? "")) takeovers.push(request.url()); });
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => { if (/takeover/i.test(String(payload))) takeovers.push(String(payload)); }));
  const cdp: CDPSession = await context.newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });

  /** Open a pane and wait for the server to say it takes input. */
  const open = async (pane: string) => {
    const metrics = page.waitForResponse((response) => response.url().includes("/api/pane/scroll?") && response.request().method() === "GET");
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await metrics;
    await page.locator(".conn-live").waitFor();
    await page.waitForFunction((id) => window.__burst.events.some((event) => event.k === "input-ready" && event.pane === id), pane);
  };
  let marks = 0;
  /** Type k in the application and wait until the application answered it and the client parsed and painted the answer. */
  const mark = async () => {
    marks += 1;
    const text = `MARK_${marks}_DONE`;
    const answered = waitOutput(appPane, text);
    await page.locator(".xterm-helper-textarea").first().focus();
    await page.keyboard.press("k");
    await answered;
    await page.waitForFunction(([value, shown]) => document.querySelector(shown)?.textContent?.includes(value), [text, shownRows()] as const);
    return page.evaluate(() => performance.now());
  };

  // --- Measured swipes ---------------------------------------------------------------------------
  const results: Record<string, unknown>[] = [];
  // the kind of pane this part swipes in: the predicates below compare a kind's swipes with its own, never the two kinds
  const kinds: readonly ("application" | "native-history")[] = part === "application" ? ["application"] : ["native-history"];
  for (const target of [{ pane: appPane, kind: "application" as const }, { pane: shellPane, kind: "native-history" as const }]) {
    if (!kinds.includes(target.kind)) continue;
    await open(target.pane);
    const screen = page.locator(".xterm-screen").first();
    if (target.kind === "native-history") {
      // away from both native edges, so clamping cannot look like a lost step
      const moved = await page.request.post(`${origin}/api/pane/scroll`, { data: { pane_id: target.pane, offset_from_bottom: 1500 } });
      assert.equal(moved.status(), 200);
    }
    // REPS measured passes, then one recorded pass whose screencast frames are kept but never measured:
    // the screencast itself costs frames
    for (let rep = 0; rep <= REPS; rep++) for (const gesture of gestures) {
      const recorded = rep === REPS;
      const box = (await screen.boundingBox())!;
      const rows = await page.locator(shownRow()).count();
      const cell = box.height / rows;
      const stepPixels = cell * HERDR_MOUSE_SCROLL_LINES;
      // a screen of travel, plus a quarter step so finalStep's half-step rounding never sits on an edge
      const travel = box.height * gesture.screens + stepPixels / 4;
      const x = box.x + box.width / 2;
      const top = box.y + 4;
      const ys = path(gesture, top, travel, cell);
      const logBefore = target.kind === "application" ? readFileSync(log, "latin1").length : 0;
      const offsetBefore = target.kind === "native-history" ? (await paneScrollInfo(target.pane))!.offset_from_bottom : 0;
      // the frame before the gesture is kept: the first gap is measured from it
      await page.evaluate(() => { const probe = window.__burst; probe.events.length = 0; probe.longtasks.length = 0; probe.frames.splice(0, probe.frames.length - 1); probe.ptyFrames = 0; });
      if (recorded) await page.screenshot({ path: join(frames, `${target.kind}-${gesture.name}-0-before.png`) });
      const shots: Array<{ data: string }> = [];
      const onFrame = (frame: { data: string; sessionId: number }) => {
        shots.push({ data: frame.data });
        void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      };
      const record = recorded && gesture.screens === 2;
      if (record) { cdp.on("Page.screencastFrame", onFrame); await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1 }); }
      await touch("touchStart", x, ys[0]!);
      for (const y of ys.slice(1)) {
        await touch("touchMove", x, y);
        if (gesture.speed === "slow") await nextFrame(page);
      }
      await touch("touchEnd");
      let received: number[] | null = null;
      let offsetAfter: number | null = null;
      let parsedAt: number;
      if (target.kind === "application") {
        // the key goes out on the same socket after every report the swipe made: the application's
        // answer, parsed and painted by the client, closes the gesture
        const expectedCount = derive([ys[0]!, ...(await page.evaluate(() => window.__burst.events.filter((event) => event.k === "touchmove").map((event) => event.y!)))], stepPixels).steps.length;
        await page.waitForFunction((want) => window.__burst.events.filter((event) => event.k === "wheel").length >= want, expectedCount);
        parsedAt = await mark();
        const bytes = readFileSync(log, "latin1").slice(logBefore);
        received = reported(bytes.slice(0, bytes.lastIndexOf("k")));
      } else {
        const want = offsetBefore - derive([ys[0]!, ...(await page.evaluate(() => window.__burst.events.filter((event) => event.k === "touchmove").map((event) => event.y!)))], stepPixels).steps.reduce((sum, step) => sum + step, 0) * HERDR_MOUSE_SCROLL_LINES;
        const deadline = Date.now() + 10000;
        for (;;) {
          offsetAfter = (await paneScrollInfo(target.pane))!.offset_from_bottom;
          if (offsetAfter === want || Date.now() > deadline) break;
          await nextFrame(page);
        }
        // herdr redraws the moved history down the attach: the client has parsed and painted it
        await page.waitForFunction(() => window.__burst.ptyFrames > 0 && window.__burst.lastPaint >= window.__burst.lastPtyData);
        parsedAt = await page.evaluate(() => window.__burst.lastPaint);
      }
      if (record) { await cdp.send("Page.stopScreencast"); cdp.off("Page.screencastFrame", onFrame); }
      shots.forEach((shot, n) => writeFileSync(join(frames, `${target.kind}-${gesture.name}-frame-${String(n).padStart(3, "0")}.jpg`), Buffer.from(shot.data, "base64")));
      if (recorded) await page.screenshot({ path: join(frames, `${target.kind}-${gesture.name}-1-after.png`) });
      const probe = await page.evaluate(() => ({ events: window.__burst.events, longtasks: window.__burst.longtasks, frames: window.__burst.frames, ptyFrames: window.__burst.ptyFrames }));
      // the gesture's events end at the key that closes it
      const keyAt = probe.events.findIndex((event) => event.k === "keydown");
      const gestureEvents = keyAt < 0 ? probe.events : probe.events.slice(0, keyAt);
      const seenYs = gestureEvents.filter((event) => event.k === "touchmove").map((event) => event.y!);
      const { steps: expected, cumulative } = derive([ys[0]!, ...seenYs], stepPixels);
      const expectedSum = expected.reduce((sum, step) => sum + step, 0);
      const touchstart = gestureEvents.find((event) => event.k === "touchstart")!.t;
      const touchend = gestureEvents.find((event) => event.k === "touchend")!.t;
      const wheels = gestureEvents.filter((event) => event.k === "wheel");
      const lastWheel = wheels.at(-1)?.t ?? touchend;
      const gaps = probe.frames.slice(1).map((t, i) => t - probe.frames[i]!).filter((_, i) => probe.frames[i + 1]! >= touchstart && probe.frames[i]! <= lastWheel + 50);
      // reports dispatched per animation frame: wheel events grouped by the frame callback that sent
      // them (its frame timestamp), never by wall-clock time, which a late frame under load blurs
      const perFrame = new Map<number, number>();
      for (const event of wheels) {
        const frame = event.ft ?? -1;
        perFrame.set(frame, (perFrame.get(frame) ?? 0) + 1);
      }
      // the queue right after each touch handler pushed its steps: derived so far less reports already dispatched
      const touches = gestureEvents.filter((event) => event.k === "touchmove" || event.k === "touchend");
      const peakQueue = Math.max(0, ...touches.map((event, i) => cumulative[i]! - wheels.filter((wheel) => wheel.t < event.t).length));
      const during = (task: { start: number; duration: number }) => task.start + task.duration >= touchstart && task.start <= lastWheel + 50;
      const result = {
        rep, recorded, loadAverage: loadavg()[0],
        kind: target.kind, gesture: gesture.name, screens: gesture.screens, speed: gesture.speed, reverse: gesture.reverse,
        rows, cellHeight: cell, stepPixels, travelPx: travel, touchmoves: seenYs.length,
        expectedSteps: expected.length, expectedSigned: expectedSum, expectedSequence: expected.join(","),
        wheelEventsDispatched: wheels.length,
        wheelReportsSent: wheelsSent(gestureEvents),
        applicationReceivedSteps: received?.length ?? null, applicationReceivedSequence: received?.join(",") ?? null,
        offsetBefore: target.kind === "native-history" ? offsetBefore : null, offsetAfter,
        nativeLinesMoved: offsetAfter === null ? null : offsetAfter - offsetBefore,
        expectedNativeLines: target.kind === "native-history" ? -expectedSum * HERDR_MOUSE_SCROLL_LINES : null,
        perFrameDispatches: [...perFrame.values()], maxDispatchesPerFrame: Math.max(0, ...perFrame.values()),
        // a report sent outside any frame callback (from the touch handler itself) escapes the per-frame count
        wheelsOutsideFrames: wheels.filter((event) => event.ft === undefined).length,
        peakQueue, droppedReports: expected.length - wheels.length,
        drainAfterTouchendMs: Math.max(0, lastWheel - touchend),
        ptyFramesParsed: probe.ptyFrames, parsedAfterTouchendMs: parsedAt - touchend,
        longtasks: probe.longtasks.filter(during),
        maxLongtaskMs: Math.max(0, ...probe.longtasks.filter(during).map((task) => task.duration)),
        frameGaps: gaps, maxFrameGapMs: Math.max(0, ...gaps), screencastFrames: shots.length,
        trace: gestureEvents.filter((event) => event.k !== "send" || (event.wheels ?? 0) > 0).map((event) => ({ k: event.k, t: Math.round((event.t - touchstart) * 10) / 10, y: event.y, wheels: event.wheels })),
      };
      console.log(JSON.stringify({ ...result, trace: undefined, frameGaps: undefined }));
      results.push(result);
      if (target.kind === "native-history") {
        const back = await page.request.post(`${origin}/api/pane/scroll`, { data: { pane_id: target.pane, offset_from_bottom: 1500 } });
        assert.equal(back.status(), 200);
      }
    }
  }

  // --- Overflow: more than 64 reports waiting -----------------------------------------------------
  // The frame clock is held, so nothing drains while the finger travels: the queue fills to its
  // limit and only what lies beyond it is dropped, and counted.
  if (part === "history") await open(appPane);
  const overflow = part !== "history" ? null : await (async () => {
    const box = (await page.locator(".xterm-screen").first().boundingBox())!;
    const rows = await page.locator(shownRow()).count();
    const stepPixels = (box.height / rows) * HERDR_MOUSE_SCROLL_LINES;
    const x = box.x + box.width / 2;
    const top = box.y + 4;
    const want = TOUCH_WHEEL_QUEUE_LIMIT + 30;
    const ys = Array.from({ length: 11 }, (_, n) => top + ((want + 0.25) * stepPixels * n) / 10);
    const logBefore = readFileSync(log, "latin1").length;
    const droppedCounter = () => page.evaluate(() => document.querySelector("[data-touch-wheel-dropped]")?.getAttribute("data-touch-wheel-dropped") ?? null);
    const droppedBefore = Number(await droppedCounter() ?? 0);
    await page.evaluate(() => { window.__burst.events.length = 0; window.__frames.hold = true; });
    await touch("touchStart", x, ys[0]!);
    for (const y of ys.slice(1)) await touch("touchMove", x, y);
    await touch("touchEnd");
    const seenYs = await page.evaluate(() => window.__burst.events.filter((event) => event.k === "touchmove").map((event) => event.y!));
    await page.evaluate(() => window.__frames.release());
    await page.waitForFunction((limit) => window.__burst.events.filter((event) => event.k === "wheel").length >= limit, TOUCH_WHEEL_QUEUE_LIMIT);
    await mark();
    const derived = derive([ys[0]!, ...seenYs], stepPixels).steps.length;
    const bytes = readFileSync(log, "latin1").slice(logBefore);
    const received = reported(bytes.slice(0, bytes.lastIndexOf("k"))).length;
    const counter = await droppedCounter();
    const record = { derived, received, expectedDropped: derived - TOUCH_WHEEL_QUEUE_LIMIT, droppedDiagnostic: counter === null ? null : Number(counter) - droppedBefore };
    console.log(JSON.stringify({ overflow: record }));
    return record;
  })();

  // --- Boundaries -------------------------------------------------------------------------------
  // The frame clock is held after the first frame of reports: the rest of the swipe waits. Each
  // boundary is then established from its own event or acknowledgement, the clock released and
  // the finger lifted; nothing of the swipe may be sent after it, to either pane.
  const boundaries: Record<string, unknown>[] = [];
  const switchTo = async (pane: string) => {
    await page.evaluate((id) => {
      // Back to an entry that names only the pane, as a link to it does
      const search = new URLSearchParams({ pane: id });
      window.history.pushState(null, "", `${window.location.pathname}?${search}`);
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    }, pane);
  };
  const lastEvent = (kind: string, pane?: string) => page.evaluate(({ kind, pane }) => window.__burst.events.filter((event) => event.k === kind && (pane === undefined || event.pane === pane)).at(-1) ?? null, { kind, pane });
  // polled on a timer, not on frames: the frame clock may be held
  const waitEvent = async (kind: string, after: number, pane?: string, wheels?: number) => {
    const want = { kind, after, pane: pane ?? null, wheels: wheels ?? null };
    await page.waitForFunction((want) => window.__burst.events.some((event) => event.k === want.kind && event.t > want.after
      && (want.pane === null || event.pane === want.pane) && (want.wheels === null || event.wheels === want.wheels)), want, { polling: 50 });
    return page.evaluate((want) => window.__burst.events.filter((event) => event.k === want.kind && event.t > want.after
      && (want.pane === null || event.pane === want.pane) && (want.wheels === null || event.wheels === want.wheels)).at(-1)!, want);
  };
  if (part === "history") for (const boundary of ["new-touch", "second-finger-outside", "key", "disconnect", "pane-switch", "observe-role", "lease-release"] as const) {
    await open(appPane);
    await page.locator(".xterm-helper-textarea").first().focus();
    const box = (await page.locator(".xterm-screen").first().boundingBox())!;
    const rows = await page.locator(shownRow()).count();
    const stepPixels = (box.height / rows) * HERDR_MOUSE_SCROLL_LINES;
    const x = box.x + box.width / 2;
    const top = box.y + 4;
    const shellBefore = (await paneScrollInfo(shellPane))!.offset_from_bottom;
    const logBefore = readFileSync(log, "latin1").length;
    const start = await page.evaluate(() => { window.__burst.events.length = 0; window.__frames.hold = true; return performance.now(); });
    // ten whole steps and three quarters of one more: what finalStep would send at the lift
    await touch("touchStart", x, top);
    await touch("touchMove", x, top + stepPixels * 10.75);
    // one frame of the drain, then the clock stays held
    await page.evaluate(() => window.__frames.step());
    const firstFrame = await page.evaluate(() => window.__burst.events.filter((event) => event.k === "wheel").length);
    let established: ProbeEvent;
    if (boundary === "new-touch") {
      await touch("touchEnd");
      await touch("touchStart", x, top);
      established = (await lastEvent("touchstart"))!;
      await touch("touchEnd");
    } else if (boundary === "second-finger-outside") {
      // the swiping finger stays down; a second one lands on the tab bar above the terminal, where the
      // terminal's own touch listener never sees it
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: top + stepPixels * 10.75, id: 0 }, { x, y: box.y - 40, id: 1 }] });
      established = (await lastEvent("touchstart"))!;
      await touch("touchEnd");
    } else if (boundary === "key") {
      await page.keyboard.press("k");
      marks += 1;
      // the key's own input frame, not a wheel report
      established = await waitEvent("send", start, appPane, 0);
    } else if (boundary === "disconnect") {
      await page.evaluate(() => window.__socket!.close(1000, "touch burst boundary"));
      established = await waitEvent("close", start);
    } else if (boundary === "pane-switch") {
      await switchTo(shellPane);
      established = await waitEvent("attach", start, shellPane);
    } else if (boundary === "observe-role") {
      await page.evaluate(() => window.__socket!.send(JSON.stringify({ type: "role", mode: "observe" })));
      established = await waitEvent("role-observe", start);
    } else {
      await page.evaluate(() => { window.__burst.hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
      established = await waitEvent("detach", start, appPane);
    }
    await page.evaluate(() => window.__frames.release());
    // the drain would have gone on in these frames
    for (let n = 0; n < 4; n++) await nextFrame(page);
    // back to where the swipe began, the finger still down: the reconnect, the pane, the role and the attach return
    if (boundary === "disconnect") await waitEvent("input-ready", established.t, appPane);
    else if (boundary === "pane-switch") {
      for (let n = 0; n < 4; n++) await nextFrame(page);
      const after = await page.evaluate(() => performance.now());
      await switchTo(appPane);
      await waitEvent("attach", after, appPane);
      await waitEvent("input-ready", after, appPane);
    } else if (boundary === "observe-role") {
      const after = await page.evaluate(() => performance.now());
      await page.evaluate(() => window.__socket!.send(JSON.stringify({ type: "role", mode: "interact" })));
      await waitEvent("role-interact", after);
    } else if (boundary === "lease-release") {
      const after = await page.evaluate(() => performance.now());
      await page.evaluate(() => { window.__burst.hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
      await waitEvent("attach", after, appPane);
      await waitEvent("input-ready", after, appPane);
    }
    await page.locator(".conn-live").waitFor();
    // and only now the finger lifts: what was left of the old swipe must not go with it
    if (boundary !== "new-touch" && boundary !== "second-finger-outside") await touch("touchEnd");
    for (let n = 0; n < 4; n++) await nextFrame(page);
    await mark();
    const events = await page.evaluate(() => window.__burst.events);
    const bytes = readFileSync(log, "latin1").slice(logBefore);
    const beforeBoundary = events.filter((event) => event.k === "send" && event.t <= established.t);
    const stale = events.filter((event) => event.k === "send" && (event.wheels ?? 0) > 0 && event.t > established.t);
    const record = {
      boundary, established: { k: established.k, pane: established.pane, t: Math.round(established.t - start) },
      reportsInFirstFrame: firstFrame, reportsSentBeforeBoundary: wheelsSent(beforeBoundary),
      staleReportsSent: wheelsSent(stale), staleToPane: [...new Set(stale.map((event) => event.pane))],
      applicationReceivedSteps: reported(bytes).length, applicationBytes: JSON.stringify(bytes),
      shellOffsetMoved: (await paneScrollInfo(shellPane))!.offset_from_bottom - shellBefore,
    };
    console.log(JSON.stringify(record));
    boundaries.push(record);
  }

  // --- A concurrent observer ----------------------------------------------------------------------
  // A second phone watches the same pane while this one is attached: its swipe pans its own copy
  // of the grid and sends the pane nothing.
  let concurrent: { observerInputFrames: number; applicationReceivedSteps: number } | null = null;
  if (part === "history") {
    const observerContext = await browser.newContext(phone);
    await instrument(observerContext);
    const observer = await observerContext.newPage();
    observer.setDefaultTimeout(15000);
    observer.on("pageerror", (error) => errors.push(`observer: ${error.message}`));
    const observerCdp = await observerContext.newCDPSession(observer);
    concurrent = await (async () => {
      await open(appPane);
      const logBefore = readFileSync(log, "latin1").length;
      await observer.goto(`${origin}/?pane=${encodeURIComponent(appPane)}`);
      await observer.locator(".conn-live").waitFor();
      await observer.waitForFunction(() => window.__socket !== undefined);
      await observer.evaluate(() => window.__socket!.send(JSON.stringify({ type: "role", mode: "observe" })));
      await observer.waitForFunction(() => window.__burst.events.some((event) => event.k === "role-observe"));
      const box = (await observer.locator(".xterm-screen").first().boundingBox())!;
      const x = box.x + box.width / 2;
      await observer.evaluate(() => { window.__burst.events.length = 0; });
      await observerCdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: box.y + 4 }] });
      for (let n = 1; n <= 6; n++) await observerCdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: box.y + 4 + (box.height * n) / 6 }] });
      await observerCdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      for (let n = 0; n < 4; n++) await observer.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      await mark();
      const sent = await observer.evaluate(() => window.__burst.events.filter((event) => event.k === "send" || event.k === "keys").length);
      const bytes = readFileSync(log, "latin1").slice(logBefore);
      const record = { observerInputFrames: sent, applicationReceivedSteps: reported(bytes).length };
      console.log(JSON.stringify({ concurrentObserver: record }));
      return record;
    })();
    await observerContext.close();
  }

  // --- Predicates and contract ---------------------------------------------------------------------
  const measured = results.filter((result) => !result.recorded);
  const find = (kind: string, name: string, rep: number) => measured.find((result) => result.kind === kind && result.gesture === name && result.rep === rep)!;
  const steps = (result: Record<string, unknown>) => (result.kind === "application" ? result.applicationReceivedSteps as number : Math.abs(result.nativeLinesMoved as number) / HERDR_MOUSE_SCROLL_LINES);
  const reps = Array.from({ length: REPS }, (_, rep) => rep);
  // strict, per pass: one measured pass that meets a predicate meets it
  const predicateA = kinds.flatMap((kind) => [1, 2].flatMap((screens) => (["fast", "flick"] as const).map((speed) => {
    const passes = reps.map((rep) => {
      const slow = steps(find(kind, `slow-${screens}screen`, rep));
      const fast = steps(find(kind, `${speed}-${screens}screen`, rep));
      return { rep, slowSteps: slow, fastSteps: fast, satisfied: slow > 0 && fast < 0.9 * slow };
    });
    return { kind, screens, speed, passes, satisfied: passes.some((pass) => pass.satisfied) };
  })));
  const predicateB = { boundaries, satisfied: boundaries.some((record) => (record.staleReportsSent as number) > 0) };
  const breach = (result: Record<string, unknown>) => (result.maxLongtaskMs as number) > 200 || (result.maxFrameGapMs as number) > 300;
  const predicateC = kinds.flatMap((kind) => (["fast", "flick"] as const).map((speed) => {
    const passes = reps.map((rep) => {
      const fast = find(kind, `${speed}-2screen`, rep);
      const slow = find(kind, "slow-2screen", rep);
      return { rep, fastLongtaskMs: fast.maxLongtaskMs, fastFrameGapMs: fast.maxFrameGapMs, slowLongtaskMs: slow.maxLongtaskMs, slowFrameGapMs: slow.maxFrameGapMs, loadAverage: fast.loadAverage, satisfied: breach(fast) && !breach(slow) };
    });
    return { kind, speed, passes, satisfied: passes.some((pass) => pass.satisfied) };
  }));
  const summary = {
    reps: REPS, predicateA, predicateB, predicateC,
    predicatesMet: { a: predicateA.some((p) => p.satisfied), b: predicateB.satisfied, c: predicateC.some((p) => p.satisfied) },
    maxDispatchesPerFrame: Math.max(...results.map((result) => result.maxDispatchesPerFrame as number)),
    peakQueue: Math.max(...results.map((result) => result.peakQueue as number)),
    maxTwoScreenDrainMs: Math.max(...results.filter((result) => result.screens === 2).map((result) => result.drainAfterTouchendMs as number)),
    ordinaryDroppedReports: results.reduce((sum, result) => sum + (result.droppedReports as number), 0),
    overflow, concurrentObserver: concurrent, takeovers, errors,
  };
  console.log(JSON.stringify({ ...summary, predicateA: undefined, predicateC: undefined }, null, 2));
  // the serial lane hands every script the same evidence folder: each part's measurement has a name of its own there
  writeFileSync(join(evidence, `touch-burst-measurement-${part}.json`), JSON.stringify({ results, summary }, null, 2));

  assert.deepEqual(errors, []);
  for (const result of results) {
    if (result.kind === "application") assert.equal(result.applicationReceivedSequence, result.expectedSequence, `${result.kind} ${result.gesture} rep ${result.rep}: the application receives every derived step in order`);
    else assert.equal(result.nativeLinesMoved, result.expectedNativeLines, `${result.kind} ${result.gesture} rep ${result.rep}: native history moves by every derived step`);
    assert.equal(result.droppedReports, 0, `${result.gesture}: an ordinary swipe drops nothing`);
    assert.equal(result.wheelsOutsideFrames, 0, `${result.kind} ${result.gesture} rep ${result.rep}: every report goes out from an animation frame`);
    assert.ok((result.maxDispatchesPerFrame as number) <= TOUCH_WHEEL_REPORTS_PER_FRAME, `${result.kind} ${result.gesture} rep ${result.rep}: at most ${TOUCH_WHEEL_REPORTS_PER_FRAME} reports per frame, saw ${result.maxDispatchesPerFrame}`);
    assert.ok((result.peakQueue as number) <= TOUCH_WHEEL_QUEUE_LIMIT, `${result.gesture}: at most ${TOUCH_WHEEL_QUEUE_LIMIT} reports waiting, saw ${result.peakQueue}`);
    // the recorded pass runs under the screencast, which costs frames: its drain time is not measured
    if (result.screens === 2 && !result.recorded) assert.ok((result.drainAfterTouchendMs as number) <= DRAIN_LIMIT_MS, `${result.kind} ${result.gesture} rep ${result.rep}: drained ${result.drainAfterTouchendMs} ms after touchend`);
  }
  for (const result of measured.filter((result) => result.speed === "fast" && result.screens === 2)) {
    assert.ok(!breach(result), `${result.kind} fast two-screen rep ${result.rep}: long task ${result.maxLongtaskMs} ms, frame gap ${result.maxFrameGapMs} ms`);
  }
  if (overflow !== null) {
    assert.equal(overflow.received, TOUCH_WHEEL_QUEUE_LIMIT, "travel beyond the queue arrives up to its limit");
    assert.equal(overflow.droppedDiagnostic, overflow.expectedDropped, "the terminal counts exactly the reports beyond the queue");
  }
  for (const record of boundaries) {
    assert.equal(record.staleReportsSent, 0, `${record.boundary}: nothing of the swipe is sent after the boundary (${JSON.stringify(record)})`);
    assert.equal(record.applicationReceivedSteps, record.reportsSentBeforeBoundary, `${record.boundary}: the application receives only what went out before the boundary`);
    assert.equal(record.shellOffsetMoved, 0, `${record.boundary}: the other pane receives nothing`);
  }
  if (concurrent !== null) {
    assert.equal(concurrent.observerInputFrames, 0, "an observer sends no input");
    assert.equal(concurrent.applicationReceivedSteps, 0, "an observer's swipe reaches nothing");
  }
  assert.deepEqual(takeovers, [], "nothing takes the pane over");
  assert.ok(!summary.predicatesMet.a && !summary.predicatesMet.b && !summary.predicatesMet.c, "no predicate holds with the repair");
  await context.close();
  // no boundary ran in the application's part: its line says what it swiped
  if (part === "application") { console.log("PASS attached touch scrolling in an application: every step arrives, paced and bounded"); return; }
  console.log("PASS attached touch scrolling: every step arrives, paced and bounded, and every boundary cancels the rest");
} finally {
  await browser?.close();
  server?.stop();
  for (const workspace of workspaces) await workspaceClose(workspace).catch(() => {});
  rmSync(state, { recursive: true, force: true });
} }
