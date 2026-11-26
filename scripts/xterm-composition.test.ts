import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { join } from "node:path";
import { buildXtermSource, xtermSourcePlugin } from "./build-xterm.ts";

// Exercise the patched source Vite ships, without a browser, server or herdr session.
const source = buildXtermSource(join(import.meta.dir, ".."));
const bundle = await Bun.build({
  entrypoints: [join(source, "browser/input/CompositionHelper.js"), join(source, "browser/CoreBrowserTerminal.js")],
  plugins: [xtermSourcePlugin(source)], target: "bun",
});
if (!bundle.success) throw new AggregateError(bundle.logs, "Could not build the composition helper");
const load = async (name: string, from = bundle) => {
  const output = from.outputs.find(({ path }) => path.endsWith(`/${name}.js`))!;
  return import(`data:text/javascript;base64,${Buffer.from(await output.text()).toString("base64")}`);
};
const { CompositionHelper } = await load("CompositionHelper");
const { CoreBrowserTerminal } = await load("CoreBrowserTerminal");

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

function editor(term?: any, Helper = CompositionHelper) {
  const sent: string[] = [];
  const textarea = Object.assign(new EventTarget(), {
    value: "", selectionStart: 0, selectionEnd: 0, style: {},
    focus() {},
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; },
  });
  const element = Object.assign(new EventTarget(), { classList: { add() {}, remove() {} } });
  const view = { textContent: "", classList: { add() {}, remove() {} } };
  const helper = new Helper(textarea, view,
    { buffer: { isCursorInViewport: false } },
    { rawOptions: { screenReaderMode: false } },
    term?.coreService ?? { triggerDataEvent: (text: string) => sent.push(text) }, {});
  if (term) {
    Object.assign(term, {
      textarea, element, _compositionHelper: helper,
      screenElement: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
      _selectionService: { selectionText: "screen-output", shouldColumnSelect: () => false, reset() {} },
    });
    term.onData((text: string) => sent.push(text));
    term._initGlobal();
  } else {
    textarea.addEventListener("compositionstart", () => helper.compositionstart());
    textarea.addEventListener("compositionupdate", (event) => helper.compositionupdate(event));
    textarea.addEventListener("compositionend", () => helper.compositionend());
    textarea.addEventListener("keydown", (event) => helper.keydown(event));
    textarea.addEventListener("beforeinput", (event) => helper.beforeinput(event));
    textarea.addEventListener("input", (event) => helper.input(event, true));
  }
  const event = (type: string, fields: Record<string, unknown> = {}, target: EventTarget = textarea) =>
    target.dispatchEvent(Object.assign(new Event(type, { bubbles: true, composed: true }), fields));
  const value = (text: string) => {
    textarea.value = text;
    textarea.selectionStart = textarea.selectionEnd = text.length;
  };
  const compose = (text: string) => {
    const prefix = textarea.value;
    event("keydown", { keyCode: 229 });
    event("compositionstart");
    let preedit = "";
    for (const character of text) {
      if (preedit) event("keydown", { keyCode: 229 });
      preedit += character;
      event("compositionupdate", { data: preedit });
      event("beforeinput", { inputType: "insertCompositionText", data: preedit, isComposing: true });
      value(prefix + preedit);
      event("input", { inputType: "insertCompositionText", data: preedit, isComposing: true });
      jest.runOnlyPendingTimers();
    }
    event("compositionend", { data: text });
    jest.runAllTimers();
  };
  const edit = (next: string, inputType = "insertText", data: string | null = " ") => {
    event("keydown", { keyCode: 229 });
    event("beforeinput", { inputType, data, isComposing: false });
    value(next);
    event("input", { inputType, data, isComposing: false });
    jest.runAllTimers();
  };
  return { sent, textarea, element, compose, edit, event, value, helper };
}

describe("xterm mobile composition input", () => {
  for (const inputType of ["insertReplacementText", "insertText"]) {
    it(`replaces Gboard's double space without resending the line (${inputType})`, () => {
      const e = editor();
      e.compose("word");
      e.edit("word ");
      e.compose("word");
      e.edit("word word ");
      e.edit("word word. ", inputType, ". ");
      expect(e.sent).toEqual(["word", " ", "word", " ", "\x7f. "]);
      e.compose("next");
      e.edit("word word. next ");
      e.edit("word word. next. ", inputType, ". ");
      expect(e.sent.slice(5)).toEqual(["next", " ", "\x7f. "]);
    });
  }

  it("replaces two already inserted spaces with a period and a space", () => {
    const e = editor();
    e.compose("word word");
    e.edit("word word  ");
    e.edit("word word. ", "insertReplacementText", ". ");
    expect(e.sent).toEqual(["word word", "  ", "\x7f\x7f. "]);
  });

  it("keeps plain appends, unchanged input and a single deletion", () => {
    const e = editor();
    e.compose("word word");
    e.edit("word word ");
    e.edit("word word ");
    e.edit("word word", "deleteContentBackward", null);
    expect(e.sent).toEqual(["word word", " ", "\x7f"]);
  });

  it("replaces a supplementary character without splitting its surrogate pair", () => {
    const e = editor();
    e.compose("word 😀");
    e.edit("word 😁", "insertReplacementText", "😁");
    expect(e.sent).toEqual(["word 😀", "\x7f😁"]);
  });

  it("drains adjacent compositions before an interrupting key", () => {
    const e = editor();
    e.event("compositionstart");
    e.value("니");
    e.event("compositionupdate", { data: "니" });
    jest.runOnlyPendingTimers();
    e.event("compositionend", { data: "니" });
    e.event("compositionstart");
    e.value("니다");
    e.event("compositionupdate", { data: "다" });
    e.event("compositionend", { data: "다" });
    e.event("keydown", { keyCode: 190 });
    jest.runAllTimers();
    expect(e.sent.join("")).toBe("니다");
  });

  it("forwards an edit before the end as an insertion without deleting other text", () => {
    const e = editor();
    e.compose("abcdef");
    e.textarea.selectionStart = e.textarea.selectionEnd = 3;
    e.event("keydown", { keyCode: 229 });
    e.textarea.value = "abcXdef";
    jest.runAllTimers();
    expect(e.sent).toEqual(["abcdef", "X"]);
  });

  for (const [name, clear] of [
    ["Enter", (e: ReturnType<typeof editor>) => e.event("keydown", { keyCode: 13 })],
    ["a paste or blur", (e: ReturnType<typeof editor>) => e.helper.finishReplacement()],
  ] as const) {
    it(`sends a pending edit before ${name} clears the textarea`, () => {
      const e = editor();
      e.compose("long command");
      e.event("keydown", { keyCode: 229 });
      e.value("long command.");
      clear(e);
      e.value("");
      jest.runAllTimers();
      expect(e.sent).toEqual(["long command", "."]);
    });
  }

  it("does not deliver a deferred edit after the terminal resets", () => {
    const e = editor();
    e.compose("word word");
    e.event("keydown", { keyCode: 229 });
    e.value("word word. ");
    e.helper.reset();
    jest.runAllTimers();
    expect(e.sent).toEqual(["word word"]);
  });

  // Gboard rewrites the word it sees before the caret, and the fallback sends that as DELs at the
  // shell cursor. A key that moved the cursor must leave none of the text before it there (#2836).
  const rewriteWord = (e: ReturnType<typeof editor>, word: string) =>
    e.edit(e.textarea.value.replace(/\S*$/, word), "insertReplacementText", word);
  for (const [name, key, sends] of [
    ["ArrowLeft", { key: "ArrowLeft", keyCode: 37 }, "\x1b[D"],
    ["Home", { key: "Home", keyCode: 36 }, "\x1b[H"],
    ["Tab", { key: "Tab", keyCode: 9 }, "\t"],
    ["Escape", { key: "Escape", keyCode: 27 }, "\x1b"],
    ["Ctrl+A", { key: "a", keyCode: 65, ctrlKey: true }, "\x01"],
    ["Alt+B", { key: "b", keyCode: 66, altKey: true }, "\x1bb"],
  ] as const) {
    it(`deletes nothing the user did not edit after ${name} moves the shell cursor`, () => {
      const e = editor(new CoreBrowserTerminal());
      e.compose("abcdef");
      e.event("keydown", key);
      rewriteWord(e, "X");
      expect(e.sent).toEqual(["abcdef", sends, "X"]);
    });
  }

  it("deletes nothing the user did not edit after the embedder's input moves the shell cursor", () => {
    const term = new CoreBrowserTerminal();
    const e = editor(term);
    e.compose("abcdef");
    term.input("\x1b[D");
    rewriteWord(e, "X");
    expect(e.sent).toEqual(["abcdef", "\x1b[D", "X"]);
  });

  it("leaves a just finished composition to its own send after the embedder's input", () => {
    const term = new CoreBrowserTerminal();
    const e = editor(term);
    e.event("compositionstart");
    e.value("abc");
    e.event("compositionupdate", { data: "abc" });
    e.event("compositionend", { data: "abc" });
    term.input("\x1b[D");
    expect(e.sent).toEqual(["\x1b[D"]);
    jest.runAllTimers();
    expect(e.sent).toEqual(["\x1b[D", "abc"]);
  });
});

for (const platform of ["iPhone", "MacIntel"]) describe(`xterm dictation input on mobile WebKit (${platform})`, async () => {
  const safari = await Bun.build({
    entrypoints: [join(source, "browser/input/CompositionHelper.js"), join(source, "browser/CoreBrowserTerminal.js")],
    plugins: [xtermSourcePlugin(source)], target: "bun",
    banner: `const process = undefined; const document = {}; const window = {}; const navigator = {
      userAgent: 'Mozilla/5.0 (${platform === "iPhone" ? "iPhone" : "Macintosh"}) AppleWebKit/605.1.15 Version/27.0 Safari/604.1',
      platform: '${platform}', maxTouchPoints: 5, language: 'en'
    };`,
  });
  if (!safari.success) throw new AggregateError(safari.logs, "Could not build the terminal for iPhone WebKit");
  const { CompositionHelper: SafariHelper } = await load("CompositionHelper", safari);
  const { CoreBrowserTerminal: SafariTerminal } = await load("CoreBrowserTerminal", safari);

  for (const rewrite of ["insertReplacementText", "insertText"]) {
    it(`keeps ${rewrite} rewrites of a provisional dictation phrase out of the PTY until Enter`, () => {
      const e = editor(new SafariTerminal(), SafariHelper);
      // The phone report has no event log; the insertText case models the same selected range
      // as the established replacement trace, but with a different inputType on later revisions.
      const hypotheses = ["p", "ple", "pleas", "please ", "please te", "please test", "please test t",
        "please test thi", "please test this", "please test this solution", "please test this solution"];
      for (const [index, data] of hypotheses.entries()) {
        const inputType = index === 0 ? "insertReplacementText" : rewrite;
        e.textarea.selectionStart = 0;
        e.event("beforeinput", { inputType, data, isComposing: false });
        e.value(data);
        e.event("input", { inputType, data, isComposing: false });
        jest.runOnlyPendingTimers();
      }
      expect(e.sent).toEqual([]);
      e.event("keydown", { key: "Enter", keyCode: 13 });
      expect(e.sent).toEqual(["please test this solution", "\r"]);
    });
  }

  const insert = (e: ReturnType<typeof editor>, data: string, inputType = "insertText") => {
    const fields = { inputType, data, isComposing: false };
    e.event("beforeinput", fields);
    const { value, selectionStart, selectionEnd } = e.textarea;
    e.value(value.slice(0, selectionStart) + data + value.slice(selectionEnd));
    e.event("input", fields);
  };

  for (const key of [undefined, { key: "Unidentified", keyCode: 229 }]) {
    it(`sends single-key answers without waiting for a following key (${key ? "229" : "no keydown"})`, () => {
      const e = editor(new SafariTerminal(), SafariHelper);
      for (const [index, data] of ["1", "y"].entries()) {
        if (key) e.event("keydown", key);
        insert(e, data);
        expect(e.sent).toEqual(["1", "y"].slice(0, index + 1));
        if (key) e.event("keyup", key);
        jest.runOnlyPendingTimers();
        expect(e.sent).toEqual(["1", "y"].slice(0, index + 1));
      }
    });

    it(`buffers only the rewrites after a plain first insertion (${key ? "229" : "no keydown"})`, () => {
      const e = editor(new SafariTerminal(), SafariHelper);
      for (const data of ["p", "ple", "please"]) {
        e.textarea.select();
        if (key) e.event("keydown", key);
        insert(e, data);
        expect(e.sent).toEqual(["p"]);
        if (key) e.event("keyup", key);
        jest.runOnlyPendingTimers();
      }
      e.event("keydown", { key: "Enter", keyCode: 13 });
      expect(e.sent).toEqual(["p", "lease", "\r"]);
    });
  }

  it("keeps a keyless append after a retrospective rewrite provisional until Enter", () => {
    const e = editor(new SafariTerminal(), SafariHelper);
    insert(e, "ths");
    e.textarea.select();
    insert(e, "this");
    insert(e, " is");
    jest.runOnlyPendingTimers();
    expect(e.sent).toEqual(["ths"]);
    e.event("keydown", { key: "Enter", keyCode: 13 });
    expect(e.sent).toEqual(["ths", "\x7fis is", "\r"]);
  });

  it("corrects only the selected suffix of a sent insertion at Enter", () => {
    const e = editor(new SafariTerminal(), SafariHelper);
    insert(e, "test ths");
    e.textarea.selectionStart = "test ".length;
    insert(e, "this", "insertReplacementText");
    jest.runOnlyPendingTimers();
    expect(e.sent).toEqual(["test ths"]);
    e.event("keydown", { key: "Enter", keyCode: 13 });
    expect(e.sent).toEqual(["test ths", "\x7fis", "\r"]);
  });

  it("corrects a sent prefix only at commit, after Backspace edits the provisional text", () => {
    const e = editor(new SafariTerminal(), SafariHelper);
    insert(e, "thi");
    e.textarea.select();
    insert(e, "This.");
    e.event("keydown", { key: "Backspace", keyCode: 8 });
    e.textarea.selectionStart--;
    e.event("beforeinput", { inputType: "deleteContentBackward", isComposing: false });
    e.value("This");
    e.event("input", { inputType: "deleteContentBackward", isComposing: false });
    expect(e.sent).toEqual(["thi"]);
    e.event("keydown", { key: "Enter", keyCode: 13 });
    expect(e.sent).toEqual(["thi", "\x7f\x7f\x7fThis", "\r"]);
  });

  it("accepts keyless input after reset even when the old key never came up", () => {
    const term = new SafariTerminal();
    const e = editor(term, SafariHelper);
    e.event("keydown", { key: "Shift", keyCode: 16 });
    term.reset();
    insert(e, "first", "insertReplacementText");
    e.textarea.select();
    insert(e, "final", "insertReplacementText");
    e.event("keydown", { key: "Enter", keyCode: 13 });
    expect(e.sent).toEqual(["final", "\r"]);
  });

  it("commits dictation before context-menu paste replaces the textarea with a grid selection", () => {
    const e = editor(new SafariTerminal({ rightClickSelectsWord: false }), SafariHelper);
    insert(e, "p", "insertReplacementText");
    e.textarea.select();
    insert(e, "please");
    e.event("contextmenu", { clientX: 0, clientY: 0 }, e.element);
    e.event("paste", { clipboardData: { getData: () => "PASTE" } });
    expect(e.sent).toEqual(["please", "PASTE"]);
  });

  it("sends the iOS Chinese keyboard's Space immediately over a selected dictation hypothesis", () => {
    const e = editor(new SafariTerminal(), SafariHelper);
    insert(e, "hello", "insertReplacementText");
    e.textarea.select();
    e.event("keydown", { key: " ", code: "Space", keyCode: 229 });
    insert(e, " ");
    e.event("keyup", { key: " ", code: "Space", keyCode: 32 });
    expect(e.sent).toEqual(["hello", " "]);
  });

  it("keeps a suffix-only dictation correction in the same provisional phrase", () => {
    const e = editor(new SafariTerminal(), SafariHelper);
    insert(e, "please text", "insertReplacementText");
    e.textarea.select();
    insert(e, "please text this");
    e.textarea.selectionStart = "please ".length;
    insert(e, "test this");
    e.event("keydown", { key: "Enter", keyCode: 13 });
    expect(e.sent).toEqual(["please test this", "\r"]);
  });

  it("commits dictation before regular text inserted at the caret", () => {
    const e = editor(new SafariTerminal(), SafariHelper);
    e.event("beforeinput", { inputType: "insertReplacementText", data: "hello", isComposing: false });
    e.value("hello");
    e.event("input", { inputType: "insertReplacementText", data: "hello", isComposing: false });
    e.event("beforeinput", { inputType: "insertText", data: "!", isComposing: false });
    e.value("hello!");
    e.event("input", { inputType: "insertText", data: "!", isComposing: false });
    expect(e.sent).toEqual(["hello", "!"]);
  });
});

describe("xterm composition placement in Firefox", async () => {
  // Platform reads the browser from navigator, and takes a runtime with process for Node: shadow both
  const firefox = await Bun.build({
    entrypoints: [join(source, "browser/input/CompositionHelper.js")],
    plugins: [xtermSourcePlugin(source)], target: "bun",
    banner: "const process = undefined; const navigator = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:159.0) Gecko/20100101 Firefox/159.0', platform: 'Win32', language: 'zh-CN' };",
  });
  if (!firefox.success) throw new AggregateError(firefox.logs, "Could not build the composition helper for Firefox");
  const { CompositionHelper: FirefoxHelper } = await import(`data:text/javascript;base64,${Buffer.from(await firefox.outputs[0]!.text()).toString("base64")}`);

  it("keeps the text typed before a preedit from scrolling the helper textarea", () => {
    const style: Record<string, string> = {};
    const textarea = Object.defineProperties(Object.assign(new EventTarget(), { value: "", selectionStart: 0, selectionEnd: 0, style }), {
      clientWidth: { get: () => Math.round(parseFloat(style.width ?? "0")) },
      scrollWidth: { get: () => Math.max(textarea.clientWidth, textarea.value.length * 8) },
    });
    const view = {
      textContent: "", style: {} as Record<string, string>, classList: { add() {}, remove() {} },
      getBoundingClientRect: () => ({ width: view.textContent.length * 9, height: 17 }),
    };
    const helper = new FirefoxHelper(textarea, view,
      { buffer: { isCursorInViewport: true, x: 12, y: 3 }, cols: 80 },
      { rawOptions: { screenReaderMode: false, fontFamily: "monospace", fontSize: 15 } },
      { triggerDataEvent() {} },
      { dimensions: { css: { cell: { width: 9, height: 17 } } } });
    textarea.value = "ni hao shi ";
    helper.compositionstart();
    // the browser puts the preedit in the textarea after compositionupdate; the deferred update measures it
    helper.compositionupdate({ data: "jie" });
    textarea.value += "jie";
    jest.runOnlyPendingTimers();
    // Firefox anchors the candidate window to the unscrolled text, so nothing may overflow the box,
    // while its right edge, where the preedit ends, stays at the end of the drawn preedit
    expect(textarea.scrollWidth).toBe(textarea.clientWidth);
    expect(parseFloat(style.left) + parseFloat(style.width)).toBe(12 * 9 + 3 * 9);
    expect(style.top).toBe(3 * 17 + "px");
  });
});
