import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act, createRef } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import * as i18n from "../lib/i18n.ts";
import { ChatMinimap } from "./ChatMinimap.tsx";

const globals = ["requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let page: Page;
let frames: Map<number, FrameRequestCallback>;
let restoreTranslation = () => {};

beforeEach(() => {
  page = openPage();
  frames = new Map();
  let next = 0;
  const translated = spyOn(i18n, "useT").mockReturnValue((text) => text);
  restoreTranslation = () => translated.mockRestore();
  const values: Record<string, unknown> = {
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    ResizeObserver: class { observe() {} disconnect() {} },
  };
  for (const key of globals) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  }
});

afterEach(async () => {
  await page.close();
  restoreTranslation();
  for (const key of globals) {
    const descriptor = saved.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

it("measures a hidden chat in no frame until the page is shown again (IS-092)", async () => {
  let measured = 0;
  const ref = createRef<HTMLDivElement>();
  const setHidden = (value: boolean) => Object.defineProperty(page.window.document, "hidden", { configurable: true, value });
  setHidden(true);
  Object.defineProperty(page.window.HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => { measured++; return { top: 0, bottom: 800, width: 1000, height: 800 }; },
  });
  await page.render(<><div ref={ref} /><ChatMinimap turns={[]} rowKeys={["a", "b"]} scroller={ref} onJump={() => {}} /></>);
  await act(async () => { Reflect.apply(page.one("div").dispatchEvent, page.one("div"), [new page.window.Event("scroll")]); });
  expect(frames.size).toBe(0);
  expect(measured).toBe(0);
  setHidden(false);
  await act(async () => { page.window.document.dispatchEvent(new page.window.Event("visibilitychange")); });
  expect(frames.size).toBe(1);
  await act(async () => {
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback(0);
  });
  expect(measured).toBe(1);
});
