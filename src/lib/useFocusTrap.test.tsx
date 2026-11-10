import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import { inFocusTrap, overlayStops, tabTarget, useFocusTrap } from "./useFocusTrap.ts";

describe("a dialog's Tab round and a device waiting for approval over it", () => {
  const keys = ["window", "document", "HTMLElement", "Element", "IS_REACT_ACT_ENVIRONMENT"];
  const saved = new Map<string, PropertyDescriptor | undefined>();
  class HTMLElement {
    isConnected = true;
    tabIndex = 0;
    disabled = false;
    /** under an inert column: the browser refuses it the focus */
    inert = false;
    /** not drawn: no box */
    hidden = false;
    /** the role of the surface it is in, as `closest` is asked for it ("dialog", "menu") */
    role: string | null = null;
    constructor(readonly name: string, readonly inside: HTMLElement[] = []) {}
    focus(): void { if (!this.inert && !this.disabled) page.activeElement = this; }
    hasAttribute(attribute: string): boolean { return attribute === "disabled" && this.disabled; }
    /** how often it was brought into view */
    scrolled = 0;
    scrollIntoView(): void { this.scrolled += 1; }
    getAttribute(): string | null { return null; }
    getClientRects(): unknown[] { return this.hidden ? [] : [{}]; }
    closest(selector: string): HTMLElement | null {
      if (selector === "[inert]") return this.inert ? this : null;
      return this.role !== null && selector.includes(`[role="${this.role}"]`) ? this : null;
    }
    contains(other: unknown): boolean { return other === this || this.inside.some((node) => node.contains(other)); }
    /** every element in it, in order: the hook filters what is a stop */
    querySelectorAll(): HTMLElement[] { return this.inside.flatMap((node) => [node, ...node.querySelectorAll()]); }
  }
  let page: { activeElement: HTMLElement | null; body: HTMLElement; prompts: HTMLElement[] };
  let events: EventTarget;
  let renderer: ReactTestRenderer | undefined;

  /** a prompt as RelayPairingPrompt draws it: a surface that takes the focus by script only, and its two buttons */
  function prompt(name: string): HTMLElement {
    const node = new HTMLElement(name, [new HTMLElement(`${name} Approve`), new HTMLElement(`${name} Decline`)]);
    node.tabIndex = -1;
    return node;
  }
  /** Settings: a button, a field, a button */
  function dialog(): HTMLElement {
    return new HTMLElement("settings", [new HTMLElement("back"), new HTMLElement("field"), new HTMLElement("close")]);
  }
  function Trap({ surface, paused }: { surface: HTMLElement; paused?: boolean }) {
    const ref = useFocusTrap<never>(true, { paused });
    (ref as { current: unknown }).current = surface;
    return null;
  }
  async function open(surface: HTMLElement): Promise<void> {
    await act(async () => { renderer = create(createElement(Trap, { surface })); });
  }
  /** Tab as the window hears it; true when the trap kept it from the browser */
  function tab(back = false): boolean {
    const event = Object.assign(new Event("keydown", { cancelable: true }), { key: "Tab", shiftKey: back });
    events.dispatchEvent(event);
    return event.defaultPrevented;
  }
  const focused = () => page.activeElement?.name ?? "nothing";

  beforeEach(() => {
    for (const key of keys) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    events = new EventTarget();
    page = { activeElement: null, body: new HTMLElement("body"), prompts: [] };
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "Element", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      get activeElement() { return page.activeElement; }, get body() { return page.body; },
      querySelectorAll: (selector: string) => selector === ".relay-pairing-prompt" ? page.prompts : [],
    } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  it("goes round the stops, and from what is no stop to the first or the last", () => {
    const [a, b, c] = [new HTMLElement("a") as never, new HTMLElement("b") as never, new HTMLElement("c") as never] as const;
    expect(tabTarget([a, b, c], a, false)).toBe(b);
    expect(tabTarget([a, b, c], c, false)).toBe(a);
    expect(tabTarget([a, b, c], a, true)).toBe(c);
    expect(tabTarget([a, b, c], b, true)).toBe(a);
    expect(tabTarget([a, b, c], new HTMLElement("elsewhere") as never, false)).toBe(a);
    expect(tabTarget([a, b, c], null, true)).toBe(c);
    expect(tabTarget([], a, false)).toBeUndefined();
  });

  it("counts each waiting prompt as a stop before its buttons, and none that cannot take the focus", () => {
    const [first, second, inert, hidden] = [prompt("p1"), prompt("p2"), prompt("inert"), prompt("hidden")];
    inert.inert = true;
    hidden.hidden = true;
    // Approve and Decline are disabled while a decision is on its way
    second.inside[0]!.disabled = true;
    second.inside[1]!.disabled = true;
    page.prompts = [first, inert, second, hidden];
    expect(overlayStops().map((node) => (node as unknown as HTMLElement).name)).toEqual(["p1", "p1 Approve", "p1 Decline", "p2"]);
    page.prompts = [];
    expect(overlayStops()).toEqual([]);
  });

  it("reaches a prompt from a field in the dialog by Tab, on the prompt itself, and comes back to the dialog", async () => {
    const settings = dialog();
    await open(settings);
    // the prompt arrives while a field has the focus: it leaves the focus there (RelayPairingPrompt's takesFocus)
    settings.inside[1]!.focus();
    page.prompts = [prompt("p1")];
    const walked: string[] = [];
    for (let step = 0; step < 6; step += 1) { expect(tab()).toBe(true); walked.push(focused()); }
    // never straight from the dialog onto Approve: a Tab and an Enter typed for the field press nothing
    expect(walked).toEqual(["close", "p1", "p1 Approve", "p1 Decline", "back", "field"]);
  });

  it("reaches the prompt backwards from the dialog's first stop, and leaves it backwards into the dialog", async () => {
    const settings = dialog();
    await open(settings);
    expect(focused()).toBe("back");
    page.prompts = [prompt("p1"), prompt("p2")];
    const walked: string[] = [];
    for (let step = 0; step < 7; step += 1) { expect(tab(true)).toBe(true); walked.push(focused()); }
    expect(walked).toEqual(["p2 Decline", "p2 Approve", "p2", "p1 Decline", "p1 Approve", "p1", "close"]);
  });

  it("keeps Tab in the dialog when no device waits, and when the prompt cannot take the focus", async () => {
    const settings = dialog();
    await open(settings);
    settings.inside[2]!.focus();
    expect(tab()).toBe(true);
    expect(focused()).toBe("back");
    const refused = prompt("p1");
    refused.inert = true;
    page.prompts = [refused];
    expect(tab(true)).toBe(true);
    expect(focused()).toBe("close");
  });

  it("goes to the prompt when every control of the dialog is disabled, and nowhere when no device waits", async () => {
    const working = new HTMLElement("working", [new HTMLElement("only")]);
    working.inside[0]!.disabled = true;
    working.tabIndex = -1;
    await open(working);
    expect(focused()).toBe("working");
    expect(tab()).toBe(true);
    expect(focused()).toBe("working");
    page.prompts = [prompt("p1")];
    expect(tab()).toBe(true);
    expect(focused()).toBe("p1");
    expect(tab()).toBe(true);
    expect(focused()).toBe("p1 Approve");
  });

  it("knows what is in a surface it holds Tab in, for as long as it does", async () => {
    // what a prompt over the page may take the focus from (RelayPairingPrompt's takesFocus): Tab leads back here
    const settings = dialog();
    const [field, elsewhere] = [settings.inside[1] as never, new HTMLElement("history button") as never];
    expect(inFocusTrap(field)).toBe(false);
    await open(settings);
    expect([inFocusTrap(field), inFocusTrap(settings as never), inFocusTrap(elsewhere)]).toEqual([true, true, false]);
    await act(async () => { renderer!.update(createElement(Trap, { surface: settings, paused: true })); });
    expect(inFocusTrap(field)).toBe(false);
    await act(async () => { renderer!.update(createElement(Trap, { surface: settings })); });
    expect(inFocusTrap(field)).toBe(true);
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    expect(inFocusTrap(field)).toBe(false);
  });

  it("brings a prompt into view when Tab lands on it or on one of its buttons", async () => {
    // several devices in a short window: the stack scrolls, and what is about to be approved must be read
    const settings = dialog();
    await open(settings);
    settings.inside[2]!.focus();
    const [first, second] = [prompt("p1"), prompt("p2")];
    page.prompts = [first, second];
    const seen: string[] = [];
    for (let step = 0; step < 7; step += 1) {
      tab();
      seen.push(`${focused()}: ${first.scrolled} ${second.scrolled} ${page.activeElement === first || page.activeElement === second ? "-" : page.activeElement!.scrolled}`);
    }
    // the prompt first (its number and words), then the button on it; nothing of the dialog's is scrolled
    expect(seen).toEqual(["p1: 1 0 -", "p1 Approve: 2 0 1", "p1 Decline: 3 0 1", "p2: 3 1 -", "p2 Approve: 3 2 1", "p2 Decline: 3 3 1", "back: 3 3 0"]);
  });

  it("leaves Tab to a menu or another dialog that has the focus, and to nothing while paused", async () => {
    const settings = dialog();
    await open(settings);
    page.prompts = [prompt("p1")];
    const item = new HTMLElement("menu item");
    item.role = "menu";
    page.activeElement = item;
    expect(tab()).toBe(false);
    expect(focused()).toBe("menu item");
    await act(async () => { renderer!.update(createElement(Trap, { surface: settings, paused: true })); });
    settings.inside[1]!.focus();
    expect(tab()).toBe(false);
    expect(focused()).toBe("field");
  });
});
