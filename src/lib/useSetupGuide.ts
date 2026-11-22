import { useCallback, useEffect, useRef, useState } from "react";

import { fetchDevices, fetchPreferences } from "./api.ts";
import { onSetupGuideRequest } from "./setupGuide.ts";
import { autoOpen, otherDevice, GUIDE_STORAGE_KEY, guideStep, readGuide, readSignedIn, REOPENED, saveGuide, FIRST_RUN, type GuideEvent, type GuideState } from "./setupGuideFlow.ts";
import { SETTINGS_STORAGE_KEY } from "./themeBoot.ts";
import { setupRowOn, USAGE_ARMED_KEY } from "./firstHints.ts";

const storage = (): Storage | null => {
  try { return window.localStorage; } catch { return null; }
};

export interface SetupGuideFacts {
  showUsage?: boolean;
  enabled: boolean;
  workspaces: number | null;
  pairingGate: "open" | "closed" | "unavailable" | null | undefined;
  watching: boolean;
}

export function useSetupGuide({ enabled, workspaces, pairingGate, watching, showUsage = false }: SetupGuideFacts) {
  const usageWas = useRef(showUsage);
  useEffect(() => {
    try {
      const store = storage();
      if (usageWas.current && !showUsage) store?.removeItem(USAGE_ARMED_KEY);
      else if (showUsage && store?.getItem(USAGE_ARMED_KEY) === "1") store.setItem(USAGE_ARMED_KEY, "on");
    } catch { }
    usageWas.current = showUsage;
  }, [showUsage]);
  const [savedSettings] = useState(() => { try { return storage()?.getItem(SETTINGS_STORAGE_KEY) != null; } catch { return true; } });
  const [record] = useState(() => { const store = storage(); return store === null ? null : readGuide(store); });
  const [guide, setGuide] = useState<GuideState | null>(() => record?.status === "open" ? record.state : null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [sharedRevision, setSharedRevision] = useState<number | null>(null);
  const decided = useRef(record !== null);
  const [settled, setSettled] = useState(record !== null || savedSettings);
  const openedHere = useRef(false);
  const lastWrite = useRef<string | null>(null);
  // a watching device sets nothing up: no guide is restored, reopened or kept for it (the server refuses
  // its installs and workspaces anyway, as #2330's Settings hides Install for it)
  const watchingRef = useRef(watching);
  watchingRef.current = watching;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled || decided.current) return;
    // no answer, or a server without shared settings, is not proof of a fresh install
    fetchPreferences().then((preferences) => setSharedRevision(preferences?.revision ?? -1), () => setSharedRevision(-1));
  }, [enabled]);

  useEffect(() => {
    if (decided.current || !enabled || pairingGate === undefined) return;
    if (workspaces === null || sharedRevision === null) return;
    decided.current = true;
    setSettled(true);
    if (autoOpen({ workspaces, savedSettings, sharedRevision, pairingGate, watching })) { openedHere.current = true; setGuide(FIRST_RUN); }
  }, [enabled, workspaces, sharedRevision, pairingGate, watching, savedSettings]);

  useEffect(() => {
    const reopen = (at: GuideState["at"]) => {
      if (watchingRef.current || !enabledRef.current) return;
      decided.current = true; setSettled(true); openedHere.current = true; setGuide(at === undefined ? REOPENED : { ...REOPENED, at }); setPaused(false);
    };
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== GUIDE_STORAGE_KEY || event.newValue === null) return;
      if (readGuide({ getItem: () => event.newValue })?.status !== "closed") return;
      const store = storage();
      if (store !== null && lastWrite.current !== null && store.getItem(GUIDE_STORAGE_KEY) === lastWrite.current) return;
      decided.current = true; setSettled(true); openedHere.current = false; setGuide(null); setPaused(false);
    };
    window.addEventListener("storage", onStorage);
    const stop = onSetupGuideRequest(reopen);
    return () => { stop(); window.removeEventListener("storage", onStorage); };
  }, []);

  useEffect(() => {
    const store = storage();
    if (guide === null || store === null) return;
    if (!openedHere.current && readGuide(store)?.status === "closed") { setGuide(null); setPaused(false); return; }
    openedHere.current = false;
    lastWrite.current = saveGuide(store, guide);
  }, [guide]);

  const openRef = useRef(false);
  openRef.current = guide !== null && !watching;
  const tickets = useRef(0);
  const wasOpen = useRef(false);
  if (wasOpen.current && !openRef.current) tickets.current += 1;
  wasOpen.current = openRef.current;
  const stepAside = useCallback(() => { if (openRef.current) { pausedRef.current = true; setPaused(true); } }, []);

  const dispatch = useCallback((event: GuideEvent) => setGuide((current) => current === null ? null : guideStep(current, event)), []);
  const guideRef = useRef(guide);
  guideRef.current = guide;
  const close = useCallback(() => {
    openRef.current = false;
    const begun = guideRef.current?.step === "setup";
    tickets.current += 1;
    setGuide(null);
    setPaused(false);
    const store = storage();
    if (store !== null) { saveGuide(store, null); if (begun) setupRowOn(store); }
  }, []);
  const resume = useCallback(() => { pausedRef.current = false; setPaused(false); }, []);
  // turned into a watching device (its pairing changed): an open guide goes, without closing it for this browser
  useEffect(() => { if (watching) { setGuide(null); setPaused(false); } }, [watching]);
  const finish = useCallback((select: () => void) => {
    const aside = pausedRef.current;
    close();
    if (!aside) select();
  }, [close]);
  const ticket = useCallback(() => {
    const mine = ++tickets.current;
    return () => tickets.current === mine && openRef.current;
  }, []);
  const voidTickets = useCallback(() => { tickets.current += 1; }, []);
  return { guide: watching ? null : guide, settled: settled || watching, paused, dispatch, close, resume, stepAside, finish, ticket, voidTickets };
}

/**
 * Closing the guide stops it: no retry reads again, and no late answer turns usage on
 * over a choice made since in Settings.
 */
export function useSignedInUsage(ready: readonly string[], read: (refresh: boolean) => Promise<readonly string[]>, showing: boolean, turnOn: () => void, enabled = true): readonly string[] | null {
  const [signedIn, setSignedIn] = useState<readonly string[] | null>(null);
  const shown = useRef(showing);
  shown.current = showing;
  const readyKey = ready.join(",");
  // nothing is read, nor turned on, until the caller says so (the guide: after the user's own press on the agent step)
  useEffect(() => !enabled ? undefined : readSignedIn(
    () => read(readyKey !== ""),
    (agents) => {
      setSignedIn(agents);
      if (agents.length > 0 && !shown.current) { shown.current = true; turnOn(); }
    },
    (run, ms) => { const timer = window.setTimeout(run, ms); return () => window.clearTimeout(timer); },
  ), [readyKey, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return signedIn;
}

/**
 * A device paired here other than this browser (otherDevice), read from the server while `enabled`, and again when
 * `again` changes; null until it answers, and when it cannot (a watching device, an older server).
 */
export function useOtherDevice(enabled: boolean, again?: unknown): string | null;
export function useOtherDevice(enabled: boolean, again: unknown, pending: true): string | null | undefined;
export function useOtherDevice(enabled: boolean, again?: unknown, pending = false): string | null | undefined {
  const [name, setName] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetchDevices().then((devices) => { if (live) setName(otherDevice(devices)); }, () => { if (live) setName((known) => known ?? null); });
    return () => { live = false; };
  }, [enabled, again]);
  return pending ? name : name ?? null;
}
