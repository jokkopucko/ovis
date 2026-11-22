import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import {
  ENGINE_ENUMS,
  ENGINE_FIELDS,
  ENGINE_FUNCTIONS,
  GhosttyEngine,
  GhosttyModule,
  readTypeLayout,
  type EngineEffect,
  type EngineOptions,
  type GhosttyExports,
  type GhosttyRun,
  type WrittenColor,
} from "./engine.ts";

const repo = join(import.meta.dir, "../..");
const wasmPath = join(import.meta.dir, "ghostty-vt.wasm");
/** the file the digest case checks: OVIS_GHOSTTY_WASM points it at another copy */
const checkedWasmPath = process.env.OVIS_GHOSTTY_WASM || wasmPath;

const wasm = await WebAssembly.compile(await Bun.file(wasmPath).arrayBuffer());
const instantiate = (): WebAssembly.Instance => new WebAssembly.Instance(wasm, {});
/** the module the cases share unless one makes its own; the screen itself keeps one module per pane */
const shared = new GhosttyModule(instantiate());

const rowText = (runs: GhosttyRun<unknown>[]): string => runs.flatMap((run) => run.cells.map((cell) => cell.text)).join("").trimEnd();
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const bytesOf = (value: string): Uint8Array => new TextEncoder().encode(value);
/** what a call threw, or null */
const thrown = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
};
const message = (run: () => unknown): string => (thrown(run) as Error | null)?.message ?? "returned";
/** writes `value` and its 0 into the module's memory, as ghostty_type_json() hands its text over */
function placeText(exports: GhosttyExports, value: string): number {
  const bytes = new TextEncoder().encode(`${value}\0`);
  const ptr = exports.ghostty_wasm_alloc(bytes.length);
  new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
  return ptr;
}

/** an engine as the screen makes it, with everything it reports collected */
function screenEngine(cols: number, rows: number, options: Partial<EngineOptions> = {}, module = shared) {
  const replies: string[] = [];
  const holds: boolean[] = [];
  const effects: EngineEffect[] = [];
  const engine = new GhosttyEngine(module, cols, rows, {
    widths: "core",
    images: false,
    events: { onReply: (bytes) => replies.push(text(bytes)), onHold: (held) => holds.push(held), onEffect: (effect) => effects.push(effect) },
    ...options,
  });
  return { engine, replies, holds, effects };
}

/** every row as frameAll draws it, in the colours the program wrote */
function screenRows(engine: GhosttyEngine): Map<number, GhosttyRun<WrittenColor>[]> {
  const rows = new Map<number, GhosttyRun<WrittenColor>[]>();
  engine.frameAll((y, runs) => rows.set(y, runs), "written");
  return rows;
}

describe("shared/ghostty engine", () => {
  it("engine exports", () => {
    const exported = new Map(WebAssembly.Module.exports(wasm).map((entry) => [entry.name, entry.kind]));
    expect(Object.keys(ENGINE_FUNCTIONS).filter((name) => exported.get(name) !== "function")).toEqual([]);
    expect(exported.get("__indirect_function_table")).toBe("table");
    const layout = readTypeLayout(instantiate().exports as unknown as GhosttyExports);
    const unresolved = [
      ...Object.entries(ENGINE_ENUMS).flatMap(([type, names]) =>
        names.filter((name) => layout.types[type]?.values?.[name] === undefined).map((name) => `${type}.${name}`)),
      ...Object.entries(ENGINE_FIELDS).flatMap(([type, names]) =>
        names.filter((name) => layout.types[type]?.fields?.[name] === undefined).map((name) => `${type}.${name}`)),
    ];
    expect(unresolved).toEqual([]);
  });

  it("engine wasm is the build script's expected output", async () => {
    const script = await Bun.file(join(repo, "scripts/ghostty-vt/build.sh")).text();
    const expected = /^# Expected output sha256.*\n#\s+([0-9a-f]{64})$/m.exec(script)?.[1];
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    const actual = new Bun.CryptoHasher("sha256").update(await Bun.file(checkedWasmPath).arrayBuffer()).digest("hex");
    expect(actual).toBe(expected!);
  });

  it("engine draws what was written", () => {
    const engine = new GhosttyEngine(new GhosttyModule(instantiate()), 20, 4, { widths: "xterm", images: false });
    try {
      engine.write(bytesOf("hello"));
      const rows = new Map<number, string>();
      expect(engine.frame((y, runs) => rows.set(y, rowText(runs)))).toBe(true);
      expect(rows.get(0)).toBe("hello");
      expect(engine.cursor()).toEqual({ visible: true, x: 5, y: 0, style: 1 });
    } finally {
      engine.dispose();
    }
  });

  it("engine names a type name the module does not have", () => {
    const exports = new GhosttyModule(instantiate()).exports;
    const layout = structuredClone(readTypeLayout(exports));
    delete layout.types["GhosttyTerminalOption"]!.values!["SCROLLBACK_MAX_LINES"];
    const ptr = placeText(exports, JSON.stringify(layout));
    // a second module from the same text is refused the same way: a layout that lacks a name is never taken as whole
    for (let time = 0; time < 2; time++) {
      expect(() => new GhosttyModule({ ...exports, ghostty_type_json: () => ptr })).toThrow("GhosttyTerminalOption.SCROLLBACK_MAX_LINES");
    }
  });

  it("engine shares one parsed type layout between modules", () => {
    const first = new GhosttyModule(instantiate());
    const second = new GhosttyModule(instantiate());
    const layout = readTypeLayout(first.exports);
    expect(readTypeLayout(second.exports)).toBe(layout);
    expect(second.keys).toBe(first.keys);

    // frozen all the way down: a write through one module throws and the other still reads what the module reported
    const enter = first.keys["ENTER"]!;
    const wideLsb = layout.types["GhosttyCell"]!.bits!["wide"]!.lsb;
    expect(() => { (first.keys as Record<string, number>)["ENTER"] = enter + 1; }).toThrow(TypeError);
    expect(() => { delete layout.types["GhosttyKey"]; }).toThrow(TypeError);
    expect(() => { layout.types["GhosttyCell"]!.bits!["wide"]!.lsb = wideLsb + 1; }).toThrow(TypeError);
    expect(second.keys["ENTER"]).toBe(enter);
    expect(readTypeLayout(second.exports).types["GhosttyCell"]!.bits!["wide"]!.lsb).toBe(wideLsb);

    // a module whose layout text differs gets a layout of its own, and that text too is parsed once for every module made from it
    const exports = instantiate().exports as unknown as GhosttyExports;
    const changed = structuredClone(layout);
    changed.types["RowFiftyFive"] = { size: 55 };
    const json = JSON.stringify(changed);
    const ptr = placeText(exports, json);
    const parse = JSON.parse;
    let parses = 0;
    JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      if (text === json) parses++;
      return parse(text, reviver);
    }) as typeof JSON.parse;
    let others: GhosttyModule[];
    try {
      others = [0, 1, 2].map(() => new GhosttyModule({ ...exports, ghostty_type_json: () => ptr }));
    } finally {
      JSON.parse = parse;
    }
    expect(parses).toBe(1);
    const own = readTypeLayout(others[0]!.exports);
    expect(own).not.toBe(layout);
    expect(own.types["RowFiftyFive"]).toEqual({ size: 55 });
    expect(layout.types["RowFiftyFive"]).toBeUndefined();
    expect(others.every((module) => readTypeLayout(module.exports) === own)).toBe(true);
  });

  it("engine keeps no layout from a text that is not JSON", () => {
    const exports = instantiate().exports as unknown as GhosttyExports;
    const ptr = placeText(exports, '{"types":{"GhosttyKey":');
    for (let time = 0; time < 2; time++) {
      expect(thrown(() => new GhosttyModule({ ...exports, ghostty_type_json: () => ptr }))).toBeInstanceOf(SyntaxError);
    }
  });

  it("engine split feed", () => {
    const stream = bytesOf([
      "\x1b]0;title\x07\x1b[31mred\x1b[0m \x1b[38;5;196mx\x1b[48;2;10;20;30my\x1b[0m\r\n",
      "한글 👨‍👩‍👧 e\u0301\r\n",
      "\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[>1u\x1b[?9001h\x1b[5 q\x1b[42m\x1b[K\x1b[0m\r\n",
      "wrapping text past the edge\x1b[2;2H",
    ].join(""));
    const snapshot = (...chunks: Uint8Array[]): string => {
      const { engine } = screenEngine(20, 6);
      try {
        for (const chunk of chunks) engine.write(chunk);
        return JSON.stringify({ rows: [...screenRows(engine)], cursor: engine.cursorState(), modes: engine.modes() });
      } finally {
        engine.dispose();
      }
    };
    const whole = snapshot(stream);
    for (let cut = 1; cut < stream.length; cut++) expect(snapshot(stream.subarray(0, cut), stream.subarray(cut))).toBe(whole);
    expect(snapshot(...Array.from(stream, (byte) => Uint8Array.of(byte)))).toBe(whole);

    const { engine } = screenEngine(20, 6);
    try {
      engine.write(stream);
      const rows = screenRows(engine);
      const first = rows.get(0)!;
      expect(first.map((run) => [run.x, run.cells.map((cell) => cell.text).join(""), run.fg, run.bg])).toEqual([
        [0, "red", 1, null], [3, " ", null, null], [4, "x", 196, null], [5, "y", 196, [10, 20, 30]], [6, " ".repeat(14), null, null],
      ]);
      const second = rows.get(1)!.flatMap((run) => run.cells);
      expect(second.slice(0, 6)).toEqual([
        { text: "한", wide: true }, { text: "글", wide: true }, { text: " ", wide: false },
        { text: "👨‍👩‍👧", wide: true }, { text: " ", wide: false }, { text: "e\u0301", wide: false },
      ]);
      expect(rows.get(2)).toEqual([{ x: 0, cells: Array(20).fill({ text: " ", wide: false }), fg: null, bg: 2, flags: 0 }]);
      expect(rowText(rows.get(3)!)).toBe("wrapping text past t");
      expect(rowText(rows.get(4)!)).toBe("he edge");
      expect(engine.cursorState()).toEqual({ visible: true, x: 1, y: 1, style: "bar", blinking: true, wideTail: true });
      expect(engine.modes()).toEqual({
        altScreen: false, mouse: "button", mouseFormat: "sgr", bracketedPaste: true, kittyFlags: 1, focusReports: false,
        syncOutput: false, appCursor: false, appKeypad: false, altScroll: true, win32Input: true,
      });
    } finally {
      engine.dispose();
    }
  });

  it("engine replies only through onReply", () => {
    const { engine, replies } = screenEngine(80, 24);
    try {
      engine.write(bytesOf("\x1b[6n"));
      expect(replies).toEqual(["\x1b[1;1R"]);
      engine.write(bytesOf("\x1b[?1000h\x1b[?1006h\x1b[?2004h"));
      expect(text(engine.encodeKey({ key: "A", text: "a", unshifted: "a" }))).toBe("a");
      expect(text(engine.encodeMouse({ action: "press", button: "left", col: 0, row: 0 }))).toBe("\x1b[<0;1;1M");
      expect(text(engine.encodePaste("one\ntwo\nthree"))).toBe("\x1b[200~one\ntwo\nthree\x1b[201~");
      expect(replies).toEqual(["\x1b[1;1R"]);
    } finally {
      engine.dispose();
    }
  });

  it("engine effects", () => {
    const { engine, replies, effects } = screenEngine(20, 4);
    try {
      engine.write(bytesOf("\x07\x1b]52;c;aGVsbG8=\x07\x1b]52;c;?\x07"));
      expect(effects).toEqual([
        { type: "bell" },
        { type: "clipboardWrite", location: "standard", contents: [{ mime: "text/plain", data: bytesOf("hello") }] },
      ]);
      expect(replies).toEqual([]);
    } finally {
      engine.dispose();
    }
  });

  it("engine keeps its state true when the module refuses", () => {
    const { engine, replies } = screenEngine(80, 24);
    const state = (): string => {
      replies.length = 0;
      engine.write(bytesOf("\x1b[18t\x1b]10;?\x07"));
      const rows = [...screenRows(engine)].map(([y, runs]) => `${y}:${rowText(runs)}`);
      const mouse = text(engine.encodeMouse({ action: "press", button: "left", col: 79, row: 23 }));
      return JSON.stringify({ replies: [...replies], modes: engine.modes(), cursor: engine.cursorState(), history: engine.history(), rows, mouse });
    };
    const paletteEntry = (): string => {
      replies.length = 0;
      engine.write(bytesOf("\x1b]4;1;?\x07"));
      return replies.join("");
    };
    try {
      engine.resize(80, 24, 8, 16);
      const entry = paletteEntry();
      // no palette given: the palette stays as it was
      engine.setColors({ foreground: [1, 2, 3], background: null, cursor: null, palette: [] });
      expect(paletteEntry()).toBe(entry);
      engine.write(bytesOf("hello\r\nworld\x1b[?1000h\x1b[?1006h"));
      const before = state();
      expect(JSON.parse(before)).toMatchObject({ replies: ["\x1b[8;24;80t", "\x1b]10;rgb:0101/0202/0303\x07"], mouse: "\x1b[<0;80;24M" });

      for (const [cols, rows] of [[0, 0], [0, 24], [80, 0]] as const) {
        expect(message(() => engine.resize(cols, rows, 8, 16))).toBe("ghostty-vt: resize failed (-2)");
        expect(message(() => engine.resize(cols, rows, 8, 16))).toBe("ghostty-vt: resize failed (-2)");
        expect(state()).toBe(before);
      }
      expect(message(() => engine.setMode(65535, true))).toBe("ghostty-vt: mode 65535 failed (-2)");
      expect(state()).toBe(before);
      const palette = Array.from({ length: 256 }, () => [9, 9, 9] as const);
      expect(message(() => engine.setColors({ foreground: [9, 9, 9], background: null, cursor: null, palette: [...palette, [9, 9, 9]] })))
        .toBe("ghostty-vt: a palette of 257 colours, not 256 or none");
      expect(message(() => engine.setColors({ foreground: [9, 9, 9], background: [256, 0, 0], cursor: null, palette }))).toBe("ghostty-vt: a colour outside 0-255");
      expect(message(() => engine.setColors({ foreground: [9, 9, 9], background: null, cursor: [1.5, 0, 0], palette }))).toBe("ghostty-vt: a colour outside 0-255");
      expect(state()).toBe(before);
      // accepted, not refused: the module reads -1 as no line limit, and a scroll past either end stops there
      engine.setScrollback(-1);
      engine.scrollFromBottom(1e9);
      engine.scrollFromBottom(-5);
      expect(state()).toBe(before);

      // a draw that throws: the next frame draws the rows it did not take
      engine.write(bytesOf("\x1b[3;1Hthird"));
      expect(message(() => engine.frame(() => { throw new Error("draw failed"); }, "written"))).toBe("draw failed");
      const drawn = new Map<number, string>();
      engine.frame((y, runs) => drawn.set(y, rowText(runs)), "written");
      expect(drawn.get(2)).toBe("third");
    } finally {
      engine.dispose();
    }

    // a screen's engine refused at construction leaves the module as it was
    expect(message(() => new GhosttyEngine(shared, 0, 0, { widths: "core", images: false, events: {} }))).toBe("ghostty-vt: terminal_new failed (-2)");
    expect(message(() => new GhosttyEngine(shared, 0, 0, { widths: "core", images: false, events: {} }))).toBe("ghostty-vt: terminal_new failed (-2)");
    expect(shared.trap).toBeNull();

    // a disposed screen's engine refuses, a second dispose frees nothing, and the module's other engines go on
    const counted = instantiate().exports as unknown as GhosttyExports;
    let terminalsFreed = 0;
    const counting = new GhosttyModule({ ...counted, ghostty_terminal_free: (terminal: number) => { terminalsFreed++; counted.ghostty_terminal_free(terminal); } });
    const gone = screenEngine(20, 4, {}, counting);
    const other = screenEngine(20, 4, {}, counting);
    gone.engine.dispose();
    expect(message(() => gone.engine.write(bytesOf("x")))).toBe("ghostty-vt: the engine was disposed");
    expect(message(() => gone.engine.dispose())).toBe("returned");
    expect(terminalsFreed).toBe(1);

    // a screen's engine refused half made frees what it made and drops its route; one that traps half made
    // marks its module and drops its route
    const halfway = instantiate().exports as unknown as GhosttyExports;
    const userdataOption = new GhosttyModule({ ...halfway }).enums.GhosttyTerminalOption.USERDATA;
    const handles: number[] = [], handlesFreed: number[] = [], blocks: string[] = [], blocksFreed: string[] = [];
    const freeing = (free: (handle: number) => void) => (handle: number) => { handlesFreed.push(handle); free(handle); };
    const refusing = new GhosttyModule({
      ...halfway,
      ghostty_terminal_set: (terminal: number, option: number, value: number) => (option === userdataOption ? -2 : halfway.ghostty_terminal_set(terminal, option, value)),
      ghostty_wasm_take_opaque: (slot: number) => { const handle = halfway.ghostty_wasm_take_opaque(slot); handles.push(handle); return handle; },
      ghostty_wasm_alloc: (len: number) => { const ptr = halfway.ghostty_wasm_alloc(len); blocks.push(`${ptr}+${len}`); return ptr; },
      ghostty_wasm_free: (ptr: number, len: number) => { blocksFreed.push(`${ptr}+${len}`); halfway.ghostty_wasm_free(ptr, len); },
      ghostty_terminal_free: freeing(halfway.ghostty_terminal_free),
      ghostty_render_state_free: freeing(halfway.ghostty_render_state_free),
      ghostty_render_state_row_iterator_free: freeing(halfway.ghostty_render_state_row_iterator_free),
      ghostty_render_state_row_cells_free: freeing(halfway.ghostty_render_state_row_cells_free),
      ghostty_render_state_image_iterator_free: freeing(halfway.ghostty_render_state_image_iterator_free),
    });
    expect(message(() => new GhosttyEngine(refusing, 20, 4, { widths: "core", images: false, events: {} }))).toBe("ghostty-vt: userdata failed (-2)");
    // the terminal, the render state and its three iterators
    expect(handles).toHaveLength(5);
    expect([...handlesFreed].sort((a, b) => a - b)).toEqual([...handles].sort((a, b) => a - b));
    expect(blocks).not.toEqual([]);
    expect(blocksFreed).toEqual(blocks);
    expect(refusing["targets"].size).toBe(0);
    expect(refusing.trap).toBeNull();
    const trapping = new GhosttyModule({ ...(instantiate().exports as unknown as GhosttyExports), ghostty_terminal_new: () => { throw new WebAssembly.RuntimeError("unreachable"); } });
    expect(thrown(() => new GhosttyEngine(trapping, 20, 4, { widths: "core", images: false, events: {} }))).toBe(trapping.trap!);
    expect(trapping.trap).toBeInstanceOf(WebAssembly.RuntimeError);
    const late = instantiate().exports as unknown as GhosttyExports;
    const trappingLate = new GhosttyModule({
      ...late,
      ghostty_terminal_set: (terminal: number, option: number, value: number) => {
        if (option === userdataOption) throw new WebAssembly.RuntimeError("unreachable");
        return late.ghostty_terminal_set(terminal, option, value);
      },
    });
    expect(thrown(() => new GhosttyEngine(trappingLate, 20, 4, { widths: "core", images: false, events: {} }))).toBe(trappingLate.trap!);
    expect(trappingLate.trap).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(trappingLate["targets"].size).toBe(0);
    other.engine.write(bytesOf("\x1b[6n"));
    expect(other.replies).toEqual(["\x1b[1;1R"]);
    other.engine.dispose();

    // the module has no room: a screen's engine refuses and keeps what it had
    const exports = instantiate().exports as unknown as GhosttyExports;
    const freed: number[] = [];
    const tight = screenEngine(20, 4, {}, new GhosttyModule({
      ...exports,
      ghostty_wasm_alloc: (len: number) => (len > 1 << 20 ? 0 : exports.ghostty_wasm_alloc(len)),
      ghostty_wasm_free: (ptr: number, len: number) => { freed.push(len); exports.ghostty_wasm_free(ptr, len); },
    }));
    const big = "x".repeat(2 << 20);
    tight.engine.write(bytesOf("hello"));
    expect(message(() => tight.engine.write(bytesOf(big)))).toBe(`ghostty-vt: no memory for a write (${2 << 20} bytes)`);
    // the input buffer the engine has (64 kB) is still its own
    expect(freed).not.toContain(64 * 1024);
    expect(message(() => tight.engine.encodePaste(big))).toBe(`ghostty-vt: no memory for a paste (${2 << 20} bytes)`);
    expect(message(() => tight.engine.search(big))).toBe(`ghostty-vt: no memory for a search needle (${2 << 20} bytes)`);
    tight.engine.write(bytesOf(" ok\x1b[6n"));
    expect(rowText(screenRows(tight.engine).get(0)!)).toBe("hello ok");
    expect(tight.replies).toEqual(["\x1b[1;9R"]);
    tight.engine.dispose();

    // every other buffer a screen's engine takes is refused the same way
    const roomy = instantiate().exports as unknown as GhosttyExports;
    let refuse = (_len: number): boolean => true;
    const picky = new GhosttyModule({ ...roomy, ghostty_wasm_alloc: (len: number) => (refuse(len) ? 0 : roomy.ghostty_wasm_alloc(len)) });
    expect(message(() => new GhosttyEngine(picky, 20, 4, { widths: "core", images: false, events: {} }))).toStartWith("ghostty-vt: no memory for the engine's scratch block");
    refuse = () => false;
    const choosy = screenEngine(40, 4, {}, picky);
    const longGrapheme = `e${"\u0301".repeat(70)}`;
    choosy.engine.write(bytesOf(`${longGrapheme}\r\nneedle needle\x1b[?2004h`));
    refuse = () => true;
    expect(message(() => choosy.engine.frameAll(() => {}))).toStartWith("ghostty-vt: no memory for a grapheme");
    const pasted = "p".repeat(200);
    refuse = (len) => len > pasted.length;
    expect(message(() => choosy.engine.encodePaste(pasted))).toStartWith("ghostty-vt: no memory for an encoded input");
    const needle = "needle";
    refuse = (len) => len !== needle.length;
    expect(message(() => choosy.engine.search(needle))).toStartWith("ghostty-vt: no memory for the search matches");
    refuse = () => false;
    // the module keeps fewer marks than were written
    expect(rowText(screenRows(choosy.engine).get(0)!)).toStartWith("e\u0301\u0301");
    expect(choosy.engine.search(needle)).toHaveLength(2);
    expect(text(choosy.engine.encodePaste(pasted))).toBe(`\x1b[200~${pasted}\x1b[201~`);
    choosy.engine.dispose();

    // a callback that threw during a call the module refused: the call's own error is reported, and only once
    const quiet = instantiate().exports as unknown as GhosttyExports;
    const query = quiet.ghostty_wasm_alloc(4);
    new Uint8Array(quiet.memory.buffer, query, 4).set(bytesOf("\x1b[6n"));
    const answering = new GhosttyModule({ ...quiet, ghostty_terminal_resize: (terminal: number) => { quiet.ghostty_terminal_vt_write(terminal, query, 4); return -2; } });
    const loud = new GhosttyEngine(answering, 20, 4, { widths: "core", images: false, events: { onReply: () => { throw new Error("reply handler failed"); } } });
    expect(message(() => loud.resize(30, 5, 8, 16))).toBe("ghostty-vt: resize failed (-2)");
    expect(message(() => loud.modes())).toBe("returned");
    loud.dispose();

    // the frame a hold begins with could not be captured: reported after the module returns, the hold still on
    const plain = instantiate().exports as unknown as GhosttyExports;
    let refuseCapture = false;
    const capturing = new GhosttyModule({ ...plain, ghostty_render_state_update: (state: number, terminal: number) => (refuseCapture ? -1 : plain.ghostty_render_state_update(state, terminal)) });
    const held = screenEngine(20, 3, {}, capturing);
    held.engine.write(bytesOf("A"));
    refuseCapture = true;
    expect(message(() => held.engine.write(bytesOf("\x1b[?2026hB")))).toBe("ghostty-vt: render_state_update failed (-1)");
    refuseCapture = false;
    expect(held.holds).toEqual([true]);
    expect(held.engine.modes().syncOutput).toBe(true);
    held.engine.releaseHold();
    expect(held.holds).toEqual([true, false]);
    expect(rowText(screenRows(held.engine).get(0)!)).toBe("AB");
    expect(capturing.trap).toBeNull();
    held.engine.dispose();
  });

  it("engine key table", () => {
    const table: [setup: string, key: Parameters<GhosttyEngine["encodeKey"]>[0], bytes: string][] = [
      ["", { key: "C", mods: { ctrl: true }, text: "c", unshifted: "c" }, "\x03"],
      ["", { key: "A", mods: { alt: true }, text: "a", unshifted: "a" }, "\x1ba"],
      ["", { key: "TAB", mods: { shift: true } }, "\x1b[Z"],
      ["", { key: "TAB", text: "\t" }, "\t"],
      ["", { key: "ENTER", text: "\r" }, "\r"],
      ["", { key: "I", mods: { ctrl: true }, text: "i", unshifted: "i" }, "\t"],
      ["", { key: "M", mods: { ctrl: true }, text: "m", unshifted: "m" }, "\r"],
      ["", { key: "A", mods: { ctrl: true, shift: true }, text: "A", unshifted: "a" }, "\x01"],
      ["", { key: "A", text: "한" }, "한"],
      ["", { key: "ARROW_UP" }, "\x1b[A"],
      ["", { key: "BACKSPACE" }, "\x7f"],
      ["", { key: "ESCAPE" }, "\x1b"],
      ["", { key: "SHIFT_LEFT", mods: { shift: true } }, ""],
      ["", { key: "A", text: "a", unshifted: "a", action: "release" }, ""],
      ["\x1b[?1h", { key: "ARROW_UP" }, "\x1bOA"],
      ["\x1b[>1u", { key: "A", mods: { ctrl: true, shift: true }, text: "A", unshifted: "a" }, "\x1b[97;6u"],
      ["\x1b[>1u", { key: "I", mods: { ctrl: true }, text: "i", unshifted: "i" }, "\x1b[105;5u"],
      ["\x1b[>1u", { key: "ESCAPE" }, "\x1b[27u"],
      ["\x1b[>4;2m", { key: "I", mods: { ctrl: true }, text: "i", unshifted: "i" }, "\x1b[27;5;105~"],
    ];
    const rows = table.map(([setup, key]) => {
      const { engine } = screenEngine(80, 24);
      try {
        engine.write(bytesOf(setup));
        return [setup, key, text(engine.encodeKey(key))];
      } finally {
        engine.dispose();
      }
    });
    expect(rows).toEqual(table);
  });

  it("engine mouse follows the program", () => {
    const { engine, replies } = screenEngine(80, 24);
    try {
      expect(text(engine.encodeMouse({ action: "press", button: "left", col: 3, row: 2 }))).toBe("");
      engine.write(bytesOf("\x1b[?1002h\x1b[?1006h"));
      expect(engine.modes()).toMatchObject({ mouse: "button", mouseFormat: "sgr" });
      expect(text(engine.encodeMouse({ action: "press", button: "left", col: 3, row: 2 }))).toBe("\x1b[<0;4;3M");
      expect(text(engine.encodeMouse({ action: "motion", button: "left", col: 5, row: 2 }))).toBe("\x1b[<32;6;3M");
      expect(text(engine.encodeMouse({ action: "release", button: "left", col: 5, row: 2 }))).toBe("\x1b[<0;6;3m");
      expect(text(engine.encodeMouse({ action: "motion", col: 7, row: 2 }))).toBe("");
      expect(text(engine.encodeMouse({ action: "press", button: "wheelUp", mods: { ctrl: true }, col: 0, row: 0 }))).toBe("\x1b[<80;1;1M");
      engine.write(bytesOf("\x1b[?1002l\x1b[?1006l"));
      expect(engine.modes()).toMatchObject({ mouse: "none", mouseFormat: "x10" });
      expect(text(engine.encodeMouse({ action: "press", button: "left", col: 3, row: 2 }))).toBe("");
      expect(replies).toEqual([]);
    } finally {
      engine.dispose();
    }
  });

  it("engine paste", () => {
    const { engine } = screenEngine(80, 24);
    try {
      expect(text(engine.encodePaste("one\ntwo\n\nthree"))).toBe("one\rtwo\r\rthree");
      engine.write(bytesOf("\x1b[?2004h"));
      expect(text(engine.encodePaste("a\x1b[201~b"))).toBe("\x1b[200~a [201~b\x1b[201~");
      expect(text(engine.encodePaste("one\ntwo\nthree"))).toBe("\x1b[200~one\ntwo\nthree\x1b[201~");
      expect(text(engine.encodePaste(""))).toBe("\x1b[200~\x1b[201~");
    } finally {
      engine.dispose();
    }
  });

  it("engine hold", () => {
    const { engine, holds } = screenEngine(20, 3);
    const firstRow = (): string => rowText(screenRows(engine).get(0)!);
    try {
      engine.write(bytesOf("A"));
      expect(firstRow()).toBe("A");
      engine.write(bytesOf("B\x1b[?2026hC"));
      expect(holds).toEqual([true]);
      expect(firstRow()).toBe("AB");
      engine.write(bytesOf("\x1b[?2026h"));
      expect(holds).toEqual([true]);
      expect(engine.frame(() => {})).toBe(false);
      engine.write(bytesOf("\x1b[?2026l"));
      expect(holds).toEqual([true, false]);
      expect(firstRow()).toBe("ABC");
      engine.write(bytesOf("\x1b[?2026hD"));
      expect(firstRow()).toBe("ABC");
      expect(engine.modes().syncOutput).toBe(true);
      engine.releaseHold();
      expect(holds).toEqual([true, false, true, false]);
      expect(engine.modes().syncOutput).toBe(false);
      expect(firstRow()).toBe("ABCD");
      engine.write(bytesOf("\x1b[?2026l"));
      engine.releaseHold();
      expect(holds).toEqual([true, false, true, false]);
    } finally {
      engine.dispose();
    }
  });

  it("engine core widths", () => {
    const family = bytesOf("ABC👨‍👩‍👧XYZ");
    const cursorAfter = (widths: EngineOptions["widths"]): number[] => {
      const { engine } = screenEngine(40, 2, { widths });
      try {
        engine.write(family);
        engine.frame(() => {});
        const before = engine.cursorState().x;
        engine.reset();
        engine.write(family);
        engine.frame(() => {});
        return [before, engine.cursorState().x];
      } finally {
        engine.dispose();
      }
    };
    expect(cursorAfter("core")).toEqual([8, 8]);
    expect(cursorAfter("xterm")).toEqual([12, 12]);
  });

  it("engine same-size resize", () => {
    const { engine, replies } = screenEngine(80, 24);
    try {
      engine.resize(80, 24, 8, 16);
      engine.write(bytesOf("\x1b[?2048h"));
      expect(replies).toEqual(["\x1b[48;24;80;384;640t"]);
      engine.resize(80, 24, 8, 16);
      engine.resize(80, 24, 8.2, 15.8);
      expect(replies).toEqual(["\x1b[48;24;80;384;640t"]);
      // a refused resize is not remembered: asked again, it reaches the module and is refused again
      expect(message(() => engine.resize(0, 0, 8, 16))).toBe("ghostty-vt: resize failed (-2)");
      expect(message(() => engine.resize(0, 0, 8, 16))).toBe("ghostty-vt: resize failed (-2)");
      engine.write(bytesOf("\x1b[18t"));
      expect(replies).toEqual(["\x1b[48;24;80;384;640t", "\x1b[8;24;80t"]);
      engine.resize(100, 30, 8, 16);
      expect(replies).toEqual(["\x1b[48;24;80;384;640t", "\x1b[8;24;80t", "\x1b[48;30;100;480;800t"]);
    } finally {
      engine.dispose();
    }
  });

  it("engine images off", () => {
    const query = bytesOf("\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\");
    const off = screenEngine(20, 4);
    const on = screenEngine(20, 4, { images: 1024n * 1024n });
    try {
      off.engine.write(query);
      on.engine.write(query);
      expect(off.replies).toEqual([]);
      expect(on.replies).toEqual(["\x1b_Gi=31;OK\x1b\\"]);
    } finally {
      off.engine.dispose();
      on.engine.dispose();
    }
  });

  it("engine 9001", () => {
    const { engine } = screenEngine(20, 4);
    try {
      expect(engine.modes().win32Input).toBe(false);
      engine.write(bytesOf("\x1b[?90"));
      engine.write(bytesOf("01h"));
      expect(engine.modes().win32Input).toBe(true);
      engine.write(bytesOf("\x1b[?9001l"));
      expect(engine.modes().win32Input).toBe(false);
      engine.write(bytesOf("\x1b[?1;9001h"));
      expect(engine.modes().win32Input).toBe(true);
      engine.write(bytesOf("\x1b[?9001;1"));
      engine.write(bytesOf("l"));
      expect(engine.modes().win32Input).toBe(false);
      engine.write(bytesOf("\x1b[?9001h\x1bc"));
      expect(engine.modes().win32Input).toBe(false);
      engine.write(bytesOf("\x1b[9001h\x1b[?19001h"));
      expect(engine.modes().win32Input).toBe(false);
      // inside a CSI that is not private, and a ? printed after one
      engine.write(bytesOf("\x1b[1;9001h\x1b[1m?9001h"));
      expect(engine.modes().win32Input).toBe(false);
    } finally {
      engine.dispose();
    }
    const browsers = new GhosttyEngine(shared, 20, 4, { widths: "xterm", images: false });
    try {
      browsers.write(bytesOf("\x1b[?9001h"));
      expect(browsers.modes().win32Input).toBe(false);
    } finally {
      browsers.dispose();
    }
  });

  it("rowContinues distinguishes soft wraps, hard breaks and absent kept rows", () => {
    const { engine } = screenEngine(8, 2, { scrollbackLines: 1000 });
    try {
      engine.write(bytesOf("0123456789\r\n01234567\r\n89"));
      expect(engine.rowContinues(-1)).toBeNull();
      expect(engine.rowContinues(0)).toBe(false);
      expect(engine.rowContinues(1)).toBe(true);
      expect(engine.rowContinues(2)).toBe(false);
      expect(engine.rowContinues(3)).toBe(false);
      expect(engine.rowContinues(4)).toBeNull();
    } finally {
      engine.dispose();
    }
  });

  it("engine history", () => {
    const { engine } = screenEngine(80, 6, { scrollbackLines: 1000 });
    try {
      engine.write(bytesOf(Array.from({ length: 40 }, (_, i) => `line ${String(i).padStart(2, "0")} end`).join("\r\n")));
      expect(engine.history()).toEqual({ scrollback: 34, total: 40, viewportTop: 34 });
      expect(engine.textOf({ start: { x: 0, y: 0 }, end: { x: 79, y: 1 } })).toBe("line 00 end\nline 01 end");
      expect(engine.lineAt({ x: 3, y: 39 })).toEqual({ start: { x: 0, y: 39 }, end: { x: 10, y: 39 } });
      expect(engine.wordAt({ x: 6, y: 7 })).toEqual({ start: { x: 5, y: 7 }, end: { x: 6, y: 7 } });
      expect(engine.wordAt({ x: 70, y: 7 })).toBeNull();
      expect(engine.search("line 07")).toEqual([{ start: { x: 0, y: 7 }, end: { x: 6, y: 7 } }]);
      expect(engine.searchStep("older")).toEqual({ start: { x: 0, y: 7 }, end: { x: 6, y: 7 } });
      const scrolled = engine.history().viewportTop;
      expect(scrolled).toBeLessThanOrEqual(7);
      expect(rowText(screenRows(engine).get(7 - scrolled)!)).toBe("line 07 end");
      expect(engine.search("absent")).toEqual([]);
      expect(engine.searchStep("newer")).toBeNull();
      engine.scrollFromBottom(0);
      expect(engine.history().viewportTop).toBe(34);
    } finally {
      engine.dispose();
    }
    // 6000 lines of 107 columns: past 2000 the kept rows move between about 1623 and 1998 as whole pages are
    // dropped; with the module's byte limit on, about 600 stay whatever the line limit says
    const lines = bytesOf(Array.from({ length: 6000 }, (_, i) => `H${String(i).padStart(5, "0")} ${"x".repeat(100)}\r\n`).join(""));
    const keptRows = (engine: GhosttyEngine): number => {
      try {
        engine.write(lines);
        return engine.history().scrollback;
      } finally {
        engine.dispose();
      }
    };
    const atMostTheLimit = 2000 + 40;
    const kept = keptRows(screenEngine(120, 40, { scrollbackLines: 2000 }).engine);
    expect(kept).toBeGreaterThan(1500);
    expect(kept).toBeLessThanOrEqual(atMostTheLimit);
    const changedLater = screenEngine(120, 40, { scrollbackLines: 500 }).engine;
    changedLater.setScrollback(2000);
    const keptLater = keptRows(changedLater);
    expect(keptLater).toBeGreaterThan(1500);
    expect(keptLater).toBeLessThanOrEqual(atMostTheLimit);
    const browsers = new GhosttyEngine(shared, 120, 40, { widths: "xterm", images: false });
    browsers.setScrollback(2000);
    expect(keptRows(browsers)).toBeLessThan(1000);
  });

  it("engine refuses every call after a trap in its module", () => {
    const exports = instantiate().exports as unknown as GhosttyExports;
    const module = new GhosttyModule({ ...exports, ghostty_terminal_vt_write: () => { throw new WebAssembly.RuntimeError("unreachable"); } });
    const first = screenEngine(20, 4, {}, module);
    const second = screenEngine(20, 4, {}, module);
    const trap = thrown(() => first.engine.write(bytesOf("x")));
    expect(trap).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(module.trap).toBe(trap as WebAssembly.RuntimeError);
    for (const refusal of [
      thrown(() => first.engine.modes()),
      thrown(() => second.engine.encodePaste("x")),
      thrown(() => new GhosttyEngine(module, 20, 4, { widths: "core", images: false })),
    ]) {
      expect(refusal).toBeInstanceOf(Error);
      expect(refusal).not.toBeInstanceOf(WebAssembly.RuntimeError);
      expect((refusal as Error).cause).toBe(trap);
    }

    // the browser's engines record no trap: the module they share stays usable for the page's other terminals
    const trapping = (): never => { throw new WebAssembly.RuntimeError("unreachable"); };
    const browsers = new GhosttyModule({ ...exports, ghostty_terminal_vt_write: trapping, ghostty_terminal_resize: trapping });
    const failing = new GhosttyEngine(browsers, 20, 4, { widths: "xterm", images: false });
    const other = new GhosttyEngine(browsers, 20, 4, { widths: "xterm", images: false });
    expect(thrown(() => failing.write(bytesOf("x")))).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(thrown(() => failing.resize(30, 5, 8, 16))).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(browsers.trap).toBeNull();
    other.setColors({ foreground: [1, 2, 3], background: null, cursor: null, palette: [] });
    expect(other.frame(() => {})).toBe(true);
    failing.dispose();
    other.dispose();

    // a trap inside the frame capture a hold begins with marks the module as well
    const plain = instantiate().exports as unknown as GhosttyExports;
    let trapCapture = false;
    const capturing = new GhosttyModule({
      ...plain,
      ghostty_render_state_update: (state: number, terminal: number) => {
        if (trapCapture) throw new WebAssembly.RuntimeError("unreachable");
        return plain.ghostty_render_state_update(state, terminal);
      },
    });
    const held = screenEngine(20, 3, {}, capturing);
    held.engine.write(bytesOf("A"));
    trapCapture = true;
    const captureTrap = thrown(() => held.engine.write(bytesOf("\x1b[?2026hB")));
    expect(captureTrap).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(capturing.trap).toBe(captureTrap as WebAssembly.RuntimeError);
    expect((thrown(() => held.engine.modes()) as Error).cause).toBe(captureTrap);
  });

  it("engine input buffer order", () => {
    // what the allocator is asked while an engine's writes grow its input buffer
    const calls = (events: EngineOptions["events"]): string[] => {
      const exports = instantiate().exports as unknown as GhosttyExports;
      const seen: string[] = [];
      const module = new GhosttyModule({
        ...exports,
        ghostty_wasm_alloc: (len: number) => { seen.push(`alloc ${len}`); return exports.ghostty_wasm_alloc(len); },
        ghostty_wasm_free: (ptr: number, len: number) => { seen.push(`free ${len}`); exports.ghostty_wasm_free(ptr, len); },
      });
      const engine = new GhosttyEngine(module, 20, 4, { widths: "xterm", images: false, events });
      seen.length = 0;
      for (const size of [100_000, 200_000, 400_000]) engine.write(new Uint8Array(size).fill(0x41));
      const writes = [...seen];
      engine.dispose();
      return writes;
    };
    // the browser's frees the old buffer first, as its loader always had it: the allocator hands that block back, so
    // the page's one memory grows no more than it did
    expect(calls(undefined)).toEqual(["alloc 100000", "free 100000", "alloc 200000", "free 200000", "alloc 400000"]);
    // a screen's takes the new one first, so a refused write keeps the buffer it has
    expect(calls({})).toEqual(["alloc 100000", "alloc 200000", "free 100000", "alloc 400000", "free 200000"]);

    // the module has no room: the browser's engine goes on as its loader always had it (the 1-byte write lands at
    // address 0, below the module's data); the module is thrown away, never disposed into
    const exports = instantiate().exports as unknown as GhosttyExports;
    let room = true;
    const full = new GhosttyModule({ ...exports, ghostty_wasm_alloc: (len: number) => (room ? exports.ghostty_wasm_alloc(len) : 0) });
    const browsers = new GhosttyEngine(full, 20, 4, { widths: "xterm", images: false });
    room = false;
    expect(message(() => browsers.write(bytesOf("A")))).toBe("returned");
  });
});


describe("a screen engine's size, slot and hold", () => {
  it("resizes to the size it has again once the program switched its columns, and skips it while nothing changed the grid", () => {
    const real = instantiate().exports as unknown as GhosttyExports;
    let resizes = 0;
    const counting = new GhosttyModule({ ...real, ghostty_terminal_resize: (...args: Parameters<GhosttyExports["ghostty_terminal_resize"]>) => {
      resizes++;
      return real.ghostty_terminal_resize(...args);
    } });
    const { engine } = screenEngine(80, 24, {}, counting);
    engine.resize(80, 24, 8, 16);
    engine.resize(80, 24, 8, 16);
    // output that leaves the grid as it is changes nothing: a program with mode 2048 gets no second size report
    engine.write(bytesOf("hello\x1b[1mbold\x1b[0m"));
    engine.resize(80, 24, 8, 16);
    expect(resizes).toBe(1);
    // the program switches to 132 columns: the same size must reach the module again
    engine.write(bytesOf("\x1b[?40h\x1b[?3h"));
    engine.resize(80, 24, 8, 16);
    expect(resizes).toBe(2);
    engine.write(bytesOf("\x1b[2JX"));
    let drawn = 0;
    engine.frameAll((_y, runs) => {
      for (const run of runs) drawn = Math.max(drawn, run.x + run.cells.reduce((width, cell) => width + (cell.wide ? 2 : 1), 0));
    });
    expect(drawn).toBe(80);
    engine.dispose();
  });

  it("refuses a handle slot the module had no room for before any call writes through it, and frees its slot whatever comes", () => {
    const real = instantiate().exports as unknown as GhosttyExports;
    let terminals = 0;
    const noSlot = new GhosttyModule({ ...real, ghostty_wasm_alloc_opaque: () => 0, ghostty_terminal_new: (...args: Parameters<GhosttyExports["ghostty_terminal_new"]>) => {
      terminals++;
      return real.ghostty_terminal_new(...args);
    } });
    const low = () => [...new Uint8Array(real.memory.buffer, 0, 16)];
    const before = low();
    expect(message(() => new GhosttyEngine(noSlot, 20, 4, { widths: "core", images: false, events: {} }))).toBe("ghostty-vt: no memory for the engine's handle slot");
    expect({ terminals, low: low() }).toEqual({ terminals: 0, low: before });

    const counted = instantiate().exports as unknown as GhosttyExports;
    let freed = 0;
    let room = true;
    const counting = new GhosttyModule({
      ...counted,
      ghostty_wasm_free_opaque: (slot: number) => {
        freed++;
        counted.ghostty_wasm_free_opaque(slot);
      },
      ghostty_wasm_alloc: (len: number) => (room ? counted.ghostty_wasm_alloc(len) : 0),
    });
    const made = screenEngine(20, 4, {}, counting);
    expect(freed).toBe(1);
    made.engine.dispose();
    room = false;
    expect(message(() => new GhosttyEngine(counting, 20, 4, { widths: "core", images: false, events: {} }))).toStartWith("ghostty-vt: no memory for the engine's scratch block");
    expect(freed).toBe(2);
  });

  it("answers a size report and bounds the mouse by the grid a program switched to, not the size it was given", () => {
    const { engine, replies } = screenEngine(80, 24);
    const click = () => text(engine.encodeMouse({ action: "press", button: "left", col: 100, row: 0 }));
    engine.resize(80, 24, 8, 16);
    engine.write(bytesOf("\x1b[?40h\x1b[?3h\x1b[?1000h\x1b[?1006h\x1b[18t"));
    expect({ replies, click: click() }).toEqual({ replies: ["\x1b[8;24;132t"], click: "\x1b[<0;101;1M" });
    // back to 80 columns: column 101 is off the grid again
    engine.write(bytesOf("\x1b[?3l\x1b[18t"));
    expect({ replies, click: click() }).toEqual({ replies: ["\x1b[8;24;132t", "\x1b[8;24;80t"], click: "" });
    engine.dispose();
  });

  it("begins and ends a hold through setMode(2026) as the program's own bytes would, each reported once", () => {
    const { engine, holds } = screenEngine(20, 2);
    const row = () => rowText(screenRows(engine).get(0)!);
    engine.write(bytesOf("A\x1b[?2026hB"));
    expect({ row: row(), holds }).toEqual({ row: "A", holds: [true] });
    engine.setMode(2026, false);
    expect({ sync: engine.modes().syncOutput, row: row(), holds }).toEqual({ sync: false, row: "AB", holds: [true, false] });
    engine.setMode(2026, false);
    expect(holds).toEqual([true, false]);
    engine.setMode(2026, true);
    engine.write(bytesOf("C"));
    expect({ sync: engine.modes().syncOutput, row: row(), holds }).toEqual({ sync: true, row: "AB", holds: [true, false, true] });
    engine.releaseHold();
    expect({ row: row(), holds }).toEqual({ row: "ABC", holds: [true, false, true, false] });
    engine.dispose();
  });
});
