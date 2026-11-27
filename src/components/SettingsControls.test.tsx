import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { act, createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { SettingsProvider } from "../lib/settings.ts";
import { inputWas, placeSentence, sentenceHoles, sentenceRoom, SettingsBare, SettingsRow, Stepper, Toggle, typedStep, useRowSentence } from "./SettingsControls.tsx";

describe("the typed font size (G-179)", () => {
  let page: Page;
  beforeEach(() => { page = openPage(); });
  afterEach(async () => { await page.close(); });

  const mount = async () => {
    const changes: number[] = [];
    await page.render(createElement(Stepper, { label: "Terminal font size", value: 14, text: "14px", min: 10, max: 22, decreaseLabel: "Smaller", increaseLabel: "Larger", unit: "px", range: "Enter 10–22px", onChange: (value: number) => changes.push(value) }));
    const field = () => page.one<HTMLInputElement>("input");
    const button = (name: string) => page.one<HTMLButtonElement>(`button[aria-label="${name}"]`);
    const range = () => page.one(`[id="${field().getAttribute("aria-describedby")}"]`);
    return { changes, field, button, range };
  };
  const key = (field: HTMLInputElement, name: string, composing: boolean) => act(async () => {
    const event = new page.window.KeyboardEvent("keydown", { key: name, isComposing: composing, bubbles: true, cancelable: true });
    Object.defineProperty(event, "keyCode", { value: composing ? 229 : name === "Enter" ? 13 : 27 });
    Reflect.apply(field.dispatchEvent, field, [event]);
  });

  it("keeps a valid size typed when the field goes without a blur, and nothing after Escape", async () => {
    const { changes, field } = await mount();
    await page.type(field(), "16");
    await page.render(null);
    expect(changes).toEqual([16]);

    const again = await mount();
    await page.type(again.field(), "18");
    await key(again.field(), "Escape", false);
    await page.render(null);
    expect(again.changes).toEqual([]);
  });

  it("steps from the size still in the field, not the saved one", async () => {
    const { changes, field, button } = await mount();
    await page.type(field(), "16");
    await act(async () => button("Larger").click());
    expect(changes).toEqual([17]);
    await act(async () => { field().focus(); field().blur(); });
    expect(changes).toEqual([17]);
  });

  it("says an end's button goes no further without disabling it, and a press there changes nothing", async () => {
    const { changes, field, button } = await mount();
    expect(button("Larger").getAttribute("aria-disabled")).toBeNull();
    await page.type(field(), "22");
    expect(button("Larger").getAttribute("aria-disabled")).toBe("true");
    // a disabled button would drop the keyboard's focus to the page
    expect(button("Larger").hasAttribute("disabled")).toBe(false);
    await act(async () => button("Larger").click());
    expect(changes).toEqual([]);
    await page.type(field(), "10");
    expect(button("Smaller").getAttribute("aria-disabled")).toBe("true");
    expect(button("Larger").getAttribute("aria-disabled")).toBeNull();
    await act(async () => button("Smaller").click());
    expect(changes).toEqual([]);
  });

  it("names the range, and shows it under the field after a refused size until the next edit", async () => {
    const { field, range } = await mount();
    expect(range().textContent).toBe("Enter 10–22px");
    expect(range().className).toBe("visually-hidden");
    await page.type(field(), "30");
    await key(field(), "Enter", false);
    expect(range().className).toBe("settings-stepper-range");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    await page.type(field(), "1");
    expect(range().className).toBe("visually-hidden");
  });

  it("leaves Enter and Escape to an IME while it composes, then commits the finished number", async () => {
    const { changes, field } = await mount();
    await page.type(field(), "16");
    await key(field(), "Enter", true);
    expect(changes).toEqual([]);
    expect(field().value).toBe("16");
    await key(field(), "Escape", true);
    expect(field().value).toBe("16");
    await key(field(), "Enter", false);
    expect(changes).toEqual([16]);
  });

  it("reads a pasted number whole and refuses one out of range", async () => {
    const { changes, field } = await mount();
    await page.type(field(), "200");
    await key(field(), "Enter", false);
    expect(changes).toEqual([]);
    expect(field().value).toBe("14");
  });

  it("takes the full-width digits an IME types as the number, and shows it in plain digits once committed", async () => {
    const { changes, field, range } = await mount();
    await page.type(field(), "１６");
    expect(field().value).toBe("１６");
    expect(field().getAttribute("aria-invalid")).toBeNull();
    await key(field(), "Enter", false);
    expect(changes).toEqual([16]);
    expect(range().className).toBe("visually-hidden");
    expect(field().value).toBe("14");
    await page.type(field(), "１８");
    await act(async () => page.one<HTMLButtonElement>('button[aria-label="Larger"]').click());
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
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let page: Page;
  const rows = new Map<string, ReturnType<typeof useRowSentence>>();
  const row = (name = "a") => rows.get(name)!;

  function Row({ name, on }: { name: string; on: boolean }) {
    const sentence = useRowSentence(on);
    rows.set(name, sentence);
    return <div ref={sentence.row} data-row={name} {...sentence.rowEvents}><span className="settings-row-text">{name}</span></div>;
  }
  async function draw(shown: Record<string, boolean> = { a: true }): Promise<void> {
    await page.render(<><div aria-modal="true"><button id="settings-focus">Settings</button><input id="settings-input" />
      {Object.entries(shown).map(([name, on]) => <Row key={name} name={name} on={on} />)}
    </div><div aria-modal="true"><button id="palette-focus">Palette</button></div></>);
  }
  const does = (run: () => void): Promise<void> => act(async () => { run(); });
  const target = (name: string) => page.one(`[data-row="${name}"]`);
  const focusRow = (name: string) => Reflect.apply(target(name).dispatchEvent, target(name), [new page.window.FocusEvent("focusin", { bubbles: true })]);
  const focusAfter = (key: string, name = "a") => does(() => { inputWas({ key }); focusRow(name); });
  const focusLeaves = (name = "a") => does(() => {
    Reflect.apply(target(name).dispatchEvent, target(name), [new page.window.FocusEvent("focusout", { bubbles: true })]);
  });
  const drawn = (is = true, name = "a"): void => { row(name).drawn.current = is; };
  const pointer = (node: Element, type: string, pointerType: string) => does(() => {
    Reflect.apply(node.dispatchEvent, node, [new page.window.PointerEvent(type, { pointerType, bubbles: true })]);
  });
  const mouseEnters = (name = "a") => pointer(target(name), "pointerover", "mouse");
  const restEnds = () => does(() => { jest.runOnlyPendingTimers(); });
  async function tapName(name = "a"): Promise<void> {
    const nameText = page.one(`[data-row="${name}"] .settings-row-text`);
    await pointer(nameText, "pointerdown", "touch");
    await does(() => nameText.click());
  }
  async function escape({ isComposing = false }: { isComposing?: boolean } = {}): Promise<boolean> {
    let heard = false;
    const closeSettings = (): void => { heard = true; };
    window.addEventListener("keydown", closeSettings);
    try {
      await does(() => {
        const event = new page.window.KeyboardEvent("keydown", { key: "Escape", isComposing, bubbles: true, cancelable: true });
        Reflect.apply((document.activeElement ?? document.body).dispatchEvent, document.activeElement ?? document.body, [event]);
      });
    } finally { window.removeEventListener("keydown", closeSettings); }
    return heard;
  }

  beforeEach(() => {
    page = openPage();
    jest.useFakeTimers();
    Object.defineProperty(page.window, "setTimeout", { configurable: true, value: setTimeout });
    Object.defineProperty(page.window, "clearTimeout", { configurable: true, value: clearTimeout });
    for (const [name, value] of Object.entries({ HTMLElement: page.window.HTMLElement, HTMLInputElement: page.window.HTMLInputElement, HTMLTextAreaElement: page.window.HTMLTextAreaElement })) {
      descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, value });
    }
  });

  afterEach(async () => {
    jest.useRealTimers();
    await page.close();
    rows.clear();
    for (const [name, was] of descriptors) {
      if (was) Object.defineProperty(globalThis, name, was);
      else Reflect.deleteProperty(globalThis, name);
    }
    descriptors.clear();
  });

  it("shows on a focus the keyboard moved, not on one the app gives back after Escape or Enter, nor on a pointer's", async () => {
    await draw();
    await focusAfter("Escape");
    expect(row().shown).toBeNull();
    await focusAfter("Enter");
    expect(row().shown).toBeNull();
    await does(() => { inputWas("pointer"); focusRow("a"); });
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
    await does(() => page.one("#settings-input").focus());
    expect(await escape()).toBe(true);
    expect(row().shown).toBeNull();

    await show();
    expect(await escape({ isComposing: true })).toBe(true);
    expect(row().shown).toBe("focus");

    await does(() => page.one("#palette-focus").focus());
    expect(await escape()).toBe(true);
    expect(row().shown).toBeNull();

    await does(() => page.one("#settings-focus").focus());
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

    await pointer(target("a"), "pointerout", "mouse");
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
