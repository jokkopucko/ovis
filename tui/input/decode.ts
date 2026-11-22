/**
 * What the bytes a terminal sends mean: the events of host input and the tables that name keys, mouse
 * reports, focus reports and the replies to the start probe. Written from the protocol descriptions
 * (ECMA-48, xterm's control sequences, the kitty keyboard protocol); pure, with no state and no clock.
 * `framer.ts` cuts the bytes into sequences and stamps the events.
 *
 * A key is named the way the shared engine's key encoder takes it (`EngineKey` in shared/ghostty/engine.ts):
 * the physical key by its GhosttyKey name, the modifiers, the text it types and its character without
 * shift. When the key types text, shift is already in that text and is left out of `mods` (shift+a is
 * `A` with no shift), because the encoder writes a key with shift in its modifiers as a chord.
 */

export interface Mods { shift?: boolean; ctrl?: boolean; alt?: boolean; super?: boolean }
type KeyAction = "press" | "repeat" | "release";
type MouseButton = "left" | "middle" | "right" | "wheelUp" | "wheelDown" | "wheelLeft" | "wheelRight";
/** `timeout`: the start probe's wait ran out before its DA1 reply came */
type ReplyKind = "kittyFlags" | "mode" | "color" | "cellSize" | "deviceAttributes" | "timeout";

/** Every event carries `at`: the caller's time of the read that held its first byte. */
export type InputEvent =
  | { type: "key"; key: string; mods: Mods; text?: string; unshifted?: string; action: KeyAction; at: number }
  | { type: "text"; text: string; at: number }
  | { type: "paste"; text: string; complete: boolean; at: number }
  | { type: "mouse"; action: "press" | "release" | "motion"; button?: MouseButton; mods: Mods; col: number; row: number; at: number }
  | { type: "focus"; focused: boolean; at: number }
  | { type: "reply"; kind: ReplyKind; data: string; at: number }
  /** a sequence nothing here knows, or a reply no query waits for; `raw` holds its bytes one char per byte */
  | { type: "unknown"; raw: string; at: number };

type Unstamp<E> = E extends unknown ? Omit<E, "at"> : never;
export type Unstamped = Unstamp<InputEvent>;
type Key = Extract<Unstamped, { type: "key" }>;

const MOD_NAMES = ["shift", "alt", "ctrl", "super"] as const;

function key(name: string, mods: Mods, action: KeyAction = "press", text?: string, unshifted?: string): Key {
  const clean: Mods = {};
  for (const mod of MOD_NAMES) if (mods[mod]) clean[mod] = true;
  return { type: "key", key: name, mods: clean, action, ...(text === undefined ? {} : { text }), ...(unshifted === undefined ? {} : { unshifted }) };
}

export function withAlt(event: Key): Key {
  return { ...event, mods: { ...event.mods, alt: true } };
}

// The US layout: the key each printable ASCII character is on, and which characters need shift.
const PUNCTUATION_KEYS: Readonly<Record<string, string>> = {
  " ": "SPACE", "`": "BACKQUOTE", "-": "MINUS", "=": "EQUAL", "[": "BRACKET_LEFT", "]": "BRACKET_RIGHT",
  "\\": "BACKSLASH", ";": "SEMICOLON", "'": "QUOTE", ",": "COMMA", ".": "PERIOD", "/": "SLASH",
};
const SHIFTED_TO_BASE: Readonly<Record<string, string>> = {
  "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/",
};
const BASE_TO_SHIFTED: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(SHIFTED_TO_BASE).map(([shifted, base]) => [base, shifted]));

/** The key a character is typed with on a US layout, the character without shift, and whether it needs shift. */
function keyOfChar(char: string): { name: string; unshifted: string; shifted: boolean } {
  if (char >= "a" && char <= "z") return { name: char.toUpperCase(), unshifted: char, shifted: false };
  if (char >= "A" && char <= "Z") return { name: char, unshifted: char.toLowerCase(), shifted: true };
  if (char >= "0" && char <= "9") return { name: `DIGIT_${char}`, unshifted: char, shifted: false };
  const punctuation = PUNCTUATION_KEYS[char];
  if (punctuation) return { name: punctuation, unshifted: char, shifted: false };
  const base = SHIFTED_TO_BASE[char];
  if (base) return { name: keyOfChar(base).name, unshifted: base, shifted: true };
  return { name: "UNIDENTIFIED", unshifted: char, shifted: false };
}

/**
 * The key that types `char` with `mods`. With ctrl or super it types nothing, and shift stays a modifier;
 * otherwise its text is `char` with shift applied (or the text the terminal reported), and shift is dropped.
 */
export function typedKey(char: string, mods: Mods, action: KeyAction = "press", reported?: string): Key {
  const { name, unshifted, shifted } = keyOfChar(char);
  const shift = Boolean(mods.shift) || shifted;
  if (mods.ctrl || mods.super) return key(name, { ...mods, shift }, action, undefined, unshifted);
  const text = reported ?? (shift && !shifted ? BASE_TO_SHIFTED[char] ?? char.toUpperCase() : char);
  return key(name, { ...mods, shift: false }, action, text, unshifted);
}

// C0 bytes ctrl gives with a punctuation or digit key (the letters are 0x01 to 0x1a).
const CTRL_PUNCTUATION: Readonly<Record<number, string>> = { 0x1c: "\\", 0x1d: "]", 0x1e: "6", 0x1f: "/" };

/** A C0 byte or DEL read on its own (ESC is the framer's). 0x08 is Backspace only when the tty's erase character is ^H. */
export function decodeControl(byte: number, eraseIsCtrlH: boolean): Key {
  if (byte === 0x09) return key("TAB", {});
  if (byte === 0x0d) return key("ENTER", {});
  if (byte === 0x7f || (byte === 0x08 && eraseIsCtrlH)) return key("BACKSPACE", {});
  if (byte === 0x00) return typedKey(" ", { ctrl: true });
  const punctuation = CTRL_PUNCTUATION[byte];
  return typedKey(punctuation ?? String.fromCharCode(byte + 0x60), { ctrl: true });
}

// Keys whose CSI form ends in a letter (`CSI A`, `CSI 1;5A`), also sent as SS3 (`ESC O A`).
const LETTER_KEYS: Readonly<Record<string, string>> = {
  A: "ARROW_UP", B: "ARROW_DOWN", C: "ARROW_RIGHT", D: "ARROW_LEFT", E: "NUMPAD_BEGIN", F: "END", H: "HOME",
  P: "F1", Q: "F2", R: "F3", S: "F4",
};
// The Linux console's keypad 5 is `CSI G`.
const CSI_LETTER_KEYS: Readonly<Record<string, string>> = { ...LETTER_KEYS, G: "NUMPAD_BEGIN" };
// rxvt's arrows: with shift `CSI a` to `CSI d`, with ctrl `ESC O a` to `ESC O d`.
const RXVT_ARROWS: Readonly<Record<string, string>> = { a: "ARROW_UP", b: "ARROW_DOWN", c: "ARROW_RIGHT", d: "ARROW_LEFT" };
// SS3 forms: the letter keys, and the keypad while the host is in application keypad mode.
const SS3_KEYS: Readonly<Record<string, string>> = {
  ...LETTER_KEYS, M: "NUMPAD_ENTER", X: "NUMPAD_EQUAL", j: "NUMPAD_MULTIPLY", k: "NUMPAD_ADD", l: "NUMPAD_SEPARATOR",
  m: "NUMPAD_SUBTRACT", n: "NUMPAD_DECIMAL", o: "NUMPAD_DIVIDE",
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String.fromCharCode(0x70 + i), `NUMPAD_${i}`])),
};
// The Linux console's F1 to F5: `CSI [ A` to `CSI [ E`.
const LINUX_FUNCTION_KEYS: Readonly<Record<string, string>> = { A: "F1", B: "F2", C: "F3", D: "F4", E: "F5" };

// Keys sent as `CSI n ~`: xterm's, the VT220's (1 Home and 4 End under tmux, screen, linux and putty;
// 25 to 34 F13 to F20), rxvt's 7 and 8, and kitty's menu and keypad begin. 29 is kitty's menu; the
// VT220 hosts send it for F16.
const TILDE_KEYS: Readonly<Record<number, string>> = {
  1: "HOME", 2: "INSERT", 3: "DELETE", 4: "END", 5: "PAGE_UP", 6: "PAGE_DOWN", 7: "HOME", 8: "END",
  11: "F1", 12: "F2", 13: "F3", 14: "F4", 15: "F5", 17: "F6", 18: "F7", 19: "F8", 20: "F9", 21: "F10", 23: "F11", 24: "F12",
  25: "F13", 26: "F14", 28: "F15", 29: "CONTEXT_MENU", 31: "F17", 32: "F18", 33: "F19", 34: "F20", 57427: "NUMPAD_BEGIN",
};
// rxvt writes the modifiers of a `CSI n ~` key in its final byte instead.
const RXVT_FINAL_MODS: Readonly<Record<string, Mods>> = { "$": { shift: true }, "^": { ctrl: true }, "@": { shift: true, ctrl: true } };

// The keys that type nothing among modifyOtherKeys' and kitty's numbered keys, by the control code both give them.
const CONTROL_KEYS: Readonly<Record<number, string>> = { 9: "TAB", 13: "ENTER", 27: "ESCAPE", 127: "BACKSPACE" };
// kitty's numbers for its other keys that type nothing, all in the private use area.
const KITTY_KEYS: Readonly<Record<number, string>> = {
  57361: "PRINT_SCREEN", 57362: "PAUSE", 57363: "CONTEXT_MENU",
  ...Object.fromEntries(Array.from({ length: 13 }, (_, i) => [57376 + i, `F${13 + i}`])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [57399 + i, `NUMPAD_${i}`])),
  57409: "NUMPAD_DECIMAL", 57410: "NUMPAD_DIVIDE", 57411: "NUMPAD_MULTIPLY", 57412: "NUMPAD_SUBTRACT", 57413: "NUMPAD_ADD",
  57414: "NUMPAD_ENTER", 57415: "NUMPAD_EQUAL", 57416: "NUMPAD_SEPARATOR", 57417: "NUMPAD_LEFT", 57418: "NUMPAD_RIGHT",
  57419: "NUMPAD_UP", 57420: "NUMPAD_DOWN", 57421: "NUMPAD_PAGE_UP", 57422: "NUMPAD_PAGE_DOWN", 57423: "NUMPAD_HOME",
  57424: "NUMPAD_END", 57425: "NUMPAD_INSERT", 57426: "NUMPAD_DELETE", 57427: "NUMPAD_BEGIN",
};

const ACTIONS: Readonly<Record<number, KeyAction>> = { 1: "press", 2: "repeat", 3: "release" };
const MOD_BITS = { shift: 1, alt: 2, ctrl: 4, super: 8 } as const;
// hyper and meta: no program in a pane can be sent them, so such a chord is dropped, never sent without them
const UNSENDABLE_BITS = 16 | 32;

function num(field: string | undefined): number | undefined {
  return field !== undefined && /^\d{1,7}$/.test(field) ? Number(field) : undefined;
}

/** The `modifiers[:event]` field: 1 + the modifier bits (lock bits ignored), then press, repeat or release. */
function modifiers(field: readonly string[] | undefined): { mods: Mods; action: KeyAction } | undefined {
  const value = field?.[0] ? num(field[0]) : 1;
  const action = ACTIONS[field?.[1] ? num(field[1]) ?? 0 : 1];
  if (value === undefined || value < 1 || !action) return undefined;
  const bits = value - 1;
  if (bits & UNSENDABLE_BITS) return undefined;
  const mods: Mods = {};
  for (const mod of MOD_NAMES) if (bits & MOD_BITS[mod]) mods[mod] = true;
  return { mods, action };
}

function isPrintable(code: number): boolean {
  return code >= 0x20 && code <= 0x10ffff && !(code >= 0x7f && code <= 0x9f) && !(code >= 0xd800 && code <= 0xdfff);
}

/** the Unicode private use area, where kitty numbers every key that types nothing but the four control keys */
const isPrivateUse = (code: number): boolean => code >= 0xe000 && code <= 0xf8ff;

/** A key number that is the character it types, as modifyOtherKeys sends every key, or one of the four control keys. */
function characterKey(code: number, mods: Mods, action: KeyAction, reported?: string): Key | undefined {
  const name = CONTROL_KEYS[code];
  if (name) return key(name, mods, action);
  return isPrintable(code) ? typedKey(String.fromCodePoint(code), mods, action, reported) : undefined;
}

/**
 * `CSI code[:shifted[:base]] ; mods[:event] ; text u`: kitty's keys, and modifyOtherKeys' from a host that sends them
 * in this form (xterm's formatOtherKeys, tmux's csi-u format), where the number is always the character typed. While
 * the host speaks kitty (`kitty`), a number in the private use area is one of kitty's keys that type nothing (Caps
 * Lock, the modifiers, F26 and up, the media keys): unknown unless named here, never a character, unless it reports
 * the text it typed. kitty's named keys keep their names either way, so a kitty host whose flags the probe missed
 * still gets its keypad and F13 to F25.
 */
function kittyKey(fields: readonly string[][], kitty: boolean): Unstamped | undefined {
  if (fields.length < 1 || fields.length > 3) return undefined;
  const [codes = [], modField, textField] = fields;
  const code = num(codes[0]);
  const held = modifiers(modField);
  if (code === undefined || !held) return undefined;
  let text: string | undefined;
  if (textField) {
    const points = textField.map(num);
    if (!points.every((point): point is number => point !== undefined && isPrintable(point))) return undefined;
    text = String.fromCodePoint(...points);
  }
  if (code === 0) return text && !Object.keys(held.mods).length ? { type: "text", text } : undefined;
  const shifted = num(codes[1]);
  if (text === undefined && held.mods.shift && shifted !== undefined && isPrintable(shifted)) text = String.fromCodePoint(shifted);
  const name = KITTY_KEYS[code];
  if (name) return key(name, held.mods, held.action);
  if (kitty && isPrivateUse(code) && text === undefined) return undefined;
  return characterKey(code, held.mods, held.action, text);
}

/** `CSI n ; mods ~`, and modifyOtherKeys' `CSI 27 ; mods ; code ~`. */
function tildeKey(fields: readonly string[][]): Unstamped | undefined {
  const n = num(fields[0]?.[0]);
  if (n === 27 && fields.length === 3) {
    const held = modifiers(fields[1]);
    const code = num(fields[2]?.[0]);
    return held && code !== undefined ? characterKey(code, held.mods, held.action) : undefined;
  }
  const name = n === undefined ? undefined : TILDE_KEYS[n];
  const held = modifiers(fields[1]);
  return name && held && fields.length <= 2 ? key(name, held.mods, held.action) : undefined;
}

/** `CSI A` with no parameters, or `CSI 1 ; mods A`; rxvt's shifted arrows `CSI a` to `CSI d`. */
function letterKey(final: string, fields: readonly string[][]): Unstamped | undefined {
  const rxvt = RXVT_ARROWS[final];
  if (rxvt) return fields.length === 0 ? key(rxvt, { shift: true }) : undefined;
  const name = CSI_LETTER_KEYS[final];
  if (!name) return undefined;
  // `CSI row ; column R` is a cursor position report. F3 takes only xterm's modified form `CSI 1 ; m R`
  // with m from 2: a report for row 1 has that same shape, so the screen never asks its host for one (`CSI 6 n`).
  if (final === "R" && !(fields.length === 2 && (num(fields[1]?.[0]) ?? 0) >= 2)) return undefined;
  if (fields.length === 0) return key(name, {});
  const held = modifiers(fields[1]);
  return fields.length === 2 && fields[0]?.length === 1 && num(fields[0][0]) === 1 && held ? key(name, held.mods, held.action) : undefined;
}

/** rxvt's `CSI n $`, `CSI n ^` and `CSI n @`: a `CSI n ~` key with shift, ctrl, or both. */
function rxvtKey(final: string, params: string): Unstamped | undefined {
  const name = /^\d+$/.test(params) ? TILDE_KEYS[Number(params)] : undefined;
  const mods = RXVT_FINAL_MODS[final];
  return name && mods ? key(name, mods) : undefined;
}

const BUTTONS: readonly MouseButton[] = ["left", "middle", "right"];
const WHEELS: readonly MouseButton[] = ["wheelUp", "wheelDown", "wheelLeft", "wheelRight"];

/** SGR mouse, `CSI < b ; x ; y M` (press) or `m` (release), to 0-based cells. */
function sgrMouse(fields: readonly string[][], final: string): Unstamped | undefined {
  if (fields.length !== 3 || fields.some((field) => field.length !== 1)) return undefined;
  const [b, x, y] = fields.map((field) => num(field[0]));
  if (b === undefined || !x || !y || b & 128) return undefined;
  const mods: Mods = {};
  if (b & 4) mods.shift = true;
  if (b & 8) mods.alt = true;
  if (b & 16) mods.ctrl = true;
  const low = b & 3;
  const at = { mods, col: x - 1, row: y - 1 };
  if (b & 64) return final === "M" ? { type: "mouse", action: "press", button: WHEELS[low], ...at } : undefined;
  if (b & 32) return { type: "mouse", action: "motion", ...(low === 3 ? {} : { button: BUTTONS[low] }), ...at };
  if (low === 3) return undefined;
  return { type: "mouse", action: final === "M" ? "press" : "release", button: BUTTONS[low], ...at };
}

const reply = (kind: ReplyKind, data: string): Unstamped => ({ type: "reply", kind, data });

/** The probe's replies of the form `CSI ? ...`: kitty flags, a DEC mode report, and DA1. */
function privateReply(params: string, intermediates: string, final: string): Unstamped | undefined {
  if (final === "u" && !intermediates && /^\d+$/.test(params)) return reply("kittyFlags", params);
  if (final === "y" && intermediates === "$" && /^\d+;\d+$/.test(params)) return reply("mode", params);
  if (final === "c" && !intermediates && /^[\d;]*$/.test(params)) return reply("deviceAttributes", params);
  return undefined;
}

/**
 * A whole CSI sequence: `body` is what lies between `ESC [` and the final byte. Undefined when nothing
 * here knows it; a reply's shape gives a reply only while a query waits (`awaitingReplies`), and a
 * `CSI u` key is read as kitty's while the host speaks kitty (`kitty`).
 */
export function decodeCsi(body: string, final: string, awaitingReplies: boolean, kitty: boolean): Unstamped | undefined {
  const parts = /^([<=>?]?)([\d;:]*)([\x20-\x2f]*)$/.exec(body);
  if (!parts) return undefined;
  const [, prefix, params = "", intermediates] = parts;
  const fields = params === "" ? [] : params.split(";").map((field) => field.split(":"));
  if (prefix === "<") return final === "M" || final === "m" ? sgrMouse(fields, final) : undefined;
  if (prefix === "?") return awaitingReplies ? privateReply(params, intermediates ?? "", final) : undefined;
  if (prefix || intermediates) return undefined;
  switch (final) {
    case "u": return kittyKey(fields, kitty);
    case "~": return tildeKey(fields);
    case "I": case "O": return params === "" ? { type: "focus", focused: final === "I" } : undefined;
    case "Z": return params === "" ? key("TAB", { shift: true }) : undefined;
    case "$": case "^": case "@": return rxvtKey(final, params);
    case "t": return awaitingReplies && fields.length === 3 && num(fields[0]?.[0]) === 6 && /^6;\d+;\d+$/.test(params) ? reply("cellSize", params.slice(2)) : undefined;
    default: return letterKey(final, fields);
  }
}

/** `ESC O` and one final byte. */
export function decodeSs3(final: string): Unstamped | undefined {
  const ctrlArrow = RXVT_ARROWS[final];
  if (ctrlArrow) return key(ctrlArrow, { ctrl: true });
  const name = SS3_KEYS[final];
  return name ? key(name, {}) : undefined;
}

/** The byte after the Linux console's `CSI [`. */
export function decodeLinuxFunction(final: string): Unstamped | undefined {
  const name = LINUX_FUNCTION_KEYS[final];
  return name ? key(name, {}) : undefined;
}

/** A whole OSC, DCS or APC string, without its introducer and terminator. Only the probe's colour replies are known. */
export function decodeString(kind: "osc" | "dcs" | "apc", body: string, awaitingReplies: boolean): Unstamped | undefined {
  return kind === "osc" && awaitingReplies && /^1[012];/.test(body) ? reply("color", body) : undefined;
}
