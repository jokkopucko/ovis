/** Replay the native iPadOS Safari + hardware keyboard and iPhone on-screen keyboard traces (Korean 2-set), not a claim to automate the OS IME. */
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdirSync } from "node:fs";
import type { Browser } from "playwright-core";

/**
 * iPadOS 27 Safari with a Magic Keyboard sends each jamo as a printable keydown (its own keyCode,
 * not 229, isComposing false), then a keypress, then composes in the editor: a new syllable is an
 * insertText, a changed one is deleteContentBackward followed by insertText of the whole result.
 * There are no composition events. Recorded with scripts/terminal-ime-diagnostic.ts on 2026-10-13.
 * The iPhone's on-screen Korean keyboard (iOS 27 simulator, Safari, 2026-10-18) edits the same way,
 * with keyCode 0 on each jamo's keydown. So does the Ovis iOS app (iOS 27 simulator, 2026-10-29),
 * whose WKWebView reports no "Safari" in its user agent: there each jamo reached the pane on its own.
 */
export async function checkIpadIme(browser: Browser, origin: string, pane: string, otherPane: string): Promise<void> {
  // one context for both iPad platforms: the page, not the context, carries the platform it reports
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15",
    viewport: { width: 1100, height: 700 },
  });
  // an iPhone's user agent: the terminal also keeps a space in its field there (#862)
  const iphone = await browser.newContext({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 1100, height: 700 },
  });
  // the Ovis iOS app's web view, as recorded: WebKit, but no Version/ or Safari/ in its user agent
  const iphoneApp = await browser.newContext({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    viewport: { width: 1100, height: 700 },
  });
  try {
  // the platform iPadOS Safari reports by default (desktop site), the one it reports otherwise,
  // an iPhone's, and the iPhone app's
  for (const platform of ["MacIntel", "iPad", "iPhone", "iPhone app"]) {
    const page = await (platform === "iPhone" ? iphone : platform === "iPhone app" ? iphoneApp : context).newPage();
    await page.addInitScript(({ pane, platform }) => {
      Object.defineProperty(navigator, "platform", { get: () => platform });
      Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 });
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "direct" }));
      localStorage.setItem(`ovis:view:${pane}`, "terminal");
    }, { pane, platform: platform === "iPhone app" ? "iPhone" : platform });
    const sent: Array<{ pane_id: string; text: string }> = [];
    // key frames (a key-bar chord), with how many input frames came before each
    const keyed: Array<{ pane_id: string; keys: string[]; after: number }> = [];
    const signals = new EventEmitter();
    const signal = (name: string) => once(signals, name, { signal: AbortSignal.timeout(10_000) });
    // output for the page as if the pane wrote it: input here never reaches the pane to echo
    let toPage = (_data: string): void => {};
    await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
      const server = socket.connectToServer();
      toPage = (data) => socket.send(JSON.stringify({ type: "pty-data", pane_id: pane, data }));
      server.onMessage((raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "input-ready" && frame.ready !== false) signals.emit("ready");
        socket.send(raw);
      });
      socket.onMessage((raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "input") { sent.push(frame); signals.emit(`input:${frame.text}`); }
        else if (frame.type === "keys") { keyed.push({ pane_id: frame.pane_id, keys: frame.keys, after: sent.length }); signals.emit("keys"); }
        else server.send(raw);
      });
    });
    const input = page.locator(".xterm-helper-textarea:visible");
    const reset = async () => {
      const ready = signal("ready");
      await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
      await ready;
      await input.focus();
      assert.equal(await input.inputValue(), " ", "touch devices keep the Backspace repeat space");
      sent.length = 0;
      keyed.length = 0;
    };
    // the pane and the exact bytes a named assertion saw, JSON-escaped
    const report = (label: string, owner = pane) => console.log(`  ok ${platform}: ${label}: pane ${owner} bytes ${JSON.stringify(sent.map((frame) => frame.text).join(""))}${keyed.length ? ` keys ${JSON.stringify(keyed)}` : ""}`);
    // iOS dictation replaces its hypothesis in place: insertReplacementText over the previous one,
    // no key and no composition events.
    const dictate = (hypotheses: string[]) => input.evaluate(async (element, hypotheses) => {
      const box = element as HTMLTextAreaElement;
      const from = box.value.length;
      for (const data of hypotheses) {
        box.setSelectionRange(from, box.value.length);
        box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, inputType: "insertReplacementText", data, isComposing: false }));
        box.setRangeText(data, from, box.value.length, "end");
        box.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data, isComposing: false }));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return box.value.slice(from);
    }, hypotheses);
    // A keyboard that commits a whole string as one key (FluidVoice's dictation, any keyboard
    // extension calling insertText): WebKit names the string as the keydown's key, sends a keypress
    // with its first character's charCode, then inserts the whole string (iOS 27 simulator, #1488).
    // `inserted` is what the editor inserts after the keypress, if anything.
    const insertWhole = (text: string, keyCode: number, inserted: string | null = text) => input.evaluate(async (element, { text, keyCode, inserted }) => {
      const box = element as HTMLTextAreaElement;
      const down = box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: text, code: "Unidentified", keyCode }));
      const charCode = text.codePointAt(0)!;
      const press = down && box.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, cancelable: true, composed: true, key: text, code: "Unidentified", keyCode: charCode, charCode }));
      if (down && press && inserted !== null) {
        box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType: "insertText", data: inserted, isComposing: false }));
        box.setRangeText(inserted, box.selectionStart, box.selectionEnd, "end");
        box.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: inserted, isComposing: false }));
      }
      box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed: true, key: text, code: "Unidentified", keyCode }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }, { text, keyCode, inserted });
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
    // One key of the recorded order: keydown (jamo, real keyCode), keypress, then the editor's
    // edits. A cancelled keydown means a browser makes no edit, which is the failure this guards.
    const KEYCODES: Record<string, number> = { "ㅎ": 71, "ㅏ": 75, "ㄴ": 83, "ㄱ": 82, "ㅡ": 77, "ㄹ": 70, "ㅇ": 68, "ㅁ": 65 };
    const key = async (jamo: string, edits: Array<["delete"] | ["insert", string]>, moveCaret = false) => {
      return input.evaluate(async (element, { jamo, keyCode, edits, moveCaret }) => {
        const box = element as HTMLTextAreaElement;
        if (moveCaret) box.setSelectionRange(0, 0);
        const down = box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: jamo, code: "", keyCode, isComposing: false }));
        const press = down && box.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, cancelable: true, key: jamo, keyCode: jamo.charCodeAt(0), charCode: jamo.charCodeAt(0) }));
        if (down && press) {
          for (const edit of edits) {
            if (edit[0] === "delete") {
              const end = box.selectionEnd;
              const start = box.selectionStart === end ? Math.max(0, end - 1) : box.selectionStart;
              box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, inputType: "deleteContentBackward", isComposing: false }));
              box.setRangeText("", start, end, "end");
              box.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "deleteContentBackward", isComposing: false }));
            } else {
              box.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, inputType: "insertText", data: edit[1], isComposing: false }));
              box.setRangeText(edit[1], box.selectionStart, box.selectionEnd, "end");
              box.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: edit[1], isComposing: false }));
            }
          }
        }
        box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: jamo, keyCode, isComposing: false }));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return down;
      }, { jamo, keyCode: platform.startsWith("iPhone") ? 0 : KEYCODES[jamo] ?? 65, edits, moveCaret });
    };
    const fresh = (jamo: string) => key(jamo, [["insert", jamo]]);
    const replace = (jamo: string, result: string) => key(jamo, [["delete"], ["insert", result]]);
    const check = async (expected: string, label: string) => {
      const received = signal("input:\x07");
      await input.press("Control+g");
      await received.catch((error) => { throw new Error(`no sentinel for "${label}" (platform ${platform}): input ${JSON.stringify(sent)} keys ${JSON.stringify(keyed)}`, { cause: error }); });
      assert.equal(sent.map((frame) => frame.text).join(""), expected + "\x07", `${label} (platform ${platform})`);
      assert(sent.every((frame) => frame.pane_id === pane), "input stays with its pane");
    };
    try {
      await reset();
      await key("ㅎ", [["insert", "ㅎ"]], true);
      await check("ㅎ", "the first Hangul jamo after caret 0 is sent instead of the kept space");
      console.log(`  ok ${platform}: caret 0 then first Hangul jamo sent ${JSON.stringify(sent.map((frame) => frame.text).join(""))}`);

      await reset();
      await key("ㅎ", [["insert", "ㅎ"]], true);
      await replace("ㅏ", "하"); await replace("ㄴ", "한");
      await check("한", "Hangul after moving before the kept space sends the syllable, not the space");
      console.log(`  ok ${platform}: caret 0 then Hangul sent ${JSON.stringify(sent.map((frame) => frame.text).join(""))}`);

      await reset();
      const compositionCaret = await input.evaluate(async (element) => {
        const box = element as HTMLTextAreaElement;
        box.setSelectionRange(0, 0);
        box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Process", keyCode: 229 }));
        const caret = [box.selectionStart, box.selectionEnd];
        box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
        box.setRangeText("日本", box.selectionStart, box.selectionEnd, "end");
        box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "日本" }));
        box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "日本", isComposing: true }));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }));
        return caret;
      });
      assert.deepEqual(compositionCaret, [1, 1], "keydown 229 restores the caret before composition starts");
      await check("日本", "keydown 229 restores the caret before Japanese composition");
      console.log(`  ok ${platform}: caret 0 then Japanese sent ${JSON.stringify(sent.map((frame) => frame.text).join(""))}`);

      await reset();
      await input.evaluate((element) => {
        const box = element as HTMLTextAreaElement;
        box.blur();
        box.value = " ";
        box.setSelectionRange(0, 0);
        box.focus();
      });
      assert.deepEqual(await input.evaluate((box) => [(box as HTMLTextAreaElement).selectionStart, (box as HTMLTextAreaElement).selectionEnd]), [1, 1], "focus restores the caret after the kept space");
      await input.evaluate((element) => {
        const box = element as HTMLTextAreaElement;
        box.setSelectionRange(0, 0);
        for (const repeat of [false, true, true]) {
          box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace", keyCode: 8, repeat }));
        }
      });
      await check("\x7f\x7f\x7f", "held Backspace still sends every repeat after moving the caret");
      console.log(`  ok ${platform}: focus and held Backspace restore the kept-space caret`);

      await reset();
      await input.press("a"); await input.press("b"); await input.press("c");
      assert.equal(await fresh("ㅎ"), true, `a Hangul keydown is left to the editor (platform ${platform})`);
      await replace("ㅏ", "하"); await replace("ㄴ", "한");
      assert.equal(sent.map((frame) => frame.text).join(""), "abc", "provisional Hangul stays local, no jamo is sent");
      await fresh("ㄱ"); await replace("ㅡ", "그"); await replace("ㄹ", "글");
      await input.press("Space");
      await check("abc한글 ", "English then iPad Hangul commits each syllable once, in order");
      // the syllable being typed is drawn at the size its row gives the committed ones
      // (terminalGlyphs enlarges a two-cell glyph that leaves its cells half empty)
      toPage("\r\n한 ");
      await page.waitForFunction(() => [...document.querySelectorAll(".xterm-rows span")].some((span) => span.textContent?.includes("한")));
      await fresh("ㄱ"); await replace("ㅡ", "그");
      const sizes = await page.evaluate(() => {
        const row = [...document.querySelectorAll<HTMLElement>(".xterm-rows span")].find((span) => span.textContent?.includes("한"))!;
        // the fit is drawn by a span inside the row's (terminalGlyphs.ts), which carries any enlarged size
        const glyph = row.querySelector<HTMLElement>(".herdr-box-glyph") ?? row;
        const view = document.querySelector<HTMLElement>(".composition-view")!;
        return { row: getComputedStyle(glyph).fontSize, view: getComputedStyle(view).fontSize, pending: view.classList.contains("active") ? view.textContent : null };
      });
      assert.equal(sizes.pending, "그", "a syllable is pending");
      assert(Math.abs(Number.parseFloat(sizes.view) - Number.parseFloat(sizes.row)) < 0.01,
        `the pending syllable is drawn at its row's size: ${sizes.view} against ${sizes.row} (platform ${platform})`);

      await reset();
      // 망 then ㅏ: the final ㅇ moves on and the editor puts back two syllables at once
      await fresh("ㅁ"); await replace("ㅏ", "마"); await replace("ㅇ", "망"); await replace("ㅏ", "마아");
      await input.press("Space");
      await check("마아 ", "a two-syllable replacement commits both");

      for (const [press, expected] of [["Enter", "\r"], ["Control+c", "\x03"], ["Tab", "\t"]]) {
        await reset(); await fresh("ㅎ"); await replace("ㅏ", "하"); await replace("ㄴ", "한");
        await input.press(press!);
        await check("한" + expected, `iPad commit precedes ${press}`);
      }

      // the key bar's keys reach xterm through term.input, not a keydown: they follow the syllable too
      await reset(); await fresh("ㅎ"); await replace("ㅏ", "하"); await replace("ㄴ", "한");
      const escape = page.locator('.key-bar .key[data-key="Escape"]');
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.key-bar .key[data-key="Escape"]')?.disabled === false);
      await escape.evaluate((node: HTMLElement) => node.click());
      await check("한\x1b", "the pending syllable precedes a key-bar key");

      await reset(); await fresh("ㅎ"); await replace("ㅏ", "하"); await replace("ㄴ", "한");
      const blurred = signal("input:한");
      await input.evaluate((box) => (box as HTMLTextAreaElement).blur());
      await blurred;
      await input.focus();
      await check("한", "blur commits the pending syllable once");

      if (process.env.UI_EVIDENCE_DIR) {
        mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
        toPage("\r\nCaret replay passed: 한 日本\r\n");
        await page.waitForFunction(() => [...document.querySelectorAll(".xterm-rows span")].some((span) => span.textContent?.includes("Caret replay passed")));
        for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
          await page.setViewportSize(viewport);
          await page.locator('.view-switch button[title^="Live terminal"]').click();
          await page.waitForFunction(() => {
            const terminal = document.querySelector(".terminal-host");
            return terminal && terminal.getBoundingClientRect().width > Math.min(innerWidth - 40, 600);
          });
          await page.screenshot({ path: `${process.env.UI_EVIDENCE_DIR}/${platform}-${viewport.width}x${viewport.height}.png`, animations: "disabled" });
        }
        await page.setViewportSize({ width: 1100, height: 700 });
      }

      // Dictation: the hypotheses stay in the field, and the corrected phrase is sent once.
      const hypotheses = ["thi", "this", "this is", "this is a test", "This is a test."];
      await reset();
      assert.equal(await dictate(hypotheses), "This is a test.", "the field ends on the corrected phrase");
      await check("This is a test.", "dictation replacement commits one corrected phrase");
      report("dictation replacement commits one corrected phrase");

      for (const [label, text, keyCode] of [
        ["a sentence", "hello world this is a test", 72],
        ["a capitalised word", "Yes", 89],
        ["Hangul", "안녕하세요", 0],
        // WebKit's charCode is the first code point, here outside the BMP
        ["an emoji first", "😀 hello", 0],
        ["a CJK extension character first", "𠮷野家", 0],
      ] as const) {
        await reset();
        await insertWhole(text, keyCode);
        await check(text, `a whole string committed as one key is sent whole, once: ${label}`);
        report(`a whole string committed as one key is sent whole, once: ${label}`);
      }
      // with no insertion of that string, the keypress's own character goes, as it always did
      for (const [label, inserted] of [["no insertion", null], ["another insertion", "hey "]] as const) {
        await reset();
        // sent by the keyup (or the insertion) itself, not left for a later key to flush
        const sentAlone = signal("input:h");
        await insertWhole("hey", 72, inserted);
        await sentAlone;
        await check("h", `a whole-string key with ${label} sends its keypress's character`);
        report(`a whole-string key with ${label} sends its keypress's character`);
      }
      // typing goes on as before after it: a letter, then a Hangul syllable composed in the editor
      await reset();
      await insertWhole("hello world", 72);
      await input.press("x");
      await fresh("ㅎ"); await replace("ㅏ", "하");
      await input.press("Space");
      await check("hello worldx하 ", "typing after a whole-string key");
      report("typing after a whole-string key");
      // a syllable still being typed goes first, then the whole string, each once
      await reset();
      await fresh("ㅎ"); await replace("ㅏ", "하");
      await insertWhole("hello", 72);
      await check("하hello", "a whole-string key after a pending syllable");
      report("a whole-string key after a pending syllable");

      for (const [label, run, expected] of [
        ["test, test again, space", async () => { await typeText("test"); await composeWord("test"); await typeText(" "); }, "test "],
        ["tes extended to test", async () => { await typeText("tes"); await composeWord("test"); }, "test"],
        ["tes, test twice, space", async () => { await typeText("tes"); await composeWord("test"); await composeWord("test"); await typeText(" "); }, "test "],
      ] as const) {
        await reset(); await run();
        await check(expected, `SwiftKey repeats a word without duplication: ${label}`);
        report(`SwiftKey repeats a word without duplication: ${label}`);
      }

      // The key bar's Ctrl stays held until tapped again, and turns a typed letter or a key-bar key
      // into a chord. A syllable still being typed is text: it goes first, never as the chord, and the
      // next syllable starts clean (no c, no DEL).
      const ctrl = page.locator('.key-bar .key[data-key="Control"]');
      await reset(); await fresh("ㅎ"); await replace("ㅏ", "하");
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.key-bar .key[data-key="Control"]')?.disabled === false);
      await ctrl.evaluate((node: HTMLElement) => node.click());
      let chord = signal("keys");
      await input.press("c");
      await chord.catch((error) => { throw new Error(`no key frame for the held Ctrl and c (platform ${platform}): input ${JSON.stringify(sent)}`, { cause: error }); });
      await ctrl.evaluate((node: HTMLElement) => node.click());
      await fresh("ㄱ"); await replace("ㅡ", "그");
      await ctrl.evaluate((node: HTMLElement) => node.click());
      chord = signal("keys");
      await page.locator('.key-bar .key[data-key="Escape"]').evaluate((node: HTMLElement) => node.click());
      await chord.catch((error) => { throw new Error(`no key frame for the held Ctrl and the key bar's Esc (platform ${platform}): input ${JSON.stringify(sent)}`, { cause: error }); });
      await ctrl.evaluate((node: HTMLElement) => node.click());
      await fresh("ㅎ");
      await check("하그ㅎ", "refused context cannot seed the next accepted rewrite: a held Ctrl chord");
      assert.deepEqual(keyed, [{ pane_id: pane, keys: ["ctrl+c"], after: 1 }, { pane_id: pane, keys: ["ctrl+esc"], after: 2 }],
        `each chord follows its syllable, as one key frame: ${JSON.stringify(keyed)}`);
      report("refused context cannot seed the next accepted rewrite: held Ctrl chord");

      // A pane switch during a pending dictation phrase: neither pane receives it.
      await reset(); await dictate(hypotheses.slice(0, 3));
      const away = signal("ready");
      await page.locator(`.pane-select[title^="${otherPane} —"]`).first().evaluate((node: HTMLElement) => node.click());
      await page.waitForFunction((pane) => JSON.parse(localStorage.getItem("ovis:selection") ?? "null")?.pane_id === pane, otherPane);
      await away;
      const ended = signal("input:\x07");
      await input.focus();
      await input.press("x");
      await input.press("Control+g");
      await ended;
      assert.equal(sent.map((frame) => frame.text).join(""), "x\x07", "refused context cannot seed the next accepted rewrite: a pane switch mid-dictation");
      assert(sent.every((frame) => frame.pane_id === otherPane), `input goes to the pane switched to: ${JSON.stringify(sent)}`);
      report("refused context cannot seed the next accepted rewrite: pane switched mid-dictation", otherPane);

      await reset(); await fresh("ㅎ"); await replace("ㅏ", "하");
      const switched = signal("ready");
      await page.locator(`.pane-select[title^="${otherPane} —"]`).first().evaluate((node: HTMLElement) => node.click());
      await page.waitForFunction((pane) => JSON.parse(localStorage.getItem("ovis:selection")!).pane_id === pane, otherPane);
      await switched;
      const received = signal("input:\x07");
      await input.press("Control+g");
      await received;
      assert.equal(sent.map((frame) => frame.text).join(""), "\x07", "pending iPad text cannot enter another pane");
      console.log(`  ok navigator.platform ${platform}`);
    } finally {
      // left open until the context closes: closing a page whose WebSocket is routed took the
      // whole headless browser down on macOS
      await page.goto("about:blank").catch(() => {});
    }
  }
  } finally { await context.close(); await iphone.close(); await iphoneApp.close(); }
  console.log("PASS iPad hardware-keyboard and iPhone keyboard replay: jamo keys composed in the editor, pending syllable at its row's size, commit keys, two-syllable replacement, blur, pane reset, dictation, SwiftKey and refused contexts");
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { createServer } = await import("../server/index.ts");
  const { workspaceCreate, workspaceClose } = await import("../server/herdr/client.ts");
  const { chromium } = await import("playwright-core");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "herdr-ipad-replay-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "" });
  console.log(`QA resources: pid=${process.pid} port=${server.port} state=${root}`);
  const owned: string[] = [];
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true });
    const panes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const made = await workspaceCreate({ cwd: root, label: "ovis-test-ipad-replay" });
      owned.push(made.workspace.workspace_id); panes.push(made.root_pane.pane_id);
    }
    await checkIpadIme(browser, `http://127.0.0.1:${server.port}`, panes[0]!, panes[1]!);
  } finally {
    await browser?.close(); server.stop();
    for (const workspace of owned) await workspaceClose(workspace);
    rmSync(root, { recursive: true, force: true });
  }
}
