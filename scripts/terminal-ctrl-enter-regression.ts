import assert from "node:assert/strict";
import type { Browser } from "playwright-core";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneSendKeys, paneSendText } from "../server/herdr/client.ts";
import { shownRows } from "./shown-rows.ts";

const MODIFIED_CTRL_ENTER = "\x1b[27;5;13~";
const NO_SEND_WAIT_MS = 300;

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type Sent = { type: "input"; pane_id: string; text: string } | { type: "keys"; pane_id: string; keys: string[] };

/**
 * A mirrored pane (no terminal attach on its PC, #924) never shows the browser the program's
 * request, so there Ctrl+Enter goes as herdr's `ctrl+enter` key, which herdr encodes in the
 * program's own mode: the program reads the same bytes either way.
 */
export async function checkCtrlEnter(browser: Browser, origin: string, paneId: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1100, height: 650 } });
  await context.addInitScript((id) => {
    Object.defineProperty(navigator, "platform", { get: () => "Linux x86_64" });
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    localStorage.setItem(`ovis:view:${id}`, "terminal");
  }, paneId);
  const fixture = mkdtempSync(join(tmpdir(), "herdr-ctrl-enter-"));
  const received = join(fixture, "received.txt");
  const script = join(fixture, "keys.cjs");
  writeFileSync(script, `const fs = require("node:fs");
process.stdin.setRawMode(true);
process.stdout.write("\\x1b[2J\\x1b[H\\x1b[>4;2mOwned Ctrl+Enter test: modifyOtherKeys on\\r\\n");
process.stdin.on("data", (data) => {
  fs.appendFileSync(${JSON.stringify(received)}, data.toString("hex") + "\\n");
  if (data.includes(3)) {
    process.stdout.write("\\x1b[>4;0m");
    process.exit(0);
  }
  if (data.toString() === "o") process.stdout.write("\\x1b[>4;0mOwned Ctrl+Enter test: modifyOtherKeys off\\r\\n");
});
`);
  appendFileSync(received, "");
  try {
    const page = await context.newPage();
    const inputs: Sent[] = [];
    let mirrored = false;
    let inputReady = false;
    page.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        const { id: _receipt, ...message } = JSON.parse(String(payload));
        if (message.type === "input" || message.type === "keys") inputs.push(message);
      });
      socket.on("framereceived", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.pane_id !== paneId) return;
        if (message.type === "pane-geometry" && message.fixed) mirrored = true;
        if (message.type === "input-ready") inputReady = message.ready !== false;
      });
    });
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
    await page.locator(".conn-live").waitFor();
    const input = page.locator(".xterm-helper-textarea");
    await input.waitFor();
    await until(() => inputReady, "input-ready");
    const typed = (text: string): Sent => ({ type: "input", pane_id: paneId, text });
    const ctrlEnter = (modified: boolean): Sent => mirrored ? { type: "keys", pane_id: paneId, keys: ["ctrl+enter"] }
      : typed(modified ? MODIFIED_CTRL_ENTER : "\r");
    const isModifiedCtrlEnter = (sent: Sent): boolean => sent.type === "keys" ? sent.keys.includes("ctrl+enter")
      : sent.text === MODIFIED_CTRL_ENTER;
    const screen = (text: string) => page.locator(shownRows(), { hasText: text }).waitFor();
    const press = async (shortcut: string, expected: Sent): Promise<void> => {
      const before = inputs.length;
      await input.press(shortcut);
      await until(() => inputs.length > before, shortcut);
      await page.waitForTimeout(NO_SEND_WAIT_MS); // fixed wait: no second copy of the sequence may arrive
      assert.deepEqual(inputs.slice(before), [expected], `${shortcut} must send ${JSON.stringify(expected)} exactly once`);
    };
    const reads = (): string[] => readFileSync(received, "utf8").split("\n").filter(Boolean);
    const read = async (expected: string, since: number): Promise<void> => {
      const hex = Buffer.from(expected, "latin1").toString("hex");
      await until(() => reads().slice(since).includes(hex), `the pane reads ${JSON.stringify(expected)}`);
    };

    await press("Control+Enter", ctrlEnter(false));
    await paneSendText(paneId, `node ${script}`);
    await paneSendKeys(paneId, ["Enter"]);
    await screen("modifyOtherKeys on");
    let since = reads().length;
    await press("Control+Enter", ctrlEnter(true));
    await read(MODIFIED_CTRL_ENTER, since);
    for (const [shortcut, expected] of [["Enter", "\r"], ["Shift+Enter", "\x1b\r"], ["Alt+Enter", "\x1b\r"]]) {
      await press(shortcut!, typed(expected!));
    }
    for (const composition of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
      const before = inputs.length;
      await input.dispatchEvent("keydown", {
        key: "Enter", code: "Enter", ctrlKey: true, ...composition, bubbles: true, cancelable: true,
      });
      await page.waitForTimeout(NO_SEND_WAIT_MS); // fixed wait: no modified Ctrl+Enter sequence may arrive during composition
      assert.equal(inputs.slice(before).some(isModifiedCtrlEnter), false,
        "an IME commit must not receive the modified Ctrl+Enter");
    }
    const beforeCommit = inputs.length;
    await input.evaluate(async (element) => {
      const textarea = element as HTMLTextAreaElement;
      textarea.value = "";
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      textarea.value = "한";
      textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "한", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "한", bubbles: true }));
      const enter = { key: "Enter", code: "Enter", keyCode: 13, which: 13, ctrlKey: true, bubbles: true, cancelable: true };
      textarea.dispatchEvent(new KeyboardEvent("keydown", enter));
      textarea.dispatchEvent(new KeyboardEvent("keyup", enter));
    });
    await until(() => inputs.length >= beforeCommit + 2, "IME commit followed by Ctrl+Enter");
    await page.waitForTimeout(NO_SEND_WAIT_MS); // fixed wait: nothing beyond the commit and one Ctrl+Enter may arrive
    assert.deepEqual(inputs.slice(beforeCommit), [typed("한"), ctrlEnter(true)],
      "pending IME text must precede Ctrl+Enter without duplicates");
    await paneSendText(paneId, "o");
    await screen("modifyOtherKeys off");
    since = reads().length;
    await press("Control+Enter", ctrlEnter(false));
    await read("\r", since);
    console.log(`PASS Ctrl+Enter stays Enter until the pane asks for modifyOtherKeys, then reaches it as CSI 27;5;13~${mirrored ? " (mirrored pane, herdr's key)" : ""}`);
    console.log("PASS Enter, Shift+Enter and Alt+Enter keep their sequences; IME text precedes Ctrl+Enter");
  } finally {
    await paneSendKeys(paneId, ["ctrl+c"]).catch(() => {});
    await context.close();
    if (existsSync(fixture)) rmSync(fixture, { recursive: true, force: true });
  }
}
