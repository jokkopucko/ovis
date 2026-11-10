import { afterEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import { Stepper, typedStep } from "./SettingsControls.tsx";

/** A key on the size field, as React hands it over: `composing` while an IME still holds the draft. */
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
    // Settings closed by a swipe or the system Back: no blur comes
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
    // the draft is resolved: a later blur does not put 16 back
    act(() => field().props.onBlur());
    expect(changes).toEqual([17]);
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
    // the IME's own Enter confirms its text: the draft is not committed yet
    act(() => field().props.onKeyDown(key("Enter", true)));
    expect(changes).toEqual([]);
    expect(field().props.value).toBe("16");
    // nor does its Escape throw the draft away
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
    // the text is the IME's until the commit: it is not rewritten under the composition
    expect(field().props.value).toBe("１６");
    expect(field().props["aria-invalid"]).toBeUndefined();
    act(() => field().props.onKeyDown(key("Enter", false)));
    expect(changes).toEqual([16]);
    expect(range().props.className).toBe("visually-hidden");
    expect(field().props.value).toBe("14");
    // the -/+ buttons step from a full-width size still in the field
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
