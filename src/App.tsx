import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, ChevronDown, Plus, CircleHelp, Ellipsis, FolderOpen, Link, Menu, MessageCircle, MessageSquare, PanelLeft, Search, SquareTerminal, Target, X } from "lucide-react";

import type { HerdrPane, PaneDirection } from "../shared/protocol.ts";
import { authenticate, createTab, movePaneBeside, moveTabToWorkspace, paneSessionKey, shareSeen, swapPaneWith } from "./lib/api.ts";
import { layoutActions } from "./lib/layoutActions.ts";
import { displayPaneTitle, storedBackgroundFolded, storedWorktreeCollapsed, tabPaneTitle } from "./components/Sidebar.tsx";
import { endSignIn } from "./lib/signOut.ts";
import { PaneCanvas } from "./components/PaneCanvas.tsx";
import { MachineSessionsProvider } from "./lib/machineSessionContext.tsx";
import { PaneTerminal } from "./components/PaneTerminal.tsx";
import { paneCovered, paneContentKey, paneContentPresented } from "./lib/panePresentation.ts";
import { PANE_TABPANEL_ID, paneTabPanelLabel } from "./lib/paneRegion.ts";
import { worktreeRepoName } from "./lib/composerStrip.ts";
import { AccessGate } from "./components/AccessGate.tsx";
import { AgentMark } from "./components/AgentMark.tsx";
import { NewSessionDialog } from "./components/NewSessionDialog.tsx";
import { SetupGuide, SetupGuideResume } from "./components/SetupGuide.tsx";
import { useSetupGuide } from "./lib/useSetupGuide.ts";
import { SessionHistory } from "./components/SessionHistory.tsx";
import { WorktreeRequestDialog } from "./components/WorktreeDialog.tsx";
import { worktreesStartHere } from "./lib/repositoryWorkspaces.ts";
import { UnsentTextDialog } from "./components/UnsentText.tsx";
import { useUnsentRecovery } from "./lib/useUnsentRecovery.ts";
import { sessionHistoryAgent, sessionHistoryListAgent, sessionHistorySourcePane } from "./lib/sessionHistory.ts";
import { usePreferencesSync } from "./lib/preferencesSync.ts";
import { setTabLabelLearning, settleTabLabels, subscribeTabLabels } from "./lib/tabLabels.ts";
import { customTabLabel, tabLabel } from "./lib/tabName.ts";
import { agentName } from "./lib/runtimeMove.ts";
import { TabStrip } from "./components/TabStrip.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { loadedOnSettingsEntry } from "./lib/settingsHistory.ts";
import { useSettingsDialog } from "./lib/useSettingsDialog.ts";
import { usePhoneSheetBack } from "./lib/sheetHistory.ts";
import { peekFor, type PeekRequest } from "./lib/terminalPeek.ts";
import { SHEET_QUERY } from "./lib/sheets.ts";
import { linksSomewhere, readLink } from "./lib/deepLink.ts";
import { pageSearch } from "./lib/pageQuery.ts";
import { copyText } from "./lib/clipboard.ts";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { AppLayoutContext, appLayoutOf, MachineContext } from "./lib/machineContext.tsx";
import { MachineActionBanner, MachineSidebar } from "./components/MachineSidebar.tsx";
import { SidebarResizer } from "./components/SidebarResizer.tsx";
import { type PanePresence, useSidebarActivityState } from "./lib/sidebarActivity.tsx";
import { FilePanelResizer } from "./components/FilePanelResizer.tsx";
import { openPresentation } from "./lib/filePresentation.ts";
import { MachineDialog } from "./components/MachineDialog.tsx";
import { RowMenu, type RowMenuItem } from "./components/RowMenu.tsx";
import { headerCrumb, showsChat } from "./lib/headerCrumb.ts";
import { LOCAL_MACHINE, paneStorageId } from "../shared/machines.ts";
import { serverIdOfPath, shellMode } from "./lib/shellMode.ts";
import { usePairedNotices } from "./lib/usePairedNotices.ts";
import { takeAuthTokenFromUrl } from "./lib/authLink.ts";
import { rosterPanes } from "./lib/dagPane.ts";
import { adjacentTabPane, adjacentWorkspacePane, numberedTabPane, drawnWorkspaceRows, sidebarWorkspaceSteps, type ViewedPane } from "./lib/adjacentTarget.ts";
import { lastViewedPane } from "./lib/lastViewedPane.ts";
import { currentSidebarPins, movedSidebarPins, pinnedWorkspaceIds } from "./lib/sidebarPins.ts";
import { liveGroupKeys, movedAgentGroup } from "./lib/namedAgentGroups.ts";
import { ReorderContext } from "./lib/machineContext.tsx";
import { pcLoadOn, useSettings } from "./lib/settings.ts";
import { useHiddenMachines, useShownMachines } from "./lib/hiddenMachines.ts";
import { formatKeys, shortcutDisplayKeys, useShortcuts } from "./lib/shortcuts.ts";
import { useHerdrPrefixKeys } from "./lib/herdrKeys.ts";
import { useMediaQuery } from "./lib/useMediaQuery.ts";
import { useAnnouncedText } from "./lib/useAnnouncedText.ts";
import { CRAMPED_QUERY, paneContextPress, tabRowHidden } from "./lib/paneCanvas.ts";
import { useTabSheet } from "./lib/useTabSheet.ts";
import type { AppActions, PaneView, PaneControls } from "./lib/actions.ts";
import { removePushSubscription } from "./lib/push.ts";
import { resetPushHealth } from "./lib/pushHealth.ts";
import { useUpdates } from "./lib/updates.ts";
import { UpdateNotice } from "./components/UpdateControls.tsx";
import { LanExposureNotice } from "./components/LanExposureNotice.tsx";
import { PushHealthNotice } from "./components/PushHealthNotice.tsx";
import { InstallHint } from "./components/InstallHint.tsx";
import { DevicePairedNotice, DeviceRemovedNotice } from "./components/DevicePairedNotice.tsx";
import { RelayPairingPrompt } from "./components/RelayPairingPrompt.tsx";
import { AccountApprovals } from "./components/AccountApprovals.tsx";
import { TelemetryNotice } from "./components/TelemetryControls.tsx";
import { FilesDialog } from "./components/FilesDialog.tsx";
import { folderQueryFor } from "./lib/paletteFolders.ts";
import { FileViewer } from "./components/FileViewer.tsx";
import { WebPanel } from "./components/WebPanel.tsx";
import { WebPanelContext } from "./lib/webPanel.ts";
import { RepoDiffViewer } from "./components/RepoDiffViewer.tsx";
import { noteBlock, noteBlockWord } from "./lib/diffLineNotes.ts";
import { directHostOf, useDirectNotice } from "./lib/directNotice.ts";
import { usePaneObserving } from "./lib/paneObserving.ts";
import { OpenFileContext } from "./lib/filePaths.ts";
import { useAccessState, useLockedRef, usePairFromAddress } from "./lib/useAccess.ts";
import { useLocalHealth } from "./lib/useLocalHealth.ts";
import { useMachinesRef, useRecentFolderMemory, useRefetchTimer, useRosterError, useRosterEvents, useRosterLoader, useRosterState } from "./lib/useMachineRoster.ts";
import { useMachineDialog } from "./lib/useMachineDialog.ts";
import { useNewSessionMachine, useNewSessionState, useSessionHistoryList } from "./lib/useNewSessionDialog.ts";
import { useCommandPalette } from "./lib/useCommandPalette.ts";
import { useRenameRequest } from "./lib/useRenameRequest.ts";
import { useSearchRequest } from "./lib/useSearchRequest.ts";
import { fileViewerKey, useFilePanels } from "./lib/useFilePanels.ts";
import { usePaneCoverage } from "./lib/usePaneCoverage.ts";
import { useT } from "./lib/i18n.ts";
import { useConnectionChip, useServerMessageHandler } from "./lib/useConnectionChip.ts";
import { useHeaderConnection } from "./lib/headerConnection.ts";
import { ConnectionRouteMark } from "./components/ConnectionRouteMark.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { HeaderCounts } from "./components/HeaderCounts.tsx";
import { PcLoadStatus } from "./components/MachineStats.tsx";
import logoDark from "./assets/brand/logo-dark.png";
import logoLight from "./assets/brand/logo-light.png";
import { nextWaitingTarget, sessionCountsAcross, tabPosition, useDrawerDialog, useWaitingRosters } from "./lib/headerSessions.ts";
import { selectionStill } from "./lib/selectionMark.ts";
import { carryMovedPane, movedView } from "./lib/paneMove.ts";
import { useScreenWakeLock } from "./lib/wakeLock.ts";
import { useSidebarLayout } from "./lib/useSidebarLayout.ts";
import { useSidebarPeek } from "./lib/sidebarPeek.ts";
import { useAlertPrefs, useAlertRefs } from "./lib/useAlerts.ts";
import { useAlertSignals } from "./lib/useAlertSignals.ts";
import { useNotificationState, useNotificationSwitch } from "./lib/useNotifications.ts";
import { alertsBell } from "./lib/alertsBell.ts";
import { Droplet } from "./components/Droplet.tsx";
import { MarkdownLinkMenu } from "./components/MarkdownLinkMenu.tsx";
import { paneDragData, PANE_DRAG_TYPE, slotSide, type SplitSlot, type SplitTarget } from "./lib/split.ts";
import { paneMoveNotice, useLayoutNotice, useLayoutRefused, useMoveRefused } from "./lib/useLayoutNotice.ts";
import { PaneFollowContext, PanePressContext } from "./lib/paneSubmitContext.ts";
import { SplitDividers } from "./components/SplitDividers.tsx";
import { SplitDropPreview } from "./components/SplitDropPreview.tsx";
import { CrashProbe, RegionCrash } from "./components/AppCrash.tsx";
import { RenderBoundary } from "./components/RenderBoundary.tsx";
import { lensOwner, storedView, usePaneLens, usePaneLensState, usePaneViewPicks } from "./lib/usePaneLens.ts";
import { useSplitLayout, useSplitRecheck, useSplitState } from "./lib/useSplitView.ts";
import { linkSelects, useLinkLanding, useMachineGone, useNotificationTargets, useSelectedLayout, useSelectedMachine, useSelectedPane, useSelectionMark, useSelectionState, useSelectPane, useSelectTarget } from "./lib/useSelection.ts";
import { useAddressBar } from "./lib/useAddressBar.ts";
import { catchTypeAhead } from "./lib/typeAhead.ts";
import { goalStatusWord, sessionMenuLines, sizeWords, useSessionStats, workedWords } from "./lib/sessionStats.ts";

const APP_TITLE = "Ovis";
/** how soon after a key press a focus counts as the user's own (lastKeyAtRef) */
const KEY_FOCUS_MS = 1000;

/** Every slot of the split but `a` draws on connections of its own: several slots may attach one tab,
 *  and each attaches and detaches it as the others are not there (lib/split.ts). */
function SlotSessions({ slot, machineIds, children }: { slot: SplitSlot; machineIds: readonly string[]; children: ReactNode }) {
  return slot !== "a" ? <MachineSessionsProvider machineIds={machineIds}>{children}</MachineSessionsProvider> : <>{children}</>;
}

/** The header's note. Its status is in the header from the header's first render, clipped while empty
    (never display: none, as the connection chip), and its words land a frame after the box, even the
    ones a page opens with (lib/useAnnouncedText.ts). Its sentence is cut like the title it stands in
    for, under its own class: only the pane title carries .context-title-text, which the browser
    checks measure (scripts/mobile-tabs-regression.ts). */
function HeaderNote({ note }: { note: string | null }) {
  const shown = useAnnouncedText(note);
  return (
    <div className={shown === null ? "visually-hidden" : "context"}>
      <span className={shown === null ? undefined : "pill header-note"} role="status" style={{ minWidth: 0 }}>
        <span className="header-note-text">{shown}</span>
      </span>
    </div>
  );
}

/** The connecting shell's one sidebar line: the same announced status as every other (lib/useAnnouncedText.ts). */
function ConnectingNote() {
  const t = useT();
  const shown = useAnnouncedText(t("Connecting…"));
  return <p className={shown === null ? "visually-hidden" : "tree-state"} role="status">{shown}</p>;
}

/** The header's connection chip. It speaks only while the bridge is not live; live, it stays in the document
    for a screen reader (and the browser scripts that wait on it), drawn by nothing (styles.css). Its word lands
    a frame after the chip (lib/useAnnouncedText.ts), as every status line's does. */
function ConnectionChip({ connected, word, title, quiet }: { connected: boolean; word: string; title: string | undefined; quiet: boolean }) {
  const shown = useAnnouncedText(word);
  return (
    // quiet: the title area or the status bar says it in words (lib/headerConnection.ts), so the chip stays a live
    // region out of the flow (.conn.conn-quiet in styles.css): a dot that appears beside the lens switch would move
    // the switch and Files over by its width while reconnecting, and the header's controls hold their place (G-144).
    <span className={`conn ${connected ? "conn-live" : "conn-reconnecting"}${quiet ? " conn-quiet" : ""}`} role="status" title={title}>
      <span className="conn-dot" aria-hidden="true" />
      <span className="conn-text">{shown}</span>
    </span>
  );
}

/** The sidebar's head (from 769px): the Ovis wordmark in the theme's colours (ovis-site's logo pair). */
function SidebarBrand({ dark }: { dark: boolean }) {
  return (
    <div className="brand sidebar-brand">
      <img src={dark ? logoDark : logoLight} alt="Ovis" width="68" height="24" />
    </div>
  );
}

function Brand() {
  return (
    <h1 className="brand">
      <img src="/icons/icon-192.png?v=sheep1" alt="" width="22" height="22" className="brand-mark" />
      <span className="brand-name">
        Ovis
      </span>
    </h1>
  );
}

export function App() {
  const t = useT();
  const apple = /Mac|iPhone|iPad/.test(navigator.platform);
  const { settings, resolvedTheme, resolvedEntry, update: updateSettings } = useSettings();
  // the PCs this device hides cannot say their panes are gone (lib/namedAgentGroups.ts liveGroupKeys)
  const hiddenMachines = useHiddenMachines();
  const { alerts, alertsRef, alertsOn, alertsOnRef } = useAlertPrefs({ settings });
  const { machineSessions, machines, setMachines, machineRosterLoaded, setMachineRosterLoaded } = useRosterState();
  // the place the address names, read once at load: a link wins over this window's last selection
  const [initialLink] = useState(() => {
    // a link's lens is drawn over its pane's own, as a tapped notification's is (notificationViewTarget below)
    if (!linksSomewhere(pageSearch())) return null;
    const link = readLink(pageSearch());
    // a load onto an entry Settings left (a reload) steps out of it (lib/settingsHistory.ts): the
    // dialog its address names, on that entry or on the one stepped back to, is the one it closed
    return loadedOnSettingsEntry() ? { ...link, settings: null, section: null } : link;
  });
  useRecentFolderMemory({ machines });
  const { selectedMachineId, setSelectedMachineId, selectedMachine, snapshot } = useSelectedMachine({ initialLink, machines });
  const { machinesRef } = useMachinesRef({ machines });
  const [updateRemote, setUpdateRemote] = useState(false);
  const { machineDialog, setMachineDialog, addPcPreset, setAddPcPreset, addPcFocusReturn, closeMachineDialog } = useMachineDialog();
  const { newSessionMachineId, setNewSessionMachineId } = useNewSessionMachine();
  const { health, localFreshness, shownHealth, readLocalHealth } = useLocalHealth();
  const exposure = health?.lan_exposure ?? health?.direct_exposure;
  const exposureDirect = !health?.lan_exposure || health.lan_exposure.direct === true;
  const directNotice = useDirectNotice(serverIdOfPath(window.location.pathname) ?? "", directHostOf(health));
  const { error, setError } = useRosterError();
  const { layoutNotice, setLayoutNotice } = useLayoutNotice();
  const { locked, setLocked, lockReason, pairCode, consumePairCode, pairingUnconfirmed, onPaired, auth, canSignOut, security, readBridgeHealth } = useAccessState({ ui: settings.uiFontFamily, chat: settings.chatFontFamily });
  const { pairedNotices, setPairedNotices, dismissPairedNotice, relayPairings, setRelayPairings, remotePairings, setRemotePairings, removedNotices, setRemovedNotices, dismissRemovedNotice } = usePairedNotices();
  const updates = useUpdates(locked === false);
  const { selectedPaneId, setSelectedPaneId, notificationViewTarget, setNotificationViewTarget, terminalPeek, setTerminalPeek, endPeek, pendingLink, linkLanded, setLinkLanded, rosterSeq, linkSince, selectionSince, rosterTick, setRosterTick, linkTick, setLinkTick } = useSelectionState({ initialLink });
  const { otherRecheck, otherRosterTick, setOtherRosterTick } = useSplitRecheck();
  const { rosterIn, pendingFile, selectionHint, setHeaderNote, note, autoSelected, setAutoSelected } = useLinkLanding({ initialLink, otherRecheck, setOtherRosterTick, pendingLink, rosterSeq, setRosterTick, linkLanded, t });
  const { drawerOpen, setDrawerOpen, drawerOpenRef, wideScreen, sidebarCollapsed, setSidebarCollapsed, sidebarWidth, setSidebarWidth, filePanelAvailable, filePanelWidth, setFilePanelWidth, sidebarFilterRequest, openSidebarFilter } = useSidebarLayout({ initialLink });
  // Settings → Show the sidebar on hover: the collapsed sidebar over the pane for a moment (lib/sidebarPeek.ts)
  const { peeking: sidebarPeeking, sidebarRef: peekSidebarRef, toggleRef: peekToggleRef, toggleHandlers: peekToggleHandlers, sidebarHandlers: peekSidebarHandlers } = useSidebarPeek(settings.sidebarPeek && wideScreen && sidebarCollapsed);
  const { selectionRef, movingPanes } = useSelectionMark({ selectedMachineId, selectedPaneId });
  const { lens, setLens, viewPicks, setViewPicks } = usePaneLensState();
  const { split, setSplit, soloSlot, endSplit, splitRef, splitShownRef, lastKeyAtRef, paneDragging, setPaneDragging, gridDrop, gridDropRef, showGridDrop, hideDropTarget, clearDropPreview, paneAreaRef, tabDrag, draggedPaneRef, markSwap, markMove } = useSplitState();
  const { paletteOpen, paletteQuery, openPalette, setPaletteOpen } = useCommandPalette();
  const paneControls = useRef<PaneControls | null>(null);
  const [findRequest, setFindRequest] = useState<{ paneId: string | null; serial: number }>({ paneId: null, serial: 0 });
  // Search conversation over a pane's chat (ChatView): from the palette for the selected pane, from a pane's own menu for that one
  const { searchRequest, requestSearch } = useSearchRequest(setDrawerOpen);
  /** a pane's chat can be searched: it shows the chat, and its PC's bridge searches (an older one does not) */
  const searchable = (machineId: string, pane: HerdrPane, lens: PaneView): boolean =>
    showsChat(pane, lens) && machineSessions.peek(machineId)?.socket.canSearchConversation() === true;
  // the Rename tab shortcut and palette action: the tab strip of the selected pane opens its name field
  const { renameRequest, requestRename, clearRenameRequest } = useRenameRequest(selectedMachineId, selectedPaneId);
  // the header's More menu: its button
  const [more, setMore] = useState<{ anchor: HTMLElement } | null>(null);
  const closeMore = useCallback(() => setMore(null), []);
  // the pane canvas's actions, for the phone's tab menu (TabStrip)
  const paneActionsRef = useRef<((target: HerdrPane) => RowMenuItem[]) | null>(null);
  const { filesOpen, setFilesOpen, filesDocked, filesCovered, revealFiles, viewing, openFile, closeFile, leaveFile, restoreFile, fileFromPop, forgetLeftFiles, diffViewing, openDiff, closeDiff, releaseDiff, presentation, fileDocked, webPage, closeWebPage, openWebPage, openDiffFile, reportFileKind, toggleFilePresentation, viewFile } = useFilePanels({ settings, filePanelAvailable, selectedPaneId, selectedMachineId });
  // a diff's line notes go to its own pane: none while this window only watches that pane
  const diffPaneObserving = usePaneObserving(diffViewing?.paneId ? paneStorageId(diffViewing.machineId, diffViewing.paneId) : null);
  const { settingsOpen, setSettingsOpen, settingsLinkPage, setSettingsLinkPage, settingsLinkSection, setSettingsLinkSection, settingsPage, settingsSection, setSettingsSection, closeSettings, onSettingsPage } = useSettingsDialog(initialLink);
  const { newSessionOpen, setNewSessionOpen, newPrefill, setNewPrefill, newFields, setNewFields, pendingCreate, newTab, setNewTab, sessionHistory, setSessionHistory, worktreeFor, setWorktreeFor } = useNewSessionState({ initialLink, watching: auth?.role === "watch" });
  const { connected, setConnected, connectedBefore, setConnectedBefore, paneLost, outputStopped, setOutputStopped, reportedBy, setReportedBy } = useConnectionChip();
  const { notifications, setNotifications, pushOn, setPushOn, pushOnRef } = useNotificationState();
  // the shared settings and pins, the same in every browser of this server, once the app is in
  const { receive: receivePreferences, saveError: settingsSaveError, paused: settingsSavePaused, retrying: settingsSaveRetrying, retry: retrySettingsSave, resubscribed: preferencesResubscribed, disconnected: preferencesDisconnected, closed: preferencesClosed } = usePreferencesSync(locked === false);
  // labels from first messages (#2019): keyed once their pane is seen, gone with their pane, all gone with the setting off
  const tabLabelWatching = auth?.role === "watch";
  // a file is edited only from a browser that drives this PC, as the server checks too (server/file-edit.ts)
  const fileEditable = auth?.role === "drive" && auth.via !== "portal" && auth.via !== "open";
  useEffect(() => {
    setTabLabelLearning(settings.autoTabNames, tabLabelWatching);
    const settle = (): void => settleTabLabels(machines);
    settle();
    return subscribeTabLabels(settle);
  }, [machines, settings.autoTabNames, tabLabelWatching]);
  const receivePreferencesRef = useRef(receivePreferences); receivePreferencesRef.current = receivePreferences;
  const preferencesResubscribedRef = useRef(preferencesResubscribed); preferencesResubscribedRef.current = preferencesResubscribed;
  const preferencesDisconnectedRef = useRef(preferencesDisconnected); preferencesDisconnectedRef.current = preferencesDisconnected;
  const preferencesClosedRef = useRef(preferencesClosed); preferencesClosedRef.current = preferencesClosed;
  const { lockedRef } = useLockedRef({ locked });
  const { statusRef, turnStartRef, lastTurnRef, alertSoundRef } = useAlertRefs({ settings });
  const followFocusRef = useRef(settings.followHerdrFocus);
  followFocusRef.current = settings.followHerdrFocus;
  const { refetchTimer } = useRefetchTimer();
  const snapshotRef = useRef<typeof snapshot>(null);
  snapshotRef.current = snapshot;

  const loadHealth = useCallback(async () => {
    await readBridgeHealth();
    await readLocalHealth();
  }, []);
  usePairFromAddress({ locked, pairCode, auth, consumePairCode, onPaired, loadHealth });
  const { snapshotRequests, reorderCoordinator, load, scheduleRefetch, onRosterStream } = useRosterLoader({ locked, healthFailing: localFreshness === "unknown" || localFreshness === "unavailable", rosterIn, setMachines, setMachineRosterLoaded, setError, setLocked, loadHealth, lockedRef, refetchTimer });

  const { dropIn, chime, onRoster, onPaneStatus, onPaneExited } = useAlertSignals({ settings, selectionRef, drawerOpenRef, splitRef, splitShownRef, machinesRef, alertsRef, alertsOnRef, pushOnRef, statusRef, turnStartRef, lastTurnRef, alertSoundRef });

  // herdr moved a pane under a new ID, from anywhere (the server's pane-moved): followPaneMove below, called at the event
  useRosterEvents({ onPaneMoved: (machineId, from, to) => followPaneMove(machineId, from, to), machineSessions, locked, onRosterStream, receivePreferencesRef, snapshotRequests, onRoster, reorderCoordinator, setMachines, rosterIn, setMachineRosterLoaded, machinesRef, onPaneStatus, onPaneExited, followFocusRef, selectionRef, splitShownRef, splitRef, pendingLink, selectionHint, setSelectedPaneId, setNotificationViewTarget, setTerminalPeek, setAutoSelected, scheduleRefetch, preferencesResubscribedRef, preferencesDisconnectedRef, preferencesClosedRef, dropIn, chime, setPairedNotices, setRelayPairings, setRemotePairings, setRemovedNotices, getTakeNotificationTargetRef: () => takeNotificationTargetRef });

  const handleServerMessage = useServerMessageHandler(setOutputStopped);

  const { enableNotifications, disableNotifications, repairNotifications } = useNotificationSwitch({ updateSettings, locked, notifications, setNotifications, alerts, alertsRef, alertsOn, setPushOn });
  // the first-run setup guide: by itself once on a fresh install, again from Settings → Agents' Setup guide
  const localSnapshot = machines.find((machine) => machine.id === "local")?.snapshot ?? null;
  const setupGuide = useSetupGuide({
    enabled: locked === false,
    workspaces: machineRosterLoaded && localSnapshot !== null ? localSnapshot.workspaces.length : null,
    // undefined holds the decision until the access facts and this device's role are in: a failed read decides nothing
    pairingGate: security.state === "loading" || security.state === "error" || auth === null ? undefined : security.state === "known" ? security.summary.pairing_gate : null,
    watching: auth?.role === "watch",
  });
  const guideShown = setupGuide.guide !== null && !setupGuide.paused;


  const unlock = useCallback(() => {
    setLocked(false);
    void loadHealth();
    void load();
  }, [load, loadHealth]);

  // pasting the auth link into an already-open tab is a fragment-only navigation:
  // no reload happens, so the boot consumer never re-runs. Watch for the arrival
  // of the fragment instead; a wrong token just leaves the gate as it is.
  useEffect(() => {
    const onHashChange = (): void => {
      const linkToken = takeAuthTokenFromUrl();
      if (linkToken === null) return;
      void authenticate(linkToken)
        .then(unlock)
        .catch(() => undefined);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [unlock]);

  const lock = useCallback(async () => {
    setDrawerOpen(false);
    // before signOut: the unsubscribe call needs the cookie, and a locked device must stop
    // receiving pane titles
    await removePushSubscription().catch(() => undefined);
    setPushOn(false);
    resetPushHealth();
    let reload = false;
    try {
      ({ reload } = await endSignIn(auth?.via));
    } catch {
      throw new Error(t("Could not sign out. Try again."));
    } finally {
      // The response may have been lost after the cookie was cleared.
      if (!reload) await loadHealth();
    }
    if (reload) window.location.reload();
  }, [auth?.via, loadHealth, t]);

  const { selectedMachineRef, selectTarget, selectTargetRef, picks } = useSelectTarget({ selectedMachineId, setConnected, setConnectedBefore, setSelectedMachineId, setSelectedPaneId, setAutoSelected, setDrawerOpen, setOutputStopped, setNotificationViewTarget, setTerminalPeek, pendingLink, pendingFile, setLinkLanded, selectionHint, selectionSince, rosterSeq, snapshot, selectedMachine, selectedPaneId, setHeaderNote, linkTick, movingPanes, onPick: setupGuide.stepAside });

  const { selectPane } = useSelectPane({ pendingLink, pendingFile, setLinkLanded, selectionHint, setSelectedPaneId, setNotificationViewTarget, setTerminalPeek, setAutoSelected, setDrawerOpen, onPick: () => { picks.current += 1; setupGuide.stepAside(); } });

  const layoutRefused = useLayoutRefused(setLayoutNotice, t);
  const moveRefused = useMoveRefused(setLayoutNotice, t);
  // a pane's title dropped on another pane's title of its tab (useSplitLayout's drop)
  const swapPanes = (dragged: SplitTarget, targetPaneId: string): void => {
    void swapPaneWith(dragged.paneId, targetPaneId, dragged.machineId).then((swap) => {
      if (!swap.changed) {
        const reason = swap.reason === "cross_tab" ? t("The panes are in different tabs.")
          : swap.reason === "same_pane" ? t("Choose two different panes.")
          : swap.reason === "not_found" ? t("A pane is no longer available.")
          : swap.reason === "no_neighbor" ? t("There is no pane on that side.")
          : t("The pane swap could not be completed. Try again.");
        setLayoutNotice(t("Pane swap was refused: {reason}", { reason }));
      }
      void load();
    }).catch((err) => layoutRefused("pane swap failed", err));
  };
  // a pane's title dropped on another pane's body in its tab: it goes to that side of it (#1819)
  const movePanes = (dragged: SplitTarget, targetPaneId: string, side: PaneDirection): void => {
    void movePaneBeside(dragged.paneId, targetPaneId, side, dragged.machineId).then((move) => {
      const notice = paneMoveNotice(move, side, t);
      if (notice !== null) setLayoutNotice(notice);
      void load();
    }).catch((err: unknown) => { moveRefused(err); void load(); });
  };

  // what this browser keeps under the moved pane's ID goes to its new ID (lib/paneMove.ts), and wherever the old ID is
  // shown, in either half, the view goes with it (#1503). Nothing is sent: held text waits for its Send or Discard
  const followPaneMove = (machineId: string, from: string, to: string): void => {
    carryMovedPane(machineId, from, to);
    // its lock goes with its pin (lib/paneLocks.ts), and its named group the same way (lib/namedAgentGroups.ts): read from
    // the settings as this save stores them, when the change applies: this call may come from an older render's event,
    // another tab may have saved since, and storage may refuse writes (#2977)
    updateSettings(({ lockedAgents, agentGroupOf }) => ({
      lockedAgents: [...movedSidebarPins(lockedAgents, machineId, from, to)],
      agentGroupOf: { ...movedAgentGroup(agentGroupOf, machineId, from, to) },
    }));
    const view = movedView(selectionRef.current, splitRef.current, machineId, from, to);
    if (view.split !== null) setSplit(view.split);
    if (view.selection !== null) selectTargetRef.current(machineId, view.selection);
  };
  const { takeNotificationTargetRef } = useNotificationTargets({ machinesRef, selectTargetRef, selectionHint, pendingLink, pendingFile, setLinkLanded, linkSince, rosterSeq, setLinkTick, load });


  const { selectedPane } = useSelectedPane({ snapshot, selectedPaneId });
  useScreenWakeLock(settings.keepScreenOn && locked === false && selectedPane !== null);
  const { selectedWorkspace, presentedPaneId } = useSelectedLayout({ selectedPane, snapshot, drawerOpen, selectedMachineId, selectedPaneId, setSelectedPaneId, setAutoSelected });
  // the selected pane has a tab strip to rename in: its pane and workspace are in the roster
  const tabStripMounted = selectedPane !== null && selectedWorkspace !== null;
  const targetHerdr = selectedMachineId === "local" ? health?.herdr : selectedMachine?.herdr;
  // the layout calls the selected PC's herdr answers (lib/machineContext.tsx AppLayoutContext): the palette and the
  // shortcuts offer only those; each PC's own value goes to its sidebar and its half
  const appLayout = appLayoutOf(targetHerdr);
  const herdrOn = (machineId: string) => machineId === "local" ? health?.herdr : machines.find((machine) => machine.id === machineId)?.herdr;
  const appLayoutOn = (machineId: string) => appLayoutOf(herdrOn(machineId));
  // the herdr the header names as current: this PC's last answer only while it is still shown (through one
  // failed read, not once unavailable), though its capabilities stay in targetHerdr
  const shownHerdr = selectedMachineId === "local" ? shownHealth?.herdr : targetHerdr;
  // Pictures in the terminal not chosen on this device: what the PC's terminal connection does (its
  // `terminal-history`, as PaneTerminal reads it), the health read only until that connection listed its features
  const shownTerminal = machineSessions.peek(selectedMachineId)?.socket;
  const picturesByDefault = shownTerminal?.hasTerminalHistory() === true
    || (shownTerminal?.featuresListed() !== true && shownHerdr?.runtime === "herdr-core" && shownHerdr.terminal_attach !== false);
  const selectedTitle = selectedPane ? displayPaneTitle(selectedPane) : null;
  // the tab that governs the pane region, so the strip's tabs and the pane they select are
  // one thing to a screen reader (A4); null while no tab owns this pane
  const tabPanelLabel = paneTabPanelLabel(snapshot, selectedPane, t);
  const selectedAgent = selectedPane?.agent ?? null;
  // a herdr not heard from yet (or a server that predates the flag) counts as attach-capable; a failed
  // health read keeps this PC's last answer (lib/healthPresentation.ts)
  // a server that repaints the pane's screen instead (terminal_mirror) has a terminal lens too
  const terminalAttach = targetHerdr?.terminal_attach !== false || targetHerdr?.terminal_mirror === true;
  // the same rule for any PC: a press on another PC's pane asks its lens as a pick there would
  const attachOn = (machineId: string): boolean => { const herdr = herdrOn(machineId); return herdr?.terminal_attach !== false || herdr?.terminal_mirror === true; };

  const { lenses, view, pressPane } = usePaneLens({ settings, selectedPaneId, selectedMachineId, selectedPane, selectedAgent, terminalAttach, attachOn, notificationViewTarget, setNotificationViewTarget, lens, setLens, viewPicks, terminalPeek, setTerminalPeek });
  // a peek shows the terminal over the chat: nothing there to search
  const selectedSearchable = selectedPane !== null && terminalPeek === null && searchable(selectedMachineId, selectedPane, view);

  const contentKey = paneContentKey(selectedMachine, selectedPane, view);
  const { dialogCover, webDialogCover, contentReady } = usePaneCoverage({ contentKey });
  // covered by something (closing it brings the pane into view again), or in view with its content still loading
  const panePresence = useCallback((): PanePresence => !(locked === false && linkLanded && pendingFile.current === null && pendingCreate.current === null
    && !drawerOpen && !settingsOpen && !newSessionOpen
    && !(filesOpen && !filesDocked) && !machineDialog && !paletteOpen && !diffViewing && !(viewing && !fileDocked)
    && !dialogCover && !paneCovered()) ? "covered"
    : contentReady && paneContentPresented(contentKey) ? "front" : "loading",
  [locked, linkLanded, drawerOpen, settingsOpen, newSessionOpen, filesOpen, filesDocked, machineDialog, paletteOpen, diffViewing, viewing, fileDocked, dialogCover, contentReady, contentKey]);
  // one source for the sidebar's two lists: live counters per PC and finishes looked at here
  const activity = useSidebarActivityState(machines, selectedMachineId, presentedPaneId, panePresence, shareSeen);

  const { pickView, setView } = usePaneViewPicks({ setViewPicks, setNotificationViewTarget, setTerminalPeek, setLens, setAutoSelected, selectedPaneId, selectedMachineId });
  const { unsentFor, openUnsent, closeUnsent, recover } = useUnsentRecovery({ selectedMachineId, selectedPaneId, setView, pickView });
  // on a phone a peek is a step of its own: Back takes the chat back, as it closes a sheet. It stays
  // up under a sheet or Settings opened over it: their close, or a Back, comes back to the peek
  usePhoneSheetBack(() => endPeek(), terminalPeek !== null, true);

  const { splitOn, others, shownSlots, rects, follows, activateSlot, closeSlot, selectInSlot, dockSide, splitDragOn, paneDragOver, paneDragLeave, paneDrop, dividers, resizeDivider, gridPreview } = useSplitLayout({ machines, split, wideScreen, selectedPaneId, selectedPane, selectedMachineId, splitShownRef, health, machineRosterLoaded, endSplit, otherRecheck, otherRosterTick, setSplit, soloSlot, setConnected, setConnectedBefore, setSelectedMachineId, setSelectedPaneId, setAutoSelected, setOutputStopped, splitRef, selectPane, paneAreaRef, gridDrop, gridDropRef, clearDropPreview, tabDrag, showGridDrop, hideDropTarget, setPaneDragging, movingPanes, draggedPaneRef, markSwap, markMove, swapPanes, movePanes, arrangeRefused: (machineId) => !appLayoutOn(machineId).arrange });

  useAddressBar({ newSessionOpen, selectedPane, selectedPaneId, selectedWorkspace, viewing, selectedMachineId, leaveFile, restoreFile, fileFromPop, forgetLeftFiles, locked, machines, snapshot, linkLanded, view, settingsOpen, settingsPage, settingsLinkPage, settingsLinkSection, wideScreen, sidebarCollapsed, newTab, newFields, autoSelected, pendingFile, selectedMachine, openFile, machinesRef, selectTargetRef, pendingLink, setLinkLanded, linkSince, rosterSeq, setNewSessionOpen, pendingCreate, setHeaderNote, selectionRef });


  const { bell, alertsOffDot } = alertsBell({ t, alertsOn, notifications, pushOn, enableNotifications, disableNotifications });
  const connWord = t(connected ? "live" : outputStopped ? "disconnected" : connectedBefore ? "reconnecting" : "connecting");
  // each split half has sockets of its own, even on one PC: the line is about the active half's
  const headerConnection = useHeaderConnection({ scope: `${split ? split.active : soloSlot}:${selectedMachineId}`, reportedBy, connected, connectedBefore, outputStopped });
  // the selected pane's chat totals (lib/sessionStats.ts): after the crumb from 769px, and in More
  const session = useSessionStats(selectedMachineId, selectedPane?.pane_id ?? null);
  const sessionLines = session === null ? null : sessionMenuLines(session);
  const sessionShort = session === null ? [] : [workedWords(session), sizeWords(session)].filter((part) => part !== null);
  const crumb = selectedPane && selectedTitle !== null
    ? headerCrumb({ machine: selectedMachine?.name ?? selectedMachineId, machineCount: machines.length, workspace: selectedWorkspace?.label ?? selectedPane.workspace_id, title: selectedTitle, cwd: selectedPane.cwd })
    : null;
  const tabPlace = snapshot ? tabPosition(snapshot, selectedPaneId) : null;
  const position = tabPlace && { ...tabPlace, words: t("Tab {index} of {count}", { index: tabPlace.index, count: tabPlace.count }) };

  const tabTitle = selectedPane ? tabPaneTitle(selectedPane) : null;
  useEffect(() => {
    document.title = tabTitle ? `${tabTitle} · Ovis` : APP_TITLE;
  }, [tabTitle]);

  // A new tab's workspace: the named one, else the selected pane's. Its folder is the workspace's:
  // a worktree's checkout, else where the pane in front (the selected one, else the one herdr has
  // in front, else the first) is. Read from refs, so the actions keep no stale roster.
  const newTabTarget = (target?: { machineId: string; workspaceId: string }) => {
    const machineId = target?.machineId ?? selectionRef.current.machineId;
    const roster = machinesRef.current.find((m) => m.id === machineId)?.snapshot;
    // pane ids repeat across PCs: the selected pane counts only on the PC the tab is for
    const selectedPaneId = selectionRef.current.machineId === machineId ? selectionRef.current.paneId : null;
    const workspaceId = target?.workspaceId ?? roster?.panes.find((pane) => pane.pane_id === selectedPaneId)?.workspace_id;
    const workspace = roster?.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
    if (!roster || !workspace) return null;
    const panes = roster.panes.filter((pane) => pane.workspace_id === workspace.workspace_id);
    const inFront = panes.find((pane) => pane.pane_id === selectedPaneId)
      ?? panes.find((pane) => pane.pane_id === roster.layouts?.find((layout) => layout.tab_id === workspace.active_tab_id)?.focused_pane_id)
      ?? panes[0];
    return { machineId, workspace, cwd: workspace.worktree?.checkout_path ?? inFront?.cwd ?? null, agent: inFront?.agent ?? null, panes };
  };

  const actions = useMemo<AppActions>(
    () => ({
      selectPane,
      selectAdjacentPane: (direction) => {
        // the panes the sidebar lists: a step never lands on a viewer it leaves out
        const panes = rosterPanes(snapshotRef.current?.panes ?? [], selectedPaneId);
        if (panes.length === 0) return;
        const index = panes.findIndex((pane) => pane.pane_id === selectedPaneId);
        const next = panes[(index + direction + panes.length) % panes.length];
        if (next) selectPane(next.pane_id);
      },
      selectAdjacentTab: (direction) => {
        const roster = snapshotRef.current;
        const viewed: ViewedPane = (scope, id) => lastViewedPane(scope, selectedMachineId, id);
        const next = roster ? adjacentTabPane(roster, selectedPaneId, direction, viewed) : null;
        if (next) selectPane(next);
      },
      selectTabNumber: (number) => {
        const roster = snapshotRef.current;
        const viewed: ViewedPane = (scope, id) => lastViewedPane(scope, selectedMachineId, id);
        const next = roster ? numberedTabPane(roster, selectedPaneId, number, viewed) : null;
        if (next) selectPane(next);
      },
      selectAdjacentWorkspace: (direction) => {
        const roster = snapshotRef.current;
        if (!roster) return;
        // the rows the sidebar draws, as it draws them; a PC folded in it has none drawn, so its rows are
        // worked out as they would be: a drag's order until herdr has it, pins first, saved folds left out
        const unfolded = (): string[] => {
          const byId = new Map(roster.workspaces.map((workspace) => [workspace.workspace_id, workspace]));
          const ordered = reorderCoordinator.order(selectedMachineId, roster.workspaces.map((workspace) => workspace.workspace_id)).flatMap((id) => byId.get(id) ?? []);
          const selectedWorkspaceId = roster.panes.find((pane) => pane.pane_id === selectedPaneId)?.workspace_id ?? null;
          const folded = (repoKey: string) => repoKey !== "" && storedWorktreeCollapsed(selectedMachineId, [repoKey]).has(repoKey);
          const backgroundFolded = settings.sidebarBackgroundWorkspaces ? storedBackgroundFolded(selectedMachineId) : null;
          const blocked = new Set(roster.panes.filter((pane) => pane.agent_status === "blocked").map((pane) => pane.workspace_id));
          return sidebarWorkspaceSteps(ordered, pinnedWorkspaceIds(currentSidebarPins(), selectedMachineId), folded, selectedWorkspaceId, backgroundFolded, blocked);
        };
        const order = drawnWorkspaceRows(selectedMachineId) ?? unfolded();
        const viewed: ViewedPane = (scope, id) => lastViewedPane(scope, selectedMachineId, id);
        const next = adjacentWorkspacePane(roster, order, selectedPaneId, direction, viewed);
        if (next) selectPane(next);
      },
      setView,
      // a peek shows the terminal over the chat: the shortcut takes the chat back, the lens stays Chat
      toggleView: () => { if (terminalPeek !== null) endPeek(); else setView(view === "chat" ? "terminal" : "chat"); setDrawerOpen(false); },
      focusInput: () => paneControls.current?.focusInput(),
      scrollPage: (direction) => paneControls.current?.scrollPage(direction),
      openNewSession: () => {
        setDrawerOpen(false);
        setNewSessionMachineId(selectedMachineId);
        setNewTab(null);
        setNewSessionOpen(true);
      },
      openNewTab: (target) => {
        const found = newTabTarget(target);
        if (!found) return;
        const { machineId, workspace, cwd } = found;
        setDrawerOpen(false);
        setNewSessionMachineId(machineId);
        setNewTab({ workspaceId: workspace.workspace_id, workspaceLabel: workspace.label, cwd, number: workspace.tab_count + 1 });
        setNewSessionOpen(true);
      },
      renameTab: () => {
        // a PC whose herdr renames no tab (lib/machineContext.tsx AppLayoutContext)
        if (selectedPaneId === null || !tabStripMounted || !appLayout.rename) return;
        setDrawerOpen(false);
        requestRename(selectedMachineId, selectedPaneId);
      },
      openTerminalTab: async (target) => {
        const found = newTabTarget(target);
        if (!found) return;
        const asked = selectionRef.current;
        // the keys typed from now on are the new tab's (lib/typeAhead.ts)
        const ahead = catchTypeAhead();
        let created: Awaited<ReturnType<typeof createTab>>;
        try {
          created = await createTab({ workspace_id: found.workspace.workspace_id, cwd: found.cwd, label: null, agent: null }, found.machineId);
        } catch (reason) {
          ahead?.drop();
          throw reason;
        }
        void load();
        // what the user went to while herdr answered is theirs to keep
        const still = selectionStill(asked, selectionRef.current);
        // the keys typed ahead are this tab's either way: held for it when the user went elsewhere meanwhile
        ahead?.handTo(found.machineId, created.pane_id, still);
        if (still) selectTargetRef.current(found.machineId, created.pane_id);
      },
      moveTabToWorkspace: async ({ machineId, tabId, workspaceId, notice }) => {
        const roster = machinesRef.current.find((m) => m.id === machineId)?.snapshot;
        const from = roster?.panes.find((pane) => pane.tab_id === tabId)?.pane_id ?? null;
        const moving = from === null ? null : paneStorageId(machineId, from);
        if (moving !== null) movingPanes.current.add(moving);
        try {
          const moved = await moveTabToWorkspace(tabId, workspaceId, machineId);
          if (from === null) return;
          // the pane changed its ID with its workspace: what was kept under the old one, and the view showing it,
          // go with it; the server's pane-moved for the same move finds nothing left to carry
          followPaneMove(machineId, from, moved.pane_id);
        } catch (err) {
          if (notice) moveRefused(err);
          throw err;
        } finally {
          if (moving !== null) movingPanes.current.delete(moving);
          void load();
        }
      },
      openSessionHistory: (target) => {
        const found = newTabTarget(target);
        if (!found) return;
        // a pane's own agent, or nothing; for a workspace, the agent named, else the pane in front's, else any of it
        const agent = sessionHistoryListAgent(target, found.agent, found.panes.map((pane) => pane.agent));
        if (agent === null) return;
        // Claude's list prefers a pane running Claude, so a selected shell never hides its store.
        const selected = selectionRef.current.machineId === found.machineId ? selectionRef.current.paneId : null;
        const tabs = machinesRef.current.find((m) => m.id === found.machineId)?.snapshot?.tabs ?? [];
        const tabNumber = (tabId: string) => tabs.find((tab) => tab.tab_id === tabId)?.number ?? Number.MAX_SAFE_INTEGER;
        const askingPaneId = target?.paneId ?? null;
        const paneId = sessionHistorySourcePane(agent, [...found.panes].sort((one, other) => tabNumber(one.tab_id) - tabNumber(other.tab_id)), { workspaceId: found.workspace.workspace_id, askingPaneId, selectedPaneId: selected });
        setDrawerOpen(false);
        setSessionHistory({ machineId: found.machineId, workspaceId: found.workspace.workspace_id, agent, paneId, askingPaneId, selectedPaneId: selected });
      },
      openWorktree: (mode) => {
        const found = newTabTarget();
        // the workspaces the sidebar and the palette offer worktrees for (lib/repositoryWorkspaces.ts)
        const machine = machinesRef.current.find((candidate) => candidate.id === found?.machineId);
        if (!found || machine?.state !== "connected" || !worktreesStartHere(found.machineId, found.workspace)) return;
        setDrawerOpen(false);
        setWorktreeFor({ machineId: found.machineId, machineName: machine.name, workspace: found.workspace, mode });
      },
      openPalette,
      agentStarted: (machineId, paneId) => lenses.startedAgent(lensOwner(machineId, paneId), window.matchMedia?.("(pointer: coarse)").matches === true),
      openFind: () => {
        if (selectedPaneId === null) return;
        // a peek already shows the pane's terminal: find searches it there, and the peek (its return,
        // and the lens and address under it) stays
        if (terminalPeek?.paneId !== selectedPaneId || terminalPeek.machineId !== selectedMachineId) setView("terminal");
        setDrawerOpen(false);
        setFindRequest((request) => ({ paneId: selectedPaneId, serial: request.serial + 1 }));
      },
      openSettings: () => {
        setDrawerOpen(false);
        setSettingsSection(null);
        setSettingsOpen(true);
      },
      openAddPc: (preset) => {
        // the new PC reports its progress in the sidebar: nothing should sit over it
        setSettingsOpen(false);
        setUpdateRemote(false);
        addPcFocusReturn.current = true;
        setAddPcPreset(preset ?? null);
        setMachineDialog("new");
      },
      connectPc: (machine) => {
        setSettingsOpen(false);
        setUpdateRemote(false);
        addPcFocusReturn.current = true;
        setMachineDialog(machine);
      },
      toggleSidebar: () => {
        if (window.matchMedia("(max-width: 768px)").matches) setDrawerOpen((open) => !open);
        else setSidebarCollapsed((collapsed) => !collapsed);
      },
      openSidebarFilter,
      toggleTheme: () => updateSettings({ theme: resolvedTheme === "dark" ? "light" : "dark" }),
      lock: canSignOut ? lock : null,
      enableNotifications: bell.run === enableNotifications ? () => void enableNotifications() : null,
      refresh: () => void load(),
      openFiles: selectedPaneId !== null ? () => { setDrawerOpen(false); revealFiles(); } : null,
      // the page is this PC's whichever PC is selected: the browser reaches it under the app's own host,
      // which in the hosted shell is not the PC (and its frame-src frames no other port)
      openLocalPage: settings.webLinks === "panel" && shellMode() !== "relay" ? (url) => { setDrawerOpen(false); openWebPage(url, false, LOCAL_MACHINE); } : null,
      searchConversation: selectedSearchable && selectedPaneId !== null ? () => requestSearch(split ? split.active : soloSlot, selectedMachineId, selectedPaneId) : null,
      // herdr's layout calls on the selected pane (lib/layoutActions.ts): only those the PC's herdr answers
      ...layoutActions({ selectedPaneId, offer: appLayout, paneSplits: !selectedPane?.own_tab, selection: selectionRef, roster: snapshotRef, load, selectPane, layoutRefused }),
    }),
    [revealFiles, selectPane, selectedPaneId, selectedPane?.own_tab, selectedMachineId, appLayout, reorderCoordinator, tabStripMounted, setView, view, terminalPeek, endPeek, updateSettings, resolvedTheme, canSignOut, lock, bell.run, enableNotifications, load, layoutRefused, moveRefused, lenses, openSidebarFilter, selectedSearchable, requestSearch, split, soloSlot, settings.webLinks, settings.sidebarBackgroundWorkspaces, openWebPage],
  );

  useShortcuts(actions, locked === false);
  const herdrPrefixWaiting = useHerdrPrefixKeys(actions, locked === false, setLayoutNotice);

  // The header's More menu: what used to be three buttons of its own. Each item is there under
  // the condition its button had. At phone width the palette's button gives its room to the
  // pane's title, and the menu's first item opens the palette.
  useMachineGone({ machines, pendingLink, pendingFile, pendingCreate, selectedMachineRef, linkSince, selectionSince, rosterSeq, setLinkLanded, setHeaderNote, selectTargetRef, rosterTick, linkTick });
  // the PCs this device shows in its sidebar, Agents list and palette (Settings → Devices and PCs); every other
  // use of the roster keeps them all, so a link, an alert or a split still reaches a hidden PC's pane
  const sidebarMachines = useShownMachines({ machines, selectedMachineRef, selectTargetRef, picks, restored: !linkSelects(initialLink) });
  // every connected PC's sessions as its sidebar draws them, so the "waiting for you" count and its next jump
  // triage the same set the Agents list shows (G-002), and the selected PC's even when the sidebar hides it (lib/headerSessions.ts)
  const waitingRosters = useWaitingRosters(sidebarMachines, machines.find((machine) => machine.id === selectedMachineId), activity.status);
  const sessionTally = sessionCountsAcross(waitingRosters);
  const nextWaiting = nextWaitingTarget(waitingRosters, { machineId: selectedMachineId, paneId: selectedPaneId });
  const openNextWaiting = (): void => { if (nextWaiting !== null) selectTarget(nextWaiting.machineId, nextWaiting.paneId); };

  // a link to the New workspace dialog opens it once the PCs are in; one for a tab, once the
  // linked workspace's pane is selected (its folder is the workspace's, as the tab strip's + does)
  const [createTick, setCreateTick] = useState(0);
  useEffect(() => {
    const linked = pendingCreate.current;
    if (linked === null || !linkLanded || machines.length === 0 || newSessionOpen) return;
    if (linked.kind === "tab" && !selectedPane) return;
    pendingCreate.current = null;
    const fields = { cwd: linked.cwd, name: linked.name, agent: linked.agent };
    setNewPrefill(fields);
    setNewFields(fields);
    if (linked.kind === "tab") actions.openNewTab({ machineId: selectedMachineId, workspaceId: selectedPane!.workspace_id });
    else { setNewSessionMachineId(selectedMachineId); setNewTab(null); setNewSessionOpen(true); }
  }, [linkLanded, machines.length, newSessionOpen, selectedPane, selectedMachineId, actions, createTick]);
  // Forward onto an entry the dialog was open on: the popstate above leaves it pending
  useEffect(() => {
    const onPop = (): void => setCreateTick((tick) => tick + 1);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const { closeNewSession, closeSessionHistory, recentResumes, rememberResume, sessionHistoryWorkspace } = useSessionHistoryList({ machines, sessionHistory, setSessionHistory, setNewSessionOpen, setNewPrefill, setNewFields });

  // the palette's shortcut, said beside its item where a hardware keyboard is likely (a fine pointer)
  const keyboardLikely = useMediaQuery("(hover: hover) and (pointer: fine)");
  const paletteKeys = keyboardLikely ? formatKeys(shortcutDisplayKeys("palette", settings.shortcutOverrides)).join("+") : "";
  // A tooltip follows the platform and the current binding, including a removed shortcut.
  const shortcutTitle = (label: string, id: "palette" | "toggle-sidebar" | "toggle-view"): string => {
    const keys = formatKeys(shortcutDisplayKeys(id, settings.shortcutOverrides));
    return keys.length === 0 ? label : `${label} (${keys.join("+")})`;
  };
  // a phone's More opens a bottom sheet, a dialog, not a menu (RowMenu at SHEET_QUERY): the button says which
  const isSheetWidth = useMediaQuery(SHEET_QUERY);
  // a phone's open drawer is a dialog over the pane (G-003): Tab stays in it, the pane column is inert under it, Escape
  // closes it and the focus goes back to the toggle that opened it (lib/headerSessions.ts useDrawerDialog)
  // only once the shell is drawn: a drawer a link opens behind the access gate takes its focus when it mounts
  const drawerModal = locked === false && drawerOpen && !wideScreen;
  const { ref: drawerRef } = useDrawerDialog(drawerModal, setDrawerOpen, [peekSidebarRef]);
  // a phone (the sheets' width) draws no tab row: the header's title lists the tabs (TabStrip's sheet),
  // as the Codex and Claude apps title a thread and list the others from it
  const { tabsInHeader, sheet: tabSheet, toggle: toggleTabSheet, close: closeTabSheet } = useTabSheet(selectedPane !== null && !guideShown ? JSON.stringify([selectedMachineId, selectedPane.workspace_id]) : null);
  // there, and for a lone tab on a cramped phone, the row and its pane's ellipsis are not drawn (TabStrip,
  // PaneCanvas): the header's own ellipsis is the one menu, so it carries the pane's and the tab's actions too.
  // They come from the canvas's last render; each runs as the canvas's latest one has it, and does
  // nothing when that one no longer offers it (the pane or the layout changed while the menu was open)
  const cramped = useMediaQuery(CRAMPED_QUERY);
  const paneMenuInMore = selectedPane !== null
    && tabRowHidden(cramped, snapshot?.tabs.filter((tab) => tab.workspace_id === selectedPane.workspace_id).length ?? 0, tabsInHeader);
  // More's first item jumps to the next session waiting for you, and where no status bar says it, a
  // waiting-coloured dot on its button says how many. A phone's header also counts the running and the
  // unseen finished sessions beside it (components/HeaderCounts.tsx); a wider screen's sidebar shows them
  const waitingInMore = sessionTally.waiting > 0;
  const currentTabInMore = paneMenuInMore && selectedPane ? snapshot?.tabs.find((tab) => tab.tab_id === selectedPane.tab_id) : undefined;
  const currentTabPlace = currentTabInMore && snapshot ? snapshot.tabs.filter((tab) => tab.workspace_id === selectedPane!.workspace_id).indexOf(currentTabInMore) + 1 : 1;
  const currentTabName = currentTabInMore ? (customTabLabel(currentTabInMore, currentTabPlace) ?? tabLabel(currentTabInMore, t, currentTabPlace)) : null;
  const paneMoreItems = paneMenuInMore && selectedPane ? (paneActionsRef.current?.(selectedPane) ?? []).map((item, index): RowMenuItem => ({
    ...item, divider: index === 0 || item.divider,
    ...(item.id === "rename-tab" && currentTabName ? { hint: currentTabName, title: `${item.label} · ${currentTabName}` } : {}),
    run: () => paneActionsRef.current?.(selectedPane).find((fresh) => fresh.id === item.id)?.run(),
  })) : [];
  const moreBase = alertsOffDot ? t("More · alerts are off") : t("More");
  const moreLabel = waitingInMore ? `${moreBase} · ${t("{count} waiting for you", { count: sessionTally.waiting })}` : moreBase;
  const moreItems: RowMenuItem[] = [
    ...(waitingInMore && nextWaiting !== null ? [{ id: "next-waiting", label: t("Open the next session waiting for you"), hint: String(sessionTally.waiting), icon: CircleHelp, run: openNextWaiting }] : []),
    // first at every width: a phone's header has no palette button, and a touch screen no shortcut
    { id: "palette", label: t("Search panes and actions"), icon: Search, ...(paletteKeys ? { hint: paletteKeys } : {}), run: () => openPalette() },
    ...(selectedPane && !selectedPane.restore_error ? [{ id: "find", label: t("Find in terminal"), icon: Search, run: actions.openFind }] : []),
    // from 769px Files has its own button beside the lens switch; a phone keeps it here
    ...(selectedPane && !wideScreen ? [{ id: "files", label: t("Browse files"), icon: FolderOpen, run: () => setFilesOpen(true) }] : []),
    // the address says where the app is (lib/deepLink.ts); a phone has no address bar to copy it from
    { id: "copy-link", label: t("Copy link"), icon: Link, run: () => void copyText(window.location.href).then((ok) => { if (ok) setHeaderNote("copied"); }) },
    { id: "alerts", label: t("Alerts"), hint: bell.state, checked: bell.on, title: bell.title, icon: Bell, run: () => void bell.run() },
    ...paneMoreItems,
  ];

  // the chat's surface is what the pane column shows: the header's pane zone and the tab strip
  // take it (from 769px). A pane herdr could not restore draws a placeholder, not the chat.
  const chatShown = showsChat(selectedPane, view);
  // From 769px with one pane in view the header is one row, a browser's tab strip: the workspace's tabs and +,
  // then the lens switch, Files and More (styles.css .header-tabs, THIRD_PARTY_NOTICES.md). A split keeps a
  // strip per half and the title here; a phone keeps the title that lists the tabs.
  const stripInHeader = wideScreen && !splitOn && !tabsInHeader && !guideShown && snapshot !== null && selectedPane !== null && selectedWorkspace !== null;
  // from 769px with a mouse the pane column ends in the Herdr app's status bar: where the pane is, its branch,
  // the connection. A touch screen keeps that room for its key bar and says them in More and the chip.
  const statusBarShown = wideScreen && keyboardLikely && selectedPane !== null && crumb !== null && !guideShown;
  const waitingDot = waitingInMore && !statusBarShown;

  if (locked === null) {
    // the auth state is unknown until /api/health or /api/session answers (ten seconds when
    // herdr is down): show the shell without the terminal, and so without a WebSocket,
    // instead of a blank page
    return (
      <div className="app">
        <header className="app-header">
          <Brand />
        </header>
        <div className="app-body">
          <aside className="sidebar">
            <ConnectingNote />
          </aside>
          <main className="terminal-host">
            <div className="terminal-placeholder">
              <div className="terminal-placeholder-inner">
                <span>{t("Connecting to Ovis…")}</span>
              </div>
            </div>
          </main>
        </div>
      </div>
    );
  }
  if (locked) return <AccessGate reason={lockReason} initialCode={pairCode} consumePairCode={consumePairCode} pairingUnconfirmed={pairingUnconfirmed} onPaired={onPaired} onUnlocked={unlock} />;

  // Files beside the pane (opt-in, wide windows) shares the docked file's place: shown while no docked
  // file or web page covers it, and kept mounted under one so its folder and tab are there again after
  const filesBeside = filesOpen && filesDocked && selectedPane !== null && !filesCovered;
  const toggleFiles = (): void => {
    if (filesBeside) setFilesOpen(false);
    else revealFiles();
  };
  const filesDialog = (docked: boolean): ReactNode => selectedPane && (
    <FilesDialog docked={docked} covered={docked && filesCovered} panelStart={docked ? <FilePanelResizer width={filePanelWidth} onResize={setFilePanelWidth} /> : undefined}
      start={selectedPane.foreground_cwd ?? selectedPane.cwd ?? ""} paneId={selectedPane.pane_id} viewing={(viewing !== null && !fileDocked) || diffViewing !== null} onOpenFile={viewFile}
      onOpenDiff={(comparison, file) => openDiff({ machineId: selectedMachineId, paneId: selectedPane.pane_id, directory: selectedPane.foreground_cwd ?? selectedPane.cwd ?? null, ...comparison, path: file.path, oldPath: file.old_path })}
      onBrowseFolders={(path) => actions.openPalette(folderQueryFor(path, null))}
      machineName={selectedMachineId !== LOCAL_MACHINE || machines.length > 1 ? selectedMachine?.name : undefined}
      onClose={() => setFilesOpen(false)} />
  );

  return (
    <MachineSessionsProvider sessions={machineSessions} machineIds={machines.map((machine) => machine.id)}><MachineContext.Provider value={selectedMachineId}><AppLayoutContext.Provider value={appLayout}><div className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}`} style={sidebarWidth === null && filePanelWidth === null ? undefined : {
      ...(sidebarWidth === null ? {} : { "--sidebar-user-w": `${sidebarWidth}px` }),
      ...(filePanelWidth === null ? {} : { "--file-panel-user-w": `${filePanelWidth}px` }),
    } as CSSProperties}>
      {selectedPane !== null && !guideShown && <h1 className="visually-hidden">{selectedTitle}</h1>}
      <header className={`app-header is-zoned${chatShown ? " is-chat" : ""}${stripInHeader ? " has-tab-row" : ""}`}>
        {/* is-zoned tells this header from the connecting shell's, which has no zones to draw.
            .header-side is the sidebar's own top row from 769px (styles.css); below that its
            buttons sit in the bar */}
        <div className="header-side">
          {wideScreen && !sidebarCollapsed && <SidebarBrand dark={resolvedTheme === "dark"} />}
          <button
            type="button"
            id="drawer-toggle"
            className="icon-button drawer-toggle"
            aria-label={t(drawerOpen ? "Close workspace list" : "Open workspace list")}
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
            aria-controls="workspace-drawer"
            onClick={() => setDrawerOpen((open) => !open)}
          >
            {drawerOpen ? <X /> : <Menu />}
          </button>
          {((wideScreen && !sidebarCollapsed) || (!wideScreen && drawerOpen)) && settings.sidebarRows !== "two" && <button type="button" id="drawer-new-workspace" className="icon-button new-workspace-button" disabled={auth?.role === "watch" || selectedMachine?.state !== "connected"} aria-label={t("New workspace")} title={auth?.role === "watch" ? `${t("New workspace")} · ${t("View only")}` : t("New workspace")} onClick={() => actions.openNewSession()}>
            <Plus aria-hidden="true" />
          </button>}
          <button type="button" className="icon-button palette-button" aria-label={t("Command palette")} title={shortcutTitle(t("Command palette"), "palette")} onClick={() => openPalette()}>
            <Search />
          </button>
          <button
            type="button"
            className="icon-button header-desktop-only sidebar-toggle"
            aria-label={t(sidebarCollapsed ? "Show workspace list" : "Hide workspace list")}
            aria-pressed={!sidebarCollapsed}
            title={shortcutTitle(t("Toggle sidebar"), "toggle-sidebar")}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            ref={peekToggleRef}
            {...peekToggleHandlers}
          >
            <PanelLeft />
          </button>
        </div>
        <HeaderNote note={herdrPrefixWaiting ? t("herdr prefix: press a key") : note} />
        {stripInHeader ? (
          <div className="header-tabs">
            {/* the strip that cannot be drawn leaves the sidebar and the pane working, as the pane's own strip did */}
            <RenderBoundary resetKey={`${selectedMachineId}:${selectedPane.pane_id}`} fallback={(retry) => <RegionCrash message={t("This pane can't be shown.")} retry={retry} />}>
            <PanePressContext.Provider value={pressPane}>
              <TabStrip snapshot={snapshot} workspace={selectedWorkspace} selectedPane={selectedPane} onSelectPane={selectPane} splitDrag browserTabs closable={auth?.role !== "watch"}
                renameRequest={renameRequest?.machineId === selectedMachineId && renameRequest.paneId === selectedPane.pane_id ? renameRequest : null}
                onRenameHandled={clearRenameRequest}
                onNewTab={() => actions.openNewTab()}
                onNewTerminal={() => actions.openTerminalTab()}
                onMoveToWorkspace={(tabId, workspaceId) => actions.moveTabToWorkspace({ machineId: selectedMachineId, tabId, workspaceId })}
                paneActions={(paneId) => {
                  const target = snapshot.panes.find((item) => item.pane_id === paneId);
                  if (!target || !paneActionsRef.current) return [];
                  return paneActionsRef.current(target).map((item) => ({ ...item, run: () => paneActionsRef.current?.(target).find((fresh) => fresh.id === item.id)?.run() }));
                }} />
            </PanePressContext.Provider>
            </RenderBoundary>
          </div>
        ) : note !== null ? null : selectedPane && crumb ? (
          <div className={`context${headerConnection === null ? "" : " has-connection"}${tabsInHeader && selectedWorkspace && !guideShown ? " has-tabs" : ""}`} title={crumb.tooltip}>
            <div className="context-title">
              {selectedAgent && <AgentMark agent={selectedAgent} size={18} />}
              <span className="context-title-text" role="group" aria-label={[selectedAgent ? agentName(selectedAgent) : null, crumb.fullContext].filter((part) => part !== null).join(" · ")}>{selectedTitle}</span>
              {position && <span className="context-position" title={position.words}>
                <span aria-hidden="true">{position.index}/{position.count}</span>
                <span className="visually-hidden">{position.words}</span>
              </span>}
              {/* the whole title is its target (styles.css .context-tabs::after) */}
              {tabsInHeader && selectedWorkspace && !guideShown && <button type="button" className="context-tabs" aria-label={t("Tabs of {workspace}", { workspace: selectedWorkspace.label })}
                aria-haspopup="dialog" aria-expanded={tabSheet !== null} onClick={(event) => toggleTabSheet(event.currentTarget)}>
                <ChevronDown aria-hidden="true" />
              </button>}
            </div>
            {/* lost and back, the connection takes the crumb's place in words, in the same box: nothing moves */}
            <div className={`context-sub${headerConnection === null ? "" : ` context-connection is-${headerConnection}`}`}>
              {/* a watching device says so where the status bar would (G-004): a phone has no status bar, so the crumb line leads with it, the connection's word kept after it */}
              {auth?.role === "watch" && !statusBarShown && <><span className="context-watch">{t("View only")}</span><span className="context-sep" aria-hidden="true">·</span></>}
              {headerConnection !== null ? <span>{t(headerConnection === "connected" ? "Connected" : "Reconnecting…")}</span> : <>
                {/* one PC needs no name: the sidebar leaves it out too, and More still says it */}
                {crumb.showMachine && <><span className="machine-context-name">{crumb.machine}</span><span className="context-sep" aria-hidden="true">›</span></>}
                <span>{crumb.workspace}</span>
                {crumb.folder !== null && (
                  <>
                    <span className="context-sep" aria-hidden="true">›</span>
                    <span>{crumb.folder}</span>
                  </>
                )}
              </>}
            </div>
            {/* after the crumb, so it wraps out of sight before the crumb does; the connection's word has the line */}
            {headerConnection === null && session !== null && sessionLines !== null && (sessionShort.length > 0 || session.goal !== null) && (
              <div className="context-sub context-session" title={[sessionLines.totals, sessionLines.goal].filter((line) => line !== null).join("\n")}>
                {sessionShort.length > 0 && <span>{sessionShort.join(" · ")}</span>}
                {session.goal !== null && <span className="context-session-goal"><Target aria-hidden="true" />{goalStatusWord(session.goal.status)}</span>}
              </div>
            )}
          </div>
        ) : (
          <><Brand /><span className="machine-context-name">{selectedMachine?.name ?? selectedMachineId}</span></>
        )}
        {/* both lenses, the open one on a thumb that slides to it (Apple's segmented control): the chat in the
            rounded face with its bubble, the terminal in the mono face with its prompt. Mod+Shift+J switches too */}
        {selectedPane && (
          <div className="view-switch" data-view={view} role="group" aria-label={`${t("Chat")} / ${t("Terminal")}`}>
            <button type="button" className="lens-option is-chat" aria-pressed={view === "chat"} aria-label={t("Chat")} title={shortcutTitle(t("Chat transcript"), "toggle-view")}
              onClick={() => { setView("chat"); setDrawerOpen(false); }}>
              <MessageCircle aria-hidden="true" />
              <span className="lens-label">{t("Chat")}</span>
            </button>
            <button type="button" className="lens-option is-terminal" aria-pressed={view === "terminal"} aria-label={terminalAttach ? t("Terminal") : `${t("Terminal")} · ${t("soon")}`}
              title={!terminalAttach ? t("Live terminal: coming to Windows PCs once herdr can attach there") : shortcutTitle(t("Live terminal"), "toggle-view")}
              onClick={() => { setView("terminal"); setDrawerOpen(false); }}>
              <SquareTerminal aria-hidden="true" />
              <span className="lens-label">{t("Terminal")}</span>
              {!terminalAttach && <span className="pill pill-soon">{t("soon")}</span>}
            </button>
            {/* after the buttons, so each lens is its own :first-child / :nth-child */}
            <span className="lens-thumb" aria-hidden="true" />
          </div>
        )}
        {selectedPane && wideScreen && (
          <button type="button" className="header-text-button header-files-button is-icon" aria-label={t("Browse files")} title={t("Files")} aria-pressed={filesDocked ? filesBeside : undefined} onClick={toggleFiles}>
            <FolderOpen aria-hidden="true" />
          </button>
        )}
        <div className="header-meta">
          {/* the chip speaks for the pane's terminal: the setup guide stands in the pane's place and has none */}
          {!guideShown && <ConnectionChip
            connected={connected}
            word={connWord}
            quiet={(headerConnection === "reconnecting" && note === null && crumb !== null && !stripInHeader) || statusBarShown}
            title={[connected ? null : connWord, shownHerdr ? (shownHerdr.runtime === "herdr-core" ? t("herdr-core {version} · protocol {protocol}", { version: shownHerdr.version, protocol: shownHerdr.protocol }) : t("herdr {version} · protocol {protocol}", { version: shownHerdr.version, protocol: shownHerdr.protocol })) : null].filter((part) => part !== null).join(" · ") || undefined}
          />}
          {/* the Host's herdr is away: the step to take is on that PC (the sidebar's state line says the same) */}
          {/* this PC's herdr is told by its health reads: one failed read is unknown, a second unavailable, and
              neither is proof that herdr stopped. Another PC's is told by its bridge (the roster) */}
          {selectedMachineId !== "local"
            ? !targetHerdr && <span className="pill pill-offline">{t("herdr offline")}</span>
            : localFreshness === "unknown"
              ? <span className="pill pill-stale" title={health ? (health.herdr.runtime === "herdr-core" ? t("The last health check failed. Last seen: herdr-core {version} · protocol {protocol}", { version: health.herdr.version, protocol: health.herdr.protocol }) : t("The last health check failed. Last seen: herdr {version} · protocol {protocol}", { version: health.herdr.version, protocol: health.herdr.protocol })) : t("The health check failed")}>{t("Status unknown")}</span>
              : localFreshness === "unavailable" && (health?.herdr.runtime === "herdr-core"
                ? <span className="pill pill-offline" title={t("Open the Herdr app on this PC, or check HC_SESSION and HC_SOCKET.")}>{t("herdr-core unavailable")}</span>
                : <span className="pill pill-offline" title={t("Start herdr on this PC, or check HERDR_SOCKET.")}>{t("herdr unavailable")}</span>)}
          {isSheetWidth && <HeaderCounts counts={sessionTally} onOpen={() => setDrawerOpen(true)} />}
          <span className="header-more">
            <button
              type="button"
              className="icon-button header-more-button"
              aria-label={moreLabel}
              title={moreLabel}
              aria-haspopup={isSheetWidth ? "dialog" : "menu"}
              aria-expanded={more !== null}
              onClick={(event) => {
                const anchor = event.currentTarget;
                setMore((open) => (open ? null : { anchor }));
              }}
            >
              <Ellipsis />
            </button>
            {/* the waiting dot carries the count (G-015): the number a phone otherwise reads only inside More */}
            {waitingDot ? <span className="header-more-dot is-waiting" data-count={sessionTally.waiting} aria-hidden="true" /> : alertsOffDot && <span className="header-more-dot" aria-hidden="true" />}
          </span>
        </div>
        {more && (
          <RowMenu
            anchor={more.anchor}
            title={t("More")}
            header={crumb ? (
              <div className="header-more-crumb">
                {/* the status bar says where the pane is; the session's lines and the route stay here */}
                {/* the pane's whole title, which the header cuts short: a phone has no tooltip, so More says it, with the agent (G-069) */}
                {!statusBarShown && selectedTitle !== null && <span className="header-more-title">{selectedAgent ? `${agentName(selectedAgent)} · ${selectedTitle}` : selectedTitle}</span>}
                {!statusBarShown && <span>{currentTabName ? `${crumb.place} › ${currentTabName}` : crumb.place}</span>}
                {!statusBarShown && crumb.path !== null && <span className="header-more-path">{crumb.path}</span>}
                {sessionLines !== null && <span className="header-more-session">
                  <span>{sessionLines.totals}</span>
                  {sessionLines.goal !== null && <span>{sessionLines.goal}</span>}
                </span>}
                {/* how this device reaches Ovis, said here instead of beside the chip */}
                <ConnectionRouteMark portal={auth?.via === "portal"} ingress={security.state === "known" ? security.summary.observed_ingress : null} />
              </div>
            ) : undefined}
            items={moreItems}
            onClose={closeMore}
          />
        )}
      </header>

      <PanePressContext.Provider value={pressPane}>
      <div className="app-body">
        <aside id="workspace-drawer" className={`sidebar${drawerOpen ? " is-open" : ""}${sidebarPeeking ? " is-peek" : ""}`} role={drawerModal ? "dialog" : undefined} aria-modal={drawerModal ? true : undefined} tabIndex={drawerModal ? -1 : undefined} aria-label={drawerModal ? t("Workspace list") : undefined}
          // the header's toggle and + are drawn as the open drawer's top row: a screen reader that keeps to the modal finds them in it
          aria-owns={drawerModal ? (settings.sidebarRows !== "two" ? "drawer-toggle drawer-new-workspace" : "drawer-toggle") : undefined} ref={drawerRef} {...peekSidebarHandlers}>
          {error && <div className="error-state" role="alert"><p>{error}</p><button className="btn" onClick={() => void load()}>{t("Retry")}</button></div>}
          {/* a sidebar that cannot be drawn leaves the panes working */}
          <RenderBoundary resetKey={null} fallback={(retry) => <RegionCrash message={t("The sidebar can't be shown.")} retry={retry} />}>
            <CrashProbe region="sidebar" />
            <ReorderContext.Provider value={reorderCoordinator}><MachineSidebar machines={sidebarMachines} allMachines={machines} watching={auth?.role === "watch"} appLayout={appLayoutOn} drawerOpen={drawerOpen} filterRequest={sidebarFilterRequest} selectedMachineId={selectedMachineId} selectedPaneId={selectedPaneId} activity={activity} actions={actions} onSelect={selectTarget} onUsageLogin={(paneId) => { selectTarget("local", paneId, "terminal"); void load(); }} onSetup={(machine, update = false) => { setUpdateRemote(update); setMachineDialog(machine); }} onNew={(id) => { setNewSessionMachineId(id); setNewTab(null); setNewSessionOpen(true); setDrawerOpen(false); }} /></ReorderContext.Provider>
          </RenderBoundary>
          <SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} />
        </aside>

        {/* kept on the page closed (styles.css): a swipe that begins on it closes the drawer */}
        <div className={`scrim${drawerOpen ? " is-open" : ""}`} aria-hidden="true" onClick={() => setDrawerOpen(false)} />

        {/* a file path in the chat opens in the viewer, relative to the selected pane's folder */}
        <OpenFileContext.Provider value={selectedPaneId !== null ? viewFile : null}>
        <WebPanelContext.Provider value={openWebPage}>
        <div className={`pane-column${chatShown ? " is-chat" : ""}`} inert={drawerModal || undefined}>
        {/* over the pane only: a bar across the window would cut the sidebar off from its top row in the header */}
        <UpdateNotice updates={updates} onOpen={() => { setSettingsSection("updates"); setSettingsOpen(true); }} />
        <TelemetryNotice enabled={locked === false} onOpen={() => { setSettingsLinkPage("about"); setSettingsLinkSection("telemetry"); setSettingsOpen(true); }} />
        <MachineActionBanner machines={machines} onSetup={(machine, update = false) => { setDrawerOpen(false); setUpdateRemote(update); setMachineDialog(machine); }} />
        {layoutNotice && <p className="pane-notice" role="alert">{layoutNotice}</p>}
        {/* the last answer that got through: a listener does not stop because herdr's ping failed */}
        {exposure && !(exposureDirect && directNotice.dismissed) && <LanExposureNotice host={exposure.host} direct={exposureDirect} onOpen={() => { setSettingsLinkPage("devices"); setSettingsOpen(true); }} onDismiss={directNotice.dismiss} />}
        <PushHealthNotice onRepair={repairNotifications} onOpen={() => { setSettingsLinkPage("alerts"); setSettingsOpen(true); }} />
        <InstallHint />
        {setupGuide.guide !== null && setupGuide.paused && <SetupGuideResume onResume={setupGuide.resume} />}
        {relayPairings.length > 0 && <RelayPairingPrompt pairings={relayPairings} />}
        {remotePairings.length > 0 && <AccountApprovals pairings={remotePairings} />}
        {pairedNotices.length > 0 && <DevicePairedNotice events={pairedNotices} onDismiss={dismissPairedNotice} onOpen={(event) => { dismissPairedNotice(event); setSettingsLinkPage("devices"); setSettingsOpen(true); }} />}
        {removedNotices.length > 0 && <DeviceRemovedNotice events={removedNotices} onDismiss={dismissRemovedNotice} />}
        {/* the pane's tab, or two tabs side by side (lib/split.ts): a tab dragged down out of its strip,
            or a sidebar row dragged over this area, opens its pane in the half it is dropped on */}
        {/* kept mounted while it steps aside, so a sign-in or a workspace being made goes on where it was; it is this PC's setup */}
        {setupGuide.guide !== null && <MachineContext.Provider value="local"><SetupGuide auth={auth} security={security} hidden={setupGuide.paused} state={setupGuide.guide} dispatch={setupGuide.dispatch} onClose={setupGuide.close} onOpenSettings={(page) => { setSettingsLinkPage(page); setSettingsOpen(true); }}
          // the tab was just made: picked before the roster has it, the pick would be released as a closed pane
          // picked once the roster has it: only the latest tab the guide asked for, while it is open, Start
          // was not pressed since, and nothing else was picked meanwhile
          onOpenTerminal={(paneId) => { const at = picks.current; const latest = setupGuide.ticket(); void load().finally(() => { if (latest() && picks.current === at) selectTarget("local", paneId, "terminal"); }); }}
          onStarting={setupGuide.voidTickets}
          onPaired={() => void loadHealth()}
          onOpened={(paneId, agentStarted) => { if (agentStarted) actions.agentStarted("local", paneId); setupGuide.finish(() => selectTarget("local", paneId)); void load(); }} /></MachineContext.Provider>}
        {guideShown ? null :
        <div ref={paneAreaRef} className={`pane-split${splitOn ? " is-split" : ""}`} onDragEnterCapture={paneDragOver} onDragOverCapture={paneDragOver} onDragLeave={paneDragLeave} onDropCapture={paneDrop}>
          {shownSlots.map((slot) => {
            const active = !splitOn || split!.active === slot;
            const other = active ? undefined : others.get(slot);
            if (!active && !other) return null;
            const machineId = other ? other.target.machineId : selectedMachineId;
            const paneId = other ? other.target.paneId : selectedPaneId;
            const machine = other ? other.machine : selectedMachine;
            const herdr = other ? other.herdr : targetHerdr;
            const pane = other ? other.pane : selectedPane;
            const workspace = other ? other.workspace : selectedWorkspace;
            const slotSnapshot = other ? other.machine?.snapshot ?? null : snapshot;
            const attach = other ? other.attach : terminalAttach;
            const rect = rects?.get(slot);
            // two slots side by side keep the halves' sides; any other layout places each slot at its rectangle
            const side = splitOn ? slotSide(split!, slot) : null;
            const lensOf = (item: HerdrPane): PaneView => active && item.pane_id === selectedPaneId ? view
              : storedView(lenses, viewPicks, item.pane_id, machineId, item.agent != null, attach);
            const slotView = active ? view : pane ? lensOf(pane) : "terminal";
            const onSelect = active ? selectPane : (id: string, focusInput = true) => selectInSlot(slot, machineId, id, focusInput);
            // one pane's panel keeps the page's own id, whichever slot draws it
            const slotPanelId = !splitOn || slot === "a" ? PANE_TABPANEL_ID : `${PANE_TABPANEL_ID}-${slot}`;
            const slotPanelLabel = active ? tabPanelLabel : paneTabPanelLabel(slotSnapshot, pane, t);
            // a peek shows this half's terminal over its chat: the half's lens button says the chat,
            // and takes it back, as the palette's toggle and Mod+Shift+J do
            const slotPeek = active && pane ? peekFor(terminalPeek, slot, machineId, pane.pane_id) : null;
            const shownView: PaneView = slotPeek !== null ? "terminal" : slotView;
            const toggleSlotView = (): void => {
              if (slotPeek !== null) { endPeek(slotPeek); return; }
              const next = slotView === "chat" ? "terminal" : "chat";
              if (active) setView(next); else if (pane) pickView(machineId, pane.pane_id, next);
            };
            // a half's own lens and close sit at the end of its tab strip. The row's free end is the
            // half's grip: its pane, dropped on a half of the pane area, opens there too (dockSide)
            const slotEnd = splitOn ? <div className="pane-slot-grip" draggable={paneId !== null}
              onDragStart={(event) => {
                if (paneId === null) return;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(PANE_DRAG_TYPE, paneDragData({ machineId, paneId }));
              }}>
              {machines.length > 1 && <span className="pane-slot-machine">{machine?.name ?? machineId}</span>}
              {pane && <button type="button" className="icon-button pane-slot-action" aria-label={t(shownView === "chat" ? "Show the terminal" : "Show the chat")} title={t(shownView === "chat" ? "Show the terminal" : "Show the chat")} onClick={toggleSlotView}>
                {shownView === "chat" ? <SquareTerminal /> : <MessageSquare />}
              </button>}
              <button type="button" className="icon-button pane-slot-action" aria-label={t(shownSlots.length > 2 ? "Remove from the split" : "Close this half")} title={t(shownSlots.length > 2 ? "Remove from the split" : "Close this half")} onClick={() => closeSlot(slot)}>
                <X />
              </button>
            </div> : undefined;
            // a half with no strip to carry its close (its pane gone, or the half crashed) keeps one in a bar of its own
            const slotBar = splitOn ? <div className="pane-slot-bar"><span className="pane-slot-title">{pane ? displayPaneTitle(pane) : t("Pane closed")}</span>{slotEnd}</div> : null;
            return (
              <MachineContext.Provider key={slot} value={machineId}><AppLayoutContext.Provider value={appLayoutOf(herdr)}><SlotSessions slot={slot} machineIds={machines.map((item) => item.id)}><PaneFollowContext.Provider value={follows(slot)}>
              <div
                className={`pane-slot${showsChat(pane, slotView) ? " is-chat" : ""}${splitOn ? active ? " is-active" : " is-inactive" : ""}${rect && rect.x + rect.w < 0.999 ? " joins-right" : ""}${rect && rect.y + rect.h < 0.999 ? " joins-below" : ""}`}
                style={rect ? { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` } : undefined}
                data-slot={slot}
                data-machine={machineId}
                data-side={side ?? undefined}
                // a press or the focus in the other half makes it the active one, before the press acts;
                // its own bar's buttons (its lens, its close) act on it as it is. A menu the half opened
                // is portaled out of it: a press or a focus there reaches these handlers through React but
                // is not in the half, and activating would close the menu before its item's click lands
                onPointerDownCapture={active ? undefined : (event) => {
                  if (!event.currentTarget.contains(event.target as Node)) return;
                  if (event.button === 0 && !paneContextPress(event, apple) && !(event.target as Element).closest(".pane-slot-action")) activateSlot(slot);
                }}
                onFocusCapture={active ? undefined : (event) => { if (event.currentTarget.contains(event.target as Node) && Date.now() - lastKeyAtRef.current < KEY_FOCUS_MS && !(event.target as Element).closest(".pane-slot-action")) activateSlot(slot, true); }}
                // a file or text dropped into the other half is for its pane: an upload's paths and the pasted
                // text reach only the active half's terminal, so the drop makes the half active first
                onDropCapture={active ? undefined : (event) => { if (!event.dataTransfer.types.includes(PANE_DRAG_TYPE)) activateSlot(slot); }}
              >
                {/* a pane this half cannot draw leaves the sidebar and the other half working; picking
                    another pane tries again */}
                <RenderBoundary resetKey={`${machineId}:${paneId ?? ""}`} fallback={(retry) => <>{slotBar}<RegionCrash message={t("This pane can't be shown.")} retry={retry} onShown={active ? paneLost : undefined} /></>}>
                <CrashProbe region="pane" />
                {!(slotSnapshot && pane && workspace) && slotBar}
                {slotSnapshot && pane && workspace && !(active && stripInHeader) && (
                  <TabStrip snapshot={slotSnapshot} workspace={workspace} selectedPane={pane} panelId={slotPanelId} splitDrag={wideScreen} onSelectPane={onSelect}
                    inHeader={tabsInHeader} sheet={active ? tabSheet : null} onSheetClose={closeTabSheet} end={slotEnd} closable={auth?.role !== "watch"}
                    renameRequest={active && renameRequest?.machineId === machineId && renameRequest.paneId === pane.pane_id ? renameRequest : null}
                    onRenameHandled={clearRenameRequest}
                    onNewTab={() => actions.openNewTab(active ? undefined : { machineId, workspaceId: workspace.workspace_id })}
                    onNewTerminal={() => actions.openTerminalTab(active ? undefined : { machineId, workspaceId: workspace.workspace_id })}
                    onMoveToWorkspace={(tabId, workspaceId) => actions.moveTabToWorkspace({ machineId, tabId, workspaceId })}
                    paneActions={active ? (paneId) => {
                      const target = snapshot?.panes.find((item) => item.pane_id === paneId);
                      if (!target || !paneActionsRef.current) return [];
                      // the strip renders before the canvas, so its items come from the canvas's previous render:
                      // an action runs against the canvas's latest one, where a snapshot change has landed; one it no
                      // longer offers (a close a lock took away, lib/paneLocks.ts) does nothing
                      return paneActionsRef.current(target).map((item) => ({ ...item, run: () => paneActionsRef.current?.(target).find((fresh) => fresh.id === item.id)?.run() }));
                    } : undefined} />
                )}
                {/* the tab strip's panel: its id is what each tab's aria-controls points at, one per half.
                    No tabIndex - the terminal (PaneTerminal) and the composer are the focusable things inside it. */}
                <main className="terminal-host">
                  <div id={slotPanelId} className="terminal-tabpanel" role={slotPanelLabel === null ? undefined : "tabpanel"} aria-label={slotPanelLabel ?? undefined}>
                  <PaneCanvas key={machineId} snapshot={slotSnapshot} pane={pane} selectedPaneId={paneId} onSelect={onSelect} onChanged={actions.refresh} actionsRef={active ? paneActionsRef : undefined} watching={auth?.role === "watch"}
                    mirrored={herdr?.terminal_attach === false || herdr?.terminal_mirror === true}
                    onOpenInHalf={wideScreen ? (id, side) => dockSide({ machineId, paneId: id }, side) : undefined}
                    onRecoverUnsent={(target) => openUnsent({ machineId, pane: target })}
                    onSearchConversation={(target) => searchable(machineId, target, lensOf(target)) && !(slotPeek !== null && target.pane_id === pane?.pane_id) ? () => requestSearch(slot, machineId, target.pane_id) : null}
                    onNewTab={workspace ? () => actions.openNewTab(active ? undefined : { machineId, workspaceId: workspace.workspace_id }) : undefined}
                    onNewTerminal={workspace ? () => actions.openTerminalTab(active ? undefined : { machineId, workspaceId: workspace.workspace_id }) : undefined}
                    onMoveToWorkspace={(tabId, workspaceId) => actions.moveTabToWorkspace({ machineId, tabId, workspaceId })}
                    tabsInHeader={tabsInHeader}
                    renameRequest={active && pane && renameRequest?.machineId === machineId && renameRequest.paneId === pane.pane_id ? renameRequest : null}
                    renderPane={(item, itemActive, herdrSplit) => <OpenFileContext.Provider value={item ? (path) => openFile({ path, paneId: item.pane_id, machineId }) : null}>
                      <PaneTerminal
                        presentationKey={paneContentKey(machine, item, item ? lensOf(item) : slotView)}
                        finishEpoch={machine?.snapshot?.finish_epoch}
                        finishId={item?.finish_id}
                        title={item ? displayPaneTitle(item) : active ? selectedTitle : null}
                        // Wait for the roster before attaching: the loading placeholder is replaced
                        // by the keyed tile, and must never claim the pane on a throwaway connection.
                        paneId={item?.restore_error ? null : item?.pane_id ?? null}
                        terminalId={item?.terminal_id ?? null}
                        mirrored={herdr ? herdr.terminal_attach === false || herdr.terminal_mirror === true : null}
                        restoreError={item?.restore_error ?? null}
                        agent={item?.agent ?? null}
                        agentStatus={item?.agent_status}
                        agentSession={item ? paneSessionKey(item) : null}
                        backgroundTasks={item?.background_tasks ?? 0}
                        // an offline PC's cached plan cannot be read
                        plan={machine?.state === "connected" ? (item as HerdrPane | undefined)?.plan ?? null : null}
                        backgroundWait={item?.background_wait === true}
                        cwd={item?.cwd ?? null}
                        workspaceId={item?.workspace_id ?? null}
                        workspaceLabel={slotSnapshot?.workspaces.find((workspace) => workspace.workspace_id === item?.workspace_id)?.label ?? null}
                        worktreeRepo={worktreeRepoName(item === null ? undefined : slotSnapshot?.workspaces.find((workspace) => workspace.workspace_id === item.workspace_id))}
                        machineName={machine?.name ?? machineId}
                        view={item ? lensOf(item) : slotView}
                        // the composer's way to the terminal: the selected pane's lens, or the pane's own remembered one
                        onOpenTerminal={item ? () => { if (active && item.pane_id === selectedPaneId) setView("terminal"); else pickView(machineId, item.pane_id, "terminal"); } : undefined}
                        // a terminal command's peek, for the active half's selected pane alone (lib/terminalPeek.ts)
                        peek={active && item?.pane_id === selectedPaneId ? peekFor(terminalPeek, slot, machineId, item.pane_id) : null}
                        onPeek={active && item && item.pane_id === selectedPaneId && attach ? (request: PeekRequest) => setTerminalPeek({ ...request, slot, machineId, paneId: item.pane_id }) : undefined}
                        onEndPeek={endPeek}
                        // /resume lists the pane's own agent's sessions, and only for an agent whose store is read
                        onOpenHistory={item && sessionHistoryAgent(item.agent) !== null ? () => actions.openSessionHistory({ machineId, workspaceId: item.workspace_id, agent: item.agent, scope: "pane", paneId: item.pane_id }) : undefined}
                        // the other half never takes the keyboard: a press in it makes it active first
                        active={active && itemActive}
                        // the paging shortcuts reach the selected pane of the active half only
                        controls={active && itemActive ? paneControls : undefined}
                        findRequest={active && findRequest.paneId === item?.pane_id ? findRequest.serial : 0}
                        searchRequest={searchRequest.slot === slot && searchRequest.machineId === machineId && searchRequest.paneId === item?.pane_id ? searchRequest.serial : 0}
                        autoSelected={active ? autoSelected : true}
                        terminalFontSize={settings.terminalFontSize}
                        split={herdrSplit || splitOn}
                        terminalWheelSpeed={settings.terminalWheelSpeed}
                        terminalFontFamily={settings.terminalFontFamily}
                        theme={resolvedEntry.mode}
                        palette={resolvedEntry.id}
                        onConnectionChange={active && itemActive ? (next, before) => { setConnected(next); setConnectedBefore(before); setReportedBy(`${slot}:${machineId}`); if (next) setOutputStopped(false); } : undefined}
                        onServerMessage={active && itemActive ? handleServerMessage : undefined}
                      />
                    </OpenFileContext.Provider>} />
                  </div>
                </main>
                </RenderBoundary>
              </div>
              </PaneFollowContext.Provider></SlotSessions></AppLayoutContext.Provider></MachineContext.Provider>
            );
          })}
          {dividers.length > 0 && <SplitDividers dividers={dividers} areaRef={paneAreaRef} onResize={resizeDivider} />}
          <SplitDropPreview visible={splitDragOn && (paneDragging || tabDrag !== null)} grid={gridPreview} />
        </div>}
        {statusBarShown && selectedPane && crumb && <StatusBar machineId={selectedMachineId} workspaceId={selectedPane.workspace_id}
          machine={crumb.machine} place={crumb.folder === null ? crumb.workspace : `${crumb.workspace} › ${crumb.folder}`} path={crumb.path}
          session={sessionShort.length > 0 ? sessionShort.join(" · ") : null}
          pcLoad={pcLoadOn(settings, machines) ? <PcLoadStatus key={selectedMachine?.id ?? ""} machine={selectedMachine ?? null} /> : null}
          watching={auth?.role === "watch"}
          waiting={sessionTally.waiting} onNextWaiting={nextWaiting === null ? null : openNextWaiting}
          connection={headerConnection ?? (connected ? "live" : "lost")}
          connectionWord={headerConnection === "reconnecting" ? t("Reconnecting…") : connected ? t("Connected") : connWord} />}
        </div>
        </WebPanelContext.Provider>
        </OpenFileContext.Provider>
        {/* last in the row: the file beside the pane (from 980px), the pane column shrinks and its terminal refits */}
        {viewing !== null && fileDocked && <MachineContext.Provider value={viewing.machineId}>
          <FileViewer key={fileViewerKey(viewing)} docked panelStart={<FilePanelResizer width={filePanelWidth} onResize={setFilePanelWidth} />} path={viewing.path} paneId={viewing.paneId} onClose={closeFile} onOpen={(path) => openFile({ ...viewing, path, presentation })} onKind={reportFileKind} onTogglePresentation={toggleFilePresentation} keyboardActive={!settingsOpen} editable={fileEditable} />
        </MachineContext.Provider>}
        {filesOpen && filesDocked && filesDialog(true)}
        {webPage !== null && !(viewing !== null && fileDocked) &&
          <WebPanel key={webPage} url={webPage} docked={filePanelAvailable} covered={webDialogCover} onClose={closeWebPage} panelStart={filePanelAvailable ? <FilePanelResizer width={filePanelWidth} onResize={setFilePanelWidth} /> : undefined} />}
      </div>
      </PanePressContext.Provider>

      <MachineContext.Provider value={newSessionMachineId}><NewSessionDialog
        key={newSessionMachineId}
        machineName={machines.find((m) => m.id === newSessionMachineId)?.name ?? newSessionMachineId}
        worktrees={machines.find((m) => m.id === newSessionMachineId)?.snapshot?.workspaces.flatMap((workspace) => workspace.worktree?.is_linked_worktree ? [workspace.worktree.checkout_path] : []) ?? []}
        open={newSessionOpen}
        tab={newTab}
        defaultCwd={newSessionMachineId === selectedMachineId ? selectedPane?.cwd ?? null : null}
        prefill={newPrefill}
        onDraft={setNewFields}
        onClose={closeNewSession}
        onOpenPane={(paneId) => { closeNewSession(); selectTarget(newSessionMachineId, paneId, "terminal"); void load(); }}
        watching={auth?.role === "watch"}
        groupKept={(groupOf) => liveGroupKeys(groupOf, machines, hiddenMachines)}
        onCreated={(paneId, agentStarted, messageWaits = false) => {
          closeNewSession();
          if (agentStarted) actions.agentStarted(newSessionMachineId, paneId);
          // the first message waits in the chat's box: the pane opens on it, whatever lens the page would pick
          if (messageWaits) pickView(newSessionMachineId, paneId, "chat");
          selectTarget(newSessionMachineId, paneId);
          void load();
        }}
      /></MachineContext.Provider>
      {sessionHistory && sessionHistoryWorkspace && <MachineContext.Provider value={sessionHistory.machineId}><SessionHistory
        workspace={sessionHistoryWorkspace.workspace}
        machineName={machines.find((m) => m.id === sessionHistory.machineId)?.name}
        panes={sessionHistoryWorkspace.panes}
        agent={sessionHistory.agent}
        sourcePaneId={sessionHistory.paneId}
        askingPaneId={sessionHistory.askingPaneId}
        selectedPaneId={sessionHistory.selectedPaneId}
        recent={recentResumes}
        onClose={closeSessionHistory}
        onSelectPane={(paneId) => { closeSessionHistory(); selectTarget(sessionHistory.machineId, paneId); }}
        onResumed={(opened, session) => {
          closeSessionHistory();
          if (opened.agent_started) {
            rememberResume({ machineId: sessionHistory.machineId, workspaceId: sessionHistory.workspaceId, agent: session.agent, id: session.id, store: session.store, paneId: opened.pane_id });
            actions.agentStarted(sessionHistory.machineId, opened.pane_id);
          }
          selectTarget(sessionHistory.machineId, opened.pane_id);
          void load();
        }}
      /></MachineContext.Provider>}
      {machineDialog && <MachineDialog updateRemote={updateRemote} machine={machineDialog === "new" ? undefined : machineDialog} preset={machineDialog === "new" ? addPcPreset ?? undefined : undefined} onClose={closeMachineDialog} onConnected={(id) => { closeMachineDialog(); selectTarget(id, null); void load(); }} />}
      <Droplet onOpen={(machineId, paneId) => {
        // an ended pane's card outlives the pane: the refetch has dropped it, and selecting it attaches nothing
        if (!machinesRef.current.find((m) => m.id === machineId)?.snapshot?.panes.some((p) => p.pane_id === paneId)) return;
        // Files lists the pane it was opened on, and would open its paths on the new one
        setFilesOpen(false);
        selectTargetRef.current(machineId, paneId);
      }} />
      <SettingsDialog machines={machines} auth={auth} picturesByDefault={picturesByDefault} herdrVersion={shownHealth?.herdr?.version ?? null} herdrRuntime={shownHealth?.herdr ? shownHealth.herdr.runtime ?? "herdr" : null} herdrCore={shownHealth?.herdr_core ?? null} herdrRuntimeFacts={shownHealth?.herdr_runtime ?? null} bootId={shownHealth?.web_ui?.boot_id ?? null} onServerRestarted={() => { void readLocalHealth(); void readBridgeHealth(); void load(); }} security={security} open={settingsOpen} section={settingsSection} linkPage={settingsLinkPage} linkSection={settingsLinkSection} onPage={onSettingsPage} onClose={closeSettings} onUsageLogin={(paneId) => { closeSettings(); selectTarget("local", paneId, "terminal"); void load(); }} onOpenPane={(machineId, paneId) => { closeSettings(); selectTarget(machineId, paneId, "terminal"); void load(); }} actions={actions} updates={updates} onEnableNotifications={enableNotifications} saveError={settingsSaveError} savePaused={settingsSavePaused} saveRetrying={settingsSaveRetrying} onRetrySave={retrySettingsSave} overPreview={(viewing !== null && !fileDocked) || diffViewing !== null || (webPage !== null && !filePanelAvailable)} />
      {filesOpen && !filesDocked && filesDialog(false)}
      {diffViewing !== null && <MachineContext.Provider value={diffViewing.machineId}>
        <RepoDiffViewer key={`${diffViewing.scope}:${diffViewing.path}`} target={diffViewing} onClose={closeDiff} onOpenFile={async (path) => {
          try {
            if (await openDiffFile({ path, paneId: diffViewing.paneId, machineId: diffViewing.machineId })) { if (!filesDocked) setFilesOpen(false); return; }
          } catch {
            // A rejected traversal does not tell us which entry is current: keep Files and the diff.
            return;
          }
          const docked = filePanelAvailable && openPresentation(path, settings.fileOpen) === "panel";
          if (docked) {
            // Files beside the pane stays under the file, as it does for a file opened from its list
            if (!filesDocked) setFilesOpen(false);
            releaseDiff();
          }
          openFile({ path, paneId: diffViewing.paneId, machineId: diffViewing.machineId }, docked);
        }} keyboardActive={!settingsOpen && (viewing === null || fileDocked)} note={(() => {
          // only the diff's own pane on its own PC takes its notes, never the one selected now
          const machine = machines.find((item) => item.id === diffViewing.machineId);
          const block = noteBlock({ paneId: diffViewing.paneId, pane: machine?.snapshot?.panes.find((pane) => pane.pane_id === diffViewing.paneId), watching: auth?.role === "watch", observing: diffPaneObserving === "watching", mounted: diffPaneObserving !== "unknown", reachable: machine?.state === "connected" });
          return { machine: machine?.name ?? diffViewing.machineId, blocked: block === null ? null : noteBlockWord(t, block) };
        })()} />
      </MachineContext.Provider>}
      {viewing !== null && !fileDocked && <MachineContext.Provider value={viewing.machineId}>
        <FileViewer key={fileViewerKey(viewing)} path={viewing.path} paneId={viewing.paneId} onClose={closeFile} onOpen={(path) => openFile({ ...viewing, path, presentation })} onKind={reportFileKind} onTogglePresentation={toggleFilePresentation} keyboardActive={!settingsOpen} editable={fileEditable} />
      </MachineContext.Provider>}
      {worktreeFor && <WorktreeRequestDialog request={worktreeFor} onClose={() => setWorktreeFor(null)} onOpenPane={(paneId) => { setWorktreeFor(null); selectTarget(worktreeFor.machineId, paneId); }} onOpened={(opened) => {
        setWorktreeFor(null);
        if (opened.agent_started === true) actions.agentStarted(worktreeFor.machineId, opened.pane_id);
        selectTarget(worktreeFor.machineId, opened.pane_id);
      }} />}
      {unsentFor && <UnsentTextDialog machines={machines} target={unsentFor} canRecover={unsentFor.pane.agent != null} onClose={closeUnsent} onRecover={recover} />}
      <CommandPalette key={selectedMachineId} machines={sidebarMachines} onSelect={selectTarget} open={paletteOpen} initialQuery={paletteQuery} onClose={() => setPaletteOpen(false)} snapshot={snapshot} online={selectedMachine?.state === "connected"} selectedPaneId={selectedPaneId}
        // a peek shows the terminal: its toggle says Switch to chat, which ends the peek
        view={terminalPeek !== null ? "terminal" : view} actions={actions} watching={auth?.role === "watch"} />
      <MarkdownLinkMenu />
    </div></AppLayoutContext.Provider></MachineContext.Provider></MachineSessionsProvider>
  );
}
