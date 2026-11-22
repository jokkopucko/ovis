import { useCallback, useEffect, useRef, useState } from "react";
import { outsideSettings } from "./settingsHistory.ts";
import { FILE_PREVIEW_KEY, WEB_PANEL_BELOW_KEY, sheetStep, webPagesBelow, withoutWebPanel } from "./historyKeys.ts";
import type { FilePresentation } from "./filePresentation.ts";
import { backUnderCurrentEntry } from "./historyNavigation.ts";

interface FilePreview {
  path: string;
  paneId: string | null;
  machineId: string;
  presentation?: FilePresentation;
}
const HISTORY_KEY = FILE_PREVIEW_KEY;

function previewFromState(state: unknown): FilePreview | null {
  if (state === null || typeof state !== "object") return null;
  const preview = (state as Record<string, unknown>)[HISTORY_KEY];
  if (preview === null || typeof preview !== "object") return null;
  const value = preview as Record<string, unknown>;
  return typeof value.path === "string" && typeof value.machineId === "string" &&
    (value.paneId === null || typeof value.paneId === "string") ? {
      path: value.path, machineId: value.machineId, paneId: value.paneId,
      ...(value.presentation === "panel" || value.presentation === "popup" ? { presentation: value.presentation } : {}),
    } : null;
}

/**
 * The file open in the viewer, held in its own history entry. Android Back traverses history: a
 * preview must be an entry above the chat, not just a modal. Back closes it, Forward and a reload
 * restore it from the entry, and a tab switch releases it, or hides it with its entry kept (#3179).
 */
export function useFileViewer() {
  const [viewing, setViewing] = useState(() => previewFromState(window.history.state));
  const closing = useRef(false);
  const pops = useRef(viewing !== null ? 1 : 0);
  const popped = useRef(pops.current);

  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      if (sheetStep.taking(event) || sheetStep.holds(event)) return;
      closing.current = false;
      const preview = previewFromState(event.state);
      if (preview !== null) pops.current += 1;
      popped.current = preview !== null ? pops.current : 0;
      setViewing(preview);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openFile = useCallback((preview: FilePreview, replace = false) => {
    if (closing.current) return;
    const current = outsideSettings(window.history.state);
    const state = { ...withoutWebPanel(current), [HISTORY_KEY]: preview };
    if (replace || previewFromState(window.history.state)) {
      // a docked file taking over the entry of a page stacked on the web panel's other entries keeps
      // their count: closing it goes back past them too, or the page under it would show again (#3058)
      const below = webPagesBelow(current);
      window.history.replaceState(below > 0 ? { ...state, [WEB_PANEL_BELOW_KEY]: below } : state, "");
    } else window.history.pushState(state, "");
    popped.current = 0;
    setViewing(preview);
  }, []);

  const closeFile = useCallback(() => {
    if (closing.current) return;
    if (previewFromState(window.history.state)) {
      closing.current = true;
      // X, Escape and scrim clicks consume the same entry as the system Back button. A traversal
      // the browser refuses lands nowhere and fires no popstate: the latch is let go for the next click.
      backUnderCurrentEntry(1 + webPagesBelow(outsideSettings(window.history.state)))?.catch(() => { closing.current = false; });
    } else { popped.current = 0; setViewing(null); }
  }, []);

  const setPresentation = useCallback((presentation: FilePresentation) => {
    const preview = previewFromState(window.history.state);
    if (closing.current || preview === null || preview.presentation === presentation) return;
    const next = { ...preview, presentation };
    window.history.replaceState({ ...window.history.state, [HISTORY_KEY]: next }, "");
    setViewing(next);
  }, []);

  const releaseFile = useCallback(() => {
    const { [HISTORY_KEY]: _, ...rest } = (window.history.state ?? {}) as Record<string, unknown>;
    window.history.replaceState(rest, "");
    popped.current = 0;
    setViewing(null);
  }, []);

  const hideFile = useCallback(() => { popped.current = 0; setViewing(null); }, []);
  const fileFromPop = useCallback(() => popped.current, []);

  return { viewing, openFile, closeFile, setPresentation, releaseFile, hideFile, fileFromPop };
}
