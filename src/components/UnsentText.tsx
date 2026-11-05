/**
 * Recover unsent text (a pane's menu, only while there is some): the text panes of an earlier herdr
 * left behind when herdr was replaced and gave their pane IDs out again (lib/paneLifetime.ts). Each
 * one says its PC, pane and kind, and is plain text: Put in message box adds it to the message box
 * of the pane the list was opened from, Copy puts it on the clipboard, Discard removes it. Nothing
 * here is ever sent. Slack's Drafts list is the model: unsent text kept apart, opened by the user.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import "./UnsentText.css";

import type { Machine } from "../../shared/machines.ts";
import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import { paneLifetimes, type UnsentText } from "../lib/paneLifetime.ts";
import { useSettings } from "../lib/settings.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";

interface Props {
  machines: readonly Machine[];
  /** the pane has a message box (an agent's): Put in message box is offered */
  canRecover: boolean;
  /** false: the box took the text but could not save it, so the record stays here too */
  onRecover: (text: string, agentOnly: boolean) => boolean;
  onClose: () => void;
}

export function UnsentTextDialog({ machines, canRecover, onRecover, onClose }: Props) {
  const t = useT();
  const { resolvedLanguage } = useSettings();
  const closeButton = useRef<HTMLButtonElement>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: closeButton });
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => { onClose(); });
  const items = useSyncExternalStore(paneLifetimes.subscribe, paneLifetimes.unsent);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  // the last one recovered or discarded (here or in another tab): nothing is left to show
  useEffect(() => { if (items.length === 0) onClose(); }, [items.length, onClose]);

  const pcName = (item: UnsentText): string => machines.find((machine) => machine.id === item.machine_id)?.name ?? item.machine_id;
  const when = (at: number): string => new Date(at).toLocaleString(resolvedLanguage, { dateStyle: "medium", timeStyle: "short" });

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal unsent-modal" role="dialog" aria-modal="true" aria-labelledby="unsent-title">
        <header className="modal-header"><h2 className="modal-title" id="unsent-title">{t("Unsent text")}</h2></header>
        <div className="modal-body">
          <p className="unsent-lead">{t("Text you had not sent when herdr restarted. A new herdr gives pane IDs out again, so it waits here rather than in a pane it was not written for. Nothing here is sent.")}</p>
          <ul className="unsent-list">
            {items.map((item) => (
              <li key={item.id} className="unsent-item">
                <p className="unsent-meta">
                  <span>{pcName(item)}</span>
                  <span>{item.pane_title ?? item.pane_id}</span>
                  <span>{item.kind === "message" ? t("Message box") : item.kind === "line" ? t("Terminal line") : item.kind === "held" ? t("Held input") : t("Held message")}</span>
                  <time dateTime={new Date(item.at).toISOString()}>{when(item.at)}</time>
                </p>
                <pre className="unsent-text">{item.text}</pre>
                <div className="unsent-actions">
                  {canRecover && (
                    <button type="button" className="btn btn-primary" title={t("Adds the text to this pane's message box. Nothing is sent.")}
                      onClick={() => { if (onRecover(item.text, item.agent_only === true)) paneLifetimes.discard(item.id); onClose(); }}>{t("Put in message box")}</button>
                  )}
                  <button type="button" className="btn" onClick={() => {
                    void copyText(item.text).then((done) => { if (done) setCopied(item.id); });
                  }}>{copied === item.id ? t("Copied") : t("Copy")}</button>
                  <button type="button" className="btn btn-ghost" onClick={() => paneLifetimes.discard(item.id)}>{t("Discard")}</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <footer className="modal-footer"><button ref={closeButton} type="button" className="btn" onClick={onClose}>{t("Close")}</button></footer>
      </div>
    </div>,
    document.body,
  );
}
