/**
 * The phone's Paste key and the input line's Insert, on the real client over the demo's fictional
 * shell: Paste reads the clipboard from its tap alone, into the line at the caret, and drops a read
 * that answers for another pane, connection, mode or an edited line; Insert types the line without
 * Enter and clears only what the bridge confirmed, while the shell runs nothing until an explicit
 * Enter. With UI_EVIDENCE_DIR set, every state of both controls is captured at 390 (iPhone 14 class:
 * DPR 3, mobile, touch) and 1440, light and dark, plus Korean at 390, with a manifest.
 * Everything stays in this disposable, loopback-only app; no herdr session is opened.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const playwrightCore = "playwright-core";
const { chromium } = (await import(playwrightCore)) as typeof import("playwright-core");

const app = mkdtempSync(join(tmpdir(), "herdr-paste-insert-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });

/** what the test drives in the page: the demo's sockets, the clipboard and the bridge's answers */
interface Hook {
  sent: { type: string; id?: number; pane_id?: string; text?: string }[];
  holdInsert: boolean;
  olderBridge: boolean;
  blockConnections: boolean;
  forceInsert: { code: string; message: string } | null;
  clipboardMode: "real" | "hold" | "reject" | "text";
  clipboardText: string;
  clipboardReads: number;
  releaseInsert(): void;
  releaseClipboard(): void;
  closeSockets(): void;
  push(message: unknown): void;
  hideClipboard(hidden: boolean): void;
}
declare global { interface Window { pasteInsertTest: Hook } }

const HOOK = `<script>(() => {
  const DemoSocket = window.WebSocket;
  const sockets = new Set();
  const test = window.pasteInsertTest = {
    sent: [], holdInsert: false, heldInsert: [], olderBridge: false, blockConnections: false, forceInsert: null,
    clipboardMode: "real", clipboardText: "", clipboardReads: 0, held: null,
    releaseInsert() { for (const release of this.heldInsert.splice(0)) release(); },
    releaseClipboard() { const held = this.held; this.held = null; if (held) held(); },
    closeSockets() { for (const socket of [...sockets]) socket.close(1006, "test"); },
    push(message) { for (const socket of sockets) socket.push(message); },
    hideClipboard(hidden) { navigator.clipboard.readText = hidden ? undefined : readText; navigator.clipboard.read = hidden ? undefined : read; },
  };
  const Socket = function (...args) {
    const socket = new DemoSocket(...args);
    sockets.add(socket);
    if (test.blockConnections) setTimeout(() => socket.close(1006, "blocked"), 0);
    const push = socket.push.bind(socket);
    socket.push = (message) => {
      if (message.type === "snapshot" && test.olderBridge) message = { ...message, features: message.features.filter((feature) => feature !== "terminal-insert") };
      if (message.type === "insert-result" && test.holdInsert) { test.heldInsert.push(() => push(message)); return; }
      push(message);
    };
    const send = socket.send.bind(socket);
    socket.send = (raw) => {
      let frame = null;
      try { frame = JSON.parse(raw); } catch {}
      if (frame) test.sent.push(frame);
      if (frame && frame.type === "insert" && test.forceInsert) { socket.push({ type: "insert-result", id: frame.id, pane_id: frame.pane_id, ok: false, ...test.forceInsert }); return; }
      send(raw);
    };
    socket.addEventListener("close", () => sockets.delete(socket));
    return socket;
  };
  Socket.prototype = DemoSocket.prototype;
  Object.setPrototypeOf(Socket, DemoSocket);
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(Socket, name, { value: DemoSocket[name] });
  window.WebSocket = Socket;
  const realRead = navigator.clipboard.readText.bind(navigator.clipboard);
  const readText = () => {
    test.clipboardReads += 1;
    if (test.clipboardMode === "hold") return new Promise((resolve) => { test.held = () => resolve(test.clipboardText); });
    if (test.clipboardMode === "reject") return Promise.reject(new DOMException("Read permission denied.", "NotAllowedError"));
    if (test.clipboardMode === "text") return Promise.resolve(test.clipboardText);
    return realRead();
  };
  navigator.clipboard.readText = readText;
  // the line reads with clipboard.read() where the browser has it, for an image too: the same text, as one item
  const read = () => readText().then((text) => [new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }) })]);
  navigator.clipboard.read = read;
})();</script>`;

type Variant = { width: 390 | 1440; theme: "light" | "dark"; language: "en" | "ko" };
const label = (variant: Variant) => `${variant.width}-${variant.theme}${variant.language === "ko" ? "-ko" : ""}`;

interface Capture { file: string; width: number; height: number; theme: string; language: string; state: string; sha256: string; capturedAt: string }
const manifest: Capture[] = [];
/** what a screenshot cannot show, read in the page at each capture: sizes, contrast, targets, names */
const measurements: Record<string, unknown> = {};
const results: Record<string, { check: string; observed: unknown; pass: boolean }[]> = {};
let scenario = "";
/** records one observation under the current scenario and asserts it */
function check(name: string, pass: boolean, observed: unknown): void {
  (results[scenario] ??= []).push({ check: name, observed, pass });
  assert.ok(pass, `${scenario}: ${name} (observed ${JSON.stringify(observed)})`);
}

const hook = (page: Page) => ({
  set: (patch: Partial<Hook>) => page.evaluate((values) => { Object.assign(window.pasteInsertTest, values); }, patch),
  inserts: () => page.evaluate(() => window.pasteInsertTest.sent.filter((frame) => frame.type === "insert").map((frame) => ({ id: frame.id, pane_id: frame.pane_id, text: frame.text }))),
  typedFrames: () => page.evaluate(() => window.pasteInsertTest.sent.filter((frame) => ["insert", "input", "submit", "keys"].includes(frame.type)).length),
  reads: () => page.evaluate(() => window.pasteInsertTest.clipboardReads),
  releaseInsert: () => page.evaluate(() => window.pasteInsertTest.releaseInsert()),
  releaseClipboard: () => page.evaluate(() => window.pasteInsertTest.releaseClipboard()),
  closeSockets: () => page.evaluate(() => window.pasteInsertTest.closeSockets()),
  push: (message: unknown) => page.evaluate((frame) => window.pasteInsertTest.push(frame), message),
  hideClipboard: (hidden: boolean) => page.evaluate((value) => window.pasteInsertTest.hideClipboard(value), hidden),
});

const lineValue = (page: Page, expected: string) => page.waitForFunction((value) => document.querySelector<HTMLTextAreaElement>(".pane-frame.is-current .terminal-input-text")?.value === value, expected, { timeout: 10_000 });
const noteText = (page: Page, expected: string) => page.waitForFunction((value) => document.querySelector(".pane-frame.is-current .terminal-input-note")?.textContent === value, expected, { timeout: 10_000 });
const screenShows = (page: Page, text: string) => page.waitForFunction((value) => document.querySelector(".pane-frame.is-current .pane-terminal .xterm-rows")?.textContent?.includes(value) === true, text, { timeout: 10_000 });
const screenText = (page: Page) => page.locator(".pane-frame.is-current .pane-terminal .xterm-rows").evaluate((rows) => rows.textContent ?? "");
const drafts = (page: Page) => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((key) => key.startsWith("ovis:terminal-line:")).map((key) => [key, localStorage.getItem(key)])));
const settled = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

async function openShell(browser: Browser, origin: string, variant: Variant) {
  const phone = variant.width === 390;
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: variant.language === "ko" ? "ko-KR" : "en-US" }
    : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "en-US" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(origin).origin });
  await context.addInitScript(([theme, language, paneId]) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language, theme, terminalInputMode: "line", alertsOn: false, shortcutOverrides: { "previous-pane": "1", "next-pane": "2" } }));
    localStorage.setItem(`ovis:view:${paneId}`, "terminal");
  }, [variant.theme, variant.language, panes.shell] as const);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}?pane=${encodeURIComponent(panes.shell)}&view=terminal`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(".pane-frame.is-current .terminal-input-text").waitFor();
  await screenShows(page, "parses amounts to cents");
  await appFaces(page);
  return { context, page, errors, phone };
}

const ready = (page: Page) => page.waitForFunction(() => {
  const insert = document.querySelector<HTMLButtonElement>(".pane-frame.is-current .terminal-input-insert");
  const paste = document.querySelector<HTMLButtonElement>('.pane-frame.is-current .key-bar [data-key="paste"]');
  return insert !== null && (paste === null || !paste.disabled) && document.querySelector(".conn-live") !== null;
}, undefined, { timeout: 15_000 });

/** the line as if typed: fill fires the input events a keyboard would, which also clear the line's note (twice, so a same value still fires one) */
async function setLine(page: Page, text: string): Promise<void> {
  const line = page.locator(".pane-frame.is-current .terminal-input-text");
  await line.fill(text ? `${text}.` : " ");
  await line.fill(text);
  await lineValue(page, text);
}

async function capture(page: Page, variant: Variant, state: string): Promise<void> {
  if (!evidence) return;
  await settled(page);
  const file = `terminal-insert-${label(variant)}-${state}.png`;
  const path = join(evidence, file);
  await page.screenshot({ path, animations: "disabled" });
  measurements[file] = await page.evaluate(measurePage);
  const viewport = page.viewportSize()!;
  manifest.push({ file, width: viewport.width, height: viewport.height, theme: variant.theme, language: variant.language, state, sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), capturedAt: new Date().toISOString() });
}

/**
 * The input line's and the key bar's controls as rendered now: computed text sizes, WCAG contrast of
 * text, icons and control edges against the colour actually behind them, hit rectangles and the gap
 * to Paste's neighbours, accessible names, whether notes can be selected, and whether a note covers
 * the terminal's screen. Runs in the page.
 */
function measurePage() {
  const frame = document.querySelector(".pane-frame.is-current");
  if (!frame) return null;
  type Rgba = [number, number, number, number];
  const parse = (value: string): Rgba | null => {
    const match = value.match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
    return [parts[0]!, parts[1]!, parts[2]!, parts.length > 3 ? parts[3]! : 1];
  };
  const over = (top: Rgba, under: Rgba): Rgba => [0, 1, 2].map((i) => top[i]! * top[3] + under[i]! * (1 - top[3])).concat(1) as Rgba;
  // the colour behind an element: its own background over its ancestors', down to the first opaque one
  const backdrop = (element: Element | null): Rgba => {
    const layers: Rgba[] = [];
    for (let node = element; node; node = node.parentElement) {
      const colour = parse(getComputedStyle(node).backgroundColor);
      if (colour && colour[3] > 0) { layers.push(colour); if (colour[3] >= 1) break; }
    }
    return layers.reverse().reduce<Rgba>((under, top) => over(top, under), [255, 255, 255, 1]);
  };
  const luminance = (colour: Rgba) => {
    const [r, g, b] = colour.slice(0, 3).map((channel) => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: Rgba, b: Rgba) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return Math.round(((x! + 0.05) / (y! + 0.05)) * 100) / 100; };
  const hex = (colour: Rgba) => "#" + colour.slice(0, 3).map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("");
  const text = (selector: string) => {
    const element = frame.querySelector(selector);
    if (!element) return null;
    const style = getComputedStyle(element);
    const behind = backdrop(element.parentElement);
    const colour = over(parse(style.color)!, behind);
    return { text: element.textContent, fontSizePx: parseFloat(style.fontSize), color: hex(colour), backdrop: hex(behind), contrast: ratio(colour, behind), userSelect: style.userSelect };
  };
  const rect = (element: Element | null) => { if (!element) return null; const box = element.getBoundingClientRect(); return { x: Math.round(box.x * 10) / 10, y: Math.round(box.y * 10) / 10, width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10 }; };
  const action = (selector: string) => {
    const button = frame.querySelector<HTMLButtonElement>(selector);
    if (!button) return null;
    const face = button.querySelector(".terminal-input-face")!;
    const faceStyle = getComputedStyle(face);
    const panel = backdrop(button.parentElement);
    const fill = backdrop(face);
    const edge = parse(faceStyle.borderTopColor)!;
    const icon = over(parse(getComputedStyle(face.querySelector("svg")!).color)!, fill);
    return {
      name: button.getAttribute("aria-label"), disabled: button.disabled, hit: rect(button), face: rect(face),
      caption: text(`${selector} .terminal-input-caption`),
      edge: { style: faceStyle.borderTopStyle, width: faceStyle.borderTopWidth, color: hex(over(edge, panel)), againstPanel: edge[3] > 0 ? ratio(over(edge, panel), panel) : null },
      fill: { color: hex(fill), againstPanel: ratio(fill, panel) },
      icon: { color: hex(icon), againstFill: ratio(icon, fill) },
    };
  };
  const paste = frame.querySelector('.key-bar [data-key="paste"]');
  const gap = (a: Element | null, b: Element | null) => a && b ? Math.round((b.getBoundingClientRect().left - a.getBoundingClientRect().right) * 10) / 10 : null;
  const screen = frame.querySelector(".xterm-screen")?.getBoundingClientRect();
  const covers = (selector: string) => {
    const element = frame.querySelector(selector);
    if (!element || !screen) return null;
    const box = element.getBoundingClientRect();
    return box.bottom > screen.top && box.top < screen.bottom && box.right > screen.left && box.left < screen.right;
  };
  const focused = document.activeElement instanceof HTMLElement && frame.contains(document.activeElement) && document.activeElement.matches(":focus-visible") ? document.activeElement : null;
  const ring = focused ? (() => { const style = getComputedStyle(focused); const colour = parse(style.outlineColor); const behind = backdrop(focused.parentElement); return { element: focused.className, style: style.outlineStyle, width: style.outlineWidth, offset: style.outlineOffset, contrast: colour ? ratio(over(colour, behind), behind) : null }; })() : null;
  return {
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, pageScrollsSideways: document.documentElement.scrollWidth > innerWidth },
    line: { ...text(".terminal-input-text"), name: frame.querySelector(".terminal-input-text")?.getAttribute("aria-label") ?? null, labelledBy: (frame.querySelector(".terminal-input-text") as HTMLTextAreaElement | null)?.labels?.[0]?.textContent ?? null, rect: rect(frame.querySelector(".terminal-input-text")) },
    label: text(".terminal-input-label"),
    placeholder: frame.querySelector(".terminal-input-text") ? (() => { const element = frame.querySelector(".terminal-input-text")!; const colour = parse(getComputedStyle(element, "::placeholder").color); const behind = backdrop(element); return colour ? { color: hex(over(colour, behind)), contrast: ratio(over(colour, behind), behind) } : null; })() : null,
    insert: action(".terminal-input-insert"),
    send: action(".terminal-input-send"),
    note: text(".terminal-input-note"),
    noteCoversScreen: covers(".terminal-input-note"),
    keyBarNote: text(".key-bar-note"),
    keyBarNoteCoversScreen: covers(".key-bar-note"),
    paste: paste ? { name: paste.getAttribute("aria-label"), disabled: (paste as HTMLButtonElement).disabled, hit: rect(paste), gapBefore: gap(paste.previousElementSibling, paste), gapAfter: gap(paste, paste.nextElementSibling) } : null,
    focusRing: ring,
  };
}

/** Paste at the caret, Insert acknowledged by the bridge, and the shell left alone until Enter. */
async function checkAcknowledgedInsert(page: Page): Promise<void> {
  scenario = "paste-acknowledged-insert";
  const h = hook(page);
  const line = page.locator(".pane-frame.is-current .terminal-input-text");
  const insert = page.locator(".pane-frame.is-current .terminal-input-insert");
  const send = page.locator(".pane-frame.is-current .terminal-input-send");
  const paste = page.locator('.pane-frame.is-current .key-bar [data-key="paste"]');
  await ready(page);
  check("Insert and Send are told apart by name", await insert.getAttribute("aria-label") === "Insert text without Enter" && await send.getAttribute("aria-label") === "Press Enter in the terminal",
    [await insert.getAttribute("aria-label"), await send.getAttribute("aria-label")]);
  // and in words on screen, inside each name; the line has a label in view, not only its placeholder
  const words = { insert: await insert.locator(".terminal-input-caption").textContent(), send: await send.locator(".terminal-input-caption").textContent(),
    label: await page.locator(".pane-frame.is-current .terminal-input-label").textContent() };
  check("Insert and Send are told apart in words on screen", words.insert === "Insert text" && words.send === "Enter" && words.label === "Input line", words);
  check("the label is the line's own", await page.locator(".pane-frame.is-current .terminal-input-label").getAttribute("for") === await line.getAttribute("id"), await line.getAttribute("id"));
  check("Paste has its own name on the key bar", await paste.getAttribute("aria-label") === "Paste into the input line", await paste.getAttribute("aria-label"));
  check("Insert is off while the line is empty", await insert.isDisabled(), await insert.isDisabled());
  for (const [name, locator] of [["Insert", insert], ["Send", send]] as const) {
    const box = (await locator.boundingBox())!;
    check(`${name} is at least 44x44`, box.width >= 44 && box.height >= 44, [box.width, box.height]);
  }
  // a key-bar key is drawn shorter and reaches its 44px target through its expander (KeyBar.css .key::before, #1527):
  // a tap half a pixel inside that band, above and below the key's middle, lands on Paste
  const pasteBox = (await paste.boundingBox())!;
  const pasteTaps = await paste.evaluate((key) => {
    const rect = key.getBoundingClientRect();
    const middle = rect.top + rect.height / 2;
    const lands = (y: number) => document.elementFromPoint(rect.left + rect.width / 2, y)?.closest('[data-key="paste"]') === key;
    return { above: lands(middle - 21.5), below: lands(middle + 21.5) };
  });
  check("Paste is at least 44x44 to a finger", pasteBox.width >= 44 && pasteTaps.above && pasteTaps.below, { width: pasteBox.width, ...pasteTaps });
  // the owned browser's clipboard, read from the tap, into the line at the caret
  await page.evaluate((text) => navigator.clipboard.writeText(text), "status --short");
  const readsBefore = await h.reads();
  await setLine(page, "git ");
  await line.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(4, 4));
  await paste.tap();
  await lineValue(page, "git status --short");
  await page.waitForFunction(() => { const node = document.querySelector<HTMLTextAreaElement>(".pane-frame.is-current .terminal-input-text"); return document.activeElement === node && node?.selectionStart === 18; });
  check("one clipboard read, from the tap", await h.reads() === readsBefore + 1, await h.reads() - readsBefore);
  check("the caret follows the pasted text", await line.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]).then(([a, b]) => a === 18 && b === 18), 18);
  check("Insert is on with text in the line", !(await insert.isDisabled()), await insert.isDisabled());
  check("Send says Send once the line has text", await send.locator(".terminal-input-caption").textContent() === "Send", await send.locator(".terminal-input-caption").textContent());
  // the bridge's answer is held back: the line keeps its text, the shell echoes it and runs nothing
  await h.set({ holdInsert: true });
  const before = (await h.inserts()).length;
  await insert.tap();
  await page.waitForFunction((count) => window.pasteInsertTest.sent.filter((frame) => frame.type === "insert").length > count, before);
  const frame = (await h.inserts()).at(-1)!;
  check("one insert frame carries the line as typed, no Enter", frame.text === "git status --short" && frame.pane_id === panes.shell, frame);
  await page.waitForFunction(() => document.querySelector<HTMLButtonElement>(".pane-frame.is-current .terminal-input-insert")?.disabled === true && document.querySelector<HTMLButtonElement>(".pane-frame.is-current .terminal-input-send")?.disabled === true);
  check("the line keeps its text while the insert is unconfirmed", await line.inputValue() === "git status --short", await line.inputValue());
  await screenShows(page, "git status --short");
  check("the shell shows the text at its prompt and has not run it", !(await screenText(page)).includes("On branch main"), (await screenText(page)).includes("On branch main"));
  // typed meanwhile: stays once the sent prefix is confirmed
  await page.keyboard.type(" -b");
  await lineValue(page, "git status --short -b");
  await h.releaseInsert();
  await lineValue(page, " -b");
  check("only the acknowledged prefix clears", await line.inputValue() === " -b", await line.inputValue());
  check("no command ran on the acknowledgement", !(await screenText(page)).includes("On branch main"), false);
  // the explicit Enter, from the key bar, runs what was inserted; the line's own text stays
  await page.locator('.pane-frame.is-current .key-bar [data-key="Enter"]').tap();
  await screenShows(page, "On branch main");
  check("the shell ran the inserted line only after the explicit Enter", await line.inputValue() === " -b", await line.inputValue());
  check("the insert frame went once", (await h.inserts()).length === before + 1, (await h.inserts()).length - before);
  // another device's grid on the pane: Insert takes nothing back from it, no resize, focus or take-over
  await h.set({ holdInsert: false });
  await setLine(page, "git status");
  await h.push({ type: "pane-geometry", pane_id: panes.shell, cols: 120, rows: 40 });
  await settled(page);
  const from = await page.evaluate(() => window.pasteInsertTest.sent.length);
  await insert.tap();
  await lineValue(page, "");
  const frames = await page.evaluate((start) => window.pasteInsertTest.sent.slice(start).filter((frame) => !["pty-ack", "ping", "presence"].includes(frame.type)), from);
  check("Insert sends its insert frame and nothing else: no resize, focus or take-over", frames.length === 1 && frames[0]!.type === "insert" && frames[0]!.text === "git status", frames);
  // the inserted line runs on its explicit Enter, leaving the prompt clean for what follows
  await page.locator('.pane-frame.is-current .key-bar [data-key="Enter"]').tap();
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll(".pane-frame.is-current .pane-terminal .xterm-rows > div")].map((row) => (row.textContent ?? "").trimEnd()).filter(Boolean);
    return rows.at(-2)?.includes("working tree clean") === true && rows.at(-1)?.endsWith("$") === true;
  });
  await setLine(page, "");
  console.log("PASS paste at the caret from the tap, Insert acknowledged by the bridge, the shell ran nothing until Enter");
}

/** A clipboard read that answers after its target changed, and a refused or missing clipboard. */
async function checkClipboardTargetChanged(page: Page): Promise<void> {
  scenario = "clipboard-target-changed";
  const h = hook(page);
  const line = page.locator(".pane-frame.is-current .terminal-input-text");
  const paste = page.locator('.pane-frame.is-current .key-bar [data-key="paste"]');
  const pending = page.locator(".pane-frame.is-current .terminal-input-note.is-pending");
  const insertsBefore = (await h.inserts()).length;
  const typedBefore = await h.typedFrames();
  await h.set({ clipboardMode: "hold", clipboardText: "CLIP" });
  const noClip = async (where: string) => {
    const stored = await drafts(page);
    check(`no clipboard text in any draft after ${where}`, !Object.values(stored).some((value) => value?.includes("CLIP")), stored);
  };
  // edited while the read waited
  await setLine(page, "echo ");
  await paste.tap();
  await pending.waitFor();
  check("Paste is off while the read waits", await paste.isDisabled(), await paste.isDisabled());
  await page.keyboard.type("x");
  await lineValue(page, "echo x");
  await h.releaseClipboard();
  await noteText(page, "Not pasted: the line or the terminal changed meanwhile. Paste again.");
  check("an edited line takes no late clipboard text", await line.inputValue() === "echo x", await line.inputValue());
  await noClip("an edit");
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.pane-frame.is-current .key-bar [data-key="paste"]')?.disabled);
  // the pane changed while the read waited
  await setLine(page, "echo ");
  await paste.tap();
  await pending.waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+Digit2");
  await page.waitForFunction((previous) => document.querySelector(".pane-frame.is-current")?.getAttribute("data-layout-pane") !== previous, panes.shell);
  await h.releaseClipboard();
  await page.keyboard.press("ControlOrMeta+Shift+Digit1");
  await page.waitForFunction((pane) => document.querySelector(".pane-frame.is-current")?.getAttribute("data-layout-pane") === pane, panes.shell);
  await line.waitFor();
  await lineValue(page, "echo ");
  await noClip("a pane switch");
  // the line put away (direct typing) while the read waited; Paste there says where it goes and changes no mode
  await paste.tap();
  await pending.waitFor();
  const direct = page.locator('.pane-frame.is-current .key-bar [data-key="direct"]');
  await direct.tap();
  await line.waitFor({ state: "detached" });
  await h.releaseClipboard();
  await paste.tap();
  const guidance = page.locator(".pane-frame.is-current .key-bar .key-bar-note", { hasText: "Tap Input line to paste." });
  await guidance.waitFor();
  check("Paste in direct typing leaves the mode alone", await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings")!).terminalInputMode) === "direct", "direct");
  // said in the bar's own row, beside the Input line key it names: nothing painted over the terminal
  const placed = await page.evaluate(() => {
    const note = document.querySelector(".pane-frame.is-current .key-bar .key-bar-note")!.getBoundingClientRect();
    const bar = document.querySelector(".pane-frame.is-current .key-bar")!.getBoundingClientRect();
    const grid = document.querySelector(".pane-frame.is-current .xterm-screen")!.getBoundingClientRect();
    const toggle = document.querySelector('.pane-frame.is-current .key-bar [data-key="direct"]')!.getBoundingClientRect();
    return { insideBar: note.top >= bar.top - 0.5 && note.bottom <= bar.bottom + 0.5, belowGrid: note.top >= grid.bottom - 0.5, besideToggle: note.left > toggle.right,
      banners: [...document.querySelectorAll(".pane-frame.is-current .terminal-banner")].filter((banner) => /paste/i.test(banner.textContent ?? "")).length };
  });
  check("the guidance sits in the key bar beside Input line, over no terminal output", placed.insideBar && placed.belowGrid && placed.besideToggle && placed.banners === 0, placed);
  await noClip("a mode switch");
  await direct.tap();
  await line.waitFor();
  await lineValue(page, "echo ");
  // the connection dropped and came back while the read waited
  await ready(page);
  await paste.tap();
  await pending.waitFor();
  await h.closeSockets();
  // the read still waits, so Paste stays off; the line itself is back in use on the new connection
  await page.waitForFunction(() => document.querySelector(".conn-live") !== null && document.querySelector<HTMLButtonElement>(".pane-frame.is-current .terminal-input-insert")?.disabled === false, undefined, { timeout: 15_000 });
  await h.releaseClipboard();
  await noteText(page, "Not pasted: the line or the terminal changed meanwhile. Paste again.");
  await ready(page);
  check("a reconnected pane takes no late clipboard text", await line.inputValue() === "echo ", await line.inputValue());
  await noClip("a reconnect");
  // the target changed and came back while the read waited: the caret moved, a composition began and
  // ended with nothing written, the pane's input was lost and given again. Each is another target
  for (const change of ["selection", "composition-cycle", "readiness-cycle"] as const) {
    await ready(page);
    await setLine(page, "abcdef");
    await line.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(1, 3));
    await h.set({ clipboardMode: "hold", clipboardText: "CLIP" });
    await paste.tap();
    await pending.waitFor();
    if (change === "selection") await line.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(5, 5));
    if (change === "composition-cycle") {
      await line.dispatchEvent("compositionstart", { data: "" });
      await line.dispatchEvent("compositionend", { data: "" });
    }
    if (change === "readiness-cycle") {
      await h.push({ type: "input-ready", pane_id: panes.shell, ready: false });
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>(".pane-frame.is-current .terminal-input-insert") !== null);
      await h.push({ type: "input-ready", pane_id: panes.shell, ready: true });
    }
    await h.releaseClipboard();
    await noteText(page, "Not pasted: the line or the terminal changed meanwhile. Paste again.");
    check(`a ${change} while the read waited keeps the line as it was`, await line.inputValue() === "abcdef", await line.inputValue());
    await noClip(`a ${change}`);
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.pane-frame.is-current .key-bar [data-key="paste"]')?.disabled);
  }
  // a refused, a missing and an empty clipboard say to use the keyboard's own paste, or that there is nothing
  await h.set({ clipboardMode: "reject" });
  await paste.tap();
  await noteText(page, "The clipboard could not be read. Use the keyboard's own paste in the input line.");
  await h.hideClipboard(true);
  await setLine(page, "echo ");
  await paste.tap();
  await noteText(page, "Paste is not available here. Use the keyboard's own paste in the input line.");
  await h.hideClipboard(false);
  await h.set({ clipboardMode: "text", clipboardText: "" });
  await setLine(page, "echo ");
  await paste.tap();
  await noteText(page, "Nothing to paste: the clipboard is empty.");
  // a composing line: neither a paste nor an insert goes into the preedit
  await setLine(page, "echo 한");
  await line.dispatchEvent("compositionstart", { data: "" });
  await paste.tap();
  await noteText(page, "Finish the word, then paste.");
  await page.locator(".pane-frame.is-current .terminal-input-insert").tap();
  await noteText(page, "Finish the word, then insert.");
  await line.dispatchEvent("compositionend", { data: "한" });
  check("no insert frame went while the clipboard was refused, held or stale", (await h.inserts()).length === insertsBefore, (await h.inserts()).length - insertsBefore);
  check("no typed frame went either", await h.typedFrames() === typedBefore, await h.typedFrames() - typedBefore);
  await h.set({ clipboardMode: "real" });
  await setLine(page, "");
  console.log("PASS a clipboard read that answers for an edited line, another pane, direct typing or a new connection is dropped; a refused clipboard says to paste natively");
}

/** An older bridge, a dropped connection and the bridge's refusals keep the line and say why. */
async function checkOlderBridgeAndUncertainty(page: Page): Promise<void> {
  scenario = "older-bridge-and-uncertainty";
  const h = hook(page);
  const line = page.locator(".pane-frame.is-current .terminal-input-text");
  const insert = page.locator(".pane-frame.is-current .terminal-input-insert");
  const typedBefore = await h.typedFrames();
  await h.set({ olderBridge: true });
  await h.closeSockets();
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await ready(page);
  await screenShows(page, "parses amounts to cents");
  await setLine(page, "git log");
  await insert.tap();
  await noteText(page, "Update this PC to insert without Enter. Nothing was sent.");
  check("an older bridge gets no insert, input or submit for Insert", await h.typedFrames() === typedBefore, await h.typedFrames() - typedBefore);
  check("the line keeps its text on an older bridge", await line.inputValue() === "git log", await line.inputValue());
  await h.set({ olderBridge: false });
  await h.closeSockets();
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await ready(page);
  await screenShows(page, "parses amounts to cents");
  // the connection drops while the bridge's answer is on its way: not confirmed, kept, never sent again
  await h.set({ holdInsert: true });
  const before = (await h.inserts()).length;
  await setLine(page, "git log");
  await insert.tap();
  await page.waitForFunction((count) => window.pasteInsertTest.sent.filter((frame) => frame.type === "insert").length > count, before);
  await h.closeSockets();
  await noteText(page, "Not confirmed: the terminal did not confirm the text. Check it before inserting again.");
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await ready(page);
  await screenShows(page, "parses amounts to cents");
  check("the unconfirmed line stays", await line.inputValue() === "git log", await line.inputValue());
  check("nothing is sent again on the new connection", (await h.inserts()).length === before + 1, (await h.inserts()).length - before);
  await h.set({ holdInsert: false });
  // several lines: Insert types one line (nothing reports a paste mode), so the line says so and sends nothing
  const linesBefore = await h.typedFrames();
  await setLine(page, "one\ntwo");
  await insert.tap();
  await noteText(page, "Insert takes one line. Send several lines, or insert them one at a time.");
  check("refused lines stay in the line", await line.inputValue() === "one\ntwo", await line.inputValue());
  check("several lines send no frame at all", await h.typedFrames() === linesBefore, await h.typedFrames() - linesBefore);
  await setLine(page, "");
  console.log("PASS an older bridge, a drop before the answer and a refused block keep the line with a note and send nothing else");
}

/** every state of the two controls, captured for the variant */
async function captureStates(page: Page, variant: Variant, phone: boolean): Promise<void> {
  if (!evidence) return;
  const h = hook(page);
  const line = page.locator(".pane-frame.is-current .terminal-input-text");
  const insert = page.locator(".pane-frame.is-current .terminal-input-insert");
  const paste = page.locator('.pane-frame.is-current .key-bar [data-key="paste"]');
  const press = (locator: ReturnType<Page["locator"]>) => phone ? locator.tap() : locator.click();
  await ready(page);
  await setLine(page, "");
  await capture(page, variant, "empty");
  await setLine(page, "git status");
  await capture(page, variant, "rest");
  // keyboard focus on Insert: the ring
  await line.focus();
  for (let i = 0; i < 4 && !(await insert.evaluate((node) => node === document.activeElement)); i++) await page.keyboard.press("Tab");
  check("Tab reaches Insert", await insert.evaluate((node) => node === document.activeElement), label(variant));
  await capture(page, variant, "focus-visible");
  if (!phone) {
    await insert.hover();
    await capture(page, variant, "hover");
  }
  // pressed: the pointer held on the control, let go beside it so no click follows
  const box = (await insert.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await capture(page, variant, "pressed");
  await page.mouse.move(box.x - 40, box.y + box.height / 2);
  await page.mouse.up();
  await lineValue(page, "git status");
  // in flight: the bridge's answer held back
  await h.set({ holdInsert: true });
  const before = (await h.inserts()).length;
  await press(insert);
  await page.waitForFunction((count) => window.pasteInsertTest.sent.filter((frame) => frame.type === "insert").length > count, before);
  await page.waitForFunction(() => document.querySelector<HTMLButtonElement>(".pane-frame.is-current .terminal-input-insert")?.disabled === true);
  await capture(page, variant, "in-flight");
  await h.releaseInsert();
  await lineValue(page, "");
  await h.set({ holdInsert: false });
  // the empty line's Send is the terminal's Enter: the shell runs what was inserted and shows its prompt again
  await press(page.locator(".pane-frame.is-current .terminal-input-send"));
  await screenShows(page, "On branch main");
  if (phone) {
    // the clipboard read waits (a permission prompt), is refused, and in direct typing is told where it goes
    await h.set({ clipboardMode: "hold", clipboardText: "CLIP" });
    await setLine(page, "git ");
    await paste.tap();
    await page.locator(".pane-frame.is-current .terminal-input-note.is-pending").waitFor();
    await capture(page, variant, "loading-permission");
    await page.keyboard.type("x");
    await h.releaseClipboard();
    await page.locator(".pane-frame.is-current .terminal-input-note:not(.is-pending)").waitFor();
    await capture(page, variant, "paste-cancelled");
    await h.set({ clipboardMode: "reject" });
    await paste.tap();
    await page.locator(".pane-frame.is-current .terminal-input-note:not(.is-pending)").waitFor();
    await capture(page, variant, "clipboard-error");
    await h.hideClipboard(true);
    await setLine(page, "git ");
    await paste.tap();
    await page.locator(".pane-frame.is-current .terminal-input-note").waitFor();
    await capture(page, variant, "clipboard-missing");
    await h.hideClipboard(false);
    await h.set({ clipboardMode: "text", clipboardText: "" });
    await setLine(page, "git ");
    await paste.tap();
    await page.locator(".pane-frame.is-current .terminal-input-note").waitFor();
    await capture(page, variant, "clipboard-empty");
    await h.set({ clipboardMode: "text", clipboardText: "y".repeat(40_000) });
    await setLine(page, "");
    await paste.tap();
    await page.locator(".pane-frame.is-current .terminal-input-note").waitFor();
    await capture(page, variant, "limit");
    await h.set({ clipboardMode: "real" });
    const direct = page.locator('.pane-frame.is-current .key-bar [data-key="direct"]');
    await setLine(page, "");
    await direct.tap();
    await line.waitFor({ state: "detached" });
    await paste.tap();
    await page.locator(".pane-frame.is-current .key-bar .key-bar-note").waitFor();
    await capture(page, variant, "direct-mode-guidance");
    await direct.tap();
    await line.waitFor();
  }
  // a composing line
  await setLine(page, "git 한");
  await line.dispatchEvent("compositionstart", { data: "" });
  await press(insert);
  await page.locator(".pane-frame.is-current .terminal-input-note").waitFor();
  await capture(page, variant, "composition");
  await line.dispatchEvent("compositionend", { data: "한" });
  // long and unbroken, then scrolled to its end; several lines, refused as one block
  await setLine(page, "x".repeat(420));
  await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".pane-frame.is-current .terminal-input-text")?.rows === 4);
  await capture(page, variant, "long-unbroken");
  await line.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await capture(page, variant, "long-unbroken-scrolled-end");
  await setLine(page, "one\ntwo\nthree\nfour\nfive");
  await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".pane-frame.is-current .terminal-input-text")?.rows === 4);
  await press(insert);
  await page.locator(".pane-frame.is-current .terminal-input-note").waitFor();
  await capture(page, variant, "multiline");
  await line.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await capture(page, variant, "multiline-scrolled-end");
  // the bridge's refusals, each with its note (the demo answers none of these itself)
  const refusals: [string, { code: string; message: string }][] = [
    ["read-only", { code: "read_only", message: "observe" }], ["too-long", { code: "insert_too_long", message: "long" }],
    ["secret-prompt", { code: "secret_prompt", message: "password" }], ["not-transmitted", { code: "not_transmitted", message: "dropped" }],
    ["waited-too-long", { code: "insert_timeout", message: "late" }], ["not-ready", { code: "input_not_ready", message: "not ready" }],
    ["other", { code: "pane_busy", message: "The pane is busy with a demo turn." }],
  ];
  for (const [state, forced] of refusals) {
    await h.set({ forceInsert: forced });
    await setLine(page, "git status");
    await press(insert);
    await page.locator(".pane-frame.is-current .terminal-input-note").waitFor();
    await capture(page, variant, `refused-${state}`);
  }
  await h.set({ forceInsert: null });
  // the line disconnected under the tap: told, not sent (the socket closes in the same task as the tap)
  await setLine(page, "git status");
  await page.evaluate(() => { window.pasteInsertTest.closeSockets(); document.querySelector<HTMLButtonElement>(".pane-frame.is-current .terminal-input-insert")!.click(); });
  await page.locator(".pane-frame.is-current .terminal-input-note").waitFor();
  await capture(page, variant, "disconnected-under-tap");
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await ready(page);
  await screenShows(page, "parses amounts to cents");
  if (phone) {
    await setLine(page, "git status");
    await page.evaluate(() => { window.pasteInsertTest.closeSockets(); document.querySelector<HTMLButtonElement>('.pane-frame.is-current .key-bar [data-key="paste"]')!.click(); });
    await page.locator(".pane-frame.is-current .terminal-input-note").waitFor();
    await capture(page, variant, "paste-not-ready");
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await ready(page);
  }
  // an older bridge: Insert answers at once, from the snapshot
  await h.set({ olderBridge: true });
  await h.closeSockets();
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await ready(page);
  await screenShows(page, "parses amounts to cents");
  await setLine(page, "git status");
  await press(insert);
  await page.locator(".pane-frame.is-current .terminal-input-note").waitFor();
  await capture(page, variant, "unsupported-older-bridge");
  await h.set({ olderBridge: false });
  await h.closeSockets();
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await ready(page);
  await screenShows(page, "parses amounts to cents");
  // the connection drops before the answer: not confirmed
  await h.set({ holdInsert: true });
  await setLine(page, "git status");
  const sent = (await h.inserts()).length;
  await press(insert);
  await page.waitForFunction((count) => window.pasteInsertTest.sent.filter((frame) => frame.type === "insert").length > count, sent);
  await h.closeSockets();
  await page.locator(".pane-frame.is-current .terminal-input-note").waitFor();
  await capture(page, variant, "uncertain-acknowledgement");
  await h.set({ holdInsert: false });
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await ready(page);
  await screenShows(page, "parses amounts to cents");
  // a password prompt on screen: the masked input stands in, no Paste or Insert
  await h.push({ type: "pty-data", pane_id: panes.shell, data: "\r\nPassword:" });
  await page.locator(".pane-frame.is-current .secret-input").waitFor();
  await capture(page, variant, "secret-hidden");
  await h.push({ type: "pty-data", pane_id: panes.shell, data: "\r\n\x1b[38;5;214mrelease\x1b[0m $ " });
  await line.waitFor();
  // a view-only connection: neither control
  await h.push({ type: "role-ack", mode: "observe" });
  await page.locator(".pane-frame.is-current .terminal-banner-observe").waitFor();
  await capture(page, variant, "observe");
  await h.push({ type: "role-ack", mode: "interact" });
  await line.waitFor();
  await ready(page);
  // offline: the PC is gone, the line waits with its text
  await setLine(page, "git status");
  await h.set({ blockConnections: true });
  await h.closeSockets();
  await page.locator(".pane-frame.is-current .terminal-banner-warning").waitFor();
  await page.waitForFunction(() => document.querySelector<HTMLButtonElement>(".pane-frame.is-current .terminal-input-insert")?.disabled === true);
  await capture(page, variant, "offline");
  await h.set({ blockConnections: false });
  await page.locator(".conn-live").waitFor({ state: "attached", timeout: 20_000 });
  await ready(page);
  await screenShows(page, "parses amounts to cents");
  await setLine(page, "");
  check("no horizontal scroll", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), label(variant));
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${HOOK}\n    <script type="module"`));
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
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const origin = `http://127.0.0.1:${server.port}${prefix}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const main: Variant = { width: 390, theme: "light", language: "en" };
      const { context, page, errors } = await openShell(browser, origin, main);
      try {
        await checkAcknowledgedInsert(page);
        await checkClipboardTargetChanged(page);
        await checkOlderBridgeAndUncertainty(page);
        scenario = `captures-${label(main)}`;
        await captureStates(page, main, true);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
      if (evidence) {
        const variants: Variant[] = [{ width: 390, theme: "dark", language: "en" }, { width: 390, theme: "light", language: "ko" }, { width: 1440, theme: "light", language: "en" }, { width: 1440, theme: "dark", language: "en" }];
        for (const variant of variants) {
          const opened = await openShell(browser, origin, variant);
          try {
            scenario = `captures-${label(variant)}`;
            await captureStates(opened.page, variant, opened.phone);
            assert.deepEqual(opened.errors, []);
          } finally { await opened.context.close(); }
        }
        writeFileSync(join(evidence, "manifest.json"), JSON.stringify(manifest, null, 2));
        writeFileSync(join(evidence, "measurements.json"), JSON.stringify(measurements, null, 2));
        console.log(`PASS ${manifest.length} captures in ${evidence}`);
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
  if (evidence) {
    const tool = "UI_EVIDENCE_DIR=<evidence>/visual bun scripts/terminal-paste-insert-demo-regression.ts";
    for (const name of ["paste-acknowledged-insert", "clipboard-target-changed", "older-bridge-and-uncertainty"]) {
      writeFileSync(join(evidence, `${name}.json`), JSON.stringify({ scenario: name, tool, at: new Date().toISOString(), checks: results[name] ?? [] }, null, 2));
    }
    writeFileSync(join(evidence, "results.json"), JSON.stringify(results, null, 2));
  }
} finally { rmSync(app, { recursive: true, force: true }); }
