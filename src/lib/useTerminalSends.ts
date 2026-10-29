import { useCallback, useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { HerdrSocket, SubmitDelivery, SubmitResult } from "./ws.ts";
import type { MachineSession } from "./machineSession.ts";
import { EMPTY_DRAFT } from "./draft.ts";
import { composerMessage, composerPayload, insertNote, submitNote, submitNotTyped } from "./compose.ts";
import { afterSend, afterSettled, greetingMemory, rememberGreeting } from "./greeting.ts";
import { hasModifiers, terminalChord, type StickyModifiers } from "./keys.ts";
import type { InputRowState } from "./inputRow.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { pendingMessages } from "./pendingMessages.ts";
import type { PaneSubmitRetention } from "./paneSubmitRetention.ts";
import type { Translate } from "./i18n.ts";
import type { Terminal } from "@xterm/xterm";
import type { InputDraft } from "./draft.ts";
import type { Settings } from "./settings.ts";

export interface TerminalSendsDeps {
  activeRef: RefObject<boolean>;
  agent: string | null;
  chatView: boolean;
  cancelTouchRef: RefObject<() => void>;
  coarse: boolean;
  composingRef: RefObject<boolean>;
  directTyping: boolean;
  draft: InputDraft;
  draftHeldForRef: RefObject<string | null>;
  heldRef: RefObject<boolean>;
  hostRef: RefObject<HTMLDivElement | null>;
  inputLine: boolean;
  inputRowNow: () => InputRowState | null;
  keyboardToggleFocusRef: RefObject<boolean>;
  knownOutcomes: (pane: string | null) => readonly string[] | null;
  lineComposingRef: RefObject<boolean>;
  machineId: string;
  modifiersRef: RefObject<StickyModifiers>;
  onChatSuggestion: (pane: string, value: string | null) => void;
  paneId: string | null;
  paneRef: RefObject<string | null>;
  pendingEpochRef: RefObject<number>;
  pendingSubmissionsRef: RefObject<Set<{ pane: string; socket: HerdrSocket; epoch: number }>>;
  reassertIfStaleRef: RefObject<() => void>;
  redrawGreeting: () => void;
  releaseRef: RefObject<() => void>;
  secretRef: RefObject<string | null>;
  sessionRef: RefObject<MachineSession | null>;
  setChatRefresh: Dispatch<SetStateAction<number>>;
  setChatSent: Dispatch<SetStateAction<number>>;
  setDraft: (value: InputDraft | ((previous: InputDraft) => InputDraft)) => void;
  showSentCommand: (pane: string, text: string, known: readonly string[] | null, seen: boolean) => void;
  socketRef: RefObject<HerdrSocket | null>;
  stillOpenNote: (open: { pane: string; agent: string; command: string; named: boolean; history: string | undefined }) => string;
  stillOpenRef: RefObject<{ pane: string; agent: string; command: string; named: boolean; history: string | undefined } | null>;
  submitRetention: PaneSubmitRetention | null;
  tRef: RefObject<Translate>;
  termRef: RefObject<Terminal | null>;
  updateSettings: (patch: Partial<Settings>) => void;
}

export function useTerminalSends(deps: TerminalSendsDeps) {
  const { activeRef, agent, cancelTouchRef, chatView, coarse, composingRef, directTyping, draft, draftHeldForRef, heldRef, hostRef, inputLine, inputRowNow, keyboardToggleFocusRef, knownOutcomes, lineComposingRef, machineId, modifiersRef, onChatSuggestion, paneId, paneRef, pendingEpochRef, pendingSubmissionsRef, reassertIfStaleRef, redrawGreeting, releaseRef, secretRef, sessionRef, setChatRefresh, setChatSent, setDraft, showSentCommand, socketRef, stillOpenNote, stillOpenRef, submitRetention, tRef, termRef, updateSettings } = deps;
  const sendDraft = useCallback(() => {
    const socket = socketRef.current;
    const pane = paneRef.current;
    if (!socket || !pane || draft.text.length === 0 || !socket.connected || secretRef.current !== null || heldRef.current) return;
    // a frame the socket refuses (input not ready yet) keeps the draft, on screen and on disk, for
    // another try or Discard; it is never queued
    cancelTouchRef.current();
    if (socket.sendInput(pane, draft.text)) setDraft(EMPTY_DRAFT);
  }, [draft]);

  const discardDraft = useCallback(() => {
    setDraft(EMPTY_DRAFT);
  }, []);

  // the composer goes straight to the socket, not through onData: an armed key-bar Ctrl
  // must not turn a one-letter message into a control key. Offline it sends nothing and
  // keeps its text (never-queue); a message the server could not deliver keeps it too,
  // with the reason. Bracketed-paste wrapping follows the pane program's mode.
  const submitComposerMessage = useCallback((text: string, delivery: SubmitDelivery = "immediate", clearDraft?: string, sendAnyway = false, resendId?: string, generation?: number, agentOnly = false): Promise<SubmitResult> | null => {
    const term = termRef.current;
    const socket = socketRef.current;
    const session = sessionRef.current;
    const pane = paneRef.current;
    if (!term || !socket || !session || pane === null || secretRef.current !== null || heldRef.current) return null;
    // its Enter would run the pty's line without the start a held draft keeps
    if (draftHeldForRef.current === pane) return Promise.resolve({ ok: false, code: "held_input", message: "send or discard the held input first" });
    // not the scope itself: a message sent right after a reconnect leaves before the snapshot that names it
    const epoch = session.epoch;
    const sent = socket.submit(pane, composerMessage(text), composerPayload(text, term.modes.bracketedPasteMode), false, delivery, clearDraft, sendAnyway, resendId, generation, agentOnly);
    if (sent === null) return null;
    const releaseSubmit = submitRetention?.retain(pane);
    const submission = delivery !== "immediate" ? { pane, socket, epoch } : null;
    if (submission) pendingSubmissionsRef.current.add(submission);
    term.scrollToBottom();
    if (delivery === "immediate") setChatSent((current) => current + 1);
    const owner = paneStorageId(machineId, pane);
    const history = greetingMemory(owner).history;
    if (delivery === "immediate") { rememberGreeting(owner, afterSend(greetingMemory(owner))); redrawGreeting(); }
    // a message went out, from the box or a queued one: the agent's suggestion was for the turn before it
    onChatSuggestion(pane, null);
    return sent.then((result) => {
      // a message refused before anything was typed leaves the greeting as it was; each answer
      // settles its own message only, so one on its way beside it (a queued "Send now") is not undone
      const typed = result.ok ? result.pending === undefined : !submitNotTyped(result.code);
      if (delivery === "immediate") {
        rememberGreeting(owner, afterSettled(greetingMemory(owner), typed, history)); redrawGreeting();
      } else if (typed) {
        rememberGreeting(owner, afterSettled(afterSend(greetingMemory(owner)), true, history)); redrawGreeting();
      }
      if (!result.ok) return result;
      if (result.pending) {
        session.acceptPending(pane, result.pending, epoch);
      } else {
        if (paneRef.current === pane) {
          if (delivery !== "immediate") setChatSent((current) => current + 1);
          setChatRefresh((current) => current + 1);
        }
      }
      return result;
    }, (error: unknown) => {
      // the send broke with no answer: it may have been typed, and it is no longer on its way
      rememberGreeting(owner, afterSettled(delivery === "immediate" ? greetingMemory(owner) : afterSend(greetingMemory(owner)), true, history)); redrawGreeting();
      throw error;
    }).finally(() => {
      if (submission) pendingSubmissionsRef.current.delete(submission);
      releaseSubmit?.();
      if (paneRef.current === pane && socketRef.current === socket && pendingEpochRef.current === epoch) releaseRef.current();
    });
  }, [onChatSuggestion, machineId, submitRetention]);

  const sendComposerText = useCallback((text: string, delivery: "queue" | "immediate" = "immediate"): false | Promise<true | string> => {
    const pane = paneRef.current;
    // a screen a peek left open would take it: the row keeps it (the notice's close, or the screen's, lets it go)
    const open = stillOpenRef.current;
    if (pane !== null && open !== null && open.pane === pane) return Promise.resolve(stillOpenNote(open));
    const known = knownOutcomes(pane);
    const seen = inputRowNow() === "ready";
    const result = submitComposerMessage(text, delivery);
    return result === null ? false : result.then((answer) => {
      if (!answer.ok) return submitNote(answer.code, answer.message, agent);
      // an older bridge took it with no receipt: the held row goes, a row not confirmed keeps its text
      if (answer.unconfirmed && pane !== null) pendingMessages.keepUnconfirmed(paneStorageId(machineId, pane), text);
      if (pane !== null && answer.pending === undefined && !answer.unconfirmed) showSentCommand(pane, text, known, seen);
      return true;
    });
  }, [submitComposerMessage, agent, machineId, showSentCommand, inputRowNow, stillOpenNote]);

  // the terminal's input line: the text typed like the keyboard would, into an agent's open
  // menu too, then Enter after the server's gap; several lines go as one paste
  const sendTerminalLine = useCallback((text: string): false | Promise<true | string> => {
    const term = termRef.current;
    const socket = socketRef.current;
    const pane = paneRef.current;
    if (!term || !socket || pane === null || secretRef.current !== null) return false;
    // its text and Enter would land beside the held draft: Send or Discard that first
    if (draftHeldForRef.current === pane) return Promise.resolve(tRef.current("Not sent: send or discard the held input first."));
    const message = composerMessage(text);
    const payload = message.includes("\n") ? composerPayload(text, term.modes.bracketedPasteMode) : message;
    reassertIfStaleRef.current();
    cancelTouchRef.current();
    const sent = socket.submit(pane, message, payload, true);
    if (sent === null) return false;
    const releaseSubmit = submitRetention?.retain(pane);
    term.scrollToBottom();
    return sent.then((result) => (result.ok ? true : submitNote(result.code, result.message))).finally(() => {
      releaseSubmit?.();
      if (paneRef.current === pane && socketRef.current === socket) releaseRef.current();
    });
  }, [submitRetention]);

  // the input line's Insert: one line typed like the keyboard would, with no Enter after it, and
  // answered once herdr has it (HerdrSocket.insert). Nothing but the insert frame goes: unlike Send,
  // it takes no grid back from another device (no resize), and moves no focus
  const insertTerminalText = useCallback((text: string): false | Promise<true | string> => {
    const term = termRef.current;
    const socket = socketRef.current;
    const pane = paneRef.current;
    if (!term || !socket || pane === null || secretRef.current !== null) return false;
    // its text would land beside the held draft: Send or Discard that first
    if (draftHeldForRef.current === pane) return Promise.resolve(insertNote("held_input", ""));
    const sent = socket.insert(pane, text);
    if (sent === null) return false;
    const releaseInsert = submitRetention?.retain(pane);
    term.scrollToBottom();
    return sent.then((result) => (result.ok ? true : insertNote(result.code, result.message))).finally(() => {
      releaseInsert?.();
      if (paneRef.current === pane && socketRef.current === socket) releaseRef.current();
    });
  }, [submitRetention]);

  // a tap into the input line is the user here: the grid is theirs again before they type
  const reassertGrid = useCallback(() => {
    // not the keyboard control's focus of the line: it shows the keyboard and sizes nothing
    if (keyboardToggleFocusRef.current) return;
    reassertIfStaleRef.current();
  }, []);

  const pressEnter = useCallback((): boolean | string => {
    const socket = socketRef.current;
    const pane = paneRef.current;
    if (!socket || pane === null || !socket.connected) return false;
    // Enter beside a held draft would run the pty's line without the held start
    if (draftHeldForRef.current === pane) return tRef.current("Not sent: send or discard the held input first.");
    reassertIfStaleRef.current();
    cancelTouchRef.current();
    const sent = hasModifiers(modifiersRef.current)
      ? socket.sendKeys(pane, [terminalChord("Enter", modifiersRef.current)!]) : socket.sendInput(pane, "\r");
    termRef.current?.scrollToBottom();
    return sent;
  }, []);

  const toggleDirect = useCallback(() => {
    if (composingRef.current || lineComposingRef.current) return;
    updateSettings({ terminalInputMode: directTyping ? "line" : "direct" });
  }, [directTyping, updateSettings]);

  // the input line keeps a tapped grid from raising the keyboard; typing straight into it gives it
  // back. Only turning direct typing on raises it: a pane or lens picked with it on does not.
  const directTypingRef = useRef(directTyping);
  useEffect(() => {
    const turnedOn = directTyping && !directTypingRef.current;
    directTypingRef.current = directTyping;
    const textarea = hostRef.current?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    if (!textarea) return;
    if (inputLine) {
      textarea.setAttribute("inputmode", "none");
      if (document.activeElement === textarea) textarea.blur();
    } else {
      textarea.removeAttribute("inputmode");
      // only the selected pane: a focused sibling would take the selection (PaneCanvas onFocusCapture)
      if (activeRef.current && coarse && !chatView && turnedOn) termRef.current?.focus();
    }
  }, [inputLine, coarse, chatView, directTyping, paneId]);

  return { sendDraft, discardDraft, submitComposerMessage, sendComposerText, sendTerminalLine, insertTerminalText, reassertGrid, pressEnter, toggleDirect };
}
