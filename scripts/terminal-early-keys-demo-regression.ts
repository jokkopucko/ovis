/**
 * Keys typed into a terminal whose attach is still opening (connected, the bridge has not yet said
 * the pane takes input) are never lost in silence: text is held in the draft for review, and a key the
 * draft cannot hold (Escape) says it was not sent. None of it goes by itself once the pane takes input:
 * it was typed blind, and what the screen shows then may be a password or a y/n prompt.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { serveDemo } from "./demo-server.ts";

interface Fixture {
  sent: Array<{ type: string; pane_id?: string; text?: string; keys?: string[] }>;
  holdReady: boolean;
  heldReady: Array<() => void>;
}
declare global { interface Window { earlyKeys: Fixture } }

function installEarlyKeysFixture(): void {
  const state: Fixture = { sent: [], holdReady: true, heldReady: [] };
  window.earlyKeys = state;
  const Demo = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    const socket = new Demo(url, protocols) as WebSocket & { push(frame: { type: string }): void };
    const send = socket.send.bind(socket);
    socket.send = (raw) => {
      state.sent.push(JSON.parse(String(raw)));
      send(raw);
    };
    const push = socket.push.bind(socket);
    socket.push = (frame) => {
      if (state.holdReady && frame.type === "input-ready") state.heldReady.push(() => push(frame));
      else push(frame);
    };
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Recorded, name, { value: Demo[name] });
  window.WebSocket = Recorded as unknown as typeof WebSocket;
}

const app = mkdtempSync(join(tmpdir(), "ovis-early-keys-demo-"));
let server: ReturnType<typeof Bun.serve> | null = null;
let browser: Browser | null = null;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n<script>(${installEarlyKeysFixture.toString()})()</script>\n<script type="module"`));
  const prefix = "/herdr-web-ui/demo/app/";
  server = serveDemo(app, { prefix });
  const url = `http://127.0.0.1:${server.port}${prefix}`;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
  try {
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", defaultView: "terminal", terminalInputMode: "direct", alertsOn: false })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    const pane = await page.evaluate(async () => {
      const roster = await (await fetch("/api/machines")).json() as { machines: Array<{ id: string; snapshot?: { panes: Array<{ pane_id: string; agent?: string | null }> } }> };
      return roster.machines.find((machine) => machine.id === "local")?.snapshot?.panes.find((pane) => !pane.agent)?.pane_id ?? null;
    });
    assert.ok(pane, "the demo has a shell pane");
    await page.goto(`${url}?pane=${encodeURIComponent(pane)}`);
    const frame = page.locator(`[data-layout-pane="${pane}"]`);
    await page.waitForFunction((pane) => window.earlyKeys.sent.some((sent) => sent.type === "attach" && sent.pane_id === pane)
      && window.earlyKeys.heldReady.length > 0, pane, { timeout: 10_000 });
    await frame.getByText("Waiting for terminal input…").waitFor({ state: "attached", timeout: 10_000 });
    const typedOf = (pane: string) => page.evaluate((pane) => window.earlyKeys.sent
      .filter((sent) => (sent.type === "input" || sent.type === "keys") && sent.pane_id === pane)
      .map((sent) => sent.type === "input" ? sent.text! : sent.keys!.join(" ")), pane);
    const keyboard = frame.locator(".xterm-helper-textarea");
    // keys whose bytes match a reply xterm sends by itself (Shift+F3 a cursor-position report, Ctrl+F3 too,
    // Alt+] the start of an OSC colour, Alt+Shift+P of a DECRQSS reply) were typed all the same: each is told
    const notReady = frame.getByText("Not sent: the terminal is not ready for keys.");
    for (const key of ["Shift+F3", "Control+F3", "Alt+BracketRight", "Alt+Shift+KeyP"]) {
      await keyboard.focus();
      await page.keyboard.press(key);
      await notReady.first().waitFor({ state: "attached", timeout: 10_000 })
        .catch(async () => assert.fail(`${key} typed before input-ready was dropped without a word: ${JSON.stringify(await typedOf(pane))}`));
      await frame.getByRole("button", { name: "Dismiss" }).first().click();
      await notReady.first().waitFor({ state: "detached", timeout: 10_000 });
    }
    await keyboard.focus();
    await page.keyboard.press("x");
    await page.keyboard.press("y");
    await page.keyboard.press("Escape");
    await frame.getByText("Not sent: the terminal is not ready for keys.").first().waitFor({ state: "attached", timeout: 10_000 })
      .catch(async () => assert.fail(`an Escape typed before input-ready was dropped without a word: ${JSON.stringify(await typedOf(pane))}`));
    await frame.getByRole("button", { name: "Discard held input" }).first().waitFor({ state: "attached", timeout: 10_000 });
    assert.equal(await frame.locator("code", { hasText: /^xy$/ }).count() > 0, true, "the text typed before input-ready is held in the draft");
    await page.evaluate(() => {
      window.earlyKeys.holdReady = false;
      for (const release of window.earlyKeys.heldReady.splice(0)) release();
    });
    await page.keyboard.press("Escape");
    await page.waitForFunction((pane) => window.earlyKeys.sent.some((sent) => sent.type === "input" && sent.pane_id === pane), pane, { timeout: 10_000 });
    assert.deepEqual(await typedOf(pane), ["\x1b"], "nothing typed before input-ready is sent by itself; the key typed after it is");
    assert.deepEqual(errors, [], "no browser errors");
    console.log("PASS keys typed before the terminal took input are held or told, and never sent by themselves");
  } finally { await context.close(); }
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
