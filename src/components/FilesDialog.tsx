import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { FolderSearch, X } from "lucide-react";

import "./FilesDialog.css";
import { DirectoryBrowser } from "./DirectoryBrowser.tsx";
import { MarkdownDocuments } from "./MarkdownDocuments.tsx";
import { PullRequestPanel } from "./PullRequestPanel.tsx";
import { RepoChanges } from "./RepoChanges.tsx";
import type { RepoDiffFile } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { subscribeFilesFolder } from "../lib/paletteFolders.ts";
import type { RepoComparison } from "../lib/repoDiff.ts";
import { focusInOtherModal, nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";

export interface FilesDialogProps {
  /** the folder to open at: the pane's own */
  start: string;
  /** the pane whose repository's changes are listed */
  paneId: string;
  /** a file or a diff is open above this dialog: Escape belongs to it, which closes first */
  viewing: boolean;
  onOpenFile: (path: string) => void;
  onOpenDiff: (comparison: RepoComparison, file: RepoDiffFile) => void;
  /** the command palette, already browsing this folder (it opens above this dialog) */
  onBrowseFolders: (path: string) => void;
  onClose: () => void;
  /** beside the pane on a wide window (Settings → Files beside the pane), not a dialog over it */
  docked?: boolean;
  /** drawn first in the docked column (its resize edge) */
  panelStart?: ReactNode;
  /** docked, with a file or web page in its place: kept, folder and tab, for when that closes */
  covered?: boolean;
  /** the PC's name where it says which PC (another PC, or this one among several): Pull request names it */
  machineName?: string;
}

type Tab = "browse" | "changes" | "pr" | "docs";

/** The files of the pane's folder (and any other), each opened in the file viewer, and the changes of its repository, each opened as a diff. */
export function FilesDialog({ start, paneId, viewing, onOpenFile, onOpenDiff, onBrowseFolders, onClose, docked = false, panelStart, covered = false, machineName }: FilesDialogProps) {
  const t = useT();
  const machineId = useMachineId();
  const phone = useMediaQuery("(max-width: 480px)");
  // docked beside the pane, the rest of the page stays reachable: no trap, swipe or Back entry
  const surface = useFocusTrap<HTMLElement>(!docked);
  const [chosenTab, setTab] = useState<Tab>("browse");
  const tab: Tab = chosenTab;
  // the changes are read with the first visit and kept, as the browser keeps its folder
  const [changesVisited, setChangesVisited] = useState(false);
  const [prVisited, setPrVisited] = useState(false);
  const [docsVisited, setDocsVisited] = useState(false);
  useSheetSwipe(surface, docked ? null : onClose);
  // a file opened from the list is drawn over it with an entry of its own: Back closes the file first
  usePhoneSheetBack(onClose, !viewing && !docked);
  // the listener stays put across renders: an earlier listener of the same key that re-renders the app (the split
  // guide Escape puts away) would otherwise swap it out mid-dispatch, and a listener removed then never runs (#2631)
  const onKey = useEffectEvent((event: KeyboardEvent): void => {
    // one Escape closes one dialog, the one with the keyboard: Settings opened with Files open holds the focus
    // (it closes first), and Settings under Files may have taken this Escape already
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (focusInOtherModal(surface.current)) return;
    // docked, the pane beside it is live: Escape there is the terminal's, so only one inside the panel closes it
    if (docked && !surface.current?.contains(document.activeElement)) return;
    // a native modal over it (Add PC, from the palette) takes its own Escape
    if (nativeModalOver(surface.current)) return;
    event.preventDefault();
    onClose();
  });
  useEffect(() => {
    if (viewing) return;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing]);
  // the palette's Open in Files names a folder for the browser: kept beside the pane on another tab, it shows Browse
  useEffect(() => subscribeFilesFolder(() => setTab("browse")), []);
  const show = (next: Tab): void => {
    setTab(next);
    if (next === "changes") setChangesVisited(true);
    if (next === "pr") setPrVisited(true);
    if (next === "docs") setDocsVisited(true);
  };
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ browse: null, changes: null, pr: null, docs: null });
  const tabs: readonly { id: Tab; label: string }[] = [
    { id: "browse", label: t("Browse") },
    { id: "changes", label: t("Changes") },
    { id: "pr", label: t("Pull request") },
    { id: "docs", label: t("Documents") },
  ];
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    // Alt+Left and the like are the browser's (Back); only the bare keys move between the tabs
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const count = tabs.length;
    const nextIndex = event.key === "ArrowRight" ? (index + 1) % count
      : event.key === "ArrowLeft" ? (index - 1 + count) % count
      : event.key === "Home" ? 0
      : event.key === "End" ? count - 1
      : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = tabs[nextIndex]!.id;
    show(next);
    tabRefs.current[next]?.focus();
  };
  // the folder the browser shows now (it tells each one it opens), for the pane it showed it for;
  // else the one the dialog opened at
  const folder = useRef<{ pane: string; path: string } | null>(null);
  const browseFolders = (): void => onBrowseFolders(folder.current?.pane === paneId ? folder.current.path : (start || "~"));
  const content = <>
    <header className="modal-header">
      <h2 className="modal-title" id="files-dialog-title">{t("Files")}</h2>
      <div className="segmented files-dialog-tabs" role="group" aria-label={t("Show")}>
        {tabs.map((item, index) => {
          const selected = tab === item.id;
          // a panel not visited yet is not in the page: only a mounted one is named as controlled
          const mounted = item.id === "browse" || (item.id === "changes" ? changesVisited : item.id === "pr" ? prVisited : docsVisited);
          return (
            <button
              key={item.id}
              ref={(node) => { tabRefs.current[item.id] = node; }}
              id={`files-dialog-tab-${item.id}`}
              type="button"
              aria-pressed={selected}
              aria-controls={mounted ? `files-dialog-panel-${item.id}` : undefined}
              onClick={() => show(item.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              <span className="files-dialog-tab-label">{item.label}</span>
            </button>
          );
        })}
      </div>
      {!phone && <button type="button" className="icon-button" aria-label={t("Browse folders in the palette")} title={t("Browse folders in the palette")} onClick={browseFolders}><FolderSearch aria-hidden="true" /></button>}
      <button type="button" className="icon-button" aria-label={t("Close files")} title={t("Close files")} onClick={onClose}><X aria-hidden="true" /></button>
    </header>
    <div className="modal-body">
      {/* the dialog stays open across a pane switch (Next pane): the browser starts over on the new
          pane's folder, as Changes reads the new pane, instead of listing the pane it was opened on */}
      <div id="files-dialog-panel-browse" className="files-dialog-panel" role="region" aria-labelledby="files-dialog-tab-browse" hidden={tab !== "browse"}><DirectoryBrowser key={`${machineId}:${paneId}`} start={start} onOpenFile={onOpenFile} onFolder={(path) => { folder.current = { pane: paneId, path }; }} /></div>
      {/* not keyed by PC and pane: Changes keeps its scope (Branch) across a switch and itself drops answers for the target left behind */}
      {changesVisited && <div id="files-dialog-panel-changes" className="files-dialog-panel" role="region" aria-labelledby="files-dialog-tab-changes" hidden={tab !== "changes"}><RepoChanges paneId={paneId} directory={start} onOpenDiff={onOpenDiff} /></div>}
      {/* one panel per PC and pane: an answer or a merge still on its way for the last pane never lands in this one */}
      {prVisited && <div id="files-dialog-panel-pr" className="files-dialog-panel" role="region" aria-labelledby="files-dialog-tab-pr" hidden={tab !== "pr"}><PullRequestPanel key={`${machineId}:${paneId}`} paneId={paneId} directory={start} machineName={machineName} /></div>}
      {/* one list per PC and pane, as the browser: a pane switch reads the new pane's folder */}
      {docsVisited && <div id="files-dialog-panel-docs" className="files-dialog-panel" role="region" aria-labelledby="files-dialog-tab-docs" hidden={tab !== "docs"}><MarkdownDocuments key={`${machineId}:${paneId}`} paneId={paneId} onOpenFile={onOpenFile} /></div>}
    </div>
  </>;
  if (docked) return (
    <aside ref={surface} className="file-panel files-panel" aria-labelledby="files-dialog-title" tabIndex={-1} hidden={covered}>
      {panelStart}
      <section className="files-dialog files-dialog-docked">{content}</section>
    </aside>
  );
  return (
    <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={surface} className="modal files-dialog" role="dialog" aria-modal="true" aria-labelledby="files-dialog-title" tabIndex={-1}>
        {content}
      </section>
    </div>
  );
}
