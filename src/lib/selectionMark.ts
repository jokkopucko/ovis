export interface SelectionMark {
  machineId: string;
  paneId: string | null;
  generation: number;
}

export function markSelection(mark: SelectionMark, machineId: string, paneId: string | null): SelectionMark {
  if (mark.machineId === machineId && mark.paneId === paneId) return mark;
  return { machineId, paneId, generation: mark.generation + 1 };
}

export function selectionStill(then: SelectionMark, now: SelectionMark): boolean {
  return then.generation === now.generation;
}
