import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { contrastRatio } from "./terminalFold.ts";
import { parseThemeBlocks, resolveEntry } from "./themeCss.ts";
import { CONTRAST_PAIRS, LIGHT_ANSI_PAIRS } from "./themeContrast.ts";
import { SUPPORTED_ENTRIES } from "./themes.ts";

/**
 * The floors of themeContrast.ts for every theme of src/styles.css, so a palette edit cannot
 * quietly make the interface unreadable.
 */
const blocks = parseThemeBlocks(readFileSync(new URL("../styles.css", import.meta.url), "utf8"));

describe("theme contrast", () => {
  it("checks every supported theme entry", () => {
    expect(SUPPORTED_ENTRIES.length).toBeGreaterThan(0);
  });

  for (const entry of SUPPORTED_ENTRIES) {
    it(`${entry.id}/${entry.mode} meets the WCAG AA floors`, () => {
      const colors = resolveEntry(blocks, entry.id, entry.mode).resolved;
      const below = [...CONTRAST_PAIRS, ...(entry.mode === "light" ? LIGHT_ANSI_PAIRS : [])].flatMap(({ fg, bg, floor }) => {
        const ratio = contrastRatio(colors[`--${fg}`] ?? "", colors[`--${bg}`] ?? "");
        // a colour that is not plain hex (an alpha tint) cannot be measured here: it fails rather than passing unread
        if (ratio === null) return [`${fg} on ${bg}: ${colors[`--${fg}`]} / ${colors[`--${bg}`]} is not #rrggbb`];
        return ratio < floor ? [`${fg} on ${bg}: ${ratio.toFixed(2)}:1 < ${floor}:1 (${colors[`--${fg}`]} / ${colors[`--${bg}`]})`] : [];
      });
      expect(below).toEqual([]);
    });
  }
});
