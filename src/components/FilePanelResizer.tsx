import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import "./FilePanelResizer.css";

import { clampFilePanelWidth, filePanelMaxWidth, FILE_PANEL_MIN_WIDTH, keyedFilePanelWidth, storeFilePanelWidth } from "../lib/filePanelWidth.ts";
import { useT } from "../lib/i18n.ts";

export interface FilePanelResizerProps {
  width: number | null;
  onResize(width: number | null): void;
}

export function FilePanelResizer({ width, onResize }: FilePanelResizerProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ right: number; grip: number; width: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [shown, setShown] = useState(width ?? FILE_PANEL_MIN_WIDTH);
  const [limit, setLimit] = useState(() => filePanelMaxWidth(window.innerWidth));
  const sidebarWidth = (): number => ref.current?.closest(".app-body")?.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0;
  const measure = (): number => {
    const measured = Math.floor(ref.current?.parentElement?.getBoundingClientRect().width ?? shown);
    if (measured > 0) setShown(measured);
    setLimit(filePanelMaxWidth(window.innerWidth, sidebarWidth()));
    return measured > 0 ? measured : shown;
  };
  useLayoutEffect(() => { measure(); }, [width]);
  useEffect(() => {
    const panel = ref.current?.parentElement;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { measure(); });
    observer.observe(panel);
    const sidebar = panel.parentElement?.querySelector(".sidebar");
    if (sidebar) observer.observe(sidebar);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const onWindowResize = (): void => { measure(); };
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const panel = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!panel) return;
    // no text selection in the file while the edge moves
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { right: panel.right, grip: event.clientX - panel.left, width: Math.round(panel.width), moved: false };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    if (!state) return;
    const next = clampFilePanelWidth(state.right - (event.clientX - state.grip), window.innerWidth, sidebarWidth());
    if (next === state.width) return;
    state.width = next;
    state.moved = true;
    onResize(next);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (state.moved) storeFilePanelWidth(state.width);
  };
  const reset = (): void => {
    storeFilePanelWidth(null);
    onResize(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = keyedFilePanelWidth(measure(), event.key, window.innerWidth, sidebarWidth());
    if (next === null) return;
    event.preventDefault();
    storeFilePanelWidth(next);
    onResize(next);
  };

  return (
    <div
      ref={ref}
      className={`file-panel-resizer${dragging ? " is-dragging" : ""}`}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t("Resize file panel")}
      aria-valuemin={Math.min(FILE_PANEL_MIN_WIDTH, limit)}
      aria-valuemax={limit}
      aria-valuenow={shown}
      title={t("Drag to resize · double-click to reset")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={reset}
      onFocus={measure}
      onKeyDown={onKeyDown}
    />
  );
}
