import type { InlineNode } from "../../shared/markdown.ts";

/**
 * A bare <img> is zero height until its bytes arrive, so the row around it moves when the picture
 * lands and again if it fails and its alt text takes its place.
 * Adapted from t3code's ChatMarkdown.
 */

/** A picture in prose: as wide as the lane, up to this (t3code's bound), unless the author said narrower. */
const SLOT_MAX_REM = 30;

export function standaloneImage(nodes: InlineNode[]): boolean {
  const shown = nodes.filter((node) => node.type !== "text" || node.value.trim() !== "");
  const node = shown.length === 1 ? shown[0]! : null;
  if (node === null) return false;
  return node.type === "image" || (node.type === "link" && standaloneImage(node.children));
}

export function imageSlotStyle(width?: number): { maxWidth: string } {
  const bounds = ["100%", `${SLOT_MAX_REM}rem`];
  if (width !== undefined && Number.isFinite(width) && width > 0) bounds.push(`${Math.round(width)}px`);
  return { maxWidth: `min(${bounds.join(", ")})` };
}
