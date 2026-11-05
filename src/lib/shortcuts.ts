import { useEffect } from "react";
import { useSettings } from "./settings.ts";
import { bindingChord, formatExactChord, isMacPlatform, parseExactChord, type ExactChord, type ShortcutOverrides } from "./shortcutBindings.ts";
import { physicalKey } from "./keys.ts";

import type { AppActions } from "./actions.ts";

export const SHORTCUTS = [
  { id: "palette", label: "Command palette", keys: ["Mod", "Shift", "K"] },
  { id: "find", label: "Find in terminal", keys: ["Mod", "Shift", "F"] },
  { id: "toggle-view", label: "Switch chat / terminal", keys: ["Mod", "Shift", "J"] },
  { id: "focus-input", label: "Focus pane input", keys: ["Mod", "Shift", "E"] },
  { id: "scroll-up", label: "Scroll pane up", keys: ["Mod", "Shift", "PageUp"] },
  { id: "scroll-down", label: "Scroll pane down", keys: ["Mod", "Shift", "PageDown"] },
  { id: "toggle-sidebar", label: "Toggle sidebar", keys: ["Mod", "Shift", "B"] },
  // Mod+Shift+N keeps working where the browser lets it through (the installed app), but Chrome
  // keeps Ctrl+Shift+N for a new incognito window in a tab: O is the one shown, and works in both
  { id: "new-session", label: "New workspace", keys: ["Mod", "Shift", "O"] },
  // no default key: the free Mod+Shift letters are few, so each person picks one in Settings
  { id: "new-tab", label: "New tab", keys: [] },
  { id: "rename-tab", label: "Rename tab", keys: [] },
  { id: "split-right", label: "Split pane right", keys: [] },
  { id: "split-down", label: "Split pane down", keys: [] },
  { id: "previous-pane", label: "Previous pane", keys: ["Mod", "Shift", "ArrowUp"] },
  { id: "next-pane", label: "Next pane", keys: ["Mod", "Shift", "ArrowDown"] },
  // no default key either, as New tab: each person picks one in Settings
  { id: "previous-tab", label: "Previous tab", keys: [] },
  { id: "next-tab", label: "Next tab", keys: [] },
  { id: "previous-workspace", label: "Previous workspace", keys: [] },
  { id: "next-workspace", label: "Next workspace", keys: [] },
  { id: "settings", label: "Settings", keys: ["Mod", "Shift", ","] },
  // listed only: held, not dispatched; VoiceInput.tsx listens for it itself (isVoiceShortcut)
  { id: "voice", label: "Dictate (hold)", keys: ["Mod", "Shift", "Space"] },
] as const;

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

export interface ShortcutEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

const KEY_TO_ID: Readonly<Record<string, ShortcutId>> = {
  k: "palette",
  f: "find",
  j: "toggle-view",
  e: "focus-input",
  PageUp: "scroll-up",
  PageDown: "scroll-down",
  b: "toggle-sidebar",
  n: "new-session",
  o: "new-session",
  ArrowUp: "previous-pane",
  ArrowDown: "next-pane",
  ",": "settings",
};

export function shortcutKeys(id: ShortcutId, overrides: ShortcutOverrides): string[] {
  if (Object.hasOwn(overrides, id)) return overrides[id] ? [overrides[id]!] : [];
  return Object.entries(KEY_TO_ID).filter(([, action]) => action === id).map(([key]) => key);
}

export function shortcutDisplayKeys(id: ShortcutId, overrides: ShortcutOverrides): string[] {
  const shortcut = SHORTCUTS.find((candidate) => candidate.id === id)!;
  if (id === "voice" || !Object.hasOwn(overrides, id)) return [...shortcut.keys];
  const value = overrides[id];
  return value ? bindingDisplayKeys(value) : [];
}

/** A stored binding as shown: Mod+Shift+key, or its exact modifiers in macOS order (⌃⌥⇧⌘). */
export function bindingDisplayKeys(value: string): string[] {
  const chord = parseExactChord(value);
  const bare = chord?.key ?? value;
  const key = bare.length === 1 ? bare.toUpperCase() : bare;
  if (!chord) return ["Mod", "Shift", key];
  return [...(chord.ctrl ? ["Ctrl"] : []), ...(chord.alt ? ["Alt"] : []), ...(chord.shift ? ["Shift"] : []), ...(chord.meta ? ["Meta"] : []), key];
}

/** Two bindings conflict when they name the same chord on this platform, however each is stored. */
export function shortcutConflict(id: ShortcutId, keys: string[], overrides: ShortcutOverrides, platformIsMac = isMacPlatform()): boolean {
  const wanted = new Set(keys.map((key) => formatExactChord(bindingChord(key, platformIsMac))));
  return SHORTCUTS.some((other) => other.id !== id && shortcutKeys(other.id, overrides).some((key) => wanted.has(formatExactChord(bindingChord(key, platformIsMac)))));
}

/** The key a Mod+Shift chord names, as overrides and KEY_TO_ID store it (letters lowercase). */
export function shortcutEventKey(event: ShortcutEventLike): string {
  // Shift+Comma produces "<" on common keyboard layouts.
  const code = event.code ?? "";
  // Share the terminal's letter-position convention, but never turn a typed symbol into an app action.
  // A Latin layout's own letter stays as typed, accented ones included: BÉPO's É sits on KeyW and
  // Turkish F's Ç on KeyB, and neither is that binding.
  const nonLatinLetter = /^\p{L}$/u.test(event.key) && !/^\p{Script=Latin}$/u.test(event.key);
  const letter = nonLatinLetter ? physicalKey(event.key, code) : event.key;
  if (code === "Comma") return ",";
  if (/^Digit[0-9]$/.test(code)) return code.slice(-1);
  const typed = letter.length === 1 ? letter.toLowerCase() : letter;
  // An a–z letter stays as typed (AZERTY's M sits on Semicolon); anything else on a punctuation key
  // is read by position, so a Hungarian É or a German Ö is the key it sits on, on any layout.
  return !/^[a-z]$/.test(typed) && Object.hasOwn(PUNCTUATION_BY_CODE, code) ? PUNCTUATION_BY_CODE[code]! : typed;
}

/** Punctuation keys by position, named by the US character (IntlBackslash, the ISO key, as §). */
const PUNCTUATION_BY_CODE: Readonly<Record<string, string>> = {
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'",
  Backslash: "\\", Period: ".", Slash: "/", Backquote: "`", IntlBackslash: "§",
};
const CODE_BY_PUNCTUATION: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(PUNCTUATION_BY_CODE).map(([code, key]) => [key, code]));

/** This keyboard's own character on each key, where the browser tells it (Chromium); else the US name. */
let layoutMap: ReadonlyMap<string, string> | null = null;
let layoutRequested = false;
function loadKeyboardLayout(): void {
  if (layoutRequested || typeof navigator === "undefined") return;
  layoutRequested = true;
  const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<ReadonlyMap<string, string>> } }).keyboard;
  keyboard?.getLayoutMap?.().then((map) => { layoutMap = map; }, () => { /* keep the US names */ });
}

/**
 * The pressed chord with its exact modifiers. With Alt the key is read from its position: macOS
 * Option turns K into "˚" and E into a dead key, and the binding is the key, not that character.
 */
export function exactChordFromEvent(event: ShortcutEventLike): ExactChord {
  const code = event.code ?? "";
  const key = event.altKey && /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : shortcutEventKey(event);
  return { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey, key };
}

export function matchShortcut(event: ShortcutEventLike, platformIsMac: boolean, overrides: ShortcutOverrides = {}): ShortcutId | null {
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.ctrlKey || event.altKey || event.metaKey) {
    const pressed = formatExactChord(exactChordFromEvent(event));
    for (const shortcut of SHORTCUTS) {
      if (shortcut.id === "voice") continue;
      const value = Object.hasOwn(overrides, shortcut.id) ? overrides[shortcut.id] : null;
      const chord = value ? parseExactChord(value) : null;
      if (chord && formatExactChord(chord) === pressed) return shortcut.id;
    }
  }
  const hasMod = platformIsMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!hasMod || !event.shiftKey || event.altKey) return null;
  const key = shortcutEventKey(event);
  for (const shortcut of SHORTCUTS) {
    if (shortcut.id === "voice") continue;
    if (Object.hasOwn(overrides, shortcut.id) && overrides[shortcut.id] === key) return shortcut.id;
  }
  const id = KEY_TO_ID[key];
  return id && !Object.hasOwn(overrides, id) ? id : null;
}

/** Mod+Shift+Space, held to dictate. matchShortcut never returns "voice": it has no action. */
export function isVoiceShortcut(event: ShortcutEventLike, platformIsMac: boolean): boolean {
  const hasMod = platformIsMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return hasMod && event.shiftKey && !event.altKey && (event.code === "Space" || event.key === " ");
}

const STEP_SHORTCUTS: ReadonlySet<ShortcutId> = new Set(["previous-pane", "next-pane", "previous-tab", "next-tab", "previous-workspace", "next-workspace"]);

/**
 * Mod+Shift+ArrowUp/ArrowDown move the selection in a text field (on a Mac Cmd+Shift+↑ selects to
 * the start of the text): in the message box or any other field with text they stay the field's, and
 * switch panes everywhere else: an empty field, which has nothing to select, and the terminal (its
 * own input element is xterm's, not a field to edit). keepsKeyForText also lets them go where the
 * field has no text left that way.
 */
export interface KeyTargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  value?: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  selectionDirection?: string | null;
  classList?: { contains(name: string): boolean };
}

export function keepsArrowsForText(target: KeyTargetLike | EventTarget | null): boolean {
  if (target === null || typeof target !== "object" || !("tagName" in target)) return false;
  const element = target as KeyTargetLike;
  if (element.classList?.contains("xterm-helper-textarea") || element.value === "") return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  const type = element.type ?? "";
  return type === "text" || type === "search" || type === "url" || type === "email" || type === "password" || type === "tel" || type === "number" || type === "";
}

/**
 * The capture listener below only prevents the browser's default, so xterm would still encode an
 * app shortcut for the pane: its key handler asks this first.
 */
export function isAppShortcut(event: ShortcutEventLike, overrides: ShortcutOverrides = {}): boolean {
  return matchShortcut(event, isMacPlatform(), overrides) !== null;
}

export { isMacPlatform };

/**
 * Arrows, Home and End select or move in a field with text; there a matching binding gives way. A
 * step to another pane, tab or workspace gives way only until the selection's moving end is at the
 * edge the key goes to: then the key has nothing left to do in the field. A step focuses the next
 * pane's message box, and a draft there must not stop the next step for good.
 */
export function keepsKeyForText(event: { key: string; target: KeyTargetLike | EventTarget | null }, shortcut: ShortcutId): boolean {
  if (!(event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") || !keepsArrowsForText(event.target)) return false;
  const field = event.target as KeyTargetLike;
  if (!STEP_SHORTCUTS.has(shortcut)) return true;
  // a field without a text selection (email, number, contenteditable) keeps the key while it has text
  if (typeof field.selectionStart !== "number" || typeof field.selectionEnd !== "number") return true;
  const moving = field.selectionDirection === "backward" ? field.selectionStart : field.selectionEnd;
  const back = event.key === "ArrowUp" || event.key === "ArrowLeft" || event.key === "Home";
  return back ? moving > 0 : moving < (field.value ?? "").length;
}

export function modKeyLabel(): string {
  return isMacPlatform() ? "⌘" : "Ctrl";
}

export function formatKeys(keys: readonly string[]): string[] {
  const mac = isMacPlatform();
  const mod = modKeyLabel();
  return keys.map((key) => (key === "Mod" ? mod : key === "Meta" ? (mac ? "⌘" : "Meta") : key === "Alt" && mac ? "⌥" : key === "Ctrl" && mac ? "⌃" : layoutLabel(key)));
}

function layoutLabel(key: string): string {
  const code = CODE_BY_PUNCTUATION[key];
  const own = code === undefined ? undefined : layoutMap?.get(code);
  return own ? own.toUpperCase() : key;
}

/** True while Settings records a chord: the dispatcher below stands down so the pressed chord is not run. */
let recordingShortcut = false;
export function setShortcutRecording(recording: boolean): void {
  recordingShortcut = recording;
}

export function useShortcuts(actions: AppActions, enabled: boolean): void {
  const { settings } = useSettings();
  useEffect(() => {
    if (!enabled) return;
    loadKeyboardLayout();
    const platformIsMac = isMacPlatform();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (recordingShortcut) return;
      const shortcut = matchShortcut(event, platformIsMac, settings.shortcutOverrides);
      if (shortcut === null) return;
      if (keepsKeyForText(event, shortcut)) return;
      event.preventDefault();
      // a held chord repeats: a tab or a split is made once per press, not once per key repeat
      if (event.repeat && (shortcut === "new-tab" || shortcut === "rename-tab" || shortcut === "split-right" || shortcut === "split-down")) return;
      switch (shortcut) {
        case "palette":
          actions.openPalette();
          break;
        case "find":
          actions.openFind();
          break;
        case "toggle-view":
          actions.toggleView();
          break;
        case "focus-input":
          actions.focusInput();
          break;
        case "scroll-up":
          actions.scrollPage(-1);
          break;
        case "scroll-down":
          actions.scrollPage(1);
          break;
        case "toggle-sidebar":
          actions.toggleSidebar();
          break;
        case "new-session":
          actions.openNewSession();
          break;
        case "new-tab":
          actions.openNewTab();
          break;
        case "rename-tab":
          actions.renameTab();
          break;
        case "split-right":
          actions.splitPane?.("right");
          break;
        case "split-down":
          actions.splitPane?.("down");
          break;
        case "previous-pane":
          actions.selectAdjacentPane(-1);
          break;
        case "next-pane":
          actions.selectAdjacentPane(1);
          break;
        case "previous-tab":
          actions.selectAdjacentTab(-1);
          break;
        case "next-tab":
          actions.selectAdjacentTab(1);
          break;
        case "previous-workspace":
          actions.selectAdjacentWorkspace(-1);
          break;
        case "next-workspace":
          actions.selectAdjacentWorkspace(1);
          break;
        case "settings":
          actions.openSettings();
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [actions, enabled, settings.shortcutOverrides]);
}
