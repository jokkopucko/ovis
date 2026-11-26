/** The current text layer or the folded view, whichever the pane shows. */
export function shownRows(scope = ""): string {
  const at = scope ? `${scope} ` : "";
  return [
    `${at}.pane-terminal[data-renderer='ghostty']:not([data-folded]) .ghostty-text`,
    `${at}.pane-terminal[data-folded] .terminal-fold`,
  ].join(", ");
}

export function shownRow(scope = ""): string {
  const at = scope ? `${scope} ` : "";
  return [
    `${at}.pane-terminal[data-renderer='ghostty']:not([data-folded]) .ghostty-row`,
    `${at}.pane-terminal[data-folded] .terminal-fold-row`,
  ].join(", ");
}
