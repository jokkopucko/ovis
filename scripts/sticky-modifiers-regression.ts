/** Touch controls → browser WS → Herdr's pane encoder → real raw-mode PTY. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose, paneSendText, paneSendKeys, paneRead } from "../server/herdr/client.ts";
import { openSettingsPage } from "./settings-page.ts";
import { chromePath } from "./chrome-path.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-sticky-qa-"));
const owned: string[] = [];
const server = createServer({ port: 0, stateDir: join(root, "state"), token: "" });
// launched inside the try: a missing Chrome must still stop the server and remove the temp directory
let launched: Browser | undefined;
const errors: string[] = [];
const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert(Date.now() < deadline, `timed out: ${label}`);
    await Bun.sleep(20);
  }
}
try {
  const browser = launched = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  for (const mode of ["legacy", "kitty"] as const) {
    const made = await workspaceCreate({ cwd: root, label: `ovis-test-sticky-${mode}`, focus: false });
    owned.push(made.workspace.workspace_id);
    const pane = made.root_pane.pane_id;
    const log = join(root, `${mode}.hex`);
    const probe = resolve("scripts/fixtures/modifier-probe.py");
    await paneSendText(pane, `python3 -u '${probe}' '${log}' ${mode}`);
    await paneSendKeys(pane, ["Enter"]);
    await until(async () => (await paneRead({ paneId: pane, source: "visible" })).text.includes(`PROBE READY ${mode}`), "raw probe ready");
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.addInitScript(({ pane }) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "direct", keyBarExtras: ["alt", "shift-tab", "home-end", "page-up-down", "ctrl-d", "ctrl-z", "pipe", "tilde", "slash"] }));
      localStorage.setItem(`ovis:view:${pane}`, "terminal");
    }, { pane });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const frames: any[] = [];
    let ws: import("playwright-core").WebSocketRoute | undefined;
    await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
      ws = socket;
      const remote = socket.connectToServer();
      remote.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "error") console.log("terminal error", message);
        socket.send(raw);
      });
      // the typing frames each key produced, in order: a ping that confirms typing (#2587) can go out
      // after any of them, once the pong of the one before comes back
      socket.onMessage((raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "input" || frame.type === "keys") frames.push(frame);
        remote.send(raw);
      });
    });
    await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
    const settingsShortcut = await page.evaluate(() => /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent))
      ? "Meta+Shift+Comma" : "Control+Shift+Comma";
    const ctrl = page.locator('[data-key="Control"]');
    await until(async () => !(await ctrl.isDisabled()), "terminal input ready");
    // Herdr's screen stream enables bracketed paste; exercise xterm with it disabled too.
    ws!.send(JSON.stringify({ type: "pty-data", pane_id: pane, data: "\x1b[?2004l" }));
    const input = page.locator(".xterm-helper-textarea");
    await input.focus();
    let previousMask = 0;
    const held = async (mask: number) => {
      for (const [bit, key] of [[4, "Control"], [2, "Alt"], [1, "Shift"]] as const) {
        if ((mask & bit) !== (previousMask & bit)) await page.locator(`[data-key="${key}"]`).tap();
        assert.equal(await page.locator(`[data-key="${key}"]`).getAttribute("aria-pressed"), String(!!(mask & bit)));
      }
      previousMask = mask;
      assert.equal(await input.evaluate((element) => document.activeElement === element), true, "touch toggle keeps typing focus");
    };
    const read = () => existsSync(log) ? readFileSync(log, "utf8") : "";
    for (let mask = 1; mask < 8; mask++) {
      await held(mask);
      const prefix = [mask & 4 ? "ctrl" : "", mask & 2 ? "alt" : "", mask & 1 ? "shift" : ""].filter(Boolean).join("+");
      for (const [key, name] of [["ArrowLeft", "left"], ["ArrowUp", "up"], ["ArrowRight", "right"], ["ArrowDown", "down"], ["a", "a"], ["b", "b"], ["!", "!"], ["+", "plus"], [" ", "space"], ["я", "я"], ["😀", "😀"], ["Enter", "enter"], ["Tab", "tab"], ["Backspace", "backspace"]]) {
        const before = read();
        const frameCount = frames.length;
        if (key!.startsWith("Arrow") || key === "Tab" || key === "Enter") await page.locator(`[data-key="${key}"]`).tap();
        else if (key === "Backspace") await input.press("Backspace");
        else await page.keyboard.insertText(key!); // soft-keyboard input without keydown
        await until(() => frames.length > frameCount, "modified key frame");
        assert.equal(frames.at(-1).type, "keys");
        assert.deepEqual(frames.at(-1).keys, [`${prefix}+${name}`]);
        await until(() => read().length > before.length, "modified key received by PTY");
        const received = Buffer.from(read().slice(before.length), "hex").toString();
        const parameter = 1 + mask;
        if (key!.startsWith("Arrow")) {
          const final = ({ ArrowLeft: "D", ArrowUp: "A", ArrowRight: "C", ArrowDown: "B" } as Record<string, string>)[key!];
          assert.equal(received, `\x1b[1;${parameter}${final}`, `${mode} ${prefix}+${name}`);
        } else if (mode === "kitty") {
          const code = ({ Enter: 13, Tab: 9, Backspace: 127 } as Record<string, number>)[key!] ?? key!.codePointAt(0);
          assert.equal(received, `\x1b[${code};${parameter}u`, `${mode} ${prefix}+${name}`);
        }
        console.log(`${mode} ${prefix}+${name}: ${Buffer.from(received).toString("hex")}`);
      }
      // Every modifier stays held across all keys, including Control.
      assert.equal(await ctrl.getAttribute("aria-pressed"), String(!!(mask & 4)));
    }
    await held(7);
    for (const [key, name] of [["Home", "home"], ["End", "end"], ["PageUp", "pageup"], ["PageDown", "pagedown"], ["BackTab", "tab"], ["pipe", "|"], ["tilde", "~"], ["slash", "/"]]) {
      const before = read();
      const frameCount = frames.length;
      await page.locator(`[data-key="${key}"]`).tap();
      await until(() => frames.length > frameCount, "optional modified key frame");
      if (["Home", "End", "PageUp", "PageDown"].includes(key!)) {
        assert.equal(frames.at(-1).type, "input");
        assert.equal(frames.at(-1).text, ({ Home: "\x1b[1;8H", End: "\x1b[1;8F", PageUp: "\x1b[5;8~", PageDown: "\x1b[6;8~" } as Record<string, string>)[key!]);
      } else assert.deepEqual(frames.at(-1).keys, [`ctrl+alt+shift+${name}`]);
      await until(() => read().length > before.length, `optional modified ${key} received by PTY`);
    }
    if (evidence) await page.screenshot({ path: join(evidence, `sticky-${mode}-phone.png`) });
    // Dropped text is also paste, even one character with every modifier held.
    const dropBefore = read();
    const dropFrames = frames.length;
    await page.locator(".xterm").evaluate((element) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData("text/plain", "z");
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    });
    await until(() => frames.length > dropFrames && read().length > dropBefore.length, "single-character drop received");
    assert.equal(frames[dropFrames].type, "input", "drop bypasses held modifiers");
    assert.equal(frames[dropFrames].text, "z");
    assert.equal(Buffer.from(read().slice(dropBefore.length).trim().split(/\s+/).join(""), "hex").toString(), "z");
    // Paste is text, including a single character; it must not become a shortcut.
    const pasteBefore = read();
    const pasteFrames = frames.length;
    await input.evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "x");
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    });
    await until(() => read().length > pasteBefore.length, "paste received");
    assert.equal(frames.slice(pasteFrames).some((frame) => frame.type === "keys"), false);
    assert.equal(Buffer.from(read().slice(pasteBefore.length), "hex").toString(), "x");
    // Deferred IME commits are text, including one character with every modifier held.
    for (const text of ["한", "한글"]) {
      const imeBefore = read();
      const imeFrames = frames.length;
      await input.evaluate((element, text) => {
        const box = element as HTMLTextAreaElement;
        box.value = "";
        box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        box.value = text;
        box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: text }));
        box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
      }, text);
      // a commit can reach the program in more than one read: wait for all of its bytes, two hex digits each
      await until(() => read().length - imeBefore.length >= Buffer.byteLength(text) * 2, "IME commit received");
      assert.equal(frames.slice(imeFrames).some((frame) => frame.type === "keys"), false, "IME commit bypasses held modifiers");
      assert.equal(Buffer.from(read().slice(imeBefore.length), "hex").toString(), text);
    }
    // A second composition starts before the first deferred commit runs.
    const burstBefore = read();
    const burstFrames = frames.length;
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      box.value = "";
      for (const text of ["한", "글"]) {
        box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        box.value += text;
        box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: text }));
        box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
      }
    });
    await until(() => Buffer.from(read().slice(burstBefore.length), "hex").toString() === "한글", "IME burst received");
    assert.equal(frames.slice(burstFrames).some((frame) => frame.type === "keys"), false, "consecutive IME commits bypass held modifiers");
    assert.equal(Buffer.from(read().slice(burstBefore.length), "hex").toString(), "한글");
    // Hardware modifiers combine with held touch modifiers as well.
    await held(2);
    await input.evaluate((element) => { (element as HTMLTextAreaElement).value = ""; });
    await input.focus();
    const hardwareBefore = read();
    await input.press("Control+Shift+d");
    await until(() => read().length > hardwareBefore.length, "hardware/touch combination received");
    assert.deepEqual(frames.at(-1).keys, ["ctrl+alt+shift+d"]);
    if (mode === "kitty") assert.equal(Buffer.from(read().slice(hardwareBefore.length), "hex").toString(), "\x1b[100;8u");
    // A physical key on a non-Latin layout names the chord by its position: Korean ㅊ on KeyC
    // with a held Ctrl is Ctrl+C (an interrupt herdr encodes), not ctrl+ㅊ (a letter it types).
    const layoutBefore = read();
    const layoutFrames = frames.length;
    // keydown and keyup both: xterm waits for the keypress of a key still down and ignores typed text
    await input.evaluate((element) => {
      for (const type of ["keydown", "keyup"]) element.dispatchEvent(new KeyboardEvent(type, { key: "ㅊ", code: "KeyC", keyCode: 67, ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await until(() => frames.length > layoutFrames, "non-Latin layout chord frame");
    assert.deepEqual(frames.at(-1).keys, ["ctrl+alt+c"], "a Korean-layout Ctrl+C with a held Alt");
    await until(() => read().length > layoutBefore.length, "non-Latin layout chord received by PTY");
    if (mode === "kitty") assert.equal(Buffer.from(read().slice(layoutBefore.length), "hex").toString(), "\x1b[99;7u");
    // A chord the terminal cannot take now is told, not dropped in silence: the page loses
    // input readiness, the key bar greys out, and a held-modifier key typed meanwhile is
    // answered with the not-sent banner. Nothing is queued for later.
    ws!.send(JSON.stringify({ type: "input-ready", pane_id: pane, ready: false }));
    await until(() => ctrl.isDisabled(), "key bar disabled while input is not ready");
    const notReadyFrames = frames.length;
    await page.keyboard.insertText("q");
    const notSent = page.locator(".terminal-banner", { hasText: "Not sent: the terminal is not ready for keys." });
    await notSent.waitFor({ state: "visible" });
    assert.equal(frames.slice(notReadyFrames).some((frame) => frame.type === "keys" || frame.type === "input"), false, "nothing sent while input is not ready");
    await notSent.locator(".terminal-banner-action").tap();
    await until(async () => (await notSent.count()) === 0, "not-sent banner dismissed");
    ws!.send(JSON.stringify({ type: "input-ready", pane_id: pane, ready: true }));
    await until(async () => !(await ctrl.isDisabled()), "key bar enabled again");
    console.log(`${mode} chord while not ready: told, not sent`);
    // Removing the optional Alt button must not leave an invisible held modifier.
    await page.keyboard.press(settingsShortcut);
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await openSettingsPage(page, "Terminal");
    await settings.getByRole("button", { name: "Edit key bar", exact: true }).tap();
    const keyBarSettings = page.getByRole("dialog", { name: "Key bar", exact: true });
    const heldModifierSettings = keyBarSettings.getByRole("group", { name: "Held modifiers", exact: true });
    await heldModifierSettings.getByRole("button", { name: "Alt", exact: true }).tap();
    await keyBarSettings.getByRole("button", { name: "Close settings", exact: true }).tap();
    assert.equal(await page.locator('[data-key="Alt"]').count(), 0);
    const plainBefore = frames.length;
    await until(async () => !(await ctrl.isDisabled()), "typing ready after settings");
    await input.evaluate((element) => { (element as HTMLTextAreaElement).value = ""; });
    await keyBarSettings.waitFor({ state: "hidden" });
    await input.focus();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await input.focus();
    await input.press("z");
    await until(() => frames.length > plainBefore, "typing after hiding Alt");
    assert.equal(frames.at(-1).type, "input");
    assert.equal(frames.at(-1).text, "z");
    await page.keyboard.press(settingsShortcut);
    await openSettingsPage(page, "Terminal");
    await settings.getByRole("button", { name: "Edit key bar", exact: true }).tap();
    await heldModifierSettings.getByRole("button", { name: "Alt", exact: true }).tap();
    await keyBarSettings.getByRole("button", { name: "Close settings", exact: true }).tap();
    previousMask = 0;
    assert.equal(await page.locator('[data-key="Alt"]').getAttribute("aria-pressed"), "false");
    // Leaving the terminal lens clears held state on the same pane.
    await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).tap();
    await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).tap();
    await until(async () => !(await ctrl.isDisabled()), "terminal lens ready again");
    for (const key of ["Control", "Alt", "Shift"]) assert.equal(await page.locator(`[data-key="${key}"]`).getAttribute("aria-pressed"), "false");
    previousMask = 0;
    // A cancelled chord or text says so in a banner. The banner column lets taps through to the
    // terminal under it, so its Dismiss has to take them back.
    ws!.send(JSON.stringify({ type: "error", code: "input_failed", message: "Terminal input could not be confirmed. Check the terminal before typing again.", pane_id: pane }));
    const refused = page.locator(".terminal-banner", { hasText: "Terminal input could not be confirmed" });
    await refused.waitFor();
    await refused.getByRole("button", { name: "Dismiss", exact: true }).tap({ timeout: 5_000 });
    await refused.waitFor({ state: "hidden" });
    assert.equal(await ctrl.isDisabled(), false, "a refused key leaves the pane ready for the next one");
    await input.focus();
    await held(7);
    // Disconnect clears all modifiers and sends no retained shortcuts on reconnect.
    await ws!.close();
    await until(async () => (await ctrl.getAttribute("aria-pressed")) === "false", "disconnect clears held Ctrl");
    for (const key of ["Alt", "Shift"]) assert.equal(await page.locator(`[data-key="${key}"]`).getAttribute("aria-pressed"), "false");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "phone has no horizontal page overflow");
    await context.close();
    console.log(`PASS ${mode}: seven modifier combinations, repeated keys, actual PTY bytes, touch focus, paste, IME, reset`);
  }
  assert.deepEqual(errors, []);
} finally {
  await launched?.close(); server.stop();
  for (const id of owned) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
}
