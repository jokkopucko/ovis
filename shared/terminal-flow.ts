/** Overloaded output stops this connection; automatic replay could conceal lost ANSI state. */
export const OUTPUT_STALLED_CLOSE_CODE = 4008;

/** Lines a herdr-core attach replays first and xterm keeps for its pane (`ServerFeature` `terminal-history`). */
export const TERMINAL_HISTORY_LINES = 2000;
