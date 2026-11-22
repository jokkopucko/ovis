import type {
  EngineColors,
  EngineCursor,
  EngineEvents,
  EngineHistory,
  EngineKey,
  EngineModes,
  EngineMouse,
  GhosttyRun,
  ScreenPoint,
  ScreenRange,
  WrittenColor,
} from "../../shared/ghostty/engine.ts";

export {
  STYLE_BOLD,
  STYLE_FAINT,
  STYLE_INVERSE,
  STYLE_INVISIBLE,
  STYLE_ITALIC,
  STYLE_STRIKE,
  STYLE_UNDERLINE_MASK,
} from "../../shared/ghostty/engine.ts";
export type { EngineColors, EngineCursor, EngineEvents, EngineHistory, EngineKey, EngineModes, EngineMouse, GhosttyRun, ScreenPoint, ScreenRange, WrittenColor };

/**
 * Why a call gave no answer:
 * - `trapped`: the engine's module trapped (a `WebAssembly.RuntimeError`). This is the only kind that ends the emulator: it
 *   drops its engine and every later call answers the same error; the pane machine makes a new one by reattaching.
 * - `disposed`: the emulator was disposed; every later call answers this.
 * - `failed`: the engine or a handler passed in `events` threw something else (a bad argument, a throwing callback); that call
 *   only, the emulator stays alive.
 * - `size`: a size outside the range (or no options object, which names no size), refused before the engine saw it; the
 *   emulator stays alive.
 * - `busy`: a handler or draw callback called its own emulator while that emulator's call was running; refused, nothing done,
 *   the emulator stays alive.
 */
export interface EmulatorError {
  kind: "size" | "disposed" | "trapped" | "failed" | "busy";
  message: string;
  cause?: unknown;
}

/** What every call of an emulator returns: nothing it does throws into the caller. */
export type EmulatorResult<T> = { ok: true; value: T } | { ok: false; error: EmulatorError };

export interface EmulatorOptions {
  cols: number;
  rows: number;
  /** replies, holds and effects of this pane; an empty object when the caller wants none */
  events: EngineEvents;
}

/**
 * One pane's terminal state. Not shared: its own wasm instance, freed by `dispose`. A handler passed in `events` or a draw callback
 * may call `dispose()` on its own emulator (it takes effect when the running call returns, and no handler or draw callback of it
 * is called after it); any other call on its own emulator answers `busy`. Other emulators may be called freely.
 */
export interface Emulator {
  /**
   * Null while the emulator lives and after a clean `dispose()`. Otherwise why it ended: the trap that killed it (`trapped`), or
   * what the engine threw while `dispose()` freed it (`trapped` for a trap, `failed` for anything else; the emulator is
   * disposed all the same).
   */
  readonly failure: EmulatorError | null;

  write(bytes: Uint8Array): EmulatorResult<void>;
  /** a no-op when nothing changed; cell sizes are in pixels */
  resize(cols: number, rows: number, cellW: number, cellH: number): EmulatorResult<void>;
  reset(): EmulatorResult<void>;
  /**
   * frees the terminal; safe to call twice and on a dead emulator, and it never throws. From inside a handler or draw callback
   * of a running call it frees when that call returns; that call still returns its own result.
   */
  dispose(): void;

  /** rows changed since the last call, as runs of cells that share a style, colours as the program wrote them; true when any row was drawn */
  frame(draw: (y: number, runs: GhosttyRun<WrittenColor>[]) => void): EmulatorResult<boolean>;
  frameAll(draw: (y: number, runs: GhosttyRun<WrittenColor>[]) => void): EmulatorResult<void>;
  /** the cursor of the last frame; draw first */
  cursorState(): EmulatorResult<EngineCursor>;
  modes(): EmulatorResult<EngineModes>;
  setMode(mode: number, on: boolean): EmulatorResult<void>;
  releaseHold(): EmulatorResult<void>;
  setColors(colors: EngineColors): EmulatorResult<void>;

  /** empty bytes: the program cannot see the key */
  encodeKey(key: EngineKey): EmulatorResult<Uint8Array>;
  /** empty bytes: the program asked for no mouse */
  encodeMouse(mouse: EngineMouse): EmulatorResult<Uint8Array>;
  encodePaste(text: string): EmulatorResult<Uint8Array>;

  setScrollback(lines: number): EmulatorResult<void>;
  scrollFromBottom(rowsAboveBottom: number): EmulatorResult<void>;
  history(): EmulatorResult<EngineHistory>;
  rowContinues(y: number): EmulatorResult<boolean | null>;
  textOf(range: ScreenRange): EmulatorResult<string>;
  wordAt(point: ScreenPoint): EmulatorResult<ScreenRange | null>;
  lineAt(point: ScreenPoint): EmulatorResult<ScreenRange | null>;
  search(needle: string): EmulatorResult<ScreenRange[]>;
  searchStep(toward: "older" | "newer"): EmulatorResult<ScreenRange | null>;
}

/** Makes emulators, one per pane. */
export interface EmulatorLoader {
  create(options: EmulatorOptions): Promise<EmulatorResult<Emulator>>;
}
