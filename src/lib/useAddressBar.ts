import { type Dispatch, type RefObject, type SetStateAction, useEffect, useRef } from "react";
import type { HerdrPane, HerdrWorkspace } from "../../shared/protocol.ts";
import type { Machine } from "../../shared/machines.ts";
import type { PaneView } from "./actions.ts";
import { isNavigation, linkSearch, NAV_KEY, readLink, resolveLink, slugOf, type AppLink, type LinkNote } from "./deepLink.ts";
import { pageAddress, pageSearch } from "./pageQuery.ts";
import type { SelectionMark } from "./selectionMark.ts";
import { settingsEntry, settingsSteppedOff } from "./settingsHistory.ts";
import { sheetSteppedOff } from "./sheetHistory.ts";
import type { useFilePanels } from "./useFilePanels.ts";
import type { useNewSessionState } from "./useNewSessionDialog.ts";
import type { usePaneLens } from "./usePaneLens.ts";
import type { useSettingsDialog } from "./useSettingsDialog.ts";

export function useAddressBar({ newSessionOpen, selectedPane, selectedPaneId, selectedWorkspace, viewing, selectedMachineId, releaseFile, locked, machines, snapshot, linkLanded, view, settingsOpen, settingsPage, settingsLinkPage, settingsLinkSection, wideScreen, sidebarCollapsed, newTab, newFields, autoSelected, pendingFile, selectedMachine, openFile, machinesRef, selectTargetRef, pendingLink, setLinkLanded, linkSince, rosterSeq, setNewSessionOpen, pendingCreate, setHeaderNote, selectionRef }: {
  newSessionOpen: boolean;
  selectedPane: HerdrPane | null;
  selectedPaneId: string | null;
  selectedWorkspace: HerdrWorkspace | null;
  viewing: ReturnType<typeof useFilePanels>["viewing"];
  selectedMachineId: string;
  releaseFile: ReturnType<typeof useFilePanels>["releaseFile"];
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
  // to the pane the file was open on, without the file
  const fileLeft = viewing !== null && linkFile === null;
  useEffect(() => {
    if (fileLeft) releaseFile();
  }, [fileLeft, releaseFile]);
  useEffect(() => {
    if (locked !== false || machines.length === 0 || snapshot === null || linkWorkspaceId === undefined || !linkLanded) return;
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
    // Back and Forward land where the address already says: nothing to write
    if (search === pageSearch()) return;
    const url = pageAddress(window.location.pathname, search, window.location.hash);
    if (previous !== null && !popped && !autoSelected && !settingsOpen && !newSessionOpen && isNavigation(previous, link)) {
      // a move that leaves the open file behind takes the file's entry: no entry is left between
      if (fileLeft) window.history.replaceState({ [NAV_KEY]: true }, "", url);
      else window.history.pushState({ [NAV_KEY]: true }, "", url);
    } else window.history.replaceState(window.history.state, "", url);
  }, [locked, machines.length, snapshot, linkLanded, selectedMachineId, selectedPaneId, linkWorkspaceId, linkSlug, linkFile, fileLeft, view, settingsOpen, settingsPage, settingsLinkPage, settingsLinkSection, newSessionOpen, newTab, newFields, wideScreen, sidebarCollapsed, autoSelected]);


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
        if (!link.pane && !link.workspace) return;
        selectTargetRef.current(link.machine, link.pane, link.view ?? undefined);
        pendingLink.current = link; pendingFile.current = null; setLinkLanded(false);
        linkSince.current = rosterSeq.current;
        poppedTo.current = true;
        return;
      }
      const machine = machinesRef.current.find((candidate) => candidate.id === link.machine);
      const missing = !machine && machinesRef.current.length > 0;
      // the New workspace dialog is part of the address it was open on: Back closes it, Forward opens
      // it again, but not for a PC removed since
      if (!link.create) setNewSessionOpen(false);
      else if (!missing && !newSessionOpenRef.current) pendingCreate.current = link.create;
      // an entry naming a PC since removed leaves the app where it is and says so, as a link to it would
      if (missing) setHeaderNote("machine-missing");
      else {
        const pane = machine?.snapshot ? resolveLink(machine.snapshot, link).pane : link.pane;
        if (pane === null) return;
        const current = selectionRef.current;
        // the entry's lens is drawn over the pane's own, as a tapped notification's is. Where it
        // lands is written over the entry, so Forward keeps the entries after it
        if (current.machineId !== link.machine || current.paneId !== pane) { poppedTo.current = true; selectTargetRef.current(link.machine, pane, link.pane === pane ? link.view ?? undefined : undefined); return; }
      }
      // the same pane, or no PC to go to: the entry landed on may still say what is no longer shown
      // (the address a link to Settings opened the page with, under the dialog's own entries), so it says it now
      sayShown();
    };
    const sayShown = (): void => {
      const shown = writtenLink.current;
      const search = shown ? linkSearch(shown, pageSearch()) : pageSearch();
      if (search !== pageSearch()) window.history.replaceState(window.history.state, "", pageAddress(window.location.pathname, search, window.location.hash));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
}
