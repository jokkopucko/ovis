/**
 * A composition in either field refuses
 * the tap and keeps its word; a sibling pane's field is never touched; an observer has no control,
 * and a held, ended or offline pane a disabled one. Chromium's synthetic viewport geometry stands
 * in for a keyboard here and proves nothing about a native one: that is checked by hand on an iOS
 * Simulator against `--serve-ios`, which only serves the built demo on loopback until SIGINT.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { appContext, installClock } from "./app-context.ts";
import { withDemoBrowser } from "./demo-browser.ts";
import { buildDemoApp } from "./demo-build.ts";
import { appFaces } from "./app-faces.ts";
import { shownRow, shownRows } from "./shown-rows.ts";
import { serveDemo } from "./demo-server.ts";
import { RECONNECTING_SHOWN_AFTER_MS } from "../src/lib/headerConnection.ts";

const SETTINGS_KEY = "ovis:settings";
const PREFIX = "/herdr-web-ui/demo/app/";
/**
 * Fake time run past the last change: PaneTerminal fits a changed host RESIZE_SETTLE_MS (120 ms) after
 * its ResizeObserver saw it, so a fit, resize or deferred focus the toggle caused has run by then
 */
const FLUSH_MS = 1_000;
const FORBIDDEN = new Set(["input", "keys", "resize", "take-over", "submit", "secret"]);
const PHONE = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };
const KEYBOARD_PORTRAIT = 500;
const KEYBOARD_LANDSCAPE = 200;

interface Frame { type: string; pane_id?: string }
interface Recorded {
  sentFrames: Frame[];
  recordedSockets: Array<WebSocket & { push(frame: Record<string, unknown>): void }>;
  socketsRefused?: boolean;
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

let origin = "";

const RECORDER = `<script>(() => {
  const Demo = window.WebSocket;
  window.sentFrames = [];
  window.recordedSockets = [];
  const Recorded = function (url, protocols) {
    // while socketsRefused is set, a reconnect finds the server away: the loss lasts as long as a test needs
    const socket = new Demo(window.socketsRefused ? "ws://127.0.0.1:9/" : url, protocols);
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

const settled = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

async function phone(browser: Browser, settings: Settings, viewport = PHONE): Promise<BrowserContext> {
  const context = await appContext(browser, { viewport, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await context.addInitScript(({ key, settings, pane, height }) => {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(settings));
    localStorage.setItem(`ovis:view:${pane}`, "terminal");
    if (localStorage.getItem("ovis:phone-tabs") === null) localStorage.setItem("ovis:phone-tabs", JSON.stringify("header"));
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
  if (clock) await installClock(page);
  await page.goto(`${origin}?pane=${encodeURIComponent(panes.shell)}&view=terminal`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(shownRows(".pane-frame:not(.is-hidden)")).waitFor();
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

const control = (page: Page): Promise<ControlState> => page.evaluate((row) => {
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
    grid: { rows: document.querySelectorAll(row).length, width: Math.round(screen?.width ?? 0), height: Math.round(screen?.height ?? 0) },
    settings: localStorage.getItem("ovis:settings"),
    frames: (window as unknown as QaWindow).sentFrames.map((frame) => frame.type),
  };
}, shownRow(".pane-frame:not(.is-hidden)"));

const lineState = (page: Page): Promise<[string, number | null, number | null]> =>
  lineOf(page).evaluate((node: HTMLTextAreaElement) => [node.value, node.selectionStart, node.selectionEnd]);

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

async function tabTo(page: Page): Promise<string[]> {
  await lineOf(page).focus();
  const stops: string[] = [];
  for (let step = 0; step < 6; step++) {
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

async function switchMode(page: Page, to: "line" | "direct"): Promise<void> {
  const before = await control(page);
  await page.locator('.pane-frame:not(.is-hidden) .key-bar [data-key="direct"]').tap();
  if (to === "direct") await page.locator("[data-direct-typing]").waitFor();
  else await page.locator("[data-direct-typing]").waitFor({ state: "detached" });
  if (before.keyboard) {
    await ready(page);
    await flushTimers(page);
    const after = await control(page);
    assert.deepEqual(after.grid, before.grid, `the switch under a keyboard keeps the grid (#1045)`);
    assert.deepEqual(after.frames.slice(before.frames.length).filter((type) => type === "resize"), [], "and sends no resize");
    return;
  }
  await page.waitForFunction(({ rows, row }) => document.querySelectorAll(row).length !== rows, { rows: before.grid.rows, row: shownRow(".pane-frame:not(.is-hidden)") });
  await page.waitForFunction((count) => (window as unknown as QaWindow).sentFrames.filter((frame) => frame.type === "resize").length > count, before.frames.filter((type) => type === "resize").length);
  await ready(page);
}

async function currentModeKeyboard(browser: Browser): Promise<Record<string, unknown>> {
  const context = await phone(browser, { language: "en", theme: "dark", terminalInputMode: "line", defaultView: "terminal" });
  try {
    const { page, errors } = await open(context, true);
    await ready(page);
    const key = keyOf(page);
    const cycles: Record<string, unknown>[] = [];
    for (const mode of ["line", "direct"] as const) {
      if (mode === "direct") {
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
    const outline = await page.evaluate(() => {
      const terminal = document.querySelector<HTMLElement>(".pane-frame:not(.is-hidden) .pane-terminal")!;
      const style = (selector: string) => getComputedStyle(terminal.querySelector(selector) ?? terminal);
      return [getComputedStyle(terminal).outlineStyle, style(".xterm").boxShadow, style(".xterm-viewport").boxShadow];
    });
    assert.deepEqual(outline, ["none", "none", "none"], "the focused terminal has no outline ring (#3550)");
    await switchMode(page, "line");
    await flushTimers(page);
    const lineAgain = await control(page);
    assert.deepEqual([lineAgain.direct, lineAgain.active, lineAgain.keyboard], [false, null, false], `direct to line with the keyboard down: the line is not focused, so the keyboard stays down (${JSON.stringify(lineAgain.active)})`);
    console.log("PASS mode switch, keyboard down: neither direction focuses the new mode's field, though the old one kept the focus");
    assert.deepEqual(errors, []);
    return { scenario: "current-mode-keyboard", cycles, keyboardRoute: { route, before: routeBefore, after: routeAfter } };
  } finally { await context.close(); }
}

const fieldState = (page: Page, field: string): Promise<{ inputmode: string | null; focused: boolean }> => page.evaluate((field) => {
  const node = document.querySelector<HTMLElement>(`.pane-frame:not(.is-hidden) .${field}`)!;
  return { inputmode: node.getAttribute("inputmode"), focused: document.activeElement === node };
}, field);

const tapAndInputmode = (page: Page, field: string): Promise<{ atFocus: string | null | undefined; focused: boolean }> => page.evaluate((field) => {
  const node = document.querySelector<HTMLElement>(`.pane-frame:not(.is-hidden) .${field}`)!;
  let atFocus: string | null | undefined;
  node.addEventListener("focus", () => { atFocus = node.getAttribute("inputmode"); }, { once: true });
  document.querySelector<HTMLButtonElement>('.pane-frame:not(.is-hidden) .key-bar [data-key="keyboard"]')!.click();
  return { atFocus, focused: document.activeElement === node };
}, field);

async function keyboardOnRequest(browser: Browser): Promise<Record<string, unknown>> {
  const results: Record<string, unknown>[] = [];
  for (const onRequest of [false, true]) {
    const context = await phone(browser, { language: "en", theme: "dark", terminalInputMode: "line", defaultView: "terminal" });
    if (onRequest) await context.addInitScript(() => { localStorage.setItem("ovis:terminal-keyboard-on-request", "true"); });
    try {
      const { page, errors } = await open(context, true);
      await ready(page);
      const held = onRequest ? "none" : null;
      for (const mode of ["line", "direct"] as const) {
        if (mode === "direct") await switchMode(page, "direct");
        await blur(page);
        await flushTimers(page);
        const field = mode === "line" ? "terminal-input-text" : "xterm-helper-textarea";
        const label = `${onRequest ? "on" : "off"}, ${mode}`;
        assert.equal((await fieldState(page, field)).inputmode, held, `${label}: at rest the field ${onRequest ? "raises no keyboard" : "raises the keyboard as on main"}`);
        await page.locator(`.pane-frame:not(.is-hidden) ${mode === "line" ? ".terminal-input-text" : ".xterm-screen"}`).tap();
        await page.waitForFunction((field) => document.activeElement?.classList.contains(field) === true, field);
        await flushTimers(page);
        assert.deepEqual(await fieldState(page, field), { inputmode: held, focused: true }, `${label}: a tap on the field focuses it, ${onRequest ? "with no keyboard" : "raising the keyboard"}`);
        assert.equal((await control(page)).label, "Show keyboard", `${label}: the control still offers the keyboard`);
        const shown = await tapAndInputmode(page, field);
        assert.deepEqual(shown, { atFocus: null, focused: true }, `${label}: Show focuses the field with no inputmode inside the tap (${JSON.stringify(shown)})`);
        await raise(page);
        await flushTimers(page);
        assert.deepEqual(await fieldState(page, field), { inputmode: null, focused: true }, `${label}: with the keyboard up the field keeps it`);
        // the back gesture: the keyboard goes, the field keeps the focus, and the hold comes back
        await lower(page);
        await flushTimers(page);
        assert.deepEqual(await fieldState(page, field), { inputmode: held, focused: true }, `${label}: the keyboard put away by the system holds the field again`);
        // a keyboard the measurement is blind to (a floating keyboard, a zoomed page): Show's request
        // outlives the control's settle window, which falls back to the measured "down"
        await blur(page);
        await tapAndInputmode(page, field);
        await flushTimers(page);
        assert.equal((await control(page)).label, "Show keyboard", `${label}: unmeasured, the control falls back to the measurement`);
        assert.deepEqual(await fieldState(page, field), { inputmode: null, focused: true }, `${label}: an unmeasured keyboard Show raised is not taken back`);
        await blur(page);
        await flushTimers(page);
        assert.equal((await fieldState(page, field)).inputmode, held, `${label}: the focus gone from the pane's fields holds them again`);
        await tapAndInputmode(page, field);
        await raise(page);
        await flushTimers(page);
        await keyOf(page).tap();
        await lower(page);
        await flushTimers(page);
        assert.deepEqual(await fieldState(page, field), { inputmode: held, focused: false }, `${label}: Hide blurs the field and holds it again`);
        results.push({ onRequest, mode, field });
      }
      if (onRequest) {
        await switchMode(page, "line");
        await blur(page);
        await page.clock.pauseAt(await page.evaluate(() => Date.now()) + FLUSH_MS);
        await page.evaluate(() => { (window as unknown as QaWindow).recordedSockets.at(-1)!.close(); });
        await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.pane-frame:not(.is-hidden) .key-bar [data-key="keyboard"]')?.disabled === true);
        await lineOf(page).tap();
        await page.waitForFunction(() => document.activeElement?.classList.contains("terminal-input-text") === true);
        await nextRender(page);
        assert.deepEqual(await fieldState(page, "terminal-input-text"), { inputmode: null, focused: true }, "on, offline: with the control disabled a tap on the line raises the keyboard for a draft");
        await page.keyboard.type("echo draft");
        await page.clock.resume();
        await ready(page);
        await flushTimers(page);
        assert.deepEqual(await fieldState(page, "terminal-input-text"), { inputmode: null, focused: true }, "on, back online: the line typed in offline keeps its keyboard");
      }
      assert.deepEqual(errors, []);
      console.log(`PASS keyboard only from the key bar ${onRequest ? "on" : "off"}: line and grid ${onRequest ? "carry inputmode=none until Show, again after Hide or the system's dismissal" : "carry no inputmode, as on main"}`);
    } finally { await context.close(); }
  }
  return { scenario: "keyboard-on-request", results };
}

interface FoldState { bar: boolean; barModeFirst: boolean; lineKeys: string | null; gridHeight: number; slotBottom: number; padBottom: number; viewport: number }

const foldState = (page: Page): Promise<FoldState> => page.evaluate(() => {
  const frame = document.querySelector(".pane-frame:not(.is-hidden)")!;
  const line = frame.querySelector(".terminal-input");
  return {
    bar: frame.querySelector(".key-bar") !== null,
    barModeFirst: frame.querySelector('.key-bar-row > [data-key="direct"]:first-child') !== null,
    lineKeys: frame.querySelector(".terminal-input-keys")?.getAttribute("aria-pressed") ?? null,
    gridHeight: Math.round(frame.querySelector(".xterm-screen")!.getBoundingClientRect().height),
    slotBottom: Math.round(frame.querySelector(".terminal-input-slot")?.getBoundingClientRect().bottom ?? 0),
    padBottom: line ? parseFloat(getComputedStyle(line).paddingBottom) : 0,
    viewport: window.innerHeight,
  };
});

async function foldKeyBar(browser: Browser): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  for (const fold of [false, true]) {
    const context = await phone(browser, { language: "en", theme: "dark", terminalInputMode: "line", defaultView: "terminal" });
    if (fold) await context.addInitScript(() => { localStorage.setItem("ovis:terminal-fold-key-bar", "true"); });
    try {
      const { page, errors } = await open(context);
      const keys = page.locator(".pane-frame:not(.is-hidden) .terminal-input-keys");
      const bar = page.locator(".pane-frame:not(.is-hidden) .key-bar");
      if (fold) await keys.waitFor();
      else await ready(page);
      await settled(page);
      const rest = await foldState(page);
      results[fold ? "on" : "off"] = rest;
      if (!fold) {
        assert.deepEqual([rest.bar, rest.barModeFirst, rest.lineKeys], [true, true, null], "off: the key bar stays under the line with its mode key first, as on main");
        assert.deepEqual(errors, []);
        console.log("PASS fold the key bar off: the key bar and its mode key under the input line, as on main");
        continue;
      }
      const off = results["off"] as FoldState;
      assert.deepEqual([rest.bar, rest.lineKeys], [false, "false"], "on: the key bar is folded, Terminal keys sits in the line");
      assert.equal(rest.slotBottom, rest.viewport, "on: the input line is the screen's bottom row");
      assert.ok(rest.padBottom >= 8, `on: the folded line keeps at least --space-2 under its controls (${rest.padBottom})`);
      assert.ok(rest.gridHeight > off.gridHeight, `on: the terminal gets the key bar's row back (${off.gridHeight} -> ${rest.gridHeight})`);
      await keys.tap();
      await bar.waitFor();
      await ready(page);
      await settled(page);
      const opened = await foldState(page);
      assert.deepEqual([opened.barModeFirst, opened.lineKeys], [true, "true"], "on: Terminal keys opens the key bar, pressed, its mode key first");
      assert.ok(opened.slotBottom < opened.viewport, "on, open: the line stands over the key bar again");
      await keys.tap();
      await bar.waitFor({ state: "detached" });
      assert.equal((await foldState(page)).lineKeys, "false", "on: a second tap folds the key bar again");
      await keys.tap();
      const ctrl = page.locator('.pane-frame:not(.is-hidden) .key-bar [data-key="Control"]');
      await ctrl.tap();
      await page.waitForFunction(() => document.querySelector('.pane-frame:not(.is-hidden) .key-bar [data-key="Control"]')?.getAttribute("aria-pressed") === "true");
      await keys.tap();
      await bar.waitFor({ state: "detached" });
      await keys.tap();
      assert.equal(await ctrl.getAttribute("aria-pressed"), "false", "on: folding the row lets go of the modifier it held");
      await page.locator('.pane-frame:not(.is-hidden) .key-bar [data-key="direct"]').tap();
      await page.locator("[data-direct-typing]").waitFor();
      assert.deepEqual([(await foldState(page)).barModeFirst, (await foldState(page)).lineKeys], [true, null], "on, direct typing: the whole key bar, mode key first, and no input line");
      await page.locator('.pane-frame:not(.is-hidden) .key-bar [data-key="direct"]').tap();
      await page.locator("[data-direct-typing]").waitFor({ state: "detached" });
      await bar.waitFor({ state: "detached" });
      assert.equal((await foldState(page)).lineKeys, "false", "on: back in the line the row is folded again");
      assert.deepEqual(errors, []);
      console.log(`PASS fold the key bar on: folded under a bottom input line (+${rest.gridHeight - off.gridHeight}px of grid), Terminal keys opens and folds it, a fold lets go of held modifiers, direct typing keeps the whole bar`);
    } finally { await context.close(); }
  }
  return { scenario: "fold-key-bar", results };
}

async function composingOrUnavailableTarget(browser: Browser): Promise<Record<string, unknown>> {
  const context = await phone(browser, { language: "en", theme: "dark", terminalInputMode: "line", defaultView: "terminal" });
  const checks: Record<string, unknown> = {};
  try {
    let { page, errors } = await open(context, true);
    await ready(page);
    let key = keyOf(page);

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
    // refusal keeps the focus, and with it the commit xterm is about to read.
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
    await key.tap();
    await lineOf(page).evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(4, 4));
    await blur(page);

    const made = await page.evaluate(async (paneId) => {
      const response = await fetch("/api/pane/split", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: paneId, direction: "right", focus: true }) });
      return { status: response.status, body: await response.json().catch(() => ({})) as { pane?: { pane_id?: string } } };
    }, panes.shell);
    assert.equal(made.status, 200, `/api/pane/split answered ${made.status}`);
    await page.locator(".pane-frame.is-hidden").waitFor({ state: "attached" });
    await page.locator(shownRows(".pane-frame:not(.is-hidden)")).waitFor();
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
    await page.addStyleTag({ content: ".droplet { visibility: hidden !important; }" });
    await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 200);
    const inFlight = await tapAndState(page);
    assert.deepEqual([inFlight.pressed, inFlight.label, inFlight.keyboard], ["true", "Hide keyboard", false], "the tapped pane's Show is in flight, the keyboard still measured down");
    const sibling = await focusedPane();
    assert.deepEqual(sibling, { active: "terminal-input-text", frame: shownFrame, draft: shellDraft(shownFrame), hiddenFocused: false }, `Show focuses the shown pane's own line, with its own draft, never the sibling's (${JSON.stringify(sibling)})`);
    await page.locator(".header-more-button").tap();
    const sheet = page.getByRole("dialog");
    await sheet.waitFor();
    await sheet.locator(`.row-sheet-item[data-item="pane:${hiddenFrame}"]`).tap();
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
    const disabledTap = async (name: string, lasting: boolean): Promise<void> => {
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.pane-frame:not(.is-hidden) .key-bar [data-key="keyboard"]')?.disabled === true);
      if (lasting) await flushTimers(page);
      const before = await control(page);
      await tapAnyway(key);
      if (lasting) await flushTimers(page);
      else await nextRender(page);
      const after = await control(page);
      assert.deepEqual([after.disabled, after.active, after.keyboard], [true, null, false], `${name}: a disabled control focuses nothing (${JSON.stringify(after)})`);
      assert.deepEqual(after.frames.slice(before.frames.length).filter((type) => FORBIDDEN.has(type)), [], `${name}: and sends nothing`);
      states[name] = after;
    };
    await socket(page, { type: "error", code: "attach_held", pane_id: panes.shell, message: "Another web bridge has this pane" });
    await disabledTap("held", true);
    await socket(page, { type: "attach-resumed", pane_id: panes.shell });
    await socket(page, { type: "input-ready", pane_id: panes.shell });
    await ready(page);
    console.log("PASS held: disabled, focuses nothing; resumed: enabled again");

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
    const inputs = (from: number): Promise<string[]> => page.evaluate(({ from, types }) => (window as unknown as { sentFrames: Array<{ type: string; text?: string }> }).sentFrames.slice(from)
      .filter((frame) => types.includes(frame.type)).map((frame) => `${frame.type}:${JSON.stringify(frame.text ?? "")}`), { from, types: [...FORBIDDEN] });
    const frameCount = (): Promise<number> => page.evaluate(() => (window as unknown as QaWindow).sentFrames.length);
    const nothingFocused = (): Promise<boolean> => page.evaluate(() => document.activeElement === null || document.activeElement === document.body);
    // input-ready precedes fixture playback, whose last frame can outlast flushTimers. Let the clock
    // run until that frame is drawn before adding output its cursor moves could overwrite.
    await page.locator(shownRows(".pane-frame:not(.is-hidden)"), { hasText: "0 fail" }).waitFor();
    await flushTimers(page);
    await blur(page);
    assert.equal(await nothingFocused(), true, "nothing focused before focus reporting goes on");
    // xterm parses its input in order: the marker after DECSET 1004 drawn is proof the mode is on
    await socket(page, { type: "pty-data", pane_id: panes.shell, data: "\r\n\u001b[?1004hfocus reporting on" });
    await page.locator(shownRows(".pane-frame:not(.is-hidden)"), { hasText: "focus reporting on" }).waitFor();
    await flushTimers(page);
    assert.equal(await nothingFocused(), true, "still nothing focused once the mode is on");
    const xterm = page.locator(".pane-frame:not(.is-hidden) .xterm-helper-textarea");

    let from = await frameCount();
    await xterm.focus();
    await page.waitForFunction((from) => (window as unknown as QaWindow).sentFrames.slice(from).some((frame) => frame.type === "input"), from);
    const userFocus = await inputs(from);
    assert.deepEqual(userFocus, [`input:${JSON.stringify("\u001b[I")}`], `focus reporting is on: a focus the user makes reports ESC [ I (${userFocus.join(", ")})`);

    from = await frameCount();
    await key.tap();
    await raise(page);
    assert.equal((await control(page)).active, "terminal-input-text");
    await key.tap();
    await lower(page);
    await flushTimers(page);
    const lineMode = await inputs(from);
    assert.deepEqual(lineMode, [], `line mode: Show from the focused grid and Hide send nothing (${lineMode.join(", ")})`);

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

async function openForCapture(context: BrowserContext): Promise<Page> {
  const { page } = await open(context, true);
  await page.clock.runFor(5_000);
  await page.addStyleTag({ content: ".droplet { visibility: hidden !important; }" });
  return page;
}

interface Capture { file: string; width: number; height: number; viewport: { width: number; height: number }; theme: string; language: string; state: string; sha256: string; capturedAt: string }

async function captureSet(browser: Browser, dir: string): Promise<Capture[]> {
  mkdirSync(dir, { recursive: true });
  const captures: Capture[] = [];
  const shot = async (page: Page, name: string, meta: { theme: string; language: string; state: string }, held = false): Promise<void> => {
    if (held) await nextRender(page);
    else await settled(page);
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
      await page.evaluate(() => { const bar = document.querySelector<HTMLElement>(".pane-frame:not(.is-hidden) .key-bar-row")!; bar.scrollLeft = bar.scrollWidth; });
      await page.waitForFunction(() => document.querySelector(".pane-frame:not(.is-hidden) .key-bar-row")?.hasAttribute("data-overflow-start"));
      await shot(page, `390-${theme}-bar-end`, meta("line mode, keyboard up, the key bar scrolled to its end"));
      await page.evaluate(() => { document.querySelector<HTMLElement>(".pane-frame:not(.is-hidden) .key-bar-row")!.scrollLeft = 0; });
      await key.tap();
      await lower(page);
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
      await page.clock.pauseAt(await page.evaluate(() => Date.now()) + FLUSH_MS);
      await page.evaluate(() => { (window as unknown as QaWindow).recordedSockets.at(-1)!.close(); });
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.pane-frame:not(.is-hidden) .key-bar [data-key="keyboard"]')?.disabled === true);
      const offlineNow = (): Promise<[boolean | null, boolean, boolean]> => page.evaluate(() => [
        document.querySelector<HTMLButtonElement>('.pane-frame:not(.is-hidden) .key-bar [data-key="keyboard"]')?.disabled ?? null,
        document.querySelector(".conn-reconnecting") !== null,
        document.querySelector(".conn-live") !== null,
      ]);
      assert.deepEqual(await offlineNow(), [true, false, true], "offline before the capture: control disabled, header not yet saying it within the grace");
      await shot(page, `390-${theme}-disabled-offline`, meta("direct typing, the connection dropped (reconnect held, inside the grace): the bar and the control disabled"), true);
      assert.deepEqual(await offlineNow(), [true, false, true], "still offline after the capture: the screenshot shows the offline state");
      await page.keyboard.press("Shift");
      await page.getByText("Reconnecting to Ovis…").waitFor();
      // the header and its chip name a reconnect only once it has lasted RECONNECTING_SHOWN_AFTER_MS: the reconnects
      // meanwhile find the server away, so this loss lasts that long
      await page.evaluate(() => { (window as unknown as QaWindow).socketsRefused = true; });
      await page.clock.runFor(RECONNECTING_SHOWN_AFTER_MS);
      await page.waitForFunction(() => document.querySelector(".conn-reconnecting") !== null && document.querySelector(".conn-live") === null);
      await page.evaluate(() => { (window as unknown as QaWindow).socketsRefused = false; });
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
  for (const theme of ["dark", "light"] as const) {
    const desktop = await appContext(browser, { viewport: { width: 1440, height: 900 } });
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

if (serveIos) {
  // serving for an iPhone to open: no browser of this script's, so not withDemoBrowser
  const app = mkdtempSync(join(tmpdir(), "herdr-terminal-keyboard-demo-"));
  try {
    await buildDemoApp(app);
    const index = join(app, "index.html");
    const html = readFileSync(index, "utf8");
    assert.match(html, /<script type="module"/);
    writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${RECORDER}\n    <script type="module"`));
    const server = serveDemo(app, { prefix: PREFIX });
    try {
      console.log(`SERVING http://127.0.0.1:${server.port}${PREFIX}?pane=${encodeURIComponent(panes.shell)}&view=terminal`);
      await new Promise<void>((resolve) => { process.once("SIGINT", () => resolve()); process.once("SIGTERM", () => resolve()); });
      console.log("stopping");
    } finally { server.stop(true); }
  } finally { rmSync(app, { recursive: true, force: true }); }
} else {
  await withDemoBrowser({ tempPrefix: "herdr-terminal-keyboard-demo-", afterTransport: `\n    ${RECORDER}` }, async ({ browser, baseUrl }) => {
    origin = baseUrl;
    const reports = [await currentModeKeyboard(browser), await keyboardOnRequest(browser), await foldKeyBar(browser), await composingOrUnavailableTarget(browser), await focusReports(browser)];
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      for (const report of reports) writeFileSync(join(evidence, `terminal-keyboard-${report["scenario"]}.json`), JSON.stringify({ ...report, synthetic: "Chromium with scripted visualViewport geometry; not a native keyboard" }, null, 2));
      const captures = await captureSet(browser, evidence);
      writeFileSync(join(evidence, "manifest.json"), JSON.stringify(captures, null, 2));
      console.log(`PASS captures: ${captures.length} files under ${evidence}`);
    }
    console.log("PASS terminal keyboard control: current-mode focus, measured state, composition refusal, sibling pane, observe/held/offline/ended");
  });
}
