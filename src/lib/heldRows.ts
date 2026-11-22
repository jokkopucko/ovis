/**
 * A phone window with too little height for the rows. This is the layout viewport: Android
 * Chrome shrinks it for the keyboard, iOS Safari does not (see lib/viewport.ts), so an iPhone
 * with its keyboard up is not a short phone here.
 */
export const SHORT_PHONE_QUERY = "(max-width: 480px) and (max-height: 600px)";

export interface HeldRowsState {
  promptOpen: boolean;
  shortPhone: boolean;
  ready: boolean;
}

export function heldRowsFold({ promptOpen, shortPhone, ready }: HeldRowsState): boolean {
  return !ready && (promptOpen || shortPhone);
}

export function heldRowError(error: { owner: string; id: string } | null, owner: string | null, ids: readonly string[]): boolean {
  return error !== null && error.owner === owner && ids.includes(error.id);
}

export function heldOpenAtFold({ fold, sameOwner, focusInRows }: { fold: boolean; sameOwner: boolean; focusInRows: boolean }): boolean {
  return fold && sameOwner && focusInRows;
}

export function heldOpenOnFocus(fold: boolean, opened: boolean): boolean {
  return opened || fold;
}

export function heldToggleShown(fold: boolean, rowError: boolean): boolean {
  return fold && !rowError;
}

export function heldRefocusDue(controlled: string | null, listId: string | null): boolean {
  return controlled !== null && controlled === listId;
}

export function heldRowsHidden(fold: boolean, opened: boolean, rowError: boolean): boolean {
  return fold && !opened && !rowError;
}
