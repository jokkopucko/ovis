/**
 * A chat picture over the whole screen, fitted to it, the message's other pictures a step away.
 * The wheel or a pinch zooms at the pointer, a drag pans, a double-click toggles fit and the
 * picture's own pixels, and the bar and the keys (+ - 0, arrows) do the same; at fit, Left and
 * Right step through the gallery. Copy puts the picture on the clipboard as PNG and Download
 * saves it under its name. Escape, the close button, a phone's Back and a swipe down that starts
 * on the bar or the caption leave (the stage takes every stroke for panning), and the focus
 * returns to the thumbnail that opened it while it is still drawn. ChatView holds the viewer, not
 * the chat row, so a row scrolled out of the render window does not close it. The zoom arithmetic
 * is MermaidLightbox's.
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronLeft, ChevronRight, Copy, Download, ImageOff, Minus, Plus, Scan, X } from "lucide-react";

import "./ImageLightbox.css";

import { canCopyImage, copyImage } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import { actualSizeFactor, arrowAction, wrapIndex, zoomPercent, type GalleryImage } from "../lib/imageViewer.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useResourceUrl } from "../lib/useResourceUrl.ts";
import { getTransport } from "../lib/transport.ts";
import { FIT, MAX_ZOOM, MIN_ZOOM, PAN_STEP, STEP, zoomAt, type View } from "./MermaidLightbox.tsx";

export function ImageLightbox({ images, index, onClose }: { images: GalleryImage[]; index: number; onClose: () => void }) {
  const t = useT();
  const close = useRef<HTMLButtonElement>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: close });
  usePhoneSheetBack(onClose);
  useSheetSwipe(surface, onClose);
  const stage = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const [current, setCurrent] = useState(() => wrapIndex(index, images.length));
  const [view, setView] = useState<View>(FIT);
  const latest = useRef(view);
  latest.current = view;
  // the fitted picture's size over its natural size, so the bar says the zoom in its own pixels
  const [fit, setFit] = useState(1);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const [dragging, setDragging] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const count = images.length;
  const image = images[current];
  const src = useResourceUrl(image?.src ?? null);
  const download = useResourceUrl(image?.src.startsWith("/api/") && getTransport().kind === "relay"
    ? `${image.src}${image.src.includes("?") ? "&" : "?"}download=1` : image?.src ?? null);
  const many = count > 1;
  const copyable = canCopyImage();

  const measure = (): void => {
    const node = picture.current;
    if (node && node.naturalWidth > 0 && node.offsetWidth > 0) setFit(node.offsetWidth / node.naturalWidth);
  };
  useEffect(() => {
    const node = stage.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const center = (): { x: number; y: number } => {
    const box = stage.current?.getBoundingClientRect();
    return { x: (box?.width ?? 0) / 2, y: (box?.height ?? 0) / 2 };
  };
  const zoomBy = (factor: number): void => { const c = center(); setView((v) => zoomAt(v, factor, c.x, c.y)); };
  const step = (by: -1 | 1): void => {
    setCurrent((at) => wrapIndex(at + by, count));
    setView(FIT);
    setFit(1);
    setCopied(null);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const node = surface.current;
      if (!node || nativeModalOver(node)) return;
      // a dialog opened over this one by its shortcut (Settings) has the keys; the focus may
      // also rest on the body (Safari after a click on the stage), which is still ours
      const dialog = event.target instanceof Element ? event.target.closest('[aria-modal="true"]') : null;
      if (dialog !== null && dialog !== node) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      switch (event.key) {
        case "Escape": onClose(); break;
        case "+": case "=": zoomBy(STEP); break;
        case "-": case "_": zoomBy(1 / STEP); break;
        case "0": setView(FIT); break;
        default: {
          const action = arrowAction(event.key, latest.current.scale > 1, count, PAN_STEP);
          if (action === null) return;
          if (action.kind === "pan") setView((v) => ({ ...v, x: v.x + action.dx, y: v.y + action.dy }));
          else step(action.by);
        }
      }
      event.stopPropagation();
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, count]);

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
  const toggle = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    setView((v) => v.scale === 1 && v.x === 0 && v.y === 0 ? zoomAt(v, actualSizeFactor(fit), event.clientX - box.left, event.clientY - box.top) : FIT);
  };

  const copy = async (): Promise<void> => {
    const node = picture.current;
    if (!node) return;
    const ok = await copyImage(node);
    setCopied(ok ? "done" : "failed");
    if (ok) window.setTimeout(() => setCopied((state) => state === "done" ? null : state), 1500);
  };

  if (image === undefined) return null;
  const unavailable = failed === image.src;
  return createPortal(
    <div className="modal-scrim image-lightbox-scrim">
      <div ref={surface} className="image-lightbox" role="dialog" aria-modal="true" aria-label={t("Image viewer")} tabIndex={-1}>
        <div className="image-lightbox-bar">
          <button type="button" className="icon-button" onClick={() => zoomBy(1 / STEP)} disabled={view.scale <= MIN_ZOOM} aria-label={t("Zoom out")} title={t("Zoom out")}><Minus aria-hidden="true" /></button>
          <span className="image-lightbox-zoom" aria-live="off">{zoomPercent(view.scale, fit)}%</span>
          <button type="button" className="icon-button" onClick={() => zoomBy(STEP)} disabled={view.scale >= MAX_ZOOM} aria-label={t("Zoom in")} title={t("Zoom in")}><Plus aria-hidden="true" /></button>
          <button type="button" className="icon-button" onClick={() => setView(FIT)} aria-label={t("Fit to screen")} title={t("Fit to screen")}><Scan aria-hidden="true" /></button>
          {copyable && <button type="button" className={`icon-button${copied === "done" ? " is-copied" : ""}`} onClick={() => void copy()} disabled={unavailable} aria-label={copied === "done" ? t("Copied") : t("Copy image")} title={copied === "done" ? t("Copied") : t("Copy image")}>
            {copied === "done" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </button>}
          <a className="icon-button" href={download ?? undefined} download={image.file} aria-label={t("Download")} title={t("Download")}><Download aria-hidden="true" /></a>
          <button ref={close} type="button" className="icon-button" onClick={onClose} aria-label={t("Close")} title={t("Close")}><X aria-hidden="true" /></button>
        </div>
        <div
          ref={stage}
          className={`image-lightbox-stage${dragging ? " is-dragging" : ""}`}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onDoubleClick={toggle}
        >
          <div className="image-lightbox-canvas" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
            {!unavailable && <img
              ref={picture}
              key={image.src}
              src={src ?? undefined}
              alt={image.name}
              draggable={false}
              onLoad={measure}
              onError={() => setFailed(image.src)}
            />}
          </div>
          {unavailable && <p className="image-lightbox-failed" role="alert"><ImageOff aria-hidden="true" /><span>{t("Image unavailable")}</span></p>}
        </div>
        <div className="image-lightbox-foot">
          <div className="image-lightbox-foot-row">
            {many && <button type="button" className="icon-button" onClick={() => step(-1)} aria-label={t("Previous image")} title={t("Previous image")}><ChevronLeft aria-hidden="true" /></button>}
            <p className="image-lightbox-caption" aria-live="polite">
              <span className="image-lightbox-name">{image.name}</span>
              {many && <span className="image-lightbox-count">{t("{n} of {count}", { n: current + 1, count })}</span>}
            </p>
            {many && <button type="button" className="icon-button" onClick={() => step(1)} aria-label={t("Next image")} title={t("Next image")}><ChevronRight aria-hidden="true" /></button>}
          </div>
          {copied === "failed" && <p className="image-lightbox-note" role="alert">{t("Couldn't copy the image. Download it instead.")}</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
