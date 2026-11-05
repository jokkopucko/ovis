/**
 * Settings in the browser's history. The system Back button (Android's, a swipe from the screen's
 * edge) traverses history, and a dialog that is no entry of it is skipped: Back left the app
 * instead of the page. So each step into Settings is an entry above the app: the dialog, the
 * page a phone opens from its list, the key bar editor. Back takes them off one at a time.
 *
 * The dialog says what is shown as a list of levels (`recordSettings`); this module makes the
 * history hold exactly those entries, pushing the missing ones and stepping back over the ones
 * no longer shown (a Back control in the dialog, its X, Escape). It tells its listeners when a
 * traversal lands, and whether it was one of its own.
 */

import { SHEET_HISTORY_KEY, SHEET_UNDER_KEY, sheetStep } from "./historyKeys.ts";

const KEY = "ovis:settings";
/** names an opening of Settings on the entry it began from and on each of its entries */
const BASE_KEY = "ovis:settings-base";
/** names the opening an entry another dialog pushed from a Settings entry lies above */
const ABOVE_KEY = "ovis:settings-above";
/** on an opening's entries when its first one took over the entry it began from (a phone sheet's, sheetHistory) */
const LOST_KEY = "ovis:settings-base-lost";
/** that opening's anchor: the id of the sheet whose entry it took, which the entry the sheet opened over carries.
 *  Kept apart from the sheet's own key, which a sheet opened inside Settings writes again */
const ANCHOR_KEY = "ovis:settings-anchor";
/** how long to wait before releasing the traversal's busy state, not its ownership */
const LANDING_MS = 1000;

/** One step into Settings: the page shown (null: a phone's list of pages) and the key bar editor over it. */
export interface SettingsLevel {
  page: string | null;
  keyBar: boolean;
}

export interface SettingsEntry extends SettingsLevel {
  /** how many entries of Settings the history holds up to this one */
  depth: number;
}

/**
 * What the dialog shows, as the steps that led there. A phone lists the pages first, so its
 * list is a step of its own; a wider dialog opens on a page, and turning to another replaces it.
 */
export function settingsLevels(narrow: boolean, page: string | null, keyBar: boolean): SettingsLevel[] {
  const levels: SettingsLevel[] = narrow ? [{ page: null, keyBar: false }] : [];
  if (page !== null) levels.push({ page, keyBar: false });
  if (page !== null && keyBar) levels.push({ page, keyBar: true });
  return levels;
}

/** The Settings entry a history state holds, or null: state is whatever another script left there. */
export function settingsEntry(state: unknown): SettingsEntry | null {
  if (state === null || typeof state !== "object") return null;
  const entry = (state as Record<string, unknown>)[KEY];
  if (entry === null || typeof entry !== "object") return null;
  const { page, keyBar, depth } = entry as Record<string, unknown>;
  if ((page !== null && typeof page !== "string") || typeof keyBar !== "boolean") return null;
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1 || depth > 3) return null;
  return { page, keyBar, depth };
}

const fieldOf = (state: unknown, key: string): unknown =>
  state !== null && typeof state === "object" ? (state as Record<string, unknown>)[key] : undefined;

/**
 * The state for an entry another dialog (a file preview) pushes from this one. It is no Settings
 * entry, so it does not copy one: it notes the opening it lies above instead, which a reload on
 * it closes without stepping back over it.
 */
export function outsideSettings(state: unknown): Record<string, unknown> {
  const { [KEY]: _entry, [BASE_KEY]: opening, ...rest } = state !== null && typeof state === "object" ? state as Record<string, unknown> : {};
  return settingsEntry(state) !== null && typeof opening === "string" ? { ...rest, [ABOVE_KEY]: opening } : rest;
}

type Listener = (entry: SettingsEntry | null, own: boolean) => void;
const listeners = new Set<Listener>();
/** whether the popstate being dispatched left Settings' entries for the one beneath: this module listens first, so the app's Back reads it for the same event */
let steppedOff = false;
/** a step over buried entries is under way: it lands where the user's Back meant to go, and is no closing */
let skippingBuried = false;

/**
 * Whether the popstate the app is handling is Settings closing, by its own controls or by a Back off
 * its last entry, onto the entry it opened over. That is no Back to the entry's pane: a pick made
 * while the dialog was up stays where it is.
 */
export function settingsSteppedOff(): boolean {
  return steppedOff;
}
let wanted: readonly SettingsLevel[] = [];
/** the steps this module knows the history holds for Settings, by depth; null for one it did not push and cannot see */
let held: Array<SettingsLevel | null> = [];
const same = (a: SettingsLevel | null, b: SettingsLevel): boolean => a !== null && a.page === b.page && a.keyBar === b.keyBar;
/** traversals asked for here that have not landed yet: nothing is pushed while one is under way */
let rewinding = 0;
let landing: ReturnType<typeof setTimeout> | undefined;
let pending: { from: unknown; depth: number; level: SettingsLevel | null; expired: boolean; reopened: boolean; claim: boolean } | null = null;
let observed: unknown = typeof window === "undefined" ? undefined : window.history.state;
let writing = false;
let loadedOnSettings = false;
/** the opening of Settings the entries held belong to, as written into its base entry */
let opening: unknown;
/** the phone sheet whose entry that opening took over (its anchor): the entry the sheet opened over carries its id */
let openedOver: unknown;
/** the openings whose entries lie under an entry that is not their base: Back onto them steps over them, each until it has been */
const buried = new Set<unknown>();

/** Whether two states are the same entry to Settings: the same step into it, of the same opening. */
function sameEntry(a: unknown, b: unknown): boolean {
  const one = settingsEntry(a), other = settingsEntry(b);
  return fieldOf(a, BASE_KEY) === fieldOf(b, BASE_KEY) && (one === null ? other === null
    : other !== null && one.page === other.page && one.keyBar === other.keyBar && one.depth === other.depth);
}

function releasePending(): void { pending = null; rewinding = 0; clearTimeout(landing); }

function writeState(method: "pushState" | "replaceState", state: unknown): void {
  writing = true;
  try { window.history[method](state, ""); }
  finally { writing = false; observed = window.history.state; }
}

function rewind(by: number): void {
  if (pending !== null) return;
  const depth = (settingsEntry(window.history.state)?.depth ?? 0) - by;
  const request = { from: window.history.state, depth, level: held[depth - 1] ?? null, expired: false, reopened: false, claim: true };
  pending = request;
  rewinding = 1;
  clearTimeout(landing);
  landing = setTimeout(() => {
    if (pending !== request) return;
    rewinding = 0;
    request.expired = true;
    if (request.reopened) request.claim = false;
  }, LANDING_MS);
  // a sheet opened inside Settings closed a moment ago (Connect a phone, once the phone paired) and
  // its entry, which copies the Settings entry under it, is still the current one: step over it too
  window.history.go(-by - (sheetStep.takeLeaving(window.history.state) ? 1 : 0));
}

function reconcile(): void {
  const state: unknown = window.history.state;
  if (pending !== null && state !== observed) releasePending();
  observed = state;
  if (rewinding > 0) return;
  const current = settingsEntry(state);
  const have = current?.depth ?? 0;
  // entries held under a state that is not the one they began from: a markerless entry (a typed
  // #hash, another script's pushState, a preview) landed above them, and they are buried there
  if (have === 0 && held.length > 0 && fieldOf(state, BASE_KEY) !== opening) buried.add(opening);
  if (have > 0) { opening = fieldOf(state, BASE_KEY); openedOver = fieldOf(state, ANCHOR_KEY); }
  // what the history holds up to here: a Back landed under what was recorded; the step shown is
  // read from the state; one this module did not push (a reload or a Forward landed on entries
  // of an earlier opening) is unknown, never taken on trust, and rebuilt like a differing one
  held = held.slice(0, have);
  while (held.length < have) held.push(null);
  if (have > 0 && current) held[have - 1] = { page: current.page, keyBar: current.keyBar };
  if (have > wanted.length) { rewind(have - wanted.length); return; }
  // the first step that differs from what is wanted. An earlier one (the window changed width:
  // a phone's list belongs under a page a wider dialog had opened directly, or no longer does)
  // is stepped back to and the steps above it are made anew
  let differs = 0;
  while (differs < have && differs < wanted.length && same(held[differs]!, wanted[differs]!)) differs++;
  if (differs < have - 1) { rewind(have - differs - 1); return; }
  let base = state !== null && typeof state === "object" ? state : {};
  if (have === 0 && wanted.length > 0) {
    // a new opening: its base entry is marked, so a Back onto it is told from a foreign entry. It
    // drops the lost mark and the anchor an earlier opening that took over a phone sheet's entry
    // left there (a preview opened over that opening copies both): its entries copy the base's,
    // and their closing would be told by the earlier opening's anchor
    const { [LOST_KEY]: _lost, [ANCHOR_KEY]: _anchor, ...unanchored } = base as Record<string, unknown>;
    opening = Math.random().toString(36).slice(2);
    openedOver = undefined;
    writeState("replaceState", { ...unanchored, [BASE_KEY]: opening });
    base = window.history.state as object;
  }
  if (have > 0 && differs === have - 1) {
    // the step shown is another: a wider dialog turned its page, or the list took a page's place
    writeState("replaceState", { ...base, [KEY]: { ...wanted[have - 1], depth: have } });
    held[have - 1] = wanted[have - 1]!;
  }
  for (let depth = have + 1; depth <= wanted.length; depth++) {
    // a push from a phone sheet's entry becomes a replace of it (sheetHistory): the entry this
    // opening began from, with its mark, is gone, so its entries say so for its closing to be told
    const takesOver = depth === 1 && fieldOf(window.history.state, SHEET_HISTORY_KEY) !== undefined;
    writeState("pushState", { ...base, [KEY]: { ...wanted[depth - 1], depth } });
    if (takesOver) {
      const { [SHEET_HISTORY_KEY]: _sheet, ...unmarked } = base as Record<string, unknown>;
      const anchor = unmarked[SHEET_UNDER_KEY];
      openedOver = anchor;
      const marks = { [LOST_KEY]: true, ...(anchor === undefined ? {} : { [ANCHOR_KEY]: anchor }) };
      base = { ...unmarked, ...marks };
      // from the entry as the sheet left it, without its mark: with it, the entry is the sheet's again
      const current: unknown = window.history.state;
      writeState("replaceState", { ...(current !== null && typeof current === "object" ? current : {}), ...marks });
    }
    held.push(wanted[depth - 1]!);
  }
}

/** Makes the history hold these steps into Settings, in order; none when the dialog is closed. */
export function recordSettings(levels: readonly SettingsLevel[]): void {
  const reopening = wanted.length === 0 && levels.length > 0;
  wanted = levels;
  if (reopening && pending !== null) { pending.reopened = true; if (pending.expired) pending.claim = false; }
  if (typeof window !== "undefined") reconcile();
}

/**
 * Whether this load began on an entry Settings left, which it steps out of, or on one above them
 * (a preview opened over Settings), which it keeps with Settings closed. Asked rather than
 * read from the history by whoever opens Settings from the address: the step lands when the
 * browser gets to it, before or after the app first draws, and either address may name Settings.
 */
export function loadedOnSettingsEntry(): boolean { return loadedOnSettings; }

/**
 * Tells when the history moved: the Settings entry it landed on (null: under the dialog), and
 * whether the move was this module's own stepping back, which the dialog already shows.
 */
export function onSettingsHistory(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

if (typeof window !== "undefined") {
  for (const method of ["pushState", "replaceState"] as const) {
    const history = window.history;
    const write = history[method].bind(history);
    history[method] = ((...args: Parameters<History["pushState"]>) => {
      const before: unknown = history.state;
      write(...args);
      observed = history.state;
      // the address written on the same entry (the app's address bar, as Settings closes) moves
      // nothing: a step back under way still lands where it was asked to, and is still this module's
      if (!writing && (method === "pushState" || !sameEntry(before, history.state))) releasePending();
    }) as History["pushState"];
  }
  window.addEventListener("popstate", (event) => {
    const previous = observed;
    observed = event.state;
    const entry = settingsEntry(event.state);
    const skipped = skippingBuried;
    skippingBuried = false;
    // Back from above onto the entries of a buried opening: Settings closed when they were buried,
    // so they are stepped over to the entry they began from instead of opening it again
    if (pending === null && entry !== null && buried.has(fieldOf(event.state, BASE_KEY)) && fieldOf(previous, BASE_KEY) !== fieldOf(event.state, BASE_KEY)) {
      buried.delete(fieldOf(event.state, BASE_KEY));
      skippingBuried = true;
      rewind(entry.depth);
      return;
    }
    // a closed phone sheet's step off its entry, asked for before Settings opened over that entry,
    // lands on the entry the sheet opened over, under Settings: no Back of the user's. Settings
    // stays, its entries made again from here (over a sheet that stays up, a peek, whose entry
    // sheetHistory has just made again). A sheet's step onto any other entry (a preview's, above
    // Settings) is no such step
    if (pending === null && entry === null && wanted.length > 0 && openedOver !== undefined
      && fieldOf(event.state, SHEET_UNDER_KEY) === openedOver && sheetStep.lands(event)) {
      steppedOff = false;
      held = [];
      reconcile();
      return;
    }
    const matches = pending !== null && (entry?.depth ?? 0) === pending.depth
      && (pending.level === null || (entry !== null && same(pending.level, entry)));
    const own = matches && pending?.claim === true;
    // Settings closing lands on the entry it was opened over: by its controls (this module's own
    // step back), or a Back onto the entry with the opening's mark. A jump past that entry (the
    // browser's Back menu) goes to another pane, Forward onto an entry above Settings (a preview
    // opened over it) is no closing, nor is the step over buried entries that finishes a Back of
    // the user's. An opening whose entry a phone sheet took over closes onto the entry the sheet
    // opened over, which carries the sheet's id (sheetHistory); without that id, any step below does
    const left = settingsEntry(previous);
    const forwardAbove = fieldOf(event.state, ABOVE_KEY) !== undefined && fieldOf(event.state, ABOVE_KEY) === fieldOf(previous, BASE_KEY);
    const ontoBase = fieldOf(event.state, BASE_KEY) !== undefined && fieldOf(event.state, BASE_KEY) === fieldOf(previous, BASE_KEY);
    const baseLost = fieldOf(previous, LOST_KEY) === true;
    const anchor = fieldOf(previous, ANCHOR_KEY);
    const ontoUnder = anchor === undefined || fieldOf(event.state, SHEET_UNDER_KEY) === anchor;
    steppedOff = !skipped && entry === null && left !== null && !forwardAbove && (own || ontoBase || (baseLost && ontoUnder));
    if (pending !== null && (matches || event.state !== pending.from)) releasePending();
    for (const listener of [...listeners]) listener(entry, own);
    // what was asked for while the traversal was under way is done now
    if (own) reconcile();
  });
  // a reload keeps the history and not the dialog: step out of the entries it left
  const left = settingsEntry(window.history.state);
  if (left !== null) { loadedOnSettings = true; rewind(left.depth); }
  else if (typeof fieldOf(window.history.state, ABOVE_KEY) === "string") {
    // an entry above Settings (a preview opened over it) stays, and Settings stays closed: Back
    // from it steps over the entries beneath
    loadedOnSettings = true;
    buried.add(fieldOf(window.history.state, ABOVE_KEY));
  }
}
