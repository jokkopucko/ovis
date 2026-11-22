import { afterEach, beforeEach, expect, it } from "bun:test";
import { LegendList } from "@legendapp/list/react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { ChatTimeline, type ChatTimelineProps, type ChatTimelineRow } from "./ChatTimeline.tsx";

const globals = ["document", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "HTMLDivElement", "IS_REACT_ACT_ENVIRONMENT"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let page: EventTarget & { hidden: boolean };
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  page = Object.assign(new EventTarget(), { hidden: false });
  Object.defineProperty(page, "visibilityState", { get: () => page.hidden ? "hidden" : "visible" });
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    document: page,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    HTMLDivElement: class {},
  };
  for (const key of globals) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  }
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  for (const key of globals) {
    const descriptor = saved.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const node = () => Object.assign(new EventTarget(), {
  offsetHeight: 0, scrollTop: 0, clientHeight: 0, scrollHeight: 0, style: {},
  getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, x: 0, y: 0 }), querySelector: () => null, querySelectorAll: () => [],
});
const row = (key: string): ChatTimelineRow => ({ key, beforeUser: false });
const props = (rows: readonly ChatTimelineRow[], footer: string): ChatTimelineProps<ChatTimelineRow> => ({
  rows, footer, scope: "pane", source: undefined, header: null, label: "Chat", memories: new Map(),
  scroller: { current: null }, listRef: { current: null }, following: { current: true }, manualLayout: { current: false }, selecting: { current: false },
  onScroll() {}, onFollowed() {}, onOpen() {}, renderRow: (item) => item.key,
});
const drawn = () => {
  if (renderer === undefined) throw new Error("timeline is not mounted");
  return {
    keys: renderer.root.findByType(LegendList).props.data.map((item: ChatTimelineRow) => item.key),
    footer: renderer.root.findByProps({ className: "chat-virtual-footer" }).children,
  };
};
const setHidden = (hidden: boolean): void => {
  act(() => {
    page.hidden = hidden;
    page.dispatchEvent(new Event("visibilitychange"));
  });
};

it("holds measured list input while hidden and applies the latest rows and footer on return (IS-092)", () => {
  act(() => { renderer = create(<ChatTimeline {...props([row("a")], "Working")} />, { createNodeMock: node }); });
  setHidden(true);
  act(() => renderer?.update(<ChatTimeline {...props([row("a"), row("b")], "")} />));
  expect(drawn()).toEqual({ keys: ["a"], footer: ["Working"] });
  setHidden(false);
  expect(drawn()).toEqual({ keys: ["a", "b"], footer: [] });
});
