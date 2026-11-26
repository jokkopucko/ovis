import { TerminalInput } from "./input.ts";
import type { TerminalInputHost, TerminalInputModes } from "./input.ts";
import { detectInputPlatform } from "./platform.ts";

export type EventFields = Partial<KeyboardEvent & InputEvent & MouseEvent & WheelEvent> & {
  readonly clipboardData?: Pick<DataTransfer, "getData">;
};

export function rect(width = 0, height = 0): DOMRect {
  const box = { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height };
  return { ...box, toJSON: () => box };
}

export function dispatch(target: EventTarget, type: string, fields?: EventFields): Event {
  const event = Object.assign(new Event(type, { bubbles: true, composed: true, cancelable: true }), {
    key: "", code: "", keyCode: 0, buttons: 0, button: 0, ctrlKey: false, altKey: false,
    shiftKey: false, metaKey: false, getModifierState: () => false, ...fields,
  });
  target.dispatchEvent(event);
  return event;
}

export function fixture(options: {
  platform?: { platform: string; userAgent: string };
  cursor?: { x: number; y: number };
  cell?: { width: number; height: number };
} = {}) {
  const page = Object.assign(new EventTarget(), {
    defaultView: { navigator: options.platform, getComputedStyle: () => ({ getPropertyValue: () => "0px" }) },
    createElement: () => node(),
  });
  let active: HTMLElement | undefined;
  const children: HTMLElement[] = [];
  function node() {
    const classes = new Set<string>();
    return Object.assign(new EventTarget(), {
      ownerDocument: page, style: {}, value: "", textContent: "", className: "", selectionStart: 0, selectionEnd: 0,
      classList: {
        add: (name: string) => { classes.add(name); },
        remove: (name: string) => { classes.delete(name); },
        contains: (name: string) => classes.has(name),
        toggle: (name: string, force: boolean) => { if (force) classes.add(name); else classes.delete(name); return force; },
      },
      append: (...nodes: HTMLElement[]) => { children.push(...nodes); },
      remove() {}, select() {}, setAttribute() {},
      getBoundingClientRect: () => rect(),
      focus(this: HTMLElement) { if (active !== this) { active = this; dispatch(this, "focus"); } },
      blur(this: HTMLElement) { if (active === this) { active = undefined; dispatch(this, "blur"); } },
    });
  }
  // Bun has EventTarget but not HTML elements. Confine the DOM doubles to this boundary.
  const element: EventTarget = node();
  const screen: EventTarget = node();
  const modes: { -readonly [K in keyof TerminalInputModes]: TerminalInputModes[K] } = {
    applicationCursorKeys: false, applicationKeypad: false, bracketedPaste: false, sendFocus: false,
    mouseProtocol: "none", mouseEncoding: "default", alternateScreen: false,
  };
  const host: TerminalInputHost = {
    element: element as HTMLElement, screen: screen as HTMLElement, cols: () => 80, rows: () => 24, modes: () => modes,
    cell: () => options.cell ?? { width: 10, height: 14 }, cursor: () => options.cursor ?? null,
    cellWidth: () => 1, font: () => ({ family: "monospace", size: 15 }),
  };
  const term = new TerminalInput(host);
  const view = children.find((el) => el.className === "composition-view");
  if (!view) throw new Error("Missing composition view");
  const sent: string[] = [];
  term.onData((text) => sent.push(text));
  return { host, page, view, term, modes, sent, platform: detectInputPlatform(options.platform) };
}
