import { useCallback, useEffect, useRef, useState } from "react";

import { fetchPreferences } from "./api.ts";
import { onSetupGuideRequest } from "./setupGuide.ts";
import { autoOpen, GUIDE_STORAGE_KEY, guideStep, readGuide, readSignedIn, REOPENED, saveGuide, WELCOME, type GuideEvent, type GuideState } from "./setupGuideFlow.ts";
import { SETTINGS_STORAGE_KEY } from "./themeBoot.ts";

const storage = (): Storage | null => {
  try { return window.localStorage; } catch { return null; }
};

export interface SetupGuideFacts {
  /** the app is in (past the access gate) */
  enabled: boolean;
  /** this PC's workspaces once the roster has them; null before */
  workspaces: number | null;
  /** undefined until the server's access facts and this device's role are both known; null when it sent none */
  pairingGate: "open" | "closed" | "unavailable" | null | undefined;
  watching: boolean;
}

/**
 * The setup guide's place in the app: shown by itself once on a fresh install (lib/setupGuideFlow.ts),
 * resumed where a reload left it, and opened again by Settings → Agents' Setup guide (lib/setupGuide.ts).
 * `stepAside` is told of every pane picked (lib/useSelection.ts onPick: a row, the palette, a new
 * workspace, an alert, the tab the guide opened): the guide steps aside, still mounted, for it. The
 * app's own fallback pick of a first pane is no pick, and leaves it in front.
 */
export function useSetupGuide({ enabled, workspaces, pairingGate, watching }: SetupGuideFacts) {
  // read before this page saves anything: a save made by the guide itself must not count
  const [savedSettings] = useState(() => { try { return storage()?.getItem(SETTINGS_STORAGE_KEY) != null; } catch { return true; } });
  const [record] = useState(() => { const store = storage(); return store === null ? null : readGuide(store); });
  const [guide, setGuide] = useState<GuideState | null>(() => record?.status === "open" ? record.state : null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [sharedRevision, setSharedRevision] = useState<number | null>(null);
  const decided = useRef(record !== null);
  // this tab opened the guide itself (the welcome, or Settings): its progress may replace a closed record once
  const openedHere = useRef(false);
  // the record this tab wrote last: a close that storage no longer holds is older than it
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
    if (autoOpen({ workspaces, savedSettings, sharedRevision, pairingGate, watching })) { openedHere.current = true; setGuide(WELCOME); }
  }, [enabled, workspaces, sharedRevision, pairingGate, watching, savedSettings]);

  useEffect(() => {
    const reopen = () => {
      if (watchingRef.current || !enabledRef.current) return;
      decided.current = true; openedHere.current = true; setGuide(REOPENED); setPaused(false);
    };
    // closed in another tab of this browser: closed here too, read from the event itself (storage may
    // already hold this tab's own later write)
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== GUIDE_STORAGE_KEY || event.newValue === null) return;
      if (readGuide({ getItem: () => event.newValue })?.status !== "closed") return;
      // a close that arrives after this tab opened the guide again and wrote it is the older of the two
      const store = storage();
      if (store !== null && lastWrite.current !== null && store.getItem(GUIDE_STORAGE_KEY) === lastWrite.current) return;
      decided.current = true; openedHere.current = false; setGuide(null); setPaused(false);
    };
    window.addEventListener("storage", onStorage);
    const stop = onSetupGuideRequest(reopen);
    return () => { stop(); window.removeEventListener("storage", onStorage); };
  }, []);

  useEffect(() => {
    const store = storage();
    if (guide === null || store === null) return;
    // a close made in another tab wins over progress this tab has not opened afresh since
    if (!openedHere.current && readGuide(store)?.status === "closed") { setGuide(null); setPaused(false); return; }
    openedHere.current = false;
    // what this tab wrote, not what storage holds a moment later: another tab may have written since
    lastWrite.current = saveGuide(store, guide);
  }, [guide]);


  const openRef = useRef(false);
  openRef.current = guide !== null && !watching;
  // the tabs the guide asked to show: every one asked for before the guide went away is void
  const tickets = useRef(0);
  const wasOpen = useRef(false);
  if (wasOpen.current && !openRef.current) tickets.current += 1;
  wasOpen.current = openRef.current;
  // the ref at once: a Start answer in the same update as the pick must see it (finish below)
  const stepAside = useCallback(() => { if (openRef.current) { pausedRef.current = true; setPaused(true); } }, []);

  const dispatch = useCallback((event: GuideEvent) => setGuide((current) => current === null ? null : guideStep(current, event)), []);
  const close = useCallback(() => {
    // a pane picked right after closing (Done's first workspace) finds it closed, not open
    openRef.current = false;
    tickets.current += 1;
    setGuide(null);
    setPaused(false);
    const store = storage();
    if (store !== null) saveGuide(store, null);
  }, []);
  const resume = useCallback(() => { pausedRef.current = false; setPaused(false); }, []);
  // turned into a watching device (its pairing changed): an open guide goes, without closing it for this browser
  useEffect(() => { if (watching) { setGuide(null); setPaused(false); } }, [watching]);
  // and the render that brings the role already shows none
  // the first workspace opened from the guide: the guide closes, and its pane is shown only when the
  // user stayed on the guide, not over a pane they went to while it was being made
  const finish = useCallback((select: () => void) => {
    const aside = pausedRef.current;
    close();
    if (!aside) select();
  }, [close]);
  // a tab the guide opens (an install's) is selected once the roster has it, if it is still the latest
  // asked for, Start was not pressed since, and the guide has stayed open since (tickets, above)
  const ticket = useCallback(() => {
    const mine = ++tickets.current;
    return () => tickets.current === mine && openRef.current;
  }, []);
  const voidTickets = useCallback(() => { tickets.current += 1; }, []);
  return { guide: watching ? null : guide, paused, dispatch, close, resume, stepAside, finish, ticket, voidTickets };
}

/**
 * The agents this PC is signed in to, read while the setup guide's agent list shows; the first one
 * seen turns plan usage on (`turnOn`) when it is off. `ready` (the agents set up from the list) reads
 * them afresh. Closing the guide stops it: no retry reads again, and no late answer turns usage on
 * over a choice made since in Settings.
 */
export function useSignedInUsage(ready: readonly string[], read: (refresh: boolean) => Promise<readonly string[]>, showing: boolean, turnOn: () => void): readonly string[] {
  const [signedIn, setSignedIn] = useState<readonly string[]>([]);
  const shown = useRef(showing);
  shown.current = showing;
  const readyKey = ready.join(",");
  useEffect(() => readSignedIn(
    // an agent signed in just now: read the accounts afresh, not what the server last saw
    () => read(readyKey !== ""),
    (agents) => {
      setSignedIn(agents);
      if (agents.length > 0 && !shown.current) { shown.current = true; turnOn(); }
    },
    (run, ms) => { const timer = window.setTimeout(run, ms); return () => window.clearTimeout(timer); },
  ), [readyKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return signedIn;
}
