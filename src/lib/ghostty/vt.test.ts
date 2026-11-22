import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { patchedTerminal } from "../../../scripts/build-xterm.ts";
import { matchHerdrWidths } from "../terminalWidths.ts";
import { GhosttyVt } from "./vt.ts";

const Terminal = await patchedTerminal(join(import.meta.dir, "../../.."));

interface Layout { cells: [number, string][]; cursor: number }

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

async function xtermLayout(text: string, cols = 40, row = 0): Promise<Layout> {
  const term = new Terminal({ allowProposedApi: true, cols, rows: 2 });
  matchHerdrWidths(term);
  await new Promise<void>((resolve) => term.write(text, resolve));
  const line = term.buffer.active.getLine(row)!;
  const cells: [number, string][] = [];
  for (let x = 0; x < cols; x++) {
    const chars = line.getCell(x)?.getChars() ?? "";
    if (chars && chars !== " ") cells.push([x, chars]);
  }
  const cursor = term.buffer.active.cursorX;
  term.dispose();
  return { cells, cursor };
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
  for (const [name, text] of [
    ["ZWJ family", "ABC👨‍👩‍👧XYZ"],
    ["emoji presentation selector", "a⚠️b"],
    ["skin tone", "a👍🏽b"],
    ["flag", "a🇰🇷b"],
    ["keycap", "a1️⃣b"],
    ["Unicode 15 emoji", "a🫨b"],
    ["Hangul and Han", "a한漢b"],
    ["Bengali", "aবাংলাb"],
    ["Indic conjunct", "aक्षb"],
    ["text-presentation selector", "a⚽︎b"],
    ["text-presentation selector in the Enclosed Ideographic Supplement", "a\u{1f21a}\ufe0eb"],
    ["text-presentation selector on a text symbol", "a#\ufe0e\u26a0\ufe0eb"],
    ["subdivision flag", "a🏴󠁧󠁢󠁳󠁣󠁴󠁿b"],
  ] as const) {
    it(`draws each grapheme in xterm's cell: ${name}`, async () => {
      expect(await ghosttyLayout(text)).toEqual(await xtermLayout(text));
    });
  }

  // libghostty draws a cluster with a spacing mark as one two-column cell where xterm has two cells over the
  // same columns, and drops a zero-width space or a selector it does not apply that xterm keeps in the cell
  // before it: nothing after them moves
  for (const [name, text] of [
    ["Thai SARA AM", "aน้ำb c"],
    ["Devanagari vowel sign", "aकाb c"],
    ["zero-width space", "a\u200bb c"],
    ["text-presentation selector on an emoji without a text form", "a\u{1f600}\ufe0eb c"],
    ["text- then emoji-presentation selector", "a\u26bd\ufe0e\ufe0fb c"],
    ["text-presentation selector after a skin tone", "a\u{1f44d}\u{1f3fd}\ufe0eb c"],
    ["a ZWJ sequence after a text-presentation selector", "a\u231a\ufe0e\u200d\u231ab c"],
    ["a skin tone after a text-presentation selector", "a\u{1f44d}\ufe0e\u{1f3fd}b c"],
    ["a style change before a skin tone", "a👍\x1b[31m🏽b c"],
    ["a style change before a ZWJ", "a👨\x1b[31m‍👩b c"],
    ["a style change after a ZWJ", "a👨‍\x1b[31m👩b c"],
    ["a bell before a flag's second half", "a🇰\x07🇷b c"],
    ["an OSC title before a skin tone", "a👍\x1b]0;t\x07🏽b c"],
    ["an OSC title ended by ST before a skin tone", "a👍\x1b]0;t\x1b\\🏽b c"],
  ] as const) {
    it(`puts the text after it in xterm's columns: ${name}`, async () => {
      expect(ascii(await ghosttyLayout(text))).toEqual(ascii(await xtermLayout(text)));
    });
  }

  for (const [name, prefix] of [
    ["the program turns mode 2027 on", "\x1b[?2027h"],
    ["it turns 2027 on among other modes", "\x1b[?1;2027h"],
    ["it restores a saved 2027", "\x1b[?2027h\x1b[?2027s\x1b[?2027r"],
    ["the terminal is reset", "\x1bc"],
  ] as const) {
    it(`lays out as xterm after ${name}`, async () => {
      expect(await ghosttyLayout(`${prefix}ABC👨‍👩‍👧XYZ`)).toEqual(await xtermLayout(`${prefix}ABC👨‍👩‍👧XYZ`));
    });
  }

  it("lays out as xterm when a mode 2027 on is split between two writes", async () => {
    expect(await ghosttyLayout("\x1b[?20", "27hABCक्षXYZ")).toEqual(await xtermLayout("\x1b[?2027hABCक्षXYZ"));
    expect(await ghosttyLayout("\x1b[?2027", "hABCक्षXYZ")).toEqual(await xtermLayout("\x1b[?2027hABCक्षXYZ"));
  });

  it("draws a ZWJ sequence longer than the grapheme buffer", async () => {
    const long = `👩${"\u200d👩".repeat(18)}X`;
    expect(await ghosttyLayout(long)).toEqual(await xtermLayout(long));
  });

  it("gives a spacing mark xterm's own cell at the end of a line and when overwritten", async () => {
    expect(await ghosttyScreen(10, 0, ["123456789काX"], 1)).toEqual(await xtermLayout("123456789काX", 10, 1));
    expect(await ghosttyLayout("aका\x1b[3GZ")).toEqual(await xtermLayout("aका\x1b[3GZ"));
    expect(await ghosttyLayout("aน้ำb")).toEqual(await xtermLayout("aน้ำb"));
  });

  it("finds a mode 2027 on with a control byte or DEL inside it or across a reset", async () => {
    expect(await ghosttyLayout("\x1b[\x00?2027haक्षX")).toEqual(await xtermLayout("\x1b[\x00?2027haक्षX"));
    expect(await ghosttyLayout("\x1b[?2027\x7fhaक्षX")).toEqual(await xtermLayout("\x1b[?2027\x7fhaक्षX"));
    expect(await ghosttyScreen(40, 1, ["\x1b[?20", "27haक्षX"])).toEqual(await xtermLayout("aक्षX"));
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
