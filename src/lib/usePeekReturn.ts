import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { GhosttyTerminal } from "./ghostty/terminal.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import type { InputRowState, FrameGate } from "./inputRow.ts";
import { modalOpen } from "./focus.ts";
import { returnBlocked, watchReturn, type PeekRequest, type TerminalPeek } from "./terminalPeek.ts";
import type { Translate } from "./i18n.ts";
import type { StillOpen } from "./paneTerminalShared.ts";

const SCREEN_OVER_ROW: ReadonlySet<string> = new Set(["claude", "codex"]);

export interface PeekReturnDeps {
  activeRef: RefObject<boolean>;
  agent: string | null;
  agentRef: RefObject<string | null>;
  agentStatus: AgentStatus | undefined;
  chatMounted: boolean;
  coarseRef: RefObject<boolean>;
  compositionCommitPendingRef: RefObject<boolean>;
  composingRef: RefObject<boolean>;
  draftHeldForRef: RefObject<string | null>;
  ended: boolean;
  findOpenRef: RefObject<boolean>;
  frameGateRef: RefObject<FrameGate>;
  inputRowNow: () => InputRowState | null;
  lineComposingRef: RefObject<boolean>;
  onEndPeekRef: RefObject<((peek: TerminalPeek) => void) | undefined>;
  onOpenTerminal: (() => void) | undefined;
  onPeekRef: RefObject<((request: PeekRequest) => void) | undefined>;
  paneId: string | null;
  paneRef: RefObject<string | null>;
  peek: TerminalPeek | null;
  peekRef: RefObject<TerminalPeek | null>;
  presented: boolean;
  receiptRowRef: RefObject<{ pane: string; text: string; state: InputRowState } | null>;
  stackRef: RefObject<HTMLDivElement | null>;
  termRef: RefObject<GhosttyTerminal | null>;
  terminalId: string | null;
  t: Translate;
  heldRef: RefObject<boolean>;
  unsupportedRef: RefObject<boolean>;
}

export function usePeekReturn(deps: PeekReturnDeps) {
  const { activeRef, agent, agentRef, agentStatus, chatMounted, coarseRef, compositionCommitPendingRef, composingRef, draftHeldForRef, ended, findOpenRef, frameGateRef, inputRowNow, lineComposingRef, onEndPeekRef, onOpenTerminal, onPeekRef, paneId, paneRef, peek, peekRef, presented, receiptRowRef, stackRef, termRef, terminalId, t, heldRef, unsupportedRef } = deps;
  const [manualPeek, setManualPeek] = useState<TerminalPeek | null>(null);
  const autoPeek = peek !== null && peek.auto && manualPeek !== peek ? peek : null;
  const autoEndedRef = useRef<TerminalPeek | null>(null);
  const onCommandScreenClosed = useCallback((closed: TerminalPeek) => {
    if (peekRef.current !== closed) return;
    const pane = paneRef.current;
    if (returnBlocked({ heldDraft: pane !== null && draftHeldForRef.current === pane, findOpen: findOpenRef.current,
      composing: composingRef.current || compositionCommitPendingRef.current || lineComposingRef.current })) { setManualPeek(closed); return; }
    autoEndedRef.current = closed;
    onEndPeekRef.current?.(closed);
  }, []);
  useEffect(() => { if (peek !== null && (ended || !presented)) onEndPeekRef.current?.(peek); }, [peek, ended, presented]);
  // A watched peek (lib/terminalPeek.ts watchReturn): armed by a frame whose input row an open screen
  // hid or covered, back on the first frame that draws the row again, empty. Read off whole frames
  // only (onInputRowFrame), never on a timer, and nothing is typed.
  const watchRef = useRef<{ peek: TerminalPeek; agent: string; armed: boolean } | null>(null);
  const lastWatchRef = useRef<{ peek: TerminalPeek; agent: string; armed: boolean } | null>(null);
  const watchFrame = useCallback((state: InputRowState) => {
    const watch = watchRef.current;
    if (watch === null) return;
    if (peekRef.current !== watch.peek) { watchRef.current = null; return; }
    if (agentRef.current !== watch.agent) { watchRef.current = null; setManualPeek(watch.peek); return; }
    const next = watchReturn(watch.agent, watch.armed, state);
    if (next.step === "wait") { watch.armed = next.armed; return; }
    watchRef.current = null;
    if (next.step === "manual") setManualPeek(watch.peek);
    else onCommandScreenClosed(watch.peek);
  }, [onCommandScreenClosed]);
  useLayoutEffect(() => {
    if (peek === null || peek.watch === null || manualPeek === peek) { watchRef.current = null; return; }
    if (watchRef.current?.peek === peek) return;
    watchRef.current = { peek, agent: peek.watch, armed: false };
    lastWatchRef.current = watchRef.current;
    const atReceipt = receiptRowRef.current;
    receiptRowRef.current = null;
    if (atReceipt !== null && atReceipt.pane === peek.paneId && atReceipt.text === peek.text) watchFrame(atReceipt.state);
    const state = frameGateRef.current.reflowing ? null : inputRowNow();
    if (state !== null && watchRef.current?.peek === peek) watchFrame(state);
  }, [peek, manualPeek, inputRowNow, watchFrame]);
  // A peek ended by hand while the command's screen is still open in the terminal (Claude's /btw
  // answer, a picker left up): the next message would be typed into that screen and do nothing, so
  // the composer says so, holds Send behind Send anyway, and offers the terminal again. Nothing is
  // typed to close anything.
  const [stillOpen, setStillOpenState] = useState<StillOpen | null>(null);
  const stillOpenRef = useRef(stillOpen);
  const screenHeldRef = useRef(false);
  const setStillOpen = useCallback((next: StillOpen | null) => {
    stillOpenRef.current = next;
    if (next !== null) screenHeldRef.current = true;
    setStillOpenState(next);
  }, []);
  // A watched command whose screen had not opened when its peek was ended by hand (gjc's /sessions
  // keeps its empty box for seconds while it loads): no notice yet, and the first frame that shows
  // its screen (the agent's arm set) turns it into one.
  const pendingOpenRef = useRef<StillOpen | null>(null);
  const undecidedOpenRef = useRef<StillOpen | null>(null);
  const chatHistoryRef = useRef<{ pane: string; history: string | undefined } | null>(null);
  const stillOpenNotedRef = useRef(false);
  // A screen the agent opens over the row outside a peek ended by hand (Codex's transcript search,
  // Claude's /config, a peek's screen the terminal lens kept) would take the next message just the same,
  // so it gets the same unnamed notice: only with the chat up, no peek, no guard already, the agent at
  // rest and the row read before on this pane (an unknown variant never gets the notice) (#1552).
  const rowSeenRef = useRef<{ pane: string; agent: string } | null>(null);
  const inferredRef = useRef<StillOpen | null>(null);
  const chatMountedRef = useRef(chatMounted); chatMountedRef.current = chatMounted;
  const agentStatusRef = useRef(agentStatus); agentStatusRef.current = agentStatus;
  const noteRow = useCallback((state: InputRowState) => {
    const pane = paneRef.current, current = agentRef.current;
    if (pane === null || current === null) return;
    if (state === "ready") { rowSeenRef.current = { pane, agent: current }; screenHeldRef.current = false; inferredRef.current = null; return; }
    if ((state !== "gone" && state !== "covered") || !SCREEN_OVER_ROW.has(current) || screenHeldRef.current) return;
    const seen = rowSeenRef.current;
    if (seen === null || seen.pane !== pane || seen.agent !== current) return;
    if (!chatMountedRef.current || peekRef.current !== null || stillOpenRef.current !== null || pendingOpenRef.current !== null || undecidedOpenRef.current !== null) return;
    if (agentStatusRef.current === "working" || agentStatusRef.current === "blocked") return;
    const history = chatHistoryRef.current?.pane === pane ? chatHistoryRef.current.history : undefined;
    const open: StillOpen = { pane, agent: current, command: "", named: false, history };
    inferredRef.current = open;
    setStillOpen(open);
  }, [setStillOpen]);
  const onInputRowFrame = useCallback(() => {
    const pending = pendingOpenRef.current;
    const undecided = undecidedOpenRef.current;
    const watching = watchRef.current !== null || stillOpenRef.current !== null || pending !== null || undecided !== null;
    const seen = rowSeenRef.current;
    const known = seen !== null && seen.pane === paneRef.current && seen.agent === agentRef.current;
    if (!watching && (agentStatusRef.current === "working" || (known && !chatMountedRef.current && !screenHeldRef.current))) return;
    // herdr's first frame for the pane's new size may be its old screen reflowed: no screen opened or closed
    if (frameGateRef.current.reflowing) return;
    const state = inputRowNow();
    if (state === null || state === "unknown") return;
    if (!watching) { noteRow(state); return; }
    if (state === "ready") noteRow(state);
    if (undecided !== null) {
      undecidedOpenRef.current = null;
      if (state !== "ready" && undecided.pane === paneRef.current && undecided.agent === agentRef.current) setStillOpen(undecided);
    }
    if (state === "ready" && stillOpenRef.current !== null) setStillOpen(null);
    if (pending !== null) {
      const step = pending.pane === paneRef.current && pending.agent === agentRef.current ? watchReturn(pending.agent, false, state) : null;
      if (step === null) pendingOpenRef.current = null;
      else if (step.step === "wait" && step.armed) { pendingOpenRef.current = null; setStillOpen(pending); }
    }
    watchFrame(state);
  }, [inputRowNow, watchFrame, setStillOpen, noteRow]);
  const onInputRowFrameRef = useRef(onInputRowFrame); onInputRowFrameRef.current = onInputRowFrame;
  useLayoutEffect(() => { setStillOpen(null); pendingOpenRef.current = null; undecidedOpenRef.current = null; stillOpenNotedRef.current = false; rowSeenRef.current = null; screenHeldRef.current = false; inferredRef.current = null; }, [paneId, terminalId, setStillOpen]);
  useEffect(() => {
    if (!chatMounted || peekRef.current !== null || frameGateRef.current.reflowing) return;
    const state = inputRowNow();
    if (state !== null && state !== "unknown") noteRow(state);
  }, [chatMounted, inputRowNow, noteRow]);
  useEffect(() => {
    if (stillOpenRef.current !== null && stillOpenRef.current.agent !== agent) setStillOpen(null);
    if (pendingOpenRef.current !== null && pendingOpenRef.current.agent !== agent) pendingOpenRef.current = null;
    if (undecidedOpenRef.current !== null && undecidedOpenRef.current.agent !== agent) undecidedOpenRef.current = null;
  }, [agent, setStillOpen]);
  useEffect(() => {
    if (agentStatus !== "working") return;
    pendingOpenRef.current = null; undecidedOpenRef.current = null;
    if (inferredRef.current !== null && stillOpenRef.current === inferredRef.current) setStillOpen(null);
    inferredRef.current = null;
    if (stillOpenRef.current === null) screenHeldRef.current = false;
  }, [agentStatus, setStillOpen]);
  const stillOpenNote = useCallback((open: StillOpen): string => open.named
    ? t("Not sent: {command} is still open in the terminal.", { command: open.command })
    : t("Not sent: a screen is still open in the terminal."), [t]);
  const showStillOpen = useCallback(() => {
    const open = stillOpenRef.current;
    const show = onPeekRef.current;
    if (open === null) return;
    if (show === undefined || heldRef.current || unsupportedRef.current || open.command === "") { onOpenTerminal?.(); return; }
    show({ command: open.command, text: null, knownOutcomeIds: null, auto: false, watch: null, inputRowSeen: true });
  }, [onOpenTerminal]);
  // Every end of a peek back to the chat: the hidden grid lets go of the keyboard (it has no Chat
  // guard of its own, and keys typed after the return would reach the pane), and a desktop's typing
  // goes back to the message box of the same pane (another pane's composer focuses itself, or not,
  // as a pane switch decides). A phone's keyboard stays down. Keep Terminal (or the header's
  // GhosttyTerminal) keeps the grid, and gives it the keyboard its button took.
  const shownPeekRef = useRef<TerminalPeek | null>(null);
  useLayoutEffect(() => {
    const was = shownPeekRef.current;
    shownPeekRef.current = peek;
    if (peek !== null) { pendingOpenRef.current = null; undecidedOpenRef.current = null; }
    if (was === null || peek !== null) return;
    if (!chatMounted) {
      if (activeRef.current && was.paneId === paneRef.current && !coarseRef.current && !modalOpen() && !findOpenRef.current) termRef.current?.focus();
      return;
    }
    if (was !== autoEndedRef.current && was.inputRowSeen && was.paneId === paneRef.current && agentRef.current !== null) {
      const state = inputRowNow();
      const history = chatHistoryRef.current?.pane === was.paneId ? chatHistoryRef.current.history : undefined;
      const kept = stillOpenRef.current?.pane === was.paneId ? stillOpenRef.current : null;
      const open: StillOpen = { pane: was.paneId, agent: agentRef.current, command: was.text === null && kept !== null ? kept.command : was.command,
        named: was.text !== null || kept?.named === true, history };
      const watched = lastWatchRef.current?.peek === was ? lastWatchRef.current : null;
      if (state === "ready") {
        setStillOpen(null);
        if (watched !== null && !watched.armed && watched.agent === agentRef.current) pendingOpenRef.current = open;
      } else if (state === "unknown") undecidedOpenRef.current = open;
      else if (state !== null) setStillOpen(open);
    }
    termRef.current?.blur();
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && stackRef.current?.contains(focused)) focused.blur();
    if (activeRef.current && was.paneId === paneRef.current && !coarseRef.current && !modalOpen()) {
      stackRef.current?.querySelector<HTMLTextAreaElement>(".composer-text")?.focus({ preventScroll: true });
    }
  }, [peek, chatMounted]); // eslint-disable-line react-hooks/exhaustive-deps -- read at the end only
  return { autoPeek, onCommandScreenClosed, stillOpen, stillOpenRef, setStillOpen, pendingOpenRef, undecidedOpenRef, chatHistoryRef, stillOpenNotedRef, onInputRowFrameRef, stillOpenNote, showStillOpen };
}
