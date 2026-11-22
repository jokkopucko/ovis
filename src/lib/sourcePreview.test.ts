import { describe, expect, it } from "bun:test";
import { SOURCE_PREVIEW_BYTES, SOURCE_PREVIEW_LINES, TEXT_PREVIEW_BYTES } from "./filePreviewText.ts";
import { lineRequest, readBudget, shownSource, sourceLayout, VIRTUAL_HIGHLIGHT_CHARS, VIRTUAL_HIGHLIGHT_LINES, VIRTUAL_SOURCE_LINES, virtualHighlightable } from "./sourcePreview.ts";

describe("lineRequest", () => {
  it("marks visible lines, including the final empty source line", () => {
    expect(lineRequest(3, "a\nb\n", false)).toEqual({ kind: "shown", line: 3 });
    expect(lineRequest(2, "a\nb", true)).toEqual({ kind: "shown", line: 2 });
    expect(lineRequest(1, "", false)).toEqual({ kind: "shown", line: 1 });
  });
  it("distinguishes unseen preview text from a complete file's end", () => {
    expect(lineRequest(4, "a\nb\nc", true)).toEqual({ kind: "past-preview", line: 4 });
    expect(lineRequest(4, "a\nb\nc", false)).toEqual({ kind: "past-end", line: 4, lines: 3 });
  });
  it("marks any line of a virtualized source, which numbers every row", () => {
    expect(lineRequest(123_456, "\n".repeat(SOURCE_PREVIEW_LINES - 1), false)).toEqual({ kind: "shown", line: 123_456 });
    expect(lineRequest(null, "\n".repeat(VIRTUAL_SOURCE_LINES), true)).toBeNull();
  });
  it("counts a cut prefix by the reader's complete lines: the cap is shown, the line past it is unseen", () => {
    const cut = shownSource("x\n".repeat(SOURCE_PREVIEW_LINES), true);
    expect(lineRequest(SOURCE_PREVIEW_LINES, cut, true, SOURCE_PREVIEW_LINES)).toEqual({ kind: "shown", line: SOURCE_PREVIEW_LINES });
    expect(lineRequest(SOURCE_PREVIEW_LINES + 1, cut, true, SOURCE_PREVIEW_LINES)).toEqual({ kind: "past-preview", line: SOURCE_PREVIEW_LINES + 1 });
    expect(lineRequest(SOURCE_PREVIEW_LINES + 1, cut, true)).toEqual({ kind: "past-preview", line: SOURCE_PREVIEW_LINES + 1 });
    expect(lineRequest(4, shownSource("a\nb\nc\n", true), true, 3)).toEqual({ kind: "past-preview", line: 4 });
    expect(lineRequest(3, shownSource("a\nb\nc\n", true), true, 3)).toEqual({ kind: "shown", line: 3 });
  });
});

describe("shownSource", () => {
  it("drops the row after a cut prefix's final newline and keeps a complete file's final empty line", () => {
    expect(shownSource("a\nb\n", true)).toBe("a\nb");
    expect(shownSource("a\nb\n", false)).toBe("a\nb\n");
    expect(shownSource("one long line", true)).toBe("one long line");
    expect(shownSource("", true)).toBe("");
  });
});

describe("sourceLayout", () => {
  it("virtualizes only past the element-per-line limit", () => {
    expect(sourceLayout(1)).toBe("elements");
    expect(sourceLayout(VIRTUAL_SOURCE_LINES)).toBe("elements");
    expect(sourceLayout(VIRTUAL_SOURCE_LINES + 1)).toBe("virtual");
  });
});

describe("virtualHighlightable", () => {
  it("colors a virtualized source only within both the character and the line bound", () => {
    expect(virtualHighlightable(VIRTUAL_HIGHLIGHT_CHARS, VIRTUAL_HIGHLIGHT_LINES)).toBe(true);
    expect(virtualHighlightable(VIRTUAL_HIGHLIGHT_CHARS + 1, 10)).toBe(false);
    expect(virtualHighlightable(10, VIRTUAL_HIGHLIGHT_LINES + 1)).toBe(false);
  });
});

describe("readBudget", () => {
  it("keeps Markdown at the Preview's budget whatever its size", () => {
    expect(readBudget("markdown", SOURCE_PREVIEW_BYTES * 2)).toEqual({ bytes: TEXT_PREVIEW_BYTES, lines: SOURCE_PREVIEW_LINES, timeoutMs: 5_000 });
  });
  it("reads a text that fits the Preview's budget under it, and a larger source under the source budget", () => {
    expect(readBudget("ts", TEXT_PREVIEW_BYTES)).toEqual({ bytes: TEXT_PREVIEW_BYTES, lines: SOURCE_PREVIEW_LINES, timeoutMs: 5_000 });
    expect(readBudget(null, TEXT_PREVIEW_BYTES)).toEqual({ bytes: TEXT_PREVIEW_BYTES, lines: SOURCE_PREVIEW_LINES, timeoutMs: 5_000 });
    expect(readBudget("ts", TEXT_PREVIEW_BYTES + 1)).toEqual({ bytes: SOURCE_PREVIEW_BYTES, lines: SOURCE_PREVIEW_LINES, timeoutMs: 30_000 });
    expect(readBudget(null, SOURCE_PREVIEW_BYTES * 4)).toEqual({ bytes: SOURCE_PREVIEW_BYTES, lines: SOURCE_PREVIEW_LINES, timeoutMs: 30_000 });
  });
  it("caps the lines under every budget", () => {
    expect(readBudget("ts", 10).lines).toBe(SOURCE_PREVIEW_LINES);
    expect(readBudget("markdown", 10).lines).toBe(SOURCE_PREVIEW_LINES);
  });
});
