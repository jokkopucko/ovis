import type { ScreenCell, ScreenLine } from "../terminalScreen.ts";
import type { SelectionHost } from "./index.ts";

class TestElement extends EventTarget {
  parent: EventTarget | undefined;
  readonly style = { paddingLeft: "0", paddingTop: "0" };
  private readonly classes = new Set<string>();
  readonly classList = {
    contains: (name: string) => this.classes.has(name),
    remove: (name: string) => { this.classes.delete(name); },
    toggle: (name: string, enabled: boolean) => {
      if (enabled) this.classes.add(name);
      else this.classes.delete(name);
      return enabled;
    },
  };
  constructor(readonly ownerDocument: EventTarget) { super(); }
  append(child: TestElement): void { child.parent = this; }
  remove(): void { this.parent = undefined; }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
}

const zero = (): number => 0;
const yes = (): boolean => true;
const no = (): boolean => false;
function cell(chars = "", width = 1): ScreenCell {
  return {
    getChars: () => chars, getWidth: () => width, isBold: zero, isDim: zero, isItalic: zero,
    isUnderline: zero, isStrikethrough: zero, isOverline: zero, isInverse: zero, isInvisible: zero,
    isFgDefault: yes, isBgDefault: yes, isFgRGB: no, isBgRGB: no, getFgColor: zero, getBgColor: zero,
  };
}

export function terminal(lines = ["alpha beta", "0123456789", "abcdefghij"], options: {
  viewport?: number; wrapped?: number[]; platform?: string;
} = {}) {
  const cols = 10, visible = 3;
  const reporting = { mouse: false, alternate: false };
  let viewportY = options.viewport ?? 0;
  const intervals = new Map<number, () => void>();
  let nextInterval = 0;
  const view = Object.assign(new EventTarget(), {
    navigator: { platform: options.platform ?? "Linux" },
    getComputedStyle: (node: TestElement) => node.style,
    Element: TestElement,
    setInterval: (tick: () => void) => { intervals.set(++nextInterval, tick); return nextInterval; },
    clearInterval: (id: number) => { intervals.delete(id); },
  });
  const page = Object.assign(new EventTarget(), { defaultView: view });
  const outer = new TestElement(page);
  const grid = new TestElement(page);
  const body = new TestElement(page);
  body.append(outer);
  outer.append(grid);
  body.parent = page;
  const element: EventTarget = outer, screen: EventTarget = grid;
  const buffer = lines.map((text, y): ScreenLine => ({
    isWrapped: options.wrapped?.includes(y) ?? false,
    length: cols,
    getCell: (x) => x >= 0 && x < cols ? cell(text[x]) : undefined,
    translateToString: (trim = false, start = 0, end = cols) =>
      (trim ? text : text.padEnd(cols)).slice(start, end),
  }));
  const inputs = new EventTarget();
  const scrolls: number[] = [];
  const host = {
    // Bun has EventTarget but no HTML elements. Keep the partial DOM at the fixture boundary.
    element: element as HTMLElement, screen: screen as HTMLElement,
    cols: () => cols, rows: () => visible, cell: () => ({ width: 10, height: 20 }),
    screenRows: () => ({
      alternate: reporting.alternate, length: buffer.length, baseY: Math.max(0, buffer.length - visible), viewportY, cursorX: 0, cursorY: 0,
      getLine: (y) => buffer[y], getNullCell: () => cell(),
    }),
    scrollLines(amount) {
      scrolls.push(amount);
      viewportY = Math.max(0, Math.min(Math.max(0, buffer.length - visible), viewportY + amount));
    },
    mouseReporting: () => reporting.mouse, wordSeparator: () => " ",
    isMac: options.platform === "MacIntel", macOptionClickForcesSelection: true,
    onUserInput(listener) {
      inputs.addEventListener("input", listener);
      return () => inputs.removeEventListener("input", listener);
    },
  } satisfies SelectionHost;
  const mouse = (type: string, point: [number, number], init: MouseEventInit = {}, target: EventTarget = screen): Event => {
    const { bubbles = true, ...fields } = init;
    let stopped = false;
    const event = Object.assign(new Event(type, { bubbles, cancelable: true, composed: true }), {
      altKey: false, metaKey: false, shiftKey: false, ctrlKey: false,
      button: 0, detail: 1, buttons: type === "mouseup" ? 0 : 1,
      clientX: point[0], clientY: point[1], ...fields,
      // A dispatch resets native propagation flags; keep them across our synthetic DOM path.
      stopPropagation() { stopped = true; Event.prototype.stopPropagation.call(this); },
      stopImmediatePropagation() { stopped = true; Event.prototype.stopImmediatePropagation.call(this); },
    });
    for (let node: EventTarget | undefined = target; node; node = node instanceof TestElement ? node.parent : undefined) {
      node.dispatchEvent(event);
      if (!event.bubbles || stopped) break;
    }
    return event;
  };
  const click = (point: [number, number], init?: MouseEventInit): void => {
    mouse("mousedown", point, init);
    mouse("mouseup", point, init);
  };
  return {
    host, mouse, click, reporting, scrolls, page, body,
    tick: () => { for (const run of intervals.values()) run(); },
    input: () => inputs.dispatchEvent(new Event("input")),
    trim: (amount: number) => buffer.splice(0, amount),
  };
}
