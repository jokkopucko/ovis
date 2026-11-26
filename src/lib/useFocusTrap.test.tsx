import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";

import { openPage, type Page } from "./page.fixture.ts";
import { inFocusTrap, overlayStops, tabTarget, useFocusTrap } from "./useFocusTrap.ts";

describe("a dialog's Tab round and a device waiting for approval over it", () => {
  const keys = ["HTMLElement", "Element"] as const;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let page: Page;
  let scrolls: Map<Element, number>;
  const doc = () => page.container.ownerDocument;
  const scrolled = (node: Element | null) => node === null ? 0 : scrolls.get(node) ?? 0;
  function node<K extends "div" | "button">(tag: K, name: string, ...children: HTMLElement[]): HTMLElementTagNameMap[K] {
    const element = doc().createElement(tag);
    element.dataset.name = name;
    element.append(...children);
    Object.defineProperties(element, {
      getClientRects: { value: () => element.hidden ? [] : [new page.window.DOMRect(0, 0, 1, 1)] },
      scrollIntoView: { value: () => scrolls.set(element, scrolled(element) + 1) },
    });
    return element;
  }

  function prompt(name: string): HTMLElement {
    const prompt = node("div", name, node("button", `${name} Approve`), node("button", `${name} Decline`));
    prompt.tabIndex = -1;
    prompt.className = "relay-pairing-prompt";
    return prompt;
  }
  function dialog(): HTMLElement {
    return node("div", "settings", node("button", "back"), node("button", "field"), node("button", "close"));
  }
  function showPrompts(...prompts: HTMLElement[]): void {
    for (const prompt of doc().querySelectorAll(".relay-pairing-prompt")) prompt.remove();
    doc().body.append(...prompts);
  }
  function Trap({ surface, paused }: { surface: HTMLElement; paused?: boolean }) {
    const ref = useFocusTrap<HTMLElement>(true, { paused });
    ref.current = surface;
    return null;
  }
  async function open(surface: HTMLElement): Promise<void> {
    doc().body.append(surface);
    await page.render(createElement(Trap, { surface }));
  }
  async function tab(back = false): Promise<boolean> {
    const event = new page.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: back, bubbles: true, cancelable: true });
    await act(async () => { page.window.dispatchEvent(event); });
    return event.defaultPrevented;
  }
  const focused = () => doc().activeElement?.getAttribute("data-name") ?? "nothing";
  const button = (surface: HTMLElement, name: string) => surface.querySelector<HTMLButtonElement>(`button[data-name="${name}"]`)!;

  beforeEach(() => {
    for (const key of keys) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    page = openPage();
    scrolls = new Map();
    for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: page.window[key] });
  });

  afterEach(async () => {
    await page.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  it("goes round the stops, and from what is no stop to the first or the last", () => {
    const [a, b, c] = [node("button", "a"), node("button", "b"), node("button", "c")] as const;
    expect(tabTarget([a, b, c], a, false)).toBe(b);
    expect(tabTarget([a, b, c], c, false)).toBe(a);
    expect(tabTarget([a, b, c], a, true)).toBe(c);
    expect(tabTarget([a, b, c], b, true)).toBe(a);
    expect(tabTarget([a, b, c], node("button", "elsewhere"), false)).toBe(a);
    expect(tabTarget([a, b, c], null, true)).toBe(c);
    expect(tabTarget([], a, false)).toBeUndefined();
  });

  it("counts each waiting prompt as a stop before its buttons, and none that cannot take the focus", () => {
    const [first, second, inert, hidden] = [prompt("p1"), prompt("p2"), prompt("inert"), prompt("hidden")];
    inert.setAttribute("inert", "");
    hidden.hidden = true;
    button(second, "p2 Approve").disabled = true;
    button(second, "p2 Decline").disabled = true;
    showPrompts(first, inert, second, hidden);
    expect(overlayStops().map((node) => node.dataset.name)).toEqual(["p1", "p1 Approve", "p1 Decline", "p2"]);
    showPrompts();
    expect(overlayStops()).toEqual([]);
  });

  it("reaches a prompt from a field in the dialog by Tab, on the prompt itself, and comes back to the dialog", async () => {
    const settings = dialog();
    await open(settings);
    button(settings, "field").focus();
    showPrompts(prompt("p1"));
    const walked: string[] = [];
    for (let step = 0; step < 6; step += 1) { expect(await tab()).toBe(true); walked.push(focused()); }
    // never straight from the dialog onto Approve: a Tab and an Enter typed for the field press nothing
    expect(walked).toEqual(["close", "p1", "p1 Approve", "p1 Decline", "back", "field"]);
  });

  it("reaches the prompt backwards from the dialog's first stop, on the prompt itself, and leaves it backwards into the dialog", async () => {
    const settings = dialog();
    await open(settings);
    expect(focused()).toBe("back");
    showPrompts(prompt("p1"), prompt("p2"));
    const walked: string[] = [];
    for (let step = 0; step < 7; step += 1) { expect(await tab(true)).toBe(true); walked.push(focused()); }
    // never from outside a prompt onto one of its buttons: Shift+Tab twice and an Enter typed for the dialog press nothing
    expect(walked).toEqual(["p2", "p1", "close", "field", "back", "p2", "p1"]);
  });

  it("walks a prompt's own buttons in both directions once the focus is in it", async () => {
    const settings = dialog();
    await open(settings);
    const [first, second] = [prompt("p1"), prompt("p2")];
    showPrompts(first, second);
    second.focus();
    const walked: string[] = [];
    for (const back of [false, false, true, true, true]) { expect(await tab(back)).toBe(true); walked.push(focused()); }
    expect(walked).toEqual(["p2 Approve", "p2 Decline", "p2 Approve", "p2", "p1"]);
  });

  it("keeps Tab in the dialog when no device waits, and when the prompt cannot take the focus", async () => {
    const settings = dialog();
    await open(settings);
    button(settings, "close").focus();
    expect(await tab()).toBe(true);
    expect(focused()).toBe("back");
    const refused = prompt("p1");
    refused.setAttribute("inert", "");
    showPrompts(refused);
    expect(await tab(true)).toBe(true);
    expect(focused()).toBe("close");
  });

  it("goes to the prompt when every control of the dialog is disabled, and nowhere when no device waits", async () => {
    const only = node("button", "only");
    only.disabled = true;
    const working = node("div", "working", only);
    working.tabIndex = -1;
    await open(working);
    expect(focused()).toBe("working");
    expect(await tab()).toBe(true);
    expect(focused()).toBe("working");
    showPrompts(prompt("p1"));
    expect(await tab()).toBe(true);
    expect(focused()).toBe("p1");
    expect(await tab()).toBe(true);
    expect(focused()).toBe("p1 Approve");
  });

  it("knows what is in a surface it holds Tab in, for as long as it does", async () => {
    const settings = dialog();
    const [field, elsewhere] = [button(settings, "field"), node("button", "history button")];
    expect(inFocusTrap(field)).toBe(false);
    await open(settings);
    expect([inFocusTrap(field), inFocusTrap(settings), inFocusTrap(elsewhere)]).toEqual([true, true, false]);
    await page.render(createElement(Trap, { surface: settings, paused: true }));
    expect(inFocusTrap(field)).toBe(false);
    await page.render(createElement(Trap, { surface: settings }));
    expect(inFocusTrap(field)).toBe(true);
    await page.render(null);
    expect(inFocusTrap(field)).toBe(false);
  });

  it("brings a prompt into view when Tab lands on it or on one of its buttons", async () => {
    const settings = dialog();
    await open(settings);
    button(settings, "close").focus();
    const [first, second] = [prompt("p1"), prompt("p2")];
    showPrompts(first, second);
    const seen: string[] = [];
    for (let step = 0; step < 7; step += 1) {
      await tab();
      const active = doc().activeElement;
      seen.push(`${focused()}: ${scrolled(first)} ${scrolled(second)} ${active === first || active === second ? "-" : scrolled(active)}`);
    }
    expect(seen).toEqual(["p1: 1 0 -", "p1 Approve: 2 0 1", "p1 Decline: 3 0 1", "p2: 3 1 -", "p2 Approve: 3 2 1", "p2 Decline: 3 3 1", "back: 3 3 0"]);
  });

  it("leaves Tab to a menu or another dialog that has the focus, and to nothing while paused", async () => {
    const settings = dialog();
    await open(settings);
    showPrompts(prompt("p1"));
    const item = node("button", "menu item");
    item.role = "menu";
    doc().body.append(item);
    item.focus();
    expect(await tab()).toBe(false);
    expect(focused()).toBe("menu item");
    await page.render(createElement(Trap, { surface: settings, paused: true }));
    button(settings, "field").focus();
    expect(await tab()).toBe(false);
    expect(focused()).toBe("field");
  });
});
