import { useCallback, useEffect, useRef, useState } from "react";

import { openPresentation, type FilePresentation } from "./filePresentation.ts";
import { backUnderCurrentEntry } from "./historyNavigation.ts";
import { useFocusReturn } from "./useFocusTrap.ts";
import { useFileViewer } from "./useFileViewer.ts";
import { useRepoDiffViewer } from "./useRepoDiffViewer.ts";
import { useWebPanel } from "./useWebPanel.ts";
import type { Settings } from "./settings.ts";

export interface FilePanelsParams {
  settings: Settings;
  filePanelAvailable: boolean;
  selectedPaneId: string | null;
  selectedMachineId: string;
}

export function useFilePanels({ settings, filePanelAvailable, selectedPaneId, selectedMachineId }: FilePanelsParams) {
  // the Files dialog, and the file open in the viewer (a path as the chat or the dialog gave it)
  const [filesOpen, setFilesOpen] = useState(false);
  const { viewing, openFile: openPreview, closeFile, setPresentation, releaseFile } = useFileViewer();
  // a repository diff from the Files dialog's Changes tab, an entry of its own like a file
  const { viewing: diffViewing, openDiff, closeDiff, releaseDiff } = useRepoDiffViewer();
  const presentation = viewing?.presentation ?? openPresentation(viewing?.path ?? "", settings.fileOpen);
  const fileDocked = filePanelAvailable && presentation === "panel";
  useEffect(() => {
    if (viewing !== null && fileDocked) setFilesOpen(false);
  }, [viewing, fileDocked]);
  // a same-host web page shares the docked file's place on wide windows and opens as a popup on narrow ones.
  // Either replacing the other takes over its history entry in place: no push over it, no Back to wait on.
  const { webPage, openWebPage: openWebPanel, closeWebPage, yieldEntry, holdsEntry } = useWebPanel({ settings, filePanelAvailable });
  const openWebPage = useCallback((uri: string, shiftKey: boolean, machineId: string) =>
    openWebPanel(uri, shiftKey, machineId, viewing !== null && fileDocked ? releaseFile : undefined),
  [openWebPanel, viewing, fileDocked, releaseFile]);
  const openFile = useCallback((preview: Parameters<typeof openPreview>[0], replace = false) => {
    const docks = filePanelAvailable && (preview.presentation ?? openPresentation(preview.path, settings.fileOpen)) === "panel";
    openPreview(preview, (docks && webPage !== null && yieldEntry()) || replace);
  }, [openPreview, filePanelAvailable, settings.fileOpen, webPage, yieldEntry]);
  useEffect(() => {
    if (viewing !== null && fileDocked && webPage !== null) closeWebPage(true);
  }, [viewing, fileDocked, webPage, closeWebPage]);
  // the panel is no dialog, so no trap gives the focus back when it closes: what opened the file
  // (a link in the chat, a row of Files) gets it, as it does from the popup
  useFocusReturn(viewing !== null && fileDocked);
  // a collapse (below) whose two steps back have not landed: a second click on Show beside the
  // pane, or the kind correction in the same moment, must not queue two steps more and the file twice
  const collapsing = useRef(false);
  // a collapse whose step back never lands must not lock the toggle once the file and diff are gone
  useEffect(() => { if (viewing === null && diffViewing === null) collapsing.current = false; }, [viewing, diffViewing]);
  const presentFile = useCallback((next: FilePresentation) => {
    if (collapsing.current) return;
    if (next === "panel" && filePanelAvailable && diffViewing !== null && viewing !== null) {
      // Collapse the stacked diff and popup to one panel entry. Pushing from their opener
      // also discards the old forward entries, so Forward cannot resurrect the popup or diff.
      const preview = { ...viewing, presentation: next };
      collapsing.current = true;
      window.addEventListener("popstate", () => {
        collapsing.current = false;
        releaseDiff();
        openFile(preview);
      }, { once: true });
      window.history.go(-2);
    } else if (next === "panel" && filePanelAvailable && viewing !== null && webPage !== null && holdsEntry()) {
      // A popup file over the report's entry docks in the report's place: like the collapse above,
      // step back past both entries (the Back closes the report) and push the docked file from their
      // opener, so the two panels leave one entry and Forward cannot bring the popup back.
      const preview = { ...viewing, presentation: next };
      collapsing.current = true;
      const land = (): void => {
        collapsing.current = false;
        openFile(preview);
      };
      window.addEventListener("popstate", land, { once: true });
      // a step back the browser refuses lands nowhere: the file stays a popup and the toggle is free again
      backUnderCurrentEntry(2)?.catch(() => { window.removeEventListener("popstate", land); collapsing.current = false; });
    } else setPresentation(next);
  }, [filePanelAvailable, diffViewing, viewing, releaseDiff, openFile, setPresentation, webPage, holdsEntry]);
  // A diff's file docking in the place of a docked report that holds the entry under the diff: like the
  // popup collapse above, step back past the diff and the report's entry and push the file from their
  // opener, so Back closes the file and then leaves, as when the report held no entry.
  const openDiffFile = useCallback(async (preview: Parameters<typeof openPreview>[0]) => {
    const docks = filePanelAvailable && openPresentation(preview.path, settings.fileOpen) === "panel";
    if (!docks || webPage === null || !holdsEntry()) return false;
    if (collapsing.current) return true;
    collapsing.current = true;
    const land = (): void => {
      collapsing.current = false;
      openFile(preview);
    };
    window.addEventListener("popstate", land, { once: true });
    try {
      await backUnderCurrentEntry(2);
    } catch (error) {
      window.removeEventListener("popstate", land);
      collapsing.current = false;
      throw error;
    }
    return true;
  }, [filePanelAvailable, settings.fileOpen, webPage, holdsEntry, openFile]);
  // the kind corrects a guess from the extension; with files set to open in the popup there is no guess to correct
  const reportFileKind = useCallback((kind: FilePresentation) => {
    const wanted = settings.fileOpen === "panel" ? kind : "popup";
    if (viewing !== null && viewing.presentation === undefined && wanted !== openPresentation(viewing.path, settings.fileOpen)) presentFile(wanted);
  }, [viewing, presentFile, settings.fileOpen]);
  const toggleFilePresentation = filePanelAvailable && viewing !== null
    ? () => presentFile(fileDocked ? "popup" : "panel")
    : undefined;
  const viewFile = useCallback((path: string) => {
    // the Files dialog would cover the docked panel the file opens in
    if (filePanelAvailable && openPresentation(path, settings.fileOpen) === "panel") setFilesOpen(false);
    openFile({ path, paneId: selectedPaneId, machineId: selectedMachineId });
  }, [openFile, selectedPaneId, selectedMachineId, filePanelAvailable, settings.fileOpen]);
  return { filesOpen, setFilesOpen, viewing, openFile, closeFile, setPresentation, releaseFile, diffViewing, openDiff, closeDiff, releaseDiff, presentation, fileDocked, webPage, closeWebPage, openWebPage, collapsing, presentFile, openDiffFile, reportFileKind, toggleFilePresentation, viewFile };
}
