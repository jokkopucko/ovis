import { useLayoutEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { Terminal, type ILinkProvider } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { HerdrSocket, markTyped } from "./ws.ts";
import { sendInOrder } from "./sendInOrder.ts";
import { MachineSession, type MachineSessionRegistry } from "./machineSession.ts";
import { disposeAfterPendingFrame } from "./terminalDispose.ts";
import { clipboardKey, hasModifiers, physicalKey, terminalChord, navigationSequence, keyFromData, ctrlEnterSequence, mirroredCtrlEnterKey, modifyOtherKeysLevel, NO_STICKY_MODIFIERS, type StickyModifiers } from "./keys.ts";
import { EMPTY_DRAFT, applyToDraft, draftIsEmpty, holdBefore, type InputDraft } from "./draft.ts";
import { pendingMessages } from "./pendingMessages.ts";
import { FrameGate } from "./inputRow.ts";
import { AttachmentTooLargeError, assertAttachable, fetchPaneConversation, fetchPaneScroll, fetchPaneSelection, scrollPane } from "./api.ts";
import { parseOsc52 } from "./osc52.ts";
import { reserveOsc52Copy, type Osc52Reservation } from "./osc52Clipboard.ts";
import { matchHerdrWidths } from "./terminalWidths.ts";
import { unwrapAgentRows } from "./agentCopy.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { createSecretScreen } from "./secretScreen.ts";
import { TERMINAL_HISTORY_LINES } from "../../shared/terminal-flow.ts";
import type { ClientRole, ServerMessage } from "../../shared/protocol.ts";
import type { Settings } from "./settings.ts";
import type { TerminalColors } from "./themes.ts";
import { measurableFontStack, openingFontStack, TERMINAL_FONT_STACK } from "./fontFamily.ts";
import type { Translate } from "./i18n.ts";
import { isAppShortcut, isMacPlatform } from "./shortcuts.ts";
import { keyboardHoldsGrid, keyboardUp } from "./keyboard.ts";
import { fileUriPath } from "../../shared/fileUri.ts";
import { isWebLink, openExternal } from "./externalLink.ts";
import { bareNameLinks, hyperlinkFilter, terminalFileLinkProvider, terminalFileLinks } from "./terminalFileLinks.ts";
import { shouldOpenWebPage } from "./webPanel.ts";
import { adjustTerminalGlyphs } from "./terminalGlyphs.ts";
import { fitLineHeight } from "./terminalLineHeight.ts";
import { keepDeleteRepeatText, keyboardNeedsText, restoreDeleteRepeatCaret } from "./deleteRepeat.ts";
import { pinchFontSize } from "./pinchFontSize.ts";
import { narrowPaneFontSize } from "./narrowPaneFont.ts";
import { finalStep, HERDR_MOUSE_SCROLL_LINES, wheelSteps } from "./wheelSteps.ts";
import { createTouchFling, createVelocityTracker } from "./touchFling.ts";
import { createTouchWheelPacer } from "./touchWheelPacer.ts";
import { attachTerminalWheel, canPanTerminalGrid } from "./terminalWheel.ts";
import { createTerminalFold, dimmedColor, wideGridKey, wideGrids } from "./terminalFold.ts";
import { screenRows, terminalScreen, viewRows } from "./terminalScreen.ts";
import { hyperlinkProvider } from "./ghostty/hyperlinks.ts";
import { userInputTracker } from "./terminalReplies.ts";
import { visibleTerminalInputBounds } from "./terminalViewport.ts";
import type { PaneSubmitRetention } from "./paneSubmitRetention.ts";
import type { ShortcutOverrides } from "./shortcutBindings.ts";
import { takeTypeAhead, type CaughtKey } from "./typeAhead.ts";
import { RESIZE_SETTLE_MS, RELEASE_AFTER_MS, IDLE_RELEASE_MS, RESUME_INPUT_WAIT_MS, VIEW_BUFFER_MAX, afterSwitch, dropViewChange, holdViews, inUse, keepsCoreGrid as keptCoreGrid, takeKeptCoreGrid, connectedSockets, plainError, releaseViews, setTerminalTimeout, CONTROL_CHARACTER } from "./paneTerminalShared.ts";
import { copyOnSelect, herdrUiKnown, loadHerdrUi } from "./herdrUi.ts";
import { captureForGhostty } from "./ghostty/capture.ts";
import { holdForPictures } from "./terminalImages.ts";

/**
 * Build-time constant: on only in the browser lane's demo build (lib/crashProbe.ts). Read it through
 * `typeof`: fixture bundles built with Bun.build (scripts/chat-history-fixture.tsx) do not define it.
 */
declare const __HERDR_TEST_HOOKS__: boolean;

/** `automatic`: xterm made the input itself (a query's answer), nobody typed it */
/** `typedAt`: when it was captured (markTyped): what waited goes only over a link up since then (HerdrSocket.takesKey) */
type Typed = { input: string; keys: string[] | null; chord: boolean; stop: boolean; secret: boolean; typedAt: number; arrowModeEpoch?: number | null; automatic?: boolean };

export interface TerminalMountDeps {
  activeRef: RefObject<boolean>;
  /** the pane's agent as herdr reports it: OpenCode, and Codex where codexDrag is on, take a plain drag themselves (onMouseDown) */
  agentRef: RefObject<string | null>;
  barKeyRef: RefObject<{ key: string; chord: string | null; } | null>;
  baseFontRef: RefObject<number>;
  pinchingRef: RefObject<boolean>;
  cachedRef: RefObject<boolean>;
  watchedRef: RefObject<boolean>;
  cachedReleaseRef: RefObject<boolean>;
  cancelLeaveRef: RefObject<() => void>;
  cancelTouchRef: RefObject<() => void>;
  chatMountedRef: RefObject<boolean>;
  chatOutputRef: RefObject<(() => void) | null>;
  chatViewRef: RefObject<boolean>;
  clearModifiers: () => void;
  consumeModifiers: () => void;
  clipboardTimerRef: RefObject<number | null>;
  coarseRef: RefObject<boolean>;
  /** sends a pending Safari syllable or dictation phrase as an IME commit, ahead of a chord */
  commitPendingText: () => void;
  composingRef: RefObject<boolean>;
  compositionCommitPendingRef: RefObject<boolean>;
  deferAttachRef: RefObject<(pane: string) => boolean>;
  draftHeldForRef: RefObject<string | null>;
  draftPaneRef: RefObject<string | null>;
  endedRef: RefObject<boolean>;
  findOpenRef: RefObject<boolean>;
  fitRef: RefObject<FitAddon | null>;
  fittedRef: RefObject<() => void>;
  fixedGridRef: RefObject<boolean>;
  followCursorRef: RefObject<() => void>;
  followRef: RefObject<boolean>;
  frameGateRef: RefObject<FrameGate>;
  heldRef: RefObject<boolean>;
  hostRef: RefObject<HTMLDivElement | null>;
  hyperlinksRef: RefObject<ReturnType<typeof hyperlinkFilter>>;
  keyboardHoldsRef: RefObject<(force: boolean) => boolean>;
  keyboardToggleFocusRef: RefObject<boolean>;
  leaveRef: RefObject<() => void>;
  typeAheadRef: RefObject<(pane: string) => void>;
  lineScroll: RefObject<((lines: number) => void) | null>;
  machineId: string;
  machineSessions: MachineSessionRegistry | null;
  mirroredRef: RefObject<boolean | null>;
  mirrorWrapRef: RefObject<boolean>;
  modifiersRef: RefObject<StickyModifiers>;
  modifyOtherKeysRef: RefObject<number>;
  narrowFontRef: RefObject<boolean>;
  noteClipboard: (note: string) => void;
  observeRef: RefObject<boolean>;
  onChatSuggestion: (pane: string, value: string | null) => void;
  onInputRowFrameRef: RefObject<() => void>;
  onRoleAckRef: RefObject<((mode: ClientRole) => void) | undefined>;
  onServerMessageRef: RefObject<((message: ServerMessage) => void) | undefined>;
  openFileRef: RefObject<((path: string) => void) | null>;
  openWebRef: RefObject<(uri: string, shiftKey: boolean) => boolean>;
  reuseExternalLinkTabRef: RefObject<boolean>;
  osc52AllowedRef: RefObject<boolean>;
  codexDragRef: RefObject<boolean>;
  setTerminalHistory: (keeps: boolean) => void;
  picturesChoiceRef: RefObject<boolean | null>;
  outputTargetRef: RefObject<string>;
  colors: TerminalColors;
  paneRef: RefObject<string | null>;
  pendingEpochRef: RefObject<number>;
  pendingScopeRef: RefObject<string | null>;
  pendingSubmissionsRef: RefObject<Set<{ pane: string; socket: HerdrSocket; epoch: number; }>>;
  pinchBadgeRef: RefObject<HTMLSpanElement | null>;
  pinchStatusRef: RefObject<HTMLSpanElement | null>;
  presentationRef: RefObject<() => void>;
  presentedRef: RefObject<boolean>;
  reassertIfStaleRef: RefObject<() => void>;
  reattachRef: RefObject<() => void>;
  redrawGreeting: () => void;
  releaseAwayRef: RefObject<boolean>;
  idleReleaseRef: RefObject<boolean>;
  setIdleView: (next: boolean) => void;
  releaseRef: RefObject<() => void>;
  releasedRef: RefObject<boolean>;
  retireOutputRef: RefObject<() => void>;
  secretRef: RefObject<string | null>;
  sessionRef: RefObject<MachineSession | null>;
  setChatInvalidation: Dispatch<SetStateAction<number>>;
  setChatRefresh: Dispatch<SetStateAction<number>>;
  setChatSent: Dispatch<SetStateAction<number>>;
  setComposing: (active: boolean) => void;
  setConnected: Dispatch<SetStateAction<boolean>>;
  setConnectedBefore: Dispatch<SetStateAction<boolean>>;
  setConversationPushes: Dispatch<SetStateAction<boolean>>;
  setDraft: (value: InputDraft | ((previous: InputDraft) => InputDraft)) => void;
  setEnded: Dispatch<SetStateAction<boolean>>;
  setHeld: (next: boolean) => void;
  setInputError: Dispatch<SetStateAction<string | null>>;
  setInputReady: Dispatch<SetStateAction<boolean>>;
  setObserving: Dispatch<SetStateAction<boolean>>;
  setOutputError: Dispatch<SetStateAction<string | null>>;
  setOutputReady: Dispatch<SetStateAction<boolean>>;
  setParsedTarget: Dispatch<SetStateAction<string | undefined>>;
  setReleased: (next: boolean) => void;
  setSecret: Dispatch<SetStateAction<{ pane: string; prompt: string; unchecked: boolean } | null>>;
  setSelectionQuote: Dispatch<SetStateAction<{ pane: string; text: string; range: { start: number; end: number; } | null; } | null>>;
  setTerminal: Dispatch<SetStateAction<Terminal | null>>;
  setUnsupported: Dispatch<SetStateAction<boolean>>;
  setWatching: (next: boolean) => void;
  setViewHeld: (held: boolean) => void;
  sharedGridRef: RefObject<{ cols: number; rows: number; } | null>;
  shortcutSettings: RefObject<ShortcutOverrides>;
  shownRef: RefObject<boolean>;
  coveredRef: RefObject<boolean>;
  sizesPty: () => boolean;
  socketRef: RefObject<HerdrSocket | null>;
  stackRef: RefObject<HTMLDivElement | null>;
  stalledRef: RefObject<boolean>;
  stopKeyRef: RefObject<number | null>;
  submitRetention: PaneSubmitRetention | null;
  t: Translate;
  tRef: RefObject<Translate>;
  termRef: RefObject<Terminal | null>;
  terminalFontSize: number;
  updateSettings: (patch: Partial<Settings>) => void;
  uploadFileRef: RefObject<(pane: string, image: Blob) => Promise<string>>;
  /** set here: files picked from the key bar's Attach files key, stored and pasted as a drop's are, while
   * `still()` holds when they are stored (the pane, connection, input lease and mode they were picked for) */
  attachFilesRef: RefObject<(files: File[], still: () => boolean) => void>;
  watchingRef: RefObject<boolean>;
  wheelStateRef: RefObject<{ speed: number; omoQuestion: boolean; }>;
}

export function useTerminalMount(deps: TerminalMountDeps): void {
  const { setTerminalHistory, picturesChoiceRef, typeAheadRef, activeRef, agentRef, barKeyRef, baseFontRef, pinchingRef, cachedRef, watchedRef, cachedReleaseRef, cancelLeaveRef, cancelTouchRef, chatMountedRef, chatOutputRef, chatViewRef, clearModifiers, clipboardTimerRef, coarseRef, commitPendingText, composingRef, compositionCommitPendingRef, consumeModifiers, deferAttachRef, draftHeldForRef, draftPaneRef, endedRef, findOpenRef, fitRef, fittedRef, fixedGridRef, followCursorRef, followRef, frameGateRef, heldRef, hostRef, hyperlinksRef, keyboardHoldsRef, keyboardToggleFocusRef, leaveRef, lineScroll, machineId, machineSessions, mirroredRef, mirrorWrapRef, modifiersRef, modifyOtherKeysRef, narrowFontRef, noteClipboard, observeRef, onChatSuggestion, onInputRowFrameRef, onRoleAckRef, onServerMessageRef, openFileRef, openWebRef, reuseExternalLinkTabRef, osc52AllowedRef, codexDragRef, outputTargetRef, colors, paneRef, pendingEpochRef, pendingScopeRef, pendingSubmissionsRef, pinchBadgeRef, pinchStatusRef, presentationRef, presentedRef, reassertIfStaleRef, reattachRef, redrawGreeting, releaseAwayRef, idleReleaseRef, setIdleView, releaseRef, releasedRef, retireOutputRef, secretRef, sessionRef, setChatInvalidation, setChatRefresh, setChatSent, setComposing, setConnected, setConnectedBefore, setConversationPushes, setDraft, setEnded, setHeld, setInputError, setInputReady, setObserving, setOutputError, setOutputReady, setParsedTarget, setReleased, setSecret, setSelectionQuote, setTerminal, setUnsupported, setViewHeld, setWatching, sharedGridRef, shortcutSettings, shownRef, coveredRef, sizesPty, socketRef, stackRef, stalledRef, stopKeyRef, submitRetention, t, tRef, termRef, terminalFontSize, updateSettings, uploadFileRef, attachFilesRef, watchingRef, wheelStateRef } = deps;

    // Where this terminal is: its pane, and whether it is active, presented, shown and not the chat view.
    // Counted on every commit that changes it: an explicit copy still waiting for herdr's text is
    // cancelled when the user leaves, even to come back (the copy made on release still finishes).
    const viewRef = useRef({ key: "", changes: 0 });
    /** set while text composed before input was ready is committed: it goes to the draft, not the pane */
    const holdPendingTextRef = useRef(false);
    useLayoutEffect(() => {
      const key = JSON.stringify([paneRef.current, activeRef.current, presentedRef.current, shownRef.current, chatViewRef.current]);
      if (key === viewRef.current.key) return;
      viewRef.current.key = key;
      viewRef.current.changes++;
    });
    useLayoutEffect(() => {
      const host = hostRef.current;
      if (!host) return;

      // xterm activates a link whenever a press and its release land on it: a drag that selects
      // part of a path and a right click do too, and neither means "open this"
      const linkPressed = (event: MouseEvent): boolean => event.button === 0 && !terminalScreen(term).hasSelection();
      const reuseTab = (event: MouseEvent): boolean => reuseExternalLinkTabRef.current && !event.metaKey && !event.ctrlKey && !event.altKey;
      const shouldOpenInPanel = (event: MouseEvent, uri: string): boolean =>
        shouldOpenWebPage(event, uri, (target, shiftKey) => openWebRef.current?.(target, shiftKey) ?? false, machineId);
      // an OSC 8 hyperlink's target: a file opens in the viewer, an http(s) address as a web link, and nothing else
      const openHyperlink = (event: MouseEvent, uri: string): void => {
        if (!linkPressed(event)) return;
        const path = fileUriPath(uri);
        if (path !== null) openFileRef.current?.(path);
        else if (isWebLink(uri) && !shouldOpenInPanel(event, uri)) openExternal(uri, "link", reuseTab(event));
      };
      const term = new Terminal({
        convertEol: false,
        // a program's own DECSCUSR still changes the cursor
        cursorStyle: "block",
        cursorBlink: true,
        // xterm keeps no scrollback: the attach stream lives in the alternate screen and herdr
        // owns scrollback (wheel and touch go to it). With scrollback on, the fit addon reserves
        // a scrollbar column - 15px by fallback wherever scrollbars are overlays - and the last
        // columns of the hero surface go dead. On herdr-core xterm keeps the history (syncHistory).
        scrollback: 0,
        allowProposedApi: true,
        fontSize: terminalFontSize,
        fontFamily: measurableFontStack(openingFontStack(TERMINAL_FONT_STACK)),
        theme: { ...colors },
        // a program's own colors suit one background (Claude Code's question titles are #ffffff, near
        // 1:1 on a light palette): xterm moves a foreground under 4.5:1 toward black or white. Dim text
        // needs half that, and box, block and powerline glyphs keep their color.
        minimumContrastRatio: 4.5,
        linkHandler: {
          activate: openHyperlink,
          allowNonHttpProtocols: true,
        },
        // Option+drag selects on macOS, as Shift+drag does elsewhere; a plain drag is forced below
        macOptionClickForcesSelection: true,
      });
      fitLineHeight(term);
      const fit = new FitAddon();
      // Every fit first settles the font: a split pane under 80 columns draws smaller to reach
      // them (btop refuses a narrower screen), and returns to the user's size once it is wide enough.
      const fitGrid = fit.fit.bind(fit);
      fit.fit = (): void => {
        if (followRef.current) return;
        const base = baseFontRef.current;
        const colsAt = (size: number): number | null => {
          term.options.fontSize = size;
          const cols = fit.proposeDimensions()?.cols;
          return cols !== undefined && Number.isFinite(cols) ? cols : null;
        };
        term.options.fontSize = narrowFontRef.current && !observeRef.current && !fixedGridRef.current ? narrowPaneFontSize(base, colsAt) : base;
        fitLineHeight(term);
        fitGrid();
      };
      term.loadAddon(fit);
      matchHerdrWidths(term);
      // libghostty's OSC 8 hyperlinks, first: where a hyperlink's label is an address too, its target is what opens, as with
      // xterm's own provider
      term.registerLinkProvider(hyperlinkProvider(() => viewRows(term), (uri) => isWebLink(uri) || fileUriPath(uri) !== null, openHyperlink));
      // the same policy as the linkHandler above: an http(s) address or nothing (S10). The addon reads the rows a link is
      // in through the terminal it is given: the rows drawn (viewRows), libghostty's while it holds the screen. It is not
      // loaded through the terminal (that would read xterm's buffer), so it is disposed with it below
      const webLinks = new WebLinksAddon((event, uri) => { if (isWebLink(uri) && !shouldOpenInPanel(event, uri)) openExternal(uri, "link", reuseTab(event)); });
      webLinks.activate({ registerLinkProvider: (provider: ILinkProvider) => term.registerLinkProvider(provider), buffer: { get active() { return viewRows(term); } } } as unknown as Terminal);
      const bareLinks = bareNameLinks(isMacPlatform());
      const onLinkKey = (event: KeyboardEvent | MouseEvent): void => bareLinks.update(event);
      const offLinkKey = (): void => bareLinks.reset();
      term.registerLinkProvider(terminalFileLinkProvider(() => viewRows(term), (path, event) => { if (linkPressed(event)) openFileRef.current?.(path); }, bareLinks));
      term.open(host);
      // xterm turns autocorrect, autocapitalize and spellcheck off on its helper textarea; an Android
      // keyboard still shows its word strip there unless the field also says autocomplete="off",
      // the one attribute Chrome turns into the keyboard's NO_SUGGESTIONS
      term.textarea?.setAttribute("autocomplete", "off");
      const syncInputViewport = (): void => {
        // every grid confines xterm's helper textarea and IME preedit to the host's visible box: a grid
        // this browser drives fits the host's width, so it never pans, yet a long preedit (a phone's voice
        // typing sends one, growing with every word) made the browser scroll the host sideways to keep the
        // helper's caret in view, and the whole grid slid off to the left and stayed there
        const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
        if (!screen) return;
        const hostRect = host.getBoundingClientRect();
        const visibleHost = {
          left: hostRect.left + host.clientLeft,
          top: hostRect.top + host.clientTop,
          right: hostRect.left + host.clientLeft + host.clientWidth,
          bottom: hostRect.top + host.clientTop + host.clientHeight,
          width: host.clientWidth,
          height: host.clientHeight,
        };
        term.setTextAreaViewportBounds(visibleTerminalInputBounds(visibleHost, screen.getBoundingClientRect()));
      };
      syncInputViewport();
      host.addEventListener("scroll", syncInputViewport, { passive: true });
      const inputViewportResize = term.onResize(syncInputViewport);
      const frameResize = term.onResize(() => frameGateRef.current.resized());
      const inputScreenResize = new ResizeObserver(syncInputViewport);
      const inputScreen = term.element?.querySelector<HTMLElement>(".xterm-screen");
      if (inputScreen) inputScreenResize.observe(inputScreen);
      let compositionEndTimer: number | null = null;
      compositionCommitPendingRef.current = false;
      const compositionStart = () => {
        if (compositionEndTimer !== null) window.clearTimeout(compositionEndTimer);
        compositionEndTimer = null;
        compositionCommitPendingRef.current = false;
        setComposing(true);
      };
      const compositionEnd = () => {
        if (compositionEndTimer !== null) window.clearTimeout(compositionEndTimer);
        // xterm's textarea listener queues its commit before this bubbling host listener.
        // Keep that commit on the text path; a new composition cancels this clear.
        compositionCommitPendingRef.current = true;
        setComposing(false);
        compositionEndTimer = window.setTimeout(() => {
          compositionEndTimer = null;
          compositionCommitPendingRef.current = false;
        }, 0);
      };
      host.addEventListener("compositionstart", compositionStart);
      host.addEventListener("compositionend", compositionEnd);
      // iOS repeats a held ⌫ only while the field has text and wraps (#862). These run after
      // xterm's own capturing listeners on its textarea, so they refill it once xterm emptied it.
      const textarea = term.textarea;
      const keepText = (event: Event): void => {
        if (!textarea || composingRef.current) return;
        if ((event instanceof KeyboardEvent || event instanceof InputEvent) && event.isComposing) return;
        if (event.type === "focus" || event.type === "keydown") restoreDeleteRepeatCaret(textarea);
        if (event instanceof KeyboardEvent && event.keyCode === 229) return;
        keepDeleteRepeatText(textarea);
      };
      const keepTextOn = textarea && keyboardNeedsText(navigator) ? ["focus", "keydown", "input"] : [];
      for (const type of keepTextOn) textarea?.addEventListener(type, keepText, true);
      if (textarea && keepTextOn.length) textarea.style.whiteSpace = "pre-wrap";
      const stopGlyphs = adjustTerminalGlyphs(term);
      // Let the browser emit a paste event, which xterm already handles (including
      // bracketed paste). Otherwise Ctrl+V becomes 0x16, triggering the agent's
      // image-paste shortcut against the server's clipboard and canceling text paste.
      // Returning false skips xterm's key handling without preventing browser defaults.
      // With text selected, Ctrl+C (and Ctrl+Shift+C) copies it instead of interrupting the pane.
      // A non-Latin layout (Korean, Russian...) reports its own character as the key, so the
      // physical key names the letter then; a Latin layout keeps its own (Dvorak's C is not KeyC).
      // An app shortcut is the app's alone: xterm would still type it, and Ctrl+Shift+↓ reached the
      // pane it had just switched to as ESC[1;6B.
      let typedChord: string | null = null;
      let releaseOnKeyUp: string | null = null;
      term.attachCustomKeyEventHandler((event) => {
        if (releaseOnKeyUp !== null && (event.type === "keyup" ? event.code === releaseOnKeyUp : event.type === "keydown" && event.code !== releaseOnKeyUp)) {
          releaseOnKeyUp = null;
          consumeModifiers();
        }
        if (isAppShortcut(event, shortcutSettings.current)) return false;
        if (hasModifiers(modifiersRef.current) && !term.options.disableStdin && !composingRef.current && !compositionCommitPendingRef.current
            && !event.isComposing && event.keyCode !== 229 && !event.metaKey) {
          const combined = {
            ctrl: modifiersRef.current.ctrl || event.ctrlKey,
            alt: modifiersRef.current.alt || event.altKey,
            shift: modifiersRef.current.shift || event.shiftKey,
          };
          // the chord names the key by its position on a non-Latin layout (ㅊ on KeyC is Ctrl+C)
          const chord = terminalChord(physicalKey(event.key, event.code), combined);
          const navigation = navigationSequence(event.key, combined);
          if (navigation !== null) {
            if (event.type === "keydown") { event.preventDefault(); commitPendingText(); term.input(navigation); releaseOnKeyUp = event.code; }
            return false;
          }
          const letter = clipboardKey(event.key, event.code);
          const clipboard = event.ctrlKey && !event.altKey && /^(c|v)$/.test(letter)
            && (letter === "v" || terminalScreen(term).hasSelection());
          if (chord !== null && !clipboard) {
            if (event.type === "keydown") {
              event.preventDefault();
              commitPendingText();
              typedChord = chord;
              // Go through the same readiness/role/secret checks as other input.
              term.input(event.key);
              typedChord = null;
              releaseOnKeyUp = event.code;
            }
            return false;
          }
        }
        if (!event.ctrlKey || event.altKey || event.metaKey) return true;
        const key = clipboardKey(event.key, event.code);
        if (key === "v") return false;
        if (key === "c" && terminalScreen(term).hasSelection()) {
          if (event.type === "keydown") {
            event.preventDefault();
            copySelection();
            term.clearSelection();
          }
          return false;
        }
        return true;
      });
      attachTerminalWheel(term, wheelStateRef, {
        drag: (event) => { if (!drag) return false; dragWheel(event); return true; },
        adopted: () => adopted(),
        mirrored: () => scrollableMirror(),
        pan: (event) => {
          if (!scrollableMirror() || !canPanTerminalGrid(host, event.deltaY)) return false;
          panned = true;
          return true;
        },
        scroll: (lines) => lineScroll.current?.(lines),
      });
      termRef.current = term;
      setTerminal(term);
      fitRef.current = fit;

      // A mirror has no cursor; xterm's own rests on the last row with text, which serves the same.
      // A page attached without sizing a herdr-core pty (away when it attached, or let go of the size since) draws it in
      // the pty's grid: in its own, a wrapped row or a taller screen put each redraw in rows the program never drew, and
      // the old frames stayed on screen. A grid held under the soft keyboard is the keyboard's to give back (keyboardHolds).
      const keepsCoreGrid = (): boolean => !keyboardHeld && keptCoreGrid(socketRef.current, paneRef.current);
      const adopted = (): boolean => observeRef.current || fixedGridRef.current || followRef.current || keepsCoreGrid();
      const scrollableMirror = (): boolean => fixedGridRef.current && !observeRef.current && !followRef.current;
      // The soft keyboard takes the bottom of the screen, not the pane: a fit to what is left above
      // it would size the shared pty to that strip, and every other viewer of the pane, herdr's own
      // window included, would reflow twice per keyboard (#1045). While the keyboard is up, a host
      // that only lost height keeps its grid and the view pans to the cursor as an adopted grid's
      // does; the fit it held back runs once the keyboard goes (the host grows, the observer fits).
      let keyboardHeld = false;
      let fittedWidth: number | null = null;
      let heldForce = false;
      let panned = false;
      // A grid wider than the screen that this browser does not size is drawn folded to its width
      // (lib/terminalFold.ts): a mirror (a Windows PC's pane keeps its size there and a phone cannot
      // change it), an attached pane this device only watches (the pty's grid, which another device
      // sized), or one held under the soft keyboard at another device's size until the keyboard goes.
      // A phone that drives the pty is never folded: the program redraws at its width. Nor is a split's
      // following half. A tap on folded rows opens a link or focuses the terminal, as on a mirror; it is
      // no mouse click for the program (herdr's attach always reports the mouse, so that cannot tell a
      // program that wants clicks): the pane menu's "Original width" draws the grid as it is again.
      // The folded rows keep the cursor's row in view, as the grid does: at the top while it fits there,
      // else at the bottom of the view (a cleared shell's prompt on the first row stays in sight).
      const followFold = (): void => {
        const bottom = fold.cursorBottom();
        if (bottom !== null) host.scrollTop = bottom <= host.clientHeight ? 0 : bottom - host.clientHeight;
      };
      const wideOwner = {};
      const fold = createTerminalFold(term, host, {
        foreign: () => (fixedGridRef.current || observeRef.current || keyboardHeld || keepsCoreGrid()) && !followRef.current,
        wrap: () => mirrorWrapRef.current,
        onWide: (wide) => {
          const current = paneRef.current;
          wideGrids.set(wideOwner, wide && current ? wideGridKey(machineId, current) : null);
        },
        onDrawn: () => {
          if (!panned) followFold();
          syncInputViewport();
        },
        onTap: () => {
          // folded rows are outside xterm's element, where a press takes the pane back (reclaim)
          reassertIfStaleRef.current();
          if (activeRef.current && !findOpenRef.current) term.focus();
        },
        onLink: (target, event) => {
          if (!linkPressed(event)) return false;
          if ("url" in target) {
            if (!isWebLink(target.url)) return false;
            if (!shouldOpenInPanel(event, target.url)) openExternal(target.url, "link", reuseTab(event));
            return true;
          }
          const buffer = viewRows(term);
          const uri = terminalScreen(term).hyperlinkAt(buffer.viewportY + target.row, target.col);
          if (uri !== null && (isWebLink(uri) || fileUriPath(uri) !== null)) {
            openHyperlink(event, uri);
            return true;
          }
          const y = buffer.viewportY + target.row + 1;
          const x = target.col + 1;
          const link = terminalFileLinks(buffer, y, (path, pressed) => { if (linkPressed(pressed)) openFileRef.current?.(path); }, bareLinks.pressed(event) ? bareLinks : undefined, () => viewRows(term))
            .find(({ range: { start, end } }) => (y > start.y || (y === start.y && x >= start.x)) && (y < end.y || (y === end.y && x <= end.x)));
          if (!link) return false;
          link.activate(event);
          return true;
        },
        onPan: () => { panned = true; },
      });
      const followCursor = (): void => {
        host.toggleAttribute("data-adopted-grid", adopted());
        const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
        if (!(adopted() || keyboardHeld) || panned || !screen) return;
        if (fold.active) {
          followFold();
          return;
        }
        const row = screen.offsetHeight / term.rows;
        const cursorBottom = screen.offsetTop + (viewRows(term).cursorY + 1) * row;
        const max = host.scrollHeight - host.clientHeight;
        host.scrollTop = cursorBottom <= host.clientHeight ? 0 : cursorBottom - row >= max ? max : cursorBottom - host.clientHeight;
      };
      followCursorRef.current = () => { panned = false; fold.sync(); followCursor(); };
      const keyboardHolds = (force: boolean): boolean => {
        if (!keyboardHoldsGrid(keyboardUp(), host.clientWidth, fittedWidth)) return false;
        keyboardHeld = true;
        heldForce ||= force;
        const shared = sharedGridRef.current;
        if (shared && !adopted() && (term.cols !== shared.cols || term.rows !== shared.rows)) {
          term.resize(shared.cols, shared.rows);
          heldForce = true;
        }
        panned = false;
        fold.sync();
        followCursor();
        return true;
      };
      const fitted = (): void => {
        fittedWidth = host.clientWidth;
        keyboardHeld = false;
        heldForce = false;
        // xterm's helper textarea can sit at the old grid's cursor row for a while and keep the host
        // scrollable: a view panned under the keyboard would stay panned past the grid's top
        host.scrollTop = 0;
        if (!adopted()) host.scrollLeft = 0;
        fold.sync();
        syncInputViewport();
      };
      keyboardHoldsRef.current = keyboardHolds;
      fittedRef.current = fitted;

      let copiedText: string | null = null;
      let said: { pane: string; texts: readonly string[] } | null = null;
      const readSaid = (pane: string): Promise<readonly string[]> => fetchPaneConversation(pane, machineId).then((answer) => {
        const texts = answer.source === "scrollback" ? [] : answer.turns.flatMap((turn) => turn.role === "assistant"
          ? turn.parts.flatMap((part) => part.kind === "text" ? [part.text] : []) : []);
        said = { pane, texts };
        return texts;
      }, () => []);
      const saidNow = (): readonly string[] => said !== null && said.pane === paneRef.current ? said.texts : [];
      const asCopied = (text: string, firstCol: number, texts: readonly string[]): string =>
        agentRef.current ? unwrapAgentRows(text, term.cols, firstCol, texts) : text;
      const visibleSelection = (): string => asCopied(terminalScreen(term).getSelection(), terminalScreen(term).getSelectionPosition()?.start.x ?? 0, saidNow());
      let selectionGeneration = 0;
      let disposed = false;
      // Run after xterm's own copy listener, including for Cmd+C and context-menu
      // Copy. Its buffer contains only the visible part of a scrolled selection.
      let awaitedText: { generation: number; text: Promise<string>; scrolled: boolean; reserved: boolean } | null = null;
      // An explicit copy made before herdr's text arrived writes that text when it does, reserved in
      // this gesture: the copy's own clearing of the selection must not leave the visible rows alone.
      const reserveAwaitedText = (): void => {
        const awaited = awaitedText;
        if (!awaited || awaited.reserved || awaited.generation !== selectionGeneration) return;
        if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return;
        awaited.reserved = true;
        const view = viewRef.current.changes;
        const left = (): boolean => disposed || viewRef.current.changes !== view;
        const blob = awaited.text.then((value) => {
          // left before herdr answered: this copy is cancelled, and the clipboard keeps the rows native copy took
          if (left()) throw new Error("left the pane");
          return new Blob([value], { type: "text/plain" });
        });
        void navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]).catch(() => {
          if (!left() && awaited.scrolled) noteClipboard(awaited.generation === selectionGeneration ? "copied the visible part; Copy or Ctrl+C copies the whole selection" : "clipboard write blocked by the browser");
        });
      };
      const onCopy = (event: ClipboardEvent): void => {
        if (!terminalScreen(term).hasSelection() || copiedText === null || !event.clipboardData) return;
        event.clipboardData.setData("text/plain", copiedText);
        event.preventDefault();
        reserveAwaitedText();
      };
      host.addEventListener("copy", onCopy);
      const copySelection = (): void => {
        const text = copiedText ?? visibleSelection();
        if (!text) return;
        reserveAwaitedText();
        // Native copy still works in a user gesture when a Chromium/PWA site has
        // denied the async clipboard permission, or plain HTTP has no clipboard API.
        if (document.execCommand("copy")) {
          noteClipboard("copied to clipboard");
          return;
        }
        if (!navigator.clipboard) {
          noteClipboard("clipboard write blocked by the browser");
          return;
        }
        void navigator.clipboard.writeText(text).then(
          () => { if (!disposed) noteClipboard("copied to clipboard"); },
          () => { if (!disposed) noteClipboard("clipboard write blocked by the browser"); },
        );
      };
      const selectionChange = term.onSelectionChange(() => {
        // a selection is the user's own copy: no program's copy fills the clipboard over it
        if (terminalScreen(term).hasSelection()) cancelCopy();
        else {
          copiedText = null;
          selectionGeneration++;
          setSelectionQuote(null);
        }
      });

      // herdr's attach stream turns mouse reporting on, so xterm hands every click to the
      // pty and selects only with Shift (Option on macOS) held. Selection lives in herdr's
      // own TUI client, not in `herdr terminal attach`, so a left drag here selects as if the
      // modifier were held, and letting go copies, as the herdr TUI does; a press let go in
      // place is a click and goes to the program (forwardClick). Touch keeps its drag-to-scroll.
      //
      // xterm keeps no scrollback (herdr owns it), so a drag that outlives one screen is
      // tracked in herdr's history rows: a wheel, or dragging past the top or bottom edge,
      // scrolls the pane through the API, the highlight is repainted over the visible part,
      // and letting go copies herdr's own text for the range, soft-wrapped lines joined.
      // Without the API (plain HTTP, observe mode, an older remote bridge, a failed read)
      // only the visible selection is copied, as xterm has it.
      interface Cell { row: number; col: number }
      interface Drag {
        pane: string;
        anchor: Cell;
        cursor: Cell;
        top: number | null;
        anchorRow: number;
        offset: number;
        maxOffset: number;
        scrolled: boolean;
        edge: -1 | 0 | 1;
        wheelPixels: number;
        sentOffset: number;
        sending: boolean;
        click: ClickKeys | null;
        said: Promise<readonly string[]> | null;
      }
      interface ClickKeys { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }
      const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
      let drag: Drag | null = null;
      let edgeTimer: number | null = null;
      const cellAt = (event: MouseEvent): { cell: Cell; edge: -1 | 0 | 1 } => {
        const rect = (term.element?.querySelector(".xterm-screen") ?? host).getBoundingClientRect();
        const col = Math.floor((event.clientX - rect.left) / (rect.width / term.cols));
        const row = Math.floor((event.clientY - rect.top) / (rect.height / term.rows));
        return {
          cell: { row: Math.max(0, Math.min(term.rows - 1, row)), col: Math.max(0, Math.min(term.cols - 1, col)) },
          edge: row < 0 ? -1 : row >= term.rows ? 1 : 0,
        };
      };
      const ordered = (a: Cell, b: Cell): [Cell, Cell] =>
        a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
      const historyRange = (d: Drag): [Cell, Cell] =>
        ordered({ row: d.anchorRow, col: d.anchor.col }, { row: d.top! + d.cursor.row, col: d.cursor.col });
      const repaint = (d: Drag): void => {
        const [start, end] = historyRange(d);
        const first = d.top!;
        const last = first + term.rows - 1;
        if (end.row < first || start.row > last) {
          term.clearSelection();
          return;
        }
        const from = start.row < first ? { row: 0, col: 0 } : { row: start.row - first, col: start.col };
        const to = end.row > last ? { row: term.rows - 1, col: term.cols - 1 } : { row: end.row - first, col: end.col };
        term.select(from.col, from.row, to.row * term.cols + to.col + 1 - (from.row * term.cols + from.col));
      };
      const sendScroll = (d: Drag): void => {
        if (d.sending || d.sentOffset === d.offset) return;
        d.sending = true;
        const target = d.offset;
        void scrollPane(d.pane, target, machineId).catch(() => {}).finally(() => {
          d.sending = false;
          d.sentOffset = target;
          sendScroll(d);
        });
      };
      const cellHeight = (): number =>
        (term.element?.querySelector(".xterm-screen")?.getBoundingClientRect().height ?? term.rows) / term.rows;
      const scrollDrag = (d: Drag, lines: number): void => {
        if (d.top === null) return;
        const offset = Math.max(0, Math.min(d.maxOffset, d.offset + lines));
        if (offset === d.offset) return;
        d.offset = offset;
        d.top = d.maxOffset - offset;
        d.scrolled = true;
        repaint(d);
        sendScroll(d);
      };
      const dragWheel = (event: WheelEvent): void => {
        const d = drag;
        if (!d || d.top === null) return;
        const lineHeight = cellHeight();
        const { steps: lines, rest } = wheelSteps(
          d.wheelPixels + (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * lineHeight : event.deltaY), lineHeight);
        d.wheelPixels = rest;
        if (lines === 0) return;
        scrollDrag(d, -lines);
      };
      const stopEdge = (): void => {
        if (edgeTimer !== null) window.clearInterval(edgeTimer);
        edgeTimer = null;
      };
      let programPress: { pane: string | null; cell: Cell; codex: boolean; moved: boolean } | null = null;
      const onMouseDown = (event: MouseEvent): void => {
        programPress = null;
        if (event.button !== 0 || !event.isTrusted) return;
        if ((event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents) return;
        if (!term.element?.contains(event.target as Node)) return;
        cancelCopy();
        // with reporting off xterm already selects on a plain drag; only the history tracking is ours
        const reporting = term.modes.mouseTrackingMode !== "none";
        const selecting = isMac ? event.altKey : event.shiftKey;
        const onLink = term.element?.querySelector(".xterm-screen")?.classList.contains("xterm-cursor-pointer") === true;
        // OpenCode reads the mouse and selects inside the panel a drag starts in, as in a native terminal
        // (#2362). Codex selects through the history of its alternate screen and scrolls it while a drag is
        // held past an edge, where Ovis's selection stops at the screen (#2384), but it copies only with OSC 52,
        // which herdr's attach drops: a device hands it the drag only by choice (Settings, codexDrag). A plain
        // press is the program's, drags included, as a click is, and it clears a selection made here. herdr
        // reports which agent runs, never a program's mouse mode, so this goes by the agent.
        const agent = agentRef.current;
        const selfSelecting = agent === "opencode" || (agent === "codex" && codexDragRef.current);
        if (reporting && selfSelecting && !event.shiftKey && !event.altKey && !onLink && !term.options.disableStdin) {
          term.clearSelection();
          programPress = { pane: paneRef.current, cell: cellAt(event).cell, codex: agent === "codex", moved: false };
          return;
        }
        const click: ClickKeys | null = reporting && !selecting && !onLink && !terminalScreen(term).hasSelection()
          ? { ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey } : null;
        if (reporting) Object.defineProperty(event, isMac ? "altKey" : "shiftKey", { value: true });
        copiedText = null;
        selectionGeneration++;
        setSelectionQuote(null);
        const pane = paneRef.current;
        const { cell } = cellAt(event);
        const d: Drag = {
          pane: pane ?? "", anchor: cell, cursor: cell, top: null, anchorRow: 0, offset: 0, maxOffset: 0,
          scrolled: false, edge: 0, wheelPixels: 0, sentOffset: 0, sending: false, click,
          said: pane && agentRef.current ? readSaid(pane) : null,
        };
        drag = d;
        if (!pane || !navigator.clipboard || observeRef.current) return;
        void fetchPaneScroll(pane, machineId).then((scroll) => {
          if (!scroll || drag !== d || d.scrolled) return;
          d.offset = d.sentOffset = scroll.offset_from_bottom;
          d.maxOffset = scroll.max_offset_from_bottom;
          d.top = d.maxOffset - d.offset;
          d.anchorRow = d.top + d.anchor.row;
        }, () => {});
      };
      // capture on window: ahead of xterm's own document listener, which would repaint a
      // scrolled drag from its stale screen anchor
      const onMouseMove = (event: MouseEvent): void => {
        const d = drag;
        if (!d) {
          if (programPress && !programPress.moved && (event.buttons & 1) !== 0) {
            const { cell, edge } = cellAt(event);
            programPress.moved = edge !== 0 || cell.row !== programPress.cell.row || cell.col !== programPress.cell.col;
          }
          // With herdr's copy_on_select off the selection is kept to be copied: a buttonless move over
          // the grid would reach the program as a hover report, and xterm clears its selection on any
          // input. herdr reports no moves to a pane holding a selection either. Copying on, the first
          // move clears the copied highlight as herdr's does, so Ctrl+C interrupts again.
          if (event.buttons === 0 && !copyOnSelect() && terminalScreen(term).hasSelection() && term.element?.contains(event.target as Node)) event.stopPropagation();
          return;
        }
        const { cell, edge } = cellAt(event);
        const grid = term.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
        const beside = grid !== undefined && (event.clientX < grid.left || event.clientX >= grid.right);
        if (beside || edge !== 0 || cell.row !== d.anchor.row || cell.col !== d.anchor.col) d.click = null;
        d.cursor = edge < 0 ? { row: 0, col: 0 } : edge > 0 ? { row: term.rows - 1, col: term.cols - 1 } : cell;
        if (d.top === null) return;
        if (edge !== d.edge) {
          d.edge = edge;
          stopEdge();
          if (edge !== 0) edgeTimer = window.setInterval(() => scrollDrag(d, -d.edge), 60);
        }
        if (d.scrolled || edge !== 0) {
          event.stopPropagation();
          d.scrolled = true;
          repaint(d);
        }
      };
      // A press that became no selection was a click, and a program that reads the mouse (a
      // close button in Claude Code's diff, a TUI's menu) expects it: herdr's attach forwards
      // left clicks to it, as a phone's tap already showed (#621). The press and release are
      // replayed without the selection modifier so xterm encodes them in the reporting mode
      // herdr asked for; xterm sends nothing while stdin is disabled (observing, a held pane).
      const forwardClick = (event: MouseEvent, keys: ClickKeys): void => {
        const target = event.target;
        if (!(target instanceof Element) || !term.element?.contains(target)) return;
        const init = { ...keys, bubbles: true, cancelable: true, view: window, button: 0, detail: 1, clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY };
        target.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1 }));
        target.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
      };
      // a release outside the window never arrives: stop scrolling the shared pane
      const onBlur = (): void => {
        stopEdge();
        drag = null;
        programPress = null;
      };
      const onMouseUp = (event: MouseEvent): void => {
        const d = drag;
        if (event.button !== 0) return;
        if (!d) {
          const press = programPress;
          programPress = null;
          if (press?.pane == null || press.pane !== paneRef.current) return;
          if (mayReserveCopy()) reserveCopy(press.pane);
          // Codex's drag made Codex's own selection: on herdr its copy never reaches this device, and Ovis
          // cannot quote what it cannot read, so the way that does both is said where the drag ended
          if (press.codex && press.moved && socketRef.current?.hasTerminalHistory() !== true) {
            const t = tRef.current; // the language of now, not of the attach
            noteClipboard(isMac ? t("Codex selected this: Option+drag copies or quotes it here") : t("Codex selected this: Shift+drag copies or quotes it here"));
          }
          return;
        }
        drag = null;
        stopEdge();
        // Window bubble runs after xterm's document listener, still inside the
        // release gesture. A timer here loses clipboard permission in some browsers.
        if (d.scrolled) repaint(d);
        const released = cellAt(event).cell;
        // released on the pane it was pressed on: a pane switched meanwhile gets no click of this press
        if (d.click && d.pane !== "" && d.pane === paneRef.current && !d.scrolled && !terminalScreen(term).hasSelection()
          && released.row === d.anchor.row && released.col === d.anchor.col) {
          forwardClick(event, d.click);
          if (mayReserveCopy()) reserveCopy(d.pane);
          return;
        }
        if (!terminalScreen(term).hasSelection()) return;
        const visibleText = visibleSelection();
        copiedText = visibleText;
        // herdr's copy_on_select: letting go copies, or only selects for Ctrl+C or Copy (herdr's text below either way)
        const autoCopy = copyOnSelect();
        if (autoCopy) copySelection();
        const generation = selectionGeneration;
        const current = (): boolean => !disposed && paneRef.current === d.pane && generation === selectionGeneration;
        if (d.pane !== "") setSelectionQuote({ pane: d.pane, text: visibleText, range: null });
        let range: [Cell, Cell] | null = null;
        if (d.scrolled) range = historyRange(d);
        else if (d.top !== null) {
          const position = terminalScreen(term).getSelectionPosition();
          if (position) {
            // xterm's end column is exclusive, herdr's inclusive
            const end = position.end.x > 0
              ? { row: d.top + position.end.y, col: position.end.x - 1 }
              : { row: d.top + position.end.y - 1, col: term.cols - 1 };
            range = [{ row: d.top + position.start.y, col: position.start.x }, end];
          }
        }
        if (!range) return;
        let fromHerdr = true;
        const start = range[0];
        const herdrText = fetchPaneSelection(d.pane, range[0], range[1], machineId).then(async (value) => asCopied(value, start.col, await (d.said ?? []))).catch(() => {
          if (current() && d.scrolled) noteClipboard("could not read the selection from herdr");
          fromHerdr = false;
          return visibleText;
        });
        const awaited = { generation, text: herdrText.then((value) => value || visibleText), scrolled: d.scrolled, reserved: false };
        awaitedText = awaited;
        const text = herdrText.then((value) => {
          if (!current()) throw new Error("selection changed");
          // A redraw can remove the range before herdr reads it. Keep what the user
          // actually selected instead of replacing a successful copy with nothing.
          copiedText = value || visibleText;
          setSelectionQuote({ pane: d.pane, text: copiedText, range: fromHerdr && value ? { start: range[0].row, end: range[1].row } : null });
          return copiedText;
        });
        void herdrText.then(() => { if (awaitedText === awaited) awaitedText = null; });
        if (!autoCopy) {
          void text.catch(() => {});
          return;
        }
        // Reserve the write NOW, supplying the server text when it arrives. Never
        // start a fresh clipboard write from a delayed response or an older drag.
        if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
          const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
          void blob.catch(() => {});
          void navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]).catch(() => {
            if (current() && d.scrolled) noteClipboard("copied the visible part; Copy or Ctrl+C copies the whole selection");
          });
        } else {
          // Native copy already captured the visible text; the full text stays
          // available for the next explicit Copy where delayed items are unsupported.
          void text.then(() => {
            if (current() && d.scrolled) noteClipboard("copied the visible part; Copy or Ctrl+C copies the whole selection");
          }, () => {});
        }
      };
      host.addEventListener("mousedown", onMouseDown, { capture: true });
      window.addEventListener("mousemove", onMouseMove, { capture: true });
      window.addEventListener("blur", onBlur);
      window.addEventListener("mouseup", onMouseUp);
      for (const type of ["keydown", "keyup", "mousemove"] as const) window.addEventListener(type, onLinkKey, { capture: true });
      window.addEventListener("blur", offLinkKey);
      void loadHerdrUi();
      const onOnline = (): void => { if (!herdrUiKnown()) void loadHerdrUi(); };
      window.addEventListener("online", onOnline);

      // Output reaches xterm one frame at a time, so the frame being parsed is known: a frame the
      // bridge marked `replay` (the screen from before this attach) is presentation history, and a
      // copy request in it was answered when it was new. The flag holds from the frame's write
      // until its callback; xterm's own parser state says whether a replayed OSC is still open.
      const outputFrames: { data: string; replay: boolean; view?: boolean; done?: () => void; acknowledge?: () => void; mode?: { pane: string; generation: number; lifetime: number }; seq: number }[] = [];
      let writingOutput = false;
      let holdingForPictures = false;
      let parsingReplay = false;
      // a hidden tab's view parsed on its return (resume): what it drew is history, and a query in it
      // was answered when it was new, so xterm's replies to it never reach the pane (queryReplies below)
      let parsingView = false;
      let parsingCurrentPtyOutput = false;
      let parsingModeEpoch = 0;
      let parsingModePane: string | null = null;
      let parsingModeGeneration = -1;
      let parsingModeLifetime = -1;
      // Which output the frames belong to: a pane switch or reconnect starts new output, and the
      // frame xterm is parsing then is the old output's (`parsingOwner`), which copies nothing.
      let outputOwner = 0;
      let parsingOwner = 0;
      // A click handed to the program starts a clipboard write that its OSC 52 answer fills in
      // (osc52Clipboard.ts): Safari writes only within the click. One at a time, for that pane's output,
      // and only output that arrived after the click (`after`, a count of frames received) answers it.
      let framesReceived = 0;
      let parsingFrame = 0;
      // the frame an OSC still open at a frame's end began in: an answer starts after the click, not only ends after it
      let oscStartFrame: number | null = null;
      let copyReservation: { pane: string; owner: number; after: number; copy: Osc52Reservation } | null = null;
      const cancelCopy = (): void => {
        copyReservation?.copy.cancel();
        copyReservation = null;
      };
      const reserveCopy = (pane: string): void => {
        cancelCopy();
        const copy = reserveOsc52Copy();
        if (copy) copyReservation = { pane, owner: outputOwner, after: framesReceived, copy };
      };
      /** whether a click on the terminal now reaches a program that may copy for it */
      const mayReserveCopy = (): boolean => osc52AllowedRef.current && !observeRef.current && !heldRef.current
        && !term.options.disableStdin && !terminalScreen(term).hasSelection();
      /** the reservation this live copy may fill: still waiting, same pane and output, output from after the click */
      const takeCopy = (origin: number): Osc52Reservation | null => {
        const held = copyReservation;
        // a copy that began before the click is not its answer, and leaves it waiting for that
        if (held && origin <= held.after) return null;
        copyReservation = null;
        if (held && held.copy.pending && held.pane === paneRef.current && held.owner === outputOwner
          && !observeRef.current && !terminalScreen(term).hasSelection()) return held.copy;
        held?.copy.cancel();
        return null;
      };
      // a replayed frame, or retired output, ended inside an OSC that may still dispatch as OSC 52 in a
      // later live write
      let replayOscOpen = false;
      const oscMayCopy = (): boolean => {
        const osc = term.oscStringState();
        return osc.open && (!osc.idComplete || osc.id === 52);
      };
      // where each output frame goes into the terminal: the browser scripts' probe counts here, whichever engine parses it
      let writeFrame = (data: string | Uint8Array, callback: () => void): void => term.write(data, callback);
      const writeNextOutput = (): void => {
        holdingForPictures = false;
        const next = outputFrames[0];
        if (next && !disposed && (picturesChoiceRef.current ?? socket.hasTerminalHistory()) && holdForPictures(term, next.data, writeNextOutput)) {
          writingOutput = holdingForPictures = true;
          // the server stops a connection whose output goes unacknowledged (server/output-window.ts): what
          // waits here is taken, as xterm's own write buffer would take it
          for (const frame of outputFrames) acknowledgeFrame(frame);
          return;
        }
        const frame = outputFrames.shift();
        if (!frame || disposed) {
          writingOutput = false;
          return;
        }
        writingOutput = true;
        parsingReplay = frame.replay;
        parsingView = frame.view === true;
        parsingFrame = frame.seq;
        const owner = parsingOwner = outputOwner;
        const mode = frame.mode;
        parsingCurrentPtyOutput = mode !== undefined && mode.pane === paneRef.current
          && mode.generation === outputGeneration && mode.lifetime === outputLifetime && recoveringPane !== mode.pane;
        parsingModeEpoch = arrowModeEpoch;
        parsingModePane = mode?.pane ?? null;
        parsingModeGeneration = mode?.generation ?? -1;
        parsingModeLifetime = mode?.lifetime ?? -1;
        writeFrame(frame.data, () => {
          parsingReplay = false;
          parsingView = false;
          parsingCurrentPtyOutput = false;
          if (!disposed) {
            if (frame.replay || owner !== outputOwner) replayOscOpen = oscMayCopy();
            else if (replayOscOpen && !term.oscStringState().open) replayOscOpen = false;
            oscStartFrame = term.oscStringState().open ? (oscStartFrame ?? frame.seq) : null;
          }
          try {
            acknowledgeFrame(frame);
            frame.done?.();
          } finally {
            writeNextOutput();
          }
        });
      };
      const acknowledgeFrame = (frame: { acknowledge?: () => void }): void => {
        const acknowledge = frame.acknowledge;
        frame.acknowledge = undefined;
        acknowledge?.();
      };
      const writeOutput = (data: string, replay = false, done?: () => void, view = false, acknowledge?: () => void, mode?: { pane: string; generation: number; lifetime: number }): void => {
        const frame = { data, replay, view, done, acknowledge, mode, seq: ++framesReceived };
        outputFrames.push(frame);
        if (holdingForPictures) acknowledgeFrame(frame);
        if (!writingOutput) writeNextOutput();
      };
      // A pane switch resets the parser, and a reconnect replays afresh: frames still queued from
      // before are dropped unwritten (their connection or pane is gone, so they have no ACK to send),
      // and the one xterm is parsing finishes with no clipboard write. Its callback still runs, and
      // its own owner and generation checks keep it off the new output. An OSC the old output left
      // open in xterm is guarded as a replayed one: its callback decides for a frame still parsing.
      // The frame gate read those dropped frames as they came, so their stream ends there too: a
      // synchronized update one opened would otherwise keep later frames from settling until
      // another synchronized update closed.
      // the masked prompt the screen shows now, if any (lib/secretScreen.ts). An attached pane's cursor is the
      // program's; a mirrored pane's repaints carry none, and a pane not known to be attached is read the same way
      const secretScreen = createSecretScreen(term, () => mirroredRef.current === false);
      // What the field shows: the prompt, and whether its answer is typed unchecked (HerdrSocket.typesSecret). That
      // changes when the bridge says what it takes, which can come after the prompt was drawn
      const showSecret = (pane: string, prompt: string | null): void => {
        const unchecked = prompt !== null && socket.typesSecret(prompt);
        setSecret((previous) => prompt === null ? null
          : previous?.pane === pane && previous.prompt === prompt && previous.unchecked === unchecked ? previous : { pane, prompt, unchecked });
      };
      const retireOutput = (): void => {
        outputOwner++;
        invalidateArrowModes();
        outputFrames.length = 0;
        cancelCopy();
        if (recoveringPane !== paneRef.current) endRecovery();
        else if (recoveringPane !== null) rejoin = true;
        frameGateRef.current.reset();
        if (!writingOutput || holdingForPictures) replayOscOpen = oscMayCopy();
      };
      retireOutputRef.current = retireOutput;
      if (typeof __HERDR_TEST_HOOKS__ === "boolean" && __HERDR_TEST_HOOKS__) {
        // browser scripts read the parse state and count the output frames written and in flight (never in a release
        // build): at the terminal's door, so the counts are the same whether xterm or libghostty parses the text
        let inFlight = 0;
        let peakInFlight = 0;
        let writes = 0;
        let written = "";
        const write = writeFrame;
        writeFrame = (data, callback) => {
          inFlight++;
          writes++;
          if (typeof data === "string") written = (written + data).slice(-4096);
          peakInFlight = Math.max(peakInFlight, inFlight);
          write(data, () => { inFlight--; callback(); });
        };
        Object.assign(host, { outputProbe: () => ({ ...term.oscStringState(), parsingReplay, replayOscOpen, retired: writingOutput && parsingOwner !== outputOwner, queued: outputFrames.length, inFlight, peakInFlight, writes, written, frameSettled: frameGateRef.current.current,
          history: ((rows) => ({ scrollback: term.options.scrollback ?? 0, length: rows.length, viewportY: rows.viewportY, baseY: rows.baseY }))(screenRows(term)),
          grid: { cols: term.cols, rows: term.rows } }) });
      }

      // OSC 52: the pane program asked the terminal to set the clipboard - the pty
      // cannot reach the browser clipboard by itself, so xterm hands us the sequence and
      // navigator.clipboard completes the hop (text only; queries are ignored).
      // On unless turned off in Settings -> Terminal -> Clipboard from a pane: vim, tmux and Claude Code
      // copy this way, but any process in the pane, an agent's tool calls included, can plant text the
      // user then pastes somewhere else.
      const osc52 = term.parser.registerOscHandler(52, (payload) => {
        const replayed = parsingReplay || replayOscOpen;
        // OSCs do not nest: the replayed one the flag waited for ends here
        replayOscOpen = false;
        const origin = oscStartFrame ?? parsingFrame;
        oscStartFrame = null;
        // a recent tab watched off-screen draws its output but does not set the clipboard unseen
        if (!replayed && parsingOwner === outputOwner && osc52AllowedRef.current && presentedRef.current && shownRef.current) {
          const text = parseOsc52(payload);
          if (text !== null) {
            // a reserved write that fails is not tried again later: that would be a write outside the click
            const reserved = takeCopy(origin);
            const written = reserved ? reserved.fulfil(text) : navigator.clipboard?.writeText(text).then(() => true, () => false);
            void written?.then((copied) => noteClipboard(copied ? "copied to clipboard" : "clipboard write blocked by the browser"));
          }
        }
        return true;
      });
      // Every query xterm answers while parsing (device attributes and status, DECRQM, window reports,
      // DECRQSS, color reports) is taken here while a view is parsed, so its answer is never typed into the pane.
      const queryReplies = [
        ...([{ final: "c" }, { prefix: ">", final: "c" }, { prefix: "=", final: "c" }, { final: "n" }, { prefix: "?", final: "n" },
          { intermediates: "$", final: "p" }, { prefix: "?", intermediates: "$", final: "p" }, { final: "t" }] as const)
          .map((id) => term.parser.registerCsiHandler(id, () => parsingView)),
        term.parser.registerDcsHandler({ intermediates: "$", final: "q" }, () => parsingView),
        ...[4, 10, 11, 12, 13, 14, 15, 16, 17, 19].map((id) => term.parser.registerOscHandler(id, (payload) => parsingView && payload.includes("?"))),
      ];
      // OSC 8: a hyperlink this app cannot open (OmO's `omo-panel:` rows) is not drawn as one (#739)
      const osc8 = term.parser.registerOscHandler(8, (payload) => hyperlinksRef.current.handler(payload));
      // modifyOtherKeys (CSI > 4 ; level m): xterm.js has no handler for it, so this one only
      // listens, and Ctrl+Enter is sent as the program asked (see onModifiedEnter)
      const modifyOtherKeys = (final: "m" | "n") => term.parser.registerCsiHandler({ prefix: ">", final }, (params) => {
        modifyOtherKeysRef.current = modifyOtherKeysLevel(modifyOtherKeysRef.current, final, params);
        return false;
      });
      const modifyOtherKeysSet = modifyOtherKeys("m");

      // xterm's public mode flags start at defaults, which are not proof of the attached program's
      // current state. Witness only explicit DECCKM set/reset sequences in this current pty parse.
      const arrowModeWitnesses = (["h", "l"] as const).map((final) => term.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
        const setsCursorMode = params.some((param) => param === 1);
        if (setsCursorMode && parsingCurrentPtyOutput && parsingOwner === outputOwner && parsingModeEpoch === arrowModeEpoch
          && parsingModePane === paneRef.current && parsingModeGeneration === outputGeneration && parsingModeLifetime === outputLifetime
          && recoveringPane !== parsingModePane) {
          arrowModeEpoch++;
          parsingModeEpoch = arrowModeEpoch;
          arrowModeWitness = arrowModeEpoch;
        }
        return false;
      }));
      const modifyOtherKeysOff = modifyOtherKeys("n");

      const session = machineSessions?.get(machineId) ?? new MachineSession(machineId);
      const socket = session.socket;
      sessionRef.current = session;
      // On a herdr-core server (`terminal-history`) this terminal keeps the scrollback, as VS Code's
      // does: the wheel scrolls it natively unless the program reads the mouse, touch below. herdr's
      // TUI keeps its own. Returns whether it changed.
      const syncHistory = (): boolean => {
        const lines = socket.hasTerminalHistory() ? TERMINAL_HISTORY_LINES : 0;
        setTerminalHistory(lines > 0);
        if (term.options.scrollback === lines) return false;
        term.options.scrollback = lines;
        return true;
      };
      syncHistory();
      pendingScopeRef.current = session.scope;
      pendingEpochRef.current = session.epoch;
      socketRef.current = socket;
      const releaseGhostty = captureForGhostty(term, socket, host, () => mirroredRef.current === true, () => {
        const owner = outputOwner;
        const view = parsingView;
        return () => !view && owner === outputOwner;
      });
      let adjustingFaint = false;
      const clampGhosttyFaint = (): void => {
        if (adjustingFaint) return;
        adjustingFaint = true;
        try {
          const currentTheme = term.options.theme ?? {};
          const minContrast = term.options.minimumContrastRatio ?? 4.5;
          for (const span of host.querySelectorAll<HTMLElement>('.ghostty-row [style*="50%, transparent"], .ghostty-row [data-faint-fg]')) {
            let rawFg = span.dataset.faintFg;
            if (rawFg === undefined) {
              const match = /color-mix\(in srgb,\s*([^)]+?)\s+50%,\s*transparent\)/i.exec(span.getAttribute("style") ?? "");
              rawFg = match?.[1]?.trim() ?? "currentColor";
              span.dataset.faintFg = rawFg;
            }
            const fg = rawFg === "currentColor" ? (currentTheme.foreground ?? "#d8d0c3") : rawFg;
            const bg = span.style.backgroundColor || currentTheme.background || "#181613";
            const next = dimmedColor(fg, bg, minContrast);
            if (span.style.color !== next) span.style.color = next;
          }
        } finally {
          adjustingFaint = false;
        }
      };
      const ghosttyFaintObserver = new MutationObserver(clampGhosttyFaint);
      ghosttyFaintObserver.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
      setConnectedBefore(connectedSockets.has(socket));
      let outputGeneration = 0;
      // A raw arrow needs this attachment's output to have shown its DECCKM: only then has the server's attach
      // (CoreAttachSession) read the program's cursor mode, and it types a lone cursor key in that mode, whatever
      // xterm still believed when it encoded the key, so output still on its way to xterm holds nothing back.
      // Captured on the Typed item too: input waiting for an attach may flush after the first paint.
      let arrowModeEpoch = 0;
      // the epoch of the current attachment's DECCKM witness, null before one
      let arrowModeWitness: number | null = null;
      const invalidateArrowModes = (): void => { arrowModeWitness = null; arrowModeEpoch++; };
      let touchWheelDispatching = false;
      // Bumped by readiness receipts: revokes only the proof that queued output is current, never
      // the parse itself (a masked prompt must still keep typing out of every draft).
      let outputLifetime = 0;
      let recoveringPane: string | null = null;
      let joinReplay = false;
      let rejoin = false;
      const endRecovery = (): void => {
        recoveringPane = null;
        joinReplay = false;
        rejoin = false;
      };
      let deferredAttach = false;
      let viewBuffer: string[] | null = null;
      let viewBytes = 0;
      let viewDropped = false;
      let viewPane: string | null = null;
      let rereadHerdrUi = false;
      // Text composed while the pane could not take input (a dictated phrase still in the editor)
      // was typed offline: when input returns before its commit key, it goes to the draft and
      // waits for Send or Discard like the rest, never to the pane by the next key.
      let inputWasReady = false;
      // A tab that let go of its pane for idleness (#712, the release machinery below) takes it back at the next key,
      // click, paste or composition. What is typed from then until the new attach takes input waits here, and goes to
      // the pane once, in order, when that attach takes input within RESUME_INPUT_WAIT_MS (flushResume). Anything
      // else ends it as typing offline ends (failResume, retainTyped): an error or the end of the pane, a dropped
      // connection, the wait running out, or the attach given up (cancelLeave: let go of again, cached, another
      // pane). Nothing of it goes by itself after that; a masked prompt on screen keeps it out of the draft too.
      let resumeInput: { pane: string; items: Typed[]; since: number } | null = null;
      // A held pane taken back: until the new attach's own screen is read for a masked prompt (below), the one known may
      // be stale (drawn while the view was stopped, or still unparsed), so what is typed there is taken as a password
      let promptUnknownFor: string | null = null;
      let resumeTimer: number | null = null;
      const takeResume = (): { pane: string; items: Typed[]; since: number } | null => {
        const resumed = resumeInput;
        resumeInput = null;
        if (resumeTimer !== null) window.clearTimeout(resumeTimer);
        resumeTimer = null;
        return resumed !== null && resumed.pane === paneRef.current ? resumed : null;
      };
      const failResume = (): void => {
        const resumed = takeResume();
        if (resumed === null) return;
        for (const typed of resumed.items) retainTyped(resumed.pane, typed, secretRef.current !== null);
      };
      const flushResume = (): void => {
        const resumed = takeResume();
        if (resumed === null) return;
        const late = performance.now() - resumed.since > RESUME_INPUT_WAIT_MS;
        sendInOrder(resumed.items, late || draftHeldForRef.current === resumed.pane, (typed) => sendTyped(resumed.pane, typed),
          (typed) => retainTyped(resumed.pane, typed, secretRef.current !== null));
      };
      const startResume = (pane: string, since = performance.now()): void => {
        failResume();
        resumeInput = { pane, items: [], since };
        resumeTimer = window.setTimeout(() => { resumeTimer = null; failResume(); }, Math.max(0, RESUME_INPUT_WAIT_MS - (performance.now() - since)));
      };
      // What was typed for a new tab before it existed (lib/typeAhead.ts) waits with the keys typed here after it, as
      // a pane taken back does, and goes ahead of them: taken before the attach and before any key reaches this pane.
      // It is held for review instead, never sent by itself, when it holds a paste, when the user went elsewhere
      // meanwhile, or when the PC's link was not up all along since a key was typed: each key is judged by its own mark
      // (CaughtKey.typedAt, HerdrSocket.takesKey), so keys typed after a connection was replaced are not held for one
      // that came before (nothing goes after a disconnect).
      const adoptTypeAhead = (pane: string): void => {
        let held = false;
        const take = (items: CaughtKey[], heldNow: boolean): void => {
          held ||= heldNow || !socket.connected;
          // a key typed before the link that is up now was confirmed holds every key after it, whichever way it goes
          // (the resume queue refuses it without telling the catch)
          for (const item of items) {
            if (!socket.linkedSince(item.typedAt)) held = true;
            // as typing here: a masked prompt on screen now makes it secret (never held, never kept for a receipt),
            // and a draft held for this pane (a late attach held what came first) takes what follows it
            const secret = secretRef.current !== null;
            const arrow = item.arrow !== undefined ? terminalChord(item.arrow, NO_STICKY_MODIFIERS) : null;
            const typed: Typed = { input: item.input, keys: arrow !== null ? [arrow] : null, chord: false, stop: false, secret, typedAt: item.typedAt, ...(arrow !== null ? { arrowModeEpoch: null } : {}) };
            if (held || draftHeldForRef.current === pane) retainTyped(pane, typed, secret);
            else if (!secret && resumeInput !== null && resumeInput.pane === pane) resumeInput.items.push(typed);
            // a key held here holds every caught key after it, Enter included (lib/sendInOrder.ts)
            else if (paneRef.current === pane) held = !sendTyped(pane, typed);
          }
        };
        const takeKeyboard = (focused: boolean, typed = true): void => {
          if (focused && paneRef.current === pane && activeRef.current && !chatViewRef.current && (!coarseRef.current || typed)) term.focus();
        };
        const ahead = takeTypeAhead(paneStorageId(machineId, pane), { more: take, done: takeKeyboard });
        if (ahead === null) return;
        held = ahead.held || !socket.connected;
        if (ahead.pasteRefused) setInputError(tRef.current("Not sent: the terminal is not ready for keys."));
        if (!held) startResume(pane, ahead.since);
        const typed = ahead.items.length > 0;
        take(ahead.items, ahead.held);
        takeKeyboard(ahead.focused, typed);
        if (!held && socket.canInput(pane)) flushResume();
      };
      typeAheadRef.current = adoptTypeAhead;
      let lastActivity = performance.now();
      let idleTimer: number | null = null;
      let idleRound = 0;
      let idleReleased = false;
      const noteActivity = (): void => { lastActivity = performance.now(); };
      const armIdle = (delay = IDLE_RELEASE_MS): void => {
        if (idleTimer !== null) window.clearTimeout(idleTimer);
        const round = ++idleRound;
        idleTimer = window.setTimeout(() => { if (round === idleRound) idleCheck(); }, delay);
      };
      const noteInputReady = () => {
        const pane = paneRef.current;
        if (!pane) return;
        const ready = socket.canInput(pane);
        const resuming = resumeInput !== null && resumeInput.pane === pane;
        if (ready && !inputWasReady && !resuming) {
          holdPendingTextRef.current = true;
          try { commitPendingText(); } finally { holdPendingTextRef.current = false; }
        }
        if (ready && !inputWasReady) {
          lastActivity = performance.now();
          armIdle();
        }
        inputWasReady = ready;
        setInputReady(ready);
        if (ready && resuming) flushResume();
      };
      // A refusal shorter than the readiness poll (a liveness probe whose pong comes back within
      // it) still counts: text entering the editor while input is refused marks the refusal, so
      // the frame that ends it (the pong) commits that text to the draft, not the next key to the pane.
      const noteRefusedText = () => {
        const pane = paneRef.current;
        if (pane && !socket.canInput(pane)) inputWasReady = false;
      };
      const editor = term.textarea;
      editor?.addEventListener("input", noteRefusedText, true);
      const off = session.on((message, sent) => {
        onServerMessageRef.current?.(message);
        if (rereadHerdrUi) {
          rereadHerdrUi = false;
          if (!herdrUiKnown()) void loadHerdrUi();
        }
        pendingScopeRef.current = session.scope;
        pendingEpochRef.current = session.epoch;
        if ("pane_id" in message && message.pane_id !== undefined && message.pane_id !== paneRef.current) return;
        if ((message.type === "features" || message.type === "snapshot") && syncHistory() && inUse()) refit();
        if ((message.type === "features" || message.type === "snapshot") && paneRef.current !== null && secretRef.current !== null) showSecret(paneRef.current, secretRef.current);
        if (message.type === "snapshot" && stalledRef.current) {
          stalledRef.current = false;
          setOutputError(null);
          setEnded(false);
          term.options.disableStdin = observeRef.current || heldRef.current;
        }
        // A provisional watch must not strand an initial/reconnected pane on an older bridge.
        if (message.type === "snapshot" && deferredAttach && !socket.canWatch()) resume();
        if (message.type === "pending-messages" && sent) {
          redrawGreeting();
          onChatSuggestion(message.pane_id, null);
          setChatSent((current) => current + 1);
          setChatRefresh((current) => current + 1);
        }
        if (message.type === "conversation-changed" && message.pane_id === paneRef.current
          && chatMountedRef.current && document.visibilityState !== "hidden") {
          setChatInvalidation((current) => current + 1);
        }
        noteInputReady();
        // the attach an idle pane started for typing will not take it (held, stalled, failed, ended): the typing is
        // held as typing offline is, and never goes by itself when a later attach takes input
        if (resumeInput !== null && (message.type === "pty-exit" || message.type === "error")
          && (message.pane_id === undefined || message.pane_id === resumeInput.pane)) failResume();
        if (message.type === "input-ready" || message.type === "output-recovering") {
          if (message.type === "output-recovering" || message.ready === false) {
            invalidateArrowModes();
            recoveringPane = message.pane_id;
            joinReplay = message.type === "output-recovering";
            rejoin = false;
            outputLifetime++;
            setOutputReady(false);
            setParsedTarget(undefined);
          } else if (recoveringPane === message.pane_id) {
            // Recovery revokes parses queued before this receipt too. The new stream, not
            // input permission (which observers never have), proves the screen is current.
            invalidateArrowModes();
            endRecovery();
            outputLifetime++;
          }
        }
        if (message.type === "pty-data") {
          if (message.pane_id !== paneRef.current || releasedRef.current) return;
          if (chatMountedRef.current) chatOutputRef.current?.();
          // raw pty bytes: append, never repaint, so xterm keeps the screen and selection
          const acknowledge = socket.outputAcknowledgement(message);
          const owner = message.pane_id;
          if (message.replay === true && recoveringPane === owner) {
            if (joinReplay) joinReplay = false;
            else if (rejoin) {
              invalidateArrowModes();
              endRecovery();
              outputLifetime++;
            }
          }
          const generation = outputGeneration;
          const lifetime = outputLifetime;
          const target = outputTargetRef.current;
          const gridMatches = (): boolean => {
            const shared = sharedGridRef.current;
            return shared === null || (shared.cols === term.cols && shared.rows === term.rows);
          };
          const stamp = frameGateRef.current.enqueue(message.data, gridMatches());
          writeOutput(message.data, message.replay === true, () => {
            if (disposed) return;
            if (paneRef.current !== owner || generation !== outputGeneration) {
              modifyOtherKeysRef.current = 0;
              return;
            }
            if (lifetime === outputLifetime && recoveringPane !== owner) {
              if (presentedRef.current) releaseViews();
              setOutputReady(true);
              setParsedTarget(target);
            }
            followCursor();
            // A masked prompt does not close the grid: a desktop answers it there, as in any terminal,
            // and the masked input stands by for a phone (#1031). onData keeps what is typed then out
            // of every draft.
            // Read at a whole frame only: herdr hides the cursor, draws its rows and places the cursor last, so a
            // chunk that ends inside a frame has the cursor wherever drawing stopped. Read there, the prompt would
            // seem to ask no more, and the field would leave with what was typed in it
            // A herdr-core pane's stream is the program's own bytes, with no frame of herdr's to wait for: a program
            // that opened a synchronized update and never closed it (a TUI killed mid-draw, `cat` of a raw log)
            // would leave every later chunk inside one, and a later prompt unread
            if (stamp.boundary || socket.hasTerminalHistory()) {
              const prompt = secretScreen.read(owner);
              secretRef.current = prompt;
              if (promptUnknownFor === owner && lifetime === outputLifetime && recoveringPane !== owner) promptUnknownFor = null;
              showSecret(owner, prompt);
            }
            term.options.disableStdin = observeRef.current || heldRef.current;
            if (frameGateRef.current.settle(stamp, lifetime === outputLifetime && recoveringPane !== owner && gridMatches())) {
              onInputRowFrameRef.current();
              if (typeof __HERDR_TEST_HOOKS__ === "boolean" && __HERDR_TEST_HOOKS__ && stamp.synchronized && message.flow) {
                // The write callback has parsed the complete synchronized update in this xterm grid.
                host.dispatchEvent(new CustomEvent("ovis:test-terminal-frame", { bubbles: true,
                  detail: { pane: owner, cols: term.cols, rows: term.rows, replay: message.replay === true, stream: message.flow.stream_id } }));
              }
            }
          }, false, acknowledge, { pane: owner, generation, lifetime });
        } else if (message.type === "watch-data") {
          if (message.pane_id !== paneRef.current || !releasedRef.current || !watchingRef.current) return;
          if (!presentedRef.current) {
            if (viewBuffer !== null && viewBytes + message.data.length <= VIEW_BUFFER_MAX) {
              viewBuffer.push(message.data);
              viewBytes += message.data.length;
            } else {
              if (viewBuffer !== null) viewDropped = true;
              viewBuffer = null;
            }
            return;
          }
          const owner = message.pane_id;
          // a masked prompt drawn while the tab only watches: what is typed to take the pane back is not kept for it
          writeOutput(message.data, false, () => {
            if (!disposed && paneRef.current === owner && releasedRef.current) secretRef.current = secretScreen.read(owner);
          });
        } else if (message.type === "watch-end") {
          if (message.pane_id === paneRef.current) setWatching(false);
        } else if (message.type === "attach-resumed") {
          if (message.pane_id === paneRef.current) {
            setHeld(false);
            term.options.disableStdin = observeRef.current;
          }
        } else if (message.type === "pty-exit") {
          // an ended pane takes no input: a file dropped on it must not upload and paste either
          // held input stays: the server also says pty-exit when herdr restarts or an attach fails,
          // and the same pane comes back; only the user sends or discards it
          if (message.pane_id === paneRef.current) { setEnded(true); term.options.disableStdin = true; }
        } else if (message.type === "role-ack") {
          // the server is the authority on the role; only after this ack may an
          // interact client reclaim the shared grid it stopped owning (a tab out of use
          // reclaims it when the user comes back: the refit below)
          cancelTouchRef.current();
          const nowObserving = message.mode === "observe";
          // text still pending in the editor was composed without the role: it is committed while
          // observing still refuses it, so the next accepted key cannot carry it into the pane
          if (observeRef.current && !nowObserving) commitPendingText();
          observeRef.current = nowObserving;
          if (nowObserving) cancelCopy();
          if (nowObserving) {
            term.options.fontSize = baseFontRef.current;
            fitLineHeight(term);
          }
          setObserving(nowObserving);
          syncInputViewport();
          term.options.disableStdin = nowObserving || heldRef.current;
          onRoleAckRef.current?.(message.mode);
          if (!nowObserving && !fixedGridRef.current && !chatViewRef.current && inUse() && !keyboardHolds(true)) {
            try {
              fit.fit();
              fitted();
            } catch {
            }
            const pane = paneRef.current;
            if (pane && sizesPty()) socket.resize(pane, term.cols, term.rows, true);
          }
          panned = false;
          fold.sync();
          followCursor();
        } else if (message.type === "pane-geometry") {
          // observe clients adopt the pty's grid; interact clients drive it and ignore this,
          // unless the grid is fixed (nobody here drives it) or a herdr-core pty is kept at another size
          if (message.pane_id !== paneRef.current) return;
          if (message.fixed) {
            fixedGridRef.current = true;
            term.options.fontSize = baseFontRef.current;
            fitLineHeight(term);
            syncInputViewport();
          }
          const before = sharedGridRef.current;
          sharedGridRef.current = { cols: message.cols, rows: message.rows };
          // the pty took a new size: herdr may draw the old screen reflowed before the agent redraws (lib/inputRow.ts FrameGate)
          if (!message.fixed && before !== null && (before.cols !== message.cols || before.rows !== message.rows)) frameGateRef.current.reflowed();
          if (!adopted() && !chatViewRef.current) {
            if (!keyboardHeld) return;
            heldForce = true;
          }
          if (term.cols !== message.cols || term.rows !== message.rows) term.resize(message.cols, message.rows);
          panned = false;
          fold.sync();
          followCursor();
        } else if (message.type === "error") {
          if (message.code === "input_not_ready" || message.code === "input_failed") {
            if (message.pane_id === paneRef.current) setInputError(message.message);
            return;
          }
          if (message.code === "attach_held") {
            if (message.pane_id !== undefined && message.pane_id !== paneRef.current) return;
            // not an end: the server attaches as soon as the other bridge lets go
            invalidateArrowModes();
            setHeld(true);
            setOutputReady(false);
            term.options.disableStdin = true;
            setConnected(socket.connected);
            return;
          }
          if (message.code === "attach_failed") {
            if (message.pane_id !== undefined && message.pane_id !== paneRef.current) return;
            invalidateArrowModes();
            setOutputError(t("herdr could not be started on the server, so this terminal cannot attach. Put herdr on the server's PATH or set OVIS_HERDR_BIN to its full path."));
            setEnded(true);
            term.options.disableStdin = true;
            setConnected(socket.connected);
            return;
          }
          if (message.code === "terminal_unsupported") {
            if (message.pane_id !== undefined && message.pane_id !== paneRef.current) return;
            invalidateArrowModes();
            setUnsupported(true);
            term.options.disableStdin = true;
            setConnected(socket.connected);
            return;
          }
          if (message.code === "output_stalled" || message.code === "attach_conflict") {
            invalidateArrowModes();
            if (message.code === "output_stalled") stalledRef.current = true;
            setOutputError(message.message);
            setEnded(true);
            setConnected(false);
            term.options.disableStdin = true;
            // a frozen page reads the close after it is shown again, often after back() ran: the
            // stop belongs to the time it was put away, so attach again now (see back())
            if (message.code === "output_stalled" && socket.stoppedWhileHidden && inUse()) {
              queueMicrotask(() => {
                if (!disposed && stalledRef.current && socket.stoppedWhileHidden && inUse()) reattachRef.current();
              });
            }
            return;
          }
          writeOutput(`\r\n\u001b[31m[Ovis] ${message.code}: ${message.message}\u001b[0m\r\n`);
        }
        setConnected(socket.connected);
        setConversationPushes(socket.conversationPushes());
      });
      const offDisconnect = session.onDisconnect(() => {
        cancelTouchRef.current();
        rereadHerdrUi = true;
        clearModifiers();
        pendingScopeRef.current = session.scope;
        pendingEpochRef.current = session.epoch;
        outputGeneration++;
        endRecovery();
        retireOutputRef.current();
        setOutputReady(false);
        inputWasReady = false;
        setInputReady(false);
        setConnected(false);
        setConversationPushes(false);
        // the reconnect attaches afresh: it says attach_held again if the other bridge still has
        // the pane, and a pane it gets straight away sends no attach-resumed to clear this
        setHeld(false);
        modifyOtherKeysRef.current = 0;
        // typing that waited for an idle pane's new attach is held for review, never sent after the reconnect
        failResume();
        // typing the server never confirmed may not have reached the pane: held for review ahead of
        // anything typed since, never in a draft while a masked prompt is on screen (#2587)
        const current = paneRef.current;
        const lost = current === null ? [] : socket.takeUnconfirmedInput(current);
        // a key sent as a password that the server never confirmed may not have arrived: said, as nothing of it is kept
        if (current !== null && socket.takeUnconfirmedSecrets(current) > 0) {
          const t = tRef.current;
          setInputError(t("A key may not have reached the terminal: the connection ended before it was confirmed."));
        }
        if (current !== null && secretRef.current === null && !draftIsEmpty(holdBefore(lost, EMPTY_DRAFT))) {
          const samePane = draftPaneRef.current === current;
          draftPaneRef.current = current;
          setDraft((prev) => holdBefore(lost, samePane ? prev : EMPTY_DRAFT));
          draftHeldForRef.current = current;
        }
      });
      session.connect();

      const poll = window.setInterval(() => {
        setConnected(socket.connected);
        setConversationPushes(socket.conversationPushes());
        noteInputReady();
      }, 1000);

      // onKey runs after xterm drains a pending IME commit, immediately before the
      // key's onData. Remap only that CR, preserving composition text and its order.
      // xterm.js types Shift+Enter and Ctrl+Enter as plain Enter: Shift+Enter becomes the Alt+Enter
      // newline chord, Ctrl+Enter what modifyOtherKeys makes it (Claude Code's "send now") while
      // the program has asked for that, and stays Enter otherwise. A mirrored pane never hears that
      // request, so its Ctrl+Enter goes as herdr's key, which herdr encodes as the program asked.
      let enterAs: string | null = null;
      let enterKey: string | null = null;
      const onModifiedEnter = term.onKey(({ key, domEvent: event }) => {
        enterAs = null;
        enterKey = null;
        if (term.options.disableStdin || key !== "\r" || event.key !== "Enter" || event.altKey || event.metaKey
          || event.isComposing || event.keyCode === 229) return;
        if (event.shiftKey && !event.ctrlKey) enterAs = "\x1b\r";
        else if (event.ctrlKey && !event.shiftKey) {
          enterKey = mirroredCtrlEnterKey(fixedGridRef.current, modifyOtherKeysRef.current);
          enterAs = enterKey !== null ? "\r" : ctrlEnterSequence(modifyOtherKeysRef.current);
        }
      });
      // Let xterm finish pending IME text before remapping the key's following data.
      // Cmd+Backspace uses the terminal's Ctrl+U line-deletion shortcut on macOS. Ctrl+Backspace erases the word
      // before the cursor with Ctrl+W, where xterm sends Ctrl+H, which a shell reads as a one-character erase (#3415).
      // Only on an attached pane: a mirrored one is a Windows PC's, whose shells (PowerShell) already read Ctrl+H
      // as the word erase and have no Ctrl+W.
      let commandBackspace = false;
      let controlBackspace = false;
      const onCommandBackspace = term.onKey(({ key, domEvent: event }) => {
        const backspace = !term.options.disableStdin && event.type === "keydown" && event.key === "Backspace"
          && !event.altKey && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
        commandBackspace = backspace && isMac && key === "\x7f" && event.metaKey && !event.ctrlKey;
        controlBackspace = backspace && key === "\b" && event.ctrlKey && !event.metaKey && mirroredRef.current === false;
      });
      // A paste is text, even when it happens to contain just one letter. xterm
      // handles the DOM paste synchronously after this capture-phase listener.
      let pasting = false;
      const onPaste = () => { pasting = true; queueMicrotask(() => { pasting = false; }); };
      host.addEventListener("paste", onPaste, true);
      const onTyped = (): void => cancelTouchRef.current();
      host.addEventListener("keydown", onTyped, true);
      host.addEventListener("input", onTyped, true);
      host.addEventListener("paste", onTyped, true);
      // File paths and dropped text use xterm's programmatic paste without a DOM paste event. `typedAt`: the mark
      // (markTyped) of the pick, drop or paste it came from, so a path whose upload ends after an outage is held
      let pasteMark: number | null = null;
      // Text an input method, dictation or a paste lets out later is dated to when it began (compositionstart, the
      // paste), not when xterm emits it: what began before a lost link is held, what began after it goes (#4249)
      let beganMark: number | null = null;
      const textBegan = (): void => { beganMark ??= markTyped(); };
      host.addEventListener("compositionstart", textBegan, true);
      host.addEventListener("paste", textBegan, true);
      // a plain key starts nothing that comes out later: a composition that let out nothing dates no key after it
      const plainKey = (event: KeyboardEvent): void => {
        if (!event.isComposing && event.keyCode !== 229 && !composingRef.current && !compositionCommitPendingRef.current) beganMark = null;
      };
      host.addEventListener("keydown", plainKey, true);
      // a composition that ends with nothing let out dates nothing after it (a menu paste comes with no key first)
      const compositionDone = (event: CompositionEvent): void => { if (!event.data) beganMark = null; };
      host.addEventListener("compositionend", compositionDone, true);
      const pasteText = (text: string, typedAt: number): void => {
        const previous = pasting;
        pasting = true;
        pasteMark = typedAt;
        try { term.paste(text); } finally { pasting = previous; pasteMark = null; }
      };
      // xterm ignores Cmd+arrows. Handle them on the bubble phase, after its textarea
      // keydown listener drains pending IME text, so movement never precedes that text.
      const onCommandArrow = (event: KeyboardEvent): void => {
        if (!isMac || event.target !== term.textarea || event.defaultPrevented || term.options.disableStdin
          || composingRef.current || event.isComposing || event.keyCode === 229
          || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        const sequence = event.key === "ArrowLeft" ? "\x01" : event.key === "ArrowRight" ? "\x05" : null;
        if (sequence === null) return;
        event.preventDefault();
        term.input(sequence);
      };
      host.addEventListener("keydown", onCommandArrow);
      // a key, a chord or text for the pane: sent now, or, when the pane cannot take it, told or held for review
      // true when sent; what is not sent is held or told here
      const sendTyped = (current: string, typed: Typed): boolean => {
        // An arrow pressed after this attachment showed its DECCKM goes as text, also while output is still on its
        // way to xterm (#4123): a named key waits out hc's typing quiet period, and so does all typing behind it.
        // Logical type-ahead arrows and arrows pressed before that witness stay named.
        const rawArrow = typed.arrowModeEpoch !== undefined && typed.arrowModeEpoch !== null
          && typed.arrowModeEpoch === arrowModeEpoch && socket.typesArrows();
        if (typed.keys !== null && (typed.chord || !rawArrow)) {
          if (socket.sendKeys(current, typed.keys, typed.typedAt)) return true;
          // A named arrow that could not be sent must never fall through as its possibly stale CSI bytes.
          if (typed.arrowModeEpoch !== undefined) {
            retainTyped(current, typed, false);
            return false;
          }
        }
        if (!typed.chord && !holdPendingTextRef.current && socket.sendInput(current, typed.input, typed.stop, typed.automatic === true, typed.secret, typed.typedAt)) return true;
        retainTyped(current, typed, false);
        return false;
      };
      // what the pane could not take: told, or held for review (`secretNow`: a masked prompt is on screen now)
      const retainTyped = (current: string, typed: Typed, secretNow: boolean): void => {
        if (typed.chord) {
          // Shortcuts are never retained as offline text: a chord the terminal cannot take now
          // (not ready, disconnected) is told, not dropped in silence. Only one typed while an idle
          // pane is taken back waits, with the keys around it, for that attach (resumeInput)
          const t = tRef.current; // the language of now, not of the attach
          setInputError(t("Not sent: the terminal is not ready for keys."));
          return;
        }
        if (typed.secret || secretNow) {
          const t = tRef.current;
          setInputError(t("Not sent: the terminal is not ready, and a password is never held for later."));
          return;
        }
        // A closed socket, an attachment still opening, or a failed synchronous send:
        // keep printable input for explicit review, never replay it automatically.
        if (draftPaneRef.current !== current) {
          draftPaneRef.current = current;
          setDraft(EMPTY_DRAFT);
        }
        setDraft((prev) => applyToDraft(prev, typed.input));
        if (!draftIsEmpty(applyToDraft(EMPTY_DRAFT, typed.input))) draftHeldForRef.current = current;
        // A key the draft cannot hold (Escape, Enter, an arrow, typed right as the terminal opens, say) is told, never
        // lost in silence. Not Backspace, which edits the draft, nor a mouse report, nor what xterm sends by itself, which
        // no one typed (a focus report, its answers to the program's queries). Told apart at the source, not by the bytes:
        // Shift+F3 sends what a cursor-position report does, Alt+] the start of a colour report.
        else if (typed.automatic !== true && !/^([\x7f\b\x17]+|\x1b\[(<|M)[\s\S]*)$/.test(typed.input)) {
          setInputError(tRef.current("Not sent: the terminal is not ready for keys."));
        }
      };
      const userInput = userInputTracker(term);
      const onData = term.onData((data) => {
        const automatic = !userInput.wasUserInput();
        if (!touchWheelDispatching && (barKeyRef.current !== null || stopKeyRef.current !== null || pasting)) cancelTouchRef.current();
        // the split half following the other half's grid of the same tab draws it only: the active
        // half's terminal answers the program's queries (a second answer would reach it as typing),
        // and a press or key here makes this half the active one before anything is typed
        if (followRef.current) return;
        if (keyboardToggleFocusRef.current && (data === "\x1b[I" || data === "\x1b[O")) return;
        const barKey = barKeyRef.current;
        barKeyRef.current = null;
        // the Stop's mark is for its Escape: text xterm flushes ahead of it (a pending commit) is not the Stop's
        const stopKey = data === "\u001b" ? stopKeyRef.current : null;
        if (stopKey !== null) stopKeyRef.current = null;
        const physicalChord = typedChord;
        typedChord = null;
        // a modified Enter (Shift+Enter's newline, Ctrl+Enter's "send now") is decided on before its
        // rewrite: its sequence may carry no line break at all
        const modifiedEnter = enterAs !== null && data === "\r";
        const enterChord = modifiedEnter ? enterKey : null;
        if (modifiedEnter) data = enterAs!;
        enterAs = null;
        enterKey = null;
        if (commandBackspace && data === "\x7f") data = "\x15";
        if (controlBackspace && data === "\b") data = "\x17";
        commandBackspace = false;
        controlBackspace = false;
        const current = paneRef.current;
        // Hiding a cached pane blurs xterm, which may commit its pending IME text.
        // That abandoned input must reach neither the old PTY nor its held draft.
        if (!current || !presentedRef.current || !shownRef.current || observeRef.current || heldRef.current) return;
        // while a masked prompt is on screen, what is typed goes to the program or nowhere: never
        // into a draft, which is kept in the clear and offered back for review
        const secret = secretRef.current !== null || promptUnknownFor === current;
        const input = data;
        const key = keyFromData(data);
        const chord = enterChord ?? (!pasting && !composingRef.current && !compositionCommitPendingRef.current
          ? barKey !== null ? barKey.chord
            : physicalChord ?? (hasModifiers(modifiersRef.current) && key !== null ? terminalChord(key, modifiersRef.current) : null)
          : null);
        if (chord !== null && barKey === null && physicalChord === null && enterChord === null) consumeModifiers();
        if (draftHeldForRef.current === current) {
          // A chord or a modified Enter is never held, and never sent beside held text either
          // (Ctrl+J, or Ctrl+Enter under modifyOtherKeys, would run the line).
          // A paste the draft cannot take (an unbracketed tab or control character) is refused too, never sent
          // ahead of the held start.
          const pasted = pasting || input.startsWith("\x1b[200~");
          if (chord !== null || modifiedEnter || (pasted && applyToDraft(EMPTY_DRAFT, input) === EMPTY_DRAFT)) {
            const t = tRef.current;
            setInputError(t("Not sent: send or discard the held input first."));
            return;
          }
          // Text, a paste, Backspace (Ctrl+Backspace's word erase too) and anything with a line break go to the draft, which leaves
          // Enter out, so a partial command never runs. Other control keys (Ctrl+C, Escape, Tab,
          // arrows) still reach the program below: an interrupt must not wait on the draft.
          if (pasted || /[\r\n\x7f\b\x17]/.test(input) || applyToDraft(EMPTY_DRAFT, input) !== EMPTY_DRAFT) {
            if (secret) {
              const t = tRef.current;
              setInputError(t("Not sent: send or discard the held input first."));
              return;
            }
            setDraft((prev) => applyToDraft(prev, input));
            return;
          }
        }
        // Herdr, rather than xterm's legacy encoder, preserves all modifier bits
        // in the keyboard protocol requested by the program in this pane.
        // herdr's attach stream never tells xterm that the program asked for application cursor
        // keys (DECCKM), so xterm's `ESC [ A` misses in less, git log and other full-screen
        // programs. herdr encodes a named key in the program's own mode (#621). A key the socket
        // cannot take now goes the way typing does below, as an arrow always did. hc's attach does
        // tell xterm, and there sendTyped types the arrow as xterm encoded it.
        const arrow = chord === null && !pasting && !composingRef.current && !compositionCommitPendingRef.current && key?.startsWith("Arrow")
          ? terminalChord(key, NO_STICKY_MODIFIERS) : null;
        const typed: Typed = { input, keys: arrow !== null ? [arrow] : chord !== null ? [chord] : null, chord: chord !== null, stop: stopKey !== null && input === "\u001b", secret,
          // a Stop's keys are dated to the Stop: its second Escape, sent later, goes only over a link up since then
          // xterm's own reply (automatic) belongs to no typing: it neither takes nor clears the mark
          typedAt: pasteMark ?? stopKey ?? (automatic ? null : beganMark) ?? markTyped(),
          ...(arrow !== null ? { arrowModeEpoch: arrowModeWitness === arrowModeEpoch ? arrowModeEpoch : null } : {}), ...(automatic ? { automatic } : {}) };
        if (!composingRef.current && !automatic) beganMark = null;
        adoptTypeAhead(current);
        // typed into a tab taking its pane back from idleness: it waits for the new attach (never a password)
        if (resumeInput !== null && resumeInput.pane !== current) takeResume();
        // a mouse report is for the grid it was pressed on: the attach redraws the pane at another, so it is not kept
        if (resumeInput !== null && /^\x1b\[(<|M)/.test(input)) return;
        if (resumeInput !== null && !secret) {
          resumeInput.items.push(typed);
          return;
        }
        sendTyped(current, typed);
      });

      // Browsers expose dropped files as bytes, not local paths. Save them beside
      // the pane and paste the returned paths; never send Enter with a drop.
      let fileQueue: Promise<void> = Promise.resolve();
      const uploadFiles = (files: File[], still: () => boolean = () => true): void => {
        const pane = paneRef.current;
        if (!pane || !socket.connected || term.options.disableStdin) return;
        const typedAt = markTyped();
        fileQueue = fileQueue.then(() => uploadBatch(pane, files, still, typedAt));
      };
      const uploadBatch = async (pane: string, files: File[], still: () => boolean, typedAt: number): Promise<void> => {
        if (paneRef.current !== pane || !socket.connected || term.options.disableStdin) return;
        try {
          for (const file of files) assertAttachable(file);
          const paths: string[] = [];
          for (const file of files) paths.push(await uploadFileRef.current(pane, file));
          // An upload can finish after the user has switched panes or lost input access.
          if (paneRef.current !== pane || !activeRef.current || chatViewRef.current || !socket.connected || term.options.disableStdin || !still()) return;
          // a line break in a path (a pane's folder may hold one) would reach the program as Enter
          if (paths.some((path) => CONTROL_CHARACTER.test(path))) {
            const t = tRef.current;
            noteClipboard(t("Not pasted: the file's path holds a line break, which the terminal would take as Enter."));
            return;
          }
          pasteText(paths.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(" ") + " ", typedAt);
          if (activeRef.current && !findOpenRef.current) term.focus();
        } catch (error) {
          if (paneRef.current === pane) noteClipboard(error instanceof AttachmentTooLargeError ? error.message : plainError(error));
        }
      };
      attachFilesRef.current = uploadFiles;
      const onFilePaste = (event: ClipboardEvent): void => {
        // xterm handles text (and bracketed paste) itself. A file-only clipboard
        // needs the upload route instead; copied paths must remain native text.
        if (event.clipboardData?.getData("text/plain")) return;
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        uploadFiles(files);
      };
      const onDragOver = (event: DragEvent): void => {
        if (!event.dataTransfer) return;
        if (!event.dataTransfer.types.some((type) => type === "Files" || type === "text/plain")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = term.options.disableStdin ? "none" : "copy";
      };
      const onDrop = (event: DragEvent): void => {
        event.preventDefault();
        if (!event.dataTransfer || !socket.connected || term.options.disableStdin) return;
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) {
          uploadFiles(files);
          return;
        }
        const text = event.dataTransfer.getData("text/plain");
        if (text) {
          pasteText(text, markTyped());
          if (activeRef.current) term.focus();
        }
      };
      host.addEventListener("paste", onFilePaste, { capture: true });
      host.addEventListener("dragover", onDragOver);
      host.addEventListener("drop", onDrop);

      // Dragging a window edge fires this every frame. Each resize of the pty makes herdr
      // reflow the pane and the program in it redraw (Claude Code repaints its whole
      // conversation), so a drag of a long session sent over a hundred resizes and the app
      // lagged: fit once the size has settled.
      let resizeTimer: number | null = null;
      const observer = new ResizeObserver(() => {
        syncInputViewport();
        if (resizeTimer !== null) window.clearTimeout(resizeTimer);
        resizeTimer = setTerminalTimeout(() => {
          resizeTimer = null;
          // the grid belongs to the pty while observing, and to herdr when fixed: only the view moves
          // (a soft keyboard opening must not leave the prompt under it)
          if (adopted()) {
            panned = false;
            fold.sync();
            followCursor();
            return;
          }
          // the chat lens covers the grid: a phone's viewport or keyboard must not resize the
          // shared pty under another device (#361); the switch back to the terminal refits
          if (chatViewRef.current || !sizesPty()) return;
          if (keyboardHolds(false)) return;
          const force = heldForce;
          try {
            fit.fit();
            fitted();
          } catch {
            return;
          }
          const current = paneRef.current;
          if (current && inUse()) socket.resize(current, term.cols, term.rows, force);
        }, RESIZE_SETTLE_MS);
      });
      observer.observe(host);

      // Touch screens never emit wheel events and xterm.js has no touch scrolling:
      // translate a single-finger drag on the terminal into wheel events, so the
      // normal buffer scrolls its own viewport and the alternate buffer (with mouse
      // reporting on) forwards the gesture to herdr, exactly like a mouse wheel.
      // The text follows the finger, as everywhere on a phone: dragging down brings
      // older lines in. Each event carries the finger's position, since xterm reports
      // a wheel at the cell under it (without one, every report said row 1, column 1).
      let touchX = 0;
      let touchY = 0;
      let touchPixels = 0;
      let tracking = false;
      const touchPacer = createTouchWheelPacer();
      const touchVelocity = createVelocityTracker();
      const touchFling = createTouchFling();
      let touchTravel = 0;
      let touchPane: string | null = null;
      let touchGeneration = -1;
      const stopTouchScroll = (): void => {
        touchFling.cancel();
        delete host.dataset.touchFling;
        touchPacer.cancel();
      };
      cancelTouchRef.current = () => {
        stopTouchScroll();
        touchPixels = 0;
        tracking = false;
      };
      let pinch: { first: number; second: number; startSize: number; startDistance: number; size: number; startCols: number; startRows: number } | null = null;
      let pinchStroke = false;
      let pinchWatchPending = false;
      let pinchStatusFrame: number | null = null;
      const spread = (a: Touch, b: Touch): number => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
      const hidePinchBadge = (): void => {
        if (pinchBadgeRef.current) pinchBadgeRef.current.hidden = true;
      };
      const applyLiveFont = (size: number): void => {
        if (baseFontRef.current === size) return;
        baseFontRef.current = size;
        term.options.fontSize = size;
        fitLineHeight(term);
        if (adopted() || chatViewRef.current) return;
        try {
          fit.fit();
          fitted();
        } catch {
          return;
        }
      };
      const finishPinch = (save: boolean): void => {
        const finished = pinch;
        pinchingRef.current = false;
        if (finished && (!save || finished.size === finished.startSize)) applyLiveFont(finished.startSize);
        pinch = null;
        const current = paneRef.current;
        if (pinchWatchPending && current && releasedRef.current && watchingRef.current) socket.watch(current, term.cols, term.rows);
        pinchWatchPending = false;
        if (finished && !(save && finished.size !== finished.startSize) && (term.cols !== finished.startCols || term.rows !== finished.startRows)
            && current && inUse() && !adopted() && !chatViewRef.current && sizesPty()) socket.resize(current, term.cols, term.rows, true);
        if (finished && save && finished.size !== finished.startSize) {
          // a pinch can end after the pane went behind a sibling of its split: it saves the size, sizing no pty
          if (current && inUse() && !adopted() && !chatViewRef.current && sizesPty()) socket.resize(current, term.cols, term.rows, true);
          updateSettings({ terminalFontSize: finished.size });
          const t = tRef.current; // the language of now, not of the attach
          if (pinchStatusFrame !== null) cancelAnimationFrame(pinchStatusFrame);
          if (pinchStatusRef.current) pinchStatusRef.current.textContent = "";
          pinchStatusFrame = requestAnimationFrame(() => {
            pinchStatusFrame = null;
            if (pinchStatusRef.current) pinchStatusRef.current.textContent = t("Terminal text size {px} px", { px: finished.size });
          });
        }
        hidePinchBadge();
      };
      const claimPinch = (event: Event): void => {
        event.preventDefault();
        // the host listens in the capture phase: xterm's own touch listeners on its element must not
        // scroll its viewport with the first finger of a pinch
        event.stopPropagation();
      };
      const onTouchStart = (event: TouchEvent): void => {
        if (chatViewRef.current) return;
        stopTouchScroll();
        if (event.touches.length === 1 && pinchStroke) {
          finishPinch(false);
          pinchStroke = false;
        }
        if (pinchStroke) {
          claimPinch(event);
          return;
        }
        if (event.touches.length >= 2) {
          if (pinchStatusFrame !== null) cancelAnimationFrame(pinchStatusFrame);
          pinchStatusFrame = null;
          tracking = false;
          pinchStroke = true;
          claimPinch(event);
          const a = event.touches[0];
          const b = event.touches[1];
          if (event.touches.length !== 2 || !a || !b ||
              !host.contains(a.target as Node) || !host.contains(b.target as Node) ||
              spread(a, b) <= 0) return;
          const startSize = baseFontRef.current;
          pinch = { first: a.identifier, second: b.identifier, startSize, startDistance: spread(a, b), size: startSize, startCols: term.cols, startRows: term.rows };
          pinchingRef.current = true;
          if (pinchBadgeRef.current) {
            pinchBadgeRef.current.textContent = `${startSize}px`;
            pinchBadgeRef.current.hidden = false;
          }
          return;
        }
        tracking = event.touches.length === 1;
        touchPixels = 0;
        touchTravel = 0;
        touchVelocity.reset();
        const first = event.touches[0];
        if (tracking && first) {
          touchX = first.clientX;
          touchY = first.clientY;
          touchVelocity.add(event.timeStamp, 0);
          touchPane = paneRef.current;
          touchGeneration = outputGeneration;
        }
      };
      const onTouchMove = (event: TouchEvent): void => {
        if (!pinchStroke && event.touches.length > 1) {
          stopTouchScroll();
          tracking = false;
          pinchStroke = true;
        }
        if (pinchStroke) {
          claimPinch(event);
          if (pinch && event.touches.length === 2) {
            let first: Touch | undefined;
            let second: Touch | undefined;
            for (let i = 0; i < event.touches.length; i++) {
              const touch = event.touches[i]!;
              if (touch.identifier === pinch.first) first = touch;
              if (touch.identifier === pinch.second) second = touch;
            }
            if (first && second) {
              const size = pinchFontSize(pinch.startSize, pinch.startDistance, spread(first, second));
              if (size !== pinch.size) {
                pinch.size = size;
                applyLiveFont(size);
                if (pinchBadgeRef.current) pinchBadgeRef.current.textContent = `${size}px`;
              }
            }
          }
          return;
        }
        if (!tracking || event.touches.length !== 1) return;
        event.preventDefault();
        const first = event.touches[0];
        if (!first) return;
        const delta = touchY - first.clientY;
        const across = touchX - first.clientX;
        touchX = first.clientX;
        touchY = first.clientY;
        const edged = scrollableMirror() || (fold.active && !adopted());
        if ((adopted() || fold.active) && (!edged || canPanTerminalGrid(host, delta))) {
          touchPixels = 0;
          touchVelocity.reset();
          stopTouchScroll();
          panned = true;
          host.scrollBy(fold.active ? 0 : across, delta);
          return;
        }
        if (scrollableMirror() && !fold.active && across !== 0) host.scrollBy(across, 0);
        // xterm sends herdr one report per wheel event however far it went, and herdr scrolls a
        // few lines per report: one line-mode wheel per that many rows of finger travel keeps a
        // swipe as far as a slow drag, and the text under the finger
        const { steps, rest } = wheelSteps(touchPixels + delta, cellHeight() * HERDR_MOUSE_SCROLL_LINES);
        touchPixels = rest;
        touchTravel += delta;
        touchVelocity.add(event.timeStamp, touchTravel);
        sendTouchWheels(steps);
      };
      const sendTouchWheels = (steps: number): void => {
        if (steps === 0) return;
        if (scrollableMirror() || wheelStateRef.current.omoQuestion) {
          lineScroll.current?.(-steps * HERDR_MOUSE_SCROLL_LINES);
          return;
        }
        // history this terminal keeps itself (syncHistory) scrolls here, as a real wheel scrolls it: the
        // wheel dispatched below lands past xterm's viewport, which would type arrow keys to the program
        if ((term.options.scrollback ?? 0) > 0 && !terminalScreen(term).alternate && term.modes.mouseTrackingMode === "none") {
          term.scrollLines(steps * HERDR_MOUSE_SCROLL_LINES);
          return;
        }
        const target = term.element ?? host;
        // each report belongs to this pane, this attach and this role: one that is not current when
        // its frame comes drops the rest of the swipe instead of sending it
        const pane = paneRef.current;
        const generation = outputGeneration;
        const clientX = touchX;
        const clientY = touchY;
        touchPacer.push(steps, {
          allowed: () => !disposed && pane !== null && paneRef.current === pane && generation === outputGeneration
            && !observeRef.current && !heldRef.current && !releasedRef.current && !adopted() && socket.canInput(pane),
          emit: (sign) => {
            touchWheelDispatching = true;
            try {
              target.dispatchEvent(new WheelEvent("wheel", {
                bubbles: true, cancelable: true, deltaY: sign, deltaMode: WheelEvent.DOM_DELTA_LINE, clientX, clientY,
              }));
            } finally {
              touchWheelDispatching = false;
            }
          },
        });
        if (touchPacer.dropped > 0) host.dataset.touchWheelDropped = String(touchPacer.dropped);
      };
      const onTouchEnd = (event: TouchEvent): void => {
        if (tracking && event.type === "touchend" && !pinchStroke && (!adopted() || scrollableMirror())) {
          const velocity = touchVelocity.release(event.timeStamp);
          const pane = touchPane;
          const generation = touchGeneration;
          let left = touchPixels;
          // the glide belongs to the pane and attach the touch began on: a switch, a lost attach or a
          // role change, even one before the lift, stops it, as they drop the swipe's queued reports
          // (sendTouchWheels' pacer checks them too)
          const current = (): boolean => !disposed && pane !== null && paneRef.current === pane && generation === outputGeneration
            && !observeRef.current && !heldRef.current && !releasedRef.current && (!adopted() || scrollableMirror()) && socket.canInput(pane);
          host.dataset.touchFling = "";
          touchFling.start(velocity, (pixels) => {
            if (!current()) {
              delete host.dataset.touchFling;
              return false;
            }
            const { steps, rest } = wheelSteps(left + pixels, cellHeight() * HERDR_MOUSE_SCROLL_LINES);
            left = rest;
            sendTouchWheels(steps);
            return true;
          }, () => {
            delete host.dataset.touchFling;
            if (current()) sendTouchWheels(finalStep(left, cellHeight() * HERDR_MOUSE_SCROLL_LINES));
          });
        }
        touchPixels = 0;
        tracking = false;
        if (!pinchStroke) return;
        claimPinch(event);
        if (event.type === "touchcancel" || event.touches.length < 2) finishPinch(event.type === "touchend");
        if (event.touches.length === 0) pinchStroke = false;
      };
      // Safari zooms inside an overflow region (xterm's viewport) despite touch-action: none
      const onGesture = (event: Event): void => { if (!chatViewRef.current) event.preventDefault(); };
      host.addEventListener("touchstart", onTouchStart, { capture: true, passive: false });
      // a finger landing anywhere else on the page (a second one beside the swipe too) never reaches
      // the host's listener: it ends the swipe all the same
      const onPageTouchStart = (event: TouchEvent): void => {
        if (event.touches.length > 1 || !(event.target instanceof Node && host.contains(event.target))) cancelTouchRef.current();
      };
      document.addEventListener("touchstart", onPageTouchStart, { capture: true, passive: true });
      host.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
      host.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
      host.addEventListener("touchcancel", onTouchEnd, { capture: true, passive: false });
      host.addEventListener("gesturestart", onGesture, { passive: false });
      host.addEventListener("gesturechange", onGesture, { passive: false });

      // The pty is shared per pane: a client on another device (typically a phone)
      // resizes it to its own geometry, and this tab's viewport never changed, so
      // the ResizeObserver above stays silent and the pane is left at the other
      // device's size. Re-assert our geometry whenever the user comes back to this
      // tab: its window takes the focus, or it turns visible with the focus. Observe
      // connections never do this: they own no geometry to re-assert.
      const refit = (): void => {
        const current = paneRef.current;
        if (!current || observeRef.current || fixedGridRef.current || chatViewRef.current || !sizesPty() || keyboardHolds(true)) return;
        try {
          fit.fit();
          fitted();
        } catch {
          return;
        }
        socket.resize(current, term.cols, term.rows, true);
      };
      // herdr holds a pane at the size of a `terminal attach` for as long as one is attached, and its
      // own TUI cannot take it back (0.9.3): this window, left open behind it, kept the pane at the
      // window's size, and the TUI drew it cut off at its split's edge with its bottom rows out of
      // reach. So a tab out of use lets go of its pane: once the last attach ends, herdr gives the
      // pane back to its TUI. The tab attaches again when the user is back. A message queued here
      // goes out through this tab's attach, so the tab keeps the pane until the message has gone; a
      // mirrored pane holds no attach, and a page inside another page (the site's demo) has the
      // focus only while it is clicked into.
      const embedded = window.self !== window.top;
      const queueWaits = (pane: string): boolean => {
        if (submitRetention?.has(pane)) return true;
        if ([...pendingSubmissionsRef.current].some((submission) => submission.pane === pane
          && submission.socket === socket && submission.epoch === pendingEpochRef.current)) return true;
        const owner = paneStorageId(machineId, pane);
        return pendingMessages.read(owner).some((message) => pendingMessages.isOwned(owner, message.id, pendingScopeRef.current)
          && (message.state === "queued" || message.state === "sending"));
      };
      let releaseTimer: number | null = null;
      let queueHeld = false;
      const cancelLeave = (): void => {
        if (releaseTimer !== null) window.clearTimeout(releaseTimer);
        releaseTimer = null;
        queueHeld = false;
        idleReleased = false;
        setIdleView(false);
        failResume();
      };
      cancelLeaveRef.current = cancelLeave;
      const release = (idle = false): void => {
        cancelLeave();
        const current = paneRef.current;
        if (!current || embedded || mirroredRef.current || fixedGridRef.current) return;
        if (cachedRef.current && releasedRef.current) {
          afterSwitch(reconcileView);
          return;
        }
        if (releasedRef.current || (!idle && !cachedRef.current
          && (!(releaseAwayRef.current || hiddenOnTouch()) || inUse() || endedRef.current))) return;
        if (queueWaits(current)) {
          queueHeld = !idle;
          return;
        }
        socket.detach(current);
        // the attach's output is over: what is still queued has no ACK to send and copies nothing
        retireOutput();
        // The server's detach receipt holds pending input on this still-live PC connection.
        setReleased(true);
        cachedReleaseRef.current = cachedRef.current;
        if (!cachedRef.current) watch(current);
        else afterSwitch(reconcileView);
        if (idle) {
          inputWasReady = false;
          idleReleased = true;
          setIdleView(true);
        }
      };
      const idleCheck = (): void => {
        idleTimer = null;
        const pane = paneRef.current;
        if (disposed || !pane || releasedRef.current) return;
        const quiet = performance.now() - lastActivity;
        if (quiet < IDLE_RELEASE_MS) {
          armIdle(IDLE_RELEASE_MS - quiet);
          return;
        }
        if (!idleReleaseRef.current || embedded || mirroredRef.current || fixedGridRef.current || observeRef.current
          || heldRef.current || stalledRef.current || endedRef.current || chatViewRef.current || followRef.current
          || cachedRef.current || !shownRef.current || !presentedRef.current || !socket.canWatch() || findOpenRef.current
          || composingRef.current || compositionCommitPendingRef.current || secretRef.current !== null || terminalScreen(term).hasSelection()
          || queueWaits(pane)) {
          noteActivity();
          armIdle();
          return;
        }
        release(true);
      };
      // A hidden page cannot draw a view: the browser holds its frames until the page is shown,
      // then parses the whole burst at once (the return's freeze), while the unacknowledged
      // server queue grows until the socket is closed (4008) on a weak link.
      const stopWatch = (): void => {
        if (viewPane !== null && watchingRef.current) {
          socket.unwatch(viewPane);
          setWatching(false);
          if (!cachedRef.current) setViewHeld(true);
        }
        if (viewBuffer !== null) viewDropped = true;
        viewBuffer = null;
        viewBytes = 0;
      };
      const watch = (pane: string): void => {
        // a bridge without a read-only view (herdr-core) has nothing to start the screen again from:
        // the pane keeps its last screen until the next attach, which resets it (resume)
        if (!socket.canWatch()) {
          setWatching(false);
          return;
        }
        if (document.visibilityState === "hidden") {
          setViewHeld(true);
          return;
        }
        const generation = ++outputGeneration;
        viewPane = pane;
        if (!presentedRef.current) {
          viewBuffer = ["\x1bc"];
          viewBytes = 2;
          modifyOtherKeysRef.current = 0;
          setWatching(socket.watch(pane, term.cols, term.rows));
          return;
        }
        // Reset in stream order: the attach's queued writes must not draw over the view.
        writeOutput("\x1bc", false, () => {
          if (disposed || paneRef.current !== pane || generation !== outputGeneration) return;
          modifyOtherKeysRef.current = 0;
        });
        modifyOtherKeysRef.current = 0;
        setWatching(socket.watch(pane, term.cols, term.rows));
      };
      const reconcileView = (): void => {
        const current = paneRef.current;
        if (disposed || !current || !cachedRef.current || !releasedRef.current) return;
        const keep = cachedReleaseRef.current && watchedRef.current && inUse() && !releaseAwayRef.current && socket.canWatch();
        if (keep && !watchingRef.current) watch(current);
        else if (!keep && watchingRef.current) { socket.unwatch(viewPane ?? current); setWatching(false); }
      };
      // keep_size prevents resizing an existing attach, but a fresh sidecar still sizes the pane.
      // The client cannot distinguish those cases atomically, so both watch until the user returns.
      const deferAttach = (pane: string): boolean => {
        deferredAttach = false;
        if (inUse() && !cachedRef.current || embedded || mirroredRef.current || fixedGridRef.current || queueWaits(pane) || !socket.canWatch()) return false;
        cancelLeave();
        deferredAttach = true;
        setReleased(true);
        cachedReleaseRef.current = false;
        if (!cachedRef.current && mirroredRef.current !== null) watch(pane);
        return true;
      };
      deferAttachRef.current = deferAttach;
      const offBeforeReplay = socket.onBeforeReplay(() => {
        const pane = paneRef.current;
        if (!pane || releasedRef.current) return;
        if (deferAttach(pane)) socket.detach(pane);
      });
      releaseRef.current = () => { if (queueHeld) release(); };
      const onWatchedResize = term.onResize(({ cols, rows }) => {
        const current = paneRef.current;
        if (!current || !releasedRef.current || !watchingRef.current) return;
        if (pinch) pinchWatchPending = true;
        else socket.watch(current, cols, rows);
      });
      const resume = (): void => {
        if (!presentedRef.current) return;
        deferredAttach = false;
        setReleased(false);
        const current = paneRef.current;
        if (!current) return;
        if (watchingRef.current) socket.unwatch(viewPane ?? current);
        setWatching(false);
        // A fresh attach says attach_held again if needed; success does not send attach-resumed.
        const wasHeld = heldRef.current;
        setHeld(false);
        // and what the hold closed opens with it: the key that takes the pane back, and those typed before the new
        // attach's screen is drawn, go where typing goes now (onData) instead of being dropped by the terminal. Taken as
        // a password until that screen is read: sent to the pane or told, never put in a draft
        if (wasHeld) {
          term.options.disableStdin = observeRef.current || endedRef.current;
          promptUnknownFor = current;
        }
        const generation = ++outputGeneration;
        invalidateArrowModes();
        endRecovery();
        // Reset in stream order: synchronous reset would let old queued writes draw afterward.
        // A frame the old stream left open is not the new one's
        frameGateRef.current.reset();
        const drewView = viewBuffer !== null && viewBuffer.length > 1;
        const viewReset = viewDropped || viewBuffer !== null;
        if (drewView && viewBuffer !== null) {
          // marked replay: a copy request in it was answered when it was new (OSC 52 above)
          writeOutput(viewBuffer.join(""), true, () => {
            if (!disposed && paneRef.current === current) modifyOtherKeysRef.current = 0;
          }, true);
        }
        viewBuffer = null;
        viewBytes = 0;
        holdViews();
        if (!cachedReleaseRef.current || viewReset && !drewView) {
          writeOutput("\x1bc", false, () => {
            if (disposed || paneRef.current !== current || generation !== outputGeneration) return;
            modifyOtherKeysRef.current = 0;
          });
          modifyOtherKeysRef.current = 0;
        }
        cachedReleaseRef.current = false;
        viewDropped = false;
        setInputReady(false);
        setOutputReady(false);
        if (!observeRef.current && !chatViewRef.current && shownRef.current && !keyboardHolds(true)) {
          try {
            fit.fit();
            fitted();
          } catch {
          }
        }
        const away = !inUse();
        adoptTypeAhead(current);
        socket.attach(current, term.cols, term.rows, chatViewRef.current || away || !shownRef.current || followRef.current || coveredRef.current || keyboardHeld);
        if (away) leave();
      };
      const leave = (): void => {
        if (idleReleased) {
          idleReleased = false;
          setIdleView(false);
        }
        if (cachedRef.current) { release(); return; }
        const current = paneRef.current;
        if (current && !observeRef.current && !fixedGridRef.current) socket.keepSize(current, document.visibilityState === "hidden");
        if (!keyboardHeld && takeKeptCoreGrid(term, socket, current, sharedGridRef.current)) followCursorRef.current();
        if (releaseAwayRef.current && releaseTimer === null && !releasedRef.current) releaseTimer = setTerminalTimeout(() => {
          if (paneRef.current === current) release();
        }, RELEASE_AFTER_MS);
        if (hiddenOnTouch()) release();
      };
      leaveRef.current = leave;
      // The PC's connection stopped on an overload close (4008), or an attach conflicted: attach again
      // in place, as a pane pick does. The attach reconnects, and the connection's open replays every
      // pane this PC has attached; their snapshot clears what is left of the notice.
      const reattach = (): void => {
        if (!presentedRef.current || !paneRef.current) return;
        stalledRef.current = false;
        setOutputError(null);
        setEnded(false);
        resume();
        term.options.disableStdin = observeRef.current || heldRef.current;
      };
      reattachRef.current = reattach;
      const back = (): void => {
        if (!presentedRef.current) {
          if (cachedRef.current && releasedRef.current) release();
          return;
        }
        // the key, click or paste that takes an idle pane back is held with what follows it until the attach
        // takes input; offline, typing is held for review as before (nothing goes by itself after a disconnect)
        const resumeFor = idleReleased && releasedRef.current && socket.connected ? paneRef.current : null;
        cancelLeave();
        if (resumeFor !== null) startResume(resumeFor);
        // A pane that kept its attach while put away (a queued message, a mirror) stopped because its
        // frozen page sent no ACKs, not because this device is too slow: coming back attaches again,
        // once. A stop while the page stays in use is final (no reconnect loop).
        if (stalledRef.current && socket.stoppedWhileHidden && inUse()) reattach();
        else if (releasedRef.current) resume();
        else refit();
      };
      presentationRef.current = () => {
        if (cachedRef.current) release();
        else if (presentedRef.current && releasedRef.current) {
          if (inUse() || mirroredRef.current) back();
          else if ((cachedReleaseRef.current || deferredAttach && !watchingRef.current) && paneRef.current) {
            if (!deferAttach(paneRef.current)) back();
          }
          else if (paneRef.current && !watchingRef.current) watch(paneRef.current);
        } else if (presentedRef.current && inUse() && paneRef.current && !observeRef.current) {
          socket.keepSize(paneRef.current, !shownRef.current);
          refit();
        }
      };
      // A phone or tablet put away lets go of the pane at once, whatever the setting: its page can
      // freeze before a timer runs, and its attach would keep herdr's own window at the phone's size.
      const hiddenOnTouch = (): boolean => coarseRef.current && document.visibilityState === "hidden";
      const onVisibility = (): void => {
        const pane = paneRef.current;
        if (document.visibilityState === "hidden") stopWatch();
        if (inUse()) back();
        else {
          leave();
          if (hiddenOnTouch()) release();
          else if (document.visibilityState === "visible" && pane && releasedRef.current && !cachedRef.current
            && !watchingRef.current && mirroredRef.current === false && presentedRef.current) watch(pane);
        }
      };
      // Another device can size the pty while this window keeps its focus (a phone used beside a
      // PC left in front): no focus event comes back here, so a click or key in this terminal
      // takes the pane back to this window's grid.
      // Only input meant for the terminal itself: a press or key in the find bar or the key bar,
      // a right-click for the pane menu, a held key's repeats or an IME composition
      // must not resize the pty under the other device.
      // A phone's own input paths sit outside the grid (the input line, its Send and Enter, a key the
      // key bar sends, not a press on it), so they call this before they send: the reply is then
      // drawn for the grid that shows it.
      const reassertIfStale = (): void => {
        noteActivity();
        if (idleReleased && releasedRef.current) {
          back();
          return;
        }
        const shared = sharedGridRef.current;
        if (!shared || releasedRef.current || !inUse()) return;
        if ((keepsCoreGrid() && sizesPty()) || shared.cols !== term.cols || shared.rows !== term.rows) refit();
      };
      reassertIfStaleRef.current = reassertIfStale;
      const reclaim = (event: Event): void => {
        if (!(event.target instanceof Node) || !term.element?.contains(event.target)) return;
        noteActivity();
        // an IME's first key comes before compositionstart, with isComposing still false (keyCode 229)
        if (event instanceof KeyboardEvent && (event.repeat || event.isComposing || event.keyCode === 229 || composingRef.current || compositionCommitPendingRef.current)) return;
        if (event instanceof PointerEvent && event.button !== 0) return;
        if (releasedRef.current) back();
        else reassertIfStale();
      };
      const onPointer = (event: PointerEvent): void => {
        const inStack = stackRef.current?.contains(event.target as Node) ?? false;
        if (inStack) noteActivity();
        if (releasedRef.current && inStack) back();
        else reclaim(event);
      };
      // Text that comes with no key first (a paste from the menu, an IME's composition, a phone keyboard's input) is
      // typing too: it takes an idle pane back before xterm reads it, so onData holds it for the new attach.
      const onTyping = (event: Event): void => {
        if (!(event.target instanceof Node) || !term.element?.contains(event.target)) return;
        noteActivity();
        if (idleReleased && releasedRef.current) back();
      };
      const onWheelActivity = (): void => noteActivity();
      window.addEventListener("focus", back);
      window.addEventListener("blur", leave);
      window.addEventListener("pointerdown", onPointer, { capture: true });
      window.addEventListener("keydown", reclaim, { capture: true });
      window.addEventListener("beforeinput", onTyping, { capture: true });
      window.addEventListener("paste", onTyping, { capture: true });
      window.addEventListener("compositionstart", onTyping, { capture: true });
      host.addEventListener("wheel", onWheelActivity, { capture: true, passive: true });
      document.addEventListener("visibilitychange", onVisibility);

      return () => {
        disposed = true;
        term.options.disableStdin = true;
        pendingScopeRef.current = null;
        window.clearInterval(poll);
        observer.disconnect();
        fold.dispose();
        wideGrids.set(wideOwner, null);
        if (resizeTimer !== null) window.clearTimeout(resizeTimer);
        host.removeEventListener("touchstart", onTouchStart, { capture: true });
        document.removeEventListener("touchstart", onPageTouchStart, { capture: true });
        host.removeEventListener("touchmove", onTouchMove, { capture: true });
        host.removeEventListener("touchend", onTouchEnd, { capture: true });
        host.removeEventListener("touchcancel", onTouchEnd, { capture: true });
        touchFling.dispose();
        delete host.dataset.touchFling;
        touchPacer.dispose();
        cancelTouchRef.current = () => undefined;
        host.removeEventListener("gesturestart", onGesture);
        host.removeEventListener("gesturechange", onGesture);
        finishPinch(false);
        if (pinchStatusFrame !== null) cancelAnimationFrame(pinchStatusFrame);
        host.removeEventListener("mousedown", onMouseDown, { capture: true });
        window.removeEventListener("mousemove", onMouseMove, { capture: true });
        window.removeEventListener("blur", onBlur);
        window.removeEventListener("mouseup", onMouseUp);
        for (const type of ["keydown", "keyup", "mousemove"] as const) window.removeEventListener(type, onLinkKey, { capture: true });
        window.removeEventListener("blur", offLinkKey);
        window.removeEventListener("online", onOnline);
        host.removeEventListener("copy", onCopy);
        stopEdge();
        selectionChange.dispose();
        if (releaseTimer !== null) window.clearTimeout(releaseTimer);
        if (idleTimer !== null) window.clearTimeout(idleTimer);
        if (resumeTimer !== null) window.clearTimeout(resumeTimer);
        dropViewChange(reconcileView);
        releaseRef.current = () => {};
        presentationRef.current = () => {};
        leaveRef.current = () => {};
        typeAheadRef.current = () => {};
        cancelLeaveRef.current = () => {};
        reattachRef.current = () => {};
        attachFilesRef.current = () => {};
        keyboardHoldsRef.current = () => false;
        fittedRef.current = () => {};
        deferAttachRef.current = () => false;
        offBeforeReplay();
        onWatchedResize.dispose();
        window.removeEventListener("focus", back);
        window.removeEventListener("blur", leave);
        window.removeEventListener("pointerdown", onPointer, { capture: true });
        window.removeEventListener("keydown", reclaim, { capture: true });
        window.removeEventListener("beforeinput", onTyping, { capture: true });
        window.removeEventListener("paste", onTyping, { capture: true });
        window.removeEventListener("compositionstart", onTyping, { capture: true });
        host.removeEventListener("wheel", onWheelActivity, { capture: true });
        reassertIfStaleRef.current = () => undefined;
        document.removeEventListener("visibilitychange", onVisibility);
        onModifiedEnter.dispose();
        onCommandBackspace.dispose();
        inputViewportResize.dispose();
        frameResize.dispose();
        inputScreenResize.disconnect();
        host.removeEventListener("scroll", syncInputViewport);
        for (const type of keepTextOn) textarea?.removeEventListener(type, keepText, true);
        host.removeEventListener("keydown", onCommandArrow);
        onData.dispose();
        userInput.dispose();
        host.removeEventListener("paste", onPaste, true);
        host.removeEventListener("keydown", onTyped, true);
        host.removeEventListener("input", onTyped, true);
        host.removeEventListener("paste", onTyped, true);
        host.removeEventListener("paste", onFilePaste, { capture: true });
        host.removeEventListener("compositionstart", textBegan, true);
        host.removeEventListener("paste", textBegan, true);
        host.removeEventListener("keydown", plainKey, true);
        host.removeEventListener("compositionend", compositionDone, true);
        host.removeEventListener("dragover", onDragOver);
        host.removeEventListener("drop", onDrop);
        offDisconnect();
        editor?.removeEventListener("input", noteRefusedText, true);
        outputFrames.length = 0;
        parsingReplay = false;
        parsingCurrentPtyOutput = false;
        replayOscOpen = false;
        retireOutputRef.current = () => {};
        osc52.dispose();
        cancelCopy();
        for (const handler of queryReplies) handler.dispose();
        for (const handler of arrowModeWitnesses) handler.dispose();
        osc8.dispose();
        webLinks.dispose();
        modifyOtherKeysSet.dispose();
        modifyOtherKeysOff.dispose();
        if (clipboardTimerRef.current !== null) window.clearTimeout(clipboardTimerRef.current);
        off();
        if (!machineSessions) session.close();
        stopGlyphs();
        host.removeEventListener("compositionstart", compositionStart);
        host.removeEventListener("compositionend", compositionEnd);
        if (compositionEndTimer !== null) window.clearTimeout(compositionEndTimer);
        compositionCommitPendingRef.current = false;
        ghosttyFaintObserver.disconnect();
        releaseGhostty();
        term.element?.remove();
        disposeAfterPendingFrame(term);
        termRef.current = null;
        setTerminal((current) => current === term ? null : current);
        socketRef.current = null;
        sessionRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- one terminal for the mount; theme/font follow in their own effect
    }, []);
}
