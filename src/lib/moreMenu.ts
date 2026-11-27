import { useCallback, useEffect, useLayoutEffect, useState } from "react";

export type MoreGroup = "find" | "pane";

export interface MoreMenu {
  more: { anchor: HTMLElement } | null;
  toggleMore: (anchor: HTMLElement) => void;
  closeMore: () => void;
  group: { kind: MoreGroup; anchor: HTMLElement } | null;
  paneActionsInMore: boolean;
  openGroup: (kind: MoreGroup, anchor: HTMLElement) => void;
  closeGroup: () => void;
}

export function useMoreMenu(paneKey: string | null, paneMenuInMore: boolean, sheet: boolean): MoreMenu {
  const [openedMore, setMore] = useState<{ anchor: HTMLElement; paneKey: string | null } | null>(null);
  // The phone's More may take focus and dismiss the keyboard before the pane group is tapped.
  const heldPane = sheet && paneMenuInMore ? paneKey : null;
  const toggleMore = useCallback((anchor: HTMLElement) => setMore((open) => open ? null : { anchor, paneKey: heldPane }), [heldPane]);
  const closeMore = useCallback(() => setMore(null), []);
  const morePaneChanged = openedMore?.paneKey != null && (!sheet || openedMore.paneKey !== paneKey);
  const more = morePaneChanged ? null : openedMore;
  // A More whose button left the document goes with it, before a frame is drawn: the thread it stood over closed
  // under it (a system Back in the inbox mode's wide layout takes the pane's More away), and what it listed was that
  // thread's. Checked after every render: nothing tells of a button's leaving.
  useLayoutEffect(() => { if (morePaneChanged || (more !== null && !more.anchor.isConnected)) closeMore(); });
  const [opened, setGroup] = useState<{ kind: MoreGroup; anchor: HTMLElement; paneKey: string | null } | null>(null);
  const openGroup = useCallback((kind: MoreGroup, anchor: HTMLElement) => setGroup({ kind, anchor, paneKey }), [paneKey]);
  const closeGroup = useCallback(() => setGroup(null), []);
  const paneChanged = opened?.kind === "pane" && opened.paneKey !== paneKey;
  useLayoutEffect(() => { if (paneChanged) closeGroup(); }, [paneChanged, closeGroup]);
  const group = paneChanged ? null : opened;
  return { more, toggleMore, closeMore, group, openGroup, closeGroup, paneActionsInMore: paneMenuInMore || (sheet && (more?.paneKey != null || group?.kind === "pane")) };
}

export function openGroupItems<T extends { divider?: boolean }>(kind: MoreGroup | null, sheet: boolean, find: T[], pane: T[]): T[] {
  const items = !sheet ? [] : kind === "find" ? find : kind === "pane" ? pane : [];
  return items.map((item, index) => index === 0 ? { ...item, divider: false } : item);
}

export function useGroupClosedWhenEmpty(menu: MoreMenu, empty: boolean): void {
  const gone = menu.group !== null && empty;
  const { closeGroup } = menu;
  useEffect(() => { if (gone) closeGroup(); }, [gone, closeGroup]);
}
