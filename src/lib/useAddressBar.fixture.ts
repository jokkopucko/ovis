/**
 * The address bar as App.tsx mounts it, for a test that drives it through a history of its own: the
 * test says what is shown and answers what the hook asks of the app, and the rest of the app is at
 * rest (unlocked, Settings closed, a wide screen, the chat lens).
 */
import { useLayoutEffect } from "react";
import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane, HerdrWorkspace } from "../../shared/protocol.ts";
import type { AppLink, CreateDraft } from "./deepLink.ts";
import type { SelectionMark } from "./selectionMark.ts";
import { useAddressBar } from "./useAddressBar.ts";

type Params = Parameters<typeof useAddressBar>[0];
export type Snapshot = NonNullable<Machine["snapshot"]>;
export type Preview = NonNullable<Params["viewing"]>;

export interface ShownPlace {
  machineId: string;
  paneId: string | null;
  newSessionOpen: boolean;
  newFields: Omit<CreateDraft, "kind"> | null;
  sidebarCollapsed: boolean;
  snapshot: Snapshot;
  viewing: Preview | null;
  linkLanded: boolean;
  inbox: { open: boolean; enabled: boolean };
  /** the Settings page open over the place, if any */
  settings?: string | null;
  dialogMachineId?: string;
  rosterOut?: boolean;
  mode?: boolean;
}

export type AddressBarRefs = ReturnType<typeof addressBarRefs>;

export function addressBarRefs() {
  return {
    selection: { current: { machineId: "local", paneId: null, generation: 0 } as SelectionMark },
    machines: { current: [] as Machine[] },
    selectTarget: { current: (_machineId: string, _paneId: string | null): void => {} },
    pendingFile: { current: null as string | null },
    pendingLink: { current: null as AppLink | null },
    pendingCreate: { current: null as CreateDraft | null },
    newSessionPending: { current: false },
    linkSince: { current: 0 },
    rosterSeq: { current: 0 },
  };
}

export function useAddressBarOf(place: ShownPlace, refs: AddressBarRefs, app: {
  showInbox(): void;
  leaveInbox(): void;
  leaveFile(): boolean;
  setNewSessionOpen(open: boolean): void;
}): void {
  const { machineId, paneId, newSessionOpen, newFields, sidebarCollapsed, snapshot, viewing, linkLanded, inbox, settings = null, dialogMachineId, rosterOut, mode } = place;
  const machine = { id: machineId, name: "workstation", kind: "local", enabled: true, state: "connected", error: null, snapshot } as Machine;
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId) as HerdrPane;
  refs.machines.current = rosterOut ? [] : [machine];
  useLayoutEffect(() => { refs.selection.current = { machineId, paneId, generation: 0 }; }, [machineId, paneId]);
  useAddressBar({
    inbox: { shown: inbox.open && inbox.enabled, enabled: inbox.enabled, show: app.showInbox, leave: app.leaveInbox },
    mode: mode === undefined ? undefined : { on: mode, lands: () => new URLSearchParams(window.location.search).get("app") === "inbox" },
    newSessionOpen, newSessionMachineId: dialogMachineId ?? machineId, newFields, sidebarCollapsed, snapshot, selectedPaneId: paneId, selectedPane: pane,
    selectedWorkspace: snapshot.workspaces.find((workspace) => workspace.workspace_id === pane?.workspace_id) as HerdrWorkspace,
    selectedMachineId: machineId, selectedMachine: machine, machines: refs.machines.current, machinesRef: refs.machines,
    viewing, leaveFile: app.leaveFile,
    restoreFile: () => {}, fileFromPop: () => 0, forgetLeftFiles: () => {}, openFile: () => {},
    locked: false, linkLanded, view: "chat", wideScreen: true, autoSelected: false, newTab: null,
    settingsOpen: settings !== null, settingsPage: settings, settingsLinkPage: null, settingsLinkSection: null,
    pendingFile: refs.pendingFile, pendingLink: refs.pendingLink, pendingCreate: refs.pendingCreate, newSessionPending: refs.newSessionPending, linkSince: refs.linkSince, rosterSeq: refs.rosterSeq,
    selectTargetRef: refs.selectTarget, selectionRef: refs.selection,
    setLinkLanded: () => {}, setHeaderNote: () => {},
    setNewSessionOpen: app.setNewSessionOpen,
  } as unknown as Params);
}
