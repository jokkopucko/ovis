import { type Dispatch, type RefObject, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import type { HerdrPane, HerdrWorkspace } from "../../shared/protocol.ts";
import type { Machine } from "../../shared/machines.ts";
import type { PaneView } from "./actions.ts";
import { isNavigation, linkSearch, NAV_KEY, readLink, resolveLink, slugOf, type AppLink, type LinkNote } from "./deepLink.ts";
import { withoutFile } from "./historyKeys.ts";
import { pageAddress, pageSearch } from "./pageQuery.ts";
import type { SelectionMark } from "./selectionMark.ts";
import { settingsEntry, settingsSteppedOff } from "./settingsHistory.ts";
import { sheetSteppedOff } from "./sheetHistory.ts";
import type { useFilePanels } from "./useFilePanels.ts";
import type { useNewSessionState } from "./useNewSessionDialog.ts";
import type { usePaneLens } from "./usePaneLens.ts";
import type { useSettingsDialog } from "./useSettingsDialog.ts";

/**
 * Whether a Back or Forward is landing whose entry the address bar's handler has not read: `dispatching`
 * is the event the browser is dispatching (`window.event`, set for each listener and for what runs
 * between two of them, and cleared when the dispatch ends), `read` the popstate the handler last read.
 * It says no by itself once the dispatch is over, whether or not the handler ever heard the event.
 */
export function popUnread(dispatching: Event | undefined, read: Event | null): boolean {
  return dispatching !== undefined && dispatching.type === "popstate" && dispatching !== read;
}

/**
 * Keeps the address and the history in step with the selection (lib/deepLink.ts): a move between
 * panes is an entry, Back and Forward select the entry's pane, and a file open over a pane is left
 * behind, or kept for Back and shown again on return (#3179), when another pane is selected.
 */
export function useAddressBar({ newSessionOpen, selectedPane, selectedPaneId, selectedWorkspace, viewing, selectedMachineId, leaveFile, restoreFile, fileFromPop, forgetLeftFiles, locked, machines, snapshot, linkLanded, view, settingsOpen, settingsPage, settingsLinkPage, settingsLinkSection, wideScreen, sidebarCollapsed, newTab, newFields, autoSelected, pendingFile, selectedMachine, openFile, machinesRef, selectTargetRef, pendingLink, setLinkLanded, linkSince, rosterSeq, setNewSessionOpen, pendingCreate, setHeaderNote, selectionRef }: {
  newSessionOpen: boolean;
  selectedPane: HerdrPane | null;
  selectedPaneId: string | null;
  selectedWorkspace: HerdrWorkspace | null;
  viewing: ReturnType<typeof useFilePanels>["viewing"];
  selectedMachineId: string;
  leaveFile: ReturnType<typeof useFilePanels>["leaveFile"];
  restoreFile: ReturnType<typeof useFilePanels>["restoreFile"];
  fileFromPop: ReturnType<typeof useFilePanels>["fileFromPop"];
  forgetLeftFiles: ReturnType<typeof useFilePanels>["forgetLeftFiles"];
  locked: boolean | null;
  machines: Machine[];
  snapshot: Machine["snapshot"];
  linkLanded: boolean;
  view: ReturnType<typeof usePaneLens>["view"];
  settingsOpen: ReturnType<typeof useSettingsDialog>["settingsOpen"];
  settingsPage: ReturnType<typeof useSettingsDialog>["settingsPage"];
  settingsLinkPage: ReturnType<typeof useSettingsDialog>["settingsLinkPage"];
  settingsLinkSection: ReturnType<typeof useSettingsDialog>["settingsLinkSection"];
  wideScreen: boolean;
  sidebarCollapsed: boolean;
  newTab: ReturnType<typeof useNewSessionState>["newTab"];
  newFields: ReturnType<typeof useNewSessionState>["newFields"];
  autoSelected: boolean;
  pendingFile: RefObject<string | null>;
  selectedMachine: Machine | undefined;
  openFile: ReturnType<typeof useFilePanels>["openFile"];
  machinesRef: RefObject<Machine[]>;
  selectTargetRef: RefObject<(machineId: string, paneId: string | null, view?: PaneView) => void>;
  pendingLink: RefObject<AppLink | null>;
  setLinkLanded: Dispatch<SetStateAction<boolean>>;
  linkSince: RefObject<number>;
  rosterSeq: RefObject<number>;
  setNewSessionOpen: ReturnType<typeof useNewSessionState>["setNewSessionOpen"];
  pendingCreate: ReturnType<typeof useNewSessionState>["pendingCreate"];
  setHeaderNote: Dispatch<SetStateAction<LinkNote | "copied" | null>>;
  selectionRef: RefObject<SelectionMark>;
}): void {
  // The address follows the app (lib/deepLink.ts): opening another pane or PC is an entry of the
  // history, so Back returns to the last one; a lens, a Settings page or a pane the app picked
  // itself replace the entry. Nothing is written while locked or before the roster is in, so a
  // link survives the access gate and a slow first read.
  const writtenLink = useRef<AppLink | null>(null);
  // Back or Forward landed somewhere other than its entry said: that place is written over the entry
  const poppedTo = useRef(false);
  const newSessionOpenRef = useRef(newSessionOpen); newSessionOpenRef.current = newSessionOpen;
  const linkWorkspaceId = selectedPane?.workspace_id ?? (selectedPaneId === null ? null : undefined);
  const linkSlug = slugOf(selectedWorkspace?.label) || null;
  const linkFile = viewing && viewing.machineId === selectedMachineId && (viewing.paneId === null || viewing.paneId === selectedPaneId) ? viewing.path : null;
  // the file is its pane's (its paths are read from the pane's folder): another pane or PC
  // selected leaves it behind, and the move takes the file's entry over (below), so Back returns
  // to the pane the file was open on, without the file. With Reopen files on return (#3179) the file's
  // entry keeps it instead, the move is pushed over it, and Back shows the file again on its pane.
  const fileLeft = viewing !== null && linkFile === null;
  // A Back or Forward onto an entry that kept its file shows the file one render before the
  // entry's handler (below) selects its pane. While the entry's address names the file's own pane
  // and the selection has not moved since, the file is landing with its pane, not left behind:
  // neither it nor the address is touched until it lands. A pop the handler finds moves nothing (its
  // pane is already shown or closed, or Settings closed onto the entry) renders again and lands
  // nothing: its file is left behind at once, as any other.
  const shownSelection = useRef({ machineId: selectedMachineId, paneId: selectedPaneId });
  // set by the handler when the pop it handles selects a pane or PC
  const popMoving = useRef(false);
  // the last pop (lib/useFileViewer.ts numbers them) the handler found moves nothing
  const popStill = useRef(0);
  const [, setPopSettled] = useState(0);
  // The popstate the handler last read. Back and Forward land on an entry before any listener hears
  // of it, and React draws between two listeners: what an earlier one set (Settings closing, the file
  // viewer's file) and any update still waiting (a roster, the New workspace dialog's fields). The
  // place shown must not be written over that entry before the handler has read where it leads, so
  // the write is held back until then (heldWrite) and made right after (released).
  const readPop = useRef<Event | null>(null);
  const heldWrite = useRef(false);
  const [released, setReleased] = useState(0);
  const filePop = fileFromPop();
  const entryLink = fileLeft && filePop !== 0 && popStill.current !== filePop ? readLink(pageSearch()) : null;
  const fileLanding = entryLink !== null && viewing !== null && entryLink.machine === viewing.machineId && entryLink.pane === viewing.paneId &&
    shownSelection.current.machineId === selectedMachineId && shownSelection.current.paneId === selectedPaneId;
  const fileFromPopRef = useRef(fileFromPop); fileFromPopRef.current = fileFromPop;
  const fileKept = useRef(false);
  const restoreFileRef = useRef(restoreFile); restoreFileRef.current = restoreFile;
  // a pane its PC's roster no longer lists is closed; a PC with no roster read yet keeps its panes
  const paneLive = useCallback((machineId: string, paneId: string) => {
    const panes = machinesRef.current.find((machine) => machine.id === machineId)?.snapshot?.panes;
    return panes === undefined || panes.some((pane) => pane.pane_id === paneId);
  }, [machinesRef]);
  useEffect(() => {
    if (!fileLeft || fileLanding || viewing === null) return;
    // only the file shown on its own pane until this move is kept for the return; one opened for
    // another pane than the one shown (a split's other slot) is left as before
    const shown = shownSelection.current;
    fileKept.current = leaveFile(paneLive, shown.machineId === viewing.machineId && shown.paneId === viewing.paneId);
  }, [fileLeft, fileLanding, viewing, leaveFile, paneLive]);
  // a tab that closed takes its remembered file with it, so a later pane with its id never shows it
  useEffect(() => { forgetLeftFiles(paneLive); }, [machines, forgetLeftFiles, paneLive]);
  useEffect(() => {
    if (locked !== false || machines.length === 0 || snapshot === null || linkWorkspaceId === undefined || !linkLanded) return;
    // A popped entry's PC can land before its fallback pane. Keep Forward until that pane is known.
    // An offline PC never picks one, so its entry is written as it stands.
    if (poppedTo.current && selectedPaneId === null && snapshot.panes.length > 0 && selectedMachine?.state === "connected") return;
    // a file shown again by a popped entry, before its pane is selected: the place is written once it lands
    if (fileLanding) return;
    // the entry Back or Forward landed on is the handler's to read first: the place is written once it has
    if (popUnread(window.event, readPop.current)) { heldWrite.current = true; return; }
    heldWrite.current = false;
    const link: AppLink = {
      machine: selectedMachineId, workspace: linkWorkspaceId, workspaceSlug: linkSlug, pane: selectedPaneId, view: selectedPaneId ? view : null, file: linkFile,
      settings: settingsOpen ? settingsPage : null, section: settingsOpen && settingsPage === settingsLinkPage ? settingsLinkSection : null,
      sidebar: wideScreen && sidebarCollapsed ? "hidden" : null,
      create: newSessionOpen ? { kind: newTab ? "tab" : "workspace", cwd: newFields?.cwd ?? null, name: newFields?.name ?? null, agent: newFields?.agent ?? null } : null,
    };
    const previous = writtenLink.current;
    writtenLink.current = link;
    const search = linkSearch(link, pageSearch());
    const popped = poppedTo.current;
    poppedTo.current = false;
    // a kept file is this run's alone, written or not: left set, a later replace would take the file off another entry
    const kept = fileKept.current;
    fileKept.current = false;
    // Back and Forward land where the address already says: nothing to write
    if (search === pageSearch()) return;
    const url = pageAddress(window.location.pathname, search, window.location.hash);
    if (previous !== null && !popped && !autoSelected && !settingsOpen && !newSessionOpen && isNavigation(previous, link)) {
      // a move that leaves the open file behind takes the file's entry: no entry is left between
      if (fileLeft && !kept) window.history.replaceState({ [NAV_KEY]: true }, "", url);
      else window.history.pushState({ [NAV_KEY]: true }, "", url);
      // a file left on the pane moved to opens over the move's entry, as its own (#3179)
      if (selectedPaneId !== null) restoreFileRef.current(selectedMachineId, selectedPaneId);
    } else window.history.replaceState(kept && !popped ? withoutFile(window.history.state) : window.history.state, "", url);
  }, [locked, machines.length, snapshot, linkLanded, selectedMachine?.state, selectedMachineId, selectedPaneId, linkWorkspaceId, linkSlug, linkFile, fileLeft, view, settingsOpen, settingsPage, settingsLinkPage, settingsLinkSection, newSessionOpen, newTab, newFields, wideScreen, sidebarCollapsed, autoSelected, released]);
  useEffect(() => {
    shownSelection.current = { machineId: selectedMachineId, paneId: selectedPaneId };
  }, [selectedMachineId, selectedPaneId]);


  // a file a link named opens over its pane once the pane is shown, as the chat's file links do
  useEffect(() => {
    const path = pendingFile.current;
    // a viewer already up (a reload restores it from its history entry) is the file the address names:
    // the link has nothing left to open, and a Back that closes the viewer must not bring it back
    if (viewing) { pendingFile.current = null; return; }
    if (path === null || !linkLanded || locked !== false || selectedMachine?.state !== "connected" || snapshot === null) return;
    pendingFile.current = null;
    openFile({ path, paneId: selectedPane?.pane_id ?? null, machineId: selectedMachineId });
  }, [linkLanded, locked, selectedMachine?.state, snapshot, selectedPane, selectedMachineId, viewing, openFile]);

  // Back and Forward between panes: the entry's address says which one. Settings' own entries
  // are its module's (lib/settingsHistory.ts)
  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      if (settingsEntry(event.state) !== null) return;
      // a phone's sheet closing itself steps off its entry: not a Back, and what its item opened (a
      // worktree's shell, before the roster lists it) is written over the address once it is listed
      if (sheetSteppedOff()) return;
      // Settings closing lands on the entry it opened over: what was picked while it was up stays
      // (hiding a PC here moves the selection off it), and the entry is written to say so
      if (settingsSteppedOff()) { sayShown(); return; }
      const link = readLink(pageSearch());
      // before the PCs are in, nothing can say the entry's PC is still set up: it waits as a link
      // opened with the page does, settled against its roster or answered with a note once they are
      if (machinesRef.current.length === 0) {
        // an entry that asks for nothing drops a creation the page or an earlier entry left waiting
        if (!link.pane && !link.workspace && !link.create) { pendingCreate.current = null; return; }
        if (!link.create) setNewSessionOpen(false);
        pendingCreate.current = link.create ?? null;
        selectTargetRef.current(link.machine, link.pane, link.view ?? undefined);
        poppedTo.current = true;
        popMoving.current = true;
        // a creation-only entry names no place to settle: as when the page opens with one, its PC is
        // the selection, which the first roster checks, connected or not
        if (!link.pane && !link.workspace) return;
        pendingLink.current = link; pendingFile.current = null; setLinkLanded(false);
        linkSince.current = rosterSeq.current;
        return;
      }
      const machine = machinesRef.current.find((candidate) => candidate.id === link.machine);
      const missing = !machine && machinesRef.current.length > 0;
      // the New workspace dialog is part of the address it was open on: Back closes it, Forward opens
      // it again, but not for a PC removed since
      // an entry without one drops a creation still waiting; a dialog open for another PC gives way to the entry's
      if (!link.create) { setNewSessionOpen(false); pendingCreate.current = null; }
      else if (!missing && (!newSessionOpenRef.current || link.machine !== selectionRef.current.machineId)) { setNewSessionOpen(false); pendingCreate.current = link.create; }
      // an entry naming a PC since removed leaves the app where it is and says so, as a link to it would
      if (missing) setHeaderNote("machine-missing");
      else {
        const pane = machine?.snapshot ? resolveLink(machine.snapshot, link).pane : link.pane;
        if (pane === null) {
          // the dialog opens over the pane already shown on its PC; another PC's fallback pane is picked
          if (link.create && selectionRef.current.machineId !== link.machine) { poppedTo.current = true; popMoving.current = true; selectTargetRef.current(link.machine, null); }
          return;
        }
        const current = selectionRef.current;
        // the entry's lens is drawn over the pane's own, as a tapped notification's is. Where it
        // lands is written over the entry, so Forward keeps the entries after it
        if (current.machineId !== link.machine || current.paneId !== pane) { poppedTo.current = true; popMoving.current = true; selectTargetRef.current(link.machine, pane, link.pane === pane ? link.view ?? undefined : undefined); return; }
      }
      // the same pane, or no PC to go to: the entry landed on may still say what is no longer shown
      // (the address a link to Settings opened the page with, under the dialog's own entries), so it says it now
      sayShown();
    };
    const sayShown = (): void => {
      // the place shown was held back while this entry was unread: the effect writes it over the entry,
      // as it does the place any pop lands on
      if (heldWrite.current) { poppedTo.current = true; return; }
      const shown = writtenLink.current;
      const search = shown ? linkSearch(shown, pageSearch()) : pageSearch();
      if (search !== pageSearch()) window.history.replaceState(window.history.state, "", pageAddress(window.location.pathname, search, window.location.hash));
    };
    // the file viewer's listener has shown the entry's file by now: a pop that moves nothing says so,
    // and the render that follows leaves its file behind
    const decidePop = (event: PopStateEvent): void => {
      popMoving.current = false;
      readPop.current = event;
      onPop(event);
      // the entry is read: the write held back for it is made now
      if (heldWrite.current) { heldWrite.current = false; setReleased((count) => count + 1); }
      const pop = fileFromPopRef.current();
      if (pop !== 0 && !popMoving.current) { popStill.current = pop; setPopSettled((count) => count + 1); }
    };
    window.addEventListener("popstate", decidePop);
    return () => window.removeEventListener("popstate", decidePop);
  }, []);
}
