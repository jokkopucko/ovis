import { describe, expect, test } from "bun:test";
import type { ScreenCell, ScreenLine } from "./terminalScreen.ts";
import { cellStyle, columnAt, contrastRatio, dimmedColor, paletteColor, readableColor, rowHtml, webLinkAt, wideGridKey, wideGrids } from "./terminalFold.ts";

interface Cell { chars: string; width?: number; fg?: number; bg?: number; bgRgb?: number; bold?: boolean; dim?: boolean; inverse?: boolean }

function line(cells: Cell[], cols: number): ScreenLine {
  const at = (x: number): Cell => cells[x] ?? { chars: "" };
  const cell = (x: number): ScreenCell => {
    const c = at(x);
    return {
      getChars: () => c.chars,
      getWidth: () => c.width ?? 1,
      isBold: () => (c.bold ? 1 : 0),
      isItalic: () => 0, isDim: () => (c.dim ? 1 : 0), isUnderline: () => 0, isInverse: () => (c.inverse ? 1 : 0),
      isInvisible: () => 0, isStrikethrough: () => 0, isOverline: () => 0,
      isFgDefault: () => c.fg === undefined, isBgDefault: () => c.bg === undefined && c.bgRgb === undefined,
      isFgRGB: () => false, isBgRGB: () => c.bgRgb !== undefined,
      getFgColor: () => c.fg ?? 0, getBgColor: () => c.bgRgb ?? c.bg ?? 0,
    };
  };
  return { length: cols, isWrapped: false, getCell: (x: number) => (x < cols ? cell(x) : undefined), translateToString: () => "" };
}
const scratch = line([], 1).getCell(0)!;
const plain = (text: string): Cell[] => [...text].map((chars) => ({ chars }));

describe("the folded view of a mirrored grid", () => {
  test("a palette index draws as the theme's colour, xterm's own where the theme names none, then the cube and the grey ramp", () => {
    expect(paletteColor(1, { red: "#ff5555" })).toBe("#ff5555");
    expect(paletteColor(1, {})).toBe("#cc0000");
    expect(paletteColor(16, {})).toBe("#000000");
    expect(paletteColor(196, {})).toBe("#ff0000");
    expect(paletteColor(231, {})).toBe("#ffffff");
    expect(paletteColor(232, {})).toBe("#080808");
    expect(paletteColor(255, {})).toBe("#eeeeee");
  });

  test("a colour too faint on its background is lifted until it reads, as the grid's minimum contrast draws it", () => {
    const lifted = readableColor("#3465a4", "#000000", 4.5);
    expect(lifted).not.toBe("#3465a4");
    expect(readableColor(lifted, "#000000", 4.5)).toBe(lifted);
    const darkened = readableColor("#fce94f", "#ffffff", 4.5);
    expect(darkened).not.toBe("#fce94f");
    expect(readableColor(darkened, "#ffffff", 4.5)).toBe(darkened);
    expect(readableColor("#eeeeec", "#000000", 4.5)).toBe("#eeeeec");
    expect(readableColor("#3465a4", "#000000", 1)).toBe("#3465a4");
    expect(readableColor("rgb(1, 2, 3)", "#000000", 4.5)).toBe("rgb(1, 2, 3)");
  });

  test("a row is its runs of cells drawn alike, without the blank cells herdr pads it with", () => {
    const cells: Cell[] = [{ chars: "a", fg: 1 }, { chars: "b", fg: 1 }, { chars: " " }, { chars: "가", width: 2 }, { chars: "", width: 0 }, ...plain("<&>   ")];
    expect(rowHtml(line(cells, 12), 12, { red: "#ff5555" }, scratch)).toBe('<span style="color:#ff5555;">ab</span> 가&lt;&amp;&gt;');
  });

  test("a row that draws only a background keeps it, and an empty row is empty", () => {
    expect(rowHtml(line([{ chars: " ", bg: 2 }], 4), 4, { green: "#50fa7b" }, scratch)).toBe('<span style="background:#50fa7b;"> </span>');
    expect(rowHtml(line([], 4), 4, {}, scratch)).toBe("");
  });

  test("dim text fades its colour, not its background, and meets >= 4.5:1 contrast on light and dark terminal backgrounds", () => {
    expect(rowHtml(line([{ chars: "d", fg: 2, bg: 0, dim: true }], 1), 1, {}, scratch))
      .toBe('<span style="color:color-mix(in srgb, #4e9a06 50%, transparent);background:#2e3436;">d</span>');
    const dimCell = line([{ chars: "d", dim: true }], 1).getCell(0, scratch)!;
    const darkStyle = cellStyle(dimCell, { foreground: "#d8d0c3", background: "#181613" }, 4.5);
    const darkHex = /color:(#[0-9a-f]{6});/i.exec(darkStyle)?.[1];
    expect(darkHex).toBeDefined();
    expect(contrastRatio(darkHex!, "#181613")!).toBeGreaterThanOrEqual(4.5);
    const lightStyle = cellStyle(dimCell, { foreground: "#2a251f", background: "#faf8f3" }, 4.5);
    const lightHex = /color:(#[0-9a-f]{6});/i.exec(lightStyle)?.[1];
    expect(lightHex).toBeDefined();
    expect(contrastRatio(lightHex!, "#faf8f3")!).toBeGreaterThanOrEqual(4.5);
  });

  test("faint text on a cell background the browser hands back as rgb() is lifted as on its hex", () => {
    // a span's style.backgroundColor reads back serialized: "#2e3436" comes back as "rgb(46, 52, 54)"
    const onHex = dimmedColor("#4e9a06", "#2e3436", 4.5);
    expect(onHex).toMatch(/^#[0-9a-f]{6}$/i);
    expect(dimmedColor("#4e9a06", "rgb(46, 52, 54)", 4.5)).toBe(onHex);
    expect(contrastRatio(dimmedColor("#d8d0c3", "rgb(24, 22, 19)", 4.5), "#181613")!).toBeGreaterThanOrEqual(4.5);
  });

  test("a tap on a folded row finds the http(s) address it is on, without the punctuation after it", () => {
    const text = " see https://example.com/a?b=1). or http://x.y";
    expect(webLinkAt(text, text.indexOf("example"))).toEqual({ url: "https://example.com/a?b=1", start: 5, end: 30 });
    expect(webLinkAt(text, 30)).toBeNull();
    expect(webLinkAt(text, 1)).toBeNull();
    expect(webLinkAt(text, text.length - 1)?.url).toBe("http://x.y");
    const wiki = "(see https://en.wikipedia.org/wiki/Function_(mathematics)).";
    expect(webLinkAt(wiki, 10)?.url).toBe("https://en.wikipedia.org/wiki/Function_(mathematics)");
  });

  test("a folded row's character is found in its grid column, past wide glyphs and the cells they cover", () => {
    const row = line([{ chars: "가", width: 2 }, { chars: "", width: 0 }, { chars: "" }, ...plain("ab")], 6);
    expect([0, 1, 2, 3].map((offset) => columnAt(row, 6, offset, scratch))).toEqual([0, 2, 3, 4]);
    expect(columnAt(row, 6, 9, scratch)).toBe(-1);
  });

  test("a colour that cannot reach the contrast one way reaches it the other", () => {
    const grey = readableColor("#aaaaaa", "#aaaaaa", 4.5);
    expect(contrastRatio(grey, "#aaaaaa")!).toBeGreaterThanOrEqual(4.5);
  });

  test("a default foreground on a background of the program's own colour still reads", () => {
    const html = rowHtml(line([{ chars: "x", bgRgb: 0xd8d0c3 }], 1), 1, { foreground: "#d8d0c3", background: "#1b1b1b" }, scratch, 4.5);
    const color = /color:(#[0-9a-f]{6});/.exec(html)?.[1];
    expect(color).toBeDefined();
    expect(contrastRatio(color!, "#d8d0c3")!).toBeGreaterThanOrEqual(4.5);
  });

  test("inverse swaps the colours before bold brightens the foreground, as xterm draws them", () => {
    expect(rowHtml(line([{ chars: "x", fg: 1, bg: 4, bold: true, inverse: true }], 1), 1, {}, scratch))
      .toBe('<span style="color:#729fcf;background:#cc0000;font-weight:bold;">x</span>');
    expect(rowHtml(line([{ chars: "x", inverse: true }], 1), 1, { foreground: "#eeeeee", background: "#111111" }, scratch))
      .toBe('<span style="color:#111111;background:#eeeeee;">x</span>');
  });

  test("bold text of the first eight colours draws in their bright forms", () => {
    expect(rowHtml(line([{ chars: "x", fg: 1, bold: true }], 1), 1, {}, scratch)).toBe('<span style="color:#ef2929;font-weight:bold;">x</span>');
  });

  test("the cursor's cell is drawn on its own in the cursor's shape, the blank cells up to it included", () => {
    const theme = { foreground: "#eeeeee", background: "#111111", cursor: "#ff0000", cursorAccent: "#000000" };
    expect(rowHtml(line(plain("abc"), 6), 6, theme, scratch, 1, { x: 1, shape: "block" }))
      .toBe('a<span class="terminal-fold-cursor" style="background:#ff0000;color:#000000;">b</span>c');
    expect(rowHtml(line(plain("ab"), 6), 6, theme, scratch, 1, { x: 3, shape: "outline" }))
      .toBe('ab <span class="terminal-fold-cursor" style="box-shadow:inset 0 0 0 1px #ff0000;"> </span>');
    expect(rowHtml(line([{ chars: "한", width: 2 }, { chars: "", width: 0 }, { chars: "x" }], 3), 3, theme, scratch, 1, { x: 1, shape: "none" }))
      .toBe('<span class="terminal-fold-cursor">한</span>x');
    // a write that filled the row: the cursor waits past the last column, and stands on the last cell
    expect(rowHtml(line(plain("abcde"), 5), 5, theme, scratch, 1, { x: 5, shape: "block" }))
      .toBe('abcd<span class="terminal-fold-cursor" style="background:#ff0000;color:#000000;">e</span>');
  });

  test("a pane stays wide for the menu while any terminal drawing it says so, and its listeners hear each change", () => {
    const pane = wideGridKey("pc", "w1:p1");
    const first = {};
    const second = {};
    let heard = 0;
    const stop = wideGrids.subscribe(() => { heard++; });
    try {
      wideGrids.set(first, pane);
      wideGrids.set(second, pane);
      wideGrids.set(first, pane);
      expect(heard).toBe(2);
      wideGrids.set(first, null);
      expect(wideGrids.snapshot().has(pane)).toBe(true);
      wideGrids.set(second, wideGridKey("pc", "w1:p2"));
      expect(wideGrids.snapshot().has(pane)).toBe(false);
      wideGrids.set(second, null);
      expect(wideGrids.snapshot().size).toBe(0);
      expect(heard).toBe(5);
    } finally {
      stop();
      wideGrids.set(first, null);
      wideGrids.set(second, null);
    }
  });
});
