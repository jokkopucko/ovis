import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { serveDemo } from "./demo-server.ts";

const app = mkdtempSync(join(tmpdir(), "herdr-narrow-pane-demo-"));
const BASE_PX = 13;
const MIN_PX = 10;
const COLS = 80;
const APP_COMMANDS = ["direct", "paste", "keyboard", "more"];

interface Drawn { id: string; px: number; cols: number | null }
interface Want { panes: number; font: "base" | "shrunk"; cols: "fits" | "narrow" }
interface Stop { key: string | null; where: "bar" | "line" | "grid" | "page" }

async function settled(page: Page, want: Want, label: string): Promise<Drawn[]> {
  const read = (): Promise<Drawn[]> => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".pane-frame:not(.is-hidden)")].map((frame) => {
    const id = frame.dataset["layoutPane"] ?? "";
    const rows = frame.querySelector(".ghostty-text");
    return { id, px: rows ? parseFloat(getComputedStyle(rows).fontSize) : 0, cols: (window as unknown as { sentCols: Record<string, number> }).sentCols[id] ?? null };
  }));
  const matches = (drawn: Drawn[]): boolean => drawn.length === want.panes && drawn.every((pane) =>
    (want.font === "base" ? pane.px === BASE_PX : pane.px < BASE_PX && pane.px >= MIN_PX)
    && pane.cols !== null && (want.cols === "fits" ? pane.cols >= COLS : pane.cols < COLS));
  const deadline = Date.now() + 10_000;
  let drawn = await read();
  while (!matches(drawn)) {
    assert(Date.now() < deadline, `${label}: wanted ${JSON.stringify(want)}, drew ${JSON.stringify(drawn)}`);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    drawn = await read();
  }
  return drawn;
}

async function until<T>(page: Page, label: string, check: (arg: T) => boolean, arg: T): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await page.evaluate(check, arg))) {
    assert(Date.now() < deadline, label);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
}

async function focusStops(page: Page, key: "Tab" | "Shift+Tab", count: number): Promise<Stop[]> {
  const stops: Stop[] = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press(key);
    stops.push(await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      const where = el?.closest(".key-bar") ? "bar" : el?.closest(".terminal-input-slot") ? "line" : el?.classList.contains("xterm-helper-textarea") ? "grid" : "page";
      return { key: el?.dataset["key"] ?? null, where };
    }));
  }
  return stops;
}

const activeKey = (page: Page): Promise<string | null> => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset["key"] ?? null);

const lineOpen = (open: boolean): boolean => (document.querySelector(".pane-frame.is-current .terminal-input-text") !== null) === open
  && document.querySelector('.pane-frame.is-current .key-bar [data-key="direct"]')?.getAttribute("aria-pressed") === String(open);

const layout = async (page: Page, path: string, body: Record<string, unknown>): Promise<void> => {
  const status = await page.evaluate(async ([url, payload]) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload })).status,
    [path, JSON.stringify(body)] as const);
  assert.equal(status, 200, `${path} answered ${status}`);
};

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const record = `<script>(() => {
    const Demo = window.WebSocket;
    window.sentCols = {};
    const Recorded = function (url, protocols) {
      const socket = new Demo(url, protocols);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") { const frame = JSON.parse(data); if (frame.type === "resize" || frame.type === "attach") window.sentCols[frame.pane_id] = frame.cols; }
        send(data);
      };
      return socket;
    };
    for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(Recorded, name, { value: Demo[name] });
    window.WebSocket = Recorded;
  })();</script>`;
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${record}\n    <script type="module"`));
  const server = serveDemo(app);
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ viewport: { width: 1700, height: 900 }, locale: "en-US" });
      await context.addInitScript(() => {
        // These viewport thresholds require fixed font metrics: the default terminal stack uses
        // installed fonts, and Noto Sans Mono CJK KR already fits 84 columns at 1450px and 13px.
        if (!localStorage.getItem("ovis:settings")) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalFontFamily: "JetBrains Mono Web" }));
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.shell)}`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      const saved = (): Promise<number | undefined> => page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").terminalFontSize as number | undefined);

      await settled(page, { panes: 1, font: "base", cols: "fits" }, "a pane alone");
      await layout(page, "/api/pane/split", { pane_id: panes.shell, direction: "right", focus: true });
      await settled(page, { panes: 2, font: "base", cols: "fits" }, "a split wide enough");

      await page.setViewportSize({ width: 1450, height: 900 });
      const narrowSplit = await settled(page, { panes: 2, font: "base", cols: "narrow" }, "a split under 80 columns keeps the user's font size");

      await page.setViewportSize({ width: 1200, height: 900 });
      await settled(page, { panes: 2, font: "base", cols: "narrow" }, "a narrower split still keeps the user's font size");
      await page.setViewportSize({ width: 1450, height: 900 });
      await settled(page, { panes: 2, font: "base", cols: "narrow" }, "the split at 1450px keeps the user's font size");

      await layout(page, "/api/pane/zoom", { pane_id: panes.shell, mode: "on" });
      await settled(page, { panes: 1, font: "base", cols: "fits" }, "the pane zoomed reaches 80+ columns at the user's font size");
      await layout(page, "/api/pane/zoom", { pane_id: panes.shell, mode: "off" });
      await settled(page, { panes: 2, font: "base", cols: "narrow" }, "the pane unzoomed keeps the user's font size");

      await page.setViewportSize({ width: 1700, height: 900 });
      await settled(page, { panes: 2, font: "base", cols: "fits" }, "the split widened");

      const size = await saved();
      assert(size === undefined || size === BASE_PX, `the saved font stayed ${BASE_PX}px (saved ${size})`);
      assert.deepEqual(errors, []);
      console.log(`narrow pane: ${narrowSplit.map((pane) => `${pane.px}px for ${pane.cols} columns`).join(", ")} at 1450px; the user's ${BASE_PX}px kept everywhere`);

      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      try {
        await phone.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "direct" })));
        const phonePage = await phone.newPage();
        phonePage.on("pageerror", (error) => errors.push(error.message));
        await phonePage.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.shell)}&view=terminal`);
        await phonePage.locator(".conn-live").waitFor({ state: "attached" });
        await until(phonePage, "the key bar's Input line key is live", () => {
          const key = document.querySelector<HTMLButtonElement>('.pane-frame.is-current .key-bar [data-key="direct"]');
          return key !== null && !key.disabled;
        }, undefined);
        await phonePage.evaluate(() => {
          const start = Object.assign(document.createElement("div"), { tabIndex: -1, id: "tab-order-start" });
          document.querySelector(".pane-frame.is-current .key-bar")!.before(start);
          start.focus();
        });
        const direct = await focusStops(phonePage, "Tab", APP_COMMANDS.length + 1);
        await phonePage.evaluate(() => document.getElementById("tab-order-start")?.remove());
        assert.deepEqual(direct.map((stop) => stop.key), [...APP_COMMANDS, null], `direct mode: Tab visits the app commands, then leaves the bar (${JSON.stringify(direct)})`);
        assert(direct.slice(0, APP_COMMANDS.length).every((stop) => stop.where === "bar"), `direct mode: the stops are the bar's (${JSON.stringify(direct)})`);

        await focusStops(phonePage, "Shift+Tab", APP_COMMANDS.length);
        assert.equal(await activeKey(phonePage), "direct", "Shift+Tab comes back to Input line");
        await phonePage.keyboard.press("Enter");
        await until(phonePage, "Enter on Input line opens the input line", lineOpen, true);

        await phonePage.locator(".pane-frame.is-current .terminal-input-text").focus();
        const line = await focusStops(phonePage, "Tab", APP_COMMANDS.length + 3);
        const first = line.findIndex((stop) => stop.where === "bar");
        assert(first >= 0 && line.slice(0, first).every((stop) => stop.where === "line"), `line mode: Tab leaves the line for its own buttons, then the bar (${JSON.stringify(line)})`);
        assert.deepEqual(line.filter((stop) => stop.where === "bar").map((stop) => stop.key), APP_COMMANDS, `line mode: the bar's stops are the app commands (${JSON.stringify(line)})`);

        for (let i = 0; i < line.length && (await activeKey(phonePage)) !== "direct"; i++) await phonePage.keyboard.press("Shift+Tab");
        assert.equal(await activeKey(phonePage), "direct", "Shift+Tab comes back to Input line from the page's end");
        await phonePage.keyboard.press("Space");
        await until(phonePage, "Space on Input line closes the input line", lineOpen, false);
        const [next] = await focusStops(phonePage, "Tab", 1);
        assert.equal(next?.key, "paste", `direct mode again: Tab from Input line reaches Paste (${JSON.stringify(next)})`);
        assert.deepEqual(errors, []);
        console.log(`key bar: Tab stops ${APP_COMMANDS.join(", ")} in both modes; the input line's Tab leaves it after ${first} of its own; Enter and Space on Input line switch the mode`);
      } finally { await phone.close(); }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
