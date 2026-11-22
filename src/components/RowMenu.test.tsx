import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { Pencil } from "lucide-react";

import { SettingsProvider } from "../lib/settings.ts";
import { SHEET_QUERY } from "../lib/sheets.ts";
import { RowMenu } from "./RowMenu.tsx";

const node = (): HTMLElement => ({
  isConnected: true, offsetWidth: 200, offsetHeight: 100, clientHeight: 100, scrollHeight: 100, dataset: {},
  getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  querySelector: () => null, querySelectorAll: () => [], contains: () => false, closest: () => null,
  focus() {}, addEventListener() {}, removeEventListener() {},
}) as unknown as HTMLElement;

describe("how the row menu closes from outside it", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let events: EventTarget;
  let frames: FrameRequestCallback[];
  let closes: number;

  async function draw(phone: boolean, anchor = node(), { point, menuNode = node() }: { readonly point?: { x: number; y: number }; readonly menuNode?: HTMLElement } = {}): Promise<void> {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    events = new EventTarget();
    frames = [];
    closes = 0;
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("localStorage", storage);
    define("navigator", { languages: ["en-US"], platform: "Linux" });
    const on = { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
    define("window", { ...on, localStorage: storage, matchMedia: (query: string) => ({ matches: phone && query === SHEET_QUERY, addEventListener() {}, removeEventListener() {} }), innerWidth: phone ? 390 : 1280, innerHeight: 800, requestAnimationFrame: (run: FrameRequestCallback) => frames.push(run), cancelAnimationFrame() {}, setTimeout, clearTimeout });
    define("document", { ...on, visibilityState: "visible", activeElement: null, body: { nodeType: 1, children: [], createNodeMock: () => menuNode }, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null });
    define("getComputedStyle", (element: Element) => ({ overflowX: "visible", overflowY: element === anchor.parentElement ? "auto" : "visible", getPropertyValue: () => "" }));
    function OpenMenu() {
      const [open, setOpen] = useState(true);
      return open ? createElement(RowMenu, { anchor, point, title: "w1", items: [{ id: "rename", label: "Rename", icon: Pencil, run() {} }], onClose: () => { closes++; setOpen(false); } }) : null;
    }
    await act(async () => { renderer = create(createElement(SettingsProvider, null, createElement(OpenMenu)), { createNodeMock: node }); });
  }

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  beforeEach(() => descriptors.clear());

  const frame = () => act(async () => { for (const run of frames.splice(0)) run(0); });
  const scrim = () => renderer!.root.findByProps({ className: "modal-scrim" });
  const press = async (on: "scrim" | "sheet", then: "click" | "none"): Promise<void> => {
    const self = scrim();
    const target = on === "scrim" ? self : {};
    await act(async () => self.props.onPointerDown({ target, currentTarget: self }));
    if (then === "click") await act(async () => self.props.onClick({ target, currentTarget: self }));
  };

  it("keeps a phone's sheet through the press of a tap outside it, and closes it on the tap's click on the dimmed page", async () => {
    await draw(true);
    await act(async () => { events.dispatchEvent(new Event("pointerdown")); });
    expect(closes).toBe(0);
    await press("scrim", "none");
    expect(closes).toBe(0);
    await press("scrim", "click");
    expect(closes).toBe(1);
  });

  it("keeps the sheet when a press begun in it is let go over the dimmed page", async () => {
    await draw(true);
    await act(async () => { events.dispatchEvent(new Event("pointerdown")); });
    expect(closes).toBe(0);
    await press("sheet", "click");
    const self = scrim();
    await act(async () => self.props.onClick({ target: self, currentTarget: self }));
    expect(closes).toBe(0);
    await press("scrim", "click");
    expect(closes).toBe(1);
  });

  it("closes a desktop's popover on a press outside it", async () => {
    await draw(false);
    expect(renderer!.root.findAllByProps({ className: "modal-scrim" })).toHaveLength(0);
    await act(async () => { events.dispatchEvent(new Event("pointerdown")); });
    expect(closes).toBe(1);
  });

  it("follows a shifted desktop row through a chat scroll, then closes when the row scrolls out of view", async () => {
    const list = Object.assign(node(), {
      clientTop: 0, clientHeight: 300,
      getBoundingClientRect: () => ({ top: 80 }),
    });
    let top = 100, left = 212;
    const row = Object.assign(node(), {
      parentElement: list,
      getBoundingClientRect: () => ({ top, left, bottom: top + 20, right: left + 120 }),
    });
    await draw(false, row, { point: { x: 240, y: 110 } });
    const menu = () => renderer?.root.findAllByProps({ role: "menu" }) ?? [];
    const scroll = (target: HTMLElement) => act(async () => {
      events.dispatchEvent(Object.defineProperty(new Event("scroll"), "target", { value: target }));
    });
    expect(menu()[0]?.props.style).toMatchObject({ top: 110, left: 240 });

    top = 132;
    left = 224;
    await scroll(node());
    await frame();
    expect(closes).toBe(0);
    expect(menu()[0]?.props.style).toMatchObject({ top: 142, left: 252 });

    top = 140;
    await frame();
    expect(menu()[0]?.props.style.top).toBe(150);

    top = 48; // Still in the viewport, but above the scrolling list's visible area.
    await scroll(list);
    await frame();
    expect(menu()).toHaveLength(0);
    expect(closes).toBe(1);
  });

  it("repositions an open desktop menu that grows near the bottom of the viewport", async () => {
    const row = Object.assign(node(), {
      getBoundingClientRect: () => ({ top: 600, bottom: 620, left: 212, right: 332 }),
    });
    const menuNode = Object.assign(node(), { offsetHeight: 250, clientHeight: 250, scrollHeight: 250 });
    await draw(false, row, { menuNode });
    const top = () => renderer?.root.findByProps({ role: "menu" }).props.style.top;
    expect(top()).toBe(346);

    Object.assign(menuNode, { offsetHeight: 500, clientHeight: 500, scrollHeight: 500 });
    await frame();
    expect(top()).toBe(96);
  });
});
