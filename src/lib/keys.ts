export type KeyBarKey =
  | "Escape" | "Tab" | "Enter" | "BackTab" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
  | "Home" | "End" | "PageUp" | "PageDown" | "Backspace" | "Delete" | "Insert"
  | "ctrl-c" | "ctrl-d" | "ctrl-z" | "pipe" | "tilde" | "slash";

export type KeyBarExtra = "alt" | "shift-tab" | "home-end" | "page-up-down" | "ctrl-d" | "ctrl-z" | "pipe" | "tilde" | "slash";
export const KEY_BAR_EXTRAS: readonly KeyBarExtra[] = ["alt", "shift-tab", "home-end", "page-up-down", "ctrl-d", "ctrl-z", "pipe", "tilde", "slash"];

export function sanitizeKeyBarExtras(value: unknown, fallback: readonly KeyBarExtra[]): KeyBarExtra[] {
  if (!Array.isArray(value)) return [...fallback];
  return KEY_BAR_EXTRAS.filter((extra) => value.includes(extra));
}

export interface StickyModifiers { ctrl: boolean; alt: boolean; shift: boolean }
export const NO_STICKY_MODIFIERS: StickyModifiers = { ctrl: false, alt: false, shift: false };

export function hasModifiers(modifiers: StickyModifiers): boolean {
  return modifiers.ctrl || modifiers.alt || modifiers.shift;
}

export interface ModifierLatch { held: StickyModifiers; locked: StickyModifiers }
export const NO_MODIFIER_LATCH: ModifierLatch = { held: NO_STICKY_MODIFIERS, locked: NO_STICKY_MODIFIERS };

export function stepModifier(latch: ModifierLatch, modifier: keyof StickyModifiers): ModifierLatch {
  const held = latch.held[modifier];
  const locked = latch.locked[modifier];
  return {
    held: { ...latch.held, [modifier]: !locked },
    locked: { ...latch.locked, [modifier]: held && !locked },
  };
}

export function releaseLatched(latch: ModifierLatch): ModifierLatch {
  const { held, locked } = latch;
  if (held.ctrl === locked.ctrl && held.alt === locked.alt && held.shift === locked.shift) return latch;
  return { held: { ctrl: held.ctrl && locked.ctrl, alt: held.alt && locked.alt, shift: held.shift && locked.shift }, locked };
}

/** Ctrl+C/V remain native clipboard shortcuts on non-Latin layouts; Latin layouts keep their typed letter. */
export function clipboardKey(key: string, code: string): string {
  const typed = key.toLowerCase();
  return /^[a-z]$/.test(typed) ? typed : /^Key([A-Z])$/.exec(code)?.[1]?.toLowerCase() ?? typed;
}

/** The key a physical chord names. A non-Latin layout's letter goes by its position, as the plain
 * Ctrl path reads it: Korean ㅊ or Russian с on KeyC with a held Ctrl is Ctrl+C, which herdr's
 * encoder knows, not ctrl+ㅊ, which it types. A Latin layout keeps its own letter (Dvorak's C is
 * not KeyC), and anything that is not a letter position stays as typed.
 */
export function physicalKey(key: string, code: string): string {
  if ([...key].length !== 1 || /^[a-zA-Z]$/.test(key)) return key;
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  return letter === undefined ? key : letter.toLowerCase();
}

/** Send logical chords to Herdr, which owns the target pane's keyboard protocol.
 * A plus or space needs a name because Herdr's chord parser splits on '+' and trims.
 * Keep the typed symbol: the phone's layout already chose it; don't assume US Shift.
 */
export function terminalChord(key: string, modifiers: StickyModifiers): string | null {
  if (["Home", "End", "PageUp", "PageDown", "Delete", "Insert"].includes(key)) return null;
  if (/^ctrl-[cdz]$/.test(key)) { key = key.slice(-1); modifiers = { ...modifiers, ctrl: true }; }
  if (key === "BackTab") { key = "Tab"; modifiers = { ...modifiers, shift: true }; }
  const names: Record<string, string> = {
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
    Enter: "enter", Tab: "tab", Escape: "esc", Backspace: "backspace",
    Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
    pipe: "|", tilde: "~", slash: "/",
    " ": "space", "+": "plus",
  };
  const name = (Object.hasOwn(names, key) ? names[key] : undefined) ?? (/^F(?:[1-9]|1[0-2])$/.test(key) ? key.toLowerCase()
    : [...key].length === 1 && key.codePointAt(0)! >= 0x20 && key !== "\x7f" ? key : null);
  if (name === null) return null;
  return [modifiers.ctrl && "ctrl", modifiers.alt && "alt", modifiers.shift && "shift", name].filter(Boolean).join("+");
}

/** Herdr's send_keys parser lacks these names; its attach input parser accepts CSI navigation. */
export function navigationSequence(key: string, modifiers: StickyModifiers): string | null {
  const parameter = 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
  switch (key) {
    case "Home": return `\x1b[1;${parameter}H`;
    case "End": return `\x1b[1;${parameter}F`;
    case "PageUp": return `\x1b[5;${parameter}~`;
    case "PageDown": return `\x1b[6;${parameter}~`;
    case "Delete": return `\x1b[3;${parameter}~`;
    case "Insert": return `\x1b[2;${parameter}~`;
    default: return null;
  }
}

/** Soft keyboards often emit input events without a DOM keydown. */
export function keyFromData(data: string): string | null {
  const fixed: Record<string, string> = { "\r": "Enter", "\t": "Tab", "\x7f": "Backspace", "\x1b": "Escape" };
  if (Object.hasOwn(fixed, data)) return fixed[data]!;
  const arrow = /^\x1b(?:\[|O)([ABCD])$/.exec(data);
  if (arrow) return ({ A: "ArrowUp", B: "ArrowDown", C: "ArrowRight", D: "ArrowLeft" } as Record<string, string>)[arrow[1]!]!;
  return [...data].length === 1 && data.codePointAt(0)! >= 0x20 ? data : null;
}

export function isPrintable(data: string): boolean {
  if (data.length !== 1) return false;
  const code = data.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

export function controlCode(ch: string): string | null {
  if (!/^[A-Za-z@[\\\]^_]$/.test(ch)) return null;
  return String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f);
}

/**
 * Arrows follow DECCKM like a real keyboard: SS3 while a full-screen program has application
 * cursor keys on, CSI otherwise.
 */
export function keySequence(key: KeyBarKey, applicationCursorKeys: boolean): string {
  const cursor = (final: "A" | "B" | "C" | "D" | "H" | "F"): string => (applicationCursorKeys ? "\u001bO" : "\u001b[") + final;
  switch (key) {
    case "Escape":
      return "\u001b";
    case "Tab":
      return "\t";
    case "Enter":
      return "\r";
    case "BackTab":
      return "\u001b[Z";
    case "Backspace":
      return "\u007f";
    case "Delete":
      return "\u001b[3~";
    case "Insert":
      return "\u001b[2~";
    case "ctrl-c":
      return "\u0003";
    case "ctrl-d":
      return "\u0004";
    case "ctrl-z":
      return "\u001a";
    case "pipe":
      return "|";
    case "tilde":
      return "~";
    case "slash":
      return "/";
    case "Home":
      return cursor("H");
    case "End":
      return cursor("F");
    case "PageUp":
      return "\u001b[5~";
    case "PageDown":
      return "\u001b[6~";
    case "ArrowUp":
      return cursor("A");
    case "ArrowDown":
      return cursor("B");
    case "ArrowRight":
      return cursor("C");
    case "ArrowLeft":
      return cursor("D");
  }
}

/**
 * One keystroke under Alt as xterm sends it with metaSendsEscape: ESC before a single character,
 * and the Alt modifier in a cursor or editing key's sequence (Alt+Left is CSI 1;3D, Alt+PageUp CSI 5;3~).
 */
export function altSequence(data: string): string | null {
  if ([...data].length === 1) return "\u001b" + data;
  const cursor = /^\u001b[[O]([A-DHF])$/.exec(data);
  if (cursor) return `\u001b[1;3${cursor[1]}`;
  const editing = /^\u001b\[(\d+)~$/.exec(data);
  if (editing) return `\u001b[${editing[1]};3~`;
  return null;
}

/**
 * xterm's modifyOtherKeys level after CSI > 4 ; Pv m, or CSI > 4 n, which turns it off. Other
 * resources leave it as it was. xterm.js (5.5 and 6.0) ignores the request and types Ctrl+Enter as a plain
 * CR, the same as Enter, so PaneTerminal keeps the level here and sends that key itself.
 * herdr passes the pane program's request on to the attached client, and again on every
 * attach; Claude Code asks for level 2.
 */
export function modifyOtherKeysLevel(level: number, final: "m" | "n", params: ReadonlyArray<number | number[]>): number {
  // a bare CSI > m or CSI > n resets every key-modifier resource (xterm). xterm.js hands it over
  // as [0], the same as an explicit resource 0 (modifyKeyboard, which this does not track): off
  // is the safe reading, since a level left on would type CSI 27;5;13~ into a shell
  if (params.length === 0 || (params.length === 1 && params[0] === 0)) return 0;
  if (params[0] !== 4) return level;
  const value = params[1];
  return final === "m" && typeof value === "number" ? value : 0;
}

/** Ctrl+Enter under modifyOtherKeys, as xterm encodes it; null keeps xterm.js's own CR. */
export function ctrlEnterSequence(modifyOtherKeys: number): string | null {
  return modifyOtherKeys > 0 ? "\u001b[27;5;13~" : null;
}

/**
 * Ctrl+Enter on a mirrored pane, as a herdr key (#924). A mirror's repaint carries no terminal
 * modes (server/mirror.ts), so the browser never learns that the program asked for
 * modifyOtherKeys; herdr holds the pty and encodes `ctrl+enter` in the program's own mode:
 * CSI 27;5;13~ after `CSI > 4;2 m` (Claude Code's "send now"), CR otherwise (herdr 0.9.3).
 */
export function mirroredCtrlEnterKey(mirrored: boolean, modifyOtherKeys: number): string | null {
  return mirrored && modifyOtherKeys === 0 ? "ctrl+enter" : null;
}
