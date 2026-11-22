import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, type RefObject } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { AppLink } from "./deepLink.ts";
import { SECOND_TAP_MS, useSidebarLayout } from "./useSidebarLayout.ts";

describe("useSidebarLayout", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let layout: ReturnType<typeof useSidebarLayout>;
  let wide: boolean;

  beforeEach(() => {
    for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    wide = false;
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      matchMedia: (query: string) => ({ matches: query.includes("min-width: 769px") ? wide : query.includes("max-width: 768px") ? !wide : false, addEventListener() {}, removeEventListener() {} }),
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  async function mount(drawerBlocked?: RefObject<boolean>, initialLink: AppLink | null = null): Promise<void> {
    function Probe() { layout = useSidebarLayout({ initialLink, drawerBlocked }); return null; }
    await act(async () => { renderer = create(createElement(Probe)); });
  }
  const shownLink: AppLink = { machine: "local", workspace: null, pane: null, view: null, settings: null, sidebar: "shown" };

  it("opens and closes a phone's drawer when nothing blocks it", async () => {
    await mount();
    await act(async () => { layout.setDrawerOpen(true); });
    expect(layout.drawerOpen).toBe(true);
    await act(async () => { layout.setDrawerOpen((open) => !open); });
    expect(layout.drawerOpen).toBe(false);
  });

  it("never opens a blocked drawer, by a value, a toggle or the palette's filter, and opens it again once unblocked", async () => {
    const blocked = { current: true };
    await mount(blocked);

    await act(async () => { layout.setDrawerOpen(true); });
    await act(async () => { layout.setDrawerOpen((open) => !open); });
    await act(async () => { layout.openSidebarFilter(); });
    expect(layout.drawerOpen).toBe(false);

    blocked.current = false;
    await act(async () => { layout.setDrawerOpen(true); });
    expect(layout.drawerOpen).toBe(true);
  });

  it("starts with no drawer out for a link that asks for one while it is blocked", async () => {
    await mount({ current: true }, shownLink);
    expect(layout.drawerOpen).toBe(false);
    await act(async () => { renderer?.unmount(); });

    await mount({ current: false }, shownLink);
    expect(layout.drawerOpen).toBe(true);
  });

  it("pairs a tap on the open drawer's mark with the menu button's click that opened it, within SECOND_TAP_MS of it only", async () => {
    await mount();
    expect(layout.secondTapOfOpening(1_000)).toBe(false);
    await act(async () => { layout.toggleDrawerByButton(1_000); });
    expect(layout.drawerOpen).toBe(true);
    expect(layout.secondTapOfOpening(1_100)).toBe(true);
    expect(layout.secondTapOfOpening(1_000 + SECOND_TAP_MS - 1)).toBe(true);
    expect(layout.secondTapOfOpening(1_000 + SECOND_TAP_MS)).toBe(false);
    await act(async () => { layout.setDrawerOpen(false); });
    await act(async () => { layout.setDrawerOpen(true); });
    expect(layout.secondTapOfOpening(1_100)).toBe(false);
  });

  it("closes an open drawer however it is blocked", async () => {
    const blocked = { current: false };
    await mount(blocked);
    await act(async () => { layout.setDrawerOpen(true); });
    blocked.current = true;
    await act(async () => { layout.setDrawerOpen(false); });
    expect(layout.drawerOpen).toBe(false);
  });
});
