import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { join } from "node:path";
import { buildXtermSource, xtermSourcePlugin } from "./build-xterm.ts";

// Exercise the patched source Vite ships, without a browser, server or herdr session.
const source = buildXtermSource(join(import.meta.dir, ".."));
const bundle = await Bun.build({
  entrypoints: [join(source, "browser/input/CompositionHelper.js")],
  plugins: [xtermSourcePlugin(source)], target: "bun",
});
if (!bundle.success) throw new AggregateError(bundle.logs, "Could not build the composition helper");
const { CompositionHelper } = await import(`data:text/javascript;base64,${Buffer.from(await bundle.outputs[0]!.text()).toString("base64")}`);

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

function editor() {
  const sent: string[] = [];
  const textarea = Object.assign(new EventTarget(), { value: "", selectionStart: 0, selectionEnd: 0 });
  const view = { textContent: "", classList: { add() {}, remove() {} } };
  const helper = new CompositionHelper(textarea, view,
    { buffer: { isCursorInViewport: false } },
    { rawOptions: { screenReaderMode: false } },
    { triggerDataEvent: (text: string) => sent.push(text) }, {});
  textarea.addEventListener("compositionstart", () => helper.compositionstart());
  textarea.addEventListener("compositionupdate", (event) => helper.compositionupdate(event));
  textarea.addEventListener("compositionend", () => helper.compositionend());
  textarea.addEventListener("keydown", (event) => helper.keydown(event));
  textarea.addEventListener("beforeinput", (event) => helper.beforeinput(event, true));
  textarea.addEventListener("input", (event) => helper.input(event, true));
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
});
