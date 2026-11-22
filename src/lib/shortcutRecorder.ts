import { exactChordRefusal, exactChordRisk, formatExactChord, isReservedShortcutKey } from "./shortcutBindings.ts";
import { exactChordFromEvent, shortcutEventKey, type ShortcutEventLike } from "./shortcuts.ts";

export const SHORTCUT_KEYS: readonly string[] = [..."abcdefghijklmnopqrstuvwxyz0123456789,-=[];'\\./`§", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"];

/**
 * The Mod+Shift keys the Settings list offers. Home, End and the punctuation keys are left to Record:
 * punctuation is bound by position, so a US character in a list would name another key on most layouts.
 */
export const MENU_SHORTCUT_KEYS: readonly string[] = [..."abcdefghijklmnopqrstuvwxyz0123456789,", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"];

export type RecordedShortcut =
  | { kind: "key"; key: string }
  | { kind: "exact"; value: string; risk: "terminal" | "browser" | null }
  | { kind: "cancel" }
  | { kind: "ignore" }
  | { kind: "invalid"; reason: "chord" | "key" | "reserved" };

const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Shift", "Control", "Meta", "Alt", "AltGraph", "OS"]);

export function recordShortcut(event: ShortcutEventLike, platformIsMac: boolean): RecordedShortcut {
  if (event.isComposing || event.keyCode === 229) return { kind: "ignore" };
  if (MODIFIER_KEYS.has(event.key)) return { kind: "ignore" };
  const anyModifier = event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
  if (event.key === "Escape" && !anyModifier) return { kind: "cancel" };
  const hasMod = platformIsMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (hasMod && event.shiftKey && !event.altKey) {
    const key = shortcutEventKey(event);
    if (!SHORTCUT_KEYS.includes(key)) return { kind: "invalid", reason: "key" };
    if (isReservedShortcutKey(key, platformIsMac)) return { kind: "invalid", reason: "reserved" };
    return { kind: "key", key };
  }
  const chord = exactChordFromEvent(event);
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return { kind: "invalid", reason: "chord" };
  if (!SHORTCUT_KEYS.includes(chord.key)) return { kind: "invalid", reason: "key" };
  const refusal = exactChordRefusal(chord, platformIsMac);
  if (refusal !== null) return { kind: "invalid", reason: refusal };
  return { kind: "exact", value: formatExactChord(chord), risk: exactChordRisk(chord, platformIsMac) };
}

export function shortcutMatchesQuery(label: string, keysText: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${label} ${keysText}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}
