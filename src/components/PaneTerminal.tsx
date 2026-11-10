import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { fontSettled } from "../lib/fontFamily.ts";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ArrowLeft, ArrowUp, ChevronRight, ClipboardCheck, Clock, Eye, Quote, SendHorizontal, SquareTerminal, Trash2, TriangleAlert, Unplug, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import "./PaneTerminal.css";

import { HerdrSocket } from "../lib/ws.ts";
import { MachineSession } from "../lib/machineSession.ts";
import { useMachineSessions } from "../lib/machineSessionContext.tsx";
import { ViewportIntentGate } from "../lib/viewportIntent.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";
import { pageAddress, reloadOnPlainClick } from "../lib/pageQuery.ts";
import { PaneCachedContext, PaneWatchedContext, PanePresentedContext, PaneFollowContext, PaneShownContext, PaneSubmitContext } from "../lib/paneSubmitContext.ts";
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
import { outcomeCommand } from "../lib/outcomeChip.ts";
import { composerLift, greetingMemory, greetingFits, greetingFolder, roomOverComposer, showsGreeting } from "../lib/greeting.ts";
import { DETACHED, usePaneBranch } from "../lib/paneBranch.ts";
import { answerHint } from "../lib/promptAnswer.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { appendQuote, formatTerminalQuote } from "../lib/terminalQuote.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { fetchBridgeHealth } from "../lib/api.ts";
import { useSessionHistoryOffered } from "../lib/useSessionHistoryOffered.ts";
import { paneStorageId } from "../../shared/machines.ts";
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
import type { AgentStatus, ClientRole, PlanSummary, ServerMessage } from "../../shared/protocol.ts";
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
  /** App's content lifetime, including the current finish identity. */
  presentationKey?: string;
  finishEpoch?: string;
  finishId?: number;
  /** The pane this terminal attaches to; null renders the placeholder. */
  paneId: string | null;
  /** A restored pane keeps its ID but gets a new terminal after herdr restarts. */
  terminalId?: string | null;
  /** null while the PC identity loads, before the first attach's fixed-grid frame arrives. */
  mirrored?: boolean | null;
  /**
   * herdr's reason it could not restore the selected pane (0.9.3+): the pane has no
   * terminal to attach, so App passes a null paneId and the placeholder says why.
   */
  restoreError?: string | null;
  /** the pane's own name (App's header shows it): the region around the grid announces it */
  title?: string | null;
  /** the pane's agent name — the chat lens labels the assistant's voice with it */
  agent?: string | null;
  /** the pane's live agent status: `working` turns composer sends into the queue */
  agentStatus?: AgentStatus;
  /** the pane's session as the roster names it (api.ts paneSessionKey): the chat reads again when it changes */
  agentSession?: string | null;
  /** an OmO pane's running background tasks: the composer's status line offers their list */
  backgroundTasks?: number;
  /** the plan the pane's agent keeps (null on an offline PC): the composer's chip opens it */
  plan?: PlanSummary | null;
  /** the pane's turn ended on work still running in the background: the composer says BG */
  backgroundWait?: boolean;
  /** the pane's working directory and its PC's name: an empty chat's greeting names them */
  cwd?: string | null;
  /** the pane's workspace: its checkout's branch stands beside the folder under the composer */
  workspaceId?: string | null;
  /** the workspace's displayed label for the prompt card's accessible context */
  workspaceLabel?: string | null;
  /** that workspace is a linked worktree of this repository (its name, as herdr gives it); null: it is not one */
  worktreeRepo?: string | null;
  machineName?: string;
  /** the lens over the pane: the chat transcript, or the live xterm grid (App remembers it per pane) */
  view: PaneView;
  /** switches this pane to its terminal lens, and saves it (Keep Terminal) */
  onOpenTerminal?: () => void;
  /** the terminal command's peek this pane shows (lib/terminalPeek.ts): its terminal over its chat */
  peek?: TerminalPeek | null;
  /** opens a peek over this pane's chat; none: this pane cannot show one (not the selected pane, no terminal) */
  onPeek?: (request: PeekRequest) => void;
  /** ends the peek named (the chat comes back); a peek replaced since is left alone */
  onEndPeek?: (peek: TerminalPeek) => void;
  /** opens the folder's earlier sessions for the pane's agent (App's SessionHistory): the composer's /resume */
  onOpenHistory?: () => void;
  /** opens the New tab dialog on the pane's workspace (App's NewSessionDialog): the composer's new-agent button */
  findRequest?: number;
  /** bumped to open Search conversation over the pane's chat (ChatView searchRequest) */
  searchRequest?: number;
  controls?: { current: PaneControls | null };
  /** Only the selected tile may take keyboard focus after async work or a lens change. */
  active?: boolean;
  /** App selected this pane itself (the selected one closed): switching to it must not take the keyboard */
  autoSelected?: boolean;
  /** xterm font size (settings) */
  terminalFontSize: number;
  /** one of several panes drawn side by side: under 80 columns its font shrinks to reach them */
  split?: boolean;
  /** mouse reports sent per wheel event (settings): 1 is xterm's own one report */
  terminalWheelSpeed: number;
  /** fonts tried before the built-in stack (settings); "" keeps the built-in one */
  terminalFontFamily: string;
  /** the drawn theme's terminal colours (lib/themes.ts): xterm reads no CSS, so its theme object is given them */
  colors: TerminalColors;
  /** The connection's desired role; changes are sent to the server, acks come back via onRoleAck. */
  role?: ClientRole;
  /** Fires with the server-confirmed role (the header toggle shows it). */
  onRoleAck?: (mode: ClientRole) => void;
  /** Fires on every change of the socket's connected state (the header shows it). `connectedBefore`: the
   *  socket has been connected on this page before, so a connection it waits for is a reconnect, not the first. */
  onConnectionChange?: (connected: boolean, connectedBefore: boolean) => void;
  /** Every server frame also reaches App: it merges pane-status and schedules refetches. */
  onServerMessage?: (message: ServerMessage) => void;
}


/** The last refused Send now note per pane, kept across that pane's mounts (see queueError). */
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
  // the split half following the other half's grid of the same tab sizes nothing either
  const follow = useContext(PaneFollowContext);
  const followRef = useRef(follow); followRef.current = follow;
  const sizesPty = (): boolean => presentedRef.current && shownRef.current && !followRef.current;
  const { answerPanePrompt, uploadPaneImage } = useMachineApi();
  const uploadFileRef = useRef(uploadPaneImage);
  uploadFileRef.current = uploadPaneImage;
  const attachFilesRef = useRef<(files: File[], still: () => boolean) => void>(() => {});
  // the peek is this pane's only (App passes it to the selected pane alone; this guards a pane switch's render)
  const peek = peekProp !== null && peekProp.paneId === paneId && peekProp.machineId === machineId ? peekProp : null;
  const peekRef = useRef(peek); peekRef.current = peek;
  // chatMounted: the chat, its composer, queue and prompt dock are there (the Chat lens, a peek
  // included). chatView: the chat covers the grid; everything that sizes, focuses or types into the
  // grid follows it, so a peek shows and drives the grid as the terminal lens does
  const { chatMounted, gridCovered: chatView } = paneLensFlags(view, peek);
  const chatMountedRef = useRef(chatMounted); chatMountedRef.current = chatMounted;
  const [findOpen, setFindOpen] = useState(false);
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const [searchState, setSearchState] = useState<TerminalSearchState | null>(null);
  const viewportIntent = useMemo(() => new ViewportIntentGate(), [machineId, paneId]);
  const viewportSearching = useSyncExternalStore(viewportIntent.subscribe, viewportIntent.isSearching, viewportIntent.isSearching);
  // A find bar left open under the Terminal lens is not the peek's: the peek opens without it, or it
  // would take the focus, the first Escape (the agent's) and a grid row. One opened in the peek stays.
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
  // what the grid's region announces: the pane's own name, or the grid's kind while none is open
  const terminalName = terminalLabel(paneId, title, t);
  /** read by the wheel handler, which is attached once for the terminal's life */
  const wheelStateRef = useRef({ speed: terminalWheelSpeed, omoQuestion: false });
  wheelStateRef.current = { speed: terminalWheelSpeed, omoQuestion: agent === "omo" && agentStatus === "blocked" };
  const hostRef = useRef<HTMLDivElement | null>(null);
  const pinchBadgeRef = useRef<HTMLSpanElement | null>(null);
  const pinchStatusRef = useRef<HTMLSpanElement | null>(null);
  /** the user's font size (settings, or a pinch in progress); a narrow split pane may draw smaller */
  const baseFontRef = useRef(terminalFontSize);
  // two fingers are pinching the font size (useTerminalMount.ts): a font arriving meanwhile keeps the live size
  const pinchingRef = useRef(false);
  // the terminal's first font is set (useTerminalRefits.ts): the first fit and the pty's size wait for it (usePaneAttach.ts)
  const [firstFont] = useState(fontSettled);
  const fontSettledRef = useRef(firstFont);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const pageScroll = useRef<((direction: -1 | 1) => void) | null>(null);
  const lineScroll = useRef<((lines: number) => void) | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** OSC 8 links this app cannot open are not drawn (#739); its state ends with `term.reset()` */
  const hyperlinksRef = useRef(hyperlinkFilter());
  /** Retires the output written before a pane switch or reconnect (see `retireOutput`). */
  const retireOutputRef = useRef<() => void>(() => {});
  const socketRef = useRef<HerdrSocket | null>(null);
  const paneRef = useRef<string | null>(paneId);
  const onConnectionChangeRef = useRef(onConnectionChange);
  const onServerMessageRef = useRef(onServerMessage);
  const onRoleAckRef = useRef(onRoleAck);
  const [connected, setConnected] = useState(false);
  /** the socket has been connected on this page before (connectedSockets): not connected, this terminal, its
   *  chat and the header say Reconnecting; before the first connection they say Connecting */
  const [connectedBefore, setConnectedBefore] = useState(false);
  // /resume opens the list only where this PC's bridge offers it, as the workspace row's menu does
  const historyOffered = useSessionHistoryOffered(connected && onOpenHistory !== undefined);
  const pendingScopeRef = useRef<string | null>(null);
  /** The PC session's epoch: a receipt belongs to the connection on which its request left. */
  const pendingEpochRef = useRef(0);
  const [outputReady, setOutputReady] = useState(false);
  const outputTarget = JSON.stringify([paneId, terminalId]);
  const outputTargetRef = useRef(outputTarget); outputTargetRef.current = outputTarget;
  const [parsedTarget, setParsedTarget] = useState<string>();
  const [ended, setEnded] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const [inputReady, setInputReady] = useState(false);
  const [outputError, setOutputError] = useState<string | null>(null);
  // a 4008 overload close stopped this PC's shared connection: cleared when it comes back
  const stalledRef = useRef(false);
  // the server answered terminal_unsupported (a bridge too old to mirror): the lens is a notice, the chat still works
  const [unsupported, setUnsupported] = useState(false);
  const unsupportedRef = useRef(unsupported); unsupportedRef.current = unsupported;
  // another web bridge has this pane's terminal: the server waits for it and says attach-resumed
  const [held, setHeldState] = useState(false);
  // what the socket handlers read mid-stream: stdin, onData and the composer's submit
  const heldRef = useRef(false);
  // drops what is left of a touch swipe (its queued wheel reports and its unsent travel): every new
  // touch, key, disconnect, pane, role or attach change starts a new input generation
  const cancelTouchRef = useRef<() => void>(() => undefined);
  const setHeld = useCallback((next: boolean) => { cancelTouchRef.current(); heldRef.current = next; setHeldState(next); }, []);
  // The ref is what input handlers read; the state is what the key bar shows.
  const composingRef = useRef(false);
  const [composing, setComposingState] = useState(false);
  const setComposing = useCallback((active: boolean) => { composingRef.current = active; setComposingState(active); }, []);
  // a composition in the input line keeps the key bar live but blocks the switch to direct typing:
  // unmounting the line mid-composition could drop the word or replay it into the pane
  const lineComposingRef = useRef(false);
  const [lineComposing, setLineComposingState] = useState(false);
  const setLineComposing = useCallback((active: boolean) => { lineComposingRef.current = active; setLineComposingState(active); }, []);
  // the input line, for the key bar's Paste; and whether a paste of its still waits on the clipboard
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
  /** set while the composer's Stop types its ESC, so it goes out as a Stop (ClientMessage `input.stop`) */
  const stopKeyRef = useRef(false);
  // the key bar's modifiers (lib/keys.ts ModifierLatch): held is what the next key carries, locked
  // what stays after it; the refs are what onData and the key handlers read mid-stream
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
  // a key that carried the held modifiers lets go of those held for it alone
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
  // observe mode: the ref is what onData and the resize listeners read mid-stream
  const observeRef = useRef(false);
  // a mirrored pane (no terminal attach on its PC): the grid is the pane's own in herdr, adopted like an observer's
  const fixedGridRef = useRef(false);
  const mirroredRef = useRef(mirrored); mirroredRef.current = mirrored;
  // the pty's grid as the server last said it for this pane (pane-geometry), whoever set it
  const sharedGridRef = useRef<{ cols: number; rows: number } | null>(null);
  // takes the pty back to this grid when another device left it at its own (the effect below sets it)
  const reassertIfStaleRef = useRef<() => void>(() => undefined);
  // draws the grid again as adopted or not (data-adopted-grid), keeping the cursor's row in sight
  const followCursorRef = useRef<() => void>(() => undefined);
  // out of use, the tab let go of its pane (no attach) so herdr's own TUI has it back; it attaches
  // again when the user is back. The ref is what the socket handlers and the pane switch read
  const releasedRef = useRef(false);
  const [released, setReleasedState] = useState(false);
  const setReleased = useCallback((next: boolean) => { cancelTouchRef.current(); releasedRef.current = next; setReleasedState(next); }, []);
  // released, the tab still shows the pane read-only (the server's "watch", herdr's observer), which
  // leaves the pane at the size herdr's own window gives it; false on a server without it: paused
  const watchingRef = useRef(false);
  const [watching, setWatchingState] = useState(false);
  const setWatching = useCallback((next: boolean) => { watchingRef.current = next; setWatchingState(next); }, []);
  // a view a hidden page holds for its return reads as watching on the banner only, never on the wire
  const setViewHeld = useCallback((held: boolean) => setWatchingState(held || watchingRef.current), []);
  // the mount effect's initial-attach decision, also used for a replacement pane
  const deferAttachRef = useRef<(pane: string) => boolean>(() => false);
  // the mount effect's release, for the queue below: a tab that kept its pane for a message lets go once it went
  const releaseRef = useRef<() => void>(() => {});
  const presentationRef = useRef<() => void>(() => {});
  // A cache release resumes from the existing screen, not the observer's replacement screen.
  const cachedReleaseRef = useRef(false);
  // the mount effect's leave, for the pane switch: a tab out of use from the start (a reload behind
  // another app) or moving on to the next pane there lets go of it too
  const leaveRef = useRef<() => void>(() => {});
  const typeAheadRef = useRef<(pane: string) => void>(() => {});
  const cancelLeaveRef = useRef<() => void>(() => {});
  // the mount effect's in-place re-attach after the output stopped, for the banner's Reconnect
  const reattachRef = useRef<() => void>(() => {});
  // the mount effect's keyboard hold, for the fits outside it: before a fit, whether the soft keyboard
  // holds the grid (the fit then waits for the keyboard to go; `force` says it was to re-assert the
  // grid), and after one, that the grid is the host's again
  const keyboardHoldsRef = useRef<(force: boolean) => boolean>(() => false);
  const fittedRef = useRef<() => void>(() => {});
  const pendingSubmissionsRef = useRef(new Set<{ pane: string; socket: HerdrSocket; epoch: number }>());
  const endedRef = useRef(false);
  // the modifyOtherKeys level the pane's program asked for, as this pane's stream last said it
  const modifyOtherKeysRef = useRef(0);
  const [observing, setObserving] = useState(role === "observe");
  const [authWatching, setAuthWatching] = useState(() => role === "observe" || isDemoWatch());
  useEffect(() => {
    if (role === "observe" || isDemoWatch()) { setAuthWatching(true); return; }
    let live = true;
    fetchBridgeHealth().then((health) => {
      if (live && health?.auth?.role === "watch") setAuthWatching(true);
    }, () => {});
    return () => { live = false; };
  }, [role]);
  const viewOnly = observing || role === "observe" || authWatching;
  const [secret, setSecret] = useState<{ pane: string; prompt: string } | null>(null);
  const secretRef = useRef<string | null>(null);
  const secretActive = secret !== null && secret.pane === paneId;
  // a touch screen writes in the terminal's input line; typing straight into the grid is chosen
  const coarse = useMediaQuery("(pointer: coarse)");
  // A touch screen reads a pane before it answers: picking a pane or a lens there never raises the
  // keyboard by itself, only a tap on the message box or the grid does. A desktop has no keyboard
  // to raise, and the pane it picks takes the typing at once.
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
  // what the terminal effect says in a banner, in the language chosen since it was set up
  const tRef = useRef(t);
  tRef.current = t;
  /** read by the OSC 52 handler, which is attached once for the terminal's life */
  const osc52AllowedRef = useRef(settings.paneClipboard);
  osc52AllowedRef.current = settings.paneClipboard;
  const codexDragRef = useRef(settings.codexDrag);
  codexDragRef.current = settings.codexDrag;
  // Pictures in the terminal not chosen on this device: on where the server passes pictures (herdr-core)
  const [terminalHistory, setTerminalHistory] = useState(false);
  useTerminalImages(terminal, settings.terminalImages ?? terminalHistory, coarse);
  const picturesChoiceRef = useRef(settings.terminalImages);
  picturesChoiceRef.current = settings.terminalImages;
  // a wide mirror folds on a narrow screen until the pane menu's Wrap to screen / Original width says otherwise
  const narrowScreen = useMediaQuery(MIRROR_WRAP_QUERY);
  const mirrorWrap = settings.terminalMirrorWrap ?? narrowScreen;
  const mirrorWrapRef = useRef(mirrorWrap);
  mirrorWrapRef.current = mirrorWrap;
  useEffect(() => { followCursorRef.current(); }, [mirrorWrap]);
  // Settings → Use alongside herdr's own window: off (the default), a tab out of use keeps its pane and its size
  const releaseAwayRef = useRef(settings.releasePaneAway);
  releaseAwayRef.current = settings.releasePaneAway;
  const narrowFont = false;
  const narrowFontRef = useRef(narrowFont);
  narrowFontRef.current = narrowFont;
  const narrowFontFitted = useRef(narrowFont);
  // Settings → Chat width, Default: the lane follows this pane, on the stack its columns share
  usePaneLane(stackRef);
  // every device starts typing straight into the grid; the input line is a choice (key bar or Settings)
  const directTyping = settings.terminalInputMode !== "line";
  const inputLine = !directTyping && !chatView;
  const inputLineRef = useRef(inputLine);
  inputLineRef.current = inputLine;
  // the same setting lets go of a pane in use after a quiet spell (#712), where typing goes straight into the grid:
  // a key there takes it back, and the input line's sends would find no attach
  const idleReleaseRef = useRef(settings.releasePaneAway && directTyping);
  idleReleaseRef.current = settings.releasePaneAway && directTyping;
  const [idleView, setIdleView] = useState(false);
  // input typed while disconnected, held for the user to review and send
  const [draftState, setDraftState] = useState<{ owner: string | null; value: InputDraft }>({ owner: null, value: EMPTY_DRAFT });
  const draft = draftState.value;
  // a drop the connection is back from within the grace is not said (lib/reconnectGrace.ts); held input,
  // a key, a press or typed text (dictation, an IME) anywhere in the window meanwhile (the active pane's),
  // stopped output, or a pane another app held say it at once: the drop clears that warning (useTerminalMount),
  // and the pane must not look ready to type in while nothing it is sent can reach it
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
  const onEndPeekRef = useRef(onEndPeek); onEndPeekRef.current = onEndPeek;
  // The outcome ids this pane's chat last read (its prompt poll). A send notes them as it leaves, so
  // its own outcome is the newest unread one with its text, whenever a later poll lists it
  // (lib/terminalPeek.ts sentOutcome); a poll landing between the send and its receipt cannot hide it.
  const knownOutcomesRef = useRef<{ pane: string; ids: readonly string[] } | null>(null);
  const onChatOutcomes = useCallback((pane: string, ids: readonly string[]) => { knownOutcomesRef.current = { pane, ids }; }, []);
  const knownOutcomes = (pane: string | null): readonly string[] | null => pane !== null && knownOutcomesRef.current?.pane === pane ? knownOutcomesRef.current.ids : null;
  // Only the explicit send's own receipt may open a peek. A pending snapshot/removal never
  // does, and a receipt arriving after navigation cannot pull the reader back to its old pane.
  // read at the receipt, not at the send: a catalog that arrives in between still counts
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  // and the list the message box read, when this terminal's own read of it has not answered yet (#1591)
  const machineIdRef = useRef(machineId); machineIdRef.current = machineId;
  const agentRef = useRef(agent); agentRef.current = agent;
  // The frames of the pane's stream (lib/inputRow.ts FrameGate): the agent's input row is read only
  // off a whole frame drawn for this grid, never mid-frame or between a resize and the redraw for it
  const frameGateRef = useRef(new FrameGate());
  /** What the screen shows of the agent's input row now (lib/inputRow.ts); null: no recognizer for the agent. */
  const inputRowNow = useCallback((): InputRowState | null => {
    const term = termRef.current;
    const current = agentRef.current;
    if (term === null || !readsInputRow(current)) return null;
    if (!frameGateRef.current.current) return "unknown";
    return inputRowState(current, readScreen(term.buffer.active, term.cols, term.rows));
  }, []);
  /** Claude's own screen says it can take a message now, whatever herdr reports (lib/compose.ts). */
  const inputAtRest = useCallback((): boolean => {
    const term = termRef.current;
    if (term === null || agentRef.current !== "claude") return false;
    const lines = readScreenLines(term.buffer.active, term.rows);
    return lines !== null && claudeMainAtRest(inputRowNow(), lines);
  }, [inputRowNow]);
  // The row as the send's receipt came, before the peek's own resize: the watch starts from it, since
  // the first frame for a new grid may be herdr's reflow of the old screen (FrameGate reflowing)
  const receiptRowRef = useRef<{ pane: string; text: string; state: InputRowState } | null>(null);
  // `seen`: the agent's empty input row was on screen as the text left (read before it was typed)
  const showSentCommand = useCallback((pane: string, text: string, known: readonly string[] | null, seen: boolean) => {
    const command = typedTerminalCommand(paneCommandsNow(pane, machineIdRef.current, agentRef.current) ?? commandsRef.current, text);
    const open = onPeekRef.current;
    if (command === null || open === undefined || paneRef.current !== pane || !activeRef.current || !presentedRef.current || !shownRef.current
      || !chatMountedRef.current || observeRef.current || heldRef.current || endedRef.current || unsupportedRef.current) return;
    // a phone's keyboard goes down with the message box it served; the grid fits once it has gone
    if (coarseRef.current) stackRef.current?.querySelector<HTMLTextAreaElement>(".composer-text")?.blur();
    // Claude's record of a closed panel, or (for the agents whose input row is known) its screen:
    // the screen only once its recognizer has read this pane's empty row
    const recorded = known !== null && autoReturnArmed(agentRef.current, text, command.name);
    const watch = seen && agentRef.current !== null && screenReturnArmed(agentRef.current, text, command.name) ? agentRef.current : null;
    const atReceipt = watch === null || frameGateRef.current.reflowing ? null : inputRowNow();
    receiptRowRef.current = atReceipt === null ? null : { pane, text, state: atReceipt };
    open({ command: `${command.trigger ?? "/"}${command.name}`, text, knownOutcomeIds: known, auto: recorded || watch !== null, watch, inputRowSeen: seen });
  }, []);
  // A chat row's or chip's Open Terminal: a peek the reader ends by hand. Without one (another
  // pane's tile, a PC with no terminal) the terminal lens opens, as it did before.
  const peekOutcome = useCallback((text: string) => {
    const open = onPeekRef.current;
    if (open === undefined || heldRef.current || unsupportedRef.current) { onOpenTerminal?.(); return; }
    open({ command: outcomeCommand(text), text: null, knownOutcomeIds: null, auto: false, watch: null, inputRowSeen: inputRowNow() === "ready" });
  }, [onOpenTerminal, inputRowNow]);
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
  // whose word a keyboard-control tap leaves (lib/keyboardControl.ts): this component and the pane
  // it shows, so a tap in flight here never holds another pane's control
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
  // only while the control can be pressed: offline, held, ended or view only, it is gone or disabled,
  // and a line still taking a draft must raise the keyboard on a tap as it does with the setting off
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
    // read where the focus landed once it has: Show's own blur-and-refocus lands back on the field
    const onFocusOut = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const focused = document.activeElement;
        // the line or xterm's field only: the find bar's search is not where the request was made
        if (!(focused instanceof HTMLElement && stack?.contains(focused) === true && focused.matches(".terminal-input-text, .xterm-helper-textarea"))) setKeyboardRequested(false);
      }, 0);
    };
    // a tap into the line or the grid while the control cannot be pressed (offline, held) raised the
    // keyboard itself: it stands as the request, so the control coming back (a reconnect) takes nothing away
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
  // a tap still in flight when this pane stops being the selected, shown one (another pane picked,
  // its tab left, or unmounted) is abandoned: coming back, its control reads the measurement
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
  // transient OSC 52 feedback ("copied") — a pill in the banner column
  const [clipboardNote, setClipboardNote] = useState<string | null>(null);
  const clipboardTimerRef = useRef<number | null>(null);
  // the notices the user put away over the input card (lib/composerNotices.ts)
  const [dismissedNotices, setDismissedNotices] = useState<DismissedNotices>(NO_DISMISSALS);
  // the text of the last drag, offered to the chat draft while its highlight stays (herdr's rows when it gave them)
  const [selectionQuote, setSelectionQuote] = useState<{ pane: string; text: string; range: { start: number; end: number } | null } | null>(null);
  // Explicit sends refresh immediately; continuous transcript invalidations are rate-limited.
  const [chatRefresh, setChatRefresh] = useState(0);
  const [chatInvalidation, setChatInvalidation] = useState(0);
  const { autoPeek, onCommandScreenClosed, stillOpen, stillOpenRef, setStillOpen, pendingOpenRef, undecidedOpenRef, chatHistoryRef, stillOpenNotedRef, onInputRowFrameRef, stillOpenNote, showStillOpen } = usePeekReturn({ activeRef, agent, agentRef, agentStatus, chatMounted, coarseRef, compositionCommitPendingRef, composingRef, draftHeldForRef, ended, findOpenRef, frameGateRef, inputRowNow, lineComposingRef, onEndPeekRef, onOpenTerminal, onPeekRef, paneId, paneRef, peek, peekRef, presented, receiptRowRef, stackRef, termRef, terminalId, t, heldRef, unsupportedRef });
  const { conversationPushes, setConversationPushes, onConversationWatch, chatOutputRef, onTerminalOutput, chatSent, setChatSent, chatUnsent, setChatUnsent, chatMetadata, redrawGreeting, onChatRead, greetingRoom, setGreetingRoom, greetingRef, chatPrompt, promptRefresh, setPromptRefresh, chatSuggestion, chatRestored, pendingAnswer, setPendingAnswer, promptDock, setPromptDock, onPromptAnswered, clearPendingAnswer, onChatPrompt, onChatMetadata, onChatSuggestion, onChatRestored } = useChatCallbacks({ activeRef, agentStatus, chatHistoryRef, chatViewRef, findOpenRef, machineId, pendingOpenRef, setStillOpen, socketRef, stackRef, stillOpenRef, undecidedOpenRef });
  // This browser's own message from the box that the bridge took at once (ok, nothing pending), with
  // the chat's navigation generation from when it went out: the chat follows it to the end unless
  // the reader scrolled, paged or jumped since (ChatView `localSend`). A refusal, an uncertain or
  // pending answer, a queued or Send now delivery and another browser's message never advance it.
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

  // what opens outside the pane (a diff's line notes) reads whether this window only watches it
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

  useTerminalMount({ setTerminalHistory, picturesChoiceRef, typeAheadRef, activeRef, agentRef, barKeyRef, baseFontRef, pinchingRef, cachedRef, watchedRef, cachedReleaseRef, cancelLeaveRef, cancelTouchRef, chatMountedRef, chatOutputRef, chatViewRef, clearModifiers, clipboardTimerRef, coarseRef, commitPendingText, composingRef, compositionCommitPendingRef, consumeModifiers, deferAttachRef, draftHeldForRef, draftPaneRef, endedRef, findOpenRef, fitRef, fittedRef, fixedGridRef, followCursorRef, followRef, frameGateRef, heldRef, hostRef, hyperlinksRef, keyboardHoldsRef, keyboardToggleFocusRef, leaveRef, lineScroll, machineId, machineSessions, mirroredRef, mirrorWrapRef, modifiersRef, modifyOtherKeysRef, narrowFontRef, noteClipboard, observeRef, onChatSuggestion, onInputRowFrameRef, onRoleAckRef, onServerMessageRef, openFileRef, openWebRef, reuseExternalLinkTabRef, osc52AllowedRef, codexDragRef, outputTargetRef, colors, paneRef, pendingEpochRef, pendingScopeRef, pendingSubmissionsRef, pinchBadgeRef, pinchStatusRef, presentationRef, presentedRef, reassertIfStaleRef, reattachRef, redrawGreeting, releaseAwayRef, idleReleaseRef, setIdleView, releaseRef, releasedRef, retireOutputRef, secretRef, sessionRef, setChatInvalidation, setChatRefresh, setChatSent, setComposing, setConnected, setConnectedBefore, setConversationPushes, setDraft, setEnded, setHeld, setInputError, setInputReady, setObserving, setOutputError, setOutputReady, setParsedTarget, setReleased, setSecret, setSelectionQuote, setTerminal, setUnsupported, setViewHeld, setWatching, sharedGridRef, shortcutSettings, shownRef, sizesPty, socketRef, stackRef, stalledRef, stopKeyRef, submitRetention, t, tRef, termRef, terminalFontSize, updateSettings, uploadFileRef, attachFilesRef, watchingRef, wheelStateRef });

  useTerminalRefits({ activeRef, autoSelected, baseFontRef, pinchingRef, fontSettledRef, chatView, chatViewRef, coarseRef, findOpenRef, fitRef, fittedRef, fixedGridRef, follow, followCursorRef, keyboardHoldsRef, narrowFont, narrowFontFitted, observeRef, colors, paneRef, peekRef, sharedGridRef, shown, sizesPty, socketRef, termRef, terminalFontFamily, terminalFontSize });

  usePaneAttach({ typeAheadRef, activeRef, autoSelected, cached, watched, coarseRef, deferAttachRef, fontSettledRef, draftPaneRef, findOpenRef, fitRef, fittedRef, fixedGridRef, frameGateRef, hyperlinksRef, hostRef, machineId, mirrored, modifyOtherKeysRef, observeRef, paneId, pending, presented, presentationRef, releaseRef, releasedRef, retireOutputRef, secretRef, setDraft, setComposing, setEnded, setHeld, setInputError, setInputReady, setOutputError, setOutputReady, setReleased, setSecret, setUnsupported, setWatching, sharedGridRef, socketRef, stalledRef, terminalId, termRef, chatViewRef, cancelLeaveRef, cachedRef, watchingRef, keyboardHoldsRef, followRef, followCursorRef, leaveRef, shownRef });


  // A sibling already mounted in the split canvas becomes the keyboard target only on an
  // explicit navigation. Clicking inside it leaves focus on the actual clicked control.
  useEffect(() => {
    // keys typed ahead for a new tab hold the keyboard until its hand-over gives it to the terminal (lib/typeAhead.ts)
    if (active && !autoSelected && !chatViewRef.current && !coarseRef.current && !modalOpen() && !findOpenRef.current && !typeAheadFocused()) termRef.current?.focus();
  }, [active, autoSelected]);

  // the user picked the pane App had switched to on its own (the same row or lens again,
  // which changes neither the pane nor the lens): the grid takes the keyboard now
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

  const { pressKey, toggleModifier, abortTurn } = useTypedKeys({ agent, agentStatus, barKeyRef, coarseRef, commitPendingText, compositionCommitPendingRef, composingRef, inputLineRef, modifiersRef, lockedRef, setLatch, consumeModifiers, paneId, reassertIfStaleRef, setInputError, socketRef, stopKeyRef, tRef, termRef });

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
  // the line back, or another pane: the word has nothing left to say
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
    // this pane's field alone: a sibling pane's keyboard is its own, and the control itself, focused
    // from a hardware keyboard, holds no keyboard to put away
    const focused = document.activeElement;
    const hideTarget = focused instanceof HTMLElement && stack?.contains(focused) === true && focused.closest(".key-bar") === null ? focused : null;
    // the field of the current input mode: the input line, else xterm's own field for direct typing
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
      // Keyboard only from the key bar: this tap is the request, so the field may raise it now
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
    // the tap's own blur that leaves no field focused anywhere is the keyboard going, where the
    // measured state is blind (a zoomed page, a floating keyboard)
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
  // The held rows fold into their caption while a prompt card needs the room, or a phone's
  // window is short. They stay mounted; the caption is then the button that opens them
  const shortPhone = useMediaQuery(SHORT_PHONE_QUERY);
  const heldFold = heldRowsFold({ promptOpen: chatView && chatPrompt !== null && chatPrompt.pane === paneId, shortPhone, ready: readyForQueue });
  const heldListRef = useRef<HTMLOListElement | null>(null);
  const heldToggleRef = useRef<HTMLButtonElement | null>(null);
  const [heldOpened, setHeldOpened] = useState(false);
  // Each fold starts closed, and so does another pane's or a list that was empty, unless the
  // user is in one of this pane's rows right now: a phone's keyboard comes up for the message
  // being edited and must not fold it away. (During this render the DOM is still the last one.)
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
  // a row's error is for the user to read: it opens the rows too, and the caption is then no button.
  // Rows it opened are the user's own once focus is in one (the list's onFocus), whatever ends the error
  const heldRowFailed = heldRowError(queueError, queueOwner, queued.map((message) => message.id));
  const heldHidden = heldRowsHidden(heldFold, heldOpened, heldRowFailed);
  const heldToggle = heldToggleShown(heldFold, heldRowFailed);
  // The button goes when the fold ends (the agent is ready, the prompt was answered). Focus on it
  // would fall to the page, so it moves to the list the button stood for: Tab goes on from there.
  // The list, not a message box: on a phone that would raise the keyboard unasked.
  // React detaches the button's ref just before it removes the node, while focus is still on it:
  // that is read in the commit, never in a render React may discard.
  // The button names its list (aria-controls) and that is what is kept: a button that goes because
  // the user moved to another pane stood for another list, and this pane's is not focused for it.
  const heldRefocusRef = useRef<string | null>(null);
  const setHeldToggle = useCallback((node: HTMLButtonElement | null) => {
    if (node === null && heldToggleRef.current !== null && document.activeElement === heldToggleRef.current) heldRefocusRef.current = heldToggleRef.current.getAttribute("aria-controls");
    heldToggleRef.current = node;
  }, []);
  // every commit, so a flag set as the whole list went is dropped with it
  useLayoutEffect(() => {
    const left = heldRefocusRef.current;
    if (left === null) return;
    heldRefocusRef.current = null;
    if (heldRefocusDue(left, heldListRef.current?.id ?? null)) heldListRef.current?.focus({ preventScroll: true });
  });
  // an empty chat: one greeting line over the composer, which a mouse-driven window centres
  const folder = greetingFolder(cwd);
  // Sends pressed whose claim waits for the pane's cross-tab lock: each takes the greeting away from its press
  const [claims, setClaims] = useState(0);
  const onSendClaim = useCallback((delta: 1 | -1) => setClaims((current) => current + delta), []);
  const greetingDue = chatView && paneId !== null && agent !== null && !secretActive && !observing && !ended && claims === 0
    && showsGreeting({ memory: greetingMemory(paneStorageId(machineId, paneId)), agentStatus, queued: queued.length + pending.length, folder });
  // a stack too short for the composer and the greeting keeps the chat's own empty line
  const greeted = greetingDue && greetingRoom;
  // a message on its way, before its answer and its bubble, or held as a pending row (which has no
  // bubble): the chat's own empty line does not stand in for the greeting the send took away
  const sending = claims > 0 || pending.length > 0 || (paneId !== null && greetingMemory(paneStorageId(machineId, paneId)).pending > 0);
  // Only the composer moves (Composer.css): the surface under it keeps its box, so the xterm
  // mount is never resized by a greeting coming or going. Measured before paint, so the composer
  // is never seen docked first. The greeting stays mounted while it does not fit, so that it is
  // measured when the stack grows again.
  useLayoutEffect(() => {
    const stack = stackRef.current;
    const greeting = greetingRef.current;
    const composer = greeting?.parentElement;
    if (!greetingDue || !stack || !greeting || !composer) return;
    const place = (): void => {
      const lift = composerLift(stack.clientHeight, composer.offsetHeight, greeting.offsetHeight);
      const card = composer.querySelector(".composer-surface");
      // a difference of two boxes of the same composer: the lift moves both
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

  // Under the chat lens, while the input card shows, the pills the terminal lens floats top-right
  // (another app holds the pane, the output stream failed, input held for the terminal, a copy
  // note) stand over the card instead, as rows of the composer's with a dismiss each. Without the
  // card (view only, ended, a secret prompt) they stay pills. The ids carry the pane, so another
  // pane's dismissals never carry over; a dismissal goes with its notice, or when the notice says
  // something else (lib/composerNotices.ts)
  const noticesDocked = presented && paneId !== null && chatView && !secretActive && !observing && !ended;
  const noticeItems: ComposerNoticeRow[] = [];
  if (paneId !== null) {
    const owner = paneStorageId(machineId, paneId);
    const takeOver = !observing && socketRef.current?.canTakeOver() === true;
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
      // on screen the row is its parts, the held text and its two controls, as the terminal lens's
      // held-input row; the words are for the live region
      text: <>
        <span className="visually-hidden">{t("Input held:")}</span>
        {draft.text.length > 0 && <code title={draft.text}>{draft.text}</code>}
        {draft.truncated && <> {t("Some input was too long to hold and was left out.")}</>}
      </>,
      actions: <>
        {/* the composer's send glyph (an up arrow) on the row's plain icon button, beside its Discard */}
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
      // put away, the still-open notice no longer holds a send: the reader has seen the terminal's state
      if (notice.id.endsWith(":still-open")) { setStillOpen(null); return; }
      setDismissedNotices((dismissed) => dismissNotice(dismissed, notice));
    }} />
    : null;

  // a message delivered from Chat names a tab whose pane has no transcript to say which came first (lib/tabLabels.ts);
  // one held, queued or answering a question does not
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
    key={`${paneId}:${secret.prompt}`} prompt={secret.prompt} active={active} unchecked={socketRef.current?.typesSecret(secret.prompt) === true}
    onSend={(value) => socketRef.current?.sendSecret(paneId, secret.prompt, value, () => secretRef.current === secret.prompt) ?? null}
    onCancel={() => { if (socketRef.current?.connected) { cancelTouchRef.current(); socketRef.current.sendInput(paneId, "\u0003"); } }}
  /> : null;
  // the input line's row, kept while the masked input stands in for it
  const lineSlot = presented && paneId !== null && !viewOnly && !ended && inputLine;
  // What floats from the slot may reach up to the grid's top and no further (TerminalInput.css):
  // in a short pane (a split, a phone in landscape with its keyboard up) a grown line or the masked
  // input would otherwise cover the find bar, or be clipped under the pane's frame
  const [inputSlot, setInputSlot] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const surface = stackRef.current?.querySelector(".terminal-surface");
    if (!stackRef.current || !surface || !inputSlot) return;
    const measure = () => {
      const slot = inputSlot.getBoundingClientRect();
      // the chat lens's box-less slot has no rect, and nothing floats there to cap
      if (slot.width === 0) return;
      const room = slot.bottom - surface.getBoundingClientRect().top;
      inputSlot.style.setProperty("--terminal-input-room", `${Math.max(0, Math.floor(room))}px`);
    };
    measure();
    // the surface moves with the find bar and resizes with the stack and the key bar under it
    const observer = new ResizeObserver(measure);
    observer.observe(stackRef.current);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [inputSlot]);
  // Settings > Terminal > Fold the key bar (#1531): in Input line mode on a touch screen the key bar is
  // folded until the line's Terminal keys button opens it. Folded,
  // the line is the pane's last row: where that is the screen's bottom it keeps clear of the home
  // indicator, as the key bar does there (KeyBar.tsx)
  const [keysOpen, setKeysOpen] = useState(false);
  const foldKeys = coarse && settings.terminalFoldKeyBar && lineSlot && !secretActive;
  const lineLast = foldKeys && !keysOpen;
  // the row opens for the time it is wanted: leaving the line (direct typing, the setting off) folds it
  // again. And a folded row shows no modifier, so it holds none: the next Enter is a plain one
  useLayoutEffect(() => {
    if (!foldKeys) setKeysOpen(false);
    else if (!keysOpen) clearModifiers();
  }, [foldKeys, keysOpen, clearModifiers]);
  const [lineAtScreenBottom, setLineAtScreenBottom] = useState(false);
  useLayoutEffect(() => {
    if (!inputSlot || !lineLast) { setLineAtScreenBottom(false); return; }
    const place = (): void => setLineAtScreenBottom(inputSlot.getBoundingClientRect().bottom >= window.innerHeight - 1);
    place();
    // the pane's own frame and what holds it change size on a split or zoom with the page unchanged
    const observer = new ResizeObserver(place);
    for (let node: HTMLElement | null = inputSlot.parentElement; node; node = node.parentElement) observer.observe(node);
    window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); };
  }, [inputSlot, lineLast]);

  // the wait for input is a live region in the banner column from the stack's first render, clipped while
  // empty (never display: none); its words land a frame after it (lib/useAnnouncedText.ts). Only a
  // selected pane waits: with none there is no terminal whose input could become ready
  const waitingWords = useAnnouncedText(paneId !== null && !chatView && !observing && connected && !inputReady && !held && !ended && !released ? t("Waiting for terminal input…") : null);

  return (
    // data-direct-typing: xterm's own field raises the soft keyboard here (lib/viewport.ts)
    // is-peek: a terminal command's peek shows the grid over the still-mounted chat (PaneTerminal.css)
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
        {/* the chat lens says these itself (ChatView), inline; the pills are the grid's */}
        {paneId !== null && !chatView && ended && !outputError && (
          <div className="terminal-banner" role="status">
            {t("Terminal ended")}
          </div>
        )}
        {paneId !== null && !chatView && !ended && !connectionShown && (
          <div className="terminal-banner terminal-banner-warning" role="status">
            {t(connectedBefore ? "Reconnecting to Ovis…" : "Connecting to Ovis…")}
            {/* one line, cut with an ellipsis: a command is never broken inside a word; the title holds it whole */}
            {draft.text.length > 0 && <span className="draft-held" title={draft.text}> {t("Input held:")} <code>“{draft.text}”</code></span>}
          </div>
        )}
        {/* the peek's head: no grid row of its own, no focus trap and no Escape of its own (Escape is the
            agent's). Keep Terminal saves the terminal lens, which ends the peek */}
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
            {/* on screen the row is its parts, the command and its two controls; the words are for the live region */}
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
            {/* said only when it applies, on a line under the row. The preview shows the start of the
                text: without this, a draft that lost its end looks whole */}
            {draft.truncated && <span className="draft-truncated">{t("Some input could not be held and was left out.")}</span>}
            {/* Enter is never held: without this, two commands look like one line and a paste looks whole */}
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
      {/* under a peek the composer's column stays, inert: the grid has the keyboard */}
      {presented && paneId !== null && chatMounted && !viewOnly && !ended && queueOwner !== null && queued.length > 0 && (
        <section className={`composer-queue${readyForQueue ? " is-ready" : ""}${heldHidden ? " is-folded" : ""}`} aria-label={t("Queued messages")} inert={peek !== null || undefined}>
          {(() => {
            // one caption line: the sentence says the state
            const caption = <>
              <span className="composer-queue-mark" aria-hidden="true"><Clock /></span>
              <span className="composer-queue-caption">
                {t(readyForQueue ? "Held message — review and send" : "Held until the agent is ready")}
                <> · {queued.length === 1 ? t("{n} message", { n: 1 }) : t("{n} messages", { n: queued.length })}</>
              </span>
            </>;
            return <div className="composer-queue-heading">
              {/* the count stays for assistive tech, beside the button and not in its name */}
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
                {/* a phone draws the X; the word stays the button's name */}
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
        onDiscard={(id) => actOnPending(id, "discard")}
      />}
      {/* The prompt card's place: under the held messages (which fold to their caption while it is
          open), directly over the input card, on the same column. ChatView renders the card into
          it. It is a live region of its own, since the card is no longer inside the transcript's
          log: a prompt that arrives is announced, as it was there. */}
      {presented && paneId !== null && chatMounted && <div className="prompt-dock" ref={setPromptDock} aria-live="polite" inert={peek !== null || undefined} />}
      {/* the composer belongs to the chat lens: in terminal mode the grid itself is
          the input surface (key bar included), so a second box would only duplicate it */}
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
          // no suggestion under any card, a fallback or queued one included
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
              {/* each part keeps its own direction: a right-to-left PC name does not reorder the path */}
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
