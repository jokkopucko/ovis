import type { CSSProperties } from "react";
import { useT } from "../lib/i18n.ts";
import type { DropZone, SplitRect } from "../lib/split.ts";
import "./SplitDropPreview.css";

/** a rectangle of the area, drawn in a little from its edges */
const place = (rect: SplitRect): CSSProperties => ({
  left: `calc(${rect.x * 100}% + var(--space-1))`, top: `calc(${rect.y * 100}% + var(--space-1))`,
  width: `calc(${rect.w * 100}% - 2 * var(--space-1))`, height: `calc(${rect.h * 100}% - 2 * var(--space-1))`,
});

export interface GridPreview {
  zone: DropZone | null;
  /** every slot's rectangle, outlined so the places a pane can go read at a glance */
  slots: SplitRect[];
  /** the place the dropped pane would take */
  target: SplitRect | null;
}

/**
 * A guide over the pane area; it never takes a drag, focus or space from the terminals: every slot
 * outlined, and one highlight on the slot's edge or middle the pane would take.
 */
export function SplitDropPreview({ visible, grid }: { visible: boolean; grid: GridPreview }) {
  const t = useT();
  const zone = grid.zone;
  const label = !zone ? null : zone.edge === "left" ? t("Drop on the left") : zone.edge === "right" ? t("Drop on the right")
    : zone.edge === "top" ? t("Drop above") : zone.edge === "bottom" ? t("Drop below") : t("Open here");
  return <div className={`split-drop${visible ? " is-visible" : ""}`} data-edge={zone ? zone.edge ?? "middle" : undefined} aria-hidden="true">
    {grid.slots.map((rect) => <div key={`${rect.x}:${rect.y}`} className="split-drop-slot" style={place(rect)} />)}
    <div className="split-drop-zone" style={grid.target ? place(grid.target) : undefined}>
      {label && <span className="split-drop-label">{label}</span>}
    </div>
  </div>;
}
