import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { act, createElement, createRef } from "react";
import { layoutScroll, LAYOUT_SCROLL_START, LAYOUT_SCROLL_END } from "./layoutScroll.ts";
import { openPage } from "./page.fixture.ts";

test("layout notifications surround the actual write and finish after an exception", () => {
  const node = new EventTarget() as HTMLElement;
  let top = 10;
  const positions: number[] = [];
  node.addEventListener(LAYOUT_SCROLL_START, () => positions.push(top));
  node.addEventListener(LAYOUT_SCROLL_END, () => positions.push(top));
  expect(() => layoutScroll(node, () => { top = 20; throw new Error("write failed"); })).toThrow("write failed");
  expect(positions).toEqual([10, 20]);
});

test("the list patch emits the same layout notification names as the app", () => {
  const patch = readFileSync(join(import.meta.dir, "../../patches/@legendapp%2Flist@3.3.5.patch"), "utf8");
  const names = [...patch.matchAll(/new \w*Event\("([^"\n]+)"/g)].map((match) => match[1]);
  expect(names).toContain(LAYOUT_SCROLL_START);
  expect(names).toContain(LAYOUT_SCROLL_END);
});

test.each(["reader", "layout"] as const)("a %s jump to the end moves the list with the right scroll notifications", async (source) => {
  const page = openPage();
  const globals = {
    Event: page.window.Event,
    ResizeObserver: page.window.ResizeObserver,
    requestAnimationFrame: page.window.requestAnimationFrame.bind(page.window),
    cancelAnimationFrame: page.window.cancelAnimationFrame.bind(page.window),
  };
  const saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  try {
    const list = createRef<LegendListRef>();
    await page.render(createElement(LegendList<number>, {
      ref: list, className: "timeline", data: [0, 1, 2, 3, 4, 5, 6, 7], estimatedItemSize: 100,
      recycleItems: false, renderItem: ({ item }) => String(item),
    }));
    const node = page.one(".timeline");
    let top = 150;
    const landed = Promise.withResolvers<void>();
    Object.defineProperties(node, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 800 },
      scrollTop: { get: () => top },
      scrollTo: { value: (options: ScrollToOptions) => { top = options.top ?? top; landed.resolve(); } },
    });
    const positions: number[] = [];
    node.addEventListener(LAYOUT_SCROLL_START, () => positions.push(node.scrollTop));
    node.addEventListener(LAYOUT_SCROLL_END, () => positions.push(node.scrollTop));
    const options = { animated: false, layoutScroll: source === "layout" };
    const handle = list.current;
    if (handle === null) throw new Error("List did not mount");
    await act(async () => { void handle.scrollToEnd(options); });
    await act(async () => { await landed.promise; });
    expect(node.scrollTop).toBe(700);
    expect(positions).toEqual(source === "layout" ? [150, 700] : []);
  } finally {
    try { await page.close(); }
    finally {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  }
});
