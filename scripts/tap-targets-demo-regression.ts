/**
 * A finger's hit areas on a phone (mobile UX review item 2): on a coarse pointer every control the
 * review named, and the ones beside them, takes taps over at least --touch-target (44 px) both ways,
 * while it is drawn as before. The real client over the demo's fixture transport, in a disposable
 * loopback copy; no herdr session is opened. Each case is a phone (390x844 and 412x915, touch, 3x,
 * Codex dark).
 *
 * A hit area is measured where the page answers taps: from the control's drawn centre,
 * document.elementFromPoint walks out along the centre row and column while it still lands on the
 * control, and every point of the rectangle those runs span (and of the drawn box) must land on it too.
 * So a neighbour's expander that took a corner of it fails. elementFromPoint sees only the topmost
 * element, so an expander buried under a later sibling is caught from the CSS instead: each control's
 * reach (its box and its ::before, from getComputedStyle) must share no point with another's. On a desktop window (1280, a mouse) the same controls take taps over
 * their drawn box and nothing more: the expanders are for fingers only.
 * Captures go to UI_EVIDENCE_DIR as tap-targets-<width>-<state>.png when it is set.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { appFaces } from "./app-faces.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const TARGET = 44;
/** the walk's step (measure): Chromium hit-tests on device pixels (3x here), so an edge reads up to a step either way */
const RESOLUTION = 0.25;

const app = mkdtempSync(join(tmpdir(), "ovis-tap-targets-demo-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });

/** A control under test: its selector, its name in the failure message, and whether it is only a neighbour
 *  (its own size is not this test's: nothing else may take a point of its drawn box) */
interface Target { name: string; selector: string; neighbour?: boolean }
interface Box { left: number; top: number; right: number; bottom: number }
interface Area { name: string; neighbour: boolean; taps: Box | null; drawn: { x: number; y: number; width: number; height: number }; hit: { width: number; height: number }; stolen: string[] }

/** Each control's hit area as the page answers taps, measured from its drawn centre (see the header). */
const measure = (page: Page, targets: Target[], finger: boolean): Promise<Area[]> => page.evaluate(([targets, finger]) => {
  const LIMIT = 120, STEP = 0.25;
  return targets.map(({ name, selector, neighbour = false }) => {
    const element = document.querySelector(selector);
    if (!element) return { name, neighbour, taps: null, drawn: { x: 0, y: 0, width: 0, height: 0 }, hit: { width: 0, height: 0 }, stolen: [`${selector} is not on the page`] };
    const box = element.getBoundingClientRect();
    const lands = (x: number, y: number): boolean => { const hit = document.elementFromPoint(x, y); return hit !== null && (hit === element || element.contains(hit)); };
    const what = (x: number, y: number): string => { const hit = document.elementFromPoint(x, y); return hit ? `${hit.tagName.toLowerCase()}.${(hit.getAttribute("class") ?? "").split(" ")[0]}` : "nothing"; };
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    let left = cx, right = cx, top = cy, bottom = cy;
    while (left - STEP >= 0 && cx - left < LIMIT && lands(left - STEP, cy)) left -= STEP;
    while (right + STEP < innerWidth && right - cx < LIMIT && lands(right + STEP, cy)) right += STEP;
    while (top - STEP >= 0 && cy - top < LIMIT && lands(cx, top - STEP)) top -= STEP;
    while (bottom + STEP < innerHeight && bottom - cy < LIMIT && lands(cx, bottom + STEP)) bottom += STEP;
    const CONTROL = "button, a[href], input, select, textarea, summary, [role=button], [role=tab], [role=menuitem], [role=switch], [role=option], [role=checkbox]";
    // another control under the point: a neighbour (or its expander) that takes this tap
    const thief = (x: number, y: number): Element | null => {
      const control = document.elementFromPoint(x, y)?.closest(CONTROL) ?? null;
      return control && control !== element && !element.contains(control) && !control.contains(element) ? control : null;
    };
    // outside the stadium the rectangle draws (corners rounded by half its short side): Chromium hit-tests a
    // rounded control by its radius, so the corners of a round drawn box (or of a neighbour's, or of a mouse's
    // hit area, which is the drawn box) are whatever is under it, neither a miss nor a theft. Under a finger a
    // control under test owns its hit rectangle whole, corners and all
    const corner = (x: number, y: number, x0: number, y0: number, x1: number, y1: number): boolean => {
      const r = Math.min(x1 - x0, y1 - y0) / 2;
      const dx = Math.max(x0 + r - x, 0, x - (x1 - r)), dy = Math.max(y0 + r - y, 0, y - (y1 - r));
      return dx * dx + dy * dy > r * r;
    };
    // each edge is midway between the walk's last landing point and its first miss; the screen's edge counts as reached
    const edge = (at: number, step: number, limit: number) => (at + step < 0 || at + step > limit ? Math.min(Math.max(at + step, 0), limit) : at + step / 2);
    const extent = { left: edge(left, -STEP, innerWidth), right: edge(right, STEP, innerWidth), top: edge(top, -STEP, innerHeight), bottom: edge(bottom, STEP, innerHeight) };
    const stolen: string[] = [];
    const sweep = (x0: number, y0: number, x1: number, y1: number, where: string, whole: boolean) => {
      for (let x = x0 + 0.25; x < x1; x += Math.max(1, (x1 - x0 - 0.5) / 24)) for (let y = y0 + 0.25; y < y1; y += Math.max(1, (y1 - y0 - 0.5) / 24)) {
        if ((!whole || neighbour || !finger) && corner(x, y, x0, y0, x1, y1)) continue;
        if (thief(x, y)) { stolen.push(`${where} (${Math.round(x)},${Math.round(y)}) lands on ${what(x, y)}`); return; }
        if (whole && !lands(x, y)) { stolen.push(`${where} (${Math.round(x)},${Math.round(y)}) lands on ${what(x, y)}`); return; }
      }
    };
    // nothing else takes a point of the drawn box, and the measured rectangle is the control's to its rounded corners
    sweep(box.x, box.y, box.right, box.bottom, "its drawn box", false);
    sweep(left, top, right, bottom, "its hit rectangle", true);
    // where the control and its invisible expander reach, from the CSS: the box and its ::before, which is
    // positioned against the control's padding box
    const taps = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    const before = getComputedStyle(element, "::before");
    if (before.content !== "none" && before.position === "absolute") {
      const style = getComputedStyle(element);
      const pad = { left: box.left + parseFloat(style.borderLeftWidth), top: box.top + parseFloat(style.borderTopWidth), right: box.right - parseFloat(style.borderRightWidth), bottom: box.bottom - parseFloat(style.borderBottomWidth) };
      taps.left = Math.min(taps.left, pad.left + parseFloat(before.left));
      taps.top = Math.min(taps.top, pad.top + parseFloat(before.top));
      taps.right = Math.max(taps.right, pad.right - parseFloat(before.right));
      taps.bottom = Math.max(taps.bottom, pad.bottom - parseFloat(before.bottom));
    }
    return { name, neighbour, taps, drawn: { x: box.x, y: box.y, width: box.width, height: box.height }, hit: { width: extent.right - extent.left, height: extent.bottom - extent.top }, stolen };
  });
}, [targets, finger] as const);

/** Every running transition and the fonts settle, and a phone's emulated pointer leaves the page, before a measure or a capture. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity).map((animation) => animation.finished.catch(() => undefined))));
  await page.mouse.move(-50, -50);
  // a growing field (the terminal line sizes itself to its text a frame or more after it is drawn) stops moving:
  // five frames in a row with the same boxes, within two seconds
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const shape = () => [...document.querySelectorAll("textarea, .composer-surface, .terminal-input, .sidebar")].map((element) => { const box = element.getBoundingClientRect(); return `${box.x},${box.y},${box.width},${box.height}`; }).join("|");
    const deadline = performance.now() + 2000;
    let last = shape(), still = 0;
    const frame = () => {
      const now = shape();
      still = now === last ? still + 1 : 0;
      last = now;
      if (still >= 5) resolve();
      else if (performance.now() > deadline) reject(new Error("the layout kept moving for 2 s"));
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
}

// what moves on its own (a working dot's pulse, the live voice level and its clock, a message's time of day) is held still or
// not drawn, so two runs, and the same page before and after a change, capture the same pixels
const STILL = ".voice-bars, .voice-meter, .voice-timer, .chat-time { visibility: hidden !important; }";
async function capture(page: Page, width: string, state: string): Promise<void> {
  if (evidence) await page.screenshot({ path: join(evidence, `tap-targets-${width.replace(" ", "-")}-${state}.png`), animations: "disabled", style: STILL });
}

const VIEW: Target[] = [
  { name: "the Chat lens", selector: ".app-header .view-switch > button:first-child" },
  { name: "the Terminal lens", selector: ".app-header .view-switch > button:nth-child(2)" },
];
const CHAT: Target[] = [
  ...VIEW,
  { name: "Attach", selector: ".composer-controls-left .composer-attach", neighbour: true },
  { name: "the mic", selector: ".composer-controls-left .voice-mic" },
  { name: "the plan chip", selector: ".composer-controls-left .bg-tasks-toggle" },
];
const DICTATION: Target[] = [
  { name: "the mic, recording", selector: '.composer-controls-left .voice-mic[aria-pressed="true"]' },
  { name: "Cancel dictation", selector: ".composer .voice-pill.is-open .voice-cancel" },
  { name: "Insert dictation", selector: ".composer .voice-pill.is-open .voice-done" },
];
const DRAWER: Target[] = [
  { name: "the drawer's Settings gear", selector: ".sidebar.is-open .sidebar-footer-settings" },
  { name: "the plan meters beside it", selector: ".sidebar.is-open .sidebar-footer-row .usage-strip", neighbour: true },
];
/** the terminal's input line (Settings > Terminal > input line): its mic is a --touch-target circle already, and grows no further onto Insert */
const LINE: Target[] = [
  { name: "the input line's mic", selector: ".terminal-input .terminal-input-mic .voice-mic" },
  { name: "Insert text", selector: ".terminal-input .terminal-input-insert", neighbour: true },
  { name: "Enter", selector: ".terminal-input .terminal-input-send", neighbour: true },
];

/** No two controls' reach (box and expander, as the CSS lays them out) share a point, even where one lies under the other. */
function apart(areas: Area[], where: string): string[] {
  const failures: string[] = [];
  for (const [index, one] of areas.entries()) for (const other of areas.slice(index + 1)) {
    const a = one.taps, b = other.taps;
    if (!a || !b) continue;
    const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left), tall = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (overlap > 0.5 && tall > 0.5) failures.push(`${where}: ${one.name} and ${other.name} reach over the same ${overlap.toFixed(1)}x${tall.toFixed(1)}`);
  }
  return failures;
}

/** Phone: each control's hit area is a finger's both ways and wholly its own. */
function assertFinger(areas: Area[], where: string): string[] {
  const failures: string[] = apart(areas, where);
  for (const area of areas) {
    const line = `${where}: ${area.name} drawn ${Math.round(area.drawn.width)}x${Math.round(area.drawn.height)}, takes taps over ${area.hit.width}x${area.hit.height}`;
    console.log(line);
    if (!area.neighbour && (area.hit.width + RESOLUTION < TARGET || area.hit.height + RESOLUTION < TARGET)) failures.push(`${line}: under ${TARGET}x${TARGET}`);
    for (const stolen of area.stolen) failures.push(`${where}: ${area.name}: ${stolen}`);
  }
  return failures;
}

/** Desktop: a mouse's hit area is the drawn box, within a pixel's rounding. */
function assertMouse(areas: Area[], where: string): string[] {
  const failures: string[] = apart(areas, where);
  for (const area of areas) {
    console.log(`${where}: ${area.name} drawn ${Math.round(area.drawn.width)}x${Math.round(area.drawn.height)}, takes clicks over ${area.hit.width}x${area.hit.height}`);
    if (!area.neighbour && (area.hit.width > area.drawn.width + 1.5 || area.hit.height > area.drawn.height + 1.5)) failures.push(`${where}: ${area.name} takes clicks past its drawn box (${area.hit.width}x${area.hit.height} over ${area.drawn.width}x${area.drawn.height})`);
    for (const stolen of area.stolen) failures.push(`${where}: ${area.name}: ${stolen}`);
  }
  return failures;
}

async function scenario(browser: Browser, server: { port: number }, width: number, height: number, phone: boolean, density: "comfortable" | "compact"): Promise<string[]> {
  const label = density === "compact" ? `${width} compact` : String(width);
  const context = await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 3 : 1, colorScheme: "dark", locale: "en-US" });
  const failures: string[] = [];
  try {
    await context.addInitScript((density) => {
      // the first load's settings; the terminal step below changes them as Settings would
      if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", darkTheme: "codex", defaultView: "chat", alertsOn: false, voiceInput: "on", showUsage: true, density }));
      // the browser's own dictation, as a phone has it: it starts hearing at once and never hears a word
      class Recognition { onaudiostart: (() => void) | null = null; onend: (() => void) | null = null; start() { queueMicrotask(() => this.onaudiostart?.()); } stop() { this.onend?.(); } abort() { this.onend?.(); } }
      Object.defineProperty(window, "webkitSpeechRecognition", { value: Recognition, configurable: true });
      Object.defineProperty(window, "SpeechRecognition", { value: Recognition, configurable: true });
      // the demo ends its working turn 4500 ms in (2400 ms after a send): held, so the plan chip stays at work
      const later = window.setTimeout.bind(window);
      const held: number[] = [];
      Object.defineProperty(window, "tapTargetsHeld", { value: held });
      window.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
        if (ms === 4500 || ms === 2400) { held.push(ms); return 0; }
        return later(callback, ms, ...args);
      }) as typeof window.setTimeout;
    }, density);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const base = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
    const check = phone ? assertFinger : assertMouse;
    const tap = (selector: string) => phone ? page.locator(selector).tap() : page.locator(selector).click();

    await page.goto(`${base}?pane=${encodeURIComponent(panes.api)}&view=chat`);
    await page.locator(".composer-controls-left .voice-mic").waitFor();
    await page.locator(".composer-controls-left .bg-tasks-toggle").waitFor();
    await appFaces(page);
    assert.ok((await page.evaluate(() => (window as unknown as { tapTargetsHeld: number[] }).tapTargetsHeld)).includes(4500), `${label}: the demo's turn completion was held, so the plan chip stays at work`);
    await settle(page);
    await capture(page, label, "chat");
    failures.push(...check(await measure(page, CHAT, phone), `${label} chat`));

    await tap(".composer-controls-left .voice-mic");
    await page.locator('.composer .voice-pill.is-open[data-state="recording"]').waitFor();
    await settle(page);
    await capture(page, label, "dictation");
    failures.push(...check(await measure(page, DICTATION, phone), `${label} dictation`));
    await tap(".composer .voice-pill.is-open .voice-cancel");
    await page.locator(".composer .voice-pill.is-open").waitFor({ state: "detached" });

    if (phone) {
      await tap(".app-header .drawer-toggle");
      await page.locator(".sidebar.is-open .sidebar-footer-settings").waitFor();
      await settle(page);
      await capture(page, label, "drawer");
      failures.push(...check(await measure(page, DRAWER, phone), `${label} drawer`));
    } else {
      failures.push(...check(await measure(page, [{ name: "Settings", selector: ".sidebar-footer-settings" }], phone), `${label} sidebar`));
    }
    if (phone) {
      await page.evaluate(() => localStorage.setItem("ovis:settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("ovis:settings") ?? "{}"), terminalInputMode: "line" })));
      await page.goto(`${base}?pane=${encodeURIComponent(panes.shell)}&view=terminal`);
      await page.locator(".terminal-input .terminal-input-mic .voice-mic").waitFor();
      await settle(page);
      await capture(page, label, "terminal-line");
      failures.push(...check(await measure(page, [...VIEW, ...LINE], phone), `${label} terminal line`));
    }
    assert.deepEqual(errors, [], `${width}: no page errors`);
  } finally { await context.close(); }
  return failures;
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => '<script src="./demo-transport.js"></script><script type="module"'));
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
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
    try {
      const failures: string[] = [];
      for (const [width, height, phone, density] of [[390, 844, true, "comfortable"], [412, 915, true, "comfortable"], [390, 844, true, "compact"], [1280, 900, false, "comfortable"]] as const) failures.push(...await scenario(browser, server, width, height, phone, density));
      assert.deepEqual(failures, [], `hit areas:\n${failures.join("\n")}`);
      console.log("PASS tap targets: every control takes a finger's 44x44 on a phone, wholly its own, and only its drawn box under a mouse");
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
