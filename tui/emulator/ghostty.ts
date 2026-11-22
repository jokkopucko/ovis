import wasmFile from "../../shared/ghostty/ghostty-vt.wasm" with { type: "file" };
import { GhosttyEngine, GhosttyModule } from "../../shared/ghostty/engine.ts";
import { TERMINAL_HISTORY_LINES } from "../../shared/terminal-flow.ts";
import type { EngineEvents } from "../../shared/ghostty/engine.ts";
import { GraphicsQueries } from "./graphics.ts";
import type { Emulator, EmulatorError, EmulatorLoader, EmulatorOptions, EmulatorResult } from "./index.ts";

/** The smallest pane the engine is asked for. */
const MIN_CELLS = 1;
/** The engine can hang or exhaust its module on absurd sizes, so a pane is never asked for more than this. */
export const MAX_COLS = 1000;
export const MAX_ROWS = 500;
/** The largest cell, in pixels, a resize may name. */
const MAX_CELL_PIXELS = 1000;

export interface LoaderOptions {
  /** the engine file's bytes; read once, on the first emulator */
  read: () => Promise<ArrayBuffer>;
  /** called with each emulator's module before its engine is made */
  onModule?: (module: GhosttyModule) => void;
}

const inRange = (value: number, max: number): boolean => Number.isInteger(value) && value >= MIN_CELLS && value <= max;

function badSize(cols: number, rows: number): EmulatorError | null {
  if (inRange(cols, MAX_COLS) && inRange(rows, MAX_ROWS)) return null;
  return { kind: "size", message: `size ${cols}x${rows} is outside ${MIN_CELLS}x${MIN_CELLS}..${MAX_COLS}x${MAX_ROWS}` };
}

function badCell(cellW: number, cellH: number): EmulatorError | null {
  if ([cellW, cellH].every((pixels) => Number.isFinite(pixels) && pixels >= 0 && pixels <= MAX_CELL_PIXELS)) return null;
  return { kind: "size", message: `cell size ${cellW}x${cellH} is outside 0..${MAX_CELL_PIXELS}` };
}

const refuse = (error: EmulatorError): { ok: false; error: EmulatorError } => ({ ok: false, error });

/**
 * Makes emulators on the shared engine core, each on a wasm instance of its own (one per pane). The engine file is read and
 * compiled once, when the first emulator is asked for; a failed read is tried again by the next call. A compiled module holds no
 * terminal state, so nothing a trapped instance left behind reaches the next emulator.
 */
export function createEmulatorLoader(options: LoaderOptions): EmulatorLoader {
  let compiled: Promise<WebAssembly.Module> | null = null;
  const compile = (): Promise<WebAssembly.Module> => {
    compiled ??= options.read().then((bytes) => WebAssembly.compile(bytes)).catch((error: unknown) => {
      compiled = null;
      throw error;
    });
    return compiled;
  };

  return {
    async create(given: EmulatorOptions): Promise<EmulatorResult<Emulator>> {
      // no options object names no size: refused like any other bad size, before the engine file is read
      const { cols, rows, events }: EmulatorOptions =
        typeof given === "object" && given !== null ? given : { cols: Number.NaN, rows: Number.NaN, events: {} };
      const size = badSize(cols, rows);
      if (size) return refuse(size);
      try {
        const module = new GhosttyModule(new WebAssembly.Instance(await compile(), {}));
        options.onModule?.(module);
        // always a screen's engine (one made with `events`), never the browser's, whatever the caller passed as `events`
        const emulator = new GhosttyEmulator(module, events ?? {}, (guarded) =>
          new GhosttyEngine(module, cols, rows, { widths: "core", images: false, scrollbackLines: TERMINAL_HISTORY_LINES, events: guarded }));
        return { ok: true, value: emulator };
      } catch (error) {
        return refuse(errorOf(error));
      }
    },
  };
}

/** the loader of the compiled screen: the engine file embedded in the binary */
const embedded = createEmulatorLoader({ read: () => Bun.file(wasmFile).arrayBuffer() });

export const createEmulator = (options: EmulatorOptions): Promise<EmulatorResult<Emulator>> => embedded.create(options);

const busyError = (): EmulatorError => ({ kind: "busy", message: "a call of this emulator is still running; it was not entered again" });

function errorOf(error: unknown): EmulatorError {
  const message = error instanceof Error ? error.message : String(error);
  return { kind: error instanceof WebAssembly.RuntimeError ? "trapped" : "failed", message, cause: error };
}

/**
 * An emulator never runs inside its own call: a handler or draw callback that calls it again is refused with `busy`, and one that
 * disposes it only marks it disposed, so the engine is freed after the module finished the running call (freeing it earlier frees
 * memory the module is still parsing). From the mark on, no handler or draw callback of the emulator is called.
 */
class GhosttyEmulator implements Emulator {
  failure: EmulatorError | null = null;
  private module: GhosttyModule | null;
  private engine: GhosttyEngine | null;
  private readonly graphics = new GraphicsQueries();
  private disposed = false;
  /** whether a call of this emulator is running; at most one is, since a nested call is refused */
  private running = false;

  /**
   * `make` builds the engine on the caller's handlers, each looked up when the engine calls it and skipped once the emulator is
   * disposed (also in the rest of the call that disposed it)
   */
  constructor(module: GhosttyModule, private readonly events: EngineEvents, make: (events: EngineEvents) => GhosttyEngine) {
    this.module = module;
    this.engine = make({
      onReply: (bytes) => {
        if (!this.disposed) events.onReply?.(bytes);
      },
      onHold: (held) => {
        if (!this.disposed) events.onHold?.(held);
      },
      onEffect: (effect) => {
        if (!this.disposed) events.onEffect?.(effect);
      },
    });
  }

  /** a draw callback of the caller's, skipped once the emulator is disposed (also for the rest of the frame that disposed it) */
  private live<A extends unknown[]>(callback: (...args: A) => void): (...args: A) => void {
    return (...args) => {
      if (!this.disposed) callback(...args);
    };
  }

  /** the error every call answers once the emulator is disposed or dead, or null while it lives */
  private ended(): EmulatorError | null {
    if (this.disposed) return { kind: "disposed", message: "the emulator was disposed" };
    return this.failure;
  }

  /**
   * runs one engine call, unless the emulator ended, another of its calls is running (`busy`) or `check` refuses it. A trap (a
   * thrown `WebAssembly.RuntimeError`, or one recorded on the module) kills the emulator: its engine and module are dropped and
   * every later call answers the same error. Any other error fails that call only. A dispose during the call frees the engine
   * when the call is over.
   */
  private call<T>(run: (engine: GhosttyEngine) => T, check?: () => EmulatorError | null): EmulatorResult<T> {
    const refused = this.ended() ?? (this.running ? busyError() : null) ?? check?.() ?? null;
    if (refused) return refuse(refused);
    const module = this.module!;
    this.running = true;
    let result: EmulatorResult<T>;
    try {
      const value = run(this.engine!);
      result = module.trap ? refuse(this.die(module.trap)) : { ok: true, value };
    } catch (error) {
      const trap = module.trap ?? (error instanceof WebAssembly.RuntimeError ? error : null);
      result = refuse(trap ? this.die(trap) : this.ended() ?? errorOf(error));
    } finally {
      this.running = false;
    }
    if (this.disposed) this.free();
    return result;
  }

  private die(trap: WebAssembly.RuntimeError): EmulatorError {
    this.failure = errorOf(trap);
    this.engine = null;
    this.module = null;
    return this.failure;
  }

  /** inside a running call only marks the emulator disposed: `call` frees it when the call is over */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.running) this.free();
  }

  private free(): void {
    try {
      this.engine?.dispose();
    } catch (error) {
      this.failure ??= errorOf(error);
    }
    this.engine = null;
    this.module = null;
  }

  /**
   * The engine reads the bytes up to a refused graphics query's terminator, then the refusal is sent, then the engine reads on, so
   * the refusal comes before what the engine answers to bytes written after the query (a program that asks for graphics and then
   * for its terminal's attributes reads the refusal first). Every byte reaches the engine as when no query splits the write: an
   * error the refusal's handler or a piece throws is thrown once the rest is written, the first of them, and a trap ends it at once.
   */
  write: Emulator["write"] = (bytes) => this.call((engine) => {
    const errors: unknown[] = [];
    const step = (run: () => void): void => {
      try {
        run();
      } catch (error) {
        if (error instanceof WebAssembly.RuntimeError || this.module?.trap) throw error;
        errors.push(error);
      }
    };
    let from = 0;
    for (const { end, reply } of this.graphics.feed(bytes)) {
      step(() => engine.write(bytes.subarray(from, end)));
      from = end;
      step(() => {
        if (!this.disposed) this.events.onReply?.(reply);
      });
    }
    if (from < bytes.length) step(() => engine.write(bytes.subarray(from)));
    if (errors.length > 0) throw errors[0];
  });

  resize: Emulator["resize"] = (cols, rows, cellW, cellH) =>
    this.call((engine) => engine.resize(cols, rows, cellW, cellH), () => badSize(cols, rows) ?? badCell(cellW, cellH));

  reset: Emulator["reset"] = () => this.call((engine) => {
    engine.reset();
    this.graphics.reset();
  });
  frame: Emulator["frame"] = (draw) => this.call((engine) => engine.frame(this.live(draw), "written"));
  frameAll: Emulator["frameAll"] = (draw) => this.call((engine) => engine.frameAll(this.live(draw), "written"));
  cursorState: Emulator["cursorState"] = () => this.call((engine) => engine.cursorState());
  modes: Emulator["modes"] = () => this.call((engine) => engine.modes());
  setMode: Emulator["setMode"] = (mode, on) => this.call((engine) => engine.setMode(mode, on));
  releaseHold: Emulator["releaseHold"] = () => this.call((engine) => engine.releaseHold());
  setColors: Emulator["setColors"] = (colors) => this.call((engine) => engine.setColors(colors));
  encodeKey: Emulator["encodeKey"] = (key) => this.call((engine) => engine.encodeKey(key));
  encodeMouse: Emulator["encodeMouse"] = (mouse) => this.call((engine) => engine.encodeMouse(mouse));
  encodePaste: Emulator["encodePaste"] = (text) => this.call((engine) => engine.encodePaste(text));
  setScrollback: Emulator["setScrollback"] = (lines) => this.call((engine) => engine.setScrollback(lines));
  scrollFromBottom: Emulator["scrollFromBottom"] = (rows) => this.call((engine) => engine.scrollFromBottom(rows));
  history: Emulator["history"] = () => this.call((engine) => engine.history());
  rowContinues: Emulator["rowContinues"] = (y) => this.call((engine) => engine.rowContinues(y));
  textOf: Emulator["textOf"] = (range) => this.call((engine) => engine.textOf(range));
  wordAt: Emulator["wordAt"] = (point) => this.call((engine) => engine.wordAt(point));
  lineAt: Emulator["lineAt"] = (point) => this.call((engine) => engine.lineAt(point));
  search: Emulator["search"] = (needle) => this.call((engine) => engine.search(needle));
  searchStep: Emulator["searchStep"] = (toward) => this.call((engine) => engine.searchStep(toward));
}
