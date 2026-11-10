import { afterEach, describe, expect, it } from "bun:test";
import type { Terminal } from "@xterm/xterm";

import { adjustTerminalGlyphs, coversAny, displayText, followLateFaces, glyphFit, graphemes, iconScale, type LateFace, oversizedIcon, stretchedView, textPresentation } from "./terminalGlyphs.ts";

// iPhone Safari at 13px: Menlo cells are 7.84px, Hangul from Apple SD Gothic Neo 11.24px
const IOS_CELL = 7.8367;
const IOS_HANGUL = 11.245;

describe("glyphFit", () => {
  it("widens an iPhone Hangul syllable as far as a stretch goes, enlarges it for the rest, capped, and centers what is left", () => {
    const fit = glyphFit(2 * IOS_CELL - IOS_HANGUL, IOS_HANGUL, IOS_CELL);
    expect(fit?.stretch).toBe(1.1);
    expect(fit!.scale * fit!.stretch).toBeCloseTo(1.2, 6);
    // the glyph and the spacing after scaling still fill exactly the two cells
    expect(IOS_HANGUL * fit!.scale * fit!.stretch + fit!.spacing).toBeCloseTo(2 * IOS_CELL, 6);
    expect(fit!.spacing).toBeGreaterThan(0);
  });

  it("widens a 1em Hangul or Han glyph until it fills 90% of its cells, keeping its height", () => {
    const fit = glyphFit(2 * IOS_CELL - 13, 13, IOS_CELL);
    // D2Coding's syllable beside Menlo: enlarged it grew as tall as the row, and Korean lines touched
    expect(fit!.scale).toBe(1);
    expect(13 * fit!.stretch).toBeCloseTo(0.9 * 2 * IOS_CELL, 6);
    expect(fit!.spacing).toBeCloseTo(0.1 * 2 * IOS_CELL, 6);
  });

  it("leaves a glyph that nearly fills its cells as drawn (CJK on Linux)", () => {
    expect(glyphFit(1.04, 13, 7.02)).toBeNull();
  });

  it("only centers a narrow glyph in one cell, never enlarges it", () => {
    expect(glyphFit(IOS_CELL - 3.25, 3.25, IOS_CELL)).toEqual({ scale: 1, stretch: 1, spacing: IOS_CELL - 3.25 });
  });

  it("leaves rounding-level spacing and glyphs wider than their cells alone", () => {
    expect(glyphFit(0.6, 4, 4.6)).toBeNull();
    expect(glyphFit(2 * IOS_CELL - 17, 17, IOS_CELL)).toBeNull();
  });
});

describe("icons fitted to their cells", () => {
  it("takes a Nerd Font icon wider than its cell for one to fit, and nothing else", () => {
    // Symbols Nerd Font Mono advances 1em: 13px against a 6.5px cell
    expect(oversizedIcon("\uf07b", 13, 6.5)).toBe(true);
    expect(oversizedIcon("\u{f0219}", 13, 7.8)).toBe(true);
    expect(oversizedIcon("\uf07b", 7, 6.5)).toBe(false);
    expect(oversizedIcon("👍", 13, 6.5)).toBe(false);
    expect(oversizedIcon("①", 13, 6.5)).toBe(false);
    expect(oversizedIcon("a", 13, 6.5)).toBe(false);
  });

  it("scales a run so its widest icon fills its cell", () => {
    expect(iconScale([13, 13], 6.5)).toBe(0.5);
    expect(iconScale([13, 10], 6.5)).toBe(0.5);
    expect(iconScale([6], 6.5)).toBe(1);
  });
});

describe("textPresentation", () => {
  it("asks a text-default symbol for its text form, so iOS does not draw ⏺ as a two-cell emoji", () => {
    expect(textPresentation("⏺ ✔")).toBe("⏺\ufe0e ✔\ufe0e");
  });

  it("leaves a span alone when it already chooses a presentation anywhere", () => {
    // xterm measured ⏺️ as the emoji it asks to be; respacing it as text would shift X
    expect(textPresentation("⏺\ufe0fX")).toBeNull();
    expect(textPresentation("⏺⏺\ufe0f")).toBeNull();
    expect(textPresentation("⏺\ufe0e")).toBeNull();
  });

  it("leaves emoji and plain text alone", () => {
    expect(textPresentation("😀#1 ●")).toBeNull();
  });
});

describe("displayText", () => {
  it("composes stacked marks iOS Safari would drop", () => {
    expect(displayText("Tie\u0302\u0301ng a\u0306\u0309")).toBe("Tiếng ẳ");
  });

  it("composes decomposed Hangul into its syllables", () => {
    expect(displayText("\u1112\u1161\u11ab\u1100\u1173\u11af")).toBe("한글");
  });

  it("keeps text without marks as it is", () => {
    expect(displayText("한글 ﾊﾝｶｸ ㄱㅏ abc")).toBe("한글 ﾊﾝｶｸ ㄱㅏ abc");
  });
});

// PaneTerminal.css's faces, as FontFace gives them back (Chrome quotes the family, WebKit does not)
const ICON_RANGE = "U+e000-f8ff, U+f0000-ffffd";
const HANGUL_RANGE = "U+3131-318e, U+ac00-d7a3";
const STACK = '"Symbols Nerd Font Mono", Pretendard Variable, Menlo, "Noto Sans Mono CJK KR", "Ovis Hangul Mono", monospace';

describe("coversAny", () => {
  it("finds a face for text with any character in its ranges", () => {
    expect(coversAny(HANGUL_RANGE, "[나라]")).toBe(true);
    expect(coversAny(HANGUL_RANGE, "ab ㄱ")).toBe(true);
    expect(coversAny(HANGUL_RANGE, "abc 漢字")).toBe(false);
  });

  it("reads single code points, upper case and wildcards", () => {
    expect(coversAny("u+7c", "a|b")).toBe(true);
    expect(coversAny("U+AC00-D7A3", "한")).toBe(true);
    expect(coversAny("U+4??", "\u04ff")).toBe(true);
    expect(coversAny("U+4??", "\u0500")).toBe(false);
  });

  it("takes a face with no range for every character", () => {
    expect(coversAny("U+0-10FFFF", "🙂")).toBe(true);
  });
});

interface FakeFace extends LateFace {
  status: string;
  arrive(): void;
  fail(): void;
}

const face = (family: string, unicodeRange: string, status = "unloaded"): FakeFace => {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const fake: FakeFace = {
    family, unicodeRange, status, loaded: promise,
    arrive: () => { fake.status = "loaded"; resolve(); },
    fail: () => { fake.status = "error"; reject(new Error("network")); },
  };
  return fake;
};

/** A terminal's late faces, with its frames run by hand. */
const follow = (faces: FakeFace[]) => {
  const frames: (() => void)[] = [];
  let arrivals = 0;
  const late = followLateFaces(faces, (callback) => { frames.push(callback); }, () => { arrivals += 1; });
  return { late, frames, arrivals: () => arrivals, runFrames: () => { for (const callback of frames.splice(0)) callback(); } };
};

// what follows each face ran before this: it was attached first
const settled = (faces: FakeFace[]) => Promise.allSettled(faces.map((each) => each.loaded));

describe("followLateFaces", () => {
  it("measures again once for faces that arrive between two frames, and again for a later one", async () => {
    const icons = face('"Symbols Nerd Font Mono"', ICON_RANGE);
    const regular = face("Ovis Hangul Mono", HANGUL_RANGE);
    const bold = face("Ovis Hangul Mono", HANGUL_RANGE);
    const { late, frames, arrivals, runFrames } = follow([icons, regular, bold]);
    late.ask(STACK, "\uf07b 가");
    icons.arrive();
    regular.arrive();
    await settled([icons, regular]);
    expect(frames).toHaveLength(1);
    runFrames();
    expect(arrivals()).toBe(1);

    bold.arrive();
    await settled([bold]);
    runFrames();
    expect(arrivals()).toBe(2);
  });

  it("measures again for a chunk that arrived when another chunk of the text failed", async () => {
    const first = face("Pretendard Variable", "U+ac00-b097");
    const second = face("Pretendard Variable", "U+b098-d7a3");
    const { late, arrivals, runFrames } = follow([first, second]);
    late.ask(STACK, "가나");
    first.fail();
    second.arrive();
    await settled([first, second]);
    runFrames();
    expect(arrivals()).toBe(1);
  });

  it("follows the face of a character drawn while another face of its family is loading", async () => {
    const loading = face("Pretendard Variable", "U+ac00-b097", "loading");
    const later = face("Pretendard Variable", "U+b098-d7a3");
    const { late, arrivals, runFrames } = follow([loading, later]);
    late.ask(STACK, "가");
    late.ask(STACK, "a나");
    loading.fail();
    later.arrive();
    await settled([loading, later]);
    runFrames();
    expect(arrivals()).toBe(1);
  });

  it("follows a face whose family was typed in another case, as CSS matches it", async () => {
    const chunk = face('"Pretendard Variable"', "U+ac00-d7a3");
    const { late, arrivals, runFrames } = follow([chunk]);
    late.ask('"Symbols Nerd Font Mono", "pretendard variable", Menlo, monospace', "나");
    chunk.arrive();
    await settled([chunk]);
    runFrames();
    expect(arrivals()).toBe(1);
  });

  it("follows no face that loaded, failed, stands outside the stack or covers none of the text", async () => {
    const faces = [
      face("Ovis Hangul Mono", HANGUL_RANGE, "loaded"),
      face("Ovis Hangul Mono", HANGUL_RANGE, "error"),
      face('"JetBrains Mono Web"', "U+0-10ffff"),
      face('"Symbols Nerd Font Mono"', ICON_RANGE),
    ];
    const { late, frames } = follow(faces);
    late.ask(STACK, "가");
    for (const each of faces) each.arrive();
    await settled(faces);
    expect(frames).toHaveLength(0);
  });

  it("measures again for a face that arrived while its characters were boxes once one is drawn from it", async () => {
    const lines = face("Late Lines", "U+2500-257F");
    const { late, frames, arrivals, runFrames } = follow([lines]);
    late.ask("Late Lines, monospace", "\u2500", true);
    lines.arrive();
    await settled([lines]);
    expect(frames).toHaveLength(0);
    late.ask("Late Lines, monospace", "\u2500");
    runFrames();
    expect(arrivals()).toBe(1);
    // measured again: drawing it from the face once more changes nothing
    late.ask("Late Lines, monospace", "\u2500");
    expect(frames).toHaveLength(0);
  });

  it("measures again on arrival for a face a character drawn from it asked for while it loaded", async () => {
    const lines = face("Late Lines", "U+2500-257F");
    const { late, arrivals, runFrames } = follow([lines]);
    late.ask("Late Lines, monospace", "\u2500", true);
    late.ask("Late Lines, monospace", "\u2502");
    lines.arrive();
    await settled([lines]);
    runFrames();
    expect(arrivals()).toBe(1);
  });

  it("measures nothing again for a terminal that stopped", async () => {
    const icons = face('"Symbols Nerd Font Mono"', ICON_RANGE);
    const hangul = face("Ovis Hangul Mono", HANGUL_RANGE);
    const { late, frames, arrivals, runFrames } = follow([icons, hangul]);
    late.ask(STACK, "\uf07b가");
    icons.arrive();
    await settled([icons]);
    late.stop();
    runFrames();
    hangul.arrive();
    await settled([hangul]);
    expect(frames).toHaveLength(0);
    expect(arrivals()).toBe(0);
  });
});

const GLOBALS = ["document", "HTMLSpanElement", "MutationObserver", "requestAnimationFrame", "window"] as const;

/** What the renderer needs of a span: its text, classes, inline style and children. */
class FakeSpan {
  textContent = "";
  className = "";
  style: Record<string, string> = { letterSpacing: "", cssText: "" };
  children: FakeSpan[] = [];
  classList = { contains: (name: string) => this.className.split(" ").includes(name) };
  append(...nodes: FakeSpan[]): void { this.children.push(...nodes); }
  replaceChildren(...nodes: FakeSpan[]): void { this.children = nodes; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0 }; }
}

/**
 * adjustTerminalGlyphs on a stand-in page: one 7.8px cell per column, a canvas that measures an icon
 * 6px wide while its face has not loaded (the stand-in's width) and 13px once it has, xterm's rows
 * redrawn only when the test says (`draw`), and frames run by hand.
 */
function glyphPage(faces: FakeFace[], texts = ["\uf07b", "가"], composing = false) {
  const before = GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const frames: (() => void)[] = [];
  const observers: ((records: { addedNodes: FakeSpan[] }[]) => void)[] = [];
  const icons = faces.find((each) => each.family.includes("Symbols"))!;
  // a late box-drawing face draws its lines 13px wide, the stand-in 7.8px
  const lines = faces.find((each) => each.family.includes("Late Lines"));
  // and Hangul 13px, a 1em syllable
  const measure = { font: "", measureText: (text: string) => ({ width: /[\ue000-\uf8ff]/u.test(text) ? (icons.status === "loaded" ? 13 : 6)
    : /[\u2500-\u257f]/u.test(text) && lines?.status === "loaded" ? 13 : /^[\uac00-\ud7a3]/u.test(text) ? 13 : 7.8 }) };
  const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  define("document", { fonts: faces, createElement: (tag: string) => tag === "canvas" ? { getContext: () => measure } : new FakeSpan() });
  define("HTMLSpanElement", FakeSpan);
  define("MutationObserver", class { constructor(callback: (records: { addedNodes: FakeSpan[] }[]) => void) { observers.push(callback); } observe() {} disconnect() {} });
  define("requestAnimationFrame", (callback: () => void) => frames.push(callback));
  define("window", { devicePixelRatio: 1 });
  const span = (text: string): FakeSpan => Object.assign(new FakeSpan(), { textContent: text });
  const drawn = texts.map(span);
  const rows = { querySelectorAll: () => drawn, getBoundingClientRect: () => ({ left: 0, top: 0, width: 78 }), offsetWidth: 78 };
  // xterm's composition view, open while an IME composes, and the element its WidthCache measures in:
  // a Hangul syllable 13px wide there once a late Hangul face has loaded, 11.245px in the stand-in
  // before it, anything else a 7.8px cell
  const hangul = faces.find((each) => each.family.includes("Hangul"));
  const view = Object.assign(new FakeSpan(), { className: "composition-view active" });
  Object.assign(view.style, { fontSize: "13px", transform: "", transformOrigin: "", paddingLeft: "" });
  const xtermMeasure = {
    textContent: "", reads: 0,
    get offsetWidth() {
      this.reads += 1;
      const syllable = hangul && hangul.status !== "loaded" ? IOS_HANGUL : 13;
      return this.textContent.length * (/^[\uac00-\ud7a3]/u.test(this.textContent) ? syllable : 7.8);
    },
  };
  const screen = { style: { width: "78px", height: "15px" }, querySelector: (selector: string) => composing && selector === ".composition-view" ? view : null };
  const term = {
    cols: 10, rows: 1, refreshes: 0,
    options: { fontFamily: '"Symbols Nerd Font Mono", Menlo, "Ovis Hangul Mono", monospace', fontSize: 13, fontWeight: "normal", fontWeightBold: "bold" },
    element: { querySelector: (selector: string) => selector === ".xterm-rows" ? rows : selector === ".xterm-screen" ? screen
      : selector.endsWith(".xterm-char-measure-element") ? xtermMeasure : null },
    refresh() { term.refreshes += 1; },
  };
  const stop = adjustTerminalGlyphs(term as unknown as Terminal);
  return {
    term, stop, view, xtermMeasure,
    runFrames: () => { for (const callback of frames.splice(0)) callback(); },
    /** xterm writes the composition view's text, which its observer sees as a mutation */
    compose: (text: string): void => {
      view.textContent = text;
      observers[1]!([]);
    },
    /** xterm draws a row again: its new span goes through the observer, as a MutationObserver delivers it */
    draw: (text: string, className = "", letterSpacing = ""): FakeSpan => {
      const added = Object.assign(span(text), { className });
      added.style["letterSpacing"] = letterSpacing;
      observers[0]!([{ addedNodes: [added] }]);
      return added;
    },
    restore: () => { for (const [name, descriptor] of before) descriptor ? Object.defineProperty(globalThis, name, descriptor) : Reflect.deleteProperty(globalThis, name); },
  };
}

/** the font size an icon was drawn at inside its cell, or null when its span was left as xterm drew it */
const iconSize = (span: FakeSpan): number | null => {
  const glyphs = span.children[0]?.children[0];
  const size = glyphs?.style["cssText"]?.match(/font-size:([\d.]+)px/);
  return size ? Number(size[1]) : null;
};

/** a declaration of a span's inline style, as the fit appended it (the last one wins) */
const declared = (span: FakeSpan, property: string): string | undefined =>
  [...span.style["cssText"]!.matchAll(new RegExp(`(?:^|;)${property}:([^;]*)`, "g"))].at(-1)?.[1];

describe("adjustTerminalGlyphs fitting wide glyphs", () => {
  let page: ReturnType<typeof glyphPage> | undefined;
  afterEach(() => {
    page?.stop();
    page?.restore();
    page = undefined;
  });

  it("draws a Hangul run at the font's own height, widened to its cells, and keeps the next column", () => {
    page = glyphPage([face('"Symbols Nerd Font Mono"', ICON_RANGE)], []);
    // xterm gives each 13px syllable the rest of its two 7.8px cells
    const cells = page.draw("한글입", "", `${2 * 7.8 - 13}px`);
    // xterm's span keeps the cells' background on a box neither stretched nor clipped, the glyphs inside it are fitted
    expect(declared(cells, "transform")).toBeUndefined();
    expect(declared(cells, "clip-path")).toBeUndefined();
    expect(cells.style["letterSpacing"]).toBe("0px");
    const run = cells.children[0]!;
    expect(run.textContent).toBe("한글입");
    expect(declared(run, "font-size")).toBeUndefined();
    const stretch = Number(declared(run, "transform")?.match(/^scaleX\(([\d.]+)\)$/)?.[1]);
    expect(13 * stretch).toBeCloseTo(0.9 * 2 * 7.8, 5);
    expect(declared(run, "transform-origin")).toBe("0 0");
    const px = (property: string): number => Number.parseFloat(declared(run, property)!);
    // each syllable and its spacing, stretched, take its two cells, centered
    expect((13 + px("letter-spacing")) * stretch).toBeCloseTo(2 * 7.8, 5);
    expect(px("padding-left") * stretch * 2).toBeCloseTo(2 * 7.8 - 13 * stretch, 5);
    // laid out unstretched, the run with its margin ends where its three syllables' six cells end
    expect(px("padding-left") + 3 * (13 + px("letter-spacing")) + px("margin-right")).toBeCloseTo(6 * 7.8, 5);
  });

  it("counts a syllable with a mark that does not compose as one character, so the next column stays", () => {
    page = glyphPage([face('"Symbols Nerd Font Mono"', ICON_RANGE)], []);
    // NFC keeps U+0301 after the syllable: two characters in four cells
    const run = page.draw("한\u0301글", "", `${2 * 7.8 - 13}px`).children[0]!;
    expect(graphemes(run.textContent)).toBe(2);
    const px = (property: string): number => Number.parseFloat(declared(run, property)!);
    expect(px("padding-left") + 2 * (13 + px("letter-spacing")) + px("margin-right")).toBeCloseTo(4 * 7.8, 5);
  });
});

/** everything the fit writes to the composition view */
const viewFit = (view: FakeSpan) => ({
  fontSize: view.style["fontSize"], transform: view.style["transform"], transformOrigin: view.style["transformOrigin"],
  letterSpacing: view.style["letterSpacing"], paddingLeft: view.style["paddingLeft"],
});

/** the fit a page that never measured before gives one composing syllable */
function freshViewFit(faces: FakeFace[], text: string, fontSize = 13) {
  const fresh = glyphPage(faces, [], true);
  try {
    fresh.term.options.fontSize = fontSize;
    fresh.compose(text);
    return viewFit(fresh.view);
  } finally {
    fresh.stop();
    fresh.restore();
  }
}

describe("adjustTerminalGlyphs fitting the composition view", () => {
  let page: ReturnType<typeof glyphPage> | undefined;
  afterEach(() => {
    page?.stop();
    page?.restore();
    page = undefined;
  });

  it("measures a composing syllable once for its glyph and font, however often xterm rewrites the box", () => {
    const faces = [face('"Symbols Nerd Font Mono"', ICON_RANGE)];
    const larger = freshViewFit(faces, "한", 14);
    page = glyphPage(faces, [], true);
    // an IME's keys rewrite the box's text, place and font several times each
    for (const text of ["ㅎ", "하", "한"]) page.compose(text);
    const fitted = viewFit(page.view);
    expect(fitted.transform).toMatch(/^scaleX\(/);
    expect(fitted.transformOrigin).toBe("0 0");
    expect(Number.parseFloat(fitted.letterSpacing!)).toBeGreaterThan(0);
    expect(Number.parseFloat(fitted.paddingLeft!)).toBeGreaterThan(0);
    expect(page.xtermMeasure.reads).toBe(3);
    for (const text of ["한", "하", "한"]) page.compose(text);
    expect(page.xtermMeasure.reads).toBe(3);
    expect(viewFit(page.view)).toEqual(fitted);
    // xterm's own element holds what it held before each measure
    expect(page.xtermMeasure.textContent).toBe("");

    page.term.options.fontSize = 14;
    page.compose("한");
    expect(page.xtermMeasure.reads).toBe(4);
    expect(viewFit(page.view)).toEqual(larger);
    expect(larger.fontSize).not.toBe(fitted.fontSize);
  });

  it("measures a composing syllable again once its face arrived, though a later arrival set the family back", async () => {
    const inFace = freshViewFit([face('"Symbols Nerd Font Mono"', ICON_RANGE, "loaded"), face('"Ovis Hangul Mono"', HANGUL_RANGE, "loaded")], "한");
    const icons = face('"Symbols Nerd Font Mono"', ICON_RANGE);
    const hangul = face('"Ovis Hangul Mono"', HANGUL_RANGE);
    page = glyphPage([icons, hangul], ["\uf07b", "가"], true);
    const family = page.term.options.fontFamily;
    page.compose("한");
    const inStandIn = viewFit(page.view);
    expect(page.xtermMeasure.reads).toBe(1);
    // each arrival in a frame of its own: the second sets the family back as it was
    hangul.arrive();
    await settled([hangul]);
    page.runFrames();
    icons.arrive();
    await settled([icons]);
    page.runFrames();
    expect(page.term.options.fontFamily).toBe(family);
    page.compose("한");
    expect(page.xtermMeasure.reads).toBe(2);
    expect(viewFit(page.view)).toEqual(inFace);
    expect(inFace).not.toEqual(inStandIn);
  });
});

describe("adjustTerminalGlyphs fitting a syllable composed before any row drew its script", () => {
  let page: ReturnType<typeof glyphPage> | undefined;
  afterEach(() => {
    page?.stop();
    page?.restore();
    page = undefined;
  });

  it("measures it again once its face arrived, though no row had asked for that face", async () => {
    const inFace = freshViewFit([face('"Symbols Nerd Font Mono"', ICON_RANGE, "loaded"), face('"Ovis Hangul Mono"', HANGUL_RANGE, "loaded")], "한");
    const icons = face('"Symbols Nerd Font Mono"', ICON_RANGE);
    const hangul = face('"Ovis Hangul Mono"', HANGUL_RANGE);
    // no row holds Korean yet: the composition is the first text to reach the face
    page = glyphPage([icons, hangul], [], true);
    const family = page.term.options.fontFamily;
    page.compose("한");
    const inStandIn = viewFit(page.view);
    expect(page.xtermMeasure.reads).toBe(1);
    hangul.arrive();
    await settled([hangul]);
    page.runFrames();
    page.compose("하");
    page.compose("한");
    expect(viewFit(page.view)).toEqual(inFace);
    expect(inFace).not.toEqual(inStandIn);
    // no row drew from the face: the rows are not drawn again and the family is left as it was
    expect(page.term.refreshes).toBe(0);
    expect(page.term.options.fontFamily).toBe(family);
  });
});

describe("stretchedView", () => {
  it("adds the stretch to xterm's move of a long composition, counting the stretched width", () => {
    expect(stretchedView("translateX(min(0px, calc(40px - 100%)))", "scaleX(1.1)")).toBe("translateX(min(0px, calc(40px - 110%))) scaleX(1.1)");
    // as Chromium gives the same value back
    expect(stretchedView("translateX(min(0px, -100% + 40px))", "scaleX(1.1)")).toBe("translateX(min(0px, calc(40px - 110%))) scaleX(1.1)");
    expect(stretchedView("translateX(min(0px, calc(-3.5px - 100%)))", "scaleX(1.1)")).toBe("translateX(min(0px, calc(-3.5px - 110%))) scaleX(1.1)");
    expect(stretchedView("translateX(min(0px, -100% - 3.5px))", "scaleX(1.1)")).toBe("translateX(min(0px, calc(-3.5px - 110%))) scaleX(1.1)");
  });

  it("is the stretch alone with no move, and xterm's move alone with no stretch", () => {
    expect(stretchedView("", "scaleX(1.08)")).toBe("scaleX(1.08)");
    expect(stretchedView("translateX(min(0px, calc(40px - 100%)))", "")).toBe("translateX(min(0px, calc(40px - 100%)))");
  });
});

describe("adjustTerminalGlyphs with late faces", () => {
  let page: ReturnType<typeof glyphPage> | undefined;
  afterEach(() => {
    page?.stop();
    page?.restore();
    page = undefined;
  });

  it("measures an icon again once its face arrived, though a later arrival set the family back before the rows were drawn again", async () => {
    const icons = face('"Symbols Nerd Font Mono"', ICON_RANGE);
    const hangul = face('"Ovis Hangul Mono"', HANGUL_RANGE);
    page = glyphPage([icons, hangul]);
    const family = page.term.options.fontFamily;
    // each arrival in a frame of its own, and xterm draws no row in between
    icons.arrive();
    await settled([icons]);
    page.runFrames();
    hangul.arrive();
    await settled([hangul]);
    page.runFrames();
    expect(page.term.options.fontFamily).toBe(family);
    expect(page.term.refreshes).toBe(2);

    const redrawn = page.draw("\uf07b");
    expect(iconSize(redrawn)).toBeCloseTo(7.8, 5);
  });

  it("follows no face for Powerline's separators, which are drawn as boxes, not taken from the icon font", async () => {
    const icons = face('"Symbols Nerd Font Mono"', ICON_RANGE);
    page = glyphPage([icons], ["\ue0b0 main \ue0b1", "\ue0b2\ue0b7"]);
    icons.arrive();
    await settled([icons]);
    page.runFrames();
    expect(page.term.refreshes).toBe(0);
  });

  it("still follows a face for a box-drawing diagonal, which is drawn from the font", async () => {
    const icons = face('"Symbols Nerd Font Mono"', ICON_RANGE);
    const lines = face("Late Lines", "U+2500-257F");
    page = glyphPage([icons, lines], ["\u2571\u2500"]);
    page.term.options.fontFamily = `${page.term.options.fontFamily}, "Late Lines"`;
    page.draw("\u2572\u2500");
    lines.arrive();
    await settled([lines]);
    page.runFrames();
    expect(page.term.refreshes).toBe(1);
  });

  for (const [where, text, className] of [["under the cursor", "\u2500", "xterm-cursor"], ["with a joiner", "\u2500\ufe0e", ""]] as const) {
    it(`measures again a box character first drawn ${where}, after its face arrived while it was a box`, async () => {
      const icons = face('"Symbols Nerd Font Mono"', ICON_RANGE);
      const lines = face("Late Lines", "U+2500-257F");
      page = glyphPage([icons, lines], []);
      page.term.options.fontFamily = `${page.term.options.fontFamily}, "Late Lines"`;
      page.draw("\u2500\u2500");
      lines.arrive();
      await settled([lines]);
      page.runFrames();
      expect(page.term.refreshes).toBe(0);

      // xterm measured it with the stand-in, and now draws it from the face
      const drawn = page.draw(text, className, "0px");
      page.runFrames();
      expect(page.term.refreshes).toBe(1);
      // under the cursor it takes its one cell before the frame that measures everything again
      if (className !== "") expect(Number.parseFloat(drawn.style["letterSpacing"]!)).toBeCloseTo(7.8 - 13, 5);
    });
  }

  it("still follows the icon font for an icon drawn beside a separator", async () => {
    const icons = face('"Symbols Nerd Font Mono"', ICON_RANGE);
    page = glyphPage([icons], ["\ue0b0 \uf07b"]);
    icons.arrive();
    await settled([icons]);
    page.runFrames();
    expect(page.term.refreshes).toBe(1);
  });
});
