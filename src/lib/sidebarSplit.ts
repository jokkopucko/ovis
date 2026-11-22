const KEYS: Record<SplitOrder, string> = { pcs: "ovis:sidebar-split", agents: "ovis:sidebar-split-agents-first" };

export type SplitOrder = "pcs" | "agents";

const MAX_STORED = 10_000;

export interface SplitRoom { topHead: number; bottomHead: number; room: number; row: number; topRow: number; bottomRow: number }

export function splitBounds({ topHead, bottomHead, room, topRow, bottomRow }: SplitRoom): { min: number; max: number } {
  const available = Math.max(0, room);
  const heads = topHead + bottomHead;
  const scale = heads > 0 ? Math.min(1, available / heads) : 1;
  const rows = topRow + bottomRow;
  const rowScale = rows > 0 ? Math.min(1, Math.max(0, available - heads) / rows) : 0;
  return { min: topHead * scale + topRow * rowScale, max: available - bottomHead * scale - bottomRow * rowScale };
}

export function clampSplit(height: number, room: SplitRoom): number {
  const { min, max } = splitBounds(room);
  return Math.round(Math.max(min, Math.min(max, height)));
}

export function splitPercent(height: number, room: number): number {
  return room > 0 ? Math.round(Math.max(0, Math.min(100, height / room * 100))) : 0;
}

export type SplitFold = "pcs" | "agents";

export type SplitSide = "top" | "bottom";

export function sectionAt(side: SplitSide, order: SplitOrder): SplitFold {
  return (side === "top") === (order === "pcs") ? "pcs" : "agents";
}

export function splitSnap(height: number, { topHead, bottomHead, room, row }: SplitRoom): SplitSide | null {
  const slack = row * 0.6;
  const top = topHead > 0 && height < topHead + slack;
  const bottom = bottomHead > 0 && height > room - bottomHead - slack;
  if (top && bottom) return Math.abs(height - topHead) <= Math.abs(room - bottomHead - height) ? "top" : "bottom";
  return top ? "top" : bottom ? "bottom" : null;
}

export function splitDrag(raw: number, room: SplitRoom): { snap: SplitSide | null; height: number; shown: number } {
  const snap = splitSnap(raw, room);
  const height = clampSplit(raw, room);
  return { snap, height, shown: snap === "top" ? room.topHead : snap === "bottom" ? room.room - room.bottomHead : height };
}

export type SplitKey = { split: number } | { fold: SplitSide } | { reset: true };

export function keyedSplit(current: number, key: string, room: SplitRoom): SplitKey | null {
  if (key === "ArrowUp") return { split: clampSplit(current - room.row, room) };
  if (key === "ArrowDown") return { split: clampSplit(current + room.row, room) };
  if (key === "Home") return room.topHead > 0 ? { fold: "top" } : { split: clampSplit(0, room) };
  if (key === "End") return room.bottomHead > 0 ? { fold: "bottom" } : { split: clampSplit(room.room, room) };
  if (key === "Enter") return { reset: true };
  return null;
}

export function parseSidebarSplit(stored: string | null): number | null {
  if (stored === null || !/^\d+$/.test(stored)) return null;
  const height = Number(stored);
  return height > 0 && height <= MAX_STORED ? height : null;
}

export function storedSidebarSplit(order: SplitOrder): number | null {
  try {
    return parseSidebarSplit(window.localStorage.getItem(KEYS[order]));
  } catch {
    return null;
  }
}

export function storeSidebarSplit(order: SplitOrder, height: number | null): void {
  try {
    if (height === null) window.localStorage.removeItem(KEYS[order]);
    else window.localStorage.setItem(KEYS[order], String(Math.round(Math.max(1, Math.min(MAX_STORED, height)))));
  } catch {
  }
}
