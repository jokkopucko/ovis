import { useEffect, useRef, type RefObject } from "react";
import type { TerminalColors } from "./themes.ts";
import { type FontSettled, loadFontStack, measurableFontStack, monoFaceArrived, openingFontStack, terminalFontStack } from "./fontFamily.ts";
import { modalOpen } from "./focus.ts";
import { addServedFonts } from "./userFonts.ts";
import { inUse, keepsCoreGrid, takeKeptCoreGrid } from "./paneTerminalShared.ts";
import { fitLineHeight } from "./terminalLineHeight.ts";
import type { TerminalPeek } from "./terminalPeek.ts";
import type { HerdrSocket } from "./ws.ts";
import type { GhosttyFit, GhosttyTerminal } from "./ghostty/terminal.ts";
import { typeAheadFocused } from "./typeAhead.ts";
import { terminalScreen } from "./terminalScreen.ts";

export interface TerminalRefitsDeps {
  activeRef: RefObject<boolean>;
  autoSelected: boolean;
  baseFontRef: RefObject<number>;
  pinchingRef: RefObject<boolean>;
  fontSettledRef: RefObject<FontSettled>;
  chatView: boolean;
  chatViewRef: RefObject<boolean>;
  coarseRef: RefObject<boolean>;
  covered: boolean;
  findOpenRef: RefObject<boolean>;
  fitRef: RefObject<GhosttyFit | null>;
  fittedRef: RefObject<() => void>;
  fixedGridRef: RefObject<boolean>;
  follow: boolean;
  followCursorRef: RefObject<() => void>;
  keyboardHoldsRef: RefObject<(force: boolean) => boolean>;
  narrowFont: boolean;
  narrowFontFitted: RefObject<boolean>;
  observeRef: RefObject<boolean>;
  colors: TerminalColors;
  paneRef: RefObject<string | null>;
  peekRef: RefObject<TerminalPeek | null>;
  sharedGridRef: RefObject<{ cols: number; rows: number } | null>;
  shown: boolean;
  sizesPty: () => boolean;
  socketRef: RefObject<HerdrSocket | null>;
  termRef: RefObject<GhosttyTerminal | null>;
  terminalFontFamily: string;
  terminalFontSize: number;
}

export function useTerminalRefits(deps: TerminalRefitsDeps): void {
  const { activeRef, autoSelected, baseFontRef, pinchingRef, fontSettledRef, chatView, chatViewRef, coarseRef, findOpenRef, fitRef, fittedRef, fixedGridRef, follow, followCursorRef, keyboardHoldsRef, narrowFont, narrowFontFitted, observeRef, colors, covered, paneRef, peekRef, sharedGridRef, shown, sizesPty, socketRef, termRef, terminalFontFamily, terminalFontSize } = deps;
  // a fit that sizes no pty (out of use, or not this page's to size: covered, a following split) leaves a kept herdr-core
  // pty drawn in its grid
  const keptUndriven = (): boolean => keepsCoreGrid(socketRef.current, paneRef.current) && !(inUse() && sizesPty());
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = { ...colors };
  }, [colors]);

  // the font follows too, and a font change moves the grid. xterm measures the cell (and the DOM
  // renderer its glyph widths) when fontFamily or fontSize changes, and setting the same value
  // again changes nothing: so a chosen family is set only once its faces loaded, or the cell would
  // stay measured from a fallback
  const fontFamily = terminalFontStack(terminalFontFamily);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let superseded = false;
    const apply = (): void => {
      if (superseded || termRef.current !== term) return;
      const pinching = pinchingRef.current;
      const size = pinching ? baseFontRef.current : terminalFontSize;
      baseFontRef.current = size;
      // only a face that has loaded: one still loading would be measured as its fallback, so it is
      // set once it arrives (below)
      const family = measurableFontStack(openingFontStack(fontFamily));
      if (term.options.fontSize === size && term.options.fontFamily === family) return;
      term.options.fontSize = size;
      term.options.fontFamily = family;
      fitLineHeight(term);
      if (observeRef.current || fixedGridRef.current || chatViewRef.current || keyboardHoldsRef.current(true) || keptUndriven()) return;
      try {
        fitRef.current?.fit();
        fittedRef.current();
      } catch {
        return;
      }
      const pane = paneRef.current;
      if (!pinching && pane && sizesPty() && inUse()) socketRef.current?.resize(pane, term.cols, term.rows, true);
    };
    void addServedFonts(terminalFontFamily).then(() => loadFontStack(fontFamily, terminalFontSize)).then(() => {
      if (superseded) return;
      apply();
      fontSettledRef.current.settle();
      if (openingFontStack(fontFamily) !== fontFamily) void monoFaceArrived(terminalFontSize).then(apply);
    });
    return () => { superseded = true; };
  }, [terminalFontSize, fontFamily]);

  // the setting, a zoom or the last sibling closing need not resize the host: the observer may stay silent
  useEffect(() => {
    if (narrowFontFitted.current === narrowFont) return;
    narrowFontFitted.current = narrowFont;
    const term = termRef.current;
    if (!term || observeRef.current || fixedGridRef.current || chatViewRef.current || keyboardHoldsRef.current(false) || keptUndriven()) return;
    try {
      fitRef.current?.fit();
      fittedRef.current();
    } catch {
      return;
    }
    const pane = paneRef.current;
    if (pane && sizesPty() && inUse()) socketRef.current?.resize(pane, term.cols, term.rows);
  }, [narrowFont]);

  // the grid must re-fit when the lens switches back: the chat lens covered it, and a
  // resize while covered may have been skipped by a zero-size layout
  useEffect(() => {
    if (chatView) {
      const pane = paneRef.current;
      if (pane) socketRef.current?.releaseSize(pane);
      const shared = sharedGridRef.current;
      const hidden = termRef.current;
      if (shared && hidden && !observeRef.current && (hidden.cols !== shared.cols || hidden.rows !== shared.rows)) hidden.resize(shared.cols, shared.rows);
      return;
    }
    // Into the terminal from the chat: the history this browser keeps (a herdr-core server's terminal-history) shows
    // its newest rows, once per switch, unless a selection is being made in it. herdr's own view is shared with its
    // other clients (its TUI, other browsers): a lens switch here is no reason to move theirs, so that view stays
    // where it is and the way to the bottom shows over it (components/TerminalViewportTools.tsx)
    const landAtBottom = (): void => {
      const shown = termRef.current;
      if (shown && !terminalScreen(shown).hasSelection()) shown.scrollToBottom();
    };
    const reclaim = paneRef.current && socketRef.current?.canRequestWindowsFit(paneRef.current);
    if (observeRef.current || (fixedGridRef.current && !reclaim) || keptUndriven()) { landAtBottom(); return; }
    if (keyboardHoldsRef.current(true)) { landAtBottom(); return; }
    const term = termRef.current;
    try {
      fitRef.current?.fit();
      fittedRef.current();
    } catch {
      landAtBottom();
      return;
    }
    landAtBottom();
    const pane = paneRef.current;
    if (pane && term && sizesPty() && inUse()) socketRef.current?.resize(pane, term.cols, term.rows, true);
    if (activeRef.current && (!autoSelected || peekRef.current !== null) && !coarseRef.current && !modalOpen() && !findOpenRef.current && !typeAheadFocused()) term?.focus();
  }, [chatView]);

  const heldWhileHidden = useRef(false);
  const wasShown = useRef(shown);
  useEffect(() => {
    if (wasShown.current === shown) return;
    wasShown.current = shown;
    if (shown && !covered) heldWhileHidden.current = false;
    const pane = paneRef.current;
    if (!pane || observeRef.current || fixedGridRef.current || chatViewRef.current) return;
    if (!shown) {
      socketRef.current?.keepSize(pane);
      const hidden = termRef.current;
      if (hidden && takeKeptCoreGrid(hidden, socketRef.current, pane, sharedGridRef.current)) followCursorRef.current();
      return;
    }
    if (keyboardHoldsRef.current(true) || keptUndriven()) return;
    const term = termRef.current;
    try {
      fitRef.current?.fit();
      fittedRef.current();
    } catch {
      return;
    }
    if (term && sizesPty() && inUse()) socketRef.current?.resize(pane, term.cols, term.rows, true);
  }, [shown]);

  const wasCovered = useRef(covered);
  const heldAtCover = useRef(false);
  useEffect(() => {
    if (wasCovered.current === covered) return;
    wasCovered.current = covered;
    const pane = paneRef.current;
    if (covered) {
      heldAtCover.current = heldWhileHidden.current || (pane !== null && socketRef.current?.holdsSize(pane) === true);
      heldWhileHidden.current = false;
      return;
    }
    const held = heldAtCover.current;
    heldAtCover.current = false;
    if (!shown) { heldWhileHidden.current = held; return; }
    if (!held || !pane || observeRef.current || fixedGridRef.current || chatViewRef.current) return;
    if (keyboardHoldsRef.current(true) || keptUndriven()) return;
    const term = termRef.current;
    try {
      fitRef.current?.fit();
      fittedRef.current();
    } catch {
      return;
    }
    if (term && sizesPty() && inUse()) socketRef.current?.resize(pane, term.cols, term.rows);
  }, [covered]);
  useEffect(() => {
    const socket = socketRef.current;
    if (!covered || socket === null) return;
    return socket.onBeforeReplay(() => {
      const pane = paneRef.current;
      if (pane !== null && socket.holdsSize(pane)) socket.keepSize(pane, false);
    });
  }, [covered]);

  const wasFollowing = useRef(follow);
  useEffect(() => {
    if (wasFollowing.current === follow) return;
    wasFollowing.current = follow;
    const pane = paneRef.current;
    const term = termRef.current;
    if (!pane || !term || observeRef.current || fixedGridRef.current) {
      if (fixedGridRef.current || observeRef.current) followCursorRef.current();
      return;
    }
    if (follow) {
      socketRef.current?.keepSize(pane);
      const shared = sharedGridRef.current;
      if (shared && (term.cols !== shared.cols || term.rows !== shared.rows)) term.resize(shared.cols, shared.rows);
      followCursorRef.current();
      return;
    }
    followCursorRef.current();
    if (chatViewRef.current || keyboardHoldsRef.current(true) || keptUndriven()) return;
    try {
      fitRef.current?.fit();
      fittedRef.current();
    } catch {
      return;
    }
    if (sizesPty() && inUse()) socketRef.current?.resize(pane, term.cols, term.rows, true);
  }, [follow]);
}
