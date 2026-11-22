const KEY = "ovis:file-panel-width";

export const FILE_PANEL_DOCK_QUERY = "(min-width: 980px)";
export const FILE_PANEL_MIN_WIDTH = 320;
export const FILE_PANEL_MAX_WIDTH = 900;
export const FILE_PANEL_WIDTH_STEP = 16;

export function filePanelMaxWidth(viewportWidth: number, sidebarWidth = 0): number {
  return Math.min(
    Math.max(FILE_PANEL_MIN_WIDTH, Math.min(FILE_PANEL_MAX_WIDTH, Math.floor(viewportWidth * 0.6))),
    Math.floor(viewportWidth - sidebarWidth - 320),
  );
}

export function clampFilePanelWidth(width: number, viewportWidth = Number.POSITIVE_INFINITY, sidebarWidth = 0): number {
  const max = filePanelMaxWidth(viewportWidth, sidebarWidth);
  return Math.round(Math.min(max, Math.max(FILE_PANEL_MIN_WIDTH, width)));
}

export function keyedFilePanelWidth(current: number, key: string, viewportWidth = Number.POSITIVE_INFINITY, sidebarWidth = 0): number | null {
  if (key === "ArrowLeft") return clampFilePanelWidth(current + FILE_PANEL_WIDTH_STEP, viewportWidth, sidebarWidth);
  if (key === "ArrowRight") return clampFilePanelWidth(current - FILE_PANEL_WIDTH_STEP, viewportWidth, sidebarWidth);
  if (key === "Home") return clampFilePanelWidth(FILE_PANEL_MIN_WIDTH, viewportWidth, sidebarWidth);
  if (key === "End") return filePanelMaxWidth(viewportWidth, sidebarWidth);
  return null;
}

export function parseFilePanelWidth(stored: string | null): number | null {
  if (stored === null || !/^\d+$/.test(stored)) return null;
  return clampFilePanelWidth(Number(stored));
}

export function storedFilePanelWidth(): number | null {
  try {
    return parseFilePanelWidth(window.localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function storeFilePanelWidth(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, String(clampFilePanelWidth(width)));
  } catch {
    /* private mode: the width simply is not remembered */
  }
}
