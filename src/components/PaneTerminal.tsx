import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { fontSettled } from "../lib/fontFamily.ts";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ArrowLeft, ArrowUp, ChevronRight, ClipboardCheck, Clock, Eye, Pause, Quote, SendHorizontal, SquareTerminal, Trash2, TriangleAlert, Unplug, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import "./PaneTerminal.css";

import { HerdrSocket } from "../lib/ws.ts";
import { MachineSession } from "../lib/machineSession.ts";
import { useMachineSessions } from "../lib/machineSessionContext.tsx";
import { ViewportIntentGate } from "../lib/viewportIntent.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";
import { pageAddress, reloadOnPlainClick } from "../lib/pageQuery.ts";
import { PaneCachedContext, PaneCoveredContext, PaneWatchedContext, PanePresentedContext, PaneFollowContext, PaneShownContext, PaneSubmitContext } from "../lib/paneSubmitContext.ts";
import { NO_MODIFIER_LATCH, NO_STICKY_MODIFIERS, releaseLatched, type ModifierLatch, type StickyModifiers } from "../lib/keys.ts";
import { EMPTY_DRAFT, draftIsEmpty, restoreDraft, type InputDraft } from "../lib/draft.ts";
import { useReconnectGrace } from "../lib/reconnectGrace.ts";
import { looksLikeKey } from "../../shared/secret-prompt.ts";
import { messageQueues } from "../lib/messageQueue.ts";
import { pendingMessages } from "../lib/pendingMessages.ts";
import { heldOpenAtFold, heldOpenOnFocus, heldRefocusDue, heldRowError, heldRowsFold, heldRowsHidden, heldToggleShown, SHORT_PHONE_QUERY } from "../lib/heldRows.ts";
import { arrangeNotices, dismissNotice, NO_DISMISSALS, settleDismissed, type DismissedNotices } from "../lib/composerNotices.ts";
import { MAX_COMPOSER_CHARS, QUEUE_READY_STATUS, agentDisplayLabel, claudeMainAtRest, typedTerminalCommand } from "../lib/compose.ts";
import { usePaneCommands } from "../lib/usePaneCommands.ts";
import { paneCommandsNow } from "../lib/paneCommandCache.ts";
import { autoReturnArmed, paneLensFlags, screenReturnArmed, type PeekRequest, type TerminalPeek } from "../lib/terminalPeek.ts";
import { FrameGate, inputRowState, readScreen, readScreenLines, readsInputRow, type InputRowState } from "../lib/inputRow.ts";
import { terminalScreen } from "../lib/terminalScreen.ts";
import { outcomeCommand } from "../lib/outcomeChip.ts";
import { composerLift, greetingMemory, greetingFits, greetingFolder, roomOverComposer, showsGreeting } from "../lib/greeting.ts";
import { DETACHED, usePaneBranch } from "../lib/paneBranch.ts";
import { answerHint } from "../lib/promptAnswer.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { appendQuote, formatTerminalQuote } from "../lib/terminalQuote.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useSessionHistoryOffered } from "../lib/useSessionHistoryOffered.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { labelledAgent } from "../../shared/supported-agents.ts";
import { KeyBar, LineKeysButton } from "./KeyBar.tsx";
import { TerminalInput, type TerminalInputHandle } from "./TerminalInput.tsx";
import { FindBar } from "./FindBar.tsx";
import { TerminalViewportTools, type TerminalSearchState } from "./TerminalViewportTools.tsx";
import { SecretInput } from "./SecretInput.tsx";
import { ChatView } from "./ChatView.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { Composer } from "./Composer.tsx";
import { ComposerNotices, type ComposerNoticeRow } from "./ComposerNotices.tsx";
import { PendingMessages } from "./PendingMessages.tsx";
import type { AcpHold, AgentStatus, ClientRole, PlanSummary, ServerMessage } from "../../shared/protocol.ts";
import { holdAcpChild, releaseAcpChild } from "../lib/api.ts";
import type { PaneControls, PaneView } from "../lib/actions.ts";
import { usePaneLane } from "../lib/chatLane.ts";
import { useSettings } from "../lib/settings.ts";
import type { TerminalColors } from "../lib/themes.ts";
import { learnFromSend } from "../lib/tabLabels.ts";
import { useT } from "../lib/i18n.ts";
import { isAppShortcut } from "../lib/shortcuts.ts";
import { plainPageDirection } from "../lib/pageScroll.ts";
import { keyboardTypingField, keyboardUp } from "../lib/keyboard.ts";
import { keyboardControl } from "../lib/keyboardControl.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { WebPanelContext } from "../lib/webPanel.ts";
import { hyperlinkFilter } from "../lib/terminalFileLinks.ts";
import { terminalLabel } from "../lib/terminalLabel.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { MIRROR_WRAP_QUERY } from "../lib/terminalFold.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { modalOpen } from "../lib/focus.ts";
import { connectedSockets } from "../lib/paneTerminalShared.ts";
import { useTerminalMount } from "../lib/useTerminalMount.ts";
import { useTerminalRefits } from "../lib/useTerminalRefits.ts";
import { usePaneAttach } from "../lib/usePaneAttach.ts";
import { useTerminalSends } from "../lib/useTerminalSends.ts";
import { useComposerSends } from "../lib/useComposerSends.ts";
import { usePeekReturn } from "../lib/usePeekReturn.ts";
import { useChatCallbacks } from "../lib/useChatCallbacks.ts";
import { useTypedKeys } from "../lib/useTypedKeys.ts";
import { useTerminalImages } from "../lib/terminalImages.ts";
import { mountRole, paneObserving } from "../lib/paneObserving.ts";
import { typeAheadFocused } from "../lib/typeAhead.ts";

/** How long the key bar says where Paste goes while the input line is put away: two lines to read. */
const PASTE_GUIDANCE_MS = 6000;

export interface PaneTerminalProps {
  presentationKey?: string;
  finishEpoch?: string;
  finishId?: number;
  paneId: string | null;
  /** A restored pane keeps its ID but gets a new terminal after herdr restarts. */
  terminalId?: string | null;
  mirrored?: boolean | null;
  /**
   * herdr's reason it could not restore the selected pane (0.9.3+): the pane has no
   * terminal to attach, so App passes a null paneId and the placeholder says why.
   */
  restoreError?: string | null;
  title?: string | null;
  agent?: string | null;
  agentStatus?: AgentStatus;
  agentSession?: string | null;
  acpChild?: boolean;
  /** a person stopped this ACP child (HerdrPane `acp_hold`) */
  acpHold?: AcpHold;
  backgroundTasks?: number;
  plan?: PlanSummary | null;
  backgroundWait?: boolean;
  cwd?: string | null;
  workspaceId?: string | null;
  workspaceLabel?: string | null;
  worktreeRepo?: string | null;
  machineName?: string;
  view: PaneView;
  onOpenTerminal?: () => void;
  peek?: TerminalPeek | null;
  onPeek?: (request: PeekRequest) => void;
  onEndPeek?: (peek: TerminalPeek) => void;
  onOpenHistory?: () => void;
  findRequest?: number;
  searchRequest?: number;
  controls?: { current: PaneControls | null };
  active?: boolean;
  autoSelected?: boolean;
  terminalFontSize: number;
  split?: boolean;
  /** mouse reports sent per wheel event (settings): 1 is xterm's own one report */
  terminalWheelSpeed: number;
  terminalFontFamily: string;
  /** the drawn theme's terminal colours (lib/themes.ts): xterm reads no CSS, so its theme object is given them */
  colors: TerminalColors;
  role?: ClientRole;
  onRoleAck?: (mode: ClientRole) => void;
  /** this device's pairing may only watch (App's auth): the prompt card answers nothing. Not the connection's role, which the user toggles */
  deviceWatching?: boolean;
  onConnectionChange?: (connected: boolean, connectedBefore: boolean) => void;
  onServerMessage?: (message: ServerMessage) => void;
}

const heldRowNotes = new Map<string, { owner: string; id: string; text: string }>();

function reconnectHref(machineId: string, paneId: string): string {
  return pageAddress(window.location.pathname, `?machine=${encodeURIComponent(machineId)}&pane=${encodeURIComponent(paneId)}`, "");
}

function isDemoWatch(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get("demo_security") === "watch" || params.get("demo_devices") === "watch") return true;
  try { return window.sessionStorage.getItem("ovis:demo-security") === "watch"; } catch { return false; }
}

export function PaneTerminal({
  presentationKey,
  finishEpoch,
  finishId,
  paneId,
  terminalId = null,
  mirrored = false,
  restoreError = null,
  agent = null,
  title = null,
  agentStatus,
  agentSession = null,
  acpChild = false,
  acpHold,
  backgroundTasks = 0,
  plan = null,
  backgroundWait = false,
  cwd = null,
  workspaceId = null,
  workspaceLabel = null,
  worktreeRepo = null,
  machineName = "",
  view,
  findRequest = 0,
  searchRequest = 0,
  controls,
  active = true,
  autoSelected = false,
  terminalFontSize,
  split = false,
  terminalWheelSpeed,
  terminalFontFamily,
  colors,
  role = "interact",
  deviceWatching = false,
  onOpenTerminal,
  peek: peekProp = null,
  onPeek,
  onEndPeek,
  onOpenHistory,
  onRoleAck,
  onConnectionChange,
  onServerMessage,
}: PaneTerminalProps) {
  const t = useT();
  const activeRef = useRef(active);
  activeRef.current = active;
  const openFile = useContext(OpenFileContext);
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;
  const openWebPage = useContext(WebPanelContext);
  const machineId = useMachineId();
  const commands = usePaneCommands(paneId, agent);
  const openWebRef = useRef((uri: string, shiftKey: boolean) => openWebPage?.(uri, shiftKey, machineId) ?? false);
  openWebRef.current = (uri, shiftKey) => openWebPage?.(uri, shiftKey, machineId) ?? false;
  const branchWord = usePaneBranch(machineId, workspaceId);
  const machineSessions = useMachineSessions();
  const sessionRef = useRef<MachineSession | null>(null);
  const submitRetention = useContext(PaneSubmitContext);
  const presented = useContext(PanePresentedContext);
  const presentedRef = useRef(presented); presentedRef.current = presented;
  const cached = useContext(PaneCachedContext);
  const cachedRef = useRef(cached); cachedRef.current = cached;
  const watched = useContext(PaneWatchedContext);
  const watchedRef = useRef(watched); watchedRef.current = watched;
  // a split tab's pane a phone keeps behind the one it shows sizes nothing: the pty is shared with
  // every device, and a PC drawing the split would see it at the phone's size (#819)
  const shown = useContext(PaneShownContext);
  const shownRef = useRef(shown); shownRef.current = shown;
  const follow = useContext(PaneFollowContext);
  const followRef = useRef(follow); followRef.current = follow;
  const covered = useContext(PaneCoveredContext);
  const coveredRef = useRef(covered); coveredRef.current = covered;
  const sizesPty = (): boolean => presentedRef.current && shownRef.current && !followRef.current && !coveredRef.current;
  const { answerPanePrompt, uploadPaneImage } = useMachineApi();
  const uploadFileRef = useRef(uploadPaneImage);
  uploadFileRef.current = uploadPaneImage;
  const attachFilesRef = useRef<(files: File[], still: () => boolean) => void>(() => {});
  const peek = peekProp !== null && peekProp.paneId === paneId && peekProp.machineId === machineId ? peekProp : null;
  const peekRef = useRef(peek); peekRef.current = peek;
  const { chatMounted, gridCovered: chatView } = paneLensFlags(view, peek);
  const chatMountedRef = useRef(chatMounted); chatMountedRef.current = chatMounted;
  const [findOpen, setFindOpen] = useState(false);
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const [searchState, setSearchState] = useState<TerminalSearchState | null>(null);
  const viewportIntent = useMemo(() => new ViewportIntentGate(), [machineId, paneId]);
  const viewportSearching = useSyncExternalStore(viewportIntent.subscribe, viewportIntent.isSearching, viewportIntent.isSearching);
  // A find bar left open under the Terminal lens is not the peek's: the peek opens without it, or it
  // would take the focus, the first Escape (the agent's) and a grid row.
  const [findPeek, setFindPeek] = useState(peek);
  if (findPeek !== peek) {
    setFindPeek(peek);
    if (peek !== null && findOpen) setFindOpen(false);
  }
  const findOpenRef = useRef(findOpen);
  findOpenRef.current = findOpen;
  const lastFindRequest = useRef(findRequest);
  useLayoutEffect(() => { findOpenRef.current = false; setFindOpen(false); }, [paneId]);
  useLayoutEffect(() => {
    if (findRequest !== lastFindRequest.current) {
      lastFindRequest.current = findRequest;
      if (findRequest > 0 && activeRef.current) {
        findOpenRef.current = true;
        setFindOpen(true);
      }
    }
  }, [findRequest]);
  const chatViewRef = useRef(chatView);
  chatViewRef.current = chatView;
  const terminalName = terminalLabel(paneId, title, t);
  const wheelStateRef = useRef({ speed: terminalWheelSpeed, omoQuestion: false });
  wheelStateRef.current = { speed: terminalWheelSpeed, omoQuestion: agent === "omo" && agentStatus === "blocked" };
  const hostRef = useRef<HTMLDivElement | null>(null);
  const pinchBadgeRef = useRef<HTMLSpanElement | null>(null);
  const pinchStatusRef = useRef<HTMLSpanElement | null>(null);
  const baseFontRef = useRef(terminalFontSize);
  const pinchingRef = useRef(false);
  const [firstFont] = useState(fontSettled);
  const fontSettledRef = useRef(firstFont);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const pageScroll = useRef<((direction: -1 | 1) => void) | null>(null);
  const lineScroll = useRef<((lines: number) => void) | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** OSC 8 links this app cannot open are not drawn (#739); its state ends with `term.reset()` */
  const hyperlinksRef = useRef(hyperlinkFilter());
  const retireOutputRef = useRef<() => void>(() => {});
  const socketRef = useRef<HerdrSocket | null>(null);
  const paneRef = useRef<string | null>(paneId);
  const onConnectionChangeRef = useRef(onConnectionChange);
  const onServerMessageRef = useRef(onServerMessage);
  const onRoleAckRef = useRef(onRoleAck);
  const [connected, setConnected] = useState(false);
  const [connectedBefore, setConnectedBefore] = useState(false);
  const historyOffered = useSessionHistoryOffered(connected && onOpenHistory !== undefined);
  const pendingScopeRef = useRef<string | null>(null);
  const pendingEpochRef = useRef(0);
  const [outputReady, setOutputReady] = useState(false);
  const outputTarget = JSON.stringify([paneId, terminalId]);
  const outputTargetRef = useRef(outputTarget); outputTargetRef.current = outputTarget;
  const [parsedTarget, setParsedTarget] = useState<string>();
  const [ended, setEnded] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const [inputReady, setInputReady] = useState(false);
  const [outputError, setOutputError] = useState<string | null>(null);
  const stalledRef = useRef(false);
  const [unsupported, setUnsupported] = useState(false);
  const unsupportedRef = useRef(unsupported); unsupportedRef.current = unsupported;
  const [held, setHeldState] = useState(false);
  const heldRef = useRef(false);
  const cancelTouchRef = useRef<() => void>(() => undefined);
  const setHeld = useCallback((next: boolean) => { cancelTouchRef.current(); heldRef.current = next; setHeldState(next); }, []);
  const composingRef = useRef(false);
  const [composing, setComposingState] = useState(false);
  const setComposing = useCallback((active: boolean) => { composingRef.current = active; setComposingState(active); }, []);
  // a composition in the input line keeps the key bar live but blocks the switch to direct typing:
  // unmounting the line mid-composition could drop the word or replay it into the pane
  const lineComposingRef = useRef(false);
  const [lineComposing, setLineComposingState] = useState(false);
  const setLineComposing = useCallback((active: boolean) => { lineComposingRef.current = active; setLineComposingState(active); }, []);
  const lineRef = useRef<TerminalInputHandle | null>(null);
  const [linePasting, setLinePasting] = useState(false);
  const compositionCommitPendingRef = useRef(false);
  // A Safari syllable or dictation phrase still in the editor is text: before a chord, a held
  // modifier or a key-bar key it goes out as an IME commit, or the chord would take its place.
  const commitPendingText = useCallback(() => {
    compositionCommitPendingRef.current = true;
    try { termRef.current?.finishComposition(); } finally { compositionCommitPendingRef.current = false; }
  }, []);
  const barKeyRef = useRef<{ key: string; chord: string | null } | null>(null);
  // the mark (markTyped) of the Stop whose Escape xterm is emitting, null for any other input
  const stopKeyRef = useRef<number | null>(null);
  const modifiersRef = useRef<StickyModifiers>(NO_STICKY_MODIFIERS);
  const lockedRef = useRef<StickyModifiers>(NO_STICKY_MODIFIERS);
  const [modifiers, setModifiers] = useState<StickyModifiers>(NO_STICKY_MODIFIERS);
  const [lockedModifiers, setLockedModifiers] = useState<StickyModifiers>(NO_STICKY_MODIFIERS);
  const setLatch = useCallback((next: ModifierLatch) => {
    modifiersRef.current = next.held;
    lockedRef.current = next.locked;
    setModifiers(next.held);
    setLockedModifiers(next.locked);
  }, []);
  const consumeModifiers = useCallback(() => {
    const latch = { held: modifiersRef.current, locked: lockedRef.current };
    const next = releaseLatched(latch);
    if (next !== latch) setLatch(next);
  }, [setLatch]);
  const clearModifiers = useCallback(() => {
    setLatch(NO_MODIFIER_LATCH);
    barKeyRef.current = null;
  }, [setLatch]);
  useLayoutEffect(clearModifiers, [paneId, chatView, active, clearModifiers]);
  const observeRef = useRef(false);
  const fixedGridRef = useRef(false);
  const mirroredRef = useRef(mirrored); mirroredRef.current = mirrored;
  const sharedGridRef = useRef<{ cols: number; rows: number } | null>(null);
  const reassertIfStaleRef = useRef<() => void>(() => undefined);
  const followCursorRef = useRef<() => void>(() => undefined);
  const releasedRef = useRef(false);
  const [released, setReleasedState] = useState(false);
  const setReleased = useCallback((next: boolean) => { cancelTouchRef.current(); releasedRef.current = next; setReleasedState(next); }, []);
  // released, the tab still shows the pane read-only (the server's "watch", herdr's observer), which
  // leaves the pane at the size herdr's own window gives it; false on a server without it: paused
  const watchingRef = useRef(false);
  const [watching, setWatchingState] = useState(false);
  const setWatching = useCallback((next: boolean) => { watchingRef.current = next; setWatchingState(next); }, []);
  const setViewHeld = useCallback((held: boolean) => setWatchingState(held || watchingRef.current), []);
  const deferAttachRef = useRef<(pane: string) => boolean>(() => false);
  const releaseRef = useRef<() => void>(() => {});
  const presentationRef = useRef<() => void>(() => {});
  const cachedReleaseRef = useRef(false);
  const leaveRef = useRef<() => void>(() => {});
  const typeAheadRef = useRef<(pane: string) => void>(() => {});
  const cancelLeaveRef = useRef<() => void>(() => {});
  const reattachRef = useRef<() => void>(() => {});
  const keyboardHoldsRef = useRef<(force: boolean) => boolean>(() => false);
  const fittedRef = useRef<() => void>(() => {});
  const pendingSubmissionsRef = useRef(new Set<{ pane: string; socket: HerdrSocket; epoch: number }>());
  const endedRef = useRef(false);
  const modifyOtherKeysRef = useRef(0);
  const [observing, setObserving] = useState(role === "observe");
  const viewOnly = observing || role === "observe" || deviceWatching || isDemoWatch();
  // `unchecked`: the PC types the answer without reading its screen first (useTerminalMount showSecret)
  const [secret, setSecret] = useState<{ pane: string; prompt: string; unchecked: boolean } | null>(null);
  const secretRef = useRef<string | null>(null);
  const secretActive = secret !== null && secret.pane === paneId;
  const coarse = useMediaQuery("(pointer: coarse)");
  const coarseRef = useRef(coarse); coarseRef.current = coarse;
  const { settings, update: updateSettings } = useSettings();
  const reuseExternalLinkTabRef = useRef(settings.reuseExternalLinkTab);
  reuseExternalLinkTabRef.current = settings.reuseExternalLinkTab;
  const availableModifiers = settings.keyBarItems.reduce((mask, item) => item.type === "modifier"
    ? mask | { ctrl: 4, alt: 2, shift: 1 }[item.modifier] : mask, 0);
  useLayoutEffect(() => {
    const current = modifiersRef.current;
    const available = (modifiers: StickyModifiers): StickyModifiers => ({ ctrl: modifiers.ctrl && !!(availableModifiers & 4), alt: modifiers.alt && !!(availableModifiers & 2), shift: modifiers.shift && !!(availableModifiers & 1) });
    const next = available(current);
    if (next.ctrl === current.ctrl && next.alt === current.alt && next.shift === current.shift) return;
    setLatch({ held: next, locked: available(lockedRef.current) });
  }, [availableModifiers, setLatch]);
  const shortcutSettings = useRef(settings.shortcutOverrides);
  shortcutSettings.current = settings.shortcutOverrides;
  const tRef = useRef(t);
  tRef.current = t;
  const osc52AllowedRef = useRef(settings.paneClipboard);
  osc52AllowedRef.current = settings.paneClipboard;
  const codexDragRef = useRef(settings.codexDrag);
  codexDragRef.current = settings.codexDrag;
  const [terminalHistory, setTerminalHistory] = useState(false);
  useTerminalImages(terminal, settings.terminalImages ?? terminalHistory, coarse);
  const picturesChoiceRef = useRef(settings.terminalImages);
  picturesChoiceRef.current = settings.terminalImages;
  const narrowScreen = useMediaQuery(MIRROR_WRAP_QUERY);
  const mirrorWrap = settings.terminalMirrorWrap ?? narrowScreen;
  const mirrorWrapRef = useRef(mirrorWrap);
  mirrorWrapRef.current = mirrorWrap;
  useEffect(() => { followCursorRef.current(); }, [mirrorWrap]);
  const releaseAwayRef = useRef(settings.releasePaneAway);
  releaseAwayRef.current = settings.releasePaneAway;
  const narrowFont = false;
  const narrowFontRef = useRef(narrowFont);
  narrowFontRef.current = narrowFont;
  const narrowFontFitted = useRef(narrowFont);
  usePaneLane(stackRef);
  const directTyping = settings.terminalInputMode !== "line";
  const inputLine = !directTyping && !chatView;
  const inputLineRef = useRef(inputLine);
  inputLineRef.current = inputLine;
  const idleReleaseRef = useRef(settings.releasePaneAway && directTyping);
  idleReleaseRef.current = settings.releasePaneAway && directTyping;
  const [idleView, setIdleView] = useState(false);
  // input typed while disconnected, held for the user to review and send
  const [draftState, setDraftState] = useState<{ owner: string | null; value: InputDraft }>({ owner: null, value: EMPTY_DRAFT });
  const draft = draftState.value;
  const [actedWhileDropped, setActedWhileDropped] = useState(false);
  if (connected && actedWhileDropped) setActedWhileDropped(false);
  const heldWhileUp = useRef(false);
  if (connected) heldWhileUp.current = held;
  const connectionShown = useReconnectGrace(connected, connectedBefore, !draftIsEmpty(draft) || outputError !== null || actedWhileDropped || heldWhileUp.current, socketRef.current?.lostSince ?? null);
  const waitingOnGrace = active && connectionShown && !connected;
  useEffect(() => {
    if (!waitingOnGrace) return;
    const acted = () => setActedWhileDropped(true);
    const actions = ["keydown", "pointerdown", "beforeinput", "compositionstart"] as const;
    for (const action of actions) window.addEventListener(action, acted, true);
    return () => { for (const action of actions) window.removeEventListener(action, acted, true); };
  }, [waitingOnGrace]);
  const onPeekRef = useRef(onPeek); onPeekRef.current = onPeek;
  // App hands a new function on each of its renders, and it renders on every pane's event: read through
  // a ref, the chat's callback keeps its identity, so the conversation is not drawn again for another pane
  const onOpenTerminalRef = useRef(onOpenTerminal); onOpenTerminalRef.current = onOpenTerminal;
  const onEndPeekRef = useRef(onEndPeek); onEndPeekRef.current = onEndPeek;
  const knownOutcomesRef = useRef<{ pane: string; ids: readonly string[] } | null>(null);
  const onChatOutcomes = useCallback((pane: string, ids: readonly string[]) => { knownOutcomesRef.current = { pane, ids }; }, []);
  const knownOutcomes = (pane: string | null): readonly string[] | null => pane !== null && knownOutcomesRef.current?.pane === pane ? knownOutcomesRef.current.ids : null;
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const machineIdRef = useRef(machineId); machineIdRef.current = machineId;
  const agentRef = useRef(agent); agentRef.current = agent;
  // the agent the pane runs, for reading its screen: herdr's label stays the one shown
  const kindRef = useRef(labelledAgent(agent)); kindRef.current = labelledAgent(agent);
  const frameGateRef = useRef(new FrameGate());
  const inputRowNow = useCallback((): InputRowState | null => {
    const term = termRef.current;
    const current = kindRef.current;
    if (term === null || !readsInputRow(current)) return null;
    if (!frameGateRef.current.current) return "unknown";
    return inputRowState(current, readScreen(terminalScreen(term).active(), term.cols, term.rows));
  }, []);
  const inputAtRest = useCallback((): boolean => {
    const term = termRef.current;
    if (term === null || agentRef.current !== "claude") return false;
    const lines = readScreenLines(terminalScreen(term).active(), term.rows);
    return lines !== null && claudeMainAtRest(inputRowNow(), lines);
  }, [inputRowNow]);
  // The row as the send's receipt came, before the peek's own resize: the watch starts from it, since
  // the first frame for a new grid may be herdr's reflow of the old screen (FrameGate reflowing)
  const receiptRowRef = useRef<{ pane: string; text: string; state: InputRowState } | null>(null);
  const showSentCommand = useCallback((pane: string, text: string, known: readonly string[] | null, seen: boolean) => {
    const command = typedTerminalCommand(paneCommandsNow(pane, machineIdRef.current, agentRef.current) ?? commandsRef.current, text);
    const open = onPeekRef.current;
    if (command === null || open === undefined || paneRef.current !== pane || !activeRef.current || !presentedRef.current || !shownRef.current
      || !chatMountedRef.current || observeRef.current || heldRef.current || endedRef.current || unsupportedRef.current) return;
    if (coarseRef.current) stackRef.current?.querySelector<HTMLTextAreaElement>(".composer-text")?.blur();
    const recorded = known !== null && autoReturnArmed(kindRef.current, text, command.name);
    const watch = seen && kindRef.current !== null && screenReturnArmed(kindRef.current, text, command.name) ? kindRef.current : null;
    const atReceipt = watch === null || frameGateRef.current.reflowing ? null : inputRowNow();
    receiptRowRef.current = atReceipt === null ? null : { pane, text, state: atReceipt };
    open({ command: `${command.trigger ?? "/"}${command.name}`, text, knownOutcomeIds: known, auto: recorded || watch !== null, watch, inputRowSeen: seen });
  }, []);
  const peekOutcome = useCallback((text: string) => {
    const open = onPeekRef.current;
    if (open === undefined || heldRef.current || unsupportedRef.current || text === "") { onOpenTerminalRef.current?.(); return; }
    open({ command: outcomeCommand(text), text: null, knownOutcomeIds: null, auto: false, watch: null, inputRowSeen: inputRowNow() === "ready" });
  }, [inputRowNow]);
  const setDraft = useCallback((value: InputDraft | ((previous: InputDraft) => InputDraft)) => {
    const owner = paneRef.current ? paneStorageId(machineId, paneRef.current) : null;
    setDraftState((previous) => ({ owner, value: typeof value === "function" ? value(previous.owner === owner ? previous.value : EMPTY_DRAFT) : value }));
  }, [machineId]);
  const draftPaneRef = useRef<string | null>(null);
  // The pane whose held draft takes all later typing until Send or Discard: keys sent beside it would
  // reach the pty without the start the draft holds (`echo ` held, `rm -rf build` and Enter typed).
  // Set here on each render, and at once by onData when it holds a key, before that render comes.
  const draftHeldForRef = useRef<string | null>(null);
  draftHeldForRef.current = paneId !== null && draftState.owner === paneStorageId(machineId, paneId) && !draftIsEmpty(draft) ? paneId : null;
  // Set only while the key bar's own moves take the focus: the keyboard control's show/hide and the
  // input mode's handoff from the grid to the line. What those moves cause is not the user's:
  // reassertGrid leaves the grid alone, and onData drops the focus report (DECSET
  // 1004's ESC [ I / ESC [ O) xterm fires synchronously from inside that focus() or blur()
  const keyboardToggleFocusRef = useRef(false);
  const keyboardInstance = useId();
  const keyboardOwner = `${keyboardInstance}:${paneId === null ? "" : paneStorageId(machineId, paneId)}`;
  const keyboardOwnerRef = useRef(keyboardOwner);
  keyboardOwnerRef.current = keyboardOwner;
  // Settings > Terminal > Keyboard only from the key bar (#1635): on a touch screen, until the control's
  // Show asks for the keyboard, this pane's fields carry inputmode="none": a tap on the grid, the line,
  // Send or a key still focuses them, and raises no keyboard. The request is the tap's, not the
  // measurement's, which is blind to a floating keyboard or a zoomed page: it ends at Hide, at a
  // keyboard measured going down (the back gesture), or when the focus leaves this pane's fields
  const [keyboardRequested, setKeyboardRequested] = useState(false);
  const keyboardControlUsable = connected && inputReady && !held && !ended && !viewOnly;
  const keyboardHeld = settings.terminalKeyboardOnRequest && coarse && !keyboardRequested && keyboardControlUsable;
  const keyboardControlUsableRef = useRef(keyboardControlUsable);
  keyboardControlUsableRef.current = keyboardControlUsable;
  useEffect(() => {
    setKeyboardRequested(false);
    let up = keyboardUp();
    const unsubscribe = keyboardControl.subscribe(() => {
      const now = keyboardUp();
      if (up && !now) setKeyboardRequested(false);
      up = now;
    });
    const stack = stackRef.current;
    let timer: number | null = null;
    const onFocusOut = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const focused = document.activeElement;
        if (!(focused instanceof HTMLElement && stack?.contains(focused) === true && focused.matches(".terminal-input-text, .xterm-helper-textarea"))) setKeyboardRequested(false);
      }, 0);
    };
    const onFocusIn = (event: FocusEvent): void => {
      if (!keyboardControlUsableRef.current && event.target instanceof HTMLElement && event.target.matches(".terminal-input-text, .xterm-helper-textarea")) setKeyboardRequested(true);
    };
    stack?.addEventListener("focusout", onFocusOut);
    stack?.addEventListener("focusin", onFocusIn);
    return () => {
      unsubscribe();
      stack?.removeEventListener("focusout", onFocusOut);
      stack?.removeEventListener("focusin", onFocusIn);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [paneId]);
  useEffect(() => {
    if (!active || !presented) return;
    return () => keyboardControl.release(keyboardOwner);
  }, [active, presented, keyboardOwner]);
  useEffect(() => {
    if (!paneId || draftState.owner !== paneStorageId(machineId, paneId)) return;
    const key = `ovis:terminal-draft:${draftState.owner}`;
    // held text that looks like a key stays on screen only: never written down, as the input line's (#2523)
    try { if (draftIsEmpty(draft) || looksLikeKey(draft.text)) paneLifetimes.paneStorage.removeItem(key); else paneLifetimes.paneStorage.setItem(key, JSON.stringify({ ...draft, at: Date.now() })); } catch {}
  }, [draftState, paneId, machineId, draft]);
  // Another herdr took the PC's pane IDs (lib/paneLifetime.ts): the input held for the last one's
  // pane is not this one's. Read again before paint, without the reattach a pane change brings.
  const lifetime = useSyncExternalStore(paneLifetimes.subscribe, () => paneLifetimes.generation(machineId));
  const lifetimeRef = useRef(lifetime);
  useLayoutEffect(() => {
    if (lifetimeRef.current === lifetime) return;
    lifetimeRef.current = lifetime;
    // input held a moment ago may not be saved yet (the effect above saves it after paint): to recovery with the rest
    if (paneId && draftState.owner === paneStorageId(machineId, paneId) && draft.text.trim() !== "" && !looksLikeKey(draft.text)) paneLifetimes.keep(machineId, paneId, "held", draft.text);
    let saved = EMPTY_DRAFT;
    try { saved = paneId ? restoreDraft(paneLifetimes.paneStorage.getItem(`ovis:terminal-draft:${paneStorageId(machineId, paneId)}`), Date.now()) : EMPTY_DRAFT; } catch {}
    setDraft(saved);
  }, [lifetime]);
  const [clipboardNote, setClipboardNote] = useState<string | null>(null);
  const clipboardTimerRef = useRef<number | null>(null);
  const [dismissedNotices, setDismissedNotices] = useState<DismissedNotices>(NO_DISMISSALS);
  const [selectionQuote, setSelectionQuote] = useState<{ pane: string; text: string; range: { start: number; end: number } | null } | null>(null);
  const [chatRefresh, setChatRefresh] = useState(0);
  const [chatInvalidation, setChatInvalidation] = useState(0);
  const { autoPeek, onCommandScreenClosed, stillOpen, stillOpenRef, setStillOpen, pendingOpenRef, undecidedOpenRef, chatHistoryRef, stillOpenNotedRef, onInputRowFrameRef, stillOpenNote, showStillOpen } = usePeekReturn({ activeRef, agent, agentRef, agentStatus, chatMounted, coarseRef, compositionCommitPendingRef, composingRef, draftHeldForRef, ended, findOpenRef, frameGateRef, inputRowNow, lineComposingRef, onEndPeekRef, onOpenTerminal, onPeekRef, paneId, paneRef, peek, peekRef, presented, receiptRowRef, stackRef, termRef, terminalId, t, heldRef, unsupportedRef });
  const { conversationPushes, setConversationPushes, onConversationWatch, chatOutputRef, onTerminalOutput, chatSent, setChatSent, chatUnsent, setChatUnsent, chatMetadata, redrawGreeting, onChatRead, greetingRoom, setGreetingRoom, greetingRef, chatPrompt, promptRefresh, setPromptRefresh, chatSuggestion, chatRestored, pendingAnswer, setPendingAnswer, promptDock, setPromptDock, onPromptAnswered, clearPendingAnswer, onChatPrompt, onChatMetadata, onChatSuggestion, onChatRestored } = useChatCallbacks({ activeRef, agentStatus, chatHistoryRef, chatViewRef, findOpenRef, machineId, pendingOpenRef, setStillOpen, socketRef, stackRef, stillOpenRef, undecidedOpenRef });
  const [chatLocalSend, setChatLocalSend] = useState({ key: 0, navigationGeneration: 0 });
  const chatNavigation = useRef(0);
  const queueStore = messageQueues;
  const queueOwner = paneId === null ? null : paneStorageId(machineId, paneId);
  const queued = useSyncExternalStore(queueStore.subscribe, () => queueStore.read(queueOwner ?? ""));
  const pending = useSyncExternalStore(pendingMessages.subscribe, () => pendingMessages.read(queueOwner ?? ""));
  useEffect(() => {
    if (!paneId || !queueOwner || !submitRetention) return;
    let release: (() => void) | undefined;
    const retainPending = (): void => {
      const scope = sessionRef.current?.scope ?? null;
      const waits = pendingMessages.read(queueOwner).some((message) => pendingMessages.isOwned(queueOwner, message.id, scope)
        && (message.state === "queued" || message.state === "sending"));
      if (waits) release ??= submitRetention.retain(paneId);
      else { release?.(); release = undefined; }
    };
    // Transfer retention before the submit promise releases its receipt claim. A React
    // render/effect after that release would let navigation unmount the pane in between.
    const off = pendingMessages.subscribe(retainPending);
    retainPending();
    return () => { off(); release?.(); };
  }, [paneId, queueOwner, submitRetention]);
  const sendingRef = useRef(false);
  const [queueSending, setQueueSending] = useState<string | null>(null);
  // a refused Send now's note outlives this mount: a pane left for another workspace unmounts, and
  // the note must still be there when the user comes back (it is never a retry, only the words)
  const [queueError, setQueueErrorState] = useState<{ owner: string; id: string; text: string } | null>(() => (queueOwner === null ? null : heldRowNotes.get(queueOwner) ?? null));
  // the note is kept at once, not in the state update: a Send now answered after this pane
  // unmounted (the user went to another workspace) runs no update here, and the note must stay
  const setQueueError = useCallback((note: { owner: string; id: string; text: string } | null): void => {
    if (note) heldRowNotes.set(note.owner, note);
    setQueueErrorState(note);
  }, []);

  paneRef.current = paneId;
  endedRef.current = ended;
  onConnectionChangeRef.current = onConnectionChange;
  onServerMessageRef.current = onServerMessage;
  onRoleAckRef.current = onRoleAck;

  useEffect(() => {
    if (connected && socketRef.current !== null) connectedSockets.add(socketRef.current);
    if (connected && !connectedBefore) setConnectedBefore(true);
    if (active) onConnectionChangeRef.current?.(connectionShown, connectedBefore || connected);
  }, [connected, connectionShown, connectedBefore, active]);

  const observingMount = useRef(Symbol("pane-terminal")).current;
  useEffect(() => {
    if (paneId === null) return;
    const key = paneStorageId(machineId, paneId);
    paneObserving.set(key, observingMount, mountRole({ observing: viewOnly, inputReady }));
    return () => paneObserving.set(key, observingMount, null);
  }, [machineId, paneId, viewOnly, inputReady, observingMount]);

  useEffect(() => {
    if (active) onRoleAckRef.current?.(observing ? "observe" : "interact");
    else {
      termRef.current?.blur();
      if (stackRef.current?.contains(document.activeElement) && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
  }, [active, observing]);

  const noteClipboard = useCallback((note: string) => {
    if (clipboardTimerRef.current !== null) window.clearTimeout(clipboardTimerRef.current);
    setClipboardNote(note);
    clipboardTimerRef.current = window.setTimeout(() => {
      clipboardTimerRef.current = null;
      setClipboardNote(null);
    }, 2500);
  }, []);

  useTerminalMount({ setTerminalHistory, picturesChoiceRef, typeAheadRef, activeRef, agentRef, barKeyRef, baseFontRef, pinchingRef, cachedRef, watchedRef, cachedReleaseRef, cancelLeaveRef, cancelTouchRef, chatMountedRef, chatOutputRef, chatViewRef, clearModifiers, clipboardTimerRef, coarseRef, commitPendingText, composingRef, compositionCommitPendingRef, consumeModifiers, deferAttachRef, draftHeldForRef, draftPaneRef, endedRef, findOpenRef, fitRef, fittedRef, fixedGridRef, followCursorRef, followRef, frameGateRef, heldRef, hostRef, hyperlinksRef, keyboardHoldsRef, keyboardToggleFocusRef, leaveRef, lineScroll, machineId, machineSessions, mirroredRef, mirrorWrapRef, modifiersRef, modifyOtherKeysRef, narrowFontRef, noteClipboard, observeRef, onChatSuggestion, onInputRowFrameRef, onRoleAckRef, onServerMessageRef, openFileRef, openWebRef, reuseExternalLinkTabRef, osc52AllowedRef, codexDragRef, outputTargetRef, colors, paneRef, pendingEpochRef, pendingScopeRef, pendingSubmissionsRef, pinchBadgeRef, pinchStatusRef, presentationRef, presentedRef, reassertIfStaleRef, reattachRef, redrawGreeting, releaseAwayRef, idleReleaseRef, setIdleView, releaseRef, releasedRef, retireOutputRef, secretRef, sessionRef, setChatInvalidation, setChatRefresh, setChatSent, setComposing, setConnected, setConnectedBefore, setConversationPushes, setDraft, setEnded, setHeld, setInputError, setInputReady, setObserving, setOutputError, setOutputReady, setParsedTarget, setReleased, setSecret, setSelectionQuote, setTerminal, setUnsupported, setViewHeld, setWatching, sharedGridRef, shortcutSettings, shownRef, coveredRef, sizesPty, socketRef, stackRef, stalledRef, stopKeyRef, submitRetention, t, tRef, termRef, terminalFontSize, updateSettings, uploadFileRef, attachFilesRef, watchingRef, wheelStateRef });

  useTerminalRefits({ activeRef, autoSelected, baseFontRef, pinchingRef, fontSettledRef, chatView, chatViewRef, coarseRef, findOpenRef, fitRef, fittedRef, fixedGridRef, follow, followCursorRef, keyboardHoldsRef, narrowFont, narrowFontFitted, observeRef, colors, covered, paneRef, peekRef, sharedGridRef, shown, sizesPty, socketRef, termRef, terminalFontFamily, terminalFontSize });

  usePaneAttach({ typeAheadRef, activeRef, autoSelected, cached, watched, coarseRef, coveredRef, deferAttachRef, fontSettledRef, draftPaneRef, findOpenRef, fitRef, fittedRef, fixedGridRef, frameGateRef, hyperlinksRef, hostRef, machineId, mirrored, modifyOtherKeysRef, observeRef, paneId, pending, presented, presentationRef, releaseRef, releasedRef, retireOutputRef, secretRef, setDraft, setComposing, setEnded, setHeld, setInputError, setInputReady, setOutputError, setOutputReady, setReleased, setSecret, setUnsupported, setWatching, sharedGridRef, socketRef, stalledRef, terminalId, termRef, chatViewRef, cancelLeaveRef, cachedRef, watchingRef, keyboardHoldsRef, followRef, followCursorRef, leaveRef, shownRef });

  useEffect(() => {
    if (active && !autoSelected && !chatViewRef.current && !coarseRef.current && !modalOpen() && !findOpenRef.current && !typeAheadFocused()) termRef.current?.focus();
  }, [active, autoSelected]);

  const autoSelectedRef = useRef(autoSelected);
  useEffect(() => {
    const wasAuto = autoSelectedRef.current;
    autoSelectedRef.current = autoSelected;
    if (activeRef.current && wasAuto && !autoSelected && !chatViewRef.current && !coarseRef.current && !modalOpen() && !findOpenRef.current && !typeAheadFocused()) termRef.current?.focus();
  }, [autoSelected]);

  // ask the server for the role change; the role-ack handler applies the local
  // consequences (stdin gate, grid adoption or reclamation) once it is confirmed.
  // The initial default is skipped: the server already treats fresh connections as interact.
  const lastSentRole = useRef<ClientRole>("interact");
  useEffect(() => {
    if (role === lastSentRole.current) return;
    lastSentRole.current = role;
    socketRef.current?.setMode(role);
  }, [role]);

  const { sendDraft, discardDraft, submitComposerMessage, sendComposerText, sendTerminalLine, insertTerminalText, reassertGrid, pressEnter, toggleDirect } = useTerminalSends({ activeRef, agent, cancelTouchRef, chatView, coarse, composingRef, directTyping, draft, draftHeldForRef, heldRef, hostRef, inputLine, inputRowNow, keyboardHeld, keyboardOwnerRef, keyboardToggleFocusRef, lineFocus: lineRef, knownOutcomes, lineComposingRef, machineId, modifiersRef, consumeModifiers, onChatSuggestion, paneId, paneRef, pendingEpochRef, pendingSubmissionsRef, reassertIfStaleRef, redrawGreeting, releaseRef, secretRef, sessionRef, setChatRefresh, setChatSent, setChatUnsent, setDraft, showSentCommand, socketRef, stillOpenNote, stillOpenRef, submitRetention, tRef, termRef, updateSettings });

  const { pressKey, toggleModifier, abortTurn: abortTyped } = useTypedKeys({ agent, agentStatus, barKeyRef, coarseRef, commitPendingText, compositionCommitPendingRef, composingRef, inputLineRef, modifiersRef, lockedRef, setLatch, consumeModifiers, paneId, reassertIfStaleRef, setInputError, socketRef, stopKeyRef, tRef, termRef });
  // an ACP child's Stop is a person's hold (server/dispatch.ts): its turn is cancelled and the agent that called it gets no new turn
  // a PC whose Ovis has no hold yet, or a child whose real TUI has the conversation, takes the Stop key instead
  const [acpError, setAcpError] = useState<string | null>(null);
  useEffect(() => { setAcpError(null); }, [paneId, acpHold?.child_id, acpHold?.generation]);
  const abortTurn = acpChild && paneId !== null
    ? () => { setAcpError(null); void holdAcpChild(paneId, machineId).catch(() => abortTyped()); }
    : abortTyped;

  // what a paste into the line is for: this PC's pane on this connection, while it can type there.
  // Read at the tap and once the clipboard answers (TerminalInput.tsx): any difference drops the paste
  /** the PC, pane, connection and input lease a paste (the input line) or an attach (direct typing) is for; null while it cannot take one */
  const inputTarget = useCallback((line: boolean): string | null => {
    const socket = socketRef.current;
    const pane = paneRef.current;
    // a pane put out of sight (another pane picked in the split) is no longer where the user pastes
    if (!socket || pane === null || !socket.connected || !activeRef.current || !presentedRef.current || secretRef.current !== null || observeRef.current || heldRef.current || endedRef.current || releasedRef.current || inputLineRef.current !== line) return null;
    return `${paneStorageId(machineId, pane)}:${socket.inputLease(pane)}`;
  }, [machineId]);
  const pasteTarget = useCallback(() => inputTarget(true), [inputTarget]);
  // the key bar's Attach files: what the tap found must still hold when the files are stored, or nothing is typed
  const attachTarget = useCallback(() => {
    const target = inputTarget(false);
    return target === null ? null : (files: File[]) => attachFilesRef.current(files, () => inputTarget(false) === target);
  }, [inputTarget]);

  // the key bar's Paste goes into the input line, never into the grid: with the line put away
  // (direct typing), the bar says so beside the Input line key it names, in its own row (never over
  // the grid's output), and changes nothing, the mode included
  const [pasteGuidance, setPasteGuidance] = useState(false);
  const pasteGuidanceTimerRef = useRef<number | null>(null);
  const dismissPasteGuidance = useCallback(() => {
    if (pasteGuidanceTimerRef.current !== null) window.clearTimeout(pasteGuidanceTimerRef.current);
    pasteGuidanceTimerRef.current = null;
    setPasteGuidance(false);
  }, []);
  useEffect(() => dismissPasteGuidance, [inputLine, paneId, dismissPasteGuidance]);
  const pasteIntoLine = useCallback(() => {
    if (!inputLineRef.current) {
      if (pasteGuidanceTimerRef.current !== null) window.clearTimeout(pasteGuidanceTimerRef.current);
      setPasteGuidance(true);
      pasteGuidanceTimerRef.current = window.setTimeout(() => {
        pasteGuidanceTimerRef.current = null;
        setPasteGuidance(false);
      }, PASTE_GUIDANCE_MS);
      return;
    }
    lineRef.current?.paste();
  }, []);

  // the key bar's keyboard control: the soft keyboard for the current input mode, shown or put away
  // without a key, a mode change, a fit or a resize (the grid under a keyboard stays, #1045). Label
  // and tap share lib/keyboardControl.ts's tap word, so a mid-animation keyboard cannot read the tap
  // for itself. The focus runs inside the tap's own gesture, which is what lets a phone raise its
  // keyboard; Show's blur-and-refocus of an already focused field is a new input session, which a
  // keyboard a back gesture put away needs. A composition in either field, a commit on its way or a
  // paste reading the clipboard refuses the tap outright: nothing runs later, no compositionend is
  // forced. Safari's Hangul or dictation preedit has no composition events and waits for a blur
  // (the xterm patch): Hide's blur types it, as a key-bar key does first (commitPendingText)
  const toggleKeyboard = useCallback(() => {
    if (!activeRef.current || !presentedRef.current || modalOpen() || observeRef.current || heldRef.current || endedRef.current || releasedRef.current) return;
    const stack = stackRef.current;
    const focused = document.activeElement;
    const hideTarget = focused instanceof HTMLElement && stack?.contains(focused) === true && focused.closest(".key-bar") === null ? focused : null;
    const line = stack?.querySelector<HTMLElement>(".terminal-input-text") ?? termRef.current?.textarea ?? null;
    const action = keyboardControl.press({
      refused: composingRef.current || lineComposingRef.current || compositionCommitPendingRef.current,
      hideTarget: hideTarget !== null,
      showTarget: line !== null,
      owner: keyboardOwnerRef.current,
    });
    if (action !== "show" && action !== "hide") return;
    setKeyboardRequested(action === "show");
    const show = (): void => {
      if (line === null) return;
      line.removeAttribute("inputmode");
      if (line === document.activeElement) {
        // a keyboard already put away while the field kept the focus (the back gesture): a blur and
        // a focus inside the tap is a new input session, which is what a phone raises a keyboard for
        line.blur();
      }
      if (line === termRef.current?.textarea) termRef.current?.focus();
      else line.focus({ preventScroll: true });
    };
    keyboardToggleFocusRef.current = true;
    try {
      if (action === "show") show();
      else hideTarget?.blur();
    } finally {
      keyboardToggleFocusRef.current = false;
    }
    keyboardControl.settled(action, !keyboardTypingField(document.activeElement));
  }, []);

  // While the agent runs, append to its held messages. Each requires an explicit send.
  // a question in Codex's queue leaves the composer alone: Codex keeps working, and a
  // message ("stop, don't touch prod") must reach it, not become the answer; its card answers it
  // a fallback card is answered with its own buttons: what the user types still goes to the agent
  const answering = chatView && chatPrompt !== null && chatPrompt.pane === paneId && !chatPrompt.value.queued && !chatPrompt.value.fallback ? chatPrompt.value : null;
  const answerPending = answering !== null && chatPrompt?.answered === true;
  // ...and while it is open in the terminal it holds the input: nothing is sent into it
  const heldByOpenQueue = chatView && chatPrompt !== null && chatPrompt.pane === paneId && chatPrompt.value.queued === "open";
  const readyForQueue = agentStatus !== undefined && QUEUE_READY_STATUS[agentStatus] === true;
  const shortPhone = useMediaQuery(SHORT_PHONE_QUERY);
  const heldFold = heldRowsFold({ promptOpen: chatView && chatPrompt !== null && chatPrompt.pane === paneId, shortPhone, ready: readyForQueue });
  const heldListRef = useRef<HTMLOListElement | null>(null);
  const heldToggleRef = useRef<HTMLButtonElement | null>(null);
  const [heldOpened, setHeldOpened] = useState(false);
  const heldAny = queued.length > 0;
  const [heldSeen, setHeldSeen] = useState({ owner: queueOwner, fold: heldFold, any: heldAny });
  if (heldSeen.owner !== queueOwner || heldSeen.fold !== heldFold || heldSeen.any !== heldAny) {
    setHeldSeen({ owner: queueOwner, fold: heldFold, any: heldAny });
    setHeldOpened(heldOpenAtFold({
      fold: heldFold && heldAny,
      sameOwner: heldSeen.owner === queueOwner,
      focusInRows: heldListRef.current?.contains(document.activeElement) === true,
    }));
  }
  const heldRowFailed = heldRowError(queueError, queueOwner, queued.map((message) => message.id));
  const heldHidden = heldRowsHidden(heldFold, heldOpened, heldRowFailed);
  const heldToggle = heldToggleShown(heldFold, heldRowFailed);
  // React detaches the button's ref just before it removes the node, while focus is still on it:
  // that is read in the commit, never in a render React may discard.
  const heldRefocusRef = useRef<string | null>(null);
  const setHeldToggle = useCallback((node: HTMLButtonElement | null) => {
    if (node === null && heldToggleRef.current !== null && document.activeElement === heldToggleRef.current) heldRefocusRef.current = heldToggleRef.current.getAttribute("aria-controls");
    heldToggleRef.current = node;
  }, []);
  useLayoutEffect(() => {
    const left = heldRefocusRef.current;
    if (left === null) return;
    heldRefocusRef.current = null;
    if (heldRefocusDue(left, heldListRef.current?.id ?? null)) heldListRef.current?.focus({ preventScroll: true });
  });
  const folder = greetingFolder(cwd);
  const [claims, setClaims] = useState(0);
  const onSendClaim = useCallback((delta: 1 | -1) => setClaims((current) => current + delta), []);
  const greetingDue = chatView && paneId !== null && agent !== null && !secretActive && !observing && !ended && claims === 0
    && showsGreeting({ memory: greetingMemory(paneStorageId(machineId, paneId)), agentStatus, queued: queued.length + pending.length, folder });
  const greeted = greetingDue && greetingRoom;
  const sending = claims > 0 || pending.length > 0 || (paneId !== null && greetingMemory(paneStorageId(machineId, paneId)).pending > 0);
  useLayoutEffect(() => {
    const stack = stackRef.current;
    const greeting = greetingRef.current;
    const composer = greeting?.parentElement;
    if (!greetingDue || !stack || !greeting || !composer) return;
    const place = (): void => {
      const lift = composerLift(stack.clientHeight, composer.offsetHeight, greeting.offsetHeight);
      const card = composer.querySelector(".composer-surface");
      const cardOffset = card === null ? 0 : card.getBoundingClientRect().top - composer.getBoundingClientRect().top;
      stack.style.setProperty("--composer-lift", `${lift}px`);
      stack.style.setProperty("--composer-room", `${roomOverComposer(stack.clientHeight, composer.offsetHeight, lift, cardOffset)}px`);
      setGreetingRoom(greetingFits(stack.clientHeight, composer.offsetHeight, greeting.offsetHeight));
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(stack); observer.observe(composer); observer.observe(greeting);
    return () => { observer.disconnect(); stack.style.removeProperty("--composer-lift"); stack.style.removeProperty("--composer-room"); setGreetingRoom(true); };
  }, [greetingDue, paneId]);

  const noticesDocked = presented && paneId !== null && chatView && !secretActive && !observing && !ended;
  const noticeItems: ComposerNoticeRow[] = [];
  if (paneId !== null) {
    const owner = paneStorageId(machineId, paneId);
    const takeOver = !observing && socketRef.current?.canTakeOver() === true;
    // one notice per hold: a hold set again elsewhere draws a new button, so a press never hands back a hold it did not see
    if (acpHold) noticeItems.push({
      id: `${owner}:acp-hold:${acpHold.child_id}:${acpHold.generation}`, priority: "activity", revision: "", warning: acpError !== null, mark: <Pause />,
      text: acpError ?? t("Stopped by you. The agent that called it cannot give it new work."),
      actions: <button type="button" className="composer-notice-action" disabled={viewOnly} onClick={() => { setAcpError(null); void releaseAcpChild(paneId, acpHold, machineId).catch(() => setAcpError(t("Not handed back: Ovis could not reach this agent. Try again."))); }}>{t("Hand back")}</button>,
    });
    if (held) noticeItems.push({
      id: `${owner}:held`, priority: "urgent", revision: takeOver ? "open-here" : "", warning: true, mark: <Unplug />,
      text: t("Another app has this pane open. It connects here as soon as that app lets go."),
      actions: takeOver && <button type="button" className="composer-notice-action" title={t("Take this pane from another web app or terminal attach. That connection will close.")} onClick={() => { socketRef.current?.takeOver(paneId); }}>{t("Open here")}</button>,
    });
    if (outputError) noticeItems.push({
      id: `${owner}:output`, priority: "urgent", revision: outputError, warning: true, mark: <TriangleAlert />, text: outputError,
      actions: <a className="composer-notice-action" href={reconnectHref(machineId, paneId)} onClick={(event) => reloadOnPlainClick(event)}>{t("Reconnect")}</a>,
    });
    if (!ended && connected && !draftIsEmpty(draft)) noticeItems.push({
      id: `${owner}:draft`, priority: "activity", revision: `${draft.truncated ? "…" : ""}${draft.text}`, warning: false, mark: <Clock />,
      text: <>
        <span className="visually-hidden">{t("Input held:")}</span>
        {draft.text.length > 0 && <code title={draft.text}>{draft.text}</code>}
        {draft.truncated && <> {t("Some input was too long to hold and was left out.")}</>}
      </>,
      actions: <>
        <button type="button" className="icon-button" aria-label={t("Send held input")} title={t("Send held input")} disabled={draft.text.length === 0 || observing || secretActive || held} onClick={sendDraft}><ArrowUp aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label={t("Discard held input")} title={t("Discard held input")} onClick={discardDraft}><Trash2 aria-hidden="true" /></button>
      </>,
    });
    if (clipboardNote) noticeItems.push({ id: `${owner}:clipboard`, priority: "notice", revision: clipboardNote, warning: false, mark: <ClipboardCheck />, text: clipboardNote });
    // a peek ended by hand over a screen still open in the terminal: the next message would land in it
    if (stillOpen !== null && stillOpen.pane === paneId) noticeItems.push({
      id: `${owner}:still-open`, priority: "urgent", revision: stillOpen.named ? stillOpen.command : "", warning: false, mark: <SquareTerminal />,
      text: stillOpen.named ? t("{command} is still open in the terminal", { command: stillOpen.command }) : t("A screen is still open in the terminal"),
      actions: <button type="button" className="composer-notice-action" onClick={showStillOpen}>{t("Show terminal")}</button>,
    });
  }
  const settledNotices = settleDismissed(dismissedNotices, noticeItems);
  if (settledNotices !== dismissedNotices) setDismissedNotices(settledNotices);
  const shownNotices = noticesDocked ? arrangeNotices(noticeItems, settledNotices) : [];
  const composerNotices = shownNotices.length > 0
    ? <ComposerNotices notices={shownNotices} onDismiss={(notice) => {
      if (notice.id.endsWith(":still-open")) { setStillOpen(null); return; }
      setDismissedNotices((dismissed) => dismissNotice(dismissed, notice));
    }} />
    : null;

  const autoTabNamesRef = useRef(settings.autoTabNames);
  autoTabNamesRef.current = settings.autoTabNames;
  const showSentAndName = useCallback((pane: string, text: string, known: readonly string[] | null, seen: boolean) => {
    if (autoTabNamesRef.current) learnFromSend(machineIdRef.current, pane, agentRef.current, text);
    showSentCommand(pane, text, known, seen);
  }, [showSentCommand]);
  const { composerSend, actOnPending, waitingAnswer } = useComposerSends({ agent, agentStatus, answerPanePrompt, answering, answerPending, draftHeldForRef, ended, heldByOpenQueue, heldRef, inputAtRest, inputRowNow, knownOutcomes, observeRef, paneId, paneRef, pendingAnswer, pendingScopeRef, queueOwner, queueStore, machineId, secretRef, setPendingAnswer, setPromptRefresh, settings, showSentCommand: showSentAndName, socketRef, stillOpenNote, stillOpenNotedRef, stillOpenRef, submitComposerMessage, submitRetention, t, chatNavigation, setChatLocalSend, sessionRef });

  // Capture the owner's pane for the entire upload batch, even across a pane switch.
  const uploadImage = useCallback((file: Blob) => uploadPaneImage(paneId ?? "", file), [paneId]);

  useEffect(() => {
    if (!active || !paneId) return;
    const onPage = (event: KeyboardEvent) => {
      const direction = plainPageDirection(event);
      if (direction === null || event.defaultPrevented || !activeRef.current || !presentedRef.current || !chatViewRef.current || modalOpen()
          || isAppShortcut(event, shortcutSettings.current) || pageScroll.current === null) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, [contenteditable=true]") && !target.matches(".composer-text")) return;
      event.preventDefault();
      event.stopPropagation();
      pageScroll.current(direction);
    };
    window.addEventListener("keydown", onPage, true);
    return () => window.removeEventListener("keydown", onPage, true);
  }, [active, paneId]);

  const sendApplicationPage = useCallback((direction: -1 | 1) => {
    const pane = paneRef.current, socket = socketRef.current;
    if (!pane || !socket?.connected || !activeRef.current || !presentedRef.current || chatViewRef.current || modalOpen()
        || observeRef.current || heldRef.current || endedRef.current || releasedRef.current || secretRef.current !== null
        || composingRef.current || compositionCommitPendingRef.current) return;
    // An explicit page action follows the program's own history when herdr has none.
    // The live input lease refuses an unready pane and never queues this key for later.
    cancelTouchRef.current();
    socket.sendInput(pane, direction < 0 ? "\x1b[5~" : "\x1b[6~");
  }, []);

  useLayoutEffect(() => {
    if (!controls || !active || !paneId) return;
    const current: PaneControls = {
      focusInput: () => {
        if (!activeRef.current || !presentedRef.current || modalOpen() || observeRef.current) return;
        const stack = stackRef.current;
        const secret = stack?.querySelector<HTMLInputElement>(".secret-input input");
        if (secret) { secret.focus({ preventScroll: true }); return; }
        const input = stack?.querySelector<HTMLTextAreaElement>(chatViewRef.current ? ".composer-text" : ".terminal-input-text");
        if (input) input.focus({ preventScroll: true });
        else if (!chatViewRef.current && !heldRef.current && !endedRef.current) termRef.current?.focus();
      },
      scrollPage: (direction) => {
        if (activeRef.current && presentedRef.current && !modalOpen()) pageScroll.current?.(direction);
      },
    };
    controls.current = current;
    return () => { if (controls.current === current) controls.current = null; };
  }, [controls, active, paneId]);

  const secretInput = presented && paneId !== null && secretActive && !observing && !ended && connected && outputReady ? <SecretInput
    key={`${paneId}:${secret.prompt}`} prompt={secret.prompt} active={active} unchecked={secret.unchecked}
    onSend={(value) => socketRef.current?.sendSecret(paneId, secret.prompt, value, () => secretRef.current === secret.prompt) ?? null}
    onCancel={() => { if (socketRef.current?.connected) { cancelTouchRef.current(); socketRef.current.sendInput(paneId, "\u0003"); } }}
  /> : null;
  const lineSlot = presented && paneId !== null && !viewOnly && !ended && inputLine;
  const [inputSlot, setInputSlot] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const surface = stackRef.current?.querySelector(".terminal-surface");
    if (!stackRef.current || !surface || !inputSlot) return;
    const measure = () => {
      const slot = inputSlot.getBoundingClientRect();
      if (slot.width === 0) return;
      const room = slot.bottom - surface.getBoundingClientRect().top;
      inputSlot.style.setProperty("--terminal-input-room", `${Math.max(0, Math.floor(room))}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stackRef.current);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [inputSlot]);
  const [keysOpen, setKeysOpen] = useState(false);
  const foldKeys = coarse && settings.terminalFoldKeyBar && lineSlot && !secretActive;
  const lineLast = foldKeys && !keysOpen;
  useLayoutEffect(() => {
    if (!foldKeys) setKeysOpen(false);
    else if (!keysOpen) clearModifiers();
  }, [foldKeys, keysOpen, clearModifiers]);
  const [lineAtScreenBottom, setLineAtScreenBottom] = useState(false);
  useLayoutEffect(() => {
    if (!inputSlot || !lineLast) { setLineAtScreenBottom(false); return; }
    const place = (): void => setLineAtScreenBottom(inputSlot.getBoundingClientRect().bottom >= window.innerHeight - 1);
    place();
    const observer = new ResizeObserver(place);
    for (let node: HTMLElement | null = inputSlot.parentElement; node; node = node.parentElement) observer.observe(node);
    window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); };
  }, [inputSlot, lineLast]);

  const waitingWords = useAnnouncedText(paneId !== null && !chatView && !observing && connected && !inputReady && !held && !ended && !released ? t("Waiting for terminal input…") : null);

  return (
    // A press on the peek's dimmed, inert composer lands on the stack itself: it keeps the keyboard
    // in the grid, so Escape still reaches the agent, instead of handing focus to the pane frame
    <div ref={stackRef} className={`terminal-stack${chatMounted ? " is-chat" : ""}${peek !== null ? " is-peek" : ""}${greeted ? " is-greeted" : ""}`} data-pane-owner={paneId === null ? undefined : paneStorageId(machineId, paneId)} data-direct-typing={coarse && directTyping && !chatView ? "" : undefined}
      onMouseDown={peek !== null && !coarse ? (event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        termRef.current?.focus();
      } : undefined}
      data-pane-content={!chatView && paneId !== null && active && presented && shown && connected && outputReady && parsedTarget === outputTarget && !held && !ended && !released && !unsupported && !outputError ? presentationKey : undefined}>
      {paneId === null && restoreError !== null && (
        <div className="terminal-placeholder is-restore-error" role="status">
          <div className="terminal-placeholder-inner">
            <TriangleAlert aria-hidden="true" />
            <span>{t("herdr could not restore this pane")}</span>
            <span className="terminal-placeholder-detail">{restoreError}</span>
          </div>
        </div>
      )}
      {paneId === null && restoreError === null && (
        <div className="terminal-placeholder">
          <div className="terminal-placeholder-inner">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
              <path d="M7 9l3 3-3 3" />
              <path d="M12.5 15h4.5" />
            </svg>
            <span>{t("Select a pane to open its terminal")}</span>
          </div>
        </div>
      )}
      <div className="terminal-banners">
        {paneId !== null && held && !noticesDocked && (
          <div className="terminal-banner terminal-banner-warning" role="status">
            <span>{t("Another app has this pane open. It connects here as soon as that app lets go.")}</span>
            {!observing && socketRef.current?.canTakeOver() && (
              <button type="button" className="btn terminal-banner-action" title={t("Take this pane from another web app or terminal attach. That connection will close.")} onClick={() => { if (paneId !== null) socketRef.current?.takeOver(paneId); }}>{t("Open here")}</button>
            )}
          </div>
        )}
        {paneId !== null && !chatView && unsupported && (
          <div className="terminal-banner terminal-banner-soon" role="status">
            <span>{t("Live terminal is coming to Windows PCs: herdr cannot attach a terminal there yet. The chat lens works now.")}</span>
          </div>
        )}
        {paneId !== null && outputError && !noticesDocked && (
          <div className="terminal-banner terminal-banner-warning terminal-banner-output-error" role="status">
            <span>{outputError}</span>
            <button type="button" className="btn" onClick={() => reattachRef.current()}>{t("Reconnect")}</button>
          </div>
        )}
        {!chatView && inputError && <div className="terminal-banner" role="status">{inputError}<button type="button" className="btn terminal-banner-action" onClick={() => setInputError(null)}>{t("Dismiss")}</button></div>}
        <div className={waitingWords === null ? "visually-hidden" : "terminal-banner"} role="status">{waitingWords}</div>
        {paneId !== null && !chatView && released && <div className="terminal-banner" role="status">{t(watching ? idleView ? "View only while you are not typing here · type or click to type" : "View only while you use another window · click to type" : "Paused while you use another window")}</div>}
        {paneId !== null && !chatView && ended && !outputError && (
          <div className="terminal-banner" role="status">
            {t("Terminal ended")}
          </div>
        )}
        {paneId !== null && !chatView && !ended && !connectionShown && (
          <div className="terminal-banner terminal-banner-warning" role="status">
            {t(connectedBefore ? "Reconnecting to Ovis…" : "Connecting to Ovis…")}
            {draft.text.length > 0 && <span className="draft-held" title={draft.text}> {t("Input held:")} <code>“{draft.text}”</code></span>}
          </div>
        )}
        {paneId !== null && peek !== null && (
          <div className="terminal-banner terminal-banner-command" role="status">
            <span className="terminal-command-label">
              <SquareTerminal aria-hidden="true" />
              <span className="terminal-command-words">
                <span title={peek.command}>{t("{command} ran", { command: peek.command })}</span>
                {autoPeek !== null && <span className="terminal-command-note">{t("Chat may come back when you close it")}</span>}
              </span>
            </span>
            <span className="terminal-command-actions">
              <button type="button" className="btn btn-ghost" onClick={() => onEndPeek?.(peek)}><ArrowLeft aria-hidden="true" />{t("Back to Chat")}</button>
              {onOpenTerminal && <button type="button" className="btn btn-ghost" onClick={onOpenTerminal}>{t("Keep Terminal")}</button>}
            </span>
          </div>
        )}
        {paneId !== null && !ended && connected && !draftIsEmpty(draft) && !noticesDocked && (
          <div className="terminal-banner terminal-banner-draft" role="status">
            <span className="visually-hidden">{t("Input held:")}</span>
            {draft.text.length > 0 && <code className="draft-text" title={draft.text}>{draft.text}</code>}
            <span className="draft-actions">
              <button type="button" className="icon-button draft-send" aria-label={t("Send held input")} title={t("Send held input")} disabled={draft.text.length === 0 || observing || secretActive || held} onClick={sendDraft}>
                <SendHorizontal aria-hidden="true" />
              </button>
              <button type="button" className="icon-button draft-discard" aria-label={t("Discard held input")} title={t("Discard held input")} onClick={discardDraft}>
                <Trash2 aria-hidden="true" />
              </button>
            </span>
            {draft.truncated && <span className="draft-truncated">{t("Some input could not be held and was left out.")}</span>}
            {draft.leftOut && <span className="draft-truncated">{t("An Enter or line break was left out: Send never presses Enter.")}</span>}
          </div>
        )}
        {paneId !== null && !ended && (observing || (!chatView && viewOnly)) && (
          <div className="terminal-banner terminal-banner-observe" role="status">
            <Eye aria-hidden="true" />
            {t("View only")}
          </div>
        )}
        {paneId !== null && !chatView && selectionQuote?.pane === paneId && (
          <button type="button" className="terminal-banner terminal-banner-action terminal-quote"
            onMouseDown={(event) => { event.preventDefault(); }}
            onClick={() => {
              const block = formatTerminalQuote({ label: title?.trim() || paneId, range: selectionQuote.range, text: selectionQuote.text });
              if (block === null) return;
              const key = `ovis:composer-draft:${paneStorageId(machineId, paneId)}`;
              const next = appendQuote(composerDrafts.read(key).text, block, MAX_COMPOSER_CHARS);
              if (next === null) { noteClipboard(t("Too long for the message draft")); return; }
              composerDrafts.set(key, next);
              termRef.current?.clearSelection();
              noteClipboard(t("Added to the message draft"));
            }}>
            <Quote aria-hidden="true" />{t("Quote in message")}
          </button>
        )}
        {clipboardNote && !noticesDocked && (
          <div className="terminal-banner" role="status">
            {clipboardNote}
          </div>
        )}
      </div>
      {/* its own key: under a peek it is the Composer's sibling, which is keyed by the pane too, and
          two siblings with one key leave stray copies of the bar in the stack */}
      {presented && findOpen && !chatView && paneId !== null && (
        <FindBar key={`find:${paneId}`} paneId={paneId} viewportIntent={viewportIntent} onResult={setSearchState} activePane={active} focusRequest={findRequest} disabled={!connected || held || ended || released || !outputReady}
          onClose={() => { setFindOpen(false); if (activeRef.current && !coarse) termRef.current?.focus(); }} />
      )}
      <div className="terminal-surface">
        {/* xterm hides its rendered rows from assistive technology, so the region around the
            visible grid carries the pane's name: a screen reader announces which pane
            this is. No tabIndex: xterm's helper textarea takes the keyboard here on attach, so a
            stop on the wrapper would only be an empty one ahead of it. */}
        <div className={`pane-terminal${paneId === null ? " is-idle" : ""}`} ref={hostRef} role={chatView ? undefined : "region"} aria-roledescription={chatView ? undefined : t("Terminal")} aria-label={chatView ? undefined : terminalName} />
        <span className="terminal-font-size" ref={pinchBadgeRef} hidden aria-hidden="true" />
        <span className="visually-hidden" ref={pinchStatusRef} aria-live="polite" />
        {paneId !== null && <TerminalViewportTools key={paneId} viewportIntent={viewportIntent} terminal={terminal} paneId={paneId}
          pageScroll={chatView ? undefined : pageScroll}
          lineScroll={chatView ? undefined : lineScroll}
          onApplicationPage={sendApplicationPage}
          enabled={presented && connected && outputReady && !chatView && !held && !ended && !released && !unsupported}
          interactive={!viewOnly && !secretActive && !viewportSearching} search={searchState} onError={setInputError} />}
        {paneId !== null && chatMounted && (
          <RenderBoundary resetKey={paneId} fallback={(retry) => (
            <div className="chat-view"><div className="chat-empty" role="alert">
              <p>{t("The chat can't be shown. The terminal still works.")}</p>
              <button type="button" className="btn" onClick={retry}>{t("Try again")}</button>
            </div></div>
          )}>
          {/* a pane's chat never commits another pane's turns: a new pane is a new ChatView.
              The session herdr reports is left out of the key: it can change while the
              conversation stays (a shared Codex daemon), and the chat follows history_id itself */}
          <ChatView
            presentationKey={presentationKey}
            finishEpoch={finishEpoch}
            finishId={finishId}
            key={paneId}
            paneId={paneId}
            active={active}
            visible={presented && shown}
            pageScroll={pageScroll}
            refreshKey={chatRefresh}
            invalidationKey={chatInvalidation}
            onConversationWatch={onConversationWatch}
            conversationPushes={conversationPushes && !released}
            onTerminalOutput={onTerminalOutput}
            sentKey={chatSent}
            unsentKey={chatUnsent}
            pendingRows={pending}
            localSend={chatLocalSend}
            navigation={chatNavigation}
            connected={connected}
            ended={ended}
            agent={agent}
            agentStatus={agentStatus}
            agentSession={agentSession}
            onMetadata={onChatMetadata}
            onRead={onChatRead}
            greeted={greeted || sending}
            onPrompt={onChatPrompt}
            onSuggestion={onChatSuggestion}
            onRestored={onChatRestored}
            promptRefreshKey={promptRefresh}
            pendingAnswer={pendingAnswer !== null && pendingAnswer.pane === paneId ? pendingAnswer : null}
            onPendingAnswerDone={clearPendingAnswer}
            promptDock={promptDock}
            onPromptAnswered={onPromptAnswered}
            title={title}
            onOpenTerminal={onOpenTerminal ? peekOutcome : undefined}
            covered={peek !== null}
            peek={autoPeek}
            onCommandScreenClosed={onCommandScreenClosed}
            onOutcomes={onChatOutcomes}
            interactive={!viewOnly && role === "interact"}
            watching={deviceWatching}
            quotable={!secretActive}
            cwd={cwd}
            promptContext={[agentDisplayLabel(agent), workspaceLabel, cwd, machineName].filter((part): part is string => part !== null && part !== "").join(" · ")}
            searchRequest={searchRequest}
          />
          </RenderBoundary>
        )}
      </div>
      {/* the queue is the composer's, so it shows under the chat lens only: there alone is an open
          Codex question known (heldByOpenQueue), and Send now must not type into one */}
      {presented && paneId !== null && chatMounted && !viewOnly && !ended && queueOwner !== null && queued.length > 0 && (
        <section className={`composer-queue${readyForQueue ? " is-ready" : ""}${heldHidden ? " is-folded" : ""}`} aria-label={t("Queued messages")} inert={peek !== null || undefined}>
          {(() => {
            const caption = <>
              <span className="composer-queue-mark" aria-hidden="true"><Clock /></span>
              <span className="composer-queue-caption">
                {t(readyForQueue ? "Held message — review and send" : "Held until the agent is ready")}
                <> · {queued.length === 1 ? t("{n} message", { n: 1 }) : t("{n} messages", { n: queued.length })}</>
              </span>
            </>;
            return <div className="composer-queue-heading">
              <strong className="visually-hidden">{t("Queued messages ({n})", { n: queued.length })}</strong>
              {heldToggle
                ? <button type="button" className="composer-queue-toggle" ref={setHeldToggle} aria-expanded={!heldHidden} aria-controls={`queued-list-${queueOwner}`}
                    onClick={() => { setHeldOpened(heldHidden); }}>
                    {caption}
                    <span className="composer-queue-toggle-caret" aria-hidden="true"><ChevronRight /></span>
                  </button>
                : caption}
            </div>;
          })()}
          {queueStore.isUnsaved(queueOwner) && <p className="composer-queue-error" role="status">{t("Queue could not be saved. Keep this tab open or copy the messages before reloading.")}</p>}
          <ol className="composer-queue-list" id={`queued-list-${queueOwner}`} ref={heldListRef} tabIndex={-1}
            onFocus={() => { setHeldOpened((opened) => heldOpenOnFocus(heldFold, opened)); }}>
          {queued.map((message, index) => <li className="composer-queue-item" key={message.id}>
            <label className="visually-hidden" htmlFor={`queued-${message.id}`}>{t("Message {n}", { n: index + 1 })}</label>
            <textarea
              id={`queued-${message.id}`}
              className="composer-queue-text"
              value={message.text}
              rows={Math.min(4, message.text.split("\n").length)}
              aria-label={t("Queued message {n}", { n: index + 1 })}
              maxLength={MAX_COMPOSER_CHARS}
              disabled={queueStore.isSending(message.id)}
              spellCheck autoCapitalize="sentences" autoCorrect="on"
              onChange={(event) => { queueStore.edit(queueOwner, message.id, event.target.value); }}
            />
            <div className="composer-queue-actions">
              <button type="button" className="composer-queue-send"
                disabled={!connected || held || secretActive || queueSending !== null || queued.some((item) => queueStore.isSending(item.id)) || heldByOpenQueue || message.text.trim().length === 0}
                title={heldByOpenQueue ? t("Codex has a question open in the terminal: answer it above first") : undefined}
                onClick={() => {
                  if (sendingRef.current || !queueStore.beginSend(queueOwner, message.id)) return;
                  sendingRef.current = true;
                  const owner = queueOwner;
                  setQueueSending(message.id); setQueueError(null); heldRowNotes.delete(owner);
                  void Promise.resolve(sendComposerText(message.text))
                    .then((result) => {
                      if (result === true) { queueStore.remove(owner, message.id); }
                      else setQueueError({ owner, id: message.id, text: typeof result === "string" ? result : t("Not sent. Reconnect and try again.") });
                    })
                    .catch(() => setQueueError({ owner, id: message.id, text: t("Not confirmed. Check the terminal before sending again.") }))
                    .finally(() => { queueStore.endSend(owner, message.id); sendingRef.current = false; setQueueSending(null); });
                }}>{t("Send now")}</button>
              <button type="button" className="composer-queue-discard" disabled={queueStore.isSending(message.id)}
                onClick={() => { queueStore.remove(queueOwner, message.id); }}>
                <span className="composer-queue-discard-text">{t("Discard")}</span><X aria-hidden="true" />
              </button>
            </div>
            {queueError?.owner === queueOwner && queueError.id === message.id && <p className="composer-queue-error" role="status">{queueError.text}</p>}
          </li>)}
          </ol>
        </section>
      )}
      {presented && paneId !== null && chatMounted && !viewOnly && queueOwner !== null && pending.length > 0 && <PendingMessages
        key={`pending-${queueOwner}`}
        active={active}
        inert={peek !== null}
        messages={pending.map((message) => !message.serverOwned || pendingMessages.isOwned(queueOwner, message.id, pendingScopeRef.current)
          ? message : { ...message, serverOwned: false, state: "uncertain" as const })}
        connected={connected}
        agent={agent}
        blocked={held || secretActive || ended || heldByOpenQueue || answering !== null}
        unsaved={pendingMessages.isUnsaved(queueOwner)}
        isBusy={(id) => pendingMessages.isBusy(queueOwner, id)}
        onSendNow={(id) => actOnPending(id, "steer")}
        onEdit={(id) => actOnPending(id, "edit")}
        onDiscard={(id, displayOnly) => actOnPending(id, displayOnly ? "dismiss" : "discard")}
      />}
      {presented && paneId !== null && chatMounted && <div className="prompt-dock" ref={setPromptDock} aria-live="polite" inert={peek !== null || undefined} />}
      {presented && paneId !== null && chatMounted && !secretActive && !observing && !ended && (
        <Composer
          key={paneId}
          paneId={paneId}
          inert={peek !== null}
          cwd={cwd}
          branch={branchWord === DETACHED ? t("Detached HEAD") : branchWord}
          worktreeRepo={worktreeRepo}
          autoFocus={active && !autoSelected && !coarse}
          active={active}
          agent={agent}
          agentStatus={agentStatus}
          backgroundTasks={backgroundTasks}
          plan={plan}
          backgroundWait={backgroundWait}
          metadata={chatMetadata?.pane === paneId ? chatMetadata.value : null}
          connected={connected && !held}
          connectedBefore={connectedBefore}
          answerHint={viewOnly ? t("View only") : answering === null ? null
            : pendingAnswer?.promptId === answering.id ? t("Confirm your answer in the card above, or type another…") : answerHint(answering)}
          suggestion={chatPrompt?.pane !== paneId && chatSuggestion?.pane === paneId ? chatSuggestion.value : null}
          restored={chatPrompt?.pane !== paneId && chatRestored?.pane === paneId ? chatRestored.value : null}
          notices={composerNotices}
          // a device that only watches: the composer locks what writes from this role alone, in its own
          // render. Its lists (background tasks, side conversations) only read, so their rows stay usable
          role={viewOnly ? "observe" : role}
          onOpenHistory={historyOffered ? onOpenHistory : undefined}
          greeting={greetingDue ? (
            <div className={`composer-greeting${greeted ? "" : " is-out"}`} ref={greetingRef} aria-hidden={greeted ? undefined : true}>
              <p className="composer-greeting-title">{t("What should {agent} do in {folder}?", { agent: agentDisplayLabel(agent), folder })}</p>
              <p className="composer-greeting-where">{machineName && <bdi>{machineName}</bdi>}{machineName && cwd ? " · " : ""}{cwd && <bdi>{cwd}</bdi>}</p>
            </div>
          ) : null}
          waitingAnswer={waitingAnswer}
          onSend={composerSend}
          onClaim={onSendClaim}
          onAbort={abortTurn}
          onUploadImage={uploadImage}
        />
      )}
      {/* In the terminal lens the input line and the masked input float over the grid's last rows
          from a slot that keeps one row's height in flow: a line that grows while it is typed, a
          note under it or the masked input taking its place would otherwise take rows from the
          grid, and each change of its height resizes the shared pty. The masked input sits in this
          slot in the chat lens too (a box-less slot there, TerminalInput.css), so switching lenses
          keeps it mounted: a remount would drop what was typed and a send still on its way */}
      {((!chatView && lineSlot) || secretInput) && <div ref={setInputSlot} className={`terminal-input-slot${!chatView && lineSlot ? "" : " is-empty"}${lineLast && lineAtScreenBottom ? " is-at-screen-bottom" : ""}`}>
        {secretInput ?? (!chatView && lineSlot && !secretActive && <TerminalInput key={paneId} ref={lineRef} active={active} owner={paneStorageId(machineId, paneId)} onComposing={setLineComposing} connected={connected && !held} onSend={sendTerminalLine} onEnter={pressEnter} onInsert={insertTerminalText} pasteTarget={pasteTarget} onPasting={setLinePasting} uploadFile={uploadImage} attach={settings.terminalAttachButton} onFocus={reassertGrid} keyboardHeld={keyboardHeld}
          {...(foldKeys ? { keyControls: <LineKeysButton open={keysOpen} onToggle={() => setKeysOpen((open) => !open)} /> } : {})} />)}
      </div>}
      {presented && paneId !== null && !secretActive && !observing && !chatView && (!foldKeys || keysOpen) && <KeyBar disabled={composing || !connected || !inputReady || held || ended || viewOnly} onKey={pressKey}
        holdScope={`${paneStorageId(machineId, paneId)}:${view}`}
        onKeyHoldEnd={consumeModifiers}
        modifiers={modifiers} lockedModifiers={lockedModifiers} onToggleModifier={toggleModifier} items={settings.keyBarItems}
        expanded={settings.keyBarExpanded} onToggleExpanded={() => updateSettings({ keyBarExpanded: !settings.keyBarExpanded })}
        {...(coarse ? { directTyping, onToggleDirect: toggleDirect, directDisabled: lineComposing || viewOnly, onPaste: pasteIntoLine, pasteDisabled: linePasting || viewOnly,
          note: pasteGuidance ? t("Tap Input line to paste.") : null, onNoteDismiss: dismissPasteGuidance,
          onToggleKeyboard: toggleKeyboard, keyboardOwner, keyboardDisabled: !connected || !inputReady || held || ended || viewOnly, keyboardRefused: composing || lineComposing || linePasting } : {})}
        {...(coarse && directTyping && settings.terminalAttachButton ? { onAttach: attachTarget } : {})} />}
    </div>
  );
}
