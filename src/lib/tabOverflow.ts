export const TAB_MIN_WIDTH = 120;
export const TAB_MORE_WIDTH = 56;

export function tabsInRow(count: number, open: number, room: number, add: number, openWidth = TAB_MIN_WIDTH, keep = -1): number[] {
  const all = Array.from({ length: count }, (_, index) => index);
  if ((count - 1) * TAB_MIN_WIDTH + openWidth + add <= room) return all;
  const pinned = new Set(keep >= 0 && keep < count ? [open, keep] : [open]);
  const others = Math.max(0, Math.floor((room - add - TAB_MORE_WIDTH - openWidth) / TAB_MIN_WIDTH) - (pinned.size - 1));
  const first = new Set(all.filter((index) => !pinned.has(index)).slice(0, others));
  return all.filter((index) => pinned.has(index) || first.has(index));
}
