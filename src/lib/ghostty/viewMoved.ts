/** Fired on a terminal's element when herdr's view of it is moved (page keys, Jump to bottom): herdr paints the moved view as
 *  output, and libghostty's layer must not read it out as new lines (terminal.ts). Its own module, so the viewport tools
 *  do not load the layer. */
export const VIEW_MOVED_EVENT = "ovis-view-moved";
/** told on a pane's host after libghostty drew a frame that changed rows: a view drawn from its rows (the fold) draws them again */
export const GHOSTTY_DREW_EVENT = "ovis-ghostty-drew";
/** told on a terminal's element when libghostty's own view (only: xterm keeps no rows) moves off or back to the bottom */
export const GHOSTTY_VIEW_EVENT = "ovis-ghostty-view";
const views = new WeakMap<object, () => number>();
/** the overlay (only) owns the view of a terminal: rows it shows above the bottom, read by the viewport tools */
export function ownView(term: object, rowsAbove: (() => number) | null): void {
  if (rowsAbove) views.set(term, rowsAbove);
  else views.delete(term);
}
/** rows libghostty's view of this terminal sits above the bottom, or null when xterm's viewport is the view */
export function ghosttyRowsAbove(term: object): number | null {
  return views.get(term)?.() ?? null;
}
