/** Replay the native Safari 26.6.2 trace from #432, not a claim to automate the OS IME. */
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import type { Browser } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import { IME_INITIAL_ATTACH_TIMEOUT, resetImeInput, selectImePane, waitForImeTerminal } from "./terminal-ime-ready.ts";

export async function checkSafariIme(browser: Browser, origin: string, pane: string, otherPane: string): Promise<void> {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.6.2 Safari/605.1.15",
    viewport: { width: 1100, height: 700 },
  });
  await context.addInitScript((pane) => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "direct" }));
    localStorage.setItem(`ovis:view:${pane}`, "terminal");
    // a probe still ending (its pong taken, not yet handled) ignores `online`: askUntilPing asks again
    // on each frame until the page sends a ping, which it then notes in `pinged`
    const w = window as { pinged?: boolean; askUntilPing?: () => void };
    w.askUntilPing = () => {
      w.pinged = false;
      const ask = (): void => { if (w.pinged) return; window.dispatchEvent(new Event("online")); requestAnimationFrame(ask); };
      ask();
    };
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (typeof data === "string" && data.startsWith('{"type":"ping"')) w.pinged = true;
        super.send(data);
      }
    };
  }, pane);
  const page = await context.newPage();
  const sent: Array<{ pane_id: string; text: string }> = [];
  const signals = new EventEmitter();
  const signal = (name: string) => once(signals, name, { signal: AbortSignal.timeout(10_000) });
  let toPage = (_frame: object): void => {};
  let toServer = (_frame: object): void => {};
  // a liveness probe's pings, held back while set: input is refused until their pong
  let holdPings = false;
  const heldPings: string[] = [];
  let releasePings = (): void => {};
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    const server = socket.connectToServer();
    toPage = (frame) => socket.send(JSON.stringify(frame));
    toServer = (frame) => server.send(JSON.stringify(frame));
    releasePings = () => { holdPings = false; for (const raw of heldPings.splice(0)) server.send(raw); };
    server.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "pong") signals.emit("pong");
      if (frame.type === "role-ack") signals.emit(`role:${frame.mode}`);
      socket.send(raw);
    });
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "input") { sent.push(frame); signals.emit(`input:${frame.text}`); }
      else if (frame.type === "ping" && holdPings) { heldPings.push(String(raw)); signals.emit("ping"); }
      else server.send(raw);
    });
  });
  const input = page.locator(".pane-frame.is-current .xterm-helper-textarea");
  const reset = async () => {
    await resetImeInput(page, pane);
    sent.length = 0;
  };
  // Safari 26.6.2 edits the DOM BEFORE keydown 229, with no composition events. Each
  // beforeinput selection is the range Safari replaces, including final consonants.
  // The keyCode and the keydown's place (before or after the edit) are parameters: the
  // recorded trace fixes them for typing, not for Backspace, Delete or punctuation.
  // "commit" is Safari 27.0.1's Backspace on a single jamo: the input method's unchanged
  // replacement first, then a keyCode 8 keydown whose default action deletes the jamo.
  const edit = async (type: string, data: string, start: number, end = start, keyCode = 229, order: "after" | "before" | "commit" | "blur" = "after") => {
    await input.evaluate(async (element, { type, data, start, end, keyCode, order }) => {
      const box = element as HTMLTextAreaElement;
      const key = keyCode === 8 ? "Backspace" : keyCode === 46 ? "Delete" : data;
      const keydown = () => box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, keyCode, isComposing: false }));
      const change = (type: string, data: string, start: number, end: number) => {
        box.setSelectionRange(start, end);
        box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, inputType: type, data, isComposing: false }));
        box.setRangeText(data, start, end, "end");
        box.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: type, data, isComposing: false }));
      };
      // A browser makes no DOM edit for a keydown that was cancelled before it.
      if (order !== "before" || keydown()) {
        change(type, data, start, end);
        if (order === "after") keydown();
        if (order === "commit" && keydown()) change("deleteContentBackward", "", start, start + data.length);
        if (order === "blur") box.blur();
      }
      box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key, keyCode: keyCode === 229 ? 71 : keyCode, isComposing: false }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }, { type, data, start, end, keyCode, order });
  };
  const syllable = async (parts: string[], at = 0) => {
    await edit("insertText", parts[0]!, at);
    for (const part of parts.slice(1)) await edit("insertReplacementText", part, at, at + 1);
  };
  const check = async (expected: string, label: string, owner = pane) => {
    const received = signal("input:\x07");
    await input.press("Control+g");
    await received;
    assert.equal(sent.map((frame) => frame.text).join(""), expected + "\x07", label);
    assert(sent.every((frame) => frame.pane_id === owner), `input stays with its pane ${owner}: ${JSON.stringify(sent)}`);
  };
  const report = (label: string, owner = pane) => console.log(`  ok ${label}: pane ${owner} bytes ${JSON.stringify(sent.map((frame) => frame.text).join(""))}`);
  // Dictation (and Safari's text replacement) replaces its hypothesis in place: each one an
  // insertReplacementText over the previous one, with no composition events. withKey adds the
  // keydown 229 Safari sends after an edit (#432's order).
  const dictate = (hypotheses: string[], withKey: boolean) => input.evaluate(async (element, { hypotheses, withKey }) => {
    const box = element as HTMLTextAreaElement;
    const from = box.value.length;
    for (const data of hypotheses) {
      box.setSelectionRange(from, box.value.length);
      box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, inputType: "insertReplacementText", data, isComposing: false }));
      box.setRangeText(data, from, box.value.length, "end");
      box.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data, isComposing: false }));
      if (withKey) {
        box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Unidentified", keyCode: 229, isComposing: false }));
        box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Unidentified", keyCode: 229, isComposing: false }));
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    return box.value.slice(from);
  }, { hypotheses, withKey });
  // SwiftKey (#3746 in Agent of Empires): letters as plain edits, then a composition that wraps the
  // word before the caret again and commits it, or a longer one.
  const typeText = (text: string) => input.evaluate(async (element, text) => {
    const box = element as HTMLTextAreaElement;
    for (const data of text) {
      box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, inputType: "insertText", data, isComposing: false }));
      box.setRangeText(data, box.value.length, box.value.length, "end");
      box.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data, isComposing: false }));
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, text);
  const composeWord = (data: string) => input.evaluate(async (element, data) => {
    const box = element as HTMLTextAreaElement;
    const from = box.value.length - (/\S*$/.exec(box.value)?.[0].length ?? 0);
    box.setSelectionRange(from, box.value.length);
    box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, inputType: "insertCompositionText", data, isComposing: true }));
    box.setRangeText(data, from, box.value.length, "end");
    box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data }));
    box.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertCompositionText", data, isComposing: true }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, data);
  try {
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`, { waitUntil: "domcontentloaded" });
    await waitForImeTerminal(page, pane, IME_INITIAL_ATTACH_TIMEOUT);
    await reset();
    await input.press("a"); await input.press("b"); await input.press("c");
    await syllable(["ㅎ", "하", "한"]);
    assert.equal(sent.map((frame) => frame.text).join(""), "abc", "provisional Hangul must stay local");
    await edit("insertReplacementText", "한", 0, 1);
    await syllable(["ㄱ", "그", "글"], 1);
    await edit("insertReplacementText", "글", 1, 2);
    await input.press("Space");
    await check("abc한글 ", "English prefix then Safari Hangul commits once, in order");

    for (const [key, expected] of [["Enter", "\r"], ["Shift+Enter", "\x1b\r"], ["Meta+Backspace", "\x15"], ["Meta+ArrowLeft", "\x01"], ["Meta+ArrowRight", "\x05"]]) {
      await reset(); await syllable(["ㅎ", "하", "한"]);
      await input.press(key!);
      await check("한" + expected, `Safari commit precedes ${key}`);
    }
    await reset(); await syllable(["ㄱ", "가", "갑", "값"]);
    await edit("insertReplacementText", "갑", 0, 1);
    await syllable(["사"], 1);
    await input.press("Space");
    await check("갑사 ", "moved final consonant comes from the corrected DOM");

    await reset(); await syllable(["ㅎ", "하", "한"]);
    await edit("insertReplacementText", "하", 0, 1);
    await edit("insertReplacementText", "ㅎ", 0, 1);
    await edit("deleteContentBackward", "", 0, 1);
    await input.press("a");
    await check("a", "deleting uncommitted Hangul sends no partial syllable or DEL");

    // Safari 27.0.1: the third Backspace deletes the last jamo and the fourth one reaches the pane.
    await reset(); await syllable(["ㅎ", "하", "한"]);
    await edit("insertReplacementText", "하", 0, 1);
    await edit("insertReplacementText", "ㅎ", 0, 1);
    await edit("insertReplacementText", "ㅎ", 0, 1, 8, "commit");
    await input.press("Backspace");
    await input.press("Space");
    await check("\x7f ", "Backspace past an emptied syllable sends one DEL");

    await reset(); await syllable(["ㅎ", "하", "한"]);
    await syllable(["ㄱ", "그", "글"], 1);
    await edit("insertReplacementText", "그", 1, 2);
    await edit("insertReplacementText", "ㄱ", 1, 2);
    await edit("insertReplacementText", "ㄱ", 1, 2, 8, "commit");
    await input.press("Backspace");
    await input.press("Space");
    await check("한\x7f ", "four Backspaces after 한글 preserve the committed prefix and send one DEL");

    // Blur commits a changed replacement before its keydown arrives; the next key is a new edit.
    await reset(); await syllable(["ㅎ", "하", "한"]);
    await edit("insertReplacementText", "하", 0, 1, 229, "blur");
    await input.focus();
    await input.press("Backspace");
    await check("하\x7f", "Backspace after blur finalizes an edit awaiting keydown sends one DEL");

    // Backspace and Delete may report their own keyCode, before or after Safari's edit.
    const failures: string[] = [];
    const variant = async (run: () => Promise<void>) => {
      try { await run(); } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
    };
    for (const order of ["after", "before"] as const) {
      await variant(async () => {
        await reset(); await syllable(["ㅎ", "하", "한"]);
        await edit("insertReplacementText", "하", 0, 1, 8, order);
        await edit("insertReplacementText", "한", 0, 1);
        await input.press("Space");
        await check("한 ", `Backspace keyCode 8 ${order} the edit stays inside the syllable`);
      });
      await variant(async () => {
        await reset(); await syllable(["ㅎ"]);
        await edit("deleteContentBackward", "", 0, 1, 8, order);
        await input.press("b");
        await check("b", `Backspace keyCode 8 ${order} emptying the preedit sends nothing`);
      });
      await variant(async () => {
        await reset(); await syllable(["ㅎ", "하", "한"]);
        await edit("deleteContentForward", "", 0, 1, 46, order);
        await input.press("b");
        await check("b", `Delete ${order} removing the preedit sends nothing`);
      });
      await variant(async () => {
        await reset(); await syllable(["ㅎ", "하", "한"]);
        await edit("insertText", ".", 1, 1, 229, order);
        await input.press("Space");
        await check("한. ", `punctuation with keydown 229 ${order} the edit follows the syllable`);
      });
    }
    assert.deepEqual(failures, [], failures.join("\n"));

    await reset(); await syllable(["ㅎ", "하", "한"]);
    const blurred = signal("input:한");
    await input.evaluate((box) => (box as HTMLTextAreaElement).blur());
    await blurred;
    await input.focus();
    await check("한", "blur commits the last pending syllable once");

    await reset(); await syllable(["ㅎ", "하", "한"]);
    await input.evaluate((box) => {
      const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", "x");
      box.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    });
    const pasted = signal("input:\x07");
    await input.press("Control+g");
    await pasted;
    assert.deepEqual(sent.map((frame) => frame.text), ["한", sent[1]?.text, "\x07"]);
    assert(["x", "\x1b[200~x\x1b[201~"].includes(sent[1]!.text), "native paste follows the commit with its usual framing");

    await reset();
    await input.evaluate(async (element) => {
      const box = element as HTMLTextAreaElement;
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertCompositionText", data: "한", isComposing: true }));
      box.value = "한";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "한" }));
      box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "한", isComposing: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" }));
    });
    await check("한", "real composition events on Safari keep the existing path");

    await reset(); await syllable(["ㅎ", "하", "한"]);
    // A programmatic pane change does not blur first: reset must cancel pending text.
    await selectImePane(page, otherPane);
    await check("", "pending Safari text cannot enter another pane", otherPane);
    await selectImePane(page, pane);

    const hypotheses = ["thi", "this", "this is", "this is a test", "This is a test."];
    for (const withKey of [false, true]) {
      await reset();
      assert.equal(await dictate(hypotheses, withKey), "This is a test.", "the field ends on the corrected phrase");
      await check("This is a test.", `dictation replacement commits one corrected phrase${withKey ? ", keydown 229 after each edit" : ""}`);
      report(`dictation replacement commits one corrected phrase${withKey ? " (keydown 229 after each edit)" : ""}`);
    }
    await reset(); await dictate(hypotheses, false);
    await input.press("Backspace");
    await check("This is a test", "Backspace after dictation edits the phrase, never a sent byte");
    report("Backspace after dictation edits the pending phrase");
    await reset(); await dictate(hypotheses, true);
    await input.press("Enter");
    await check("This is a test.\r", "dictation commits before Enter");
    report("dictation commits before Enter");
    await reset();
    await input.evaluate((box) => {
      box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Shift", keyCode: 16 }));
      (box as HTMLTextAreaElement).blur();
    });
    await input.focus();
    await dictate(hypotheses, false);
    await check("This is a test.", "dictation after blur does not depend on the old keyup");

    // SwiftKey's retrospective compositions over a word already sent.
    for (const [label, run, expected] of [
      ["test, test again, space", async () => { await typeText("test"); await composeWord("test"); await typeText(" "); }, "test "],
      ["tes extended to test", async () => { await typeText("tes"); await composeWord("test"); }, "test"],
      ["tes, test twice, space", async () => { await typeText("tes"); await composeWord("test"); await composeWord("test"); await typeText(" "); }, "test "],
    ] as const) {
      await reset(); await run();
      await check(expected, `SwiftKey repeats a word without duplication: ${label}`);
      report(`SwiftKey repeats a word without duplication: ${label}`);
    }

    // Refused contexts: text committed where it may not go is gone, and the next accepted key
    // carries nothing of it (no stale syllable, phrase or DEL).
    // A role loss mid-syllable, acknowledged by the server: the commit while observing is dropped.
    await reset(); await syllable(["ㅎ", "하", "한"]);
    const observing = signal("role:observe");
    toServer({ type: "role", mode: "observe" });
    await observing;
    await page.locator(".pane-frame.is-current .terminal-banner-observe").waitFor();
    await input.press("Space");
    const interacting = signal("role:interact");
    toServer({ type: "role", mode: "interact" });
    await interacting;
    await page.locator(".pane-frame.is-current .terminal-banner-observe").waitFor({ state: "detached" });
    await input.focus();
    await input.press("a");
    await check("a", "refused context cannot seed the next accepted rewrite: a syllable committed while observing");
    report("refused context cannot seed the next accepted rewrite: role lost mid-syllable");
    // Dictation spoken while observing is refused, and is gone once the role comes back: the next
    // accepted key commits nothing of it.
    await reset();
    const observingDictation = signal("role:observe");
    toServer({ type: "role", mode: "observe" });
    await observingDictation;
    await page.locator(".pane-frame.is-current .terminal-banner-observe").waitFor();
    await dictate(hypotheses, false);
    const interactingAfterDictation = signal("role:interact");
    toServer({ type: "role", mode: "interact" });
    await interactingAfterDictation;
    await page.locator(".pane-frame.is-current .terminal-banner-observe").waitFor({ state: "detached" });
    await input.focus();
    await input.press("a");
    await check("a", "refused context cannot seed the next accepted rewrite: dictation while observing");
    report("refused context cannot seed the next accepted rewrite: dictated while observing");

    // A lost attachment: the committed syllable waits in the draft, later typing joins it, and only
    // Send sends it, once; a discarded draft leaves nothing for the next key.
    const notReady = async () => {
      await syllable(["ㅎ", "하", "한"]);
      toPage({ type: "input-ready", pane_id: pane, ready: false });
      await page.getByText("Waiting for terminal input…").first().waitFor({ state: "attached" });
      await input.press("Space");
      await page.waitForFunction(() => document.querySelector(".draft-text")?.textContent === "한 ");
      toPage({ type: "input-ready", pane_id: pane, ready: true });
      await page.getByText("Waiting for terminal input…").first().waitFor({ state: "detached" });
      await input.focus();
      await input.press("a");
      await page.waitForFunction(() => document.querySelector(".draft-text")?.textContent === "한 a");
    };
    await reset(); await notReady();
    const held = signal("input:한 a");
    await page.locator(".draft-send").click();
    await held;
    await page.locator(".pane-frame.is-current .terminal-banner-draft").waitFor({ state: "detached" });
    await check("한 a", "a draft held while the pane was not ready is sent once, by Send");
    report("refused context: the held draft reaches the pane only by Send");
    await reset(); await notReady();
    await page.locator(".draft-discard").click();
    await page.locator(".pane-frame.is-current .terminal-banner-draft").waitFor({ state: "detached" });
    await input.focus();
    await input.press("b");
    await check("b", "refused context cannot seed the next accepted rewrite: a discarded draft");
    report("refused context cannot seed the next accepted rewrite: draft discarded");
    // Dictation spoken while the pane is not ready belongs to the draft even when readiness returns
    // before the next key: the phrase and that key wait there, and only Send sends them, once.
    await reset();
    toPage({ type: "input-ready", pane_id: pane, ready: false });
    await page.getByText("Waiting for terminal input…").first().waitFor({ state: "attached" });
    await dictate(hypotheses, false);
    toPage({ type: "input-ready", pane_id: pane, ready: true });
    await page.getByText("Waiting for terminal input…").first().waitFor({ state: "detached" });
    await input.focus();
    await input.press("a");
    await check("", "refused context cannot seed the next accepted rewrite: dictation while not ready waits for Send");
    assert.equal(await page.locator(".draft-text").textContent(), "This is a test.a", "the dictated phrase and the next key wait in the draft");
    report("refused context cannot seed the next accepted rewrite: dictated while not ready, held in the draft");
    sent.length = 0;
    const heldPhrase = signal("input:This is a test.a");
    await page.locator(".draft-send").click();
    await heldPhrase;
    await page.locator(".pane-frame.is-current .terminal-banner-draft").waitFor({ state: "detached" });
    await check("This is a test.a", "a dictated draft is sent once, by Send");
    report("refused context: the dictated draft reaches the pane only by Send");

    // A liveness probe refuses input until its pong, and may end between two readiness polls:
    // a phrase dictated while its ping is out still goes to the draft, never to the pane.
    await reset();
    holdPings = true;
    const pinged = signal("ping");
    await page.evaluate(() => (window as { askUntilPing?: () => void }).askUntilPing?.());
    await pinged;
    await dictate(hypotheses, false);
    const ponged = signal("pong");
    releasePings();
    await ponged;
    await input.focus();
    await input.press("a");
    await check("", "refused context cannot seed the next accepted rewrite: dictation during a liveness probe waits for Send");
    assert.equal(await page.locator(".draft-text").textContent(), "This is a test.a", "the phrase dictated during the probe and the next key wait in the draft");
    report("refused context cannot seed the next accepted rewrite: dictated during a liveness probe, held in the draft");
    sent.length = 0;
    const probedPhrase = signal("input:This is a test.a");
    await page.locator(".draft-send").click();
    await probedPhrase;
    await page.locator(".pane-frame.is-current .terminal-banner-draft").waitFor({ state: "detached" });
    await check("This is a test.a", "a draft dictated during a probe is sent once, by Send");

    // A pane switch during a pending dictation phrase: neither pane receives it.
    await reset(); await dictate(hypotheses.slice(0, 3), false);
    await selectImePane(page, otherPane);
    await input.focus();
    await input.press("x");
    await check("x", "refused context cannot seed the next accepted rewrite: a pane switch mid-dictation", otherPane);
    report("refused context cannot seed the next accepted rewrite: pane switched mid-dictation", otherPane);
    console.log("PASS Safari native-event replay: English/Hangul, commit keys, final consonants, deletion, blur, pane reset, dictation, SwiftKey and refused contexts");
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
  const root = mkdtempSync(join(tmpdir(), "herdr-safari-replay-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "" });
  const owned: string[] = [];
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: chromePath(), headless: true });
    const panes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const made = await workspaceCreate({ cwd: root, label: "ovis-test-safari-replay" });
      owned.push(made.workspace.workspace_id); panes.push(made.root_pane.pane_id);
    }
    await checkSafariIme(browser, `http://127.0.0.1:${server.port}`, panes[0]!, panes[1]!);
  } finally {
    await browser?.close(); server.stop();
    for (const workspace of owned) await workspaceClose(workspace);
    rmSync(root, { recursive: true, force: true });
  }
}
