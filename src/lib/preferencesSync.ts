/**
 * Loaded once the app is in (never before the access gate): what the server holds is laid
 * over this browser's settings, setting by setting; a setting nobody has shared yet stays this
 * browser's own, and opening a page writes nothing.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { mirrorPalette, SHARED_SETTING_KEYS, type PreferencesChange, type PreferencesPut, type SharedPreferences, type SharedSettingKey } from "../../shared/preferences.ts";
import { ApiError, fetchPreferences, PreferencesConflictError, savePreferences } from "./api.ts";
import { rebasePreferenceList } from "./preferencesList.ts";
import { DEFAULT_THEME } from "./themes.ts";
import { sanitizeSettings, sharedSettings, useSettings, type Settings } from "./settings.ts";
import { currentPaneMutes, setPaneMutes, subscribePaneMutes } from "./paneMutes.ts";
import { currentSidebarPins, loadSharedPins, saveSharedPins, setSidebarPins, subscribeSidebarPins } from "./sidebarPins.ts";
import { attachmentTabLabel, currentTabLabels, setTabLabels, subscribeTabLabels } from "./tabLabels.ts";
import { userErrorMessage, type UserError } from "./userError.ts";

const SEND_AFTER_MS = 600;
const RETRY_MS = 5_000;
const PAUSE_AFTER = 3;
const MAX_CONFLICT_RETRIES = 3;
const PAUSED_RETRY_MS = 60_000;
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
  try { window.sessionStorage.setItem(CARRIED_KEY, JSON.stringify(carried)); } catch {}
}

const pausedWait = (failures: number): number => Math.min(PAUSED_RETRY_MS * 2 ** Math.max(0, failures - PAUSE_AFTER), PAUSED_RETRY_MAX_MS);

function withExpectedRevision(change: PreferencesChange, revision: number): PreferencesPut {
  return change.pins !== undefined || change.muted_panes !== undefined || Object.values(change.settings).some(Array.isArray)
    ? { ...change, expected_revision: revision }
    : change;
}

type Shared = Partial<Record<SharedSettingKey, unknown>>;
export interface Baseline {
  settings: Shared; pins: readonly string[] | null; muted: readonly string[] | null;
  tabLabels?: Readonly<Record<string, string>> | null;
}
export interface Local { settings: Settings; pins: readonly string[]; muted: readonly string[] | null; tabLabels?: Readonly<Record<string, string>> }



const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function preferencesChange(base: Baseline, local: Local): PreferencesChange | null {
  const now = sharedSettings(local.settings);
  const settings = Object.fromEntries(Object.entries(now).filter(([key, value]) => !same(value, base.settings[key as SharedSettingKey])));
  const pinsChanged = base.pins !== null && !same(local.pins, base.pins);
  const mutedChanged = base.muted !== null && local.muted !== null && !same(local.muted, base.muted);
  const heldLabels = base.tabLabels ?? {};
  const labelsHere = local.tabLabels ?? {};
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
  patch: Partial<Settings>;
  pins: string[] | null;
  muted: string[] | null | undefined;
  tabLabels: Record<string, string> | null;
}

/**
 * With `force` (a watching device, which sends nothing) every value is taken. `refused` is the last change
 * the server refused (it has taken none since): a value of it this browser still holds as sent gives
 * way where the document's differs from `base`, since another browser saved that setting after the
 * change was made, and the change, sent late, would overwrite the newer value.
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
    const reference = flown ? inFlight.settings[key] : base.settings[key];
    const mine = local.settings[key];
    const edited = !same(mine, reference) && !sent;
    const overtaken = refused !== null && key in refused.settings && same(local.settings[key], refused.settings[key]) && !same(value, base.settings[key]);
    settings[key] = value;
    if (force || !edited || overtaken) patch[key] = value;
    else if (Array.isArray(reference) && Array.isArray(mine) && Array.isArray(value)) {
      const merged = rebasePreferenceList(reference, mine, value);
      if (!same(merged, mine)) patch[key] = merged;
    }
  }
  // Palette is a derived mirror, not an independent local edit. A legacy document with no
  // sides must not overwrite a device's migrated System pair or provoke a correcting PUT.
  settings.palette = mirrorPalette(settings.theme, settings.darkTheme ?? DEFAULT_THEME, settings.lightTheme ?? DEFAULT_THEME);
  let pins: string[] | null = null;
  if (remote.pins !== undefined) {
    if (base.pins === null && !force) pins = [...remote.pins, ...local.pins.filter((pin) => !remote.pins!.includes(pin))];
    else {
      const sent = inFlight?.pins !== undefined && same(inFlight.pins, local.pins);
      const reference = inFlight?.pins ?? base.pins;
      const edited = !same(local.pins, reference) && !sent;
      const overtaken = refused?.pins !== undefined && same(local.pins, refused.pins) && !same(remote.pins, base.pins);
      if (force || !edited || overtaken) pins = [...remote.pins];
      else if (reference !== null) {
        const merged = rebasePreferenceList(reference, local.pins, remote.pins);
        if (!same(merged, local.pins)) pins = merged;
      }
    }
  }
  let muted: string[] | null | undefined = null;
  if (remote.muted_panes !== undefined) {
    const flown = inFlight?.muted_panes;
    const mine = local.muted;
    const sent = flown !== undefined && same(flown, mine);
    const reference = flown ?? base.muted;
    const edited = mine !== null && reference !== null && !same(mine, reference) && !sent;
    const overtaken = refused?.muted_panes !== undefined && same(mine, refused.muted_panes) && !same(remote.muted_panes, base.muted);
    if (force || !edited || overtaken) muted = [...remote.muted_panes];
    else {
      const merged = rebasePreferenceList(reference, mine, remote.muted_panes);
      muted = same(merged, mine) ? undefined : merged;
    }
  }
  let tabLabels: Record<string, string> | null = null;
  const remoteLabels = remote.tab_labels ?? {};
  if (base.tabLabels !== null) {
    const now = local.tabLabels ?? {};
    const reference = base.tabLabels ?? {};
    if (force || remote.settings.autoTabNames === false) tabLabels = { ...remoteLabels };
    else {
      const merged: Record<string, string> = {};
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
  receive(preferences: SharedPreferences): void;
  saveError: UserError | null;
  paused: boolean;
  retrying: boolean;
  retry(): void;
  resubscribed(): void;
  disconnected(): void;
  /** the browser gave up on the event stream (EventSource CLOSED, App opens a new one): a change nobody refused stops waiting for it; a refused one waits for `resubscribed` or `retry` */
  closed(): void;
  /** the server's shared settings were read once, or the server has none: until then a shared setting here may be stale */
  known: boolean;
}

export function usePreferencesSync(enabled: boolean): PreferencesSync {
  const { own, watch, update } = useSettings();
  const pins = useSyncExternalStore(subscribeSidebarPins, currentSidebarPins, currentSidebarPins);
  const muted = useSyncExternalStore(subscribePaneMutes, currentPaneMutes, currentPaneMutes);
  const tabLabels = useSyncExternalStore(subscribeTabLabels, currentTabLabels, currentTabLabels);
  // What this tab holds now, a change React has not drawn yet included: the provider's settings and the stores all
  // change at once. Everything that happens outside a render (a document, a save's answer or failure, Retry) is
  // judged against this, in the order it happened, so no result depends on when React renders.
  const here = useCallback((): Local => ({ settings: own(), pins: currentSidebarPins(), muted: currentPaneMutes(), tabLabels: currentTabLabels() }), [own]);
  const stored = useRef(loadSharedPins());
  const base = useRef<Baseline>({ settings: sharedSettings(own()), pins: stored.current?.pins ?? null, muted: null, tabLabels: {} });
  const revision = useRef(0);
  const loadedRef = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [none, setNone] = useState(false);
  const off = useRef(false);
  // a watching device: it takes what the others share and sends nothing; a change of its own lasts until the next shared one
  const readOnly = useRef(false);
  const inFlight = useRef<PreferencesChange | null>(null);
  const held = useRef<SharedPreferences | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saveError, setSaveError] = useState<UserError | null>(null);
  const failures = useRef(0);
  const conflicts = useRef(0);
  const [paused, setPaused] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const retryTimer = useRef<number | undefined>(undefined);
  // a paused save's longer wait, which ends the pause for one more send; apart from `retryTimer`,
  // since the send effect's cleanup (it runs again as the pause begins) must not cancel it
  const pauseTimer = useRef<number | undefined>(undefined);
  const refused = useRef<PreferencesChange | null>(null);
  const live = useRef(false);
  const [streamLost, setStreamLost] = useState(false);
  const streamLostRef = useRef(false);
  const streamClosed = useRef(false);
  const userRetry = useRef(false);
  const outlives = useRef<string | null>(null);
  const [, setTaken] = useState(0);
  const carried = useRef<Carried | null | undefined>(undefined);
  if (carried.current === undefined) carried.current = takeCarried();

  const standDown = useCallback(() => {
    failures.current = 0;
    conflicts.current = 0;
    refused.current = null;
    window.clearTimeout(pauseTimer.current);
    userRetry.current = false;
    setSaveError(null);
    setPaused(false);
    setRetrying(false);
  }, []);
  // Nothing unsent ends what a refusal left behind, the wait for its retry included: the next render sets up the wait
  // an edit made after this needs. False while something is unsent.
  const rest = useCallback((): boolean => {
    if (preferencesChange(base.current, here()) !== null) return false;
    standDown();
    setAttempt((count) => count + 1);
    return true;
  }, [here, standDown]);
  // Looked at as each edit and document lands, not only at the next render: an edit that comes back before that
  // render is then a new one, as it is once drawn.
  const quiet = useCallback(() => {
    if (loadedRef.current && inFlight.current === null) rest();
  }, [rest]);
  useEffect(() => {
    const stops = [watch(quiet), subscribeSidebarPins(quiet), subscribePaneMutes(quiet), subscribeTabLabels(quiet)];
    return () => { for (const stop of stops) stop(); };
  }, [watch, quiet]);

  // Gone with the tree (the crash screen replaces it in a live page). A save can still be answered after that: its
  // document sets no setting here then, or this tab's old view would be stored over what another tab stored since.
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    return () => { gone.current = true; };
  }, []);

  const absorb = useCallback((remote: SharedPreferences, restart = false) => {
    if (off.current || (!restart && loadedRef.current && remote.revision <= revision.current)) return;
    const local = here();
    const before = carried.current;
    carried.current = null;
    // a change the page before this one sent on its way out, where the server holds nothing newer than that page
    // knew: the request may have been lost, so each value still here as it went is this page's edit and goes again
    if (before && !loadedRef.current && remote.revision <= before.revision) {
      for (const [key, value] of Object.entries(before.settings)) {
        if (same(local.settings[key as SharedSettingKey], value)) delete base.current.settings[key as SharedSettingKey];
      }
    }
    revision.current = remote.revision;
    const kept = stored.current;
    const startedOver = kept !== null && (remote.revision < kept.revision || (kept.stateId !== undefined && remote.state_id !== undefined && remote.state_id !== kept.stateId));
    if (!loadedRef.current && startedOver) base.current = { ...base.current, pins: null };
    const taken = takePreferences(base.current, local, remote, inFlight.current, readOnly.current, refused.current);
    base.current = !loadedRef.current && remote.pins === undefined ? { ...taken.base, pins: null } : taken.base;
    saveSharedPins(base.current.pins === null ? null : { pins: [...base.current.pins], revision: remote.revision, ...(remote.state_id === undefined ? {} : { stateId: remote.state_id }) });
    // Taken at once, as the stores below are: the next document, answer or edit is judged against it before React draws it.
    // Each of the four tells `quiet` as it lands. A list not in yet is still this tab's old one, which differs from the
    // new baseline wherever the one taken will, so what is unsent reads as nothing before the last is in only if it is nothing after.
    if (Object.keys(taken.patch).length > 0 && !gone.current) update(taken.patch);
    if (taken.pins !== null) setSidebarPins(taken.pins);
    if (taken.muted !== undefined) setPaneMutes(taken.muted);
    if (taken.tabLabels !== null) setTabLabels(taken.tabLabels);
    loadedRef.current = true;
    setLoaded(true);
    setTaken((count) => count + 1);
    quiet();
  }, [here, quiet, update]);

  const receive = useCallback((remote: SharedPreferences) => {
    if (inFlight.current === null) { absorb(remote); return; }
    if (held.current === null || remote.revision > held.current.revision) held.current = remote;
  }, [absorb]);

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
      if (remote === null) { off.current = true; setNone(true); return; }
      receive(remote);
    }).catch(() => { if (!cancelled) retry = window.setTimeout(() => setLoadAttempt((count) => count + 1), RETRY_MS); });
    return () => { cancelled = true; window.clearTimeout(retry); };
  }, [enabled, loaded, loadAttempt, receive]);

  const resume = useCallback(() => {
    if (off.current || readOnly.current) return;
    failures.current = 0;
    conflicts.current = 0;
    window.clearTimeout(pauseTimer.current);
    setPaused(false);
    setAttempt((count) => count + 1);
  }, []);
  const retry = useCallback(() => {
    if (off.current || readOnly.current) return;
    if (inFlight.current === null && preferencesChange(base.current, here()) === null) { standDown(); return; }
    userRetry.current = true;
    setRetrying(true);
    resume();
  }, [here, resume, standDown]);
  const resubscribed = useCallback(() => {
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
  const closed = useCallback(() => {
    streamLostRef.current = false;
    streamClosed.current = true;
    setStreamLost(false);
    window.clearTimeout(retryTimer.current);
  }, []);

  // against this tab's settings as of now, not the ones this render draws: the baseline beside them is as of now too
  const change = loaded ? preferencesChange(base.current, { settings: own(), pins, muted, tabLabels }) : null;
  const pending = change === null ? null : JSON.stringify(change);
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
    // request may not outlive the page), what is unsent goes beside it without a precondition:
    // the first write can have advanced the revision while its answer is still on the way.
    let timer: number | undefined;
    const leaving = (event: Event): void => {
      if (event.type === "visibilitychange" && document.visibilityState !== "hidden") return;
      // what is unsent as the page goes: `pending` is as of the render that set this up, and an edit since may not be drawn
      const unsent = preferencesChange(base.current, here());
      if (unsent === null) return;
      if (inFlight.current !== null || timer === undefined) {
        const going = JSON.stringify(unsent);
        if (outlives.current === going) return;
        outlives.current = going;
        carry({ revision: revision.current, settings: unsent.settings });
        const body = inFlight.current === null ? withExpectedRevision(unsent, revision.current) : unsent;
        savePreferences(body, true).catch(() => undefined);
        return;
      }
      window.clearTimeout(timer);
      carry({ revision: revision.current, settings: unsent.settings });
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
      // what is unsent when it goes, not when this wait began: a document or an edit since then counts, drawn or not
      const body = preferencesChange(base.current, here());
      if (body === null) return;
      const manual = userRetry.current;
      userRetry.current = false;
      inFlight.current = body;
      outlives.current = keepalive ? JSON.stringify(body) : null;
      savePreferences(withExpectedRevision(body, revision.current), keepalive).then((saved) => {
        refused.current = null;
        // An older server silently drops new names. Acknowledge exactly what was sent, not
        // today's local value: an edit made while the request was in flight still goes next.
        for (const key of SHARED_SETTING_KEYS) {
          if (key in body.settings && !(key in saved.settings)) base.current.settings[key] = body.settings[key];
        }
        if (body.muted_panes !== undefined && saved.muted_panes === undefined) { base.current.muted = null; setPaneMutes(null); }
        if (body.tab_labels !== undefined && Object.keys(body.tab_labels).length > 0 && saved.tab_labels === undefined && saved.settings.autoTabNames !== false) base.current.tabLabels = null;
        absorb(saved);
        settled();
        failures.current = 0;
        conflicts.current = 0;
        setRetrying(false);
        if (preferencesChange(base.current, here()) === null) {
          userRetry.current = false;
          setSaveError(null);
        }
        setAttempt((count) => count + 1);
      }).catch((error: unknown) => {
        if (error instanceof PreferencesConflictError) {
          const arrived = held.current;
          held.current = null;
          inFlight.current = null;
          if (!live.current) return;
          refused.current = null;
          const restart = error.current.revision < revision.current;
          // A conflict did not accept our write. Rebase against the old baseline, not the sent list.
          absorb(!restart && arrived !== null && arrived.revision > error.current.revision ? arrived : error.current, restart);
          if (rest()) return;
          if (++conflicts.current <= MAX_CONFLICT_RETRIES) {
            userRetry.current ||= manual;
            setAttempt((count) => count + 1);
          } else {
            userRetry.current = false;
            setSaveError(userErrorMessage(error));
            setRetrying(false);
            setPaused(true);
            const pausedFailures = PAUSE_AFTER + conflicts.current - MAX_CONFLICT_RETRIES - 1;
            pauseTimer.current = window.setTimeout(() => setPaused(false), pausedWait(pausedFailures));
          }
          return;
        }
        const status = error instanceof ApiError ? error.status : null;
        // before a document held behind this save is read: a device that cannot write takes it whole, and a
        // refused value gives way to a newer one saved elsewhere
        if (status === 403) readOnly.current = true;
        else if (status !== 404) refused.current = body;
        settled();
        if (status === 403) {
          standDown();
        } else if (status === 404) {
          off.current = true;
          standDown();
        } else if (!rest()) {
          const next = userErrorMessage(error);
          setSaveError((before) => before !== null && before.message === next.message && before.detail === next.detail ? before : next);
          failures.current += 1;
          if (userRetry.current && failures.current < PAUSE_AFTER) { setAttempt((count) => count + 1); return; }
          userRetry.current = false;
          setRetrying(false);
          if (failures.current >= PAUSE_AFTER) {
            setPaused(true);
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
  }, [enabled, loaded, paused, streamLost, pending, attempt, absorb, settled, standDown, here, rest]);

  return { receive, saveError, paused, retrying, retry, resubscribed, disconnected, closed, known: loaded || none };
}
