import type { PaneCells, Regions } from "./geometry.ts";
import type { Part } from "./paint.ts";

/**
 * Placeholder chrome until the real one is drawn (sidebar, tab bar, borders, mode bar): each part fills its rectangle with a
 * mark and a colour of its own, so a test can tell the regions apart, and names its whole rectangle in the hit map.
 */
export function placeholderChrome(regions: Regions, panes: readonly PaneCells[]): Part[] {
  const filled = (key: string, rect: Part["rect"], mark: string, color: number): Part => ({
    key, rect, version: 0,
    draw: (canvas) => {
      canvas.fill(canvas.style({ fg: color }), mark);
      canvas.hit(rect, key);
    },
  });
  const borders = panes.filter(({ outer, inner }) => outer.width !== inner.width).map(({ pane, outer }): Part => ({
    key: `border ${pane}`, rect: outer, version: 0,
    draw: (canvas) => {
      const style = canvas.style({ fg: 8 });
      const right = outer.x + outer.width - 1;
      const bottom = outer.y + outer.height - 1;
      for (let col = outer.x; col <= right; col++) {
        canvas.put(col, outer.y, col === outer.x || col === right ? "+" : "-", 1, style);
        canvas.put(col, bottom, col === outer.x || col === right ? "+" : "-", 1, style);
      }
      for (let row = outer.y + 1; row < bottom; row++) {
        canvas.put(outer.x, row, "|", 1, style);
        canvas.put(right, row, "|", 1, style);
      }
    },
  }));
  return [
    filled("sidebar", regions.sidebar, ".", 4),
    filled("tabs", regions.tabBar, "-", 6),
    filled("mode", regions.modeBar, "=", 3),
    ...borders,
  ];
}
