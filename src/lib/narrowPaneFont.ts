/** The width full-screen programs expect at least (btop refuses to draw under it). */
export const NARROW_PANE_COLS = 80;

export function narrowPaneFontSize(base: number, _colsAt?: (size: number) => number | null): number {
  return base;
}
