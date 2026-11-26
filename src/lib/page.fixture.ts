/**
 * A browser page for component and hook tests: happy-dom's window, document and navigator as globals,
 * and a react-dom root in its body, the way the app renders. Timers and fetch stay Bun's, so fake
 * timers and fetch spies work as before. happy-dom's windows share their classes' prototypes, so what a
 * test stubs on `page.window.HTMLElement.prototype` and the like is put back when the page closes.
 */
import { BrowserErrorCaptureEnum, Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const GLOBALS = ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"] as const;

type Snapshot = Map<object, Map<PropertyKey, PropertyDescriptor>>;

/** The own properties of every prototype and class the window's classes share with other windows. */
function snapshotClasses(window: Window): Snapshot {
  const snapshot: Snapshot = new Map();
  for (const name of Object.getOwnPropertyNames(window)) {
    const value: unknown = Object.getOwnPropertyDescriptor(window, name)?.value;
    if (typeof value !== "function" || typeof value.prototype !== "object" || value.prototype === null) continue;
    for (const target of [value, value.prototype as object]) {
      if (snapshot.has(target)) continue;
      snapshot.set(target, new Map(Reflect.ownKeys(target).map((key) => [key, Object.getOwnPropertyDescriptor(target, key)!])));
    }
  }
  return snapshot;
}

function restoreClasses(snapshot: Snapshot): void {
  for (const [target, descriptors] of snapshot) {
    for (const key of Reflect.ownKeys(target)) if (!descriptors.has(key)) Reflect.deleteProperty(target, key);
    for (const [key, descriptor] of descriptors) Object.defineProperty(target, key, descriptor);
  }
}

export interface Page {
  readonly window: Window;
  /** Where the root renders. */
  readonly container: HTMLElement;
  /** Renders `node` into the root, mounting it on the first call. */
  render(node: ReactNode): Promise<void>;
  /** The one element in the container that `selector` matches; throws on none or several. */
  one<E extends Element = HTMLElement>(selector: string): E;
  /** Types `value` into a text field the way a user does: React's onChange sees it. */
  type(field: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void>;
  /** Unmounts the root and puts back the globals the page replaced, even when unmounting throws. */
  close(): Promise<void>;
}

/**
 * The props React last rendered on `element`. Only for a guard inside a handler that no event can reach:
 * React drops a click on a disabled button before its handler runs, so a test of the handler's own check
 * (a watch-only device may not answer) calls the handler from here, as a stale or scripted call would.
 */
export function reactProps(element: Element): Record<string, unknown> {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"));
  if (!key) throw new Error("React did not render this element");
  return (element as unknown as Record<string, Record<string, unknown>>)[key]!;
}

export function openPage(url = "http://localhost/"): Page {
  const saved = new Map(GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  // by default happy-dom catches an error thrown in a listener and only reports it as the window's error event:
  // here it fails the dispatch, so the test that caused it fails
  const window = new Window({ url, settings: { errorCapture: BrowserErrorCaptureEnum.disabled } });
  const classes = snapshotClasses(window);
  const values: Record<(typeof GLOBALS)[number], unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of GLOBALS) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  const container = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.appendChild(container as never);
  let root: Root | null = null;
  return {
    window,
    container,
    async render(node) {
      await act(async () => {
        root ??= createRoot(container);
        root.render(node);
      });
    },
    one<E extends Element>(selector: string): E {
      const found = container.querySelectorAll<E>(selector);
      if (found.length !== 1) throw new Error(`Expected 1 element matching ${selector}, found ${found.length}`);
      return found[0]!;
    },
    async type(field, value) {
      const prototype = field.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
        field.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
      });
    },
    async close() {
      try {
        await act(async () => { root?.unmount(); });
      } finally {
        root = null;
        try {
          await window.happyDOM.close();
        } finally {
          restoreClasses(classes);
          for (const [name, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
          }
        }
      }
    },
  };
}
