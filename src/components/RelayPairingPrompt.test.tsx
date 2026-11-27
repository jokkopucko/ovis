import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { act, createElement, StrictMode, type ReactNode } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { RelayPairingRequest } from "../../shared/protocol.ts";
import { translate } from "../lib/i18n.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { APPROVE_KEY_GUARD_MS, APPROVE_POINTER_GUARD_MS, INPUT_AGE_MAX_MS, RelayPairingPrompt, aroundDigits, deadlineOf, firstJoinPrompts, inputAge, listAddPrompts, pendingKeyPrompts, secondsLeft, takesFocus } from "./RelayPairingPrompt.tsx";

const AT = Date.parse("2026-11-10T00:00:00.000Z");
const request = (over: Partial<RelayPairingRequest> = {}): RelayPairingRequest => ({ id: "p1", label: "Hako's iPhone", digits: "725403", expires_at: new Date(AT + 90_000).toISOString(), ...over });

const text = (node: Element): string => node.textContent ?? "";

describe("the PC's prompt for a device waiting for approval", () => {
  let page: Page;
  let decided: [string, unknown][];
  const browserGlobals = ["HTMLElement", "Element", "Node", "Event", "CustomEvent", "fetch"] as const;
  const savedBrowserGlobals = new Map<(typeof browserGlobals)[number], PropertyDescriptor | undefined>();
  let settings: HTMLElement;
  let opener: HTMLElement;
  let shift: number;
  let strict: boolean;
  let inert: boolean;
  let focusCalls: WeakMap<HTMLElement, number>;
  let scrollCalls: WeakMap<HTMLElement, number>;
  let nativeFocus: (this: HTMLElement) => void;

  function Held() {
    const ref = useFocusTrap<HTMLElement>(true);
    ref.current = settings;
    return null;
  }
  const makeNode = (tag: string, parent: Element = document.body): HTMLElement => {
    const node = document.createElement(tag);
    node.tabIndex = -1;
    parent.append(node);
    return node;
  };
  const inSettings = (tag = "button") => makeNode(tag, settings);
  const setActive = (node: HTMLElement) => {
    if (node === document.body && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    else nativeFocus.call(node);
  };
  const draw = (node: ReactNode) => {
    const tree = <><Held />{node}</>;
    return page.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  };

  beforeEach(async () => {
    page = openPage("http://127.0.0.1:7421/");
    for (const key of browserGlobals) {
      savedBrowserGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      if (key !== "fetch") Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: page.window[key] });
    }
    decided = [];
    inert = false;
    shift = 0;
    strict = false;
    focusCalls = new WeakMap();
    scrollCalls = new WeakMap();
    nativeFocus = window.HTMLElement.prototype.focus;
    Object.defineProperties(window.HTMLElement.prototype, {
      focus: { configurable: true, value: function (this: HTMLElement) {
        focusCalls.set(this, (focusCalls.get(this) ?? 0) + 1);
        if (!inert || !this.matches(".relay-pairing-prompt")) nativeFocus.call(this);
      } },
      scrollIntoView: { configurable: true, value: function (this: HTMLElement) {
        scrollCalls.set(this, (scrollCalls.get(this) ?? 0) + 1);
        if (this.parentElement?.matches(".relay-pairing-layer")) this.parentElement.scrollTop += shift;
      } },
    });
    // React restores the pre-commit focus; a body without tabindex cannot take it in a browser.
    Object.defineProperty(document.body, "focus", { configurable: true, value: () => {} });
    settings = makeNode("div");
    settings.setAttribute("aria-modal", "true");
    opener = inSettings();
    setActive(opener);
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: unknown, init?: RequestInit) => {
      decided.push([new URL(String(input), "http://127.0.0.1:7421").pathname, init?.body === undefined ? null : JSON.parse(String(init.body))]);
      expect(init?.method).toBe("POST");
      return new Response(null, { status: 204 });
    } });
    await draw(null);
    jest.useFakeTimers();
    jest.setSystemTime(AT);
  });

  afterEach(async () => {
    jest.useRealTimers();
    try { await page.close(); } finally {
      for (const [key, descriptor] of savedBrowserGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      savedBrowserGlobals.clear();
    }
  });

  const element = (pairings: RelayPairingRequest[]) => createElement(SettingsProvider, null, createElement(RelayPairingPrompt, { pairings }));
  async function show(pairings: RelayPairingRequest[]): Promise<HTMLElement> {
    await draw(element(pairings));
    return page.container;
  }
  const prompts = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('div[data-testid="relay-pairing-prompt"]')];
  const one = (root: Element, selector: string): HTMLElement => {
    const found = root.querySelectorAll<HTMLElement>(selector);
    if (found.length !== 1 || !found[0]) throw new Error(`Expected one element matching ${selector}`);
    return found[0];
  };
  const sentence = (prompt: HTMLElement) => text(one(prompt, `span[id="${prompt.getAttribute("aria-labelledby")}"]`));
  const left = (prompt: HTMLElement) => text(one(prompt, '[data-testid="relay-pairing-left"]')).trim();
  const focusEvent = (node: HTMLElement, type: "focusin" | "focusout", relatedTarget: HTMLElement | null) => {
    node.dispatchEvent(new window.FocusEvent(type, { bubbles: true, relatedTarget }));
  };
  function click(button: HTMLButtonElement, { detail, timeStamp }: { detail: number; timeStamp?: number }): void {
    const event = new window.MouseEvent("click", { bubbles: true, cancelable: true, detail });
    Object.defineProperty(event, "timeStamp", { value: timeStamp ?? performance.now() });
    button.dispatchEvent(event);
  }

  const SENTENCE = "{name} wants to add this PC to your account. Type {digits} on {name}, or check that {name} shows the same number, then press Approve here.";
  /** a click a pointer made; one a key made has detail 0, the second of a double-click 2 */
  const POINTER = { detail: 1 };
  const KEY = { detail: 0 };
  const SECOND_CLICK = { detail: 2 };
  const approveOf = (prompt: HTMLElement) => prompt.querySelectorAll("button")[0]!;
  const approved = () => decided.map(([, body]) => (body as { id: string }).id);

  it("tells the owner to type the number on the other device when this PC waits to be added", async () => {
    const [prompt] = prompts(await show([request({ local_only: true })]));
    expect(sentence(prompt!)).toBe("Hako's iPhone wants to add this PC to your account. Type 725 403 on Hako's iPhone, or check that Hako's iPhone shows the same number, then press Approve here.");
    expect(text(one(prompt!, "strong"))).toBe("725 403");
    expect(prompt!.getAttribute("data-local-only")).toBe("true");
  });

  it("keeps the whole sentence whatever the asking device calls itself", async () => {
    // the label is the other device's to choose (shared/relay-mux.ts pairLabel limits its length only)
    for (const label of ["Hako's iPhone\u0000", "\u0000", "{digits}", "a {digits} b {name} c", "$& $1 $`"]) {
      const [prompt] = prompts(await show([request({ local_only: true, label })]));
      const drawn = sentence(prompt!);
      const [before, after] = SENTENCE.split("{digits}").map((part) => part.replaceAll("{name}", () => label));
      expect(drawn).toBe(`${before}725 403${after}`);
      expect(drawn.startsWith(`${label} wants to add this PC to your account. Type 725 403 on ${label}, or check`)).toBe(true);
      expect(drawn.endsWith(`or check that ${label} shows the same number, then press Approve here.`)).toBe(true);
      expect([...prompt!.querySelectorAll("strong")].map(text)).toEqual(["725 403"]);
      await draw(null);
      setActive(opener);
    }
    expect(aroundDigits("a {name} {digits} b {name}", "{digits}")).toEqual(["a {digits} ", " b {digits}"]);
    expect(aroundDigits("no place for them {name}", "x")).toEqual(["no place for them x ", ""]);
    const [compared] = prompts(await show([request({ label: "x\u0000{digits}{name}" })]));
    expect(sentence(compared!)).toBe("x\u0000{digits}{name} wants to pair through the relay. Approve it only if its screen shows 725 403");
  });

  it("asks to compare the digits when the other device shows them", async () => {
    const [prompt] = prompts(await show([request()]));
    expect(sentence(prompt!)).toBe("Hako's iPhone wants to pair through the relay. Approve it only if its screen shows 725 403");
    expect(prompt!.getAttribute("data-local-only")).toBeNull();
    expect([...prompt!.querySelectorAll('[data-testid="relay-pairing-check"]')]).toHaveLength(0);
    await draw(element([request({ local_only: false })]));
    expect(sentence(prompts(page.container)[0]!)).toContain("Approve it only if its screen shows");
  });

  it("counts the seconds left down from expires_at and stops at 0", async () => {
    const root = await show([request()]);
    expect(left(prompts(root)[0]!)).toBe("90 s left");
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(left(prompts(root)[0]!)).toBe("89 s left");
    await act(async () => { jest.advanceTimersByTime(88_000); });
    expect(left(prompts(root)[0]!)).toBe("1 s left");
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(left(prompts(root)[0]!)).toBe("0 s left");
    await act(async () => { jest.advanceTimersByTime(30_000); });
    expect(left(prompts(root)[0]!)).toBe("0 s left");
  });

  it("counts from what the PC said is left, not from a clock that differs from the PC's", async () => {
    const fast = request({ expires_at: new Date(AT - 30_000).toISOString(), left_ms: 90_000 });
    const root = await show([fast]);
    expect(left(prompts(root)[0]!)).toBe("90 s left");
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(left(prompts(root)[0]!)).toBe("30 s left");
    await draw(element([{ ...fast, left_ms: 30_000 }, request({ id: "p2", label: "desk2", expires_at: new Date(AT - 30_000 + 60_000).toISOString(), left_ms: 90_000 })]));
    expect(prompts(root).map(left)).toEqual(["30 s left", "90 s left"]);
    await act(async () => { jest.advanceTimersByTime(31_000); });
    expect(prompts(root).map(left)).toEqual(["0 s left", "59 s left"]);
    const slow = request({ id: "p3", expires_at: new Date(Date.now() + 210_000).toISOString(), left_ms: 90_000 });
    await draw(element([slow]));
    expect(prompts(root).map(left)).toEqual(["90 s left"]);
    expect(deadlineOf(slow, Date.now() + 5000)).toBe(Date.now() + 90_000);
    expect(deadlineOf(request({ left_ms: Number.NaN }), AT)).toBe(AT + 90_000);
    expect(deadlineOf(request({ left_ms: -1 }), AT)).toBe(AT + 90_000);
  });

  it("shows no time for a request without one it can read", async () => {
    const root = await show([request({ expires_at: "" })]);
    expect([...root.querySelectorAll('[data-testid="relay-pairing-left"]')]).toEqual([]);
    expect(deadlineOf(request({ expires_at: "" }), AT)).toBeNull();
    expect(secondsLeft(AT + 1, AT)).toBe(1);
    expect(secondsLeft(AT - 5000, AT)).toBe(0);
  });

  it("is a named group, not a dialog, in a layer labelled for devices", async () => {
    const root = await show([request()]);
    const [prompt] = prompts(root);
    // an alertdialog would count as a cover for every "a dialog is open" check on the page: Escape in
    // Connect a phone and in the phone drawer, the pane's cover, the web popup's trap
    expect(prompt!.getAttribute("role")).toBe("group");
    expect(prompt!.getAttribute("aria-modal")).toBeNull();
    expect([...root.querySelectorAll('[role="alertdialog"], [role="dialog"]')]).toEqual([]);
    expect(prompt!.tabIndex).toBe(-1);
    expect(String(prompt!.className).split(" ")).toContain("relay-pairing-prompt");
    expect(sentence(prompt!)).toContain("Hako's iPhone");
    expect(one(prompt!, '[data-testid="relay-pairing-left"]').getAttribute("aria-live")).toBe("off");
    const layer = one(root, ".relay-pairing-layer");
    expect(layer.getAttribute("aria-label")).toBe("Devices waiting for approval");
    expect(layer.getAttribute("aria-live")).toBe("assertive");
  });

  it("takes the focus from a dialog on the prompt itself, never on Approve, and gives it back when the prompt goes", async () => {
    const root = await show([request()]);
    const node = prompts(root)[0]!;
    expect(document.activeElement).toBe(node);
    expect(node.getAttribute("data-testid")).toBe("relay-pairing-prompt");
    expect(focusCalls.get(node) ?? 0).toBe(1);
    await act(async () => { jest.advanceTimersByTime(3000); });
    await draw(element([request(), request({ id: "p2", label: "desk2" })]));
    expect(focusCalls.get(node) ?? 0).toBe(1);
    expect(document.activeElement).toBe(node);
    setActive(document.body);
    await draw(element([request({ id: "p2", label: "desk2" })]));
    const second = prompts(root)[0]!;
    expect(second).not.toBe(node);
    expect(document.activeElement).toBe(second);
    setActive(document.body);
    await draw(null);
    expect(document.activeElement).toBe(opener);
    expect(focusCalls.get(opener) ?? 0).toBe(1);
  });

  it("keeps the focus it took when development runs its effects twice", async () => {
    // StrictMode (src/main.tsx) runs each effect's cleanup once right after the first run: the hand-back
    // meant for a prompt that went must not leave the focus in Settings while the prompt is still there
    strict = true;
    await draw(null);
    const root = await show([request()]);
    const node = prompts(root)[0]!;
    expect(document.activeElement).toBe(node);
    setActive(document.body);
    await draw(null);
    expect(document.activeElement).toBe(opener);
  });

  it("leaves the focus in a field the person is typing in, a terminal's included", async () => {
    // xterm's helper textarea, the chat composer, a field in Settings: the keys on their way (a shell's
    // Tab, then Enter) must not land on the prompt and walk to Approve
    for (const field of [makeNode("textarea"), Object.assign(makeNode("div"), { contentEditable: "true" }), inSettings("input"),
      inSettings("iframe"), inSettings("embed"), inSettings("object")]) {
      setActive(field);
      const root = await show([request()]);
      const node = prompts(root)[0]!;
      expect(focusCalls.get(node) ?? 0).toBe(0);
      expect(document.activeElement).toBe(field);
      await draw(element([request(), request({ id: "p2", label: "desk2" })]));
      await draw(element([request({ id: "p2", label: "desk2" })]));
      expect(document.activeElement).toBe(field);
      await draw(null);
      expect(document.activeElement).toBe(field);
      expect(focusCalls.get(field) ?? 0).toBe(0);
    }
  });

  it("takes the focus only where the prompt could not be reached otherwise", () => {
    expect(takesFocus(null)).toBe(true);
    expect(takesFocus(document.body)).toBe(true);
    expect(takesFocus(inSettings())).toBe(true);
    // a dialog that keeps Tab by its own key handler (session history, the worktree dialog, a row's sheet): the
    // prompt is outside that handler's reach, so Tab from it would go on to the page the dialog covers
    expect(takesFocus(makeNode("button", Object.assign(makeNode("div"), { ariaModal: "true" })))).toBe(false);
    expect(takesFocus(makeNode("button", Object.assign(document.createElement("dialog"), { open: true })))).toBe(false);
    // a frame's keys go to the page inside it
    for (const frame of ["iframe", "embed", "object"]) expect(takesFocus(inSettings(frame))).toBe(false);
    expect(takesFocus(makeNode("button"))).toBe(false);
    expect(takesFocus(makeNode("textarea"))).toBe(false);
    expect(takesFocus(inSettings("select"))).toBe(false);
  });

  it("takes nothing, and gives nothing back, when the prompt refuses the focus", async () => {
    // under an inert pane column (a phone's open drawer) focus() does nothing
    inert = true;
    const root = await show([request()]);
    const node = prompts(root)[0]!;
    expect(focusCalls.get(node) ?? 0).toBe(1);
    expect(document.activeElement).toBe(opener);
    const elsewhere = makeNode("button");
    setActive(elsewhere);
    await draw(element([request({ id: "p2", label: "desk2" })]));
    setActive(document.body);
    await draw(null);
    expect(document.activeElement).toBe(document.body);
    expect(focusCalls.get(opener) ?? 0).toBe(0);
  });

  it("leaves the focus where the person moved it meanwhile", async () => {
    const root = await show([request(), request({ id: "p2", label: "desk2" })]);
    const elsewhere = makeNode("button");
    await act(async () => { focusEvent(prompts(root)[0]!, "focusout", elsewhere); });
    setActive(elsewhere);
    await draw(element([request({ id: "p2", label: "desk2" })]));
    expect(document.activeElement).toBe(elsewhere);
    await draw(null);
    expect(document.activeElement).toBe(elsewhere);
    expect(focusCalls.get(opener) ?? 0).toBe(0);
  });

  it("gives the focus back to the stop Tab brought it from", async () => {
    const field = inSettings("input");
    const last = inSettings();
    setActive(field);
    const root = await show([request()]);
    const node = prompts(root)[0]!;
    expect(document.activeElement).toBe(field);
    await act(async () => { setActive(last); setActive(node); });
    await act(async () => { focusEvent(node, "focusin", node); });
    // approved by a key: Approve is disabled, then gone, and the browser drops the focus with a blur to nothing
    await act(async () => { focusEvent(node, "focusout", null); });
    setActive(document.body);
    await draw(null);
    expect(document.activeElement).toBe(last);
    expect(focusCalls.get(last) ?? 0).toBe(1);
    expect(focusCalls.get(field) ?? 0).toBe(0);
    const terminal = makeNode("textarea");
    setActive(terminal);
    const again = await show([request()]);
    await act(async () => { focusEvent(prompts(again)[0]!, "focusin", terminal); });
    setActive(document.body);
    await draw(null);
    expect(document.activeElement).toBe(document.body);
    expect(focusCalls.get(terminal) ?? 0).toBe(0);
  });

  it("does not approve by a key in the first second, which was typed before the prompt was there", async () => {
    const root = await show([request()]);
    const approve = () => prompts(root)[0]!.querySelectorAll("button")[0]!;
    await act(async () => { click(approve(), KEY); });
    await act(async () => { jest.advanceTimersByTime(APPROVE_KEY_GUARD_MS - 1); });
    await act(async () => { click(approve(), KEY); });
    expect(decided).toEqual([]);
    await act(async () => { jest.advanceTimersByTime(1); });
    await draw(element([request(), request({ id: "p2", label: "desk2" })]));
    await act(async () => { click(prompts(root)[1]!.querySelectorAll("button")[0]!, KEY); });
    expect(decided).toEqual([]);
    await act(async () => { click(approve(), KEY); });
    expect(decided).toEqual([["/api/relay/pairing", { id: "p1", decision: "approve" }]]);
    // a pointer's click waits too, but not as long: it is aimed by sight
    await act(async () => { jest.advanceTimersByTime(APPROVE_POINTER_GUARD_MS); });
    await act(async () => { click(prompts(root)[1]!.querySelectorAll("button")[0]!, POINTER); });
    expect(decided[1]).toEqual(["/api/relay/pairing", { id: "p2", decision: "approve" }]);
  });

  it("does not approve by a key in the first second after the focus was handed to the prompt", async () => {
    const root = await show([request(), request({ id: "p2", label: "desk2" })]);
    setActive(prompts(root)[1]!);
    await act(async () => { jest.advanceTimersByTime(5000); });
    await act(async () => { click(approveOf(prompts(root)[1]!), KEY); });
    expect(approved()).toEqual(["p2"]);
    // it goes, the browser drops the focus, and the first prompt, which did not move, is handed it: a Tab and
    // an Enter typed by habit then would press its Approve, whose own first second passed long ago
    setActive(document.body);
    await draw(element([request()]));
    expect(document.activeElement).toBe(prompts(root)[0]!);
    await act(async () => { jest.advanceTimersByTime(50); });
    await act(async () => { click(approveOf(prompts(root)[0]!), KEY); });
    await act(async () => { jest.advanceTimersByTime(APPROVE_KEY_GUARD_MS - 51); });
    await act(async () => { click(approveOf(prompts(root)[0]!), KEY); });
    expect(approved()).toEqual(["p2"]);
    await act(async () => { jest.advanceTimersByTime(1); });
    await act(async () => { click(approveOf(prompts(root)[0]!), KEY); });
    expect(approved()).toEqual(["p2", "p1"]);
  });

  it("does not approve by a key in the first second after the focus came into the prompt from outside it", async () => {
    const field = inSettings("input");
    setActive(field);
    const root = await show([request(), request({ id: "p2", label: "desk2" })]);
    await act(async () => { jest.advanceTimersByTime(5000); });
    const first = prompts(root)[0]!;
    setActive(first!);
    await act(async () => { focusEvent(first!, "focusin", field); });
    await act(async () => { click(approveOf(prompts(root)[0]!), KEY); });
    await act(async () => { jest.advanceTimersByTime(APPROVE_KEY_GUARD_MS - 1); });
    await act(async () => { focusEvent(prompts(root)[0]!, "focusin", prompts(root)[0]!); });
    await act(async () => { click(approveOf(prompts(root)[0]!), KEY); });
    expect(approved()).toEqual([]);
    await act(async () => { focusEvent(prompts(root)[1]!, "focusin", prompts(root)[0]!); });
    await act(async () => { click(approveOf(prompts(root)[1]!), KEY); });
    expect(approved()).toEqual([]);
    await act(async () => { click(approveOf(prompts(root)[1]!), POINTER); });
    expect(approved()).toEqual(["p2"]);
    await act(async () => { jest.advanceTimersByTime(1); });
    await act(async () => { click(approveOf(prompts(root)[0]!), KEY); });
    expect(approved()).toEqual(["p2", "p1"]);
  });

  it("counts the guards to when the key or the click was made, not to when the page got to it", async () => {
    const ago = (ms: number): number => performance.now() - ms;
    const root = await show([request(), request({ id: "p2", label: "desk2" }), request({ id: "p3", label: "desk3" })]);
    const [first, second, third] = prompts(root).map(approveOf);
    await act(async () => { jest.advanceTimersByTime(APPROVE_KEY_GUARD_MS); });
    // an Enter and a click made 600 ms ago, before the prompt's first second and half second were over
    await act(async () => { click(first!, { ...KEY, timeStamp: ago(600) }); });
    await act(async () => { click(first!, { ...POINTER, timeStamp: ago(600) }); });
    expect(approved()).toEqual([]);
    // the click a key makes may be stamped when it is made: the key's own press counts
    await act(async () => { const event = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }); Object.defineProperty(event, "timeStamp", { value: ago(600) }); second!.dispatchEvent(event); });
    await act(async () => { click(second!, { ...KEY, timeStamp: ago(0) }); });
    await act(async () => { const event = new window.PointerEvent("pointerdown", { bubbles: true }); Object.defineProperty(event, "timeStamp", { value: ago(600) }); second!.dispatchEvent(event); });
    await act(async () => { click(second!, { ...POINTER, timeStamp: ago(0) }); });
    expect(approved()).toEqual([]);
    // a press belongs to the click right after it, on its own button, and to no later one
    await act(async () => { click(second!, { ...KEY, timeStamp: ago(0) }); });
    expect(approved()).toEqual(["p2"]);
    await act(async () => { click(third!, { ...POINTER, timeStamp: ago(400) }); });
    await act(async () => { click(first!, { ...KEY, timeStamp: ago(0) }); });
    expect(approved()).toEqual(["p2", "p3", "p1"]);
  });

  it("takes an input to be at most five seconds old, and one that does not say as made now", () => {
    expect(inputAge(1000, 1600)).toBe(600);
    // a clock of the events that runs behind the page's would refuse every approval for good
    expect(inputAge(1000, 60_000)).toBe(INPUT_AGE_MAX_MS);
    expect(inputAge(2000, 1600)).toBe(0);
    for (const none of [undefined, 0, -1, Number.NaN, "12"]) expect(inputAge(none, 1600)).toBe(0);
  });

  it("does not approve the prompt that moved up into the place of the one just approved", async () => {
    const root = await show([request(), request({ id: "p2", label: "desk2" }), request({ id: "p3", label: "desk3" })]);
    await act(async () => { jest.advanceTimersByTime(5000); });
    await act(async () => { click(approveOf(prompts(root)[0]!), POINTER); });
    expect(approved()).toEqual(["p1"]);
    setActive(document.body);
    await draw(element([request({ id: "p2", label: "desk2" }), request({ id: "p3", label: "desk3" })]));
    // the second click of a double-click, a key typed by habit and a click aimed at what was there: none
    // approves the prompt now under them, nor the one that moved up behind it
    for (const prompt of prompts(root)) for (const gesture of [SECOND_CLICK, KEY, POINTER]) await act(async () => { click(approveOf(prompt), gesture); });
    await act(async () => { jest.advanceTimersByTime(APPROVE_POINTER_GUARD_MS - 1); });
    for (const prompt of prompts(root)) await act(async () => { click(approveOf(prompt), POINTER); });
    expect(approved()).toEqual(["p1"]);
    await act(async () => { jest.advanceTimersByTime(1); });
    await act(async () => { click(approveOf(prompts(root)[1]!), POINTER); });
    expect(approved()).toEqual(["p1", "p3"]);
  });

  it("never approves by the second click of a double-click, and by no click in a prompt's first half second", async () => {
    const root = await show([request()]);
    const approve = approveOf(prompts(root)[0]!);
    await act(async () => { click(approve, POINTER); });
    await act(async () => { jest.advanceTimersByTime(APPROVE_POINTER_GUARD_MS - 1); });
    await act(async () => { click(approve, POINTER); });
    expect(decided).toEqual([]);
    await act(async () => { jest.advanceTimersByTime(60_000); });
    for (const detail of [2, 3]) await act(async () => { click(approve, { detail }); });
    expect(decided).toEqual([]);
    await act(async () => { click(approve, POINTER); });
    expect(approved()).toEqual(["p1"]);
  });

  it("starts a prompt's guards again where it moved to, and leaves the ones that stayed", async () => {
    const field = makeNode("textarea");
    setActive(field);
    const [first, second, third] = [request(), request({ id: "p2", label: "desk2" }), request({ id: "p3", label: "desk3" })];
    const root = await show([first, second, third]);
    await act(async () => { jest.advanceTimersByTime(5000); });
    await draw(element([first, second]));
    await act(async () => { click(approveOf(prompts(root)[1]!), POINTER); });
    expect(approved()).toEqual(["p2"]);
    await draw(element([first, third]));
    await act(async () => { jest.advanceTimersByTime(5000); });
    await draw(element([third]));
    await act(async () => { click(approveOf(prompts(root)[0]!), POINTER); });
    await act(async () => { click(approveOf(prompts(root)[0]!), KEY); });
    expect(approved()).toEqual(["p2"]);
    expect(document.activeElement).toBe(field);
    await act(async () => { jest.advanceTimersByTime(APPROVE_KEY_GUARD_MS); });
    await act(async () => { click(approveOf(prompts(root)[0]!), KEY); });
    expect(approved()).toEqual(["p2", "p3"]);
  });

  it("brings the prompt it gives the focus to into view, and starts every guard again when that moved the stack", async () => {
    const [first, second, third] = [request(), request({ id: "p2", label: "desk2" }), request({ id: "p3", label: "desk3" })];
    const root = await show([first, second, third]);
    expect(document.activeElement).toBe(prompts(root)[0]!);
    expect(prompts(root).map((prompt) => scrollCalls.get(prompt) ?? 0)).toEqual([1, 0, 0]);
    setActive(prompts(root)[2]!);
    await act(async () => { jest.advanceTimersByTime(5000); });
    await act(async () => { click(approveOf(prompts(root)[2]!), KEY); });
    expect(approved()).toEqual(["p3"]);
    shift = -40;
    scrollCalls = new WeakMap();
    setActive(document.body);
    await draw(element([first, second]));
    expect(document.activeElement).toBe(prompts(root)[0]!);
    expect(prompts(root).map((prompt) => scrollCalls.get(prompt) ?? 0)).toEqual([1, 0]);
    await act(async () => { click(approveOf(prompts(root)[1]!), POINTER); });
    expect(approved()).toEqual(["p3"]);
    await act(async () => { jest.advanceTimersByTime(APPROVE_POINTER_GUARD_MS); });
    await act(async () => { click(approveOf(prompts(root)[1]!), POINTER); });
    expect(approved()).toEqual(["p3", "p2"]);
  });

  it("does not scroll to a prompt that refused the focus", async () => {
    inert = true;
    const root = await show([request()]);
    expect(scrollCalls.get(prompts(root)[0]!) ?? 0).toBe(0);
  });

  it("asks this PC's own window to allow the first phone of a PC with no member, beside its digits, and decides it there", async () => {
    const asked = new Date(AT).toISOString();
    const root = await show(firstJoinPrompts([
      { id: "j1", label: "Android · Chrome", asked_at: asked, left_ms: 60_000, digits: "725403" },
      // a join a member could approve is typed in Settings, never tapped here
      { id: "j2", label: "Tablet", asked_at: asked, left_ms: 60_000 },
      // and one this PC cannot let in (an app that knows no signed list) is allowed nowhere: its card says why
      { id: "j3", label: "Old phone", asked_at: asked, left_ms: 60_000, digits: "111222", list_unknown: true },
    ]));
    const [prompt, ...more] = prompts(root);
    expect(more).toEqual([]);
    expect(sentence(prompt!)).toContain("Android · Chrome");
    expect([...prompt!.querySelectorAll("strong")].map(text)).toEqual(["725 403"]);
    expect(left(prompt!)).toBe("60 s left");
    const checks = (node: HTMLElement) => [...node.querySelectorAll('[data-testid="relay-pairing-check"]')].map(text);
    expect(checks(prompt!)).toEqual([` · ${translate("en", "Allow only if your phone shows this number")}`]);
    expect([...prompt!.querySelectorAll("button")].map(text)).toEqual(["Allow", "Decline"]);
    await act(async () => { click(prompt!.querySelectorAll("button")[1]!, KEY); });
    await act(async () => { jest.advanceTimersByTime(APPROVE_POINTER_GUARD_MS); });
    await act(async () => { click(approveOf(prompt!), POINTER); });
    expect(decided).toEqual([["/api/relay/join", { id: "j1", decision: "decline" }], ["/api/relay/join", { id: "j1", decision: "approve" }]]);
  });

  it("shows this PC's own window a key a QR or code pairing waits with, beside its fingerprint, with a button that has the PC open its confirm page and Decline", async () => {
    const key = { id: "a".repeat(32), label: "Pixel 9", fingerprint: "K7QF-29XM", via: "relay" as const, redeemed_at: new Date(AT).toISOString(), slots: { used: 1, of: 3 } };
    const [prompt] = prompts(await show(pendingKeyPrompts([key])));
    expect(sentence(prompt!)).toContain("Pixel 9");
    expect([...prompt!.querySelectorAll("strong")].map(text)).toEqual(["K7QF-29XM"]);
    expect([...prompt!.querySelectorAll('[data-testid="relay-pairing-left"]')]).toHaveLength(0);
    // nothing here decides it: the confirm page does, which checks the user behind the connection
    expect([...prompt!.querySelectorAll('[data-testid="relay-pairing-check"]')]).toHaveLength(0);
    expect([...prompt!.querySelectorAll("button")].map(text)).toEqual(["Confirm on this PC", "Decline"]);
    await act(async () => { prompt!.querySelectorAll("button")[0]!.click(); });
    // refusing only narrows: it goes the way the PC's waiting list always declined a key
    await act(async () => { prompt!.querySelectorAll("button")[1]!.click(); });
    expect(decided).toEqual([["/api/account/confirm-page", null], ["/api/devices/pending/decline", { id: "a".repeat(32) }]]);
  });

  it("shows this PC's own window the number of its add by the account's list, and answers for that add: The numbers match, or Cancel", async () => {
    const until = new Date(AT + 120_000).toISOString();
    const shown = { state: "number" as const, run: "0123456789abcdef", account: "acct_1", list: "ab".repeat(32), digits: "482913", until };
    expect(listAddPrompts({ ...shown, state: "waiting" })).toEqual([]);
    expect(listAddPrompts(null)).toEqual([]);
    const [prompt, ...more] = prompts(await show(listAddPrompts(shown)));
    expect(more).toEqual([]);
    expect(sentence(prompt!)).toBe("This PC is being added to your account. Does the device adding it show 482 913?");
    expect(left(prompt!)).toBe("120 s left");
    const checks = [...prompt!.querySelectorAll('[data-testid="relay-pairing-check"]')].map(text);
    expect(checks).toEqual([` · ${translate("en", "Confirm only if that device shows the same number")}`]);
    expect([...prompt!.querySelectorAll("button")].map(text)).toEqual(["The numbers match", "Cancel"]);
    // the yes waits out the guard as any approval does, and names the number it was shown with its add
    await act(async () => { click(approveOf(prompt!), POINTER); });
    expect(decided).toEqual([]);
    await act(async () => { jest.advanceTimersByTime(APPROVE_POINTER_GUARD_MS); });
    await act(async () => { click(approveOf(prompt!), POINTER); });
    await act(async () => { click(prompt!.querySelectorAll("button")[1]!, KEY); });
    expect(decided).toEqual([["/api/account/list/add/confirm", { run: "0123456789abcdef", digits: "482913" }], ["/api/account/list/add/cancel", { run: "0123456789abcdef" }]]);
  });

  it("still approves and declines through decideRelayPairing", async () => {
    const root = await show([request(), request({ id: "p2", label: "desk2", local_only: true })]);
    const [first, second] = prompts(root);
    // declining is never held back
    await act(async () => { click(second!.querySelectorAll("button")[1]!, KEY); });
    await act(async () => { jest.advanceTimersByTime(APPROVE_POINTER_GUARD_MS); });
    await act(async () => { click(first!.querySelectorAll("button")[0]!, POINTER); });
    expect(decided).toEqual([["/api/relay/pairing", { id: "p2", decision: "decline" }], ["/api/relay/pairing", { id: "p1", decision: "approve" }]]);
  });
});
