import { useCallback, useEffect, useRef, useState } from "react";

import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { WEB_PANEL_KEY as HISTORY_KEY, WEB_PANEL_DOCKED_KEY as DOCKED_KEY, WEB_PANEL_BELOW_KEY as BELOW_KEY, SHEET_HISTORY_KEY, sheetStep, webPagesBelow, withoutWebPanel } from "./historyKeys.ts";
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

function pagesBelow(state: unknown): number {
  return webPagesBelow(outsideSettings(state));
}

function panelState(state: unknown, url: string | null, below = pagesBelow(state)): Record<string, unknown> {
  return { ...withoutWebPanel(outsideSettings(state)), ...(url === null ? { [DOCKED_KEY]: true } : { [HISTORY_KEY]: { url } }), ...(below > 0 ? { [BELOW_KEY]: below } : {}) };
}

export function useWebPanel({ settings, filePanelAvailable }: { settings: Settings; filePanelAvailable: boolean }) {
  const [webPage, setWebPage] = useState<string | null>(() => webPanelFromState(window.history.state));
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
      else if (!ownsEntry.current) window.history.pushState(panelState(state, webPage, 0), "");
      ownsEntry.current = true;
    }
  }, [filePanelAvailable, webPage]);

  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      if (sheetStep.holds(event) || sheetStep.taking(event)) return;
      closingWebPage.current = false;
      const next = webPanelFromState(event.state);
      const docked = isDocked(event.state);
      const inSettings = settingsEntry(event.state) !== null;
      const { webPage: page, filePanelAvailable: wide } = current.current;
      if (next !== null || (docked && page !== null)) {
        if (!inSettings && wide !== (next === null)) window.history.replaceState(panelState(event.state, wide ? null : page), "");
        ownsEntry.current = true;
        if (next !== null) setWebPage(next);
      } else if (ownsEntry.current && !inSettings) {
        ownsEntry.current = false;
        setWebPage(null);
      } else if (!wide && page !== null && !inSettings) {
        window.history.pushState(panelState(event.state, page, 0), "");
        ownsEntry.current = true;
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openWebPage = useCallback((uri: string, shiftKey: boolean, machineId: string, takeOver?: () => void) => {
    if (machineId !== LOCAL_MACHINE || !wantsPanel(settings.webLinks, shiftKey)) return false;
    const url = panelUrl(uri, window.location);
    if (url === null) return false;
    takeOver?.();
    const state = window.history.state;
    const sheet = state !== null && typeof state === "object" && typeof (state as Record<string, unknown>)[SHEET_HISTORY_KEY] === "string";
    const owned = takeOver !== undefined || (!sheet && ownsEntry.current && (webPanelFromState(state) !== null || isDocked(state)));
    const stacked = sheet && ownsEntry.current && webPanelFromState(state) !== null;
    if (owned) window.history.replaceState(panelState(state, filePanelAvailable ? null : url), "");
    else if (!filePanelAvailable) window.history.pushState(panelState(state, url, stacked ? pagesBelow(state) + 1 : 0), "");
    ownsEntry.current = owned || !filePanelAvailable || ownsEntry.current;
    closingWebPage.current = false;
    setWebPage(url);
    return true;
  }, [settings.webLinks, filePanelAvailable]);

  const yieldEntry = useCallback(() => {
    const state = window.history.state;
    const owned = ownsEntry.current && settingsEntry(state) === null && (webPanelFromState(state) !== null || isDocked(state));
    ownsEntry.current = false;
    return owned;
  }, []);

  const holdsEntry = useCallback(() => ownsEntry.current, []);

  const closeWebPage = useCallback((replaced = false) => {
    if (closingWebPage.current) return;
    if (replaced === true) {
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
      // past the pages stacked under this one too, or the one under it would show again (#3054)
      backUnderCurrentEntry(1 + pagesBelow(state))?.catch(() => { closingWebPage.current = false; });
    } else {
      ownsEntry.current = false;
      setWebPage(null);
    }
  }, []);

  return { webPage, openWebPage, closeWebPage, yieldEntry, holdsEntry };
}
