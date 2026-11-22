import type { PaneLayoutSnapshot } from "../../shared/protocol.ts";
type PaneLayoutSplit = PaneLayoutSnapshot["splits"][number];

export const SOLO_PANE_QUERY = "(max-width: 768px)";

export const CRAMPED_QUERY = "(max-width: 768px) and (max-height: 700px)";
export const tabRowHidden = (cramped: boolean, tabCount: number, inHeader: boolean): boolean => inHeader || (cramped && tabCount === 1);

/**
 * The pane a tab shows alone, or null when every pane is drawn: herdr's zoomed pane, else on a
 * narrow screen the selected pane (herdr's focused one, then the first, while the selection is
 * not in this tab). A narrow screen changes only what this browser draws, never herdr's zoom.
 */
export function soloPane(layout: PaneLayoutSnapshot | null, paneIds: readonly string[], selectedPaneId: string | null, narrow: boolean): string | null {
  if (layout?.zoomed) return layout.focused_pane_id;
  if (!narrow || paneIds.length < 2) return null;
  if (selectedPaneId !== null && paneIds.includes(selectedPaneId)) return selectedPaneId;
  return layout !== null && paneIds.includes(layout.focused_pane_id) ? layout.focused_pane_id : paneIds[0]!;
}

/** macOS Control-click opens a context menu even though its pointer button is the left one. */
export function paneContextPress(event: { button: number; ctrlKey: boolean }, apple: boolean): boolean {
  return event.button === 2 || (apple && event.button === 0 && event.ctrlKey);
}

/**
 * A right-click in a pane's own text field (the composer, the terminal's input line, the find or
 * secret field) is the browser's: its Copy, Paste and spelling menu on that field (#1180). xterm's
 * hidden textarea is the terminal's, so a right-click on the terminal stays the pane menu.
 */
export function paneFieldTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const field = target.closest("input, textarea, [contenteditable=true]");
  return field !== null && !field.classList.contains("xterm-helper-textarea");
}

/** herdr's stable split path, not its preorder number (which changes after another split). */
export function splitPath(id: string): boolean[] | null {
  const match = /^split_\d+_(root|[01]+)$/.exec(id);
  if (!match) return null;
  return match[1] === "root" ? [] : [...match[1]!].map((side) => side === "1");
}

export function layoutTopology(layout: PaneLayoutSnapshot): string {
  return JSON.stringify([layout.tab_id, layout.zoomed, layout.panes.map((pane) => pane.pane_id),
    layout.splits.map((split) => [split.id, split.direction])]);
}

export function splitRatioAt(split: PaneLayoutSplit, layout: PaneLayoutSnapshot,
  canvas: { left: number; top: number; width: number; height: number }, x: number, y: number): number {
  const horizontal = split.direction === "right";
  const point = horizontal ? layout.area.x + (x - canvas.left) / canvas.width * layout.area.width
    : layout.area.y + (y - canvas.top) / canvas.height * layout.area.height;
  const start = horizontal ? split.rect.x : split.rect.y;
  const extent = horizontal ? split.rect.width : split.rect.height;
  return Math.max(0.1, Math.min(0.9, (point - start) / Math.max(1, extent)));
}
