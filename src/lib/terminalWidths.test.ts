import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { patchedTerminal } from "../../scripts/build-xterm.ts";
import { matchHerdrWidths } from "./terminalWidths.ts";

const Terminal = await patchedTerminal(join(import.meta.dir, "../.."));

async function columnsAfter(text: string): Promise<number> {
  const term = new Terminal({ allowProposedApi: true, cols: 40, rows: 2 });
  matchHerdrWidths(term);
  await new Promise<void>((resolve) => term.write(text, resolve));
  const column = term.buffer.active.cursorX;
  term.dispose();
  return column;
}

// herdr's own answers: each text printed in a herdr 0.9 pane, then the cursor position
// read back with a DSR query (ESC [ 6 n)
const HERDR_COLUMNS: [string, string, number][] = [
  ["Unicode 9 emoji", "🤖", 2],
  ["emoji presentation selector on a text symbol", "⚠️", 2],
  ["the same symbol without one", "⚠", 1],
  ["ZWJ family", "👨‍👩‍👧", 2],
  ["skin tone", "👍🏽", 2],
  ["flag", "🇰🇷", 2],
  ["keycap", "1️⃣", 2],
  ["Unicode 14 emoji", "🫡", 2],
  ["Unicode 15 emoji", "🫨", 2],
  ["Thai SARA AM after a tone mark", "น้ำ", 2],
  ["Devanagari vowel sign", "का", 2],
  ["zero-width space", "a\u200bb", 2],
  ["left-to-right mark", "a\u200eb", 2],
  ["decomposed Hangul", "\u1112\u1161\u11ab", 2],
  ["Hangul and Han", "한漢", 4],
  ["ambiguous-width circle", "●", 1],
  ["text presentation selector on an emoji", "⚽\ufe0e", 1],
  ["text presentation selector on an emoji in the Enclosed Ideographic Supplement", "\u{1f21a}\ufe0e", 1],
  ["text presentation selector on an emoji without a text form", "😀\ufe0e", 2],
  ["an emoji presentation selector after a text one", "⚽\ufe0e\ufe0f", 1],
  ["text presentation selector after a skin tone", "👍🏽\ufe0e", 2],
  ["a ZWJ sequence after a text presentation selector", "\u231a\ufe0e\u200d\u231a", 2],
  ["a skin tone after a text presentation selector", "\u{1f44d}\ufe0e\u{1f3fd}", 3],
];

describe("matchHerdrWidths", () => {
  for (const [name, text, columns] of HERDR_COLUMNS) {
    it(`advances as herdr does: ${name}`, async () => {
      expect(await columnsAfter(text)).toBe(columns);
    });
  }

  it("keeps a ZWJ sequence whole in one cell, so the next character cannot overwrite part of it", async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 40, rows: 2 });
    matchHerdrWidths(term);
    await new Promise<void>((resolve) => term.write("👨‍👩‍👧x", resolve));
    const line = term.buffer.active.getLine(0);
    expect(line?.getCell(0)?.getChars()).toBe("👨‍👩‍👧");
    expect(line?.getCell(2)?.getChars()).toBe("x");
    term.dispose();
  });

  it("gives back the second cell of an emoji a text presentation selector narrows", async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 40, rows: 2 });
    matchHerdrWidths(term);
    await new Promise<void>((resolve) => term.write("A⚽", resolve));
    await new Promise<void>((resolve) => term.write("\ufe0eX", resolve));
    const line = term.buffer.active.getLine(0);
    expect([0, 1, 2].map((x) => [line?.getCell(x)?.getChars(), line?.getCell(x)?.getWidth()])).toEqual([["A", 1], ["⚽\ufe0e", 1], ["X", 1]]);
    term.dispose();
  });

  it("narrows an emoji the last column wrapped", async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 4, rows: 3 });
    matchHerdrWidths(term);
    await new Promise<void>((resolve) => term.write("abc⚽\ufe0eX", resolve));
    const line = term.buffer.active.getLine(1);
    expect([0, 1].map((x) => line?.getCell(x)?.getChars())).toEqual(["⚽\ufe0e", "X"]);
    expect(term.buffer.active.cursorX).toBe(2);
    term.dispose();
  });

  for (const [before, cols, after, wideAt] of [["abcde", 6, "abcdeX", null], ["abc漢", 6, "abc漢X", 3], ["한한", 5, "한한X", 2]] as const) {
    it(`keeps what came before an emoji that autowrap off dropped at the last column: ${before}`, async () => {
      const term = new Terminal({ allowProposedApi: true, cols, rows: 2 });
      matchHerdrWidths(term);
      await new Promise<void>((resolve) => term.write(`\x1b[?7l${before}\u26bd\ufe0eX`, resolve));
      const line = term.buffer.active.getLine(0);
      expect(line?.translateToString(true).replace(/\ufe0e/g, "")).toBe(after);
      if (wideAt !== null) expect(line?.getCell(wideAt)?.getWidth()).toBe(2);
      term.dispose();
    });
  }
});
