/**
 * The rows a pane shows, for a browser regression to read its text from: libghostty's own rows while it
 * draws the pane (src/lib/ghostty/overlay.ts), where xterm's are hidden and no longer redrawn; xterm's rows
 * where xterm draws by itself (the module did not load, an iTerm2 or sixel picture); a folded mirror's own rows (lib/terminalFold.ts)
 * while it is folded.
 */
export function shownRows(scope = ""): string {
  const at = scope ? `${scope} ` : "";
  return [
    `${at}.pane-terminal[data-renderer='ghostty']:not([data-folded]) .ghostty-text`,
    `${at}.pane-terminal:not([data-renderer='ghostty']):not([data-folded]) .xterm-rows`,
    `${at}.pane-terminal[data-folded] .terminal-fold`,
  ].join(", ");
}

export function shownRow(scope = ""): string {
  const at = scope ? `${scope} ` : "";
  return [
    `${at}.pane-terminal[data-renderer='ghostty']:not([data-folded]) .ghostty-row`,
    `${at}.pane-terminal:not([data-renderer='ghostty']):not([data-folded]) .xterm-rows > div`,
    `${at}.pane-terminal[data-folded] .terminal-fold-row`,
  ].join(", ");
}
