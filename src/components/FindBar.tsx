import { useContext, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import type { PaneFindResponse } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import type { ViewportIntentGate } from "../lib/viewportIntent.ts";
import { findResultAfterError } from "../lib/paneFind.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { PaneShownContext } from "../lib/paneSubmitContext.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useT } from "../lib/i18n.ts";
import { userErrorMessage, type UserError } from "../lib/userError.ts";
import type { TerminalSearchState } from "./TerminalViewportTools.tsx";
import "./FindBar.css";

export function FindBar({ paneId, viewportIntent, disabled, focusRequest, activePane = true, onClose, onResult }: { paneId: string; viewportIntent: ViewportIntentGate; disabled: boolean; focusRequest: number; activePane?: boolean; onClose: () => void; onResult?: (state: TerminalSearchState | null) => void }) {
  const t = useT();
  const { findPane } = useMachineApi();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<PaneFindResponse | null>(null);
  const shown = useContext(PaneShownContext);
  usePhoneSheetBack(() => { onClose(); }, shown);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UserError | null>(null);
  useEffect(() => { onResult?.(result ? { query, result } : null); }, [query, result, onResult]);
  useEffect(() => () => onResult?.(null), [onResult]);
  const active = useRef(true);
  const disabledRef = useRef(disabled); disabledRef.current = disabled;
  const pending = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => { if (activePane && focusRequest > 0) input.current?.focus(); }, [focusRequest]);

  const search = async (direction: "forward" | "backward") => {
    if (!query || disabled || pending.current) return;
    input.current?.focus();
    pending.current = true;
    setBusy(true);
    setError(null);
    let releaseViewport: (() => void) | null = null;
    try {
      releaseViewport = await viewportIntent.beginSearch();
      // A pending scrollbar request may outlive this pane, the search bar or the connection.
      // Never turn its late completion into a search on a pane the user has already left.
      if (!releaseViewport || !active.current || disabledRef.current) return;
      const answer = await findPane({
        pane_id: paneId, query, direction,
        ...(result?.match ? { previous: result.match, content_revision: result.content_revision } : {}),
      });
      if (active.current) setResult(answer);
    } catch (cause) {
      if (active.current) {
        setResult((current) => findResultAfterError(current, cause));
        setError(cause instanceof ApiError && cause.code === "stale_content" ? { message: t("Pane changed. Search again."), detail: null } : userErrorMessage(cause));
      }
    } finally {
      releaseViewport?.();
      pending.current = false;
      if (active.current) setBusy(false);
    }
  };

  return (
    <form className="find-bar" role="search" aria-label={t("Find in terminal")} onSubmit={(event) => { event.preventDefault(); void search(result ? "forward" : "backward"); }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
          event.preventDefault(); event.stopPropagation(); onClose();
        }
      }}>
      <div className="find-bar-controls">
        <label className="find-bar-query">
          <Search size={16} aria-hidden="true" />
          <span className="visually-hidden">{t("Find in terminal")}</span>
          <input ref={input} className="input" type="search" value={query} maxLength={1024} placeholder={t("Find in terminal")} readOnly={busy} onChange={(event) => { setQuery(event.target.value); setResult(null); setError(null); }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === "Enter") { event.preventDefault(); void search(event.shiftKey || !result ? "backward" : "forward"); }
            }} />
        </label>
        <span className="find-bar-count" role="status">{busy ? t("Searching…") : result ? result.current === null ? t("No matches") : t("{current} of {total}", { current: result.current, total: result.total }) : ""}</span>
        <button className="icon-button" type="button" aria-label={t("Previous match")} title={t("Previous match")} disabled={disabled || busy || !query} onClick={() => void search("backward")}><ArrowUp size={16} aria-hidden="true" /></button>
        <button className="icon-button" type="button" aria-label={t("Next match")} title={t("Next match")} disabled={disabled || busy || !query} onClick={() => void search("forward")}><ArrowDown size={16} aria-hidden="true" /></button>
        <button className="icon-button" type="button" aria-label={t("Close search")} title={t("Close search")} onClick={onClose}><X size={16} aria-hidden="true" /></button>
      </div>
      {error ? <p className="find-bar-error" role="alert">{error.message}{error.detail !== null && <><br /><code>{error.detail}</code></>}</p> : <p className="find-bar-hint">{t("Search moves the pane for every client.")}</p>}
    </form>
  );
}
