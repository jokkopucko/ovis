import { describe, expect, it } from "bun:test";
import { altSequence, clipboardKey, physicalKey, controlCode, ctrlEnterSequence, mirroredCtrlEnterKey, isPrintable, keySequence, modifyOtherKeysLevel, sanitizeKeyBarExtras, navigationSequence, terminalChord, keyFromData, NO_MODIFIER_LATCH, releaseLatched, stepModifier } from "./keys.ts";

describe("clipboardKey", () => {
  it("recognizes native Ctrl+C/V on Korean and Russian layouts without replacing Latin layout letters", () => {
    expect(clipboardKey("ㅍ", "KeyV")).toBe("v");
    expect(clipboardKey("м", "KeyV")).toBe("v");
    expect(clipboardKey("ㅊ", "KeyC")).toBe("c");
    expect(clipboardKey("с", "KeyC")).toBe("c");
    expect(clipboardKey("c", "KeyJ")).toBe("c");
    expect(clipboardKey("j", "KeyC")).toBe("j");
    expect(clipboardKey("V", "KeyV")).toBe("v");
    expect(clipboardKey("ArrowLeft", "ArrowLeft")).toBe("arrowleft");
  });
});

describe("physicalKey", () => {
  it("names a non-Latin layout's letter by its position and keeps a Latin layout's own", () => {
    expect(physicalKey("ㅊ", "KeyC")).toBe("c");
    expect(physicalKey("с", "KeyC")).toBe("c");
    expect(physicalKey("ㅉ", "KeyC")).toBe("c");
    expect(physicalKey("j", "KeyC")).toBe("j");
    expect(physicalKey("C", "KeyC")).toBe("C");
    expect(physicalKey("!", "Digit1")).toBe("!");
    expect(physicalKey("ArrowLeft", "ArrowLeft")).toBe("ArrowLeft");
    expect(physicalKey("한", "KeyG")).toBe("g");
  });
});

describe("terminalChord", () => {
  it("combines held modifiers with optional navigation and symbol keys", () => {
    const held = { ctrl: true, alt: true, shift: true };
    for (const [key, name] of [["pipe", "|"], ["tilde", "~"], ["slash", "/"], ["BackTab", "tab"]]) {
      expect(terminalChord(key!, held)).toBe(`ctrl+alt+shift+${name}`);
    }
    for (const [key, sequence] of [["Home", "\x1b[1;8H"], ["End", "\x1b[1;8F"], ["PageUp", "\x1b[5;8~"], ["PageDown", "\x1b[6;8~"]]) {
      expect(terminalChord(key!, held)).toBeNull();
      expect(navigationSequence(key!, held)).toBe(sequence!);
    }
    expect(terminalChord("BackTab", { ctrl: true, alt: false, shift: false })).toBe("ctrl+shift+tab");
  });
  it("preserves every combination for cursor keys, letters and symbols", () => {
    for (let mask = 0; mask < 8; mask++) {
      const modifiers = { ctrl: !!(mask & 4), alt: !!(mask & 2), shift: !!(mask & 1) };
      const prefix = [modifiers.ctrl && "ctrl", modifiers.alt && "alt", modifiers.shift && "shift"].filter(Boolean).join("+");
      for (const [key, name] of [["ArrowLeft", "left"], ["a", "a"], ["я", "я"], ["!", "!"], ["+", "plus"], [" ", "space"], ["Enter", "enter"], ["Tab", "tab"]]) {
        expect(terminalChord(key!, modifiers)).toBe((prefix ? prefix + "+" : "") + name);
      }
    }
  });
  it("rejects text blocks and unidentified hardware keys", () => {
    for (const key of ["Dead", "Unidentified", "paste me", "constructor", "toString", "__proto__", "\x03", ""]) {
      expect(terminalChord(key, { ctrl: true, alt: true, shift: true })).toBeNull();
    }
  });
  it("combines intrinsic control buttons with held Alt and Shift", () => {
    const alt = { ctrl: false, alt: true, shift: false };
    expect(terminalChord("ctrl-d", alt)).toBe("ctrl+alt+d");
    expect(terminalChord("ctrl-z", { ...alt, shift: true })).toBe("ctrl+alt+shift+z");
    expect(terminalChord("ctrl-c", { ctrl: false, alt: false, shift: false })).toBe("ctrl+c");
    expect(altSequence(keySequence("ctrl-d", false))).toBe("\x1b\x04");
    expect(altSequence(keySequence("ctrl-z", false))).toBe("\x1b\x1a");
  });
  it("keeps the existing Alt editing sequences and supports combined attach navigation", () => {
    const alt = { ctrl: false, alt: true, shift: false };
    for (const key of ["Delete", "Insert"] as const) {
      expect(terminalChord(key, alt)).toBeNull();
      expect(navigationSequence(key, alt)).toBe(altSequence(keySequence(key, false)));
    }
    expect(navigationSequence("Delete", { ctrl: true, alt: true, shift: true })).toBe("\x1b[3;8~");
    expect(navigationSequence("Insert", { ctrl: true, alt: false, shift: false })).toBe("\x1b[2;5~");
  });
});

describe("keyFromData", () => {
  it("identifies single committed keys without guessing inside paste or encoded chords", () => {
    expect(keyFromData("\x1bOA")).toBe("ArrowUp");
    expect(keyFromData("\x1b[D")).toBe("ArrowLeft");
    expect(keyFromData("\r")).toBe("Enter");
    expect(keyFromData("я")).toBe("я");
    expect(keyFromData("😀")).toBe("😀");
    for (const data of ["paste me", "한글", "constructor", "toString", "__proto__", "\x1b[1;5A", "\x1b[200~a\x1b[201~", ""]) expect(keyFromData(data)).toBeNull();
  });
});

describe("controlCode", () => {
  it("maps letters to their control code regardless of case", () => {
    expect(controlCode("c")).toBe("\u0003");
    expect(controlCode("C")).toBe("\u0003");
    expect(controlCode("a")).toBe("\u0001");
    expect(controlCode("z")).toBe("\u001a");
  });

  it("maps the six punctuation keys terminals define control codes for", () => {
    expect(controlCode("@")).toBe("\u0000");
    expect(controlCode("[")).toBe("\u001b");
    expect(controlCode("\\")).toBe("\u001c");
    expect(controlCode("]")).toBe("\u001d");
    expect(controlCode("^")).toBe("\u001e");
    expect(controlCode("_")).toBe("\u001f");
  });

  it("returns null for anything else, so the character is sent as typed", () => {
    for (const ch of ["1", " ", "?", "é", "ㄱ", "ab", ""]) expect(controlCode(ch)).toBeNull();
  });
});

describe("isPrintable", () => {
  it("accepts one printable character and rejects control characters, DEL and multi-character input", () => {
    expect(isPrintable("a")).toBe(true);
    expect(isPrintable(" ")).toBe(true);
    expect(isPrintable("ㄱ")).toBe(true);
    expect(isPrintable("\u001b")).toBe(false);
    expect(isPrintable("\u007f")).toBe(false);
    expect(isPrintable("ab")).toBe(false);
    expect(isPrintable("")).toBe(false);
  });
});

describe("keySequence", () => {
  it("sends the fixed bytes for Escape, Tab and Ctrl+C", () => {
    expect(keySequence("Escape", false)).toBe("\u001b");
    expect(keySequence("Tab", false)).toBe("\t");
    expect(keySequence("ctrl-c", true)).toBe("\u0003");
  });

  it("sends CSI arrows normally and SS3 arrows under application cursor keys mode", () => {
    expect(keySequence("ArrowUp", false)).toBe("\u001b[A");
    expect(keySequence("ArrowDown", false)).toBe("\u001b[B");
    expect(keySequence("ArrowRight", false)).toBe("\u001b[C");
    expect(keySequence("ArrowLeft", false)).toBe("\u001b[D");
    expect(keySequence("ArrowUp", true)).toBe("\u001bOA");
    expect(keySequence("ArrowLeft", true)).toBe("\u001bOD");
  });

  it("sends the optional keys as xterm does: Home/End follow DECCKM, the rest are fixed", () => {
    expect(keySequence("BackTab", false)).toBe("\u001b[Z");
    expect(keySequence("Home", false)).toBe("\u001b[H");
    expect(keySequence("End", false)).toBe("\u001b[F");
    expect(keySequence("Home", true)).toBe("\u001bOH");
    expect(keySequence("End", true)).toBe("\u001bOF");
    expect(keySequence("PageUp", true)).toBe("\u001b[5~");
    expect(keySequence("PageDown", false)).toBe("\u001b[6~");
    expect(keySequence("ctrl-d", false)).toBe("\u0004");
    expect(keySequence("ctrl-z", false)).toBe("\u001a");
    expect([keySequence("pipe", false), keySequence("tilde", false), keySequence("slash", false)]).toEqual(["|", "~", "/"]);
  });
});

describe("altSequence", () => {
  it("puts ESC before one character, control characters and IME syllables included", () => {
    expect(altSequence("b")).toBe("\u001bb");
    expect(altSequence("\u007f")).toBe("\u001b\u007f");
    expect(altSequence("\r")).toBe("\u001b\r");
    expect(altSequence("\u0003")).toBe("\u001b\u0003");
    expect(altSequence("한")).toBe("\u001b한");
    expect(altSequence("😀")).toBe("\u001b😀");
  });

  it("adds the Alt modifier to cursor and editing keys in either cursor mode", () => {
    expect(altSequence("\u001b[D")).toBe("\u001b[1;3D");
    expect(altSequence("\u001bOA")).toBe("\u001b[1;3A");
    expect(altSequence("\u001bOH")).toBe("\u001b[1;3H");
    expect(altSequence("\u001b[5~")).toBe("\u001b[5;3~");
  });

  it("leaves pastes and terminal reports alone, so they do not use up the armed Alt", () => {
    for (const data of ["ab", "", "\u001b[12;5R", "\u001b[I", "\u001b[<0;3;4M", "\u001b[200~x\u001b[201~", "\u001b[Z"]) expect(altSequence(data)).toBeNull();
  });
});

describe("sanitizeKeyBarExtras", () => {
  it("keeps known keys once, in the bar's order, and the default for a missing list", () => {
    expect(sanitizeKeyBarExtras(["slash", "alt", "nope", "alt", 3], ["alt"])).toEqual(["alt", "slash"]);
    expect(sanitizeKeyBarExtras([], ["alt"])).toEqual([]);
    expect(sanitizeKeyBarExtras(undefined, ["alt"])).toEqual(["alt"]);
    expect(sanitizeKeyBarExtras("alt", ["alt"])).toEqual(["alt"]);
  });
});

describe("modifyOtherKeysLevel", () => {
  it("follows CSI > 4 ; Pv m and turns off on CSI > 4 m and CSI > 4 n", () => {
    expect(modifyOtherKeysLevel(0, "m", [4, 2])).toBe(2);
    expect(modifyOtherKeysLevel(0, "m", [4, 1])).toBe(1);
    // herdr turns it off as CSI > 4 ; 0 m, a program may leave the value out
    expect(modifyOtherKeysLevel(2, "m", [4, 0])).toBe(0);
    expect(modifyOtherKeysLevel(2, "m", [4])).toBe(0);
    expect(modifyOtherKeysLevel(2, "n", [4])).toBe(0);
    // a bare CSI > m or CSI > n resets every resource; xterm.js reports it as [0] or []
    expect(modifyOtherKeysLevel(2, "m", [0])).toBe(0);
    expect(modifyOtherKeysLevel(2, "n", [0])).toBe(0);
    expect(modifyOtherKeysLevel(2, "m", [])).toBe(0);
  });

  it("leaves the level alone for the other key modifier resources", () => {
    expect(modifyOtherKeysLevel(2, "m", [1, 2])).toBe(2);
    expect(modifyOtherKeysLevel(2, "n", [1])).toBe(2);
    expect(modifyOtherKeysLevel(0, "m", [[4, 2]])).toBe(0);
  });
});

describe("ctrlEnterSequence", () => {
  it("keeps xterm.js's CR until the program asks for modifyOtherKeys", () => {
    expect(ctrlEnterSequence(0)).toBeNull();
    expect(ctrlEnterSequence(1)).toBe("\u001b[27;5;13~");
    expect(ctrlEnterSequence(2)).toBe("\u001b[27;5;13~");
  });
});

describe("mirroredCtrlEnterKey", () => {
  it("sends a mirrored pane's Ctrl+Enter as herdr's key, which herdr encodes in the program's own mode (#924)", () => {
    expect(mirroredCtrlEnterKey(true, 0)).toBe("ctrl+enter");
  });

  it("leaves an attached pane's Ctrl+Enter to xterm and to what its stream asked for", () => {
    expect(mirroredCtrlEnterKey(false, 0)).toBeNull();
    expect(mirroredCtrlEnterKey(false, 2)).toBeNull();
  });
});

describe("key bar modifier latch", () => {
  it("steps one modifier off, once, locked and off again, leaving the others", () => {
    const once = stepModifier(NO_MODIFIER_LATCH, "ctrl");
    expect(once).toEqual({ held: { ctrl: true, alt: false, shift: false }, locked: { ctrl: false, alt: false, shift: false } });
    const locked = stepModifier(once, "ctrl");
    expect(locked).toEqual({ held: { ctrl: true, alt: false, shift: false }, locked: { ctrl: true, alt: false, shift: false } });
    const withAlt = stepModifier(locked, "alt");
    expect(withAlt.held).toEqual({ ctrl: true, alt: true, shift: false });
    expect(stepModifier(withAlt, "ctrl")).toEqual({ held: { ctrl: false, alt: true, shift: false }, locked: { ctrl: false, alt: false, shift: false } });
  });

  it("lets go of the modifiers held for one key and keeps the locked ones", () => {
    const latch = stepModifier(stepModifier(stepModifier(NO_MODIFIER_LATCH, "ctrl"), "ctrl"), "shift");
    expect(releaseLatched(latch)).toEqual({ held: { ctrl: true, alt: false, shift: false }, locked: { ctrl: true, alt: false, shift: false } });
    const settled = releaseLatched(latch);
    expect(releaseLatched(settled)).toBe(settled);
    expect(releaseLatched(NO_MODIFIER_LATCH)).toBe(NO_MODIFIER_LATCH);
  });
});
