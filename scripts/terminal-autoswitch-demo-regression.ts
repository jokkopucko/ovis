import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { appContext } from "./app-context.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { appFaces } from "./app-faces.ts";
import { shownRows } from "./shown-rows.ts";
import panes from "../site/demo/fixtures/panes.json";
import { openLens } from "./header-lens.ts";

// Real client and demo transport. Only receipts and demo-turn completion are held, then released
// explicitly: no provider, live herdr, sleeps or deadline-dependent assertions.
const app = mkdtempSync(join(tmpdir(), "terminal-autoswitch-"));
const evidence = join(process.env.UI_EVIDENCE_DIR || "/tmp/terminal-autoswitch-shots", "edges");
mkdirSync(evidence, { recursive: true });
await buildDemoApp(app);
const html = await Bun.file(join(app, "index.html")).text();
const setup = `<script>(() => {
const turnsToFinish = [];
const later = window.setTimeout.bind(window);
window.setTimeout = (fn, ms, ...args) => {
  if (ms === 2400 || ms === 4500) { turnsToFinish.push(() => fn(...args)); return 0; }
  return later(fn, ms, ...args);
};
window.finishDemoTurns = () => { const ready = turnsToFinish.splice(0); ready.forEach(fn => fn()); };
window.sentFrames = [];
window.receiptMode = "normal";
window.releaseReceipt = null;
window.discardOnSteer = false;
})();</script><script src="/demo-transport.js"></script><script>(() => {
const Socket = window.WebSocket;
window.WebSocket = function(...args) {
  const socket = new Socket(...args);
  window.demoSocket = socket;
  const send = socket.send.bind(socket);
  socket.send = (raw) => {
    const frame = JSON.parse(raw);
    window.sentFrames.push(frame);
    if (frame.type === "pending-action" && frame.action === "steer" && window.discardOnSteer) {
      send(JSON.stringify({...frame, id: frame.id + 10000, action: "discard"}));
    }
    if (frame.type === "submit" && window.receiptMode !== "normal") {
      window.releaseReceipt = () => {
        if (window.receiptMode === "hold") send(raw);
        else socket.push({ type: "submit-result", id: frame.id, pane_id: frame.pane_id, ok: false,
          code: window.receiptMode === "unconfirmed" ? "submit_unconfirmed" : "agent_not_ready",
          message: "The fixture refused the command." });
        window.releaseReceipt = null;
      };
      return;
    }
    send(raw);
  };
  return socket;
};
Object.assign(window.WebSocket, { CONNECTING: Socket.CONNECTING, OPEN: Socket.OPEN, CLOSING: Socket.CLOSING, CLOSED: Socket.CLOSED });
const fetch = window.fetch;
window.focusCalls = [];
// the catalog race (#1591): "later" holds every read of the pane's commands after the first, "all" holds
// every one, until releaseCommandReads(); commandsParsed counts the answers the page has read
window.holdCommandReads = sessionStorage.getItem("qa:hold-command-reads");
window.commandReads = 0;
window.heldCommandReads = [];
window.commandsParsed = 0;
window.releaseCommandReads = () => { window.holdCommandReads = null; window.heldCommandReads.splice(0).forEach(go => go()); };
// answered prompt reads (each lists the pane's outcomes): a later one has seen what came before it
window.promptReads = 0;
window.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
  if (url.includes("/pane/focus")) window.focusCalls.push(url);
  if (url.includes("/pane/commands") && window.holdCommandReads !== null && (++window.commandReads > 1 || window.holdCommandReads === "all")) {
    return new Promise((resolve, reject) => { window.heldCommandReads.push(() => fetch(input, init).then(resolve, reject)); });
  }
  const answer = fetch(input, init);
  if (url.includes("/pane/prompt?")) answer.then(() => { window.promptReads += 1; }, () => {});
  return answer;
};
const json = Response.prototype.json;
Response.prototype.json = async function() {
  const value = await json.call(this);
  if (Array.isArray(value.commands)) window.commandsParsed += 1;
  if (Array.isArray(value.turns)) {
    const history = Array.from({length: 24}, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      ts: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      parts: [{kind:"text", text: "Earlier fixture turn " + index + ". " + "A stable paragraph for the reading-position regression. ".repeat(8)}]
    }));
    value.turns = [...history, ...value.turns];
  }
  return value;
};
})();</script>`;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/") return new Response(html.replace('<script type="module"', `${setup}<script type="module"`), { headers: { "Content-Type": "text/html" } });
  if (path.includes("..")) return new Response("not found", { status: 404 });
  return new Response(Bun.file(join(app, path.slice(1))));
} });
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
const owner = panes.flaky;
const AUTO_NOTE = "Chat may come back when you close it";
type Frame = { type: string; pane_id?: string; text?: string };
type PeekWindow = Window & { sentFrames: Frame[]; chatLog?: Element | null; promptReads: number };
const stack = (page: Page) => page.locator(`.terminal-stack[data-pane-owner="${owner}"]`);
const chat = (page: Page) => page.locator(`.terminal-stack.is-chat[data-pane-owner="${owner}"]`);
const peek = (page: Page) => page.locator(`.terminal-stack.is-chat.is-peek[data-pane-owner="${owner}"]`);
const box = (page: Page) => chat(page).locator(".composer-text");
const hint = (page: Page) => page.locator(".terminal-banner-command");
const send = async (page: Page, text: string) => {
  await box(page).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
};
const finish = async (page: Page) => page.evaluate("window.finishDemoTurns()");
const capture = async (page: Page, name: string) => page.screenshot({ path: join(evidence, `${name}.png`), animations: "disabled" });
const ready = async (page: Page) => {
  await chat(page).locator(".composer-status[data-status='done'], .composer-status[data-status='idle']").waitFor();
};
const frames = (page: Page): Promise<Frame[]> => page.evaluate(() => (window as unknown as PeekWindow).sentFrames);
const attachments = async (page: Page) => (await frames(page)).filter((frame) => frame.type === "attach" || frame.type === "detach").length;
const typed = async (page: Page) => (await frames(page)).filter((frame) => frame.type === "input" && frame.pane_id === owner).map((frame) => frame.text ?? "");
const lens = (page: Page) => page.evaluate((pane) => ({
  stored: localStorage.getItem(`ovis:view:${pane}`),
  address: new URL(location.href).searchParams.get("view"),
  chatPressed: document.querySelector('.view-switch .is-chat')?.getAttribute("aria-pressed") ?? null,
}), owner);
const noteLog = (page: Page) => page.evaluate((pane) => {
  (window as unknown as PeekWindow).chatLog = document.querySelector(`.terminal-stack[data-pane-owner="${pane}"] [role="log"]`);
}, owner);
const logState = (page: Page) => page.evaluate((pane) => {
  const log = document.querySelector(`.terminal-stack[data-pane-owner="${pane}"] [role="log"]`);
  return { same: log !== null && log === (window as unknown as PeekWindow).chatLog, visibility: log === null ? null : getComputedStyle(log).visibility };
}, owner);
const gridFocused = (page: Page) => page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea") === true);
try {
  for (const width of [1280, 390]) for (const theme of ["light", "dark"] as const) {
    const touch = width === 390;
    const context = await appContext(browser, { viewport: { width, height: 844 }, isMobile: touch, hasTouch: touch });
    try {
      await context.addInitScript(({ theme, pane }) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme, darkTheme: "amber", lightTheme: "amber", autoSendQueued: true, voiceInput: "auto" }));
        localStorage.setItem(`ovis:view:${pane}`, "chat");
      }, { theme, pane: owner });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
      page.setDefaultTimeout(10_000);
      await page.goto(`${server.url}?pane=${encodeURIComponent(owner)}`);
      await chat(page).locator(".composer").waitFor();
      await appFaces(page);
      page.on("console", (message) => { if (message.type() === "error") console.error(message.text()); });
      await box(page).fill("/conf");
      await page.locator('.menu-item[data-terminal]').first().waitFor();
      await box(page).fill("");
      await page.waitForFunction(() => (window as unknown as PeekWindow).promptReads > 0);
      const tag = `${width}-${theme}`;
      const chatLens = await lens(page);
      assert.deepEqual({ stored: chatLens.stored, chatPressed: chatLens.chatPressed }, { stored: "chat", chatPressed: touch ? null : "true" });
      const phoneButton = () => page.locator(".app-header .lens-toggle").evaluate((node) => ({ view: node.getAttribute("data-view"), label: node.getAttribute("aria-label") }));
      if (touch) assert.deepEqual(await phoneButton(), { view: "chat", label: "Switch to terminal" });

      const expectPeek = async (auto: boolean, command: string) => {
        await peek(page).waitFor();
        await hint(page).getByText(`${command} ran`, { exact: true }).waitFor();
        assert.equal(await hint(page).getByText(AUTO_NOTE, { exact: true }).count(), auto ? 1 : 0, `${command}: the head says whether the chat comes back by itself`);
        assert.deepEqual(await lens(page), chatLens, "a peek writes no lens or address, and the header keeps Chat pressed");
        if (touch) assert.deepEqual(await phoneButton(), { view: "terminal", label: "Switch to chat" }, "the phone's lens button reflects the peek");
        assert.deepEqual(await logState(page), { same: true, visibility: "hidden" }, "the chat stays mounted under the grid, hidden");
        // shown, not only laid out: under the chat the grid keeps its box with content-visibility hidden
        assert.ok(await stack(page).locator(".xterm-screen").isVisible(), "the grid shows");
        if (touch) {
          assert.equal(await chat(page).locator(".composer").evaluate((node) => getComputedStyle(node).display), "none");
          await stack(page).locator(".key-bar").waitFor();
          assert.equal(await gridFocused(page), false, "a touch screen's keyboard is not raised by the peek");
        } else {
          assert.equal(await chat(page).locator(".composer").getAttribute("inert"), "", "the composer stays, inert");
          assert.ok(await chat(page).locator(".composer").isVisible());
          assert.equal(await stack(page).locator(".key-bar").isVisible(), false);
          await page.waitForFunction(() => document.activeElement?.classList.contains("xterm-helper-textarea") === true);
        }
      };
      const expectReturned = async (options: { focus?: boolean } = {}) => {
        await peek(page).waitFor({ state: "detached" });
        await chat(page).waitFor();
        assert.equal(await hint(page).count(), 0);
        assert.deepEqual(await logState(page), { same: true, visibility: "visible" }, "the same chat comes back");
        if (!touch && options.focus !== false) {
          await page.waitForFunction((pane) => document.activeElement === document.querySelector(`.terminal-stack[data-pane-owner="${pane}"] .composer-text`), owner);
        }
        assert.equal(await gridFocused(page), false, "the hidden grid has let go of the keyboard");
        const before = await typed(page);
        const draft = await box(page).inputValue();
        await page.keyboard.type("zq");
        assert.deepEqual(await typed(page), before, "keys typed after the return reach no pty");
        if (!touch && options.focus !== false) {
          assert.equal(await box(page).inputValue(), `${draft}zq`, "they go to the message box");
          await box(page).fill(draft);
        }
      };
      const pressEscape = async () => {
        const escapes = (await typed(page)).filter((text) => text === "\x1b").length;
        if (touch) {
          await page.waitForFunction((pane) => document.querySelector<HTMLButtonElement>(`.terminal-stack[data-pane-owner="${pane}"] .key-bar .key[data-key="Escape"]`)?.disabled === false, owner);
          await stack(page).locator('.key-bar .key[data-key="Escape"]').click();
          assert.equal(await gridFocused(page), false, "a key-bar tap in the peek leaves a phone's keyboard down");
        } else await page.keyboard.press("Escape");
        await page.waitForFunction(([pane, before]) => (window as unknown as PeekWindow).sentFrames
          .filter((frame) => frame.type === "input" && frame.pane_id === pane && frame.text === "\x1b").length > before, [owner, escapes] as const);
      };

      for (const mode of ["refused", "unconfirmed"]) {
        await page.evaluate((mode) => { Object.assign(window, { receiptMode: mode }); }, mode);
        await send(page, "/config");
        await page.waitForFunction("window.releaseReceipt !== null").catch(async (error) => {
          console.error(await page.evaluate("JSON.stringify({mode:window.receiptMode,frames:window.sentFrames})"));
          await capture(page, `${tag}-receipt-failure`);
          throw error;
        });
        assert.equal(await peek(page).count(), 0, "no peek before acceptance");
        await page.evaluate("window.releaseReceipt()");
        await chat(page).locator(".composer-note").waitFor();
        assert.equal(await box(page).inputValue(), "/config");
        assert.equal(await peek(page).count(), 0);
        assert.equal(await hint(page).count(), 0);
        await capture(page, `${tag}-${mode}`);
      }
      await box(page).fill("");
      console.log(`PASS ${tag}: refused and unconfirmed sends retain the draft and open no peek`);

      const attached = await attachments(page);
      await noteLog(page);
      await page.evaluate("window.receiptMode = 'hold'");
      await send(page, "/config");
      await page.waitForFunction("window.releaseReceipt !== null");
      await box(page).press("PageUp");
      await box(page).press("PageUp");
      await page.waitForFunction(() => {
        const log = document.querySelector('[role="log"]');
        return log && [...log.querySelectorAll("[data-chat-row]")].some((row) => {
          const top = log.getBoundingClientRect().top;
          const rect = row.getBoundingClientRect();
          return rect.top <= top && rect.bottom > top;
        });
      });
      const place = await chat(page).getByRole("log").evaluate((node) => {
        const top = node.getBoundingClientRect().top;
        const row = [...node.querySelectorAll("[data-chat-row]")].find((row) => row.getBoundingClientRect().bottom > top);
        return { text: row?.textContent, offset: (row?.getBoundingClientRect().top ?? 0) - top };
      });
      assert.ok(place.text);
      assert.equal(await peek(page).count(), 0, "no peek before acceptance");
      await page.evaluate("window.releaseReceipt()");
      await expectPeek(true, "/config");
      await capture(page, `${tag}-accepted`);
      await hint(page).getByRole("button", { name: "Back to Chat", exact: true }).click();
      await chat(page).getByRole("log").waitFor();
      await page.waitForFunction(({ pane, place }) => {
        const log = document.querySelector(`.terminal-stack.is-chat[data-pane-owner="${pane}"] [role="log"]`);
        const row = log && [...log.querySelectorAll("[data-chat-row]")].find((row) => row.textContent === place.text);
        return row && log && Math.abs(row.getBoundingClientRect().top - log.getBoundingClientRect().top - place.offset) < 3;
      }, { pane: owner, place }).catch(async (error) => {
        await capture(page, `${tag}-position-failure`);
        console.error(JSON.stringify({ place, rows: await chat(page).getByRole("log").evaluate((node) => [...node.querySelectorAll("[data-chat-row]")].map(row => ({ text: row.textContent?.slice(0, 60), offset: row.getBoundingClientRect().top - node.getBoundingClientRect().top }))) }));
        throw error;
      });
      assert.equal(await box(page).inputValue(), "");
      await expectReturned();
      await capture(page, `${tag}-reading-position`);
      console.log(`PASS ${tag}: delayed acceptance opens a peek over the same chat; Back to Chat keeps the reading position`);

      // Claude Code records the closed panel: Escape in the grid (or the key bar) reaches the pty,
      // and the chat comes back by itself once the note of it is read.
      await page.evaluate("window.receiptMode = 'normal'");
      const latest = chat(page).getByRole("button", { name: "Jump to latest", exact: true });
      if (await latest.count() > 0) {
        await latest.click();
        await latest.waitFor({ state: "detached" });
      }
      await send(page, "/config");
      await expectPeek(true, "/config");
      await capture(page, `${tag}-peek-auto`);
      if (!touch) {
        const dimmed = await chat(page).locator(".composer").boundingBox();
        assert.ok(dimmed);
        await page.mouse.click(dimmed.x + dimmed.width / 2, dimmed.y + dimmed.height / 2);
        assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea") === true), true,
          "a press on the inert composer leaves the grid focused");
      }
      await pressEscape();
      await expectReturned();
      await chat(page).getByRole("log").locator(".chat-notice-label", { hasText: "Config dialog dismissed" }).last().waitFor();
      await capture(page, `${tag}-peek-auto-returned`);
      console.log(`PASS ${tag}: Escape reaches the pty and Claude's closed panel brings the chat back by itself`);

      // a command whose close Claude does not record: Escape reaches the pty and the peek stays
      await send(page, "/doctor");
      await expectPeek(false, "/doctor");
      await pressEscape();
      const reads = await page.evaluate(() => (window as unknown as PeekWindow).promptReads);
      await page.waitForFunction((reads) => (window as unknown as PeekWindow).promptReads >= reads + 2, reads);
      assert.equal(await peek(page).count(), 1, "a command Claude does not record closing stays until the reader leaves it");
      await capture(page, `${tag}-peek-manual`);
      await openLens(page, "chat");
      await expectReturned();
      console.log(`PASS ${tag}: an unrecorded command keeps the peek after Escape; the header's Chat ends it`);

      await send(page, "/doctor");
      await expectPeek(false, "/doctor");
      await page.keyboard.press("Control+Shift+J");
      await expectReturned();
      assert.deepEqual(await lens(page), chatLens, "the shortcut ends the peek instead of switching lenses");
      if (touch) assert.deepEqual(await phoneButton(), { view: "chat", label: "Switch to terminal" }, "the phone's lens button follows the peek's end");
      console.log(`PASS ${tag}: Mod+Shift+J ends the peek`);

      if (touch) {
        await send(page, "/doctor");
        await expectPeek(false, "/doctor");
        await page.goBack();
        await expectReturned();
        assert.equal(new URL(page.url()).searchParams.get("pane"), owner, "Back stays on the pane");
        console.log(`PASS ${tag}: a phone's Back ends the peek`);

        await send(page, "/doctor");
        await expectPeek(false, "/doctor");
        const entrySheet = (): unknown => (history.state as Record<string, unknown> | null)?.["ovis:sheet"];
        const overPeek = async (way: string, close: () => Promise<unknown>) => {
          await page.waitForFunction(() => typeof (history.state as Record<string, unknown> | null)?.["ovis:sheet"] === "string");
          const peekEntry = await page.evaluate(entrySheet);
          await page.locator(".header-more-button").click();
          await page.locator(".row-sheet-cancel").waitFor();
          await page.waitForFunction((entry) => { const now = (history.state as Record<string, unknown> | null)?.["ovis:sheet"]; return typeof now === "string" && now !== entry; }, peekEntry);
          await close();
          await page.locator(".row-sheet-cancel").waitFor({ state: "detached" });
          await page.waitForFunction((entry) => (history.state as Record<string, unknown> | null)?.["ovis:sheet"] === entry, peekEntry);
          assert.equal(await peek(page).count(), 1, `${way} leaves the peek under the menu`);
        };
        await overPeek("the menu's Cancel", () => page.locator(".row-sheet-cancel").click());
        await overPeek("Back with the menu up", () => page.goBack());
        await page.goBack();
        await expectReturned();
        console.log(`PASS ${tag}: a sheet over the peek closes back onto it`);

        await send(page, "/doctor");
        await expectPeek(false, "/doctor");
        const sheetEntry = (): boolean => typeof (history.state as Record<string, unknown> | null)?.["ovis:sheet"] === "string";
        const settingsDepth = (depth: number): boolean => ((history.state as Record<string, { depth?: number } | undefined> | null)?.["ovis:settings"]?.depth ?? 0) === depth;
        await page.waitForFunction(sheetEntry);
        await page.locator(".drawer-toggle").click();
        await page.locator("#workspace-drawer.is-open").waitFor();
        await page.locator(".sidebar-footer-settings").click();
        const settings = page.locator(".settings-dialog");
        await settings.waitFor();
        await settings.locator(".settings-tab").first().click();
        await page.waitForFunction(settingsDepth, 2);
        await page.goBack();
        await page.waitForFunction(settingsDepth, 1);
        assert.equal(await peek(page).count(), 1, "Back inside Settings leaves the peek under it");
        await page.goBack();
        await settings.waitFor({ state: "detached" });
        assert.equal(await peek(page).count(), 1, "Back closes Settings and leaves the peek");
        await page.waitForFunction(sheetEntry);
        await page.goBack();
        await expectReturned();
        assert.equal(new URL(page.url()).searchParams.get("pane"), owner, "Back ends the peek after Settings, and stays on the pane");
        console.log(`PASS ${tag}: Back closes Settings opened over the peek, then the peek`);
      }

      const keepWays: [string, () => Promise<void>][] = [
        ["Keep Terminal", () => hint(page).getByRole("button", { name: "Keep Terminal", exact: true }).click()],
        ...(touch ? [] : [["the header's Terminal", () => openLens(page, "terminal")] as [string, () => Promise<void>]]),
      ];
      for (const [way, keep] of keepWays) {
        await send(page, "/doctor");
        await expectPeek(false, "/doctor");
        if (way === "Keep Terminal") await capture(page, `${tag}-peek-head`);
        await keep();
        await chat(page).waitFor({ state: "detached" });
        assert.equal(await hint(page).count(), 0);
        const kept = await lens(page);
        assert.deepEqual({ stored: kept.stored, address: kept.address }, { stored: "terminal", address: "terminal" }, `${way} saves the terminal lens`);
        if (!touch) await page.waitForFunction(() => document.activeElement?.classList.contains("xterm-helper-textarea") === true);
        await openLens(page, "chat");
        await chat(page).locator(".composer").waitFor();
        assert.deepEqual(await lens(page), chatLens);
        await noteLog(page);
      }
      console.log(`PASS ${tag}: Keep Terminal and the header's Terminal end the peek and keep the terminal lens`);

      if (!touch) {
        // a find bar left open under the Terminal lens is not the peek's: it would take the focus,
        // the first Escape (the agent's) and a grid row
        await openLens(page, "terminal");
        await chat(page).waitFor({ state: "detached" });
        await page.keyboard.press("Control+Shift+F");
        await stack(page).locator(".find-bar input").waitFor();
        await openLens(page, "chat");
        await chat(page).locator(".composer").waitFor();
        await noteLog(page);
        assert.equal(await chat(page).locator(".composer .voice-mic").count(), 1);
        await send(page, "/doctor");
        await expectPeek(false, "/doctor");
        assert.equal(await stack(page).locator(".find-bar").count(), 0, "the peek opens without the terminal lens's find bar");
        const dictationTaken = await page.evaluate(() => {
          const init = { key: " ", code: "Space", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true };
          const down = new KeyboardEvent("keydown", init);
          window.dispatchEvent(down);
          window.dispatchEvent(new KeyboardEvent("keyup", init));
          return down.defaultPrevented;
        });
        assert.equal(dictationTaken, false, "Mod+Shift+Space dictates into no inert composer");
        await hint(page).getByRole("button", { name: "Back to Chat", exact: true }).click();
        await expectReturned();
        console.log(`PASS ${tag}: a peek leaves the terminal lens's find bar behind, and its inert composer takes no dictation`);

        await send(page, "/config");
        await expectPeek(true, "/config");
        await page.keyboard.press("Control+Shift+F");
        await stack(page).locator(".find-bar input").waitFor();
        assert.equal(await peek(page).count(), 1, "find keeps the peek");
        assert.deepEqual(await lens(page), chatLens, "find in a peek writes no lens or address");
        await stack(page).locator(".xterm-screen").click();
        await pressEscape();
        await hint(page).getByText(AUTO_NOTE, { exact: true }).waitFor({ state: "detached" });
        assert.equal(await peek(page).count(), 1, "the find bar leaves the return to the reader");
        assert.equal(await stack(page).locator(".find-bar").count(), 1, "one find bar");
        await stack(page).locator(".find-bar input").press("Escape");
        await stack(page).locator(".find-bar").waitFor({ state: "detached" });
        await hint(page).getByRole("button", { name: "Back to Chat", exact: true }).click();
        await expectReturned();
        console.log(`PASS ${tag}: find in a peek keeps it, and an open find bar leaves the return manual`);
      }

      await chat(page).getByRole("log").locator(".chat-terminal-command", { hasText: "/doctor" }).last().getByRole("button", { name: "Open Terminal", exact: true }).click();
      await expectPeek(false, "/doctor");
      await capture(page, `${tag}-peek-row`);
      await hint(page).getByRole("button", { name: "Back to Chat", exact: true }).click();
      await expectReturned();
      assert.equal(await attachments(page), attached, "no peek attaches or detaches anything");
      console.log(`PASS ${tag}: a Ran in terminal row opens a manual peek; no attach or detach in any peek`);

      await send(page, "Start a deterministic demo turn");
      await chat(page).locator('.composer-status[data-status="working"]').waitFor();
      await send(page, "/config");
      await page.locator(".pending-message").waitFor();
      assert.equal(await hint(page).count(), 0);
      assert.equal(await peek(page).count(), 0);
      await capture(page, `${tag}-queued`);
      await page.getByRole("button", { name: "Send now: /config", exact: true }).click();
      await expectPeek(true, "/config");
      await capture(page, `${tag}-send-now`);
      await hint(page).getByRole("button", { name: "Back to Chat", exact: true }).click();
      await expectReturned();
      await finish(page);
      await ready(page);
      console.log(`PASS ${tag}: queue acceptance stays in Chat, explicit Send now opens a peek`);

      await send(page, "Start the automatic-delivery turn");
      await chat(page).locator('.composer-status[data-status="working"]').waitFor();
      await send(page, "/config");
      await page.locator(".pending-message").waitFor();
      await finish(page);
      await page.locator(".pending-message").waitFor({ state: "detached" });
      await ready(page);
      assert.equal(await peek(page).count(), 0);
      assert.equal(await hint(page).count(), 0);
      console.log(`PASS ${tag}: automatic queue delivery never opens a peek`);

      await send(page, "Start the discard-race turn");
      await chat(page).locator('.composer-status[data-status="working"]').waitFor();
      await send(page, "/config");
      await page.locator(".pending-message").waitFor();
      await page.evaluate("window.discardOnSteer = true");
      await page.getByRole("button", { name: "Send now: /config", exact: true }).click();
      await page.locator(".pending-message").waitFor({ state: "detached" });
      assert.equal(await peek(page).count(), 0, "a successful replay of discard is not delivery");
      assert.equal(await hint(page).count(), 0);
      await page.evaluate("window.discardOnSteer = false");
      await finish(page);
      await ready(page);
      console.log(`PASS ${tag}: concurrent discard plus successful action ACK never opens a peek`);

      if (!touch) {
        await send(page, "/doctor");
        await expectPeek(false, "/doctor");
        await page.locator(`.pane-select[data-pane="${panes.api}"]`).click();
        await page.waitForURL((url) => url.searchParams.get("pane") === panes.api);
        await page.locator(`.terminal-stack[data-pane-owner="${panes.api}"]`).waitFor();
        assert.equal(await page.locator(".terminal-stack.is-peek").count(), 0, "a peek never follows to another pane");
        assert.equal(await hint(page).count(), 0);
        await page.locator(`.pane-select[data-pane="${owner}"]`).click();
        await page.waitForURL((url) => url.searchParams.get("pane") === owner);
        await chat(page).locator(".composer").waitFor();
        assert.equal(await peek(page).count(), 0);
        console.log(`PASS ${tag}: choosing another pane ends the peek`);
      }

      assert.deepEqual(await page.evaluate("window.sentFrames.filter(frame => frame.type === 'focus' || frame.type === 'take-over')"), []);
      assert.deepEqual(await page.evaluate("window.focusCalls"), [], "no peek moves herdr's focus");

      if (touch) {
        // an IME composition in the input line leaves the return to the reader: the chat coming
        // back would unmount the line mid-word
        await send(page, "/config");
        await expectPeek(true, "/config");
        const direct = stack(page).locator('.key-bar .key[data-key="direct"]');
        await direct.click();
        const line = stack(page).locator(".terminal-input textarea");
        await line.waitFor();
        await line.dispatchEvent("compositionstart", { data: "" });
        await pressEscape();
        await hint(page).getByText(AUTO_NOTE, { exact: true }).waitFor({ state: "detached" });
        assert.equal(await peek(page).count(), 1, "a composition in the input line keeps the peek");
        await line.dispatchEvent("compositionend", { data: "" });
        await direct.click();
        await line.waitFor({ state: "detached" });
        await hint(page).getByRole("button", { name: "Back to Chat", exact: true }).click();
        await expectReturned();
        console.log(`PASS ${tag}: a composition in the input line leaves the return manual`);
      }

      await send(page, "/doctor");
      await expectPeek(false, "/doctor");
      await page.reload();
      await chat(page).locator(".composer").waitFor();
      assert.equal(await peek(page).count(), 0, "a reload lands on Chat");
      assert.equal((await lens(page)).stored, "chat");
      console.log(`PASS ${tag}: a reload lands on Chat`);

      // The server's confirmed role controls input. A command outcome published to this reader
      // still cannot open a peek; no composer remains from which it could submit one.
      await page.evaluate("window.demoSocket.send(JSON.stringify({type:'role', mode:'observe'}))");
      await chat(page).locator(".composer").waitFor({ state: "detached" });
      assert.equal(await chat(page).count(), 1);
      assert.equal(await peek(page).count(), 0);
      assert.equal(await hint(page).count(), 0);
      const forbidden = await page.evaluate("window.sentFrames.filter(frame => frame.type === 'focus' || frame.type === 'take-over')");
      assert.deepEqual(forbidden, []);
      assert.deepEqual(await page.evaluate("window.focusCalls"), []);
      assert.deepEqual(errors, []);
      await capture(page, `${tag}-watch-only`);
      console.log(`PASS ${tag}: watch-only stays in Chat without a composer; no focus or takeover frames`);
    } finally { await context.close(); }
  }

  for (const width of [1280, 390]) {
    const touch = width === 390;
    const context = await appContext(browser, { viewport: { width, height: 844 }, isMobile: touch, hasTouch: touch });
    try {
      await context.addInitScript((views) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "light", darkTheme: "amber", lightTheme: "amber", autoSendQueued: true }));
        for (const pane of views) localStorage.setItem(`ovis:view:${pane}`, "chat");
      }, [owner, panes.omp]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
      page.setDefaultTimeout(10_000);
      const tag = `screens-${width}`;
      const STILL_OPEN = "/btw is still open in the terminal";
      const of = (pane: string) => ({
        stack: page.locator(`.terminal-stack[data-pane-owner="${pane}"]`),
        chat: page.locator(`.terminal-stack.is-chat:not(.is-peek)[data-pane-owner="${pane}"]`),
        peek: page.locator(`.terminal-stack.is-chat.is-peek[data-pane-owner="${pane}"]`),
        box: page.locator(`.terminal-stack.is-chat[data-pane-owner="${pane}"] .composer-text`),
      });
      const open = async (pane: string, probe: string) => {
        await page.goto(`${server.url}?pane=${encodeURIComponent(pane)}`);
        await of(pane).chat.locator(".composer").waitFor();
        await of(pane).box.fill(probe);
        await page.locator(".menu-item[data-terminal]").first().waitFor();
        await of(pane).box.fill("");
      };
      const submits = async (pane: string, text: string) => (await frames(page)).filter((frame) => frame.type === "submit" && frame.pane_id === pane && frame.text === text).length;
      const sendIn = async (pane: string, text: string) => {
        await of(pane).box.fill(text);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
      };
      const escapeIn = async (pane: string) => {
        const before = (await frames(page)).filter((frame) => frame.type === "input" && frame.pane_id === pane && frame.text === "\x1b").length;
        if (touch) {
          await page.waitForFunction((pane) => document.querySelector<HTMLButtonElement>(`.terminal-stack[data-pane-owner="${pane}"] .key-bar .key[data-key="Escape"]`)?.disabled === false, pane);
          await of(pane).stack.locator('.key-bar .key[data-key="Escape"]').click();
        } else await page.keyboard.press("Escape");
        await page.waitForFunction(([pane, before]) => (window as unknown as PeekWindow).sentFrames
          .filter((frame) => frame.type === "input" && frame.pane_id === pane && frame.text === "\x1b").length > before, [pane, before] as const);
      };
      const backToChat = async (pane: string) => {
        await hint(page).getByRole("button", { name: "Back to Chat", exact: true }).click();
        await of(pane).peek.waitFor({ state: "detached" });
        await of(pane).chat.locator(".composer").waitFor();
      };
      const screen = (pane: string, text: string) => of(pane).stack.locator(shownRows(), { hasText: text });

      // omp's /settings: the panel hides the editor's row, Escape draws it back, and the chat comes back by itself
      await open(panes.omp, "/sett");
      await sendIn(panes.omp, "/settings");
      await of(panes.omp).peek.waitFor();
      await hint(page).getByText("/settings ran", { exact: true }).waitFor();
      await hint(page).getByText(AUTO_NOTE, { exact: true }).waitFor();
      await screen(panes.omp, "to close").waitFor();
      await capture(page, `${tag}-omp-settings`);
      await escapeIn(panes.omp);
      await of(panes.omp).peek.waitFor({ state: "detached" });
      await of(panes.omp).chat.locator(".composer").waitFor();
      assert.equal(await page.locator(".composer-notice", { hasText: "is still open in the terminal" }).count(), 0, "a screen that closed leaves no still-open notice");
      assert.equal(await page.evaluate((pane) => localStorage.getItem(`ovis:view:${pane}`), panes.omp), "chat");
      console.log(`PASS ${tag}: omp's /settings comes back to Chat by itself once its editor's row is drawn again`);

      // omp's /copy is not on omp's list (the head promises nothing) and only prints above the row,
      // which stays drawn: no frame arms the return, so the peek stays until the reader leaves it
      await sendIn(panes.omp, "/copy");
      await of(panes.omp).peek.waitFor();
      await hint(page).getByText("/copy ran", { exact: true }).waitFor();
      assert.equal(await hint(page).getByText(AUTO_NOTE, { exact: true }).count(), 0, "/copy comes back by hand");
      await screen(panes.omp, "Nothing to copy yet.").waitFor();
      await escapeIn(panes.omp);
      await screen(panes.omp, "Nothing to copy yet.").waitFor({ state: "detached" });
      assert.equal(await of(panes.omp).peek.count(), 1, "a row that was never hidden keeps the peek");
      await backToChat(panes.omp);
      assert.equal(await page.locator(".composer-notice", { hasText: "is still open in the terminal" }).count(), 0, "the row is back: no still-open notice");
      console.log(`PASS ${tag}: omp's /copy, off the list, stays until the reader leaves it`);

      // Claude's /btw answer left open: the peek ended by hand, the next message would be typed into it
      await open(owner, "/conf");
      await sendIn(owner, "/btw what changed?");
      await of(owner).peek.waitFor();
      await hint(page).getByText("/btw ran", { exact: true }).waitFor();
      assert.equal(await hint(page).getByText(AUTO_NOTE, { exact: true }).count(), 0);
      await screen(owner, "Escape to dismiss").waitFor();
      await backToChat(owner);
      const notice = of(owner).chat.locator(".composer-notice", { hasText: STILL_OPEN });
      await notice.waitFor();
      await notice.getByRole("button", { name: "Show terminal", exact: true }).waitFor();
      await capture(page, `${tag}-still-open`);
      const held = "Did the retry test pass?";
      await sendIn(owner, held);
      await of(owner).chat.locator(".composer-note", { hasText: "Not sent: /btw is still open in the terminal." }).waitFor();
      assert.equal(await of(owner).box.inputValue(), held, "the message stays in the box");
      assert.equal(await submits(owner, held), 0, "nothing is sent while the screen is open");
      await capture(page, `${tag}-still-open-held`);
      await of(owner).chat.getByRole("button", { name: "Send anyway", exact: true }).click();
      await page.waitForFunction(([pane, text]) => (window as unknown as PeekWindow).sentFrames.some((frame) => frame.type === "submit" && frame.pane_id === pane && frame.text === text), [owner, held] as const);
      await page.waitForFunction((pane) => document.querySelector<HTMLTextAreaElement>(`.terminal-stack[data-pane-owner="${pane}"] .composer-text`)?.value === "", owner);
      assert.equal(await submits(owner, held), 1, "Send anyway sends once");
      assert.equal((await frames(page)).filter((frame) => frame.type === "submit" && frame.pane_id === owner && (frame as { send_anyway?: unknown }).send_anyway === true).length, 0,
        "Send anyway past the notice is no send over a box the server showed");
      await finish(page);
      await of(owner).chat.locator(".composer-status[data-status='done'], .composer-status[data-status='idle']").waitFor();
      await notice.waitFor();
      await notice.getByRole("button", { name: "Show terminal", exact: true }).click();
      await of(owner).peek.waitFor();
      await hint(page).getByText("/btw ran", { exact: true }).waitFor();
      assert.equal(await hint(page).getByText(AUTO_NOTE, { exact: true }).count(), 0, "Show terminal opens a peek that only ends by hand");
      await backToChat(owner);
      await notice.waitFor();
      await page.evaluate((pane) => (window as unknown as { demoSocket: WebSocket }).demoSocket.send(JSON.stringify({ type: "input", pane_id: pane, text: "\x1b" })), owner);
      await notice.waitFor({ state: "detached" });
      const after = "And the flaky one?";
      await sendIn(owner, after);
      await page.waitForFunction(([pane, text]) => (window as unknown as PeekWindow).sentFrames.some((frame) => frame.type === "submit" && frame.pane_id === pane && frame.text === text), [owner, after] as const);
      await finish(page);
      console.log(`PASS ${tag}: Claude's /btw left open holds Send behind the notice; Send anyway sends once; its close clears the notice`);

      // #1552: a screen left open by any other way back to Chat (Keep Terminal, then the header's Chat)
      // would take the next message just the same: Send holds it behind the same notice
      const ANY_OPEN = "A screen is still open in the terminal";
      await of(owner).chat.locator(".composer-status[data-status='done'], .composer-status[data-status='idle']").waitFor();
      await sendIn(owner, "/btw and the retry?");
      await of(owner).peek.waitFor();
      await screen(owner, "Escape to dismiss").waitFor();
      await hint(page).getByRole("button", { name: "Keep Terminal", exact: true }).click();
      await of(owner).peek.waitFor({ state: "detached" });
      await openLens(page, "chat");
      await of(owner).chat.locator(".composer").waitFor();
      const kept = "Is that screen still up?";
      await sendIn(owner, kept);
      await of(owner).chat.locator(".composer-note", { hasText: "Not sent: a screen is still open in the terminal." }).waitFor();
      assert.equal(await of(owner).box.inputValue(), kept, "the message stays in the box");
      assert.equal(await submits(owner, kept), 0, "nothing is typed into a screen the terminal lens left open");
      const anyOpen = of(owner).chat.locator(".composer-notice", { hasText: ANY_OPEN });
      await anyOpen.waitFor();
      await capture(page, `${tag}-left-open-held`);
      await page.evaluate((pane) => (window as unknown as { demoSocket: WebSocket }).demoSocket.send(JSON.stringify({ type: "input", pane_id: pane, text: "\x1b" })), owner);
      await anyOpen.waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page.waitForFunction(([pane, text]) => (window as unknown as PeekWindow).sentFrames.some((frame) => frame.type === "submit" && frame.pane_id === pane && frame.text === text), [owner, kept] as const);
      await finish(page);
      assert.deepEqual(await page.evaluate("window.sentFrames.filter(frame => frame.type === 'focus' || frame.type === 'take-over')"), []);
      assert.deepEqual(await page.evaluate("window.focusCalls"), [], "no peek or notice moves herdr's focus");
      assert.deepEqual(errors, []);
      console.log(`PASS ${tag}: a screen left open through the terminal lens holds Send behind the notice; its close clears it`);
    } finally { await context.close(); }
  }

  for (const hold of ["later", "all"] as const) {
    const context = await appContext(browser, { viewport: { width: 1280, height: 844 } });
    try {
      await context.addInitScript(({ pane, hold }) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "light", darkTheme: "amber", lightTheme: "amber", autoSendQueued: true }));
        localStorage.setItem(`ovis:view:${pane}`, "chat");
        sessionStorage.setItem("qa:hold-command-reads", hold);
      }, { pane: owner, hold });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
      page.setDefaultTimeout(10_000);
      await page.goto(`${server.url}?pane=${encodeURIComponent(owner)}`);
      await chat(page).locator(".composer").waitFor();
      await page.waitForFunction(() => (window as unknown as PeekWindow).promptReads > 0);
      type HoldWindow = PeekWindow & { heldCommandReads: unknown[]; commandsParsed: number; releaseReceipt: (() => void) | null };
      if (hold === "later") {
        await page.waitForFunction(() => (window as unknown as HoldWindow).commandsParsed === 1);
        await box(page).fill("/conf");
        await page.locator('.menu-item[data-terminal]').first().waitFor();
        await send(page, "/doctor");
      } else {
        await page.waitForFunction(() => (window as unknown as HoldWindow).heldCommandReads.length === 1);
        await page.evaluate(() => { Object.assign(window, { receiptMode: "hold" }); });
        await send(page, "/doctor");
        await page.waitForFunction(() => (window as unknown as HoldWindow).releaseReceipt !== null);
        assert.equal(await peek(page).count(), 0, "no peek before the receipt");
        await page.evaluate(() => { (window as unknown as { releaseCommandReads: () => void }).releaseCommandReads(); });
        await page.waitForFunction(() => (window as unknown as HoldWindow).commandsParsed >= 1);
        await page.evaluate(() => { (window as unknown as HoldWindow).releaseReceipt?.(); });
      }
      await peek(page).waitFor();
      await hint(page).getByText("/doctor ran", { exact: true }).waitFor();
      await capture(page, `catalog-race-${hold}`);
      assert.equal(await page.evaluate(() => (window as unknown as { commandReads: number }).commandReads), 1, "the pane's components share one read of its commands");
      await page.evaluate(() => { (window as unknown as { releaseCommandReads: () => void }).releaseCommandReads(); });
      assert.deepEqual(errors, []);
      console.log(`PASS catalog race (${hold}): one read of the pane's commands, and its receipt reads that list and opens the peek`);
    } finally { await context.close(); }
  }

  const context = await appContext(browser, { viewport: { width: 1280, height: 844 } });
  try {
    await context.addInitScript(({ pane, other }) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "light", darkTheme: "amber", lightTheme: "amber", autoSendQueued: true }));
      localStorage.setItem(`ovis:view:${pane}`, "chat");
      sessionStorage.setItem("ovis:split", JSON.stringify({ other: { machineId: "local", paneId: other }, bSide: "right", active: "a" }));
    }, { pane: owner, other: panes.api });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
    page.setDefaultTimeout(10_000);
    await page.goto(`${server.url}?pane=${encodeURIComponent(owner)}`);
    await chat(page).locator(".composer").waitFor();
    const half = page.locator(".pane-slot.is-active");
    await half.getByRole("button", { name: "Show the terminal", exact: true }).waitFor();
    await box(page).fill("/conf");
    await page.locator('.menu-item[data-terminal]').first().waitFor();
    await box(page).fill("");
    await page.waitForFunction(() => (window as unknown as PeekWindow).promptReads > 0);
    await box(page).fill("/doctor");
    await chat(page).getByRole("button", { name: "Send message", exact: true }).click();
    await peek(page).waitFor();
    await half.getByRole("button", { name: "Show the chat", exact: true }).click();
    await peek(page).waitFor({ state: "detached" });
    await chat(page).locator(".composer").waitFor();
    assert.equal(await page.evaluate((pane) => localStorage.getItem(`ovis:view:${pane}`), owner), "chat", "the half's button ends the peek without saving the terminal lens");
    await half.getByRole("button", { name: "Show the terminal", exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log("PASS split: a half's lens button says the chat during a peek and ends it");
  } finally { await context.close(); }
} finally {
  await browser.close();
  server.stop(true);
  rmSync(app, { recursive: true, force: true });
}
console.log(`PASS terminal autoswitch edge cases; screenshots in ${evidence}`);
