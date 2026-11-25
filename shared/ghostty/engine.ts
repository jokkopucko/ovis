/**
 * The host-free core of the wrapper over libghostty-vt compiled to WebAssembly (ghostty-vt.wasm beside
 * this file, MIT; built by scripts/ghostty-vt/build.sh with the Kitty graphics protocol turned on). A
 * loader instantiates the module and hands it over as a GhosttyModule: the browser's is src/lib/ghostty/vt.ts.
 *
 * A GhosttyEngine owns one terminal and one render state. Each frame hands every changed row to the caller as
 * runs of text that share one style, and lists the Kitty images on screen with their pixels.
 * Raw cells are read a row at a time and decoded with the bit layout the module reports in
 * ghostty_type_json(), so a row costs one wasm call plus a few per style change. Every enum value and struct
 * field the core uses is read from there by name as well (ENGINE_ENUMS, ENGINE_FIELDS).
 *
 * An engine made with `events` is a terminal screen's: the module calls back into it (through a small helper
 * module, as Bun has no WebAssembly.Function) with its replies, holds, bells and clipboard writes, and its
 * frames keep showing the frame a synchronized-output hold began with; it also follows win32-input-mode and
 * records a trap on its module. One without them (the browser's) adds nothing to the module's own behaviour:
 * no callback, no 9001 watch and no trap bookkeeping, each call running as the browser's loader always had it.
 */

interface Bits { lsb: number; width: number; arms?: Record<string, { bits: Record<string, Bits> } | null> }
export interface TypeLayout {
  types: Record<string, { size?: number; values?: Record<string, number>; fields?: Record<string, { offset: number }>; bits?: Record<string, Bits> }>;
}

// every wasm function the core calls is declared here: the compiler and ENGINE_FUNCTIONS are the guard
export interface GhosttyExports {
  memory: WebAssembly.Memory;
  __indirect_function_table: WebAssembly.Table;
  ghostty_type_json(): number;
  ghostty_wasm_alloc(len: number): number;
  ghostty_wasm_free(ptr: number, len: number): void;
  ghostty_wasm_alloc_opaque(): number;
  ghostty_wasm_free_opaque(slot: number): void;
  ghostty_wasm_take_opaque(slot: number): number;
  ghostty_free(allocator: number, ptr: number, len: number): void;
  ghostty_terminal_new(allocator: number, slot: number, cols: number, rows: number): number;
  ghostty_terminal_free(terminal: number): void;
  ghostty_terminal_reset(terminal: number): void;
  ghostty_terminal_resize(terminal: number, cols: number, rows: number, cellW: number, cellH: number): number;
  ghostty_terminal_set(terminal: number, option: number, value: number): number;
  ghostty_terminal_get(terminal: number, key: number, out: number): number;
  ghostty_terminal_vt_write(terminal: number, ptr: number, len: number): void;
  ghostty_terminal_scroll_viewport(terminal: number, behavior: number): void;
  ghostty_terminal_grid_ref(terminal: number, point: number, outRef: number): number;
  ghostty_terminal_point_from_grid_ref(terminal: number, ref: number, tag: number, outCoordinate: number): number;
  ghostty_grid_ref_row(ref: number, outRow: number): number;
  ghostty_grid_ref_cell(ref: number, outCell: number): number;
  ghostty_grid_ref_graphemes(ref: number, buf: number, bufLen: number, outLen: number): number;
  ghostty_grid_ref_style(ref: number, outStyle: number): number;
  ghostty_row_get(row: bigint, key: number, out: number): number;
  ghostty_terminal_select_word(terminal: number, options: number, outSelection: number): number;
  ghostty_terminal_select_line(terminal: number, options: number, outSelection: number): number;
  ghostty_terminal_selection_format_alloc(terminal: number, allocator: number, options: number, outPtr: number, outLen: number): number;
  ghostty_render_state_new(allocator: number, slot: number): number;
  ghostty_render_state_free(state: number): void;
  ghostty_render_state_update(state: number, terminal: number): number;
  ghostty_render_state_get(state: number, key: number, out: number): number;
  ghostty_render_state_clean(state: number): number;
  ghostty_render_state_row_iterator_new(allocator: number, slot: number): number;
  ghostty_render_state_row_iterator_next(iterator: number): number;
  ghostty_render_state_row_iterator_next_dirty(iterator: number, outY: number): number;
  ghostty_render_state_row_iterator_free(iterator: number): void;
  ghostty_render_state_row_get(iterator: number, key: number, out: number): number;
  ghostty_render_state_row_cells_new(allocator: number, slot: number): number;
  ghostty_render_state_row_cells_select(cells: number, x: number): number;
  ghostty_render_state_row_cells_get(cells: number, key: number, out: number): number;
  ghostty_render_state_row_cells_free(cells: number): void;
  ghostty_render_state_image_iterator_new(allocator: number, slot: number): number;
  ghostty_render_state_image_iterator_next(iterator: number): number;
  ghostty_render_state_image_get(iterator: number, key: number, out: number): number;
  ghostty_render_state_image_iterator_free(iterator: number): void;
  ghostty_kitty_graphics_image(graphics: number, id: number): number;
  ghostty_kitty_graphics_image_get(image: number, key: number, out: number): number;
  ghostty_key_event_new(allocator: number, outEvent: number): number;
  ghostty_key_event_free(event: number): void;
  ghostty_key_event_set_action(event: number, action: number): void;
  ghostty_key_event_set_key(event: number, key: number): void;
  ghostty_key_event_set_mods(event: number, mods: number): void;
  ghostty_key_event_set_utf8(event: number, ptr: number, len: number): void;
  ghostty_key_event_set_unshifted_codepoint(event: number, codepoint: number): void;
  ghostty_key_encoder_new(allocator: number, outEncoder: number): number;
  ghostty_key_encoder_free(encoder: number): void;
  ghostty_key_encoder_setopt_from_terminal(encoder: number, terminal: number): void;
  ghostty_key_encoder_encode(encoder: number, event: number, out: number, outCap: number, outLen: number): number;
  ghostty_mouse_event_new(allocator: number, outEvent: number): number;
  ghostty_mouse_event_free(event: number): void;
  ghostty_mouse_event_set_action(event: number, action: number): void;
  ghostty_mouse_event_set_button(event: number, button: number): void;
  ghostty_mouse_event_clear_button(event: number): void;
  ghostty_mouse_event_set_mods(event: number, mods: number): void;
  ghostty_mouse_event_set_position(event: number, position: number): void;
  ghostty_mouse_encoder_new(allocator: number, outEncoder: number): number;
  ghostty_mouse_encoder_free(encoder: number): void;
  ghostty_mouse_encoder_setopt(encoder: number, option: number, value: number): void;
  ghostty_mouse_encoder_setopt_from_terminal(encoder: number, terminal: number): void;
  ghostty_mouse_encoder_encode(encoder: number, event: number, out: number, outCap: number, outLen: number): number;
  ghostty_paste_encode(data: number, dataLen: number, bracketed: number, out: number, outCap: number, outLen: number): number;
  ghostty_search_new(allocator: number, outSearch: number, terminal: number): number;
  ghostty_search_free(search: number): void;
  ghostty_search_set(search: number, option: number, value: number): number;
  ghostty_search_run(search: number): number;
  ghostty_search_get(search: number, key: number, out: number): number;
}

/** every module function the core calls; the type turns one missing here into a compile error */
export const ENGINE_FUNCTIONS: Record<Exclude<keyof GhosttyExports, "memory" | "__indirect_function_table">, true> = {
  ghostty_type_json: true, ghostty_wasm_alloc: true, ghostty_wasm_free: true, ghostty_wasm_alloc_opaque: true, ghostty_wasm_free_opaque: true,
  ghostty_wasm_take_opaque: true, ghostty_free: true, ghostty_terminal_new: true, ghostty_terminal_free: true, ghostty_terminal_reset: true,
  ghostty_terminal_resize: true, ghostty_terminal_set: true, ghostty_terminal_get: true, ghostty_terminal_vt_write: true,
  ghostty_terminal_scroll_viewport: true, ghostty_terminal_grid_ref: true, ghostty_terminal_point_from_grid_ref: true,
  ghostty_grid_ref_row: true, ghostty_grid_ref_cell: true, ghostty_grid_ref_graphemes: true, ghostty_grid_ref_style: true, ghostty_row_get: true,
  ghostty_terminal_select_word: true, ghostty_terminal_select_line: true, ghostty_terminal_selection_format_alloc: true,
  ghostty_render_state_new: true, ghostty_render_state_free: true,
  ghostty_render_state_update: true, ghostty_render_state_get: true, ghostty_render_state_clean: true,
  ghostty_render_state_row_iterator_new: true, ghostty_render_state_row_iterator_next: true, ghostty_render_state_row_iterator_next_dirty: true,
  ghostty_render_state_row_iterator_free: true, ghostty_render_state_row_get: true, ghostty_render_state_row_cells_new: true,
  ghostty_render_state_row_cells_select: true, ghostty_render_state_row_cells_get: true, ghostty_render_state_row_cells_free: true,
  ghostty_render_state_image_iterator_new: true, ghostty_render_state_image_iterator_next: true,
  ghostty_render_state_image_get: true, ghostty_render_state_image_iterator_free: true, ghostty_kitty_graphics_image: true,
  ghostty_kitty_graphics_image_get: true,
  ghostty_key_event_new: true, ghostty_key_event_free: true, ghostty_key_event_set_action: true, ghostty_key_event_set_key: true,
  ghostty_key_event_set_mods: true, ghostty_key_event_set_utf8: true, ghostty_key_event_set_unshifted_codepoint: true,
  ghostty_key_encoder_new: true, ghostty_key_encoder_free: true, ghostty_key_encoder_setopt_from_terminal: true,
  ghostty_key_encoder_encode: true, ghostty_mouse_event_new: true, ghostty_mouse_event_free: true, ghostty_mouse_event_set_action: true,
  ghostty_mouse_event_set_button: true, ghostty_mouse_event_clear_button: true, ghostty_mouse_event_set_mods: true,
  ghostty_mouse_event_set_position: true, ghostty_mouse_encoder_new: true, ghostty_mouse_encoder_free: true,
  ghostty_mouse_encoder_setopt: true, ghostty_mouse_encoder_setopt_from_terminal: true, ghostty_mouse_encoder_encode: true,
  ghostty_paste_encode: true, ghostty_search_new: true, ghostty_search_free: true, ghostty_search_set: true, ghostty_search_run: true,
  ghostty_search_get: true,
};

/** the enum values the core uses, by type and name in ghostty_type_json() */
export const ENGINE_ENUMS = {
  GhosttyResult: ["OUT_OF_SPACE", "NO_VALUE"],
  GhosttyTerminalOption: ["USERDATA", "WRITE_PTY", "BELL", "SIZE", "COLOR_FOREGROUND", "COLOR_BACKGROUND", "COLOR_CURSOR", "COLOR_PALETTE",
    "KITTY_IMAGE_STORAGE_LIMIT", "CLIPBOARD_WRITE", "SCROLLBACK_MAX_BYTES", "SCROLLBACK_MAX_LINES", "MODE_DEFAULT", "MODE", "RENDER_HOLD"],
  GhosttyTerminalData: ["COLS", "ROWS", "CURSOR_X", "CURSOR_Y", "ACTIVE_SCREEN", "SCREEN_GENERATION", "KITTY_KEYBOARD_FLAGS", "SCROLLBAR", "SCROLLBACK_ROWS", "KITTY_GRAPHICS", "MODE"],
  GhosttyTerminalScreen: ["ALTERNATE"],
  GhosttyTerminalScrollViewportTag: ["BOTTOM", "DELTA"],
  GhosttyRenderStateData: ["DIRTY", "ROW_ITERATOR", "CURSOR_VISUAL_STYLE", "CURSOR_VISIBLE", "CURSOR_VIEWPORT_HAS_VALUE",
    "CURSOR_VIEWPORT_X", "CURSOR_VIEWPORT_Y", "CURSOR", "IMAGE_ITERATOR", "IMAGE_PLACEMENTS_GENERATION"],
  GhosttyRenderStateCursorVisualStyle: ["BAR", "BLOCK", "UNDERLINE", "BLOCK_HOLLOW"],
  GhosttyRenderStateRowData: ["CELLS", "CELLS_RAW", "VIEWPORT_Y"],
  GhosttyRenderStateRowCellsData: ["STYLE", "BG_COLOR", "FG_COLOR", "GRAPHEMES_UTF8"],
  GhosttyRenderStateImageData: ["IMAGE_ID", "IMAGE_GENERATION", "LAYER", "Z", "VIEWPORT_COL", "VIEWPORT_ROW", "CELL_OFFSET_X",
    "CELL_OFFSET_Y", "PIXEL_WIDTH", "PIXEL_HEIGHT", "SOURCE_X", "SOURCE_Y", "SOURCE_WIDTH", "SOURCE_HEIGHT"],
  GhosttyKittyGraphicsImageData: ["WIDTH", "HEIGHT", "FORMAT", "DATA_PTR", "DATA_LEN"],
  GhosttyKittyImageFormat: ["RGB", "RGBA", "GRAY_ALPHA", "GRAY"],
  GhosttyCellWide: ["NARROW", "WIDE", "SPACER_TAIL", "SPACER_HEAD"],
  GhosttyCellContentTag: ["CODEPOINT", "CODEPOINT_GRAPHEME", "BG_COLOR_PALETTE", "BG_COLOR_RGB"],
  GhosttyStyleColorTag: ["PALETTE", "RGB"],
  GhosttyKeyAction: ["PRESS", "REPEAT", "RELEASE"],
  GhosttyMouseAction: ["PRESS", "RELEASE", "MOTION"],
  GhosttyMouseButton: ["LEFT", "MIDDLE", "RIGHT", "FOUR", "FIVE", "SIX", "SEVEN"],
  GhosttyMouseEncoderOption: ["SIZE"],
  GhosttyClipboardLocation: ["STANDARD", "SELECTION", "PRIMARY"],
  GhosttyPointTag: ["SCREEN"],
  GhosttyRowData: ["WRAP_CONTINUATION"],
  GhosttyFormatterFormat: ["PLAIN"],
  GhosttySearchOption: ["NEEDLE", "SELECT_NEXT", "SELECT_PREV"],
  GhosttySearchData: ["MATCHES", "SELECTED_MATCH"],
} as const;

/** the struct fields the core reads or writes, by type and name in ghostty_type_json() */
export const ENGINE_FIELDS = {
  GhosttyStyle: ["flags", "fg_color", "bg_color"],
  GhosttyStyleColor: ["tag", "value"],
  GhosttyColorRgb: ["r", "g", "b"],
  GhosttyCellsView: ["ptr", "len"],
  GhosttyBuffer: ["ptr", "cap", "len"],
  GhosttyString: ["ptr", "len"],
  GhosttyTerminalModeConfig: ["mode", "value"],
  GhosttyTerminalScrollViewport: ["tag", "value"],
  GhosttyTerminalScrollbar: ["total", "offset"],
  GhosttyRenderStateCursor: ["size", "viewport_has_value", "viewport_x", "viewport_y", "wide_tail", "visible", "blinking", "visual_style"],
  GhosttySizeReportSize: ["rows", "columns", "cell_width", "cell_height"],
  GhosttyClipboardWrite: ["location", "contents", "contents_len"],
  GhosttyClipboardContent: ["mime", "data"],
  GhosttyMouseEncoderSize: ["size", "screen_width", "screen_height", "cell_width", "cell_height", "padding_top", "padding_bottom",
    "padding_right", "padding_left"],
  GhosttyMousePosition: ["x", "y"],
  GhosttyPoint: ["tag", "value"],
  GhosttyPointCoordinate: ["x", "y"],
  GhosttyGridRef: ["node", "x"],
  GhosttySelection: ["start", "end", "rectangle"],
  GhosttySelectionBuffer: ["ptr", "cap", "len"],
  GhosttyTerminalSelectWordOptions: ["size", "ref", "boundary_codepoints", "boundary_codepoints_len"],
  GhosttyTerminalSelectLineOptions: ["size", "ref", "whitespace", "whitespace_len", "semantic_prompt_boundary"],
  GhosttyTerminalSelectionFormatOptions: ["size", "emit", "unwrap", "trim", "selection"],
} as const;

type Resolved<T extends Record<string, readonly string[]>> = { readonly [K in keyof T]: { readonly [N in T[K][number]]: number } };

/**
 * A colour as the program wrote it: a palette index (0-255) or an rgb triple. A null colour is the
 * terminal's default, so the host's own palette and default colours show.
 */
export type WrittenColor = number | Rgb;

/** how frame() and frameAll() hand colours over: resolved to "#rrggbb" through the terminal's palette, or as written */
export type ColorForm = "hex" | "written";
type RunColor<F extends ColorForm> = F extends "written" ? WrittenColor : string;

/** One run of cells in a row that share a style. */
export interface GhosttyRun<Color = string> {
  x: number;
  /** each cell's grapheme, and whether it fills two columns (Hangul, CJK, most emoji) */
  cells: { text: string; wide: boolean }[];
  fg: Color | null;
  bg: Color | null;
  flags: number;
}

export interface GhosttyCursor { visible: boolean; x: number; y: number; style: number }

/**
 * One cell of a kept row as a reader walks it. `width` 0 is the second column of a wide cell, and `text` is "" where
 * nothing was printed (a blank cell, or one an erase left only a background on). Colours are as the program wrote them.
 */
export interface EngineCell { text: string; width: 0 | 1 | 2; flags: number; fg: WrittenColor | null; bg: WrittenColor | null }

/** A kept row's text cell by cell (GhosttyEngine.rowText). */
export interface EngineRowText { continues: boolean; codes: Uint32Array; widths: Uint8Array; graphemes: Map<number, string> }

/** A Kitty image on screen, in viewport cells and CSS pixels, as the render state places it. */
export interface GhosttyImage {
  id: number;
  /** changes whenever the image's pixels do: part of a decoded image's cache key */
  generation: number;
  /** 0 below the cell backgrounds, 1 below the text, 2 above it */
  layer: number;
  z: number;
  col: number;
  row: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  source: { x: number; y: number; width: number; height: number };
}

/** A stored Kitty image's pixels as RGBA, copied out of the module. */
export interface GhosttyPixels { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> }

/** The cursor as a screen draws it: the shape the program chose, whether it blinks, and whether it sits on a wide character's second column. */
export interface EngineCursor {
  visible: boolean;
  x: number;
  y: number;
  style: "bar" | "block" | "underline" | "hollow";
  blinking: boolean;
  wideTail: boolean;
}

/** The modes the program set that change what its input must look like or how it is drawn. */
export interface EngineModes {
  altScreen: boolean;
  mouse: "none" | "x10" | "normal" | "button" | "any";
  mouseFormat: "x10" | "utf8" | "sgr" | "urxvt" | "sgrPixels";
  bracketedPaste: boolean;
  /** the Kitty keyboard flags in force on the active screen (0: legacy keys) */
  kittyFlags: number;
  focusReports: boolean;
  syncOutput: boolean;
  appCursor: boolean;
  appKeypad: boolean;
  altScroll: boolean;
  /** win32-input-mode (DEC 9001): the module does not keep it, so a screen's engine watches the written bytes for it; false on the browser's */
  win32Input: boolean;
  /**
   * Native screen switches and full resets, including a 1049 re-entry that clears the current alternate.
   * Compare for equality to bind a selection to its screen. The browser counts only its own reset() calls.
   */
  screens: number;
}

export interface EngineMods { shift?: boolean; ctrl?: boolean; alt?: boolean; super?: boolean }

/** A key as the host reported it. */
export interface EngineKey {
  /** the physical key by its GhosttyKey name in ghostty_type_json(): "A", "DIGIT_1", "ENTER", "ARROW_UP", "F1" */
  key: string;
  mods?: EngineMods;
  /** the text the key wrote, shift applied ("A" for shift+a); absent for a key that writes none */
  text?: string;
  /** the key's character without shift ("a" for shift+a) */
  unshifted?: string;
  action?: "press" | "repeat" | "release";
}

/** A mouse event in the pane's own cells (0-based). */
export interface EngineMouse {
  action: "press" | "release" | "motion";
  /** the button pressed or released, or held during a motion; the wheel is buttons 4 to 7 */
  button?: "left" | "middle" | "right" | "wheelUp" | "wheelDown" | "wheelLeft" | "wheelRight";
  mods?: EngineMods;
  col: number;
  row: number;
}

/** What the program asked of its host besides replies: a bell, or a clipboard write (OSC 52 and its kin). */
export type EngineEffect =
  | { type: "bell" }
  | { type: "clipboardWrite"; location: "standard" | "selection" | "primary"; contents: { mime: string; data: Uint8Array }[] };

export interface EngineEvents {
  /** bytes the emulator itself answers the program with (a cursor or size report, a mode report): never input */
  onReply?(bytes: Uint8Array): void;
  /** a synchronized-output hold began (true) or ended (false); frame() shows the frame it began with meanwhile */
  onHold?(held: boolean): void;
  onEffect?(effect: EngineEffect): void;
}

/** A cell in the whole kept screen: y 0 is the oldest row history still holds. Pruning moves it, so read again after a write. */
export interface ScreenPoint { x: number; y: number }
/** From start to end, both cells included. */
export interface ScreenRange { start: ScreenPoint; end: ScreenPoint }

export interface EngineHistory {
  /** rows kept above the screen */
  scrollback: number;
  /** every row kept, the screen's included */
  total: number;
  /** the screen row of the viewport's first row; scrollback when it shows the newest rows */
  viewportTop: number;
}

/** The identity and viewport captured with a render state, including a synchronized-output snapshot. */
export interface EngineScreen {
  readonly altScreen: boolean;
  readonly screens: number;
  readonly history: EngineHistory;
  /** A text read is safe only while no content-changing call has intervened since this capture. */
  readonly contentVersion: number;
}

export type Rgb = readonly [number, number, number];

/** The terminal's colours; a null one is left as it is. */
export interface EngineColors { foreground: Rgb | null; background: Rgb | null; cursor: Rgb | null; palette: readonly Rgb[] }

export interface EngineOptions {
  /**
   * "core" lays graphemes out as herdr-core does: grapheme clustering (mode 2027) on, also after a reset.
   * "xterm" keeps the module's default (2027 off), for a loader that lays graphemes out as xterm does itself.
   */
  widths: "xterm" | "core";
  /** bytes of decoded Kitty pictures the terminal keeps; false keeps none, and a graphics query then gets no answer */
  images: bigint | false;
  /**
   * a terminal screen's lines of history above the screen: sets the line limit and lifts the module's byte
   * limit for the engine's life; absent (the browser's loader) leaves both as the module sets them
   */
  scrollbackLines?: number;
  /**
   * a terminal screen's: the module calls back with replies, holds and effects, and the engine follows 9001
   * and records traps; without it none of that happens
   */
  events?: EngineEvents;
}

export const STYLE_BOLD = 1 << 0;
export const STYLE_ITALIC = 1 << 1;
export const STYLE_FAINT = 1 << 2;
export const STYLE_INVERSE = 1 << 4;
export const STYLE_INVISIBLE = 1 << 5;
export const STYLE_STRIKE = 1 << 6;
export const STYLE_OVERLINE = 1 << 7;
export const STYLE_UNDERLINE_MASK = 0x7 << 8;

// GhosttyMods bits (key/event.h): ghostty_type_json() describes GhosttyMods only as a u16
const MODS_SHIFT = 1 << 0, MODS_CTRL = 1 << 1, MODS_ALT = 1 << 2, MODS_SUPER = 1 << 3;
// DEC private modes as ghostty_mode_new() encodes them (a DEC mode is its own number)
const MODE = {
  appCursor: 1, x10Mouse: 9, appKeypad: 66, normalMouse: 1000, buttonMouse: 1002, anyMouse: 1003, focus: 1004, utf8Mouse: 1005,
  sgrMouse: 1006, altScroll: 1007, urxvtMouse: 1015, sgrPixelsMouse: 1016, bracketedPaste: 2004, syncOutput: 2026, graphemeCluster: 2027,
} as const;
const WIN32_INPUT_MODE = 9001;
/** DECCOLM: a program switches the grid to 80 or 132 columns with it */
const DECCOLM = 3;

const MOUSE_BUTTONS = { left: "LEFT", middle: "MIDDLE", right: "RIGHT", wheelUp: "FOUR", wheelDown: "FIVE", wheelLeft: "SIX", wheelRight: "SEVEN" } as const;
const KEY_ACTIONS = { press: "PRESS", repeat: "REPEAT", release: "RELEASE" } as const;
const MOUSE_ACTIONS = { press: "PRESS", release: "RELEASE", motion: "MOTION" } as const;

/** every layout text a module has reported, parsed: identical bytes describe an identical layout */
const layouts = new Map<string, TypeLayout>();

/**
 * The type layout the module reports, as ghostty_type_json() returns it: parsed once per distinct text and shared,
 * frozen to the last level, by every module that reports that text. Parsing the same 187-type object again for each
 * module (a screen makes one per pane) crashed Bun 1.4.2 in a few percent of processes that made many: an abort in
 * materializePropertyTable, a segmentation fault, or a type name missing from the parsed result.
 */
export function readTypeLayout(exports: Pick<GhosttyExports, "memory" | "ghostty_type_json">): TypeLayout {
  const ptr = exports.ghostty_type_json();
  const bytes = new Uint8Array(exports.memory.buffer, ptr);
  const text = new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
  let layout = layouts.get(text);
  if (!layout) {
    layout = frozen(JSON.parse(text) as TypeLayout);
    layouts.set(text, layout);
  }
  return layout;
}

function frozen<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) frozen(inner);
    Object.freeze(value);
  }
  return value;
}

function resolve<T extends Record<string, readonly string[]>>(table: T, read: (type: string, name: string) => number | undefined): Resolved<T> {
  return Object.fromEntries(Object.entries(table).map(([type, names]) => [type, Object.fromEntries(names.map((name) => {
    const value = read(type, name);
    if (value === undefined) throw new Error(`ghostty-vt: no ${type}.${name} in ghostty_type_json`);
    return [name, value];
  }))])) as Resolved<T>;
}

/** what one engine does when the module calls back with its userdata */
interface CallbackTarget {
  reply(ptr: number, len: number): void;
  size(out: number): boolean;
  bell(): void;
  hold(held: boolean): void;
  clipboardWrite(request: number): void;
}

/** the table slots of the helper's five forwarders, one per callback the terminal takes */
interface CallbackSlots { reply: number; size: number; bell: number; hold: number; clipboardWrite: number }

/**
 * A wasm module of five functions, each forwarding its i32 arguments to the JS import of the same name: the
 * engine's function table can hold only wasm functions, and Bun has no WebAssembly.Function to make one.
 * Each entry is [name, argument count, returns an i32].
 */
const CALLBACK_SIGNATURES = [["reply", 4, false], ["size", 3, true], ["bell", 2, false], ["hold", 3, false], ["clipboardWrite", 3, false]] as const;

function callbackModuleBytes(): Uint8Array<ArrayBuffer> {
  const I32 = 0x7f, FUNC = 0x60, CALL = 0x10, LOCAL_GET = 0x20, END = 0x0b;
  const leb = (value: number): number[] => {
    const out: number[] = [];
    do {
      const byte = value & 0x7f;
      value >>>= 7;
      out.push(value ? byte | 0x80 : byte);
    } while (value);
    return out;
  };
  const name = (text: string): number[] => [...leb(text.length), ...new TextEncoder().encode(text)];
  const vector = (items: number[][]): number[] => [...leb(items.length), ...items.flat()];
  const section = (id: number, body: number[]): number[] => [id, ...leb(body.length), ...body];
  const count = CALLBACK_SIGNATURES.length;
  const types = vector(CALLBACK_SIGNATURES.map(([, args, returns]) => [FUNC, ...leb(args), ...Array(args).fill(I32), ...(returns ? [1, I32] : [0])]));
  const imports = vector(CALLBACK_SIGNATURES.map(([fn], index) => [...name("js"), ...name(fn), 0, ...leb(index)]));
  const functions = vector(CALLBACK_SIGNATURES.map((_, index) => leb(index)));
  const exports = vector(CALLBACK_SIGNATURES.map(([fn], index) => [...name(fn), 0, ...leb(count + index)]));
  const code = vector(CALLBACK_SIGNATURES.map(([, args], index) => {
    const body = [0, ...Array.from({ length: args }, (_, arg) => [LOCAL_GET, ...leb(arg)]).flat(), CALL, ...leb(index), END];
    return [...leb(body.length), ...body];
  }));
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...section(1, types), ...section(2, imports), ...section(3, functions),
    ...section(7, exports), ...section(10, code)]);
}

/** An instantiated libghostty-vt module, with the numbers the core uses read from it by name. */
export class GhosttyModule {
  readonly exports: GhosttyExports;
  readonly enums: Resolved<typeof ENGINE_ENUMS>;
  readonly fields: Resolved<typeof ENGINE_FIELDS>;
  /** each ENGINE_FIELDS struct's size in bytes */
  readonly sizes: { readonly [K in keyof typeof ENGINE_FIELDS]: number };
  /** GhosttyKey values by name */
  readonly keys: Readonly<Record<string, number>>;
  readonly bit: Record<"codepoint" | "content_tag" | "wide" | "style_id" | "bg_index" | "bg_r" | "bg_g" | "bg_b", Bits>;
  /**
   * The trap that broke this module, recorded by a screen's engine (one made with `events`): a trap leaves
   * the module's stack pointer moved for good, so every engine on it refuses from then on and its owner makes
   * a new module (one per pane). The browser's engines record none: its loader shares one module among a
   * page's terminals and hands a terminal whose call threw to xterm, the others drawing on as they did.
   */
  trap: WebAssembly.RuntimeError | null = null;
  private slots: CallbackSlots | null = null;
  private readonly targets = new Map<number, CallbackTarget>();
  private nextUserdata = 1;

  constructor(instance: WebAssembly.Instance | WebAssembly.Instance["exports"]) {
    // the one place untyped exports are taken as GhosttyExports; the `engine exports` test checks them against the module
    this.exports = (instance instanceof WebAssembly.Instance ? instance.exports : instance) as unknown as GhosttyExports;
    const layout = readTypeLayout(this.exports);
    this.enums = resolve(ENGINE_ENUMS, (type, name) => layout.types[type]?.values?.[name]);
    this.fields = resolve(ENGINE_FIELDS, (type, name) => layout.types[type]?.fields?.[name]?.offset);
    this.sizes = Object.fromEntries(Object.keys(ENGINE_FIELDS).map((type) => {
      const size = layout.types[type]?.size;
      if (size === undefined) throw new Error(`ghostty-vt: no size of ${type} in ghostty_type_json`);
      return [type, size];
    })) as GhosttyModule["sizes"];
    const keys = layout.types["GhosttyKey"]?.values;
    if (!keys) throw new Error("ghostty-vt: no GhosttyKey in ghostty_type_json");
    this.keys = keys;
    const cell = layout.types["GhosttyCell"]?.bits;
    if (!cell) throw new Error("ghostty-vt: no GhosttyCell layout in ghostty_type_json");
    const pick = (name: string): Bits => {
      const found = cell[name];
      if (!found) throw new Error(`ghostty-vt: GhosttyCell has no ${name}`);
      return found;
    };
    const content = pick("content");
    const arm = (tag: string, name: string): Bits => {
      const inner = content.arms?.[tag]?.bits[name];
      if (!inner) throw new Error(`ghostty-vt: GhosttyCell content has no ${tag}.${name}`);
      return { lsb: content.lsb + inner.lsb, width: inner.width };
    };
    this.bit = {
      codepoint: arm("CODEPOINT", "codepoint"), content_tag: pick("content_tag"), wide: pick("wide"), style_id: pick("style_id"),
      bg_index: arm("BG_COLOR_PALETTE", "index"), bg_r: arm("BG_COLOR_RGB", "r"), bg_g: arm("BG_COLOR_RGB", "g"), bg_b: arm("BG_COLOR_RGB", "b"),
    };
  }

  /** routes the module's callbacks for a new userdata to `target`; the slots are made once per module */
  connect(target: CallbackTarget): { userdata: number; slots: CallbackSlots } {
    if (!this.slots) {
      const forward = (userdata: number): CallbackTarget | undefined => this.targets.get(userdata);
      const helper = new WebAssembly.Instance(new WebAssembly.Module(callbackModuleBytes()), {
        js: {
          reply: (_terminal: number, userdata: number, ptr: number, len: number) => forward(userdata)?.reply(ptr, len),
          size: (_terminal: number, userdata: number, out: number) => (forward(userdata)?.size(out) ? 1 : 0),
          bell: (_terminal: number, userdata: number) => forward(userdata)?.bell(),
          hold: (_terminal: number, userdata: number, held: number) => forward(userdata)?.hold(held !== 0),
          clipboardWrite: (_terminal: number, userdata: number, request: number) => forward(userdata)?.clipboardWrite(request),
        },
      });
      const table = this.exports.__indirect_function_table;
      const base = table.grow(CALLBACK_SIGNATURES.length);
      CALLBACK_SIGNATURES.forEach(([fn], index) => table.set(base + index, helper.exports[fn] as Parameters<WebAssembly.Table["set"]>[1]));
      this.slots = { reply: base, size: base + 1, bell: base + 2, hold: base + 3, clipboardWrite: base + 4 };
    }
    const userdata = this.nextUserdata++;
    this.targets.set(userdata, target);
    return { userdata, slots: this.slots };
  }

  disconnect(userdata: number): void {
    this.targets.delete(userdata);
  }
}

const hex = (r: number, g: number, b: number): string => `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;

/**
 * Where the engine keeps its small structs in its scratch block (bytes from its start), each placed once
 * so that no two calls in one operation share a spot.
 */
/** a field of a 64-bit cell read as two 32-bit halves; a field may straddle them (style_id does) */
function bitField(lo: number, hi: number, b: Bits): number {
  const mask = b.width >= 32 ? 0xffffffff : (1 << b.width) - 1;
  if (b.lsb >= 32) return (hi >>> (b.lsb - 32)) & mask;
  if (b.lsb + b.width <= 32) return (lo >>> b.lsb) & mask;
  return ((lo >>> b.lsb) | (hi << (32 - b.lsb))) & mask;
}

/** a blank cell in the default style, shared: rowCells hands out many */
const BLANK_CELL: EngineCell = Object.freeze({ text: "", width: 1, flags: 0, fg: null, bg: null });

const AT = {
  frameIterator: 16, frameCells: 24, frameY: 32, frameView: 40, frameColor: 64, frameStyle: 96, palette: 128, graphemeOut: 240,
  grapheme: 256, scroll: 512, mode: 1000, cursor: 1024, mouseSize: 1056, mousePosition: 1096, outLen: 1104, outPtr: 1108,
  string: 1112, selectionBuffer: 1120, point: 1136, refStart: 1160, refEnd: 1168, coordinate: 1176, selection: 1184,
  selectOptions: 1208, formatOptions: 1232, scrollbar: 1256, handle: 1280, encoded: 1296, keyText: 1424,
} as const;
const SCRATCH_BYTES = 1536;
const PALETTE_SIZE = 256;
const ENCODED_CAP = AT.keyText - AT.encoded;
const KEY_TEXT_CAP = SCRATCH_BYTES - AT.keyText;

export class GhosttyEngine {
  private readonly module: GhosttyModule;
  private readonly x: GhosttyExports;
  private readonly e: GhosttyModule["enums"];
  private readonly f: GhosttyModule["fields"];
  private readonly bit: GhosttyModule["bit"];
  private readonly terminal: number;
  private readonly state: number;
  private readonly iterator: number;
  private readonly cells: number;
  private readonly images: number;
  private readonly slot: number;
  private readonly scratch: number;
  private readonly events: EngineEvents | undefined;
  private userdata: number | null = null;
  private input = 0;
  private inputCap = 0;
  private placementsGeneration = -1;
  /** the cursor the last frame() saw: libghostty marks no row dirty when only the cursor moves */
  private lastCursor = "";
  private size: { cols: number; rows: number; cellW: number; cellH: number };
  /** whether a synchronized-output hold is on: frames then come from the render state captured when it began */
  private held = false;
  private renderedScreen: EngineScreen | null = null;
  private contentVersion = 0;
  /** since the last resize the program switched its columns (DECCOLM), or the terminal was reset: the grid may not be the size the engine was given */
  private gridTouched = false;
  private win32Input = false;
  private browserResets = 0;
  /** where the written bytes stand in a `CSI ? Pm h|l` that may name 9001, carried from one write to the next */
  private scan: "ground" | "esc" | "csi" | "private" = "ground";
  private scanParam = 0;
  private scanNames9001 = false;
  private scanNamesColumns = false;
  /** an error a callback of the caller threw while the module ran: kept out of the wasm frames and thrown after them */
  private callbackError: unknown = null;
  private keyEncoder = 0;
  private keyEvent = 0;
  private mouseEncoder = 0;
  private mouseEvent = 0;
  private searcher = 0;
  /** set on a screen's engine by dispose(): every later call refuses */
  private disposed = false;

  constructor(module: GhosttyModule, cols: number, rows: number, options: EngineOptions) {
    if (module.trap) throw new Error("ghostty-vt: the module trapped earlier and cannot make a terminal", { cause: module.trap });
    const exports = module.exports;
    this.module = module;
    this.x = exports;
    this.e = module.enums;
    this.f = module.fields;
    this.bit = module.bit;
    this.size = { cols, rows, cellW: 0, cellH: 0 };
    this.events = options.events;
    // what a screen's engine that fails half made undoes, newest first
    const undo: (() => void)[] = [];
    try {
      this.slot = exports.ghostty_wasm_alloc_opaque();
      if (this.events) {
        // a screen's engine refuses a slot the module had no room for before any call writes through it, and frees it
        if (this.slot === 0) throw new Error("ghostty-vt: no memory for the engine's handle slot");
        undo.push(() => exports.ghostty_wasm_free_opaque(this.slot));
      }
      this.scratch = this.allocate(SCRATCH_BYTES, "the engine's scratch block");
      undo.push(() => exports.ghostty_wasm_free(this.scratch, SCRATCH_BYTES));
      const take = (result: number, what: string, free: (handle: number) => void): number => {
        this.check(result, what);
        const handle = exports.ghostty_wasm_take_opaque(this.slot);
        undo.push(() => free(handle));
        return handle;
      };
      this.terminal = take(exports.ghostty_terminal_new(0, this.slot, cols, rows), "terminal_new", exports.ghostty_terminal_free);
      this.state = take(exports.ghostty_render_state_new(0, this.slot), "render_state_new", exports.ghostty_render_state_free);
      this.iterator = take(exports.ghostty_render_state_row_iterator_new(0, this.slot), "row_iterator_new", exports.ghostty_render_state_row_iterator_free);
      this.cells = take(exports.ghostty_render_state_row_cells_new(0, this.slot), "row_cells_new", exports.ghostty_render_state_row_cells_free);
      this.images = take(exports.ghostty_render_state_image_iterator_new(0, this.slot), "image_iterator_new", exports.ghostty_render_state_image_iterator_free);
      this.setUp(module, options, undo);
      // every handle is taken, so a screen's engine needs its slot no more (the browser's keeps its loader's ways)
      if (this.events) exports.ghostty_wasm_free_opaque(this.slot);
    } catch (error) {
      // a screen's engine leaves nothing behind: its route goes, what it made is freed, and a trap marks the
      // module as one in any later call would; the browser's fails as its loader always had it
      if (options.events) {
        if (error instanceof WebAssembly.RuntimeError) {
          module.trap = error;
          if (this.userdata !== null) module.disconnect(this.userdata);
        } else for (const step of undo.reverse()) step();
      }
      throw error;
    }
  }

  /** the options and, on a screen's engine, the callbacks: the constructor's second half */
  private setUp(module: GhosttyModule, options: EngineOptions, undo: (() => void)[]): void {
    const exports = this.x;
    const option = this.e.GhosttyTerminalOption;
    this.view().setBigUint64(this.scratch, options.images === false ? 0n : options.images, true);
    this.check(exports.ghostty_terminal_set(this.terminal, option.KITTY_IMAGE_STORAGE_LIMIT, this.scratch), "image storage limit");
    if (options.widths === "core") this.setModeConfig(option.MODE_DEFAULT, MODE.graphemeCluster, true);
    if (options.scrollbackLines !== undefined) {
      this.setLineLimit(options.scrollbackLines);
      // a NULL value removes the byte limit, which would otherwise cut history long before the line limit
      this.check(exports.ghostty_terminal_set(this.terminal, option.SCROLLBACK_MAX_BYTES, 0), "scrollback bytes");
    }

    if (this.events) {
      const { userdata, slots } = module.connect({
        reply: (ptr, len) => this.callback(() => this.events?.onReply?.(new Uint8Array(this.x.memory.buffer, ptr, len).slice())),
        size: (out) => {
          const grid = this.grid();
          const dv = this.view();
          const report = this.f.GhosttySizeReportSize;
          dv.setUint16(out + report.rows, grid.rows, true);
          dv.setUint16(out + report.columns, grid.cols, true);
          dv.setUint32(out + report.cell_width, this.size.cellW, true);
          dv.setUint32(out + report.cell_height, this.size.cellH, true);
          return true;
        },
        bell: () => this.callback(() => this.events?.onEffect?.({ type: "bell" })),
        hold: (held) => this.setHeld(held),
        clipboardWrite: (request) => this.callback(() => this.events?.onEffect?.(this.readClipboardWrite(request))),
      });
      this.userdata = userdata;
      undo.push(() => module.disconnect(userdata));
      this.check(exports.ghostty_terminal_set(this.terminal, option.USERDATA, userdata), "userdata");
      this.check(exports.ghostty_terminal_set(this.terminal, option.WRITE_PTY, slots.reply), "write_pty callback");
      this.check(exports.ghostty_terminal_set(this.terminal, option.SIZE, slots.size), "size callback");
      this.check(exports.ghostty_terminal_set(this.terminal, option.BELL, slots.bell), "bell callback");
      this.check(exports.ghostty_terminal_set(this.terminal, option.RENDER_HOLD, slots.hold), "render_hold callback");
      this.check(exports.ghostty_terminal_set(this.terminal, option.CLIPBOARD_WRITE, slots.clipboardWrite), "clipboard_write callback");
    }
  }

  /**
   * A buffer in the module's memory. The module answers 0 when it has no room: a screen's engine refuses then,
   * instead of writing over the module's own memory at address 0; the browser's goes on as its loader always had it.
   */
  private allocate(len: number, what: string): number {
    const ptr = this.x.ghostty_wasm_alloc(len);
    if (ptr === 0 && this.events) throw new Error(`ghostty-vt: no memory for ${what} (${len} bytes)`);
    return ptr;
  }

  private check(result: number, what: string): void {
    if (result !== 0) throw new Error(`ghostty-vt: ${what} failed (${result})`);
  }

  private view(): DataView {
    return new DataView(this.x.memory.buffer);
  }

  /** runs one public call: refuses on a trapped module, records a screen engine's trap, and throws what a callback threw */
  private guard<T>(run: () => T): T {
    const trap = this.module.trap;
    if (trap) throw new Error("ghostty-vt: the module trapped earlier; make a new one", { cause: trap });
    if (this.disposed) throw new Error("ghostty-vt: the engine was disposed");
    let result: T;
    try {
      result = run();
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError && this.events) this.module.trap = error;
      // the call's own error is the one reported: a callback's from the same call must not surface on the next
      this.callbackError = null;
      throw error;
    }
    const failed = this.callbackError;
    if (failed !== null) {
      this.callbackError = null;
      throw failed;
    }
    return result;
  }

  /** a callback of the caller's, run while the module waits: a throw must not unwind through the wasm frames */
  private callback(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.callbackError ??= error;
    }
  }

  private readClipboardWrite(request: number): EngineEffect {
    const dv = this.view();
    const write = this.f.GhosttyClipboardWrite, content = this.f.GhosttyClipboardContent, string = this.f.GhosttyString;
    const location = this.e.GhosttyClipboardLocation;
    const where = dv.getUint32(request + write.location, true);
    const list = dv.getUint32(request + write.contents, true);
    const count = dv.getUint32(request + write.contents_len, true);
    const bytes = (at: number): Uint8Array =>
      new Uint8Array(this.x.memory.buffer, dv.getUint32(at + string.ptr, true), dv.getUint32(at + string.len, true)).slice();
    const contents = Array.from({ length: count }, (_, index) => {
      const item = list + index * this.module.sizes.GhosttyClipboardContent;
      return { mime: new TextDecoder().decode(bytes(item + content.mime)), data: bytes(item + content.data) };
    });
    return { type: "clipboardWrite", location: where === location.SELECTION ? "selection" : where === location.PRIMARY ? "primary" : "standard", contents };
  }

  /** feeds bytes to the terminal as they are */
  write(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    // the browser's loader writes in many small pieces: its engines feed the module directly, as they always did
    if (!this.events) return this.feed(bytes);
    this.guard(() => this.feed(bytes));
  }

  private onAlternate(): boolean {
    return this.getU32(this.e.GhosttyTerminalData.ACTIVE_SCREEN) === this.e.GhosttyTerminalScreen.ALTERNATE;
  }

  private reserveInput(length: number): void {
    if (length > this.inputCap) {
      const cap = Math.max(length, 64 * 1024);
      if (this.events) {
        // a screen's: allocated before the old one is freed, so a refused write keeps it
        const next = this.allocate(cap, "a write");
        if (this.input) this.x.ghostty_wasm_free(this.input, this.inputCap);
        this.input = next;
        this.inputCap = cap;
      } else {
        // the browser's: freed first, exactly as its loader always had it, so the allocator can hand the freed
        // block back and the page's one memory grows no more than it did
        if (this.input) this.x.ghostty_wasm_free(this.input, this.inputCap);
        this.inputCap = cap;
        this.input = this.allocate(cap, "a write");
      }
    }
  }

  private feed(bytes: Uint8Array): void {
    this.reserveInput(bytes.length);
    if (this.events) this.followWrittenModes(bytes);
    new Uint8Array(this.x.memory.buffer, this.input, bytes.length).set(bytes);
    this.changeContent(() => this.x.ghostty_terminal_vt_write(this.terminal, this.input, bytes.length));
  }

  /**
   * A hold can capture midway through a write or resize, before that call changes more text. Mark both boundaries,
   * also on failure: such a snapshot must never authorize a read of the terminal after the call. No parser mirror
   * or history copy is needed. The browser does not use frame-bound reads and keeps its existing behavior.
   */
  private changeContent(run: () => void): void {
    if (!this.events) return run();
    this.contentVersion++;
    try {
      run();
    } finally {
      this.contentVersion++;
    }
  }

  /**
   * Follows `CSI ? Pm h` and `CSI ? Pm l` naming 9001 (win32-input-mode), which the module parses but does not
   * keep, or 3 (DECCOLM, which changes the grid's columns), and a full reset (ESC c), across writes. Only the byte after an ESC and the inside of a `CSI ?`
   * are looked at: any other sequence is skipped to the next ESC, so plain and styled output costs one
   * indexOf per escape sequence. Screen lifetime is reported by the module, not inferred here.
   */
  private followWrittenModes(bytes: Uint8Array): void {
    for (let at = 0; at < bytes.length; at++) {
      const byte = bytes[at]!;
      if (this.scan === "ground") {
        const next = bytes.indexOf(0x1b, at);
        if (next < 0) return;
        at = next;
        this.scan = "esc";
        continue;
      }
      if (byte === 0x1b) { this.scan = "esc"; continue; }
      if (byte === 0x18 || byte === 0x1a) { this.scan = "ground"; continue; }
      switch (this.scan) {
        case "esc":
          if (byte === 0x63) {
            this.win32Input = false;
            this.gridTouched = true;
          }
          this.scan = byte === 0x5b ? "csi" : "ground";
          continue;
        case "csi":
          this.scan = byte === 0x3f ? "private" : "ground";
          this.scanParam = 0;
          this.scanNames9001 = false;
          this.scanNamesColumns = false;
          continue;
        case "private":
          if (byte >= 0x30 && byte <= 0x39) this.scanParam = Math.min(this.scanParam * 10 + byte - 0x30, 1e6);
          else if (byte === 0x3b) {
            if (this.scanParam === WIN32_INPUT_MODE) this.scanNames9001 = true;
            if (this.scanParam === DECCOLM) this.scanNamesColumns = true;
            this.scanParam = 0;
          } else if (byte >= 0x40 && byte <= 0x7e) {
            if ((byte === 0x68 || byte === 0x6c) && (this.scanNames9001 || this.scanParam === WIN32_INPUT_MODE)) this.win32Input = byte === 0x68;
            if ((byte === 0x68 || byte === 0x6c) && (this.scanNamesColumns || this.scanParam === DECCOLM)) this.gridTouched = true;
            this.scan = "ground";
          }
      }
    }
  }

  private setModeConfig(option: number, mode: number, on: boolean): void {
    const dv = this.view();
    const config = this.scratch + AT.mode;
    dv.setUint16(config + this.f.GhosttyTerminalModeConfig.mode, mode, true);
    dv.setUint8(config + this.f.GhosttyTerminalModeConfig.value, on ? 1 : 0);
    this.check(this.x.ghostty_terminal_set(this.terminal, option, config), `mode ${mode}`);
  }

  /** sets a terminal mode as ghostty_mode_new() encodes it (a DEC private mode is its own number) */
  setMode(mode: number, on: boolean): void {
    if (mode === DECCOLM) this.gridTouched = true;
    // the browser's loader toggles 2027 around every emoji joiner: as with write, no guard on its engines
    if (!this.events) return this.setModeConfig(this.e.GhosttyTerminalOption.MODE, mode, on);
    this.guard(() => this.changeContent(() => {
      this.setModeConfig(this.e.GhosttyTerminalOption.MODE, mode, on);
      // setting the mode this way does not call back: a hold begins or ends here, as the program's own bytes would make it
      if (mode === MODE.syncOutput) this.setHeld(on);
    }));
  }

  private getMode(mode: number): boolean {
    const dv = this.view();
    const config = this.scratch + AT.mode;
    dv.setUint16(config + this.f.GhosttyTerminalModeConfig.mode, mode, true);
    dv.setUint8(config + this.f.GhosttyTerminalModeConfig.value, 0);
    this.check(this.x.ghostty_terminal_get(this.terminal, this.e.GhosttyTerminalData.MODE, config), `mode ${mode}`);
    return this.view().getUint8(config + this.f.GhosttyTerminalModeConfig.value) !== 0;
  }

  private getU32(key: number): number {
    this.view().setUint32(this.scratch, 0, true);
    this.check(this.x.ghostty_terminal_get(this.terminal, key, this.scratch), `terminal_get ${key}`);
    return this.view().getUint32(this.scratch, true);
  }

  /**
   * The grid the terminal has now, which a program can switch from the size it was given (DECCOLM: 80 or 132
   * columns), or that size where the module cannot say. It never throws: the module's size callback asks it.
   */
  private grid(): { cols: number; rows: number } {
    const read = (key: number): number | undefined => {
      this.view().setUint16(this.scratch, 0, true);
      return this.x.ghostty_terminal_get(this.terminal, key, this.scratch) === 0 ? this.view().getUint16(this.scratch, true) : undefined;
    };
    const data = this.e.GhosttyTerminalData;
    return { cols: read(data.COLS) ?? this.size.cols, rows: read(data.ROWS) ?? this.size.rows };
  }

  modes(): EngineModes {
    return this.guard(() => {
      const data = this.e.GhosttyTerminalData;
      const on = (mode: number): boolean => this.getMode(mode);
      this.view().setUint8(this.scratch, 0);
      this.check(this.x.ghostty_terminal_get(this.terminal, data.KITTY_KEYBOARD_FLAGS, this.scratch), "kitty keyboard flags");
      const kittyFlags = this.view().getUint8(this.scratch);
      let screens = this.browserResets;
      if (this.events) {
        this.check(this.x.ghostty_terminal_get(this.terminal, data.SCREEN_GENERATION, this.scratch), "screen generation");
        screens = Number(this.view().getBigUint64(this.scratch, true));
      }
      // with several on, the most capable wins: a program that sets one after another means the last, and the last is the most capable
      const mouse = on(MODE.anyMouse) ? "any" : on(MODE.buttonMouse) ? "button" : on(MODE.normalMouse) ? "normal" : on(MODE.x10Mouse) ? "x10" : "none";
      const mouseFormat = on(MODE.sgrPixelsMouse) ? "sgrPixels" : on(MODE.sgrMouse) ? "sgr" : on(MODE.urxvtMouse) ? "urxvt" : on(MODE.utf8Mouse) ? "utf8" : "x10";
      return {
        altScreen: this.onAlternate(),
        mouse, mouseFormat, bracketedPaste: on(MODE.bracketedPaste), kittyFlags, focusReports: on(MODE.focus),
        syncOutput: on(MODE.syncOutput), appCursor: on(MODE.appCursor), appKeypad: on(MODE.appKeypad), altScroll: on(MODE.altScroll),
        win32Input: this.win32Input, screens,
      };
    });
  }

  /**
   * Ends a hold the program forgot (synchronized output left on): the next frame shows what it wrote since,
   * and onHold(false) reports the end, as it does when the program ends a hold itself.
   */
  releaseHold(): void {
    this.guard(() => {
      if (!this.held) return;
      // turning the mode off this way does not call back, so the end is made here
      this.setModeConfig(this.e.GhosttyTerminalOption.MODE, MODE.syncOutput, false);
      this.setHeld(false);
    });
  }

  /**
   * The one way a hold begins or ends, whether the program's bytes, releaseHold or setMode(2026) turn it: a hold
   * already so changes nothing and reports nothing. A hold that begins keeps exactly the frame the program wants left
   * on screen, captured now (a failure is reported after the module returns, like any callback's, never thrown
   * through its frames; a trap marks the module, as one in any call does).
   */
  private setHeld(held: boolean): void {
    if (held === this.held) return;
    if (held) this.callback(() => {
      try {
        this.updateRenderState();
      } catch (error) {
        if (error instanceof WebAssembly.RuntimeError) this.module.trap = error;
        throw error;
      }
    });
    this.held = held;
    this.callback(() => this.events?.onHold?.(held));
  }

  reset(): void {
    this.guard(() => {
      this.gridTouched = true;
      this.changeContent(() => this.x.ghostty_terminal_reset(this.terminal));
      this.placementsGeneration = -1;
      this.win32Input = false;
      if (!this.events) this.browserResets++;
    });
  }

  /**
   * The browser's engine resizes every time, as its loader always did. A screen's engine skips a resize to the size it
   * has only while nothing changed its grid since (a written or set DECCOLM, which switches to 80 or 132 columns, or a
   * reset could): the module would send a program with mode 2048 a second size report.
   */
  resize(cols: number, rows: number, cellW: number, cellH: number): void {
    const w = Math.max(1, Math.round(cellW)), h = Math.max(1, Math.round(cellH));
    // the module reads the new size back through the SIZE callback during the call, so it is set first and put back
    // when the module refuses: the next resize to that size must reach the module again
    const apply = (): void => {
      const size = this.size;
      this.size = { cols, rows, cellW: w, cellH: h };
      try {
        this.check(this.x.ghostty_terminal_resize(this.terminal, cols, rows, w, h), "resize");
      } catch (error) {
        this.size = size;
        throw error;
      }
      this.gridTouched = false;
    };
    if (!this.events) return apply();
    this.guard(() => {
      const size = this.size;
      if (!this.gridTouched && size.cols === cols && size.rows === rows && size.cellW === w && size.cellH === h) return;
      this.changeContent(apply);
    });
  }

  /**
   * Lines of history above the screen, as a line limit only (the module prunes whole pages, so 0 still
   * keeps about 200 rows of 120 columns). The module's byte limit stays as it is: on the browser's engines
   * it keeps about 600 rows of 120 columns whatever the line count. An engine made with `scrollbackLines`
   * has the byte limit lifted for good, so there the line count alone decides.
   */
  setScrollback(lines: number): void {
    this.guard(() => this.changeContent(() => this.setLineLimit(lines)));
  }

  private setLineLimit(lines: number): void {
    this.view().setUint32(this.scratch, lines, true);
    this.check(this.x.ghostty_terminal_set(this.terminal, this.e.GhosttyTerminalOption.SCROLLBACK_MAX_LINES, this.scratch), "scrollback");
  }

  /** shows the screen `rowsAboveBottom` rows up in the history (0: the newest rows) */
  scrollFromBottom(rowsAboveBottom: number): void {
    this.guard(() => {
      const dv = this.view();
      const behavior = this.scratch + AT.scroll;
      const { tag, value } = this.f.GhosttyTerminalScrollViewport;
      dv.setUint32(behavior + tag, this.e.GhosttyTerminalScrollViewportTag.BOTTOM, true);
      this.x.ghostty_terminal_scroll_viewport(this.terminal, behavior);
      if (rowsAboveBottom <= 0) return;
      dv.setUint32(behavior + tag, this.e.GhosttyTerminalScrollViewportTag.DELTA, true);
      dv.setInt32(behavior + value, -rowsAboveBottom, true);
      this.x.ghostty_terminal_scroll_viewport(this.terminal, behavior);
    });
  }

  setColors(colors: EngineColors): void {
    // checked before the module is called, so a refused set changes no colour
    const usable = (value: Rgb | null): boolean => value === null || value.every((c) => Number.isInteger(c) && c >= 0 && c <= 255);
    if (![colors.foreground, colors.background, colors.cursor, ...colors.palette].every(usable)) throw new Error("ghostty-vt: a colour outside 0-255");
    if (colors.palette.length !== 0 && colors.palette.length !== PALETTE_SIZE) throw new Error(`ghostty-vt: a palette of ${colors.palette.length} colours, not ${PALETTE_SIZE} or none`);
    this.guard(() => {
      const dv = this.view();
      const option = this.e.GhosttyTerminalOption;
      const setColor = (key: number, value: Rgb | null): void => {
        if (!value) return;
        dv.setUint8(this.scratch, value[0]);
        dv.setUint8(this.scratch + 1, value[1]);
        dv.setUint8(this.scratch + 2, value[2]);
        this.check(this.x.ghostty_terminal_set(this.terminal, key, this.scratch), `color ${key}`);
      };
      setColor(option.COLOR_FOREGROUND, colors.foreground);
      setColor(option.COLOR_BACKGROUND, colors.background);
      setColor(option.COLOR_CURSOR, colors.cursor);
      const palette = this.scratch + AT.palette;
      colors.palette.forEach((value, index) => {
        dv.setUint8(palette + index * 3, value[0]);
        dv.setUint8(palette + index * 3 + 1, value[1]);
        dv.setUint8(palette + index * 3 + 2, value[2]);
      });
      if (colors.palette.length === PALETTE_SIZE) this.check(this.x.ghostty_terminal_set(this.terminal, option.COLOR_PALETTE, palette), "palette");
    });
  }

  /**
   * Snapshot the terminal and call `draw` for each row that changed since the last frame.
   * Returns false when nothing changed, the cursor included (an arrow key moves only the cursor, #3266).
   * During a synchronized-output hold the snapshot is the one taken when the hold began.
   */
  frame<F extends ColorForm = "hex">(draw: (y: number, runs: GhosttyRun<RunColor<F>>[]) => void, colors?: F): boolean {
    return this.guard(() => this.drawRows(draw as (y: number, runs: GhosttyRun<string | WrittenColor>[]) => void, false, colors === "written"));
  }

  /** frame() for every row, changed or not: a screen repaints a whole pane with it */
  frameAll<F extends ColorForm = "hex">(draw: (y: number, runs: GhosttyRun<RunColor<F>>[]) => void, colors?: F): void {
    this.guard(() => this.drawRows(draw as (y: number, runs: GhosttyRun<string | WrittenColor>[]) => void, true, colors === "written"));
  }

  /** Read after frame/frameAll: the screen those cells came from, not the terminal behind a held snapshot. */
  frameScreen(): EngineScreen | null {
    return this.guard(() => this.renderedScreen);
  }

  private updateRenderState(): void {
    this.check(this.x.ghostty_render_state_update(this.state, this.terminal), "render_state_update");
    if (this.events) {
      this.check(this.x.ghostty_terminal_get(this.terminal, this.e.GhosttyTerminalData.SCREEN_GENERATION, this.scratch), "screen generation");
      const screens = Number(this.view().getBigUint64(this.scratch, true));
      this.renderedScreen = { screens, altScreen: this.onAlternate(), history: this.readHistory(), contentVersion: this.contentVersion };
    }
  }

  private drawRows(draw: (y: number, runs: GhosttyRun<string | WrittenColor>[]) => void, all: boolean, written: boolean): boolean {
    const x = this.x;
    const rs = this.e.GhosttyRenderStateData, rowData = this.e.GhosttyRenderStateRowData, cellsData = this.e.GhosttyRenderStateRowCellsData;
    const wides = this.e.GhosttyCellWide, tags = this.e.GhosttyCellContentTag;
    if (!this.held) this.updateRenderState();
    const c = this.readCursor();
    const cursor = `${c.visible} ${c.x} ${c.y} ${c.style}`;
    const cursorMoved = cursor !== this.lastCursor;
    this.lastCursor = cursor;
    this.check(x.ghostty_render_state_get(this.state, rs.DIRTY, this.scratch), "dirty");
    if (!all && this.view().getInt32(this.scratch, true) === 0) return cursorMoved;

    const iterSlot = this.scratch + AT.frameIterator;
    const cellsSlot = this.scratch + AT.frameCells;
    const outY = this.scratch + AT.frameY;
    const viewOut = this.scratch + AT.frameView;
    const colorOut = this.scratch + AT.frameColor;
    const styleOut = this.scratch + AT.frameStyle;
    const flagsOffset = this.f.GhosttyStyle.flags;
    let dv = this.view();
    dv.setUint32(iterSlot, this.iterator, true);
    this.check(x.ghostty_render_state_get(this.state, rs.ROW_ITERATOR, iterSlot), "row iterator");
    dv.setUint32(cellsSlot, this.cells, true);
    const { codepoint: cpB, content_tag: tagB, wide: wideB, style_id: styleB } = this.bit;
    const field = bitField;
    const next = all
      ? (): boolean => {
        if (!x.ghostty_render_state_row_iterator_next(this.iterator)) return false;
        this.check(x.ghostty_render_state_row_get(this.iterator, rowData.VIEWPORT_Y, outY), "row y");
        return true;
      }
      : (): boolean => x.ghostty_render_state_row_iterator_next_dirty(this.iterator, outY) !== 0;

    while (next()) {
      dv = this.view();
      const y = dv.getUint16(outY, true);
      this.check(x.ghostty_render_state_row_get(this.iterator, rowData.CELLS_RAW, viewOut), "cells raw");
      this.check(x.ghostty_render_state_row_get(this.iterator, rowData.CELLS, cellsSlot), "cells");
      dv = this.view();
      const ptr = dv.getUint32(viewOut + this.f.GhosttyCellsView.ptr, true);
      const len = dv.getUint32(viewOut + this.f.GhosttyCellsView.len, true);
      const runs: GhosttyRun<string | WrittenColor>[] = [];
      let run: GhosttyRun<string | WrittenColor> | null = null;
      let runKey = -1;
      for (let col = 0; col < len; col++) {
        const lo = dv.getUint32(ptr + col * 8, true);
        const hi = dv.getUint32(ptr + col * 8 + 4, true);
        const wide = field(lo, hi, wideB);
        if (wide === wides.SPACER_TAIL || wide === wides.SPACER_HEAD) continue;
        const tag = field(lo, hi, tagB);
        const styleId = field(lo, hi, styleB);
        const bgOnly = tag === tags.BG_COLOR_PALETTE || tag === tags.BG_COLOR_RGB;
        // the style id changes whenever the style does; bg-only cells carry their colour in the cell itself
        const key = bgOnly ? -2 - lo : styleId;
        if (!run || key !== runKey) {
          run = { x: col, cells: [], fg: null, bg: null, flags: 0 };
          runKey = key;
          runs.push(run);
          if (written && bgOnly) {
            run.bg = tag === tags.BG_COLOR_PALETTE
              ? field(lo, hi, this.bit.bg_index)
              : [field(lo, hi, this.bit.bg_r), field(lo, hi, this.bit.bg_g), field(lo, hi, this.bit.bg_b)];
          } else if (written && styleId !== 0) {
            x.ghostty_render_state_row_cells_select(this.cells, col);
            if (x.ghostty_render_state_row_cells_get(this.cells, cellsData.STYLE, styleOut) === 0) {
              dv = this.view();
              run.flags = dv.getUint16(styleOut + flagsOffset, true);
              run.fg = this.writtenColor(dv, styleOut + this.f.GhosttyStyle.fg_color);
              run.bg = this.writtenColor(dv, styleOut + this.f.GhosttyStyle.bg_color);
            }
            dv = this.view();
          } else if (styleId !== 0 || bgOnly) {
            x.ghostty_render_state_row_cells_select(this.cells, col);
            if (x.ghostty_render_state_row_cells_get(this.cells, cellsData.FG_COLOR, colorOut) === 0) {
              dv = this.view();
              run.fg = hex(dv.getUint8(colorOut), dv.getUint8(colorOut + 1), dv.getUint8(colorOut + 2));
            }
            if (x.ghostty_render_state_row_cells_get(this.cells, cellsData.BG_COLOR, colorOut) === 0) {
              dv = this.view();
              run.bg = hex(dv.getUint8(colorOut), dv.getUint8(colorOut + 1), dv.getUint8(colorOut + 2));
            }
            if (!bgOnly && x.ghostty_render_state_row_cells_get(this.cells, cellsData.STYLE, styleOut) === 0) {
              dv = this.view();
              run.flags = dv.getUint16(styleOut + flagsOffset, true);
            }
            dv = this.view();
          }
        }
        let text: string;
        if (tag === tags.CODEPOINT_GRAPHEME) {
          text = this.grapheme(col);
          dv = this.view();
        } else {
          const cp = bgOnly ? 0 : field(lo, hi, cpB);
          text = cp === 0 ? " " : String.fromCodePoint(cp);
        }
        run.cells.push({ text, wide: wide === wides.WIDE });
      }
      draw(y, runs);
    }
    this.check(x.ghostty_render_state_clean(this.state), "clean");
    return true;
  }

  /** a GhosttyStyleColor at `at` as the program wrote it */
  private writtenColor(dv: DataView, at: number): WrittenColor | null {
    const tag = dv.getUint8(at + this.f.GhosttyStyleColor.tag);
    const value = at + this.f.GhosttyStyleColor.value;
    const { PALETTE, RGB } = this.e.GhosttyStyleColorTag;
    if (tag === PALETTE) return dv.getUint8(value);
    if (tag !== RGB) return null;
    const rgb = this.f.GhosttyColorRgb;
    return [dv.getUint8(value + rgb.r), dv.getUint8(value + rgb.g), dv.getUint8(value + rgb.b)];
  }

  private grapheme(col: number): string {
    const x = this.x;
    const graphemes = this.e.GhosttyRenderStateRowCellsData.GRAPHEMES_UTF8;
    x.ghostty_render_state_row_cells_select(this.cells, col);
    const buf = this.scratch + AT.grapheme;
    const cap = 120;
    const out = this.scratch + AT.graphemeOut;
    const { ptr: ptrAt, cap: capAt, len: lenAt } = this.f.GhosttyBuffer;
    let dv = this.view();
    dv.setUint32(out + ptrAt, buf, true);
    dv.setUint32(out + capAt, cap, true);
    dv.setUint32(out + lenAt, 0, true);
    if (x.ghostty_render_state_row_cells_get(this.cells, graphemes, out) !== 0) {
      // a long ZWJ sequence: the call names the room it needs
      const need = this.view().getUint32(out + lenAt, true);
      if (need <= cap) return " ";
      const big = this.allocate(need, "a grapheme");
      try {
        dv = this.view();
        dv.setUint32(out + ptrAt, big, true);
        dv.setUint32(out + capAt, need, true);
        dv.setUint32(out + lenAt, 0, true);
        if (x.ghostty_render_state_row_cells_get(this.cells, graphemes, out) !== 0) return " ";
        const n = this.view().getUint32(out + lenAt, true);
        return new TextDecoder().decode(new Uint8Array(this.x.memory.buffer, big, n).slice()) || " ";
      } finally {
        x.ghostty_wasm_free(big, need);
      }
    }
    dv = this.view();
    const n = dv.getUint32(out + lenAt, true);
    return new TextDecoder().decode(new Uint8Array(this.x.memory.buffer, buf, n)) || " ";
  }

  private getU8(key: number): number {
    this.check(this.x.ghostty_render_state_get(this.state, key, this.scratch), `render_state_get ${key}`);
    return this.view().getUint8(this.scratch);
  }

  private getU16(key: number): number {
    this.check(this.x.ghostty_render_state_get(this.state, key, this.scratch), `render_state_get ${key}`);
    return this.view().getUint16(this.scratch, true);
  }

  private readCursor(): GhosttyCursor {
    const rs = this.e.GhosttyRenderStateData;
    const visible = this.getU8(rs.CURSOR_VISIBLE) !== 0 && this.getU8(rs.CURSOR_VIEWPORT_HAS_VALUE) !== 0;
    if (!visible) return { visible: false, x: 0, y: 0, style: 1 };
    return { visible, x: this.getU16(rs.CURSOR_VIEWPORT_X), y: this.getU16(rs.CURSOR_VIEWPORT_Y), style: this.getU8(rs.CURSOR_VISUAL_STYLE) };
  }

  /** the cursor of the last frame(), its style as the module's number */
  cursor(): GhosttyCursor {
    return this.guard(() => this.readCursor());
  }

  /** the cursor of the last frame() as a screen draws it */
  cursorState(): EngineCursor {
    return this.guard(() => {
      const out = this.scratch + AT.cursor;
      const c = this.f.GhosttyRenderStateCursor;
      this.view().setUint32(out + c.size, this.module.sizes.GhosttyRenderStateCursor, true);
      this.check(this.x.ghostty_render_state_get(this.state, this.e.GhosttyRenderStateData.CURSOR, out), "cursor");
      const dv = this.view();
      const shape = this.e.GhosttyRenderStateCursorVisualStyle;
      const visual = dv.getUint32(out + c.visual_style, true);
      const style = visual === shape.BAR ? "bar" : visual === shape.UNDERLINE ? "underline" : visual === shape.BLOCK_HOLLOW ? "hollow" : "block";
      const visible = dv.getUint8(out + c.visible) !== 0 && dv.getUint8(out + c.viewport_has_value) !== 0;
      return {
        visible, x: visible ? dv.getUint16(out + c.viewport_x, true) : 0, y: visible ? dv.getUint16(out + c.viewport_y, true) : 0, style,
        blinking: dv.getUint8(out + c.blinking) !== 0, wideTail: visible && dv.getUint8(out + c.wide_tail) !== 0,
      };
    });
  }

  private modsBits(mods: EngineMods | undefined): number {
    if (!mods) return 0;
    return (mods.shift ? MODS_SHIFT : 0) | (mods.ctrl ? MODS_CTRL : 0) | (mods.alt ? MODS_ALT : 0) | (mods.super ? MODS_SUPER : 0);
  }

  /** an encoder's output into the scratch block, read once more into a fresh buffer when it needs more room */
  private encoded(encode: (out: number, cap: number, outLen: number) => number, what: string): Uint8Array {
    const outLen = this.scratch + AT.outLen;
    this.view().setUint32(outLen, 0, true);
    const result = encode(this.scratch + AT.encoded, ENCODED_CAP, outLen);
    if (result === this.e.GhosttyResult.OUT_OF_SPACE) {
      const need = this.view().getUint32(outLen, true);
      const big = this.allocate(need, "an encoded input");
      try {
        this.check(encode(big, need, outLen), what);
        return new Uint8Array(this.x.memory.buffer, big, this.view().getUint32(outLen, true)).slice();
      } finally {
        this.x.ghostty_wasm_free(big, need);
      }
    }
    this.check(result, what);
    return new Uint8Array(this.x.memory.buffer, this.scratch + AT.encoded, this.view().getUint32(outLen, true)).slice();
  }

  private handle(make: (out: number) => number, what: string): number {
    this.view().setUint32(this.scratch + AT.handle, 0, true);
    this.check(make(this.scratch + AT.handle), what);
    return this.view().getUint32(this.scratch + AT.handle, true);
  }

  /**
   * The bytes a key sends to the program in the keyboard mode it asked for; empty when the program
   * cannot see the chord (a lone modifier, a release in legacy mode): drop it.
   */
  encodeKey(key: EngineKey): Uint8Array {
    return this.guard(() => {
      const x = this.x;
      const code = this.module.keys[key.key];
      if (code === undefined) throw new Error(`ghostty-vt: no key ${key.key}`);
      if (!this.keyEncoder) this.keyEncoder = this.handle((out) => x.ghostty_key_encoder_new(0, out), "key_encoder_new");
      if (!this.keyEvent) this.keyEvent = this.handle((out) => x.ghostty_key_event_new(0, out), "key_event_new");
      const event = this.keyEvent;
      // legacy encoding gives ctrl+shift+a its C0 byte only when the event's text is the unshifted letter
      const text = key.mods?.ctrl && key.unshifted ? key.unshifted : key.text ?? "";
      const utf8 = new TextEncoder().encode(text);
      if (utf8.length > KEY_TEXT_CAP) throw new Error(`ghostty-vt: key text of ${utf8.length} bytes`);
      new Uint8Array(x.memory.buffer, this.scratch + AT.keyText, utf8.length).set(utf8);
      x.ghostty_key_event_set_action(event, this.e.GhosttyKeyAction[KEY_ACTIONS[key.action ?? "press"]]);
      x.ghostty_key_event_set_key(event, code);
      x.ghostty_key_event_set_mods(event, this.modsBits(key.mods));
      x.ghostty_key_event_set_utf8(event, utf8.length ? this.scratch + AT.keyText : 0, utf8.length);
      x.ghostty_key_event_set_unshifted_codepoint(event, key.unshifted?.codePointAt(0) ?? 0);
      x.ghostty_key_encoder_setopt_from_terminal(this.keyEncoder, this.terminal);
      const bytes = this.encoded((out, cap, outLen) => x.ghostty_key_encoder_encode(this.keyEncoder, event, out, cap, outLen), "key encode");
      return this.legacyControl(bytes);
    });
  }

  /**
   * The encoder writes ctrl+i, ctrl+m and ctrl+[ as CSI u (`ESC[105;5u`) even when the program asked for
   * no keyboard protocol, where such a program shows it as text. Send what a plain terminal sends instead:
   * the C0 byte, the same as Tab, Enter and Esc. A program that turned on Kitty flags or modifyOtherKeys
   * keeps the encoder's own form.
   */
  private legacyControl(bytes: Uint8Array): Uint8Array {
    const match = /^\x1b\[(\d+);5u$/.exec(new TextDecoder().decode(bytes));
    if (!match) return bytes;
    const codepoint = Number(match[1]);
    if (codepoint < 0x40 || codepoint > 0x7e) return bytes;
    this.view().setUint8(this.scratch, 0);
    this.check(this.x.ghostty_terminal_get(this.terminal, this.e.GhosttyTerminalData.KITTY_KEYBOARD_FLAGS, this.scratch), "kitty keyboard flags");
    if (this.view().getUint8(this.scratch) !== 0) return bytes;
    return Uint8Array.of(codepoint & 0x1f);
  }

  /** The bytes a mouse event sends to the program in the mouse mode and format it asked for; empty when it asked for none. */
  encodeMouse(mouse: EngineMouse): Uint8Array {
    return this.guard(() => {
      const x = this.x;
      if (!this.mouseEncoder) this.mouseEncoder = this.handle((out) => x.ghostty_mouse_encoder_new(0, out), "mouse_encoder_new");
      if (!this.mouseEvent) this.mouseEvent = this.handle((out) => x.ghostty_mouse_event_new(0, out), "mouse_event_new");
      const encoder = this.mouseEncoder, event = this.mouseEvent;
      x.ghostty_mouse_encoder_setopt_from_terminal(encoder, this.terminal);
      // the encoder takes surface pixels: a pane-local cell is its top-left pixel
      const cellW = Math.max(1, this.size.cellW), cellH = Math.max(1, this.size.cellH);
      const grid = this.grid();
      const dv = this.view();
      const size = this.scratch + AT.mouseSize, s = this.f.GhosttyMouseEncoderSize;
      dv.setUint32(size + s.size, this.module.sizes.GhosttyMouseEncoderSize, true);
      dv.setUint32(size + s.screen_width, grid.cols * cellW, true);
      dv.setUint32(size + s.screen_height, grid.rows * cellH, true);
      dv.setUint32(size + s.cell_width, cellW, true);
      dv.setUint32(size + s.cell_height, cellH, true);
      for (const padding of [s.padding_top, s.padding_bottom, s.padding_left, s.padding_right]) dv.setUint32(size + padding, 0, true);
      x.ghostty_mouse_encoder_setopt(encoder, this.e.GhosttyMouseEncoderOption.SIZE, size);
      x.ghostty_mouse_event_set_action(event, this.e.GhosttyMouseAction[MOUSE_ACTIONS[mouse.action]]);
      if (mouse.button) x.ghostty_mouse_event_set_button(event, this.e.GhosttyMouseButton[MOUSE_BUTTONS[mouse.button]]);
      else x.ghostty_mouse_event_clear_button(event);
      x.ghostty_mouse_event_set_mods(event, this.modsBits(mouse.mods));
      const position = this.scratch + AT.mousePosition, p = this.f.GhosttyMousePosition;
      dv.setFloat32(position + p.x, mouse.col * cellW, true);
      dv.setFloat32(position + p.y, mouse.row * cellH, true);
      x.ghostty_mouse_event_set_position(event, position);
      return this.encoded((out, cap, outLen) => x.ghostty_mouse_encoder_encode(encoder, event, out, cap, outLen), "mouse encode");
    });
  }

  /**
   * A paste as the program should receive it: one bracketed block when it turned mode 2004 on, with any
   * control byte inside (an end marker's ESC) made a space; each newline a CR when it did not.
   */
  encodePaste(text: string): Uint8Array {
    return this.guard(() => {
      const x = this.x;
      const bracketed = this.getMode(MODE.bracketedPaste) ? 1 : 0;
      const data = new TextEncoder().encode(text);
      const input = this.allocate(Math.max(1, data.length), "a paste");
      try {
        new Uint8Array(x.memory.buffer, input, data.length).set(data);
        return this.encoded((out, cap, outLen) => x.ghostty_paste_encode(input, data.length, bracketed, out, cap, outLen), "paste encode");
      } finally {
        x.ghostty_wasm_free(input, Math.max(1, data.length));
      }
    });
  }

  history(): EngineHistory {
    return this.guard(() => this.readHistory());
  }

  private readHistory(): EngineHistory {
    const data = this.e.GhosttyTerminalData;
    const scrollbar = this.scratch + AT.scrollbar, bar = this.f.GhosttyTerminalScrollbar;
    this.check(this.x.ghostty_terminal_get(this.terminal, data.SCROLLBAR, scrollbar), "scrollbar");
    const dv = this.view();
    const total = Number(dv.getBigUint64(scrollbar + bar.total, true));
    const viewportTop = Number(dv.getBigUint64(scrollbar + bar.offset, true));
    return { scrollback: this.getU32(data.SCROLLBACK_ROWS), total, viewportTop };
  }

  /** the grid reference of a screen point at `out`; false when the point is outside the kept rows */
  private gridRef(point: ScreenPoint, out: number): boolean {
    const dv = this.view();
    const at = this.scratch + AT.point, p = this.f.GhosttyPoint, coordinate = this.f.GhosttyPointCoordinate;
    dv.setUint32(at + p.tag, this.e.GhosttyPointTag.SCREEN, true);
    dv.setUint16(at + p.value + coordinate.x, point.x, true);
    dv.setUint32(at + p.value + coordinate.y, point.y, true);
    return this.x.ghostty_terminal_grid_ref(this.terminal, at, out) === 0;
  }

  private screenPoint(ref: number): ScreenPoint {
    const out = this.scratch + AT.coordinate, coordinate = this.f.GhosttyPointCoordinate;
    this.check(this.x.ghostty_terminal_point_from_grid_ref(this.terminal, ref, this.e.GhosttyPointTag.SCREEN, out), "point_from_grid_ref");
    const dv = this.view();
    return { x: dv.getUint16(out + coordinate.x, true), y: dv.getUint32(out + coordinate.y, true) };
  }

  private rangeOf(selection: number): ScreenRange {
    const s = this.f.GhosttySelection;
    return { start: this.screenPoint(selection + s.start), end: this.screenPoint(selection + s.end) };
  }

  /** Whether a kept row continues a soft wrap, even if the preceding row has been pruned. */
  rowContinues(y: number): boolean | null {
    return this.guard(() => {
      const ref = this.scratch + AT.refStart, row = this.scratch + AT.refEnd;
      if (!this.gridRef({ x: 0, y }, ref)) return null;
      this.check(this.x.ghostty_grid_ref_row(ref, row), "grid_ref_row");
      const raw = this.view().getBigUint64(row, true);
      this.check(this.x.ghostty_row_get(raw, this.e.GhosttyRowData.WRAP_CONTINUATION, this.scratch), "row wrap continuation");
      return this.view().getUint8(this.scratch) !== 0;
    });
  }

  /** the cursor's cell on the screen a program writes to, `y` counted from that screen's top row (the first one below the history) */
  screenCursor(): ScreenPoint {
    return this.guard(() => {
      const data = this.e.GhosttyTerminalData;
      const read = (key: number): number => {
        this.check(this.x.ghostty_terminal_get(this.terminal, key, this.scratch), `terminal_get ${key}`);
        return this.view().getUint16(this.scratch, true);
      };
      return { x: read(data.CURSOR_X), y: read(data.CURSOR_Y) };
    });
  }

  /** whether a program has the alternate screen up (it keeps no history) */
  alternate(): boolean {
    return this.guard(() => this.onAlternate());
  }

  /**
   * The text of kept row `y` cell by cell, for a reader of the text alone: each cell's code point (0 where nothing was
   * printed, a background left by an erase included) and width (0 for a wide cell's second column), and the whole
   * grapheme of a cell that holds more than one code point, and whether the row continues a soft wrap (rowContinues).
   * Null outside the kept rows. Unlike rowCells, no style is read.
   */
  rowText(y: number): EngineRowText | null {
    return this.guard(() => {
      const x = this.x;
      const tags = this.e.GhosttyCellContentTag, wides = this.e.GhosttyCellWide;
      const ref = this.scratch + AT.refStart, raw = this.scratch + AT.frameView;
      const cols = this.grid().cols;
      if (!this.gridRef({ x: 0, y }, ref)) return null;
      const refX = ref + this.f.GhosttyGridRef.x;
      const { wide: wideB, content_tag: tagB, codepoint: cpB } = this.bit;
      const rowRaw = this.scratch + AT.refEnd;
      this.check(x.ghostty_grid_ref_row(ref, rowRaw), "grid_ref_row");
      this.check(x.ghostty_row_get(this.view().getBigUint64(rowRaw, true), this.e.GhosttyRowData.WRAP_CONTINUATION, this.scratch), "row wrap continuation");
      const row: EngineRowText = { continues: this.view().getUint8(this.scratch) !== 0, codes: new Uint32Array(cols), widths: new Uint8Array(cols), graphemes: new Map() };
      let dv = this.view();
      for (let col = 0; col < cols; col++) {
        dv.setUint16(refX, col, true);
        if (x.ghostty_grid_ref_cell(ref, raw) !== 0) throw new Error("ghostty-vt: grid_ref_cell failed");
        const lo = dv.getUint32(raw, true), hi = dv.getUint32(raw + 4, true);
        const wide = bitField(lo, hi, wideB), tag = bitField(lo, hi, tagB);
        row.widths[col] = wide === wides.WIDE ? 2 : wide === wides.SPACER_TAIL ? 0 : 1;
        if (wide === wides.SPACER_HEAD || (tag !== tags.CODEPOINT && tag !== tags.CODEPOINT_GRAPHEME)) continue;
        row.codes[col] = bitField(lo, hi, cpB);
        if (tag === tags.CODEPOINT_GRAPHEME) {
          row.graphemes.set(col, this.refGrapheme(ref));
          dv = this.view();
        }
      }
      return row;
    });
  }

  /** The cells of kept row `y` (screen coordinates, as rowContinues), as wide as the grid; null outside the kept rows. */
  rowCells(y: number): EngineCell[] | null {
    return this.guard(() => {
      const x = this.x;
      const tags = this.e.GhosttyCellContentTag, wides = this.e.GhosttyCellWide;
      const ref = this.scratch + AT.refStart, raw = this.scratch + AT.frameView, style = this.scratch + AT.frameStyle;
      const cols = this.grid().cols;
      const cells: EngineCell[] = [];
      // the row is found once (a point is looked up from the oldest kept row); its cells are its reference moved along it
      if (!this.gridRef({ x: 0, y }, ref)) return null;
      const refX = ref + this.f.GhosttyGridRef.x;
      const { wide: wideB, content_tag: tagB, codepoint: cpB, style_id: styleB } = this.bit;
      let dv = this.view();
      for (let col = 0; col < cols; col++) {
        dv.setUint16(refX, col, true);
        if (x.ghostty_grid_ref_cell(ref, raw) !== 0) throw new Error("ghostty-vt: grid_ref_cell failed");
        const lo = dv.getUint32(raw, true), hi = dv.getUint32(raw + 4, true);
        const wide = bitField(lo, hi, wideB);
        const tag = bitField(lo, hi, tagB);
        const codepoint = tag === tags.CODEPOINT || tag === tags.CODEPOINT_GRAPHEME ? bitField(lo, hi, cpB) : 0;
        const styleId = bitField(lo, hi, styleB);
        if (wide === wides.NARROW && tag === tags.CODEPOINT && styleId === 0) {
          // the common cell: one code point, or none, in the default style
          cells.push(codepoint === 0 ? BLANK_CELL : { text: codepoint < 0x10000 ? String.fromCharCode(codepoint) : String.fromCodePoint(codepoint), width: 1, flags: 0, fg: null, bg: null });
          continue;
        }
        const cell: EngineCell = { text: "", width: wide === wides.WIDE ? 2 : wide === wides.SPACER_TAIL ? 0 : 1, flags: 0, fg: null, bg: null };
        if (tag === tags.BG_COLOR_PALETTE) cell.bg = bitField(lo, hi, this.bit.bg_index);
        else if (tag === tags.BG_COLOR_RGB) cell.bg = [bitField(lo, hi, this.bit.bg_r), bitField(lo, hi, this.bit.bg_g), bitField(lo, hi, this.bit.bg_b)];
        else {
          if (tag === tags.CODEPOINT_GRAPHEME) {
            cell.text = this.refGrapheme(ref);
            dv = this.view();
          } else if (codepoint !== 0 && wide !== wides.SPACER_HEAD) cell.text = String.fromCodePoint(codepoint);
          if (styleId !== 0) {
            this.check(x.ghostty_grid_ref_style(ref, style), "grid_ref_style");
            cell.flags = dv.getUint16(style + this.f.GhosttyStyle.flags, true);
            cell.fg = this.writtenColor(dv, style + this.f.GhosttyStyle.fg_color);
            cell.bg = this.writtenColor(dv, style + this.f.GhosttyStyle.bg_color);
          }
        }
        cells.push(cell);
      }
      return cells;
    });
  }

  /** the grapheme cluster of the cell `ref` points at, its first code point included */
  private refGrapheme(ref: number): string {
    const x = this.x;
    const out = this.scratch + AT.graphemeOut, buf = this.scratch + AT.grapheme, cap = (AT.scroll - AT.grapheme) / 4;
    const read = (at: number, count: number): string => {
      const dv = this.view();
      let text = "";
      for (let index = 0; index < count; index++) text += String.fromCodePoint(dv.getUint32(at + index * 4, true));
      return text;
    };
    const result = x.ghostty_grid_ref_graphemes(ref, buf, cap, out);
    if (result === 0) return read(buf, this.view().getUint32(out, true));
    if (result !== this.e.GhosttyResult.OUT_OF_SPACE) this.check(result, "grid_ref_graphemes");
    // a long ZWJ sequence: the call names the room it needs
    const need = this.view().getUint32(out, true);
    const big = this.allocate(need * 4, "a grapheme");
    try {
      this.check(x.ghostty_grid_ref_graphemes(ref, big, need, out), "grid_ref_graphemes");
      return read(big, this.view().getUint32(out, true));
    } finally {
      x.ghostty_wasm_free(big, need * 4);
    }
  }

  /**
   * The text of a range, soft wraps joined and trailing blanks dropped. With a captured content version, refuse
   * instead of substituting text from a newer terminal state (including a held frame whose history was pruned).
   */
  textOf(range: ScreenRange, contentVersion?: number): string {
    return this.guard(() => {
      if (contentVersion !== undefined && contentVersion !== this.contentVersion) return "";
      const x = this.x;
      const selection = this.scratch + AT.selection, s = this.f.GhosttySelection;
      if (!this.gridRef(range.start, this.scratch + AT.refStart) || !this.gridRef(range.end, this.scratch + AT.refEnd)) return "";
      const dv = this.view();
      const refBytes = this.module.sizes.GhosttyGridRef;
      new Uint8Array(x.memory.buffer).copyWithin(selection + s.start, this.scratch + AT.refStart, this.scratch + AT.refStart + refBytes);
      new Uint8Array(x.memory.buffer).copyWithin(selection + s.end, this.scratch + AT.refEnd, this.scratch + AT.refEnd + refBytes);
      dv.setUint8(selection + s.rectangle, 0);
      const options = this.scratch + AT.formatOptions, o = this.f.GhosttyTerminalSelectionFormatOptions;
      dv.setUint32(options + o.size, this.module.sizes.GhosttyTerminalSelectionFormatOptions, true);
      dv.setUint32(options + o.emit, this.e.GhosttyFormatterFormat.PLAIN, true);
      dv.setUint8(options + o.unwrap, 1);
      dv.setUint8(options + o.trim, 1);
      dv.setUint32(options + o.selection, selection, true);
      const outPtr = this.scratch + AT.outPtr, outLen = this.scratch + AT.outLen;
      dv.setUint32(outPtr, 0, true);
      dv.setUint32(outLen, 0, true);
      this.check(x.ghostty_terminal_selection_format_alloc(this.terminal, 0, options, outPtr, outLen), "selection format");
      const ptr = this.view().getUint32(outPtr, true), len = this.view().getUint32(outLen, true);
      const text = new TextDecoder().decode(new Uint8Array(x.memory.buffer, ptr, len));
      x.ghostty_free(0, ptr, len);
      return text;
    });
  }

  /** the word under a point, as a double click selects it; null on a blank */
  wordAt(point: ScreenPoint): ScreenRange | null {
    return this.guard(() => {
      const options = this.scratch + AT.selectOptions, o = this.f.GhosttyTerminalSelectWordOptions;
      if (!this.gridRef(point, options + o.ref)) return null;
      const dv = this.view();
      dv.setUint32(options + o.size, this.module.sizes.GhosttyTerminalSelectWordOptions, true);
      dv.setUint32(options + o.boundary_codepoints, 0, true);
      dv.setUint32(options + o.boundary_codepoints_len, 0, true);
      const selection = this.scratch + AT.selection;
      const result = this.x.ghostty_terminal_select_word(this.terminal, options, selection);
      if (result === this.e.GhosttyResult.NO_VALUE) return null;
      this.check(result, "select_word");
      return this.rangeOf(selection);
    });
  }

  /** the line under a point, as a triple click selects it (a soft-wrapped line whole); null on a blank row */
  lineAt(point: ScreenPoint): ScreenRange | null {
    return this.guard(() => {
      const options = this.scratch + AT.selectOptions, o = this.f.GhosttyTerminalSelectLineOptions;
      if (!this.gridRef(point, options + o.ref)) return null;
      const dv = this.view();
      dv.setUint32(options + o.size, this.module.sizes.GhosttyTerminalSelectLineOptions, true);
      dv.setUint32(options + o.whitespace, 0, true);
      dv.setUint32(options + o.whitespace_len, 0, true);
      dv.setUint8(options + o.semantic_prompt_boundary, 0);
      const selection = this.scratch + AT.selection;
      const result = this.x.ghostty_terminal_select_line(this.terminal, options, selection);
      if (result === this.e.GhosttyResult.NO_VALUE) return null;
      this.check(result, "select_line");
      return this.rangeOf(selection);
    });
  }

  /**
   * Every match of `needle` in the screen and the history, newest first (ASCII letters match either case).
   * An empty needle ends the search. The matches stay valid until the next write.
   */
  search(needle: string): ScreenRange[] {
    return this.guard(() => {
      const x = this.x;
      if (!this.searcher) this.searcher = this.handle((out) => x.ghostty_search_new(0, out, this.terminal), "search_new");
      const option = this.e.GhosttySearchOption;
      const bytes = new TextEncoder().encode(needle);
      if (bytes.length === 0) {
        this.check(x.ghostty_search_set(this.searcher, option.NEEDLE, 0), "search needle");
        return [];
      }
      const copy = this.allocate(bytes.length, "a search needle");
      try {
        new Uint8Array(x.memory.buffer, copy, bytes.length).set(bytes);
        const string = this.scratch + AT.string, str = this.f.GhosttyString;
        this.view().setUint32(string + str.ptr, copy, true);
        this.view().setUint32(string + str.len, bytes.length, true);
        this.check(x.ghostty_search_set(this.searcher, option.NEEDLE, string), "search needle");
      } finally {
        x.ghostty_wasm_free(copy, bytes.length);
      }
      this.check(x.ghostty_search_run(this.searcher), "search run");
      const buffer = this.scratch + AT.selectionBuffer, b = this.f.GhosttySelectionBuffer;
      const matches = this.e.GhosttySearchData.MATCHES;
      let dv = this.view();
      dv.setUint32(buffer + b.ptr, 0, true);
      dv.setUint32(buffer + b.cap, 0, true);
      dv.setUint32(buffer + b.len, 0, true);
      const sized = x.ghostty_search_get(this.searcher, matches, buffer);
      if (sized !== 0 && sized !== this.e.GhosttyResult.OUT_OF_SPACE) this.check(sized, "search matches");
      const count = this.view().getUint32(buffer + b.len, true);
      if (count === 0) return [];
      const stride = this.module.sizes.GhosttySelection;
      const list = this.allocate(count * stride, "the search matches");
      try {
        dv = this.view();
        dv.setUint32(buffer + b.ptr, list, true);
        dv.setUint32(buffer + b.cap, count, true);
        this.check(x.ghostty_search_get(this.searcher, matches, buffer), "search matches");
        const found = this.view().getUint32(buffer + b.len, true);
        return Array.from({ length: found }, (_, index) => this.rangeOf(list + index * stride));
      } finally {
        x.ghostty_wasm_free(list, count * stride);
      }
    });
  }

  /**
   * Selects the next match of the last search toward older rows (up into history) or newer ones, wrapping
   * at the end, and scrolls the viewport to it when it is off screen; null when there is no match.
   */
  searchStep(toward: "older" | "newer"): ScreenRange | null {
    return this.guard(() => {
      if (!this.searcher) return null;
      const x = this.x;
      const option = this.e.GhosttySearchOption;
      const result = x.ghostty_search_set(this.searcher, toward === "older" ? option.SELECT_NEXT : option.SELECT_PREV, 0);
      if (result === this.e.GhosttyResult.NO_VALUE) return null;
      this.check(result, "search select");
      const selection = this.scratch + AT.selection;
      this.check(x.ghostty_search_get(this.searcher, this.e.GhosttySearchData.SELECTED_MATCH, selection), "search selected");
      return this.rangeOf(selection);
    });
  }

  /** the Kitty images on screen after the last frame(), or null when the list has not changed since the last call */
  placedImages(): GhosttyImage[] | null {
    return this.guard(() => {
      const x = this.x;
      const rs = this.e.GhosttyRenderStateData, image = this.e.GhosttyRenderStateImageData;
      const dv0 = this.view();
      dv0.setBigUint64(this.scratch, 0n, true);
      this.check(x.ghostty_render_state_get(this.state, rs.IMAGE_PLACEMENTS_GENERATION, this.scratch), "placements generation");
      const generation = Number(this.view().getBigUint64(this.scratch, true));
      if (generation === this.placementsGeneration) return null;
      this.placementsGeneration = generation;
      this.view().setUint32(this.scratch, this.images, true);
      this.check(x.ghostty_render_state_get(this.state, rs.IMAGE_ITERATOR, this.scratch), "image iterator");
      const out = this.scratch + 64;
      const read = (key: number, signed = false): number => {
        const dv = this.view();
        dv.setBigUint64(out, 0n, true);
        if (x.ghostty_render_state_image_get(this.images, key, out) !== 0) return 0;
        const fresh = this.view();
        return signed ? fresh.getInt32(out, true) : fresh.getUint32(out, true);
      };
      const list: GhosttyImage[] = [];
      while (x.ghostty_render_state_image_iterator_next(this.images)) {
        const dv = this.view();
        dv.setBigUint64(out, 0n, true);
        x.ghostty_render_state_image_get(this.images, image.IMAGE_GENERATION, out);
        const imageGeneration = Number(this.view().getBigUint64(out, true));
        list.push({
          id: read(image.IMAGE_ID), generation: imageGeneration, layer: read(image.LAYER), z: read(image.Z, true),
          col: read(image.VIEWPORT_COL, true), row: read(image.VIEWPORT_ROW, true), offsetX: read(image.CELL_OFFSET_X), offsetY: read(image.CELL_OFFSET_Y),
          width: read(image.PIXEL_WIDTH), height: read(image.PIXEL_HEIGHT),
          source: { x: read(image.SOURCE_X), y: read(image.SOURCE_Y), width: read(image.SOURCE_WIDTH), height: read(image.SOURCE_HEIGHT) },
        });
      }
      return list;
    });
  }

  /** a stored Kitty image's pixels as RGBA, copied out of the module; null once the program deleted it */
  imagePixels(id: number): GhosttyPixels | null {
    return this.guard(() => {
      const x = this.x;
      const data = this.e.GhosttyKittyGraphicsImageData, format = this.e.GhosttyKittyImageFormat;
      this.view().setUint32(this.scratch, 0, true);
      if (x.ghostty_terminal_get(this.terminal, this.e.GhosttyTerminalData.KITTY_GRAPHICS, this.scratch) !== 0) return null;
      const graphics = this.view().getUint32(this.scratch, true);
      const image = x.ghostty_kitty_graphics_image(graphics, id);
      if (!image) return null;
      const u32 = (key: number): number => {
        this.check(x.ghostty_kitty_graphics_image_get(image, key, this.scratch + 64), `image ${key}`);
        return this.view().getUint32(this.scratch + 64, true);
      };
      const width = u32(data.WIDTH), height = u32(data.HEIGHT), kind = u32(data.FORMAT);
      const ptr = u32(data.DATA_PTR), len = u32(data.DATA_LEN);
      if (width === 0 || height === 0) return null;
      const source = new Uint8Array(this.x.memory.buffer, ptr, len);
      const rgba = new Uint8ClampedArray(width * height * 4);
      const pixels = width * height;
      if (kind === format.RGBA) rgba.set(source.subarray(0, rgba.length));
      else {
        const channels = kind === format.RGB ? 3 : kind === format.GRAY_ALPHA ? 2 : kind === format.GRAY ? 1 : 0;
        if (channels === 0) return null;
        for (let p = 0; p < pixels; p++) {
          const s = p * channels, d = p * 4;
          if (channels >= 3) { rgba[d] = source[s]!; rgba[d + 1] = source[s + 1]!; rgba[d + 2] = source[s + 2]!; rgba[d + 3] = 255; }
          else { rgba[d] = rgba[d + 1] = rgba[d + 2] = source[s]!; rgba[d + 3] = channels === 2 ? source[s + 1]! : 255; }
        }
      }
      return { width, height, rgba };
    });
  }

  /** frees the terminal and everything made for it; on a trapped module only the callback route is dropped */
  dispose(): void {
    if (this.disposed) return;
    // a screen's engine refuses every call from now on; the browser's keeps its loader's old ways
    if (this.events) this.disposed = true;
    if (this.userdata !== null) this.module.disconnect(this.userdata);
    if (this.module.trap) return;
    const x = this.x;
    if (this.searcher) x.ghostty_search_free(this.searcher);
    if (this.keyEvent) x.ghostty_key_event_free(this.keyEvent);
    if (this.keyEncoder) x.ghostty_key_encoder_free(this.keyEncoder);
    if (this.mouseEvent) x.ghostty_mouse_event_free(this.mouseEvent);
    if (this.mouseEncoder) x.ghostty_mouse_encoder_free(this.mouseEncoder);
    x.ghostty_render_state_image_iterator_free(this.images);
    x.ghostty_render_state_row_cells_free(this.cells);
    x.ghostty_render_state_row_iterator_free(this.iterator);
    x.ghostty_render_state_free(this.state);
    x.ghostty_terminal_free(this.terminal);
    x.ghostty_wasm_free(this.scratch, SCRATCH_BYTES);
    if (this.input) x.ghostty_wasm_free(this.input, this.inputCap);
  }
}
