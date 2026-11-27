import { afterEach, beforeEach, expect, it } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { ChatTimeline, type ChatTimelineProps, type ChatTimelineRow } from "./ChatTimeline.tsx";

const saved = new Map<string, PropertyDescriptor | undefined>();
const listResize = Symbol.for("ovis.test.legendListResize");
let page: Page;
let hidden: boolean;

beforeEach(() => {
  page = openPage();
  hidden = false;
  Object.defineProperty(page.window.document, "hidden", { configurable: true, get: () => hidden });
  Object.defineProperty(page.window.document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
  Object.defineProperties(page.window.HTMLElement.prototype, {
    getBoundingClientRect: { configurable: true, value: () => new page.window.DOMRect(0, 0, 800, 600) },
    clientHeight: { configurable: true, get: () => 600 },
    clientWidth: { configurable: true, get: () => 800 },
  });
  const values = {
    requestAnimationFrame: page.window.requestAnimationFrame.bind(page.window),
    cancelAnimationFrame: page.window.cancelAnimationFrame.bind(page.window),
    // LegendList keeps its first observer across suites. Leave its callback on the
    // observed item so scrollInput can deliver a measurement even if we ran first.
    ResizeObserver: class {
      constructor(readonly notify: (entries: readonly ResizeObserverEntry[]) => void) {}
      observe(target: Element, options?: ResizeObserverOptions) {
        if (options?.box === "border-box") Object.defineProperty(target, listResize, { configurable: true, value: this.notify });
      }
      unobserve(target: Element) { Reflect.deleteProperty(target, listResize); }
      disconnect() {}
    },
    HTMLDivElement: page.window.HTMLDivElement,
  };
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});

afterEach(async () => {
  await page.close();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

const row = (key: string): ChatTimelineRow => ({ key, beforeUser: false });
const props = (rows: readonly ChatTimelineRow[], footer: string): ChatTimelineProps<ChatTimelineRow> => ({
  rows, footer, scope: "pane", source: undefined, header: null, label: "Chat", memories: new Map(),
  scroller: { current: null }, listRef: { current: null }, following: { current: false }, manualLayout: { current: false }, selecting: { current: false },
  onScroll() {}, onFollowed() {}, onOpen() {}, renderRow: (item) => item.key,
});
const drawn = () => ({
  keys: [...page.container.querySelectorAll("[data-chat-row]")].map((node) => node.getAttribute("data-chat-row")),
  footer: page.one(".chat-virtual-footer").textContent,
});
const setHidden = async (value: boolean): Promise<void> => {
  await act(async () => {
    hidden = value;
    page.window.document.dispatchEvent(new page.window.Event("visibilitychange"));
  });
};

it("holds measured list input while hidden and applies the latest rows and footer on return (IS-092)", async () => {
  await page.render(<ChatTimeline {...props([row("a")], "Working")} />);
  await setHidden(true);
  await page.render(<ChatTimeline {...props([row("a"), row("b")], "")} />);
  expect(drawn()).toEqual({ keys: ["a"], footer: "Working" });
  await setHidden(false);
  expect(drawn()).toEqual({ keys: ["a", "b"], footer: "" });
});
