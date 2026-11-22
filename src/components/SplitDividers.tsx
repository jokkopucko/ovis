import type { KeyboardEvent, PointerEvent, RefObject } from "react";
import { useT } from "../lib/i18n.ts";
import { SPLIT_RATIO_STEP, MIN_SPLIT_RATIO, type SplitDivider } from "../lib/split.ts";

export function SplitDividers({ dividers, areaRef, onResize }: {
  dividers: SplitDivider[];
  areaRef: RefObject<HTMLDivElement | null>;
  onResize: (path: string, ratio: number) => void;
}) {
  const t = useT();
  const ratioAt = (divider: SplitDivider, x: number, y: number): number | null => {
    const box = areaRef.current?.getBoundingClientRect();
    if (!box) return null;
    const { area } = divider;
    return divider.dir === "row"
      ? (x - box.left - area.x * box.width) / (area.w * box.width)
      : (y - box.top - area.y * box.height) / (area.h * box.height);
  };
  return <>{dividers.map((divider) => {
    const { area, dir, ratio, path } = divider;
    const style = dir === "row"
      ? { left: `${(area.x + area.w * ratio) * 100}%`, top: `${area.y * 100}%`, height: `${area.h * 100}%` }
      : { top: `${(area.y + area.h * ratio) * 100}%`, left: `${area.x * 100}%`, width: `${area.w * 100}%` };
    const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
    };
    const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const next = ratioAt(divider, event.clientX, event.clientY);
      if (next !== null) onResize(path, next);
    };
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
      const back = dir === "row" ? "ArrowLeft" : "ArrowUp";
      const forward = dir === "row" ? "ArrowRight" : "ArrowDown";
      if (event.key !== back && event.key !== forward) return;
      event.preventDefault();
      onResize(path, ratio + (event.key === forward ? SPLIT_RATIO_STEP : -SPLIT_RATIO_STEP));
    };
    return <div key={path} className="pane-split-divider" data-dir={dir} style={style}
      role="separator" tabIndex={0} aria-label={t("Resize the split")}
      aria-orientation={dir === "row" ? "vertical" : "horizontal"}
      aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)} aria-valuemax={Math.round((1 - MIN_SPLIT_RATIO) * 100)} aria-valuenow={Math.round(ratio * 100)}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onKeyDown={onKeyDown} />;
  })}</>;
}
