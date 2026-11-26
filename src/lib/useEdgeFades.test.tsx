import { afterEach, beforeEach, expect, it } from "bun:test";
import { act, useRef } from "react";

import { openPage, type Page } from "./page.fixture.ts";
import { useEdgeFades } from "./useEdgeFades.ts";

const globals = ["requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "MutationObserver"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let page: Page;
let frames: Map<number, FrameRequestCallback>;
let mutated: () => void;

function setHidden(hidden: boolean): void {
  Object.defineProperty(page.window.document, "hidden", { configurable: true, value: hidden });
}

function List() {
  const ref = useRef<HTMLDivElement>(null);
  useEdgeFades(ref);
  return <div ref={(list) => {
    ref.current = list;
    if (list) Object.defineProperties(list, { clientHeight: { value: 100 }, scrollHeight: { value: 300 } });
  }} />;
}

beforeEach(() => {
  page = openPage();
  setHidden(false);
  frames = new Map();
  let next = 0;
  mutated = () => { throw new Error("no MutationObserver made"); };
  const values: Record<string, unknown> = {
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { constructor(callback: () => void) { mutated = callback; } observe() {} disconnect() {} },
  };
  for (const key of globals) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  }
});

afterEach(async () => {
  await page.close();
  for (const key of globals) {
    const descriptor = saved.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

it("reads a hidden list's edges in no frame until the page is shown again (IS-092)", async () => {
  await page.render(<List />);
  const list = page.one<HTMLDivElement>("div");
  await act(async () => {
    setHidden(true);
    page.window.document.dispatchEvent(new page.window.Event("visibilitychange"));
    list.scrollTop = 200;
    mutated();
    mutated();
  });
  expect(frames.size).toBe(0);
  expect(list.getAttributeNames()).toEqual(["data-fade-bottom"]);
  await act(async () => {
    setHidden(false);
    page.window.document.dispatchEvent(new page.window.Event("visibilitychange"));
  });
  expect(frames.size).toBe(1);
  const due = [...frames.values()];
  frames.clear();
  await act(async () => { for (const callback of due) callback(0); });
  expect(list.getAttributeNames()).toEqual(["data-fade-top"]);
});
