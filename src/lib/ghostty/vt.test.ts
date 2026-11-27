import { describe, expect, it } from "bun:test";

import { GhosttyVt, textCells } from "./vt.ts";


interface Layout { cells: readonly (readonly [number, string])[]; cursor: number }

async function ghosttyLayout(...chunks: string[]): Promise<Layout> {
  return await ghosttyScreen(40, 0, chunks);
}

async function ghosttyScreen(cols: number, resetAfter: number, chunks: string[], row = 0): Promise<Layout> {
  const vt = await GhosttyVt.create(cols, 2);
  try {
    chunks.forEach((chunk, index) => {
      vt.write(chunk);
      if (index + 1 === resetAfter) vt.reset();
    });
    const cells: [number, string][] = [];
    vt.frame((y, runs) => {
      if (y !== row) return;
      for (const run of runs) {
        let x = run.x;
        for (const cell of run.cells) {
          if (cell.text !== " ") cells.push([x, cell.text]);
          x += cell.wide ? 2 : 1;
        }
      }
    });
    return { cells, cursor: vt.cursor().x };
  } finally {
    vt.dispose();
  }
}

const ascii = ({ cells, cursor }: Layout): Layout => ({
  cells: cells.map(([x, text]): [number, string] => [x, text.replace(/\p{Default_Ignorable_Code_Point}/gu, "")])
    .filter(([, text]) => /^[\x21-\x7e]$/.test(text)),
  cursor,
});

describe("GhosttyVt frame", () => {
  it("tells a frame that only moved, hid or showed the cursor", async () => {
    const vt = await GhosttyVt.create(80, 5);
    try {
      const step = (bytes: string) => {
        vt.write(bytes);
        const changed = vt.frame(() => {});
        const c = vt.cursor();
        return { changed, x: c.x, y: c.y, visible: c.visible };
      };
      expect(step("ab")).toEqual({ changed: true, x: 2, y: 0, visible: true });
      expect(step("\x1b[D")).toEqual({ changed: true, x: 1, y: 0, visible: true });
      expect(step("\x1b[C")).toEqual({ changed: true, x: 2, y: 0, visible: true });
      expect(step(" ")).toEqual({ changed: true, x: 3, y: 0, visible: true });
      expect(step("\x1b[3;5H")).toEqual({ changed: true, x: 4, y: 2, visible: true });
      expect(step("")).toEqual({ changed: false, x: 4, y: 2, visible: true });
      expect(step("\x1b[?25l")).toEqual({ changed: true, x: 0, y: 0, visible: false });
      expect(step("\x1b[?25h")).toEqual({ changed: true, x: 4, y: 2, visible: true });
    } finally {
      vt.dispose();
    }
  });
});

describe("GhosttyVt widths", () => {
  for (const [name, grapheme, width] of [
    ["ZWJ family", "👨‍👩‍👧", 2], ["emoji presentation selector", "⚠️", 2], ["skin tone", "👍🏽", 2],
    ["flag", "🇰🇷", 2], ["keycap", "1️⃣", 2], ["Unicode 15 emoji", "🫨", 2],
    ["text-presentation selector", "⚽︎", 1], ["Enclosed Ideographic Supplement", "🈚︎", 1],
    ["subdivision flag", "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}", 2],
    ["ZWJ sequence longer than the grapheme buffer", "👩" + "‍👩".repeat(18), 2],
  ] as const) {
    it("draws a whole grapheme at its cell width: " + name, async () => {
      expect(await ghosttyLayout("a" + grapheme + "b")).toEqual({ cells: [[0, "a"], [1, grapheme], [1 + width, "b"]], cursor: 2 + width } satisfies Layout);
    });
  }

  for (const [name, text, cells] of [
    ["Hangul and Han", "a한漢b", [[0, "a"], [1, "한"], [3, "漢"], [5, "b"]]],
    ["Bengali", "aবাংলাb", [[0, "a"], [1, "ব"], [2, "া"], [3, "ং"], [4, "ল"], [5, "া"], [6, "b"]]],
    ["Indic conjunct", "aक्षb", [[0, "a"], [1, "क्"], [2, "ष"], [3, "b"]]],
    ["text presentation selectors on text symbols", "a#\ufe0e\u26a0\ufe0eb", [[0, "a"], [1, "#︎"], [2, "⚠︎"], [3, "b"]]],
  ] as const) {
    it("keeps the printed cell boundaries: " + name, async () => {
      expect(await ghosttyLayout(text)).toEqual({ cells, cursor: (cells.at(-1)?.[0] ?? 0) + 1 });
    });
  }

  for (const [name, text, column] of [
    ["Thai SARA AM", "aน้ำb c", 3], ["Devanagari vowel sign", "aकाb c", 3],
    ["zero-width space", "a\u200bb c", 1], ["selector on an emoji without a text form", "a😀\ufe0eb c", 3],
    ["text then emoji selector", "a⚽\ufe0e\ufe0fb c", 2], ["text selector after a skin tone", "a👍🏽\ufe0eb c", 3],
    ["ZWJ after a text selector", "a⌚\ufe0e\u200d⌚b c", 3], ["skin tone after a text selector", "a👍\ufe0e🏽b c", 4],
    ["style change before a skin tone", "a👍\x1b[31m🏽b c", 5],
    ["style change before a ZWJ", "a👨\x1b[31m‍👩b c", 5], ["style change after a ZWJ", "a👨‍\x1b[31m👩b c", 5],
    ["bell before a flag's second half", "a🇰\x07🇷b c", 3],
    ["OSC title before a skin tone", "a👍\x1b]0;t\x07🏽b c", 5],
    ["OSC title ended by ST", "a👍\x1b]0;t\x1b\\🏽b c", 5],
  ] as const) {
    it("puts the text that follows in its own columns: " + name, async () => {
      expect(ascii(await ghosttyLayout(text))).toEqual({ cells: [[0, "a"], [column, "b"], [column + 2, "c"]], cursor: column + 3 } satisfies Layout);
    });
  }

  it.each(["\x1b[?2027h", "\x1b[?1;2027h", "\x1b[?2027h\x1b[?2027s\x1b[?2027r", "\x1bc"])("keeps layout after a program mode change or reset %j", async (prefix) => {
    expect(await ghosttyLayout(prefix + "ABC👨‍👩‍👧XYZ")).toEqual({ cells: [[0, "A"], [1, "B"], [2, "C"], [3, "👨‍👩‍👧"], [5, "X"], [6, "Y"], [7, "Z"]], cursor: 8 } satisfies Layout);
  });

  it("keeps Indic spacing when a mode 2027 enable is split between writes", async () => {
    const expected: Layout = { cells: [[0, "A"], [1, "B"], [2, "C"], [3, "क्"], [4, "ष"], [5, "X"], [6, "Y"], [7, "Z"]], cursor: 8 };
    expect(await ghosttyLayout("\x1b[?20", "27hABCक्षXYZ")).toEqual(expected);
    expect(await ghosttyLayout("\x1b[?2027", "hABCक्षXYZ")).toEqual(expected);
  });

  it("gives a spacing mark its own cell at the end of a line and when overwritten", async () => {
    expect(await ghosttyScreen(10, 0, ["123456789काX"], 1)).toEqual({ cells: [[0, "ा"], [1, "X"]], cursor: 2 } satisfies Layout);
    expect(await ghosttyLayout("aका\x1b[3GZ")).toEqual({ cells: [[0, "a"], [1, "क"], [2, "Z"]], cursor: 3 } satisfies Layout);
    expect(await ghosttyLayout("aน้ำb")).toEqual({ cells: [[0, "a"], [1, "น้"], [2, "ำ"], [3, "b"]], cursor: 4 } satisfies Layout);
  });

  it("gives back the second cell when a later write narrows an emoji", async () => {
    expect(await ghosttyLayout("A⚽", "\ufe0eX")).toEqual({ cells: [[0, "A"], [1, "⚽︎"], [2, "X"]], cursor: 3 } satisfies Layout);
    expect(await ghosttyScreen(4, 0, ["abc⚽\ufe0eX"], 1)).toEqual({ cells: [[0, "⚽︎"], [1, "X"]], cursor: 2 } satisfies Layout);
  });

  it.each([
    ["abcde", 6, [[0, "a"], [1, "b"], [2, "c"], [3, "d"], [4, "e"], [5, "X"]]],
    ["abc漢", 6, [[0, "a"], [1, "b"], [2, "c"], [3, "漢"], [5, "X"]]],
    ["한한", 5, [[0, "한"], [2, "한"], [4, "X"]]],
  ] as const)("keeps existing cells when autowrap is off and a wide glyph will not fit: %s", async (before, cols, cells) => {
    expect(await ghosttyScreen(cols, 0, ["\x1b[?7l" + before + "⚽\ufe0eX"])).toEqual({ cells, cursor: cols - 1 });
  });

  it("finds a mode 2027 on with a control byte or DEL inside it or across a reset", async () => {
    const expected: Layout = { cells: [[0, "a"], [1, "क्"], [2, "ष"], [3, "X"]], cursor: 4 };
    expect(await ghosttyLayout("\x1b[\x00?2027haक्षX")).toEqual(expected);
    expect(await ghosttyLayout("\x1b[?2027\x7fhaक्षX")).toEqual(expected);
    expect(await ghosttyScreen(40, 1, ["\x1b[?20", "27haक्षX"])).toEqual(expected);
  });
});

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

describe("textCells", () => {
  it.each(HERDR_COLUMNS)("counts cells for %s", async (_name, text, columns) => {
    const vt = await GhosttyVt.create(80, 24);
    vt.dispose();
    expect(textCells(text)).toBe(columns);
  });

  it("ignores controls and resets the scratch grid between readings, even for long lines", async () => {
    const vt = await GhosttyVt.create(80, 24);
    vt.dispose();
    expect(textCells("한".repeat(2500))).toBe(5000);
    expect(textCells("a\t\nb\r\x1b\x7f\x9bc")).toBe(3);
    expect(textCells("")).toBe(0);
  });
});

describe("resize after a program changed its columns", () => {
  it("draws the size it is given again after the program switched to 132 columns", async () => {
    const vt = await GhosttyVt.create(80, 24);
    try {
      vt.resize(80, 24, 8, 16);
      vt.write("\x1b[?40h\x1b[?3h");
      vt.frame(() => {});
      vt.resize(80, 24, 8, 16);
      vt.write("\x1b[2JX");
      let drawn = 0;
      vt.frame((_y, runs) => {
        for (const run of runs) drawn = Math.max(drawn, run.x + run.cells.reduce((width, cell) => width + (cell.wide ? 2 : 1), 0));
      });
      expect({ cols: vt.cols, drawn }).toEqual({ cols: 80, drawn: 80 });
    } finally {
      vt.dispose();
    }
  });
});
