/**
 * The key bar's keyboard control (#1046) on the real client over the demo's fixture transport, as a
 * phone: Show focuses the field of the current input mode inside the tap, Hide blurs this pane's
 * field, the label and pressed state say what the tap asked for (lib/keyboardControl.ts holds the
 * tap's word until the measurement confirms it or the settle window runs out), and none of it sends
 * changes the input mode, fits or resizes the shared grid. A composition in either field refuses
 * the tap and keeps its word; a sibling pane's field is never touched; an observer has no control,
 * and a held, ended or offline pane a disabled one. Chromium's synthetic viewport geometry stands
 * in for a keyboard here and proves nothing about a native one: that is checked by hand on an iOS
 * Simulator against `--serve-ios`, which only serves the built demo on loopback until SIGINT.
 *
 * UI_EVIDENCE_DIR: the capture set (terminal-keyboard-<390|1440>-<light|dark>[-ko]-<state>.png
 * with manifest.json) and the two scenario reports as JSON, written after the assertions.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { appFaces } from "./app-faces.ts";

const SETTINGS_KEY = "ovis:settings";
const PREFIX = "/herdr-web-ui/demo/app/";
/**
 * Fake time run past the last change: PaneTerminal fits a changed host RESIZE_SETTLE_MS (120 ms) after
 * its ResizeObserver saw it, so a fit, resize or deferred focus the toggle caused has run by then
 */
const FLUSH_MS = 1_000;
/** the frames a keyboard toggle must never send */
const FORBIDDEN = new Set(["input", "keys", "resize", "take-over", "submit", "secret"]);
const PHONE = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };
const KEYBOARD_PORTRAIT = 500;
const KEYBOARD_LANDSCAPE = 200;

interface Frame { type: string; pane_id?: string }
interface Recorded {
  sentFrames: Frame[];
  recordedSockets: Array<WebSocket & { push(frame: Record<string, unknown>): void }>;
  viewportQA: { resize(height: number): void };
}
type QaWindow = Window & Recorded;
type Settings = Record<string, unknown>;

interface ControlState {
  present: boolean;
  label: string | null;
  title: string | null;
  tabIndex: number | null;
  pressed: string | null;
  disabled: boolean | null;
  refused: boolean;
  keyboard: boolean;
  active: string | null;
  direct: boolean;
  grid: { rows: number; width: number; height: number };
  settings: string | null;
  frames: string[];
}

const evidence = process.env["UI_EVIDENCE_DIR"];
const serveIos = process.argv.includes("--serve-ios");

const app = mkdtempSync(join(tmpdir(), "herdr-terminal-keyboard-demo-"));
let origin = "";

/** The demo's socket is a class of its own that no browser event reports: note every frame it sends, and keep the socket to play the server's side. */
const RECORDER = `<script>(() => {
  const Demo = window.WebSocket;
  window.sentFrames = [];
  window.recordedSockets = [];
  const Recorded = function (url, protocols) {
    const socket = new Demo(url, protocols);
    window.recordedSockets.push(socket);
    const send = socket.send.bind(socket);
    socket.send = (raw) => {
      if (typeof raw === "string") { try { window.sentFrames.push(JSON.parse(raw)); } catch {} }
      send(raw);
    };
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(Recorded, name, { value: Demo[name] });
  window.WebSocket = Recorded;
})();</script>`;

function serve(): ReturnType<typeof Bun.serve> {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(PREFIX)) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(PREFIX.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
}

const settled = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/** A phone, with a keyboard the script raises and lowers: lib/viewport.ts measures the visual viewport. */
async function phone(browser: Browser, settings: Settings, viewport = PHONE): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "en-US" });
  await context.addInitScript(({ key, settings, pane, height }) => {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(settings));
    localStorage.setItem(`ovis:view:${pane}`, "terminal");
    const visual = window.visualViewport!;
    let current = height;
    Object.defineProperty(visual, "height", { get: () => current });
    (window as unknown as { viewportQA: Recorded["viewportQA"] }).viewportQA = {
      resize: (value) => { current = value; visual.dispatchEvent(new Event("resize")); },
    };
  }, { key: SETTINGS_KEY, settings, pane: panes.shell, height: viewport.height });
  return context;
}

/** `clock`: the scenario pages take Playwright's clock (it runs on its own until `flushTimers` pauses it) */
async function open(context: BrowserContext, clock = false): Promise<{ page: Page; errors: string[] }> {
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (clock) await page.clock.install();
  await page.goto(`${origin}?pane=${encodeURIComponent(panes.shell)}&view=terminal`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(".pane-frame:not(.is-hidden) .xterm-rows").waitFor();
  await appFaces(page);
  return { page, errors };
}

/**
 * Runs every timer the last change scheduled, without waiting for it: a fresh ResizeObserver's first
 * callback comes at the next rendering step, after the app's own observers of that step have
 * scheduled their fit; then the clock runs FLUSH_MS ahead at once, firing that fit and anything a
 * tap left for later. What the frames show afterwards is all the change will ever send.
 */
async function flushTimers(page: Page): Promise<void> {
  await nextRender(page);
  await page.clock.runFor(FLUSH_MS);
}

/** The next rendering step has run (real frames, not the clock's), with every ResizeObserver of it. */
const nextRender = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => {
  const observer = new ResizeObserver(() => { observer.disconnect(); resolve(); });
  observer.observe(document.documentElement);
}));

const keyOf = (page: Page): Locator => page.locator('.pane-frame:not(.is-hidden) .key-bar [data-key="keyboard"]');
const lineOf = (page: Page): Locator => page.locator(".pane-frame:not(.is-hidden) .terminal-input-text");

/**
 * Taps the control and reads its own label, pressed state and the field in the same evaluate, as
 * the direct-commit check does with key.click(): the tap's word must be read inside its settle
 * window, which the page's real clock could otherwise outlast in a slow run and flip the assertion
 * into the settled state. React commits the store's change after the click returns (its microtask,
 * then its scheduler's MessageChannel task), so the label is read once both have run.
 */
const tapAndState = (page: Page): Promise<{ label: string | null; pressed: string | null; active: string | null; keyboard: boolean }> =>
  page.evaluate(async () => {
    const key = document.querySelector<HTMLButtonElement>('.pane-frame:not(.is-hidden) .key-bar [data-key="keyboard"]')!;
    key.click();
    const active = document.activeElement;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => { const channel = new MessageChannel(); channel.port1.onmessage = () => resolve(); channel.port2.postMessage(null); });
    return {
      label: key.getAttribute("aria-label"),
      pressed: key.getAttribute("aria-pressed"),
      active: active instanceof HTMLElement && active !== document.body ? active.className : null,
      keyboard: document.documentElement.hasAttribute("data-keyboard"),
    };
  });

const ready = (page: Page): Promise<unknown> =>
  page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.pane-frame:not(.is-hidden) .key-bar [data-key="keyboard"]')?.disabled === false);

const control = (page: Page): Promise<ControlState> => page.evaluate(() => {
  const frame = document.querySelector(".pane-frame:not(.is-hidden)");
  const key = frame?.querySelector<HTMLButtonElement>('.key-bar [data-key="keyboard"]') ?? null;
  const active = document.activeElement;
  const screen = frame?.querySelector(".xterm-screen")?.getBoundingClientRect();
  return {
    present: key !== null,
    label: key?.getAttribute("aria-label") ?? null,
    title: key?.getAttribute("title") ?? null,
    tabIndex: key?.tabIndex ?? null,
    pressed: key?.getAttribute("aria-pressed") ?? null,
    disabled: key?.disabled ?? null,
    refused: key?.getAttribute("aria-disabled") === "true",
    keyboard: document.documentElement.hasAttribute("data-keyboard"),
    active: active instanceof HTMLElement && active !== document.body ? active.className : null,
    direct: document.querySelector("[data-direct-typing]") !== null,
    grid: { rows: frame?.querySelectorAll(".xterm-rows > div").length ?? 0, width: Math.round(screen?.width ?? 0), height: Math.round(screen?.height ?? 0) },
    settings: localStorage.getItem("ovis:settings"),
    frames: (window as unknown as QaWindow).sentFrames.map((frame) => frame.type),
  };
});

const lineState = (page: Page): Promise<[string, number | null, number | null]> =>
  lineOf(page).evaluate((node: HTMLTextAreaElement) => [node.value, node.selectionStart, node.selectionEnd]);

/** Blurs the focused field and waits for lib/viewport.ts's deferred focusout sync. */
const blur = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) { resolve(); return; }
  document.addEventListener("focusout", () => window.setTimeout(resolve, 0), { once: true });
  active.blur();
}));

const geometry = (page: Page, height: number): Promise<void> => page.evaluate((value) => (window as unknown as QaWindow).viewportQA.resize(value), height);
const raise = async (page: Page, height = KEYBOARD_PORTRAIT): Promise<void> => { await geometry(page, height); await page.locator("html[data-keyboard]").waitFor(); await settled(page); };
const lower = async (page: Page, height = PHONE.height): Promise<void> => { await geometry(page, height); await page.locator("html[data-keyboard]").waitFor({ state: "detached" }); await settled(page); };

/** A tap at the key's centre, as a finger lands on a key Playwright would wait on (disabled or refusing). */
async function tapAnyway(key: Locator): Promise<void> {
  const box = (await key.boundingBox())!;
  await key.page().touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * From the input line, Tab as a hardware keyboard does until the control has the focus, with its
 * focus-visible ring; returns the stops passed. A bounded walk: it throws if the control is not
 * reached, or the focus leaves the pane's bottom for the rest of the page first.
 */
async function tabTo(page: Page): Promise<string[]> {
  await lineOf(page).focus();
  const stops: string[] = [];
  for (let step = 0; step < 4; step++) {
    const stop = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return { name: active?.getAttribute("aria-label") ?? active?.className ?? "none", control: active?.matches('.pane-frame:not(.is-hidden) .key-bar [data-key="keyboard"]:focus-visible') === true };
    });
    stops.push(stop.name);
    if (stop.control) return stops;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab from the input line did not reach the keyboard control: ${stops.join(" -> ")}`);
}

const composition = (page: Page, field: Locator, type: "compositionstart" | "compositionend", data = ""): Promise<void> =>
  field.evaluate((node, { type, data }) => { node.dispatchEvent(new CompositionEvent(type, { bubbles: true, cancelable: true, data })); }, { type, data });

const socket = (page: Page, frame: Record<string, unknown>): Promise<void> =>
  page.evaluate((frame) => { (window as unknown as QaWindow).recordedSockets.at(-1)!.push(frame); }, frame);

const role = (page: Page, mode: "observe" | "interact"): Promise<void> =>
  page.evaluate((mode) => { (window as unknown as QaWindow).recordedSockets.at(-1)!.send(JSON.stringify({ type: "role", mode })); }, mode);

/**
 * The mode switch beside the control. The input line's slot keeps a row of the grid: leaving or
 * entering line mode changes the host, and the fit that follows resizes the pty. That resize is
 * the switch's own, so a cycle's baseline is taken after it is on the wire. With the keyboard
 * measured up the grid under it is held (#1045): no fit, and no resize, follows the switch then.
 */
async function switchMode(page: Page, to: "line" | "direct"): Promise<void> {
  const before = await control(page);
  await page.locator('.pane-frame:not(.is-hidden) .key-bar [data-key="direct"]').tap();
  if (to === "direct") await page.locator("[data-direct-typing]").waitFor();
  else await page.locator("[data-direct-typing]").waitFor({ state: "detached" });
  if (before.keyboard) {
    await ready(page);
    // whatever the switch scheduled (a fit RESIZE_SETTLE_MS later) has run before the grid is read
    await flushTimers(page);
    const after = await control(page);
    assert.deepEqual(after.grid, before.grid, `the switch under a keyboard keeps the grid (#1045)`);
    assert.deepEqual(after.frames.slice(before.frames.length).filter((type) => type === "resize"), [], "and sends no resize");
    return;
  }
  await page.waitForFunction((rows) => document.querySelectorAll(".pane-frame:not(.is-hidden) .xterm-rows > div").length !== rows, before.grid.rows);
  await page.waitForFunction((count) => (window as unknown as QaWindow).sentFrames.filter((frame) => frame.type === "resize").length > count, before.frames.filter((type) => type === "resize").length);
  await ready(page);
}

// ---- scenario: the keyboard of the current input mode -------------------------------------------

async function currentModeKeyboard(browser: Browser): Promise<Record<string, unknown>> {
  const context = await phone(browser, { language: "en", theme: "dark", terminalInputMode: "line", defaultView: "terminal" });
  try {
    const { page, errors } = await open(context, true);
    await ready(page);
    const key = keyOf(page);
    const cycles: Record<string, unknown>[] = [];
    for (const mode of ["line", "direct"] as const) {
      if (mode === "direct") {
        // the switch beside it is the other control: it changes the typing, and with the keyboard
        // down focuses nothing; the cycle starts as a reader has it, keyboard down and nothing focused
        await switchMode(page, "direct");
        await blur(page);
      }
      const field = mode === "line" ? "terminal-input-text" : "xterm-helper-textarea";
      const before = await control(page);
      assert.deepEqual([before.keyboard, before.pressed, before.label, before.active], [false, "false", "Show keyboard", null], `${mode}: at rest, keyboard down (${JSON.stringify(before)})`);
      assert.deepEqual([before.title, before.tabIndex], ["Show keyboard", 0], `${mode}: the icon-only control has its name as a tooltip and is a Tab stop`);
      assert.equal(before.direct, mode === "direct");
      const shown = await tapAndState(page);
      assert.equal(shown.active, field, `${mode}: Show focuses the mode's own field inside the tap`);
      assert.deepEqual([shown.pressed, shown.label], ["true", "Hide keyboard"], `${mode}: the tap's word is the truth at once: the control puts the keyboard away on the next tap`);
      let draft: [string, number | null, number | null] | null = null;
      if (mode === "line") {
        await page.keyboard.type("echo 한글 draft");
        await lineOf(page).evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(5, 7));
        draft = await lineState(page);
        assert.deepEqual(draft, ["echo 한글 draft", 5, 7]);
      }
      await raise(page);
      const up = await control(page);
      assert.deepEqual([up.pressed, up.label, up.active], ["true", "Hide keyboard", field], `${mode}: measured up, the control says so and the field keeps the focus`);
      assert.equal(up.title, "Hide keyboard", `${mode}: the tooltip follows the measured state`);
      assert.deepEqual(up.grid, before.grid, `${mode}: the grid under the keyboard stays (#1045)`);
      if (mode === "line") assert.deepEqual(await lineState(page), draft, `${mode}: the draft and its caret stay`);
      const hidden = await tapAndState(page);
      assert.notEqual(hidden.active, field, `${mode}: Hide blurs the field`);
      assert.deepEqual([hidden.pressed, hidden.label], ["false", "Show keyboard"], `${mode}: the blur left no field focused anywhere, so the keyboard is going, and the label says so at once`);
      if (mode === "line") assert.deepEqual(await lineState(page), draft, `${mode}: a blurred line keeps its draft and caret`);
      await lower(page);
      const down = await control(page);
      assert.deepEqual([down.pressed, down.label, down.keyboard], ["false", "Show keyboard", false], `${mode}: measured down again`);
      // no fit, resize, key or input follows the toggle or the keyboard-only height change
      await flushTimers(page);
      const after = await control(page);
      assert.deepEqual(after.frames.slice(before.frames.length).filter((type) => FORBIDDEN.has(type)), [], `${mode}: the toggle sends nothing (${after.frames.slice(before.frames.length).join(", ") || "no frame"})`);
      assert.deepEqual(after.grid, before.grid, `${mode}: the grid is the same after the keyboard went`);
      assert.equal(after.settings, before.settings, `${mode}: no setting changed`);
      assert.equal(after.direct, mode === "direct", `${mode}: the input mode is the same`);
      if (mode === "line") assert.deepEqual(await lineState(page), draft);
      cycles.push({ mode, field, draft, before, shown, up, hidden, down, after, framesDuring: after.frames.slice(before.frames.length) });
      console.log(`PASS keyboard control, ${mode} mode: Show focuses ${field} in the tap, measured up/down state, Hide blurs it, grid ${before.grid.rows} rows kept, no input/keys/resize/take-over frame, mode and settings unchanged`);
    }
    // a hardware keyboard reaches the control by Tab from the input line (past its Enter button) and
    // presses it with Enter, the native button's own activation: Show focuses the line again
    await switchMode(page, "line");
    await blur(page);
    const routeBefore = await control(page);
    const route = await tabTo(page);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.classList.contains("terminal-input-text") === true);
    await flushTimers(page);
    const routeAfter = await control(page);
    assert.deepEqual([routeAfter.active, routeAfter.direct, routeAfter.settings], ["terminal-input-text", false, routeBefore.settings], "Enter on the control focused from the keyboard shows the line's keyboard, mode and settings unchanged");
    assert.deepEqual(routeAfter.frames.slice(routeBefore.frames.length).filter((type) => FORBIDDEN.has(type)), [], `the keyboard route sends nothing (${routeAfter.frames.slice(routeBefore.frames.length).join(", ") || "no frame"})`);
    console.log(`PASS keyboard route: Tab reaches the control (${route.join(" -> ")}) with a focus-visible ring, and Enter on it focuses the input line, sending nothing`);

    // Android's back gesture puts the keyboard away and leaves the field focused (as the route left
    // it): the field keeps its focus through the down, and Show re-raises the keyboard by blur and
    // refocus inside the tap, the new input session a phone raises for
    const gesture = await control(page);
    assert.deepEqual([gesture.active, gesture.keyboard], ["terminal-input-text", false], "the gesture model: the field keeps its focus with the keyboard measured down");
    // the already focused branch must do more than nothing: the line loses and takes the focus again
    // inside the tap — the blur-and-refocus that is a phone's new input session
    await page.evaluate(() => {
      const line = document.querySelector<HTMLTextAreaElement>(".pane-frame:not(.is-hidden) .terminal-input-text")!;
      const counts = { focusin: 0, focusout: 0 };
      line.addEventListener("focusin", () => counts.focusin++);
      line.addEventListener("focusout", () => counts.focusout++);
      (window as unknown as { lineMoves: typeof counts }).lineMoves = counts;
    });
    const tapWord = await tapAndState(page);
    await raise(page);
    const reRaised = await control(page);
    const moves = await page.evaluate(() => (window as unknown as { lineMoves: { focusin: number; focusout: number } }).lineMoves);
    assert.deepEqual([tapWord.pressed, tapWord.label], ["true", "Hide keyboard"], "the tap's word is the truth at once, before the geometry answers");
    assert.deepEqual([reRaised.active, reRaised.keyboard], ["terminal-input-text", true], "Show on the already focused field re-raises the keyboard inside the tap");
    assert.deepEqual(moves, { focusin: 1, focusout: 1 }, `the re-raise is the blur-and-refocus branch, not a no-op tap (${JSON.stringify(moves)})`);
    await lineOf(page).evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(node.value.length, node.value.length));
    await page.keyboard.type(" now");
    const reTyped = await lineState(page);
    assert.deepEqual(reTyped, ["echo 한글 draft now", "echo 한글 draft now".length, "echo 한글 draft now".length], "typing lands in the re-raised session's line, the caret at its typed end");
    console.log("PASS back gesture: Show on a focused field with the keyboard down raises it again, and the line takes keyboard types");

    // the mode switch with the keyboard up: the grid takes it in place, then direct to line hands
    // it back to the line, focus and all — any drop and raise of the keyboard across the switches
    // (the one-frame loss a real phone would show) is counted
    await switchMode(page, "direct");
    const directUp = await control(page);
    assert.deepEqual([directUp.active, directUp.keyboard], ["xterm-helper-textarea", true], "line to direct: the grid takes the keyboard in place, which stays up");
    await page.evaluate(() => {
      const drops = { removed: 0 };
      const observer = new MutationObserver(() => { if (!document.documentElement.hasAttribute("data-keyboard")) drops.removed++; });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-keyboard"] });
      (window as unknown as { keyDrops: typeof drops }).keyDrops = drops;
    });
    await switchMode(page, "line");
    const handed = await control(page);
    assert.deepEqual([handed.active, handed.keyboard], ["terminal-input-text", true], "direct to line with the keyboard up: the handoff gives the keyboard to the line, focus and all");
    await flushTimers(page);
    const drops = await page.evaluate(() => (window as unknown as { keyDrops: { removed: number } }).keyDrops);
    assert.deepEqual((await control(page)).keyboard, true, "the keyboard is up after the switch and everything it scheduled");
    assert.deepEqual(drops.removed, 0, `the keyboard was never dropped across the handoff (${drops.removed})`);
    console.log("PASS mode handoff: direct to line gives the grid's keyboard to the line, focus and all, with no removal of the measured state across the switch");
    await key.tap();
    await lower(page);
    await blur(page);
    await flushTimers(page);

    // the mode switch with the keyboard down, a field still focused (the back gesture's state): no
    // field is focused for the new mode either way, where a focus would raise the keyboard the user
    // put away
    await lineOf(page).focus();
    const lineDown = await control(page);
    assert.deepEqual([lineDown.active, lineDown.keyboard, lineDown.label], ["terminal-input-text", false, "Show keyboard"], "the line focused with the keyboard measured down");
    await switchMode(page, "direct");
    await flushTimers(page);
    const directDown = await control(page);
    assert.deepEqual([directDown.direct, directDown.active, directDown.keyboard], [true, null, false], `line to direct with the keyboard down: the grid is not focused, so the keyboard stays down (${JSON.stringify(directDown.active)})`);
    await page.locator(".pane-frame:not(.is-hidden) .xterm-helper-textarea").focus();
    const gridDown = await control(page);
    assert.deepEqual([gridDown.active, gridDown.keyboard, gridDown.label], ["xterm-helper-textarea", false, "Show keyboard"], "the grid focused with the keyboard measured down");
    await switchMode(page, "line");
    await flushTimers(page);
    const lineAgain = await control(page);
    assert.deepEqual([lineAgain.direct, lineAgain.active, lineAgain.keyboard], [false, null, false], `direct to line with the keyboard down: the line is not focused, so the keyboard stays down (${JSON.stringify(lineAgain.active)})`);
    console.log("PASS mode switch, keyboard down: neither direction focuses the new mode's field, though the old one kept the focus");
    assert.deepEqual(errors, []);
    return { scenario: "current-mode-keyboard", cycles, keyboardRoute: { route, before: routeBefore, after: routeAfter } };
  } finally { await context.close(); }
}

// ---- scenario: composing, or no field to show the keyboard for --------------------------------------

async function composingOrUnavailableTarget(browser: Browser): Promise<Record<string, unknown>> {
  const context = await phone(browser, { language: "en", theme: "dark", terminalInputMode: "line", defaultView: "terminal" });
  const checks: Record<string, unknown> = {};
  try {
    let { page, errors } = await open(context, true);
    await ready(page);
    let key = keyOf(page);

    // a hardware keyboard, or an occlusion the browser cannot report: the tap's word is claimed at
    // once, and leaves again at the settle window the measurement never answered
    const claimed = await tapAndState(page);
    assert.deepEqual([claimed.active, claimed.pressed, claimed.label], ["terminal-input-text", "true", "Hide keyboard"], "the tap's word: the control claims the keyboard while the measurement has not answered");
    await page.keyboard.type("git status");
    await lineOf(page).evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(4, 4));
    await page.waitForFunction(() => document.querySelector('.pane-frame:not(.is-hidden) .key-bar [data-key="keyboard"]')?.getAttribute("aria-label") === "Show keyboard", undefined, { timeout: 3_000 });
    await settled(page);
    const hardware = await control(page);
    assert.deepEqual([hardware.active, hardware.pressed, hardware.label, hardware.keyboard], ["terminal-input-text", "false", "Show keyboard", false], "no occlusion measured: after the settle window the control answers to what it knows, the field still focused");
    checks["hardwareKeyboard"] = hardware;
    console.log("PASS no-occlusion geometry: a focused field with no keyboard measured stays Show keyboard, not pressed");

    // a composition in the line refuses the tap, keeping the focus and the word; its end runs nothing later
    await raise(page);
    const line = lineOf(page);
    await composition(page, line, "compositionstart");
    await page.waitForFunction(() => document.querySelector('.pane-frame:not(.is-hidden) .key-bar [data-key="keyboard"]')?.getAttribute("aria-disabled") === "true");
    const composing = await control(page);
    assert.equal(composing.disabled, false, "a refusing control is live, not disabled: a press on it must not move the focus");
    await tapAnyway(key);
    await settled(page);
    const refused = await control(page);
    assert.deepEqual([refused.active, refused.keyboard, refused.refused], ["terminal-input-text", true, true], "a tap during a composition is refused: the field keeps the focus and the composition");
    assert.deepEqual(await lineState(page), ["git status", 4, 4], "the word being composed and its caret stay");
    await composition(page, line, "compositionend", "git status");
    await page.waitForFunction(() => document.querySelector('.pane-frame:not(.is-hidden) .key-bar [data-key="keyboard"]')?.getAttribute("aria-disabled") !== "true");
    // no deferred blur or focus follows the composition's end (nothing was scheduled by the refused tap)
    await flushTimers(page);
    const afterComposition = await control(page);
    assert.deepEqual([afterComposition.active, afterComposition.keyboard, afterComposition.refused], ["terminal-input-text", true, false], "the composition's end runs nothing the refused tap left behind");
    assert.deepEqual(await lineState(page), ["git status", 4, 4]);
    assert.deepEqual(afterComposition.frames.slice(hardware.frames.length).filter((type) => FORBIDDEN.has(type)), [], "no frame left for the composition");
    checks["lineComposition"] = { composing, refused, afterComposition };
    console.log("PASS line composition: the tap is refused with the focus and the text kept, and nothing runs when the word commits");
    await key.tap();
    await lower(page);

    // direct typing: a commit still on its way (the tick after compositionend) refuses the tap too.
    // The keyboard is measured up first, so the tap would be a Hide that blurs the grid: only the
    // refusal keeps the focus, and with it the commit xterm is about to read. The switch, the
    // keyboard down, focuses nothing: Show focuses the grid
    await switchMode(page, "direct");
    await flushTimers(page);
    await key.tap();
    await raise(page);
    const direct = await control(page);
    assert.deepEqual([direct.active, direct.keyboard, direct.pressed], ["xterm-helper-textarea", true, "true"], "direct typing, grid focused, keyboard measured up: the control is Hide");
    const pending = await page.evaluate(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(".pane-frame:not(.is-hidden) .xterm-helper-textarea")!;
      const key = document.querySelector<HTMLButtonElement>('.pane-frame:not(.is-hidden) .key-bar [data-key="keyboard"]')!;
      (window as unknown as { gridBlurs: number }).gridBlurs = 0;
      textarea.addEventListener("focusout", () => { (window as unknown as { gridBlurs: number }).gridBlurs++; });
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
      key.click();
      return { active: document.activeElement?.className ?? null, keyboard: document.documentElement.hasAttribute("data-keyboard") };
    });
    assert.deepEqual([pending.active, pending.keyboard], ["xterm-helper-textarea", true], "a Hide tap while a direct commit is pending is refused: the grid keeps the focus");
    // nothing the refused tap could have left for later: no deferred blur, no frame
    await flushTimers(page);
    const afterPending = await control(page);
    const gridBlurs = await page.evaluate(() => (window as unknown as { gridBlurs: number }).gridBlurs);
    assert.deepEqual([afterPending.active, afterPending.keyboard, afterPending.refused, gridBlurs], ["xterm-helper-textarea", true, false, 0], "the pending commit cleared on its own tick, the grid never lost the focus, and nothing was deferred");
    assert.deepEqual(afterPending.frames.slice(direct.frames.length).filter((type) => FORBIDDEN.has(type)), [], "no frame for the empty composition");
    checks["directCommitPending"] = { direct, pending, afterPending, gridBlurs };
    console.log("PASS direct typing: a Hide tap during a pending commit is refused, the grid keeps the focus and nothing is deferred");
    await key.tap();
    await lower(page);
    await switchMode(page, "line");
    // the line mounted again with its draft; its caret is set where the sibling check expects it
    await key.tap();
    await lineOf(page).evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(4, 4));
    await blur(page);

    // a split tab on a phone: the control of the shown pane focuses its own field, never the sibling's
    const made = await page.evaluate(async (paneId) => {
      const response = await fetch("/api/pane/split", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: paneId, direction: "right", focus: true }) });
      return { status: response.status, body: await response.json().catch(() => ({})) as { pane?: { pane_id?: string } } };
    }, panes.shell);
    assert.equal(made.status, 200, `/api/pane/split answered ${made.status}`);
    await page.locator(".pane-frame.is-hidden").waitFor({ state: "attached" });
    await page.locator(".pane-frame:not(.is-hidden) .xterm-rows").waitFor();
    await ready(page);
    const shownFrame = (await page.locator(".pane-frame:not(.is-hidden)").getAttribute("data-layout-pane"))!;
    const hiddenFrame = (await page.locator(".pane-frame.is-hidden").getAttribute("data-layout-pane"))!;
    assert.notEqual(shownFrame, hiddenFrame);
    const focusedPane = () => page.evaluate(() => {
      const active = document.activeElement;
      const frame = active instanceof Element ? active.closest(".pane-frame") : null;
      const field = active instanceof HTMLTextAreaElement ? active : null;
      const hidden = document.querySelector<HTMLTextAreaElement>(".pane-frame.is-hidden .terminal-input-text");
      return { active: active instanceof HTMLElement ? active.className : null, frame: frame?.getAttribute("data-layout-pane") ?? null, draft: field ? [field.value, field.selectionStart, field.selectionEnd] : null, hiddenFocused: hidden !== null && hidden === active };
    });
    const shellDraft = (frame: string) => frame === panes.shell ? ["git status", 4, 4] : ["", 0, 0];
    await flushTimers(page);
    // this pane's Show stays in flight through the switch below: the clock holds still before the
    // tap, inside its settle window, the keyboard still measured down. A droplet the demo's turn
    // raised would stay over the tab strip with the clock held: it is not drawn (as in openForCapture)
    await page.addStyleTag({ content: ".droplet { visibility: hidden !important; }" });
    await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 200);
    const inFlight = await tapAndState(page);
    assert.deepEqual([inFlight.pressed, inFlight.label, inFlight.keyboard], ["true", "Hide keyboard", false], "the tapped pane's Show is in flight, the keyboard still measured down");
    const sibling = await focusedPane();
    assert.deepEqual(sibling, { active: "terminal-input-text", frame: shownFrame, draft: shellDraft(shownFrame), hiddenFocused: false }, `Show focuses the shown pane's own line, with its own draft, never the sibling's (${JSON.stringify(sibling)})`);
    // the other pane shown instead: its control focuses its line, with the draft and caret that line has
    await page.locator(".tab-strip-menu:visible").tap();
    const sheet = page.getByRole("dialog");
    await sheet.waitFor();
    await sheet.locator('.row-sheet-item:not([aria-current="true"])').first().tap();
    await page.locator(`.pane-frame:not(.is-hidden)[data-layout-pane="${hiddenFrame}"]`).waitFor();
    await ready(page);
    const other = await control(page);
    assert.deepEqual([other.label, other.pressed, other.keyboard], ["Show keyboard", "false", false], `the pane now shown reads the keyboard: the other pane's Show, in flight when it was left, is not its word (${JSON.stringify([other.label, other.pressed])})`);
    await keyOf(page).tap();
    const switched = await focusedPane();
    assert.deepEqual(switched, { active: "terminal-input-text", frame: hiddenFrame, draft: shellDraft(hiddenFrame), hiddenFocused: false }, `after the switch, the control focuses the pane now shown, whose draft and caret are its own (${JSON.stringify(switched)})`);
    await page.clock.resume();
    checks["siblingPane"] = { shownFrame, hiddenFrame, sibling, switched };
    console.log("PASS split tab: the control focuses only the shown pane's field, before and after a pane switch");
    assert.deepEqual(errors, []);
    await page.close();

    // no field the control may show the keyboard for: an observer has no control, a held, offline or ended pane a disabled one
    ({ page, errors } = await open(context, true));
    await ready(page);
    key = keyOf(page);
    await role(page, "observe");
    await page.locator(".terminal-banner-observe").waitFor();
    assert.equal(await key.count(), 0, "an observer's bar is gone with its input: no keyboard control");
    const observe = await control(page);
    await role(page, "interact");
    await ready(page);
    console.log("PASS observe: no control; interact again: the control is back and enabled");

    const states: Record<string, unknown> = { observe };
    /** `lasting`: the state stays until the script ends it (held, ended); offline would end by itself, so its clock is held still */
    const disabledTap = async (name: string, lasting: boolean): Promise<void> => {
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.pane-frame:not(.is-hidden) .key-bar [data-key="keyboard"]')?.disabled === true);
      // the state's own banner changes the host, and its fit is that state's resize, not the tap's
      if (lasting) await flushTimers(page);
      const before = await control(page);
      await tapAnyway(key);
      // the refused tap sends no fit, resize, key or input afterwards (offline: the clock is paused,
      // so its pending reconnect cannot end the state under test, and the next render is the barrier)
      if (lasting) await flushTimers(page);
      else await nextRender(page);
      const after = await control(page);
      assert.deepEqual([after.disabled, after.active, after.keyboard], [true, null, false], `${name}: a disabled control focuses nothing (${JSON.stringify(after)})`);
      assert.deepEqual(after.frames.slice(before.frames.length).filter((type) => FORBIDDEN.has(type)), [], `${name}: and sends nothing`);
      states[name] = after;
    };
    await socket(page, { type: "error", code: "attach_held", pane_id: panes.shell, message: "Another web bridge has this pane" });
    await disabledTap("held", true);
    // the attach took: the server says so, then that input is ready again (server/core/terminal-process.ts)
    await socket(page, { type: "attach-resumed", pane_id: panes.shell });
    await socket(page, { type: "input-ready", pane_id: panes.shell });
    await ready(page);
    console.log("PASS held: disabled, focuses nothing; resumed: enabled again");

    // the clock stops before the socket goes, so the reconnect it schedules waits until resumed; the
    // pause point is ahead of the running clock by far more than one round trip
    await page.clock.pauseAt(await page.evaluate(() => Date.now()) + FLUSH_MS);
    await page.evaluate(() => { (window as unknown as QaWindow).recordedSockets.at(-1)!.close(); });
    await disabledTap("offline", false);
    await page.clock.resume();
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.pane-frame:not(.is-hidden) .key-bar [data-key="keyboard"]')?.disabled === false, undefined, { timeout: 20_000 });
    console.log("PASS offline: disabled until the connection is back");

    await socket(page, { type: "pty-exit", pane_id: panes.shell });
    await disabledTap("ended", true);
    console.log("PASS ended: disabled, focuses nothing");
    checks["unavailable"] = states;
    assert.deepEqual(errors, []);
    return { scenario: "composing-unavailable-target", checks };
  } finally { await context.close(); }
}

// ---- scenario: an application with focus reporting on -----------------------------------------------

/**
 * DECSET 1004 has xterm report its textarea's focus (ESC [ I) and blur (ESC [ O) as input. The
 * control's own focus moves are not the user's: Show and Hide send nothing, in either mode, while a
 * focus the user makes still reports.
 */
async function focusReports(browser: Browser): Promise<Record<string, unknown>> {
  const context = await phone(browser, { language: "en", theme: "dark", terminalInputMode: "line", defaultView: "terminal" });
  try {
    const { page, errors } = await open(context, true);
    await ready(page);
    const key = keyOf(page);
    /** every input, key, resize, take-over, submit or secret frame sent since `from`, with its text */
    const inputs = (from: number): Promise<string[]> => page.evaluate(({ from, types }) => (window as unknown as { sentFrames: Array<{ type: string; text?: string }> }).sentFrames.slice(from)
      .filter((frame) => types.includes(frame.type)).map((frame) => `${frame.type}:${JSON.stringify(frame.text ?? "")}`), { from, types: [...FORBIDDEN] });
    const frameCount = (): Promise<number> => page.evaluate(() => (window as unknown as QaWindow).sentFrames.length);
    const nothingFocused = (): Promise<boolean> => page.evaluate(() => document.activeElement === null || document.activeElement === document.body);
    // input-ready precedes fixture playback, whose last frame can outlast flushTimers. Let the clock
    // run until that frame is drawn before adding output its cursor moves could overwrite.
    await page.locator(".pane-frame:not(.is-hidden) .xterm-rows", { hasText: "0 fail" }).waitFor();
    // a known start: whatever the load leaves for later has run, then nothing is focused when the mode
    // goes on, so no focus or blur of the load's can report inside the window the assertions read
    await flushTimers(page);
    await blur(page);
    assert.equal(await nothingFocused(), true, "nothing focused before focus reporting goes on");
    // xterm parses its input in order: the marker after DECSET 1004 drawn is proof the mode is on
    await socket(page, { type: "pty-data", pane_id: panes.shell, data: "\r\n\u001b[?1004hfocus reporting on" });
    await page.locator(".pane-frame:not(.is-hidden) .xterm-rows", { hasText: "focus reporting on" }).waitFor();
    await flushTimers(page);
    assert.equal(await nothingFocused(), true, "still nothing focused once the mode is on");
    const xterm = page.locator(".pane-frame:not(.is-hidden) .xterm-helper-textarea");

    // a focus the user makes reports: the grid focused by hand, then left
    let from = await frameCount();
    await xterm.focus();
    await page.waitForFunction((from) => (window as unknown as QaWindow).sentFrames.slice(from).some((frame) => frame.type === "input"), from);
    const userFocus = await inputs(from);
    assert.deepEqual(userFocus, [`input:${JSON.stringify("\u001b[I")}`], `focus reporting is on: a focus the user makes reports ESC [ I (${userFocus.join(", ")})`);

    // line mode, grid focused: Show moves the focus to the line, and the grid's blur reports nothing
    from = await frameCount();
    await key.tap();
    await raise(page);
    assert.equal((await control(page)).active, "terminal-input-text");
    await key.tap();
    await lower(page);
    await flushTimers(page);
    const lineMode = await inputs(from);
    assert.deepEqual(lineMode, [], `line mode: Show from the focused grid and Hide send nothing (${lineMode.join(", ")})`);

    // direct typing: Show focuses the grid and Hide blurs it, and neither reports (the switch, the
    // keyboard down, focuses nothing)
    await switchMode(page, "direct");
    await flushTimers(page);
    assert.equal(await nothingFocused(), true, "the switch to direct typing with the keyboard down focuses nothing");
    from = await frameCount();
    await key.tap();
    await raise(page);
    assert.equal((await control(page)).active, "xterm-helper-textarea");
    await key.tap();
    await lower(page);
    await flushTimers(page);
    const directMode = await inputs(from);
    assert.deepEqual(directMode, [], `direct typing: Show (grid focus) and Hide (grid blur) send nothing (${directMode.join(", ")})`);
    assert.notEqual((await control(page)).active, "xterm-helper-textarea");

    // direct typing, the grid already focused with the keyboard measured down (the back-gesture
    // state): Show's blur-and-refocus inside the tap reports nothing either, though it is a focus
    // change like a user's
    await xterm.focus();
    await page.waitForFunction((from) => (window as unknown as QaWindow).sentFrames.slice(from).some((frame) => frame.type === "input"), from);
    from = await frameCount();
    await key.tap();
    await raise(page);
    await key.tap();
    await lower(page);
    await flushTimers(page);
    const focusedBranch = await inputs(from);
    assert.deepEqual(focusedBranch, [], `direct typing, the grid already focused with the keyboard down: the blur-and-refocus reports nothing (${focusedBranch.join(", ")})`);

    // and the user's own focus still reports after the control was used
    from = await frameCount();
    await xterm.focus();
    await page.waitForFunction((from) => (window as unknown as QaWindow).sentFrames.slice(from).some((frame) => frame.type === "input"), from);
    const userAgain = await inputs(from);
    assert.deepEqual(userAgain, [`input:${JSON.stringify("\u001b[I")}`], "a user's focus still reports after the control was used");
    assert.deepEqual(errors, []);
    console.log("PASS focus reporting (DECSET 1004): Show and Hide send no ESC [ I / ESC [ O in line or direct mode, an already focused Show's blur-and-refocus sends none, and a user's own focus still reports");
    return { scenario: "focus-reports", userFocus, lineMode, directMode, focusedBranch, userAgain };
  } finally { await context.close(); }
}

/**
 * A capture page: the clock is installed (it runs on its own), then run past the demo's one-shot turn
 * completion (site/demo/transport.ts, 4500 ms after load), so its status is the finished one in every
 * shot. The droplet that completion raises is not waited for: the clock ran on its own while the page
 * and its fonts loaded, so by now it may be on its way in, up, leaving or gone. The shots are of the key
 * bar, so it is not drawn (as in sidebar-filter-demo-regression.ts). The offline capture can also hold
 * this clock still.
 */
async function openForCapture(context: BrowserContext): Promise<Page> {
  const { page } = await open(context, true);
  await page.clock.runFor(5_000);
  await page.addStyleTag({ content: ".droplet { visibility: hidden !important; }" });
  return page;
}

// ---- the capture set -----------------------------------------------------------------------------

interface Capture { file: string; width: number; height: number; viewport: { width: number; height: number }; theme: string; language: string; state: string; sha256: string; capturedAt: string }

async function captureSet(browser: Browser, dir: string): Promise<Capture[]> {
  mkdirSync(dir, { recursive: true });
  const captures: Capture[] = [];
  /** `held`: the page's clock is paused, so its animation frames wait; the next rendering step is the barrier */
  const shot = async (page: Page, name: string, meta: { theme: string; language: string; state: string }, held = false): Promise<void> => {
    if (held) await nextRender(page);
    else await settled(page);
    // a droplet or a banner caught mid-entrance would draw as a half-faded shape: every finite animation ends first
    await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined))));
    const file = `terminal-keyboard-${name}.png`;
    const path = join(dir, file);
    await page.screenshot({ path });
    const bytes = readFileSync(path);
    const size = page.viewportSize()!;
    const scale = await page.evaluate(() => window.devicePixelRatio);
    captures.push({ file, width: size.width * scale, height: size.height * scale, viewport: size, ...meta, sha256: createHash("sha256").update(bytes).digest("hex"), capturedAt: new Date().toISOString() });
  };
  for (const theme of ["dark", "light"] as const) {
    const language = "en";
    const context = await phone(browser, { language, theme, terminalInputMode: "line", defaultView: "terminal" });
    try {
      const page = await openForCapture(context);
      await ready(page);
      const key = keyOf(page);
      const meta = (state: string) => ({ theme, language, state });
      await shot(page, `390-${theme}-line-down`, meta("line mode, keyboard down (rest)"));
      await key.tap();
      await page.keyboard.type("echo 한글 draft");
      await raise(page);
      await shot(page, `390-${theme}-line-up`, meta("line mode, keyboard measured up (pressed), line focused with a draft"));
      await composition(page, lineOf(page), "compositionstart");
      await page.waitForFunction(() => document.querySelector('.pane-frame:not(.is-hidden) .key-bar [data-key="keyboard"]')?.getAttribute("aria-disabled") === "true");
      await shot(page, `390-${theme}-line-refused`, meta("line mode, composition in the line: the control refuses (aria-disabled)"));
      await composition(page, lineOf(page), "compositionend", "echo 한글 draft");
      await page.keyboard.press("End");
      for (const word of [" && git log --oneline -20", " && bun test ./src/lib/keyboard.test.ts", " && echo a line long enough to wrap the box", " && echo the last line of a long draft"]) await page.keyboard.type(word);
      await lineOf(page).evaluate((node: HTMLTextAreaElement) => { node.scrollTop = node.scrollHeight; });
      await shot(page, `390-${theme}-line-long-draft-end`, meta("line mode, keyboard up, a long draft scrolled to its end"));
      await page.evaluate(() => { const bar = document.querySelector<HTMLElement>(".pane-frame:not(.is-hidden) .key-bar")!; bar.scrollLeft = bar.scrollWidth; });
      await page.waitForFunction(() => document.querySelector(".pane-frame:not(.is-hidden) .key-bar")?.hasAttribute("data-overflow-start"));
      await shot(page, `390-${theme}-bar-end`, meta("line mode, keyboard up, the key bar scrolled to its end"));
      await page.evaluate(() => { document.querySelector<HTMLElement>(".pane-frame:not(.is-hidden) .key-bar")!.scrollLeft = 0; });
      await key.tap();
      await lower(page);
      // the ring: the control is a Tab stop, reached from the input line by Tab alone
      await tabTo(page);
      await shot(page, `390-${theme}-focus-visible`, meta("line mode, keyboard down, the control reached by Tab from the input line (focus-visible ring)"));
      await blur(page);
      await switchMode(page, "direct");
      await blur(page);
      await shot(page, `390-${theme}-direct-down`, meta("direct typing, keyboard down"));
      await key.tap();
      await raise(page);
      await shot(page, `390-${theme}-direct-up`, meta("direct typing, keyboard measured up (pressed), grid focused"));
      await key.tap();
      await lower(page);
      await socket(page, { type: "pty-data", pane_id: panes.shell, data: "\r\nPassword: " });
      await page.locator(".pane-frame:not(.is-hidden) .secret-input input").waitFor();
      await shot(page, `390-${theme}-secret-down`, meta("secret mode, keyboard down: the masked input takes the slot and the key bar, with its control, is not shown"));
      await page.locator(".pane-frame:not(.is-hidden) .secret-input input").tap();
      await page.waitForFunction(() => document.activeElement?.matches(".secret-input input") === true);
      await raise(page);
      await shot(page, `390-${theme}-secret-up`, meta("secret mode, keyboard measured up: the masked input focused above the keyboard, no key bar (and so no control) while it is shown"));
      await blur(page);
      await lower(page);
      await socket(page, { type: "pty-data", pane_id: panes.shell, data: "\r\nrelease $ " });
      await page.locator(".pane-frame:not(.is-hidden) .secret-input input").waitFor({ state: "detached" });
      await ready(page);
      await socket(page, { type: "error", code: "attach_held", pane_id: panes.shell, message: "Another web bridge has this pane" });
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.pane-frame:not(.is-hidden) .key-bar [data-key="keyboard"]')?.disabled === true);
      await shot(page, `390-${theme}-disabled-held`, meta("direct typing, the pane held by another bridge: the bar and the control disabled"));
      await socket(page, { type: "attach-resumed", pane_id: panes.shell });
      await socket(page, { type: "input-ready", pane_id: panes.shell });
      await ready(page);
      // offline, held through its capture: the clock stops before the socket goes, so the reconnect it
      // schedules waits until resumed, and the state is read on both sides of the screenshot
      await page.clock.pauseAt(await page.evaluate(() => Date.now()) + FLUSH_MS);
      await page.evaluate(() => { (window as unknown as QaWindow).recordedSockets.at(-1)!.close(); });
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.pane-frame:not(.is-hidden) .key-bar [data-key="keyboard"]')?.disabled === true);
      const offlineNow = (): Promise<[boolean | null, boolean, boolean]> => page.evaluate(() => [
        document.querySelector<HTMLButtonElement>('.pane-frame:not(.is-hidden) .key-bar [data-key="keyboard"]')?.disabled ?? null,
        document.querySelector(".conn-reconnecting") !== null,
        document.querySelector(".conn-live") !== null,
      ]);
      assert.deepEqual(await offlineNow(), [true, true, false], "offline before the capture: control disabled, header reconnecting");
      await shot(page, `390-${theme}-disabled-offline`, meta("direct typing, the connection dropped (reconnect held): the bar and the control disabled, the header reconnecting"), true);
      assert.deepEqual(await offlineNow(), [true, true, false], "still offline after the capture: the screenshot shows the offline state");
      await page.clock.resume();
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.pane-frame:not(.is-hidden) .key-bar [data-key="keyboard"]')?.disabled === false, undefined, { timeout: 20_000 });
      await role(page, "observe");
      await page.locator(".terminal-banner-observe").waitFor();
      await shot(page, `390-${theme}-observe`, meta("view only: the bar and its controls are not shown"));
      await role(page, "interact");
      await ready(page);
      await page.close();
    } finally { await context.close(); }
    const landscape = await phone(browser, { language, theme, terminalInputMode: "line", defaultView: "terminal" }, LANDSCAPE);
    try {
      const page = await openForCapture(landscape);
      await ready(page);
      await keyOf(page).tap();
      await page.keyboard.type("echo landscape");
      await raise(page, KEYBOARD_LANDSCAPE);
      await shot(page, `390-${theme}-landscape-up`, { theme, language, state: "landscape (844x390), line mode, keyboard measured up: the bar at the keyboard's edge" });
    } finally { await landscape.close(); }
  }
  // Korean: the control's names (its accessible names, said by a screen reader; the glyph does not change)
  const korean = await phone(browser, { language: "ko", theme: "dark", terminalInputMode: "line", defaultView: "terminal" });
  try {
    const page = await openForCapture(korean);
    await ready(page);
    const key = keyOf(page);
    assert.equal(await key.getAttribute("aria-label"), "키보드 보이기");
    assert.equal(await key.getAttribute("title"), "키보드 보이기");
    assert.equal(await page.locator('.pane-frame:not(.is-hidden) .key-bar [data-key="direct"]').getAttribute("aria-label"), "입력창");
    await shot(page, "390-dark-ko-line-down", { theme: "dark", language: "ko", state: "line mode, keyboard down: the control is named 키보드 보이기" });
    await key.tap();
    await page.keyboard.type("echo 한글 초안");
    await raise(page);
    assert.equal(await key.getAttribute("aria-label"), "키보드 숨기기");
    assert.equal(await key.getAttribute("title"), "키보드 숨기기");
    await shot(page, "390-dark-ko-line-up", { theme: "dark", language: "ko", state: "line mode, keyboard measured up: the control is named 키보드 숨기기" });
  } finally { await korean.close(); }
  // a desktop with a fine pointer: no key bar, so no phone-only key; Mod+Shift+E is its focus equivalent
  for (const theme of ["dark", "light"] as const) {
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
    try {
      await desktop.addInitScript(({ key, settings, pane }) => {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(settings));
        localStorage.setItem(`ovis:view:${pane}`, "terminal");
      }, { key: SETTINGS_KEY, settings: { language: "en", theme, terminalInputMode: "line", defaultView: "terminal" }, pane: panes.shell });
      const page = await openForCapture(desktop);
      assert.equal(await page.locator(".key-bar").isVisible(), false, "a desktop shows no key bar under the terminal");
      assert.equal(await page.locator('[data-key="keyboard"]').count(), 0, "and so no phone keyboard control");
      await shot(page, `1440-${theme}-rest`, { theme, language: "en", state: "desktop, line mode: no key bar, so the phone-only control is intentionally absent" });
      await page.locator(".pane-frame.is-current").focus();
      await page.keyboard.press("ControlOrMeta+Shift+E");
      await page.waitForFunction(() => document.activeElement?.classList.contains("terminal-input-text") === true);
      await page.keyboard.type("echo desktop");
      await shot(page, `1440-${theme}-focus`, { theme, language: "en", state: "desktop, Mod+Shift+E focused the input line: the desktop equivalent of Show keyboard" });
    } finally { await desktop.close(); }
  }
  return captures;
}

// ---- run -------------------------------------------------------------------------------------------

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${RECORDER}\n    <script type="module"`));
  const server = serve();
  origin = `http://127.0.0.1:${server.port}${PREFIX}`;
  try {
    if (serveIos) {
      // native QA: a Simulator on this Mac opens the loopback address; nothing else runs until SIGINT
      console.log(`SERVING ${origin}?pane=${encodeURIComponent(panes.shell)}&view=terminal`);
      await new Promise<void>((resolve) => { process.once("SIGINT", () => resolve()); process.once("SIGTERM", () => resolve()); });
      console.log("stopping");
    } else {
      const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
      try {
        const reports = [await currentModeKeyboard(browser), await composingOrUnavailableTarget(browser), await focusReports(browser)];
        if (evidence) {
          mkdirSync(evidence, { recursive: true });
          for (const report of reports) writeFileSync(join(evidence, `terminal-keyboard-${report["scenario"]}.json`), JSON.stringify({ ...report, synthetic: "Chromium with scripted visualViewport geometry; not a native keyboard" }, null, 2));
          const captures = await captureSet(browser, evidence);
          writeFileSync(join(evidence, "manifest.json"), JSON.stringify(captures, null, 2));
          console.log(`PASS captures: ${captures.length} files under ${evidence}`);
        }
      } finally { await browser.close(); }
      console.log("PASS terminal keyboard control: current-mode focus, measured state, composition refusal, sibling pane, observe/held/offline/ended");
    }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
