/**
 * The theme role contract, apart from the generated theme data: the generator reads it to
 * produce themes.generated.ts, so it must load even when that output is missing or conflicted.
 */
export const ROLES = {
  bg: "color",
  "bg-panel": "color",
  "bg-elevated": "color",
  "bg-hover": "color",
  "bg-input": "color",
  border: "color",
  "border-strong": "color",
  text: "color",
  "text-dim": "color",
  "text-strong": "color",
  accent: "color",
  "accent-tint": "color",
  primary: "color",
  "primary-hover": "color",
  "primary-text": "color",
  "primary-tint": "color",
  "status-idle": "color",
  "status-working": "color",
  "status-blocked": "color",
  "status-done": "color",
  "status-working-tint": "color",
  "status-blocked-tint": "color",
  "status-done-tint": "color",
  "danger-tint": "color",
  notice: "color",
  "danger-text": "color",
  scrim: "color",
  "term-bg": "color",
  "term-fg": "color",
  "term-cursor": "color",
  "term-selection": "color",
  "line-number": "color",
  "syntax-function": "color",
  "syntax-keyword": "color",
  "syntax-string": "color",
  "syntax-number": "color",
  "syntax-type": "color",
  "syntax-variable": "color",
  "syntax-meta": "color",
  "bubble-border": "color",
  "shadow-drawer": "shadow",
  "shadow-pop": "shadow",
  "shadow-card": "shadow",
} as const;

/** Light-only terminal roles, keyed by xterm's ITheme names. Dark rows use xterm defaults. */
export const LIGHT_ANSI_ROLES = {
  black: "term-black",
  red: "term-red",
  green: "term-green",
  yellow: "term-yellow",
  blue: "term-blue",
  magenta: "term-magenta",
  cyan: "term-cyan",
  white: "term-white",
  brightBlack: "term-bright-black",
  brightRed: "term-bright-red",
  brightGreen: "term-bright-green",
  brightYellow: "term-bright-yellow",
  brightBlue: "term-bright-blue",
  brightMagenta: "term-bright-magenta",
  brightCyan: "term-bright-cyan",
  brightWhite: "term-bright-white",
} as const;

/**
 * herdr's TUI state colours (the sidebar's and the tabs' classic status glyphs). The base blocks of
 * src/styles.css set them once for every built-in theme; an imported theme sets its own (themeDerive.ts).
 */
export const INDICATOR_ROLES = ["indicator-working", "indicator-blocked", "indicator-done", "indicator-idle", "indicator-unknown"] as const;

export const SHADOW_GEOMETRY = {
  dark: {
    "shadow-drawer": ["0 0 40px"],
    "shadow-pop": ["0 16px 48px", "0 0 0 1px"],
    "shadow-card": ["0 4px 16px"],
  },
  light: {
    "shadow-drawer": ["0 0 40px"],
    "shadow-pop": ["0 16px 48px", "0 0 0 1px"],
    "shadow-card": ["0 4px 16px"],
  },
} as const;
