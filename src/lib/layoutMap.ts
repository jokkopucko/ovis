/**
 * Measured on herdr 0.9.3: `pane.resize` moves the pane's own border on the side it names
 * when the pane has a neighbour there, and otherwise the opposite border in that direction.
 * A left-hand pane therefore shrinks on `left`, a right-hand one grows on it, and a pane
 * between two others grows on either; such a pane is narrowed by resizing its neighbour.
 */
import type { PaneDirection, PaneLayoutRect, PaneLayoutSnapshot } from "../../shared/protocol.ts";

export interface LayoutCell {
  paneId: string;
  focused: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
}

export function layoutCells(layout: PaneLayoutSnapshot): LayoutCell[] {
  const { area } = layout;
  const width = Math.max(1, area.width);
  const height = Math.max(1, area.height);
  return layout.panes
    .map((pane) => ({
      paneId: pane.pane_id,
      focused: pane.focused,
      left: ((pane.rect.x - area.x) / width) * 100,
      top: ((pane.rect.y - area.y) / height) * 100,
      width: (pane.rect.width / width) * 100,
      height: (pane.rect.height / height) * 100,
    }))
    .sort((a, b) => a.top - b.top || a.left - b.left);
}

/** herdr zooms its focused pane. */
export function zoomedPaneId(layout: PaneLayoutSnapshot): string | null {
  return layout.zoomed ? layout.focused_pane_id : null;
}

/** `pane.zoom`'s explicit modes: the UI never sends its `toggle`. */
export type ZoomMode = "on" | "off";

/**
 * Never `toggle`: herdr focuses the pane and then flips the tab's flag, so a toggle on another
 * pane of a zoomed tab would unzoom the tab instead of showing that pane.
 */
export function zoomMode(layout: PaneLayoutSnapshot, paneId: string): ZoomMode {
  return zoomedPaneId(layout) === paneId ? "off" : "on";
}

export interface PaneNeighbors {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

/** herdr tiles the area in whole cells; a cell of slack covers a split rounded either way. */
const SLACK = 1;
const overlaps = (from: number, length: number, otherFrom: number, otherLength: number): boolean =>
  otherFrom < from + length - SLACK && from < otherFrom + otherLength - SLACK;

function touches(rect: PaneLayoutRect, other: PaneLayoutRect, side: PaneDirection): boolean {
  switch (side) {
    case "right": return Math.abs(other.x - (rect.x + rect.width)) <= SLACK && overlaps(rect.y, rect.height, other.y, other.height);
    case "left": return Math.abs(other.x + other.width - rect.x) <= SLACK && overlaps(rect.y, rect.height, other.y, other.height);
    case "down": return Math.abs(other.y - (rect.y + rect.height)) <= SLACK && overlaps(rect.x, rect.width, other.x, other.width);
    case "up": return Math.abs(other.y + other.height - rect.y) <= SLACK && overlaps(rect.x, rect.width, other.x, other.width);
  }
}

export function neighborPane(layout: PaneLayoutSnapshot, paneId: string, side: PaneDirection): string | null {
  const rect = layout.panes.find((pane) => pane.pane_id === paneId)?.rect;
  if (!rect) return null;
  return layout.panes.find((other) => other.pane_id !== paneId && touches(rect, other.rect, side))?.pane_id ?? null;
}

export function paneNeighbors(layout: PaneLayoutSnapshot, paneId: string): PaneNeighbors {
  return {
    left: neighborPane(layout, paneId, "left") !== null,
    right: neighborPane(layout, paneId, "right") !== null,
    up: neighborPane(layout, paneId, "up") !== null,
    down: neighborPane(layout, paneId, "down") !== null,
  };
}

export type ResizeIntent = "wider" | "narrower" | "taller" | "shorter";

export interface ResizeMove {
  paneId: string;
  direction: PaneDirection;
}

/**
 * How to make the pane wider, narrower, taller or shorter; null when it fills the tab on that
 * axis. Growing moves the pane's own border toward a neighbour. Shrinking a pane with one
 * neighbour on the axis moves the border away from it; a pane between two neighbours grows on
 * both of herdr's directions, so its neighbour is told to grow toward it instead.
 */
export function resizeMove(layout: PaneLayoutSnapshot, paneId: string, intent: ResizeIntent): ResizeMove | null {
  const [near, far]: [PaneDirection, PaneDirection] = intent === "wider" || intent === "narrower" ? ["right", "left"] : ["down", "up"];
  const onNear = neighborPane(layout, paneId, near);
  const onFar = neighborPane(layout, paneId, far);
  if (onNear === null && onFar === null) return null;
  const grow = intent === "wider" || intent === "taller";
  if (grow) return { paneId, direction: onNear !== null ? near : far };
  if (onNear === null) return { paneId, direction: near };
  if (onFar === null) return { paneId, direction: far };
  return { paneId: onNear, direction: far };
}
