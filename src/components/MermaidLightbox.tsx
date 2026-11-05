/**
 * A diagram over the whole screen, fitted to it. The wheel or a pinch zooms at the pointer, a drag
 * pans, a double-click toggles fit and 2x, and the bar and the keys (+ - 0, arrows) do the same.
 * Escape and the close button leave.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, Scan, X } from "lucide-react";

import "./MermaidLightbox.css";

import { useT } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";

// the view model is shared with ImageLightbox, which zooms a chat picture the same way
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 16;
export const STEP = 1.25;
export const PAN_STEP = 80;

/** `scale` 1 is the diagram fitted to the stage; `x`/`y` move it in stage pixels. */
export interface View { scale: number; x: number; y: number }
export const FIT: View = { scale: 1, x: 0, y: 0 };

const clamp = (value: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

/** Zooms by `factor` keeping the stage point (px, py) still. */
export function zoomAt(view: View, factor: number, px: number, py: number): View {
  const scale = clamp(view.scale * factor);
  const k = scale / view.scale;
  return { scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
}

/** `svg` is markup drawn into the page (Mermaid's own sanitized output); `src` is a figure drawn as an image. */
export function MermaidLightbox({ svg, src, onClose }: ({ svg: string; src?: undefined } | { svg?: undefined; src: string }) & { onClose: () => void }) {
  const t = useT();
  const close = useRef<HTMLButtonElement>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: close });
  usePhoneSheetBack(onClose);
  const stage = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(FIT);
  const [dragging, setDragging] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  const center = (): { x: number; y: number } => {
    const box = stage.current?.getBoundingClientRect();
    return { x: (box?.width ?? 0) / 2, y: (box?.height ?? 0) / 2 };
  };
  const zoomBy = (factor: number): void => { const c = center(); setView((v) => zoomAt(v, factor, c.x, c.y)); };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (nativeModalOver(surface.current)) return;
      const pan = (dx: number, dy: number): void => setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      switch (event.key) {
        case "Escape": onClose(); break;
        case "+": case "=": zoomBy(STEP); break;
        case "-": case "_": zoomBy(1 / STEP); break;
        case "0": setView(FIT); break;
        case "ArrowLeft": pan(PAN_STEP, 0); break;
        case "ArrowRight": pan(-PAN_STEP, 0); break;
        case "ArrowUp": pan(0, PAN_STEP); break;
        case "ArrowDown": pan(0, -PAN_STEP); break;
        default: return;
      }
      event.stopPropagation();
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // React's onWheel is passive and could not stop the page behind from scrolling
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const box = node.getBoundingClientRect();
      // a trackpad pinch (ctrl) sends small deltas; a mouse wheel notch is a fixed step
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      setView((v) => zoomAt(v, factor, event.clientX - box.left, event.clientY - box.top));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  const down = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    setDragging(true);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const held = pointers.current;
    const before = held.get(event.pointerId);
    if (!before) return;
    const after = { x: event.clientX, y: event.clientY };
    const box = event.currentTarget.getBoundingClientRect();
    if (held.size === 2) {
      const other = [...held.entries()].find(([id]) => id !== event.pointerId)![1];
      const was = Math.hypot(before.x - other.x, before.y - other.y);
      const now = Math.hypot(after.x - other.x, after.y - other.y);
      // the pinch zooms about the midpoint and carries it along as it moves
      const mid = { x: (after.x + other.x) / 2 - box.left, y: (after.y + other.y) / 2 - box.top };
      const shift = { x: (after.x - before.x) / 2, y: (after.y - before.y) / 2 };
      if (was > 0) setView((v) => { const z = zoomAt(v, now / was, mid.x, mid.y); return { ...z, x: z.x + shift.x, y: z.y + shift.y }; });
    } else {
      setView((v) => ({ ...v, x: v.x + after.x - before.x, y: v.y + after.y - before.y }));
    }
    held.set(event.pointerId, after);
  };
  const up = (event: ReactPointerEvent<HTMLDivElement>): void => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) setDragging(false);
  };
  const toggle = (event: ReactPointerEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    setView((v) => v.scale === 1 && v.x === 0 && v.y === 0 ? zoomAt(v, 2, event.clientX - box.left, event.clientY - box.top) : FIT);
  };

  return createPortal(
    <div className="modal-scrim mermaid-lightbox-scrim">
      <div ref={surface} className="mermaid-lightbox" role="dialog" aria-modal="true" aria-label={t("Diagram")} tabIndex={-1}>
        <div className="mermaid-lightbox-bar">
          <button type="button" className="icon-button" onClick={() => zoomBy(1 / STEP)} disabled={view.scale <= MIN_ZOOM} aria-label={t("Zoom out")}><Minus aria-hidden="true" /></button>
          <span className="mermaid-lightbox-zoom" aria-live="off">{Math.round(view.scale * 100)}%</span>
          <button type="button" className="icon-button" onClick={() => zoomBy(STEP)} disabled={view.scale >= MAX_ZOOM} aria-label={t("Zoom in")}><Plus aria-hidden="true" /></button>
          <button type="button" className="icon-button" onClick={() => setView(FIT)} aria-label={t("Fit to screen")} title={t("Fit to screen")}><Scan aria-hidden="true" /></button>
          <button ref={close} type="button" className="icon-button" onClick={onClose} aria-label={t("Close")}><X aria-hidden="true" /></button>
        </div>
        <div
          ref={stage}
          className={`mermaid-lightbox-stage${dragging ? " is-dragging" : ""}`}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onDoubleClick={toggle}
        >
          {src === undefined ? (
            <div
              className="mermaid-lightbox-canvas"
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
              dangerouslySetInnerHTML={{ __html: svg ?? "" }}
            />
          ) : (
            <div className="mermaid-lightbox-canvas" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
              <img src={src} alt="" draggable={false} />
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
