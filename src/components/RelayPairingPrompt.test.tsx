import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { act, createElement, StrictMode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { RelayPairingRequest } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { APPROVE_KEY_GUARD_MS, APPROVE_POINTER_GUARD_MS, RelayPairingPrompt, aroundDigits, deadlineOf, secondsLeft, takesFocus } from "./RelayPairingPrompt.tsx";

const AT = Date.parse("2026-11-10T00:00:00.000Z");
const request = (over: Partial<RelayPairingRequest> = {}): RelayPairingRequest => ({ id: "p1", label: "Hako's iPhone", digits: "725403", expires_at: new Date(AT + 90_000).toISOString(), ...over });

/** every string an element draws, in order */
function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("");
}

describe("the PC's prompt for a device waiting for approval", () => {
  const keys = ["window", "document", "navigator", "getComputedStyle", "HTMLElement", "Element", "Node", "fetch", "IS_REACT_ACT_ENVIRONMENT"];
  /** what decideRelayPairing posted: the path and the body */
  let decided: [string, unknown][];
  const saved = new Map<string, PropertyDescriptor | undefined>();
  class HTMLElement {
    isConnected = true;
    focused = 0;
    /** refuses the focus, as under an inert column */
    inert = false;
    /** `within`: what `closest` finds around it, as words of the selectors asked ("textarea", "aria-modal") */
    constructor(readonly name: string, readonly inside: HTMLElement[] = [], readonly within: string[] = []) {}
    focus(): void { this.focused += 1; if (!this.inert) page.activeElement = this; }
    /** how often it was brought into view, which moves the stack around it by `shift` */
    scrolled = 0;
    scrollTop = 0;
    scrollIntoView(): void { this.scrolled += 1; stack.scrollTop += shift; }
    closest(selector: string): HTMLElement | null { return this.within.some((word) => selector.includes(word)) ? this : null; }
    contains(other: unknown): boolean { return other === this || this.inside.some((node) => node.contains(other)); }
  }
  /** the document: what has the focus now */
  let page: { activeElement: HTMLElement | null; body: HTMLElement };
  /** Settings: a modal dialog whose Tab round useFocusTrap holds */
  let settings: HTMLElement;
  let trap: ReactTestRenderer | undefined;
  function Held({ surface }: { surface: HTMLElement }) {
    const ref = useFocusTrap<never>(true);
    (ref as { current: unknown }).current = surface;
    return null;
  }
  /** something in Settings */
  const inSettings = (name: string, within: string[] = []): HTMLElement => { const node = new HTMLElement(name, [], ["aria-modal", ...within]); settings.inside.push(node); return node; };
  /** what had the focus when the prompt arrived: a button in Settings */
  let opener: HTMLElement;
  /** the layer the prompts are stacked in, and how far it scrolls to bring a prompt into view */
  let stack: HTMLElement;
  let shift: number;
  /** set before show(): the prompts drawn refuse the focus */
  let inert: boolean;
  /** the node behind each drawn element, by test id or tag */
  let nodes: Map<string, HTMLElement>;
  let renderer: ReactTestRenderer | undefined;

  beforeEach(async () => {
    decided = [];
    for (const key of keys) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    opener = new HTMLElement("opener", [], ["aria-modal"]);
    settings = new HTMLElement("settings", [opener]);
    inert = false;
    shift = 0;
    page = { activeElement: opener, body: new HTMLElement("body") };
    nodes = new Map();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "http://127.0.0.1:7421/", origin: "http://127.0.0.1:7421", pathname: "/" },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, querySelectorAll: () => [],
      get activeElement() { return page.activeElement; }, get body() { return page.body; },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    } });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: unknown, init?: RequestInit) => {
      decided.push([new URL(String(input), "http://127.0.0.1:7421").pathname, JSON.parse(String(init?.body))]);
      expect(init?.method).toBe("POST");
      return new Response(null, { status: 204 });
    } });
    Object.defineProperty(globalThis, "Element", { configurable: true, value: HTMLElement });
    await act(async () => { trap = create(createElement(Held, { surface: settings })); });
    jest.useFakeTimers();
    jest.setSystemTime(AT);
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    await act(async () => { trap?.unmount(); });
    trap = undefined;
    jest.useRealTimers();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const element = (pairings: RelayPairingRequest[]) => createElement(SettingsProvider, null, createElement(RelayPairingPrompt, { pairings }));
  async function show(pairings: RelayPairingRequest[], wrap: (drawn: ReturnType<typeof element>) => Parameters<typeof create>[0] = (drawn) => drawn): Promise<ReactTestInstance> {
    const layer = stack = new HTMLElement("layer");
    await act(async () => {
      renderer = create(wrap(element(pairings)), { createNodeMock: (drawn) => {
        const props = drawn.props as { className?: string; id?: string };
        if (props.className === "relay-pairing-layer") return layer;
        if (drawn.type !== "div" || !props.className?.includes("relay-pairing-prompt")) return null;
        const node = new HTMLElement("prompt");
        node.inert = inert;
        layer.inside.push(node);
        nodes.set(String((drawn.props as { "aria-labelledby": string })["aria-labelledby"]), node);
        return node;
      } });
    });
    return renderer!.root;
  }
  const prompts = (root: ReactTestInstance) => root.findAll((node) => node.type === "div" && node.props["data-testid"] === "relay-pairing-prompt");
  const nodeOf = (prompt: ReactTestInstance) => nodes.get(String(prompt.props["aria-labelledby"]))!;
  const sentence = (prompt: ReactTestInstance) => text(prompt.find((node) => node.type === "span" && node.props.id === prompt.props["aria-labelledby"]));
  const left = (prompt: ReactTestInstance) => text(prompt.find((node) => node.props["data-testid"] === "relay-pairing-left")).trim();

  const SENTENCE = "{name} wants to add this PC to your account. Type {digits} on {name}, or check that {name} shows the same number, then press Approve here.";
  /** a click a pointer made; one a key made has detail 0, the second of a double-click 2 */
  const POINTER = { detail: 1 };
  const KEY = { detail: 0 };
  const SECOND_CLICK = { detail: 2 };
  const approveOf = (prompt: ReactTestInstance) => prompt.findAllByType("button")[0]!;
  const approved = () => decided.map(([, body]) => (body as { id: string }).id);

  it("tells the owner to type the number on the other device when this PC waits to be added", async () => {
    const [prompt] = prompts(await show([request({ local_only: true })]));
    // it also holds for a device that came by an ordinary link meanwhile and shows digits to compare
    expect(sentence(prompt!)).toBe("Hako's iPhone wants to add this PC to your account. Type 725 403 on Hako's iPhone, or check that Hako's iPhone shows the same number, then press Approve here.");
    expect(text(prompt!.findByType("strong"))).toBe("725 403");
    expect(prompt!.props["data-local-only"]).toBe("true");
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
      // the digits are drawn once, in their own element, where the sentence put them
      expect(prompt!.findAllByType("strong").map(text)).toEqual(["725 403"]);
      await act(async () => { renderer!.unmount(); });
      renderer = undefined;
      page.activeElement = opener;
    }
    expect(aroundDigits("a {name} {digits} b {name}", "{digits}")).toEqual(["a {digits} ", " b {digits}"]);
    expect(aroundDigits("no place for them {name}", "x")).toEqual(["no place for them x ", ""]);
    // and the compared sentence, which ends in the digits
    const [compared] = prompts(await show([request({ label: "x\u0000{digits}{name}" })]));
    expect(sentence(compared!)).toBe("x\u0000{digits}{name} wants to pair through the relay. Approve it only if its screen shows 725 403");
  });

  it("asks to compare the digits when the other device shows them", async () => {
    const [prompt] = prompts(await show([request()]));
    expect(sentence(prompt!)).toBe("Hako's iPhone wants to pair through the relay. Approve it only if its screen shows 725 403");
    expect(prompt!.props["data-local-only"]).toBeUndefined();
    // an older server sends false for nothing, but a false is the same sentence
    await act(async () => { renderer!.update(element([request({ local_only: false })])); });
    expect(sentence(prompts(renderer!.root)[0]!)).toContain("Approve it only if its screen shows");
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
    // this window's clock runs two minutes ahead of the PC's: by expires_at the request is long over
    const fast = request({ expires_at: new Date(AT - 30_000).toISOString(), left_ms: 90_000 });
    const root = await show([fast]);
    expect(left(prompts(root)[0]!)).toBe("90 s left");
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(left(prompts(root)[0]!)).toBe("30 s left");
    // the list told again (another device asked) carries what is left by then
    await act(async () => { renderer!.update(element([{ ...fast, left_ms: 30_000 }, request({ id: "p2", label: "desk2", expires_at: new Date(AT - 30_000 + 60_000).toISOString(), left_ms: 90_000 })])); });
    expect(prompts(root).map(left)).toEqual(["30 s left", "90 s left"]);
    await act(async () => { jest.advanceTimersByTime(31_000); });
    expect(prompts(root).map(left)).toEqual(["0 s left", "59 s left"]);
    // a slow clock: two minutes more by expires_at
    const slow = request({ id: "p3", expires_at: new Date(Date.now() + 210_000).toISOString(), left_ms: 90_000 });
    await act(async () => { renderer!.update(element([slow])); });
    expect(prompts(root).map(left)).toEqual(["90 s left"]);
    // read once per telling, and a left_ms that is no time falls back to expires_at
    expect(deadlineOf(slow, Date.now() + 5000)).toBe(Date.now() + 90_000);
    expect(deadlineOf(request({ left_ms: Number.NaN }), AT)).toBe(AT + 90_000);
    expect(deadlineOf(request({ left_ms: -1 }), AT)).toBe(AT + 90_000);
  });

  it("shows no time for a request without one it can read", async () => {
    const root = await show([request({ expires_at: "" })]);
    expect(root.findAll((node) => node.props["data-testid"] === "relay-pairing-left")).toEqual([]);
    expect(deadlineOf(request({ expires_at: "" }), AT)).toBeNull();
    expect(secondsLeft(AT + 1, AT)).toBe(1);
    expect(secondsLeft(AT - 5000, AT)).toBe(0);
  });

  it("is a named group, not a dialog, in a layer labelled for devices", async () => {
    const root = await show([request()]);
    const [prompt] = prompts(root);
    // an alertdialog would count as a cover for every "a dialog is open" check on the page: Escape in
    // Connect a phone and in the phone drawer, the pane's cover, the web popup's trap
    expect(prompt!.props.role).toBe("group");
    expect(prompt!.props["aria-modal"]).toBeUndefined();
    expect(root.findAll((node) => typeof node.type === "string" && (node.props.role === "alertdialog" || node.props.role === "dialog"))).toEqual([]);
    expect(prompt!.props.tabIndex).toBe(-1);
    // what a dialog's focus trap counts among its own Tab stops (overlayStops in lib/useFocusTrap.ts)
    expect(String(prompt!.props.className).split(" ")).toContain("relay-pairing-prompt");
    expect(sentence(prompt!)).toContain("Hako's iPhone");
    // the clock is not part of the name, and is not announced each second
    expect(prompt!.find((node) => node.props["data-testid"] === "relay-pairing-left").props["aria-live"]).toBe("off");
    const layer = root.find((node) => node.props.className === "relay-pairing-layer");
    expect(layer.props["aria-label"]).toBe("Devices waiting for approval");
    expect(layer.props["aria-live"]).toBe("assertive");
  });

  it("takes the focus from a dialog on the prompt itself, never on Approve, and gives it back when the prompt goes", async () => {
    const root = await show([request()]);
    const node = nodeOf(prompts(root)[0]!);
    expect(page.activeElement).toBe(node);
    expect(node.name).toBe("prompt");
    expect(node.focused).toBe(1);
    // a second that passes, or a second device, does not take the focus again
    await act(async () => { jest.advanceTimersByTime(3000); });
    await act(async () => { renderer!.update(element([request(), request({ id: "p2", label: "desk2" })])); });
    expect(node.focused).toBe(1);
    expect(page.activeElement).toBe(node);
    // the first is decided while it has the focus: the one still waiting takes it
    page.activeElement = page.body;
    await act(async () => { renderer!.update(element([request({ id: "p2", label: "desk2" })])); });
    const second = nodeOf(prompts(root)[0]!);
    expect(second).not.toBe(node);
    expect(page.activeElement).toBe(second);
    page.activeElement = page.body;
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    expect(page.activeElement).toBe(opener);
    expect(opener.focused).toBe(1);
  });

  it("keeps the focus it took when development runs its effects twice", async () => {
    // StrictMode (src/main.tsx) runs each effect's cleanup once right after the first run: the hand-back
    // meant for a prompt that went must not leave the focus in Settings while the prompt is still there
    const root = await show([request()], (drawn) => createElement(StrictMode, null, drawn));
    const node = nodeOf(prompts(root)[0]!);
    expect(page.activeElement).toBe(node);
    page.activeElement = page.body;
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    expect(page.activeElement).toBe(opener);
  });

  it("leaves the focus in a field the person is typing in, a terminal's included", async () => {
    // xterm's helper textarea, the chat composer, a field in Settings: the keys on their way (a shell's
    // Tab, then Enter) must not land on the prompt and walk to Approve
    for (const field of [new HTMLElement("terminal", [], ["textarea"]), new HTMLElement("composer", [], ["contenteditable"]), inSettings("settings field", ["input"]),
      // a page in the in-app browser's popup, an HTML or PDF preview: the frame has the focus while the person types in it
      inSettings("web page", ["iframe"]), inSettings("pdf", ["embed"]), inSettings("plugin", ["object"])]) {
      page.activeElement = field;
      const root = await show([request()]);
      const node = nodeOf(prompts(root)[0]!);
      expect(node.focused).toBe(0);
      expect(page.activeElement).toBe(field);
      // nor when another device asks, or the first prompt goes
      await act(async () => { renderer!.update(element([request(), request({ id: "p2", label: "desk2" })])); });
      await act(async () => { renderer!.update(element([request({ id: "p2", label: "desk2" })])); });
      expect(page.activeElement).toBe(field);
      await act(async () => { renderer!.unmount(); });
      renderer = undefined;
      // nothing was taken, so nothing is given back
      expect(page.activeElement).toBe(field);
      expect(field.focused).toBe(0);
    }
  });

  it("takes the focus only where the prompt could not be reached otherwise", () => {
    expect(takesFocus(null)).toBe(true);
    expect(takesFocus(page.body as never)).toBe(true);
    expect(takesFocus(inSettings("settings button") as never)).toBe(true);
    // a dialog that keeps Tab by its own key handler (session history, the worktree dialog, a row's sheet): the
    // prompt is outside that handler's reach, so Tab from it would go on to the page the dialog covers
    expect(takesFocus(new HTMLElement("history button", [], ["aria-modal"]) as never)).toBe(false);
    expect(takesFocus(new HTMLElement("native dialog button", [], ["dialog[open]"]) as never)).toBe(false);
    // a frame's keys go to the page inside it
    for (const frame of ["iframe", "embed", "object"]) expect(takesFocus(inSettings(frame, [frame]) as never)).toBe(false);
    // a sidebar row, a header button: Tab reaches the prompt from the page, and their keys stay theirs
    expect(takesFocus(new HTMLElement("sidebar row") as never)).toBe(false);
    expect(takesFocus(new HTMLElement("terminal", [], ["textarea"]) as never)).toBe(false);
    expect(takesFocus(inSettings("settings field", ["select"]) as never)).toBe(false);
  });

  it("takes nothing, and gives nothing back, when the prompt refuses the focus", async () => {
    // under an inert pane column (a phone's open drawer) focus() does nothing
    inert = true;
    const root = await show([request()]);
    const node = nodeOf(prompts(root)[0]!);
    expect(node.focused).toBe(1);
    expect(page.activeElement).toBe(opener);
    // the person moves on; the prompt going must not pull the focus back to where it was
    const elsewhere = new HTMLElement("drawer row");
    page.activeElement = elsewhere;
    await act(async () => { renderer!.update(element([request({ id: "p2", label: "desk2" })])); });
    page.activeElement = page.body;
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    expect(page.activeElement).toBe(page.body);
    expect(opener.focused).toBe(0);
  });

  it("leaves the focus where the person moved it meanwhile", async () => {
    const root = await show([request(), request({ id: "p2", label: "desk2" })]);
    const elsewhere = new HTMLElement("composer");
    await act(async () => { root.find((node) => node.props.className === "relay-pairing-layer").props.onBlur({ relatedTarget: elsewhere, currentTarget: { contains: () => false } }); });
    page.activeElement = elsewhere;
    await act(async () => { renderer!.update(element([request({ id: "p2", label: "desk2" })])); });
    expect(page.activeElement).toBe(elsewhere);
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    expect(page.activeElement).toBe(elsewhere);
    expect(opener.focused).toBe(0);
  });

  it("gives the focus back to the stop Tab brought it from", async () => {
    // a field in Settings kept the focus when the prompt arrived; Tab then walked from Settings' last stop into it
    const field = inSettings("settings field", ["input"]);
    const last = inSettings("settings close");
    page.activeElement = field;
    const root = await show([request()]);
    const node = nodeOf(prompts(root)[0]!);
    expect(page.activeElement).toBe(field);
    const layer = root.find((drawn) => drawn.props.className === "relay-pairing-layer");
    page.activeElement = node;
    await act(async () => { layer.props.onFocus({ relatedTarget: last, currentTarget: { contains: () => false } }); });
    // a move inside the layer (to Approve) is not a new arrival
    await act(async () => { layer.props.onFocus({ relatedTarget: node, currentTarget: { contains: () => true } }); });
    // approved by a key: Approve is disabled, then gone, and the browser drops the focus with a blur to nothing
    await act(async () => { layer.props.onBlur({ relatedTarget: null, currentTarget: { contains: () => false } }); });
    page.activeElement = page.body;
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    expect(page.activeElement).toBe(last);
    expect(last.focused).toBe(1);
    expect(field.focused).toBe(0);
    // from the page (a terminal, then a tap on Approve) nothing is taken, so nothing goes back
    const terminal = new HTMLElement("terminal", [], ["textarea"]);
    page.activeElement = terminal;
    const again = await show([request()]);
    await act(async () => { again.find((drawn) => drawn.props.className === "relay-pairing-layer").props.onFocus({ relatedTarget: terminal, currentTarget: { contains: () => false } }); });
    page.activeElement = page.body;
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    expect(page.activeElement).toBe(page.body);
    expect(terminal.focused).toBe(0);
  });

  it("does not approve by a key in the first second, which was typed before the prompt was there", async () => {
    const root = await show([request()]);
    const approve = () => prompts(root)[0]!.findAllByType("button")[0]!;
    await act(async () => { approve().props.onClick(KEY); });
    await act(async () => { jest.advanceTimersByTime(APPROVE_KEY_GUARD_MS - 1); });
    await act(async () => { approve().props.onClick(KEY); });
    expect(decided).toEqual([]);
    // a second device starts its own second; the first prompt's has passed
    await act(async () => { jest.advanceTimersByTime(1); });
    await act(async () => { renderer!.update(element([request(), request({ id: "p2", label: "desk2" })])); });
    await act(async () => { prompts(root)[1]!.findAllByType("button")[0]!.props.onClick(KEY); });
    expect(decided).toEqual([]);
    await act(async () => { approve().props.onClick(KEY); });
    expect(decided).toEqual([["/api/relay/pairing", { id: "p1", decision: "approve" }]]);
    // a pointer's click waits too, but not as long: it is aimed by sight
    await act(async () => { jest.advanceTimersByTime(APPROVE_POINTER_GUARD_MS); });
    await act(async () => { prompts(root)[1]!.findAllByType("button")[0]!.props.onClick(POINTER); });
    expect(decided[1]).toEqual(["/api/relay/pairing", { id: "p2", decision: "approve" }]);
  });

  it("does not approve by a key in the first second after the focus was handed to the prompt", async () => {
    // two devices wait; the second has waited long enough, and has the focus (Tab took it there)
    const root = await show([request(), request({ id: "p2", label: "desk2" })]);
    page.activeElement = nodeOf(prompts(root)[1]!);
    await act(async () => { jest.advanceTimersByTime(5000); });
    await act(async () => { approveOf(prompts(root)[1]!).props.onClick(KEY); });
    expect(approved()).toEqual(["p2"]);
    // it goes, the browser drops the focus, and the first prompt, which did not move, is handed it: a Tab and
    // an Enter typed by habit then would press its Approve, whose own first second passed long ago
    page.activeElement = page.body;
    await act(async () => { renderer!.update(element([request()])); });
    expect(page.activeElement).toBe(nodeOf(prompts(root)[0]!));
    await act(async () => { jest.advanceTimersByTime(50); });
    await act(async () => { approveOf(prompts(root)[0]!).props.onClick(KEY); });
    await act(async () => { jest.advanceTimersByTime(APPROVE_KEY_GUARD_MS - 51); });
    await act(async () => { approveOf(prompts(root)[0]!).props.onClick(KEY); });
    expect(approved()).toEqual(["p2"]);
    await act(async () => { jest.advanceTimersByTime(1); });
    await act(async () => { approveOf(prompts(root)[0]!).props.onClick(KEY); });
    expect(approved()).toEqual(["p2", "p1"]);
  });

  it("does not approve the prompt that moved up into the place of the one just approved", async () => {
    const root = await show([request(), request({ id: "p2", label: "desk2" }), request({ id: "p3", label: "desk3" })]);
    await act(async () => { jest.advanceTimersByTime(5000); });
    await act(async () => { approveOf(prompts(root)[0]!).props.onClick(POINTER); });
    expect(approved()).toEqual(["p1"]);
    page.activeElement = page.body;
    await act(async () => { renderer!.update(element([request({ id: "p2", label: "desk2" }), request({ id: "p3", label: "desk3" })])); });
    // the second click of a double-click, a key typed by habit and a click aimed at what was there: none
    // approves the prompt now under them, nor the one that moved up behind it
    for (const prompt of prompts(root)) for (const click of [SECOND_CLICK, KEY, POINTER]) await act(async () => { approveOf(prompt).props.onClick(click); });
    await act(async () => { jest.advanceTimersByTime(APPROVE_POINTER_GUARD_MS - 1); });
    for (const prompt of prompts(root)) await act(async () => { approveOf(prompt).props.onClick(POINTER); });
    expect(approved()).toEqual(["p1"]);
    await act(async () => { jest.advanceTimersByTime(1); });
    await act(async () => { approveOf(prompts(root)[1]!).props.onClick(POINTER); });
    expect(approved()).toEqual(["p1", "p3"]);
  });

  it("never approves by the second click of a double-click, and by no click in a prompt's first half second", async () => {
    const root = await show([request()]);
    const approve = approveOf(prompts(root)[0]!);
    // a click aimed at what was there before the prompt
    await act(async () => { approve.props.onClick(POINTER); });
    await act(async () => { jest.advanceTimersByTime(APPROVE_POINTER_GUARD_MS - 1); });
    await act(async () => { approve.props.onClick(POINTER); });
    expect(decided).toEqual([]);
    await act(async () => { jest.advanceTimersByTime(60_000); });
    for (const detail of [2, 3]) await act(async () => { approve.props.onClick({ detail }); });
    expect(decided).toEqual([]);
    await act(async () => { approve.props.onClick(POINTER); });
    expect(approved()).toEqual(["p1"]);
  });

  it("starts a prompt's guards again where it moved to, and leaves the ones that stayed", async () => {
    // the person types in a field, so no prompt is handed the focus: only the places change
    const field = new HTMLElement("terminal", [], ["textarea"]);
    page.activeElement = field;
    const [first, second, third] = [request(), request({ id: "p2", label: "desk2" }), request({ id: "p3", label: "desk3" })];
    const root = await show([first, second, third]);
    await act(async () => { jest.advanceTimersByTime(5000); });
    // the last one runs out: the two above it stay where they are
    await act(async () => { renderer!.update(element([first, second])); });
    await act(async () => { approveOf(prompts(root)[1]!).props.onClick(POINTER); });
    expect(approved()).toEqual(["p2"]);
    // the first one runs out: the one below moves up
    await act(async () => { renderer!.update(element([first, third])); });
    await act(async () => { jest.advanceTimersByTime(5000); });
    await act(async () => { renderer!.update(element([third])); });
    await act(async () => { approveOf(prompts(root)[0]!).props.onClick(POINTER); });
    await act(async () => { approveOf(prompts(root)[0]!).props.onClick(KEY); });
    expect(approved()).toEqual(["p2"]);
    expect(page.activeElement).toBe(field);
    await act(async () => { jest.advanceTimersByTime(APPROVE_KEY_GUARD_MS); });
    await act(async () => { approveOf(prompts(root)[0]!).props.onClick(KEY); });
    expect(approved()).toEqual(["p2", "p3"]);
  });

  it("brings the prompt it gives the focus to into view, and starts every guard again when that moved the stack", async () => {
    // more devices than a short window shows at once: the stack scrolls
    const [first, second, third] = [request(), request({ id: "p2", label: "desk2" }), request({ id: "p3", label: "desk3" })];
    const root = await show([first, second, third]);
    expect(page.activeElement).toBe(nodeOf(prompts(root)[0]!));
    // in view already: nothing moved, and the other prompts were not touched
    expect(prompts(root).map((prompt) => nodeOf(prompt).scrolled)).toEqual([1, 0, 0]);
    // Tab took the focus to the last one, which the dialog's trap scrolled to; it is approved there
    page.activeElement = nodeOf(prompts(root)[2]!);
    await act(async () => { jest.advanceTimersByTime(5000); });
    await act(async () => { approveOf(prompts(root)[2]!).props.onClick(KEY); });
    expect(approved()).toEqual(["p3"]);
    // the first is handed the focus and scrolled back to: the second moved under the pointer with it
    shift = -40;
    page.activeElement = page.body;
    await act(async () => { renderer!.update(element([first, second])); });
    expect(page.activeElement).toBe(nodeOf(prompts(root)[0]!));
    expect(prompts(root).map((prompt) => nodeOf(prompt).scrolled)).toEqual([1, 0]);
    await act(async () => { approveOf(prompts(root)[1]!).props.onClick(POINTER); });
    expect(approved()).toEqual(["p3"]);
    await act(async () => { jest.advanceTimersByTime(APPROVE_POINTER_GUARD_MS); });
    await act(async () => { approveOf(prompts(root)[1]!).props.onClick(POINTER); });
    expect(approved()).toEqual(["p3", "p2"]);
  });

  it("does not scroll to a prompt that refused the focus", async () => {
    inert = true;
    const root = await show([request()]);
    expect(nodeOf(prompts(root)[0]!).scrolled).toBe(0);
  });

  it("still approves and declines through decideRelayPairing", async () => {
    const root = await show([request(), request({ id: "p2", label: "desk2", local_only: true })]);
    const [first, second] = prompts(root);
    // declining is never held back
    await act(async () => { second!.findAllByType("button")[1]!.props.onClick(KEY); });
    await act(async () => { jest.advanceTimersByTime(APPROVE_POINTER_GUARD_MS); });
    await act(async () => { first!.findAllByType("button")[0]!.props.onClick(POINTER); });
    expect(decided).toEqual([["/api/relay/pairing", { id: "p2", decision: "decline" }], ["/api/relay/pairing", { id: "p1", decision: "approve" }]]);
  });
});
