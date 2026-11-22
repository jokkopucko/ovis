import { useCallback, useEffect, useLayoutEffect, useState, type Dispatch, type SetStateAction } from "react";

export type MoreGroup = "find" | "pane";

export interface MoreMenu {
  more: { anchor: HTMLElement } | null;
  setMore: Dispatch<SetStateAction<{ anchor: HTMLElement } | null>>;
  closeMore: () => void;
  group: { kind: MoreGroup; anchor: HTMLElement } | null;
  openGroup: (kind: MoreGroup, anchor: HTMLElement) => void;
  closeGroup: () => void;
}

export function useMoreMenu(): MoreMenu {
  const [more, setMore] = useState<{ anchor: HTMLElement } | null>(null);
  const closeMore = useCallback(() => setMore(null), []);
  // A More whose button left the document goes with it, before a frame is drawn: the thread it stood over closed
  // under it (a system Back in the inbox mode's wide layout takes the pane's More away), and what it listed was that
  // thread's. Checked after every render: nothing tells of a button's leaving.
  useLayoutEffect(() => { if (more !== null && !more.anchor.isConnected) setMore(null); });
  const [group, setGroup] = useState<{ kind: MoreGroup; anchor: HTMLElement } | null>(null);
  const openGroup = useCallback((kind: MoreGroup, anchor: HTMLElement) => setGroup({ kind, anchor }), []);
  const closeGroup = useCallback(() => setGroup(null), []);
  return { more, setMore, closeMore, group, openGroup, closeGroup };
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
