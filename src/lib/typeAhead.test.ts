import { describe, expect, it } from "bun:test";
import { paneStorageId } from "../../shared/machines.ts";
import { catchTypeAhead, takeTypeAhead, typeAheadKey } from "./typeAhead.ts";
import { markTyped } from "./ws.ts";

/** The few DOM pieces the catch's hidden field uses, until restored. */
function fakeDocument(): { field: () => EventTarget & { value: string }; restore: () => void } {
  const globals = globalThis as unknown as Record<string, unknown>;
  const before = { document: globals["document"], window: globals["window"], HTMLElement: globals["HTMLElement"] };
  class Field extends EventTarget {
    value = "";
    className = "";
    style = {};
    setAttribute(): void {}
    focus(): void { page.activeElement = this; }
    blur(): void { if (page.activeElement === this) page.activeElement = null; }
    remove(): void {}
  }
  let made: Field | null = null;
  const page = {
    activeElement: null as Field | null,
    body: { appendChild: () => {} },
    hasFocus: () => true,
    createElement: () => { made = new Field(); return made; },
  };
  globals["document"] = page;
  globals["window"] = globalThis;
  globals["HTMLElement"] = Field;
  return {
    field: () => made!,
    restore: () => { for (const [name, value] of Object.entries(before)) globals[name] = value; },
  };
}

const event = (type: string, fields: Record<string, unknown> = {}): Event => Object.assign(new Event(type, { cancelable: true }), fields);
const keyDown = (key: string): Event => event("keydown", { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0 });

describe("catchTypeAhead", () => {
  it("marks each caught key when it is typed, a composition when it began, never when the catch opened", () => {
    const dom = fakeDocument();
    try {
      const caught = catchTypeAhead()!;
      caught.handTo("local", "w1:p1");
      const opened = markTyped();
      const field = dom.field();
      field.value = "ls";
      field.dispatchEvent(event("input"));
      field.dispatchEvent(keyDown("Enter"));
      field.dispatchEvent(event("compositionstart"));
      const composing = markTyped();
      field.value = "한";
      field.dispatchEvent(event("input", { isComposing: true }));
      field.dispatchEvent(event("compositionend"));
      // a composition that commits nothing leaves no mark behind for the text typed after it
      field.dispatchEvent(event("compositionstart"));
      field.dispatchEvent(event("compositionend"));
      const cancelled = markTyped();
      field.value = "x";
      field.dispatchEvent(event("input"));
      const taken = takeTypeAhead(paneStorageId("local", "w1:p1"), { more: () => {}, done: () => {} })!;
      expect(taken.items.map((item) => item.input)).toEqual(["ls", "\r", "한", "x"]);
      const [ls, enter, composed, after] = taken.items;
      expect(ls!.typedAt).toBeGreaterThan(opened);
      expect(enter!.typedAt).toBeGreaterThan(ls!.typedAt);
      expect(composed!.typedAt).toBeGreaterThan(enter!.typedAt);
      expect(composed!.typedAt).toBeLessThan(composing);
      expect(after!.typedAt).toBeGreaterThan(cancelled);
    } finally {
      dom.restore();
    }
  });
});

const key = (name: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  typeAheadKey({ key: name, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe("typeAheadKey", () => {
  it("sends the keys a shell line needs as the terminal does", () => {
    expect(key("Enter")).toEqual({ input: "\r" });
    expect(key("Enter", { shiftKey: true })).toEqual({ input: "\x1b\r" });
    expect(key("Tab")).toEqual({ input: "\t" });
    expect(key("Tab", { shiftKey: true })).toEqual({ input: "\x1b[Z" });
    expect(key("Escape")).toEqual({ input: "\x1b" });
    expect(key("ArrowLeft")).toEqual({ input: "\x1b[D", arrow: "ArrowLeft" });
    expect(key("c", { ctrlKey: true })).toEqual({ input: "\x03" });
    expect(key("U", { ctrlKey: true })).toEqual({ input: "\x15" });
  });

  it("erases and moves as the terminal does", () => {
    expect(key("Backspace")).toEqual({ input: "\x7f" });
    expect(key("Backspace", { altKey: true })).toEqual({ input: "\x1b\x7f" });
    expect(key("Backspace", { ctrlKey: true })).toEqual({ input: "\b" });
    expect(key("Backspace", { metaKey: true })).toEqual({ input: "\x15" });
    expect(key("Delete")).toEqual({ input: "\x1b[3~" });
    expect(key("Home")).toEqual({ input: "\x1b[H" });
    expect(key("End")).toEqual({ input: "\x1b[F" });
    expect(key("ArrowLeft", { metaKey: true })).toEqual({ input: "\x01" });
    expect(key("ArrowRight", { metaKey: true })).toEqual({ input: "\x05" });
  });

  it("holds the catch for an editing key it cannot be sure of", () => {
    expect(key("ArrowLeft", { altKey: true })).toBe("hold");
    expect(key("ArrowRight", { ctrlKey: true })).toBe("hold");
    expect(key("Delete", { ctrlKey: true })).toBe("hold");
    expect(key("Enter", { ctrlKey: true })).toBe("hold");
    expect(key("b", { altKey: true })).toBe("hold");
  });

  it("leaves text, the browser's paste and its shortcuts to the browser", () => {
    expect(key("a")).toBeNull();
    expect(key("v", { ctrlKey: true })).toBeNull();
    expect(key("t", { metaKey: true })).toBeNull();
    expect(key("K", { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(key("F5")).toBeNull();
  });
});
