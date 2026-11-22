const KEY = "ovis:sidebar-width";

export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 520;
export const SIDEBAR_WIDTH_STEP = 16;

export function sidebarMaxWidth(viewportWidth: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.floor(viewportWidth / 2)));
}

export function clampSidebarWidth(width: number, viewportWidth = Number.POSITIVE_INFINITY): number {
  return Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(sidebarMaxWidth(viewportWidth), width)));
}

export function keyedSidebarWidth(current: number, key: string, viewportWidth = Number.POSITIVE_INFINITY): number | null {
  if (key === "ArrowLeft") return clampSidebarWidth(current - SIDEBAR_WIDTH_STEP, viewportWidth);
  if (key === "ArrowRight") return clampSidebarWidth(current + SIDEBAR_WIDTH_STEP, viewportWidth);
  if (key === "Home") return SIDEBAR_MIN_WIDTH;
  if (key === "End") return sidebarMaxWidth(viewportWidth);
  return null;
}

export function parseSidebarWidth(stored: string | null): number | null {
  if (stored === null || !/^\d+$/.test(stored)) return null;
  return clampSidebarWidth(Number(stored));
}

export function storedSidebarWidth(): number | null {
  try {
    return parseSidebarWidth(window.localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function storeSidebarWidth(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, String(clampSidebarWidth(width)));
  } catch {
  }
}
