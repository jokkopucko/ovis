/**
 * Keeps the shared settings, the pins and the muted panes (shared/preferences.ts) the same in every browser of this
 * server. Loaded once the app is in (never before the access gate): what the server holds is laid
 * over this browser's settings, setting by setting; a setting nobody has shared yet stays this
 * browser's own, and opening a page writes nothing. A change here sends just what changed, once the
 * settings rest; another browser's arrives as a `preferences` event, and the server sends its whole
 * document each time the event stream opens, so a reconnected page catches up. Last write wins,
 * setting by setting: a change made here and not yet sent stays, and goes out over what arrived.
 * After three failed saves in a row, sending pauses: the change stays in this page, edits made then
 * join it, and it goes again on Retry, when the event stream reopens, or once a longer wait ends (each
 * refusal after the pause doubles it). A value the server refused, still as it was sent, gives way
 * where another browser saved the same setting (or the pins) since: sent late, it would overwrite the
 * newer value. A value changed here after the refusal is a new change, and goes out over what arrived
 * as any does. While the event stream is lost, nothing goes out on its own either: its reopening sends
 * what is unsent. A stream the browser gave up on (App opens a new one) holds back only a refused
 * change, until the new stream's opening document is read; anything else goes, so a refusal shows.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { mirrorPalette, SHARED_SETTING_KEYS, type PreferencesChange, type SharedPreferences, type SharedSettingKey } from "../../shared/preferences.ts";
import { ApiError, fetchPreferences, savePreferences } from "./api.ts";
import { DEFAULT_THEME } from "./themes.ts";
import { sanitizeSettings, sharedSettings, useSettings, type Settings } from "./settings.ts";
import { currentPaneMutes, setPaneMutes, subscribePaneMutes } from "./paneMutes.ts";
import { currentSidebarPins, loadSharedPins, saveSharedPins, setSidebarPins, subscribeSidebarPins } from "./sidebarPins.ts";
import { attachmentTabLabel, currentTabLabels, setTabLabels, subscribeTabLabels } from "./tabLabels.ts";
import { userErrorMessage, type UserError } from "./userError.ts";

const SEND_AFTER_MS = 600;
/** a request that failed on the way (the network, a restart) is tried again after this */
const RETRY_MS = 5_000;
/** failed saves in a row after which sending waits for Retry, a reopened event stream or a longer wait */
const PAUSE_AFTER = 3;
/** the first of those longer waits: a paused change goes once more on its own after it */
const PAUSED_RETRY_MS = 60_000;
/** each refusal after the pause doubles the wait, up to this */
const PAUSED_RETRY_MAX_MS = 5 * 60_000;
/**
 * Where a page that goes with a change unsent leaves it for the page that comes back in the same tab (a reload):
 * the browser may drop the request sent on the way out, and the change would be lost (#2374).
 */
const CARRIED_KEY = "ovis:preferences-unsent";
interface Carried { revision: number; settings: Shared }

function takeCarried(): Carried | null {
  try {
    const raw = window.sessionStorage.getItem(CARRIED_KEY);
    window.sessionStorage.removeItem(CARRIED_KEY);
    return raw === null ? null : JSON.parse(raw) as Carried;
  } catch {
    return null;
  }
}

function carry(carried: Carried): void {
  try { window.sessionStorage.setItem(CARRIED_KEY, JSON.stringify(carried)); } catch { /* storage blocked: the request on the way out is all there is */ }
}

/** how long a paused change waits before it goes once more, after `failures` failed saves in a row */
const pausedWait = (failures: number): number => Math.min(PAUSED_RETRY_MS * 2 ** Math.max(0, failures - PAUSE_AFTER), PAUSED_RETRY_MAX_MS);

type Shared = Partial<Record<SharedSettingKey, unknown>>;
/**
 * What this browser last knew the server to hold; `pins` is null while the server has held none,
 * `muted` while no document has carried a list (a server too old to keep one never sends it).
 */
export interface Baseline {
  settings: Shared; pins: readonly string[] | null; muted: readonly string[] | null;
  /** the tab labels the server holds (absent: none yet); null once it showed it keeps none (an older server), which is then sent none */
  tabLabels?: Readonly<Record<string, string>> | null;
}
/** What this browser holds; `muted` is null until the server's list arrived (lib/paneMutes.ts). */
export interface Local { settings: Settings; pins: readonly string[]; muted: readonly string[] | null; tabLabels?: Readonly<Record<string, string>> }



const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * What changed here since `base`: the shared settings that differ, and the pins and the muted panes
 * when they do; null when nothing did. While the server has held no pins, this browser's ride along
 * with its first change, so the pins of the browser that shares first are not lost. The muted panes
 * go out only as a change to a list the server sent: a server without one is never sent a made-up one.
 */
export function preferencesChange(base: Baseline, local: Local): PreferencesChange | null {
  const now = sharedSettings(local.settings);
  const settings = Object.fromEntries(Object.entries(now).filter(([key, value]) => !same(value, base.settings[key as SharedSettingKey])));
  const pinsChanged = base.pins !== null && !same(local.pins, base.pins);
  const mutedChanged = base.muted !== null && local.muted !== null && !same(local.muted, base.muted);
  const heldLabels = base.tabLabels ?? {};
  const labelsHere = local.tabLabels ?? {};
  // while the setting is off the server keeps none: nothing learned is sent, so nothing is refused again and again
  // a label an earlier version learned from an attachment's path is replaced by the one learned again (#2637)
  const replaced = (key: string): boolean => key in labelsHere && key in heldLabels && attachmentTabLabel(heldLabels[key]!) && labelsHere[key] !== heldLabels[key];
  const added: Record<string, string> = base.tabLabels === null || local.settings.autoTabNames === false ? {} : Object.fromEntries(Object.entries(labelsHere).filter(([key]) => !(key in heldLabels) || replaced(key)));
  const removed = base.tabLabels === null ? [] : Object.keys(heldLabels).filter((key) => !(key in labelsHere) || (key in added && replaced(key)));
  // a label dropped because its pane was seen gone is no one's action: the drop waits for a change someone made,
  // so reading or watching a page never writes the shared preferences
  const othersChanged = Object.keys(settings).length > 0 || pinsChanged || mutedChanged || Object.keys(added).length > 0;
  if (!othersChanged) return null;
  return {
    settings,
    ...(pinsChanged || base.pins === null ? { pins: [...local.pins] } : {}),
    ...(mutedChanged ? { muted_panes: [...local.muted!] } : {}),
    ...(Object.keys(added).length > 0 ? { tab_labels: added } : {}),
    ...(removed.length > 0 ? { tab_labels_removed: removed } : {}),
  };
}

export interface Taken {
  base: Baseline;
  /** the settings to set here */
  patch: Partial<Settings>;
  /** the pins to set here; null leaves them */
  pins: string[] | null;
  /** the muted panes to set here; null when the server keeps no list (no mute is offered then); undefined leaves them */
  muted: string[] | null | undefined;
  /** the tab labels to set here; null leaves them */
  tabLabels: Record<string, string> | null;
}

/**
 * What a document from the server does here. Each setting it holds replaces this browser's, except
 * one changed here since `base` and not yet sent (it goes out next and wins), and one this browser
 * cannot read (a newer release's value stays the others'). `inFlight` is the change the document
 * answers: a value the server took is no longer this browser's own, so the document's stands (a
 * document from before the change landed is held until the answer, lib/preferencesSync.ts). With
 * `force` (a watching device, which sends nothing) every value is taken. `refused` is the last change
 * the server refused (it has taken none since): a value of it this browser still holds as sent gives
 * way where the document's differs from `base`, since another browser saved that setting after the
 * change was made, and the change, sent late, would overwrite the newer value. A value changed here
 * after the refusal is not the refused one: it stays and goes out next, as any unsent edit. The
 * baseline takes the server's values either way. The first pins the server holds join this browser's:
 * nobody loses pins when a server begins sharing them; after that the last write wins. The muted
 * panes are the server's list alone (nothing is kept here to join), taken unless a change of them
 * made here is still on its way, and given way to as the pins are when that change was refused. A document without the list comes from a server that keeps none
 * (an older one, or one rolled back to it), whatever came before: the mutes stand down here, and
 * none is sent to it.
 */
export function takePreferences(base: Baseline, local: Local, remote: SharedPreferences, inFlight: PreferencesChange | null, force = false, refused: PreferencesChange | null = null): Taken {
  const settings: Shared = { ...base.settings };
  const patch: Record<string, unknown> = {};
  const incoming = { ...remote.settings };
  // Read an old document's fixed-mode appearance into its active side. System's palette
  // was unused, so it must not replace this device's migrated pair. This is passive
  // migration only: the derived side advances the baseline too, never a correcting PUT.
  if (!("darkTheme" in incoming) && !("lightTheme" in incoming) && "palette" in incoming) {
    const mode = incoming.theme ?? base.settings.theme;
    if (mode === "dark") incoming.darkTheme = incoming.palette;
    if (mode === "light") incoming.lightTheme = incoming.palette;
  }
  for (const key of SHARED_SETTING_KEYS) {
    if (!(key in incoming)) continue;
    const value = incoming[key];
    if (!same(sanitizeSettings({ [key]: value })[key], value)) continue;
    const flown = inFlight !== null && key in inFlight.settings;
    const sent = flown && same(inFlight.settings[key], local.settings[key]);
    // measured against the change on its way, as the muted panes are: a value set back while it was
    // on its way is an edit, though it matches what the server held before
    const edited = !same(local.settings[key], flown ? inFlight.settings[key] : base.settings[key]) && !sent;
    const overtaken = refused !== null && key in refused.settings && same(local.settings[key], refused.settings[key]) && !same(value, base.settings[key]);
    settings[key] = value;
    if (force || !edited || overtaken) patch[key] = value;
  }
  // Palette is a derived mirror, not an independent local edit. A legacy document with no
  // sides must not overwrite a device's migrated System pair or provoke a correcting PUT.
  settings.palette = mirrorPalette(settings.theme, settings.darkTheme ?? DEFAULT_THEME, settings.lightTheme ?? DEFAULT_THEME);
  let pins: string[] | null = null;
  if (remote.pins !== undefined) {
    if (base.pins === null && !force) pins = [...remote.pins, ...local.pins.filter((pin) => !remote.pins!.includes(pin))];
    else {
      const sent = inFlight?.pins !== undefined && same(inFlight.pins, local.pins);
      const edited = !same(local.pins, inFlight?.pins ?? base.pins) && !sent;
      const overtaken = refused?.pins !== undefined && same(local.pins, refused.pins) && !same(remote.pins, base.pins);
      if (force || !edited || overtaken) pins = [...remote.pins];
    }
  }
  let muted: string[] | null | undefined = null;
  if (remote.muted_panes !== undefined) {
    const flown = inFlight?.muted_panes;
    const sent = flown !== undefined && same(flown, local.muted);
    // an edit made while a change of the list is on its way is measured against that change: an
    // unmute made before the server's answer to the mute is still an edit, and goes out next
    const reference = flown ?? base.muted;
    const edited = local.muted !== null && reference !== null && !same(local.muted, reference) && !sent;
    const overtaken = refused?.muted_panes !== undefined && same(local.muted, refused.muted_panes) && !same(remote.muted_panes, base.muted);
    if (force || !edited || overtaken) muted = [...remote.muted_panes];
    else {
      // a change made here and not yet sent is laid over the list pane by pane: a pane another browser
      // muted or unmuted meanwhile keeps its new state, and only the panes changed here go out
      const was = reference!;
      const now = local.muted!;
      const merged = [...remote.muted_panes.filter((key) => now.includes(key) || !was.includes(key)), ...now.filter((key) => !was.includes(key) && !remote.muted_panes!.includes(key))];
      muted = same(merged, now) ? undefined : merged;
    }
  }
  // The tab labels go key by key: the server's map, with a label learned here and not yet held laid
  // over it and one dropped here and still held left out, both to go out next (the server merges each,
  // so a change on its way, or refused, is sent again as it stands). A document without them holds
  // none; a server that keeps none (base null) is left alone; a watching device takes the server's.
  let tabLabels: Record<string, string> | null = null;
  const remoteLabels = remote.tab_labels ?? {};
  if (base.tabLabels !== null) {
    const now = local.tabLabels ?? {};
    const reference = base.tabLabels ?? {};
    // the setting off (the server then holds none) leaves nothing unsent to lay over its map
    if (force || remote.settings.autoTabNames === false) tabLabels = { ...remoteLabels };
    else {
      const merged: Record<string, string> = {};
      // a label learned here again over an attachment's (#2637) stays, to replace it as preferencesChange does (#2682)
      for (const [key, label] of Object.entries(remoteLabels)) if (key in now || !(key in reference)) merged[key] = key in now && attachmentTabLabel(label) && now[key] !== label ? now[key]! : label;
      for (const [key, label] of Object.entries(now)) if (!(key in reference) && !(key in merged)) merged[key] = label;
      tabLabels = merged;
    }
  }
  return {
    base: { settings, pins: remote.pins === undefined ? base.pins : [...remote.pins], muted: remote.muted_panes === undefined ? null : [...remote.muted_panes],
      ...(base.tabLabels === null ? { tabLabels: null } : base.tabLabels === undefined && remote.tab_labels === undefined ? {} : { tabLabels: { ...remoteLabels } }) },
    patch: patch as Partial<Settings>,
    pins,
    muted,
    tabLabels,
  };
}

export interface PreferencesSync {
  /** a document the event stream brought */
  receive(preferences: SharedPreferences): void;
  /**
   * the last change the server refused to save, as a sentence for Settings (lib/userError.ts); null
   * once a save lands and nothing changed here since is still unsent. The change is sent again
   * meanwhile, until `paused`. A watching device and a server without the route are not refusals.
   */
  saveError: UserError | null;
  /** three saves failed in a row: nothing is sent until `retry`, `resubscribed` or a longer wait ends */
  paused: boolean;
  /** a Retry is waiting for its save's answer */
  retrying: boolean;
  /** the user's Retry: send what is unsent now, as it stands, and start counting failures again */
  retry(): void;
  /** the event stream opened again (App's EventSource): a paused change gets a new round */
  resubscribed(): void;
  /** the event stream was lost (App's EventSource): no save goes out on its own until `resubscribed` or `closed` */
  disconnected(): void;
  /** the browser gave up on the event stream (EventSource CLOSED, App opens a new one): a change nobody refused stops waiting for it; a refused one waits for `resubscribed` or `retry` */
  closed(): void;
}

export function usePreferencesSync(enabled: boolean): PreferencesSync {
  const { settings, update } = useSettings();
  const pins = useSyncExternalStore(subscribeSidebarPins, currentSidebarPins, currentSidebarPins);
  const muted = useSyncExternalStore(subscribePaneMutes, currentPaneMutes, currentPaneMutes);
  const tabLabels = useSyncExternalStore(subscribeTabLabels, currentTabLabels, currentTabLabels);
  const latest = useRef<Local>({ settings, pins, muted, tabLabels });
  latest.current = { settings, pins, muted, tabLabels };
  // what this browser last knew the server to hold; until a document arrives, what it holds itself
  const stored = useRef(loadSharedPins());
  const base = useRef<Baseline>({ settings: sharedSettings(settings), pins: stored.current?.pins ?? null, muted: null, tabLabels: {} });
  const revision = useRef(0);
  // a document has arrived (the GET, or the event stream's opening): sending begins then
  const loadedRef = useRef(false);
  const [loaded, setLoaded] = useState(false);
  // a server without the route: sync stands down, settings stay this browser's
  const off = useRef(false);
  // a watching device: it takes what the others share and sends nothing; a change of its own lasts until the next shared one
  const readOnly = useRef(false);
  const inFlight = useRef<PreferencesChange | null>(null);
  // the newest document that arrived while a change was on its way: whether it is older or newer
  // than that change shows once the answer, with its revision, is here
  const held = useRef<SharedPreferences | null>(null);
  // the send effect runs again when this moves: after a send, or a failed one's wait
  const [attempt, setAttempt] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saveError, setSaveError] = useState<UserError | null>(null);
  // failed save answers in a row, not renders or edits; a confirmed save starts it over
  const failures = useRef(0);
  const [paused, setPaused] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // the wait before a failed save goes again; a ref, so an answer that arrives after its effect was
  // cleaned up still sets a timer the next cleanup, a pause or unmounting cancels
  const retryTimer = useRef<number | undefined>(undefined);
  // a paused save's longer wait, which ends the pause for one more send; apart from `retryTimer`,
  // since the send effect's cleanup (it runs again as the pause begins) must not cancel it
  const pauseTimer = useRef<number | undefined>(undefined);
  // the last change the server refused (or that was lost on the way), until it takes one: a newer value
  // another browser saves meanwhile wins over a value of it still unsent here as it was (takePreferences)
  const refused = useRef<PreferencesChange | null>(null);
  // mounted and enabled: an answer that arrives after either ended is still read, but sets no wait
  const live = useRef(false);
  // the event stream is lost: the server is likely unreachable, so nothing is sent until it reopens
  const [streamLost, setStreamLost] = useState(false);
  const streamLostRef = useRef(false);
  // the browser gave up on the event stream and App's new one has not opened: no document from another
  // browser can arrive, so a refused change waits for the new stream's opening one (or Retry)
  const streamClosed = useRef(false);
  // the user's Retry goes once even while the stream is lost; the send it starts clears this, and so
  // does an answer that leaves nothing unsent (a Retry pressed while a save was on its way)
  const userRetry = useRef(false);
  // the change last sent in a request that outlives the page, so leaving does not send it twice
  const outlives = useRef<string | null>(null);
  // the baseline is a ref: a document that changes nothing here still moves what is pending
  const [, setTaken] = useState(0);
  // what the page this tab showed before went with unsent, read once
  const carried = useRef<Carried | null | undefined>(undefined);
  if (carried.current === undefined) carried.current = takeCarried();

  const absorb = useCallback((remote: SharedPreferences) => {
    if (off.current || (loadedRef.current && remote.revision <= revision.current)) return;
    // a change the page before this one sent on its way out, where the server holds nothing newer than that page
    // knew: the request may have been lost, so each value still here as it went is this page's edit and goes again
    const before = carried.current;
    carried.current = null;
    if (before && !loadedRef.current && remote.revision <= before.revision) {
      for (const [key, value] of Object.entries(before.settings)) {
        if (same(latest.current.settings[key as SharedSettingKey], value)) delete base.current.settings[key as SharedSettingKey];
      }
    }
    revision.current = Math.max(revision.current, remote.revision);
    // the page's first document from a server that started over (a fresh state folder: another folder's
    // id, or, from a server that names none, revisions that went back): the pins this browser kept
    // knowing are not its, and its own join the server's as on a first share
    const kept = stored.current;
    const startedOver = kept !== null && (remote.revision < kept.revision || (kept.stateId !== undefined && remote.state_id !== undefined && remote.state_id !== kept.stateId));
    if (!loadedRef.current && startedOver) base.current = { ...base.current, pins: null };
    const taken = takePreferences(base.current, latest.current, remote, inFlight.current, readOnly.current, refused.current);
    // the page's first document without pins comes from a server that holds none (a fresh state
    // folder): the pins this browser kept knowing are not its, and its own go with its next change
    base.current = !loadedRef.current && remote.pins === undefined ? { ...taken.base, pins: null } : taken.base;
    // the id goes with the baseline it came with: a document without one (a release that names no folder)
    // leaves none, and the next page goes by the revision, since that baseline may be another folder's
    saveSharedPins(base.current.pins === null ? null : { pins: [...base.current.pins], revision: remote.revision, ...(remote.state_id === undefined ? {} : { stateId: remote.state_id }) });
    // a second document in the same tick compares against what this one set, not the last render
    latest.current = { settings: sanitizeSettings({ ...latest.current.settings, ...taken.patch }), pins: taken.pins ?? latest.current.pins, muted: taken.muted === undefined ? latest.current.muted : taken.muted, tabLabels: taken.tabLabels ?? latest.current.tabLabels };
    if (Object.keys(taken.patch).length > 0) update(taken.patch);
    if (taken.pins !== null) setSidebarPins(taken.pins);
    if (taken.muted !== undefined) setPaneMutes(taken.muted);
    if (taken.tabLabels !== null) setTabLabels(taken.tabLabels);
    loadedRef.current = true;
    setLoaded(true);
    setTaken((count) => count + 1);
  }, [update]);

  const receive = useCallback((remote: SharedPreferences) => {
    if (inFlight.current === null) { absorb(remote); return; }
    if (held.current === null || remote.revision > held.current.revision) held.current = remote;
  }, [absorb]);

  // the change is answered or lost: what arrived meanwhile is read now (an older document is dropped by its revision)
  const settled = useCallback(() => {
    inFlight.current = null;
    const arrived = held.current;
    held.current = null;
    if (arrived !== null) absorb(arrived);
  }, [absorb]);

  useEffect(() => {
    if (!enabled || off.current || loaded) return;
    let cancelled = false;
    let retry: number | undefined;
    fetchPreferences().then((remote) => {
      if (cancelled) return;
      if (remote === null) { off.current = true; return; }
      receive(remote);
    }).catch(() => { if (!cancelled) retry = window.setTimeout(() => setLoadAttempt((count) => count + 1), RETRY_MS); });
    return () => { cancelled = true; window.clearTimeout(retry); };
  }, [enabled, loaded, loadAttempt, receive]);

  /** sending stopped for good (a watching device, a server without the route): nothing is unconfirmed */
  const standDown = useCallback(() => {
    failures.current = 0;
    refused.current = null;
    window.clearTimeout(pauseTimer.current);
    userRetry.current = false;
    setSaveError(null);
    setPaused(false);
    setRetrying(false);
  }, []);

  /** a new round of sends, for the user's Retry or a reopened event stream; one chain still, never a second */
  const resume = useCallback(() => {
    if (off.current || readOnly.current) return;
    failures.current = 0;
    window.clearTimeout(pauseTimer.current);
    setPaused(false);
    setAttempt((count) => count + 1);
  }, []);
  const retry = useCallback(() => {
    if (off.current || readOnly.current) return;
    // nothing unsent and nothing on its way: nothing is left to confirm, so nothing to wait for
    if (inFlight.current === null && preferencesChange(base.current, latest.current) === null) { standDown(); return; }
    userRetry.current = true;
    setRetrying(true);
    resume();
  }, [resume, standDown]);
  // the server's own document comes first on a (re)opened stream (server/machine-api.ts queues it
  // before answering), well within the send wait, so a paused change gives way to a newer value
  // saved elsewhere before it goes again (takePreferences' `refused`)
  const resubscribed = useCallback(() => {
    // a server that kept no labels may have been updated since: the next answer tells again
    if (base.current.tabLabels === null) base.current.tabLabels = {};
    streamLostRef.current = false;
    streamClosed.current = false;
    setStreamLost(false);
    resume();
  }, [resume]);
  const disconnected = useCallback(() => {
    streamLostRef.current = true;
    streamClosed.current = false;
    setStreamLost(true);
    window.clearTimeout(retryTimer.current);
  }, []);
  // no reopening to wait for (a proxy's 502 during a restart, a 401): a change nobody refused goes on
  // the usual wait again, so a refusal shows with its Retry; a refused one waits for App's new stream,
  // whose opening document comes before it (`resubscribed`), since it cannot learn what another
  // browser saved meanwhile until then
  const closed = useCallback(() => {
    streamLostRef.current = false;
    streamClosed.current = true;
    setStreamLost(false);
    window.clearTimeout(retryTimer.current);
  }, []);

  const change = loaded ? preferencesChange(base.current, { settings, pins, muted, tabLabels }) : null;
  const pending = change === null ? null : JSON.stringify(change);
  // what was unsent now matches the server (another browser saved the same): nothing is left to confirm
  useEffect(() => {
    if (loaded && pending === null && inFlight.current === null) standDown();
  }, [loaded, pending, standDown]);
  useEffect(() => {
    if (!enabled) return;
    live.current = true;
    return () => { live.current = false; window.clearTimeout(retryTimer.current); window.clearTimeout(pauseTimer.current); };
  }, [enabled]);
  useEffect(() => {
    if (!enabled || !loaded || off.current || readOnly.current || paused || pending === null) return;
    // a reload or a closed tab ends the send wait below with the page (#2374), and a phone may kill a hidden
    // one: what is unsent goes now, in a request that outlives the page. While a change is on its way (its
    // request may not outlive the page), what is unsent, that change's values included, goes beside it,
    // untracked: the same values, and last write wins.
    let timer: number | undefined;
    const leaving = (event: Event): void => {
      if (event.type === "visibilitychange" && document.visibilityState !== "hidden") return;
      if (inFlight.current !== null || timer === undefined) {
        // a page that is hidden and then goes sends once: what already went out to outlive it stays as it is
        if (outlives.current === pending) return;
        outlives.current = pending;
        const body = JSON.parse(pending) as PreferencesChange;
        carry({ revision: revision.current, settings: body.settings });
        savePreferences(body, true).catch(() => undefined);
        return;
      }
      window.clearTimeout(timer);
      carry({ revision: revision.current, settings: (JSON.parse(pending) as PreferencesChange).settings });
      sendNow(true);
    };
    const listen = (): (() => void) => {
      window.addEventListener("pagehide", leaving);
      document.addEventListener("visibilitychange", leaving);
      return () => { window.removeEventListener("pagehide", leaving); document.removeEventListener("visibilitychange", leaving); };
    };
    if (inFlight.current !== null) return listen();
    if ((streamLost || (streamClosed.current && refused.current !== null)) && !userRetry.current) return;
    const sendNow = (keepalive: boolean): void => {
      userRetry.current = false;
      const body = JSON.parse(pending) as PreferencesChange;
      inFlight.current = body;
      outlives.current = keepalive ? pending : null;
      savePreferences(body, keepalive).then((saved) => {
        // the server took this change: an unsent edit made meanwhile goes over what arrived, as any does
        refused.current = null;
        // An older server silently drops new names. Acknowledge exactly what was sent, not
        // today's local value: an edit made while the request was in flight still goes next.
        for (const key of SHARED_SETTING_KEYS) {
          if (key in body.settings && !(key in saved.settings)) base.current.settings[key] = body.settings[key];
        }
        // a server that answers a mute list with none keeps none: the mutes stand down here, unsent again
        if (body.muted_panes !== undefined && saved.muted_panes === undefined) { base.current.muted = null; setPaneMutes(null); }
        // a server that answers labels with none (and with the setting on) keeps none: they stay this page's, never sent again
        if (body.tab_labels !== undefined && Object.keys(body.tab_labels).length > 0 && saved.tab_labels === undefined && saved.settings.autoTabNames !== false) base.current.tabLabels = null;
        // the answer is the whole document as this change left it: one from elsewhere that landed
        // before comes with it, one that landed after was held and is read now
        absorb(saved);
        settled();
        failures.current = 0;
        setRetrying(false);
        // the status stays while a change made during the send is unconfirmed; it goes out now
        if (preferencesChange(base.current, latest.current) === null) {
          userRetry.current = false;
          setSaveError(null);
        }
        setAttempt((count) => count + 1);
      }).catch((error: unknown) => {
        // a document held while this was on its way is read before this refusal counts: an edit made
        // meanwhile is the newest here, and the refused value itself stays unless it was refused before
        settled();
        if (error instanceof ApiError && error.status === 403) {
          readOnly.current = true;
          standDown();
        } else if (error instanceof ApiError && error.status === 404) {
          off.current = true;
          standDown();
        } else if (preferencesChange(base.current, latest.current) === null) {
          // undone while it was on its way (or another browser saved the same): nothing is unconfirmed
          standDown();
        } else {
          // the same refusal every RETRY_MS is one state, not a render each time
          const next = userErrorMessage(error);
          setSaveError((before) => before !== null && before.message === next.message && before.detail === next.detail ? before : next);
          // what gives way to a newer value from elsewhere: these values, while still unsent here as sent
          refused.current = body;
          failures.current += 1;
          // a Retry pressed while this save was on its way still owes its own send: it goes now, not after the wait
          if (userRetry.current && failures.current < PAUSE_AFTER) { setAttempt((count) => count + 1); return; }
          userRetry.current = false;
          setRetrying(false);
          if (failures.current >= PAUSE_AFTER) {
            setPaused(true);
            // the pause ends for one more send after a longer wait, so a server that can write again
            // gets the change without a Retry; a lost or closed stream holds that send until it reopens
            if (live.current) pauseTimer.current = window.setTimeout(() => setPaused(false), pausedWait(failures.current));
          } else if (live.current && !streamLostRef.current && !streamClosed.current) retryTimer.current = window.setTimeout(() => setAttempt((count) => count + 1), RETRY_MS);
        }
      });
    };
    timer = window.setTimeout(() => sendNow(false), SEND_AFTER_MS);
    const unlisten = listen();
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(retryTimer.current);
      unlisten();
    };
  }, [enabled, loaded, paused, streamLost, pending, attempt, absorb, settled, standDown]);

  return { receive, saveError, paused, retrying, retry, resubscribed, disconnected, closed };
}
