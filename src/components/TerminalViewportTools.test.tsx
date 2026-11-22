import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Terminal } from "@xterm/xterm";
import type { PaneScrollInfo } from "../../shared/protocol.ts";
import * as machineContext from "../lib/machineContext.tsx";
import * as settingsModule from "../lib/settings.ts";
import { SCROLL_POLL_BUSY_MS } from "../lib/terminalViewport.ts";
import { ViewportIntentGate } from "../lib/viewportIntent.ts";
import { TerminalViewportTools } from "./TerminalViewportTools.tsx";
import ORDERS from "./TerminalViewportTools.orders.json";

const ROWS = 24;
/** a page moves the viewport less one overlap row (pageScrollDistance) */
const PAGE = ROWS - 1;
const metrics = (max: number, offset = 0): PaneScrollInfo => ({ offset_from_bottom: offset, max_offset_from_bottom: max, viewport_rows: ROWS });

// React, the component and its viewport gate are real; herdr's scroll API, the xterm terminal and the DOM are stand-ins.
describe("a page held for a scroll read on stale zero-history metrics", () => {
  const globals = ["document", "getComputedStyle", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"] as const;
  let saved: (PropertyDescriptor | undefined)[] = [];
  let spies: { mockRestore(): void }[] = [];
  let renderer: ReactTestRenderer | null = null;
  /** each metrics read waits for the test to answer it */
  let reads: ((scroll: PaneScrollInfo) => void)[] = [];
  let scrolledTo: number[] = [];
  let applicationPages: number[] = [];
  let output: () => void = () => {};
  const pageScroll: { current: ((direction: -1 | 1) => void) | null } = { current: null };

  beforeEach(async () => {
    jest.useFakeTimers();
    reads = []; scrolledTo = []; applicationPages = []; pageScroll.current = null;
    saved = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
    const listen = { addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
    Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: { visibilityState: "visible", ...listen } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, writable: true, value: () => ({ visibility: "visible" }) });
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: class { observe() {} disconnect() {} } });
    spies = [
      spyOn(machineContext, "useMachineApi").mockReturnValue({
        fetchPaneScroll: () => new Promise<PaneScrollInfo>((resolve) => { reads.push(resolve); }),
        scrollPane: async (_pane: string, offset: number) => { scrolledTo.push(offset); return metrics(273, offset); },
      } as unknown as ReturnType<typeof machineContext.useMachineApi>),
      spyOn(settingsModule, "useSettings").mockReturnValue({
        settings: settingsModule.DEFAULT_SETTINGS, resolvedLanguage: "en",
      } as ReturnType<typeof settingsModule.useSettings>),
    ];
    const disposable = { dispose() {} };
    const terminal = {
      cols: 80, rows: ROWS,
      element: { getClientRects: () => [{}], querySelector: () => null, parentElement: null, dispatchEvent: () => true, ...listen },
      buffer: { active: { viewportY: 0, baseY: 0, getLine: () => undefined } },
      onWriteParsed: (listener: () => void) => { output = listener; return disposable; },
      onScroll: () => disposable, onRender: () => disposable, onResize: () => disposable,
    } as unknown as Terminal;
    await act(async () => {
      renderer = create(createElement(TerminalViewportTools, {
        viewportIntent: new ViewportIntentGate(), terminal, paneId: "w1:p1", pageScroll,
        onApplicationPage: (direction) => { applicationPages.push(direction); },
        enabled: true, interactive: true, search: null, onError: (message) => { throw new Error(message); },
      }));
    });
    // a program owned the screen: no history to scroll; then it quits and hands the screen back to the shell
    await answer(metrics(0));
    await act(async () => { output(); });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = null;
    for (const spy of spies) spy.mockRestore();
    globals.forEach((name, index) => {
      const descriptor = saved[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
    jest.useRealTimers();
  });

  /** Answers the oldest pending read and lets its promise chain (and a scroll write it starts) finish. */
  async function answer(scroll: PaneScrollInfo) {
    const resolve = reads.shift();
    expect(resolve).toBeDefined();
    await act(async () => { resolve!(scroll); for (let turn = 0; turn < 10; turn++) await Promise.resolve(); });
  }
  const advance = (ms: number) => act(async () => { jest.advanceTimersByTime(ms); });
  /** Lets the poll run on for a few seconds, every read answered with the scrolled view of `max` rows of history. */
  async function drain(max = 273) {
    for (let step = 0; step < 20; step++) {
      await advance(250);
      while (reads.length) await answer(metrics(max, scrolledTo.at(-1) ?? 0));
    }
  }

  it("scrolls the shell's history once when the read began in time but returns after the hold", async () => {
    await act(async () => { pageScroll.current!(-1); });
    await advance(0);
    expect(reads).toHaveLength(1);
    // the read began at the press and takes longer than the hold to come back
    await advance(1100);
    await answer(metrics(273));
    expect(scrolledTo).toEqual([PAGE]);
    await drain();
    expect(scrolledTo).toEqual([PAGE]);
    expect(applicationPages).toEqual([]);
  });

  it("does not scroll the history when the read that began in time returns seconds later", async () => {
    await act(async () => { pageScroll.current!(-1); });
    await advance(0);
    expect(reads).toHaveLength(1);
    await advance(3100);
    await answer(metrics(273));
    expect(scrolledTo).toEqual([]);
    await drain();
    expect(scrolledTo).toEqual([]);
    expect(applicationPages).toEqual([]);
  });

  it("sends the page to the program once when the read began in time but returns after the hold", async () => {
    await act(async () => { pageScroll.current!(-1); });
    await advance(0);
    expect(reads).toHaveLength(1);
    // still the program's screen: no history, so the page goes to the program as a key
    await advance(1100);
    await answer(metrics(0));
    expect(applicationPages).toEqual([-1]);
    await drain(0);
    expect(applicationPages).toEqual([-1]);
    expect(scrolledTo).toEqual([]);
  });

  it("sends nothing to the program when the read that began in time returns seconds later", async () => {
    await act(async () => { pageScroll.current!(-1); });
    await advance(0);
    expect(reads).toHaveLength(1);
    await advance(3100);
    await answer(metrics(0));
    expect(applicationPages).toEqual([]);
    await drain(0);
    expect(applicationPages).toEqual([]);
    expect(scrolledTo).toEqual([]);
  });

  it("drops the page when the read that answers it began after the hold expired", async () => {
    await act(async () => { pageScroll.current!(-1); });
    await advance(0);
    expect(reads).toHaveLength(1);
    // output during the read: its metrics are stale, so the page waits for the next read, 1350 ms after the press
    await act(async () => { output(); });
    await advance(1100);
    await answer(metrics(273));
    await advance(250);
    expect(reads).toHaveLength(1);
    await answer(metrics(273));
    await drain();
    expect(scrolledTo).toEqual([]);
    expect(applicationPages).toEqual([]);
  });
});

/** herdr's side as a step may set it: its view, its history, a program's alternate screen */
type HerdrState = { offset?: number; max?: number; alternateScreen?: boolean };
/** where this view wrote, where herdr's view ended, and the page keys the program received as `direction@ms` */
type OrderResult = { end: number; writes: number[]; program: string[] };
type OrderStep = { at: number } & (
  | { do: "read"; fail?: boolean }
  | { do: "wheel"; lines: number }
  | { do: "page"; direction: -1 | 1 }
  | { do: "output" | "resize" | "jumpToBottom" | "unmount" | "writeIfPending" | "writeAllPending" }
  | { do: "herdr"; state: HerdrState }
  | { do: "write"; fail?: boolean; bare?: boolean; moved?: HerdrState }
  | { do: "settle"; from: number; until: number; every: number }
  | { do: "settleSecondWrite"; from: number; until: number; every: number; writesFrom: number });
/** an order of the merge reviews (TerminalViewportTools.orders.json): `main` is main's result before held lines went out
 * with a fresh line; `fix`, this view's where it differs from that, in view movement only */
type Order = {
  id: string; title: string; start: Required<HerdrState>; steps: OrderStep[];
  main: OrderResult; fix?: OrderResult & { note: string };
};

/** herdr's side of the view: every metrics read and scroll write waits until the test answers it, and is answered
 * from herdr's state at that moment (a program on its alternate screen leaves no history: offset and maximum 0) */
function fakeHerdr(max: number) {
  let offset = 0, alternate = false;
  const reads: { resolve: (metrics: PaneScrollInfo) => void; reject: (error: Error) => void }[] = [];
  const writes: { target: number; resolve: (metrics: PaneScrollInfo) => void; reject: (error: Error) => void }[] = [];
  const targets: number[] = [];
  const metrics = (): PaneScrollInfo => alternate
    ? { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 }
    : { offset_from_bottom: offset, max_offset_from_bottom: max, viewport_rows: 24 };
  const set = (state: HerdrState) => { offset = state.offset ?? offset; max = state.max ?? max; alternate = state.alternateScreen ?? alternate; };
  const nextWrite = () => {
    const write = writes.shift();
    if (!write) throw new Error("no scroll write is waiting");
    return write;
  };
  return {
    get offset() { return offset; },
    targets,
    enterAlternateScreen() { alternate = true; },
    /** herdr's state changes without answering anything (output under a held view, a program switching screens) */
    set,
    api: {
      fetchPaneScroll: () => new Promise<PaneScrollInfo>((resolve, reject) => { reads.push({ resolve, reject }); }),
      scrollPane: (_pane: string, target: number) => {
        targets.push(target);
        return new Promise<PaneScrollInfo>((resolve, reject) => { writes.push({ target, resolve, reject }); });
      },
    },
    writing: () => writes.length > 0,
    /** applies the oldest write; `moved`: herdr's state then changes so before the answer (output under a held view);
     * null: the answer carries no metrics */
    answerWrite(moved?: HerdrState | null) {
      const write = nextWrite();
      if (!alternate) offset = Math.max(0, Math.min(max, write.target));
      if (moved) set(moved);
      write.resolve(moved === null ? null as unknown as PaneScrollInfo : metrics());
    },
    failWrite() { nextWrite().reject(new Error("herdr refused the scroll")); },
    answerReads() { for (const read of reads.splice(0)) read.resolve(metrics()); },
    failReads() { for (const read of reads.splice(0)) read.reject(new Error("herdr did not answer")); },
  };
}

describe("history scrolls by every wheel line while the view's own writes are slow, and page keys go where they did", () => {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    for (const key of ["document", "getComputedStyle", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"]) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
    define("getComputedStyle", () => ({ visibility: "visible" }));
    define("ResizeObserver", class { observe() {} disconnect() {} });
    spyOn(settingsModule, "useSettings").mockReturnValue({
      settings: settingsModule.DEFAULT_SETTINGS, resolvedLanguage: "en",
    } as ReturnType<typeof settingsModule.useSettings>);
  });

  afterEach(() => {
    act(() => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  async function mount(herdr: ReturnType<typeof fakeHerdr>) {
    spyOn(machineContext, "useMachineApi").mockReturnValue(herdr.api as unknown as ReturnType<typeof machineContext.useMachineApi>);
    const written: (() => void)[] = [], resized: (() => void)[] = [], wheeled: (() => void)[] = [];
    const listener = () => ({ dispose() {} });
    // the grid and its layer have a size, so the Jump to bottom button is drawn
    const rect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
    const screen = { getBoundingClientRect: () => rect };
    const terminal = {
      element: {
        getClientRects: () => [rect], querySelector: () => screen, parentElement: null, dispatchEvent: () => true,
        addEventListener(type: string, callback: () => void) { if (type === "wheel") wheeled.push(callback); }, removeEventListener() {},
      },
      cols: 80, rows: 24,
      buffer: { active: { viewportY: 0, baseY: 0, getLine: () => undefined } },
      onWriteParsed: (callback: () => void) => { written.push(callback); return { dispose() {} }; },
      onScroll: listener, onRender: listener, onResize: (callback: () => void) => { resized.push(callback); return { dispose() {} }; },
    } as unknown as Terminal;
    const lineScroll: { current: ((lines: number) => void) | null } = { current: null };
    const pageScroll: { current: ((direction: -1 | 1) => void) | null } = { current: null };
    const errors: string[] = [];
    const programPages: number[] = [], programKeys: string[] = [];
    let start = 0;
    await act(async () => {
      renderer = create(createElement(TerminalViewportTools, {
        viewportIntent: new ViewportIntentGate(), terminal, paneId: "w1:p1", lineScroll, pageScroll,
        onApplicationPage: (direction: -1 | 1) => { programPages.push(direction); programKeys.push(`${direction}@${Date.now() - start}`); },
        enabled: true, interactive: true, search: null, onError: (message: string) => { errors.push(message); },
      }), { createNodeMock: () => ({ parentElement: screen }) });
    });
    start = Date.now();
    // a step at the time of the one before moves nothing (a timer of 0 ms has taken the clock 1 ms on)
    const at = (ms: number) => act(async () => { if (start + ms > Date.now()) jest.advanceTimersByTime(start + ms - Date.now()); });
    return {
      errors,
      /** page keys the view handed to the program on its alternate screen */
      programPages,
      /** the same, each as `direction@ms after mounting` */
      programKeys,
      /** moves the clock to `ms` after mounting, running the poll timers due on the way */
      at,
      wheel: (lines: number) => act(async () => { lineScroll.current!(lines); }),
      /** the same through the terminal's wheel event, as the browser sends it: the view also marks a gesture */
      wheelEvent: (lines: number) => act(async () => { for (const callback of wheeled) callback(); lineScroll.current!(lines); }),
      page: (direction: -1 | 1) => act(async () => { pageScroll.current!(direction); }),
      jumpToBottom: () => act(async () => { renderer!.root.findByProps({ "aria-label": "Jump to bottom" }).props.onClick(); }),
      /** a chunk of output parsed, as herdr's repaint of a moved view arrives */
      output: () => act(async () => { for (const callback of written) callback(); }),
      answerWrite: (moved?: HerdrState | null) => act(async () => { herdr.answerWrite(moved); }),
      failWrite: () => act(async () => { herdr.failWrite(); }),
      answerReads: () => act(async () => { herdr.answerReads(); }),
      failReads: () => act(async () => { herdr.failReads(); }),
      /** the grid's size changes (a resize while a write is out) */
      resize: () => act(async () => { for (const callback of resized) callback(); }),
      unmount: () => act(async () => { renderer?.unmount(); renderer = undefined; }),
      /** answers every read and write as they come, through `until` ms after mounting */
      async answerAll(until: number) {
        while (herdr.writing()) await act(async () => { herdr.answerWrite(); });
        for (let ms = Date.now() - start + 100; ms <= until; ms += 100) {
          await at(ms);
          await act(async () => { herdr.answerReads(); });
          while (herdr.writing()) await act(async () => { herdr.answerWrite(); });
        }
      },
    };
  }

  it("applies every wheel line asked while the view's writes outlast the busy cadence, though the wheel keeps reads waiting past the hold", async () => {
    const herdr = fakeHerdr(300);
    const view = await mount(herdr);
    await view.answerReads();
    let asked = 0;
    const wheel = async () => { asked += 3; await view.wheel(3); };
    // Given: a wheel's write in flight, and output (herdr repainting the moved view) since its metrics were read
    await view.at(10);
    await wheel();
    expect(herdr.writing()).toBe(true);
    await view.output();
    await view.at(100);
    await wheel();
    // When: a line more than the busy cadence after the metrics in use began, while that write is still out, and the
    // wheel going on for over a second, each write answered only after the next line, so no read can start in between
    await view.at(10 + SCROLL_POLL_BUSY_MS + 40);
    await wheel();
    for (let ms = 350; ms <= 1500; ms += 50) {
      await view.at(ms);
      await wheel();
      if (herdr.writing()) await view.answerWrite();
      await view.output();
    }
    await view.answerAll(3000);
    // Then: herdr's view moved by every line asked
    expect(herdr.offset).toBe(asked);
    expect(herdr.targets.at(-1)).toBe(asked);
    expect(view.errors).toEqual([]);
  });

  it("holds a line and a page on stale metrics while nothing of the view is in flight, until a read", async () => {
    const herdr = fakeHerdr(300);
    const view = await mount(herdr);
    await view.answerReads();
    // Given: output since the metrics were read, and no write out
    await view.output();
    // When: a line and a page past the busy cadence
    await view.at(10 + SCROLL_POLL_BUSY_MS + 40);
    await view.wheel(3);
    await view.page(-1);
    await view.at(10 + SCROLL_POLL_BUSY_MS + 50);
    // Then: nothing is written before a read answers, and both apply after it
    expect(herdr.targets).toEqual([]);
    await view.answerAll(3000);
    expect(herdr.offset).toBe(herdr.targets[0]! + 3);
    expect(view.programPages).toEqual([]);
  });

  /** a page's write out, then the program entering its alternate screen, then PageUp past the busy cadence */
  async function pageAfterSwitch(herdr: ReturnType<typeof fakeHerdr>) {
    const view = await mount(herdr);
    await view.answerReads();
    await view.at(10);
    await view.page(-1);
    await view.output();
    await view.at(200);
    herdr.enterAlternateScreen();
    await view.output();
    await view.at(300);
    await view.page(-1);
    return view;
  }

  it("gives a page key pressed during a write past the program's switch to its alternate screen to the program after a read", async () => {
    const herdr = fakeHerdr(300);
    const view = await pageAfterSwitch(herdr);
    await view.answerAll(3000);
    expect(herdr.targets).toEqual([herdr.targets[0]!]);
    expect(view.programPages).toEqual([-1]);
  });

  it("drops that page key when the write is answered only after the hold has passed", async () => {
    const herdr = fakeHerdr(300);
    const view = await pageAfterSwitch(herdr);
    await view.at(3000);
    await view.answerAll(6000);
    expect(herdr.targets).toEqual([herdr.targets[0]!]);
    expect(view.programPages).toEqual([]);
  });

  it("gives that page key to the program after a read when the write fails", async () => {
    const herdr = fakeHerdr(300);
    const view = await pageAfterSwitch(herdr);
    await view.at(400);
    await view.failWrite();
    await view.answerAll(3000);
    expect(view.errors).toHaveLength(1);
    expect(view.programPages).toEqual([-1]);
  });

  it("gives that page key to the program after a read though Jump to bottom comes before the write's answer", async () => {
    const herdr = fakeHerdr(300);
    const view = await mount(herdr);
    await view.answerReads();
    await view.at(10);
    await view.page(-1);
    await view.output();
    await view.at(20);
    await view.answerWrite();
    await view.at(30);
    await view.page(-1);
    await view.output();
    await view.at(150);
    herdr.enterAlternateScreen();
    await view.output();
    await view.at(300);
    await view.page(-1);
    await view.at(350);
    await view.jumpToBottom();
    await view.answerAll(3000);
    expect(herdr.targets).toEqual([23, 46, 0]);
    expect(view.programPages).toEqual([-1]);
  });

  it("gives a page key pressed with a wheel line during a write the page path after a read, though the next write would outlast its hold", async () => {
    const herdr = fakeHerdr(300);
    const view = await mount(herdr);
    await view.answerReads();
    // Given: a wheel write out, and output since the metrics were read
    await view.at(10);
    await view.answerReads();
    await view.wheel(3);
    await view.output();
    // When: a wheel line and a PageUp past the busy cadence, the write answered at 400 ms, and nothing herdr is asked
    // after that answered before 1100 ms
    await view.at(10 + SCROLL_POLL_BUSY_MS + 50);
    await view.wheel(3);
    await view.page(-1);
    await view.at(400);
    await view.answerWrite();
    await view.at(1100);
    await view.answerAll(4000);
    // Then: the page and the line both applied, the page first, as on main
    expect(herdr.targets).toEqual([3, 26, 29]);
    expect(herdr.offset).toBe(29);
  });

  it("applies a wheel line asked on stale metrics during a write that fails, after a read", async () => {
    const herdr = fakeHerdr(300);
    const view = await mount(herdr);
    await view.answerReads();
    await view.at(10);
    await view.wheel(3);
    await view.output();
    await view.at(10 + SCROLL_POLL_BUSY_MS + 40);
    await view.wheel(3);
    await view.failWrite();
    await view.answerAll(3000);
    // the failed write's own lines are gone, as on main; the later line applies
    expect(view.errors).toHaveLength(1);
    expect(herdr.offset).toBe(3);
  });

  /** a wheel write out, output, then a wheel line and a PageUp past the busy cadence: both held */
  async function wheelAndPageDuringWrite(herdr: ReturnType<typeof fakeHerdr>) {
    const view = await mount(herdr);
    await view.answerReads();
    await view.at(10);
    await view.answerReads();
    await view.wheel(3);
    await view.output();
    await view.at(10 + SCROLL_POLL_BUSY_MS + 50);
    await view.wheel(3);
    await view.page(-1);
    await view.at(400);
    return view;
  }

  it("applies a line held with a page after the page, from where herdr's view moved before the answer", async () => {
    const herdr = fakeHerdr(300);
    const view = await wheelAndPageDuringWrite(herdr);
    // When: herdr applied the write to 3, and output moved its view to 12 before it answered
    await view.answerWrite({ offset: 12 });
    await view.answerAll(3000);
    // Then: the page from 12, then the held line up: 12 + 23 + 3, never back down
    expect(herdr.targets).toEqual([3, 35, 38]);
    expect(herdr.offset).toBe(38);
  });

  it("applies a line held with a page after the page, though the write's answer carries no metrics", async () => {
    const herdr = fakeHerdr(300);
    const view = await wheelAndPageDuringWrite(herdr);
    // When: herdr applied the write to 3 and answered without metrics
    await view.answerWrite(null);
    await view.answerAll(3000);
    // Then: the first write's lines are not applied again: 3 + 23 + 3
    expect(herdr.offset).toBe(29);
  });

  it("leaves held lines that would pass the top to the read, which knows how far the history has grown, as main", async () => {
    const herdr = fakeHerdr(100);
    herdr.set({ offset: 93 });
    const view = await mount(herdr);
    await view.answerReads();
    // Given: writes up to 99 and 5 lines held on stale metrics, past the top of 100 those metrics know
    await view.at(10); await view.wheelEvent(3); await view.output();
    await view.at(100); await view.wheelEvent(3);
    await view.at(310); await view.wheelEvent(5);
    await view.at(350); await view.answerWrite(); await view.output();
    await view.at(400); await view.answerWrite(); await view.output();
    // When: the history grows to 120, and a line more on fresh metrics
    await view.at(425); herdr.set({ max: 120 }); await view.output();
    await view.at(450); await view.wheelEvent(3);
    await view.at(500); await view.answerWrite(); await view.output();
    await view.answerAll(2500);
    // Then: the read with the grown history applies the held lines: 105, as on main
    expect(herdr.offset).toBe(105);
  });

  it("leaves held lines that would pass the top to the read, so a PageDown in between lands as on main", async () => {
    const herdr = fakeHerdr(100);
    herdr.set({ offset: 91 });
    const view = await mount(herdr);
    await view.answerReads();
    await view.at(10); await view.wheelEvent(3); await view.output();
    await view.at(100); await view.wheelEvent(3);
    await view.at(310); await view.wheelEvent(3);
    await view.at(350); await view.answerWrite(); await view.output();
    await view.at(400); await view.answerWrite(); await view.output();
    await view.at(450); await view.wheelEvent(3); await view.output();
    await view.at(720); await view.page(1);
    await view.at(750); await view.answerWrite();
    await view.answerAll(2500);
    // the top (100), the page down (77), then the held line: 80, as on main
    expect(herdr.offset).toBe(80);
  });

  it("leaves held lines against a later line's direction to the read, so the view first moves the way of that line", async () => {
    const herdr = fakeHerdr(300);
    herdr.set({ offset: 50 });
    const view = await mount(herdr);
    await view.answerReads();
    await view.at(10); await view.wheelEvent(3); await view.output();
    await view.at(100); await view.wheelEvent(3);
    await view.at(310); await view.wheelEvent(3);
    await view.at(320); await view.wheelEvent(3);
    await view.at(350); await view.answerWrite(); await view.output();
    await view.at(400); await view.answerWrite(); await view.output();
    // When: a line down on fresh metrics, with two lines up held
    await view.at(450); await view.wheelEvent(-3);
    await view.at(500); await view.answerWrite();
    // Then: down first (53), and the held lines after the read (59), as on main
    expect(herdr.offset).toBe(53);
    await view.answerAll(1500);
    expect(herdr.offset).toBe(59);
  });

  it("leaves held lines to the read while a write is out, so its failure cannot drop them", async () => {
    const herdr = fakeHerdr(300);
    herdr.set({ offset: 50 });
    const view = await mount(herdr);
    await view.answerReads();
    await view.at(10); await view.wheelEvent(3); await view.output();
    await view.at(100); await view.wheelEvent(3);
    await view.at(310); await view.wheelEvent(3);
    await view.at(350); await view.answerWrite(); await view.output();
    await view.at(400); await view.answerWrite(); await view.output();
    // When: a PageDown's write out, a line on fresh metrics queued behind it, and that write fails
    await view.at(450); await view.page(1);
    await view.at(460); await view.wheelEvent(3);
    await view.at(500); await view.failWrite();
    await view.answerAll(1500);
    // Then: the queued line is gone with the failure, as on main, and the held line still applies after the read
    expect(view.errors).toHaveLength(1);
    expect({ end: herdr.offset, writes: herdr.targets }).toEqual({ end: 59, writes: [53, 56, 33, 59] });
  });

  it("gives a page key to the program when main does, after a wheel whose held lines reached the bottom", async () => {
    const herdr = fakeHerdr(100);
    herdr.set({ offset: 20 });
    const view = await mount(herdr);
    await view.answerReads();
    // Given: a wheel down whose held lines take the view to the bottom (main lost them and stayed at 11)
    await view.at(10); await view.wheelEvent(-3); await view.output();
    await view.at(100); await view.wheelEvent(-3);
    for (const ms of [310, 320, 330, 340]) { await view.at(ms); await view.wheelEvent(-3); }
    await view.at(350); await view.answerWrite(); await view.output();
    await view.at(400); await view.answerWrite(); await view.output();
    await view.at(450); await view.wheelEvent(-3);
    await view.at(900); await view.output();
    await view.at(1400); await view.answerWrite(); await view.output();
    expect(herdr.targets).toEqual([17, 14, 0]);
    // When: the program enters its alternate screen and PageUp is pressed
    await view.at(1650); await view.answerReads();
    await view.at(1700); await view.output();
    await view.at(1800); herdr.enterAlternateScreen(); await view.output();
    await view.at(2000); await view.answerReads();
    await view.at(2050); await view.page(-1);
    // Then: the poll kept main's pace, so the metrics are fresh and the key goes to the program at once, as on main
    expect(view.programKeys).toEqual(["-1@2050"]);
  });

  /** one order of the merge review: herdr's state at mount, then timed steps, each at its ms after mounting */
  async function runOrder(order: Order): Promise<OrderResult> {
    const herdr = fakeHerdr(order.start.max);
    herdr.set(order.start);
    const view = await mount(herdr);
    const answerWrites = async () => { while (herdr.writing()) await view.answerWrite(); };
    for (const step of order.steps) {
      await view.at(step.at);
      switch (step.do) {
        case "read": await (step.fail ? view.failReads() : view.answerReads()); break;
        case "wheel": await view.wheel(step.lines); break;
        case "page": await view.page(step.direction); break;
        case "output": await view.output(); break;
        case "resize": await view.resize(); break;
        case "jumpToBottom": await view.jumpToBottom(); break;
        case "unmount": await view.unmount(); break;
        case "herdr": herdr.set(step.state); break;
        case "write": await (step.fail ? view.failWrite() : view.answerWrite(step.bare ? null : step.moved)); break;
        case "writeIfPending": if (herdr.writing()) await view.answerWrite(); break;
        case "writeAllPending": await answerWrites(); break;
        // every `every` ms: the reads, then the writes, as they come
        case "settle":
          for (let ms = step.from; ms <= step.until; ms += step.every) { await view.at(ms); await view.answerReads(); await answerWrites(); }
          break;
        // the next write takes until `writesFrom`: reads are answered meanwhile, writes from then on
        case "settleSecondWrite":
          for (let ms = step.from; ms <= step.until; ms += step.every) {
            await view.at(ms);
            await view.answerReads();
            if (ms >= step.writesFrom) await answerWrites();
          }
          break;
      }
    }
    return { end: herdr.offset, writes: herdr.targets, program: view.programKeys };
  }

  for (const order of ORDERS as Order[]) {
    const { note, ...fix } = order.fix ?? { note: "", ...order.main };
    it(`${order.id} ${note ? `differs from main in view movement only (${note})` : "as on main"}: ${order.title}`, async () => {
      const result = await runOrder(order);
      // every page key reaches the same receiver at the same time as on main
      expect(result.program).toEqual(order.main.program);
      expect(result).toEqual(fix);
    });
  }
});
