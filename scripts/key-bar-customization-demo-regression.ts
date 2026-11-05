import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { openSettingsPage } from "./settings-page.ts";
import { keyBarItemLabel } from "../src/lib/keyBar.ts";

// Production client over the demo's synthetic transport. Editing and typing stay in this
// disposable, loopback-only app; no herdr session or user terminal is opened.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-key-bar-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;
const SETTINGS_KEY = "ovis:settings";
// the touch key bar's fixed keys lead: the Input line toggle, Paste into the input line, then the keyboard control
const MIGRATED_KEYS = ["direct", "paste", "keyboard", "Escape", "Tab", "BackTab", "Control", "Alt", "Shift", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "ctrl-c", "ctrl-d", "ctrl-z", "pipe", "tilde", "slash"];
const DEFAULT_KEY_BAR_KEYS = ["direct", "paste", "keyboard", "Escape", "Tab", "ctrl-c", "Control", "Alt", "Shift", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

interface InputFrame { type: "input" | "keys"; pane_id: string; text?: string; keys?: string[] }
const framesOf = (page: Page): Promise<InputFrame[]> => page.evaluate(() => (window as unknown as { keyBarFrames: InputFrame[] }).keyBarFrames);
const keysOf = (page: Page): Promise<string[]> => page.locator(".key-bar [data-key]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-key")!));
const settingsOf = (page: Page): Promise<Record<string, unknown>> => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), SETTINGS_KEY);
const settled = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const settingsScrolls = new WeakMap<Page, number>();
let capturedSettings = false;
let capturedDetail = false;

const ready = async (page: Page): Promise<void> => {
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(".key-bar").waitFor();
  await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.key-bar [data-key="direct"]')?.disabled === false);
};
const openMainSettings = async (page: Page): Promise<Locator> => {
  const mac = await page.evaluate(() => /mac/i.test(navigator.platform));
  await page.keyboard.press(`${mac ? "Meta" : "Control"}+Shift+Comma`);
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.waitFor();
  await openSettingsPage(page, "Terminal");
  assert.equal(await dialog.locator(".key-bar-settings").count(), 0, "the Terminal page keeps the key-bar editor behind its compact row");
  return dialog;
};
const openSettings = async (page: Page): Promise<Locator> => {
  const main = await openMainSettings(page);
  const edit = main.getByRole("button", { name: "Edit key bar", exact: true });
  await edit.scrollIntoViewIfNeeded();
  if (evidence && !capturedSettings) {
    mkdirSync(evidence, { recursive: true });
    await settled(page);
    await page.screenshot({ path: join(evidence, "compact-settings-key-bar-phone.png") });
    capturedSettings = true;
  }
  settingsScrolls.set(page, await main.locator(".settings-body").evaluate((node) => node.scrollTop));
  await edit.tap();
  const detail = page.getByRole("dialog", { name: "Key bar", exact: true });
  await detail.locator(".key-bar-settings").waitFor();
  if (evidence && !capturedDetail) {
    await settled(page);
    await page.screenshot({ path: join(evidence, "key-bar-detail-phone.png") });
    capturedDetail = true;
  }
  return detail;
};
const returnedToSettings = async (page: Page): Promise<Locator> => {
  const main = page.getByRole("dialog", { name: "Settings", exact: true });
  await main.waitFor();
  assert.equal(await main.locator(".key-bar-settings").count(), 0);
  const edit = main.getByRole("button", { name: "Edit key bar", exact: true });
  await page.waitForFunction((scroll) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(".settings-dialog button")].find((node) => node.textContent?.trim() === "Edit key bar");
    const body = document.querySelector(".settings-body");
    return button !== undefined && document.activeElement === button && body !== null && Math.abs(body.scrollTop - scroll) <= 1;
  }, settingsScrolls.get(page)!, { timeout: 5_000 });
  return edit;
};
const closeSettings = async (page: Page, dialog: Locator): Promise<void> => {
  await dialog.getByRole("button", { name: "Close settings", exact: true }).tap();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("dialog", { name: "Settings", exact: true }).count(), 0, "Close settings closes the whole dialog rather than only returning from the detail");
  await ready(page);
};
const expectFrame = async (page: Page, press: () => Promise<unknown>, expected: Omit<InputFrame, "pane_id">): Promise<void> => {
  const before = (await framesOf(page)).length;
  await press();
  await page.waitForFunction((count) => (window as unknown as { keyBarFrames: InputFrame[] }).keyBarFrames.length > count, before, { timeout: 5_000 });
  assert.deepEqual((await framesOf(page)).slice(before), [{ pane_id: panes.api, ...expected }]);
};
const addKey = async (editor: Locator, key: string): Promise<void> => {
  await editor.getByRole("combobox", { name: "Add key", exact: true }).selectOption(key);
  await editor.getByRole("button", { name: "Add key", exact: true }).tap();
};
const addCharacter = async (editor: Locator, character: string, wanted: string[]): Promise<void> => {
  await editor.getByRole("combobox", { name: "Base key", exact: true }).selectOption("character");
  await editor.getByRole("textbox", { name: "Character", exact: true }).fill(character);
  const modifiers = editor.getByRole("group", { name: "Combination modifiers", exact: true });
  for (const name of ["Ctrl", "Alt", "Shift"]) {
    const button = modifiers.getByRole("button", { name, exact: true });
    if ((await button.getAttribute("aria-pressed") === "true") !== wanted.includes(name)) await button.tap();
  }
  await editor.getByRole("button", { name: "Add combination", exact: true }).tap();
};

/** Real touch input must reorder only on the grip; the rest of the list remains a scroll surface. */
async function checkHandleReorder(page: Page): Promise<void> {
  const original = await settingsOf(page);
  let dialog = await openSettings(page);
  const caps = (): Promise<string[]> => dialog.locator(".key-bar-settings-cap").allTextContents();
  const savedCaps = async (): Promise<string[]> => {
    const items = (await settingsOf(page)).keyBarItems;
    assert.ok(Array.isArray(items), "the layout is saved as an ordered array");
    return items.map(keyBarItemLabel);
  };
  const before = await caps();
  const expected = [before.at(-1)!, ...before.slice(0, -1)];
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", point?: { x: number; y: number }): Promise<unknown> =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: point ? [point] : [] });
  const center = async (node: Locator): Promise<{ x: number; y: number }> => {
    await node.scrollIntoViewIfNeeded();
    const box = await node.boundingBox();
    assert.ok(box, "the gesture target is visible");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const trackSaves = (): Promise<void> => page.evaluate((key) => {
    const originalSet = Storage.prototype.setItem;
    // This counter is installed and read only by this browser test.
    const recorder = window as unknown as { keyBarSettingsWrites: number };
    recorder.keyBarSettingsWrites = 0;
    Storage.prototype.setItem = function (name, value) {
      if (this === localStorage && name === key) recorder.keyBarSettingsWrites++;
      originalSet.call(this, name, value);
    };
  }, SETTINGS_KEY);
  const saves = (): Promise<number> => page.evaluate(() => {
    // The test installed this counter before any gesture.
    const recorder = window as unknown as { keyBarSettingsWrites: number };
    return recorder.keyBarSettingsWrites;
  });
  try {
    await trackSaves();
    const last = await center(dialog.locator(".key-bar-settings-handle").last());
    if (evidence) await page.screenshot({ path: join(evidence, "key-bar-drag-before-phone.png") });
    const framesBefore = await framesOf(page);
    await touch("touchStart", last);
    const body = await dialog.locator(".settings-key-bar-body").boundingBox();
    assert.ok(body);
    // A held finger at the top must keep scrolling without further pointer moves.
    const edge = { x: last.x, y: body.y + 8 };
    for (let step = 1; step <= 12; step++) {
      await touch("touchMove", { x: last.x, y: last.y + (edge.y - last.y) * step / 12 });
      await settled(page);
    }
    await page.waitForFunction(() => document.querySelector(".settings-key-bar-body")!.scrollTop === 0, undefined, { timeout: 10_000 });
    const first = await center(dialog.locator(".key-bar-settings-handle").first());
    await touch("touchMove", first);
    assert.equal(await saves(), 0, "holding and edge scrolling do not save intermediate orders");
    assert.deepEqual(await caps(), before, "the source stays in place until release");
    await touch("touchEnd");
    await settled(page);
    assert.deepEqual(await caps(), expected, "a touch handle moves the last key to the first slot");
    assert.deepEqual(await savedCaps(), expected, "the exact rendered order is saved");
    assert.equal(await saves(), 1, "one release saves once, not once per crossed row");
    assert.deepEqual(await framesOf(page), framesBefore, "editing the layout never types into a terminal");
    if (evidence) await page.screenshot({ path: join(evidence, "key-bar-drag-after-phone.png") });
    await closeSettings(page, dialog);
    const terminalOrder = await keysOf(page);
    assert.deepEqual(terminalOrder, ["direct", "paste", "keyboard", MIGRATED_KEYS.at(-1)!, ...MIGRATED_KEYS.slice(3, -1)]);
    await page.reload();
    await ready(page);
    assert.deepEqual(await keysOf(page), terminalOrder, "the dragged order persists through reload");
    dialog = await openSettings(page);
    assert.deepEqual(await caps(), expected);
    await trackSaves();
    const saved = (await settingsOf(page)).keyBarItems;

    let start = await center(dialog.locator(".key-bar-settings-handle").first());
    let target = await center(dialog.locator(".key-bar-settings-handle").nth(2));
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.equal(await dialog.isVisible(), true, "Escape cancels the drag, not the key-bar detail");
    assert.deepEqual(await caps(), expected);
    assert.deepEqual((await settingsOf(page)).keyBarItems, saved);
    assert.equal(await saves(), 0, "Escape does not persist an intermediate order");

    await touch("touchStart", start);
    await touch("touchMove", target);
    await touch("touchCancel");
    await settled(page);
    assert.deepEqual(await caps(), expected);
    assert.deepEqual((await settingsOf(page)).keyBarItems, saved);
    assert.equal(await saves(), 0, "a cancelled pointer restores without saving");
    await touch("touchStart", start);
    await touch("touchEnd");
    await settled(page);
    assert.equal(await saves(), 0, "releasing in the original slot does not save");

    const swipe = await center(dialog.locator(".key-bar-settings-cap").nth(4));
    const scrollBefore = await dialog.locator(".settings-key-bar-body").evaluate((node) => node.scrollTop);
    await touch("touchStart", swipe);
    for (let step = 1; step <= 12; step++) {
      await touch("touchMove", { x: swipe.x, y: swipe.y - 160 * step / 12 });
      await settled(page);
    }
    await touch("touchEnd");
    await page.waitForFunction((before) => document.querySelector(".settings-key-bar-body")!.scrollTop > before, scrollBefore);
    assert.deepEqual(await caps(), expected, "swiping a row body scrolls without reordering");
    assert.deepEqual((await settingsOf(page)).keyBarItems, saved);
    assert.equal(await saves(), 0, "native scrolling does not save");

    start = await center(dialog.locator(".key-bar-settings-handle").first());
    const currentBody = await dialog.locator(".settings-key-bar-body").boundingBox();
    assert.ok(currentBody);
    const lowerEdge = { x: start.x, y: currentBody.y + currentBody.height - 8 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(lowerEdge.x, lowerEdge.y, { steps: 8 });
    await page.waitForFunction(() => {
      const row = document.querySelector(".key-bar-settings-row:last-child")!.getBoundingClientRect();
      const body = document.querySelector(".settings-key-bar-body")!.getBoundingClientRect();
      return row.bottom <= body.bottom;
    }, undefined, { timeout: 10_000 });
    target = await center(dialog.locator(".key-bar-settings-handle").last());
    await page.mouse.move(target.x, target.y);
    assert.equal(await saves(), 0);
    await page.mouse.up();
    await settled(page);
    const mouseOrder = [...expected.slice(1), expected[0]!];
    assert.deepEqual(await caps(), mouseOrder, "the same handle supports a mouse without a long press");
    assert.deepEqual(await savedCaps(), mouseOrder);
    assert.equal(await saves(), 1);

    start = await center(dialog.locator(".key-bar-settings-handle").first());
    target = await center(dialog.locator(".key-bar-settings-handle").nth(2));
    const sheetBefore = await dialog.boundingBox();
    assert.ok(sheetBefore);
    await touch("touchStart", start);
    for (let step = 1; step <= 8; step++) {
      await touch("touchMove", { x: start.x, y: start.y + (target.y - start.y) * step / 8 });
      await settled(page);
    }
    const sheetDuring = await dialog.boundingBox();
    assert.ok(sheetDuring);
    assert.ok(Math.abs(sheetDuring.y - sheetBefore.y) < 1, "dragging down on the grip icon never drags the Settings sheet");
    await touch("touchEnd");
    await settled(page);
    const downOrder = [mouseOrder[1]!, mouseOrder[2]!, mouseOrder[0]!, ...mouseOrder.slice(3)];
    assert.equal(await dialog.isVisible(), true, "a downward touch reorder does not dismiss Settings");
    assert.deepEqual(await caps(), downOrder);
    assert.deepEqual(await savedCaps(), downOrder);
    assert.equal(await saves(), 2, "each completed mouse or touch reorder saves once");
    console.log("PASS touch handle last-to-first with edge scrolling, one save on release, reload persistence, Escape/pointercancel/no-op cancellation, row-body scrolling and mouse reorder");
  } finally { await cdp.detach(); }
  // Keep the legacy-customization scenarios below independent of this gesture's order.
  await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: SETTINGS_KEY, value: original });
  await page.reload();
  await ready(page);
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // The demo replaces WebSocket itself, so install the recorder after it and before the app.
  // Record input only: output ACKs and resize frames must not race the input assertions.
  const record = `<script>(() => {
    const Demo = window.WebSocket;
    window.keyBarFrames = [];
    window.WebSocket = function (url, protocols) {
      const socket = new Demo(url, protocols);
      const send = socket.send.bind(socket);
      socket.send = (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "input" || frame.type === "keys") window.keyBarFrames.push(frame);
        send(raw);
      };
      return socket;
    };
    for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(window.WebSocket, name, { value: Demo[name] });
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${record}\n    <script type="module"`));

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const prefix = "/herdr-web-ui/demo/app/";
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
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      try {
        await context.addInitScript(({ pane, key }) => {
          // Seed once. Reload must read the layout the user just edited.
          if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({
            language: "en", terminalInputMode: "direct",
            keyBarExtras: ["alt", "shift-tab", "home-end", "page-up-down", "ctrl-d", "ctrl-z", "pipe", "tilde", "slash"],
          }));
          localStorage.setItem(`ovis:view:${pane}`, "terminal");
        }, { pane: panes.api, key: SETTINGS_KEY });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.api)}`);
        await ready(page);
        await appFaces(page);
        assert.deepEqual(await keysOf(page), MIGRATED_KEYS, "old extras retain every fixed key, modifier and paired extra in their original order");
        await checkHandleReorder(page);

        let dialog = await openSettings(page);
        let editor = dialog.locator(".key-bar-settings");
        await editor.getByRole("button", { name: "Remove Tab", exact: true }).tap();
        await addKey(editor, "Backspace");
        await addKey(editor, "Delete");
        await editor.getByRole("button", { name: "Move ⌫ up", exact: true }).tap();
        const held = editor.getByRole("group", { name: "Held modifiers", exact: true });
        await held.getByRole("button", { name: "Shift", exact: true }).tap();
        assert.equal(await held.getByRole("button", { name: "Shift", exact: true }).getAttribute("aria-pressed"), "false");
        await held.getByRole("button", { name: "Shift", exact: true }).tap();
        assert.equal(await held.getByRole("button", { name: "Shift", exact: true }).getAttribute("aria-pressed"), "true");

        await editor.getByRole("combobox", { name: "Base key", exact: true }).selectOption("character");
        await editor.getByRole("textbox", { name: "Character", exact: true }).fill("ww");
        assert.equal(await editor.getByRole("button", { name: "Add combination", exact: true }).isDisabled(), true, "a combination accepts one character");
        await addCharacter(editor, "w", ["Ctrl"]);
        assert.equal(await editor.getByRole("button", { name: "Add combination", exact: true }).isDisabled(), true, "duplicate combinations are refused");
        await addCharacter(editor, "+", ["Alt"]);
        await addCharacter(editor, " ", ["Shift"]);
        await addCharacter(editor, "q", []);
        await editor.getByRole("button", { name: "Move Ctrl+w up", exact: true }).tap();
        const beforeBack = (await settingsOf(page)).keyBarItems;
        await dialog.getByRole("button", { name: "Back to settings", exact: true }).tap();
        let edit = await returnedToSettings(page);
        await edit.tap();
        dialog = page.getByRole("dialog", { name: "Key bar", exact: true });
        await dialog.locator(".key-bar-settings").waitFor();
        assert.deepEqual((await settingsOf(page)).keyBarItems, beforeBack, "Back keeps the edited layout when the detail is reopened");
        await dialog.getByRole("button", { name: "Remove Ctrl+w", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await returnedToSettings(page);
        await page.keyboard.press("Escape");
        await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor({ state: "hidden" });
        await ready(page);
        dialog = await openSettings(page);
        await dialog.getByRole("button", { name: "Remove Ctrl+w", exact: true }).waitFor();
        assert.deepEqual((await settingsOf(page)).keyBarItems, beforeBack, "Escape backs out of the detail without discarding the saved layout");
        console.log("PASS compact Settings opens the key-bar detail; Back and Escape restore the parent's scroll and focus without losing edits, and a second Escape closes Settings");
        await closeSettings(page, dialog);
        const editedKeys = await keysOf(page);
        assert.equal(editedKeys.includes("Tab"), false);
        assert.ok(editedKeys.includes("Backspace") && editedKeys.includes("Delete"));
        assert.ok(editedKeys.indexOf("Backspace") < editedKeys.indexOf("slash"), "move up changes the terminal's order");
        assert.ok(editedKeys.indexOf("Shift") > editedKeys.indexOf("Delete"), "a removed modifier can be added at the end");
        const saved = (await settingsOf(page)).keyBarItems;
        await page.reload();
        await ready(page);
        assert.deepEqual(await keysOf(page), editedKeys, "reload preserves additions, removals and order");
        assert.deepEqual((await settingsOf(page)).keyBarItems, saved);
        console.log("PASS legacy extras migrate to the full bar; keys, modifiers and combinations can be added, removed and reordered, and survive reload");

        const bar = page.locator(".key-bar");
        const input = page.locator(".xterm-helper-textarea");
        await input.focus();
        await bar.locator('[data-key="Control"]').tap();
        await expectFrame(page, () => bar.locator('[data-key="ArrowLeft"]').tap(), { type: "keys", keys: ["ctrl+left"] });
        await bar.locator('[data-key="Alt"]').tap();
        await bar.locator('[data-key="Shift"]').tap();
        for (const [name, chord] of [["Ctrl+w", "ctrl+w"], ["Alt++", "alt+plus"], ["Shift+Space", "shift+space"], ["q", "q"]]) {
          await expectFrame(page, () => bar.getByRole("button", { name: `Press ${name}`, exact: true }).tap(), { type: "keys", keys: [chord!] });
          assert.equal(await input.evaluate((node) => document.activeElement === node), true, "key taps preserve direct typing focus");
        }
        for (const key of ["Control", "Shift"]) await bar.locator(`[data-key="${key}"]`).tap();
        await expectFrame(page, () => bar.locator('[data-key="ctrl-d"]').tap(), { type: "keys", keys: ["ctrl+alt+d"] });
        await expectFrame(page, () => bar.locator('[data-key="Delete"]').tap(), { type: "input", text: "\x1b[3;3~" });
        const beforePaste = (await framesOf(page)).length;
        await input.evaluate((node) => {
          node.dispatchEvent(new KeyboardEvent("keydown", { key: "ㅍ", code: "KeyV", ctrlKey: true, bubbles: true, cancelable: true }));
          node.dispatchEvent(new KeyboardEvent("keyup", { key: "ㅍ", code: "KeyV", ctrlKey: true, bubbles: true, cancelable: true }));
        });
        await settled(page);
        assert.equal((await framesOf(page)).length, beforePaste, "native Ctrl+V stays a clipboard shortcut with a non-Latin layout");
        console.log("PASS ordinary keys inherit held modifiers; saved combinations override them, including plus and space, and clipboard shortcuts stay native");

        // Removing an armed modifier must leave ordinary typing plain, including after re-adding it.
        assert.equal(await bar.locator('[data-key="Alt"]').getAttribute("aria-pressed"), "true");
        dialog = await openSettings(page);
        editor = dialog.locator(".key-bar-settings");
        await editor.getByRole("button", { name: "Remove Alt", exact: true }).tap();
        await closeSettings(page, dialog);
        assert.equal(await bar.locator('[data-key="Alt"]').count(), 0);
        await input.evaluate((node) => { (node as HTMLTextAreaElement).value = ""; });
        await input.focus();
        await settled(page);
        await input.focus();
        await expectFrame(page, () => input.press("z"), { type: "input", text: "z" });
        dialog = await openSettings(page);
        editor = dialog.locator(".key-bar-settings");
        await editor.getByRole("group", { name: "Held modifiers", exact: true }).getByRole("button", { name: "Alt", exact: true }).tap();
        await closeSettings(page, dialog);
        assert.equal(await bar.locator('[data-key="Alt"]').getAttribute("aria-pressed"), "false");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "the phone page has no sideways overflow");
        if (evidence) {
          mkdirSync(evidence, { recursive: true });
          await appFaces(page);
          await page.screenshot({ path: join(evidence, "custom-key-bar-phone.png") });
        }
        console.log("PASS removing an armed modifier clears it and re-adding it does not restore the old hold");

        dialog = await openSettings(page);
        editor = dialog.locator(".key-bar-settings");
        while (await editor.locator(".key-bar-settings-row").count()) await editor.getByRole("button", { name: /^Remove / }).first().tap();
        await editor.getByText("No keys selected.", { exact: true }).waitFor();
        await closeSettings(page, dialog);
        assert.deepEqual(await keysOf(page), ["direct", "paste", "keyboard"], "an empty list keeps the fixed controls");
        await page.reload();
        await ready(page);
        assert.deepEqual(await keysOf(page), ["direct", "paste", "keyboard"], "an intentionally empty list survives reload");
        await bar.locator('[data-key="direct"]').tap();
        await page.getByRole("textbox", { name: "Terminal input line", exact: true }).waitFor();
        await bar.locator('[data-key="direct"]').tap();
        await page.getByRole("textbox", { name: "Terminal input line", exact: true }).waitFor({ state: "hidden" });
        dialog = await openSettings(page);
        await dialog.locator(".key-bar-settings").getByRole("button", { name: "Restore defaults", exact: true }).tap();
        await closeSettings(page, dialog);
        assert.deepEqual(await keysOf(page), DEFAULT_KEY_BAR_KEYS);
        for (const width of [320, 390]) {
          await page.setViewportSize({ width, height: 844 });
          await settled(page);
          const controlC = await page.evaluate(() => {
            const bar = document.querySelector<HTMLElement>(".key-bar");
            const key = bar?.querySelector<HTMLElement>('[data-key="ctrl-c"]');
            if (!bar || !key) return null;
            bar.scrollLeft = 0;
            const barRect = bar.getBoundingClientRect();
            const keyRect = key.getBoundingClientRect();
            return {
              visibleAtStart: getComputedStyle(bar).display !== "none"
                && keyRect.left >= barRect.left
                && keyRect.right <= barRect.left + bar.clientWidth,
              scrollLeft: bar.scrollLeft,
            };
          });
          assert.deepEqual(controlC, { visibleAtStart: true, scrollLeft: 0 }, `Ctrl+C is visible without horizontal scrolling at ${width}px`);
          if (evidence && width === 390) {
            mkdirSync(evidence, { recursive: true });
            await appFaces(page);
            await page.screenshot({ path: join(evidence, "key-bar-defaults-390.png") });
          }
        }

        // Chromium on Linux has no safe-area inset: give the page's stylesheet a 34px home-indicator
        // inset. Only the bar that reaches the bottom of the screen keeps room for it, and every bar
        // stands off the pane's edges.
        const inset = await context.newPage();
        await inset.route("**/*.css", async (route) => {
          const response = await route.fetch();
          await route.fulfill({ response, body: (await response.text()).replace(/env\(safe-area-inset-bottom(?:,\s*0px)?\)/g, "34px") });
        });
        await inset.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.api)}`);
        const barBox = (): Promise<{ bottom: number; paddingBottom: string; paddingLeft: string }> => inset.locator(".key-bar").evaluate((row) => {
          const style = getComputedStyle(row);
          return { bottom: row.getBoundingClientRect().bottom, paddingBottom: style.paddingBottom, paddingLeft: style.paddingLeft };
        });
        await inset.locator(".key-bar").waitFor();
        await inset.waitForFunction(() => document.querySelector(".key-bar")!.getBoundingClientRect().bottom >= innerHeight - 1);
        assert.deepEqual(await barBox().then(({ paddingBottom, paddingLeft }) => ({ paddingBottom, paddingLeft })), { paddingBottom: "26px", paddingLeft: "8px" }, "the bar at the bottom of the screen keeps room for the home indicator, less its own padding");
        await inset.evaluate(() => { document.querySelector(".key-bar")!.parentElement!.style.height = "700px"; });
        await inset.waitForFunction(() => document.querySelector(".key-bar")!.getBoundingClientRect().bottom < innerHeight - 1);
        // the bar re-places itself from a ResizeObserver, a frame after the layout moved
        await inset.waitForFunction(() => getComputedStyle(document.querySelector(".key-bar")!).paddingBottom === "0px", undefined, { timeout: 5_000 });
        assert.deepEqual(await barBox().then(({ paddingBottom, paddingLeft }) => ({ paddingBottom, paddingLeft })), { paddingBottom: "0px", paddingLeft: "8px" }, "a bar above the bottom of the screen has no home-indicator room");
        await inset.close();
        console.log("PASS only the bar at the bottom of the screen keeps home-indicator room, and every bar stands off the pane's edges");

        await page.setViewportSize({ width: 1280, height: 844 });
        await settled(page);
        const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
        const openSidebarAction = async (): Promise<Locator> => {
          await page.keyboard.press("ControlOrMeta+Shift+k");
          await palette.waitFor({ timeout: 5_000 });
          await palette.getByRole("searchbox", { name: "Search panes and actions", exact: true }).fill("Toggle sidebar");
          const action = palette.getByRole("option").filter({ hasText: "Toggle sidebar" });
          await action.waitFor({ state: "visible", timeout: 5_000 });
          return action;
        };
        const closePalette = async (): Promise<void> => {
          await page.keyboard.press("Escape");
          await palette.waitFor({ state: "hidden", timeout: 5_000 });
        };
        const modifierLabel = await page.evaluate(() => /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl");
        const expectSidebarHint = async (action: Locator, key: string): Promise<void> => {
          const hint = action.locator(".palette-shortcut");
          await hint.waitFor({ state: "visible", timeout: 5_000 });
          assert.equal(await hint.getAttribute("aria-label"), `${modifierLabel} + Shift + ${key}`);
          assert.deepEqual(await hint.locator("kbd").allTextContents(), [modifierLabel, "Shift", key]);
        };
        const openShortcutSettings = async (): Promise<Locator> => {
          await page.keyboard.press("ControlOrMeta+Shift+Comma");
          const settings = page.getByRole("dialog", { name: "Settings", exact: true });
          await settings.waitFor({ timeout: 5_000 });
          await openSettingsPage(page, "Shortcuts");
          return settings;
        };
        let action = await openSidebarAction();
        await expectSidebarHint(action, "B");
        await closePalette();

        dialog = await openShortcutSettings();
        let sidebarShortcut = dialog.getByRole("combobox", { name: "Toggle sidebar", exact: true });
        await sidebarShortcut.selectOption("x");
        await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)!).shortcutOverrides["toggle-sidebar"] === "x", SETTINGS_KEY, { timeout: 5_000 });
        await closeSettings(page, dialog);
        action = await openSidebarAction();
        await expectSidebarHint(action, "X");
        await closePalette();
        await page.reload();
        await ready(page);
        const savedOverrides = (await settingsOf(page)).shortcutOverrides as Record<string, string | null>;
        assert.equal(savedOverrides["toggle-sidebar"], "x", "a shortcut rebinding survives reload");
        action = await openSidebarAction();
        await expectSidebarHint(action, "X");
        await closePalette();

        dialog = await openShortcutSettings();
        sidebarShortcut = dialog.getByRole("combobox", { name: "Toggle sidebar", exact: true });
        await sidebarShortcut.selectOption("off");
        await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key)!).shortcutOverrides["toggle-sidebar"] === null, SETTINGS_KEY, { timeout: 5_000 });
        await closeSettings(page, dialog);
        action = await openSidebarAction();
        assert.equal(await action.locator(".palette-shortcut").count(), 0, "disabling a shortcut removes its CommandPalette hint");
        await closePalette();

        dialog = await openShortcutSettings();
        sidebarShortcut = dialog.getByRole("combobox", { name: "Toggle sidebar", exact: true });
        assert.match(await sidebarShortcut.locator('option[value="t"]').innerText(), /Reserved/);
        await sidebarShortcut.selectOption("t");
        await dialog.getByText(`Your browser or operating system may intercept ${modifierLabel}+⇧+T.`, { exact: true }).waitFor({ timeout: 5_000 });
        assert.equal(((await settingsOf(page)).shortcutOverrides as Record<string, string>)["toggle-sidebar"], "t", "a reservation warns without silently changing the configured key");
        await dialog.getByRole("button", { name: "Reset shortcuts", exact: true }).click();
        await page.waitForFunction((key) => Object.keys(JSON.parse(localStorage.getItem(key)!).shortcutOverrides).length === 0, SETTINGS_KEY, { timeout: 5_000 });
        sidebarShortcut = dialog.getByRole("combobox", { name: "Toggle sidebar", exact: true });
        await page.waitForFunction(() => (document.querySelector<HTMLSelectElement>('.settings-dialog select[aria-label="Toggle sidebar"]')?.value ?? "") === "default", undefined, { timeout: 5_000 });
        if (evidence) {
          mkdirSync(evidence, { recursive: true });
          await sidebarShortcut.scrollIntoViewIfNeeded();
          await appFaces(page);
          await page.screenshot({ path: join(evidence, "shortcuts-settings-defaults.png") });
          await page.setViewportSize({ width: 390, height: 844 });
          await settled(page);
          await dialog.locator(".settings-body").evaluate((node) => { node.scrollTop = 0; });
          await page.screenshot({ path: join(evidence, "shortcuts-settings-phone.png") });
          await page.setViewportSize({ width: 1280, height: 844 });
          await settled(page);
        }
        await closeSettings(page, dialog);
        action = await openSidebarAction();
        await expectSidebarHint(action, "B");
        if (evidence) {
          await appFaces(page);
          await page.screenshot({ path: join(evidence, "command-palette-shortcut-defaults.png") });
        }
        await closePalette();

        const dispatchPhysicalK = async (isComposing: boolean): Promise<void> => {
          await input.focus();
          await input.evaluate((node, composing) => {
            const mac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
            node.dispatchEvent(new KeyboardEvent("keydown", {
              key: "ㅏ",
              code: "KeyK",
              ctrlKey: !mac,
              metaKey: mac,
              shiftKey: true,
              isComposing: composing,
              bubbles: true,
              cancelable: true,
            }));
          }, isComposing);
        };
        const beforePhysicalShortcut = (await framesOf(page)).length;
        await dispatchPhysicalK(false);
        await palette.waitFor({ state: "visible", timeout: 5_000 });
        await settled(page);
        assert.equal((await framesOf(page)).length, beforePhysicalShortcut, "a non-Latin physical Mod+Shift+K opens the palette without sending terminal input");
        await closePalette();
        await dispatchPhysicalK(true);
        await settled(page);
        assert.equal(await palette.count(), 0, "the composing equivalent does not open the command palette");
        assert.deepEqual(errors, []);
        console.log("PASS restoring defaults keeps Ctrl+C visible; shortcut hints update, disable and reset; physical non-Latin Mod+Shift+K opens the palette without terminal input, but composition does not");

        // The frames above go to an agent pane, which the demo never types into. Its shell must
        // answer a chord as a terminal would: the demo has no herdr to turn the names into keys.
        const shell = await context.newPage();
        shell.on("pageerror", (error) => errors.push(error.message));
        await shell.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.shell)}`);
        await ready(shell);
        const shellBar = shell.locator(".key-bar");
        const screen = (): Promise<string> => shell.evaluate(() => (document.querySelector(".pane-terminal .xterm-rows")?.textContent ?? "").replaceAll("\u00a0", " "));
        const shows = async (wanted: string): Promise<void> => {
          const deadline = Date.now() + 5_000;
          while (!(await screen()).includes(wanted)) {
            assert.ok(Date.now() < deadline, `the demo shell shows ${JSON.stringify(wanted)}; it shows ${JSON.stringify((await screen()).trim())}`);
            await Bun.sleep(50);
          }
        };
        // the shell first replays a recorded session, with the gaps between its frames capped at
        // half a second: typing before it ends is drawn over by the frames that follow
        let replayed = "";
        let replayedSince = Date.now();
        const replayDeadline = Date.now() + 15_000;
        while (Date.now() - replayedSince < 1_000) {
          assert.ok(Date.now() < replayDeadline, "the demo shell's replay comes to rest");
          const now = await screen();
          if (now !== replayed || now.trim() === "") { replayed = now; replayedSince = Date.now(); }
          await Bun.sleep(50);
        }
        await shell.locator(".xterm-helper-textarea").focus();
        await shell.keyboard.insertText("ls");
        await shows("$ ls");
        await shellBar.locator('[data-key="Shift"]').tap();
        await shellBar.locator('[data-key="Enter"]').tap();
        await shows("package.json");
        await shell.keyboard.insertText("q");
        await shows("$ Q");
        await shellBar.locator('[data-key="Shift"]').tap();
        await shellBar.locator('[data-key="Control"]').tap();
        await shell.keyboard.insertText("c");
        await shows("^C");
        assert.deepEqual(errors, []);
        console.log("PASS the demo's shell runs a line on Shift+Enter, types a held Shift's capital and takes Ctrl+C from the held modifier");
      } finally { await context.close(); }
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
