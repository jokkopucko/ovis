/**
 * The header's More menu (App): its button's menu, and on a phone the two groups it folds its items into,
 * Find… and Pane and tab… (G-143), each opened as a sheet of its own from More's button once More has closed.
 */
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";

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
  const [group, setGroup] = useState<{ kind: MoreGroup; anchor: HTMLElement } | null>(null);
  const openGroup = useCallback((kind: MoreGroup, anchor: HTMLElement) => setGroup({ kind, anchor }), []);
  const closeGroup = useCallback(() => setGroup(null), []);
  return { more, setMore, closeMore, group, openGroup, closeGroup };
}

/**
 * The open group's items, the first without a hairline over it. Only a phone's More folds its items into groups:
 * wider, More lists them itself, so a group still open from a phone's width has none, and closes.
 */
export function openGroupItems<T extends { divider?: boolean }>(kind: MoreGroup | null, sheet: boolean, find: T[], pane: T[]): T[] {
  const items = !sheet ? [] : kind === "find" ? find : kind === "pane" ? pane : [];
  return items.map((item, index) => index === 0 ? { ...item, divider: false } : item);
}

/** A group left with nothing in it (the pane went, the screen widened) is closed, not kept to come back later. */
export function useGroupClosedWhenEmpty(menu: MoreMenu, empty: boolean): void {
  const gone = menu.group !== null && empty;
  const { closeGroup } = menu;
  useEffect(() => { if (gone) closeGroup(); }, [gone, closeGroup]);
}
