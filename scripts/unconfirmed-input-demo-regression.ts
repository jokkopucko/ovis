/**
 * Typing the socket accepted just before its connection closes (#2587), on the real client over the
 * demo's fixture transport: the frames leave the page but never reach the server (a relay carrier that
 * stopped before the mux wrote them, or a socket gone half-open), then the connection closes. Nothing
 * confirmed them, so the text comes back as held input for the user to send or discard, and nothing is
 * sent on its own after the reconnect. Held text that looks like a key stays on screen but is never
 * written to storage.
 */
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { installClock } from "./app-context.ts";
import { withDemoBrowser } from "./demo-browser.ts";
import { shownRows } from "./shown-rows.ts";

const SETTINGS_KEY = "ovis:settings";

interface Frame { type: string; text?: string }
type QaWindow = Window & {
  delivered: Frame[];
  swallowed: Frame[];
  blackhole: boolean;
  recordedSockets: WebSocket[];
};

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

const typedText = (frames: Frame[]): string => frames.filter((frame) => frame.type === "input").map((frame) => frame.text ?? "").join("");

async function open(page: Page, origin: string): Promise<void> {
  await installClock(page);
  await page.goto(`${origin}?pane=${encodeURIComponent(panes.shell)}&view=terminal`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(shownRows(".pane-frame:not(.is-hidden)")).first().waitFor();
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>(".pane-frame:not(.is-hidden) .xterm-helper-textarea")?.disabled);
  await page.locator(".pane-frame:not(.is-hidden) .xterm-helper-textarea").focus();
}

async function typeThenDrop(page: Page, text: string): Promise<{ held: string | null; swallowed: string }> {
  await page.evaluate(() => { (window as unknown as QaWindow).blackhole = true; });
  await page.keyboard.type(text);
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1_000);
  await page.evaluate(() => { (window as unknown as QaWindow).recordedSockets.at(-1)!.close(); });
  await page.locator(".pane-frame:not(.is-hidden) .terminal-banner-warning").waitFor();
  const held = await page.evaluate(() => document.querySelector(".pane-frame:not(.is-hidden) .terminal-banner-warning .draft-held code")?.textContent ?? null);
  const swallowed = await page.evaluate(() => (window as unknown as QaWindow).swallowed);
  await page.evaluate(() => { (window as unknown as QaWindow).blackhole = false; });
  return { held, swallowed: typedText(swallowed) };
}

await withDemoBrowser({ tempPrefix: "herdr-unconfirmed-input-demo-", afterTransport: `\n    ${LOSSY}` }, async ({ newContext, baseUrl: origin }) => {
  const scenario = async (text: string): Promise<{ held: string | null; swallowed: string; resent: string; stored: string[] }> => {
    const context = await newContext({ viewport: { width: 1280, height: 800 } });
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
});
