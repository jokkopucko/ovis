/**
 * Keys the app's history modules write into history entries' state, shared so one can tell the
 * other's entries without importing it (sheetHistory patches the history when it loads).
 */

/** a phone sheet's own entry (lib/sheetHistory.ts): a push made while it is current replaces it */
export const SHEET_HISTORY_KEY = "ovis:sheet";
/** the sheet's id on the entry it opened over, and on its own: one that takes the sheet's entry over can tell that entry */
export const SHEET_UNDER_KEY = "ovis:sheet-under";

export const WEB_PANEL_KEY = "ovis:web-panel";
export const WEB_PANEL_DOCKED_KEY = "ovis:web-panel-docked";

/** A different panel's entry must not inherit the web panel's ownership marks. */
export function withoutWebPanel(state: Record<string, unknown>): Record<string, unknown> {
  const { [WEB_PANEL_KEY]: _page, [WEB_PANEL_DOCKED_KEY]: _docked, ...rest } = state;
  return rest;
}

/**
 * Whether a popstate is a closed phone sheet stepping off its own entry, which the browser lands
 * later, and no Back of the user's. sheetHistory answers it and settingsHistory asks: the answer
 * holds whichever of the two hears the event first (in the app sheetHistory loads, and listens, first).
 */
export const sheetStep: {
  lands: (event: Event) => boolean;
  /**
   * Takes over the step back of a closed sheet whose entry `state` is, when that step has not run
   * yet: whoever goes back from there steps over the sheet's entry too. sheetHistory answers it.
   */
  takeLeaving: (state: unknown) => boolean;
} = { lands: () => false, takeLeaving: () => false };
