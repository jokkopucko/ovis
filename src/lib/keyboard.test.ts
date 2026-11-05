import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DISMISS_DRAG_PX, dismissKeyboardOn, dragDismisses, keyboardHoldsGrid, scrolledDown, tapDismisses } from "./keyboard.ts";

describe("dragDismisses", () => {
  test("a drag down the transcript puts the keyboard away", () => {
    expect(dragDismisses(0, DISMISS_DRAG_PX)).toBe(true);
    expect(dragDismisses(10, 80)).toBe(true);
  });

  test("a short, upward or sideways drag leaves it up", () => {
    expect(dragDismisses(0, DISMISS_DRAG_PX - 1)).toBe(false);
    expect(dragDismisses(0, -80)).toBe(false);
    expect(dragDismisses(90, 40)).toBe(false);
  });
});

describe("tapDismisses", () => {
  test("a tap with no element or on plain transcript reads", () => {
    expect(tapDismisses(null, "")).toBe(true);
  });

  test("a tap that ends a text selection keeps the keyboard", () => {
    expect(tapDismisses(null, "copied words")).toBe(false);
  });
});

/** The transcript's listeners, on a stand-in node and document, with the keyboard up. */
describe("dismissKeyboardOn", () => {
  type Handler = (event: unknown) => void;
  const names = ["window", "document", "HTMLElement"] as const;
  let saved: Record<string, unknown>;
  let selection: string;
  let blurred: number;

  beforeEach(() => {
    saved = Object.fromEntries(names.map((name) => [name, (globalThis as Record<string, unknown>)[name]]));
    selection = "";
    blurred = 0;
    class Element { blur(): void { blurred++; } }
    (globalThis as Record<string, unknown>)["HTMLElement"] = Element;
    (globalThis as Record<string, unknown>)["window"] = { getSelection: () => ({ toString: () => selection }) };
    (globalThis as Record<string, unknown>)["document"] = { documentElement: { hasAttribute: () => true }, activeElement: new Element() };
  });
  afterEach(() => {
    for (const name of names) (globalThis as Record<string, unknown>)[name] = saved[name];
  });

  const drag = (target: unknown, during?: () => void, card?: { scrollTop: number }): number => {
    const listeners = new Map<string, Handler>();
    const node = { ...card, addEventListener: (type: string, handler: Handler) => listeners.set(type, handler), removeEventListener: () => {} };
    const stop = dismissKeyboardOn(node as unknown as HTMLElement, { atTopOnly: card !== undefined });
    const touch = (y: number) => ({ target, touches: [{ clientX: 100, clientY: y }] });
    listeners.get("touchstart")!(touch(200));
    during?.();
    listeners.get("touchmove")!(touch(200 + DISMISS_DRAG_PX + 10));
    stop();
    return blurred;
  };

  test("a drag down plain transcript puts the keyboard away", () => {
    expect(drag({ closest: () => null })).toBe(1);
  });

  test("a drag that became a text selection after it started keeps the keyboard", () => {
    expect(drag({ closest: () => null }, () => { selection = "picked words"; })).toBe(0);
  });

  test("a drag that starts on a field in the transcript keeps the keyboard", () => {
    expect(drag({ closest: (selector: string) => (selector.includes("input") ? {} : null) })).toBe(0);
  });

  test("a drag down a prompt card at its top puts the keyboard away", () => {
    expect(drag({ closest: () => null }, undefined, { scrollTop: 0 })).toBe(1);
  });

  test("a drag down a scrolled prompt card scrolls it back and keeps the keyboard", () => {
    expect(drag({ closest: () => null }, undefined, { scrollTop: 40 })).toBe(0);
  });

  test("a drag down the card's scrolled reference text keeps the keyboard", () => {
    expect(drag({ closest: () => null, scrollTop: 12, parentElement: null }, undefined, { scrollTop: 0 })).toBe(0);
  });
});

describe("scrolledDown", () => {
  test("looks at every scroller from the touched element up to the node, and no further", () => {
    const page = { scrollTop: 300, parentElement: null };
    const card = { scrollTop: 0, parentElement: page };
    const body = { scrollTop: 0, parentElement: card };
    const line = { parentElement: body };
    expect(scrolledDown(line, card)).toBe(false);
    body.scrollTop = 8;
    expect(scrolledDown(line, card)).toBe(true);
    body.scrollTop = 0;
    card.scrollTop = 8;
    expect(scrolledDown(line, card)).toBe(true);
    expect(scrolledDown(null, card)).toBe(true);
  });
});

/** #1045: the keyboard takes the bottom of the screen, not the pane; the shared pty keeps its grid */
describe("keyboardHoldsGrid", () => {
  test("a host that only lost height under the keyboard keeps its grid (regression: fails on main)", () => {
    expect(keyboardHoldsGrid(true, 390, 390)).toBe(true);
  });

  test("a first fit under the keyboard waits for it to go (regression: fails on main)", () => {
    expect(keyboardHoldsGrid(true, 390, null)).toBe(true);
  });

  test("a host whose width changed under the keyboard (a rotation) refits (control)", () => {
    expect(keyboardHoldsGrid(true, 430, 390)).toBe(false);
    expect(keyboardHoldsGrid(true, 390, 430)).toBe(false);
  });

  test("without the keyboard every resize refits, the first one too (control)", () => {
    expect(keyboardHoldsGrid(false, 390, 390)).toBe(false);
    expect(keyboardHoldsGrid(false, 390, null)).toBe(false);
    expect(keyboardHoldsGrid(false, 450, 390)).toBe(false);
  });
});
