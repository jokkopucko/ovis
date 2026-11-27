/**
 * The system Back button (Android's, a swipe from the screen's
 * edge) traverses history, and a dialog that is no entry of it is skipped: Back left the app
 * instead of the page.
 */

import { SHEET_HISTORY_KEY, SHEET_UNDER_KEY, sheetStep, silentSheetLandings } from "./historyKeys.ts";

const KEY = "ovis:settings";
const BASE_KEY = "ovis:settings-base";
const ABOVE_KEY = "ovis:settings-above";
const LOST_KEY = "ovis:settings-base-lost";
const ANCHOR_KEY = "ovis:settings-anchor";
const LANDING_MS = 1000;

export interface SettingsLevel {
  page: string | null;
  keyBar: boolean;
}

export interface SettingsEntry extends SettingsLevel {
  depth: number;
}

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

export function outsideSettings(state: unknown): Record<string, unknown> {
  const { [KEY]: _entry, [BASE_KEY]: opening, ...rest } = state !== null && typeof state === "object" ? state as Record<string, unknown> : {};
  return settingsEntry(state) !== null && typeof opening === "string" ? { ...rest, [ABOVE_KEY]: opening } : rest;
}

type Listener = (entry: SettingsEntry | null, own: boolean) => void;
const listeners = new Set<Listener>();
let steppedOff = false;
let skippingBuried = false;

export function settingsSteppedOff(): boolean {
  return steppedOff;
}
let wanted: readonly SettingsLevel[] = [];
let held: Array<SettingsLevel | null> = [];
const same = (a: SettingsLevel | null, b: SettingsLevel): boolean => a !== null && a.page === b.page && a.keyBar === b.keyBar;
let rewinding = 0;
let landing: ReturnType<typeof setTimeout> | undefined;
let pending: { from: unknown; depth: number; level: SettingsLevel | null; expired: boolean; reopened: boolean; claim: boolean } | null = null;
let observed: unknown = typeof window === "undefined" ? undefined : window.history.state;
let writing = false;
let loadedOnSettings = false;
let deferredForSheet = false;
let opening: unknown;
let openedOver: unknown;
const buried = new Set<unknown>();

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
  window.history.go(-by - (sheetStep.goingBack(window.history.state) ? 1 : 0));
}

function reconcile(): void {
  const state: unknown = window.history.state;
  if (pending !== null && state !== observed) releasePending();
  observed = state;
  if (rewinding > 0) return;
  const current = settingsEntry(state);
  const have = current?.depth ?? 0;
  // The confirmation owns the entry above the Settings page. Keep the requested
  // layout, but rebuild its levels only after the confirmation leaves that entry.
  if (have > 0 && wanted.length > 0 && typeof fieldOf(state, SHEET_HISTORY_KEY) === "string") {
    deferredForSheet = true;
    return;
  }
  deferredForSheet = false;
  if (have === 0 && held.length > 0 && fieldOf(state, BASE_KEY) !== opening) buried.add(opening);
  if (have > 0) { opening = fieldOf(state, BASE_KEY); openedOver = fieldOf(state, ANCHOR_KEY); }
  // what the history holds up to here: a Back landed under what was recorded; the step shown is
  // read from the state; one this module did not push (a reload or a Forward landed on entries
  // of an earlier opening) is unknown, never taken on trust, and rebuilt like a differing one
  held = held.slice(0, have);
  while (held.length < have) held.push(null);
  if (have > 0 && current) held[have - 1] = { page: current.page, keyBar: current.keyBar };
  if (have > wanted.length) { rewind(have - wanted.length); return; }
  let differs = 0;
  while (differs < have && differs < wanted.length && same(held[differs]!, wanted[differs]!)) differs++;
  if (differs < have - 1) { rewind(have - differs - 1); return; }
  let base = state !== null && typeof state === "object" ? state : {};
  if (have === 0 && wanted.length > 0) {
    const { [LOST_KEY]: _lost, [ANCHOR_KEY]: _anchor, ...unanchored } = base as Record<string, unknown>;
    opening = Math.random().toString(36).slice(2);
    openedOver = undefined;
    writeState("replaceState", { ...unanchored, [BASE_KEY]: opening });
    base = window.history.state as object;
  }
  if (have > 0 && differs === have - 1) {
    writeState("replaceState", { ...base, [KEY]: { ...wanted[have - 1], depth: have } });
    held[have - 1] = wanted[have - 1]!;
  }
  for (let depth = have + 1; depth <= wanted.length; depth++) {
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

export function onSettingsHistory(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

if (typeof window !== "undefined") {
  const deferredHere = (state: unknown): boolean => {
    const top = wanted.at(-1);
    const current: unknown = window.history.state;
    return deferredForSheet && top !== undefined && same(settingsEntry(state), top)
      && fieldOf(state, BASE_KEY) === opening && fieldOf(current, SHEET_HISTORY_KEY) === undefined && sameEntry(state, current);
  };
  silentSheetLandings.add(() => {
    if (deferredHere(window.history.state)) reconcile();
  });
  for (const method of ["pushState", "replaceState"] as const) {
    const history = window.history;
    const write = history[method].bind(history);
    history[method] = ((...args: Parameters<History["pushState"]>) => {
      const before: unknown = history.state;
      write(...args);
      observed = history.state;
      if (!writing && (method === "pushState" || !sameEntry(before, history.state))) releasePending();
    }) as History["pushState"];
  }
  window.addEventListener("popstate", (event) => {
    if (sheetStep.holds(event) || sheetStep.taking(event)) return;
    const previous = observed;
    observed = event.state;
    const entry = settingsEntry(event.state);
    const skipped = skippingBuried;
    skippingBuried = false;
    if (pending === null && entry !== null && buried.has(fieldOf(event.state, BASE_KEY)) && fieldOf(previous, BASE_KEY) !== fieldOf(event.state, BASE_KEY)) {
      buried.delete(fieldOf(event.state, BASE_KEY));
      skippingBuried = true;
      rewind(entry.depth);
      return;
    }
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
    const left = settingsEntry(previous);
    const forwardAbove = fieldOf(event.state, ABOVE_KEY) !== undefined && fieldOf(event.state, ABOVE_KEY) === fieldOf(previous, BASE_KEY);
    const ontoBase = fieldOf(event.state, BASE_KEY) !== undefined && fieldOf(event.state, BASE_KEY) === fieldOf(previous, BASE_KEY);
    const baseLost = fieldOf(previous, LOST_KEY) === true;
    const anchor = fieldOf(previous, ANCHOR_KEY);
    const ontoUnder = anchor === undefined || fieldOf(event.state, SHEET_UNDER_KEY) === anchor;
    steppedOff = !skipped && entry === null && left !== null && !forwardAbove && (own || ontoBase || (baseLost && ontoUnder));
    if (pending !== null && (matches || event.state !== pending.from)) releasePending();
    const rebuild = entry !== null && deferredHere(event.state);
    for (const listener of [...listeners]) listener(entry, own || rebuild);
    if (own || rebuild) reconcile();
  });
  // a reload keeps the history and not the dialog: step out of the entries it left
  const left = settingsEntry(window.history.state);
  if (left !== null) { loadedOnSettings = true; rewind(left.depth); }
  else if (typeof fieldOf(window.history.state, ABOVE_KEY) === "string") {
    loadedOnSettings = true;
    buried.add(fieldOf(window.history.state, ABOVE_KEY));
  }
}
