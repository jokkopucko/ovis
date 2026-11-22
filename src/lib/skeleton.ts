export type SkeletonWidth = "short" | "medium" | "long";

const WIDTHS: readonly SkeletonWidth[] = ["medium", "long", "short", "medium", "short", "long"];

export const FIRST_SKELETON_ROWS = 3;
export const MAX_SKELETON_ROWS = 14;

export function skeletonRows(listed: number | null): SkeletonWidth[] {
  const count = listed === null ? FIRST_SKELETON_ROWS : Math.min(Math.max(listed, 1), MAX_SKELETON_ROWS);
  return Array.from({ length: count }, (_, index) => WIDTHS[index % WIDTHS.length]!);
}
