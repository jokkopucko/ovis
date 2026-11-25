import { useCallback, useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Terminal } from "@xterm/xterm";
import { hasModifiers, navigationSequence, stepModifier, terminalChord, type ModifierLatch, type StickyModifiers } from "./keys.ts";
import { keyBarInputSequence, type KeyBarKeyItem } from "./keyBar.ts";
import { DOUBLE_ESCAPE_GAP_MS, hermesCtrlCTooSoon, stopKey } from "./hermesStop.ts";
import { frameRows } from "./terminalScreen.ts";
import type { Translate } from "./i18n.ts";
import { markTyped, type HerdrSocket } from "./ws.ts";
import type { AgentStatus } from "../../shared/protocol.ts";

export interface TypedKeysDeps {
  agent: string | null;
  agentStatus: AgentStatus | undefined;
  barKeyRef: RefObject<{ key: string; chord: string | null } | null>;
  coarseRef: RefObject<boolean>;
  /** sends a pending Safari syllable or dictation phrase as an IME commit, ahead of the key */
  commitPendingText: () => void;
  compositionCommitPendingRef: RefObject<boolean>;
  composingRef: RefObject<boolean>;
  inputLineRef: RefObject<boolean>;
  modifiersRef: RefObject<StickyModifiers>;
  lockedRef: RefObject<StickyModifiers>;
  setLatch: (latch: ModifierLatch) => void;
  consumeModifiers: () => void;
  paneId: string | null;
  reassertIfStaleRef: RefObject<() => void>;
  setInputError: Dispatch<SetStateAction<string | null>>;
  socketRef: RefObject<HerdrSocket | null>;
  stopKeyRef: RefObject<number | null>;
  tRef: RefObject<Translate>;
  termRef: RefObject<Terminal | null>;
}

export function useTypedKeys(deps: TypedKeysDeps) {
  const { agent, agentStatus, barKeyRef, coarseRef, commitPendingText, compositionCommitPendingRef, composingRef, inputLineRef, modifiersRef, lockedRef, setLatch, consumeModifiers, paneId, reassertIfStaleRef, setInputError, socketRef, stopKeyRef, tRef, termRef } = deps;
  const pressKey = useCallback((item: KeyBarKeyItem, repeat = false) => {
    const term = termRef.current;
    if (!term) return;
    if (composingRef.current || compositionCommitPendingRef.current) return;
    const active = item.modifiers ?? modifiersRef.current;
    const modified = (item.key !== "ctrl-c" || item.modifiers !== undefined) && (hasModifiers(active) || item.modifiers !== undefined);
    const chord = modified ? terminalChord(item.key, active) : null;
    const input = (modified ? navigationSequence(item.key, active) : null)
      ?? keyBarInputSequence(item.key, term.modes.applicationCursorKeysMode);
    if (input === null) return;
    reassertIfStaleRef.current();
    commitPendingText();
    barKeyRef.current = { key: item.key, chord };
    try { term.input(input); } finally { barKeyRef.current = null; }
    if (item.modifiers === undefined && !repeat) consumeModifiers();
    if (!inputLineRef.current && !coarseRef.current) term.focus();
  }, [commitPendingText]);

  const toggleModifier = useCallback((modifier: keyof StickyModifiers) => {
    if (composingRef.current) return;
    setLatch(stepModifier({ held: modifiersRef.current, locked: lockedRef.current }, modifier));
    if (!inputLineRef.current && !coarseRef.current) termRef.current?.focus();
  }, []);


  // the composer's stop button: Escape interrupts the agent's current turn in every
  // supported TUI (Claude Code, omp, codex) without killing the process the way ^C would
  // Hermes' Stop is one Ctrl+C per turn (hermesStop.ts): a second one would quit it
  const hermesStopSentRef = useRef(false);
  // when this pane last sent Hermes a Ctrl+C: status flicker or a quick new turn resets the
  // guard above, so a second Ctrl+C inside Hermes' 2 s force-quit window is refused by time
  const hermesCtrlCAtRef = useRef<number | null>(null);
  useEffect(() => { if (agentStatus !== "working" && agentStatus !== "blocked") hermesStopSentRef.current = false; }, [agentStatus]);
  useEffect(() => { hermesStopSentRef.current = false; hermesCtrlCAtRef.current = null; }, [paneId, agent]);
  // the second Escape of a two-Escape Stop, still to be sent: it belongs to the pane and connection of the first
  const secondEscapeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropSecondEscape = useCallback(() => {
    if (secondEscapeRef.current !== null) clearTimeout(secondEscapeRef.current);
    secondEscapeRef.current = null;
  }, []);
  // one terminal serves the pane it is switched to: a pending Escape must not follow it there
  useEffect(() => dropSecondEscape, [paneId, agent, dropSecondEscape]);
  useEffect(() => {
    if (agentStatus !== "working" && agentStatus !== "blocked") dropSecondEscape();
  }, [agentStatus, dropSecondEscape]);
  const abortTurn = useCallback(() => {
    const term = termRef.current;
    const socket = socketRef.current;
    if (!term || !socket || !socket.connected) return;
    const now = Date.now();
    const key = stopKey(agent, () => {
      const buffer = frameRows(term);
      return Array.from({ length: term.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "");
    }, hermesStopSentRef.current, hermesCtrlCAtRef.current, now);
    if (key === null) {
      const t = tRef.current;
      if (hermesStopSentRef.current) return;
      setInputError(agent === "grok"
        ? (hermesCtrlCTooSoon(hermesCtrlCAtRef.current, now)
          ? t("Not stopped: Grok got Ctrl+C under 2 seconds ago, and a second one may quit it. Try again in a moment.")
          : t("Not stopped: Grok does not show a turn to cancel. Check the terminal."))
        : hermesCtrlCTooSoon(hermesCtrlCAtRef.current, now)
          ? t("Not stopped: Hermes got Ctrl+C under 2 seconds ago, and a second one would quit it. Try again in a moment.")
          : t("Not stopped: Hermes does not show a turn to interrupt. Check the terminal."));
      return;
    }
    if (key === "\u0003") {
      hermesStopSentRef.current = true;
      hermesCtrlCAtRef.current = now;
    }
    // both Escapes of a Stop carry its mark: the second, sent after a gap, is refused if the link was lost since
    const pressedAt = markTyped();
    const press = (sent: string): void => {
      stopKeyRef.current = pressedAt;
      try { term.input(sent); } finally { stopKeyRef.current = null; }
    };
    if (key !== "\u001b\u001b") return press(key);
    // two Escapes as two key presses: written together they read as one Alt+Escape
    press("\u001b");
    // nothing typed is sent after a disconnect: the second Escape goes out only on the connection, role and
    // pane readiness the first one had (the socket object itself survives a reconnect)
    const lease = paneId === null ? null : socket.inputLease(paneId);
    dropSecondEscape();
    secondEscapeRef.current = setTimeout(() => {
      secondEscapeRef.current = null;
      const now = socketRef.current;
      if (now !== socket || !now.connected || termRef.current !== term) return;
      if (paneId !== null && now.inputLease(paneId) !== lease) return;
      press("\u001b");
    }, DOUBLE_ESCAPE_GAP_MS);
  }, [agent, paneId, dropSecondEscape]);

  return { pressKey, toggleModifier, abortTurn, dropSecondEscape };
}
