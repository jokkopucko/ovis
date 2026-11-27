import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, createElement, type ComponentProps } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import * as i18n from "../lib/i18n.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { ChatView } from "./ChatView.tsx";
import { loadChatTimeline } from "./chatTimelineLoader.ts";

class Scroller {
  clientHeight = 758;
  clientWidth = 600;
  scrollHeight = 2000;
  top = 0;
  get scrollTop(): number { return this.top; }
  set scrollTop(value: number) { this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
}

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let page: Page;
let scroller: Scroller;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let translationSpy: ReturnType<typeof spyOn<typeof i18n, "useT">>;
const translateEnglish: i18n.Translate = (key, vars) => i18n.translate("en", key, vars);
const observers = new Set<TestResizeObserver>();
const listResize = Symbol.for("ovis.test.legendListResize");
class TestResizeObserver {
  readonly targets = new Set<Element>();
  constructor(readonly callback: (entries: readonly ResizeObserverEntry[]) => void) {}
  observe(target: Element) { this.targets.add(target); observers.add(this); }
  unobserve(target: Element) {
    this.targets.delete(target);
    if (this.targets.size === 0) observers.delete(this);
  }
  disconnect() { this.targets.clear(); observers.delete(this); }
}
const resize = (target: Element, height: number) => {
  const contentRect = new DOMRect(0, 0, 600, height);
  const size = [{ blockSize: height, inlineSize: 600 }];
  const entries = [{ target, contentRect, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size }];
  for (const observer of observers) {
    if (observer.targets.has(target)) observer.callback(entries);
  }
  const notify: unknown = Object.getOwnPropertyDescriptor(target, listResize)?.value;
  if (typeof notify === "function") notify(entries);
};
const box = () => page.one<HTMLDivElement>(".chat-view");
const scroll = () => {
  box().dispatchEvent(new page.window.Event("scroll") as unknown as Event);
  box().dispatchEvent(new page.window.Event("scrollend") as unknown as Event);
};
const jumps = () => page.container.querySelectorAll('[aria-label="Jump to latest"]');
const measure = (height: number) => {
  const row = page.one("[data-chat-row]");
  const targets = new Set([...observers].flatMap((observer) => [...observer.targets]));
  let target = row.parentElement;
  while (target !== null && target !== box() && !targets.has(target) && !Object.hasOwn(target, listResize)) target = target.parentElement;
  if (!target || target === box()) throw new Error("The list did not observe its item");
  resize(target, height);
};

beforeEach(() => {
  page = openPage();
  // Keep the translator stable across renders, even after suites that mock useT.
  translationSpy = spyOn(i18n, "useT").mockReturnValue(translateEnglish);
  scroller = new Scroller();
  const proto = page.window.HTMLElement.prototype;
  const bounds = proto.getBoundingClientRect;
  const query = proto.querySelector;
  const isScroller = (element: HTMLElement) => element.classList.contains("chat-view");
  const px = (dimension: "clientHeight" | "clientWidth" | "scrollHeight") => ({
    configurable: true, get(this: HTMLElement) { return isScroller(this) || (dimension === "scrollHeight" && this.classList.contains("chat-transcript-virtual")) ? scroller[dimension] : 0; },
  });
  const nativeScrollTo = proto.scrollTo;
  Object.defineProperties(proto, {
    scrollTo: { configurable: true, value(this: HTMLElement, options: ScrollToOptions) {
      if (!isScroller(this)) return nativeScrollTo.call(this, options.left ?? this.scrollLeft, options.top ?? this.scrollTop);
      // The fixture supplies browser/list offsets explicitly; only pane paging moves the viewport here.
      if (options.behavior === "instant" && options.top !== undefined) this.scrollTop = options.top;
    } },
    onscrollend: { configurable: true, value: null },
    clientHeight: px("clientHeight"), clientWidth: px("clientWidth"), scrollHeight: px("scrollHeight"),
    scrollTop: { configurable: true, get(this: HTMLElement) { return isScroller(this) ? scroller.scrollTop : 0; }, set(this: HTMLElement, top: number) { if (isScroller(this)) scroller.scrollTop = top; } },
    getBoundingClientRect: { configurable: true, value(this: HTMLElement) {
      return isScroller(this) ? new page.window.DOMRect(0, 0, scroller.clientWidth, scroller.clientHeight) : bounds.call(this);
    } },
    querySelector: { configurable: true, value(this: HTMLElement, selector: string) {
      const escaped = /^\[data-chat-row="(.*)"\]$/.exec(selector)?.[1];
      if (escaped === undefined) return query.call(this, selector);
      const key = escaped.replace(/\\(.)/g, "$1");
      return [...this.querySelectorAll("[data-chat-row]")].find((node) => node.getAttribute("data-chat-row") === key) ?? null;
    } },
  });
  page.window.innerWidth = 1440;
  Object.defineProperty(page.window, "requestAnimationFrame", { configurable: true, value: () => 1 });
  page.window.cancelAnimationFrame = () => {};
  const values = {
    Node: page.window.Node, Element: page.window.Element, HTMLElement: page.window.HTMLElement, HTMLDivElement: page.window.HTMLDivElement,
    DOMRect: page.window.DOMRect, CSS: page.window.CSS,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    WheelEvent: page.window.WheelEvent, KeyboardEvent: page.window.KeyboardEvent, PointerEvent: page.window.PointerEvent, TouchEvent: page.window.TouchEvent,
    ResizeObserver: TestResizeObserver, MutationObserver: page.window.MutationObserver,
    getSelection: page.window.getSelection.bind(page.window),
  };
  for (const [key, value] of Object.entries(values)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () =>
    Response.json({ source: "scrollback", scrollback: "A transcript to read", messages: [], truncated: false }),
  { preconnect: globalThis.fetch.preconnect }));
});

afterEach(async () => {
  await page.close();
  fetchSpy.mockRestore();
  translationSpy.mockRestore();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});

test.each(["wheel", "touch", "key", "scrollbar", "scrollbar track click", "layout", "returned"] as const)(
  "%s during a shrink keeps the reader's scroll; layout alone follows",
  async (input) => {
    await page.render(createElement(SettingsProvider, null, createElement(ChatView, {
        paneId: `shrink-${input}`, refreshKey: 0, connected: true, ended: false, agent: null, agentStatus: "idle",
    })));
    await act(async () => { scroll(); });
    expect(scroller.scrollTop).toBe(1242);

    await act(async () => {
      const wheel = () => box().dispatchEvent(new page.window.WheelEvent("wheel", { deltaY: -190, bubbles: true }) as unknown as Event);
      const touch = (type: string, y: number) => box().dispatchEvent(new page.window.TouchEvent(type, { bubbles: true, touches: [new page.window.Touch({ identifier: 0, target: box() as never, clientY: y })] }) as unknown as Event);
      switch (input) {
        case "wheel": wheel(); break;
        case "touch": touch("touchstart", 200); touch("touchmove", 390); break;
        case "key": box().dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "PageUp", keyCode: 33, bubbles: true }) as unknown as Event); break;
        case "scrollbar": pointer("pointerdown", 600); pointer("pointermove", 410); break;
        case "scrollbar track click": pointer("pointerdown", 20); pointer("pointerup", 20); break;
        case "layout": break;
        case "returned": wheel(); scroller.scrollTop -= 190; scroll(); scroller.scrollTop += 190; scroll(); break;
        default: input satisfies never;
      }
      scroller.clientHeight = 627;
      resize(box(), scroller.clientHeight);
      expect(scroller.scrollTop).toBe(1373);
      scroller.scrollTop -= input === "scrollbar track click" ? 20 : 190;
      scroll();
    });

    const follows = input === "layout" || input === "returned";
    expect(scroller.scrollTop).toBe(follows ? 1373 : input === "scrollbar track click" ? 1353 : 1183);
    expect(jumps()).toHaveLength(follows ? 0 : 1);
  },
);

async function mountVirtualChat(paneId: string, pageScroll?: ComponentProps<typeof ChatView>["pageScroll"]) {
  await loadChatTimeline();
  fetchSpy.mockImplementation(Object.assign(async () => Response.json({ source: "grok-transcript", turns: [{ role: "assistant", parts: [{ kind: "text", text: "A transcript to read" }] }] }),
    { preconnect: globalThis.fetch.preconnect }));
  await page.render(createElement(SettingsProvider, null, createElement(ChatView, {
    paneId, pageScroll, refreshKey: 0, connected: true, ended: false, agent: null, agentStatus: "idle",
  })));
  box().style.lineHeight = "20px";
}

const pointer = (type: string, clientY: number, clientX = 601) => box().dispatchEvent(new page.window.PointerEvent(type, { bubbles: true, clientY, clientX, buttons: 1, button: 0, pointerType: "mouse" }) as unknown as Event);

test("a first-open list scroll clamped at the old height catches up to the end", async () => {
  scroller.scrollHeight = 1200;
  await mountVirtualChat("first-open");

  await act(async () => {
    scroller.scrollHeight = scroller.clientHeight;
    scroller.scrollTop = 0;
    scroll();
    scroller.scrollHeight = 1200;
    scroller.scrollTop = scroller.scrollHeight; // clamped at the old end, 442 px
    scroller.scrollHeight = 2000;
    scroll();
  });

  expect(scroller.scrollTop).toBe(1242);
  expect(jumps()).toHaveLength(0);
});

test("a downward scrollbar track click stops where the browser scrolled after pointerup", async () => {
  scroller.scrollTop = scroller.scrollHeight;
  await mountVirtualChat("scrollbar-track-down");
  await act(async () => { scroll(); });

  await act(async () => {
    scroller.scrollHeight += 600; // the thumb is no longer at the bottom
    // This press is on the browser's scrollbar track, not in the transcript's selectable contents.
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new page.window.PointerEvent(type, { clientX: 601, clientY: scroller.clientHeight - 1, button: 0, buttons: type === "pointerdown" ? 1 : 0, pointerType: "mouse" });
      Object.defineProperty(event, "target", { get: () => box() });
      page.window.document.dispatchEvent(event);
    }
    scroller.scrollTop += 100;
    scroll();
  });

  expect(scroller.scrollTop).toBe(1342);
  expect(jumps()).toHaveLength(0);
});

test("a one-pixel browser trim does not stop following during selection", async () => {
  scroller.scrollTop = scroller.scrollHeight;
  await mountVirtualChat("selection-trim");
  await act(async () => {
    pointer("pointerdown", 20, 10);
    scroller.scrollHeight += 61; // the selection holds the view while the last row grows
    scroll();
  });

  await act(async () => {
    scroller.scrollHeight -= 1;
    scroller.scrollTop -= 1;
    scroll();
  });

  expect(scroller.scrollTop).toBe(1241);
  expect(jumps()).toHaveLength(0);
});

test.each(["wheel", "input-less"] as const)(
  "a late virtual list correction keeps following, but %s scrolling leaves the end",
  async (input) => {
    scroller.scrollTop = scroller.scrollHeight;
    await mountVirtualChat(`late-list-correction-${input}`);
    await act(async () => { scroll(); });
    expect(scroller.scrollTop).toBe(1242);

    // The virtual list re-anchors after measuring, with no net change in scroll height.
    await act(async () => { measure(121); scroller.scrollTop -= 61; });
    expect(jumps()).toHaveLength(0);
    expect(scroller.scrollTop).toBe(1242);

    if (input === "wheel") {
      await act(async () => {
        box().dispatchEvent(new page.window.WheelEvent("wheel", { deltaY: -190, bubbles: true }) as unknown as Event);
        scroller.scrollTop -= 61;
        scroll();
      });
    } else {
      await act(async () => { scroller.scrollTop -= 30; scroll(); });
      expect(jumps()).toHaveLength(0);
      await act(async () => { scroller.scrollTop -= 31; scroll(); });
    }
    expect(jumps()).toHaveLength(1);
    expect(scroller.scrollTop).toBe(1181);
  },
);

test.each(["from the bottom", "clamped at the history start"] as const)(
  "pane PageUp %s leaves the reader away through a list measurement",
  async (start) => {
    const pageScroll: { current: ((direction: -1 | 1) => void) | null } = { current: null };
    scroller.scrollTop = scroller.scrollHeight;
    await mountVirtualChat(`page-up-${start}`, pageScroll);
    if (pageScroll.current === null) throw new Error("Chat paging did not mount");
    await act(async () => { scroll(); });
    expect(scroller.scrollTop).toBe(1242);

    await act(async () => {
      // PageUp can arrive at the top before the browser delivers the scroll that got there.
      if (start === "clamped at the history start") scroller.scrollTop = 0;
      pageScroll.current?.(-1);
    });
    const paged = start === "from the bottom" ? 504 : 0;
    expect(scroller.scrollTop).toBe(paged);
    expect(jumps()).toHaveLength(1);

    await act(async () => { measure(121); });
    expect(scroller.scrollTop).toBe(paged);
    expect(jumps()).toHaveLength(1);
  },
);
