import { describe, expect, it } from "bun:test";

import { terminalLineHeight } from "./terminalLineHeight.ts";

const row = (charHeight: number, lineHeight: number, ratio: number): number =>
  Math.floor(Math.ceil(charHeight * ratio) * lineHeight) / ratio;

// Hangul's ink (0.913em) and the gap kept below it (0.35em)
const WANTED_EM = 1.263;

describe("terminalLineHeight", () => {
  it("makes Menlo's 15px line at 13px a 16.5px row on a 2x screen, 16px on a 1x one", () => {
    expect(row(15, terminalLineHeight(15, 13, 2), 2)).toBe(16.5);
    expect(row(15, terminalLineHeight(15, 13, 1), 1)).toBe(16);
  });

  it("keeps a line already tall enough for Hangul and its gap (JetBrains Mono, Noto Sans Mono)", () => {
    expect(terminalLineHeight(17, 13, 1)).toBe(1);
    expect(terminalLineHeight(17.6, 13, 2)).toBe(1);
    expect(terminalLineHeight(22, 16, 3)).toBe(1);
  });

  it("gives the row nearest Hangul and its gap, never shorter than the font's line, at every size and pixel ratio", () => {
    for (const ratio of [1, 1.25, 1.5, 2, 2.625, 3]) {
      for (let fontSize = 8; fontSize <= 32; fontSize += 1) {
        for (const lineEm of [1.164, 1.171]) {
          const charHeight = Math.round(lineEm * fontSize);
          const drawn = row(charHeight, terminalLineHeight(charHeight, fontSize, ratio), ratio);
          const line = Math.ceil(charHeight * ratio) / ratio;
          expect(drawn).toBe(Math.max(line, Math.round(WANTED_EM * fontSize * ratio) / ratio));
        }
      }
    }
  });

  it("keeps the font's line when nothing was measured", () => {
    expect(terminalLineHeight(0, 13, 2)).toBe(1);
    expect(terminalLineHeight(Number.NaN, 13, 2)).toBe(1);
    expect(terminalLineHeight(15, 13, 0)).toBe(1);
  });
});
