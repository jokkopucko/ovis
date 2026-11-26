import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type CDPSession, type Locator, type Page } from "playwright-core";
import type { KeyBarItem } from "../src/lib/keyBar.ts";
import { KEY_REPEAT_DELAY_MS, KEY_REPEAT_INTERVAL_MS } from "../src/lib/keyRepeat.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { serveDemo } from "./demo-server.ts";
import { checkChromeTmpdir } from "./chrome-path.ts";

// The disposable app only listens on loopback; no herdr session, user terminal or real input
// transport is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-key-bar-hold-repeat-"));
const evidence = process.env.UI_EVIDENCE_DIR;
const HOLD_MS = KEY_REPEAT_DELAY_MS + 10 * KEY_REPEAT_INTERVAL_MS;
const NO_SEND_WAIT_MS = 4 * KEY_REPEAT_INTERVAL_MS;
const keyBarItems: KeyBarItem[] = [
  { type: "key", key: "Escape" },
  { type: "modifier", modifier: "ctrl" },
  { type: "key", key: "ArrowLeft" },
  ...["ArrowUp", "ArrowDown", "ArrowRight", "Tab", "Enter", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "F1", "F2", "F3", "F4"].map((key): KeyBarItem => ({ type: "key", key })),
  { type: "key", key: "ArrowRight", modifiers: { ctrl: false, alt: true, shift: false } },
];

type InputFrame =
  | { type: "keys"; pane_id: string; keys: string[] }
  | { type: "input"; pane_id: string; text: string };
interface Recorder {
  keyBarFrames: InputFrame[];
  keyBarReleaseFrameCount: number | null;
}
interface Point { x: number; y: number }

const framesOf = (page: Page): Promise<InputFrame[]> => page.evaluate(() => (window as unknown as Recorder).keyBarFrames);
const framesSince = async (page: Page, before: number): Promise<InputFrame[]> => (await framesOf(page)).slice(before).filter((frame) => frame.pane_id === panes.api);
const sentKeys = (frames: InputFrame[]): string[] => frames.flatMap((frame) => frame.type === "keys" ? frame.keys : []);
const leftKeys = (frames: InputFrame[]): string[] => sentKeys(frames).filter((key) => key === "left" || key.endsWith("+left"));
const settled = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const touch = (cdp: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", point?: Point): Promise<unknown> =>
  cdp.send("Input.dispatchTouchEvent", { type, touchPoints: point ? [{ x: point.x, y: point.y }] : [] });

async function centerOf(key: Locator): Promise<Point> {
  await key.scrollIntoViewIfNeeded();
  const box = await key.boundingBox();
  assert.ok(box, "the key is visible for the touch gesture");
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

async function hold(page: Page, cdp: CDPSession, key: Locator, duration: number, during?: () => Promise<void>): Promise<number> {
  const point = await centerOf(key);
  await page.evaluate(() => { (window as unknown as Recorder).keyBarReleaseFrameCount = null; });
  await touch(cdp, "touchStart", point);
  await Bun.sleep(duration);
  await during?.();
  await touch(cdp, "touchEnd");
  await settled(page);
  const boundary = await page.evaluate(() => (window as unknown as Recorder).keyBarReleaseFrameCount);
  assert.notEqual(boundary, null, "a stationary held finger ends with pointerup");
  return boundary!;
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // The demo replaces WebSocket itself. Install this synchronous send recorder after the
  // transport and before the app, so release checks cannot race delayed WS frame reporting.
  const record = `<script>(() => {
    const Demo = window.WebSocket;
    window.keyBarFrames = [];
    window.keyBarReleaseFrameCount = null;
    document.addEventListener("pointerup", (event) => {
      if (event.pointerType === "touch") window.keyBarReleaseFrameCount = window.keyBarFrames.length;
    }, true);
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

  const server = serveDemo(app);
  try {
    checkChromeTmpdir();
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, locale: "en-US" });
      try {
        await context.addInitScript(({ pane, items }) => {
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "direct", keyBarItems: items }));
          localStorage.setItem(`ovis:view:${pane}`, "terminal");
        }, { pane: panes.api, items: keyBarItems });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.api)}`);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.key-bar .key[data-key="ArrowLeft"]')?.disabled === false, undefined, { timeout: 5_000 });
        await page.locator(".xterm-helper-textarea").focus();
        const bar = page.locator(".key-bar-row");
        const left = bar.locator('.key[data-key="ArrowLeft"]');
        const escape = bar.locator('.key[data-key="Escape"]');
        const ctrl = bar.locator('.key[data-key="Control"]');
        const cdp = await context.newCDPSession(page);

        // 1. Playwright's touch tap drives pointerdown, pointerup and the normal click path.
        let before = (await framesOf(page)).length;
        await left.tap();
        await Bun.sleep(NO_SEND_WAIT_MS);
        assert.deepEqual(sentKeys(await framesSince(page, before)), ["left"], "a touch tap sends one Left, never two");
        console.log("PASS touch tap Left sends exactly one key");

        before = (await framesOf(page)).length;
        const release = await hold(page, cdp, left, HOLD_MS);
        const repeats = leftKeys(await framesSince(page, before));
        assert.ok(repeats.length >= 5, `a held Left repeats before release (got ${repeats.length})`);
        assert.ok(repeats.every((key) => key === "left"), "unmodified Left repeats stay unmodified");
        assert.equal((await framesOf(page)).length, release, "the release click sends nothing after repeat starts");
        await Bun.sleep(NO_SEND_WAIT_MS);
        assert.equal(leftKeys(await framesSince(page, before)).length, repeats.length, "no repeat arrives after release");
        assert.equal((await framesOf(page)).length, release, "release stops all input sends");
        console.log(`PASS holding Left repeats (${repeats.length} keys) and release sends no extra click or later key`);

        before = (await framesOf(page)).length;
        await hold(page, cdp, left, Math.floor(KEY_REPEAT_DELAY_MS / 2), async () => {
          assert.deepEqual(await framesSince(page, before), [], "a short hold sends no key while the finger is down");
        });
        await Bun.sleep(NO_SEND_WAIT_MS);
        assert.deepEqual(sentKeys(await framesSince(page, before)), ["left"], "a short hold remains exactly one click");
        console.log("PASS a hold shorter than the repeat delay sends exactly one key on release");

        // 4. The seeded layout really overflows. Keep native CDP panning enabled: synthetically
        // dispatching pointermove would test cancellation but could not prove the row scrolls.
        await bar.evaluate((row) => { row.scrollLeft = 0; });
        await settled(page);
        const scroll = await bar.evaluate((row) => ({ left: row.scrollLeft, width: row.clientWidth, content: row.scrollWidth }));
        assert.ok(scroll.content > scroll.width, "the swipe fixture has a horizontally scrollable key row");
        const start = await centerOf(left);
        const distance = Math.min(120, start.x - 12);
        assert.ok(distance >= 80, "the arrow leaves room for an 80px horizontal swipe");
        before = (await framesOf(page)).length;
        await touch(cdp, "touchStart", start);
        for (let step = 1; step <= 8; step += 1) {
          await touch(cdp, "touchMove", { x: Math.round(start.x - distance * step / 8), y: start.y });
          await Bun.sleep(16);
        }
        await touch(cdp, "touchEnd");
        await page.waitForFunction((initial) => (document.querySelector(".key-bar-row")?.scrollLeft ?? initial) > initial, scroll.left, { timeout: 2_000 });
        await Bun.sleep(KEY_REPEAT_DELAY_MS + NO_SEND_WAIT_MS);
        assert.equal(leftKeys(await framesSince(page, before)).length, 0, "a swipe sends no arrow");
        assert.deepEqual(await framesSince(page, before), [], "a swipe sends no other input either");
        assert.ok(await bar.evaluate((row) => row.scrollLeft) > scroll.left, "the native swipe scrolls the overflowing row");
        console.log("PASS horizontal swipe from Left scrolls the overflowing row and sends zero keys");

        await bar.evaluate((row) => { row.scrollLeft = 0; });
        before = (await framesOf(page)).length;
        await hold(page, cdp, escape, HOLD_MS, async () => {
          assert.deepEqual(await framesSince(page, before), [], "Escape does not send or repeat while held");
        });
        await Bun.sleep(NO_SEND_WAIT_MS);
        // Chrome's touch long-press can suppress the release click, so zero keys is also valid.
        const escapeKeys = sentKeys(await framesSince(page, before));
        assert.ok(escapeKeys.length <= 1 && escapeKeys.every((key) => key === "esc"), `held Escape does not repeat: ${JSON.stringify(escapeKeys)}`);
        console.log("PASS held Escape does not repeat");

        const backspace = bar.locator('.key[data-key="Backspace"]');
        before = (await framesOf(page)).length;
        const backspaceRelease = await hold(page, cdp, backspace, HOLD_MS);
        const backspaceFrames = await framesSince(page, before);
        const backspaceKeys = backspaceFrames.flatMap((frame) => frame.type === "input" ? [...frame.text] : frame.keys);
        assert.ok(backspaceKeys.length >= 5, `a held Backspace repeats before release (got ${backspaceKeys.length})`);
        assert.ok(backspaceKeys.every((key) => key === "\x7f"), `Backspace repeats stay Backspace: ${JSON.stringify(backspaceKeys)}`);
        // fixed wait: proves no repeat arrives after release
        await Bun.sleep(NO_SEND_WAIT_MS);
        assert.equal((await framesOf(page)).length, backspaceRelease, "Backspace stops after release with no extra click");
        console.log(`PASS holding Backspace repeats (${backspaceKeys.length} keys) and stops on release`);
        await bar.evaluate((row) => { row.scrollLeft = 0; });

        await ctrl.tap();
        assert.equal(await ctrl.getAttribute("aria-pressed"), "true", "Ctrl is armed");
        assert.equal(await ctrl.getAttribute("data-latch"), "once", "one tap holds Ctrl for one key");
        before = (await framesOf(page)).length;
        const modifiedRelease = await hold(page, cdp, left, HOLD_MS);
        const modifiedFrames = await framesSince(page, before);
        const modifiedKeys = sentKeys(modifiedFrames);
        assert.ok(leftKeys(modifiedFrames).length >= 5, "Ctrl+Left repeats while held");
        assert.ok(modifiedFrames.every((frame) => frame.type === "keys"), "every repeat stays on the logical keys path");
        assert.ok(modifiedKeys.every((key) => key === "ctrl+left"), `every repeat carries Ctrl: ${JSON.stringify(modifiedKeys)}`);
        assert.equal((await framesOf(page)).length, modifiedRelease, "Ctrl+Left has no extra release click");
        await Bun.sleep(NO_SEND_WAIT_MS);
        assert.equal((await framesOf(page)).length, modifiedRelease, "Ctrl+Left stops after release");
        assert.equal(await ctrl.getAttribute("aria-pressed"), "false", "lifting the finger lets go of Ctrl held for one key");
        console.log(`PASS sticky Ctrl applies to every held Left repeat (${modifiedKeys.length} Ctrl+Left keys), then lets go`);

        await ctrl.tap();
        await ctrl.tap();
        assert.equal(await ctrl.getAttribute("data-latch"), "locked", "a second tap locks Ctrl");
        assert.equal(await ctrl.getAttribute("aria-label"), "Control, locked");
        before = (await framesOf(page)).length;
        await left.tap();
        await left.tap();
        await page.waitForFunction((count) => (window as unknown as Recorder).keyBarFrames.length >= count + 2, before, { timeout: 5_000 });
        assert.deepEqual(sentKeys(await framesSince(page, before)), ["ctrl+left", "ctrl+left"], "a locked Ctrl carries every key");
        assert.equal(await ctrl.getAttribute("data-latch"), "locked", "keys leave a locked Ctrl locked");
        await ctrl.tap();
        assert.equal(await ctrl.getAttribute("aria-pressed"), "false", "a third tap lets Ctrl go");
        console.log("PASS two taps lock Ctrl for every key and a third lets it go");

        await ctrl.tap();
        await page.locator(".xterm-helper-textarea").focus();
        before = (await framesOf(page)).length;
        await page.keyboard.down("ArrowLeft");
        await page.keyboard.down("ArrowLeft");
        await page.keyboard.down("ArrowLeft");
        await page.waitForFunction((count) => (window as unknown as Recorder).keyBarFrames.length >= count + 3, before, { timeout: 5_000 });
        assert.equal(await ctrl.getAttribute("aria-pressed"), "true", "Ctrl stays held while the hardware key repeats");
        await page.keyboard.up("ArrowLeft");
        assert.deepEqual(leftKeys(await framesSince(page, before)), ["ctrl+left", "ctrl+left", "ctrl+left"], "every auto-repeat carries Ctrl");
        assert.equal(await ctrl.getAttribute("aria-pressed"), "false", "letting the hardware key up lets Ctrl go");
        console.log("PASS a hardware key's auto-repeat keeps Ctrl held for one key until the key is let up");

        await ctrl.tap();
        const altRight = bar.getByRole("button", { name: "Press Alt+Right", exact: true });
        before = (await framesOf(page)).length;
        await hold(page, cdp, altRight, HOLD_MS);
        const comboKeys = sentKeys(await framesSince(page, before));
        assert.ok(comboKeys.length >= 5 && comboKeys.every((key) => key === "alt+right"), `the saved Alt+Right repeats as itself: ${JSON.stringify(comboKeys)}`);
        assert.equal(await ctrl.getAttribute("data-latch"), "once", "releasing a held saved combination leaves Ctrl held for one key");
        await ctrl.tap();
        await ctrl.tap();
        assert.equal(await ctrl.getAttribute("aria-pressed"), "false");
        await bar.evaluate((row) => { row.scrollLeft = 0; });
        console.log(`PASS a held saved combination repeats its own chord (${comboKeys.length} keys) and leaves a once-held Ctrl alone`);

        await hold(page, cdp, left, KEY_REPEAT_DELAY_MS + KEY_REPEAT_INTERVAL_MS, async () => {
          const prevented = await left.evaluate((key) => {
            const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
            const allowed = key.dispatchEvent(event);
            return { defaultPrevented: event.defaultPrevented, allowed };
          });
          assert.deepEqual(prevented, { defaultPrevented: true, allowed: false }, "held keys prevent the contextmenu default");
        });
        console.log("PASS a held arrow prevents the contextmenu default");

        // 8. Outside iOS the terminal's helper textarea keeps xterm's own empty, unwrapped field.
        const helper = page.locator(".xterm-helper-textarea");
        assert.deepEqual(await helper.evaluate((field: HTMLTextAreaElement) => ({ value: field.value, wrap: getComputedStyle(field).whiteSpace })),
          { value: "", wrap: "nowrap" }, "a non-iOS phone keeps xterm's helper textarea as it was");
        console.log("PASS outside iOS the helper textarea stays empty and unwrapped");

        const more = page.locator('.key-bar > .key[data-key="more"]');
        await helper.focus();
        assert.equal(await more.getAttribute("aria-expanded"), "false");
        await more.tap();
        await page.locator(".key-bar.is-expanded .key-bar-arrow-pad").waitFor();
        assert.equal(await more.getAttribute("aria-expanded"), "true");
        assert.equal(await more.getAttribute("aria-label"), "Fewer keys");
        assert.equal(await helper.evaluate((node) => document.activeElement === node), true, "More keys keeps the typing focus");
        assert.deepEqual(await page.locator(".key-bar-second-row [data-key]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-key"))),
          ["Escape", "Tab", "pipe", "tilde", "slash", "-"]);
        const rowKeys = await bar.locator("[data-key]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-key")));
        for (const key of ["Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) assert.ok(!rowKeys.includes(key), `the row leaves out ${key} the second row or the pad shows`);
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings")!).keyBarExpanded), true, "the open bar is saved for this device");
        const padBoxes = await page.locator(".key-bar-arrow-pad .key").evaluateAll((nodes) => Object.fromEntries(nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return [node.getAttribute("data-key"), { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), right: box.right }];
        })));
        assert.equal(padBoxes.ArrowUp.x, padBoxes.ArrowDown.x, "Up stands over Down");
        assert.ok(padBoxes.ArrowUp.y < padBoxes.ArrowDown.y && padBoxes.ArrowLeft.y === padBoxes.ArrowDown.y && padBoxes.ArrowRight.y === padBoxes.ArrowDown.y, "Left, Down and Right share the lower row");
        assert.ok(padBoxes.ArrowLeft.x < padBoxes.ArrowDown.x && padBoxes.ArrowDown.x < padBoxes.ArrowRight.x && padBoxes.ArrowRight.right <= 393, "the pad fits the screen");
        const padUp = page.locator('.key-bar-arrow-pad .key[data-key="ArrowUp"]');
        before = (await framesOf(page)).length;
        const padRelease = await hold(page, cdp, padUp, HOLD_MS);
        const upKeys = sentKeys(await framesSince(page, before));
        assert.ok(upKeys.length >= 5 && upKeys.every((key) => key === "up"), `the pad's Up repeats while held: ${JSON.stringify(upKeys)}`);
        assert.equal((await framesOf(page)).length, padRelease, "the pad's Up stops on release with no extra click");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "the open bar adds no sideways page scroll");
        await more.tap();
        await page.locator(".key-bar-arrow-pad").waitFor({ state: "detached" });
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings")!).keyBarExpanded), false);
        console.log(`PASS More keys opens the second row and the arrow pad (Up repeated ${upKeys.length} keys) without taking the focus, and closes again`);

        if (evidence) {
          mkdirSync(evidence, { recursive: true });
          await page.screenshot({ path: join(evidence, "key-bar-hold-repeat-phone.png") });
        }
        assert.deepEqual(errors, [], "the phone demo has no page errors");
      } finally { await context.close(); }

      // 9. iOS repeats its keyboard's held ⌫ only while the focused field has text and wraps
      // (#862): the helper textarea keeps one space and pre-wrap, and the space never reaches the pane.
      const iphone = await browser.newContext({
        viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, locale: "en-US",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
      });
      try {
        await iphone.addInitScript(({ pane }) => {
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "direct" }));
          localStorage.setItem(`ovis:view:${pane}`, "terminal");
        }, { pane: panes.api });
        const page = await iphone.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.api)}`);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.key-bar .key[data-key="ArrowLeft"]')?.disabled === false, undefined, { timeout: 5_000 });
        const helper = page.locator(".pane-frame.is-current .xterm-helper-textarea");
        await helper.focus();
        const field = () => helper.evaluate((element: HTMLTextAreaElement) => ({ value: element.value, caret: element.selectionStart, wrap: getComputedStyle(element).whiteSpace }));
        assert.deepEqual(await field(), { value: " ", caret: 1, wrap: "pre-wrap" }, "focus leaves one space before the caret in a wrapping field");
        const before = (await framesOf(page)).length;
        for (let press = 0; press < 3; press += 1) {
          await page.keyboard.press("Backspace");
          assert.deepEqual(await field(), { value: " ", caret: 1, wrap: "pre-wrap" }, "the field still holds its space after each Backspace");
        }
        await page.keyboard.type("ab");
        await page.keyboard.press("Enter");
        assert.equal((await field()).value, " ", "Enter empties the field back to its one space");
        // fixed wait: proves the space never follows the typed input out
        await Bun.sleep(NO_SEND_WAIT_MS);
        const sent = (await framesSince(page, before)).flatMap((frame) => frame.type === "input" ? [...frame.text] : frame.keys);
        assert.deepEqual(sent, ["\x7f", "\x7f", "\x7f", "a", "b", "\r"], `only the typed keys reach the pane: ${JSON.stringify(sent)}`);
        assert.deepEqual(errors, [], "the iPhone demo has no page errors");
        console.log("PASS on iOS the helper textarea keeps one space and wraps, and only typed keys reach the pane");
      } finally { await iphone.close(); }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
