import { useCallback, useEffect, useRef, useState } from "react";

import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { WEB_PANEL_KEY as HISTORY_KEY, WEB_PANEL_DOCKED_KEY as DOCKED_KEY, withoutWebPanel } from "./historyKeys.ts";
import { backUnderCurrentEntry } from "./historyNavigation.ts";
import { outsideSettings, settingsEntry } from "./settingsHistory.ts";
import { panelUrl, wantsPanel } from "./webPanel.ts";
import type { Settings } from "./settings.ts";

function webPanelFromState(state: unknown): string | null {
  if (state === null || typeof state !== "object") return null;
  const entry = (state as Record<string, unknown>)[HISTORY_KEY];
  if (entry === null || typeof entry !== "object") return null;
  const url = (entry as Record<string, unknown>).url;
  return typeof url === "string" ? panelUrl(url, window.location) : null;
}

function isDocked(state: unknown): boolean {
  return outsideSettings(state)[DOCKED_KEY] === true;
}

/** The current entry as the web panel's: a popup entry on narrow windows, a docked mark on wide ones. */
function panelState(state: unknown, url: string | null): Record<string, unknown> {
  return { ...withoutWebPanel(outsideSettings(state)), ...(url === null ? { [DOCKED_KEY]: true } : { [HISTORY_KEY]: { url } }) };
}

/**
 * The host-checked in-app web page. The page and a docked file share one panel slot and at most one
 * history entry: the narrow popup always owns one, the docked panel only one it took over (from its
 * own popup on widening, or from the file it replaced). Taking over an entry replaces it, so a swap
 * never pushes over the other panel's entry or waits on a Back; closing consumes the entry it owns.
 */
export function useWebPanel({ settings, filePanelAvailable }: { settings: Settings; filePanelAvailable: boolean }) {
  const [webPage, setWebPage] = useState<string | null>(() => webPanelFromState(window.history.state));
  // whether the current entry (outside Settings) is the panel's
  const ownsEntry = useRef(webPanelFromState(window.history.state) !== null);
  const closingWebPage = useRef(false);
  const current = useRef({ webPage, filePanelAvailable });
  current.current = { webPage, filePanelAvailable };

  useEffect(() => {
    const state = window.history.state;
    if (settingsEntry(state) !== null) return;
    if (filePanelAvailable) {
      if (webPanelFromState(state) !== null) window.history.replaceState(panelState(state, null), "");
    } else if (webPage !== null && webPanelFromState(state) === null) {
      if (isDocked(state)) window.history.replaceState(panelState(state, webPage), "");
      // a popup file pushed over the page's entry: Back off the file lands there and shows the popup
      else if (!ownsEntry.current) window.history.pushState(panelState(state, webPage), "");
      ownsEntry.current = true;
    }
  }, [filePanelAvailable, webPage]);

  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      closingWebPage.current = false;
      const next = webPanelFromState(event.state);
      const docked = isDocked(event.state);
      const inSettings = settingsEntry(event.state) !== null;
      const { webPage: page, filePanelAvailable: wide } = current.current;
      if (next !== null || (docked && page !== null)) {
        // its own entry again (Back from a panel above it, Forward to it): shown as this width wants
        if (!inSettings && wide !== (next === null)) window.history.replaceState(panelState(event.state, wide ? null : page), "");
        ownsEntry.current = true;
        if (next !== null) setWebPage(next);
      } else if (ownsEntry.current && !inSettings) {
        // Back off the panel's entry closes it, docked or not
        ownsEntry.current = false;
        setWebPage(null);
      } else if (!wide && page !== null && !inSettings) {
        window.history.pushState(panelState(event.state, page), "");
        ownsEntry.current = true;
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /** `takeOver` hands the panel the entry of the docked file it replaces; the caller releases the file first. */
  const openWebPage = useCallback((uri: string, shiftKey: boolean, machineId: string, takeOver?: () => void) => {
    if (machineId !== LOCAL_MACHINE || !wantsPanel(settings.webLinks, shiftKey)) return false;
    const url = panelUrl(uri, window.location);
    if (url === null) return false;
    takeOver?.();
    const state = window.history.state;
    const owned = takeOver !== undefined || (ownsEntry.current && (webPanelFromState(state) !== null || isDocked(state)));
    if (owned) window.history.replaceState(panelState(state, filePanelAvailable ? null : url), "");
    else if (!filePanelAvailable) window.history.pushState(panelState(state, url), "");
    // a docked page swapped under a popup file keeps the entry below it
    ownsEntry.current = owned || !filePanelAvailable || ownsEntry.current;
    closingWebPage.current = false;
    setWebPage(url);
    return true;
  }, [settings.webLinks, filePanelAvailable]);

  /** Hands the panel's entry to a docked file that replaces it: true when the file should replace the entry. */
  const yieldEntry = useCallback(() => {
    const state = window.history.state;
    const owned = ownsEntry.current && settingsEntry(state) === null && (webPanelFromState(state) !== null || isDocked(state));
    ownsEntry.current = false;
    return owned;
  }, []);

  /** Whether the panel owns the current entry, or the one under a popup file pushed over it. */
  const holdsEntry = useCallback(() => ownsEntry.current, []);

  const closeWebPage = useCallback((replaced = false) => {
    if (closingWebPage.current) return;
    if (replaced === true) {
      // another panel took the slot: drop any marks left without a traversal
      const state = window.history.state;
      if (settingsEntry(state) === null && (webPanelFromState(state) !== null || isDocked(state))) window.history.replaceState(withoutWebPanel(outsideSettings(state)), "");
      ownsEntry.current = false;
      setWebPage(null);
      return;
    }
    const state = window.history.state;
    if (webPanelFromState(state) !== null || (ownsEntry.current && isDocked(state))) {
      closingWebPage.current = true;
      if (isDocked(state)) setWebPage(null);
      backUnderCurrentEntry()?.catch(() => { closingWebPage.current = false; });
    } else {
      ownsEntry.current = false;
      setWebPage(null);
    }
  }, []);

  return { webPage, openWebPage, closeWebPage, yieldEntry, holdsEntry };
}
