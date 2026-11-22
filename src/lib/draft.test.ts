import { describe, expect, it } from "bun:test";
import { applyToDraft, draftIsEmpty, DRAFT_TTL_MS, EMPTY_DRAFT, holdBefore, restoreDraft } from "./draft.ts";

describe("holdBefore", () => {
  it("holds typing a connection lost unconfirmed ahead of what was typed after it, each chunk folded as typed (#2587)", () => {
    expect(holdBefore(["ls", "s", "\x7f", " -la"], EMPTY_DRAFT)).toEqual({ text: "ls -la", truncated: false, leftOut: false });
    // Ctrl+Backspace's Ctrl+W erased a word before the disconnect (#3415)
    expect(holdBefore(["echo alpha", "\x17", "beta"], EMPTY_DRAFT)).toEqual({ text: "echo beta", truncated: false, leftOut: false });
    expect(holdBefore(["echo", "\r"], { text: "hi", truncated: false, leftOut: false })).toEqual({ text: "echo hi", truncated: false, leftOut: true });
  });

  it("leaves the draft as it is when nothing lost can be held", () => {
    const draft = { text: "x", truncated: false, leftOut: false };
    expect(holdBefore([], draft)).toBe(draft);
    expect(holdBefore(["\x03", "\x1b[A"], draft)).toBe(draft);
  });
});

describe("applyToDraft", () => {
  it("appends a printable character to the draft", () => {
    expect(applyToDraft(EMPTY_DRAFT, "a")).toEqual({ text: "a", truncated: false, leftOut: false });
  });

  it("keeps the order of consecutive typed characters", () => {
    const draft = applyToDraft(applyToDraft(EMPTY_DRAFT, "l"), "s");
    expect(draft.text).toBe("ls");
  });

  it("applies Backspace to the held text, one code point per key", () => {
    expect(applyToDraft({ text: "ab", truncated: false, leftOut: false }, "\x7f")).toEqual({ text: "a", truncated: false, leftOut: false });
    expect(applyToDraft({ text: "ab", truncated: false, leftOut: false }, "\b")).toEqual({ text: "a", truncated: false, leftOut: false });
    let draft = EMPTY_DRAFT;
    for (const chunk of ["l", "s", "s", "\x7f", " -la"]) draft = applyToDraft(draft, chunk);
    expect(draft.text).toBe("ls -la");
    expect(applyToDraft({ text: "a😀", truncated: false, leftOut: false }, "\x7f").text).toBe("a");
    expect(applyToDraft({ text: "한글", truncated: false, leftOut: false }, "\x7f").text).toBe("한");
    expect(applyToDraft({ text: "abc", truncated: false, leftOut: false }, "\x7f\x7f").text).toBe("a");
    // deletions and the text that replaces them in one chunk, as an autocorrect may send
    expect(applyToDraft({ text: "teh", truncated: false, leftOut: false }, "\x7f\x7f\x7fthe").text).toBe("the");
  });

  it("applies Ctrl+Backspace's Ctrl+W to the held text as a shell does: the blanks, then the word before them", () => {
    const held = (text: string) => ({ text, truncated: false, leftOut: false });
    expect(applyToDraft(held("git sta"), "\x17")).toEqual(held("git "));
    expect(applyToDraft(held("echo held-b  "), "\x17")).toEqual(held("echo "));
    expect(applyToDraft(held("git sta"), "\x17status").text).toBe("git status");
    expect(applyToDraft(held("한글 단어"), "\x17\x7f").text).toBe("한글");
    expect(applyToDraft(held("word"), "\x17")).toBe(EMPTY_DRAFT);
    expect(applyToDraft(EMPTY_DRAFT, "\x17")).toBe(EMPTY_DRAFT);
  });

  it("leaves the empty draft as it is on Backspace", () => {
    expect(applyToDraft(EMPTY_DRAFT, "\x7f")).toBe(EMPTY_DRAFT);
    expect(applyToDraft(EMPTY_DRAFT, "\x7f\x7f")).toBe(EMPTY_DRAFT);
  });

  it("never holds an Enter, keeps the text on both sides, and says a break was left out", () => {
    let draft = EMPTY_DRAFT;
    for (const chunk of ["l", "s", "\r", "p", "w", "d"]) draft = applyToDraft(draft, chunk);
    expect(draft).toEqual({ text: "ls pwd", truncated: false, leftOut: true });
  });

  it("holds and tells nothing for a typed ESC CR: Shift+Enter or Alt+Enter is a key, not a line break", () => {
    expect(applyToDraft(EMPTY_DRAFT, "\x1b\r")).toBe(EMPTY_DRAFT);
    expect(applyToDraft(EMPTY_DRAFT, "\x1b\n")).toBe(EMPTY_DRAFT);
    const held = { text: "ls", truncated: false, leftOut: false };
    expect(applyToDraft(held, "\x1b\r")).toBe(held);
    expect(["ls", "\x1b\r", "\x7f", "x"].reduce(applyToDraft, EMPTY_DRAFT)).toEqual({ text: "lx", truncated: false, leftOut: false });
  });

  it("clears the left-out break with the text when Backspace erases everything held", () => {
    expect(["ls", "\r", "\x7f", "\x7f", "\x7f"].reduce(applyToDraft, EMPTY_DRAFT)).toEqual(EMPTY_DRAFT);
    expect(applyToDraft({ text: "a ", truncated: false, leftOut: true }, "\x7f\x7fb")).toEqual({ text: "b", truncated: false, leftOut: false });
    expect(applyToDraft({ text: "a b", truncated: false, leftOut: true }, "\x7f")).toEqual({ text: "a ", truncated: false, leftOut: true });
  });

  it("changes nothing for an Enter with nothing held: there is no text it separates", () => {
    expect(applyToDraft(EMPTY_DRAFT, "\r")).toBe(EMPTY_DRAFT);
    expect(draftIsEmpty(applyToDraft(EMPTY_DRAFT, "\r\r"))).toBe(true);
    expect(applyToDraft(EMPTY_DRAFT, "\x1b[200~\n\n\x1b[201~")).toBe(EMPTY_DRAFT);
    expect(applyToDraft(applyToDraft({ text: "a", truncated: false, leftOut: false }, "\x7f"), "\r")).toEqual(EMPTY_DRAFT);
  });

  it("keeps the lines of a paste, raw or bracketed, and says its breaks were left out", () => {
    expect(applyToDraft(EMPTY_DRAFT, "a\rb")).toEqual({ text: "a b", truncated: false, leftOut: true });
    expect(applyToDraft(EMPTY_DRAFT, "\x1b[200~a\nb\x1b[201~")).toEqual({ text: "a b", truncated: false, leftOut: true });
    expect(applyToDraft(EMPTY_DRAFT, "\x1b[200~one\r\ntwo\r\n\x1b[201~")).toEqual({ text: "one two ", truncated: false, leftOut: true });
    expect(applyToDraft(EMPTY_DRAFT, "a\rb").text).not.toMatch(/[\r\n]/);
    expect(applyToDraft(EMPTY_DRAFT, "a\tb\nc")).toEqual({ text: "", truncated: true, leftOut: true });
    expect(applyToDraft(EMPTY_DRAFT, "\x1b[200~if x:\n\tfoo\x1b[201~")).toEqual({ text: "if x:  foo", truncated: false, leftOut: true });
  });

  it("holds a single-line paste with a tab, and tells one with other controls instead of losing it in silence", () => {
    expect(applyToDraft(EMPTY_DRAFT, "\x1b[200~a\tb\x1b[201~")).toEqual({ text: "a b", truncated: false, leftOut: false });
    expect(applyToDraft(EMPTY_DRAFT, "\x1b[200~a\x1bb\x1b[201~")).toEqual({ text: "", truncated: true, leftOut: false });
    expect(applyToDraft(EMPTY_DRAFT, "\x1b[200~\x1b[201~")).toBe(EMPTY_DRAFT);
  });

  it("holds nothing for escape sequences, arrows and control codes: there is nothing to send or to tell", () => {
    // also what xterm answers a program by itself: a cursor position, a focus or a mouse report
    for (const special of ["\u001b[A", "\u0003", "\u001b", "\t", "\u001b[12;40R", "\u001b[I", "\u001b[<35;10;5M"]) {
      const draft = applyToDraft(EMPTY_DRAFT, special);
      expect(draft).toBe(EMPTY_DRAFT);
      expect(draftIsEmpty(draft)).toBe(true);
    }
  });

  it("caps the draft instead of growing without bound, and says that text was left out", () => {
    let draft = EMPTY_DRAFT;
    for (let i = 0; i < 1024; i += 1) draft = applyToDraft(draft, "x");
    expect(draft).toEqual({ text: "x".repeat(1024), truncated: false, leftOut: false });
    for (let i = 0; i < 76; i += 1) draft = applyToDraft(draft, "y");
    expect(draft).toEqual({ text: "x".repeat(1024), truncated: true, leftOut: false });
  });

  it("leaves out whole a chunk the draft has no room for, and says so even with nothing held", () => {
    const pasted = applyToDraft(EMPTY_DRAFT, "x".repeat(1025));
    expect(pasted).toEqual({ text: "", truncated: true, leftOut: false });
    expect(draftIsEmpty(pasted)).toBe(false);
    const after = applyToDraft(applyToDraft(EMPTY_DRAFT, "ls "), "x".repeat(1022));
    expect(after).toEqual({ text: "ls ", truncated: true, leftOut: false });
    expect(applyToDraft(after, "-la")).toEqual({ text: "ls -la", truncated: true, leftOut: false });
  });

  it("keeps a loss told when a special key follows it, and an Enter with no text to separate adds nothing", () => {
    const lost = applyToDraft(EMPTY_DRAFT, "x".repeat(1025));
    expect(applyToDraft(lost, "\u001b[A")).toBe(lost);
    expect(applyToDraft(lost, "\r")).toBe(lost);
  });

  it("stops Backspace editing the draft once text was left out: it may be meant for that text", () => {
    const after = applyToDraft(applyToDraft(EMPTY_DRAFT, "ls "), "x".repeat(1022));
    expect(applyToDraft(after, "\x7f")).toBe(after);
    expect(applyToDraft(after, "\x7f\x7f-la")).toEqual({ text: "ls -la", truncated: true, leftOut: false });
  });
});

describe("draftIsEmpty", () => {
  it("is true for the empty draft and false once text is held or was left out", () => {
    expect(draftIsEmpty(EMPTY_DRAFT)).toBe(true);
    expect(draftIsEmpty({ text: "a", truncated: false, leftOut: false })).toBe(false);
    expect(draftIsEmpty({ text: "", truncated: true, leftOut: false })).toBe(false);
    expect(draftIsEmpty({ text: "", truncated: false, leftOut: true })).toBe(false);
  });
});

it("holds multi-codepoint IME commits without splitting a surrogate at the limit", () => {
  for (const text of ["한글", "😀", "e\u0301", "abc"]) expect(applyToDraft(EMPTY_DRAFT, text).text).toBe(text);
  expect(applyToDraft({ text: "a".repeat(1023), truncated: false, leftOut: false }, "😀")).toEqual({ text: "a".repeat(1023), truncated: true, leftOut: false });
  expect(applyToDraft(EMPTY_DRAFT, "\x1b[200~text\x1b[201~")).toEqual({ text: "text", truncated: false, leftOut: false });
  expect(applyToDraft(EMPTY_DRAFT, `\x1b[200~${"a".repeat(1025)}\x1b[201~`)).toEqual({ text: "", truncated: true, leftOut: false });
  expect(applyToDraft(EMPTY_DRAFT, "\x1b[200~text")).toEqual(EMPTY_DRAFT);
});

describe("restoreDraft", () => {
  const now = 1_800_000_000_000;
  const record = (at: number) => JSON.stringify({ text: "hunter2", truncated: false, at });

  it("restores a draft written inside the TTL", () => {
    expect(restoreDraft(record(now - 1000), now)).toEqual({ text: "hunter2", truncated: false, leftOut: false });
  });

  it("forgets a draft past the TTL", () => {
    expect(restoreDraft(record(now - DRAFT_TTL_MS - 1), now)).toEqual(EMPTY_DRAFT);
  });

  it("keeps an undated record, written before the TTL existed: an update must not lose held input", () => {
    expect(restoreDraft(JSON.stringify({ text: "hunter2", truncated: false, leftOut: false }), now)).toEqual({ text: "hunter2", truncated: false, leftOut: false });
  });

  it("holds nothing for a missing, malformed or hand-edited record", () => {
    expect(restoreDraft(null, now)).toEqual(EMPTY_DRAFT);
    expect(restoreDraft("not json", now)).toEqual(EMPTY_DRAFT);
    expect(restoreDraft(JSON.stringify({ text: 7, truncated: false, at: now }), now)).toEqual(EMPTY_DRAFT);
    expect(restoreDraft(JSON.stringify({ text: "a", truncated: false, at: "soon" }), now)).toEqual(EMPTY_DRAFT);
  });

  it("reads a flag it does not recognise as no loss told, and keeps the text", () => {
    expect(restoreDraft(JSON.stringify({ text: "a", truncated: "yes", at: now }), now)).toEqual({ text: "a", truncated: false, leftOut: false });
  });

  it("keeps a loss it told, and forgets it with the text", () => {
    expect(restoreDraft(JSON.stringify({ text: "ls", truncated: true, at: now - DRAFT_TTL_MS - 1 }), now)).toEqual(EMPTY_DRAFT);
    expect(restoreDraft(JSON.stringify({ text: "ls", truncated: true, at: now }), now)).toEqual({ text: "ls", truncated: true, leftOut: false });
  });

  it("keeps a left-out line break it told, and reads any other value as none", () => {
    expect(restoreDraft(JSON.stringify({ text: "ls", truncated: false, leftOut: true, at: now }), now)).toEqual({ text: "ls", truncated: false, leftOut: true });
    expect(restoreDraft(JSON.stringify({ text: "ls", truncated: false, leftOut: 1, at: now }), now)).toEqual({ text: "ls", truncated: false, leftOut: false });
  });

  it("keeps the text of a record an earlier version wrote, and nothing but a count it held", () => {
    const legacy = JSON.stringify({ text: "ls", droppedSpecial: 3, at: now });
    expect(restoreDraft(legacy, now)).toEqual({ text: "ls", truncated: false, leftOut: false });
    expect(restoreDraft(JSON.stringify({ text: "", droppedSpecial: 3, at: now }), now)).toEqual(EMPTY_DRAFT);
  });
});
