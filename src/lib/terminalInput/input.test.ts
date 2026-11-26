import { expect, test } from "bun:test";
import { dispatch, fixture } from "./testDom.test.ts";

for (const [bracketed, expected] of [[false, "a\rb\rc\r"], [true, "\x1b[200~a\rb\rc\r\x1b[201~"]] as const) {
  test(`normalizes paste newlines (bracketed = ${bracketed})`, () => {
    const { term, modes, sent } = fixture();
    try {
      modes.bracketedPaste = bracketed;
      term.textarea.value = "old";
      term.paste("a\r\nb\nc\r");
      expect(sent).toEqual([expected]);
      expect(term.textarea.value).toBe("");
    } finally { term.dispose(); }
  });
}

test("focus reports are not user input, and blur clears the textarea", () => {
  const { term, modes } = fixture();
  const events: string[] = [];
  try {
    term.onData((text) => events.push(text));
    term.onUserInput(() => events.push("user"));
    term.onFocus(() => events.push("focus"));
    term.onBlur(() => events.push("blur"));
    modes.sendFocus = true;
    term.focus();
    term.textarea.value = "old";
    term.blur();
    expect(events).toEqual(["\x1b[I", "focus", "\x1b[O", "blur"]);
    expect(term.textarea.value).toBe("");
  } finally { term.dispose(); }
});

test("read-only blocks DOM and API input, and non-user input skips the user event", () => {
  const { term } = fixture();
  const events: string[] = [];
  try {
    term.onData((text) => events.push(text));
    term.onUserInput(() => events.push("user"));
    term.disableStdin = true;
    expect(term.textarea.readOnly).toBe(true);
    term.input("blocked");
    term.paste("blocked");
    dispatch(term.textarea, "keydown", { keyCode: 13, key: "Enter" });
    term.disableStdin = false;
    expect(term.textarea.readOnly).toBe(false);
    term.input("reply", false);
    term.input("key");
    expect(events).toEqual(["reply", "user", "key"]);
  } finally { term.dispose(); }
});

test("application keypad mode still sends the patched xterm printable keypad bytes", () => {
  const { term, modes, sent } = fixture();
  try {
    modes.applicationKeypad = true;
    dispatch(term.textarea, "keydown", { keyCode: 97, key: "1", code: "Numpad1" });
    dispatch(term.textarea, "keydown", { keyCode: 107, key: "+", code: "NumpadAdd" });
    dispatch(term.textarea, "keydown", { keyCode: 13, key: "Enter", code: "NumpadEnter" });
    expect(sent).toEqual(["1", "+", "\r"]);
  } finally { term.dispose(); }
});

test("DOM paste uses plain text, normalizes it, and leaves clipboard default handling unchanged", () => {
  const { term, modes, sent } = fixture();
  try {
    modes.bracketedPaste = true;
    const ev = dispatch(term.textarea, "paste", { clipboardData: { getData: (type) => type === "text/plain" ? "x\ny" : "" } });
    expect(sent).toEqual(["\x1b[200~x\ry\x1b[201~"]);
    expect(ev.defaultPrevented).toBe(false);
  } finally { term.dispose(); }
});

test("a custom key handler can veto all three keyboard event types", () => {
  const { term, sent } = fixture();
  const events: string[] = [];
  try {
    term.attachCustomKeyEventHandler((event) => { events.push(event.type); return false; });
    dispatch(term.textarea, "keydown", { keyCode: 65, key: "a" });
    dispatch(term.textarea, "keypress", { charCode: 97, key: "a" });
    dispatch(term.textarea, "keyup", { keyCode: 65, key: "a" });
    expect(events).toEqual(["keydown", "keypress", "keyup"]);
    expect(sent).toEqual([]);
  } finally { term.dispose(); }
});

test("a reply to the program leaves the textarea and the user's composition alone", () => {
  const { term } = fixture();
  const events: string[] = [];
  try {
    term.onData((text) => events.push(text));
    term.onUserInput(() => events.push("user"));
    term.textarea.value = "한";
    term.reply("\x1b[1;1R");
    expect(events).toEqual(["\x1b[1;1R"]);
    expect(term.textarea.value).toBe("한");
  } finally { term.dispose(); }
});
