import { afterEach, beforeEach, expect, test } from "bun:test";
import { createElement, type RefObject } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { usePageFocusGuard } from "./usePageFocusGuard.ts";

const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "HTMLElement", "setTimeout"];
const timers: Array<() => void> = [];
const saved = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let renderer: ReactTestRenderer | undefined;

class Element { isConnected = true; focused = 0; focus(): void { this.focused += 1; } }
type Listener = (event: unknown) => void;
function target() {
  const listeners = new Map<string, Listener[]>();
  return {
    addEventListener(type: string, listener: Listener, capture?: boolean) { listeners.set(`${type}:${capture === true}`, [...(listeners.get(`${type}:${capture === true}`) ?? []), listener]); },
    removeEventListener(type: string, listener: Listener, capture?: boolean) { listeners.set(`${type}:${capture === true}`, (listeners.get(`${type}:${capture === true}`) ?? []).filter((one) => one !== listener)); },
    fire(type: string, capture: boolean, event: unknown = {}) { for (const listener of listeners.get(`${type}:${capture}`) ?? []) listener(event); },
  };
}

let win: ReturnType<typeof target> & { focus(): void };
let doc: ReturnType<typeof target> & { activeElement: Element | null; hasFocus(): boolean };
const frame = new Element();
const field = new Element();
const ref = { current: frame } as unknown as RefObject<HTMLIFrameElement | null>;
let grabs = 0;
let shield = false;

function Guard() {
  shield = usePageFocusGuard(ref, true, () => { grabs += 1; }).shield;
  return null;
}

beforeEach(async () => {
  win = Object.assign(target(), { focus() {} });
  doc = Object.assign(target(), { activeElement: null as Element | null, hasFocus: () => true });
  grabs = 0;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, window: win, document: doc, HTMLElement: Element, setTimeout: (run: () => void) => { timers.push(run); return 0; } });
  await act(async () => { renderer = create(createElement(Guard)); });
  // the person is back in the app: the page has to be given the focus anew
  await act(async () => doc.fire("focusin", true, { target: field }));
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  // the guard asks for the focus once more after the blur event: that runs while the page is still there
  for (const late of timers.splice(0)) late();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

/** The frame has the focus and the window lost it: what a browser reports when the focus goes into a page. */
const intoPage = async (): Promise<void> => { doc.activeElement = frame; await act(async () => win.fire("blur", false)); };
/** A Tab as the window hears it on the way up: one its target stopped (the terminal's) never gets here. */
const tab = async (defaultPrevented = false): Promise<void> => { await act(async () => win.fire("keydown", false, { key: "Tab", defaultPrevented })); };

test("a page that takes the focus by itself loses its scripts, and the focus goes back", async () => {
  expect(shield).toBe(true);
  await intoPage();
  expect(grabs).toBe(1);
  expect(field.focused).toBeGreaterThan(0);
});

test("a Tab from the control before the page puts the focus in it", async () => {
  await tab();
  await intoPage();
  expect(grabs).toBe(0);
  expect(shield).toBe(false);
});

test("a Tab the terminal kept for itself does not let the page take the focus", async () => {
  // the terminal stops its Tab, so no listener on the way up hears it; one in the capture phase would
  await act(async () => win.fire("keydown", true, { key: "Tab", defaultPrevented: false }));
  await intoPage();
  expect(grabs).toBe(1);
});

test("a Tab the app handled does not let the page take the focus", async () => {
  await tab(true);
  await intoPage();
  expect(grabs).toBe(1);
});

test("a Tab that moved the focus inside the app does not let the page take it next", async () => {
  await tab();
  await act(async () => doc.fire("focusin", true, { target: field }));
  await intoPage();
  expect(grabs).toBe(1);
});

test("one Tab lets the focus in once", async () => {
  await tab();
  await intoPage();
  await act(async () => doc.fire("focusin", true, { target: field }));
  await intoPage();
  expect(grabs).toBe(1);
});
