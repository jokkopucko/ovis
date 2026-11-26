// Copyright (c) The xterm.js authors. MIT License.
// Adapted for Ovis.
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { CompositionHelper } from "./composition.ts";
import { fixture, dispatch, rect, type EventFields } from "./testDom.test.ts";

let editors: ReturnType<typeof fixture>[];
beforeEach(() => { editors = []; jest.useFakeTimers(); });
afterEach(() => { for (const e of editors) e.term.dispose(); jest.useRealTimers(); });

function editor(useTerminal = false) {
  const e = fixture();
  editors.push(e);
  const { host, term, sent } = e;
  const textarea = useTerminal ? term.textarea : host.screen.ownerDocument.createElement("textarea");
  const view = host.screen.ownerDocument.createElement("div");
  const helper = new CompositionHelper(textarea, view, host, e.platform, (text) => sent.push(text), () => false);
  if (!useTerminal) {
    textarea.addEventListener("compositionstart", () => helper.compositionstart());
    textarea.addEventListener("compositionupdate", (ev) => helper.compositionupdate(ev));
    textarea.addEventListener("compositionend", () => helper.compositionend());
    textarea.addEventListener("keydown", (ev) => { helper.keydown(ev); });
    textarea.addEventListener("beforeinput", (ev: InputEvent) => helper.beforeinput(ev, true));
    textarea.addEventListener("input", (ev: InputEvent) => { helper.input(ev, true); });
  }
  const event = (type: string, fields?: EventFields) => dispatch(textarea, type, fields);
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
  return { sent, textarea, compose, edit, event, value, helper, term };
}
describe("terminal mobile composition input", () => {
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
      const e = editor(true);
      e.compose("abcdef");
      e.event("keydown", key);
      rewriteWord(e, "X");
      expect(e.sent).toEqual(["abcdef", sends, "X"]);
    });
  }

  it("deletes nothing the user did not edit after the embedder's input moves the shell cursor", () => {
    const e = editor(true);
    const { term } = e;
    e.compose("abcdef");
    term.input("\x1b[D");
    rewriteWord(e, "X");
    expect(e.sent).toEqual(["abcdef", "\x1b[D", "X"]);
  });

  it("leaves a just finished composition to its own send after the embedder's input", () => {
    const e = editor(true);
    const { term } = e;
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

it("keeps the text typed before a Firefox preedit from scrolling the helper textarea", () => {
  const e = fixture({ platform: { platform: "Win32", userAgent: "Firefox/159.0" }, cursor: { x: 12, y: 3 }, cell: { width: 9, height: 17 } });
  editors.push(e);
  const { textarea } = e.term;
  Object.defineProperties(textarea, {
    clientWidth: { get: () => Math.round(parseFloat(textarea.style.width || "0")) },
    scrollWidth: { get: () => Math.max(textarea.clientWidth, textarea.value.length * 8) },
  });
  e.view.getBoundingClientRect = () => rect((e.view.textContent?.length ?? 0) * 9, 17);
  textarea.value = "ni hao shi ";
  dispatch(textarea, "compositionstart");
  dispatch(textarea, "compositionupdate", { data: "jie" });
  textarea.value += "jie";
  jest.runOnlyPendingTimers();
  expect(textarea.scrollWidth).toBe(textarea.clientWidth);
  expect(parseFloat(textarea.style.left) + parseFloat(textarea.style.width)).toBe(12 * 9 + 3 * 9);
  expect(textarea.style.top).toBe(3 * 17 + "px");
});

function appleEditor(platform: string, userAgent: string) {
  const e = fixture({ platform: { platform, userAgent } });
  editors.push(e);
  const { textarea } = e.term;
  const edit = (inputType: string, data: string | null, value: string) => {
    dispatch(textarea, "beforeinput", { inputType, data, isComposing: false });
    textarea.value = value;
    textarea.selectionStart = textarea.selectionEnd = value.length;
    dispatch(textarea, "input", { inputType, data, isComposing: false });
  };
  return { ...e, textarea, edit };
}

it("iPad WKWebView commits the corrected Hangul preedit before Enter, not the individual jamo", () => {
  const { textarea, sent, edit } = appleEditor("iPad", "Mozilla/5.0 AppleWebKit/605.1.15");
  dispatch(textarea, "keydown", { key: "ㅎ", keyCode: 12622 });
  dispatch(textarea, "keypress", { key: "ㅎ", charCode: 12622 });
  edit("insertText", "ㅎ", "ㅎ");
  dispatch(textarea, "keyup", { key: "ㅎ", keyCode: 12622 });
  dispatch(textarea, "keydown", { key: "ㅏ", keyCode: 12623 });
  edit("deleteContentBackward", null, "");
  edit("insertText", "하", "하");
  expect(sent).toEqual([]);
  dispatch(textarea, "keydown", { key: "Enter", keyCode: 13 });
  expect(sent).toEqual(["하", "\r"]);
});

it("Safari consumes the late Backspace for an already applied deletion from a Hangul preedit", () => {
  const { textarea, sent, edit } = appleEditor("MacIntel", "AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15");
  edit("insertText", "한", "한");
  dispatch(textarea, "keydown", { keyCode: 229 });
  dispatch(textarea, "keyup", { keyCode: 229 });
  edit("deleteContentBackward", null, "하");
  const event = dispatch(textarea, "keydown", { key: "Backspace", keyCode: 8 });
  expect(event.defaultPrevented).toBe(true);
  dispatch(textarea, "keydown", { key: "Enter", keyCode: 13 });
  expect(sent).toEqual(["하", "\r"]);
});

it("Safari sends only the corrected dictation hypothesis before pasting", () => {
  const { term, sent, edit } = appleEditor("iPhone", "AppleWebKit/605.1.15 Safari/605.1.15");
  edit("insertReplacementText", "thi", "thi");
  edit("insertReplacementText", "this is", "this is");
  expect(sent).toEqual([]);
  term.paste(" pasted");
  expect(sent).toEqual(["this is", " pasted"]);
});

for (const matchingInsertion of [true, false]) {
  it(`holds an iOS whole-string key until a matching insertion or keyup (insertion: ${matchingInsertion})`, () => {
    const { term, textarea, sent, edit } = appleEditor("iPhone", "AppleWebKit/605.1.15 Safari/605.1.15");
    const text = "😀 translated phrase";
    const keys: string[] = [];
    term.onKey(({ key }) => keys.push(key));
    dispatch(textarea, "keydown", { key: text });
    dispatch(textarea, "keypress", { key: text, charCode: 0x1f600 });
    expect(sent).toEqual([]);
    if (matchingInsertion) edit("insertText", text, text);
    dispatch(textarea, "keyup", { key: text });
    const expected = [matchingInsertion ? text : "😀"];
    expect(sent).toEqual(expected);
    expect(keys).toEqual(expected);
  });
}

it("Linux defers a candidate digit and sends input once, with or without keypress", () => {
  const e = fixture({ platform: { platform: "Linux x86_64", userAgent: "Chrome/130.0" } });
  editors.push(e);
  const { textarea } = e.term;
  dispatch(textarea, "keydown", { key: "1", keyCode: 49 });
  expect(e.sent).toEqual([]);
  dispatch(textarea, "input", { inputType: "insertText", data: "你" });
  dispatch(textarea, "keyup", { key: "1", keyCode: 49 });
  dispatch(textarea, "keydown", { key: "2", keyCode: 50 });
  dispatch(textarea, "keypress", { key: "好", charCode: 22909 });
  dispatch(textarea, "input", { inputType: "insertText", data: "好" });
  expect(e.sent).toEqual(["你", "好"]);
});

it("clamps the textarea to the visible screen and aligns the clipped preedit to its end", () => {
  const e = fixture({ cursor: { x: 12, y: 4 } });
  editors.push(e);
  e.view.getBoundingClientRect = () => rect(300, 14);
  const bounds = { left: 20, top: 0, right: 90, bottom: 42 };
  e.term.setTextAreaViewportBounds(bounds);
  const { textarea } = e.term;
  expect([textarea.style.left, textarea.style.top, textarea.style.width]).toEqual(["80px", "28px", "10px"]);
  dispatch(textarea, "compositionstart");
  dispatch(textarea, "compositionupdate", { data: "a long provisional phrase" });
  expect([e.view.style.left, e.view.style.top, e.view.style.maxWidth, e.view.style.display, e.view.style.justifyContent])
    .toEqual(["20px", "28px", "70px", "flex", "flex-end"]);
});

it("disposal discards a commit deferred by compositionend", () => {
  const e = fixture();
  editors.push(e);
  const { textarea } = e.term;
  dispatch(textarea, "compositionstart");
  dispatch(textarea, "compositionupdate", { data: "abc" });
  textarea.value = "abc";
  dispatch(textarea, "compositionend", { data: "abc" });
  e.term.dispose();
  jest.runAllTimers();
  expect(e.sent).toEqual([]);
});
