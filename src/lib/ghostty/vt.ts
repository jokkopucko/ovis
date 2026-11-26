/**
 * The browser's loader for the libghostty-vt wrapper core (shared/ghostty/engine.ts): it fetches and
 * instantiates shared/ghostty/ghostty-vt.wasm (MIT; built by scripts/ghostty-vt/build.sh with the Kitty
 * graphics protocol turned on), and adds the browser's choices: graphemes laid out in xterm's cells, Kitty
 * images kept, the theme's 256-colour palette and pictures as ImageData.
 */
import {
  GhosttyEngine,
  GhosttyModule,
  type EngineCell,
  type EngineEvents,
  type EngineHistory,
  type EngineModes,
  type EngineRowText,
  type GhosttyCursor,
  type GhosttyImage,
  type GhosttyRun,
  type Rgb,
  type ScreenPoint,
} from "../../../shared/ghostty/engine.ts";

export {
  STYLE_BOLD,
  STYLE_FAINT,
  STYLE_INVERSE,
  STYLE_INVISIBLE,
  STYLE_ITALIC,
  STYLE_OVERLINE,
  STYLE_STRIKE,
  STYLE_UNDERLINE_MASK,
  type EngineCell,
  type EngineRowText,
  type GhosttyCursor,
  type GhosttyImage,
  type GhosttyRun,
} from "../../../shared/ghostty/engine.ts";

export interface GhosttyColors { foreground: string; background: string; cursor: string; ansi: readonly string[] }

/** DEC private mode 2027 as ghostty_mode_new(2027, false) encodes it */
const MODE_GRAPHEME_CLUSTER = 2027;
/** DEC private mode 40, which lets a program switch the grid to 132 columns (DECCOLM, mode 3) */
const MODE_ALLOW_DECCOLM = 40;
/** history kept past the lines asked for: more than the rows of one of libghostty's pages at any width */
const HISTORY_SLACK_LINES = 4096;
const CSI_GROUND = 0, CSI_ESC = 1, CSI_BRACKET = 2, CSI_PRIVATE = 3, CSI_OTHER = 4, CSI_STRING = 5;
/**
 * Whether a code point joins the emoji before it into one cell: ZWJ, the emoji- and text-presentation
 * selectors, skin tones, the keycap mark, tags (subdivision flags) and regional indicators (country flags).
 */
const joinsEmoji = (codepoint: number): boolean =>
  codepoint === 0x200d || codepoint === 0xfe0f || codepoint === 0xfe0e || codepoint === 0x20e3
  || (codepoint >= 0x1f3fb && codepoint <= 0x1f3ff) || (codepoint >= 0xe0020 && codepoint <= 0xe007f)
  || (codepoint >= 0x1f1e6 && codepoint <= 0x1f1ff);
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
/** decoded pictures one terminal keeps; every terminal on the page shares the module's one memory */
const IMAGE_STORAGE_BYTES = 64n * 1024n * 1024n;

let loadedModule: GhosttyModule | null = null;
let widthProbe: GhosttyVt | null = null;
let modulePromise: Promise<GhosttyModule> | null = null;

function loadModule(): Promise<GhosttyModule> {
  modulePromise ??= (async () => {
    let memory: WebAssembly.Memory | null = null;
    const env = {
      log: (ptr: number, len: number) => {
        if (memory) console.debug("[ghostty-vt]", new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len)));
      },
    };
    // compiled from the bytes, not streamed: that needs `application/wasm`, which neither this PC's server
    // nor the relay's resource worker promises
    const wasmUrl = new URL("../../../shared/ghostty/ghostty-vt.wasm", import.meta.url);
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`ghostty-vt: ${wasmUrl.href} answered ${response.status}`);
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), { env });
    const module = new GhosttyModule(instance);
    memory = module.exports.memory;
    loadedModule = module;
    widthProbe = null;
    return module;
  })();
  modulePromise.catch(() => { modulePromise = null; });
  return modulePromise;
}

export function rgb(color: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{6})/i.exec(color.trim())?.[1];
  if (!hex) return null;
  const value = Number.parseInt(hex, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

export class GhosttyVt {
  cols: number;
  rows: number;
  /** the history asked for: libghostty frees history a page at a time, so it can hold a few rows more */
  scrollback = 0;
  private readonly engine: GhosttyEngine;
  private readonly encoder = new TextEncoder();
  private csi = CSI_GROUND;
  private param = 0;
  private sawGraphemeMode = false;
  private sawDeccolmAllow = false;
  private afterZwj = false;
  private broken = true;

  private constructor(module: GhosttyModule, cols: number, rows: number, events?: EngineEvents) {
    this.cols = cols;
    this.rows = rows;
    // history is cut by lines alone, as xterm cuts it: libghostty's byte limit would keep far fewer than a herdr-core pane's 2,000
    this.engine = new GhosttyEngine(module, cols, rows, { widths: "xterm", images: IMAGE_STORAGE_BYTES, scrollbackLines: 0, ...(events ? { events } : {}) });
  }

  /** `events`: a terminal libghostty alone parses (terminal.ts) hears its replies to the program and its holds */
  static async create(cols: number, rows: number, events?: EngineEvents): Promise<GhosttyVt> {
    const loading = loadModule();
    let module = await loading;
    // a module that trapped makes no terminal again: a terminal starting over loads a fresh one, once for every
    // terminal that found the same module trapped
    if (module.trap) {
      if (modulePromise === loading) modulePromise = null;
      module = await loadModule();
    }
    return new GhosttyVt(module, cols, rows, events);
  }

  /** Measure printable text with the same layout as a pane, without starting a WASM load. */
  static textCells(text: string): number | null {
    if (!loadedModule || loadedModule.trap) return null;
    const printable = text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
    // Leave the cursor a spare column even if every code unit takes two cells.
    const cols = Math.min(0xffff, Math.max(2000, printable.length * 2 + 1));
    const probe = widthProbe ??= new GhosttyVt(loadedModule, 2000, 1);
    probe.reset();
    if (probe.cols !== cols) probe.resize(cols, 1, 8, 16);
    probe.write(printable);
    return probe.screenCursor().x;
  }

  modes(): EngineModes {
    return this.engine.modes();
  }

  /** ends a synchronized update the program left open: the next frame shows what it wrote since */
  releaseHold(): void {
    this.engine.releaseHold();
  }

  write(data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? this.encoder.encode(data) : data;
    if (bytes.length === 0) return;
    // herdr and herdr-core give an emoji sequence (ZWJ family, skin tone, flag, keycap,
    // an emoji-presentation selector) one two-column cell, an emoji with a text form and the
    // text-presentation selector (\u26bd\ufe0e) one one-column cell, and otherwise lay out as libghostty
    // does with grapheme clustering (mode 2027) off: clustering also joins spacing marks and Indic
    // conjuncts that they keep apart. So mode 2027 stays off, and each code point that joins an emoji
    // (joinsEmoji, or a pictograph right after a ZWJ) is printed with it on. A program's own 2027 on
    // (CSI ? ... 2027 ... h, or r restoring it), which xterm ignores, is turned off again right after;
    // the sequence may span writes.
    let start = 0;
    const flush = (end: number): void => {
      if (end > start) this.engine.write(bytes.subarray(start, end));
      start = end;
    };
    for (let at = 0; at < bytes.length; at++) {
      const byte = bytes[at]!;
      if (byte === 0x1b) { this.csi = CSI_ESC; this.broken = true; continue; }
      if (this.csi === CSI_GROUND) {
        if (byte < 0x20) continue;
        if (byte >= 0x80 && byte < 0xc0) continue;
        if (byte < 0xe0 || byte >= 0xf8) { this.afterZwj = false; this.broken = false; continue; }
        const length = byte >= 0xf0 ? 4 : 3;
        if (at + length > bytes.length) continue;
        const codepoint = length === 3
          ? ((byte & 0x0f) << 12) | ((bytes[at + 1]! & 0x3f) << 6) | (bytes[at + 2]! & 0x3f)
          : ((byte & 0x07) << 18) | ((bytes[at + 1]! & 0x3f) << 12) | ((bytes[at + 2]! & 0x3f) << 6) | (bytes[at + 3]! & 0x3f);
        // xterm starts a new cell after an escape sequence, so nothing joins across one
        const joins = !this.broken && (joinsEmoji(codepoint) || (this.afterZwj && codepoint <= 0x10ffff && PICTOGRAPHIC.test(String.fromCodePoint(codepoint))));
        if (joins) {
          flush(at);
          this.setGraphemeClusters(true);
          flush(at + length);
          this.setGraphemeClusters(false);
        }
        this.afterZwj = codepoint === 0x200d && !this.broken;
        this.broken = false;
        at += length - 1;
        continue;
      }
      // an OSC, DCS or APC (a title, a Kitty picture) prints nothing up to its BEL or ST (ESC \)
      if (this.csi === CSI_STRING) {
        if (byte === 0x07 || byte === 0x18 || byte === 0x1a) this.csi = CSI_GROUND;
        continue;
      }
      // a C0 control or DEL inside an escape sequence runs without ending it; CAN and SUB cancel it
      if ((byte < 0x20 && byte !== 0x18 && byte !== 0x1a) || byte === 0x7f) continue;
      switch (this.csi) {
        case CSI_ESC:
          this.csi = byte === 0x5b ? CSI_BRACKET : byte === 0x5d || byte === 0x50 || byte === 0x5f || byte === 0x5e || byte === 0x58 ? CSI_STRING : CSI_GROUND;
          continue;
        case CSI_BRACKET:
          // another CSI (a style, a cursor move) is skipped to its final byte: its parameters print nothing
          this.csi = byte === 0x3f ? CSI_PRIVATE : byte >= 0x40 && byte <= 0x7e ? CSI_GROUND : CSI_OTHER;
          this.param = 0;
          this.sawGraphemeMode = false;
          this.sawDeccolmAllow = false;
          continue;
        case CSI_OTHER:
          if (byte >= 0x40 && byte <= 0x7e) this.csi = CSI_GROUND;
          continue;
      }
      if (byte >= 0x30 && byte <= 0x39) this.param = Math.min(this.param * 10 + byte - 0x30, 1e6);
      else if (byte === 0x3b || byte === 0x3a) {
        if (this.param === MODE_GRAPHEME_CLUSTER) this.sawGraphemeMode = true;
        if (this.param === MODE_ALLOW_DECCOLM) this.sawDeccolmAllow = true;
        this.param = 0;
      } else {
        if ((byte === 0x68 || byte === 0x72) && (this.sawGraphemeMode || this.param === MODE_GRAPHEME_CLUSTER)) {
          flush(at + 1);
          this.setGraphemeClusters(false);
        }
        // xterm keeps the pane's columns whatever a program asks (DECCOLM), and the pane is drawn on xterm's grid:
        // mode 40 is turned off again as soon as a program turns it on, so libghostty keeps them too
        if ((byte === 0x68 || byte === 0x72) && (this.sawDeccolmAllow || this.param === MODE_ALLOW_DECCOLM)) {
          flush(at + 1);
          this.engine.setMode(MODE_ALLOW_DECCOLM, false);
        }
        this.csi = CSI_GROUND;
      }
    }
    flush(bytes.length);
  }

  private setGraphemeClusters(on: boolean): void {
    this.engine.setMode(MODE_GRAPHEME_CLUSTER, on);
  }

  reset(): void {
    // libghostty keeps a sequence it is in the middle of across a reset, and so does the scanner
    this.engine.reset();
    this.afterZwj = false;
    this.broken = true;
  }

  resize(cols: number, rows: number, cellW: number, cellH: number): void {
    this.engine.resize(cols, rows, cellW, cellH);
    this.cols = cols;
    this.rows = rows;
  }

  /**
   * lines of history above the screen; 0 keeps none. libghostty frees history a whole page at a time, so it is
   * let keep a few pages more than asked, and the rows past `lines` are left out where it is read (screenRows.ts)
   */
  setScrollback(lines: number): void {
    this.engine.setScrollback(lines === 0 ? 0 : lines + HISTORY_SLACK_LINES);
    this.scrollback = lines;
  }

  scrollFromBottom(rowsAboveBottom: number): void {
    this.engine.scrollFromBottom(rowsAboveBottom);
  }

  setColors(colors: GhosttyColors): void {
    // the 256-colour palette: the 16 named ones from the theme, the cube and greys as xterm computes them
    const palette: Rgb[] = [];
    for (let index = 0; index < 256; index++) {
      let value: [number, number, number];
      if (index < 16) value = rgb(colors.ansi[index] ?? "") ?? [0, 0, 0];
      else if (index < 232) {
        const n = index - 16;
        const level = (v: number): number => (v === 0 ? 0 : 55 + v * 40);
        value = [level(Math.floor(n / 36)), level(Math.floor(n / 6) % 6), level(n % 6)];
      } else {
        const grey = 8 + (index - 232) * 10;
        value = [grey, grey, grey];
      }
      palette.push(value);
    }
    this.engine.setColors({ foreground: rgb(colors.foreground), background: rgb(colors.background), cursor: rgb(colors.cursor), palette });
  }

  frame(draw: (y: number, runs: GhosttyRun[]) => void): boolean {
    return this.engine.frame(draw);
  }

  cursor(): GhosttyCursor {
    return this.engine.cursor();
  }

  /** the kept rows: the history above the screen and where the view sits in it (screen coordinates, row 0 the oldest) */
  history(): EngineHistory {
    return this.engine.history();
  }

  alternate(): boolean {
    return this.engine.alternate();
  }

  screenCursor(): ScreenPoint {
    return this.engine.screenCursor();
  }

  rowCells(y: number): EngineCell[] | null {
    return this.engine.rowCells(y);
  }

  rowText(y: number): EngineRowText | null {
    return this.engine.rowText(y);
  }

  placedImages(): GhosttyImage[] | null {
    return this.engine.placedImages();
  }

  imagePixels(id: number): ImageData | null {
    const pixels = this.engine.imagePixels(id);
    return pixels ? new ImageData(pixels.rgba, pixels.width, pixels.height) : null;
  }

  dispose(): void {
    this.engine.dispose();
  }
}

export const textCells = GhosttyVt.textCells;
