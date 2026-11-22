import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, useLayoutEffect, type RefObject } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useKeptPaneBoxes } from "./coveredPane.ts";

interface Box { left: number; top: number; width: number; height: number }

class FakeSlot {
  box: Box;
  reads = 0;
  readonly attributes = new Map<string, string>();
  readonly properties = new Map<string, string>();
  readonly computed = new Map<string, string>();
  readonly style = {
    getPropertyValue: (name: string): string => this.properties.get(name) ?? "",
    setProperty: (name: string, value: string): void => { this.properties.set(name, value); },
    removeProperty: (name: string): void => { this.properties.delete(name); },
  };
  constructor(box: Box, own: Record<string, string> = {}) {
    this.box = box;
    for (const [name, value] of Object.entries(own)) this.properties.set(name, value);
  }
  getBoundingClientRect(): Box { this.reads += 1; return { ...this.box }; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  kept(): Record<string, string> | null {
    return this.attributes.has("data-kept-box") ? Object.fromEntries(this.properties) : null;
  }
}

describe("useKeptPaneBoxes", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let slots: FakeSlot[];
  let areaBox: Box;
  let asked: { panes: number; box: number; observers: number };
  const area = { current: null } as unknown as RefObject<HTMLElement | null>;

  beforeEach(() => {
    for (const key of ["ResizeObserver", "MutationObserver", "IS_REACT_ACT_ENVIRONMENT", "getComputedStyle"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: (slot: FakeSlot) => ({ getPropertyValue: (name: string) => slot.computed.get(name) ?? "" }) });
    asked = { panes: 0, box: 0, observers: 0 };
    const Observer = class {
      constructor() { asked.observers += 1; }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    for (const key of ["ResizeObserver", "MutationObserver"]) Object.defineProperty(globalThis, key, { configurable: true, value: Observer });
    slots = [];
    areaBox = { left: 0, top: 52, width: 390, height: 792 };
    (area as { current: unknown }).current = {
      querySelectorAll: () => { asked.panes += 1; return slots; },
      getBoundingClientRect: () => { asked.box += 1; return { ...areaBox }; },
    };
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

  function Probe({ covered }: { covered: boolean }) {
    useKeptPaneBoxes(area, covered);
    return null;
  }
  const draw = async (covered: boolean): Promise<void> => {
    await act(async () => {
      if (renderer) renderer.update(createElement(Probe, { covered }));
      else renderer = create(createElement(Probe, { covered }));
    });
  };

  it("holds a covered pane in the box it was shown in, whatever the shell around it has become, and lets it go when it is shown again", async () => {
    const slot = new FakeSlot({ left: 0, top: 52, width: 390, height: 792 });
    slots = [slot];
    await draw(false);
    expect(slot.kept()).toBeNull();

    areaBox = { left: 0, top: 0, width: 390, height: 844 };
    await draw(true);

    expect(slot.kept()).toEqual({ position: "absolute", left: "0px", top: "52px", width: "390px", height: "792px" });

    await draw(false);

    expect(slot.kept()).toBeNull();
    expect(slot.properties.size).toBe(0);
  });

  it("reads a pane's box as the list is about to cover it and not while it is covered: the box it keeps is the last it was shown in", async () => {
    const slot = new FakeSlot({ left: 0, top: 42, width: 1440, height: 830 });
    slots = [slot];
    await draw(false);
    areaBox = { left: 320, top: 0, width: 1120, height: 900 };
    await draw(true);
    expect(slot.kept()).toEqual({ position: "absolute", left: "-320px", top: "42px", width: "1440px", height: "830px" });

    slot.box = { left: 0, top: 42, width: 1000, height: 600 };
    await draw(true);
    expect(slot.kept()).toEqual({ position: "absolute", left: "-320px", top: "42px", width: "1440px", height: "830px" });

    await draw(false);
    slot.box = { left: 320, top: 0, width: 1120, height: 900 };
    await draw(true);
    expect(slot.kept()).toEqual({ position: "absolute", left: "0px", top: "0px", width: "1120px", height: "900px" });
  });

  it("leaves alone a pane that came to the page under the list, until it has been shown", async () => {
    areaBox = { left: 0, top: 0, width: 390, height: 844 };
    await draw(true);
    const slot = new FakeSlot({ left: 0, top: 0, width: 390, height: 844 });
    slots = [slot];
    await draw(true);
    expect(slot.kept()).toBeNull();

    await draw(false);
    await draw(true);

    expect(slot.kept()).toEqual({ position: "absolute", left: "0px", top: "0px", width: "390px", height: "844px" });
  });

  it("holds each half of a classic split in its own box over the rectangle its style carries, and gives that style back", async () => {
    const rectangle = (left: string) => ({ left, top: "0%", width: "50%", height: "100%" });
    const first = new FakeSlot({ left: 320, top: 42, width: 560, height: 830 }, rectangle("0%"));
    const second = new FakeSlot({ left: 880, top: 42, width: 560, height: 830 }, rectangle("50%"));
    slots = [first, second];
    areaBox = { left: 320, top: 42, width: 1120, height: 830 };
    await draw(false);

    areaBox = { left: 320, top: 0, width: 1120, height: 900 };
    await draw(true);

    expect(first.kept()).toEqual({ position: "absolute", left: "0px", top: "42px", width: "560px", height: "830px" });
    expect(second.kept()).toEqual({ position: "absolute", left: "560px", top: "42px", width: "560px", height: "830px" });

    // When they are shown again as the classic split, React leaves their style alone: each has its own rectangle back.
    await draw(false);
    expect([first.kept(), Object.fromEntries(first.properties)]).toEqual([null, rectangle("0%")]);
    expect([second.kept(), Object.fromEntries(second.properties)]).toEqual([null, rectangle("50%")]);
  });

  it("leaves what React wrote on a slot's style in the commit that shows it again: a thread's slot has no rectangle", async () => {
    const rectangle = { left: "0%", top: "0%", width: "50%", height: "100%" };
    const slot = new FakeSlot({ left: 320, top: 42, width: 560, height: 830 }, rectangle);
    slots = [slot];
    areaBox = { left: 320, top: 42, width: 1120, height: 830 };
    await draw(false);
    areaBox = { left: 320, top: 0, width: 1120, height: 900 };
    await draw(true);

    // When a row's thread is drawn: in that commit React clears the slot's rectangle before the hold lets go.
    for (const side of Object.keys(rectangle)) slot.style.removeProperty(side);
    await draw(false);

    expect([slot.kept(), Object.fromEntries(slot.properties)]).toEqual([null, {}]);
  });

  it("holds a split's half that Back mounts again under the list at the box the list found it in", async () => {
    const half = (id: string, left: number) => { const slot = new FakeSlot({ left, top: 42, width: 560, height: 830 }); slot.setAttribute("data-slot", id); return slot; };
    const first = half("a", 320);
    slots = [first, half("b", 880)];
    areaBox = { left: 320, top: 42, width: 1120, height: 830 };
    await draw(false);
    areaBox = { left: 320, top: 0, width: 1120, height: 900 };
    await draw(true);

    slots = [first];
    await draw(false);
    const again = half("b", 880);
    again.box = { left: 880, top: 0, width: 560, height: 900 };
    let queries = 0;
    (area as unknown as { current: { querySelectorAll(): FakeSlot[] } }).current.querySelectorAll = () => (queries++ === 0 ? [first] : [first, again]);
    await draw(true);

    expect(again.kept()).toEqual({ position: "absolute", left: "560px", top: "42px", width: "560px", height: "830px" });
  });

  it("holds a covered pane at its size before anything in the commit that covers it reads the page", async () => {
    const slot = new FakeSlot({ left: 0, top: 52, width: 390, height: 792 });
    slots = [slot];
    const seen: string[] = [];
    function Opening({ covered }: { covered: boolean }) {
      useLayoutEffect(() => { if (covered) seen.push(slot.style.getPropertyValue("height") || "not held"); }, [covered]);
      return null;
    }
    function Page({ covered }: { covered: boolean }) {
      useKeptPaneBoxes(area, covered);
      return createElement(Opening, { covered });
    }
    const show = async (covered: boolean): Promise<void> => {
      await act(async () => {
        if (renderer) renderer.update(createElement(Page, { covered }));
        else renderer = create(createElement(Page, { covered }));
      });
    };
    await show(false);

    areaBox = { left: 0, top: 0, width: 390, height: 844 };
    await show(true);

    expect(seen).toEqual(["792px"]);
    expect(slot.kept()).toEqual({ position: "absolute", left: "0px", top: "52px", width: "390px", height: "792px" });
  });

  it("holds the room a header over the pane took of it as it was shown (--header-over), and gives it back", async () => {
    const slot = new FakeSlot({ left: 320, top: 0, width: 1120, height: 900 });
    slot.computed.set("--header-over", "calc(34px + 12px * 2)");
    slots = [slot];
    areaBox = { left: 320, top: 0, width: 1120, height: 900 };
    await draw(false);

    await draw(true);

    expect(slot.kept()).toEqual({ position: "absolute", left: "0px", top: "0px", width: "1120px", height: "900px", "--header-over": "calc(34px + 12px * 2)" });

    await draw(false);
    expect([slot.kept(), slot.properties.size]).toEqual([null, 0]);
  });

  it("reads nothing of the page and watches nothing while no list covers a pane, as in the classic app", async () => {
    const slot = new FakeSlot({ left: 0, top: 52, width: 390, height: 792 });
    slots = [slot];

    await draw(false);
    await draw(false);
    await draw(false);

    expect(asked).toEqual({ panes: 0, box: 0, observers: 0 });
    expect(slot.reads).toBe(0);
  });
});
