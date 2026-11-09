/**
 * Recover unsent text (a pane's menu, only while there is some): the text panes of an earlier herdr
 * left behind when herdr was replaced and gave their pane IDs out again (lib/paneLifetime.ts). Each
 * one says its PC, pane and kind, and is plain text: Put in message box adds it to the message box
 * of the pane the list was opened from, Copy puts it on the clipboard, Discard removes it: for the undo window
 * (lib/paneLifetime.ts) that button reads Undo in the same place and puts the record back, then the row is gone for
 * good. Nothing here is ever sent. Slack's Drafts list is the model: unsent text kept apart, opened by the user.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import "./UnsentText.css";

import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import { paneLifetimes, type UnsentText } from "../lib/paneLifetime.ts";
import { useSettings } from "../lib/settings.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { displayPaneTitle } from "./Sidebar.tsx";

interface Props {
  machines: readonly Machine[];
  /** the pane whose menu opened recovery, even when a different pane is selected */
  target: { machineId: string; pane: HerdrPane };
  /** the pane has a message box (an agent's): Put in message box is offered */
  canRecover: boolean;
  /** false: the box took the text but could not save it, so the record stays here too */
  onRecover: (text: string, agentOnly: boolean) => boolean;
  onClose: () => void;
}

export function UnsentTextDialog({ machines, target, canRecover, onRecover, onClose }: Props) {
  const t = useT();
  const { resolvedLanguage } = useSettings();
  const closeButton = useRef<HTMLButtonElement>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: closeButton });
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => { onClose(); });
  const items = useSyncExternalStore(paneLifetimes.subscribe, paneLifetimes.unsent);
  const undoable = useSyncExternalStore(paneLifetimes.subscribe, paneLifetimes.undoable);
  const [copied, setCopied] = useState<string | null>(null);
  const liveIds = new Set(items.map((item) => item.id));
  const pendingDiscards = undoable.filter((item) => !liveIds.has(item.id));
  const discardedIds = new Set(pendingDiscards.map((item) => item.id));
  const allItems = [...items, ...pendingDiscards].sort((a, b) => b.at - a.at);
  const firstActiveId = items[0]?.id ?? null;

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
  // the last one recovered or discarded (with no undoable item left in view): nothing is left to show
  useEffect(() => { if (items.length === 0 && pendingDiscards.length === 0) onClose(); }, [items.length, pendingDiscards.length, onClose]);

  const pcName = (item: UnsentText): string => machines.find((machine) => machine.id === item.machine_id)?.name ?? item.machine_id;
  const targetMachine = machines.find((machine) => machine.id === target.machineId);
  const targetWorkspace = targetMachine?.snapshot?.workspaces.find((workspace) => workspace.workspace_id === target.pane.workspace_id)?.label ?? target.pane.workspace_id;
  const destination = `${targetMachine?.name ?? target.machineId} · ${targetWorkspace} · ${displayPaneTitle(target.pane)}`;
  const dialogTitle = t("Unsent text · {destination}", { destination });
  const exactWhen = (at: number): string => new Date(at).toLocaleString(resolvedLanguage, { dateStyle: "medium", timeStyle: "short" });
  const relativeWhen = (at: number): string => {
    const diffSec = Math.round((at - Date.now()) / 1000);
    const absSec = Math.abs(diffSec);
    try {
      const rtf = new Intl.RelativeTimeFormat(resolvedLanguage, { numeric: "auto" });
      if (absSec < 60) return rtf.format(0, "minute");
      const diffMin = Math.round(diffSec / 60);
      if (Math.abs(diffMin) < 60) return rtf.format(diffMin, "minute");
      const diffHour = Math.round(diffMin / 60);
      if (Math.abs(diffHour) < 48) return rtf.format(diffHour, "hour");
      return rtf.format(Math.round(diffHour / 24), "day");
    } catch {
      return exactWhen(at);
    }
  };

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal unsent-modal" role="dialog" aria-modal="true" aria-labelledby="unsent-title">
        <header className="modal-header"><h2 className="modal-title" id="unsent-title" title={dialogTitle}>{dialogTitle}</h2></header>
        <div className="modal-body">
          <p className="unsent-lead">{canRecover ? t("Put in message box adds this text to {destination}. Nothing is sent.", { destination }) : t("Text you had not sent before herdr restarted. Copy it and paste it where you need it. Nothing here is sent.")}</p>
          <ul className="unsent-list">
            {allItems.map((item) => {
              const isDiscarded = discardedIds.has(item.id);
              const isPrimary = !isDiscarded && item.id === firstActiveId;
              return (
                <li key={item.id} className={`unsent-item${isDiscarded ? " is-discarded" : ""}`}>
                  <p className="unsent-meta">
                    <span>{pcName(item)}</span>
                    <span>{item.pane_title ?? item.pane_id}</span>
                    <span>{item.kind === "message" ? t("Message box") : item.kind === "line" ? t("Terminal line") : item.kind === "held" ? t("Held input") : t("Held message")}</span>
                    <time dateTime={new Date(item.at).toISOString()} title={exactWhen(item.at)}>{relativeWhen(item.at)}</time>
                  </p>
                  <pre className="unsent-text" data-kind={item.kind}>{item.text}</pre>
                  <div className="unsent-actions">
                    {canRecover && (
                      <button type="button" className={isPrimary ? "btn btn-primary" : "btn"} disabled={isDiscarded} title={t("Adds the text to this pane's message box. Nothing is sent.")}
                        onClick={() => { if (onRecover(item.text, item.agent_only === true)) paneLifetimes.discard(item.id, 0); onClose(); }}>{t("Put in message box")}</button>
                    )}
                    <button type="button" className="btn" disabled={isDiscarded} onClick={() => {
                      void copyText(item.text).then((done) => { if (done) setCopied(item.id); });
                    }}>{copied === item.id ? t("Copied") : t("Copy")}</button>
                    {isDiscarded ? (
                      <button type="button" className="btn unsent-undo" onClick={() => { paneLifetimes.restore(item.id); }}>{t("Undo")}</button>
                    ) : (
                      <button type="button" className="btn btn-ghost unsent-discard" onClick={() => { paneLifetimes.discard(item.id); }}>{t("Discard")}</button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        <footer className="modal-footer"><button ref={closeButton} type="button" className="btn" onClick={onClose}>{t("Close")}</button></footer>
      </div>
    </div>,
    document.body,
  );
}
