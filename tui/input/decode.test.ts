import { describe, expect, it } from "bun:test";
import { bytes, expectEveryWay, feedReads, normalize, raw } from "../testing/input-runs.ts";
import type { Mods } from "./decode.ts";
import type { Framer } from "./framer.ts";

const key = (name: string, mods: Mods = {}, extra: { text?: string; unshifted?: string; action?: "press" | "repeat" | "release" } = {}) =>
  ({ type: "key", key: name, mods, action: extra.action ?? "press", ...(extra.text === undefined ? {} : { text: extra.text }), ...(extra.unshifted === undefined ? {} : { unshifted: extra.unshifted }) });
/** a key that types `char` (shift already in the text), with the char it is without shift */
const typed = (name: string, char: string, unshifted: string, mods: Mods = {}, action?: "press" | "repeat" | "release") => key(name, mods, { text: char, unshifted, action });
const text = (value: string) => ({ type: "text", text: value });
const mouse = (action: string, button: string | undefined, col: number, row: number, mods: Mods = {}) =>
  ({ type: "mouse", action, ...(button === undefined ? {} : { button }), mods, col, row });
const unknown = (value: string) => ({ type: "unknown", raw: value });
const C = { ctrl: true } as const, A = { alt: true } as const, S = { shift: true } as const;

type Row = [name: string, input: Uint8Array, events: unknown[], setup?: (framer: Framer) => void];
const eraseIsCtrlH = (framer: Framer) => framer.setModes({ eraseIsCtrlH: true });
const kittyOn = (framer: Framer) => framer.setModes({ kitty: true });

const ROWS: Row[] = [
  // legacy: text, C0 bytes and DEL
  ["a letter", bytes("a"), [text("a")]],
  ["a run of text", bytes("hello world"), [text("hello world")]],
  ["Enter", bytes("\r"), [key("ENTER")]],
  ["Tab", bytes("\t"), [key("TAB")]],
  ["DEL is Backspace", bytes("\x7f"), [key("BACKSPACE")]],
  ["BS is ctrl+h", bytes("\x08"), [key("H", C, { unshifted: "h" })]],
  ["BS is Backspace when erase is ^H", bytes("\x08"), [key("BACKSPACE")], eraseIsCtrlH],
  ["NUL is ctrl+space", bytes("\x00"), [key("SPACE", C, { unshifted: " " })]],
  ["ctrl+a", bytes("\x01"), [key("A", C, { unshifted: "a" })]],
  ["ctrl+j", bytes("\x0a"), [key("J", C, { unshifted: "j" })]],
  ["ctrl+z", bytes("\x1a"), [key("Z", C, { unshifted: "z" })]],
  ["ctrl+backslash", bytes("\x1c"), [key("BACKSLASH", C, { unshifted: "\\" })]],
  ["ctrl+]", bytes("\x1d"), [key("BRACKET_RIGHT", C, { unshifted: "]" })]],
  ["ctrl+6", bytes("\x1e"), [key("DIGIT_6", C, { unshifted: "6" })]],
  ["ctrl+/", bytes("\x1f"), [key("SLASH", C, { unshifted: "/" })]],
  ["text around Enter", bytes("ab\rcd"), [text("ab"), key("ENTER"), text("cd")]],
  ["Hangul", bytes("한글"), [text("한글")]],
  ["two- and four-byte characters", bytes("é😀"), [text("é😀")]],
  ["a private-use character", bytes("\uF000"), [text("\uF000")]],
  ["an overlong slash", raw("\xc0\xaf"), [unknown("\xc0"), unknown("\xaf")]],
  ["an overlong NUL in three bytes", raw("\xe0\x80\x80"), [unknown("\xe0"), unknown("\x80"), unknown("\x80")]],
  ["a UTF-16 surrogate", raw("\xed\xa0\x80"), [unknown("\xed"), unknown("\xa0"), unknown("\x80")]],
  ["a byte no UTF-8 starts with", raw("\xff"), [unknown("\xff")]],
  ["a cut character before ASCII", raw("\xed\x95a"), [unknown("\xed\x95"), text("a")]],
  // legacy: ESC as Alt, and the Escape key
  ["alt+a", bytes("\x1ba"), [typed("A", "a", "a", A)]],
  ["alt+shift+a", bytes("\x1bA"), [typed("A", "A", "a", A)]],
  ["alt+1", bytes("\x1b1"), [typed("DIGIT_1", "1", "1", A)]],
  ["alt+shift+1", bytes("\x1b!"), [typed("DIGIT_1", "!", "1", A)]],
  ["alt+space", bytes("\x1b "), [typed("SPACE", " ", " ", A)]],
  ["ctrl+alt+a", bytes("\x1b\x01"), [key("A", { ctrl: true, alt: true }, { unshifted: "a" })]],
  ["alt+Enter", bytes("\x1b\r"), [key("ENTER", A)]],
  ["alt+Backspace", bytes("\x1b\x7f"), [key("BACKSPACE", A)]],
  ["alt with a Hangul syllable", bytes("\x1b한"), [typed("UNIDENTIFIED", "한", "한", A)]],
  ["alt with a private-use character", bytes("\x1b\uF000"), [typed("UNIDENTIFIED", "\uF000", "\uF000", A)]],
  ["a lone ESC", bytes("\x1b"), [key("ESCAPE")]],
  ["ESC ESC", bytes("\x1b\x1b"), [key("ESCAPE"), key("ESCAPE")]],
  ["ESC [ alone is alt+[", bytes("\x1b["), [typed("BRACKET_LEFT", "[", "[", A)]],
  ["ESC O alone is alt+shift+o", bytes("\x1bO"), [typed("O", "O", "o", A)]],
  ["ESC ] alone is alt+]", bytes("\x1b]"), [typed("BRACKET_RIGHT", "]", "]", A)]],
  ["ESC P alone is alt+shift+p", bytes("\x1bP"), [typed("P", "P", "p", A)]],
  ["ESC _ alone is alt+shift+-", bytes("\x1b_"), [typed("MINUS", "_", "-", A)]],
  ["ESC before an arrow", bytes("\x1b\x1b[A"), [key("ESCAPE"), key("ARROW_UP")]],
  // CSI and SS3
  ["up", bytes("\x1b[A"), [key("ARROW_UP")]],
  ["down", bytes("\x1b[B"), [key("ARROW_DOWN")]],
  ["right", bytes("\x1b[C"), [key("ARROW_RIGHT")]],
  ["left", bytes("\x1b[D"), [key("ARROW_LEFT")]],
  ["home", bytes("\x1b[H"), [key("HOME")]],
  ["end", bytes("\x1b[F"), [key("END")]],
  ["keypad 5", bytes("\x1b[E"), [key("NUMPAD_BEGIN")]],
  ["ctrl+up", bytes("\x1b[1;5A"), [key("ARROW_UP", C)]],
  ["shift+left", bytes("\x1b[1;2D"), [key("ARROW_LEFT", S)]],
  ["alt+right", bytes("\x1b[1;3C"), [key("ARROW_RIGHT", A)]],
  ["super+down", bytes("\x1b[1;9B"), [key("ARROW_DOWN", { super: true })]],
  ["ctrl+alt+shift+home", bytes("\x1b[1;8H"), [key("HOME", { shift: true, alt: true, ctrl: true })]],
  ["insert", bytes("\x1b[2~"), [key("INSERT")]],
  ["delete", bytes("\x1b[3~"), [key("DELETE")]],
  ["ctrl+delete", bytes("\x1b[3;5~"), [key("DELETE", C)]],
  ["page up", bytes("\x1b[5~"), [key("PAGE_UP")]],
  ["page down", bytes("\x1b[6~"), [key("PAGE_DOWN")]],
  ["home as 7~", bytes("\x1b[7~"), [key("HOME")]],
  ["end as 8~", bytes("\x1b[8~"), [key("END")]],
  ["home as 1~ (tmux, screen, linux, putty)", bytes("\x1b[1~"), [key("HOME")]],
  ["end as 4~ (tmux, screen, linux, putty)", bytes("\x1b[4~"), [key("END")]],
  ["ctrl+home as 1;5~", bytes("\x1b[1;5~"), [key("HOME", C)]],
  ["shift+end as 4;2~", bytes("\x1b[4;2~"), [key("END", S)]],
  ["keypad 5 as CSI G (linux)", bytes("\x1b[G"), [key("NUMPAD_BEGIN")]],
  ["F13 as 25~ (VT220)", bytes("\x1b[25~"), [key("F13")]],
  ["F14 as 26~", bytes("\x1b[26~"), [key("F14")]],
  ["F15 as 28~", bytes("\x1b[28~"), [key("F15")]],
  ["F17 as 31~", bytes("\x1b[31~"), [key("F17")]],
  ["F18 as 32~", bytes("\x1b[32~"), [key("F18")]],
  ["F19 as 33~", bytes("\x1b[33~"), [key("F19")]],
  ["F20 as 34~", bytes("\x1b[34~"), [key("F20")]],
  ["linux F1", bytes("\x1b[[A"), [key("F1")]],
  ["linux F2", bytes("\x1b[[B"), [key("F2")]],
  ["linux F3", bytes("\x1b[[C"), [key("F3")]],
  ["linux F4", bytes("\x1b[[D"), [key("F4")]],
  ["linux F5", bytes("\x1b[[E"), [key("F5")]],
  ["an unknown linux key types nothing", bytes("\x1b[[xy"), [unknown("\x1b[[x"), text("y")]],
  ["a linux key cut by a control byte", bytes("\x1b[[\x01"), [unknown("\x1b[["), key("A", C, { unshifted: "a" })]],
  ["rxvt shift+delete", bytes("\x1b[3$"), [key("DELETE", S)]],
  ["rxvt shift+home", bytes("\x1b[7$"), [key("HOME", S)]],
  ["rxvt ctrl+end", bytes("\x1b[8^"), [key("END", C)]],
  ["rxvt ctrl+shift+page up", bytes("\x1b[5@"), [key("PAGE_UP", { shift: true, ctrl: true })]],
  ["rxvt shift+up", bytes("\x1b[a"), [key("ARROW_UP", S)]],
  ["rxvt shift+down", bytes("\x1b[b"), [key("ARROW_DOWN", S)]],
  ["rxvt shift+right", bytes("\x1b[c"), [key("ARROW_RIGHT", S)]],
  ["rxvt shift+left", bytes("\x1b[d"), [key("ARROW_LEFT", S)]],
  ["rxvt ctrl+up", bytes("\x1bOa"), [key("ARROW_UP", C)]],
  ["rxvt ctrl+down", bytes("\x1bOb"), [key("ARROW_DOWN", C)]],
  ["rxvt ctrl+right", bytes("\x1bOc"), [key("ARROW_RIGHT", C)]],
  ["rxvt ctrl+left", bytes("\x1bOd"), [key("ARROW_LEFT", C)]],
  ["an rxvt final after parameters is no key", bytes("\x1b[1;5^"), [unknown("\x1b[1;5^")]],
  ["an ANSI mode report's shape is no rxvt key", bytes("\x1b[4;2$y"), [unknown("\x1b[4;2$y")]],
  ["keypad Enter in keypad mode", bytes("\x1bOM"), [key("NUMPAD_ENTER")]],
  ["keypad 0 in keypad mode", bytes("\x1bOp"), [key("NUMPAD_0")]],
  ["keypad 5 in keypad mode", bytes("\x1bOu"), [key("NUMPAD_5")]],
  ["keypad 9 in keypad mode", bytes("\x1bOy"), [key("NUMPAD_9")]],
  ["keypad * in keypad mode", bytes("\x1bOj"), [key("NUMPAD_MULTIPLY")]],
  ["keypad + in keypad mode", bytes("\x1bOk"), [key("NUMPAD_ADD")]],
  ["keypad separator in keypad mode", bytes("\x1bOl"), [key("NUMPAD_SEPARATOR")]],
  ["keypad - in keypad mode", bytes("\x1bOm"), [key("NUMPAD_SUBTRACT")]],
  ["keypad . in keypad mode", bytes("\x1bOn"), [key("NUMPAD_DECIMAL")]],
  ["keypad / in keypad mode", bytes("\x1bOo"), [key("NUMPAD_DIVIDE")]],
  ["keypad = in keypad mode", bytes("\x1bOX"), [key("NUMPAD_EQUAL")]],
  ["F1 as 11~", bytes("\x1b[11~"), [key("F1")]],
  ["F2 as 12~", bytes("\x1b[12~"), [key("F2")]],
  ["F3 as 13~", bytes("\x1b[13~"), [key("F3")]],
  ["F4 as 14~", bytes("\x1b[14~"), [key("F4")]],
  ["F5", bytes("\x1b[15~"), [key("F5")]],
  ["F6", bytes("\x1b[17~"), [key("F6")]],
  ["F7", bytes("\x1b[18~"), [key("F7")]],
  ["F8", bytes("\x1b[19~"), [key("F8")]],
  ["F9", bytes("\x1b[20~"), [key("F9")]],
  ["F10", bytes("\x1b[21~"), [key("F10")]],
  ["F11", bytes("\x1b[23~"), [key("F11")]],
  ["F12", bytes("\x1b[24~"), [key("F12")]],
  ["shift+F12", bytes("\x1b[24;2~"), [key("F12", S)]],
  ["menu", bytes("\x1b[29~"), [key("CONTEXT_MENU")]],
  ["keypad 5 as 57427~", bytes("\x1b[57427~"), [key("NUMPAD_BEGIN")]],
  ["shift+tab", bytes("\x1b[Z"), [key("TAB", S)]],
  ["ctrl+F1", bytes("\x1b[1;5P"), [key("F1", C)]],
  ["shift+F2", bytes("\x1b[1;2Q"), [key("F2", S)]],
  ["ctrl+F3", bytes("\x1b[1;5R"), [key("F3", C)]],
  ["a bare CSI R is no key", bytes("\x1b[R"), [unknown("\x1b[R")]],
  ["a cursor report for row 1, column 1 is no key", bytes("\x1b[1;1R"), [unknown("\x1b[1;1R")]],
  ["a cursor report for row 24, column 80 is no key", bytes("\x1b[24;80R"), [unknown("\x1b[24;80R")]],
  ["alt+F4", bytes("\x1b[1;3S"), [key("F4", A)]],
  ["SS3 up", bytes("\x1bOA"), [key("ARROW_UP")]],
  ["SS3 down", bytes("\x1bOB"), [key("ARROW_DOWN")]],
  ["SS3 right", bytes("\x1bOC"), [key("ARROW_RIGHT")]],
  ["SS3 left", bytes("\x1bOD"), [key("ARROW_LEFT")]],
  ["SS3 home", bytes("\x1bOH"), [key("HOME")]],
  ["SS3 end", bytes("\x1bOF"), [key("END")]],
  ["SS3 keypad 5", bytes("\x1bOE"), [key("NUMPAD_BEGIN")]],
  ["SS3 F1", bytes("\x1bOP"), [key("F1")]],
  ["SS3 F2", bytes("\x1bOQ"), [key("F2")]],
  ["SS3 F3", bytes("\x1bOR"), [key("F3")]],
  ["SS3 F4", bytes("\x1bOS"), [key("F4")]],
  ["an unknown tilde key", bytes("\x1b[99~"), [unknown("\x1b[99~")]],
  ["an unknown final byte", bytes("\x1b[1;5X"), [unknown("\x1b[1;5X")]],
  ["an unknown SS3 key", bytes("\x1bOz"), [unknown("\x1bOz")]],
  ["a CSI cut by a control byte", bytes("\x1b[1\x01"), [unknown("\x1b[1"), key("A", C, { unshifted: "a" })]],
  ["text, a key, text", bytes("a\x1b[Ab"), [text("a"), key("ARROW_UP"), text("b")]],
  ["two arrows in one read", bytes("\x1b[A\x1b[B"), [key("ARROW_UP"), key("ARROW_DOWN")]],
  // modifyOtherKeys
  ["mok ctrl+i", bytes("\x1b[27;5;105~"), [key("I", C, { unshifted: "i" })]],
  ["mok shift+a", bytes("\x1b[27;2;65~"), [typed("A", "A", "a")]],
  ["mok ctrl+shift+a", bytes("\x1b[27;6;65~"), [key("A", { shift: true, ctrl: true }, { unshifted: "a" })]],
  ["mok alt+shift+1", bytes("\x1b[27;4;33~"), [typed("DIGIT_1", "!", "1", A)]],
  ["mok ctrl+Enter", bytes("\x1b[27;5;13~"), [key("ENTER", C)]],
  ["mok shift+Enter", bytes("\x1b[27;2;13~"), [key("ENTER", S)]],
  ["mok ctrl+Tab", bytes("\x1b[27;5;9~"), [key("TAB", C)]],
  ["mok alt with a private-use character types it", bytes("\x1b[27;3;61440~"), [typed("UNIDENTIFIED", "\uF000", "\uF000", A)]],
  ["mok shift with a private-use character types it", bytes("\x1b[27;2;61440~"), [typed("UNIDENTIFIED", "\uF000", "\uF000")]],
  ["mok ctrl with a private-use character", bytes("\x1b[27;5;61440~"), [key("UNIDENTIFIED", C, { unshifted: "\uF000" })]],
  ["mok's number for kitty's left shift is the character typed", bytes("\x1b[27;3;57441~"), [typed("UNIDENTIFIED", "\uE061", "\uE061", A)]],
  ["mok's number for kitty's keypad 0 is the character typed", bytes("\x1b[27;3;57399~"), [typed("UNIDENTIFIED", "\uE037", "\uE037", A)]],
  ["mok as CSI u: alt with a private-use character types it", bytes("\x1b[61440;3u"), [typed("UNIDENTIFIED", "\uF000", "\uF000", A)]],
  ["mok as CSI u: kitty's left-shift number is the character typed", bytes("\x1b[57441;3u"), [typed("UNIDENTIFIED", "\uE061", "\uE061", A)]],
  // kitty
  ["kitty Escape", bytes("\x1b[27u"), [key("ESCAPE")]],
  ["kitty ctrl+a", bytes("\x1b[97;5u"), [key("A", C, { unshifted: "a" })]],
  ["kitty ctrl+shift+a", bytes("\x1b[97;6u"), [key("A", { shift: true, ctrl: true }, { unshifted: "a" })]],
  ["kitty alt+a", bytes("\x1b[97;3u"), [typed("A", "a", "a", A)]],
  ["kitty alt+shift+a", bytes("\x1b[97;4u"), [typed("A", "A", "a", A)]],
  ["kitty alt+shift with the shifted key", bytes("\x1b[59:58;4u"), [typed("SEMICOLON", ":", ";", A)]],
  ["kitty ctrl+i", bytes("\x1b[105;5u"), [key("I", C, { unshifted: "i" })]],
  ["kitty ctrl+space", bytes("\x1b[32;5u"), [key("SPACE", C, { unshifted: " " })]],
  ["kitty shift+Enter", bytes("\x1b[13;2u"), [key("ENTER", S)]],
  ["kitty ctrl+Tab", bytes("\x1b[9;5u"), [key("TAB", C)]],
  ["kitty ctrl+Backspace", bytes("\x1b[127;5u"), [key("BACKSPACE", C)]],
  ["kitty keypad 0", bytes("\x1b[57399u"), [key("NUMPAD_0")]],
  ["kitty keypad Enter", bytes("\x1b[57414u"), [key("NUMPAD_ENTER")]],
  ["kitty keypad up", bytes("\x1b[57419u"), [key("NUMPAD_UP")]],
  ["kitty left shift types nothing", bytes("\x1b[57441u"), [unknown("\x1b[57441u")], kittyOn],
  ["kitty Caps Lock types nothing", bytes("\x1b[57358u"), [unknown("\x1b[57358u")], kittyOn],
  ["kitty media play types nothing", bytes("\x1b[57428u"), [unknown("\x1b[57428u")], kittyOn],
  ["kitty F27 types nothing", bytes("\x1b[57390u"), [unknown("\x1b[57390u")], kittyOn],
  ["kitty alt with an unnamed private-use number types nothing", bytes("\x1b[61440;3u"), [unknown("\x1b[61440;3u")], kittyOn],
  ["kitty key that reports private-use text types it", bytes("\x1b[61440;;61440u"), [typed("UNIDENTIFIED", "\uF000", "\uF000")], kittyOn],
  ["kitty shift with a private-use shifted key", bytes("\x1b[97:61440;2u"), [typed("A", "\uF000", "a")], kittyOn],
  ["kitty text only, a private-use character", bytes("\x1b[0;;61440u"), [text("\uF000")], kittyOn],
  ["kitty F13", bytes("\x1b[57376u"), [key("F13")]],
  ["kitty menu", bytes("\x1b[57363u"), [key("CONTEXT_MENU")]],
  ["kitty print screen", bytes("\x1b[57361;5u"), [key("PRINT_SCREEN", C)]],
  ["kitty repeat", bytes("\x1b[97;5:2u"), [key("A", C, { unshifted: "a", action: "repeat" })]],
  ["kitty release", bytes("\x1b[97;5:3u"), [key("A", C, { unshifted: "a", action: "release" })]],
  ["kitty release of a legacy form", bytes("\x1b[1;5:3A"), [key("ARROW_UP", C, { action: "release" })]],
  ["kitty ctrl with a Cyrillic letter", bytes("\x1b[1080;5u"), [key("UNIDENTIFIED", C, { unshifted: "и" })]],
  ["kitty text only", bytes("\x1b[0;;229u"), [text("å")]],
  ["kitty text of a key", bytes("\x1b[97;2;65u"), [typed("A", "A", "a")]],
  ["kitty hyper is a chord no program sees", bytes("\x1b[97;17u"), [unknown("\x1b[97;17u")]],
  ["kitty caps lock state is ignored", bytes("\x1b[97;69u"), [key("A", C, { unshifted: "a" })]],
  // SGR mouse
  ["left press", bytes("\x1b[<0;1;1M"), [mouse("press", "left", 0, 0)]],
  ["left release", bytes("\x1b[<0;10;5m"), [mouse("release", "left", 9, 4)]],
  ["middle press", bytes("\x1b[<1;3;4M"), [mouse("press", "middle", 2, 3)]],
  ["right press", bytes("\x1b[<2;3;4M"), [mouse("press", "right", 2, 3)]],
  ["drag with the left button", bytes("\x1b[<32;7;8M"), [mouse("motion", "left", 6, 7)]],
  ["motion with no button", bytes("\x1b[<35;7;8M"), [mouse("motion", undefined, 6, 7)]],
  ["wheel up", bytes("\x1b[<64;2;2M"), [mouse("press", "wheelUp", 1, 1)]],
  ["wheel down", bytes("\x1b[<65;2;2M"), [mouse("press", "wheelDown", 1, 1)]],
  ["wheel left", bytes("\x1b[<66;2;2M"), [mouse("press", "wheelLeft", 1, 1)]],
  ["wheel right", bytes("\x1b[<67;2;2M"), [mouse("press", "wheelRight", 1, 1)]],
  ["shift+press", bytes("\x1b[<4;1;1M"), [mouse("press", "left", 0, 0, S)]],
  ["alt+press", bytes("\x1b[<8;1;1M"), [mouse("press", "left", 0, 0, A)]],
  ["ctrl+press", bytes("\x1b[<16;1;1M"), [mouse("press", "left", 0, 0, C)]],
  ["ctrl+shift+wheel", bytes("\x1b[<84;2;3M"), [mouse("press", "wheelUp", 1, 2, { shift: true, ctrl: true })]],
  ["far cells", bytes("\x1b[<0;300;200M"), [mouse("press", "left", 299, 199)]],
  ["column 0 does not exist", bytes("\x1b[<0;0;1M"), [unknown("\x1b[<0;0;1M")]],
  ["extra buttons are not forwarded", bytes("\x1b[<128;1;1M"), [unknown("\x1b[<128;1;1M")]],
  ["a press of no button", bytes("\x1b[<3;1;1M"), [unknown("\x1b[<3;1;1M")]],
  ["an X10 report is consumed whole", raw("\x1b[M !!"), [unknown("\x1b[M !!")]],
  // focus
  ["focus in", bytes("\x1b[I"), [{ type: "focus", focused: true }]],
  ["focus out", bytes("\x1b[O"), [{ type: "focus", focused: false }]],
  ["focus out then in", bytes("\x1b[O\x1b[I"), [{ type: "focus", focused: false }, { type: "focus", focused: true }]],
  // reply shapes with no query waiting, strings and paste marks
  ["kitty flags with no query", bytes("\x1b[?1u"), [unknown("\x1b[?1u")]],
  ["DA1 with no query", bytes("\x1b[?62;22c"), [unknown("\x1b[?62;22c")]],
  ["a mode report with no query", bytes("\x1b[?2026;2$y"), [unknown("\x1b[?2026;2$y")]],
  ["a cell size with no query", bytes("\x1b[6;16;8t"), [unknown("\x1b[6;16;8t")]],
  ["a colour with no query", bytes("\x1b]11;rgb:0000/0000/0000\x07"), [unknown("\x1b]11;rgb:0000/0000/0000\x07")]],
  ["a DCS string", bytes("\x1bP>|xterm\x1b\\"), [unknown("\x1bP>|xterm\x1b\\")]],
  ["an APC string", bytes("\x1b_Gi=1;OK\x1b\\"), [unknown("\x1b_Gi=1;OK\x1b\\")]],
  ["a string cut by ESC", bytes("\x1b]11;x\x1b[A"), [unknown("\x1b]11;x"), key("ARROW_UP")]],
  ["a paste", bytes("\x1b[200~hi\x1b[201~"), [{ type: "paste", text: "hi", complete: true }]],
  ["a paste of private-use characters", bytes("\x1b[200~\uF000\uE061\x1b[201~"), [{ type: "paste", text: "\uF000\uE061", complete: true }]],
  ["an end mark with no paste", bytes("\x1b[201~"), [unknown("\x1b[201~")]],
];

describe("decode table", () => {
  it("has about 80 rows or more, each named once", () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(80);
    expect(new Set(ROWS.map(([name]) => name)).size).toBe(ROWS.length);
  });

  for (const [name, input, events, setup] of ROWS) {
    it(name, () => expectEveryWay(input, events, setup));
  }
});

describe("numbers in the private use area", () => {
  const PRIVATE_USE = Array.from({ length: 0xf8ff - 0xe000 + 1 }, (_, i) => 0xe000 + i);
  const altTyped = (code: number) => [typed("UNIDENTIFIED", String.fromCodePoint(code), String.fromCodePoint(code), A)];

  it("are keys that type nothing in kitty's CSI u while the host speaks kitty, named or not", () => {
    const typedNumbers = PRIVATE_USE.filter((code) => feedReads([bytes(`\x1b[${code}u`)], kittyOn).some((event) =>
      event.type === "text" || (event.type === "key" && (event.text !== undefined || event.key === "UNIDENTIFIED"))));
    expect(typedNumbers).toEqual([]);
  });

  it("are the characters typed in modifyOtherKeys' CSI 27;m;code~", () => {
    const wrong = PRIVATE_USE.filter((code) => !Bun.deepEquals(normalize(feedReads([bytes(`\x1b[27;3;${code}~`)])), altTyped(code)));
    expect(wrong).toEqual([]);
  });

  it("are the characters typed, or kitty's named keys, in a CSI u from a host that does not speak kitty", () => {
    const lost = PRIVATE_USE.filter((code) => {
      const events = normalize(feedReads([bytes(`\x1b[${code};3u`)])) as { type: string; key?: string; text?: string }[];
      const named = events.length === 1 && events[0]!.type === "key" && events[0]!.key !== "UNIDENTIFIED" && events[0]!.text === undefined;
      return !named && !Bun.deepEquals(events, altTyped(code));
    });
    expect(lost).toEqual([]);
  });
});
