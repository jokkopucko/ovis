import { useEffect, useRef, type RefObject } from "react";
import type { TerminalColors } from "./themes.ts";
import { type FontSettled, loadFontStack, measurableFontStack, monoFaceArrived, openingFontStack, terminalFontStack } from "./fontFamily.ts";
import { modalOpen } from "./focus.ts";
import { addServedFonts } from "./userFonts.ts";
import { inUse } from "./paneTerminalShared.ts";
import { fitLineHeight } from "./terminalLineHeight.ts";
import type { TerminalPeek } from "./terminalPeek.ts";
import type { HerdrSocket } from "./ws.ts";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { typeAheadFocused } from "./typeAhead.ts";

export interface TerminalRefitsDeps {
  activeRef: RefObject<boolean>;
  autoSelected: boolean;
  baseFontRef: RefObject<number>;
  pinchingRef: RefObject<boolean>;
  fontSettledRef: RefObject<FontSettled>;
  chatView: boolean;
  chatViewRef: RefObject<boolean>;
  coarseRef: RefObject<boolean>;
  findOpenRef: RefObject<boolean>;
  fitRef: RefObject<FitAddon | null>;
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
  termRef: RefObject<Terminal | null>;
  terminalFontFamily: string;
  terminalFontSize: number;
}

export function useTerminalRefits(deps: TerminalRefitsDeps): void {
  const { activeRef, autoSelected, baseFontRef, pinchingRef, fontSettledRef, chatView, chatViewRef, coarseRef, findOpenRef, fitRef, fittedRef, fixedGridRef, follow, followCursorRef, keyboardHoldsRef, narrowFont, narrowFontFitted, observeRef, colors, paneRef, peekRef, sharedGridRef, shown, sizesPty, socketRef, termRef, terminalFontFamily, terminalFontSize } = deps;
  // the theme follows the settings without a remount
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
    // a face can arrive while two fingers pinch: the pinch keeps its live size, and the pty is sized
    // once, when they lift (useTerminalMount.ts, finishPinch)
    const apply = (): void => {
      // a newer font, or an unmounted terminal, took over while the faces loaded
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
      if (observeRef.current || fixedGridRef.current || chatViewRef.current || keyboardHoldsRef.current(true)) return;
      try {
        fitRef.current?.fit();
        fittedRef.current();
      } catch {
        return;
      }
      // a chosen font loads after every attach: out of use (a reload behind another app), only
      // this grid fits, and the refit takes the pane once the user is here
      const pane = paneRef.current;
      if (!pinching && pane && sizesPty() && inUse()) socketRef.current?.resize(pane, term.cols, term.rows, true);
    };
    // the built-in stack too: its first text font is the bundled face, which the terminal opened without until it loaded.
    // A face slower than the load's timeout is set when it arrives, however late. A family this PC serves from its
    // fonts/ folder is on the page first (lib/userFonts.ts), so the cell is measured from it
    void addServedFonts(terminalFontFamily).then(() => loadFontStack(fontFamily, terminalFontSize)).then(() => {
      // a newer font's effect settles the first font once its own faces are in
      if (superseded) return;
      apply();
      // the first fit and the pty's first size waited for this font (usePaneAttach.ts)
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
    if (!term || observeRef.current || fixedGridRef.current || chatViewRef.current || keyboardHoldsRef.current(false)) return;
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
      // a grid this tab drove goes back to a terminal still showing on another device (#472)
      if (pane) socketRef.current?.releaseSize(pane);
      // the grid another device left the pty at while this one showed the terminal
      const shared = sharedGridRef.current;
      const hidden = termRef.current;
      if (shared && hidden && !observeRef.current && (hidden.cols !== shared.cols || hidden.rows !== shared.rows)) hidden.resize(shared.cols, shared.rows);
      return;
    }
    if (observeRef.current || fixedGridRef.current) return;
    // the composer's keyboard may still be up as the terminal lens appears: its grid waits for it to go
    if (keyboardHoldsRef.current(true)) return;
    const term = termRef.current;
    try {
      fitRef.current?.fit();
      fittedRef.current();
    } catch {
      return;
    }
    // this runs on every load too, right after the attach: out of use (a reload behind another
    // app), only this grid fits, and the refit takes the pane once the user is here
    const pane = paneRef.current;
    if (pane && term && sizesPty() && inUse()) socketRef.current?.resize(pane, term.cols, term.rows, true);
    // a peek opened from what the reader just sent or pressed: its keys (Escape above all) go to the agent
    // keys typed ahead for a new tab hold the keyboard until its hand-over gives it to the terminal (lib/typeAhead.ts)
    if (activeRef.current && (!autoSelected || peekRef.current !== null) && !coarseRef.current && !modalOpen() && !findOpenRef.current && !typeAheadFocused()) term?.focus();
  }, [chatView]);

  // hidden behind another pane of its split, the pane keeps the size the pty has; shown again, it
  // fits this screen and takes the pty, as a lens switch back to the terminal does
  const wasShown = useRef(shown);
  useEffect(() => {
    if (wasShown.current === shown) return;
    wasShown.current = shown;
    const pane = paneRef.current;
    if (!pane || observeRef.current || fixedGridRef.current || chatViewRef.current) return;
    if (!shown) { socketRef.current?.keepSize(pane); return; }
    if (keyboardHoldsRef.current(true)) return;
    const term = termRef.current;
    try {
      fitRef.current?.fit();
      fittedRef.current();
    } catch {
      return;
    }
    if (term && sizesPty() && inUse()) socketRef.current?.resize(pane, term.cols, term.rows, true);
  }, [shown]);

  // the split's other half took this tab's grid: this half lets the pty go and draws it at that grid;
  // made the active half, it fits its own screen and takes the pty, as a pane shown again does
  const wasFollowing = useRef(follow);
  useEffect(() => {
    if (wasFollowing.current === follow) return;
    wasFollowing.current = follow;
    const pane = paneRef.current;
    const term = termRef.current;
    if (!pane || !term || observeRef.current || fixedGridRef.current) {
      // a mirror's grid stays herdr's, a watched one the pty's: the half made active, or following, only folds it again or not
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
    if (chatViewRef.current || keyboardHoldsRef.current(true)) return;
    try {
      fitRef.current?.fit();
      fittedRef.current();
    } catch {
      return;
    }
    if (sizesPty() && inUse()) socketRef.current?.resize(pane, term.cols, term.rows, true);
  }, [follow]);
}
