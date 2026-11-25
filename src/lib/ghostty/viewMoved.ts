/** Fired on a terminal's element when herdr's view of it is moved (page keys, Jump to bottom): herdr paints the moved view as
 *  output, and libghostty's layer must not read it out as new lines (overlay.ts). Its own module, so the viewport tools
 *  do not load the layer. */
export const VIEW_MOVED_EVENT = "ovis-view-moved";
/** told on a pane's host after libghostty drew a frame that changed rows: a view drawn from its rows (the fold) draws them again */
export const GHOSTTY_DREW_EVENT = "ovis-ghostty-drew";
