/**
 * Overrides keep the app's Mod+Shift convention for a bare key ("k" is Mod+Shift+K); a recorded chord
 * with other modifiers is stored exactly, as "ctrl+alt+shift+meta+key" in that order ("meta+PageUp").
 * null returns a key to the terminal.
 */
export type ShortcutOverrides = Record<string, string | null>;
export const CUSTOM_SHORTCUT_IDS = ["palette", "find", "toggle-view", "focus-input", "scroll-up", "scroll-down", "toggle-sidebar", "new-session", "new-tab", "rename-tab", "split-right", "split-down", "previous-pane", "next-pane", "previous-tab", "next-tab", "previous-workspace", "next-workspace", "settings"];

/** A chord with its exact modifiers; key as overrides store it (letters lowercase). */
export interface ExactChord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

// the punctuation keys are named by their US character but read by position (shortcutEventKey)
const BINDABLE_KEY = "(?:[a-z0-9,\\-=\\[\\];'\\\\./`§]|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Home|End)";
const MOD_SHIFT_KEY = new RegExp(`^${BINDABLE_KEY}$`);
const EXACT_CHORD = new RegExp(`^(ctrl\\+)?(alt\\+)?(shift\\+)?(meta\\+)?(${BINDABLE_KEY})$`);

/** A stored exact chord, or null for a bare Mod+Shift key or a value with no Ctrl, Alt or Meta. */
export function parseExactChord(value: string): ExactChord | null {
  const match = EXACT_CHORD.exec(value);
  if (!match || !value.includes("+")) return null;
  const chord = { ctrl: !!match[1], alt: !!match[2], shift: !!match[3], meta: !!match[4], key: match[5]! };
  return chord.ctrl || chord.alt || chord.meta ? chord : null;
}

export function formatExactChord(chord: ExactChord): string {
  return `${chord.ctrl ? "ctrl+" : ""}${chord.alt ? "alt+" : ""}${chord.shift ? "shift+" : ""}${chord.meta ? "meta+" : ""}${chord.key}`;
}

/** What a stored binding means on this platform: a bare key is Mod+Shift+key. */
export function bindingChord(value: string, platformIsMac: boolean): ExactChord {
  return parseExactChord(value) ?? { ctrl: !platformIsMac, alt: false, shift: true, meta: platformIsMac, key: value };
}

/**
 * Narrow warning list for Mod+Shift browser/OS reservations; this is not exhaustive:
 * Mod+Shift+N opens Chromium private browsing, Mod+Shift+T reopens a closed browser tab,
 * Mod+Shift+B opens or toggles browser bookmarks, and Firefox uses Mod+Shift+P for a private
 * window. Mod+Shift+W closes a browser window. On non-Mac platforms Chromium/Firefox also
 * reserve Mod+Shift+C/I/J for DevTools, Chromium reserves Mod+Shift+O for bookmarks, and both
 * move the current tab with Mod+Shift+PageUp/PageDown.
 * macOS uses Cmd+Shift+3/4/5 for screenshots and Cmd+Shift+Q for logout.
 * This only reports likely conflicts; configured and default bindings remain valid.
 */
export function isReservedShortcutKey(key: string, platformIsMac: boolean): boolean {
  const normalized = /^[a-z]$/i.test(key) ? key.toLowerCase() : key;
  if (normalized === "n" || normalized === "t" || normalized === "b" || normalized === "p" || normalized === "w") return true;
  return platformIsMac
    ? normalized === "3" || normalized === "4" || normalized === "5" || normalized === "q" || normalized === "[" || normalized === "]"
    : normalized === "c" || normalized === "i" || normalized === "j" || normalized === "o" || normalized === "PageUp" || normalized === "PageDown";
}

/**
 * Why an exact chord cannot be bound, or null when it can:
 * - "chord": without Ctrl, Alt or ⌘ a key types text, and a non-Mac Meta (Windows/Super) chord
 *   belongs to the OS;
 * - "reserved": the browser or OS acts before the page can (Mod+N/T/W, Cmd+Q/H/M, macOS Ctrl+arrows
 *   for Spaces, Ctrl+PageUp/PageDown between tabs), or text editing needs it (Mod+A/C/V/X/Z).
 */
export function exactChordRefusal(chord: ExactChord, platformIsMac: boolean): "chord" | "reserved" | null {
  if (!chord.ctrl && !chord.alt && !chord.meta) return "chord";
  if (!platformIsMac && chord.meta) return "chord";
  const modOnly = !chord.shift && !chord.alt && (platformIsMac ? chord.meta && !chord.ctrl : chord.ctrl && !chord.meta);
  if (modOnly && "acvxzntw".includes(chord.key)) return "reserved";
  if (platformIsMac && modOnly && ["q", "h", "m", "`"].includes(chord.key)) return "reserved";
  if (platformIsMac && chord.ctrl && !chord.meta && chord.key.startsWith("Arrow")) return "reserved";
  if (chord.ctrl && !chord.meta && !chord.alt && (chord.key === "PageUp" || chord.key === "PageDown")) return "reserved";
  return null;
}

/**
 * A bindable chord the user should confirm before saving:
 * - "terminal": Ctrl or Alt without ⌘ is a key shells, editors and agents use (Ctrl+R, Ctrl+A/E,
 *   Alt+word moves, AltGr and macOS Option characters); the app takes it, so it never reaches the pane;
 * - "browser": a ⌘ chord the browser commonly uses (find, location bar, reload, print, save, tab
 *   numbers, history arrows, and with ⌥ the developer tools and page source); the app gets it only
 *   where the browser lets it through.
 */
export function exactChordRisk(chord: ExactChord, platformIsMac: boolean): "terminal" | "browser" | null {
  if (!chord.meta && (chord.ctrl || chord.alt)) return "terminal";
  if (platformIsMac && chord.meta && (/^[0-9defgjloprsuy=\-[\]]$/.test(chord.key) || chord.key === "ArrowLeft" || chord.key === "ArrowRight")) return "browser";
  if (platformIsMac && chord.meta && chord.alt && /^[ciu]$/.test(chord.key)) return "browser";
  return null;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

/** Stored overrides as this device may use them: an exact chord the recorder would refuse here is dropped. */
export function sanitizeShortcutOverrides(raw: unknown, platformIsMac = isMacPlatform()): ShortcutOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: ShortcutOverrides = {};
  for (const id of CUSTOM_SHORTCUT_IDS) {
    const value = (raw as Record<string, unknown>)[id];
    if (value === null) result[id] = null;
    if (typeof value !== "string") continue;
    const chord = parseExactChord(value);
    if (MOD_SHIFT_KEY.test(value) || (chord !== null && exactChordRefusal(chord, platformIsMac) === null)) result[id] = value;
  }
  return result;
}
