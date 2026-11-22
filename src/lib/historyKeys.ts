export const SHEET_HISTORY_KEY = "ovis:sheet";
export const SHEET_UNDER_KEY = "ovis:sheet-under";
/**
 * where an entry lies in the tab's history: a key of its own and its count, written by
 * lib/sheetHistory.ts on every entry where the browser tells neither (no Navigation API)
 */
export const PLACE_KEY = "ovis:place";

export const SEEN_KEY = "ovis:seen";

export const FILE_PREVIEW_KEY = "ovis:file-preview";
export const REPO_DIFF_KEY = "ovis:repo-diff";

export const WEB_PANEL_KEY = "ovis:web-panel";
export const WEB_PANEL_DOCKED_KEY = "ovis:web-panel-docked";
export const WEB_PANEL_BELOW_KEY = "ovis:web-panel-below";

export function webPagesBelow(state: Record<string, unknown>): number {
  const below = state[WEB_PANEL_BELOW_KEY];
  return typeof below === "number" && Number.isInteger(below) && below > 0 ? below : 0;
}

/**
 * A phone sheet's entry copies the one it opened over, the web panel's marks included. Once it is an
 * ordinary entry (a reload, Forward onto it after Back closed the sheet), a copy of the panel's entry
 * is one more of the panel's entries over that one, which closing the panel goes back past too (#3058).
 * So is a copy of a docked file's entry that holds the panel's count: closing the file goes past it.
 * With `overlays`, a copy of a file's or a diff's own entry is one more of theirs: closing it goes past
 * the real one, which would show the file or the diff again (#3101). Only where the entry under the
 * copy is still the one it copied (a reload, an address changed on the sheet's entry): after Back off
 * the sheet, another pane may have taken that entry over, and closing must not go past it.
 */
export function overCopiedEntry(state: Record<string, unknown>, overlays: boolean): Record<string, unknown> {
  const owned = state[WEB_PANEL_KEY] !== undefined || state[WEB_PANEL_DOCKED_KEY] === true ||
    (overlays && (state[FILE_PREVIEW_KEY] !== undefined || state[REPO_DIFF_KEY] !== undefined));
  if (!owned && webPagesBelow(state) === 0) return state;
  return { ...state, [WEB_PANEL_BELOW_KEY]: webPagesBelow(state) + 1 };
}

export function withoutFile(state: unknown): unknown {
  if (state === null || typeof state !== "object") return state;
  const { [FILE_PREVIEW_KEY]: _file, ...rest } = state as Record<string, unknown>;
  return rest;
}

export function withoutWebPanel(state: Record<string, unknown>): Record<string, unknown> {
  const { [WEB_PANEL_KEY]: _page, [WEB_PANEL_DOCKED_KEY]: _docked, [WEB_PANEL_BELOW_KEY]: _below, ...rest } = state;
  return rest;
}

/**
 * Whether a popstate is a closed phone sheet stepping off its own entry, which the browser lands
 * later, and no Back of the user's.
 */
export const sheetStep: {
  lands: (event: Event) => boolean;
  goingBack: (state: unknown) => boolean;
  /** Tells the sheets that the step announced with goingBack did not happen (the browser dropped the traversal): the next Back is the user's. */
  dropped: () => void;
  taking: (event: Event) => boolean;
  holds: (event: Event) => boolean;
} = { lands: () => false, goingBack: () => false, dropped: () => {}, taking: () => false, holds: () => false };
