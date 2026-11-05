/**
 * A phone's bottom sheet is a history entry, so the system Back closes it instead of going to the
 * pane before (deep links make each pane its own entry). The entry keeps the address it opened on.
 * What an item of the sheet does with the history takes the sheet's entry over: a navigation it
 * pushes (another pane, Settings, a file) replaces the entry, a sheet it opens reuses it, and an
 * address it changes on the entry (the New tab dialog) keeps it. A sheet closed any other way steps
 * back off its entry once whatever it ran has written its own history. A sheet closed by Back
 * leaves its entry ahead of the app; Forward onto it goes on to the next. A sheet opened while
 * that step back is on its way (the browser runs a traversal later) is not closed by the step's
 * popstate: its entry is made again over where the step landed. So is a sheet made to stay up
 * under what opens over it (a terminal peek under the ⋯ menu or Settings), whose entry another
 * sheet or a navigation took: the traversal that leaves what covered it, a Back or that sheet's
 * own close, does not close it. Any other sheet still up under a new one closes with it, as before.
 */
import { useEffect, useRef } from "react";
import { SHEET_HISTORY_KEY, SHEET_UNDER_KEY, sheetStep } from "./historyKeys.ts";
import { SHEET_QUERY } from "./sheets.ts";
import { useMediaQuery } from "./useMediaQuery.ts";

const KEY = SHEET_HISTORY_KEY;

/** what Back does to each open sheet: false refuses it (the sheet is busy), and the sheet keeps its entry */
const open = new Map<string, () => boolean | void>();
const leaving = new Map<string, ReturnType<typeof setTimeout>>();
/** the address each sheet's entry was made on */
const addresses = new Map<string, string>();
/** the sheets that stay up under a sheet or a navigation opened over them (a terminal peek) */
const staying = new Set<string>();
/**
 * The staying sheets whose entry another sheet or a navigation took over: the next traversal
 * leaves what covered them, not them, so it makes their entry again instead of asking them to close.
 */
const covered = new Set<string>();
/** the staying sheet whose entry `state` is, when it is still up: its entry is about to be taken over */
function cover(state: unknown): void {
  const id = sheetOf(state);
  if (id !== null && open.has(id) && staying.has(id)) covered.add(id);
}
let pushing = false;
/**
 * while a closed sheet's step back is on its way: the sheets that made their entry meanwhile, which
 * its popstate leaves open. The step always lands somewhere (a sheet's entry is made over another),
 * so its popstate comes and clears this; the next step starts a set of its own.
 */
let stepping: Set<string> | null = null;
/** whether the popstate being dispatched is such a step: this module listens first, so the app's Back reads it for the same event */
let steppedOff = false;

/**
 * Whether the popstate the app is handling is a closed sheet stepping off its own entry, not a Back.
 * The entry it lands on is the one the sheet opened over, whose address may not say yet what the
 * sheet's item opened (a pane the roster does not list yet): the app stays where it is.
 */
export function sheetSteppedOff(): boolean {
  return steppedOff;
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

/** whether the entry the state names belongs to a sheet that is up, or just closed and not yet stepped off */
function owned(state: unknown): boolean {
  const id = sheetOf(state);
  return id !== null && (open.has(id) || leaving.has(id));
}

/**
 * Makes the sheet's entry (RowMenu's effect on mount; exported for its test). `stays`: the sheet
 * stays up under a sheet or a navigation opened over it, and their going comes back to it.
 */
export function enterSheet(onBack: () => boolean | void, reuse: string | null, stays = false): string {
  // StrictMode's second mount, or a sheet reopened before its entry went: the same entry
  const timer = reuse === null ? undefined : leaving.get(reuse);
  if (reuse !== null && timer !== undefined && sheetOf(window.history.state) === reuse) {
    clearTimeout(timer);
    leaving.delete(reuse);
    open.set(reuse, onBack);
    if (stays) staying.add(reuse);
    return reuse;
  }
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const base = window.history.state;
  const fields = base !== null && typeof base === "object" ? base : {};
  const state = { ...fields, [KEY]: id };
  pushing = true;
  try {
    // a sheet opened from another sheet takes that sheet's entry: one Back closes it. A staying
    // sheet still up under it is covered, and comes back once the new sheet goes
    if (owned(base)) { cover(base); window.history.replaceState(state, ""); }
    else {
      // the entry the sheet opens over is marked with it, as is the sheet's own: a navigation that
      // takes the sheet's entry over (Settings from the palette) can tell the entry it began from
      window.history.replaceState({ ...fields, [SHEET_UNDER_KEY]: id }, "");
      window.history.pushState({ ...state, [SHEET_UNDER_KEY]: id }, "");
    }
  } finally { pushing = false; }
  open.set(id, onBack);
  if (stays) staying.add(id);
  addresses.set(id, window.location.href);
  stepping?.add(id);
  return id;
}

/** Makes the sheet's entry again over the one the history is on (Back refused, or a step that was not Back for it). */
function remake(id: string, onBack: () => boolean | void): void {
  const base = window.history.state;
  pushing = true;
  try { window.history.pushState({ ...(base !== null && typeof base === "object" ? base : {}), [KEY]: id }, ""); }
  finally { pushing = false; }
  open.set(id, onBack);
  addresses.set(id, window.location.href);
}

/** Steps off the sheet's entry once the closing click's effects are through (RowMenu's effect on unmount). */
export function leaveSheet(id: string): void {
  covered.delete(id);
  staying.delete(id);
  if (!open.delete(id)) return;
  // after the closing click's commit and effects, which may write history of their own
  leaving.set(id, setTimeout(() => {
    leaving.delete(id);
    const address = addresses.get(id);
    addresses.delete(id);
    if (sheetOf(window.history.state) !== id) return;
    // an item that changed the address on the sheet's entry (the New tab dialog) keeps the entry as its own
    if (window.location.href !== address) window.history.replaceState(without(window.history.state), "");
    else {
      // the traversal runs later: a sheet that opens before its popstate keeps its entry
      stepping = new Set();
      window.history.back();
    }
  }, 0));
}

if (typeof window !== "undefined") {
  const history = window.history;
  const push = history.pushState.bind(history);
  history.pushState = ((state: unknown, ...rest: [string, (string | URL | null)?]) => {
    if (pushing) return push(state, ...rest);
    // a navigation made from a sheet (an item that opened another pane, Settings, a file) takes the
    // sheet's entry: Back from there goes to the pane before the sheet, and no entry is left between.
    // A staying sheet still up under it is covered
    if (owned(history.state)) { cover(history.state); return history.replaceState(without(state), ...rest); }
    // an entry pushed over a sheet's copies its state (the file viewer's does): only the sheet's own carries its mark
    return push(without(state), ...rest);
  }) as History["pushState"];
  /** the popstate this module last handled: one asked about before it is handled is answered by the step on its way */
  let heard: Event | null = null;
  sheetStep.lands = (event) => event === heard ? steppedOff : stepping !== null;
  sheetStep.takeLeaving = (state) => {
    const id = sheetOf(state);
    const timer = id === null ? undefined : leaving.get(id);
    // whoever takes it over goes back past every entry down to where it opened, an address the sheet's
    // item wrote on its entry included (leaveSheet would keep that entry as the item's own)
    if (id === null || timer === undefined) return false;
    clearTimeout(timer);
    leaving.delete(id);
    addresses.delete(id);
    return true;
  };
  window.addEventListener("popstate", (event) => {
    heard = event;
    const landed = sheetOf(event.state);
    // the step off a closed sheet's entry: not a Back for the sheets that opened while it was on its way
    const step = stepping;
    stepping = null;
    steppedOff = step !== null;
    // the sheets that stay: their entries are made again over where the history landed
    const again: Array<[string, () => boolean | void]> = [];
    for (const [id, onBack] of [...open]) {
      if (id === landed) continue;
      open.delete(id);
      // a sheet busy at Back refuses it and stays; one that opened during the step was never asked,
      // nor was one whose entry was taken over: the traversal left what covered it
      if (covered.delete(id) || step?.has(id) || onBack() === false) again.push([id, onBack]);
    }
    // the entry of a sheet that Back closed lies ahead of the app: Forward lands on it and goes on,
    // and the entry is an ordinary one from here
    const retired = landed !== null && !open.has(landed) && !leaving.has(landed);
    if (retired) window.history.replaceState(without(event.state), "");
    for (const [id, onBack] of again) remake(id, onBack);
    if (retired && again.length === 0) window.history.forward();
  });
  // a reload keeps the history and not the sheet: its entry is an ordinary one now
  if (sheetOf(window.history.state) !== null) window.history.replaceState(without(window.history.state), "");
}

/**
 * While `active`, the sheet holds a history entry; Back calls `onBack`, which may return false to
 * refuse (a busy sheet keeps its entry). `stays`: the sheet stays up under what opens over it.
 */
export function useSheetHistory(active: boolean, onBack: () => boolean | void, stays = false): void {
  const latest = useRef(onBack);
  latest.current = onBack;
  const id = useRef<string | null>(null);
  const staysRef = useRef(stays);
  staysRef.current = stays;
  useEffect(() => {
    if (!active) return;
    const entry = enterSheet(() => latest.current(), id.current, staysRef.current);
    id.current = entry;
    return () => leaveSheet(entry);
  }, [active]);
}

/**
 * A dialog that is a bottom sheet at phone width: there, while `open`, Back closes it (`onBack`) as
 * it does a ⋯ menu; `onBack` returning false (the dialog is busy) keeps it and its entry. A wider
 * screen keeps Back for the panes, with the dialog over them. A dialog that mounts another over
 * itself (the file list under a file) passes `open` false meanwhile, so the one on top has the entry.
 * One that stays up under whatever opens over it (a terminal peek under the ⋯ menu or Settings)
 * passes `stays`: Back, or the other's own close, then comes back to it.
 */
export function usePhoneSheetBack(onBack: () => boolean | void, open = true, stays = false): void {
  useSheetHistory(useMediaQuery(SHEET_QUERY) && open, onBack, stays);
}
