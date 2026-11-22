import { keySequence, type KeyBarExtra, type KeyBarKey, type StickyModifiers } from "./keys.ts";

export interface KeyBarKeyItem {
  type: "key";
  key: string;
  modifiers?: StickyModifiers;
}

export type KeyBarItem =
  | { type: "modifier"; modifier: keyof StickyModifiers }
  | KeyBarKeyItem;

export const KEY_BAR_ITEMS_MAX = 32;

export const KEY_BAR_KEYS: readonly string[] = [
  "Escape", "Tab", "Enter", "BackTab", "Backspace", "Delete", "Insert",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
  "ctrl-c", "ctrl-d", "ctrl-z", "pipe", "tilde", "slash",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
];

function isScalarKey(key: string): boolean {
  if ([...key].length !== 1) return false;
  const code = key.codePointAt(0)!;
  return code >= 0x20 && !(code >= 0x7f && code <= 0x9f)
    && !(code >= 0xd800 && code <= 0xdfff) && (key === " " || key.trim() !== "");
}

export function keyBarInputSequence(key: string, applicationCursorKeys: boolean): string | null {
  if (isScalarKey(key)) return key;
  if (/^F(?:[1-9]|1[0-2])$/.test(key)) {
    const number = Number(key.slice(1));
    if (number <= 4) return `\x1bO${["P", "Q", "R", "S"][number - 1]}`;
    return `\x1b[${[15, 17, 18, 19, 20, 21, 23, 24][number - 5]}~`;
  }
  return KEY_BAR_KEYS.includes(key) ? keySequence(key as KeyBarKey, applicationCursorKeys) : null;
}

export function migrateKeyBarItems(extras: readonly KeyBarExtra[]): KeyBarItem[] {
  const has = (extra: KeyBarExtra): boolean => extras.includes(extra);
  const items: KeyBarItem[] = [{ type: "key", key: "Escape" }, { type: "key", key: "Tab" }];
  if (has("shift-tab")) items.push({ type: "key", key: "BackTab" });
  items.push({ type: "modifier", modifier: "ctrl" });
  if (has("alt")) items.push({ type: "modifier", modifier: "alt" });
  items.push({ type: "modifier", modifier: "shift" }, { type: "key", key: "Enter" });
  for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) items.push({ type: "key", key });
  if (has("home-end")) items.push({ type: "key", key: "Home" }, { type: "key", key: "End" });
  if (has("page-up-down")) items.push({ type: "key", key: "PageUp" }, { type: "key", key: "PageDown" });
  items.push({ type: "key", key: "ctrl-c" });
  for (const key of ["ctrl-d", "ctrl-z", "pipe", "tilde", "slash"] as const) {
    if (has(key)) items.push({ type: "key", key });
  }
  return items;
}

export const DEFAULT_KEY_BAR_ITEMS: KeyBarItem[] = [
  { type: "key", key: "Escape" }, { type: "key", key: "Tab" }, { type: "key", key: "ctrl-c" },
  { type: "modifier", modifier: "ctrl" }, { type: "modifier", modifier: "alt" }, { type: "modifier", modifier: "shift" },
  { type: "key", key: "Enter" },
  { type: "key", key: "ArrowUp" }, { type: "key", key: "ArrowDown" }, { type: "key", key: "ArrowLeft" }, { type: "key", key: "ArrowRight" },
];

export const KEY_BAR_SECOND_ROW: readonly string[] = ["Escape", "Tab", "pipe", "tilde", "slash", "-"];
export const KEY_BAR_ARROW_PAD: readonly string[] = ["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"];

export function keyBarRowItems(items: readonly KeyBarItem[], expanded: boolean): readonly KeyBarItem[] {
  if (!expanded) return items;
  return items.filter((item) => item.type === "modifier" || item.modifiers !== undefined
    || (!KEY_BAR_SECOND_ROW.includes(item.key) && !KEY_BAR_ARROW_PAD.includes(item.key)));
}

export function keyBarItemId(item: KeyBarItem): string {
  if (item.type === "modifier") return `modifier:${item.modifier}`;
  const modifiers = item.modifiers;
  const policy = modifiers === undefined ? "held" : `${Number(modifiers.ctrl)}${Number(modifiers.alt)}${Number(modifiers.shift)}`;
  return `key:${JSON.stringify(item.key)}:${policy}`;
}

const CAPS: Readonly<Record<string, string>> = {
  Escape: "Esc", BackTab: "⇧Tab", Backspace: "⌫", Delete: "Del", Insert: "Ins",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", PageUp: "PgUp", PageDown: "PgDn",
  "ctrl-c": "^C", "ctrl-d": "^D", "ctrl-z": "^Z", pipe: "|", tilde: "~", slash: "/", " ": "Space",
};

export function keyBarItemLabel(item: KeyBarItem): string {
  if (item.type === "modifier") return ({ ctrl: "Ctrl", alt: "Alt", shift: "Shift" })[item.modifier];
  const cap = CAPS[item.key] ?? item.key;
  if (item.modifiers === undefined) return cap;
  return [item.modifiers.ctrl && "Ctrl", item.modifiers.alt && "Alt", item.modifiers.shift && "Shift", cap].filter(Boolean).join("+");
}

function sanitizeItem(raw: unknown): KeyBarItem | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record["type"] === "modifier") {
    const modifier = record["modifier"];
    return modifier === "ctrl" || modifier === "alt" || modifier === "shift" ? { type: "modifier", modifier } : null;
  }
  const key = record["key"];
  if (record["type"] !== "key" || typeof key !== "string" || keyBarInputSequence(key, false) === null) return null;
  if (record["modifiers"] === undefined) return { type: "key", key };
  const rawModifiers = record["modifiers"];
  if (typeof rawModifiers !== "object" || rawModifiers === null || Array.isArray(rawModifiers)) return null;
  const modifiers = rawModifiers as Record<string, unknown>;
  return { type: "key", key, modifiers: { ctrl: modifiers["ctrl"] === true, alt: modifiers["alt"] === true, shift: modifiers["shift"] === true } };
}

/** Keep explicit removals/order; malformed entries cannot inject text blocks or terminal sequences. */
export function sanitizeKeyBarItems(raw: unknown, fallback: readonly KeyBarItem[] = DEFAULT_KEY_BAR_ITEMS): KeyBarItem[] {
  const items = Array.isArray(raw) ? raw : fallback;
  const result: KeyBarItem[] = [];
  const seen = new Set<string>();
  for (const rawItem of items) {
    const item = sanitizeItem(rawItem);
    if (!item) continue;
    const id = keyBarItemId(item);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
    if (result.length === KEY_BAR_ITEMS_MAX) break;
  }
  return result;
}
