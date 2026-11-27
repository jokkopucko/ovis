// allow: SIZE_OK - the terminal's facade keeps the write pipeline, the view and the events one object shares.
/**
 * libghostty parses and draws, our input layer (../terminalInput) takes keys, IME, paste,
 * focus and mouse reports, and our selection and links (../terminalSelection) take the pointer. The mount (useTerminalMount.ts) drives it.
 *
 * The view is one number, `fromBottom`: the rows it sits above the newest. 0 follows output, whatever resizes, reflows
 * or hidden repaints come; only the user's own scroll (wheel, swipe, page keys, a find) moves it off the bottom, and
 * output that arrives meanwhile keeps the rows in view where they are.
 */
import { TerminalInput, type TerminalInputModes, type TextAreaViewportBounds } from "../terminalInput/input.ts";
import { createLinkifier, createSelection, type ILinkProvider, type Linkifier, type LinkUnderline, type Selection } from "../terminalSelection/index.ts";
import { holdScreenRows, type ScreenRows } from "../terminalScreen.ts";
import { requestShownFrame } from "../shownFrame.ts";
import { fitCompositionView } from "../terminalGlyphs.ts";
import { wheelPansGrid } from "../terminalWheel.ts";
import type { PictureLimits } from "../itermPictures.ts";
import { GHOSTTY_DREW_EVENT, GHOSTTY_VIEW_EVENT, VIEW_MOVED_EVENT, ownView } from "./viewMoved.ts";
import { ghosttyRows } from "./screenRows.ts";
import { hookedStream, ParserHooks, type OscStringState } from "./hooks.ts";
import { itermPictureWriter } from "./itermPictureWriter.ts";
import { cellDimensions, measureChar, proposeGrid, type CellDimensions } from "./cellMetrics.ts";
import { createRowsRenderer, themeColors, type RendererTheme, type RowsRenderer } from "./renderer.ts";
import { GhosttyVt, rgb } from "./vt.ts";

export interface Disposable { dispose(): void }
/** what the mount sizes the grid with: the grid the element's parent fits, and fitting it (xterm's fit addon's two calls) */
export interface GhosttyFit { fit(): void; proposeDimensions(): { cols: number; rows: number } | undefined }
type Listener<T> = (value: T) => void;

class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>();
  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };
  fire(value: T): void { for (const listener of [...this.listeners]) listener(value); }
  clear(): void { this.listeners.clear(); }
}

export interface GhosttyTerminalOptions {
  fontFamily: string;
  fontSize: number;
  fontWeight?: string | number;
  fontWeightBold?: string | number;
  lineHeight: number;
  letterSpacing: number;
  theme: RendererTheme;
  scrollback: number;
  minimumContrastRatio: number;
  disableStdin: boolean;
  wordSeparator: string;
  macOptionClickForcesSelection: boolean;
  cursorStyle?: "block" | "underline" | "bar";
  cursorBlink?: boolean;
}

const DEFAULT_OPTIONS: GhosttyTerminalOptions = {
  fontFamily: "monospace", fontSize: 13, lineHeight: 1, letterSpacing: 0, theme: {}, scrollback: 0, minimumContrastRatio: 1,
  disableStdin: false, wordSeparator: " ()[]{}',\"`", macOptionClickForcesSelection: false,
};

/** the rows the app reads, as xterm's buffer gives them, with the screen up now */
export interface GhosttyBuffer extends ScreenRows { readonly type: "normal" | "alternate"; readonly alternate: boolean }

const EMPTY_ROWS: GhosttyBuffer = {
  type: "normal", alternate: false, length: 0, baseY: 0, viewportY: 0, cursorX: 0, cursorY: 0,
  getLine: () => undefined,
  getNullCell: () => ({ getChars: () => "", getWidth: () => 1, isBold: () => 0, isDim: () => 0, isItalic: () => 0, isUnderline: () => 0, isStrikethrough: () => 0, isOverline: () => 0, isInverse: () => 0, isInvisible: () => 0, isFgDefault: () => true, isBgDefault: () => true, isFgRGB: () => false, isBgRGB: () => false, getFgColor: () => -1, getBgColor: () => -1 }),
};

const MOUSE_PROTOCOL = { none: "none", x10: "x10", normal: "vt200", button: "drag", any: "any" } as const;
const MOUSE_ENCODING = { x10: "default", utf8: "default", urxvt: "default", sgr: "sgr", sgrPixels: "sgrPixels" } as const;
/** xterm's names for the mouse modes, which the mount compares against */
const TRACKING_NAME = { none: "none", x10: "x10", normal: "vt200", button: "drag", any: "any" } as const;

/** how long one task parses output before it lets the page draw and take input (xterm's write buffer budget) */
const WRITE_BUDGET_MS = 12;
/** how long a synchronized update may hold the screen before it is shown anyway (xterm's limit) */
const SYNC_HOLD_MS = 1000;
/** how many times in a row a terminal starts over with a new engine before it gives up */
const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 500;
/** an engine that drew this long without failing counts as well again: a later failure has every restart again */
const RESTARTS_FORGOTTEN_MS = 60_000;

/**
 * told on the pane's host when libghostty stopped drawing a terminal (ghostty/terminal.ts): `restarting` once a new engine
 * is in and the pane should be drawn again, or not when the terminal gave up
 */
export const TERMINAL_FAILED_EVENT = "ovis-terminal-failed";
export interface TerminalFailure { readonly error: unknown; readonly restarting: boolean }

interface Pending { readonly data: string | Uint8Array; readonly callback: (() => void) | undefined }

export class GhosttyTerminal {
  element: HTMLElement | undefined;
  textarea: HTMLTextAreaElement | undefined;
  readonly options: GhosttyTerminalOptions;
  readonly parser = new ParserHooks();
  cols: number;
  rows: number;
  private pictureCaps: PictureLimits | null = null;
  /** the limits pictures are drawn within, or null with pictures off (the mount's Settings choice) */
  get pictureLimits(): PictureLimits | null { return this.pictureCaps; }
  /** turned off, the pictures drawn go (Kitty's delete-all, given to the engine alone, never to the program) */
  set pictureLimits(limits: PictureLimits | null) {
    const off = limits === null && this.pictureCaps !== null;
    this.pictureCaps = limits;
    if (!off || !this.vt) return;
    this.clearPictures = true;
    this.clearPicturesBetweenSequences();
  }

  private clearPicturesBetweenSequences(): void {
    if (!this.clearPictures || !this.vt || !this.stream.idle()) return;
    this.clearPictures = false;
    try { this.vt.write("\x1b_Ga=d,d=A\x1b\\"); } catch (error) { this.fail(error); }
    this.schedule();
  }
  /**
   * Whether the output being parsed now is the program's live output, which libghostty may answer. The mount says no
   * for a replay of earlier output, a hidden tab's view and output of a pane it left: their questions were answered
   * when they were new, and an answer now would reach the program as typing.
   */
  replyGate: () => boolean = () => true;

  private readonly onDataEmitter = new Emitter<string>();
  private readonly onBinaryEmitter = new Emitter<string>();
  private readonly onKeyEmitter = new Emitter<{ key: string; domEvent: KeyboardEvent }>();
  private readonly onResizeEmitter = new Emitter<{ cols: number; rows: number }>();
  private readonly onRenderEmitter = new Emitter<{ start: number; end: number }>();
  private readonly onScrollEmitter = new Emitter<number>();
  private readonly onWriteParsedEmitter = new Emitter<void>();
  private readonly onSelectionChangeEmitter = new Emitter<void>();
  private readonly onUserInputEmitter = new Emitter<void>();
  readonly onData = this.onDataEmitter.event;
  readonly onBinary = this.onBinaryEmitter.event;
  readonly onKey = this.onKeyEmitter.event;
  readonly onResize = this.onResizeEmitter.event;
  readonly onRender = this.onRenderEmitter.event;
  readonly onScroll = this.onScrollEmitter.event;
  readonly onWriteParsed = this.onWriteParsedEmitter.event;
  readonly onSelectionChange = this.onSelectionChangeEmitter.event;

  private host: HTMLElement | undefined;
  private screen: HTMLElement | undefined;
  private inputLayer: TerminalInput | undefined;
  private selection: Selection | undefined;
  private linkifier: Linkifier | undefined;
  private underline: HTMLElement | undefined;
  private viewport: HTMLElement | undefined;
  private selectionLayer: HTMLElement | undefined;
  private drawnSelectionKey = "";
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private restarts = 0;
  private broken = false;
  /** the pictures were turned off inside a sequence: they are cleared once the stream is between sequences */
  private clearPictures = false;
  private readonly earlyLinks: { provider: ILinkProvider; registered: Disposable | null }[] = [];
  private vt: GhosttyVt | null = null;
  private renderer: RowsRenderer | null = null;
  private failed: unknown = null;
  private disposed = false;
  /** true until the engine is in: what is written waits in `writes` */
  private pending = true;
  private readonly writes: Pending[] = [];
  private draining: ReturnType<typeof setTimeout> | null = null;
  private decoder = new TextDecoder();
  private readonly stream = hookedStream(this.parser, (text) => this.vt?.write(text));
  private readonly pictures = itermPictureWriter(
    () => this.pictureCaps,
    () => ({ cols: this.cols, rows: this.rows, cellW: this.dims?.cell.width ?? 0, cellH: this.dims?.cell.height ?? 0 }),
    () => rgb(themeColors(this.options.theme).background) ?? [0, 0, 0],
  );
  private dims: CellDimensions | null = null;
  private fromBottom = 0;
  /** the kept row the view showed first after the last write, while it is scrolled back */
  private viewTop: number | null = null;
  private cancelFrame: (() => void) | null = null;
  private written = false;
  private announceUntil = 0;
  private readonly cleanups: (() => void)[] = [];

  constructor(options: Partial<GhosttyTerminalOptions> & { cols?: number; rows?: number } = {}) {
    const { cols = 80, rows = 24, ...rest } = options;
    this.cols = cols;
    this.rows = rows;
    const values: GhosttyTerminalOptions = { ...DEFAULT_OPTIONS, ...rest };
    // the input layer encodes keys as xterm does, which knows no Kitty keyboard protocol: a program's request for it is
    // not taken, nor its question answered, so the program goes on with the keys it gets (as under xterm)
    for (const prefix of [">", "<", "=", "?"]) this.parser.registerCsiHandler({ prefix, final: "u" }, () => true);
    // focus reports turned on are answered at once with where the focus is, as xterm answers them
    this.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (params.includes(1004) && this.textarea) this.reply(this.textarea.ownerDocument.activeElement === this.textarea ? "\x1b[I" : "\x1b[O");
      return false;
    });
    this.options = new Proxy(values, {
      set: (target, key, value) => {
        const changed = (target as unknown as Record<PropertyKey, unknown>)[key] !== value;
        (target as unknown as Record<PropertyKey, unknown>)[key] = value;
        if (changed) this.optionChanged(key as keyof GhosttyTerminalOptions);
        return true;
      },
    });
  }

  get modes() {
    const modes = this.engineModes();
    return {
      mouseTrackingMode: modes ? TRACKING_NAME[modes.mouse] : "none" as const,
      bracketedPasteMode: modes?.bracketedPaste ?? false,
      synchronizedOutputMode: modes?.syncOutput ?? false,
      applicationCursorKeysMode: modes?.appCursor ?? false,
      applicationKeypadMode: modes?.appKeypad ?? false,
      sendFocusMode: modes?.focusReports ?? false,
    };
  }

  get buffer(): { readonly active: GhosttyBuffer } {
    const vt = this.vt;
    return {
      get active(): GhosttyBuffer {
        if (!vt) return EMPTY_ROWS;
        const rows = ghosttyRows(vt);
        return { ...rows, type: rows.alternate ? "alternate" : "normal" };
      },
    };
  }

  open(host: HTMLElement): void {
    if (this.element) return;
    this.host = host;
    const element = document.createElement("div");
    element.className = "terminal xterm ovis-terminal";
    element.dir = "ltr";
    // xterm's structure and class names, which the page's styles and the browser scripts read: the viewport paints the
    // theme's background, the screen holds the grid, the selection is drawn under its rows
    const viewport = document.createElement("div");
    viewport.className = "xterm-viewport";
    Object.assign(viewport.style, { position: "absolute", inset: "0", background: themeColors(this.options.theme).background });
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    const selectionLayer = document.createElement("div");
    selectionLayer.className = "xterm-selection";
    selectionLayer.setAttribute("aria-hidden", "true");
    Object.assign(selectionLayer.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    screen.append(selectionLayer);
    screen.style.position = "relative";
    const helpers = document.createElement("div");
    helpers.className = "xterm-helpers";
    screen.append(helpers);
    element.append(viewport, screen);
    this.viewport = viewport;
    this.selectionLayer = selectionLayer;
    host.append(element);
    this.element = element;
    this.screen = screen;
    host.dataset["renderer"] = "ghostty";

    // the selection hears a press before the input layer, which reports it to the program and prevents its default, as
    // xterm registers them
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    const selection = createSelection({
      element, screen, isMac,
      macOptionClickForcesSelection: this.options.macOptionClickForcesSelection,
      cols: () => this.cols,
      rows: () => this.rows,
      cell: () => this.dims?.cell ?? { width: 0, height: 0 },
      screenRows: () => this.buffer.active,
      scrollLines: (amount) => this.scrollLines(amount),
      mouseReporting: () => this.modes.mouseTrackingMode !== "none",
      wordSeparator: () => this.options.wordSeparator,
      onUserInput: (listener) => this.onUserInputEmitter.event(listener).dispose,
      focusedLink: () => this.linkifier?.focusedLink(),
    });
    this.selection = selection;
    this.cleanups.push(
      selection.onSelectionChange(() => this.onSelectionChangeEmitter.fire()),
      selection.onRedraw(() => this.schedule()),
      // Linux's primary selection: the selected text is put in the textarea, focused and selected, as xterm does
      selection.onLinuxMouseSelection((text) => {
        const textarea = this.textarea;
        if (!textarea) return;
        textarea.value = text;
        textarea.focus();
        textarea.select();
      }),
    );
    const input = new TerminalInput({
      element, screen,
      cols: () => this.cols,
      rows: () => this.rows,
      cell: () => this.dims?.cell ?? { width: 0, height: 0 },
      cursor: () => this.cursorInView(),
      cellWidth: (x, y) => this.vt?.rowCells(this.screenTop() + y)?.[x]?.width === 2 ? 2 : 1,
      modes: () => this.inputModes(),
      font: () => ({ family: this.options.fontFamily, size: this.options.fontSize }),
      hasScrollback: () => !this.vt?.alternate() && this.options.scrollback > 0,
      hasSelection: () => this.hasSelection(),
      selectionText: () => this.getSelection(),
      selectAll: () => this.selection?.selectAll(),
      scrollLines: (lines) => this.scrollLines(lines),
      scrollOnUserInput: () => this.scrollToBottom(),
      macOptionClickForcesSelection: this.options.macOptionClickForcesSelection,
    });
    this.inputLayer = input;
    this.textarea = input.textarea;
    const view = screen.querySelector<HTMLElement>(".composition-view");
    if (view) this.cleanups.push(fitCompositionView(view, () => this.dims?.cell.width ?? 0, () => ({ family: this.options.fontFamily, size: this.options.fontSize, weight: this.options.fontWeight })));
    input.disableStdin = this.options.disableStdin;
    this.cleanups.push(
      input.onData((data) => this.onDataEmitter.fire(data)).dispose,
      input.onBinary((data) => this.onBinaryEmitter.fire(data)).dispose,
      input.onKey((event) => this.onKeyEmitter.fire(event)).dispose,
      input.onUserInput(() => this.onUserInputEmitter.fire()).dispose,
    );

    const linkifier = createLinkifier({
      screen,
      cols: () => this.cols,
      rows: () => this.rows,
      cell: () => this.dims?.cell ?? { width: 0, height: 0 },
      screenRows: () => this.buffer.active,
    });
    this.linkifier = linkifier;
    for (const early of this.earlyLinks) early.registered = linkifier.registerLinkProvider(early.provider);
    const underline = document.createElement("div");
    underline.className = "ghostty-link";
    underline.setAttribute("aria-hidden", "true");
    screen.append(underline);
    this.underline = underline;
    this.cleanups.push(linkifier.onUnderlineChange((range) => this.drawUnderline(range)));

    // a wheel over history this terminal keeps scrolls its view, a line a line or the pixels of one row; the input
    // layer turns it into a report or arrow keys where the program reads the mouse or its screen keeps no history
    let wheelPixels = 0;
    const onWheel = (event: WheelEvent): void => {
      // a wheel that pans a grid wider than the screen (terminalWheel.ts) moves only that
      if (this.disposed || wheelPansGrid(event) || this.options.scrollback === 0 || this.vt?.alternate() !== false || this.modes.mouseTrackingMode !== "none") return;
      const cellH = this.dims?.cell.height ?? 0;
      wheelPixels += event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * cellH : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.deltaY * cellH * this.rows : event.deltaY;
      const lines = cellH > 0 ? Math.trunc(wheelPixels / cellH) : 0;
      if (lines === 0) return;
      wheelPixels -= lines * cellH;
      this.scrollLines(lines);
    };
    host.addEventListener("wheel", onWheel, { passive: true });
    // on herdr's own server nothing scrolls here: a wheel or a swipe scrolls herdr's screen, which comes back as
    // written bytes, and the frames until a moment after it tell nothing new to a screen reader
    const viewMoved = (): void => { if (this.options.scrollback === 0) this.announceUntil = performance.now() + 1000; };
    for (const gesture of ["wheel", "touchmove", VIEW_MOVED_EVENT]) host.addEventListener(gesture, viewMoved, { capture: true, passive: true });
    const resize = new ResizeObserver(() => this.measure());
    resize.observe(screen);
    this.cleanups.push(() => {
      host.removeEventListener("wheel", onWheel);
      for (const gesture of ["wheel", "touchmove", VIEW_MOVED_EVENT]) host.removeEventListener(gesture, viewMoved, { capture: true });
      resize.disconnect();
    });
    ownView(this, () => this.fromBottom);
    holdScreenRows(this, () => this.buffer.active);
    this.measure();
    void this.start();
  }

  /** the engine's module loads once a page: output written before it is in is held, in order, with its callbacks */
  private async start(): Promise<void> {
    let vt: GhosttyVt;
    try {
      vt = await GhosttyVt.create(this.cols, this.rows, {
        onReply: (bytes) => this.reply(new TextDecoder().decode(bytes)),
        onHold: (held) => this.held(held),
      });
    } catch (error) {
      this.fail(error);
      return;
    }
    if (this.disposed) { vt.dispose(); return; }
    this.vt = vt;
    if (this.restarts > 0) {
      // a new engine after a failure: the mount attaches the pane again now, so the server's replay reaches this one
      this.host?.dispatchEvent(new CustomEvent<TerminalFailure>(TERMINAL_FAILED_EVENT, { detail: { error: null, restarting: true } }));
      const restarted = vt;
      setTimeout(() => { if (this.vt === restarted && this.failed === null) this.restarts = 0; }, RESTARTS_FORGOTTEN_MS);
    }
    this.renderer = createRowsRenderer(this.screen!, vt, () => ({
      fontFamily: this.options.fontFamily, fontSize: this.options.fontSize, fontWeight: this.options.fontWeight,
      fontWeightBold: this.options.fontWeightBold, theme: this.options.theme, minimumContrastRatio: this.options.minimumContrastRatio,
    }));
    vt.setScrollback(this.options.scrollback);
    this.fitEngine();
    this.pending = false;
    this.drainWrites();
  }

  private reply(data: string): void {
    if (!this.disposed && this.replyGate()) this.inputLayer?.reply(data);
  }

  /** a synchronized update left open past a second is ended, as xterm ends one, so the screen does not stay frozen */
  private held(held: boolean): void {
    if (this.holdTimer !== null) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    if (held) {
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        try { this.vt?.releaseHold(); } catch (error) { this.fail(error); }
      }, SYNC_HOLD_MS);
    } else this.schedule();
  }

  /**
   * libghostty could not start or stopped. What waits is still acknowledged, in order, so the server's flow control does
   * not take the pane for a reader that stopped. The terminal starts over with a new engine (a fresh module if this one
   * trapped) a few times, and tells the mount, which attaches the pane again so the server draws it anew; past that it
   * tells the mount it gave up (`restarting: false`).
   */
  private fail(error: unknown): void {
    if (this.failed !== null || this.disposed) return;
    this.failed = error;
    console.warn("libghostty stopped drawing this terminal", error);
    this.pending = false;
    if (this.draining === null && this.writes.length > 0) this.draining = setTimeout(() => this.drainWrites());
    const restarting = this.restarts < MAX_RESTARTS;
    // the mount is told when there is something to do: attach again once the new engine is in (start), or say it gave up
    if (restarting) {
      this.restarts++;
      // a moment between attempts, longer each time: a fetch that failed for a moment (a relay's hiccup) gets its chance
      setTimeout(() => this.restart(), RESTART_DELAY_MS * this.restarts);
    } else {
      // given up: a blank grid takes no typing, whatever the mount says about input later
      this.broken = true;
      if (this.inputLayer) this.inputLayer.disableStdin = true;
    }
    if (!restarting) this.host?.dispatchEvent(new CustomEvent<TerminalFailure>(TERMINAL_FAILED_EVENT, { detail: { error, restarting: false } }));
  }

  private restart(): void {
    if (this.disposed) return;
    try { this.renderer?.dispose(); } catch { /* the layer goes with the engine */ }
    try { this.vt?.dispose(); } catch { /* a trapped engine is gone already */ }
    this.renderer = null;
    this.vt = null;
    this.stream.reset();
    this.decoder = new TextDecoder();
    this.pictures.reset();
    this.selection?.clearSelection();
    this.fromBottom = 0;
    this.viewTop = null;
    this.failed = null;
    this.pending = true;
    void this.start();
  }

  get failure(): unknown { return this.failed; }

  /** test builds only (the mount's __HERDR_TEST_HOOKS__): libghostty stopping, as a trap stops it */
  failForTest(): void { this.fail(new Error("a stop the test asked for")); }

  /**
   * Output is parsed in a task of its own, after the event that wrote it, as xterm's write buffer parses it: a listener
   * the same message reaches after the mount's (a browser script's) sees it before its frame is parsed and told, and a
   * long run of frames yields to the page every WRITE_BUDGET_MS.
   */
  write(data: string | Uint8Array, callback?: () => void): void {
    if (this.disposed) return;
    this.writes.push({ data, callback });
    if (this.pending || this.draining !== null) return;
    this.draining = setTimeout(() => this.drainWrites());
  }

  private drainWrites(): void {
    this.draining = null;
    const start = performance.now();
    while (!this.disposed && !this.pending && this.writes.length > 0) {
      if (performance.now() - start > WRITE_BUDGET_MS) {
        this.draining = setTimeout(() => this.drainWrites());
        return;
      }
      const { data, callback } = this.writes.shift()!;
      this.parseWrite(data, callback);
    }
  }

  private parseWrite(data: string | Uint8Array, callback: (() => void) | undefined): void {
    if (this.failed !== null) { callback?.(); return; }
    // a picture conversion past its deadline is skipped (itermPictureWriter.ts), so a frame is told parsed only once it is
    this.pictures.write(data, (part, picture) => this.parse(part, picture), () => {
      try {
        if (this.failed === null) this.afterWrite();
      } catch (error) {
        this.fail(error);
      } finally {
        callback?.();
      }
    });
  }

  /**
   * A view scrolled back stays on its rows while new ones push the history up: libghostty keeps its viewport on the
   * rows it shows, so the offset is read back from it, and a selection follows the rows history let go of.
   */
  private afterWrite(): void {
    const vt = this.vt;
    if (vt && this.fromBottom > 0) {
      const top = this.viewTop;
      const history = vt.history();
      const max = vt.alternate() ? 0 : Math.min(history.scrollback, vt.scrollback);
      this.fromBottom = Math.max(0, Math.min(max, history.scrollback - history.viewportTop));
      vt.scrollFromBottom(this.fromBottom);
      this.selection?.refresh(top !== null ? Math.max(0, top - vt.history().viewportTop) : 0);
    } else this.selection?.refresh();
    this.viewTop = vt && this.fromBottom > 0 ? vt.history().viewportTop : null;
    this.clearPicturesBetweenSequences();
    this.written = true;
    // the program's mouse and cursor modes may have changed: the input layer follows them now, as xterm's does
    this.inputLayer?.cursorMoved();
    this.onWriteParsedEmitter.fire();
    if (!this.modes.synchronizedOutputMode) this.schedule();
  }

  private parse(part: string | Uint8Array, picture: boolean): void {
    if (!this.vt || this.failed !== null) return;
    try {
      const text = typeof part === "string" ? part : this.decoder.decode(part, { stream: true });
      if (!picture) { this.stream(text); return; }
      // a picture ends on its last row at the column it began in, as xterm's default sixelScrolling leaves the cursor
      const { x } = this.vt.screenCursor();
      this.stream(text);
      if (this.vt.screenCursor().x !== x) this.stream(`\x1b[${x + 1}G`);
    } catch (error) {
      this.fail(error);
    }
  }

  oscStringState(): OscStringState { return this.stream.oscStringState(); }

  reset(): void {
    this.stream.reset();
    this.decoder = new TextDecoder();
    this.pictures.reset();
    this.selection?.clearSelection();
    this.inputLayer?.reset();
    this.fromBottom = 0;
    this.viewTop = null;
    try { this.vt?.reset(); } catch (error) { this.fail(error); }
    this.schedule();
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.measure(true);
    this.onResizeEmitter.fire({ cols, rows });
  }

  /** the cell from the font; the screen and the engine take the grid's new size */
  private measure(force = false): void {
    const char = measureChar(this.options.fontFamily, this.options.fontSize);
    if (!char || !this.screen) return;
    const dims = cellDimensions(char, this.cols, this.rows, { lineHeight: this.options.lineHeight, letterSpacing: this.options.letterSpacing, dpr: window.devicePixelRatio || 1 });
    if (!force && this.dims && this.dims.cell.width === dims.cell.width && this.dims.cell.height === dims.cell.height
      && this.dims.grid.width === dims.grid.width && this.dims.grid.height === dims.grid.height) return;
    this.dims = dims;
    Object.assign(this.screen.style, { width: `${dims.grid.width}px`, height: `${dims.grid.height}px` });
    this.fitEngine();
  }

  private fitEngine(): void {
    const { vt, renderer, dims } = this;
    if (!vt || !renderer || !dims) return;
    try {
      vt.resize(this.cols, this.rows, Math.round(dims.device.width), Math.round(dims.device.height));
      renderer.fit(this.cols, this.rows, dims.cell.width, dims.cell.height);
      this.clampView();
    } catch (error) {
      this.fail(error);
    }
    this.inputLayer?.cursorMoved();
    this.schedule();
  }

  /** the grid that fits the element's parent, as xterm's fit addon proposes it */
  proposeDimensions(): { cols: number; rows: number } | undefined {
    if (!this.element) return undefined;
    const char = measureChar(this.options.fontFamily, this.options.fontSize);
    if (!char) return undefined;
    const { cell } = cellDimensions(char, this.cols, this.rows, { lineHeight: this.options.lineHeight, letterSpacing: this.options.letterSpacing, dpr: window.devicePixelRatio || 1 });
    return proposeGrid(this.element, cell, 0) ?? undefined;
  }

  fit(): void {
    const grid = this.proposeDimensions();
    if (grid) this.resize(grid.cols, grid.rows);
  }

  /** the two calls as one object, whose fit the mount wraps to settle the font first */
  fitter(): GhosttyFit {
    return { fit: () => this.fit(), proposeDimensions: () => this.proposeDimensions() };
  }

  private optionChanged(key: keyof GhosttyTerminalOptions): void {
    switch (key) {
      case "fontFamily": case "fontSize": case "lineHeight": case "letterSpacing":
        this.renderer?.restyle();
        this.measure(true);
        break;
      case "theme":
        if (this.viewport) this.viewport.style.background = themeColors(this.options.theme).background;
        this.drawnSelectionKey = "";
        this.renderer?.restyle();
        this.schedule();
        break;
      case "fontWeight": case "fontWeightBold": case "minimumContrastRatio":
        this.renderer?.restyle();
        this.schedule();
        break;
      case "scrollback":
        this.vt?.setScrollback(this.options.scrollback);
        this.clampView();
        this.schedule();
        break;
      case "disableStdin":
        if (this.inputLayer) this.inputLayer.disableStdin = this.options.disableStdin || this.broken;
        break;
    }
  }

  private engineModes() {
    if (!this.vt) return null;
    try { return this.vt.modes(); } catch { return null; }
  }

  private inputModes(): TerminalInputModes {
    const modes = this.engineModes();
    return {
      applicationCursorKeys: modes?.appCursor ?? false,
      applicationKeypad: modes?.appKeypad ?? false,
      bracketedPaste: modes?.bracketedPaste ?? false,
      sendFocus: modes?.focusReports ?? false,
      mouseProtocol: modes ? MOUSE_PROTOCOL[modes.mouse] : "none",
      mouseEncoding: modes ? MOUSE_ENCODING[modes.mouseFormat] : "default",
      alternateScreen: modes?.altScreen ?? false,
    };
  }

  /** the screen's first row among the kept ones */
  private screenTop(): number {
    return this.vt?.history().scrollback ?? 0;
  }

  private cursorInView(): { x: number; y: number } | null {
    // before the engine is in, the cursor is where a new terminal's is
    if (!this.vt) return { x: 0, y: 0 };
    if (this.fromBottom > 0) return null;
    const { x, y } = this.vt.screenCursor();
    return { x: Math.min(x, this.cols - 1), y };
  }

  private clampView(): void {
    if (!this.vt) return;
    const max = this.vt.alternate() ? 0 : Math.min(this.vt.history().scrollback, this.vt.scrollback);
    this.moveView(Math.min(this.fromBottom, max));
  }

  private moveView(rows: number): void {
    if (rows === this.fromBottom) return;
    this.fromBottom = rows;
    try {
      this.vt?.scrollFromBottom(rows);
      this.viewTop = this.vt && rows > 0 ? this.vt.history().viewportTop : null;
    } catch (error) { this.fail(error); }
    this.selection?.refresh();
    this.linkifier?.refresh();
    this.inputLayer?.cursorMoved();
    this.onScrollEmitter.fire(this.buffer.active.viewportY);
    this.element?.dispatchEvent(new Event(GHOSTTY_VIEW_EVENT));
    this.schedule();
  }

  scrollLines(amount: number): void {
    if (!this.vt || this.vt.alternate()) return;
    const max = Math.min(this.vt.history().scrollback, this.vt.scrollback);
    this.moveView(Math.max(0, Math.min(max, this.fromBottom - amount)));
  }

  scrollPages(pages: number): void { this.scrollLines(pages * (this.rows - 1)); }
  scrollToBottom(): void { this.moveView(0); }
  scrollToTop(): void { this.scrollLines(-Infinity); }

  refresh(_start = 0, _end = this.rows - 1): void { this.schedule(); }

  private schedule(): void {
    if (this.cancelFrame !== null || this.disposed) return;
    this.cancelFrame = requestShownFrame(() => {
      this.cancelFrame = null;
      this.draw();
    });
  }

  private draw(): void {
    const { vt, renderer } = this;
    if (!vt || !renderer || this.disposed || this.failed !== null) return;
    try {
      vt.scrollFromBottom(this.fromBottom);
      const drawn = this.selection?.drawnSelection() ?? null;
      const viewportY = this.buffer.active.viewportY;
      const selected = (y: number): readonly [number, number] | null => {
        if (!drawn) return null;
        const line = viewportY + y;
        const { start, end, column } = drawn;
        if (line < Math.min(start[1], end[1]) || line > Math.max(start[1], end[1])) return null;
        const [from, to] = column
          ? [Math.min(start[0], end[0]), Math.max(start[0], end[0])]
          : [line === start[1] ? start[0] : 0, line === end[1] ? end[0] : this.cols];
        return to > from ? [from, to] : null;
      };
      const announce = this.written && performance.now() >= this.announceUntil;
      this.written = false;
      const changed = renderer.draw(selected, this.fromBottom === 0, announce);
      this.drawSelection(selected);
      if (changed) {
        // a row a link was read from may have been written over: the link under the pointer is read again, once a frame
        this.linkifier?.refresh();
        this.inputLayer?.cursorMoved();
        this.host?.dispatchEvent(new Event(GHOSTTY_DREW_EVENT));
      }
      this.onRenderEmitter.fire({ start: 0, end: this.rows - 1 });
    } catch (error) {
      this.fail(error);
    }
  }

  /** the selection's rectangles, one a row, in the selection's colour under the rows, as xterm's selection layer draws them */
  private drawSelection(selected: (y: number) => readonly [number, number] | null): void {
    const layer = this.selectionLayer;
    const cell = this.dims?.cell;
    if (!layer || !cell) return;
    const spans: [number, number, number][] = [];
    for (let y = 0; y < this.rows; y++) {
      const columns = selected(y);
      if (columns) spans.push([y, columns[0], columns[1]]);
    }
    const key = JSON.stringify([spans, cell.width, cell.height]);
    if (key === this.drawnSelectionKey) return;
    this.drawnSelectionKey = key;
    const colour = this.options.theme.selectionBackground ?? themeColors(this.options.theme).foreground;
    layer.replaceChildren(...spans.map(([y, from, to]) => {
      const box = document.createElement("div");
      Object.assign(box.style, { position: "absolute", left: `${from * cell.width}px`, top: `${y * cell.height}px`, width: `${(to - from) * cell.width}px`, height: `${cell.height}px`, backgroundColor: colour });
      return box;
    }));
  }

  private drawUnderline(range: LinkUnderline | null): void {
    const element = this.underline;
    const cell = this.dims?.cell;
    if (!element || !cell) return;
    if (!range) { element.style.display = "none"; return; }
    // one line, or the first row to its end, whole rows between, and the last row to the link's end
    const rows = range.end[1] - range.start[1] + 1;
    element.replaceChildren(...Array.from({ length: rows }, (_, index) => {
      const y = range.start[1] + index;
      const from = index === 0 ? range.start[0] : 0;
      const to = index === rows - 1 ? range.end[0] : this.cols;
      const line = document.createElement("div");
      Object.assign(line.style, { position: "absolute", left: `${from * cell.width}px`, top: `${(y + 1) * cell.height - 1}px`, width: `${(to - from) * cell.width}px`, height: "1px", background: "currentColor" });
      return line;
    }));
    element.style.display = "block";
  }

  /** fired right before onData for what someone typed, pasted or pressed, never for an answer to the program */
  onUserInput(listener: () => void): Disposable { return this.onUserInputEmitter.event(listener); }
  /** the cursor's shape as drawn now, or null while it is hidden or the view is off the bottom (the fold draws it) */
  cursorShape(): "block" | "bar" | "underline" | null {
    if (!this.vt || this.fromBottom > 0) return null;
    const cursor = this.vt.cursor();
    return !cursor.visible ? null : cursor.style === 0 ? "bar" : cursor.style === 2 ? "underline" : "block";
  }
  focus(): void { this.inputLayer?.focus(); }
  blur(): void { this.inputLayer?.blur(); }
  input(data: string, wasUserInput = true): void { this.inputLayer?.input(data, wasUserInput); }
  paste(text: string): void { this.inputLayer?.paste(text); }
  finishComposition(): void { this.inputLayer?.finishComposition(); }
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void { this.inputLayer?.attachCustomKeyEventHandler(handler); }
  attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean): void { this.inputLayer?.attachCustomWheelEventHandler(handler); }
  setTextAreaViewportBounds(bounds: TextAreaViewportBounds | undefined): void { this.inputLayer?.setTextAreaViewportBounds(bounds); }
  /** a provider registered before open (the mount registers its own first) is given to the linkifier when it is made */
  registerLinkProvider(provider: ILinkProvider): Disposable {
    if (this.linkifier) return this.linkifier.registerLinkProvider(provider);
    const early = { provider, registered: null as Disposable | null };
    this.earlyLinks.push(early);
    return {
      dispose: () => {
        early.registered?.dispose();
        this.earlyLinks.splice(this.earlyLinks.indexOf(early) >>> 0, 1);
      },
    };
  }

  hasSelection(): boolean { return this.selection?.hasSelection() ?? false; }
  getSelection(): string { return this.selection?.getSelection() ?? ""; }
  getSelectionPosition() { return this.selection?.getSelectionPosition(); }
  select(column: number, row: number, length: number): void { this.selection?.select(column, row, length); }
  selectAll(): void { this.selection?.selectAll(); }
  clearSelection(): void { this.selection?.clearSelection(); }
  drawnSelection() { return this.selection?.drawnSelection() ?? null; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelFrame?.();
    if (this.holdTimer !== null) clearTimeout(this.holdTimer);
    this.writes.length = 0;
    if (this.draining !== null) clearTimeout(this.draining);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    holdScreenRows(this, null);
    ownView(this, null);
    this.selection?.dispose();
    this.linkifier?.dispose();
    this.inputLayer?.dispose();
    this.renderer?.dispose();
    this.pictures.reset();
    try { this.vt?.dispose(); } catch { /* a trapped module is gone already */ }
    this.vt = null;
    if (this.host) delete this.host.dataset["renderer"];
    this.element?.remove();
    for (const emitter of [this.onDataEmitter, this.onBinaryEmitter, this.onKeyEmitter, this.onResizeEmitter, this.onRenderEmitter, this.onScrollEmitter, this.onWriteParsedEmitter, this.onSelectionChangeEmitter, this.onUserInputEmitter]) emitter.clear();
  }
}
