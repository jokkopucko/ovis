/**
 * The demo's authoritative binary split tree. Every subsequent split, resize, swap and close edits that
 * same tree; reconstructing a grid after each operation would lose its creation hierarchy.
 *
 * Measured on herdr 0.9.3 (src/layout.rs resize_focused, src/app/api/panes.rs
 * handle_pane_resize): the split resized is the nearest one in the direction named, else the
 * nearest in the opposite direction; right and down add the amount to the ratio, left and up
 * take it off; the amount is capped at 0.5 and the ratio held to 0.1..0.9.
 */
import type { PaneDirection, PaneLayoutRect, PaneLayoutSnapshot } from "../../shared/protocol.ts";

type LayoutPane = PaneLayoutSnapshot["panes"][number];
type SplitDirection = "right" | "down";

interface Leaf { pane: LayoutPane; rect: PaneLayoutRect }
interface Split { direction: SplitDirection; ratio: number; rect: PaneLayoutRect; first: Node; second: Node }
type Node = Leaf | Split;

const isSplit = (node: Node): node is Split => "first" in node;
const trees = new WeakMap<PaneLayoutSnapshot, Node>();
const start = (rect: PaneLayoutRect, direction: SplitDirection): number => (direction === "right" ? rect.x : rect.y);
const end = (rect: PaneLayoutRect, direction: SplitDirection): number => (direction === "right" ? rect.x + rect.width : rect.y + rect.height);

function cutLine(panes: LayoutPane[], rect: PaneLayoutRect, direction: SplitDirection): number | null {
  const lines = [...new Set(panes.map((pane) => end(pane.rect, direction)))]
    .filter((line) => line > start(rect, direction) && line < end(rect, direction))
    .sort((a, b) => a - b);
  return lines.find((line) => panes.every((pane) => end(pane.rect, direction) <= line || start(pane.rect, direction) >= line)) ?? null;
}

function build(panes: LayoutPane[], rect: PaneLayoutRect, splits: Map<string, PaneLayoutSnapshot["splits"][number]>, path = ""): Node | null {
  if (panes.length === 0) return null;
  if (panes.length === 1) return { pane: panes[0]!, rect };
  const recorded = splits.get(path);
  const directions: SplitDirection[] = recorded?.direction === "right" ? ["right"] : recorded?.direction === "down" ? ["down"] : ["right", "down"];
  for (const direction of directions) {
    const extent = direction === "right" ? rect.width : rect.height;
    const line = recorded ? start(rect, direction) + Math.round(extent * recorded.ratio) : cutLine(panes, rect, direction);
    if (line === null) continue;
    const horizontal = direction === "right";
    const firstRect = horizontal ? { ...rect, width: line - rect.x } : { ...rect, height: line - rect.y };
    const secondRect = horizontal ? { ...rect, x: line, width: rect.x + rect.width - line } : { ...rect, y: line, height: rect.y + rect.height - line };
    const first = build(panes.filter((pane) => end(pane.rect, direction) <= line), firstRect, splits, `${path}0`);
    const second = build(panes.filter((pane) => start(pane.rect, direction) >= line), secondRect, splits, `${path}1`);
    if (!first || !second) return null;
    return { direction, ratio: recorded?.ratio ?? (line - start(rect, direction)) / extent, rect, first, second };
  }
  return null;
}

function tree(layout: PaneLayoutSnapshot): Node | null {
  const existing = trees.get(layout);
  if (existing) return existing;
  const splits = new Map<string, PaneLayoutSnapshot["splits"][number]>();
  for (const split of layout.splits) {
    const path = /^split_\d+_(root|[01]+)$/.exec(split.id)?.[1];
    if (path !== undefined) splits.set(path === "root" ? "" : path, split);
  }
  const root = build(layout.panes, layout.area, splits);
  if (root) trees.set(layout, root);
  return root;
}

function pathTo(node: Node, paneId: string): { split: Split; side: "first" | "second" }[] | null {
  if (!isSplit(node)) return node.pane.pane_id === paneId ? [] : null;
  for (const side of ["first", "second"] as const) {
    const rest = pathTo(node[side], paneId);
    if (rest) return [{ split: node, side }, ...rest];
  }
  return null;
}

/** the split whose cut the pane stands against on that side: herdr's nearest split in that direction */
function splitBeside(path: { split: Split; side: "first" | "second" }[], pane: LayoutPane, nav: PaneDirection): Split | null {
  const direction: SplitDirection = nav === "left" || nav === "right" ? "right" : "down";
  const side = nav === "right" || nav === "down" ? "first" : "second";
  const found = path.find((step) => {
    if (step.split.direction !== direction || step.side !== side) return false;
    const child = step.split[side].rect;
    return side === "first" ? end(pane.rect, direction) === end(child, direction) : start(pane.rect, direction) === start(child, direction);
  });
  return found?.split ?? null;
}

function minimum(node: Node, direction: SplitDirection): number {
  if (!isSplit(node)) return 1;
  const first = minimum(node.first, direction);
  const second = minimum(node.second, direction);
  return node.direction === direction ? first + second : Math.max(first, second);
}

function lay(node: Node, rect: PaneLayoutRect): LayoutPane[] {
  node.rect = rect;
  if (!isSplit(node)) return [{ ...node.pane, rect }];
  const horizontal = node.direction === "right";
  const extent = horizontal ? rect.width : rect.height;
  const first = Math.max(minimum(node.first, node.direction), Math.min(extent - minimum(node.second, node.direction), Math.round(extent * node.ratio)));
  const firstRect = horizontal ? { ...rect, width: first } : { ...rect, height: first };
  const secondRect = horizontal ? { ...rect, x: rect.x + first, width: extent - first } : { ...rect, y: rect.y + first, height: extent - first };
  return [...lay(node.first, firstRect), ...lay(node.second, secondRect)];
}

function render(layout: PaneLayoutSnapshot, root: Node): LayoutPane[] {
  const relaid = new Map(lay(root, layout.area).map((pane) => [pane.pane_id, pane.rect]));
  layout.splits = [];
  const collect = (node: Node, path: string): void => {
    if (!isSplit(node)) return;
    layout.splits.push({ id: `split_${layout.splits.length}_${path || "root"}`, direction: node.direction, ratio: node.ratio, rect: node.rect });
    collect(node.first, `${path}0`);
    collect(node.second, `${path}1`);
  };
  collect(root, "");
  return layout.panes.map((pane) => ({ ...pane, rect: relaid.get(pane.pane_id) ?? pane.rect }));
}

export function splitLayout(layout: PaneLayoutSnapshot, paneId: string, made: LayoutPane, direction: SplitDirection): boolean {
  const root = tree(layout);
  const path = root ? pathTo(root, paneId) : null;
  if (!root || !path) return false;
  const parent = path.at(-1);
  const leaf = parent ? parent.split[parent.side] : root;
  const extent = direction === "right" ? leaf.rect.width : leaf.rect.height;
  if (extent < 2) return false;
  const split: Split = { direction, ratio: Math.floor(extent / 2) / extent, rect: leaf.rect, first: leaf, second: { pane: made, rect: leaf.rect } };
  if (parent) parent.split[parent.side] = split;
  else trees.set(layout, split);
  layout.panes.push(made);
  layout.panes = render(layout, parent ? root : split);
  return true;
}

export function closeLayoutPane(layout: PaneLayoutSnapshot, paneId: string): void {
  const root = tree(layout);
  if (!root) return;
  const remove = (node: Node): Node | null => {
    if (!isSplit(node)) return node.pane.pane_id === paneId ? null : node;
    const first = remove(node.first);
    const second = remove(node.second);
    if (!first) return second;
    if (!second) return first;
    node.first = first;
    node.second = second;
    return node;
  };
  const remaining = remove(root);
  layout.panes = layout.panes.filter((pane) => pane.pane_id !== paneId);
  if (!remaining) { trees.delete(layout); return; }
  trees.set(layout, remaining);
  layout.panes = render(layout, remaining);
}

/**
 * A pane moved beside another of its tab, as herdr-core moves it: it leaves the tree as a close
 * takes it, then halves the target as a split does, so the target's room is measured once the
 * pane has left. With no room there, the tab stays as it was.
 */
export function moveLayoutPane(layout: PaneLayoutSnapshot, paneId: string, targetId: string, direction: SplitDirection): boolean {
  const root = tree(layout);
  const moving = layout.panes.find((pane) => pane.pane_id === paneId);
  if (!root || !moving || paneId === targetId) return false;
  const saved = { root: structuredClone(root), panes: layout.panes, splits: layout.splits };
  closeLayoutPane(layout, paneId);
  if (splitLayout(layout, targetId, moving, direction)) return true;
  trees.set(layout, saved.root);
  layout.panes = saved.panes;
  layout.splits = saved.splits;
  return false;
}

export function swapLayoutPanes(layout: PaneLayoutSnapshot, paneId: string, otherId: string): void {
  const root = tree(layout);
  if (!root) return;
  const leaf = (id: string): Leaf | null => {
    const path = pathTo(root, id);
    if (!path) return null;
    const parent = path.at(-1);
    const node = parent ? parent.split[parent.side] : root;
    return isSplit(node) ? null : node;
  };
  const first = leaf(paneId);
  const second = leaf(otherId);
  if (!first || !second) return;
  [first.pane, second.pane] = [second.pane, first.pane];
  layout.panes = render(layout, root);
}

/** herdr's layout.set_split_ratio: [] names the root, false the first child, true the second. */
export function setLayoutSplitRatio(layout: PaneLayoutSnapshot, path: readonly boolean[], ratio: number): boolean {
  const root = tree(layout);
  if (!root || !Number.isFinite(ratio)) return false;
  let node = root;
  for (const second of path) {
    if (!isSplit(node)) return false;
    node = second ? node.second : node.first;
  }
  if (!isSplit(node)) return false;
  node.ratio = Math.max(0.1, Math.min(0.9, ratio));
  layout.panes = render(layout, root);
  return true;
}

const OPPOSITE: Record<PaneDirection, PaneDirection> = { left: "right", right: "left", up: "down", down: "up" };

export function resizeLayout(layout: PaneLayoutSnapshot, paneId: string, direction: PaneDirection, amount: number): LayoutPane[] | null {
  const pane = layout.panes.find((candidate) => candidate.pane_id === paneId);
  const root = pane && tree(layout);
  const path = root ? pathTo(root, paneId) : null;
  if (!pane || !root || !path) return null;
  const split = splitBeside(path, pane, direction) ?? splitBeside(path, pane, OPPOSITE[direction]);
  if (!split) return null;
  const grows = direction === "right" || direction === "down";
  const delta = Math.min(0.5, Math.abs(amount));
  const extent = split.direction === "right" ? split.rect.width : split.rect.height;
  const low = minimum(split.first, split.direction) / extent;
  const high = 1 - minimum(split.second, split.direction) / extent;
  const requested = Math.min(0.9, Math.max(0.1, split.ratio + (grows ? delta : -delta)));
  const ratio = Math.min(high, Math.max(low, requested));
  if (ratio === split.ratio) return null;
  split.ratio = ratio;
  return render(layout, root);
}
