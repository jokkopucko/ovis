/**
 * Nothing goes to the server: a hidden PC stays connected, its agents keep running, and a link or an
 * alert to one of its panes still opens that pane.
 */

import { useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from "react";

interface HasId { id: string }

/**
 * Kept in a key of its own, as the PC fold state is (`ovis:pc-collapsed:<id>`), never in
 * ovis:settings: a tab still on an older version rewrites that record whole and would erase a field
 * it does not know (docs/development.md, Stored-format changes).
 */
export const HIDDEN_MACHINES_KEY = "ovis:hidden-pcs";
export const HIDDEN_MACHINES_MAX = 64;

export function parseHiddenMachines(raw: string | null): string[] {
  let value: unknown;
  try { value = raw === null ? [] : JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200))].slice(0, HIDDEN_MACHINES_MAX);
}

const listeners = new Set<() => void>();
let cache: { raw: string | null; ids: string[] } = { raw: null, ids: [] };
let unsaved: string[] | null = null;

export function readHiddenMachines(): string[] {
  if (unsaved !== null) return unsaved;
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(HIDDEN_MACHINES_KEY); } catch {}
  if (raw !== cache.raw) cache = { raw, ids: parseHiddenMachines(raw) };
  return cache.ids;
}

export function setHiddenMachines(ids: readonly string[]): void {
  try {
    window.localStorage.setItem(HIDDEN_MACHINES_KEY, JSON.stringify(ids));
    unsaved = null;
  } catch {
    unsaved = [...ids];
  }
  for (const listener of listeners) listener();
}

export function subscribeHiddenMachines(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== HIDDEN_MACHINES_KEY && event.key !== null) return;
    unsaved = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}

export function useHiddenMachines(): string[] {
  return useSyncExternalStore(subscribeHiddenMachines, readHiddenMachines, () => []);
}

export function useShownMachines<T extends HasId>({ machines, selectedMachineRef, selectTargetRef, picks, restored }: {
  machines: readonly T[];
  selectedMachineRef: RefObject<string>;
  selectTargetRef: RefObject<(machineId: string, paneId: string | null, view?: undefined, keepNote?: boolean) => void>;
  picks: RefObject<number>;
  restored: boolean;
}): T[] {
  const hidden = useHiddenMachines();
  const shown = useMemo(() => shownMachines(machines, hidden), [machines, hidden]);
  const machinesRef = useRef(machines);
  machinesRef.current = machines;
  const hiddenBefore = useRef(hidden);
  useEffect(() => {
    const before = hiddenBefore.current;
    hiddenBefore.current = hidden;
    if (before === hidden) return;
    const next = selectionToMove(machinesRef.current, before, hidden, selectedMachineRef.current);
    // the user hid the PC shown: their own move, so an earlier note goes (unlike the restore below)
    if (next !== null) selectTargetRef.current(next, null);
  }, [hidden]);
  const restoreChecked = useRef(!restored);
  useEffect(() => {
    if (restoreChecked.current || !machines.some((machine) => machine.id === selectedMachineRef.current)) return;
    restoreChecked.current = true;
    if (picks.current > 0) return;
    const next = selectionAfterHiding(machines, hidden, selectedMachineRef.current);
    // restored on load, not picked: a link's note stays
    if (next !== null) selectTargetRef.current(next, null, undefined, true);
  }, [machines]);
  return shown;
}

export function shownMachines<T extends HasId>(machines: readonly T[], hidden: readonly string[]): T[] {
  if (hidden.length === 0) return [...machines];
  const shown = machines.filter((machine) => !hidden.includes(machine.id));
  return shown.length > 0 ? shown : [...machines];
}

export function canHideMachine(machines: readonly HasId[], hidden: readonly string[], id: string): boolean {
  const shown = shownMachines(machines, hidden);
  return shown.some((machine) => machine.id === id) && shown.length > 1;
}

export function withMachineHidden(machines: readonly HasId[], hidden: readonly string[], id: string, hide: boolean): string[] {
  const inRoster = hidden.filter((other) => machines.some((machine) => machine.id === other));
  const drawn = inRoster.length >= machines.length ? [] : inRoster;
  const kept = drawn.filter((other) => other !== id);
  return hide ? [...kept, id] : kept;
}

export function isMachineShown(machines: readonly HasId[], hidden: readonly string[], id: string): boolean {
  return shownMachines(machines, hidden).some((machine) => machine.id === id);
}

export function selectionToMove(machines: readonly HasId[], before: readonly string[], after: readonly string[], selectedMachineId: string): string | null {
  if (!isMachineShown(machines, before, selectedMachineId)) return null;
  return selectionAfterHiding(machines, after, selectedMachineId);
}

export function selectionAfterHiding(machines: readonly HasId[], hidden: readonly string[], selectedMachineId: string): string | null {
  const shown = shownMachines(machines, hidden);
  if (shown.some((machine) => machine.id === selectedMachineId)) return null;
  return (shown.find((machine) => machine.id === "local") ?? shown[0])?.id ?? null;
}
