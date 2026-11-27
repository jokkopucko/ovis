import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { AppLink } from "./deepLink.ts";
import { watchDrawerSwipe } from "./edgeSwipe.ts";
import { FILE_PANEL_DOCK_QUERY, storedFilePanelWidth } from "./filePanelWidth.ts";
import { storedSidebarWidth } from "./sidebarWidth.ts";
import { useMediaQuery } from "./useMediaQuery.ts";

export const SECOND_TAP_MS = 400;

export function secondTapOf(openedAt: number | null, at: number): boolean {
  return openedAt !== null && at - openedAt < SECOND_TAP_MS;
}

export interface SidebarLayoutParams {
  initialLink: AppLink | null;
  drawerBlocked?: RefObject<boolean>;
}

export function useSidebarLayout({ initialLink, drawerBlocked }: SidebarLayoutParams) {
  const [drawerOpen, setDrawerOpenState] = useState(() => initialLink?.sidebar === "shown" && window.matchMedia?.("(min-width: 769px)").matches !== true && drawerBlocked?.current !== true);
  const setDrawerOpen = useCallback<Dispatch<SetStateAction<boolean>>>((next) => setDrawerOpenState((open) => {
    const asked = typeof next === "function" ? next(open) : next;
    return asked && drawerBlocked?.current !== true;
  }), [drawerBlocked]);
  const drawerOpenRef = useRef(drawerOpen); drawerOpenRef.current = drawerOpen;
  const wideScreen = useMediaQuery("(min-width: 769px)");
  useEffect(() => { if (wideScreen) setDrawerOpen(false); }, [wideScreen]);
  // on a phone the drawer follows a swipe in from the left edge, and a swipe back (lib/edgeSwipe.ts)
  useEffect(() => watchDrawerSwipe(() => drawerOpenRef.current, setDrawerOpen,
    () => drawerBlocked?.current !== true && document.getElementById("workspace-drawer") !== null), [drawerBlocked, setDrawerOpen]);
  const drawerOpenedAt = useRef<number | null>(null);
  const toggleDrawerByButton = useCallback((at: number) => {
    if (!drawerOpenRef.current) drawerOpenedAt.current = at;
    setDrawerOpen((open) => !open);
  }, [setDrawerOpen]);
  const secondTapOfOpening = useCallback((at: number): boolean => secondTapOf(drawerOpenedAt.current, at), []);
  useEffect(() => { if (!drawerOpen) drawerOpenedAt.current = null; }, [drawerOpen]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => initialLink?.sidebar === "hidden");
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
  const filePanelAvailable = useMediaQuery(FILE_PANEL_DOCK_QUERY);
  const [filePanelWidth, setFilePanelWidth] = useState(storedFilePanelWidth);
  const [sidebarFilterRequest, setSidebarFilterRequest] = useState(0);
  const openSidebarFilter = useCallback(() => {
    if (window.matchMedia("(max-width: 768px)").matches) setDrawerOpen(true);
    else setSidebarCollapsed(false);
    setSidebarFilterRequest((count) => count + 1);
  }, []);
  return { drawerOpen, setDrawerOpen, drawerOpenRef, toggleDrawerByButton, secondTapOfOpening, wideScreen, sidebarCollapsed, setSidebarCollapsed, sidebarWidth, setSidebarWidth, filePanelAvailable, filePanelWidth, setFilePanelWidth, sidebarFilterRequest, openSidebarFilter };
}
