import { LegendList } from "@legendapp/list/react";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, createElement, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { ChatView } from "./ChatView.tsx";
import { loadChatTimeline } from "./chatTimelineLoader.ts";

class Scroller extends EventTarget {
  clientHeight = 758;
  clientWidth = 600;
  scrollHeight = 2000;
  top = 0;
  readonly children: never[] = [];
  readonly offsetHeight = 0;
  readonly style = { setProperty() {} };
  firstElementChild = null;
  get scrollTop(): number { return this.top; }
  set scrollTop(value: number) { this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
  scrollTo({ top }: { top: number }): void { this.scrollTop = top; }
  getBoundingClientRect() { return { top: 0, left: 0, bottom: this.clientHeight, right: this.clientWidth, width: this.clientWidth, height: this.clientHeight }; }
  contains(target: unknown): boolean { return target === this; }
  closest(): null { return null; }
  querySelector(): null { return null; }
  querySelectorAll(): never[] { return []; }
}

class Wheel extends Event { readonly deltaY = -190; }
class Key extends Event { readonly key = "PageUp"; readonly isComposing = false; readonly keyCode = 33; }
class TouchInput extends Event {
  readonly touches: readonly { readonly clientY: number }[];
  constructor(type: string, y: number) { super(type); this.touches = [{ clientY: y }]; }
}
class Pointer extends Event {
  readonly buttons = 1;
  readonly button = 0;
  readonly pointerType = "mouse";
  constructor(type: string, readonly clientY: number, readonly clientX = 601) { super(type); }
}

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let scroller: Scroller;
let events: EventTarget;
let resize: () => void;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  scroller = new Scroller();
  events = new EventTarget();
  resize = () => {};
  const storage = { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 };
  const listen = { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
  const style = { lineHeight: "20px", setProperty() {}, removeProperty() {}, getPropertyValue: () => "" };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: Scroller, Element: Scroller, HTMLElement: Scroller, HTMLDivElement: Scroller,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    WheelEvent: Wheel, KeyboardEvent: Key, PointerEvent: Pointer, TouchEvent: TouchInput,
    navigator: { languages: ["en"], platform: "Linux" },
    localStorage: storage,
    window: {
      ...listen, localStorage: storage, sessionStorage: storage, innerWidth: 1440,
      matchMedia: () => ({ matches: false, ...listen }), setTimeout, clearTimeout,
      requestAnimationFrame: () => 1, cancelAnimationFrame() {}, getSelection: () => null,
    },
    document: {
      ...listen, visibilityState: "visible", activeElement: null, querySelector: () => null,
      createRange: () => ({ setStart() {}, collapse() {} }),
      documentElement: { lang: "", dataset: {}, style, hasAttribute: () => false },
    },
    getComputedStyle: () => style,
    ResizeObserver: class {
      constructor(callback: (entries: readonly { readonly target: Scroller }[]) => void) { resize = () => callback([{ target: scroller }]); }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    MutationObserver: class { observe() {} disconnect() {} },
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
  await act(async () => renderer?.unmount());
  renderer = undefined;
  fetchSpy.mockRestore();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});

test.each(["wheel", "touch", "key", "scrollbar", "scrollbar track click", "layout", "returned"] as const)(
  "%s during a shrink keeps the reader's scroll; layout alone follows",
  async (input) => {
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(ChatView, {
        paneId: `shrink-${input}`, refreshKey: 0, connected: true, ended: false, agent: null, agentStatus: "idle",
      })), { createNodeMock: ({ props }) => typeof props === "object" && props !== null && "className" in props && props.className === "chat-view" ? scroller : new Scroller() });
    });
    if (renderer === undefined) throw new Error("Chat did not mount");
    const view = renderer.root.findByProps({ className: "chat-view" });
    const scroll = (): void => { view.props.onScroll(); };
    act(scroll);
    expect(scroller.scrollTop).toBe(1242);

    act(() => {
      const send = (event: Event): void => {
        Object.defineProperty(event, "target", { value: scroller });
        events.dispatchEvent(event);
      };
      switch (input) {
        case "wheel": send(new Wheel("wheel")); break;
        case "touch": send(new TouchInput("touchstart", 200)); send(new TouchInput("touchmove", 390)); break;
        case "key": send(new Key("keydown")); break;
        case "scrollbar": send(new Pointer("pointerdown", 600)); send(new Pointer("pointermove", 410)); break;
        case "scrollbar track click": send(new Pointer("pointerdown", 20)); send(new Pointer("pointerup", 20)); break;
        case "layout": break;
        case "returned": send(new Wheel("wheel")); scroller.scrollTop -= 190; scroll(); scroller.scrollTop += 190; scroll(); break;
        default: input satisfies never;
      }
      scroller.clientHeight = 627;
      resize();
      expect(scroller.scrollTop).toBe(1373);
      scroller.scrollTop -= input === "scrollbar track click" ? 20 : 190;
      scroll();
    });

    const follows = input === "layout" || input === "returned";
    expect(scroller.scrollTop).toBe(follows ? 1373 : input === "scrollbar track click" ? 1353 : 1183);
    expect(renderer.root.findAllByProps({ "aria-label": "Jump to latest" })).toHaveLength(follows ? 0 : 1);
  },
);

async function mountVirtualChat(paneId: string, pageScroll?: ComponentProps<typeof ChatView>["pageScroll"]) {
  await loadChatTimeline();
  fetchSpy.mockImplementation(Object.assign(async () => Response.json({ source: "grok-transcript", turns: [] }),
    { preconnect: globalThis.fetch.preconnect }));
  await act(async () => {
    renderer = create(createElement(SettingsProvider, null, createElement(ChatView, {
      paneId, pageScroll, refreshKey: 0, connected: true, ended: false, agent: null, agentStatus: "idle",
    })), { createNodeMock: ({ props }) => typeof props === "object" && props !== null && "className" in props && props.className === "chat-view chat-view-virtual" ? scroller : new Scroller() });
  });
  if (renderer === undefined) throw new Error("Chat did not mount");
  return { view: renderer.root, list: renderer.root.findByType(LegendList) };
}

test("a first-open list scroll clamped at the old height catches up to the end", async () => {
  scroller.scrollHeight = 1200;
  const { view, list } = await mountVirtualChat("first-open");

  act(() => {
    scroller.scrollTop = scroller.scrollHeight; // clamped at the old end, 442 px
    scroller.scrollHeight = 2000;
    list.props.onScroll();
  });

  expect(scroller.scrollTop).toBe(1242);
  expect(view.findAllByProps({ "aria-label": "Jump to latest" })).toHaveLength(0);
});

test("a downward scrollbar track click stops where the browser scrolled after pointerup", async () => {
  scroller.scrollTop = scroller.scrollHeight;
  const { view, list } = await mountVirtualChat("scrollbar-track-down");
  act(() => { list.props.onScroll(); });

  act(() => {
    scroller.scrollHeight += 600; // the thumb is no longer at the bottom
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new Pointer(type, scroller.clientHeight - 1);
      Object.defineProperty(event, "target", { value: scroller });
      events.dispatchEvent(event);
    }
    scroller.scrollTop += 100;
    list.props.onScroll();
  });

  expect(scroller.scrollTop).toBe(1342);
  expect(view.findAllByProps({ "aria-label": "Jump to latest" })).toHaveLength(0);
});

test("a one-pixel browser trim does not stop following during selection", async () => {
  scroller.scrollTop = scroller.scrollHeight;
  const { view, list } = await mountVirtualChat("selection-trim");
  act(() => {
    scroller.dispatchEvent(new Pointer("pointerdown", 20, 10));
    scroller.scrollHeight += 61; // the selection holds the view while the last row grows
    list.props.onScroll();
  });

  act(() => {
    scroller.scrollHeight -= 1;
    scroller.scrollTop -= 1;
    list.props.onScroll();
  });

  expect(scroller.scrollTop).toBe(1241);
  expect(view.findAllByProps({ "aria-label": "Jump to latest" })).toHaveLength(0);
});

test.each(["wheel", "input-less"] as const)(
  "a late virtual list correction keeps following, but %s scrolling leaves the end",
  async (input) => {
    scroller.scrollTop = scroller.scrollHeight;
    const { view, list } = await mountVirtualChat(`late-list-correction-${input}`);
    const scroll = (): void => { list.props.onScroll(); };
    act(scroll);
    expect(scroller.scrollTop).toBe(1242);

    // The virtual list re-anchors after measuring, with no net change in scroll height.
    await act(async () => { list.props.onItemSizeChanged(); scroller.scrollTop -= 61; });
    expect(view.findAllByProps({ "aria-label": "Jump to latest" })).toHaveLength(0);
    expect(scroller.scrollTop).toBe(1242);

    if (input === "wheel") {
      act(() => {
        const wheel = new Wheel("wheel");
        Object.defineProperty(wheel, "target", { value: scroller });
        events.dispatchEvent(wheel);
        scroller.scrollTop -= 61;
        scroll();
      });
    } else {
      act(() => { scroller.scrollTop -= 30; scroll(); });
      expect(view.findAllByProps({ "aria-label": "Jump to latest" })).toHaveLength(0);
      act(() => { scroller.scrollTop -= 31; scroll(); });
    }
    expect(view.findAllByProps({ "aria-label": "Jump to latest" })).toHaveLength(1);
    expect(scroller.scrollTop).toBe(1181);
  },
);

test.each(["from the bottom", "clamped at the history start"] as const)(
  "pane PageUp %s leaves the reader away through a list measurement",
  async (start) => {
    const pageScroll: { current: ((direction: -1 | 1) => void) | null } = { current: null };
    scroller.scrollTop = scroller.scrollHeight;
    const { view, list } = await mountVirtualChat(`page-up-${start}`, pageScroll);
    if (pageScroll.current === null) throw new Error("Chat paging did not mount");
    act(() => { list.props.onScroll(); });
    expect(scroller.scrollTop).toBe(1242);

    act(() => {
      // PageUp can arrive at the top before the browser delivers the scroll that got there.
      if (start === "clamped at the history start") scroller.scrollTop = 0;
      pageScroll.current?.(-1);
    });
    const paged = start === "from the bottom" ? 504 : 0;
    expect(scroller.scrollTop).toBe(paged);
    expect(view.findAllByProps({ "aria-label": "Jump to latest" })).toHaveLength(1);

    await act(async () => { list.props.onItemSizeChanged(); });
    expect(scroller.scrollTop).toBe(paged);
    expect(view.findAllByProps({ "aria-label": "Jump to latest" })).toHaveLength(1);
  },
);
