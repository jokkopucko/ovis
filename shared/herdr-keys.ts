/**
 * herdr's `[keys]` as herdr resolves them (src/config/keybinds.rs, `validated_keybinds`). The browser
 * gets the prefix-mode actions it can run itself (resolveHerdrKeys; Settings → Shortcuts → Use herdr's
 * prefix keys); the terminal screen gets every action, the direct (prefix-free) bindings and the
 * navigate-mode keys (resolveAllHerdrKeys). `[[keys.command]]` stays herdr's: read only to know which
 * keys it takes.
 */

export const HERDR_PREFIX_ACTIONS = [
  "help", "settings", "workspace_picker", "goto", "new_workspace", "previous_workspace", "next_workspace",
  "new_tab", "rename_tab", "previous_tab", "next_tab", "switch_tab", "split_vertical", "split_horizontal", "zoom", "toggle_sidebar",
] as const;

export type HerdrPrefixAction = (typeof HERDR_PREFIX_ACTIONS)[number];

/** herdr's prefixes and, for each action the app runs, the bindings herdr keeps for it, as written. */
export interface HerdrKeys {
  /** the first of `prefixes`, kept for clients from before prefix lists */
  prefix: string;
  /** every prefix key, each of which enters prefix mode (herdr's `prefix` then `extra_prefixes`) */
  prefixes: string[];
  bindings: Record<HerdrPrefixAction, string[]>;
}

/** Every herdr action outside navigate mode, in the order herdr registers them, with its default ("" unbound). */
const FIELDS = [
  ["help", "prefix+?"], ["settings", "prefix+s"], ["new_workspace", "prefix+shift+n"], ["new_worktree", "prefix+shift+g"],
  ["open_worktree", ""], ["remove_worktree", ""], ["rename_workspace", "prefix+shift+w"], ["close_workspace", "prefix+shift+d"],
  ["workspace_picker", "prefix+w"], ["goto", "prefix+g"], ["detach", "prefix+q"], ["reload_config", "prefix+shift+r"],
  ["open_notification_target", "prefix+o"], ["previous_workspace", ""], ["next_workspace", ""], ["previous_agent", ""],
  ["next_agent", ""], ["focus_agent", ""], ["new_tab", "prefix+c"], ["rename_tab", "prefix+shift+t"], ["previous_tab", "prefix+p"],
  ["next_tab", "prefix+n"], ["move_tab_previous", ""], ["move_tab_next", ""], ["switch_tab", "prefix+1..9"], ["switch_workspace", ""],
  ["close_tab", "prefix+shift+x"], ["rename_pane", "prefix+shift+p"], ["edit_scrollback", "prefix+e"], ["clear_pane", ""],
  ["copy_mode", "prefix+["], ["focus_pane_left", "prefix+h"],
  ["focus_pane_down", "prefix+j"], ["focus_pane_up", "prefix+k"], ["focus_pane_right", "prefix+l"], ["swap_pane_left", "prefix+shift+h"],
  ["swap_pane_down", "prefix+shift+j"], ["swap_pane_up", "prefix+shift+k"], ["swap_pane_right", "prefix+shift+l"], ["last_pane", ""],
  ["cycle_pane_next", "prefix+tab"], ["cycle_pane_previous", "prefix+shift+tab"], ["split_vertical", "prefix+v"],
  ["split_horizontal", "prefix+minus"], ["close_pane", "prefix+x"], ["zoom", "prefix+z"], ["resize_mode", "prefix+r"],
  ["resize_pane_left", ""], ["resize_pane_down", ""], ["resize_pane_up", ""], ["resize_pane_right", ""], ["toggle_sidebar", "prefix+b"],
] as const;

/** One of herdr's actions outside navigate mode. */
export type HerdrAction = (typeof FIELDS)[number][0];

/** herdr's navigate-mode keys, in its order, with their defaults (as `herdr --default-config` prints them). */
const NAVIGATE_FIELDS = [
  ["navigate_workspace_up", "up"], ["navigate_workspace_down", "down"], ["navigate_pane_left", "h"],
  ["navigate_pane_down", "j"], ["navigate_pane_up", "k"], ["navigate_pane_right", "l"],
] as const;

/** One of herdr's navigate-mode keys. */
export type HerdrNavigateKey = (typeof NAVIGATE_FIELDS)[number][0];

/** indexed actions and the `[keys.indexed]` entry that displaces their default */
const INDEXED: Readonly<Record<string, string>> = { focus_agent: "agents", switch_tab: "tabs", switch_workspace: "workspaces" };
const DEFAULT_PREFIX = "ctrl+b";

export interface HerdrChord {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  /** herdr's hyper: no browser reports it, so a chord with it never matches a key */
  readonly hyper: boolean;
  /** a lowercase letter, a digit, a punctuation character or space, or a KeyboardEvent.key name (Tab, Escape, ArrowLeft, F1) */
  readonly key: string;
}

export type HerdrBinding =
  | { readonly prefixed: boolean; readonly range: false; readonly chord: HerdrChord }
  /** `1..9`: one chord per digit, `key` left empty */
  | { readonly prefixed: boolean; readonly range: true; readonly chord: HerdrChord };

type Modifier = "ctrl" | "alt" | "shift" | "meta" | "hyper";
const MODIFIERS: ReadonlyMap<string, Modifier> = new Map([
  ["ctrl", "ctrl"], ["control", "ctrl"], ["shift", "shift"], ["alt", "alt"], ["option", "alt"], ["meta", "alt"],
  ["cmd", "meta"], ["command", "meta"], ["super", "meta"], ["hyper", "hyper"],
]);
const NAMED_KEYS: ReadonlyMap<string, string> = new Map([
  ["space", " "], [" ", " "], ["enter", "Enter"], ["return", "Enter"], ["esc", "Escape"], ["escape", "Escape"], ["tab", "Tab"],
  ["backspace", "Backspace"], ["bs", "Backspace"], ["left", "ArrowLeft"], ["right", "ArrowRight"], ["up", "ArrowUp"], ["down", "ArrowDown"],
  ["minus", "-"], ["comma", ","], ["period", "."], ["slash", "/"], ["backslash", "\\"], ["quote", "'"], ["double_quote", "\""],
  ["double-quote", "\""], ["semicolon", ";"], ["colon", ":"], ["percent", "%"], ["ampersand", "&"], ["backtick", "`"], ["plus", "+"],
]);

/** herdr's `parse_binding_string`: `prefix+` first, then modifiers and one key in any order, or `1..9` with modifiers only. */
export function parseHerdrBinding(raw: string): HerdrBinding | null {
  const trimmed = raw.trim();
  const prefixed = trimmed.startsWith("prefix+");
  const body = (prefixed ? trimmed.slice("prefix+".length) : trimmed).trim();
  const flags = { ctrl: false, alt: false, shift: false, meta: false, hyper: false };
  // a literal plus is the key after the last separator: `+` alone, or modifiers then `++`
  if (body === "+" || body.endsWith("++")) {
    for (const part of body === "+" ? [] : body.slice(0, -2).split("+")) {
      const modifier = MODIFIERS.get(part.trim().toLowerCase());
      if (modifier === undefined) return null;
      flags[modifier] = true;
    }
    return { prefixed, range: false, chord: { ...flags, key: "+" } };
  }
  const parts = body.split("+").map((part) => part.trim());
  if (parts.some((part) => part === "")) return null;
  let key: string | null = null;
  let range = false;
  for (const part of parts) {
    const modifier = MODIFIERS.get(part.toLowerCase());
    if (modifier !== undefined) flags[modifier] = true;
    else if (part === "1..9" && !range && key === null) range = true;
    else if (key !== null || range) return null;
    else key = part;
  }
  if (range) return { prefixed, range: true, chord: { ...flags, key: "" } };
  if (key === null) return null;
  const named = NAMED_KEYS.get(key.toLowerCase());
  if (named !== undefined) return { prefixed, range: false, chord: { ...flags, key: named } };
  if ([...key].length === 1) {
    // an ASCII capital is Shift and its letter, as herdr reads it
    return /^[A-Z]$/.test(key) ? { prefixed, range: false, chord: { ...flags, shift: true, key: key.toLowerCase() } } : { prefixed, range: false, chord: { ...flags, key } };
  }
  const f = /^f(\d{1,3})$/i.exec(key);
  return f && Number(f[1]) <= 255 ? { prefixed, range: false, chord: { ...flags, key: `F${Number(f[1])}` } } : null;
}

export function bindingChords(binding: HerdrBinding, field: string): { chord: HerdrChord; index: number | null }[] {
  if (binding.range) return [1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => ({ chord: { ...binding.chord, key: String(index) }, index }));
  return [{ chord: binding.chord, index: Object.hasOwn(INDEXED, field) && /^[1-9]$/.test(binding.chord.key) ? Number(binding.chord.key) : null }];
}

function chordId(chord: HerdrChord): string {
  return `${+chord.ctrl}${+chord.alt}${+chord.shift}${+chord.meta}${+chord.hyper}:${chord.key}`;
}

function bindingValues(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function table(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A binding herdr keeps for an action, as written, with the chords left to it (a range: each digit no earlier binding took). */
export interface HerdrKeptBinding {
  readonly text: string;
  readonly prefixed: boolean;
  readonly range: boolean;
  readonly chords: readonly { readonly chord: HerdrChord; readonly index: number | null }[];
}

/**
 * Why a binding the config writes holds no key: `unparsable` herdr cannot read it (for a prefix also one
 * written after `prefix+` or as a range); `printable` a direct binding on a key that types text (no
 * ctrl, alt or super), which would take that key from the pane; `prefix` it is a prefix key; `taken`
 * an earlier binding holds it; `index` a range on an action that takes no index, or a key other than a
 * digit on one that does; `reserved` a navigate key navigate mode keeps for itself (a plain Escape, Enter,
 * Tab or digit 1 to 9); `unknown_action` a `[keys]` name herdr does not read.
 */
export type HerdrKeyRefusalCode = "unparsable" | "printable" | "prefix" | "taken" | "index" | "reserved" | "unknown_action";

/** `binding` and `reason` hold the config's text as written, any length and control characters included: a screen cleans and clamps them. */
export interface HerdrKeyRefusal {
  /** the `[keys]` name written: an action, `prefix`, `extra_prefixes`, `command`, a navigate key or the unknown name */
  readonly action: string;
  readonly binding: string;
  readonly code: HerdrKeyRefusalCode;
  /** for `taken`, the action (or `command`) holding the key */
  readonly holder: string | null;
  /** the same, for a person */
  readonly reason: string;
}

/** Every herdr action outside navigate mode, as herdr resolves the user's `[keys]`. */
export interface AllHerdrKeys {
  /** false when a value of the wrong type made herdr read none of `[keys]`: all else is then its defaults */
  readonly configRead: boolean;
  /** every prefix key, herdr's `prefix` first */
  readonly prefixes: readonly { readonly text: string; readonly chord: HerdrChord }[];
  /** each of herdr's actions, in its order, with its default ("" unbound) and the bindings it keeps, after the prefix or direct */
  readonly actions: readonly { readonly action: HerdrAction; readonly default: string; readonly bindings: readonly HerdrKeptBinding[] }[];
  /** the direct (prefix-free) chords of `actions`, one per chord, in action order */
  readonly direct: readonly { readonly action: HerdrAction; readonly text: string; readonly chord: HerdrChord; readonly index: number | null }[];
  /**
   * herdr's six navigate-mode keys in its order, each with its default and the key it holds: the user's when
   * written (plain keys allowed), else the default. A list holds one entry per key it keeps; a key the user
   * writes that keeps none (refused, or "") holds one entry with `text` "" and `chord` null, as an action
   * the user writes loses its default even when its binding is refused.
   */
  readonly navigate: readonly { readonly name: HerdrNavigateKey; readonly default: string; readonly text: string; readonly chord: HerdrChord | null }[];
  /** the bindings the config writes that hold no key, and the `[keys]` names herdr does not know */
  readonly refusals: readonly HerdrKeyRefusal[];
}

/** the `[keys]` names herdr reads (`remote_image_paste` acts only under `herdr --remote`) */
const KEYS_NAMES: ReadonlySet<string> = new Set([
  "prefix", "extra_prefixes", "indexed", "command", "fullscreen", "remote_image_paste", ...FIELDS.map(([action]) => action), ...NAVIGATE_FIELDS.map(([name]) => name),
]);

/** herdr on navigate keys: "Do not include prefix+, esc, enter, tab, or 1..9 here" (`herdr --default-config`), so those keys without a modifier stay navigate mode's own */
function navigateReserved(chord: HerdrChord): boolean {
  return !chord.ctrl && !chord.alt && !chord.shift && !chord.meta && !chord.hyper && /^(?:Escape|Enter|Tab|[1-9])$/.test(chord.key);
}

const REASONS: Readonly<Record<HerdrKeyRefusalCode, (refusal: Omit<HerdrKeyRefusal, "reason">) => string>> = {
  unparsable: ({ action, binding }) => `${action}: herdr cannot read "${binding}"`,
  printable: ({ action, binding }) => `${action}: "${binding}" without the prefix would take a key typed into the pane; add ctrl, alt or super`,
  prefix: ({ action, binding }) => `${action}: "${binding}" is a prefix key`,
  taken: ({ action, binding, holder }) => `${action}: "${binding}" is already bound to ${holder}`,
  index: ({ action, binding }) => `${action}: "${binding}" is not a digit binding herdr allows for this action`,
  reserved: ({ action, binding }) => `${action}: navigate mode keeps "${binding}" for itself`,
  unknown_action: ({ action }) => `herdr has no action "${action}"`,
};

/** a chord that types its key: one character with no ctrl, alt or super */
function typesText(chord: HerdrChord): boolean {
  return !chord.ctrl && !chord.alt && !chord.meta && [...chord.key].length === 1;
}

interface Resolution {
  readonly configRead: boolean;
  readonly prefixes: readonly { readonly text: string; readonly chord: HerdrChord }[];
  readonly kept: ReadonlyMap<HerdrAction, readonly HerdrKeptBinding[]>;
  readonly navigate: AllHerdrKeys["navigate"];
  readonly refusals: readonly HerdrKeyRefusal[];
}

/**
 * herdr's resolution of config.toml's `[keys]` (`keys`: that table, or anything else for none). As herdr:
 * `prefix` and `extra_prefixes` (one key or a list each) are every prefix, an entry it cannot read
 * skipped and a repeat kept once, ctrl+b when none is left; a field the config writes beats a default
 * on the same key (every field the user wrote, custom commands included, registers first, then the
 * defaults, each pass in herdr's field order), the first binding of a key keeps it, a binding on any
 * prefix is dropped (the prefix twice sends the prefix), a range belongs to an indexed action only and
 * an indexed one takes digits only, and a direct binding that types text is refused. Keys after the
 * prefix and direct keys are taken apart. A value of the wrong type makes herdr read no config at all:
 * its defaults stand. Only what the user wrote is reported: a default that loses its key stands down
 * silently. A navigate-mode key is a chord without `prefix+`, plain keys allowed, registered the same way
 * among the navigate keys alone. A hole in a prefix or navigate list is skipped (no config text makes
 * one), as the browser's resolver always did; one in an action's list throws, as it always did.
 */
function resolveKeys(keys: unknown): Resolution {
  let user = table(keys) ?? {};
  // zoom's legacy name
  if (!Object.hasOwn(user, "zoom") && Object.hasOwn(user, "fullscreen")) user = { ...user, zoom: user["fullscreen"] };
  const indexed = Object.hasOwn(user, "indexed") ? table(user["indexed"]) : {};
  const commands = Object.hasOwn(user, "command") ? user["command"] : [];
  const wellTyped = ["prefix", "extra_prefixes", ...FIELDS.map(([field]) => field)].every((field) => !Object.hasOwn(user, field) || bindingValues(user[field]) !== null)
    && indexed !== null && Object.values(indexed).every((value) => typeof value === "string")
    && Array.isArray(commands) && commands.every((command) => table(command) !== null);
  if (!wellTyped) return { ...resolveKeys(undefined), configRead: false };
  const refusals: HerdrKeyRefusal[] = [];
  const refuse = (refusal: Omit<HerdrKeyRefusal, "reason">): void => { refusals.push({ ...refusal, reason: REASONS[refusal.code](refusal) }); };
  const prefixes: { text: string; chord: HerdrChord }[] = [];
  const prefixIds = new Set<string>();
  // flatMap skips a hole in a list
  const written = ["prefix", "extra_prefixes"].flatMap((field) => (Object.hasOwn(user, field) ? bindingValues(user[field]) ?? [] : []).flatMap((raw) => [{ field, raw }]));
  for (const { field, raw } of written) {
    const parsed = parseHerdrBinding(raw);
    if (parsed === null || parsed.prefixed || parsed.range) {
      refuse({ action: field, binding: raw.trim(), code: "unparsable", holder: null });
      continue;
    }
    if (prefixIds.has(chordId(parsed.chord))) continue;
    prefixIds.add(chordId(parsed.chord));
    prefixes.push({ text: raw.trim(), chord: parsed.chord });
  }
  if (prefixes.length === 0) {
    const chord = parseHerdrBinding(DEFAULT_PREFIX)!.chord;
    prefixes.push({ text: DEFAULT_PREFIX, chord });
    prefixIds.add(chordId(chord));
  }
  const takenAfterPrefix = new Map<string, string>();
  const takenDirect = new Map<string, string>();
  const kept = new Map<HerdrAction, HerdrKeptBinding[]>(FIELDS.map(([action]) => [action, []]));
  const register = (field: HerdrAction | "command", values: readonly string[], written: boolean): void => {
    const isIndexed = Object.hasOwn(INDEXED, field);
    const report = (raw: string, code: HerdrKeyRefusalCode, holder: string | null = null): void => {
      if (written) refuse({ action: field, binding: raw.trim(), code, holder });
    };
    for (const raw of values) {
      // an empty binding unbinds the action
      if (raw.trim() === "") continue;
      const binding = parseHerdrBinding(raw);
      if (binding === null) { report(raw, "unparsable"); continue; }
      if (binding.range && !isIndexed) { report(raw, "index"); continue; }
      const items = bindingChords(binding, field);
      if (!binding.prefixed && items.some((item) => typesText(item.chord))) { report(raw, "printable"); continue; }
      const taken = binding.prefixed ? takenAfterPrefix : takenDirect;
      const chords: { chord: HerdrChord; index: number | null }[] = [];
      for (const item of items) {
        if (isIndexed && !/^[1-9]$/.test(item.chord.key)) { report(raw, "index"); continue; }
        const id = chordId(item.chord);
        if (prefixIds.has(id)) { report(raw, "prefix"); continue; }
        const holder = taken.get(id);
        if (holder !== undefined) { report(raw, "taken", holder); continue; }
        taken.set(id, field);
        chords.push(item);
      }
      if (field !== "command" && chords.length > 0) kept.get(field)!.push({ text: raw.trim(), prefixed: binding.prefixed, range: binding.range, chords });
    }
  };
  for (const pass of ["user", "default"] as const) {
    for (const [field, defaults] of FIELDS) {
      const written = Object.hasOwn(user, field);
      if (written !== (pass === "user")) continue;
      // a legacy [keys.indexed] entry is the user's own binding for that action: its default stands down
      if (pass === "default" && Object.hasOwn(INDEXED, field) && typeof indexed?.[INDEXED[field]!] === "string" && (indexed[INDEXED[field]!] as string).trim() !== "") continue;
      register(field, written ? bindingValues(user[field]) ?? [] : [defaults], written);
    }
    if (pass === "user" && Array.isArray(commands)) {
      for (const command of commands) {
        const entry = table(command);
        // a command herdr skips (no command to run) takes no key; its body is only checked, never kept
        if (entry === null || typeof entry["command"] !== "string" || entry["command"].trim() === "") continue;
        register("command", bindingValues(entry["key"]) ?? [], true);
      }
    }
  }
  const takenNavigate = new Map<string, HerdrNavigateKey>();
  const navigateHeld = new Map<HerdrNavigateKey, { text: string; chord: HerdrChord }[]>(NAVIGATE_FIELDS.map(([name]) => [name, []]));
  for (const pass of ["user", "default"] as const) {
    for (const [name, defaults] of NAVIGATE_FIELDS) {
      const written = Object.hasOwn(user, name);
      if (written !== (pass === "user")) continue;
      const report = (raw: string, code: HerdrKeyRefusalCode, holder: string | null = null): void => {
        if (written) refuse({ action: name, binding: raw.trim(), code, holder });
      };
      const values = written ? bindingValues(user[name]) : [defaults];
      if (values === null) { report("", "unparsable"); continue; }
      // flatMap skips a hole in the list
      for (const raw of values.flatMap((text) => [text])) {
        if (raw.trim() === "") continue;
        const binding = parseHerdrBinding(raw);
        if (binding === null || binding.prefixed || binding.range) { report(raw, "unparsable"); continue; }
        if (navigateReserved(binding.chord)) { report(raw, "reserved"); continue; }
        const id = chordId(binding.chord);
        if (prefixIds.has(id)) { report(raw, "prefix"); continue; }
        const holder = takenNavigate.get(id);
        if (holder !== undefined) { report(raw, "taken", holder); continue; }
        takenNavigate.set(id, name);
        navigateHeld.get(name)!.push({ text: raw.trim(), chord: binding.chord });
      }
    }
  }
  for (const [name, value] of Object.entries(user)) {
    if (!KEYS_NAMES.has(name)) refuse({ action: name, binding: bindingValues(value)?.join(", ") ?? "", code: "unknown_action", holder: null });
  }
  const navigate = NAVIGATE_FIELDS.flatMap(([name, defaults]): AllHerdrKeys["navigate"] => {
    const held = navigateHeld.get(name)!;
    return held.length === 0 ? [{ name, default: defaults, text: "", chord: null }] : held.map((key) => ({ name, default: defaults, ...key }));
  });
  return { configRead: true, prefixes, kept, navigate, refusals };
}

/** The prefixes and the prefix bindings herdr keeps for each action the app runs, as written (resolveKeys). */
export function resolveHerdrKeys(keys: unknown): HerdrKeys {
  const { prefixes, kept } = resolveKeys(keys);
  // a range keeps its text while it holds all nine digits, else one text per digit it holds
  const bindings = Object.fromEntries(HERDR_PREFIX_ACTIONS.map((action) => [action, kept.get(action)!.filter((binding) => binding.prefixed)
    .flatMap((binding) => binding.range && binding.chords.length < 9 ? binding.chords.map(({ chord }) => binding.text.replace("1..9", chord.key)) : [binding.text])])) as HerdrKeys["bindings"];
  return { prefix: prefixes[0]!.text, prefixes: prefixes.map((prefix) => prefix.text), bindings };
}

/**
 * Every herdr action outside navigate mode with its default and the bindings herdr keeps for it, the
 * prefixes, the direct bindings, the navigate-mode keys the config writes, and what it writes that
 * holds no key (resolveKeys). The
 * caller reads config.toml; `keys` is its `[keys]` table, as resolveHerdrKeys takes it.
 */
export function resolveAllHerdrKeys(keys: unknown): AllHerdrKeys {
  const { configRead, prefixes, kept, navigate, refusals } = resolveKeys(keys);
  const actions = FIELDS.map(([action, defaults]) => ({ action, default: defaults, bindings: kept.get(action)! }));
  const direct = actions.flatMap(({ action, bindings }) => bindings.filter((binding) => !binding.prefixed)
    .flatMap((binding) => binding.chords.map(({ chord, index }) => ({ action, text: binding.text, chord, index }))));
  return { configRead, prefixes, actions, direct, navigate, refusals };
}
