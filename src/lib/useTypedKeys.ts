import { useCallback, useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Terminal } from "@xterm/xterm";
import { hasModifiers, navigationSequence, terminalChord, type StickyModifiers } from "./keys.ts";
import { keyBarInputSequence, type KeyBarKeyItem } from "./keyBar.ts";
import { hermesCtrlCTooSoon, stopKey } from "./hermesStop.ts";
import type { Translate } from "./i18n.ts";
import type { HerdrSocket } from "./ws.ts";
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
  paneId: string | null;
  reassertIfStaleRef: RefObject<() => void>;
  setInputError: Dispatch<SetStateAction<string | null>>;
  setModifiers: Dispatch<SetStateAction<StickyModifiers>>;
  socketRef: RefObject<HerdrSocket | null>;
  stopKeyRef: RefObject<boolean>;
  tRef: RefObject<Translate>;
  termRef: RefObject<Terminal | null>;
}

export function useTypedKeys(deps: TypedKeysDeps) {
  const { agent, agentStatus, barKeyRef, coarseRef, commitPendingText, compositionCommitPendingRef, composingRef, inputLineRef, modifiersRef, paneId, reassertIfStaleRef, setInputError, setModifiers, socketRef, stopKeyRef, tRef, termRef } = deps;
  // key-bar taps go through xterm so the onData -> socket path above is reused
  const pressKey = useCallback((item: KeyBarKeyItem) => {
    const term = termRef.current;
    if (!term) return;
    if (composingRef.current || compositionCommitPendingRef.current) return;
    const active = item.modifiers ?? modifiersRef.current;
    // A saved combination is exact; an ordinary key inherits the held modifiers.
    // The built-in interrupt remains its dedicated Ctrl+C action.
    const modified = (item.key !== "ctrl-c" || item.modifiers !== undefined) && (hasModifiers(active) || item.modifiers !== undefined);
    const chord = modified ? terminalChord(item.key, active) : null;
    const input = (modified ? navigationSequence(item.key, active) : null)
      ?? keyBarInputSequence(item.key, term.modes.applicationCursorKeysMode);
    if (input === null) return;
    reassertIfStaleRef.current();
    commitPendingText();
    barKeyRef.current = { key: item.key, chord };
    try { term.input(input); } finally { barKeyRef.current = null; }
    // with the input line, the keyboard belongs to it: a key tap must not move it to the grid. On a
    // touch screen a key tap never takes the focus at all: focusing the grid raises the soft
    // keyboard, and a key pressed with the keyboard put away (after dictating, say) must leave it
    // away. Only the keyboard key, or a tap on the line or the grid, brings it up.
    if (!inputLineRef.current && !coarseRef.current) term.focus();
  }, [commitPendingText]);

  const toggleModifier = useCallback((modifier: keyof StickyModifiers) => {
    if (composingRef.current) return;
    const next = { ...modifiersRef.current, [modifier]: !modifiersRef.current[modifier] };
    modifiersRef.current = next;
    setModifiers(next);
    if (!inputLineRef.current && !coarseRef.current) termRef.current?.focus();
  }, []);


  // the composer's stop button: Escape interrupts the agent's current turn in every
  // supported TUI (Claude Code, omp, codex) without killing the process the way ^C would
  // Hermes' Stop is one Ctrl+C per turn (hermesStop.ts): a second one would quit it
  const hermesStopSentRef = useRef(false);
  // when this pane last sent Hermes a Ctrl+C: status flicker or a quick new turn resets the
  // guard above, so a second Ctrl+C inside Hermes' 2 s force-quit window is refused by time
  const hermesCtrlCAtRef = useRef<number | null>(null);
  // a turn waiting on an approval (blocked) is still the same turn
  useEffect(() => { if (agentStatus !== "working" && agentStatus !== "blocked") hermesStopSentRef.current = false; }, [agentStatus]);
  useEffect(() => { hermesStopSentRef.current = false; hermesCtrlCAtRef.current = null; }, [paneId, agent]);
  const abortTurn = useCallback(() => {
    const term = termRef.current;
    const socket = socketRef.current;
    if (!term || !socket || !socket.connected) return;
    const now = Date.now();
    const key = stopKey(agent, () => {
      const buffer = term.buffer.active;
      return Array.from({ length: term.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "");
    }, hermesStopSentRef.current, hermesCtrlCAtRef.current, now);
    if (key === null) {
      const t = tRef.current;
      if (hermesStopSentRef.current) return;
      setInputError(hermesCtrlCTooSoon(hermesCtrlCAtRef.current, now)
        ? t("Not stopped: Hermes got Ctrl+C under 2 seconds ago, and a second one would quit it. Try again in a moment.")
        : t("Not stopped: Hermes does not show a turn to interrupt. Check the terminal."));
      return;
    }
    if (key === "\u0003") {
      hermesStopSentRef.current = true;
      hermesCtrlCAtRef.current = now;
    }
    stopKeyRef.current = true;
    try { term.input(key); } finally { stopKeyRef.current = false; }
  }, [agent]);

  return { pressKey, toggleModifier, abortTurn };
}
