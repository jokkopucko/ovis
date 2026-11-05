import { useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink, Globe, RotateCw, X } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import "./FileViewer.css";

export interface WebPanelProps {
  url: string;
  onClose: () => void;
  docked?: boolean;
  panelStart?: ReactNode;
  covered?: boolean;
}

/**
 * A page served by this PC in the file panel's place. A narrow window presents it as a closable
 * popup. The frame is cross-origin (another port), so its scripts and storage are its own; the
 * sandbox still keeps it from navigating this window.
 */
export function WebPanel({ url, onClose, docked = true, panelStart, covered = false }: WebPanelProps) {
  const t = useT();
  const [loads, setLoads] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const surface = useFocusTrap<HTMLElement>(!docked, { initialFocus: body, paused: covered });
  useSheetSwipe(surface, docked || covered ? null : onClose);
  useEffect(() => {
    if (docked || covered) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || nativeModalOver(surface.current)) return;
      if ([...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some((dialog) => dialog !== surface.current && dialog.contains(document.activeElement))) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [docked, covered, onClose, surface]);
  const { host, pathname, search } = new URL(url);
  const label = `${host}${pathname === "/" ? "" : pathname}${search}`;
  const frame = <iframe key={`${url}#${loads}`} className="file-viewer-page web-panel-page" src={url} title={label}
    sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads" />;
  const actions = <div className="file-viewer-actions">
    <button type="button" className="icon-button file-viewer-action" aria-label={t("Reload page")} title={t("Reload page")} onClick={() => setLoads((count) => count + 1)}><RotateCw aria-hidden="true" /></button>
    <a className="icon-button file-viewer-action" href={url} target="_blank" rel="noopener noreferrer" aria-label={t("Open in a new tab")} title={t("Open in a new tab")}><ExternalLink aria-hidden="true" /></a>
  </div>;
  const close = <button type="button" className="icon-button file-viewer-action file-viewer-close" aria-label={t("Close page")} title={t("Close page")} onClick={onClose}><X aria-hidden="true" /></button>;
  return (
    <div className={docked ? "file-panel web-panel" : "modal-scrim file-viewer-scrim"} onMouseDown={(event) => { if (!docked && event.target === event.currentTarget) onClose(); }}>
      {docked ? panelStart : null}
      <section ref={surface} className={docked ? "file-viewer file-viewer-docked" : "modal file-viewer web-panel-popup"} role={docked ? undefined : "dialog"} aria-modal={docked ? undefined : true} aria-label={docked ? label : undefined} aria-labelledby={docked ? undefined : "web-panel-title"} tabIndex={-1}>
        <header className={docked ? "file-viewer-header file-viewer-header-docked" : "modal-header file-viewer-header file-viewer-header-stacked"}>
          {docked && <Globe aria-hidden="true" className="file-viewer-glyph" />}
          <div className={docked ? "file-viewer-name" : "file-viewer-title"}>
            <h2 className={docked ? undefined : "modal-title"} id="web-panel-title" title={url}><span className="file-viewer-stem">{label}</span></h2>
          </div>
          {actions}
          {close}
        </header>
        <div ref={body} className="file-viewer-body web-panel-body" tabIndex={-1}>{frame}</div>
      </section>
    </div>
  );
}
