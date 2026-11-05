/**
 * On a touch screen a key-bar tap sends its key without taking the focus, so a keyboard put away
 * stays away; only the keyboard key (or a tap on the line or the grid) brings it up. At 412 wide, in
 * Direct typing and Input line modes, with nothing focused (the keyboard down): Esc, Ctrl and Enter
 * leave the focus and the visual viewport as they were, and Enter and Esc still reach the pane, each
 * as one input frame on the wire. A fine pointer at the same width (a narrow desktop window) keeps
 * the focus move: its first key click puts the keyboard in the grid. On the isolated test herdr.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { paneSendText, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

type InputWindow = Window & { typed_: { pane: string; text: string }[] };

/** what each tapped key puts on the wire: a sticky modifier sends nothing by itself */
const SENT: Record<string, string | null> = { Control: null, Enter: "\r", Escape: "\x1b" };

export async function checkKeyBarKeepsKeyboardDown(browser: Browser, origin: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-keybar-focus-")));
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-keybar-focus" });
  const pane = created.root_pane.pane_id;
  try {
    for (const { mode, touch } of [{ mode: "direct", touch: true }, { mode: "line", touch: true }, { mode: "direct", touch: false }]) {
      const tag = touch ? mode : `${mode}, fine pointer`;
      const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: touch, hasTouch: touch, deviceScaleFactor: 2.625 });
      try {
        await context.addInitScript((m) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: m })), mode);
        // every input frame the page sends, as it leaves for the socket
        await context.addInitScript(() => {
          const typed: InputWindow["typed_"] = [];
          (window as unknown as InputWindow).typed_ = typed;
          const send = WebSocket.prototype.send;
          WebSocket.prototype.send = function (this: WebSocket, data) {
            if (typeof data === "string") {
              const frame = JSON.parse(data) as { type?: string; pane_id?: string; text?: string };
              if (frame.type === "input" && frame.pane_id !== undefined && frame.text !== undefined) typed.push({ pane: frame.pane_id, text: frame.text });
            }
            return send.call(this, data);
          };
        });
        const page = await context.newPage();
        await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
        await page.locator(".xterm-rows").waitFor();
        await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("$") ?? false);
        if (mode === "line") await page.locator(".terminal-input").waitFor();
        // a command typed but not run: only the key bar's Enter runs it. Its echo does not hold the
        // joined marker, so the marker drawn proves the shell took the Enter (a count of prompts
        // does not: with no scrollback, a new prompt can push an old one off the screen)
        const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
        const marker = `KB_${nonce}`;
        // C-g, then C-u: the last context's Escape tap can leave readline holding a Meta prefix, which
        // would turn the command's first letter into M-p (a history search). C-g ends any such sequence
        // (Esc C-g aborts too) and C-u clears the line, so the command is typed on an empty prompt
        await paneSendText(pane, `\x07\x15printf 'KB_%s\\n' ${nonce}`);
        await page.locator(".xterm-rows", { hasText: nonce }).waitFor({ timeout: 10_000 });
        // the keyboard put away: nothing focused
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        const focus = () => page.evaluate(() => ({ active: document.activeElement?.tagName, grid: document.activeElement?.classList.contains("xterm-helper-textarea") === true, height: visualViewport!.height }));
        const before = await focus();
        assert.equal(before.active, "BODY", `${tag}: nothing focused to start with`);
        await page.locator(".key-bar").waitFor();
        for (const key of ["Control", "Control", "Enter", "Escape"]) {
          const sentBefore = await page.evaluate(() => (window as unknown as InputWindow).typed_.length);
          const button = page.locator(`.key-bar [data-key="${key}"]`);
          if (touch) await button.tap();
          else await button.click();
          const now = await focus();
          if (touch) assert.deepEqual(now, before, `${tag}: a ${key} tap leaves the focus and the viewport alone`);
          else assert.equal(now.grid, true, `${tag}: a ${key} click puts the keyboard in the grid`);
          const text = SENT[key] ?? null;
          if (text === null) continue;
          await page.waitForFunction(([pane, from, text]) => (window as unknown as InputWindow).typed_.slice(from).some((frame) => frame.pane === pane && frame.text === text), [pane, sentBefore, text] as const, { timeout: 10_000 });
          const sent = await page.evaluate((from) => (window as unknown as InputWindow).typed_.slice(from), sentBefore);
          assert.deepEqual(sent, [{ pane, text }], `${tag}: a ${key} tap sends its key to the pane once, and nothing else`);
        }
        // and the shell took the Enter: the command ran
        await page.locator(".xterm-rows", { hasText: marker }).waitFor({ timeout: 10_000 }).catch(async (error) => {
          throw new Error(`${tag}: the key bar's Enter did not run the typed command (${marker}); screen: ${JSON.stringify((await page.locator(".xterm-rows").textContent())?.slice(-300))}`, { cause: error });
        });
      } finally { await context.close(); }
    }
    console.log("PASS key-bar taps on a touch screen send their keys without taking the focus (the keyboard stays down), in Direct typing and Input line modes; a fine pointer's click still focuses the grid");
  } finally {
    await workspaceClose(created.workspace.workspace_id).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "ovis-keybar-focus-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    await checkKeyBarKeepsKeyboardDown(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(state, { recursive: true, force: true });
  }
}
