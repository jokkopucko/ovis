import { type Dispatch, type RefObject, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import type { HerdrPane, HerdrWorkspace } from "../../shared/protocol.ts";
import { LOCAL_MACHINE, type Machine } from "../../shared/machines.ts";
import type { PaneView } from "./actions.ts";
import { fileFromLink, isNavigation, linkSearch, NAV_KEY, readLink, resolveLink, slugOf, type AppLink, type LinkNote } from "./deepLink.ts";
import { withoutFile } from "./historyKeys.ts";
import { INBOX_FROM_KEY, type useInbox } from "./useInbox.ts";
import { pageAddress, pageSearch } from "./pageQuery.ts";
import type { SelectionMark } from "./selectionMark.ts";
import { settingsEntry, settingsSteppedOff } from "./settingsHistory.ts";
import { onSheetTraversalOver, sheetSteppedOff, sheetTraversalPending } from "./sheetHistory.ts";
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

function otherPane(under: Pick<AppLink, "machine" | "pane"> | null, shown: Pick<AppLink, "machine" | "pane">): boolean {
  return under !== null && (under.machine !== shown.machine || under.pane !== shown.pane);
}

function entryKey(): string | undefined {
  return (window as Window & { navigation?: { currentEntry?: { key: string } | null } }).navigation?.currentEntry?.key;
}

export function useAddressBar({ inbox, mode, newSessionOpen, newSessionMachineId, selectedPane, selectedPaneId, selectedWorkspace, viewing, selectedMachineId, leaveFile, restoreFile, fileFromPop, forgetLeftFiles, locked, machines, snapshot, linkLanded, view, settingsOpen, settingsPage, settingsLinkPage, settingsLinkSection, wideScreen, sidebarCollapsed, newTab, newFields, autoSelected, pendingFile, selectedMachine, openFile, machinesRef, selectTargetRef, pendingLink, setLinkLanded, linkSince, rosterSeq, setNewSessionOpen, pendingCreate, newSessionPending, setHeaderNote, selectionRef }: {
  inbox: Pick<ReturnType<typeof useInbox>, "shown" | "enabled" | "show" | "leave">;
  mode?: { on: boolean; lands(): boolean };
  newSessionOpen: boolean;
  newSessionMachineId: string;
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
  newSessionPending: ReturnType<typeof useNewSessionState>["newSessionPending"];
  setHeaderNote: Dispatch<SetStateAction<LinkNote | "copied" | null>>;
  selectionRef: RefObject<SelectionMark>;
}): void {
  // Nothing is written while locked or before the roster is in, so a
  // link survives the access gate and a slow first read.
  const writtenLink = useRef<AppLink | null>(null);
  const poppedTo = useRef(false);
  const newSessionOpenRef = useRef(newSessionOpen); newSessionOpenRef.current = newSessionOpen;
  const inboxRef = useRef(inbox); inboxRef.current = inbox;
  const modeRef = useRef(mode); modeRef.current = mode;
  const modeOn = mode?.on === true;
  const { shown: inboxShown, enabled: inboxEnabled } = inbox;
  const linkPaneId = inboxShown ? null : selectedPaneId;
  const linkWorkspaceId = inboxShown ? null : selectedPane?.workspace_id ?? (selectedPaneId === null ? null : undefined);
  const linkSlug = inboxShown ? null : slugOf(selectedWorkspace?.label) || null;
  const listWritten = useRef(inboxShown);
  const linkFile = viewing && viewing.machineId === selectedMachineId && (viewing.paneId === null || viewing.paneId === selectedPaneId) ? viewing.path : null;
  const fileLeft = viewing !== null && linkFile === null;
  const shownSelection = useRef({ machineId: selectedMachineId, paneId: selectedPaneId });
  const popMoving = useRef(false);
  const popStill = useRef(0);
  const [, setPopSettled] = useState(0);
  // The popstate the handler last read. Back and Forward land on an entry before any listener hears
  // of it, and React draws between two listeners: what an earlier one set (Settings closing, the file
  // viewer's file) and any update still waiting (a roster, the New workspace dialog's fields). The
  // place shown must not be written over that entry before the handler has read where it leads, so
  // the write is held back until then (heldWrite) and made right after (released).
  const readPop = useRef<Event | null>(null);
  const heldWrite = useRef(false);
  // Refusing a sheet Back may leave the browser on another pane's entry if the return is lost.
  // A later render still owns the pane shown, not the entry where that Back stopped.
  const refusedEntry = useRef<{ link: Pick<AppLink, "machine" | "pane">; key: string | undefined } | null>(null);
  const wouldOverwriteRefused = (shown: Pick<AppLink, "machine" | "pane">): boolean => {
    const refused = refusedEntry.current;
    return refused !== null && (refused.key === undefined || refused.key === entryKey()) && otherPane(refused.link, shown);
  };
  const [released, setReleased] = useState(0);
  const filePop = fileFromPop();
  const entryLink = fileLeft && filePop !== 0 && popStill.current !== filePop ? readLink(pageSearch()) : null;
  const fileLanding = entryLink !== null && viewing !== null && entryLink.machine === viewing.machineId && entryLink.pane === viewing.paneId &&
    shownSelection.current.machineId === selectedMachineId && shownSelection.current.paneId === selectedPaneId;
  const fileFromPopRef = useRef(fileFromPop); fileFromPopRef.current = fileFromPop;
  const fileKept = useRef(false);
  const restoreFileRef = useRef(restoreFile); restoreFileRef.current = restoreFile;
  const paneLive = useCallback((machineId: string, paneId: string) => {
    const panes = machinesRef.current.find((machine) => machine.id === machineId)?.snapshot?.panes;
    return panes === undefined || panes.some((pane) => pane.pane_id === paneId);
  }, [machinesRef]);
  useEffect(() => {
    if (!fileLeft || fileLanding || viewing === null) return;
    const shown = shownSelection.current;
    fileKept.current = leaveFile(paneLive, shown.machineId === viewing.machineId && shown.paneId === viewing.paneId);
  }, [fileLeft, fileLanding, viewing, leaveFile, paneLive]);
  useEffect(() => { forgetLeftFiles(paneLive); }, [machines, forgetLeftFiles, paneLive]);
  useEffect(() => {
    if (locked !== false || machines.length === 0 || snapshot === null || !linkLanded) return;
    // A sheet's own traversal (its step off its entry, or its way back onto the entry a Back left)
    // has the history on another entry until it lands; release the write when its popstate lands,
    // or when the sheets say it is over with none (a way back dropped, then the entry made by a tap).
    if (sheetTraversalPending()) { heldWrite.current = true; return; }
    if (linkWorkspaceId === undefined) {
      const written = writtenLink.current;
      if (listWritten.current && !newSessionOpen && written?.create && !popUnread(window.event, readPop.current)) {
        const link: AppLink = { ...written, create: null, machine: LOCAL_MACHINE };
        if (wouldOverwriteRefused(link)) { heldWrite.current = true; return; }
        writtenLink.current = link;
        const search = linkSearch(link, pageSearch());
        if (search !== pageSearch()) window.history.replaceState(window.history.state, "", pageAddress(window.location.pathname, search, window.location.hash));
      }
      return;
    }
    if (!inboxShown && poppedTo.current && selectedPaneId === null && snapshot.panes.length > 0 && selectedMachine?.state === "connected") return;
    if (fileLanding) return;
    if (popUnread(window.event, readPop.current)) { heldWrite.current = true; return; }
    heldWrite.current = false;
    const link: AppLink = {
      machine: inboxShown ? (newSessionOpen ? newSessionMachineId : LOCAL_MACHINE) : selectedMachineId, workspace: linkWorkspaceId, workspaceSlug: linkSlug, pane: linkPaneId, view: linkPaneId ? view : null, file: inboxShown ? null : linkFile,
      settings: settingsOpen ? settingsPage : null, section: settingsOpen && settingsPage === settingsLinkPage ? settingsLinkSection : null,
      sidebar: wideScreen && sidebarCollapsed ? "hidden" : null,
      create: newSessionOpen ? { kind: newTab ? "tab" : "workspace", cwd: newFields?.cwd ?? null, name: newFields?.name ?? null, agent: newFields?.agent ?? null } : null,
    };
    const previous = writtenLink.current;
    const leftInbox = listWritten.current && !inboxShown;
    const search = linkSearch(link, pageSearch());
    const popped = poppedTo.current;
    const kept = fileKept.current;
    const moved = leftInbox ? inboxEnabled && link.pane !== null : previous !== null && !autoSelected && isNavigation(previous, link);
    const navigate = !popped && !settingsOpen && !newSessionOpen && moved;
    const replaces = !navigate || (!leftInbox && (modeOn || (fileLeft && !kept)));
    if (replaces && wouldOverwriteRefused(link)) { heldWrite.current = true; return; }
    writtenLink.current = link;
    listWritten.current = inboxShown;
    poppedTo.current = false;
    // a kept file is this run's alone, written or not: left set, a later replace would take the file off another entry
    fileKept.current = false;
    if (search === pageSearch()) return;
    const url = pageAddress(window.location.pathname, search, window.location.hash);
    if (navigate) {
      const state = leftInbox ? { [NAV_KEY]: true, [INBOX_FROM_KEY]: true } : { [NAV_KEY]: true };
      if (modeOn && !leftInbox) window.history.replaceState(fileLeft ? withoutFile(window.history.state) : window.history.state, "", url);
      else if (fileLeft && !kept && !leftInbox) window.history.replaceState(state, "", url);
      else { window.history.pushState(state, "", url); refusedEntry.current = null; }
      if (selectedPaneId !== null) restoreFileRef.current(selectedMachineId, selectedPaneId);
    } else window.history.replaceState(kept && !popped ? withoutFile(window.history.state) : window.history.state, "", url);
  }, [locked, machines.length, snapshot, linkLanded, selectedMachine?.state, selectedMachineId, selectedPaneId, linkWorkspaceId, linkSlug, linkFile, fileLeft, view, settingsOpen, settingsPage, settingsLinkPage, settingsLinkSection, newSessionOpen, newSessionMachineId, newTab, newFields, wideScreen, sidebarCollapsed, autoSelected, released, inboxShown, inboxEnabled, modeOn]);
  useEffect(() => {
    shownSelection.current = { machineId: selectedMachineId, paneId: selectedPaneId };
  }, [selectedMachineId, selectedPaneId]);


  useEffect(() => {
    const path = pendingFile.current;
    // a viewer already up (a reload restores it from its history entry) is the file the address names:
    // the link has nothing left to open, and a Back that closes the viewer must not bring it back
    if (viewing) { pendingFile.current = null; return; }
    if (path === null || !linkLanded || locked !== false || selectedMachine?.state !== "connected" || snapshot === null) return;
    pendingFile.current = null;
    openFile({ path, paneId: selectedPane?.pane_id ?? null, machineId: selectedMachineId });
  }, [linkLanded, locked, selectedMachine?.state, snapshot, selectedPane, selectedMachineId, viewing, openFile]);

  useEffect(() => {
    const listHere = (): boolean => modeRef.current?.lands() ?? inboxRef.current.enabled;
    const onPop = (event: PopStateEvent): void => {
      if (sheetSteppedOff()) { refusedEntry.current = { link: readLink(pageSearch()), key: entryKey() }; return; }
      if (settingsEntry(event.state) !== null) return;
      if (settingsSteppedOff()) { sayShown(); return; }
      refusedEntry.current = null;
      if (newSessionPending.current && newSessionOpenRef.current && inboxRef.current.shown) { sayShown(); return; }
      const link = readLink(pageSearch());
      if (machinesRef.current.length === 0) {
        if (!link.pane && !link.workspace && !link.create) {
          pendingCreate.current = null;
          if (fileFromLink(link) !== null) { if (inboxRef.current.shown) { inboxRef.current.leave(); poppedTo.current = true; } }
          else if (listHere()) inboxRef.current.show();
          return;
        }
        if (link.pane || link.workspace) inboxRef.current.leave();
        if (!link.create) setNewSessionOpen(false);
        pendingCreate.current = link.create ?? null;
        selectTargetRef.current(link.machine, link.pane, link.view ?? undefined);
        poppedTo.current = true;
        popMoving.current = true;
        if (!link.pane && !link.workspace) return;
        pendingLink.current = link; pendingFile.current = null; setLinkLanded(false);
        linkSince.current = rosterSeq.current;
        return;
      }
      const machine = machinesRef.current.find((candidate) => candidate.id === link.machine);
      const missing = !machine && machinesRef.current.length > 0;
      if (!link.create) { setNewSessionOpen(false); pendingCreate.current = null; }
      else if (!missing && (!newSessionOpenRef.current || link.machine !== selectionRef.current.machineId)) { setNewSessionOpen(false); pendingCreate.current = link.create; }
      if (missing) setHeaderNote("machine-missing");
      else {
        const pane = machine?.snapshot ? resolveLink(machine.snapshot, link).pane : link.pane;
        if (pane === null) {
          if (link.create && selectionRef.current.machineId !== link.machine) { poppedTo.current = true; popMoving.current = true; selectTargetRef.current(link.machine, null); }
          if (fileFromLink(link) !== null) { if (inboxRef.current.shown) { inboxRef.current.leave(); poppedTo.current = true; } }
          else if (listHere()) inboxRef.current.show();
          return;
        }
        const fromInbox = inboxRef.current.shown;
        inboxRef.current.leave();
        if (fromInbox) poppedTo.current = true;
        const current = selectionRef.current;
        if (current.machineId !== link.machine || current.paneId !== pane) { poppedTo.current = true; popMoving.current = true; selectTargetRef.current(link.machine, pane, link.pane === pane ? link.view ?? undefined : undefined); return; }
        if (fromInbox) return;
      }
      sayShown();
    };
    const sayShown = (): void => {
      if (heldWrite.current) { poppedTo.current = true; return; }
      const shown = writtenLink.current;
      if (shown !== null && wouldOverwriteRefused(shown)) { heldWrite.current = true; return; }
      const search = shown ? linkSearch(shown, pageSearch()) : pageSearch();
      if (search !== pageSearch()) window.history.replaceState(window.history.state, "", pageAddress(window.location.pathname, search, window.location.hash));
    };
    const decidePop = (event: PopStateEvent): void => {
      popMoving.current = false;
      readPop.current = event;
      onPop(event);
      if (heldWrite.current) { heldWrite.current = false; setReleased((count) => count + 1); }
      const pop = fileFromPopRef.current();
      if (pop !== 0 && !popMoving.current) { popStill.current = pop; setPopSettled((count) => count + 1); }
    };
    window.addEventListener("popstate", decidePop);
    const leaveTraversal = onSheetTraversalOver(() => {
      refusedEntry.current = null;
      if (heldWrite.current) { heldWrite.current = false; setReleased((count) => count + 1); }
    });
    return () => { window.removeEventListener("popstate", decidePop); leaveTraversal(); };
  }, []);
}
