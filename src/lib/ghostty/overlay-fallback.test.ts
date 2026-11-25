import { afterAll, expect, spyOn, test } from "bun:test";
import { GhosttyVt } from "./vt.ts";
import { attachGhosttyOverlay } from "./overlay.ts";
import { screenRows, type ScreenLine } from "../terminalScreen.ts";

const stub: any = new Proxy(function () {}, { get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : key === "then" ? undefined : stub), apply: () => stub, set: () => true, construct: () => stub });
let vtCalls = 0;
let failing = new Set(["write"]);
const answers: Record<string, unknown> = { history: { scrollback: 0, total: 3, viewportTop: 0 }, screenCursor: { x: 0, y: 0 } };
const create = spyOn(GhosttyVt, "create").mockImplementation(async () => new Proxy({}, { get: (_t, key) => key === "then" ? undefined : key === "scrollback" ? 0 : (...args: unknown[]) => {
    vtCalls++;
    if (failing.has(String(key))) throw new Error("trap");
    return key === "frame" ? false : String(key) in answers ? answers[String(key)] : args.length ? undefined : 0;
  } }) as unknown as GhosttyVt);
const fakes = { document: stub, ResizeObserver: stub, requestAnimationFrame: () => 0, getComputedStyle: () => stub };
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
  const xtermRows = { length: 3, baseY: 0, viewportY: 0, cursorX: 0, cursorY: 0, getLine: xtermLine };
  const term: any = { cols: 80, rows: 24, element: stub, options: { scrollback: 0, fontFamily: "monospace", fontSize: 13, theme: {} }, buffer: { active: xtermRows }, write: () => {}, reset: () => {}, onResize: stub, onRender: stub, onScroll: stub, refresh: () => {} };
  const overlay = await attachGhosttyOverlay(term, stub, () => []);
  expect(overlay).not.toBeNull();
  expect(screenRows(term)).not.toBe(xtermRows);
  expect(screenRows(term).getLine(1)?.translateToString()).toBe("xterm row 1");
  expect(screenRows(term)).toBe(xtermRows);
});
