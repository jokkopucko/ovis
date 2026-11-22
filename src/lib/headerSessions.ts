import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane, PaneInfo, SessionSnapshot } from "../../shared/protocol.ts";
import { rosterPanes } from "./dagPane.ts";
import { knownStatus } from "./status.ts";
import { nativeModalOver, useFocusTrap } from "./useFocusTrap.ts";

type Roster = Pick<SessionSnapshot, "tabs" | "panes">;
type Layouts = SessionSnapshot["layouts"] | undefined;

export interface TabPosition {
  index: number;
  count: number;
}

export function tabPosition(roster: Roster, selectedPaneId: string | null): TabPosition | null {
  const selected = roster.panes.find((pane) => pane.pane_id === selectedPaneId);
  if (!selected) return null;
  const panes = rosterPanes(roster.panes.filter((pane) => pane.workspace_id === selected.workspace_id), selectedPaneId);
  const tabs = roster.tabs.filter((tab) => tab.workspace_id === selected.workspace_id && panes.some((pane) => pane.tab_id === tab.tab_id));
  const index = tabs.findIndex((tab) => tab.tab_id === selected.tab_id);
  return tabs.length < 2 || index < 0 ? null : { index: index + 1, count: tabs.length };
}

export interface SessionCounts {
  waiting: number;
}

export function sessionCounts<T extends PaneInfo>(panes: readonly T[], status: (pane: T) => AgentStatus | undefined): SessionCounts {
  const counts: SessionCounts = { waiting: 0 };
  for (const pane of rosterPanes(panes)) if (knownStatus(status(pane)) === "blocked") counts.waiting += 1;
  return counts;
}

export interface MachineRoster<T extends PaneInfo> {
  machineId: string;
  panes: readonly T[];
  status: (pane: T) => AgentStatus | undefined;
  layouts?: Layouts;
}

export function sessionCountsAcross<T extends PaneInfo>(rosters: readonly MachineRoster<T>[]): SessionCounts {
  const total: SessionCounts = { waiting: 0 };
  for (const roster of rosters) total.waiting += sessionCounts(roster.panes, roster.status).waiting;
  return total;
}

export function waitingElsewhere<T extends PaneInfo>(rosters: readonly MachineRoster<T>[], selected: { machineId: string; paneId: string | null }): number {
  let waiting = 0;
  for (const roster of rosters) {
    for (const pane of rosterPanes(roster.panes)) {
      if (roster.machineId === selected.machineId && pane.pane_id === selected.paneId) continue;
      if (knownStatus(roster.status(pane)) === "blocked") waiting += 1;
    }
  }
  return waiting;
}

function hiddenByTabZoom<T extends PaneInfo>(panes: readonly T[], layouts: Layouts, pane: T): boolean {
  const layout = layouts?.find((candidate) => candidate.tab_id === pane.tab_id);
  return !!layout?.zoomed && layout.focused_pane_id !== pane.pane_id && panes.some((other) => other.pane_id === layout.focused_pane_id);
}

export function nextWaitingTarget<T extends PaneInfo>(rosters: readonly MachineRoster<T>[], selected: { machineId: string; paneId: string | null }): { machineId: string; paneId: string } | null {
  if (rosters.length === 0) return null;
  const pickFrom = (roster: MachineRoster<T>, candidates: readonly T[]): { machineId: string; paneId: string } | null => {
    const own = roster.machineId === selected.machineId;
    for (const pane of candidates) {
      if (own && pane.pane_id === selected.paneId) continue;
      if (knownStatus(roster.status(pane)) === "blocked" && !hiddenByTabZoom(roster.panes, roster.layouts, pane)) {
        return { machineId: roster.machineId, paneId: pane.pane_id };
      }
    }
    return null;
  };
  const at = rosters.findIndex((roster) => roster.machineId === selected.machineId);
  const start = Math.max(0, at);
  const first = rosters[start]!;
  const firstShown = rosterPanes(first.panes, at >= 0 ? selected.paneId : null);
  const selectedIndex = at >= 0 && selected.paneId !== null ? firstShown.findIndex((pane) => pane.pane_id === selected.paneId) : -1;
  const afterSelected = pickFrom(first, firstShown.slice(selectedIndex + 1));
  if (afterSelected !== null) return afterSelected;
  for (let step = 1; step < rosters.length; step += 1) {
    const roster = rosters[(start + step) % rosters.length]!;
    const hit = pickFrom(roster, rosterPanes(roster.panes));
    if (hit !== null) return hit;
  }
  return selectedIndex > 0 ? pickFrom(first, firstShown.slice(0, selectedIndex)) : null;
}

export function waitingTargets<T extends PaneInfo>(rosters: readonly MachineRoster<T>[], selected: { machineId: string; paneId: string | null }): number {
  let targets = 0;
  for (const roster of rosters) {
    const own = roster.machineId === selected.machineId;
    for (const pane of rosterPanes(roster.panes)) {
      if (own && pane.pane_id === selected.paneId) continue;
      if (knownStatus(roster.status(pane)) === "blocked" && !hiddenByTabZoom(roster.panes, roster.layouts, pane)) targets += 1;
    }
  }
  return targets;
}

export function useWaitingRosters(shown: readonly Machine[], selected: Machine | undefined, status: (machineId: string, pane: HerdrPane) => AgentStatus | undefined): MachineRoster<HerdrPane>[] {
  return useMemo(() => {
    const counted = selected === undefined || shown.some((machine) => machine.id === selected.id) ? shown : [...shown, selected];
    return counted.flatMap((machine) => machine.state === "connected" && machine.snapshot
      ? [{ machineId: machine.id, panes: machine.snapshot.panes, status: (pane: HerdrPane) => status(machine.id, pane), layouts: machine.snapshot.layouts }] : []);
  }, [shown, selected, status]);
}

const drawerHeaderStops = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".app-header .drawer-toggle")];

const drawerReturnButton = (): HTMLElement | null => document.querySelector<HTMLElement>(".app-header .drawer-toggle");

/**
 * A phone's open drawer is a dialog over the pane (App.tsx gives it the role): Tab goes round its own controls
 * and the header's toggle drawn over it (its top row), the pane column is inert under it, and the focus
 * goes back to the header toggle that opened it when it closes. It opens with the focus on its first control
 * that takes no typing: the filter's field would raise the keyboard on every open. Only a header control takes
 * the focus back: a terminal the drawer was swiped open over would raise the keyboard; a focus left in the
 * hidden drawer (or nowhere) goes to the toggle. Escape puts it away in the capture phase, so a terminal that kept the focus never receives it;
 * a dialog, sheet or menu over the drawer, an IME composition, a search field with words in it (the sidebar's
 * filter clears them first) and a field that keeps its own Escape (data-own-escape) go first.
 */
export function useDrawerDialog(open: boolean, setOpen: (open: boolean) => void, surfaceRefs: readonly MutableRefObject<HTMLElement | null>[]): { ref: (node: HTMLElement | null) => void } {
  const opener = useRef<HTMLElement | null>(null);
  const escaped = useRef(false);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (open) { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; escaped.current = false; wasOpen.current = true; }
  }, [open]);
  // The trap's own return runs inside the commit, which React undoes while the drawer stays in the document (it is
  // hidden, not unmounted): the focus goes back after the commit instead, to the header control that opened the drawer,
  // or to the toggle when Escape closed one a tap or a swipe opened, or the focus was left in the hidden drawer or nowhere.
  const surface = useFocusTrap<HTMLElement>(open, { shouldRestore: () => false, leadingStops: drawerHeaderStops, startOnSurface: true });
  useEffect(() => {
    if (open || !wasOpen.current) return;
    const active = document.activeElement;
    const lost = active === null || active === document.body || (surface.current?.contains(active) ?? false);
    const back = opener.current?.closest(".app-header") != null ? opener.current : escaped.current || lost ? drawerReturnButton() : null;
    opener.current = null;
    escaped.current = false;
    wasOpen.current = false;
    const ownedElsewhere = active instanceof Element && active.closest('[aria-modal="true"], [role="dialog"], [role="alertdialog"]') !== null && !(surface.current?.contains(active) ?? false);
    if (back?.isConnected && !ownedElsewhere && !nativeModalOver(back)) back.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      const drawer = surface.current;
      if ([...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"]')].some((node) => node !== drawer)) return;
      if (event.target instanceof HTMLInputElement && event.target.type === "search" && event.target.value !== "") return;
      if (event.target instanceof Element && event.target.closest("[data-own-escape]") !== null) return;
      event.preventDefault();
      event.stopPropagation();
      escaped.current = true;
      setOpen(false);
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [open, setOpen, surface]);
  const ref = useCallback((node: HTMLElement | null) => {
    surface.current = node;
    for (const other of surfaceRefs) other.current = node;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the refs are stable objects
  }, [surface, ...surfaceRefs]);
  return { ref };
}
