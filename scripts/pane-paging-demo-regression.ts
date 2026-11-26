import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { openSettingsPage } from "./settings-page.ts";
import { appFaces } from "./app-faces.ts";
import { serveDemo } from "./demo-server.ts";
import { checkChromeTmpdir } from "./chrome-path.ts";

const app = mkdtempSync(join(tmpdir(), "herdr-pane-paging-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;
const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const returnControl = (page: Page) => page.locator(".pane-frame.is-current .chat-new-messages");
const inputs = (page: Page): Promise<unknown[]> => page.evaluate(() => (window as unknown as { pagingInputs: unknown[] }).pagingInputs);
const scrollGeometry = (page: Page) => page.evaluate(() => {
  const node = document.querySelector<HTMLElement>(".pane-frame.is-current .chat-view");
  if (!node) return null;
  const content = node.firstElementChild as HTMLElement | null;
  return { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
    gap: node.scrollHeight - node.clientHeight - node.scrollTop, rectHeight: node.getBoundingClientRect().height,
    inlineStyle: node.getAttribute("style"), computedHeight: getComputedStyle(node).height,
    content: content && { height: content.getBoundingClientRect().height, inlineStyle: content.getAttribute("style"), source: content.dataset.conversationSource },
    returnControls: [...document.querySelectorAll<HTMLElement>(".pane-frame.is-current .chat-new-messages")].map((button) => ({ label: button.getAttribute("aria-label"), text: button.textContent, className: button.className, height: button.getBoundingClientRect().height })),
    loading: node.querySelector(".chat-inline-state")?.textContent ?? null };
});
// The demo's api pane opens mid-turn and ends that turn 4.5 s later (site/demo/transport.ts): the
// answer lands and the work block folds, so the transcript's height changes under the reader. Paging
// asserts exact scroll positions, so it starts only once that turn has ended and its fold has settled.
async function demoTurnEnded(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const transcript = document.querySelector(".pane-frame.is-current .chat-view");
    const last = transcript ? [...transcript.querySelectorAll(".chat-turn-agent")].at(-1) : undefined;
    return last !== undefined && last.querySelector(".chat-agent-meta") !== null && transcript!.querySelector(".work-block.is-live, .animated-height.is-moving") === null;
  }, undefined, { timeout: 20000 });
  await settled(page);
}
async function followedBottom(page: Page, phase: string): Promise<void> {
  try {
    await page.waitForFunction(() => {
      const node = document.querySelector(".pane-frame.is-current .chat-view");
      return node !== null && Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) < 1;
    }, undefined, { timeout: 10000 });
  } catch (cause) {
    console.error("Paging follow failed", JSON.stringify({ phase, geometry: await scrollGeometry(page) }, null, 2));
    if (evidence) {
      try { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `paging-${phase}-failure.png`), timeout: 5000 }); }
      catch (capture) { console.error("Paging failure capture failed", String(capture)); }
    }
    throw new Error(`Paging did not restore following at ${phase}`, { cause });
  }
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const record = `<script>(() => {
    const Demo = window.WebSocket;
    window.pagingInputs = [];
    window.WebSocket = function (url, protocols) {
      const socket = new Demo(url, protocols);
      const send = socket.send.bind(socket);
      socket.send = (raw) => {
        const frame = JSON.parse(String(raw));
        if (["input", "keys", "submit"].includes(frame.type)) window.pagingInputs.push(frame);
        send(raw);
      };
      return socket;
    };
    for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(window.WebSocket, name, { value: Demo[name] });
  })();</script>`;
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n${record}\n<script type="module"`));
  const prefix = "/herdr-web-ui/demo/app/";
  const server = serveDemo(app, { prefix });
  try {
    checkChromeTmpdir();
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
    try {
      checkChromeTmpdir();
      const fractionalBrowser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox", "--force-device-scale-factor=1.25"] });
      const fractional = await fractionalBrowser.newContext({ viewport: { width: 1024, height: 600 }, deviceScaleFactor: 1.25, locale: "en-US" });
      try {
        await fractional.addInitScript(() => {
          Object.defineProperty(navigator, "platform", { configurable: true, value: "iPad" });
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", alertsOn: false }));
        });
        const page = await fractional.newPage();
        page.setDefaultTimeout(10000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}${prefix}?pane=${encodeURIComponent(panes.api)}&view=chat`);
        await page.locator(".conn-live").waitFor();
        await appFaces(page);
        const transcript = page.locator(".pane-frame.is-current .chat-view");
        await transcript.locator(".chat-turn-agent").first().waitFor();
        await demoTurnEnded(page);
        await page.locator(".pane-frame.is-current .composer-text").focus();
        await transcript.evaluate((node: HTMLElement) => {
          node.dataset.fractionalPaging = "";
          node.style.height = "100.25px"; node.style.bottom = "auto"; node.style.padding = "0";
          const content = node.firstElementChild as HTMLElement;
          content.style.minHeight = "0"; content.style.height = "200.75px"; content.style.overflow = "hidden";
          const style = document.createElement("style");
          style.textContent = "[data-fractional-paging]::before { display: none; } [data-fractional-paging] :is(.chat-turn-agent > .markdown, .chat-bubble) { line-height: 1000px; }";
          document.head.append(style);
          node.scrollTop = node.scrollHeight;
          node.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        await settled(page);
        const beforeInput = await inputs(page);
        const geometry = await transcript.evaluate((node) => ({ scale: devicePixelRatio, height: node.getBoundingClientRect().height, gap: node.scrollHeight - node.clientHeight - node.scrollTop }));
        assert.equal(geometry.scale, 1.25);
        assert.ok(geometry.height % 1 !== 0, "the owned fixture has a fractional viewport height");
        assert.ok(geometry.gap > 0 && geometry.gap < 1, "the physically clamped end still has a positive rounded-DOM gap");
        await page.keyboard.press("Meta+Shift+PageUp");
        await settled(page);
        const paged = await transcript.evaluate((node) => node.scrollTop);
        await returnControl(page).waitFor();
        await transcript.evaluate((node: HTMLElement) => { node.style.height = "99.25px"; });
        await settled(page);
        assert.ok(Math.abs(await transcript.evaluate((node) => node.scrollTop) - paged) < 0.5, "one-pixel upward intent survives deferred scroll and fractional resize");
        await transcript.evaluate((node: HTMLElement) => { node.style.height = "100.25px"; });
        await settled(page);
        const clamped = await transcript.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
          const before = node.scrollTop;
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", code: "PageDown", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
          return { before, after: node.scrollTop, gap: node.scrollHeight - node.clientHeight - node.scrollTop };
        });
        assert.equal(clamped.after, clamped.before, "the explicit downward page has no available movement at the physical end");
        assert.ok(clamped.gap > 0 && clamped.gap < 1, "the clamped downward page keeps the rounded gap");
        await settled(page);
        await returnControl(page).waitFor({ state: "hidden" });
        await transcript.evaluate((node: HTMLElement) => { node.style.height = "99.25px"; });
        await settled(page);
        await followedBottom(page, "fractional-clamped-down");
        await page.keyboard.press("Meta+Shift+PageUp");
        await settled(page);
        await returnControl(page).waitFor();
        await transcript.evaluate((node) => { node.scrollTop = node.scrollHeight; });
        await settled(page);
        await returnControl(page).waitFor({ state: "hidden" });
        await page.keyboard.press("Meta+Shift+PageUp");
        await settled(page);
        await returnControl(page).waitFor();
        for (let pages = 0; await returnControl(page).count() > 0; pages++) {
          assert.ok(pages < 128, "repeated downward pages reach a fractional end within a bound");
          await page.keyboard.press("Meta+Shift+PageDown");
          await settled(page);
        }
        await transcript.evaluate((node: HTMLElement) => { node.style.height = "98.25px"; });
        await settled(page);
        await followedBottom(page, "fractional-repeat-down");
        assert.deepEqual(await inputs(page), beforeInput, "fractional paging never sends terminal input");
        assert.deepEqual(errors, []);
        console.log("PASS pane paging: fractional scale, upward intent, clamped PageDown, manual end, repeated downward pages");
      } finally { await fractional.close(); await fractionalBrowser.close(); }
      for (const touch of [false, true]) {
        const context = await browser.newContext({ viewport: { width: 1024, height: 600 }, hasTouch: touch, locale: "en-US" });
        try {
          await context.addInitScript(() => {
            Object.defineProperty(navigator, "platform", { configurable: true, value: "iPad" });
            if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", alertsOn: false, chatFontSize: 19 }));
          });
          const page = await context.newPage();
          page.setDefaultTimeout(10000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}${prefix}?pane=${encodeURIComponent(panes.api)}&view=chat`);
          await page.locator(".conn-live").waitFor();
          await appFaces(page);
          const transcript = page.locator(".pane-frame.is-current .chat-view");
          const composer = page.locator(".pane-frame.is-current .composer-text");
          await composer.waitFor();
          await page.waitForFunction(() => { const node = document.querySelector(".pane-frame.is-current .chat-view")!; return node.scrollHeight > node.clientHeight + 100; });
          await demoTurnEnded(page);
          await composer.fill("Keep this draft\nand its selection");
          await composer.evaluate((node: HTMLTextAreaElement) => { node.focus(); node.setSelectionRange(5, 15); });
          const beforeInput = await inputs(page);
          const beforeSelection = await composer.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]);
          await transcript.evaluate((node) => { node.scrollTop = node.scrollHeight; });
          await settled(page);
          const modalBottom = await transcript.evaluate((node) => node.scrollTop);
          await page.keyboard.press("Meta+Shift+Comma");
          await openSettingsPage(page, "Chat");
          await page.keyboard.press("PageUp");
          assert.equal(await transcript.evaluate((node) => node.scrollTop), modalBottom, "a modal owns its plain page keys");
          await page.keyboard.press("Escape");
          await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor({ state: "hidden" });
          await composer.evaluate((node: HTMLTextAreaElement) => { node.focus(); node.setSelectionRange(5, 15); });
          await transcript.evaluate((node) => { node.scrollTop = node.scrollHeight; });
          await settled(page);
          const plainBottom = await transcript.evaluate((node) => node.scrollTop);
          const plainStep = await transcript.evaluate((node) => Math.max(1, node.clientHeight - parseFloat(getComputedStyle(node.querySelector(".chat-turn-agent > .markdown, .chat-bubble") ?? node).lineHeight)));
          await page.keyboard.press("PageUp");
          await settled(page);
          assert.ok(Math.abs(plainBottom - await transcript.evaluate((node) => node.scrollTop) - plainStep) <= 1, "plain chat PageUp keeps one line between pages");
          assert.deepEqual(await composer.evaluate((node: HTMLTextAreaElement) => [node.value, node.selectionStart, node.selectionEnd, document.activeElement === node]), ["Keep this draft\nand its selection", 5, 15, true]);
          await page.keyboard.press("PageDown");
          await transcript.evaluate((node) => { node.scrollTop = node.scrollHeight; });
          await settled(page);
          const guardedBottom = await transcript.evaluate((node) => node.scrollTop);
          await composer.dispatchEvent("keydown", { key: "PageUp", isComposing: true, bubbles: true, cancelable: true });
          assert.equal(await transcript.evaluate((node) => node.scrollTop), guardedBottom, "composition retains plain page keys");
          await page.evaluate(() => {
            const field = document.createElement("textarea"); field.id = "owned-paging-editable";
            document.querySelector(".pane-frame.is-current")!.append(field); field.focus();
          });
          await settled(page);
          assert.equal(await page.evaluate(() => document.activeElement?.id), "owned-paging-editable");
          const editableBottom = await transcript.evaluate((node) => node.scrollTop);
          await page.keyboard.press("PageUp");
          await settled(page);
          assert.equal(await transcript.evaluate((node) => node.scrollTop), editableBottom, `other editable controls retain their plain page keys: ${JSON.stringify(await scrollGeometry(page))}`);
          await page.evaluate(() => document.querySelector("#owned-paging-editable")!.remove());
          await settled(page);
          await composer.evaluate((node: HTMLTextAreaElement) => { node.focus(); node.setSelectionRange(5, 15); });
          assert.deepEqual(await inputs(page), beforeInput, "plain chat paging never sends pane input");

          {
            await transcript.evaluate((node) => { node.scrollTop = node.scrollHeight; });
            await settled(page);
            const bottom = await transcript.evaluate((node) => node.scrollTop);
            const step = await transcript.evaluate((node) => Math.max(1, node.clientHeight - parseFloat(getComputedStyle(node.querySelector(".chat-turn-agent > .markdown, .chat-bubble") ?? node).lineHeight)));
            await page.keyboard.press("Meta+Shift+PageUp");
            assert.ok(Math.abs(bottom - await transcript.evaluate((node) => node.scrollTop) - step) <= 1, "chat instantly pages, keeping one line");
            await settled(page);
            assert.ok(Math.abs(bottom - await transcript.evaluate((node) => node.scrollTop) - step) <= 1, "the bottom-pinning effect leaves paged history in place");
            assert.equal(await composer.inputValue(), "Keep this draft\nand its selection");
            assert.deepEqual(await composer.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]), beforeSelection);
            assert.ok(await composer.evaluate((node) => document.activeElement === node), "paging leaves the composer focused");
            if (touch && evidence) {
              mkdirSync(evidence, { recursive: true });
              await page.screenshot({ path: join(evidence, "ipad-chat-paging.png") });
            }
            await page.keyboard.press("Meta+Shift+PageDown");
            assert.ok(Math.abs(await transcript.evaluate((node) => node.scrollTop) - bottom) <= 1, "opposite page returns to the same bottom");
            await settled(page);
            await returnControl(page).waitFor({ state: "hidden" });
            await transcript.evaluate((node) => { node.scrollTop -= 1; node.dispatchEvent(new Event("scroll", { bubbles: true })); });
            await settled(page);
            assert.equal(await returnControl(page).count(), 0, "ordinary manual near-bottom scrolling retains its existing follow tolerance");
          }
          assert.deepEqual(await inputs(page), beforeInput, "paging never sends pane input");
          await page.keyboard.press("Meta+Shift+Comma");
          await openSettingsPage(page, "Shortcuts");
          await page.getByRole("combobox", { name: "Scroll pane up", exact: true }).selectOption("u");
          await page.getByRole("combobox", { name: "Scroll pane down", exact: true }).selectOption("d");
          const bottom = await transcript.evaluate((node) => node.scrollTop);
          await page.keyboard.press("Meta+Shift+U");
          await settled(page);
          assert.equal(await transcript.evaluate((node) => node.scrollTop), bottom, "a modal blocks pane paging");
          assert.ok(await page.getByRole("dialog", { name: "Settings", exact: true }).evaluate((node) => node.contains(document.activeElement)), "paging cannot move focus out of Settings");
          await page.keyboard.press("Escape");
          await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor({ state: "hidden" });
          await composer.focus();
          await transcript.evaluate((node) => { node.scrollTop = node.scrollHeight; });
          await settled(page);
          const remappedBottom = await transcript.evaluate((node) => node.scrollTop);
          await page.keyboard.press("Meta+Shift+U");
          assert.ok(await transcript.evaluate((node) => node.scrollTop) < remappedBottom - 50, "letter overrides page without dedicated iPad PageUp keys");
          await page.keyboard.press("Meta+Shift+D");
          await page.reload();
          await page.locator(".conn-live").waitFor();
          await composer.waitFor();
          await demoTurnEnded(page);
          await page.keyboard.press("Meta+Shift+Comma");
          await openSettingsPage(page, "Shortcuts");
          assert.equal(await page.getByRole("combobox", { name: "Scroll pane up", exact: true }).inputValue(), "u", "paging overrides survive reload");
          await page.getByRole("combobox", { name: "Scroll pane up", exact: true }).selectOption("off");
          await page.keyboard.press("Escape");
          await composer.focus();
          await transcript.evaluate((node) => { node.scrollTop = node.scrollHeight; });
          const disabledBottom = await transcript.evaluate((node) => node.scrollTop);
          await page.keyboard.press("Meta+Shift+PageUp");
          await settled(page);
          assert.equal(await transcript.evaluate((node) => node.scrollTop), disabledBottom, "disabled paging restores the key to the focused control");

          await page.keyboard.press("Meta+Shift+Comma");
          await openSettingsPage(page, "Shortcuts");
          await page.getByRole("combobox", { name: "Scroll pane up", exact: true }).selectOption("default");
          await page.keyboard.press("Escape");
          await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor({ state: "hidden" });
          for (let pages = 0; ; pages++) {
            assert.ok(pages < 128, "repeated upward pages reach the history start within a bound");
            await page.keyboard.press("Meta+Shift+PageUp");
            await settled(page);
            if (await transcript.evaluate((node) => node.scrollTop === 0)) break;
          }
          await returnControl(page).waitFor();
          await page.keyboard.press("Meta+Shift+PageUp");
          await settled(page);
          assert.equal(await transcript.evaluate((node) => node.scrollTop), 0, "PageUp at the history start has no movement");
          assert.equal(await returnControl(page).count(), 1, "unavailable upward movement leaves the reader away");
          await transcript.evaluate((node) => { (node.firstElementChild as HTMLElement).style.display = "none"; node.scrollTop = 0; node.dispatchEvent(new Event("scroll", { bubbles: true })); });
          await settled(page);
          assert.equal(await transcript.evaluate((node) => node.scrollHeight > node.clientHeight), false, "the fixture now has no scrollable history");
          await page.keyboard.press("Meta+Shift+PageUp");
          await page.keyboard.press("Meta+Shift+D");
          await settled(page);
          assert.equal(await returnControl(page).count(), 0, "paging without available movement does not mark the chat away");
          assert.deepEqual(errors, []);
          console.log(`PASS pane paging: ${touch ? "iPad keyboard" : "desktop"}, overlap, caret, selection, modal gate, override, reload`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
