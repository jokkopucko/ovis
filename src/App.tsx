import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, ChevronDown, ChevronLeft, Eye, Plus, CircleHelp, Ellipsis, FolderOpen, Inbox, Link, Menu, MessageCircle, MessageSquare, PanelLeft, PanelsTopLeft, Search, Settings as SettingsGlyph, SquareTerminal, Target, TextSearch, X } from "lucide-react";

import type { HerdrPane, PaneDirection } from "../shared/protocol.ts";
import { authenticate, createTab, declinePendingKey, movePaneBeside, moveTabToWorkspace, paneSessionKey, shareSeen, swapPaneWith } from "./lib/api.ts";
import { openGroupItems, useGroupClosedWhenEmpty, useMoreMenu } from "./lib/moreMenu.ts";
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
import { useOtherDevice, useSetupGuide } from "./lib/useSetupGuide.ts";
import { armHints, browserStorage, setupRowState } from "./lib/firstHints.ts";
import { alertsFailed, alertsHere, alertsSurfaces } from "./lib/setupGuideFlow.ts";
import { pushSupported, registeredPushEndpoint } from "./lib/push.ts";
import { confirmation } from "./lib/pushConfirm.ts";
import { SetupProgressRow } from "./components/SetupProgressRow.tsx";
import { askAddConnection } from "./lib/addConnectionRequest.ts";
import { FirstStartHints } from "./components/FirstStartHints.tsx";
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
import { addPcExit, addPcMoreItem, MachineActionBanner, MachineSidebar } from "./components/MachineSidebar.tsx";
import { SidebarResizer } from "./components/SidebarResizer.tsx";
import { type PanePresence, useSidebarActivityState } from "./lib/sidebarActivity.tsx";
import { useAgentStateStamping } from "./lib/useAgentStateSince.ts";
import { FilePanelResizer } from "./components/FilePanelResizer.tsx";
import { openPresentation } from "./lib/filePresentation.ts";
import { MachineDialog } from "./components/MachineDialog.tsx";
import { RowMenu, type RowMenuItem } from "./components/RowMenu.tsx";
import { headerCrumb, showsChat } from "./lib/headerCrumb.ts";
import { LOCAL_MACHINE, pairedPc, paneStorageId } from "../shared/machines.ts";
import { inNativeApp } from "./lib/nativeApp.ts";
import { useTellAppWhichPc } from "./lib/useTellAppWhichPc.ts";
import { serverIdOfPath, shellMode } from "./lib/shellMode.ts";
import { usePairedNotices } from "./lib/usePairedNotices.ts";
import { takeAuthTokenFromUrl } from "./lib/authLink.ts";
import { rosterPanes } from "./lib/dagPane.ts";
import { adjacentTabPane, adjacentWorkspacePane, numberedTabPane, drawnWorkspaceRows, sidebarWorkspaceSteps, type ViewedPane } from "./lib/adjacentTarget.ts";
import { lastViewedPane } from "./lib/lastViewedPane.ts";
import { currentSidebarPins, movedSidebarPins, pinnedWorkspaceIds, sidebarPinKey } from "./lib/sidebarPins.ts";
import { liveGroupKeys, movedAgentGroup } from "./lib/namedAgentGroups.ts";
import { ReorderContext } from "./lib/machineContext.tsx";
import { pcLoadOn, phoneInboxOn, useSettings } from "./lib/settings.ts";
import { usePaneLocked } from "./lib/paneLocks.ts";
import { useHiddenMachines, useShownMachines } from "./lib/hiddenMachines.ts";
import { formatKeys, shortcutDisplayKeys, useShortcuts } from "./lib/shortcuts.ts";
import { useHerdrPrefixKeys } from "./lib/herdrKeys.ts";
import { useMediaQuery } from "./lib/useMediaQuery.ts";
import { useAnnouncedText } from "./lib/useAnnouncedText.ts";
import { CRAMPED_QUERY, paneContextPress, soloPane, tabRowHidden } from "./lib/paneCanvas.ts";
import { useTabSheet } from "./lib/useTabSheet.ts";
import type { AppActions, PaneView, PaneControls } from "./lib/actions.ts";
import { removePushSubscription } from "./lib/push.ts";
import { resetPushHealth, usePushHealth } from "./lib/pushHealth.ts";
import { useUpdates } from "./lib/updates.ts";
import { desktopUpdateBridge, useDesktopUpdate } from "./lib/desktopUpdate.ts";
import { DesktopUpdateNotice, UpdateNotice } from "./components/UpdateControls.tsx";
import { RestoreNotice } from "./components/RestoreNotice.tsx";
import { LanExposureNotice } from "./components/LanExposureNotice.tsx";
import { PushHealthNotice } from "./components/PushHealthNotice.tsx";
import { RelayNotice } from "./components/RelayNotice.tsx";
import { InstallHint } from "./components/InstallHint.tsx";
import { DevicePairedNotice, DeviceRemovedNotice } from "./components/DevicePairedNotice.tsx";
import { NewPcNotices } from "./components/NewPcNotices.tsx";
import { UnconfirmedPcNotices } from "./components/UnconfirmedPcNotices.tsx";
import { AccountJoinRequests } from "./components/AccountJoinRequests.tsx";
import { hostedAccountItems } from "./components/AccountHead.tsx";
import { useHostedSignIn } from "./lib/account/hostedSignIn.ts";
import { ownWindowHere } from "./lib/account/addThisPc.ts";
import { useAccountDeviceNotices } from "./components/AccountDeviceNotices.tsx";
import { PendingKeys } from "./components/PendingKeys.tsx";
import { RelayPairingPrompt } from "./components/RelayPairingPrompt.tsx";
import { useOwnWindowPrompts } from "./lib/useOwnWindowPrompts.ts";
import { pcHeld } from "./lib/relay/newPcHere.ts";
import { OwnJoinCard } from "./components/OwnJoins.tsx";
import { AccountApprovals } from "./components/AccountApprovals.tsx";
import { ListMoveNotices } from "./components/ListMoveNotice.tsx";
import { TelemetryNotice } from "./components/TelemetryControls.tsx";
import { FilesDialog } from "./components/FilesDialog.tsx";
import { folderQueryFor } from "./lib/paletteFolders.ts";
import { FileViewer } from "./components/FileViewer.tsx";
import { WebPanel } from "./components/WebPanel.tsx";
import { BrowserSidePanel } from "./components/BrowserSidePanel.tsx";
import { useDesktopBrowser, useShownBrowserTab } from "./lib/desktopBrowser.ts";
import { BrowserPanel } from "./components/BrowserPanel.tsx";
import { BrowserTabsGroup } from "./components/BrowserTabsGroup.tsx";
import { WebPanelContext } from "./lib/webPanel.ts";
import { RepoDiffViewer } from "./components/RepoDiffViewer.tsx";
import { noteBlock, noteBlockWord } from "./lib/diffLineNotes.ts";
import { directHostOf, useDirectNotice } from "./lib/directNotice.ts";
import { relayNoticeOf, useRelayNotice } from "./lib/relayNotice.ts";
import { useAccountSignedIn } from "./lib/account/useAccountSignedIn.ts";
import { usePaneObserving } from "./lib/paneObserving.ts";
import { OpenFileContext } from "./lib/filePaths.ts";
import { PaneOpenFile } from "./components/PaneOpenFile.tsx";
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
import { connectionWord, useHeaderConnection, type HeaderConnection } from "./lib/headerConnection.ts";
import { useRestoreHeld } from "./lib/pageRestore.ts";
import { ConnectionRouteMark } from "./components/ConnectionRouteMark.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { LensToggle } from "./components/LensToggle.tsx";
import { PcLoadStatus } from "./components/MachineStats.tsx";
import logoDark from "./assets/brand/logo-dark.png";
import logoLight from "./assets/brand/logo-light.png";
import { nextWaitingTarget, sessionCountsAcross, tabPosition, useDrawerDialog, useWaitingRosters, waitingElsewhere, waitingTargets } from "./lib/headerSessions.ts";
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
import { PaneCoveredContext, PaneFollowContext, PanePressContext } from "./lib/paneSubmitContext.ts";
import { useKeptPaneBoxes } from "./lib/coveredPane.ts";
import { SplitDividers } from "./components/SplitDividers.tsx";
import { SplitDropPreview } from "./components/SplitDropPreview.tsx";
import { CrashProbe, RegionCrash } from "./components/AppCrash.tsx";
import { RenderBoundary } from "./components/RenderBoundary.tsx";
import { lensOwner, storedView, usePaneLens, usePaneLensState, usePaneViewPicks } from "./lib/usePaneLens.ts";
import { tally, usageCounters, useCountedInboxWays, useShownCount } from "./lib/usageCounters.ts";
import { appCounted, closeFromPaneMenu, moreFilesRun, type AppCountingState } from "./lib/appCounting.ts";
import { useSplitLayout, useSplitRecheck, useSplitState } from "./lib/useSplitView.ts";
import { linkSelects, useLinkLanding, useMachineGone, useNotificationTargets, useSelectedLayout, useSelectedMachine, useSelectedPane, useSelectionMark, useSelectionState, useSelectPane, useSelectTarget } from "./lib/useSelection.ts";
import { useAddressBar } from "./lib/useAddressBar.ts";
import { useInbox, useInboxShell, wayInOpensThread } from "./lib/useInbox.ts";
import { inboxOrder } from "./lib/agentInbox.ts";
import { layoutCells } from "./lib/layoutMap.ts";
import { pageStartsInInbox, useInboxMode } from "./lib/inboxMode.ts";
import { InboxList } from "./components/InboxList.tsx";
import { InboxConnecting, InboxUnchosen, ThreadTitle, ThreadTop } from "./components/InboxMode.tsx";
import { InboxRail } from "./components/InboxRail.tsx";
import { OvisMark } from "./components/OvisMark.tsx";
import { catchTypeAhead } from "./lib/typeAhead.ts";
import { goalStatusWord, sessionMenuLines, sizeWords, useSessionStats, workedWords } from "./lib/sessionStats.ts";

const APP_TITLE = "Ovis";
const KEY_FOCUS_MS = 1000;

function SlotSessions({ slot, machineIds, children }: { slot: SplitSlot; machineIds: readonly string[]; children: ReactNode }) {
  return slot !== "a" ? <MachineSessionsProvider machineIds={machineIds}>{children}</MachineSessionsProvider> : <>{children}</>;
}

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

function ConnectingNote() {
  const t = useT();
  const shown = useAnnouncedText(t("Connecting…"));
  return <p className={shown === null ? "visually-hidden" : "tree-state"} role="status">{shown}</p>;
}

function ConnectionChip({ connected, word, title, quiet }: { connected: boolean; word: string; title: string | undefined; quiet: boolean }) {
  const shown = useAnnouncedText(word);
  return (
    <span className={`conn ${connected ? "conn-live" : "conn-reconnecting"}${quiet ? " conn-quiet" : ""}`} role="status" title={title}>
      <span className="conn-dot" aria-hidden="true" />
      <span className="conn-text">{shown}</span>
    </span>
  );
}

function SidebarBrand({ dark }: { dark: boolean }) {
  return (
    <div className="brand sidebar-brand">
      <img src={dark ? logoDark : logoLight} alt="Ovis" width="68" height="24" />
    </div>
  );
}

/** a phone's header over its open drawer: the PC and workspace the list is on, not the pane's agent and name */
function DrawerHeadTitle({ machine, workspace, connection, watching }: { machine: string; workspace: string; connection: HeaderConnection; watching: boolean }) {
  const t = useT();
  return (
    <div className={`context drawer-head-title${connection === null ? "" : " has-connection"}`} title={`${machine} › ${workspace}`}>
      <div className="context-title"><span className="context-title-text">{machine}</span></div>
      <div className={`context-sub${connection === null ? "" : ` context-connection is-${connection}`}`}>
        {watching && <><span className="context-watch">{t("View only")}</span><span className="context-sep" aria-hidden="true">·</span></>}
        <span>{connection === null ? workspace : connectionWord(connection, t)}</span>
      </div>
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
  const hiddenMachines = useHiddenMachines();
  const { alerts, alertsRef, alertsOn, alertsOnRef } = useAlertPrefs({ settings });
  const { machineSessions, machines, setMachines, machineRosterLoaded, setMachineRosterLoaded } = useRosterState();
  const [initialLink] = useState(() => {
    if (!linksSomewhere(pageSearch())) return null;
    const link = readLink(pageSearch());
    return loadedOnSettingsEntry() ? { ...link, settings: null, section: null } : link;
  });
  useRecentFolderMemory({ machines });
  const { selectedMachineId, setSelectedMachineId, selectedMachine, snapshot } = useSelectedMachine({ initialLink, machines });
  const { machinesRef } = useMachinesRef({ machines });
  const [updateRemote, setUpdateRemote] = useState(false);
  const { machineDialog, setMachineDialog, addPcPreset, setAddPcPreset, addPcFocusReturn, closeMachineDialog } = useMachineDialog();
  const { newSessionMachineId, setNewSessionMachineId } = useNewSessionMachine();
  // a PC this one only watches there (Machine.view_only) is drawn as a watching device draws every PC
  const viewOnly = (machineId: string): boolean => auth?.role === "watch" || machines.find((machine) => machine.id === machineId)?.view_only === true;
  const { health, localFreshness, shownHealth, readLocalHealth } = useLocalHealth();
  useTellAppWhichPc(health === null ? undefined : health.web_ui?.server_id ?? "", machines.find((machine) => machine.id === LOCAL_MACHINE)?.name);
  const exposure = health?.lan_exposure ?? health?.direct_exposure;
  const exposureDirect = !health?.lan_exposure || health.lan_exposure.direct === true;
  const noticeScope = serverIdOfPath(window.location.pathname) ?? "";
  const directNotice = useDirectNotice(noticeScope, directHostOf(health));
  const accountSignedIn = useAccountSignedIn();
  const relayNoticeInfo = relayNoticeOf(health, accountSignedIn !== null);
  const relayNotice = useRelayNotice(noticeScope, relayNoticeInfo);
  const { error, setError } = useRosterError();
  const { layoutNotice, setLayoutNotice } = useLayoutNotice();
  const { locked, setLocked, lockReason, pairCode, consumePairCode, pairingUnconfirmed, onPaired, auth, canSignOut, security, readBridgeHealth } = useAccessState({ ui: settings.uiFontFamily, chat: settings.chatFontFamily });
  const pendingAccess = locked === true ? false : auth === null ? undefined : auth.authenticated && auth.role === "drive" && auth.via !== "open";
  const { pairedNotices, setPairedNotices, dismissPairedNotice, relayPairings, setRelayPairings, remotePairings, setRemotePairings, removedNotices, setRemovedNotices, dismissRemovedNotice, pendingKeys, setPendingKeys, clearPendingKeys } = usePairedNotices(pendingAccess, auth?.role === "watch");
  const ownWindow = ownWindowHere(health?.auth);
  const { prompts, joins: ownJoins, reread: rereadOwnJoins } = useOwnWindowPrompts(relayPairings, pendingKeys, ownWindow, locked === false);
  const updates = useUpdates(locked === false);
  const desktopUpdate = useDesktopUpdate();
  const { selectedPaneId, setSelectedPaneId, notificationViewTarget, setNotificationViewTarget, terminalPeek, setTerminalPeek, endPeek, pendingLink, linkLanded, setLinkLanded, rosterSeq, linkSince, selectionSince, rosterTick, setRosterTick, linkTick, setLinkTick } = useSelectionState({ initialLink });
  const { otherRecheck, otherRosterTick, setOtherRosterTick } = useSplitRecheck();
  const { rosterIn, pendingFile, selectionHint, headerNote, setHeaderNote, note: linkNote, autoSelected, setAutoSelected } = useLinkLanding({ initialLink, otherRecheck, setOtherRosterTick, pendingLink, rosterSeq, setRosterTick, linkLanded, t });
  const inboxMode = useInboxMode({ startsIn: () => pageStartsInInbox(phoneInboxOn(settings), window.matchMedia?.(SHEET_QUERY).matches === true, initialLink) });
  const { drawerOpen, setDrawerOpen, drawerOpenRef, toggleDrawerByButton, secondTapOfOpening, wideScreen, sidebarCollapsed, setSidebarCollapsed, sidebarWidth, setSidebarWidth, filePanelAvailable, filePanelWidth, setFilePanelWidth, sidebarFilterRequest, openSidebarFilter } = useSidebarLayout({ initialLink, drawerBlocked: inboxMode.drawerBlocked });
  const inbox = useInbox({ on: inboxMode.on, initialLink, drawerOpenRef });
  const note = headerNote === "pane-closed" && inboxMode.on ? t("That link's chat is closed") : linkNote;
  const { peeking: sidebarPeeking, sidebarRef: peekSidebarRef, toggleRef: peekToggleRef, toggleHandlers: peekToggleHandlers, sidebarHandlers: peekSidebarHandlers } = useSidebarPeek(settings.sidebarPeek && wideScreen && sidebarCollapsed);
  const { selectionRef, movingPanes } = useSelectionMark({ selectedMachineId, selectedPaneId });
  const { lens, setLens, viewPicks, setViewPicks } = usePaneLensState();
  const { split, setSplit, soloSlot, endSplit, splitRef, splitShownRef, lastKeyAtRef, paneDragging, setPaneDragging, gridDrop, gridDropRef, showGridDrop, hideDropTarget, clearDropPreview, paneAreaRef, tabDrag, draggedPaneRef, markSwap, markMove } = useSplitState();
  useKeptPaneBoxes(paneAreaRef, inbox.shown);
  const { paletteOpen, paletteQuery, openPalette, setPaletteOpen } = useCommandPalette();
  const paneControls = useRef<PaneControls | null>(null);
  const [findRequest, setFindRequest] = useState<{ paneId: string | null; serial: number }>({ paneId: null, serial: 0 });
  const { searchRequest, requestSearch } = useSearchRequest(setDrawerOpen);
  const searchable = (machineId: string, pane: HerdrPane, lens: PaneView): boolean =>
    showsChat(pane, lens) && machineSessions.peek(machineId)?.socket.canSearchConversation() === true;
  const { renameRequest, requestRename, clearRenameRequest } = useRenameRequest(selectedMachineId, selectedPaneId);
  const { renameRequest: closeTabRequest, requestRename: requestCloseTab, clearRenameRequest: clearCloseTabRequest } = useRenameRequest(selectedMachineId, selectedPaneId);
  const moreMenu = useMoreMenu();
  const hostedSignIn = useHostedSignIn();
  // where Add a PC leads on a phone: a PC reached through the hosted app (in a browser or in the phone app, which opens
  // it there) goes to the hosted app's Add a PC, one the phone app opened by its address to the app's own screens
  const addPcTo = addPcExit({ nativeApp: inNativeApp(), relayShell: shellMode() === "relay", pathname: window.location.pathname });
  const { more, setMore, closeMore, group: moreGroup, openGroup: openMoreGroup, closeGroup: closeMoreGroup } = moreMenu;
  const paneActionsRef = useRef<((target: HerdrPane, options?: { counted?: boolean }) => RowMenuItem[]) | null>(null);
  const paneLocked = usePaneLocked(selectedMachineId);
  const { filesOpen, setFilesOpen, filesDocked, filesCovered, revealFiles, viewing, openFile, closeFile, hideFile, leaveFile, restoreFile, fileFromPop, forgetLeftFiles, diffViewing, openDiff, closeDiff, releaseDiff, presentation, fileDocked, webPage, closeWebPage, openWebPage, openDiffFile, reportFileKind, toggleFilePresentation, viewFile } = useFilePanels({ settings, filePanelAvailable, selectedPaneId, selectedMachineId });
  // a diff's line notes go to its own pane: none while this window only watches that pane
  const diffPaneObserving = usePaneObserving(diffViewing?.paneId ? paneStorageId(diffViewing.machineId, diffViewing.paneId) : null);
  const { settingsOpen, setSettingsOpen, settingsLinkPage, setSettingsLinkPage, settingsLinkSection, setSettingsLinkSection, settingsPage, settingsSection, setSettingsSection, closeSettings, onSettingsPage } = useSettingsDialog(initialLink);
  const { newSessionOpen, setNewSessionOpen, newPrefill, setNewPrefill, newFields, setNewFields, pendingCreate, newSessionPending, newTab, setNewTab, sessionHistory, setSessionHistory, worktreeFor, setWorktreeFor } = useNewSessionState({ initialLink, watching: auth?.role === "watch" });
  const { connected, setConnected, connectedBefore, setConnectedBefore, paneLost, outputStopped, setOutputStopped, reportedBy, setReportedBy } = useConnectionChip();
  const { notifications, setNotifications, pushOn, setPushOn, pushOnRef } = useNotificationState();
  const { receive: receivePreferences, saveError: settingsSaveError, paused: settingsSavePaused, retrying: settingsSaveRetrying, retry: retrySettingsSave, resubscribed: preferencesResubscribed, disconnected: preferencesDisconnected, closed: preferencesClosed, known: sharedSettingsKnown } = usePreferencesSync(locked === false);
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
  const { snapshotRequests, recovery, reorderCoordinator, load, scheduleRefetch, onRosterStream, rosterConnection } = useRosterLoader({ locked, healthFailing: localFreshness === "unknown" || localFreshness === "unavailable", rosterIn, setMachines, setMachineRosterLoaded, setError, setLocked, loadHealth, lockedRef, refetchTimer });

  const { dropIn, chime, onRoster, onPaneStatus, onPaneExited } = useAlertSignals({ settings, selectionRef, drawerOpenRef: inbox.coveredRef, splitRef, splitShownRef, machinesRef, alertsRef, alertsOnRef, pushOnRef, statusRef, turnStartRef, lastTurnRef, alertSoundRef });

  // herdr moved a pane under a new ID, from anywhere (the server's pane-moved): followPaneMove below, called at the event
  useRosterEvents({ onPaneMoved: (machineId, from, to) => followPaneMove(machineId, from, to), machineSessions, locked, onRosterStream, receivePreferencesRef, snapshotRequests, recovery, onRoster, reorderCoordinator, setMachines, rosterIn, setMachineRosterLoaded, machinesRef, onPaneStatus, onPaneExited, followFocusRef, selectionRef, splitShownRef, splitRef, pendingLink, selectionHint, setSelectedPaneId, setNotificationViewTarget, setTerminalPeek, setAutoSelected, scheduleRefetch, preferencesResubscribedRef, preferencesDisconnectedRef, preferencesClosedRef, dropIn, chime, setPairedNotices, setRelayPairings, setRemotePairings, setRemovedNotices, setPendingKeys, getTakeNotificationTargetRef: () => takeNotificationTargetRef });

  const handleServerMessage = useServerMessageHandler(setOutputStopped);

  const { enableNotifications, disableNotifications, repairNotifications } = useNotificationSwitch({ updateSettings, locked, notifications, setNotifications, alerts, alertsRef, alertsOn, setPushOn });
  const localSnapshot = machines.find((machine) => machine.id === "local")?.snapshot ?? null;
  const setupGuide = useSetupGuide({
    enabled: locked === false,
    workspaces: machineRosterLoaded && localSnapshot !== null ? localSnapshot.workspaces.length : null,
    // undefined holds the decision until the access facts and this device's role are in: a failed read decides nothing
    pairingGate: security.state === "loading" || security.state === "error" || auth === null ? undefined : security.state === "known" ? security.summary.pairing_gate : null,
    watching: auth?.role === "watch",
    showUsage: settings.showUsage,
  });
  const guideShown = setupGuide.guide !== null && !setupGuide.paused;
  const rowFacts = setupGuide.guide === null && auth?.role !== "watch" && localSnapshot !== null;
  const rowStore = browserStorage();
  const rowOn = rowFacts && rowStore !== null && setupRowState(rowStore) === "on";
  const deviceNotices = useAccountDeviceNotices({ machines, machineSessions, selectedMachineId, pageServerId: health?.web_ui?.server_id });
  const otherDevicePaired = useOtherDevice(rowOn, [...pairedNotices, ...removedNotices].map((notice) => notice.event_id).join(" "), true);
  const alertsHealth = usePushHealth();
  const rowAlerts = alertsSurfaces(alertsHere({ alertsOn, notifications, desktop: desktopUpdateBridge() !== null, pushSupported: pushSupported(), pushOn, push: { checked: alertsHealth.checked, problem: alertsHealth.health.problem, delivered: alertsHealth.delivered }, confirmed: confirmation(registeredPushEndpoint()) })).row;
  const setupRow = rowOn && otherDevicePaired !== undefined && rowAlerts !== "wait"
    ? <SetupProgressRow facts={{ workspace: localSnapshot.workspaces.length > 0, phone: otherDevicePaired !== null, alerts: rowAlerts === "done" }} actions={{
      workspace: () => actions.openNewSession(),
      // Add a connection on the Ovis relay tab, which needs no Tailscale; Tailscale only when picked there
      phone: () => { askAddConnection("relay"); setSettingsLinkPage("devices"); setSettingsOpen(true); },
      // the guide's alerts step's own call; a browser that refused says why in Settings → Alerts
      alerts: () => { void enableNotifications().then((result) => { if (alertsFailed(result, desktopUpdateBridge() !== null)) { setSettingsLinkPage("alerts"); setSettingsOpen(true); } }); },
    }} />
    : null;
  const inMode = inboxMode.on && !guideShown;
  inboxMode.drawerBlocked.current = inMode;
  const { leave: leaveModeShell } = inboxMode;
  const { enterInbox: enterInboxShell, returnTo } = useInboxShell({ inMode, shown: inbox.shown, show: inbox.show,
    open: () => {
      if (selectedPaneId === null) return;
      activateSlotOf({ machineId: selectedMachineId, paneId: selectedPaneId });
      selectTarget(selectedMachineId, selectedPaneId, "chat");
    }, enter: inboxMode.enter, setDrawerOpen, hideFile, selectedPaneId, linkLanded, wide: wideScreen,
    here: () => {
      if (selectedPaneId === null || !linkLanded) return null;
      const layout = snapshot?.layouts.find((item) => item.tab_id === selectedPane?.tab_id) ?? null;
      const cells = layout ? layoutCells(layout).map((cell) => cell.paneId) : [selectedPaneId];
      return wayInOpensThread({
        hasRow: inboxOrder(sidebarMachines, activity).some((row) => row.machine.id === selectedMachineId && row.entry.pane.pane_id === selectedPaneId),
        view, peek: terminalPeek !== null && terminalPeek.machineId === selectedMachineId && terminalPeek.paneId === selectedPaneId,
        drawnPanes: soloPane(layout, cells, selectedPaneId, !wideScreen) === null ? cells.length : 1, splitShown: splitOn,
      }) ? sidebarPinKey(selectedMachineId, selectedPaneId) : null;
    },
    thread: inMode && !inbox.shown && selectedPaneId !== null && linkLanded ? sidebarPinKey(selectedMachineId, selectedPaneId) : null,
    focusInput: () => paneControls.current?.focusInput() });
  const modeOffered = !guideShown;
  // the sidebar's foot, with its Inbox beside the gear, is on screen: More need not offer the way in too
  const footShown = modeOffered && wideScreen && !sidebarCollapsed && !inMode;
  // a phone's open drawer: the header's toggle is the Ovis mark, and its title the PC and workspace
  const drawerHead = !wideScreen && drawerOpen && !inMode;
  const { enter: enterInbox, leave: leaveMode } = useCountedInboxWays(enterInboxShell, leaveModeShell);
  useShownCount("inbox", modeOffered, LOCAL_MACHINE);


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
    clearPendingKeys();
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
  }, [auth?.via, clearPendingKeys, loadHealth, t]);

  const { selectedMachineRef, selectTarget, selectTargetRef, picks } = useSelectTarget({ selectedMachineId, setConnected, setConnectedBefore, setSelectedMachineId, setSelectedPaneId, setAutoSelected, setDrawerOpen, setOutputStopped, setNotificationViewTarget, setTerminalPeek, pendingLink, pendingFile, setLinkLanded, selectionHint, selectionSince, rosterSeq, snapshot, selectedMachine, selectedPaneId, setHeaderNote, linkTick, movingPanes, onPick: (paneId) => { setupGuide.stepAside(); if (paneId !== null) inbox.leave(); },
    onLinkMiss: () => { if (inbox.enabled) inbox.show(); } });

  const { selectPane } = useSelectPane({ pendingLink, pendingFile, setLinkLanded, selectionHint, selectedPaneId, setSelectedPaneId, setNotificationViewTarget, setTerminalPeek, setAutoSelected, setDrawerOpen, setHeaderNote, onPick: () => { picks.current += 1; setupGuide.stepAside(); inbox.leave(); } });

  const layoutRefused = useLayoutRefused(setLayoutNotice, t);
  const moveRefused = useMoveRefused(setLayoutNotice, t);
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
  const movePanes = (dragged: SplitTarget, targetPaneId: string, side: PaneDirection): void => {
    void movePaneBeside(dragged.paneId, targetPaneId, side, dragged.machineId).then((move) => {
      const notice = paneMoveNotice(move, side, t);
      if (notice !== null) setLayoutNotice(notice);
      void load();
    }).catch((err: unknown) => { moveRefused(err); void load(); });
  };

  // Nothing is sent: held text waits for its Send or Discard
  const followPaneMove = (machineId: string, from: string, to: string): void => {
    carryMovedPane(machineId, from, to);
    updateSettings(({ lockedAgents, agentGroupOf }) => ({
      lockedAgents: [...movedSidebarPins(lockedAgents, machineId, from, to)],
      agentGroupOf: { ...movedAgentGroup(agentGroupOf, machineId, from, to) },
    }));
    const view = movedView(selectionRef.current, splitRef.current, machineId, from, to);
    if (view.split !== null) setSplit(view.split);
    if (view.selection === null) return;
    const listed = inbox.shownRef.current;
    // the shown pane moved, not picked: its note stays
    selectTargetRef.current(machineId, view.selection, undefined, true);
    if (listed) inbox.show();
  };
  const { takeNotificationTargetRef } = useNotificationTargets({ machinesRef, selectTargetRef, selectionHint, pendingLink, pendingFile, setLinkLanded, linkSince, rosterSeq, setLinkTick, load, onLinkWait: () => inbox.leave() });


  const { selectedPane } = useSelectedPane({ snapshot, selectedPaneId });
  useScreenWakeLock(settings.keepScreenOn && locked === false && selectedPane !== null && !inbox.shown);
  const { selectedWorkspace, presentedPaneId } = useSelectedLayout({ selectedPane, snapshot, drawerOpen: drawerOpen || inbox.shown, selectedMachineId, selectedPaneId, setSelectedPaneId, setAutoSelected });
  const tabStripMounted = selectedPane !== null && selectedWorkspace !== null;
  const targetHerdr = selectedMachineId === "local" ? health?.herdr : selectedMachine?.herdr;
  const appLayout = appLayoutOf(targetHerdr);
  const herdrOn = (machineId: string) => machineId === "local" ? health?.herdr : machines.find((machine) => machine.id === machineId)?.herdr;
  const appLayoutOn = (machineId: string) => appLayoutOf(herdrOn(machineId));
  const shownHerdr = selectedMachineId === "local" ? shownHealth?.herdr : targetHerdr;
  const shownTerminal = machineSessions.peek(selectedMachineId)?.socket;
  const picturesByDefault = shownTerminal?.hasTerminalHistory() === true
    || (shownTerminal?.featuresListed() !== true && shownHerdr?.runtime === "herdr-core" && shownHerdr.terminal_attach !== false);
  const selectedTitle = selectedPane ? displayPaneTitle(selectedPane) : null;
  const tabPanelLabel = paneTabPanelLabel(snapshot, selectedPane, t);
  const selectedAgent = selectedPane?.agent ?? null;
  const desktopBrowser = useDesktopBrowser();
  // a herdr not heard from yet (or a server that predates the flag) counts as attach-capable; a failed
  // health read keeps this PC's last answer (lib/healthPresentation.ts)
  const terminalAttach = targetHerdr?.terminal_attach !== false || targetHerdr?.terminal_mirror === true;
  const attachOn = (machineId: string): boolean => { const herdr = herdrOn(machineId); return herdr?.terminal_attach !== false || herdr?.terminal_mirror === true; };

  const { lenses, view, pressPane } = usePaneLens({ settings, selectedPaneId, selectedMachineId, selectedPane, selectedAgent, terminalAttach, attachOn, notificationViewTarget, setNotificationViewTarget, lens, setLens, viewPicks, terminalPeek, setTerminalPeek });
  const selectedSearchable = selectedPane !== null && terminalPeek === null && searchable(selectedMachineId, selectedPane, view);

  const contentKey = paneContentKey(selectedMachine, selectedPane, view);
  const { dialogCover, webDialogCover, contentReady } = usePaneCoverage({ contentKey });
  // the desktop app's built-in browser (BrowserPanel.tsx): its tabs while it is on, and the one shown in the file panel's place
  const browserTabs = desktopBrowser?.tabs ?? null;
  const { selected: browserTab, select: setBrowserTab, shown: shownBrowserTab, opened: setOpeningTab } = useShownBrowserTab(browserTabs);
  // a tab opens in the file panel's place: a web page or a docked file there gives way to it
  const openBrowserTab = (tab: number | "new") => {
    if (webPage !== null) closeWebPage(true);
    if (viewing !== null && fileDocked) closeFile();
    setBrowserTab(tab);
  };
  const browserShown = browserTabs !== null && filePanelAvailable && !inMode && (browserTab === "new" || shownBrowserTab !== null) && webPage === null && !(viewing !== null && fileDocked);
  const panePresence = useCallback((): PanePresence => !(locked === false && linkLanded && pendingFile.current === null && pendingCreate.current === null
    && !drawerOpen && !settingsOpen && !newSessionOpen
    && !(filesOpen && !filesDocked) && !machineDialog && !paletteOpen && !diffViewing && !(viewing && !fileDocked)
    && !dialogCover && !paneCovered() && !inbox.shown) ? "covered"
    : contentReady && paneContentPresented(contentKey) ? "front" : "loading",
  [locked, linkLanded, inbox.shown, drawerOpen, settingsOpen, newSessionOpen, filesOpen, filesDocked, machineDialog, paletteOpen, diffViewing, viewing, fileDocked, dialogCover, contentReady, contentKey]);
  const activity = useSidebarActivityState(machines, selectedMachineId, presentedPaneId, panePresence, shareSeen);
  useAgentStateStamping(machines, activity);

  const agentOf = (machineId: string, paneId: string) => machines.find((machine) => machine.id === machineId)?.snapshot?.panes.find((pane) => pane.pane_id === paneId)?.agent;
  const { pickView, setView } = usePaneViewPicks({ setViewPicks, setNotificationViewTarget, setTerminalPeek, setLens, setAutoSelected, selectedPaneId, selectedMachineId, view, agentOf });
  const { unsentFor, openUnsent, closeUnsent, recover } = useUnsentRecovery({ selectedMachineId, selectedPaneId, setView, pickView });
  useShownCount("view_switch_header", selectedPane !== null && !inbox.shown, selectedMachineId);
  usePhoneSheetBack(() => endPeek(), terminalPeek !== null, true);

  const { splitOn, others, shownSlots, rects, follows, activateSlot, activateSlotOf, closeSlot, selectInSlot, dockSide, splitDragOn, paneDragOver, paneDragLeave, paneDrop, dividers, resizeDivider, gridPreview } = useSplitLayout({ machines, split, wideScreen, selectedPaneId, selectedPane, selectedMachineId, splitShownRef, health, machineRosterLoaded, endSplit, otherRecheck, otherRosterTick, setSplit, soloSlot, setConnected, setConnectedBefore, setSelectedMachineId, setSelectedPaneId, setAutoSelected, setOutputStopped, setHeaderNote, splitRef, selectPane, paneAreaRef, gridDrop, gridDropRef, clearDropPreview, tabDrag, showGridDrop, hideDropTarget, setPaneDragging, movingPanes, draggedPaneRef, markSwap, markMove, swapPanes, movePanes, followPaneMove, arrangeRefused: (machineId) => !appLayoutOn(machineId).arrange, threadDrawn: inMode && !inbox.shown });

  usePhoneSheetBack(() => { if (newSessionPending.current) return false; closeNewSession(); }, newSessionOpen && inbox.shown);
  useAddressBar({ inbox, mode: { on: inMode, lands: inboxMode.at }, newSessionOpen, newSessionMachineId, selectedPane, selectedPaneId, selectedWorkspace, viewing, selectedMachineId, leaveFile, restoreFile, fileFromPop, forgetLeftFiles, locked, machines, snapshot, linkLanded, view, settingsOpen, settingsPage, settingsLinkPage, settingsLinkSection, wideScreen, sidebarCollapsed, newTab, newFields, autoSelected, pendingFile, selectedMachine, openFile, machinesRef, selectTargetRef, pendingLink, setLinkLanded, linkSince, rosterSeq, setNewSessionOpen, pendingCreate, newSessionPending, setHeaderNote, selectionRef });


  const { bell, alertsOffDot } = alertsBell({ t, alertsOn, notifications, pushOn, enableNotifications, disableNotifications });
  // a page the phone app restored whose reload waits for the person (RestoreNotice): while it is not connected it says
  // so as stopped output does, never that it is reconnecting
  const restoreHeld = useRestoreHeld() > 0;
  const waitsForPerson = outputStopped || (restoreHeld && !connected);
  const headerConnection = useHeaderConnection({ scope: `${split ? split.active : soloSlot}:${selectedMachineId}`, reportedBy, connected, connectedBefore, outputStopped: waitsForPerson });
  // a reconnect the header does not name yet (its first second) shows the connection as it was: nothing flashes
  const chipConnected = connected || (connectedBefore && !waitsForPerson && headerConnection === null);
  const connWord = t(chipConnected ? "live" : waitsForPerson ? "disconnected" : connectedBefore ? "reconnecting" : "connecting");
  const session = useSessionStats(selectedMachineId, selectedPane?.pane_id ?? null);
  const sessionLines = session === null ? null : sessionMenuLines(session);
  const sessionShort = session === null ? [] : [workedWords(session), sizeWords(session)].filter((part) => part !== null);
  const crumb = selectedPane && selectedTitle !== null
    ? headerCrumb({ machine: selectedMachine?.name ?? selectedMachineId, machineCount: machines.length, workspace: selectedWorkspace?.label ?? selectedPane.workspace_id, title: selectedTitle, cwd: selectedPane.cwd })
    : null;
  const tabPlace = snapshot ? tabPosition(snapshot, selectedPaneId) : null;
  const position = tabPlace && { ...tabPlace, words: t("Tab {index} of {count}", { index: tabPlace.index, count: tabPlace.count }) };

  const tabTitle = selectedPane && !inbox.shown ? tabPaneTitle(selectedPane) : null;
  useEffect(() => {
    document.title = tabTitle ? `${tabTitle} · Ovis` : APP_TITLE;
  }, [tabTitle]);

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

  // a pane hidden under the mode's list is not closed, typed into, split or zoomed by a key: the shortcuts listen on the window, past its inert slot
  // nor is an inbox mode thread: the mode's shell has no tab row, split or pane menu to close from
  const closeOffered = selectedPane !== null && auth?.role !== "watch" && !guideShown && !inbox.shown && !inMode && !paneLocked(selectedPane.pane_id);
  const tabCloseOffered = selectedPane !== null && tabStripMounted && auth?.role !== "watch" && !guideShown && !inbox.shown && !inMode;
  // C3 pin 1 (#16): a PC new in the account here takes no keyboard jump into its sessions, only a tap on one
  const keyJumpHeld = (): boolean => selectedMachineId === "local" && pcHeld();
  const actions = useMemo<AppActions>(
    () => ({
      selectPane,
      selectAdjacentPane: (direction) => {
        if (keyJumpHeld()) return;
        const panes = rosterPanes(snapshotRef.current?.panes ?? [], selectedPaneId);
        if (panes.length === 0) return;
        const index = panes.findIndex((pane) => pane.pane_id === selectedPaneId);
        const next = panes[(index + direction + panes.length) % panes.length];
        if (next) selectPane(next.pane_id);
      },
      selectAdjacentTab: (direction) => {
        if (keyJumpHeld()) return;
        const roster = snapshotRef.current;
        const viewed: ViewedPane = (scope, id) => lastViewedPane(scope, selectedMachineId, id);
        const next = roster ? adjacentTabPane(roster, selectedPaneId, direction, viewed) : null;
        if (next) selectPane(next);
      },
      selectTabNumber: (number) => {
        if (keyJumpHeld()) return;
        const roster = snapshotRef.current;
        const viewed: ViewedPane = (scope, id) => lastViewedPane(scope, selectedMachineId, id);
        const next = roster ? numberedTabPane(roster, selectedPaneId, number, viewed) : null;
        if (next) selectPane(next);
      },
      selectAdjacentWorkspace: (direction) => {
        if (keyJumpHeld()) return;
        const roster = snapshotRef.current;
        if (!roster) return;
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
      counted: appCounted((): AppCountingState => ({ actions, machineId: selectedMachineId, inbox, inMode, tabTarget: newTabTarget() !== null })),
      toggleView: (source) => { if (terminalPeek !== null) endPeek(); else setView(view === "chat" ? "terminal" : "chat", source); setDrawerOpen(false); },
      focusInput: () => { if (!inbox.shown) paneControls.current?.focusInput(); },
      scrollPage: (direction) => paneControls.current?.scrollPage(direction),
      openNewSession: () => {
        setDrawerOpen(false);
        setNewSessionMachineId(selectedMachineId);
        setNewTab(null);
        setNewSessionOpen(true);
      },
      openNewTab: (target) => {
        if (target === undefined && (inbox.shown || inMode)) return;
        const found = newTabTarget(target);
        if (!found) return;
        const { machineId, workspace, cwd } = found;
        setDrawerOpen(false);
        setNewSessionMachineId(machineId);
        setNewTab({ workspaceId: workspace.workspace_id, workspaceLabel: workspace.label, cwd, number: workspace.tab_count + 1 });
        setNewSessionOpen(true);
      },
      renameTab: () => {
        if (selectedPaneId === null || !tabStripMounted || !appLayout.rename || inbox.shown || inMode) return;
        setDrawerOpen(false);
        requestRename(selectedMachineId, selectedPaneId);
      },
      openTerminalTab: async (target) => {
        if (target === undefined && (inbox.shown || inMode)) return;
        const found = newTabTarget(target);
        if (!found) return;
        const asked = selectionRef.current;
        const shellAsked = [inboxMode.drawerBlocked.current, inbox.shownRef.current];
        const ahead = catchTypeAhead();
        let created: Awaited<ReturnType<typeof createTab>>;
        try {
          created = await createTab({ workspace_id: found.workspace.workspace_id, cwd: found.cwd, label: null, agent: null }, found.machineId);
        } catch (reason) {
          ahead?.drop();
          throw reason;
        }
        void load();
        const still = selectionStill(asked, selectionRef.current) && shellAsked[0] === inboxMode.drawerBlocked.current && shellAsked[1] === inbox.shownRef.current;
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
        const agent = sessionHistoryListAgent(target, found.agent, found.panes.map((pane) => pane.agent));
        if (agent === null) return;
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
        const machine = machinesRef.current.find((candidate) => candidate.id === found?.machineId);
        if (!found || machine?.state !== "connected" || !worktreesStartHere(found.machineId, found.workspace, machine.snapshot?.herdr_lifetime)) return;
        setDrawerOpen(false);
        setWorktreeFor({ machineId: found.machineId, machineName: machine.name, workspace: found.workspace, mode });
      },
      openPalette,
      agentStarted: (machineId, paneId) => lenses.startedAgent(lensOwner(machineId, paneId), window.matchMedia?.("(pointer: coarse)").matches === true),
      openFind: () => {
        if (selectedPaneId === null) return;
        if (terminalPeek?.paneId !== selectedPaneId || terminalPeek.machineId !== selectedMachineId) setView("terminal", null);
        setDrawerOpen(false);
        setFindRequest((request) => ({ paneId: selectedPaneId, serial: request.serial + 1 }));
      },
      openSettings: () => {
        setDrawerOpen(false);
        setSettingsSection(null);
        setSettingsOpen(true);
      },
      openAddPc: (preset) => {
        setSettingsOpen(false);
        setUpdateRemote(false);
        addPcFocusReturn.current = true;
        setAddPcPreset(preset ?? null);
        setMachineDialog("new");
      },
      connectPc: (machine) => {
        setSettingsOpen(false);
        if (pairedPc(machine)) {
          const at = picks.current;
          void load().finally(() => { if (picks.current === at) selectTarget(machine.id, null); });
          return;
        }
        setUpdateRemote(false);
        addPcFocusReturn.current = true;
        setMachineDialog(machine);
      },
      toggleSidebar: () => {
        if (inMode) return;
        if (window.matchMedia("(max-width: 768px)").matches) setDrawerOpen((open) => !open);
        else setSidebarCollapsed((collapsed) => !collapsed);
      },
      openSidebarFilter: () => { if (!inMode) openSidebarFilter(); },
      inboxMode: modeOffered ? { on: inMode, go: inMode ? leaveMode : enterInbox } : null,
      toggleTheme: () => updateSettings({ theme: resolvedTheme === "dark" ? "light" : "dark" }),
      lock: canSignOut ? lock : null,
      enableNotifications: bell.run === enableNotifications ? () => void enableNotifications() : null,
      refresh: () => void load(),
      openFiles: selectedPaneId !== null ? () => { setDrawerOpen(false); revealFiles(); } : null,
      // the page is this PC's whichever PC is selected: the browser reaches it under the app's own host,
      // which in the hosted shell is not the PC (and its frame-src frames no other port)
      openLocalPage: settings.webLinks === "panel" && shellMode() !== "relay" ? (url) => { setDrawerOpen(false); openWebPage(url, false, LOCAL_MACHINE); } : null,
      searchConversation: selectedSearchable && selectedPaneId !== null ? () => requestSearch(split ? split.active : soloSlot, selectedMachineId, selectedPaneId) : null,
      ...layoutActions({ selectedPaneId: inbox.shown || inMode ? null : selectedPaneId, offer: appLayout, paneSplits: !selectedPane?.own_tab, selection: selectionRef, roster: snapshotRef, load, selectPane, layoutRefused }),
      closePane: !closeOffered ? null : () => {
        const target = snapshotRef.current?.panes.find((pane) => pane.pane_id === selectionRef.current.paneId);
        if (target) closeFromPaneMenu(paneActionsRef.current, target);
      },
      closeTab: !tabCloseOffered ? null : () => requestCloseTab(selectedMachineId, selectedPaneId!),
    }),
    [closeOffered, tabCloseOffered, requestCloseTab, inbox.shown, inMode, modeOffered, enterInbox, leaveMode, revealFiles, selectPane, selectTarget, selectedPaneId, selectedPane?.own_tab, selectedMachineId, appLayout, reorderCoordinator, tabStripMounted, setView, view, terminalPeek, endPeek, updateSettings, resolvedTheme, canSignOut, lock, bell.run, enableNotifications, load, layoutRefused, moveRefused, lenses, openSidebarFilter, selectedSearchable, requestSearch, split, soloSlot, settings.webLinks, settings.sidebarBackgroundWorkspaces, openWebPage],
  );

  useShortcuts(actions, locked === false);
  const herdrPrefixWaiting = useHerdrPrefixKeys(actions, locked === false, setLayoutNotice);

  useMachineGone({ machines, pendingLink, pendingFile, pendingCreate, selectedMachineRef, linkSince, selectionSince, rosterSeq, setLinkLanded, setHeaderNote, selectTargetRef, rosterTick, linkTick });
  const sidebarMachines = useShownMachines({ machines, selectedMachineRef, selectTargetRef, picks, restored: !linkSelects(initialLink) });
  const waitingRosters = useWaitingRosters(sidebarMachines, machines.find((machine) => machine.id === selectedMachineId), activity.status);
  const sessionTally = sessionCountsAcross(waitingRosters);
  const nextWaiting = nextWaitingTarget(waitingRosters, { machineId: selectedMachineId, paneId: selectedPaneId });
  const openNextWaiting = (): void => { if (nextWaiting !== null) selectTarget(nextWaiting.machineId, nextWaiting.paneId, inMode ? "chat" : undefined); };

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
  useEffect(() => {
    const onPop = (): void => setCreateTick((tick) => tick + 1);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const { closeNewSession, closeSessionHistory, recentResumes, rememberResume, sessionHistoryWorkspace } = useSessionHistoryList({ machines, sessionHistory, setSessionHistory, setNewSessionOpen, setNewPrefill, setNewFields });

  const keyboardLikely = useMediaQuery("(hover: hover) and (pointer: fine)");
  const paletteKeys = keyboardLikely ? formatKeys(shortcutDisplayKeys("palette", settings.shortcutOverrides)).join("+") : "";
  const shortcutTitle = (label: string, id: "palette" | "toggle-sidebar" | "toggle-view" | "settings"): string => {
    const keys = formatKeys(shortcutDisplayKeys(id, settings.shortcutOverrides));
    return keys.length === 0 ? label : `${label} (${keys.join("+")})`;
  };
  const isSheetWidth = useMediaQuery(SHEET_QUERY);
  // a phone's open drawer is a dialog over the pane (G-003): Tab stays in it, the pane column is inert under it, Escape
  // closes it and the focus goes back to the toggle that opened it (lib/headerSessions.ts useDrawerDialog)
  // only once the shell is drawn: a drawer a link opens behind the access gate takes its focus when it mounts
  const drawerModal = locked === false && drawerOpen && !wideScreen;
  const { ref: drawerRef } = useDrawerDialog(drawerModal, setDrawerOpen, [peekSidebarRef]);
  usePhoneSheetBack(() => setDrawerOpen(false), drawerModal, true);
  const { tabsInHeader, sheet: tabSheet, toggle: toggleTabSheet, close: closeTabSheet } = useTabSheet(selectedPane !== null && !guideShown && !inbox.shown && !inMode ? JSON.stringify([selectedMachineId, selectedPane.workspace_id]) : null);
  const cramped = useMediaQuery(CRAMPED_QUERY);
  const paneMenuInMore = selectedPane !== null
    && tabRowHidden(cramped, snapshot?.tabs.filter((tab) => tab.workspace_id === selectedPane.workspace_id).length ?? 0, tabsInHeader || inMode);
  const inboxWide = inMode && wideScreen;
  const moreWaiting = inMode && !inbox.shown && selectedPaneId !== null ? waitingElsewhere(waitingRosters, { machineId: selectedMachineId, paneId: selectedPaneId }) : sessionTally.waiting;
  const waitingInMore = moreWaiting > 0;
  const currentTabInMore = paneMenuInMore && selectedPane ? snapshot?.tabs.find((tab) => tab.tab_id === selectedPane.tab_id) : undefined;
  const currentTabPlace = currentTabInMore && snapshot ? snapshot.tabs.filter((tab) => tab.workspace_id === selectedPane!.workspace_id).indexOf(currentTabInMore) + 1 : 1;
  const currentTabName = currentTabInMore ? (customTabLabel(currentTabInMore, currentTabPlace) ?? tabLabel(currentTabInMore, t, currentTabPlace)) : null;
  const paneMoreItems = paneMenuInMore && selectedPane ? (paneActionsRef.current?.(selectedPane) ?? []).map((item, index): RowMenuItem => ({
    ...item, divider: index === 0 || item.divider,
    ...(item.id === "rename-tab" && currentTabName ? { hint: currentTabName, title: `${item.label} · ${currentTabName}` } : {}),
    run: () => paneActionsRef.current?.(selectedPane).find((fresh) => fresh.id === item.id)?.run(),
  })) : [];
  const moreBase = alertsOffDot ? t("More · alerts are off") : t("More");
  const moreLabel = waitingInMore ? `${moreBase} · ${t("{count} waiting for you", { count: moreWaiting })}` : moreBase;
  const findInTerminal: RowMenuItem[] = selectedPane && !selectedPane.restore_error ? [{ id: "find", label: t("Find in terminal"), icon: Search, run: actions.openFind }] : [];
  const findGroup = [...findInTerminal, ...paneMoreItems.filter((item) => item.id === "search-conversation")].map((item) => ({ ...item, divider: false }));
  const paneGroup = paneMoreItems.filter((item) => item.id !== "search-conversation" && !item.id.startsWith("pane:"));
  const foldFind = isSheetWidth && findGroup.length > 1;
  const foldPane = isSheetWidth && paneGroup.length > 1;
  const groupItems = openGroupItems(moreGroup?.kind ?? null, isSheetWidth, findGroup, paneGroup);
  useGroupClosedWhenEmpty(moreMenu, groupItems.length === 0);
  const inboxBack = inbox.enabled && !inbox.shown && !drawerOpen && !guideShown && !inboxWide;
  const moreItems: RowMenuItem[] = [
    // a phone's way to another PC (relay step 1): the hosted app's Add a PC, or the phone app's own screens
    // on a phone only, as the approved flow draws it: a desktop adds a PC from Settings → Devices and PCs
    ...[addPcMoreItem(addPcTo, isSheetWidth)].filter((item) => item !== null),
    ...(waitingInMore && nextWaiting !== null ? [{ id: "next-waiting", label: t("Open the next session waiting for you"), hint: String(moreWaiting), icon: CircleHelp, run: openNextWaiting }] : []),
    { id: "palette", label: t("Search panes and actions"), icon: Search, ...(paletteKeys ? { hint: paletteKeys } : {}), run: () => openPalette() },
    ...(foldFind && more ? [{ id: "find-group", label: t("Find…"), icon: TextSearch, run: () => openMoreGroup("find", more.anchor) }] : findInTerminal),
    ...(selectedPane && (!wideScreen || inMode) ? [{ id: "files", label: t("Browse files"), icon: FolderOpen, run: moreFilesRun(actions.counted, () => setFilesOpen(true)) }] : []),
    { id: "copy-link", label: t("Copy link"), icon: Link, run: () => void copyText(window.location.href).then((ok) => { if (ok) setHeaderNote("copied"); }) },
    { id: "alerts", label: t("Alerts"), hint: bell.state, checked: bell.on, title: bell.title, icon: Bell, run: () => void bell.run() },
    ...paneMoreItems.filter((item) => !(foldFind && item.id === "search-conversation") && (!foldPane || item.id.startsWith("pane:")))
      .map((item, index) => index === 0 ? { ...item, divider: true } : item),
    ...(foldPane && more ? [{ id: "pane-group", label: t("Pane and tab…"), icon: PanelsTopLeft, divider: true, run: () => openMoreGroup("pane", more.anchor) }] : []),
    ...(modeOffered && !footShown ? [{ id: "enter-inbox", label: t("Open agent inbox"), icon: Inbox, divider: true, run: () => { actions.counted?.("inbox", "menu"); enterInbox(); } }] : []),
    // a phone's account and Sign out of the hosted app, last, as the overview's foot had it: a desktop has them in
    // Settings → Devices and PCs, which the account line opens
    ...(isSheetWidth ? hostedAccountItems(hostedSignIn, t, () => { setSettingsLinkPage("devices"); setSettingsLinkSection("account"); setSettingsOpen(true); }) : []),
  ];
  const fromMore = (id: string): RowMenuItem[] => moreItems.filter((item) => item.id === id);
  const moreOnList = inbox.shown;
  const modeThreadItems: RowMenuItem[] = [
    ...(inboxWide ? [] : fromMore("next-waiting")), ...fromMore("find-group"), ...fromMore("find"),
    ...(foldFind ? [] : paneMoreItems.filter((item) => item.id === "search-conversation")),
    ...fromMore("files"), ...fromMore("copy-link"),
    ...paneMoreItems.filter((item) => item.id === "mirror-width" || item.id === "recover-unsent"),
  ].map((item) => ({ ...item, divider: false }));
  const modeLeadItems: RowMenuItem[] = [
    // a phone's way to another PC stays first in the inbox mode too
    ...fromMore("add-pc"),
    { id: "exit-inbox", label: t("Back to Ovis"), icon: PanelsTopLeft, glyph: <OvisMark />, run: leaveMode },
    ...fromMore("palette"),
  ];
  const modeEndItems: RowMenuItem[] = [
    ...fromMore("alerts").map((item) => ({ ...item, divider: false })),
    { id: "settings", label: t("Settings"), icon: SettingsGlyph, divider: true, run: () => { actions.counted?.("settings", "menu"); actions.openSettings(); } },
    ...fromMore("sign-out"),
  ];
  const modeAppItems: RowMenuItem[] = [...modeLeadItems, ...modeEndItems];
  const paletteOnly = inboxWide && (inbox.shown || selectedPane === null);
  const modeMoreItems: RowMenuItem[] = paletteOnly ? fromMore("palette") : moreOnList ? modeAppItems : inboxWide ? [...fromMore("palette"), ...modeThreadItems.map((item, index) => index === 0 ? { ...item, divider: true } : item)]
    : [...modeLeadItems, ...modeThreadItems.map((item, index) => index === 0 ? { ...item, divider: true } : item), ...modeEndItems];

  const chatShown = !inbox.shown && showsChat(selectedPane, view);
  // From 769px with one pane in view the header is one row, a browser's tab strip: the workspace's tabs and +,
  // then the lens switch, Files and More (styles.css .header-tabs, THIRD_PARTY_NOTICES.md).
  const phoneTabRow = tabsInHeader && !inbox.shown && !inMode;
  const workspaceTabCount = selectedPane ? snapshot?.tabs.filter((tab) => tab.workspace_id === selectedPane.workspace_id).length ?? 0 : 0;
  const classicStripInHeader = (wideScreen ? !splitOn && !tabsInHeader : tabsInHeader) && !guideShown && snapshot !== null && selectedPane !== null && selectedWorkspace !== null;
  const stripInHeader = classicStripInHeader && !inMode;
  // from 769px with a mouse the pane column ends in the Herdr app's status bar: where the pane is, its branch,
  // the connection.
  const statusBarShown = wideScreen && keyboardLikely && selectedPane !== null && crumb !== null && !guideShown && !inMode;
  const waitingDot = waitingInMore && !statusBarShown && !inboxWide;
  const openNewOn = (id: string): void => { setNewSessionMachineId(id); setNewTab(null); setNewSessionOpen(true); setDrawerOpen(false); };
  const threadDrawn = inMode && !inbox.shown;
  const paneSplit = splitOn && !threadDrawn;
  useShownCount("view_switch_pane", paneSplit, selectedMachineId);
  const listScreen = inMode && inbox.shown && !inboxWide;
  const tabRoom = inMode && !inboxWide && !inbox.shown && selectedPane !== null && !chatShown && !tabRowHidden(cramped, workspaceTabCount, tabsInHeader);

  if (locked === null) {
    // the auth state is unknown until /api/health or /api/session answers (ten seconds when
    // herdr is down): show the shell without the terminal, and so without a WebSocket,
    // instead of a blank page.
    if (inMode) return <InboxConnecting wide={inboxWide} sidebarWidth={sidebarWidth} />;
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
  if (locked) return <AccessGate reason={lockReason} ownWindow={auth?.own_window === true} initialCode={pairCode} consumePairCode={consumePairCode} pairingUnconfirmed={pairingUnconfirmed} onPaired={onPaired} onUnlocked={unlock} />;

  const listNote = herdrPrefixWaiting ? t("herdr prefix: press a key") : note;
  const openThread = (machineId: string, paneId: string): void => { activateSlotOf({ machineId, paneId }); selectTarget(machineId, paneId, "chat"); };
  const modeList = (column: boolean): ReactNode => (
    <InboxList ref={inbox.list} machines={sidebarMachines} activity={activity} watching={auth?.role === "watch"} wide={column} filter={inbox.filter} onFilter={inbox.setFilter} query={inbox.query} onQuery={inbox.setQuery} scroll={inbox.scroll} focus={{ ...inbox.focus, row: returnTo }}
      current={column && !inbox.shown && selectedPaneId !== null ? sidebarPinKey(selectedMachineId, selectedPaneId) : null}
      onOpen={openThread}
      onNew={openNewOn} questionReads={inbox.questionReads} summaryReads={inbox.summaryReads}
      more={column ? undefined : { label: moreBase, expanded: more !== null && moreOnList, popup: isSheetWidth ? "dialog" : "menu", onPress: (anchor) => setMore((open) => (open ? null : { anchor })) }}
      note={column ? undefined : <HeaderNote note={listNote} />} connection={!column && listNote === null ? rosterConnection : null} failure={error === null ? null : { error, retry: load }} />
  );
  const railFrom = { machineId: selectedMachineId, paneId: inbox.shown ? null : selectedPaneId };
  const railNext = inboxWide ? nextWaitingTarget(waitingRosters, railFrom) : null;
  const railWaiting = railNext !== null ? { count: waitingTargets(waitingRosters, railFrom), open: () => openThread(railNext.machineId, railNext.paneId) } : null;
  const moreButton = (round: boolean): ReactNode => (
    <span className="header-more">
      <button
        type="button"
        className={`icon-button ${round ? "inbox-round " : ""}header-more-button`}
        aria-label={round ? t("More") : moreLabel}
        title={round ? t("More") : moreLabel}
        aria-haspopup={isSheetWidth ? "dialog" : "menu"}
        aria-expanded={(more !== null && !(inMode && moreOnList && !inboxWide)) || groupItems.length > 0}
        onClick={(event) => {
          const anchor = event.currentTarget;
          setMore((open) => (open ? null : { anchor }));
        }}
      >
        <Ellipsis />
      </button>
      {waitingDot ? <span className="header-more-dot is-waiting" data-count={moreWaiting} aria-hidden="true" /> : alertsOffDot && !round && <span className="header-more-dot" aria-hidden="true" />}
    </span>
  );
  const filesBeside = filesOpen && filesDocked && selectedPane !== null && !filesCovered;
  const toggleFiles = (): void => {
    if (filesBeside) setFilesOpen(false);
    else { actions.counted?.("files", "button"); revealFiles(); }
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
    <MachineSessionsProvider sessions={machineSessions} machineIds={machines.map((machine) => machine.id)}><MachineContext.Provider value={selectedMachineId}><AppLayoutContext.Provider value={appLayout}><div className={`app${(inMode ? !inboxWide : sidebarCollapsed) ? " sidebar-collapsed" : ""}${inMode ? " is-inbox" : ""}${listScreen ? " is-inbox-list" : ""}${inboxWide ? " is-inbox-wide" : ""}${inboxWide && !inbox.shown && selectedPane !== null && !chatShown ? " is-inbox-terminal" : ""}${tabRoom ? " is-inbox-tab-room" : ""}`} style={sidebarWidth === null && filePanelWidth === null ? undefined : {
      ...(sidebarWidth === null ? {} : { "--sidebar-user-w": `${sidebarWidth}px` }),
      ...(filePanelWidth === null ? {} : { "--file-panel-user-w": `${filePanelWidth}px` }),
    } as CSSProperties}>
      {selectedPane !== null && !guideShown && !inbox.shown && <h1 className="visually-hidden">{selectedTitle}</h1>}
      {listScreen || inboxWide ? null : <header className={`app-header is-zoned${chatShown ? " is-chat" : ""}${stripInHeader && !phoneTabRow ? " has-tab-row" : ""}${phoneTabRow && stripInHeader ? " has-phone-tabs" : ""}`}>
        <div className="header-side">
          {wideScreen && !sidebarCollapsed && !inMode && <SidebarBrand dark={resolvedTheme === "dark"} />}
          {inboxBack ? <button type="button" id="inbox-back" className="icon-button inbox-back" aria-label={t("Back")} title={t("Back")} onClick={inbox.back}><ChevronLeft /></button> : <button
            type="button"
            id="drawer-toggle"
            className={`icon-button drawer-toggle${drawerHead ? " is-mark" : ""}`}
            aria-label={t(drawerOpen ? "Close workspace list" : "Open workspace list")}
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
            aria-controls="workspace-drawer"
            onClick={(event) => {
              // the mark stands where the menu button was: the opening double tap's second half does not close it
              if (drawerHead && secondTapOfOpening(event.timeStamp)) return;
              toggleDrawerByButton(event.timeStamp);
            }}
          >
            {drawerHead ? <OvisMark width="22" height="22" /> : drawerOpen ? <X /> : <Menu />}
          </button>}
          {!inMode && wideScreen && !sidebarCollapsed && settings.sidebarRows !== "two" && <button type="button" className="icon-button new-workspace-button" disabled={viewOnly(selectedMachineId) || selectedMachine?.state !== "connected"} aria-label={t("New workspace")} title={viewOnly(selectedMachineId) ? `${t("New workspace")} · ${t("View only")}` : t("New workspace")} onClick={() => { actions.counted?.("new_workspace", "button"); actions.openNewSession(); }}>
            <Plus aria-hidden="true" />
          </button>}
          {!inMode && <button type="button" className="icon-button palette-button" aria-label={t("Command palette")} title={shortcutTitle(t("Command palette"), "palette")} onClick={() => openPalette()}>
            <Search />
          </button>}
          {!inMode && <button
            type="button"
            className="icon-button header-desktop-only sidebar-toggle"
            aria-label={t(sidebarCollapsed ? "Show workspace list" : "Hide workspace list")}
            aria-pressed={!sidebarCollapsed}
            title={shortcutTitle(t("Toggle sidebar"), "toggle-sidebar")}
            onClick={() => { actions.counted?.("sidebar", "button"); setSidebarCollapsed((collapsed) => !collapsed); }}
            ref={peekToggleRef}
            {...peekToggleHandlers}
          >
            <PanelLeft />
          </button>}
        </div>
        <HeaderNote note={herdrPrefixWaiting ? t("herdr prefix: press a key") : note} />
        {stripInHeader ? (
          <div className={`header-tabs${phoneTabRow ? " is-phone" : ""}`}>
            <RenderBoundary resetKey={`${selectedMachineId}:${selectedPane.pane_id}`} fallback={(retry) => <RegionCrash message={t("This pane can't be shown.")} retry={retry} />}>
            <PanePressContext.Provider value={pressPane}>
              <TabStrip snapshot={snapshot} workspace={selectedWorkspace} selectedPane={selectedPane} onSelectPane={selectPane} splitDrag={!phoneTabRow} browserTabs={!phoneTabRow} phoneRow={phoneTabRow}
                sheet={phoneTabRow ? tabSheet : null} onSheetClose={closeTabSheet} closable={auth?.role !== "watch"}
                renameRequest={renameRequest?.machineId === selectedMachineId && renameRequest.paneId === selectedPane.pane_id ? renameRequest : null}
                onRenameHandled={clearRenameRequest}
                closeRequest={closeTabRequest?.machineId === selectedMachineId && closeTabRequest.paneId === selectedPane.pane_id ? closeTabRequest : null}
                onCloseHandled={clearCloseTabRequest}
                onNewTab={() => { actions.counted?.("new_tab", "button"); actions.openNewTab(); }}
                onNewTerminal={() => { actions.counted?.("new_tab", "button"); return actions.openTerminalTab(); }}
                onMoveToWorkspace={(tabId, workspaceId) => actions.moveTabToWorkspace({ machineId: selectedMachineId, tabId, workspaceId })}
                paneActions={(paneId) => {
                  const target = snapshot.panes.find((item) => item.pane_id === paneId);
                  if (!target || !paneActionsRef.current) return [];
                  return paneActionsRef.current(target).map((item) => ({ ...item, run: () => paneActionsRef.current?.(target).find((fresh) => fresh.id === item.id)?.run() }));
                }} />
            </PanePressContext.Provider>
            </RenderBoundary>
            {phoneTabRow && headerConnection !== null && <span className={`header-tabs-connection is-${headerConnection}`}>{connectionWord(headerConnection, t)}</span>}
            {phoneTabRow && viewOnly(selectedMachineId) && <span className="header-tabs-watch" title={t("View only")}><Eye aria-hidden="true" /><span className="visually-hidden">{t("View only")}</span></span>}
            {phoneTabRow && <button type="button" className="icon-button header-tabs-sheet" aria-label={t("Tabs of {workspace}", { workspace: selectedWorkspace.label })}
              title={t("Tabs of {workspace}", { workspace: selectedWorkspace.label })} aria-haspopup="dialog" aria-expanded={tabSheet !== null} onClick={(event) => toggleTabSheet(event.currentTarget)}>
              {workspaceTabCount > 1 && <span className="header-tabs-count" aria-hidden="true">{workspaceTabCount}</span>}
              <ChevronDown aria-hidden="true" />
            </button>}
          </div>
        ) : note !== null ? null : inbox.shown ? <Brand /> : inMode && selectedPane ? (
          <ThreadTitle machines={machines} activity={activity} machineId={selectedMachineId} pane={selectedPane} connection={headerConnection} watching={viewOnly(selectedMachineId)} severalPcs={sidebarMachines.length > 1} />
        ) : selectedPane && crumb && drawerHead ? (
          <DrawerHeadTitle machine={crumb.machine} workspace={crumb.workspace} connection={headerConnection} watching={viewOnly(selectedMachineId)} />
        ) : selectedPane && crumb ? (
          <div className={`context${headerConnection === null ? "" : " has-connection"}${tabsInHeader && selectedWorkspace && !guideShown ? " has-tabs" : ""}`} title={crumb.tooltip}>
            <div className="context-title">
              {selectedAgent && <AgentMark agent={selectedAgent} size={18} />}
              <span className="context-title-text" role="group" aria-label={[selectedAgent ? agentName(selectedAgent) : null, crumb.fullContext].filter((part) => part !== null).join(" · ")}>{selectedTitle}</span>
              {position && <span className="context-position" title={position.words}>
                <span aria-hidden="true">{position.index}/{position.count}</span>
                <span className="visually-hidden">{position.words}</span>
              </span>}
              {tabsInHeader && selectedWorkspace && !guideShown && <button type="button" className="context-tabs" aria-label={t("Tabs of {workspace}", { workspace: selectedWorkspace.label })}
                aria-haspopup="dialog" aria-expanded={tabSheet !== null} onClick={(event) => toggleTabSheet(event.currentTarget)}>
                <ChevronDown aria-hidden="true" />
              </button>}
            </div>
            <div className={`context-sub${headerConnection === null ? "" : ` context-connection is-${headerConnection}`}`}>
              {viewOnly(selectedMachineId) && !statusBarShown && <><span className="context-watch">{t("View only")}</span><span className="context-sep" aria-hidden="true">·</span></>}
              {headerConnection !== null ? <span>{connectionWord(headerConnection, t)}</span> : <>
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
        {selectedPane && (isSheetWidth || inMode) && !inbox.shown && (
          <LensToggle view={view} peek={terminalPeek !== null} terminalAttach={terminalAttach} thread={inMode}
            title={(label) => shortcutTitle(label, "toggle-view")} onToggle={() => actions.toggleView("header")} />
        )}
        {selectedPane && !isSheetWidth && !inMode && (
          <div className="view-switch" data-view={view} role="group" aria-label={`${t("Chat")} / ${t("Terminal")}`}>
            <button type="button" className="lens-option is-chat" aria-pressed={view === "chat"} aria-label={t("Chat")} title={shortcutTitle(t("Chat transcript"), "toggle-view")}
              onClick={() => { setView("chat", "header"); setDrawerOpen(false); }}>
              <MessageCircle aria-hidden="true" />
              <span className="lens-label">{t("Chat")}</span>
            </button>
            <button type="button" className="lens-option is-terminal" aria-pressed={view === "terminal"} aria-label={terminalAttach ? t("Terminal") : `${t("Terminal")} · ${t("soon")}`}
              title={!terminalAttach ? t("Live terminal: coming to Windows PCs once herdr can attach there") : shortcutTitle(t("Live terminal"), "toggle-view")}
              onClick={() => { setView("terminal", "header"); setDrawerOpen(false); }}>
              <SquareTerminal aria-hidden="true" />
              <span className="lens-label">{t("Terminal")}</span>
              {!terminalAttach && <span className="pill pill-soon">{t("soon")}</span>}
            </button>
            <span className="lens-thumb" aria-hidden="true" />
          </div>
        )}
        {selectedPane && wideScreen && !inMode && (
          <button type="button" className="header-text-button header-files-button is-icon" aria-label={t("Browse files")} title={t("Files")} aria-pressed={filesDocked ? filesBeside : undefined} onClick={toggleFiles}>
            <FolderOpen aria-hidden="true" />
          </button>
        )}
        <div className="header-meta">
          {!guideShown && !inbox.shown && <ConnectionChip
            connected={chipConnected}
            word={connWord}
            quiet={((headerConnection === "reconnecting" || headerConnection === "failed") && note === null && ((crumb !== null && !stripInHeader) || (phoneTabRow && stripInHeader))) || statusBarShown}
            title={[chipConnected ? null : connWord, shownHerdr ? (shownHerdr.runtime === "herdr-core" ? t("herdr-core {version} · protocol {protocol}", { version: shownHerdr.version, protocol: shownHerdr.protocol }) : t("herdr {version} · protocol {protocol}", { version: shownHerdr.version, protocol: shownHerdr.protocol })) : null].filter((part) => part !== null).join(" · ") || undefined}
          />}
          {selectedMachineId !== "local"
            ? !targetHerdr && <span className="pill pill-offline">{t("herdr offline")}</span>
            : localFreshness === "unknown"
              ? <span className="pill pill-stale" title={health ? (health.herdr.runtime === "herdr-core" ? t("The last health check failed. Last seen: herdr-core {version} · protocol {protocol}", { version: health.herdr.version, protocol: health.herdr.protocol }) : t("The last health check failed. Last seen: herdr {version} · protocol {protocol}", { version: health.herdr.version, protocol: health.herdr.protocol })) : t("The health check failed")}>{t("Status unknown")}</span>
              : localFreshness === "unavailable" && (health?.herdr.runtime === "herdr-core"
                ? <span className="pill pill-offline" title={t("Open the Herdr app on this PC, or check HC_SESSION and HC_SOCKET.")}>{t("herdr-core unavailable")}</span>
                : <span className="pill pill-offline" title={t("Start herdr on this PC, or check HERDR_SOCKET.")}>{t("herdr unavailable")}</span>)}
          {moreButton(false)}
        </div>
      </header>}
        {more && (
          <RowMenu
            anchor={more.anchor}
            title={t("More")}
            header={crumb && !inbox.shown && !(inMode && moreOnList) ? (
              <div className={`header-more-crumb${inMode ? " is-inbox" : ""}`}>
                {!statusBarShown && selectedTitle !== null && <span className="header-more-title">{selectedAgent ? `${agentName(selectedAgent)} · ${selectedTitle}` : selectedTitle}</span>}
                {!statusBarShown && <span>{currentTabName ? `${crumb.place} › ${currentTabName}` : crumb.place}</span>}
                {!statusBarShown && crumb.path !== null && <span className="header-more-path">{crumb.path}</span>}
                {sessionLines !== null && <span className="header-more-session">
                  <span>{sessionLines.totals}</span>
                  {sessionLines.goal !== null && <span>{sessionLines.goal}</span>}
                </span>}
                <ConnectionRouteMark portal={auth?.via === "portal"} ingress={security.state === "known" ? security.summary.observed_ingress : null} />
              </div>
            ) : undefined}
            items={inMode ? modeMoreItems : moreItems}
            onClose={closeMore}
          />
        )}
        {moreGroup && groupItems.length > 0 && <RowMenu anchor={moreGroup.anchor} title={t(moreGroup.kind === "find" ? "Find…" : "Pane and tab…")} items={groupItems} onClose={closeMoreGroup} />}

      <PanePressContext.Provider value={pressPane}>
      <div className="app-body">
        {inMode ? (inboxWide && <aside className="sidebar inbox-column">
          <InboxRail onExit={leaveMode} onInbox={() => inbox.list.current?.toTop()} waiting={railWaiting}
            alerts={{ on: bell.on, title: bell.title, toggle: () => void bell.run() }} onSettings={actions.openSettings} shortcutTitle={shortcutTitle}
            connection={rosterConnection} saidByThread={!inbox.shown && selectedPane !== null && note === null && rosterConnection === headerConnection} />
          {modeList(true)}
          <SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} />
        </aside>) : <aside id="workspace-drawer" className={`sidebar${drawerOpen ? " is-open" : ""}${sidebarPeeking ? " is-peek" : ""}`} role={drawerModal ? "dialog" : undefined} aria-modal={drawerModal ? true : undefined} tabIndex={drawerModal ? -1 : undefined} aria-label={drawerModal ? t("Workspace list") : undefined}
          aria-owns={drawerModal ? "drawer-toggle" : undefined} ref={drawerRef} {...peekSidebarHandlers}>
          {drawerHead && <button type="button" className="visually-hidden drawer-close" aria-controls="workspace-drawer" aria-expanded="true" onClick={() => setDrawerOpen(false)}>{t("Close workspace list")}</button>}
          {error && <div className="error-state" role="alert"><p>{error}</p><button className="btn" onClick={() => void load()}>{t("Retry")}</button></div>}
          <RenderBoundary resetKey={null} fallback={(retry) => <RegionCrash message={t("The sidebar can't be shown.")} retry={retry} />}>
            <CrashProbe region="sidebar" />
            <ReorderContext.Provider value={reorderCoordinator}><MachineSidebar machines={sidebarMachines} allMachines={machines} watching={auth?.role === "watch"} appLayout={appLayoutOn} drawerOpen={drawerOpen} filterRequest={sidebarFilterRequest} selectedMachineId={selectedMachineId} selectedPaneId={selectedPaneId} activity={activity} actions={actions} onSelect={selectTarget} onUsageLogin={(paneId) => { selectTarget("local", paneId, "terminal"); void load(); }} onSetup={(machine, update = false) => { setUpdateRemote(update); setMachineDialog(machine); }} onNew={openNewOn}
              afterPcs={browserTabs !== null && filePanelAvailable ? <BrowserTabsGroup tabs={browserTabs} selected={browserTab} onSelect={openBrowserTab} /> : undefined}
              footerStart={setupRow} inbox={modeOffered && !inMode ? { waiting: sessionTally.waiting, open: () => { actions.counted?.("inbox", "button"); enterInbox(); } } : null} /></ReorderContext.Provider>
          </RenderBoundary>
          <SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} />
        </aside>}

        {!inMode && <div className={`scrim${drawerOpen ? " is-open" : ""}`} aria-hidden="true" onClick={() => setDrawerOpen(false)} />}

        <OpenFileContext.Provider value={selectedPaneId !== null ? viewFile : null}>
        <WebPanelContext.Provider value={openWebPage}>
        <div className={`pane-column${chatShown ? " is-chat" : ""}`} inert={drawerModal || undefined}>
        <UpdateNotice updates={updates} onOpen={() => { setSettingsSection("updates"); setSettingsOpen(true); }} />
        <RestoreNotice />
        <DesktopUpdateNotice update={desktopUpdate} />
        <TelemetryNotice enabled={locked === false && setupGuide.settled && !guideShown} onOpen={() => { setSettingsLinkPage("about"); setSettingsLinkSection("telemetry"); setSettingsOpen(true); }} />
        <MachineActionBanner machines={machines} onSetup={(machine, update = false) => { setDrawerOpen(false); setUpdateRemote(update); setMachineDialog(machine); }} />
        {layoutNotice && <p className="pane-notice" role="alert">{layoutNotice}</p>}
        {/* the last answer that got through: a listener does not stop because herdr's ping failed */}
        {exposure && !(exposureDirect && directNotice.dismissed) && <LanExposureNotice host={exposure.host} direct={exposureDirect} onOpen={() => { setSettingsLinkPage("devices"); setSettingsOpen(true); }} onDismiss={directNotice.dismiss} />}
        {relayNoticeInfo && !relayNotice.dismissed && <RelayNotice notice={relayNoticeInfo} onOpen={() => { setSettingsLinkPage("devices"); setSettingsLinkSection("account"); setSettingsOpen(true); }} onDismiss={relayNotice.dismiss} />}
        <PushHealthNotice onRepair={repairNotifications} onOpen={() => { setSettingsLinkPage("alerts"); setSettingsOpen(true); }} />
        <InstallHint />
        {setupGuide.guide !== null && setupGuide.paused && <SetupGuideResume onResume={setupGuide.resume} />}
        {prompts.length > 0 && <RelayPairingPrompt pairings={prompts} onDecided={rereadOwnJoins} />}
        {/* an account join a member could approve too: this PC's own window asks for the number itself (OwnJoinCard) */}
        {ownWindow && locked === false && <OwnJoinCard joins={ownJoins} onDecided={rereadOwnJoins} />}
        {/* always there: it keeps what an approval left to say after its request is gone from this PC */}
        <AccountApprovals pairings={remotePairings} />
        <ListMoveNotices />
        {pairedNotices.length > 0 && <DevicePairedNotice events={pairedNotices} onDismiss={dismissPairedNotice} onOpen={(event) => { dismissPairedNotice(event); setSettingsLinkPage("devices"); setSettingsOpen(true); }} />}
        {deviceNotices}
        {health !== null && <NewPcNotices enabled={machineSessions.peek("local")?.socket?.accountOpensAll() === true} ownWindowOf={ownWindowHere(health.auth) ? health.web_ui?.server_id : undefined} signIn={accountSignedIn ?? undefined} />}
        {/* NewPcNotices above tells of a PC confirmed here; the hosted app's sign-in again comes back to this page, which goes on with the add */}
        {health !== null && <UnconfirmedPcNotices enabled={machineSessions.peek("local")?.socket?.accountOpensAll() === true} tellConfirmed={false}
          onSignInAgain={hostedSignIn?.signInAgain} />}
        {/* a PC asking to join while this phone went straight into another PC: its join card would never show */}
        {health !== null && hostedSignIn !== null && <AccountJoinRequests />}
        {/* The PC's pending-redemptions stream owns the list; a decline response can arrive after a newer event. */}
        <PendingKeys pending={ownWindow ? [] : pendingKeys} onDecline={(id) => { void declinePendingKey(id).catch((error: unknown) => console.warn("Ovis: the device was not declined", error instanceof Error ? error.name : error)); }} />
        {removedNotices.length > 0 && <DeviceRemovedNotice events={removedNotices} onDismiss={dismissRemovedNotice} />}
        {setupGuide.guide === null && <FirstStartHints active={locked === false} />}
        {setupGuide.guide !== null && <MachineContext.Provider value="local"><SetupGuide auth={auth} security={security} opensAll={machineSessions.peek("local")?.socket?.accountOpensAll() === true} onEnableAlerts={enableNotifications} settingsOpen={settingsOpen} pushOn={pushOn} sharedSettingsKnown={sharedSettingsKnown} notifications={notifications} hidden={setupGuide.paused} state={setupGuide.guide} dispatch={setupGuide.dispatch} onClose={setupGuide.close} onOpenSettings={(page) => { setSettingsLinkPage(page); setSettingsOpen(true); }}
          onOpenTelemetry={() => { setSettingsLinkPage("about"); setSettingsLinkSection("telemetry"); setSettingsOpen(true); }}
          // the tab was just made: picked before the roster has it, the pick would be released as a closed pane
          onOpenTerminal={(paneId) => { const at = picks.current; const latest = setupGuide.ticket(); void load().finally(() => { if (latest() && picks.current === at) selectTarget("local", paneId, "terminal"); }); }}
          onStarting={setupGuide.voidTickets}
          onPaired={() => void loadHealth()}
          onOpened={(paneId, agentStarted) => { if (agentStarted) actions.agentStarted("local", paneId);
            if (agentStarted && setupGuide.guide?.reopened !== true) { try { armHints(window.localStorage); } catch {} } setupGuide.finish(() => selectTarget("local", paneId)); void load(); }} /></MachineContext.Provider>}
        {guideShown ? null :
        <div ref={paneAreaRef} className={`pane-split${paneSplit ? " is-split" : ""}${inbox.shown ? " is-under-inbox" : ""}`} onDragEnterCapture={paneDragOver} onDragOverCapture={paneDragOver} onDragLeave={paneDragLeave} onDropCapture={paneDrop}>
          {inboxWide && <ThreadTop note={<HeaderNote note={herdrPrefixWaiting ? t("herdr prefix: press a key") : note} />}
            thread={!inbox.shown && selectedPane !== null && note === null ? { machines, activity, machineId: selectedMachineId, pane: selectedPane, connection: headerConnection, watching: viewOnly(selectedMachineId), severalPcs: sidebarMachines.length > 1 } : null}
            controls={!inbox.shown && selectedPane !== null ? <>
              <LensToggle view={view} peek={terminalPeek !== null} terminalAttach={terminalAttach} thread round
                title={(label) => shortcutTitle(label, "toggle-view")} onToggle={() => actions.toggleView("header")} />
              {moreButton(true)}
            </> : moreButton(true)} />}
          {(inbox.shown && inbox.cold ? [] : shownSlots).map((slot) => {
            const active = !splitOn || split!.active === slot;
            const other = active || threadDrawn ? undefined : others.get(slot);
            if (!active && !other) return null;
            const machineId = other ? other.target.machineId : selectedMachineId;
            const paneId = other ? other.target.paneId : selectedPaneId;
            const machine = other ? other.machine : selectedMachine;
            const herdr = other ? other.herdr : targetHerdr;
            const pane = other ? other.pane : selectedPane;
            const workspace = other ? other.workspace : selectedWorkspace;
            const slotSnapshot = other ? other.machine?.snapshot ?? null : snapshot;
            const attach = other ? other.attach : terminalAttach;
            const rect = threadDrawn ? undefined : rects?.get(slot);
            const side = paneSplit ? slotSide(split!, slot) : null;
            const lensOf = (item: HerdrPane): PaneView => active && item.pane_id === selectedPaneId ? view
              : storedView(lenses, viewPicks, item.pane_id, machineId, item.agent != null, attach);
            const slotView = active ? view : pane ? lensOf(pane) : "terminal";
            const onSelect = active ? selectPane : (id: string, focusInput = true) => selectInSlot(slot, machineId, id, focusInput);
            const slotPanelId = !paneSplit || slot === "a" ? PANE_TABPANEL_ID : `${PANE_TABPANEL_ID}-${slot}`;
            const slotPanelLabel = active ? tabPanelLabel : paneTabPanelLabel(slotSnapshot, pane, t);
            const slotPeek = active && pane ? peekFor(terminalPeek, slot, machineId, pane.pane_id) : null;
            const shownView: PaneView = slotPeek !== null ? "terminal" : slotView;
            const toggleSlotView = (): void => {
              if (slotPeek !== null) { endPeek(slotPeek); return; }
              const next = slotView === "chat" ? "terminal" : "chat";
              if (active) setView(next, "pane"); else if (pane) pickView(machineId, pane.pane_id, next, "pane");
            };
            const slotEnd = paneSplit ? <div className="pane-slot-grip" draggable={paneId !== null}
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
            const slotBar = paneSplit ? <div className="pane-slot-bar"><span className="pane-slot-title">{pane ? displayPaneTitle(pane) : t("Pane closed")}</span>{slotEnd}</div> : null;
            return (
              <MachineContext.Provider key={slot} value={machineId}><AppLayoutContext.Provider value={appLayoutOf(herdr)}><SlotSessions slot={slot} machineIds={machines.map((item) => item.id)}><PaneFollowContext.Provider value={follows(slot)}><PaneCoveredContext.Provider value={inbox.shown}>
              <div
                className={`pane-slot${showsChat(pane, slotView) ? " is-chat" : ""}${paneSplit ? active ? " is-active" : " is-inactive" : ""}${rect && rect.x + rect.w < 0.999 ? " joins-right" : ""}${rect && rect.y + rect.h < 0.999 ? " joins-below" : ""}`}
                style={rect ? { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` } : undefined}
                data-slot={slot}
                inert={inbox.shown || undefined}
                data-machine={machineId}
                data-side={side ?? undefined}
                // React delivers events from a menu this half portaled out to these handlers too: such a press
                // is not in the half, and activating would close the menu before its item's click lands
                onPointerDownCapture={active ? undefined : (event) => {
                  if (!event.currentTarget.contains(event.target as Node)) return;
                  if (event.button === 0 && !paneContextPress(event, apple) && !(event.target as Element).closest(".pane-slot-action")) activateSlot(slot);
                }}
                onFocusCapture={active ? undefined : (event) => { if (event.currentTarget.contains(event.target as Node) && Date.now() - lastKeyAtRef.current < KEY_FOCUS_MS && !(event.target as Element).closest(".pane-slot-action")) activateSlot(slot, true); }}
                onDropCapture={active ? undefined : (event) => { if (!event.dataTransfer.types.includes(PANE_DRAG_TYPE)) activateSlot(slot); }}
              >
                <RenderBoundary resetKey={`${machineId}:${paneId ?? ""}`} fallback={(retry) => <>{slotBar}<RegionCrash message={t("This pane can't be shown.")} retry={retry} onShown={active ? paneLost : undefined} /></>}>
                <CrashProbe region="pane" />
                {!(slotSnapshot && pane && workspace) && slotBar}
                {slotSnapshot && pane && workspace && !(active && classicStripInHeader) && !threadDrawn && (
                  <TabStrip snapshot={slotSnapshot} workspace={workspace} selectedPane={pane} panelId={slotPanelId} splitDrag={wideScreen} browserTabs={paneSplit && wideScreen && !tabsInHeader} onSelectPane={onSelect}
                    inHeader={tabsInHeader} sheet={active ? tabSheet : null} onSheetClose={closeTabSheet} end={slotEnd} closable={auth?.role !== "watch"}
                    renameRequest={active && renameRequest?.machineId === machineId && renameRequest.paneId === pane.pane_id ? renameRequest : null}
                    onRenameHandled={clearRenameRequest}
                    closeRequest={active && closeTabRequest?.machineId === machineId && closeTabRequest.paneId === pane.pane_id ? closeTabRequest : null}
                    onCloseHandled={clearCloseTabRequest}
                    onNewTab={() => { tally(() => usageCounters.paneUse("new_tab_by_button", machineId)); actions.openNewTab(active ? undefined : { machineId, workspaceId: workspace.workspace_id }); }}
                    onNewTerminal={() => { tally(() => usageCounters.paneUse("new_tab_by_button", machineId)); return actions.openTerminalTab(active ? undefined : { machineId, workspaceId: workspace.workspace_id }); }}
                    onMoveToWorkspace={(tabId, workspaceId) => actions.moveTabToWorkspace({ machineId, tabId, workspaceId })}
                    paneActions={active ? (paneId) => {
                      const target = snapshot?.panes.find((item) => item.pane_id === paneId);
                      if (!target || !paneActionsRef.current) return [];
                      return paneActionsRef.current(target).map((item) => ({ ...item, run: () => paneActionsRef.current?.(target).find((fresh) => fresh.id === item.id)?.run() }));
                    } : undefined} />
                )}
                <main className="terminal-host">
                  <div id={slotPanelId} className="terminal-tabpanel" role={slotPanelLabel === null ? undefined : "tabpanel"} aria-label={slotPanelLabel ?? undefined}>
                  <PaneCanvas key={machineId} snapshot={slotSnapshot} pane={pane} selectedPaneId={paneId} onSelect={onSelect} onChanged={actions.refresh} actionsRef={active ? paneActionsRef : undefined} watching={viewOnly(machineId)}
                    mirrored={herdr?.terminal_attach === false || herdr?.terminal_mirror === true}
                    onOpenInHalf={wideScreen && !threadDrawn ? (id, side) => dockSide({ machineId, paneId: id }, side) : undefined}
                    onRecoverUnsent={(target) => openUnsent({ machineId, pane: target })}
                    onSearchConversation={(target) => searchable(machineId, target, lensOf(target)) && !(slotPeek !== null && target.pane_id === pane?.pane_id) ? () => requestSearch(slot, machineId, target.pane_id) : null}
                    onNewTab={workspace ? () => { tally(() => usageCounters.paneUse("new_tab_by_button", machineId)); actions.openNewTab(active ? undefined : { machineId, workspaceId: workspace.workspace_id }); } : undefined}
                    onNewTerminal={workspace ? () => { tally(() => usageCounters.paneUse("new_tab_by_button", machineId)); return actions.openTerminalTab(active ? undefined : { machineId, workspaceId: workspace.workspace_id }); } : undefined}
                    onMoveToWorkspace={(tabId, workspaceId) => actions.moveTabToWorkspace({ machineId, tabId, workspaceId })}
                    tabsInHeader={tabsInHeader || threadDrawn} solo={threadDrawn}
                    renameRequest={active && pane && renameRequest?.machineId === machineId && renameRequest.paneId === pane.pane_id ? renameRequest : null}
                    closeTabRequest={active && pane && closeTabRequest?.machineId === machineId && closeTabRequest.paneId === pane.pane_id ? closeTabRequest : null}
                    renderPane={(item, itemActive, herdrSplit) => <PaneOpenFile paneId={item?.pane_id ?? null} machineId={machineId} open={openFile}>
                      <PaneTerminal
                        presentationKey={paneContentKey(machine, item, item ? lensOf(item) : slotView)}
                        deviceWatching={viewOnly(machineId)}
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
                        acpChild={item?.acp_child === true}
                        acpHold={item?.acp_hold}
                        backgroundTasks={item?.background_tasks ?? 0}
                        plan={machine?.state === "connected" ? (item as HerdrPane | undefined)?.plan ?? null : null}
                        backgroundWait={item?.background_wait === true}
                        cwd={item?.cwd ?? null}
                        workspaceId={item?.workspace_id ?? null}
                        workspaceLabel={slotSnapshot?.workspaces.find((workspace) => workspace.workspace_id === item?.workspace_id)?.label ?? null}
                        worktreeRepo={worktreeRepoName(item === null ? undefined : slotSnapshot?.workspaces.find((workspace) => workspace.workspace_id === item.workspace_id))}
                        machineName={machine?.name ?? machineId}
                        view={item ? lensOf(item) : slotView}
                        onOpenTerminal={item ? () => { if (active && item.pane_id === selectedPaneId) setView("terminal", "pane"); else pickView(machineId, item.pane_id, "terminal", "pane"); } : undefined}
                        peek={active && item?.pane_id === selectedPaneId ? peekFor(terminalPeek, slot, machineId, item.pane_id) : null}
                        onPeek={active && item && item.pane_id === selectedPaneId && attach ? (request: PeekRequest) => setTerminalPeek({ ...request, slot, machineId, paneId: item.pane_id }) : undefined}
                        onEndPeek={endPeek}
                        onOpenHistory={item && sessionHistoryAgent(item.agent) !== null ? () => actions.openSessionHistory({ machineId, workspaceId: item.workspace_id, agent: item.agent, scope: "pane", paneId: item.pane_id }) : undefined}
                        active={active && itemActive}
                        controls={active && itemActive ? paneControls : undefined}
                        findRequest={active && findRequest.paneId === item?.pane_id ? findRequest.serial : 0}
                        searchRequest={searchRequest.slot === slot && searchRequest.machineId === machineId && searchRequest.paneId === item?.pane_id ? searchRequest.serial : 0}
                        autoSelected={active ? autoSelected : true}
                        terminalFontSize={settings.terminalFontSize}
                        split={herdrSplit || paneSplit}
                        terminalWheelSpeed={settings.terminalWheelSpeed}
                        terminalFontFamily={settings.terminalFontFamily}
                        colors={resolvedEntry.terminal}
                        onConnectionChange={active && itemActive ? (next, before) => { setConnected(next); setConnectedBefore(before); setReportedBy(`${slot}:${machineId}`); if (next) setOutputStopped(false); } : undefined}
                        onServerMessage={active && itemActive ? handleServerMessage : undefined}
                      />
                    </PaneOpenFile>} />
                  </div>
                </main>
                </RenderBoundary>
              </div>
              </PaneCoveredContext.Provider></PaneFollowContext.Provider></SlotSessions></AppLayoutContext.Provider></MachineContext.Provider>
            );
          })}
          {listScreen && modeList(false)}
          {inboxWide && inbox.shown && <InboxUnchosen />}
          {dividers.length > 0 && !inMode && <SplitDividers dividers={dividers} areaRef={paneAreaRef} onResize={resizeDivider} />}
          <SplitDropPreview visible={!inMode && splitDragOn && (paneDragging || (tabDrag !== null && !tabDrag.workspaceTarget))} grid={gridPreview} />
        </div>}
        {statusBarShown && selectedPane && crumb && <StatusBar machineId={selectedMachineId} workspaceId={selectedPane.workspace_id}
          machine={crumb.machine} place={crumb.folder === null ? crumb.workspace : `${crumb.workspace} › ${crumb.folder}`} path={crumb.path}
          session={sessionShort.length > 0 ? sessionShort.join(" · ") : null}
          pcLoad={pcLoadOn(settings, machines) ? <PcLoadStatus key={selectedMachine?.id ?? ""} machine={selectedMachine ?? null} /> : null}
          watching={viewOnly(selectedMachineId)}
          waiting={sessionTally.waiting} onNextWaiting={nextWaiting === null ? null : openNextWaiting}
          connection={headerConnection ?? (chipConnected ? "live" : "lost")}
          connectionWord={headerConnection === "reconnecting" || headerConnection === "failed" ? connectionWord(headerConnection, t) : chipConnected ? t("Connected") : connWord} />}
        </div>
        </WebPanelContext.Provider>
        </OpenFileContext.Provider>
        {viewing !== null && fileDocked && <MachineContext.Provider value={viewing.machineId}>
          <FileViewer key={fileViewerKey(viewing)} docked panelStart={<FilePanelResizer width={filePanelWidth} onResize={setFilePanelWidth} />} path={viewing.path} paneId={viewing.paneId} onClose={closeFile} onOpen={(path) => openFile({ ...viewing, path, presentation })} onKind={reportFileKind} onTogglePresentation={toggleFilePresentation} keyboardActive={!settingsOpen} editable={fileEditable} />
        </MachineContext.Provider>}
        {filesOpen && filesDocked && filesDialog(true)}
        {webPage !== null && !(viewing !== null && fileDocked) &&
          <WebPanel key={webPage} url={webPage} docked={filePanelAvailable} covered={webDialogCover} onClose={closeWebPage} panelStart={filePanelAvailable ? <FilePanelResizer width={filePanelWidth} onResize={setFilePanelWidth} /> : undefined} />}
        {/* a tab open beside the pane takes the right panel's place: both would squeeze the conversation */}
        {desktopBrowser !== null && filePanelAvailable && !inMode && !browserShown && <MachineContext.Provider value={selectedMachineId}>
          <BrowserSidePanel browser={desktopBrowser} pane={selectedPane ? { id: selectedPane.pane_id, agent: selectedAgent, status: selectedPane.agent_status } : null}
            agentOf={(paneId) => machines.find((machine) => machine.id === "local")?.snapshot?.panes.find((pane) => pane.pane_id === paneId)?.agent ?? null}
            onOpen={openBrowserTab} />
        </MachineContext.Provider>}
        {browserShown && <BrowserPanel tab={shownBrowserTab} covered={dialogCover || webDialogCover} onOpened={setOpeningTab} onClose={() => setBrowserTab(null)}
          panelStart={<FilePanelResizer width={filePanelWidth} onResize={setFilePanelWidth} />} />}
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
        onPending={(pending) => { newSessionPending.current = pending; }}
        onOpenPane={(paneId) => { closeNewSession(); selectTarget(newSessionMachineId, paneId, "terminal"); void load(); }}
        watching={viewOnly(newSessionMachineId)}
        groupKept={(groupOf) => liveGroupKeys(groupOf, machines, hiddenMachines)}
        onCreated={(paneId, agentStarted, messageWaits = false) => {
          closeNewSession();
          if (agentStarted) actions.agentStarted(newSessionMachineId, paneId);
          if (messageWaits) pickView(newSessionMachineId, paneId, "chat", null);
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
        if (!machinesRef.current.find((m) => m.id === machineId)?.snapshot?.panes.some((p) => p.pane_id === paneId)) return;
        // Files lists the pane it was opened on, and would open its paths on the new one
        setFilesOpen(false);
        selectTargetRef.current(machineId, paneId);
      }} />
      <SettingsDialog opensAll={() => ownWindowHere(health?.auth) && machineSessions.peek("local")?.socket?.accountOpensAll() === true} withdrawn={() => machineSessions.peek("local")?.socket?.accountReleaseWithdrawn() === true} machines={machines} auth={auth} picturesByDefault={picturesByDefault} herdrVersion={shownHealth?.herdr?.version ?? null} herdrRuntime={shownHealth?.herdr ? shownHealth.herdr.runtime ?? "herdr" : null} herdrCore={shownHealth?.herdr_core ?? null} herdrRuntimeFacts={shownHealth?.herdr_runtime ?? null} bootId={shownHealth?.web_ui?.boot_id ?? null} onServerRestarted={() => { void readLocalHealth(); void readBridgeHealth(); void load(); }} security={security} open={settingsOpen} section={settingsSection} linkPage={settingsLinkPage} linkSection={settingsLinkSection} onPage={onSettingsPage} onClose={closeSettings} onUsageLogin={(paneId) => { closeSettings(); selectTarget("local", paneId, "terminal"); void load(); }} onOpenPane={(machineId, paneId) => { closeSettings(); selectTarget(machineId, paneId, "terminal"); void load(); }} actions={actions} updates={updates} onEnableNotifications={enableNotifications} saveError={settingsSaveError} savePaused={settingsSavePaused} saveRetrying={settingsSaveRetrying} onRetrySave={retrySettingsSave} overPreview={(viewing !== null && !fileDocked) || diffViewing !== null || (webPage !== null && !filePanelAvailable)} projectFolder={selectedMachineId === "local" ? selectedPane?.cwd ?? null : null} />
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
        view={terminalPeek !== null ? "terminal" : view} actions={actions} watching={viewOnly(selectedMachineId)} inboxMode={inMode} />
      <MarkdownLinkMenu />
    </div></AppLayoutContext.Provider></MachineContext.Provider></MachineSessionsProvider>
  );
}
