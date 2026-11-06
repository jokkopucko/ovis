import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

import "./MarkdownDocuments.css";
import { FileGlyph } from "./FileGlyph.tsx";

import type { PaneDocuments } from "../../shared/files.ts";
import { ApiError } from "../lib/api.ts";
import { currentLocale, useT } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import { useMachineApi } from "../lib/machineContext.tsx";

export interface MarkdownDocumentsProps {
  paneId: string;
  /** opens the file clicked (its absolute path) in the file viewer, which renders Markdown */
  onOpenFile: (path: string) => void;
}

type Load = { status: "pending" } | { status: "done"; listing: PaneDocuments } | { status: "error"; message: string };

const folded = (text: string): string => text.normalize("NFC").toLowerCase();

/**
 * Files → Documents (#1196): the Markdown files under the pane's
 * folder, newest first, with a filter over their paths. Read only: a row opens the file viewer.
 * Read once when shown and again on Refresh; nothing polls.
 */
export function MarkdownDocuments({ paneId, onOpenFile }: MarkdownDocumentsProps) {
  const t = useT();
  const { fetchPaneDocuments } = useMachineApi();
  const [load, setLoad] = useState<Load>({ status: "pending" });
  const [query, setQuery] = useState("");
  const asking = useRef<AbortController | null>(null);

  const read = useCallback(() => {
    asking.current?.abort();
    const controller = new AbortController();
    asking.current = controller;
    setLoad({ status: "pending" });
    fetchPaneDocuments(paneId, controller.signal).then((listing) => {
      if (!controller.signal.aborted) setLoad({ status: "done", listing });
    }, (reason: unknown) => {
      if (controller.signal.aborted) return;
      // an older PC answers the route it does not know with its generic 404; a missing pane has its own code
      const old = reason instanceof ApiError && reason.status === 404 && reason.code === "not_found";
      setLoad({ status: "error", message: old ? t("This PC's bridge cannot list documents yet.") : t("Documents could not be loaded.") });
    });
  }, [fetchPaneDocuments, paneId, t]);
  useEffect(() => {
    read();
    return () => asking.current?.abort();
  }, [read]);

  const listing = load.status === "done" ? load.listing : null;
  const wanted = folded(query.trim());
  const documents = listing === null ? [] : wanted === "" ? listing.documents : listing.documents.filter((document) => folded(document.path).includes(wanted));
  const open = (path: string): void => {
    if (listing === null) return;
    onOpenFile(listing.root.endsWith("/") ? `${listing.root}${path}` : `${listing.root}/${path}`);
  };

  return (
    <div className="dir-browser md-docs" role="group" aria-label={t("Documents")} aria-busy={load.status === "pending"}>
      <div className="dir-browser-bar">
        <span className="dir-browser-path" title={listing?.root}><span dir="ltr">{listing?.root ?? ""}</span></span>
        <button type="button" className="icon-button" aria-label={t("Refresh documents")} title={t("Refresh documents")} disabled={load.status === "pending"} onClick={read}>
          <RefreshCw aria-hidden="true" />
        </button>
      </div>
      <div className="dir-browser-tools">
        <div className="dir-browser-filter">
          {/* a touch screen would raise its keyboard over the list just opened; Escape clears the
              filter before it reaches the dialog's own Escape, which closes the dialog */}
          <input type="search" className="input" aria-label={t("Filter documents")} placeholder={t("Filter documents")} value={query} autoFocus={window.matchMedia?.("(pointer: coarse)").matches !== true}
            autoComplete="off" spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Enter confirms an IME candidate; Escape dismisses it, not this dialog.
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
                event.stopPropagation();
                return;
              }
              if (event.key === "Escape" && query !== "") {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }
            }} />
        </div>
      </div>
      {load.status === "error" ? <p className="dir-browser-note dir-browser-error" role="alert">{load.message}</p> : (
        <ul className="dir-browser-list" aria-label={t("Markdown files")}>
          {load.status === "pending" && <li className="dir-browser-note" role="status">{t("Loading…")}</li>}
          {documents.map((document) => {
            const slash = document.path.lastIndexOf("/");
            const name = document.path.slice(slash + 1);
            return (
              <li key={document.path}>
                <button type="button" className="dir-browser-item is-file md-docs-item" title={document.path} onClick={() => open(document.path)}>
                  <FileGlyph name={name} />
                  <span className="md-docs-name">{name}</span>
                  {slash > 0 && <span className="md-docs-folder"><span dir="ltr">{document.path.slice(0, slash)}</span></span>}
                  <time className="md-docs-time" dateTime={document.modified} title={new Date(document.modified).toLocaleString(currentLocale())}>{lastSeen(document.modified)}</time>
                </button>
              </li>
            );
          })}
          {listing !== null && listing.documents.length === 0 && !listing.truncated && <li className="dir-browser-note">{t("No Markdown files in this folder")}</li>}
          {listing !== null && listing.documents.length > 0 && documents.length === 0 && <li className="dir-browser-note" role="status">{t("No matching documents")}</li>}
          {listing?.truncated && <li className="dir-browser-note">{t("Some Markdown files here are not listed.")}</li>}
        </ul>
      )}
    </div>
  );
}
