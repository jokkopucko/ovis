import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { inputWas, placeSentence, sentenceHoles, sentenceRoom, SettingsBare, SettingsRow, Stepper, Toggle, typedStep, useRowSentence } from "./SettingsControls.tsx";

const key = (name: string, composing: boolean) => ({
  key: name,
  nativeEvent: { isComposing: composing, keyCode: composing ? 229 : name === "Enter" ? 13 : 27 },
  stopPropagation() {},
});

describe("the typed font size (G-179)", () => {
  let renderer: ReactTestRenderer | undefined;
  afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; });

  const mount = () => {
    const changes: number[] = [];
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    act(() => {
      renderer = create(createElement(Stepper, { label: "Terminal font size", value: 14, text: "14px", min: 10, max: 22, decreaseLabel: "Smaller", increaseLabel: "Larger", unit: "px", range: "Enter 10–22px", onChange: (value: number) => changes.push(value) }));
    });
    const field = () => renderer!.root.findByType("input");
    const button = (name: string) => renderer!.root.findByProps({ "aria-label": name });
    const range = () => renderer!.root.findByProps({ id: field().props["aria-describedby"] });
    return { changes, field, button, range };
  };

  it("keeps a valid size typed when the field goes without a blur, and nothing after Escape", () => {
    const { changes, field } = mount();
    act(() => field().props.onChange({ target: { value: "16" } }));
    act(() => renderer!.unmount());
    renderer = undefined;
    expect(changes).toEqual([16]);

    const again = mount();
    act(() => again.field().props.onChange({ target: { value: "18" } }));
    act(() => again.field().props.onKeyDown(key("Escape", false)));
    act(() => renderer!.unmount());
    renderer = undefined;
    expect(again.changes).toEqual([]);
  });

  it("steps from the size still in the field, not the saved one", () => {
    const { changes, field, button } = mount();
    act(() => field().props.onChange({ target: { value: "16" } }));
    act(() => button("Larger").props.onClick());
    expect(changes).toEqual([17]);
    act(() => field().props.onBlur());
    expect(changes).toEqual([17]);
  });

  it("says an end's button goes no further without disabling it, and a press there changes nothing", () => {
    const { changes, field, button } = mount();
    expect(button("Larger").props["aria-disabled"]).toBeUndefined();
    act(() => field().props.onChange({ target: { value: "22" } }));
    expect(button("Larger").props["aria-disabled"]).toBe(true);
    // a disabled button would drop the keyboard's focus to the page
    expect(button("Larger").props.disabled).toBeUndefined();
    act(() => button("Larger").props.onClick());
    expect(changes).toEqual([]);
    act(() => field().props.onChange({ target: { value: "10" } }));
    expect(button("Smaller").props["aria-disabled"]).toBe(true);
    expect(button("Larger").props["aria-disabled"]).toBeUndefined();
    act(() => button("Smaller").props.onClick());
    expect(changes).toEqual([]);
  });

  it("names the range, and shows it under the field after a refused size until the next edit", () => {
    const { field, range } = mount();
    expect(range().props.children).toBe("Enter 10–22px");
    expect(range().props.className).toBe("visually-hidden");
    act(() => field().props.onChange({ target: { value: "30" } }));
    act(() => field().props.onKeyDown(key("Enter", false)));
    expect(range().props.className).toBe("settings-stepper-range");
    expect(field().props["aria-invalid"]).toBe(true);
    act(() => field().props.onChange({ target: { value: "1" } }));
    expect(range().props.className).toBe("visually-hidden");
  });

  it("leaves Enter and Escape to an IME while it composes, then commits the finished number", () => {
    const { changes, field } = mount();
    act(() => field().props.onChange({ target: { value: "16" } }));
    act(() => field().props.onKeyDown(key("Enter", true)));
    expect(changes).toEqual([]);
    expect(field().props.value).toBe("16");
    act(() => field().props.onKeyDown(key("Escape", true)));
    expect(field().props.value).toBe("16");
    act(() => field().props.onKeyDown(key("Enter", false)));
    expect(changes).toEqual([16]);
  });

  it("reads a pasted number whole and refuses one out of range", () => {
    const { changes, field } = mount();
    act(() => field().props.onChange({ target: { value: "200" } }));
    act(() => field().props.onKeyDown(key("Enter", false)));
    expect(changes).toEqual([]);
    expect(field().props.value).toBe("14");
  });

  it("takes the full-width digits an IME types as the number, and shows it in plain digits once committed", () => {
    const { changes, field, range } = mount();
    act(() => field().props.onChange({ target: { value: "１６" } }));
    expect(field().props.value).toBe("１６");
    expect(field().props["aria-invalid"]).toBeUndefined();
    act(() => field().props.onKeyDown(key("Enter", false)));
    expect(changes).toEqual([16]);
    expect(range().props.className).toBe("visually-hidden");
    expect(field().props.value).toBe("14");
    act(() => field().props.onChange({ target: { value: "１８" } }));
    act(() => renderer!.root.findByProps({ "aria-label": "Larger" }).props.onClick());
    expect(changes).toEqual([16, 19]);
  });
});

describe("typedStep", () => {
  it("reads full-width digits as their plain ones, alone or mixed", () => {
    expect(typedStep("１６", 10, 22)).toBe(16);
    expect(typedStep("1６", 10, 22)).toBe(16);
    expect(typedStep(" ２２ ", 10, 22)).toBe(22);
  });

  it("still refuses a full-width number out of range, and anything that is not a whole number", () => {
    expect(typedStep("２３", 10, 22)).toBeNull();
    expect(typedStep("９", 10, 22)).toBeNull();
    expect(typedStep("２００", 10, 22)).toBeNull();
    expect(typedStep("１６．５", 10, 22)).toBeNull();
    expect(typedStep("16.5", 10, 22)).toBeNull();
    expect(typedStep("１６px", 10, 22)).toBeNull();
    expect(typedStep("١٦", 10, 22)).toBeNull();
    expect(typedStep("", 10, 22)).toBeNull();
  });
});

describe("where a row's sentence goes (#3275)", () => {
  const row = { left: 100, top: 300, right: 600, bottom: 358 };
  const name = { left: 140, top: 319, right: 260, bottom: 339 };
  const size = { width: 300, height: 50 };
  const screen = { width: 1280, height: 800 };

  it("above the row on the name's left edge, ending over the row's own control", () => {
    expect(placeSentence(row, name, 312, 346, size, screen)).toEqual({ left: 140, top: 258, side: "above" });
  });

  it("under the row only where the screen ends above it", () => {
    const first = { left: 100, top: 20, right: 600, bottom: 78 };
    expect(placeSentence(first, { left: 140, top: 39, right: 260, bottom: 59 }, 32, 66, size, screen)).toEqual({ left: 140, top: 70, side: "below" });
  });

  it("inside the row's card, and never past the screen's edge", () => {
    expect(placeSentence(row, { left: 520, top: 319, right: 590, bottom: 339 }, 312, 346, size, screen).left).toBe(300);
    const phone = { left: 0, top: 300, right: 390, bottom: 358 };
    expect(placeSentence(phone, { left: 40, top: 319, right: 120, bottom: 339 }, 312, 346, { width: 380, height: 50 }, { width: 390, height: 844 }).left).toBe(8);
  });

  it("as wide as the room beside another row's control it would lie on, or its own width where that room is too small", () => {
    const lies = { left: 140, top: 258, right: 440, bottom: 308 };
    expect(sentenceRoom(lies, [])).toBeNull();
    expect(sentenceRoom(lies, [{ left: 400, top: 250, right: 600, bottom: 284 }])).toBe(252);
    expect(sentenceRoom(lies, [{ left: 400, top: 100, right: 600, bottom: 134 }])).toBeNull();
    // 152px beside the control: narrower than a sentence is worth, so it keeps its width
    expect(sentenceRoom(lies, [{ left: 300, top: 250, right: 600, bottom: 284 }])).toBeNull();
  });

  it("is cut out, for the pointer, in exactly the parts that lie on another row's control", () => {
    const lies = { left: 140, top: 258, right: 440, bottom: 308 };
    expect(sentenceHoles(lies, [])).toEqual([]);
    expect(sentenceHoles(lies, [{ left: 400, top: 100, right: 600, bottom: 134 }])).toEqual([]);
    expect(sentenceHoles(lies, [{ left: 300, top: 270, right: 600, bottom: 304 }])).toEqual([{ left: 160, top: 12, right: 300, bottom: 46 }]);
    expect(sentenceHoles(lies, [{ left: 300, top: 270, right: 380, bottom: 304 }, { left: 390, top: 270, right: 600, bottom: 304 }]))
      .toEqual([{ left: 160, top: 12, right: 240, bottom: 46 }, { left: 250, top: 12, right: 300, bottom: 46 }]);
  });

  it("starts a sentence taller than the screen at the screen's top", () => {
    const first = { left: 100, top: 20, right: 600, bottom: 80 };
    const placed = placeSentence(first, { left: 120, top: 40, right: 200, bottom: 60 }, 40, 80, { width: 300, height: 250 }, { width: 800, height: 200 });
    expect(placed.side).toBe("below");
    expect(placed.top).toBe(8);
  });
});

describe("a row's sentence, as its hook keeps it (#3275)", () => {
  const names = ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "IS_REACT_ACT_ENVIRONMENT"];
  const saved = new Map<string, PropertyDescriptor | undefined>();
  class HTMLElement {
    isContentEditable = false;
    constructor(readonly dialog: object | null) {}
    closest(selector: string): object | null { return selector === "[aria-modal='true']" ? this.dialog : null; }
    contains(other: unknown): boolean { return other === this; }
    getBoundingClientRect(): { top: number; bottom: number } { return { top: 0, bottom: 40 }; }
  }
  class HTMLInputElement extends HTMLElement { type = "text"; }
  class HTMLTextAreaElement extends HTMLElement {}
  interface Key { key: string; isComposing: boolean; keyCode: number; stopped: boolean; preventDefault(): void; stopPropagation(): void }
  interface Heard { type: string; run: (event: Key) => void; capture: boolean }
  class Target {
    heard: Heard[] = [];
    addEventListener(type: string, run: Heard["run"], capture: boolean = false): void { this.heard.push({ type, run, capture }); }
    removeEventListener(type: string, run: Heard["run"], capture: boolean = false): void { this.heard = this.heard.filter((one) => !(one.type === type && one.run === run && one.capture === capture)); }
  }
  const settings = { name: "Settings" };
  const palette = { name: "the palette, opened over Settings" };
  let win: Target & { setTimeout(run: () => void): number; clearTimeout(id?: number): void };
  let doc: Target & { activeElement: HTMLElement | null };
  let rests: Map<number, () => void>;
  let renderer: ReactTestRenderer | undefined;
  const rows = new Map<string, ReturnType<typeof useRowSentence>>();
  const row = (name = "a") => rows.get(name)!;

  function Row({ name, on }: { name: string; on: boolean }) {
    rows.set(name, useRowSentence(on));
    return null;
  }
  async function draw(page: Record<string, boolean> = { a: true }): Promise<void> {
    const tree = createElement(Fragment, null, ...Object.entries(page).map(([name, on]) => createElement(Row, { key: name, name, on })));
    await act(async () => { if (renderer) renderer.update(tree); else renderer = create(tree); });
    for (const name of Object.keys(page)) (row(name).row as { current: unknown }).current ??= new HTMLElement(settings);
  }
  const does = (run: () => void): Promise<void> => act(async () => { run(); });
  const focusAfter = (key: string, name = "a") => does(() => { inputWas({ key }); row(name).rowEvents.onFocus?.({} as never); });
  const focusLeaves = (name = "a") => does(() => row(name).rowEvents.onBlur?.({ relatedTarget: null } as never));
  const drawn = (is = true, name = "a"): void => { (row(name).drawn as { current: boolean }).current = is; };
  const mouseEnters = (name = "a") => does(() => row(name).rowEvents.onPointerEnter?.({ pointerType: "mouse" } as never));
  const restEnds = () => does(() => { for (const run of [...rests.values()]) run(); rests.clear(); });
  async function tapName(name = "a"): Promise<void> {
    const target = { closest: (selector: string) => selector === ".settings-row-text" ? {} : null };
    await does(() => row(name).rowEvents.onPointerDown?.({ pointerType: "touch", target } as never));
    await does(() => row(name).rowEvents.onClick?.({ target, currentTarget: row(name).row.current, preventDefault() {} } as never));
  }
  async function escape(over: Partial<Key> = {}): Promise<boolean> {
    let heard = false;
    const closeSettings = (): void => { heard = true; };
    win.addEventListener("keydown", closeSettings);
    const event: Key = { key: "Escape", isComposing: false, keyCode: 27, stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; }, ...over };
    await act(async () => {
      for (const [target, capture] of [[win, true], [doc, true], [doc, false], [win, false]] as const) {
        if (event.stopped) break;
        for (const one of [...target.heard]) if (one.type === "keydown" && one.capture === capture) one.run(event);
      }
    });
    win.removeEventListener("keydown", closeSettings);
    return heard;
  }

  beforeEach(() => {
    for (const name of names) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    rests = new Map();
    let last = 0;
    win = Object.assign(new Target(), { setTimeout: (run: () => void) => { rests.set(++last, run); return last; }, clearTimeout: (id?: number) => { if (id !== undefined) rests.delete(id); } });
    doc = Object.assign(new Target(), { activeElement: null as HTMLElement | null });
    for (const [name, value] of Object.entries({ window: win, document: doc, HTMLElement, HTMLInputElement, HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    doc.activeElement = new HTMLElement(settings);
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    rows.clear();
    for (const name of names) {
      const was = saved.get(name);
      if (was) Object.defineProperty(globalThis, name, was);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  it("shows on a focus the keyboard moved, not on one the app gives back after Escape or Enter, nor on a pointer's", async () => {
    await draw();
    await focusAfter("Escape");
    expect(row().shown).toBeNull();
    await focusAfter("Enter");
    expect(row().shown).toBeNull();
    await does(() => { inputWas("pointer"); row().rowEvents.onFocus?.({} as never); });
    expect(row().shown).toBeNull();
    await focusAfter("Tab");
    expect(row().shown).toBe("focus");
  });

  it("takes Escape for itself while it is on the screen, and leaves it to a text field, an IME, another dialog and Settings otherwise", async () => {
    await draw();
    const show = async (): Promise<void> => { await focusLeaves(); await focusAfter("Tab"); drawn(); };
    await show();
    expect(await escape()).toBe(false);
    expect(row().shown).toBeNull();

    await show();
    doc.activeElement = new HTMLInputElement(settings);
    expect(await escape()).toBe(true);
    expect(row().shown).toBeNull();

    await show();
    expect(await escape({ isComposing: true })).toBe(true);
    expect(row().shown).toBe("focus");

    doc.activeElement = new HTMLElement(palette);
    expect(await escape()).toBe(true);
    expect(row().shown).toBeNull();

    doc.activeElement = new HTMLElement(settings);
    await focusLeaves();
    await focusAfter("Tab");
    drawn(false);
    expect(await escape()).toBe(true);
    expect(row().shown).toBe("focus");
  });

  it("stays closed after Escape while the focus moves inside the row, and shows again once the focus or the pointer has left", async () => {
    await draw();
    await focusAfter("Tab");
    drawn();
    await escape();
    await focusAfter("ArrowRight");
    expect(row().shown).toBeNull();
    await focusLeaves();
    await focusAfter("Tab");
    expect(row().shown).toBe("focus");

    drawn();
    await escape();
    await mouseEnters();
    await restEnds();
    expect(row().shown).toBe("hover");
  });

  it("closes a sentence a tap opened on Escape, before Settings, and with a row the search hides", async () => {
    await draw();
    await tapName();
    expect(row().opened).toBe(true);
    expect(await escape()).toBe(false);
    expect(row().opened).toBe(false);
    expect(await escape()).toBe(true);

    await tapName();
    await does(() => row().forget());
    expect(row().opened).toBe(false);
    expect(await escape()).toBe(true);
  });

  it("keeps what was asked last: the keyboard's sentence over a rest that began before it, the mouse's over a sentence that was there first", async () => {
    await draw({ a: true, b: true });
    await mouseEnters("a");
    await focusAfter("Tab", "b");
    await restEnds();
    expect([row("a").shown, row("b").shown]).toEqual([null, "focus"]);

    await does(() => row("a").rowEvents.onPointerLeave?.());
    await mouseEnters("a");
    await restEnds();
    expect([row("a").shown, row("b").shown]).toEqual(["hover", null]);
  });

  it("shows the mouse's sentence when it comes to rest on another row while the keyboard's is showing", async () => {
    await draw({ a: true, b: true });
    await focusAfter("Tab", "b");
    drawn(true, "b");
    await mouseEnters("a");
    await restEnds();
    expect([row("a").shown, row("b").shown]).toEqual(["hover", null]);
  });

  it("keeps no sentence for a row whose description went away, and takes no Escape for it", async () => {
    await draw();
    await tapName();
    expect(row().opened).toBe(true);
    await draw({ a: false });
    expect(row().opened).toBe(false);
    expect(await escape()).toBe(true);
    await draw({ a: true });
    expect(row().opened).toBe(false);
  });
});

describe("a row's sentence describes its control (#3275)", () => {
  const render = (bare: boolean, control: ReactNode = createElement(Toggle, { label: "Collapse work", checked: false, onChange: () => {} })): string => {
    const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      return renderToStaticMarkup(createElement(SettingsProvider, null, createElement(SettingsBare.Provider, { value: bare },
        createElement(SettingsRow, { label: "Collapse work", description: "Starts folded.", children: control }))));
    } finally {
      if (saved) Object.defineProperty(navigator, "languages", saved);
      else Reflect.deleteProperty(navigator, "languages");
    }
  };

  it.each([["a page without sentences", true, "visually-hidden"], ["a page with sentences", false, "settings-description"]] as const)("on %s", (_page, bare, shownAs) => {
    const html = render(bare);
    const id = new RegExp(`<span id="([^"]+)" class="${shownAs}">Starts folded\\.</span>`).exec(html)?.[1];
    expect(id).toBeString();
    expect(html).toContain(`role="switch" aria-checked="false" aria-label="Collapse work" aria-describedby="${id}"`);
  });

  it("describes a button and a field the page draws in the row, and leaves one that brings its own description", () => {
    const html = render(true, createElement(Fragment, null,
      createElement("span", { className: "settings-chips" }, createElement("button", { type: "button" }, "Edit key bar")),
      createElement("input", { "aria-label": "Key" }),
      createElement("button", { type: "button", "aria-describedby": "own-note" }, "Move everything")));
    const id = /<span id="([^"]+)" class="visually-hidden">Starts folded\.<\/span>/.exec(html)?.[1];
    expect(id).toBeString();
    expect(html).toContain(`<button type="button" aria-describedby="${id}">Edit key bar</button>`);
    expect(html).toContain(`<input aria-label="Key" aria-describedby="${id}"/>`);
    expect(html).toContain(`<button type="button" aria-describedby="own-note">Move everything</button>`);
  });
});
