/** Replay a Chrome 155 trace of fcitx4 with Sogou Pinyin on Linux X11 (#1649), not a claim to automate the OS IME. */
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import type { Browser } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import { IME_INITIAL_ATTACH_TIMEOUT, resetImeInput, waitForImeTerminal } from "./terminal-ime-ready.ts";

export async function checkLinuxIme(browser: Browser, origin: string, pane: string): Promise<void> {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
    viewport: { width: 1100, height: 700 },
  });
  await context.addInitScript((pane) => {
    Object.defineProperty(navigator, "platform", { get: () => "Linux x86_64" });
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "direct" }));
    localStorage.setItem(`ovis:view:${pane}`, "terminal");
  }, pane);
  const page = await context.newPage();
  const sent: Array<{ pane_id: string; text: string }> = [];
  const received = new EventEmitter();
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "input") {
        sent.push(frame);
        received.emit(frame.text);
      }
      else server.send(raw);
    });
  });
  const input = page.locator(".pane-frame.is-current .xterm-helper-textarea");
  const reset = async () => {
    await resetImeInput(page, pane);
    sent.length = 0;
  };
  // The input method consumes the pinyin keys: the page sees only their keyup. The key that
  // picks a candidate keeps its own key and keyCode in keydown (not 229, isComposing false);
  // a single-character pick then comes as a keypress whose charCode is the candidate, and the
  // input that inserts it. "word" leaves the keypress out: a multi-character pick was not in
  // the trace, and Chrome sends no keypress for more than one character.
  const pick = async (key: string, code: string, keyCode: number, candidate: string, shape: "single" | "word" = "single") => {
    await input.evaluate(async (element, { key, code, keyCode, candidate, shape }) => {
      const box = element as HTMLTextAreaElement;
      for (const letter of ["d", "e"]) {
        box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: letter, code: `Key${letter.toUpperCase()}`, keyCode: letter.toUpperCase().charCodeAt(0) }));
      }
      const keydown = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, code, keyCode, isComposing: false });
      box.dispatchEvent(keydown);
      // A browser fires no keypress, and makes no edit, after a cancelled keydown.
      if (!keydown.defaultPrevented) {
        const charCode = candidate.charCodeAt(0);
        const keypress = new KeyboardEvent("keypress", { bubbles: true, cancelable: true, key: candidate, code, keyCode: charCode, charCode, which: charCode });
        if (shape === "single") box.dispatchEvent(keypress);
        if (!keypress.defaultPrevented) {
          box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType: "insertText", data: candidate, isComposing: false }));
          box.setRangeText(candidate, box.selectionStart, box.selectionEnd, "end");
          box.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: candidate, isComposing: false }));
        }
      }
      box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key, code, keyCode, isComposing: false }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }, { key, code, keyCode, candidate, shape });
  };
  const check = async (expected: string, label: string) => {
    const sentinel = once(received, "\x07", { signal: AbortSignal.timeout(10_000) });
    await input.press("Control+g");
    await sentinel;
    assert.equal(sent.map((frame) => frame.text).join(""), expected + "\x07", label);
  };

  try {
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`, { waitUntil: "domcontentloaded" });
    await waitForImeTerminal(page, pane, IME_INITIAL_ATTACH_TIMEOUT);
    await reset(); await pick("2", "Digit2", 50, "地");
    await check("地", "a digit that picks a candidate sends the candidate, not the digit");

    await reset(); await pick(" ", "Space", 32, "的");
    await check("的", "Space that picks a candidate keeps sending the candidate");

    await reset(); await pick("3", "Digit3", 51, "的地", "word");
    await check("的地", "a digit that picks a word with no keypress sends the word");

    await reset(); await pick("2", "Digit2", 50, "地"); await pick("1", "Digit1", 49, "的");
    await check("地的", "consecutive picks each send their candidate once");

    await reset();
    await input.press("1"); await input.press("2"); await input.press("a"); await input.press("0");
    await check("12a0", "plain digits and letters are unchanged");

    await reset();
    const control = once(received, "\x03", { signal: AbortSignal.timeout(10_000) });
    await input.press("Control+c");
    await control;
    assert.equal(sent.map((frame) => frame.text).join(""), "\x03", "Ctrl with a key keeps its control byte");
    console.log("PASS Linux IME trace replay: digit and Space candidate picks, word picks, plain digits");
  } finally { await context.close(); }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { createServer } = await import("../server/index.ts");
  const { workspaceCreate, workspaceClose } = await import("../server/herdr/client.ts");
  const { chromium } = await import("playwright-core");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "herdr-linux-ime-replay-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "" });
  let owned: string | undefined;
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: chromePath(), headless: true });
    const made = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-linux-ime-replay" });
    owned = made.workspace.workspace_id;
    await checkLinuxIme(browser, `http://127.0.0.1:${server.port}`, made.root_pane.pane_id);
  } finally {
    await browser?.close(); server.stop();
    if (owned) await workspaceClose(owned);
    rmSync(root, { recursive: true, force: true });
  }
}
