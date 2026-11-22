import { describe, expect, it } from "bun:test";
import { ESC_WAIT_MS, ESC_WAIT_SLOW_MS, PASTE_LIMIT_BYTES, REPLY_WAIT_MS, SEQUENCE_DROP_MS, SEQUENCE_LIMIT_BYTES } from "../model/deadlines.ts";
import { bytes, expectEveryWay, feedReads, normalize, raw, readWays, T0 } from "../testing/input-runs.ts";
import type { InputEvent } from "./decode.ts";
import { Framer } from "./framer.ts";

const ESCAPE = { type: "key", key: "ESCAPE", mods: {}, action: "press" } as const;
const UP = { type: "key", key: "ARROW_UP", mods: {}, action: "press" } as const;
const kinds = (events: readonly InputEvent[]) => events.map((event) => event.type);

describe("esc", () => {
  it("gives a lone ESC as Escape at exactly the wait, not before, stamped when it was read", () => {
    const framer = new Framer();
    expect(framer.feed(bytes("\x1b"), T0)).toEqual([]);
    expect(framer.deadline()).toBe(T0 + ESC_WAIT_MS);
    expect(framer.tick(T0 + ESC_WAIT_MS - 1)).toEqual([]);
    expect(framer.tick(T0 + ESC_WAIT_MS)).toEqual([{ ...ESCAPE, at: T0 }]);
    expect(framer.deadline()).toBeUndefined();
  });

  it("waits longer while the host reports the mouse or has the kitty flag on", () => {
    for (const modes of [{ mouse: true }, { kitty: true }]) {
      const framer = new Framer();
      framer.setModes(modes);
      framer.feed(bytes("\x1b"), T0);
      expect(framer.tick(T0 + ESC_WAIT_SLOW_MS - 1)).toEqual([]);
      expect(normalize(framer.tick(T0 + ESC_WAIT_SLOW_MS))).toEqual([ESCAPE]);
    }
  });

  it("keeps a mouse report cut after ESC [ whole inside the longer wait", () => {
    const framer = new Framer();
    framer.setModes({ mouse: true });
    framer.feed(bytes("\x1b["), T0);
    expect(framer.tick(T0 + ESC_WAIT_MS)).toEqual([]);
    expect(normalize(framer.feed(bytes("<0;3;4M"), T0 + ESC_WAIT_MS + 1))).toEqual([{ type: "mouse", action: "press", button: "left", mods: {}, col: 2, row: 3 }]);
  });

  it("counts the Esc wait from the read that ended in the introducer, not from the ESC's own read", () => {
    const framer = new Framer();
    framer.feed(bytes("\x1b"), T0);
    framer.feed(bytes("["), T0 + 20);
    expect(framer.deadline()).toBe(T0 + 20 + ESC_WAIT_MS);
    expect(framer.tick(T0 + 49)).toEqual([]);
    expect(framer.tick(T0 + 50)).toEqual([{ type: "key", key: "BRACKET_LEFT", mods: { alt: true }, action: "press", text: "[", unshifted: "[", at: T0 }]);
  });

  it("gives ESC then [A inside the wait as one arrow", () => {
    const framer = new Framer();
    framer.feed(bytes("\x1b"), T0);
    expect(framer.feed(bytes("[A"), T0 + ESC_WAIT_MS - 1)).toEqual([{ ...UP, at: T0 }]);
  });

  it("gives ESC ], ESC P or ESC _ alone as its Alt key at the wait, and reads what follows as typed", () => {
    const cases = [["]", "BRACKET_RIGHT", "]"], ["P", "P", "p"], ["_", "MINUS", "-"]] as const;
    for (const [introducer, key, unshifted] of cases) {
      const framer = new Framer();
      expect(framer.feed(bytes(`\x1b${introducer}`), T0)).toEqual([]);
      expect(framer.deadline()).toBe(T0 + ESC_WAIT_MS);
      expect(framer.tick(T0 + ESC_WAIT_MS)).toEqual([{ type: "key", key, mods: { alt: true }, action: "press", text: introducer, unshifted, at: T0 }]);
      expect(normalize(framer.feed(bytes("abc\r"), T0 + ESC_WAIT_MS + 1))).toEqual([{ type: "text", text: "abc" }, { type: "key", key: "ENTER", mods: {}, action: "press" }]);
    }
  });

  it("keeps an ESC read last in a string the drop wait ends, as the start of what follows or as a lone Escape", () => {
    const escAt = T0 + SEQUENCE_DROP_MS - 1;
    const arrow = new Framer();
    arrow.feed(bytes("\x1b]11;x"), T0);
    arrow.feed(bytes("\x1b"), escAt);
    expect(arrow.feed(bytes("[A"), T0 + SEQUENCE_DROP_MS)).toEqual([{ type: "unknown", raw: "\x1b]11;x", at: T0 }, { ...UP, at: escAt }]);
    const lone = new Framer();
    lone.feed(bytes("\x1b]11;x"), T0);
    lone.feed(bytes("\x1b"), escAt);
    expect(lone.tick(T0 + SEQUENCE_DROP_MS)).toEqual([{ type: "unknown", raw: "\x1b]11;x", at: T0 }]);
    expect(lone.deadline()).toBe(escAt + ESC_WAIT_MS);
    expect(lone.tick(escAt + ESC_WAIT_MS - 1)).toEqual([]);
    expect(lone.tick(escAt + ESC_WAIT_MS)).toEqual([{ ...ESCAPE, at: escAt }]);
  });

  it("gives ESC ESC as two Escapes", () => {
    expectEveryWay(bytes("\x1b\x1b"), [ESCAPE, ESCAPE]);
  });

  it("gives ESC a as alt+a", () => {
    expectEveryWay(bytes("\x1ba"), [{ type: "key", key: "A", mods: { alt: true }, action: "press", text: "a", unshifted: "a" }]);
  });

  it("gives ESC and a letter read after the wait as Escape and the letter", () => {
    const framer = new Framer();
    framer.feed(bytes("\x1b"), T0);
    expect(normalize(framer.feed(bytes("a"), T0 + ESC_WAIT_MS))).toEqual([ESCAPE, { type: "text", text: "a" }]);
  });

  it("gives ESC [ < cut there no key and no text, before or after the wait", () => {
    const framer = new Framer();
    expect(framer.feed(bytes("\x1b[<"), T0)).toEqual([]);
    expect(framer.deadline()).toBe(T0 + SEQUENCE_DROP_MS);
    expect(framer.tick(T0 + ESC_WAIT_SLOW_MS)).toEqual([]);
    expect(framer.tick(T0 + SEQUENCE_DROP_MS - 1)).toEqual([]);
    expect(framer.tick(T0 + SEQUENCE_DROP_MS)).toEqual([{ type: "unknown", raw: "\x1b[<", at: T0 }]);
    expect(framer.deadline()).toBeUndefined();
  });

  it("counts the drop of a longer sequence from the read that held its first byte, not from its last read", () => {
    const framer = new Framer();
    framer.feed(bytes("\x1b[1"), T0);
    framer.feed(bytes(";5"), T0 + 400);
    expect(framer.deadline()).toBe(T0 + 500);
    expect(framer.tick(T0 + 499)).toEqual([]);
    expect(framer.tick(T0 + 500)).toEqual([{ type: "unknown", raw: "\x1b[1;5", at: T0 }]);
  });
});

describe("paste", () => {
  const PASTE = "\x1b[200~a\nb\x1b[201~rest";

  it("gives start mark, a, newline, b, end mark, rest as one paste then the text, cut anywhere", () => {
    expectEveryWay(bytes(PASTE), [{ type: "paste", text: "a\nb", complete: true }, { type: "text", text: "rest" }]);
  });

  it("waits for an end mark cut inside itself however long the gap, stamping the paste at its start", () => {
    const framer = new Framer();
    const cut = PASTE.indexOf("\x1b[201~") + 3;
    expect(framer.feed(bytes(PASTE.slice(0, cut)), T0)).toEqual([]);
    expect(framer.deadline()).toBeUndefined();
    expect(framer.tick(T0 + 60_000)).toEqual([]);
    expect(framer.feed(bytes(PASTE.slice(cut)), T0 + 60_001)).toEqual([
      { type: "paste", text: "a\nb", complete: true, at: T0 },
      { type: "text", text: "rest", at: T0 + 60_001 },
    ]);
  });

  it("keeps a U+FEFF wherever a read starts, in text and at the start of a paste", () => {
    expectEveryWay(bytes("a\uFEFFb"), [{ type: "text", text: "a\uFEFFb" }]);
    expectEveryWay(bytes("\x1b[200~\uFEFFabc\x1b[201~"), [{ type: "paste", text: "\uFEFFabc", complete: true }]);
  });

  it("keeps its own copy of a read, so a caller that reuses its buffer changes no paste", () => {
    const framer = new Framer();
    const reused = Buffer.from("abc");
    framer.feed(bytes("\x1b[200~"), T0);
    framer.feed(reused, T0 + 1);
    reused.write("xyz");
    expect(normalize(framer.feed(bytes("\x1b[201~"), T0 + 2))).toEqual([{ type: "paste", text: "abc", complete: true }]);
  });

  it("keeps an ESC inside a paste as data", () => {
    expectEveryWay(bytes("\x1b[200~x\x1by\x1b[20z\x1b[201~"), [{ type: "paste", text: "x\x1by\x1b[20z", complete: true }]);
  });

  it("takes a paste of exactly the limit, and refuses one byte more whole", () => {
    const fits = feedReads([bytes("\x1b[200~"), new Uint8Array(PASTE_LIMIT_BYTES).fill(0x61), bytes("\x1b[201~")]);
    expect(fits).toHaveLength(1);
    expect(fits[0]).toMatchObject({ type: "paste", complete: true });
    expect(fits[0]?.type === "paste" && fits[0].text.length).toBe(PASTE_LIMIT_BYTES);
    const over = feedReads([bytes("\x1b[200~"), new Uint8Array(PASTE_LIMIT_BYTES + 1).fill(0x61), bytes("\x1b[201~z")]);
    expect(normalize(over)).toEqual([{ type: "paste", text: "", complete: false }, { type: "text", text: "z" }]);
  });

  it("refuses a paste as soon as it passes the limit, and swallows the rest of it up to its end mark", () => {
    const framer = new Framer();
    const start = framer.feed(Buffer.concat([bytes("\x1b[200~"), new Uint8Array(PASTE_LIMIT_BYTES + 1).fill(0x61)]), T0);
    expect(start).toEqual([{ type: "paste", text: "", complete: false, at: T0 }]);
    expect(framer.feed(bytes("more of the paste\x1b[A"), T0 + 1)).toEqual([]);
    expect(framer.feed(bytes("\x1b[201~y"), T0 + 2)).toEqual([{ type: "text", text: "y", at: T0 + 2 }]);
  });

  it("drops a paste or sequence in progress on reset, keeping the host modes", () => {
    const framer = new Framer();
    framer.setModes({ mouse: true });
    framer.feed(bytes("\x1b[200~never ends"), T0);
    framer.reset();
    expect(framer.feed(bytes("x"), T0 + 1)).toEqual([{ type: "text", text: "x", at: T0 + 1 }]);
    framer.feed(bytes("\x1b"), T0 + 2);
    framer.reset();
    expect(framer.deadline()).toBeUndefined();
    expect(framer.tick(T0 + 60_000)).toEqual([]);
    framer.feed(bytes("\x1b"), T0 + 3);
    expect(framer.deadline()).toBe(T0 + 3 + ESC_WAIT_SLOW_MS);
  });
});

describe("hangul once", () => {
  const HANGUL = bytes("\u{D55C}\u{AE00}");

  it("gives U+D55C U+AE00 cut at each of its 5 inner offsets as those two characters once, never split", () => {
    expect(HANGUL).toHaveLength(6);
    for (let cut = 1; cut < HANGUL.length; cut++) {
      const events = feedReads([HANGUL.subarray(0, cut), HANGUL.subarray(cut)]);
      expect(kinds(events).every((kind) => kind === "text")).toBe(true);
      expect(events.map((event) => (event.type === "text" ? event.text : "")).join("")).toBe("\u{D55C}\u{AE00}");
    }
  });

  it("holds a cut character for the next read however late it comes, and stamps it when its first byte was read", () => {
    const framer = new Framer();
    expect(framer.feed(HANGUL.subarray(0, 2), T0)).toEqual([]);
    expect(framer.deadline()).toBeUndefined();
    expect(framer.tick(T0 + 60_000)).toEqual([]);
    expect(framer.feed(HANGUL.subarray(2), T0 + 60_001)).toEqual([{ type: "text", text: "\u{D55C}\u{AE00}", at: T0 }]);
  });
});

describe("replies", () => {
  const OSC_11 = "\x1b]11;rgb:1e1e/1e1e/2e2e";
  const COLOUR = { type: "reply", kind: "color", data: "11;rgb:1e1e/1e1e/2e2e" };
  const probing = (framer: Framer) => framer.expectReplies(T0);
  // with no DA1 among the bytes, the probe's wait runs out after them
  const TIMEOUT = { type: "reply", kind: "timeout", data: "" };

  it("gives an OSC 11 reply during the probe as one reply, cut anywhere, ended by BEL or by ST", () => {
    expectEveryWay(bytes(`${OSC_11}\x07`), [COLOUR, TIMEOUT], probing);
    expectEveryWay(bytes(`${OSC_11}\x1b\\`), [COLOUR, TIMEOUT], probing);
  });

  it("gives the same bytes with no query waiting as unknown only", () => {
    expectEveryWay(bytes(`${OSC_11}\x07`), [{ type: "unknown", raw: `${OSC_11}\x07` }]);
  });

  it("reads the probe's other replies and keeps keys typed meanwhile as keys", () => {
    expectEveryWay(bytes("\x1b[?1u\x1b[?2026;2$y\x1b[6;16;8tx\x1b[A"), [
      { type: "reply", kind: "kittyFlags", data: "1" },
      { type: "reply", kind: "mode", data: "2026;2" },
      { type: "reply", kind: "cellSize", data: "16;8" },
      { type: "text", text: "x" },
      UP,
      TIMEOUT,
    ], probing);
  });

  it("ends the wait at DA1: a reply after it is unknown", () => {
    expectEveryWay(bytes(`\x1b[?62;22c${OSC_11}\x07`), [{ type: "reply", kind: "deviceAttributes", data: "62;22" }, { type: "unknown", raw: `${OSC_11}\x07` }], probing);
  });

  it("ends the wait at its limit with a timeout reply, after which a reply is unknown", () => {
    const framer = new Framer();
    framer.expectReplies(T0);
    expect(framer.deadline()).toBe(T0 + REPLY_WAIT_MS);
    expect(framer.tick(T0 + REPLY_WAIT_MS - 1)).toEqual([]);
    expect(framer.tick(T0 + REPLY_WAIT_MS)).toEqual([{ type: "reply", kind: "timeout", data: "", at: T0 + REPLY_WAIT_MS }]);
    expect(framer.deadline()).toBeUndefined();
    expect(kinds(framer.feed(bytes(`${OSC_11}\x07`), T0 + REPLY_WAIT_MS + 1))).toEqual(["unknown"]);
  });
});

describe("robustness", () => {
  /** a fixed-seed generator (mulberry32), so every run sees the same bytes */
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const MIB = 1024 * 1024;
  const PIECES = ["hello ", "한글 ", "😀", "\r", "\x7f", "\x01", "\x1ba", "\x1b[A", "\x1b[1;5C", "\x1b[3~", "\x1bOP", "\x1b[97;5u", "\x1b[27;2;65~",
    "\x1b[<0;12;7M", "\x1b[<0;12;7m", "\x1b[<65;3;3M", "\x1b[I", "\x1b[O", "\x1b[200~pasted\n한 줄\x1b[201~", "\x1b]11;rgb:0/0/0\x07", "\x1b[?1u"];

  function mixed(next: () => number): Uint8Array {
    const parts: Uint8Array[] = [];
    let size = 0;
    while (size < MIB) {
      const part = bytes(PIECES[Math.floor(next() * PIECES.length)]!);
      parts.push(part);
      size += part.length;
    }
    return Buffer.concat(parts);
  }

  /** reads of 1 to 4096 bytes, all at one time, so no wait passes between them */
  function readInChunks(input: Uint8Array, next: () => number): InputEvent[] {
    const framer = new Framer();
    const events: InputEvent[] = [];
    for (let at = 0; at < input.length;) {
      const size = 1 + Math.floor(next() * 4096);
      events.push(...framer.feed(input.subarray(at, at + size), T0));
      at += size;
    }
    events.push(...framer.tick(T0 + 60_000));
    return events;
  }

  it("gives 1 MiB of random bytes and 1 MiB of mixed input the same events however they are cut", () => {
    const next = random(18);
    const noise = Uint8Array.from({ length: MIB }, () => Math.floor(next() * 256));
    for (const input of [noise, mixed(next)]) {
      const whole = normalize(readInChunks(input, () => 1));
      expect(whole.length).toBeGreaterThan(0);
      expect(normalize(readInChunks(input, next))).toEqual(whole);
      expect(normalize(readInChunks(input, next))).toEqual(whole);
    }
  });

  it("keeps no more than the sequence limit of a sequence that never ends", () => {
    const events = feedReads([bytes("\x1b]11;"), new Uint8Array(2 * MIB).fill(0x41)]);
    expect(kinds(events)).toEqual(["unknown"]);
    expect(events[0]?.type === "unknown" && events[0].raw.length).toBe(SEQUENCE_LIMIT_BYTES);
  });

  it("drops every way of cutting an unfinished sequence at the end of input the same way", () => {
    for (const { reads } of readWays(raw("ab\x1b[1;5"))) {
      expect(normalize(feedReads(reads))).toEqual([{ type: "text", text: "ab" }, { type: "unknown", raw: "\x1b[1;5" }]);
    }
  });
});
