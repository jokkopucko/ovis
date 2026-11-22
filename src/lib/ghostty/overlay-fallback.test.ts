import { afterAll, expect, spyOn, test } from "bun:test";
import { GhosttyVt } from "./vt.ts";
import { attachGhosttyOverlay } from "./overlay.ts";

const stub: any = new Proxy(function () {}, { get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : key === "then" ? undefined : stub), apply: () => stub, set: () => true, construct: () => stub });
let vtCalls = 0;
let failing = new Set(["write"]);
const create = spyOn(GhosttyVt, "create").mockImplementation(async () => new Proxy({}, { get: (_t, key) => key === "then" ? undefined : (...args: unknown[]) => {
    vtCalls++;
    if (failing.has(String(key))) throw new Error("trap");
    return key === "frame" ? false : args.length ? undefined : 0;
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
