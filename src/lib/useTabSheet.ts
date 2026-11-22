import { useCallback, useState } from "react";

import { SHEET_QUERY } from "./sheets.ts";
import { useSettings } from "./settings.ts";
import { useMediaQuery } from "./useMediaQuery.ts";

export function useTabSheet(owner: string | null): { tabsInHeader: boolean; sheet: HTMLElement | null; toggle: (anchor: HTMLElement) => void; close: () => void } {
  const { settings } = useSettings();
  const tabsInHeader = useMediaQuery(SHEET_QUERY) && settings.phoneTabs === "header";
  const [open, setOpen] = useState<{ anchor: HTMLElement; owner: string } | null>(null);
  if (open !== null && (!tabsInHeader || open.owner !== owner)) setOpen(null);
  const close = useCallback(() => setOpen(null), []);
  const toggle = useCallback((anchor: HTMLElement) => {
    if (owner !== null) setOpen((was) => was ? null : { anchor, owner });
  }, [owner]);
  return { tabsInHeader, sheet: open?.anchor ?? null, toggle, close };
}
