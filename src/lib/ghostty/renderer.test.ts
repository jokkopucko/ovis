import { afterEach, expect, test } from "bun:test";
import { createRowsRenderer } from "./renderer.ts";
import { STYLE_INVERSE, STYLE_UNDERLINE_MASK, type GhosttyRun, type GhosttyVt } from "./vt.ts";
import { rowHtml } from "../terminalFold.ts";
import { testTerminal } from "./testTerminal.test-support.ts";

interface FakeElement {
  tagName: string;
  className: string;
  innerHTML: string;
  children: FakeElement[];
  style: Record<string, string> & { setProperty(name: string, value: string): void };
  attributes: Record<string, string>;
  get textContent(): string;
  set textContent(value: string);
  append(...nodes: FakeElement[]): void;
  remove(): void;
  setAttribute(name: string, value: string): void;
  getBoundingClientRect(): { width: number; height: number };
  getContext(): { font: string; measureText(text: string): { width: number } };
}

function makeElement(tagName: string): FakeElement {
  let text = "";
  const style: FakeElement["style"] = Object.assign({} as Record<string, string>, {
    setProperty(name: string, value: string) {
      style[name] = value;
    },
  });
  const el: FakeElement = {
    tagName,
    className: "",
    innerHTML: "",
    children: [],
    style,
    attributes: {},
    get textContent() {
      return text;
    },
    set textContent(value: string) {
      text = value;
      if (value === "") el.children = [];
    },
    append(...nodes: FakeElement[]) {
      el.children.push(...nodes);
    },
    remove() {},
    setAttribute(name: string, value: string) {
      el.attributes[name] = value;
    },
    getBoundingClientRect() {
      return { width: text.length * 8, height: 16 };
    },
    getContext() {
      return {
        font: "",
        measureText(value: string) {
          return { width: value.length * 24 };
        },
      };
    },
  };
  return el;
}

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

afterEach(() => {
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else delete (globalThis as { document?: unknown }).document;
});

function renderRows(rows: GhosttyRun[][], selection: (y: number) => readonly [number, number] | null = () => null, next: GhosttyRun[][] = rows) {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: (tag: string) => makeElement(tag) },
  });
  const screen = makeElement("div");
  let frameIndex = 0;
  const vt = {
    setColors() {},
    frame(draw: (y: number, runs: GhosttyRun[]) => void) {
      const drawn = frameIndex === 0 ? rows : next;
      for (let y = 0; y < drawn.length; y++) draw(y, drawn[y]!);
      frameIndex++;
      return frameIndex > 0;
    },
    cursor() {
      return { visible: false, x: 0, y: 0, style: 1 };
    },
    placedImages() {
      return null;
    },
  } as unknown as GhosttyVt;

  const renderer = createRowsRenderer(screen as unknown as HTMLElement, vt, () => ({
    fontFamily: "monospace",
    fontSize: 13,
    minimumContrastRatio: 4.5,
  }));
  renderer.fit(40, rows.length, 8, 16);
  renderer.draw(selection, true, true);
  // the second draw announces the lines `next` changed
  renderer.draw(selection, true, true);
  const layer = screen.children[0]!;
  const textLayer = layer.children[1]!;
  const announcer = layer.children[4]!;
  const html = textLayer.children.map((row) => row.innerHTML);
  const announced = announcer.textContent;
  renderer.dispose();
  return { html, announced };
}

const placeholder = "\u{10eeee}\u0305\u0305";
const nextCol = "\u{10eeee}\u0305\u030d";
/** each painted span of a row: its style and its text */
const spans = (html: string): { style: string; text: string }[] =>
  [...html.matchAll(/<span style="([^"]*)">([^<]*)<\/span>/g)].map((m) => ({ style: m[1]!, text: m[2]! }));

test("hides Kitty Unicode placeholders in the text layer while preserving columns, backgrounds and following text", () => {
  const { html } = renderRows([
    [{ x: 1, fg: "#000001", bg: null, flags: STYLE_UNDERLINE_MASK, cells: [{ text: placeholder, wide: false }, { text: nextCol, wide: false }, { text: " ", wide: false }, { text: "O", wide: false }, { text: "K", wide: false }] }],
    [{ x: 0, fg: "#000002", bg: "#112233", flags: 0, cells: [{ text: placeholder, wide: false }, { text: nextCol, wide: false }] }],
  ]);
  expect(html.join("")).not.toContain("\u{10eeee}");
  expect(html[0]).not.toContain("ghostty-icon");
  const [blank, text] = spans(html[0]!);
  expect(blank!.text).toBe("  ");
  expect(blank!.style).toContain("left:calc(var(--ghostty-cw)*1)");
  expect(blank!.style).not.toContain("underline");
  expect(text!.text).toBe(" OK");
  expect(text!.style).toContain("left:calc(var(--ghostty-cw)*3)");
  expect(text!.style).toContain("underline");
  expect(spans(html[1]!).map((span) => span.text)).toEqual(["  "]);
  expect(html[1]).toContain("background:#112233");
});

test("a placeholder under reverse video paints the background its neighbour of the same style paints", () => {
  const { html } = renderRows([[{ x: 0, fg: "#aabbcc", bg: "#112233", flags: STYLE_INVERSE, cells: [{ text: placeholder, wide: false }, { text: "x", wide: false }] }]]);
  const backgrounds = spans(html[0]!).map((span) => /background:([^;]*)/.exec(span.style)?.[1]);
  expect(backgrounds).toEqual(["#aabbcc", "#aabbcc"]);
});

test("omits placeholder background on selected cells", () => {
  const { html } = renderRows(
    [[{ x: 0, fg: "#000001", bg: "#112233", flags: 0, cells: [{ text: placeholder, wide: false }, { text: placeholder, wide: false }] }]],
    (y) => (y === 0 ? [0, 1] : null),
  );
  const [selected, unselected] = spans(html[0]!);
  expect(selected!.style).not.toContain("background");
  expect(unselected!.style).toContain("background:#112233");
});

test("announces a new line without its placeholders", () => {
  const row = (text: string): GhosttyRun[] => [{ x: 0, fg: null, bg: null, flags: 0, cells: [{ text: placeholder, wide: false }, ...[...text].map((ch) => ({ text: ch, wide: false }))] }];
  const { announced } = renderRows([row("")], () => null, [row(" done")]);
  expect(announced).toContain("done");
  expect(announced).not.toContain("\u{10eeee}");
});

test("folded row HTML replaces Kitty Unicode placeholders with spaces", async () => {
  const term = await testTerminal({ cols: 20, rows: 4 });
  try {
    term.write("\x1b[38;2;0;0;1m\u{10eeee}\u0305\u0305\u{10eeee}\u0305\u030d\x1b[0m Swarm");
    const rows = term.buffer.active;
    const line = rows.getLine(rows.baseY);
    if (!line) throw new Error("missing line");
    const html = rowHtml(line, 20, { foreground: "#d4d4d4", background: "#1e1e1e" }, rows.getNullCell(), 4.5);
    expect(html).not.toContain("\u{10eeee}");
    expect(html.replace(/<[^>]*>/g, "")).toBe("   Swarm");
  } finally {
    term.dispose();
  }
});
