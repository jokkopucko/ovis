/**
 * No entry is made where Back would not keep it. Chromium's Back skips every entry of a page that
 * added one with no tap since it loaded or since the user's last Back or Forward (its history
 * manipulation intervention; a step the page takes by itself ends nothing), and on a phone that
 * leaves the app with the sheet still up. So a sheet that closes itself over one that stays hands
 * its entry back to it with no step; there, a Back that leaves a sheet up (it refused, or what
 * covered it went) goes again onto the entry it left, which is still in the history, instead of
 * making one; the file list, in front again once Back closed the file or the diff opened from it,
 * goes onto the entry that Back left and takes it (`returns`); and any other sheet that opens
 * with no tap behind it waits for the next one to make its entry.
 *
 * A sheet that waits so and refuses Back (a device's request to join, which shows by itself and
 * answers nothing on Back) still keeps what is under it where it is.
 *
 * Going onto an entry again, and telling which one a traversal landed on, takes a key and a count
 * for each entry: the browser's own (the Navigation API), or, in a Chromium that skips entries
 * and has none (before 102), the ones this module keeps in each entry's state (`places`).
 */
import { useEffect, useRef } from "react";
import { PLACE_KEY, SHEET_HISTORY_KEY, SHEET_UNDER_KEY, overCopiedEntry, sheetStep, silentSheetLandings } from "./historyKeys.ts";
import { SHEET_QUERY } from "./sheets.ts";
import { shellMode } from "./shellMode.ts";
import { useMediaQuery } from "./useMediaQuery.ts";

const KEY = SHEET_HISTORY_KEY;

export const BACK_QUERY = `${SHEET_QUERY}, (hover: none) and (pointer: coarse)`;

const open = new Map<string, () => boolean | void>();
const leaving = new Map<string, ReturnType<typeof setTimeout>>();
const addresses = new Map<string, string>();
const staying = new Set<string>();
const covered = new Set<string>();
const underNavigation = new Set<string>();
const heirs = new Map<string, string>();
/**
 * Whether the browser's Back skips entries made with no tap behind them: Chromium's does, and it
 * tells of activations. Elsewhere every moment counts as a tap, and entries are made as they come.
 */
const SKIPS = typeof navigator !== "undefined" && "userActivation" in navigator && /Chrome\/|Chromium\//.test(navigator.userAgent);
let tapped = !SKIPS;
const waiting = new Set<string>();
/** sheets still up whose way back onto their entry the browser dropped: they wait for the next tap to make one */
const stranded = new Set<string>();
let seen: string | null = null;
let returning: { entry: string; owner: string; href: string } | null = null;
interface NavigationApi {
  currentEntry?: { key: string; index: number } | null;
  entries(): Array<{ key: string; index: number }>;
  traverseTo(key: string): { committed: Promise<unknown>; finished: Promise<unknown> };
}
interface Place { run: string; key: string; index: number }
function placeIn(state: unknown): Place | null {
  const place = state !== null && typeof state === "object" ? (state as Record<string, unknown>)[PLACE_KEY] : null;
  if (place === null || typeof place !== "object") return null;
  const { run, key, index } = place as Record<string, unknown>;
  return typeof run === "string" && typeof key === "string" && typeof index === "number" && Number.isInteger(index) ? { run, key, index } : null;
}
function placed(state: unknown, place: Place | null): unknown {
  if (state === null || typeof state !== "object") return place === null ? state : { [PLACE_KEY]: place };
  if (place === null && !(PLACE_KEY in state)) return state;
  const { [PLACE_KEY]: _, ...rest } = state as Record<string, unknown>;
  return place === null ? rest : { ...rest, [PLACE_KEY]: place };
}
const token = (): string => Math.random().toString(36).slice(2, 10);
let run: string | null = null;
const counted = new Map<string, number>();
let asking: { key: string; landed: () => void; dropped: (why: Error) => void } | null = null;
/**
 * Going onto an entry is `history.go` by the difference of two counts. That counts the steps a framed
 * page took as well, so a way over more than one entry can land short where such a page is open.
 */
const places: NavigationApi = {
  get currentEntry() {
    const place = placeIn(window.history.state);
    if (place === null || place.run !== run) return null;
    counted.set(place.key, place.index);
    return { key: place.key, index: place.index };
  },
  entries: () => [...counted].map(([key, index]) => ({ key, index })),
  traverseTo(key) {
    const from = places.currentEntry, to = counted.get(key);
    asking?.dropped(new Error("another way was asked for"));
    asking = null;
    const way = from == null || to === undefined || to === from.index
      ? Promise.reject<void>(new Error("no way onto that entry is known"))
      : new Promise<void>((landed, dropped) => { asking = { key, landed, dropped }; window.history.go(to - from.index); });
    return { committed: way, finished: way };
  },
};
function settle(at: { key: string } | null): void {
  const way = asking;
  asking = null;
  if (way === null) return;
  if (at?.key === way.key) way.landed();
  else way.dropped(new Error("another traversal landed"));
}
const navigation = (): NavigationApi | undefined => (window as unknown as { navigation?: NavigationApi }).navigation ?? (SKIPS ? places : undefined);
let here: { key: string; index: number } | null = null;
function where(): { key: string; index: number } | null {
  const entry = navigation()?.currentEntry;
  return entry ? { key: entry.key, index: entry.index } : null;
}
function settleUnheardBack(): void {
  if (stepping === null || stepOnto === null) return;
  const at = where();
  if (at?.key !== stepOnto) return;
  stepping = null;
  stepOnto = null;
  here = at;
  seen = sheetOf(window.history.state);
  for (const listener of silentSheetLandings) listener();
}
let ahead: string | null = null;
let climbing: { key: string; owner: string; state: unknown; href: string } | null = null;
let took = false;
let stood: { key: string; by: string; pending: boolean } | null = null;
let holding = false;
const entryKeys = new Map<string, string>();
function keep(id: string): void {
  underNavigation.delete(id);
  const key = navigation()?.currentEntry?.key;
  if (key !== undefined) entryKeys.set(id, key);
}
function placeOf(id: string): number {
  const key = entryKeys.get(id);
  return key === undefined ? -1 : navigation()?.entries().find((entry) => entry.key === key)?.index ?? -1;
}
function cover(state: unknown): void {
  const top = sheetOf(state);
  if (top === null) return;
  if (open.has(top) && staying.has(top)) { covered.add(top); underNavigation.add(top); }
  for (let id = heirs.get(top); id !== undefined && covered.has(id); id = heirs.get(id)) {
    if (open.has(id) && staying.has(id)) underNavigation.add(id);
  }
}
let pushing = false;
let stepping: Set<string> | null = null;
/**
 * Where the entries have keys (the Navigation API's, or the ones this module keeps), the key of the one the step on its
 * way lands on: the entry under the one it leaves, named as the step is asked, as it is named then. A sheet that makes
 * its entry meanwhile changes neither.
 */
let stepOnto: string | null = null;
let steppedOff = false;
/**
 * A step the browser drops lands nowhere: the wait ends by itself (LANDING_MS), so the next Back is
 * the user's again.
 */
let asked: ReturnType<typeof setTimeout> | null = null;
const LANDING_MS = 1000;
function makeWaiting(): void {
  for (const id of [...waiting]) { waiting.delete(id); if (open.has(id)) write(id); else stranded.delete(id); }
}

export function sheetSteppedOff(): boolean {
  return steppedOff;
}

/**
 * Whether the history is off the entry of what is shown for a traversal of the sheets' own: a closed
 * sheet's step off its entry on its way, or a sheet still up whose way back onto the entry a Back left
 * is on its way, or was dropped and waits for the next tap to make its entry. An address written now
 * would land on the entry under it. A way back counts only while the sheet it is for is up: one the
 * browser drops with no word (no Navigation API) holds nothing once that sheet closed.
 */
export function sheetTraversalPending(): boolean {
  return stepping !== null || (returning !== null && open.has(returning.owner)) || (climbing !== null && open.has(climbing.owner))
    || stood?.pending === true || [...stranded].some((id) => open.has(id));
}

const traversalOver = new Set<() => void>();

/**
 * Calls `listener` when a sheet made its entry and nothing is pending then: the history is on the
 * entry of what is shown with no landing to tell it. A way back that only ended (dropped, given up,
 * or its sheet closed) tells nothing: after Back past more than one entry the history may still be
 * on another pane's entry.
 */
export function onSheetTraversalOver(listener: () => void): () => void {
  traversalOver.add(listener);
  return () => { traversalOver.delete(listener); };
}

function tellTraversalOver(): void {
  if (sheetTraversalPending()) return;
  for (const listener of [...traversalOver]) listener();
}

const entriesMade = new Set<(over: string | undefined) => void>();

/**
 * Calls `listener` when the page made a history entry, whoever pushed it (a sheet, Settings, a file,
 * a move to another pane): the history is on an entry no traversal landed on, so no popstate tells of it.
 * `over` is the key of the entry it was made over, where the browser or this module tells one.
 */
export function onHistoryEntryMade(listener: (over: string | undefined) => void): () => void {
  entriesMade.add(listener);
  return () => { entriesMade.delete(listener); };
}

/** The page a sheet's item leaves for (leavePageFromSheet), loaded once no step of a closing sheet is to come or on its way. */
let departure: string | null = null;

function depart(): void {
  if (departure === null || stepping !== null || leaving.size > 0) return;
  const url = departure;
  departure = null;
  if (owned(window.history.state)) window.location.replace(url);
  else window.location.assign(url);
}

/**
 * Leaves this page for `url` from an item of a sheet that closes as it runs (RowMenu closes the sheet first): the new page
 * starts loading once the sheet's step off its entry has landed, from the entry under the sheet, so Back from it lands
 * on the page the sheet was over. Started at once, the load loses to that step whenever the new page answers later than
 * the step lands, as over a phone's network: Chromium cancels the load, and Android's WebView lands the step after the
 * new page, which brings this one back. With no sheet's entry here, nor a step on its way, it loads at once. Where the
 * entry is still a sheet's that stays up under the closed one (a terminal peek), the new page takes that entry: pushed
 * over it, Back would land on a copy of this page with nothing up, and one more Back on this page again.
 */
export function leavePageFromSheet(url: string): void {
  departure = url;
  if (!owned(window.history.state)) depart();
}

function stepBack(): void {
  const api = navigation();
  const at = api?.currentEntry;
  stepOnto = api && at ? api.entries().find((entry) => entry.index === at.index - 1)?.key ?? null : null;
  stepping = new Set();
  window.history.back();
  if (stepOnto !== null) {
    const step = stepping;
    setTimeout(() => { if (stepping === step) settleUnheardBack(); }, LANDING_MS);
  }
}

function sheetOf(state: unknown): string | null {
  if (state === null || typeof state !== "object") return null;
  const id = (state as Record<string, unknown>)[KEY];
  return typeof id === "string" ? id : null;
}

function without(state: unknown): unknown {
  if (state === null || typeof state !== "object") return state;
  const { [KEY]: _, ...rest } = state as Record<string, unknown>;
  return rest;
}

function ordinary(state: unknown, overlays: boolean): unknown {
  const rest = without(state);
  return rest !== null && typeof rest === "object" ? overCopiedEntry(rest as Record<string, unknown>, overlays) : rest;
}

function owned(state: unknown): boolean {
  const id = sheetOf(state);
  return id !== null && (open.has(id) || leaving.has(id));
}

function sheetAddress(href: string): string {
  const url = new URL(href, "https://ovis.invalid");
  // Folding the sidebar changes its presentation, not the place covered by the sheet.
  url.searchParams.delete("sidebar");
  if (shellMode() === "relay" && !url.hash.startsWith("#offer=")) {
    const fields = new URLSearchParams(url.hash.slice(1));
    if (fields.has("sidebar")) {
      fields.delete("sidebar");
      url.hash = fields.toString();
    }
  }
  return url.href;
}

export function enterSheet(onBack: () => boolean | void, reuse: string | null, stays = false, returns = false): string {
  // StrictMode's second mount, or a sheet reopened before its entry went: the same entry, or the same way onto one
  const timer = reuse === null ? undefined : leaving.get(reuse);
  if (reuse !== null && timer !== undefined && (sheetOf(window.history.state) === reuse || climbing?.owner === reuse)) {
    clearTimeout(timer);
    leaving.delete(reuse);
    open.set(reuse, onBack);
    if (stays) staying.add(reuse);
    return reuse;
  }
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  // An automatic sheet can open after the silent landing, before another tap.
  settleUnheardBack();
  open.set(id, onBack);
  if (stays) staying.add(id);
  stepping?.add(id);
  if (asked === null && (tapped || owned(window.history.state))) write(id);
  else if (returns && asked === null && stepping === null && returning === null && climbing === null && ahead !== null) climb(id, ahead);
  else waiting.add(id);
  return id;
}

function climb(id: string, key: string): void {
  ahead = null;
  climbing = { key, owner: id, state: window.history.state, href: window.location.href };
  // a traversal the browser drops leaves the sheet with no entry: the next tap makes one
  const dropped = (): void => {
    if (climbing?.owner !== id) return;
    climbing = null;
    if (open.has(id)) { waiting.add(id); stranded.add(id); }
  };
  const way = navigation()!.traverseTo(key);
  way.committed.catch(dropped);
  way.finished.catch(() => undefined);
}

function write(id: string): void {
  const base = window.history.state;
  const fields = base !== null && typeof base === "object" ? base : {};
  const state = { ...fields, [KEY]: id };
  pushing = true;
  try {
    if (owned(base)) {
      const under = sheetOf(base)!;
      const heir = open.has(under) ? under : heirs.get(under);
      if (heir !== undefined && open.has(heir)) { heirs.set(id, heir); covered.add(heir); }
      window.history.replaceState(state, "");
    }
    else {
      window.history.replaceState({ ...fields, [SHEET_UNDER_KEY]: id }, "");
      window.history.pushState({ ...state, [SHEET_UNDER_KEY]: id }, "");
    }
  } finally { pushing = false; }
  addresses.set(id, window.location.href);
  seen = id;
  keep(id);
  stranded.delete(id);
  tellTraversalOver();
}

function remake(id: string, onBack: () => boolean | void): void {
  open.set(id, onBack);
  if (!tapped) { waiting.add(id); return; }
  waiting.delete(id);
  const base = window.history.state;
  pushing = true;
  try { window.history.pushState({ ...(base !== null && typeof base === "object" ? base : {}), [KEY]: id }, ""); }
  finally { pushing = false; }
  addresses.set(id, window.location.href);
  seen = id;
  keep(id);
}

export function leaveSheet(id: string): void {
  covered.delete(id);
  underNavigation.delete(id);
  staying.delete(id);
  waiting.delete(id);
  stranded.delete(id);
  if (!open.delete(id)) return;
  leaving.set(id, setTimeout(() => {
    leaving.delete(id);
    const address = addresses.get(id);
    addresses.delete(id);
    const heir = heirs.get(id);
    heirs.delete(id);
    const key = entryKeys.get(id);
    entryKeys.delete(id);
    if (sheetOf(window.history.state) !== id) { depart(); return; }
    if (window.location.href !== address && (address === undefined || sheetAddress(window.location.href) !== sheetAddress(address))) {
      window.history.replaceState(ordinary(window.history.state, true), ""); seen = null;
    }
    else if (heir !== undefined && open.has(heir) && covered.delete(heir)) {
      window.history.replaceState({ ...(window.history.state as Record<string, unknown>), [KEY]: heir }, "");
      addresses.set(heir, window.location.href);
      if (key !== undefined) entryKeys.set(heir, key);
      seen = heir;
    } else if (stepOnto === null || !stepping?.has(id)) {
      // the traversal runs later: a sheet that opens before its popstate keeps its entry. One that opened over the
      // entry a step on its way leaves, and closed before it landed, takes none where that step's landing is told by
      // its entry: the step leaves this entry too, and a second one would land under the entry it names
      stepBack();
    }
    depart();
  }, 0));
}

if (typeof window !== "undefined") {
  const history = window.history;
  const push = history.pushState.bind(history);
  const replace = history.replaceState.bind(history);
  const counting = (): boolean => navigation() === places;
  run = placeIn(history.state)?.run ?? null;
  const pushEntry = (state: unknown, ...rest: [string, (string | URL | null)?]): void => {
    if (!counting()) return push(state, ...rest);
    let from = placeIn(history.state);
    if (from === null || from.run !== run) {
      run = token();
      counted.clear();
      from = { run, key: token(), index: 0 };
      replace(placed(history.state, from), "");
    }
    // the entries ahead go with the push
    for (const [key, index] of [...counted]) if (index > from.index) counted.delete(key);
    const next = { run: from.run, key: token(), index: from.index + 1 };
    counted.set(from.key, from.index).set(next.key, next.index);
    return push(placed(state, next), ...rest);
  };
  history.replaceState = ((state: unknown, ...rest: [string, (string | URL | null)?]) =>
    replace(counting() ? placed(state, placeIn(history.state)) : state, ...rest)) as History["replaceState"];
  history.pushState = ((state: unknown, ...rest: [string, (string | URL | null)?]) => {
    let made = false;
    try {
      if (!pushing) {
        seen = null;
        if (owned(history.state)) { cover(history.state); return history.replaceState(without(state), ...rest); }
      }
      pushEntry(pushing ? state : without(state), ...rest);
      made = true;
    } finally {
      here = where();
      ahead = null;
      stood = null;
      if (made) {
        const at = here;
        const over = at === null ? undefined : navigation()?.entries().find((entry) => entry.index === at.index - 1)?.key;
        for (const listener of [...entriesMade]) listener(over);
      }
    }
  }) as History["pushState"];
  here = where();
  // a tap the browser counts as one (a scroll, or Escape, is none)
  const onTap = (): void => {
    if (navigator.userActivation?.isActive !== true) return;
    settleUnheardBack();
    tapped = true;
    if (asked === null) makeWaiting();
  };
  if (SKIPS) for (const type of ["pointerup", "touchend", "mousedown", "keydown", "click"]) window.addEventListener(type, onTap, true);
  let heard: Event | null = null;
  sheetStep.lands = (event) => event === heard ? steppedOff : stepping !== null;
  sheetStep.taking = (event) => event === heard ? took : climbing !== null && where()?.key === climbing.key;
  sheetStep.dropped = () => {
    if (asked === null) return;
    clearTimeout(asked);
    asked = null;
    if (tapped) makeWaiting();
  };
  sheetStep.goingBack = (state) => {
    if (asked !== null) clearTimeout(asked);
    asked = setTimeout(() => {
      asked = null;
      if (tapped) makeWaiting();
    }, LANDING_MS);
    const id = sheetOf(state);
    if (id === null) return false;
    const timer = leaving.get(id);
    if (timer === undefined) return open.has(id);
    clearTimeout(timer);
    leaving.delete(id);
    addresses.delete(id);
    return true;
  };
  const hear = (event: PopStateEvent): void => {
    if (event === heard) return;
    heard = event;
    holding = false;
    let was = here;
    here = where();
    // A closed sheet's step lands on the entry it named. One that landed there unheard leaves this
    // traversal, onto another entry, the user's own, from the entry that step landed on.
    if (stepping !== null && stepOnto !== null && here !== null && here.key !== stepOnto) {
      was = navigation()?.entries().find((entry) => entry.key === stepOnto) ?? was;
      stepping = null;
      stepOnto = null;
      seen = null;
    }
    settle(here);
    ahead = null;
    took = climbing !== null && here?.key === climbing.key;
    if (climbing !== null && took) {
      const { owner, state, href } = climbing;
      climbing = null;
      steppedOff = true;
      if (open.has(owner)) {
        window.history.replaceState({ ...(state !== null && typeof state === "object" ? state : {}), [KEY]: owner }, "", href);
        addresses.set(owner, href);
        seen = owner;
        keep(owner);
      } else {
        seen = sheetOf(event.state);
        stepBack();
      }
      return;
    }
    if (stood !== null && here?.key === stood.key && (stood.pending || open.has(stood.by))) {
      stood = null;
      seen = sheetOf(event.state);
      steppedOff = true;
      holding = true;
      return;
    }
    const own = asked !== null;
    if (asked !== null) { clearTimeout(asked); asked = null; }
    if (!own && stepping === null) tapped = !SKIPS;
    const from = seen;
    seen = sheetOf(event.state);
    if (returning !== null) {
      const { entry, owner, href } = returning;
      returning = null;
      if (seen === entry) {
        steppedOff = true;
        if (!open.has(owner)) stepBack();
        else if (owner !== entry) {
          window.history.replaceState({ ...(event.state as Record<string, unknown>), [KEY]: owner }, "", href);
          addresses.set(owner, href);
          seen = owner;
          keep(owner);
        }
        return;
      }
    }
    const landed = seen;
    const step = stepping;
    stepping = null;
    steppedOff = step !== null;
    const heir = from === null ? undefined : heirs.get(from);
    const left = SKIPS && from !== null ? entryKeys.get(from) : undefined;
    const again: Array<{ id: string; onBack: () => boolean | void; under: boolean; refused: boolean }> = [];
    let refuser: string | null = null;
    for (const [id, onBack] of [...open].reverse()) {
      if (id === landed) continue;
      if (here !== null && covered.has(id) && underNavigation.has(id) && placeOf(id) >= 0 && here.index >= placeOf(id)) continue;
      open.delete(id);
      if (covered.delete(id)) again.unshift({ id, onBack, under: true, refused: false });
      else if (own || step?.has(id) || refuser !== null) again.unshift({ id, onBack, under: false, refused: false });
      else if (onBack() === false) { again.unshift({ id, onBack, under: false, refused: true }); refuser = id; }
      else { heirs.delete(id); waiting.delete(id); entryKeys.delete(id); }
    }
    if (from !== null && again.length > 0 && !own) steppedOff = true;
    const retired = landed !== null && !open.has(landed) && !leaving.has(landed);
    if (retired) { window.history.replaceState(ordinary(event.state, false), ""); seen = null; }
    const owner = own || left === undefined || from === null ? undefined
      : (again.find((kept) => kept.refused && kept.id === from) ?? again.find((kept) => kept.under && kept.id === heir))?.id;
    if (owner !== undefined && left !== undefined && from !== null) {
      for (const kept of again) { open.set(kept.id, kept.onBack); if (kept.under && kept.id !== owner) covered.add(kept.id); }
      returning = { entry: from, owner, href: window.location.href };
      // a traversal the browser drops (another one overtook it) leaves them up with no entry: the next tap makes theirs
      const dropped = (): void => {
        if (returning?.entry !== from) return;
        returning = null;
        for (const kept of again) { covered.delete(kept.id); waiting.add(kept.id); if (open.has(kept.id)) stranded.add(kept.id); }
      };
      const way = navigation()!.traverseTo(left);
      way.committed.catch(dropped);
      way.finished.catch(() => undefined);
      return;
    }
    // the user's Back or Forward off an entry that is no sheet's, which a sheet with no entry of its
    // own refused (a device's request to join, up with no tap behind it): nothing under it moves.
    // Where either entry is one with no key (a browser that tells none, an entry this module cannot
    // place) the traversal is left as it landed, and Back from the first entry leaves the app with
    // no popstate to refuse
    const onto = refuser !== null && step === null && from === null && was !== null ? { key: stood?.key ?? was.key, by: refuser, pending: true } : null;
    if (onto !== null && here !== null && here.key !== onto.key) {
      steppedOff = true;
      holding = true;
      for (const kept of again) { open.set(kept.id, kept.onBack); if (kept.under) covered.add(kept.id); }
      stood = onto;
      // a way back the browser drops (another traversal overtook it) is taken again when that one lands
      const lost = (): void => { onto.pending = false; };
      const way = navigation()!.traverseTo(onto.key);
      way.committed.catch(lost);
      way.finished.catch(() => undefined);
      setTimeout(lost, LANDING_MS);
      return;
    }
    if (!own && step === null) stood = null;
    const above = here === null ? -1 : here.index + 1;
    const top = SKIPS && !own && step === null && from === null && above > 0 && climbing === null
      ? [...again].reverse().find((kept) => kept.under && staying.has(kept.id) && placeOf(kept.id) === above) : undefined;
    const onward = top === undefined ? undefined : entryKeys.get(top.id);
    if (top !== undefined && onward !== undefined) {
      for (const kept of again) {
        if (kept.id === top.id) open.set(kept.id, kept.onBack);
        else if (kept.under && entryKeys.get(kept.id) === onward) { open.set(kept.id, kept.onBack); covered.add(kept.id); }
        else remake(kept.id, kept.onBack);
      }
      climb(top.id, onward);
      return;
    }
    for (const kept of again) remake(kept.id, kept.onBack);
    if (retired && again.length === 0) window.history.forward();
    else if (!own && step === null && was !== null && here !== null && here.index === was.index - 1) ahead = was.key;
  };
  window.addEventListener("popstate", hear);
  window.addEventListener("popstate", depart);
  sheetStep.holds = (event) => { hear(event as PopStateEvent); return holding; };
  if (sheetOf(window.history.state) !== null) window.history.replaceState(ordinary(window.history.state, true), "");
}

export function sheetHistoryEntryKey(): string | undefined {
  return navigation()?.currentEntry?.key;
}

export function useSheetHistory(active: boolean, onBack: () => boolean | void, stays = false, returns = false): void {
  const latest = useRef(onBack);
  latest.current = onBack;
  const id = useRef<string | null>(null);
  const staysRef = useRef(stays);
  staysRef.current = stays;
  const returnsRef = useRef(returns);
  returnsRef.current = returns;
  useEffect(() => {
    if (!active) return;
    const entry = enterSheet(() => latest.current(), id.current, staysRef.current, returnsRef.current);
    id.current = entry;
    return () => leaveSheet(entry);
  }, [active]);
}

export function usePhoneSheetBack(onBack: () => boolean | void, open = true, stays = false, returns = false): void {
  useSheetHistory(useMediaQuery(BACK_QUERY) && open, onBack, stays, returns);
}
