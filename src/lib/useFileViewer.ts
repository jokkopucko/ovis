import { useCallback, useEffect, useRef, useState } from "react";
import { outsideSettings } from "./settingsHistory.ts";
import { withoutWebPanel } from "./historyKeys.ts";
import type { FilePresentation } from "./filePresentation.ts";
import { backUnderCurrentEntry } from "./historyNavigation.ts";

interface FilePreview {
  path: string;
  paneId: string | null;
  machineId: string;
  presentation?: FilePresentation;
}
const HISTORY_KEY = "ovis:file-preview";

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

/** Android Back traverses history: a preview must be an entry above the chat, not just a modal. */
export function useFileViewer() {
  const [viewing, setViewing] = useState(() => previewFromState(window.history.state));
  const closing = useRef(false);

  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      closing.current = false;
      // Forward restores the preview with its original PC/pane, including after reload.
      setViewing(previewFromState(event.state));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openFile = useCallback((preview: FilePreview, replace = false) => {
    if (closing.current) return;
    // a preview opened over Settings is no entry of Settings: a reload on it closes Settings and keeps the file
    const state = { ...withoutWebPanel(outsideSettings(window.history.state)), [HISTORY_KEY]: preview };
    // Choosing a different file inside an open preview must not add another Back step.
    if (replace || previewFromState(window.history.state)) window.history.replaceState(state, "");
    else window.history.pushState(state, "");
    setViewing(preview);
  }, []);

  const closeFile = useCallback(() => {
    if (closing.current) return;
    if (previewFromState(window.history.state)) {
      closing.current = true;
      // X, Escape and scrim clicks consume the same entry as the system Back button. A traversal
      // the browser refuses lands nowhere and fires no popstate: the latch is let go for the next click.
      backUnderCurrentEntry()?.catch(() => { closing.current = false; });
    } else setViewing(null);
  }, []);

  const setPresentation = useCallback((presentation: FilePresentation) => {
    const preview = previewFromState(window.history.state);
    if (closing.current || preview === null || preview.presentation === presentation) return;
    const next = { ...preview, presentation };
    window.history.replaceState({ ...window.history.state, [HISTORY_KEY]: next }, "");
    setViewing(next);
  }, []);

  /** Hands the file's entry to a move to another pane: the file leaves it without a traversal, and the viewer closes. */
  const releaseFile = useCallback(() => {
    const { [HISTORY_KEY]: _, ...rest } = (window.history.state ?? {}) as Record<string, unknown>;
    window.history.replaceState(rest, "");
    setViewing(null);
  }, []);

  return { viewing, openFile, closeFile, setPresentation, releaseFile };
}
