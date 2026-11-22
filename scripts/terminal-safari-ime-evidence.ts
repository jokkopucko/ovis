import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Socket } from "node:net";
import { chromium } from "playwright-core";
import { preview } from "vite";
import { createServer } from "../server/index.ts";
import { paneRead, paneSendText, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";
import { shownRow } from "./shown-rows.ts";

assert(process.env.HERDR_TEST_LIVE !== "1" && process.env.HERDR_TEST_MODE !== "unit");
process.env.HERDR_TEST_SESSION ||= "ovis-test-ime-evidence";
await import("./test-herdr.ts");
const [before, after] = process.argv.slice(2);
assert(before && after, "Usage: bun scripts/terminal-safari-ime-evidence.ts BEFORE_DIST AFTER_DIST");
const output = resolve(process.env.UI_EVIDENCE_DIR || "evidence/safari-ime");
mkdirSync(output, { recursive: true });
const cases = [
  { name: "English -> Korean + Space", expected: "abc한글 " },
  { name: "Korean -> English + Space", expected: "한글abc " },
  { name: "Final consonant: 값 + 아 -> 갑사", expected: "갑사 " },
  { name: "Backspace preedit, then retype", expected: "한 " },
  { name: "English -> Korean + Enter", expected: "abc한글\r" },
];
const until = async (check: () => boolean | Promise<boolean>, message: string) => {
  const deadline = Date.now() + 15_000;
  while (!(await check())) { assert(Date.now() < deadline, message); await Bun.sleep(25); }
};
const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
try {
  for (const [label, dist] of [["before", before], ["after", after]]) {
    const root = mkdtempSync(join(tmpdir(), "herdr-ime-evidence-"));
    const results = join(root, "results.json");
    const readyFile = join(root, "ready");
    const capture = join(root, "capture.cjs");
    writeFileSync(capture, String.raw`const fs = require('node:fs');
const cases = ${JSON.stringify(cases)};
const results = []; let pending = [];
process.stdin.setRawMode(true);
process.stdout.write('\x1b[2J\x1b[H');
process.stdout.write('ISSUE #432 | ${label!.toUpperCase()} | Safari event replay\r\n');
process.stdout.write('Chromium replay / owned local PTY / not a physical IME test\r\n\r\n');
fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');
process.stdin.on('data', bytes => {
  for (const byte of bytes) {
    if (byte !== 7) { pending.push(byte); continue; }
    const actual = Buffer.from(pending).toString('utf8'); pending = [];
    const test = cases[results.length]; if (!test) continue;
    const pass = actual === test.expected;
    results.push({ ...test, actual, pass });
    process.stdout.write((pass ? '\x1b[32mPASS' : '\x1b[31mFAIL') + '\x1b[0m  ' + results.length + '. ' + test.name + '\r\n');
    process.stdout.write('  Expected: ' + JSON.stringify(test.expected) + '\r\n');
    process.stdout.write('  Received: ' + JSON.stringify(actual) + '\r\n\r\n');
    if (results.length === cases.length) process.stdout.write('Completed: ' + results.filter(r => r.pass).length + '/' + cases.length + ' matched expected PTY bytes.\r\n');
    fs.writeFileSync(${JSON.stringify(results)}, JSON.stringify(results));
  }
});
`);
    const api = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), registerBridge: false });
    const sockets = new Set<Socket>();
    let workspace: string | undefined;
    let web: Awaited<ReturnType<typeof preview>> | undefined;
    const context = await browser.newContext({ viewport: { width: 1240, height: 540 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.6.2 Safari/605.1.15" });
    try {
      const made = await workspaceCreate({ cwd: root, label: "ovis-test-ime-evidence" });
      workspace = made.workspace.workspace_id;
      const pane = made.root_pane.pane_id;
      const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
      await paneSendText(pane, `exec ${quote(Bun.which("node")!)} ${quote(capture)}\r`);
      await until(() => existsSync(readyFile), "capture process must start");
      web = await preview({ configFile: false, build: { outDir: resolve(dist!) }, preview: { host: "127.0.0.1", port: 0, proxy: {
        "/api": { target: `http://127.0.0.1:${api.port}` }, "/ws": { target: `ws://127.0.0.1:${api.port}`, ws: true },
      } } });
      web.httpServer.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
      const address = web.httpServer.address(); assert(address && typeof address !== "string");
      await context.addInitScript(pane => {
        Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "direct" }));
        localStorage.setItem(`ovis:view:${pane}`, "terminal");
      }, pane);
      const page = await context.newPage();
      let ready = false;
      const sent: string[] = [];
      await page.routeWebSocket(/\/ws(?:\?|$)/, socket => {
        const server = socket.connectToServer();
        server.onMessage(raw => { const frame = JSON.parse(String(raw)); if (frame.type === "input-ready") ready = frame.ready !== false; socket.send(raw); });
        socket.onMessage(raw => { const frame = JSON.parse(String(raw)); if (frame.type === "input") sent.push(frame.text); server.send(raw); });
      });
      const input = page.locator(".xterm-helper-textarea");
      const edit = async (type: string, data: string, start: number, end = start) => input.evaluate(async (element, args) => {
        const box = element as HTMLTextAreaElement;
        box.setSelectionRange(args.start, args.end);
        box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, inputType: args.type, data: args.data, isComposing: false }));
        box.setRangeText(args.data, args.start, args.end, "end");
        box.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: args.type, data: args.data, isComposing: false }));
        box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: args.data, keyCode: 229, isComposing: false }));
        box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: args.data, keyCode: 71, isComposing: false }));
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }, { type, data, start, end });
      const syllable = async (parts: string[], at = 0) => { await edit("insertText", parts[0]!, at); for (const part of parts.slice(1)) await edit("insertReplacementText", part, at, at + 1); };
      const hangul = async () => { await syllable(["ㅎ", "하", "한"]); await edit("insertReplacementText", "한", 0, 1); await syllable(["ㄱ", "그", "글"], 1); await edit("insertReplacementText", "글", 1, 2); };
      const english = async () => { for (const key of "abc") await input.press(key); };
      for (let i = 0; i < cases.length; i++) {
        ready = false;
        await page.goto(`http://127.0.0.1:${address.port}/?pane=${encodeURIComponent(pane)}`);
        await until(() => ready, "owned pane must be input-ready"); await input.focus();
        if (i === 0 || i === 4) { await english(); await hangul(); await input.press(i === 4 ? "Enter" : "Space"); }
        if (i === 1) { await hangul(); await english(); await input.press("Space"); }
        if (i === 2) { await syllable(["ㄱ", "가", "갑", "값"]); await edit("insertReplacementText", "갑", 0, 1); await syllable(["사"], 1); await input.press("Space"); }
        if (i === 3) {
          await syllable(["ㅎ", "하", "한"]);
          for (const data of ["하", "ㅎ"]) await edit("insertReplacementText", data, 0, 1);
          await edit("deleteContentBackward", "", 0, 1);
          await syllable(["ㅎ", "하", "한"]); await input.press("Space");
        }
        await input.press("Control+g");
        await until(() => existsSync(results) && JSON.parse(readFileSync(results, "utf8")).length === i + 1, "PTY must receive this case");
      }
      const actual = JSON.parse(readFileSync(results, "utf8")) as Array<{ actual: string; pass: boolean }>;
      if (label === "after") assert(actual.every(test => test.pass), JSON.stringify(actual));
      else {
        assert.equal(actual[0]!.actual, "abcㅎㄱ ", "baseline must reproduce the recorded native failure");
        assert(actual.every(test => test.pass === false), "baseline must fail all five recorded cases");
      }
      await until(async () => (await paneRead({ paneId: pane, source: "visible" })).text.includes("Completed:"), "rendered PTY report must complete");
      await page.waitForFunction(rows => Array.from(document.querySelectorAll(rows)).some(row => row.textContent?.includes("Completed:")), shownRow());
      await page.locator(".xterm").screenshot({ path: join(output, `safari-ime-${label}.png`) });
      writeFileSync(join(output, `safari-ime-${label}.json`), JSON.stringify({ label, dist: resolve(dist!), cases: actual, wsInput: sent }, null, 2) + "\n");
      console.log(`PASS ${label}: recorded ${actual.filter(test => test.pass).length}/${cases.length} matches; ${output}`);
    } finally {
      await context.close(); api.stop(); for (const socket of sockets) socket.destroy();
      if (web) await new Promise<void>((resolve, reject) => web!.httpServer.close(error => error ? reject(error) : resolve()));
      if (workspace) await workspaceClose(workspace);
      console.log(`CLEANUP ${label}: owned workspace and servers closed; raw results: ${results}`);
    }
  }
} finally { await browser.close(); }
