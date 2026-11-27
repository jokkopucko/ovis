import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Ovis for Mac's header in the title bar's place (app/mac/Resources/title-bar.js), run as the app runs it in a page. */
type Ask = { ask: "drag"; x: number; y: number } | { ask: "zoom" };
type TitleBar = (document: FakeDocument, height: number, inset: number, post: (ask: Ask) => void) => void;
const source = readFileSync(join(import.meta.dir, "..", "app", "mac", "Resources", "title-bar.js"), "utf8");
const titleBar = new Function(`${source}\nreturn ovisTitleBar;`)() as TitleBar;

/**
 * An element as the script reads it: its classes, its tab order, its box, its descendants, and `matches` for a list
 * of tags, `[attr]` and `[attr=value]`.
 */
class FakeElement {
  constructor(readonly tag: string, readonly attrs: Record<string, string> = {}, readonly parentElement: FakeElement | null = null) {}
  readonly classList = { contains: (name: string) => (this.attrs.class ?? "").split(" ").includes(name) };
  box = { left: 0, right: 0, top: 0, bottom: 0 };
  getBoundingClientRect() {
    return this.box;
  }
  contains(other: FakeElement): boolean {
    for (let node: FakeElement | null = other; node; node = node.parentElement) if (node === this) return true;
    return false;
  }
  get tabIndex(): number {
    return this.attrs.tabindex === undefined ? (["button", "input", "select", "textarea"].includes(this.tag) ? 0 : -1) : Number(this.attrs.tabindex);
  }
  matches(selectors: string): boolean {
    return selectors.split(",").map((one) => one.trim()).some((one) => {
      const attr = /^\[([\w-]+)(?:=([\w-]+))?\]$/.exec(one);
      if (!attr) return one === this.tag;
      const value = this.attrs[attr[1]!];
      return value !== undefined && (attr[2] === undefined || value === attr[2]);
    });
  }
}

type Press = { button: number; detail: number; clientX: number; clientY: number };
type Listener = (event: Press & { target: FakeElement }) => void;
class FakeDocument {
  readonly properties = new Map<string, string>();
  readonly documentElement = { dataset: {} as Record<string, string>, style: { setProperty: (name: string, value: string) => { this.properties.set(name, value); } } };
  readonly listeners: { type: string; listener: Listener }[] = [];
  readonly elements: FakeElement[] = [];
  querySelectorAll(selector: string): FakeElement[] {
    return this.elements.filter((element) => element.classList.contains(selector.replace(/^\./, "")));
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.push({ type, listener });
  }
  fire(type: string, target: FakeElement, event: Partial<Press> = {}) {
    for (const entry of this.listeners) if (entry.type === type) entry.listener({ button: 0, detail: type === "dblclick" ? 2 : 1, clientX: 300, clientY: 200, ...event, target });
  }
}

/**
 * The page's header: a title on its bare surface, a button, an open menu and a focusable group in it, and the pane
 * below. Beside it, the inbox's top bars and rail, and a screen with no bar.
 */
function page() {
  const document = new FakeDocument();
  const app = new FakeElement("div", { class: "app", tabindex: "-1" });
  const header = new FakeElement("header", { class: "app-header is-zoned" }, app);
  const title = new FakeElement("span", { class: "context-title-text", role: "group" }, new FakeElement("div", { class: "context" }, header));
  const button = new FakeElement("svg", {}, new FakeElement("button", { class: "icon-button" }, header));
  const menu = new FakeElement("div", { class: "row-menu-header", role: "presentation" }, new FakeElement("div", { role: "menu" }, header));
  const switcher = new FakeElement("div", { class: "segmented", role: "group" }, header);
  const scrim = new FakeElement("div", { class: "modal-scrim" });
  const pane = new FakeElement("div", { class: "terminal-host" }, app);
  const row = new FakeElement("span", {}, new FakeElement("div", { class: "agent-row", tabindex: "0" }, header));
  const inboxTop = new FakeElement("div", { class: "inbox-top" }, app);
  const search = new FakeElement("input", {}, inboxTop);
  const threadTop = new FakeElement("span", { class: "thread-chip-name" }, new FakeElement("div", { class: "thread-top" }, app));
  const rail = new FakeElement("nav", { class: "inbox-rail" }, app);
  const screen = new FakeElement("main", { class: "access-gate-screen" });
  // the wide inbox's thread bar over a chat, letting presses through to it (InboxMode.css)
  const column = new FakeElement("div", { class: "pane-column is-chat" }, app);
  const threadBar = new FakeElement("div", { class: "thread-top" }, column);
  threadBar.box = { left: 400, right: 1000, top: 0, bottom: 52 };
  const chat = new FakeElement("p", {}, new FakeElement("div", { class: "chat-scroll", tabindex: "0" }, column));
  document.elements.push(threadBar);
  const asked: Ask[] = [];
  titleBar(document, 40, 72, (ask) => asked.push(ask));
  return { document, header, title, button, menu, switcher, scrim, pane, row, inboxTop, search, threadTop, rail, screen, chat, asked };
}

const drag = (x = 300, y = 200): Ask => ({ ask: "drag", x, y });

describe("Mac app title bar", () => {
  test("marks the page and the lights' corner, and hands it the bar's height and the traffic lights' right edge", () => {
    const { document } = page();
    expect(document.documentElement.dataset).toEqual({ macTitleBar: "", windowControls: "" });
    expect(Object.fromEntries(document.properties)).toEqual({ "--mac-title-bar-h": "40px", "--mac-title-bar-inset": "72px" });
  });

  test("asks to move the window from a press on the header's bare surface, even under a focusable app, with where it was", () => {
    const { document, header, title, asked } = page();
    document.fire("mousedown", title, { clientX: 140, clientY: 18 });
    document.fire("mousedown", header, { clientX: 600, clientY: 30 });
    expect(asked).toEqual([drag(140, 18), drag(600, 30)]);
  });

  test("asks to move the window from the inbox's top bars, off their controls", () => {
    const { document, inboxTop, search, threadTop, asked } = page();
    for (const target of [inboxTop, threadTop, search]) document.fire("mousedown", target);
    expect(asked).toEqual([drag(), drag()]);
  });

  test("asks to move the window from a press within the bar's height of the window's top where no bar is, as a title bar's", () => {
    const { document, rail, screen, pane, asked } = page();
    document.fire("mousedown", rail, { clientY: 39 });
    document.fire("mousedown", screen, { clientY: 10 });
    document.fire("mousedown", rail, { clientY: 40 });
    document.fire("mousedown", pane, { clientY: 300 });
    expect(asked).toEqual([drag(300, 39), drag(300, 10)]);
  });

  test("asks to move the window from a press the inbox's thread bar lets through to its pane, inside the bar's box only", () => {
    const { document, chat, scrim, asked } = page();
    document.fire("mousedown", chat, { clientX: 500, clientY: 45 });
    document.fire("mousedown", chat, { clientX: 500, clientY: 60 });
    document.fire("mousedown", scrim, { clientX: 500, clientY: 45 });
    expect(asked).toEqual([drag(500, 45)]);
  });

  test("leaves a press on a control, a focusable row, a modal scrim, in an open menu, on a group of buttons or off the bars to the page", () => {
    const { document, button, row, scrim, menu, switcher, pane, asked } = page();
    for (const target of [button, row, scrim, menu, switcher]) document.fire("mousedown", target, { clientY: 20 });
    document.fire("mousedown", pane);
    expect(asked).toEqual([]);
  });

  test("takes neither a double click's second press nor another button as a move", () => {
    const { document, title, asked } = page();
    document.fire("mousedown", title, { detail: 2 });
    document.fire("mousedown", title, { button: 2 });
    expect(asked).toEqual([]);
  });

  test("a double click on the bare surface does what a title bar's does, and only there", () => {
    const { document, title, button, asked } = page();
    document.fire("dblclick", title);
    document.fire("dblclick", button);
    expect(asked).toEqual([{ ask: "zoom" }]);
  });

  test("runs once per page, as the app may run it again on the same page", () => {
    const { document, title, asked } = page();
    titleBar(document, 52, 90, (ask) => asked.push(ask));
    document.fire("mousedown", title);
    expect(asked).toEqual([drag()]);
    expect(document.properties.get("--mac-title-bar-h")).toBe("40px");
  });
});
