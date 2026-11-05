import { useEffect, useLayoutEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { HerdrSocket } from "./ws.ts";
import { EMPTY_DRAFT, holdBefore, restoreDraft, type InputDraft } from "./draft.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { holdViews, inUse } from "./paneTerminalShared.ts";
import { modalOpen } from "./focus.ts";
import type { PendingMessageView } from "./pendingMessages.ts";
import { FONT_LOAD_TIMEOUT_MS, type FontSettled } from "./fontFamily.ts";

export interface PaneAttachDeps {
  activeRef: RefObject<boolean>;
  autoSelected: boolean;
  cached: boolean;
  watched: boolean;
  coarseRef: RefObject<boolean>;
  deferAttachRef: RefObject<(pane: string) => boolean>;
  fontSettledRef: RefObject<FontSettled>;
  draftPaneRef: RefObject<string | null>;
  findOpenRef: RefObject<boolean>;
  fitRef: RefObject<FitAddon | null>;
  fittedRef: RefObject<() => void>;
  fixedGridRef: RefObject<boolean>;
  frameGateRef: RefObject<{ reset: () => void }>;
  hyperlinksRef: RefObject<{ reset: () => void }>;
  hostRef: RefObject<HTMLDivElement | null>;
  machineId: string;
  mirrored: boolean | null;
  modifyOtherKeysRef: RefObject<number>;
  observeRef: RefObject<boolean>;
  paneId: string | null;
  pending: PendingMessageView[];
  presented: boolean;
  presentationRef: RefObject<() => void>;
  releaseRef: RefObject<() => void>;
  releasedRef: RefObject<boolean>;
  retireOutputRef: RefObject<() => void>;
  secretRef: RefObject<string | null>;
  setDraft: (value: InputDraft | ((previous: InputDraft) => InputDraft)) => void;
  setComposing: (active: boolean) => void;
  setEnded: Dispatch<SetStateAction<boolean>>;
  setHeld: (next: boolean) => void;
  setInputError: Dispatch<SetStateAction<string | null>>;
  setInputReady: Dispatch<SetStateAction<boolean>>;
  setOutputError: Dispatch<SetStateAction<string | null>>;
  setOutputReady: Dispatch<SetStateAction<boolean>>;
  setReleased: (next: boolean) => void;
  setSecret: Dispatch<SetStateAction<{ pane: string; prompt: string } | null>>;
  setUnsupported: Dispatch<SetStateAction<boolean>>;
  setWatching: (next: boolean) => void;
  sharedGridRef: RefObject<{ cols: number; rows: number } | null>;
  socketRef: RefObject<HerdrSocket | null>;
  stalledRef: RefObject<boolean>;
  terminalId: string | null;
  termRef: RefObject<Terminal | null>;
  chatViewRef: RefObject<boolean>;
  cancelLeaveRef: RefObject<() => void>;
  cachedRef: RefObject<boolean>;
  watchingRef: RefObject<boolean>;
  keyboardHoldsRef: RefObject<(force: boolean) => boolean>;
  followRef: RefObject<boolean>;
  /** decides the fold again and keeps the cursor in view (useTerminalMount) */
  followCursorRef: RefObject<() => void>;
  leaveRef: RefObject<() => void>;
  shownRef: RefObject<boolean>;
}

export function usePaneAttach(deps: PaneAttachDeps): void {
  const { activeRef, autoSelected, cached, watched, coarseRef, deferAttachRef, fontSettledRef, draftPaneRef, findOpenRef, fitRef, fittedRef, fixedGridRef, frameGateRef, hyperlinksRef, hostRef, machineId, mirrored, modifyOtherKeysRef, observeRef, paneId, pending, presented, presentationRef, releaseRef, releasedRef, retireOutputRef, secretRef, setDraft, setComposing, setEnded, setHeld, setInputError, setInputReady, setOutputError, setOutputReady, setReleased, setSecret, setUnsupported, setWatching, sharedGridRef, socketRef, stalledRef, terminalId, termRef, chatViewRef, cancelLeaveRef, cachedRef, watchingRef, keyboardHoldsRef, followRef, followCursorRef, leaveRef, shownRef } = deps;

  // Reset on a pane or terminal replacement: a herdr restart can keep the pane ID.
  // Old composition timers must never see the new terminal.
  useLayoutEffect(() => {
    const socket = socketRef.current;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!socket || !term) return;
    setEnded(false);
    setInputReady(false);
    setInputError(null);
    setComposing(false);
    setOutputReady(false);
    setOutputError(null);
    stalledRef.current = false;
    setHeld(false);
    setUnsupported(false);
    fixedGridRef.current = false;
    sharedGridRef.current = null;
    // the next pane's grid is this browser's again unless it says otherwise (pane-geometry)
    hostRef.current?.toggleAttribute("data-adopted-grid", observeRef.current);
    secretRef.current = null;
    setSecret(null);
    term.options.disableStdin = observeRef.current;
    // a record past its TTL, an undated one, and a hand-edited one all restore as nothing held
    let saved = EMPTY_DRAFT;
    try {
      saved = paneId ? restoreDraft(paneLifetimes.paneStorage.getItem(`ovis:terminal-draft:${paneStorageId(machineId, paneId)}`), Date.now()) : EMPTY_DRAFT;
    } catch {}
    // typing a connection ended with unconfirmed while no terminal of this pane was mounted (#2587)
    setDraft(holdBefore(paneId ? socket.takeUnconfirmedInput(paneId) : [], saved));
    draftPaneRef.current = paneId;
    term.reset();
    retireOutputRef.current();
    frameGateRef.current.reset();
    hyperlinksRef.current.reset();
    modifyOtherKeysRef.current = 0;
    // the fold is decided again for this pane (lib/terminalFold.ts), and the pane menu forgets the last one's width
    followCursorRef.current();
    if (!paneId) return;
    const leavePane = (): void => {
      cancelLeaveRef.current();
      // a released pane was detached already
      if (!releasedRef.current) socket.detach(paneId);
      if (watchingRef.current) {
        socket.unwatch(paneId);
        setWatching(false);
      }
      // Keep connection proof until the server confirms the detach as held.
    };
    // A fresh background pane must not acquire size ownership even with the release setting off.
    // This also covers a replacement pane: no prior release or input ownership is inherited.
    setReleased(false);
    // A restored terminal in a cached tab waits until that tab is presented again.
    if (cachedRef.current) {
      setReleased(true);
      return leavePane;
    }
    if (deferAttachRef.current(paneId)) return leavePane;
    // the hidden tabs' views start or stop once this pane drew: herdr serves its attach first (paneTerminalShared.ts)
    if (presented) holdViews();
    const attach = (): void => {
      // under the keyboard (a pane picked while typing) the fit waits for it to go, and the attach adopts
      // the pane's size meanwhile
      const held = keyboardHoldsRef.current(true);
      if (!held) {
        try {
          fit?.fit();
          fittedRef.current();
        } catch {
          /* not laid out yet; the ResizeObserver will follow up */
        }
      }
      // A pane exempt from watching still asks to keep an existing attachment's size while away.
      const away = !inUse();
      socket.attach(paneId, term.cols, term.rows, chatViewRef.current || away || !shownRef.current || followRef.current || held);
      // no blur or hidden comes for a tab already out of use: it lets go of this pane after a moment too
      if (away) leaveRef.current();
      // the chat lens covers the grid and its composer takes the keyboard: focusing the hidden
      // grid sent the keys straight to the pane, and showed a phone's IME text mid-screen
      if (activeRef.current && !chatViewRef.current && !autoSelected && !coarseRef.current && !modalOpen() && !findOpenRef.current) term.focus();
    };
    const font = fontSettledRef.current;
    if (font.done) {
      attach();
      return leavePane;
    }
    // A new terminal's first font is still loading (the bundled face, fonts/fonts.css): the first fit
    // and the size the pty is attached at wait for it, within the font effect's own bound, so the pane
    // is not sized for a fallback's cell and then again for the face's (two SIGWINCHes, a reflow).
    // The backstop only covers a font effect that never ran.
    let gone = false;
    let attached = false;
    let backstop: ReturnType<typeof setTimeout> | undefined;
    void Promise.race([font.settled, new Promise<void>((resolve) => { backstop = setTimeout(resolve, FONT_LOAD_TIMEOUT_MS + 1000); })]).then(() => {
      clearTimeout(backstop);
      if (gone || termRef.current !== term || socketRef.current !== socket) return;
      // the pane was cached, let go of (released, and maybe watched) or taken up again (resume
      // attaches it) while the font loaded: the release and resume own its attach from there
      if (cachedRef.current || releasedRef.current || socket.isAttached(paneId)) return;
      attached = true;
      attach();
    });
    return () => {
      gone = true;
      clearTimeout(backstop);
      // the pane is left as an attached one is: whoever attached or watched it meanwhile
      if (attached || socket.isAttached(paneId) || watchingRef.current) leavePane();
    };
  }, [paneId, terminalId]);

  // the message the tab kept its pane for has gone (or was held): out of use, it lets go now
  useEffect(() => { releaseRef.current(); }, [pending]);
  useEffect(() => { presentationRef.current(); }, [cached, watched, presented, mirrored]);
}
