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
const load = async (name: string) => {
  const output = bundle.outputs.find(({ path }) => path.endsWith(`/${name}.js`))!;
  return import(`data:text/javascript;base64,${Buffer.from(await output.text()).toString("base64")}`);
};
const { CompositionHelper } = await load("CompositionHelper");
const { CoreBrowserTerminal } = await load("CoreBrowserTerminal");

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

function editor(term?: any) {
  const sent: string[] = [];
  const textarea = Object.assign(new EventTarget(), { value: "", selectionStart: 0, selectionEnd: 0 });
  const view = { textContent: "", classList: { add() {}, remove() {} } };
  const helper = new CompositionHelper(textarea, view,
    { buffer: { isCursorInViewport: false } },
    { rawOptions: { screenReaderMode: false } },
    term?.coreService ?? { triggerDataEvent: (text: string) => sent.push(text) }, {});
  if (term) {
    Object.assign(term, { textarea, _compositionHelper: helper, element: { classList: { add() {}, remove() {} } } });
    term.onData((text: string) => sent.push(text));
  }
  textarea.addEventListener("compositionstart", () => helper.compositionstart());
  textarea.addEventListener("compositionupdate", (event) => helper.compositionupdate(event));
  textarea.addEventListener("compositionend", () => helper.compositionend());
  textarea.addEventListener("keydown", (event) => term ? term._keyDown(event) : helper.keydown(event));
  textarea.addEventListener("beforeinput", (event) => helper.beforeinput(event, true));
  textarea.addEventListener("input", (event) => term ? term._inputEvent(event) : helper.input(event, true));
  const event = (type: string, fields: Record<string, unknown> = {}) =>
    textarea.dispatchEvent(Object.assign(new Event(type, { bubbles: true, composed: true }), fields));
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
  return { sent, textarea, compose, edit, event, value, helper };
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
