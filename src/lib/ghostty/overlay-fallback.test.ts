import { afterAll, expect, spyOn, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { GhosttyVt } from "./vt.ts";
import { attachGhosttyOverlay } from "./overlay.ts";
import { captureForGhostty } from "./capture.ts";
import { screenRows, type ScreenLine } from "../terminalScreen.ts";
import * as pictures from "../terminalImages.ts";
import { attachTerminalWheel } from "../terminalWheel.ts";
import { HerdrSocket } from "../ws.ts";

const stub: any = new Proxy(function () {}, { get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : key === "then" ? undefined : stub), apply: () => stub, set: () => true, construct: () => stub });
let vtCalls = 0;
let failing = new Set(["write"]);
const answers: Record<string, unknown> = { history: { scrollback: 0, total: 3, viewportTop: 0 }, screenCursor: { x: 0, y: 0 } };
const createEngine = GhosttyVt.create.bind(GhosttyVt);
const create = spyOn(GhosttyVt, "create").mockImplementation(async () => new Proxy({}, { get: (_t, key) => key === "then" ? undefined : key === "scrollback" ? 0 : (...args: unknown[]) => {
    vtCalls++;
    if (failing.has(String(key))) throw new Error("trap");
    return key === "frame" ? false : String(key) in answers ? answers[String(key)] : args.length ? undefined : 0;
  } }) as unknown as GhosttyVt);
const fakes = { document: stub, ResizeObserver: stub, requestAnimationFrame: () => 0, getComputedStyle: () => stub, localStorage: { getItem: () => null },
  WheelEvent: { DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 } };
const saved = Object.fromEntries(Object.keys(fakes).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.assign(globalThis, fakes);
afterAll(() => {
  create.mockRestore();
  for (const [key, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

test("a backlog libghostty cannot replay leaves xterm drawing, with its own write", async () => {
  const written: unknown[] = [];
  const write = (data: unknown) => { written.push(data); };
  const term: any = { cols: 80, rows: 24, element: stub, options: { scrollback: 0, fontFamily: "monospace", fontSize: 13, theme: {} }, buffer: stub, write, reset: () => {}, onResize: stub, onRender: stub, onScroll: stub, refresh: () => {} };
  await expect(attachGhosttyOverlay(term, stub, () => ["backlog"])).rejects.toThrow("trap");
  const before = vtCalls;
  term.write("after");
  expect(written).toEqual(["after"]);
  expect(vtCalls).toBe(before);
});

test("a module that fails while the layer is set up leaves xterm drawing, with its own write", async () => {
  failing = new Set(["setColors", "write"]);
  const written: unknown[] = [];
  const write = (data: unknown) => { written.push(data); };
  const term: any = { cols: 80, rows: 24, element: stub, options: { scrollback: 0, fontFamily: "monospace", fontSize: 13, theme: {} }, buffer: stub, write, reset: () => {}, onResize: stub, onRender: stub, onScroll: stub, refresh: () => {} };
  await expect(attachGhosttyOverlay(term, stub, () => ["backlog"])).rejects.toThrow("trap");
  term.write("after");
  expect(written).toEqual(["after"]);
});

test("a screen read libghostty fails gives the reads back to xterm, which answers that one too", async () => {
  failing = new Set(["rowText"]);
  const xtermLine = (y: number): ScreenLine => ({ isWrapped: false, length: 80, getCell: () => undefined, translateToString: () => `xterm row ${y}` });
  const xtermRows = { length: 3, baseY: 0, viewportY: 0, cursorX: 0, cursorY: 0, getLine: xtermLine, getNullCell: () => stub };
  const term: any = { cols: 80, rows: 24, element: stub, options: { scrollback: 0, fontFamily: "monospace", fontSize: 13, theme: {} }, buffer: { active: xtermRows }, write: () => {}, reset: () => {}, onResize: stub, onRender: stub, onScroll: stub, refresh: () => {} };
  const overlay = await attachGhosttyOverlay(term, stub, () => []);
  expect(overlay).not.toBeNull();
  expect(screenRows(term)).not.toBe(xtermRows);
  expect(screenRows(term).getLine(1)?.translateToString()).toBe("xterm row 1");
  expect(screenRows(term)).toBe(xtermRows);
});

const parse = (term: Terminal, data: string): Promise<void> => new Promise((done) => term.write(data, done));
const onlyMode = { questions: [] };

function terminal() {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  Object.defineProperty(term, "element", { value: stub });
  return term;
}

test.each([false, true])("capture sends and acknowledges the crossing frame in parser order (only: %s)", (only) => {
  const term = terminal();
  const socket = new HerdrSocket("ws://localhost");
  const features = spyOn(socket, "featuresListed").mockReturnValue(true);
  const setting = spyOn(localStorage, "getItem").mockReturnValue(only ? "on" : "off");
  const sent: string[] = [];
  let parsed: (() => void) | undefined;
  const write = spyOn(term, "write").mockImplementation((data, callback) => {
    if (typeof data === "string") sent.push(data.slice(-8));
    parsed = callback;
  });
  const release = captureForGhostty(term, socket, stub, () => false);
  try {
    let acknowledged = false;
    term.write("x".repeat(32 * 1024 * 1024 - 2));
    term.write("\x1b[");
    term.write("6n\x1b[5n", () => { acknowledged = true; });
    expect(sent.slice(-2)).toEqual(only ? ["", "\x1b[6n\x1b[5n"] : ["\x1b[", "6n\x1b[5n"]);
    expect(acknowledged).toBe(false);
    parsed?.();
    expect(acknowledged).toBe(true);
  } finally { release(); write.mockRestore(); setting.mockRestore(); features.mockRestore(); term.dispose(); }
});

test.each([true, false])("startup keeps text and CPR out of xterm until the renderer is ready (Ghostty: %s)", async (attached) => {
  const term = terminal();
  const socket = new HerdrSocket("ws://localhost");
  const features = spyOn(socket, "featuresListed").mockReturnValue(true);
  const setting = spyOn(localStorage, "getItem").mockReturnValue("on");
  const loading = Promise.withResolvers<GhosttyVt>();
  const started = Promise.withResolvers<void>();
  create.mockImplementationOnce(() => { started.resolve(); return loading.promise; });
  const replies: string[] = [];
  const answered = Promise.withResolvers<void>();
  term.onData((reply) => { replies.push(reply); answered.resolve(); });
  const release = captureForGhostty(term, socket, stub, () => false);
  try {
    await started.promise;
    await parse(term, "abc\x1b[");
    await parse(term, "6n\r\nlast");
    expect(replies).toEqual([]);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("");
    if (attached) loading.resolve(await createEngine(80, 24));
    else loading.reject(new Error("fixture: module unavailable"));
    await answered.promise;
    await parse(term, "");
    expect(replies).toEqual(["\x1b[2;5R"]);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe(attached ? "" : "abc");
    expect(screenRows(term).getLine(1)?.translateToString(true)).toBe("last");
  } finally {
    release(); setting.mockRestore(); features.mockRestore();
    term.dispose();
  }
});

test("resizing and attaching leave a pending clipboard OSC intact", async () => {
  failing = new Set();
  const term = terminal();
  const copied: string[] = [];
  term.parser.registerOscHandler(52, (payload) => { copied.push(payload); return true; });
  try {
    const first = "\x1b]52;c;YWJj";
    await parse(term, first);
    const overlay = await attachGhosttyOverlay(term, stub, () => [first], onlyMode);
    term.resize(81, 24);
    await parse(term, "ZGVm\x07");
    expect(copied).toEqual(["c;YWJjZGVm"]);
    overlay?.dispose(false);
  } finally { term.dispose(); }
});

test.each([false, true])("fallback keeps previously copied text out of xterm and honors reset (reset: %s)", async (reset) => {
  failing = new Set();
  const term = terminal();
  const copied: string[] = [];
  term.parser.registerOscHandler(52, (payload) => { copied.push(payload); return true; });
  try {
    const overlay = await attachGhosttyOverlay(term, stub, () => [], onlyMode);
    if (reset) {
      await parse(term, "erased output");
      term.reset();
    }
    await parse(term, "present \x1b]52;c;YWJj\x07output");
    overlay?.dispose();
    await parse(term, "");
    if (reset) expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("present output");
    else expect(copied).toEqual(["c;YWJj"]);
  } finally { term.dispose(); }
});

test("a wheel that pans the mirror grid does not scroll Ghostty history too", async () => {
  failing = new Set();
  const term = new Terminal({ cols: 80, rows: 24, scrollback: 100 });
  const host = Object.assign(new EventTarget(), { dataset: {} });
  Object.defineProperty(term, "element", { value: {
    querySelector: () => ({ append: () => {}, getBoundingClientRect: () => ({ width: 640, height: 384 }) }),
    dispatchEvent: host.dispatchEvent.bind(host),
  } });
  const custom = spyOn(term, "attachCustomWheelEventHandler");
  attachTerminalWheel(term, { current: { speed: 1, omoQuestion: false } }, {
    drag: () => false, adopted: () => true, mirrored: () => true, pan: () => true, scroll: () => {},
  });
  try {
    const overlay = await attachGhosttyOverlay(term, host as unknown as HTMLElement, () => [], onlyMode);
    const scroll = spyOn(term, "scrollLines");
    const wheel = Object.assign(new Event("wheel"), { deltaY: -1, deltaMode: 1 }) as WheelEvent;
    custom.mock.calls[0]?.[0](wheel);
    host.dispatchEvent(wheel);
    expect(scroll).not.toHaveBeenCalled();
    overlay?.dispose(false);
  } finally {
    custom.mockRestore();
    term.dispose();
  }
});

test("fallback sends a query still behind an image without repeating a query already sent", async () => {
  failing = new Set();
  const term = terminal();
  const limits = spyOn(pictures, "terminalPictureLimits").mockReturnValue({ sizeLimit: 1000, pixelLimit: 1000 });
  const replies: string[] = [];
  term.onData((reply) => replies.push(reply));
  try {
    const overlay = await attachGhosttyOverlay(term, stub, () => [], onlyMode);
    const frame = parse(term, "\x1b[5n\x1bPq@\x1b\\after\x1b[6n").then(() => {
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("after");
    });
    overlay?.dispose();
    await frame;
    await parse(term, "");
    expect(replies).toEqual(["\x1b[0n", "\x1b[1;6R"]);
  } finally { limits.mockRestore(); term.dispose(); }
});

test.each(["", "5", "52;c;YWJj"])("overlay forwards the partial clipboard introducer in its owning frame (%j)", async (partial) => {
  failing = new Set();
  const term = terminal();
  const write = spyOn(term, "write");
  try {
    const overlay = await attachGhosttyOverlay(term, stub, () => [], onlyMode);
    await parse(term, "\x1b]" + partial);
    expect(write.mock.calls.map(([data]) => data).join("").endsWith("\x1b]" + partial)).toBe(true);
    overlay?.dispose(false);
  } finally { write.mockRestore(); term.dispose(); }
});

test("fallback silences an unfinished past clipboard write without exposing its suffix as text", async () => {
  failing = new Set();
  const term = terminal();
  const copied: string[] = [];
  term.parser.registerOscHandler(52, (payload) => { copied.push(payload); return true; });
  try {
    const overlay = await attachGhosttyOverlay(term, stub, () => [], onlyMode);
    await parse(term, "before\x1b]5");
    overlay?.dispose();
    await parse(term, "2;c;YWJj\x07after");
    expect(copied).toEqual([]);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("beforeafter");
  } finally { term.dispose(); }
});
