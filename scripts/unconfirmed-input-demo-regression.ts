/**
 * Typing the socket accepted just before its connection closes (#2587), on the real client over the
 * demo's fixture transport: the frames leave the page but never reach the server (a relay carrier that
 * stopped before the mux wrote them, or a socket gone half-open), then the connection closes. Nothing
 * confirmed them, so the text comes back as held input for the user to send or discard, and nothing is
 * sent on its own after the reconnect. Held text that looks like a key stays on screen but is never
 * written to storage.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const SETTINGS_KEY = "ovis:settings";
const PREFIX = "/herdr-web-ui/demo/app/";

interface Frame { type: string; text?: string }
type QaWindow = Window & {
  /** frames the demo server read */
  delivered: Frame[];
  /** frames that left the page but never reached the server */
  swallowed: Frame[];
  /** while true, sends are accepted and lost */
  blackhole: boolean;
  recordedSockets: WebSocket[];
};

/** The demo's socket, with a switch that loses what is sent while the socket still reads OPEN. */
const LOSSY = `<script>(() => {
  const Demo = window.WebSocket;
  window.delivered = [];
  window.swallowed = [];
  window.blackhole = false;
  window.recordedSockets = [];
  const Lossy = function (url, protocols) {
    const socket = new Demo(url, protocols);
    window.recordedSockets.push(socket);
    const send = socket.send.bind(socket);
    socket.send = (raw) => {
      let frame = null;
      if (typeof raw === "string") { try { frame = JSON.parse(raw); } catch {} }
      if (window.blackhole) { if (frame) window.swallowed.push(frame); return; }
      if (frame) window.delivered.push(frame);
      send(raw);
    };
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(Lossy, name, { value: Demo[name] });
  window.WebSocket = Lossy;
})();</script>`;

const app = mkdtempSync(join(tmpdir(), "herdr-unconfirmed-input-demo-"));

const typedText = (frames: Frame[]): string => frames.filter((frame) => frame.type === "input").map((frame) => frame.text ?? "").join("");

async function open(page: Page, origin: string): Promise<void> {
  await page.clock.install();
  await page.goto(`${origin}?pane=${encodeURIComponent(panes.shell)}&view=terminal`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(".pane-frame:not(.is-hidden) .xterm-rows").waitFor();
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>(".pane-frame:not(.is-hidden) .xterm-helper-textarea")?.disabled);
  await page.locator(".pane-frame:not(.is-hidden) .xterm-helper-textarea").focus();
}

/** Types `text` into a socket that loses it, then drops the connection with the reconnect held back. */
async function typeThenDrop(page: Page, text: string): Promise<{ held: string | null; swallowed: string }> {
  await page.evaluate(() => { (window as unknown as QaWindow).blackhole = true; });
  await page.keyboard.type(text);
  // the reconnect waits until the clock resumes, so the offline banner can be read
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1_000);
  await page.evaluate(() => { (window as unknown as QaWindow).recordedSockets.at(-1)!.close(); });
  await page.locator(".pane-frame:not(.is-hidden) .terminal-banner-warning").waitFor();
  const held = await page.evaluate(() => document.querySelector(".pane-frame:not(.is-hidden) .terminal-banner-warning .draft-held code")?.textContent ?? null);
  const swallowed = await page.evaluate(() => (window as unknown as QaWindow).swallowed);
  await page.evaluate(() => { (window as unknown as QaWindow).blackhole = false; });
  return { held, swallowed: typedText(swallowed) };
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${LOSSY}\n    <script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(PREFIX)) return new Response("not found", { status: 404 });
    let file = decodeURIComponent(path.slice(PREFIX.length));
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const origin = `http://127.0.0.1:${server.port}${PREFIX}`;
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  /** One fresh page: `text` typed into a socket that loses it, the drop, then the reconnect. */
  const scenario = async (text: string): Promise<{ held: string | null; swallowed: string; resent: string; stored: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    try {
      await context.addInitScript(({ key, pane }) => {
        localStorage.setItem(key, JSON.stringify({ language: "en", theme: "dark", terminalInputMode: "direct", defaultView: "terminal" }));
        localStorage.setItem(`ovis:view:${pane}`, "terminal");
      }, { key: SETTINGS_KEY, pane: panes.shell });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await open(page, origin);
      const lost = await typeThenDrop(page, text);
      await page.clock.resume();
      await page.locator(".conn-live").waitFor({ state: "attached", timeout: 20_000 });
      await page.locator(".pane-frame:not(.is-hidden) .terminal-banner-draft .draft-text, .composer-notice code").first().waitFor();
      const after = await page.evaluate(() => ({
        resent: (window as unknown as QaWindow).delivered.filter((frame) => frame.type === "input").map((frame) => frame.text).join(""),
        stored: Object.keys(localStorage).filter((key) => key.startsWith("ovis:terminal-draft:")).map((key) => localStorage.getItem(key) ?? ""),
      }));
      assert.deepEqual(errors, []);
      return { ...lost, ...after };
    } finally { await context.close(); }
  };
  try {
    const lost = await scenario("echo lost");
    console.log(`lost typing: ${JSON.stringify(lost)}`);
    assert.equal(lost.swallowed, "echo lost", "the typing left the page as input frames the server never read");
    assert.equal(lost.held, "“echo lost”", "typing the server never confirmed comes back as held input");
    console.log("PASS unconfirmed typing is held when the connection closes");
    assert.ok(!lost.resent.includes("echo lost"), `nothing held is sent after the reconnect (${JSON.stringify(lost.resent)})`);
    console.log("PASS the reconnect sends none of it");
    assert.ok(lost.stored.some((value) => value.includes("echo lost")), "held input is kept across a reload");

    const token = "export TOKEN=Ab12Cd34Ef56Gh78Ij90Kl12Mn34";
    const key = await scenario(token);
    console.log(`lost key: ${JSON.stringify({ ...key, stored: key.stored.length })}`);
    assert.equal(key.held, `“${token}”`, "a key typed and lost is held on screen like any typing");
    assert.ok(key.stored.every((value) => !value.includes("Ab12Cd34Ef56Gh78Ij90Kl12Mn34")), "but never written to storage");
    console.log("PASS held text that looks like a key is never written to storage");
  } finally { await browser.close(); server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
