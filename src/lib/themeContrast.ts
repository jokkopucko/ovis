/**
 * What "readable" means for a theme, as pairs of a foreground role and the surface it is drawn on:
 * WCAG 2.2 AA, 4.5:1 for text on the surfaces it sits on (1.4.3) and 3:1 for the status colours
 * the sidebar and tabs draw as indicators (1.4.11), plus the floors DESIGN.md promises: `--notice`
 * and the `--syntax-*` colours on their surfaces, and a light row's ANSI colours on its
 * `--term-bg`. The terminal's default foreground is left out: xterm draws every cell with a
 * minimum contrast ratio of its own. The hosted relay app adds its own pairs: text on
 * `--notice-tint`, its state glyphs (StatusDot) on every surface a row can take, and the focus
 * ring on the canvas and panel it is drawn over.
 *
 * One list, held two ways: themes.contrast.test.ts checks every theme of src/styles.css against it,
 * and themeDerive.ts moves an imported theme's colours until they meet it.
 */
import { LIGHT_ANSI_ROLES } from "./themeRoles.ts";

export const TEXT_FLOOR = 4.5;
export const INDICATOR_FLOOR = 3;

export interface ContrastPair { readonly fg: string; readonly bg: string; readonly floor: number }

const SURFACES = ["bg", "bg-panel", "bg-elevated", "bg-input", "bg-hover"] as const;

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...["text", "text-strong", "text-dim"].flatMap((fg) => SURFACES.map((bg) => ({ fg, bg, floor: TEXT_FLOOR }))),
  { fg: "primary-text", bg: "primary", floor: TEXT_FLOOR },
  { fg: "danger-text", bg: "bg", floor: TEXT_FLOOR },
  { fg: "danger-text", bg: "bg-panel", floor: TEXT_FLOOR },
  ...["status-working", "status-blocked", "status-done"].map((fg) => ({ fg, bg: "bg-panel", floor: INDICATOR_FLOOR })),
  ...["bg", "bg-panel", "bg-elevated"].map((bg) => ({ fg: "notice", bg, floor: TEXT_FLOOR })),
  // the chat's code blocks sit on the panels, the source viewer's on --bg (sourceTheme.ts)
  ...["syntax-function", "syntax-keyword", "syntax-string", "syntax-number", "syntax-type", "syntax-variable", "syntax-meta"]
    .flatMap((fg) => ["bg", "bg-panel", "bg-elevated"].map((bg) => ({ fg, bg, floor: TEXT_FLOOR }))),
  ...["notice", "text", "text-strong"].map((fg) => ({ fg, bg: "notice-tint", floor: TEXT_FLOOR })),
  ...["status-done", "notice", "text-dim", "status-working", "status-blocked"]
    .flatMap((fg) => ["bg", "bg-panel", "bg-elevated", "bg-hover", "notice-tint"].map((bg) => ({ fg, bg, floor: INDICATOR_FLOOR }))),
  ...["bg", "bg-panel"].map((bg) => ({ fg: "accent", bg, floor: INDICATOR_FLOOR })),
];

/** Dark rows use xterm's own ANSI colours; a light row sets all sixteen. */
export const LIGHT_ANSI_PAIRS: readonly ContrastPair[] = Object.values(LIGHT_ANSI_ROLES).map((fg) => ({ fg, bg: "term-bg", floor: TEXT_FLOOR }));
