import { useCallback, useEffect, useRef, useState } from "react";

import { openPresentation, type FilePresentation } from "./filePresentation.ts";
import { sheetStep } from "./historyKeys.ts";
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

type Preview = Parameters<ReturnType<typeof useFileViewer>["openFile"]>[0];
const LEFT_FILES_KEPT = 10;
const paneKey = (machineId: string, paneId: string): string => `${machineId}\n${paneId}`;

/**
 * The viewer's React key: a path is read from its pane's folder, so two panes' files of the same path
 * are two files, and a switch from one to the other must not keep the first one's loaded content.
 */
export const fileViewerKey = (preview: { machineId: string; paneId: string | null; path: string }): string =>
  `${preview.machineId}\n${preview.paneId ?? ""}\n${preview.path}`;

export function useFilePanels({ settings, filePanelAvailable, selectedPaneId, selectedMachineId }: FilePanelsParams) {
  const [filesOpen, setFilesOpen] = useState(false);
  const { viewing, openFile: openPreview, closeFile, setPresentation, releaseFile, hideFile, fileFromPop } = useFileViewer();
  const { viewing: diffViewing, openDiff, closeDiff, releaseDiff } = useRepoDiffViewer();
  const presentation = viewing?.presentation ?? openPresentation(viewing?.path ?? "", settings.fileOpen);
  const fileDocked = filePanelAvailable && presentation === "panel";
  const filesDocked = filePanelAvailable && settings.filesPanel;
  useEffect(() => {
    if (viewing !== null && fileDocked && !filesDocked) setFilesOpen(false);
  }, [viewing, fileDocked, filesDocked]);
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
  const filesCovered = (viewing !== null && fileDocked) || webPage !== null;
  const revealFiles = useCallback(() => {
    setFilesOpen(true);
    if (!filesDocked) return;
    if (viewing !== null && fileDocked) closeFile();
    else if (webPage !== null) closeWebPage();
  }, [filesDocked, viewing, fileDocked, closeFile, webPage, closeWebPage]);
  useFocusReturn(filesOpen && filesDocked);
  // Files closes with the dock it lived in when the window narrows: a dialog mounted then would come up
  // under a popup file or web page already open and take their focus and Escape
  const wasDocked = useRef(filesDocked);
  useEffect(() => {
    if (wasDocked.current && !filesDocked) setFilesOpen(false);
    wasDocked.current = filesDocked;
  }, [filesDocked]);
  useFocusReturn(viewing !== null && fileDocked);
  // a collapse (below) whose two steps back have not landed: a second click on Show beside the
  // pane, or the kind correction in the same moment, must not queue two steps more and the file twice
  const collapsing = useRef(false);
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
      window.history.go(-2 - (sheetStep.goingBack(window.history.state) ? 1 : 0));
    } else if (next === "panel" && filePanelAvailable && viewing !== null && webPage !== null && holdsEntry()) {
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
  const reportFileKind = useCallback((kind: FilePresentation) => {
    const wanted = settings.fileOpen === "panel" ? kind : "popup";
    if (viewing !== null && viewing.presentation === undefined && wanted !== openPresentation(viewing.path, settings.fileOpen)) presentFile(wanted);
  }, [viewing, presentFile, settings.fileOpen]);
  const leftFiles = useRef(new Map<string, Preview>());
  useEffect(() => {
    if (viewing?.paneId) leftFiles.current.delete(paneKey(viewing.machineId, viewing.paneId));
  }, [viewing]);
  const forgetLeftFiles = useCallback((paneLive: (machineId: string, paneId: string) => boolean) => {
    const left = leftFiles.current;
    for (const [key, file] of left) if (file.paneId !== null && !paneLive(file.machineId, file.paneId)) left.delete(key);
  }, []);
  const leaveFile = useCallback((paneLive: (machineId: string, paneId: string) => boolean = () => true, wasShown = true) => {
    if (!settings.reopenFileOnReturn || viewing?.paneId == null || !wasShown || !paneLive(viewing.machineId, viewing.paneId)) {
      releaseFile();
      return false;
    }
    const left = leftFiles.current;
    forgetLeftFiles(paneLive);
    const key = paneKey(viewing.machineId, viewing.paneId);
    // the oldest left beyond the cap is forgotten (a Map keeps insertion order)
    left.delete(key);
    left.set(key, viewing);
    for (const oldest of left.keys()) if (left.size > LEFT_FILES_KEPT) left.delete(oldest);
    hideFile();
    return true;
  }, [settings.reopenFileOnReturn, viewing, releaseFile, hideFile, forgetLeftFiles]);
  const restoreFile = useCallback((machineId: string, paneId: string) => {
    if (!settings.reopenFileOnReturn) return;
    const key = paneKey(machineId, paneId);
    const left = leftFiles.current.get(key);
    if (left === undefined) return;
    leftFiles.current.delete(key);
    openFile(left);
  }, [settings.reopenFileOnReturn, openFile]);
  const toggleFilePresentation = filePanelAvailable && viewing !== null
    ? () => presentFile(fileDocked ? "popup" : "panel")
    : undefined;
  const viewFile = useCallback((path: string) => {
    if (!filesDocked && filePanelAvailable && openPresentation(path, settings.fileOpen) === "panel") setFilesOpen(false);
    openFile({ path, paneId: selectedPaneId, machineId: selectedMachineId });
  }, [openFile, selectedPaneId, selectedMachineId, filePanelAvailable, settings.fileOpen, filesDocked]);
  return { filesOpen, setFilesOpen, filesDocked, filesCovered, revealFiles, viewing, openFile, closeFile, setPresentation, releaseFile, hideFile, leaveFile, restoreFile, fileFromPop, forgetLeftFiles, diffViewing, openDiff, closeDiff, releaseDiff, presentation, fileDocked, webPage, closeWebPage, openWebPage, collapsing, presentFile, openDiffFile, reportFileKind, toggleFilePresentation, viewFile };
}
