import { describe, expect, it } from "bun:test";
import { coversAny, displayText, followLateFaces, glyphFit, iconScale, type LateFace, oversizedIcon, stretchedView, textPresentation } from "./terminalGlyphs.ts";

// iPhone Safari at 13px: Menlo cells are 7.84px, Hangul from Apple SD Gothic Neo 11.24px
const IOS_CELL = 7.8367;
const IOS_HANGUL = 11.245;

describe("glyphFit", () => {
  it("widens an iPhone Hangul syllable as far as a stretch goes, enlarges it for the rest, capped, and centers what is left", () => {
    const fit = glyphFit(2 * IOS_CELL - IOS_HANGUL, IOS_HANGUL, IOS_CELL);
    expect(fit?.stretch).toBe(1.1);
    expect(fit!.scale * fit!.stretch).toBeCloseTo(1.2, 6);
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

const follow = (faces: FakeFace[]) => {
  const frames: (() => void)[] = [];
  let arrivals = 0;
  const late = followLateFaces(faces, (callback) => { frames.push(callback); }, () => { arrivals += 1; });
  return { late, frames, arrivals: () => arrivals, runFrames: () => { for (const callback of frames.splice(0)) callback(); } };
};

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
