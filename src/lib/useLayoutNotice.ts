import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { PaneDirection, PaneMoved } from "../../shared/protocol.ts";
import { ApiError, routeMissing } from "./api.ts";
import type { Translate } from "./i18n.ts";

export function useLayoutNotice() {
  const [layoutNotice, setLayoutNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!layoutNotice) return;
    const timer = window.setTimeout(() => setLayoutNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [layoutNotice]);
  return { layoutNotice, setLayoutNotice };
}

export function useLayoutRefused(setLayoutNotice: Dispatch<SetStateAction<string | null>>, t: Translate) {
  const layoutRefused = useCallback((what: string, err: unknown): void => {
    if (routeMissing(err)) setLayoutNotice(t("This PC's bridge does not offer this yet"));
    else console.warn(what, err);
  }, [t]);
  return layoutRefused;
}

export function useMoveRefused(setLayoutNotice: Dispatch<SetStateAction<string | null>>, t: Translate) {
  const moveRefused = useCallback((err: unknown): void => {
    const reason = err instanceof ApiError ? err.detail : err instanceof Error ? err.message : String(err);
    setLayoutNotice(routeMissing(err) ? t("This PC's bridge does not offer this yet") : t("Move failed: {reason}", { reason }));
  }, [t]);
  return moveRefused;
}

export function paneMoveNotice(move: PaneMoved, side: PaneDirection, t: Translate): string | null {
  if (move.reason === null) return null;
  if (move.changed) return side === "left" ? t("The pane moved to the right instead.") : t("The pane moved below instead.");
  const reason = move.reason === "cross_tab" ? t("The panes are in different tabs.")
    : move.reason === "same_pane" ? t("Choose two different panes.")
    : t("Something went wrong. Try again.");
  return t("Move failed: {reason}", { reason });
}
