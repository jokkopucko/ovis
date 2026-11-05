import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { contrastRatio } from "./terminalFold.ts";
import { parseThemeBlocks, resolveEntry } from "./themeCss.ts";
import { LIGHT_ANSI_ROLES } from "./themeRoles.ts";
import { SUPPORTED_ENTRIES } from "./themes.ts";

/**
 * WCAG 2.2 AA floors for every theme of src/styles.css, so a palette edit cannot quietly make the
 * interface unreadable: 4.5:1 for text on the surfaces it sits on (1.4.3), 3:1 for the status
 * colours the sidebar and tabs draw as indicators (1.4.11). It also holds the floors DESIGN.md
 * promises: `--notice` and the `--syntax-*` colours on their surfaces, and a light
 * row's ANSI colours on its `--term-bg`. The terminal's default foreground is left out: xterm
 * draws every cell with a minimum contrast ratio of its own.
 */
const TEXT_FLOOR = 4.5;
const INDICATOR_FLOOR = 3;

const SURFACES = ["bg", "bg-panel", "bg-elevated", "bg-input", "bg-hover"] as const;
const PAIRS: readonly { fg: string; bg: string; floor: number }[] = [
  ...["text", "text-strong", "text-dim"].flatMap((fg) => SURFACES.map((bg) => ({ fg, bg, floor: TEXT_FLOOR }))),
  { fg: "primary-text", bg: "primary", floor: TEXT_FLOOR },
  { fg: "danger-text", bg: "bg", floor: TEXT_FLOOR },
  { fg: "danger-text", bg: "bg-panel", floor: TEXT_FLOOR },
  ...["status-working", "status-blocked", "status-done"].map((fg) => ({ fg, bg: "bg-panel", floor: INDICATOR_FLOOR })),
  ...["bg", "bg-panel", "bg-elevated"].map((bg) => ({ fg: "notice", bg, floor: TEXT_FLOOR })),
  // the chat's code blocks sit on the panels, the source viewer's on --bg (sourceTheme.ts)
  ...["syntax-function", "syntax-keyword", "syntax-string", "syntax-number", "syntax-type", "syntax-variable", "syntax-meta"]
    .flatMap((fg) => ["bg", "bg-panel", "bg-elevated"].map((bg) => ({ fg, bg, floor: TEXT_FLOOR }))),
];
/** Dark rows use xterm's own ANSI colours; a light row sets all sixteen. */
const LIGHT_PAIRS = Object.values(LIGHT_ANSI_ROLES).map((fg) => ({ fg, bg: "term-bg", floor: TEXT_FLOOR }));

const blocks = parseThemeBlocks(readFileSync(new URL("../styles.css", import.meta.url), "utf8"));

describe("theme contrast", () => {
  it("checks every supported theme entry", () => {
    expect(SUPPORTED_ENTRIES.length).toBeGreaterThan(0);
  });

  for (const entry of SUPPORTED_ENTRIES) {
    it(`${entry.id}/${entry.mode} meets the WCAG AA floors`, () => {
      const colors = resolveEntry(blocks, entry.id, entry.mode).resolved;
      const below = [...PAIRS, ...(entry.mode === "light" ? LIGHT_PAIRS : [])].flatMap(({ fg, bg, floor }) => {
        const ratio = contrastRatio(colors[`--${fg}`] ?? "", colors[`--${bg}`] ?? "");
        // a colour that is not plain hex (an alpha tint) cannot be measured here: it fails rather than passing unread
        if (ratio === null) return [`${fg} on ${bg}: ${colors[`--${fg}`]} / ${colors[`--${bg}`]} is not #rrggbb`];
        return ratio < floor ? [`${fg} on ${bg}: ${ratio.toFixed(2)}:1 < ${floor}:1 (${colors[`--${fg}`]} / ${colors[`--${bg}`]})`] : [];
      });
      expect(below).toEqual([]);
    });
  }
});
