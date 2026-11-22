import type { PaneLayoutRect, PaneLayoutSplit } from "../../shared/herdr-api.generated.ts";
import { isRecord } from "./snapshot.ts";

/**
 * Which tab a terminal is in stays in its `herdr.space` and `herdr.tab` labels, so a Herdr app
 * started later adopts it.
 *
 * Geometry flows top down: a tab is a fixed LAYOUT_AREA square cut by its splits' ratios, never
 * the terminals' own grids (a viewer sizes the terminal to its cell, and a grid read back as the
 * cell made panes shrink each other, #2812).
 */

export const OVIS_LAYOUT_DOC = "ovis-layout";
export const OVIS_LAYOUT_SCHEMA = 1;
export const LAYOUT_AREA: PaneLayoutRect = Object.freeze({ x: 0, y: 0, width: 1000, height: 1000 });

export type SplitDirection = "right" | "down";
export type LayoutNode = { leaf: string } | { split: SplitDirection; ratio: number; first: LayoutNode; second: LayoutNode };
export interface TabLayout { id: string; root: LayoutNode; zoomed: string | null }
export interface WorkspaceLayout { id: string; tabs: TabLayout[] }
export interface OvisLayout { schema: typeof OVIS_LAYOUT_SCHEMA; workspaces: WorkspaceLayout[] }

export interface Grouping { id: string; tabs: { id: string; panes: readonly string[] }[] }

const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;
export const clampRatio = (ratio: number): number => Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));

function parseNode(value: unknown): LayoutNode | null {
  if (!isRecord(value)) return null;
  if (typeof value["leaf"] === "string" && value["leaf"] !== "") return { leaf: value["leaf"] };
  const split = value["split"];
  const ratio = value["ratio"];
  if ((split !== "right" && split !== "down") || typeof ratio !== "number" || !Number.isFinite(ratio)) return null;
  const first = parseNode(value["first"]);
  const second = parseNode(value["second"]);
  if (!first || !second) return first ?? second;
  return { split, ratio: clampRatio(ratio), first, second };
}

export function parseOvisLayout(value: unknown): OvisLayout | null {
  if (!isRecord(value) || value["schema"] !== OVIS_LAYOUT_SCHEMA || !Array.isArray(value["workspaces"])) return null;
  const workspaces: WorkspaceLayout[] = [];
  for (const workspace of value["workspaces"]) {
    if (!isRecord(workspace) || typeof workspace["id"] !== "string" || !Array.isArray(workspace["tabs"])) continue;
    const tabs: TabLayout[] = [];
    for (const tab of workspace["tabs"]) {
      if (!isRecord(tab) || typeof tab["id"] !== "string") continue;
      const root = parseNode(tab["root"]) ?? { leaf: "" };
      tabs.push({ id: tab["id"], root, zoomed: typeof tab["zoomed"] === "string" ? tab["zoomed"] : null });
    }
    workspaces.push({ id: workspace["id"], tabs });
  }
  return { schema: OVIS_LAYOUT_SCHEMA, workspaces };
}

export function foreignLayout(value: unknown): boolean {
  return value !== null && value !== undefined && parseOvisLayout(value) === null;
}

export function leaves(node: LayoutNode): string[] {
  return "leaf" in node ? (node.leaf ? [node.leaf] : []) : [...leaves(node.first), ...leaves(node.second)];
}

function prune(node: LayoutNode, keep: (leaf: string) => boolean): LayoutNode | null {
  if ("leaf" in node) return node.leaf && keep(node.leaf) ? node : null;
  const first = prune(node.first, keep);
  const second = prune(node.second, keep);
  if (!first || !second) return first ?? second;
  return { ...node, first, second };
}

export function sideBySide(panes: readonly string[]): LayoutNode {
  if (panes.length === 1) return { leaf: panes[0]! };
  return { split: "right", ratio: clampRatio(1 / panes.length), first: { leaf: panes[0]! }, second: sideBySide(panes.slice(1)) };
}

export function reconcile(doc: OvisLayout | null, shown: readonly Grouping[]): OvisLayout {
  const order = <T extends { id: string }, S extends { id: string }>(kept: readonly T[], live: readonly S[]): { live: S; kept: T | undefined }[] => {
    const byId = new Map(live.map((entry) => [entry.id, entry]));
    const known = kept.filter((entry) => byId.has(entry.id));
    const ids = new Set(known.map((entry) => entry.id));
    return [...known.map((entry) => ({ live: byId.get(entry.id)!, kept: entry })), ...live.filter((entry) => !ids.has(entry.id)).map((entry) => ({ live: entry, kept: undefined }))];
  };
  return {
    schema: OVIS_LAYOUT_SCHEMA,
    workspaces: order(doc?.workspaces ?? [], shown).map(({ live, kept }) => ({
      id: live.id,
      tabs: order(kept?.tabs ?? [], live.tabs).filter(({ live: tab }) => tab.panes.length > 0).map(({ live: tab, kept: stored }) => {
        const panes = new Set(tab.panes);
        const seen = new Set<string>();
        let root = stored ? prune(stored.root, (leaf) => panes.has(leaf) && !seen.has(leaf) && Boolean(seen.add(leaf))) : null;
        const held = new Set(root ? leaves(root) : []);
        const orphans = tab.panes.filter((pane) => !held.has(pane));
        if (!root) root = sideBySide(orphans);
        else if (orphans.length > 0) {
          const before = held.size;
          root = { split: "right", ratio: clampRatio(before / (before + orphans.length)), first: root, second: sideBySide(orphans) };
        }
        const zoomed = stored?.zoomed && panes.has(stored.zoomed) ? stored.zoomed : null;
        return { id: tab.id, root, zoomed };
      }),
    })),
  };
}

function minimum(node: LayoutNode, axis: SplitDirection): number {
  if ("leaf" in node) return 1;
  const first = minimum(node.first, axis);
  const second = minimum(node.second, axis);
  return node.split === axis ? first + second : Math.max(first, second);
}

function sides(node: Extract<LayoutNode, { split: SplitDirection }>, rect: PaneLayoutRect): readonly [PaneLayoutRect, PaneLayoutRect] {
  const horizontal = node.split === "right";
  const extent = horizontal ? rect.width : rect.height;
  const first = Math.max(minimum(node.first, node.split), Math.min(extent - minimum(node.second, node.split), Math.round(extent * node.ratio)));
  return horizontal
    ? [{ ...rect, width: first }, { ...rect, x: rect.x + first, width: extent - first }]
    : [{ ...rect, height: first }, { ...rect, y: rect.y + first, height: extent - first }];
}

export interface Placed { panes: { pane_id: string; rect: PaneLayoutRect }[]; splits: PaneLayoutSplit[] }

// herdr's stable split path ids: `split_<n>_root`, `split_<n>_01` (0 the first side, 1 the second)
export function place(root: LayoutNode, area: PaneLayoutRect = LAYOUT_AREA): Placed {
  const placed: Placed = { panes: [], splits: [] };
  const walk = (node: LayoutNode, rect: PaneLayoutRect, path: string): void => {
    if ("leaf" in node) { placed.panes.push({ pane_id: node.leaf, rect }); return; }
    placed.splits.push({ id: `split_${placed.splits.length}_${path || "root"}`, direction: node.split, ratio: node.ratio, rect });
    const [first, second] = sides(node, rect);
    walk(node.first, first, `${path}0`);
    walk(node.second, second, `${path}1`);
  };
  walk(root, area, "");
  return placed;
}

/** The pane's leaf turned into a split: the pane first, `made` second, half each (herdr's split). */
export function splitLeaf(root: LayoutNode, target: string, made: string, direction: SplitDirection): LayoutNode | null {
  let found = false;
  const walk = (node: LayoutNode): LayoutNode => {
    if ("leaf" in node) {
      if (node.leaf !== target) return node;
      found = true;
      return { split: direction, ratio: 0.5, first: node, second: { leaf: made } };
    }
    return { ...node, first: walk(node.first), second: walk(node.second) };
  };
  const without = prune(root, (leaf) => leaf !== made);
  const next = without ? walk(without) : null;
  return found ? next : null;
}

export function swapLeaves(root: LayoutNode, a: string, b: string): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode => {
    if ("leaf" in node) return node.leaf === a ? { leaf: b } : node.leaf === b ? { leaf: a } : node;
    return { ...node, first: walk(node.first), second: walk(node.second) };
  };
  return walk(root);
}

/** herdr's `layout.set_split_ratio`: [] the root split, false the first side, true the second; null where no split is. */
export function setRatio(root: LayoutNode, path: readonly boolean[], ratio: number): LayoutNode | null {
  if (path.length === 0) return "leaf" in root ? null : { ...root, ratio: clampRatio(ratio) };
  if ("leaf" in root) return null;
  const [second, ...rest] = path;
  const child = setRatio(second ? root.second : root.first, rest, ratio);
  if (!child) return null;
  return second ? { ...root, second: child } : { ...root, first: child };
}

export type PaneDirection = "left" | "right" | "up" | "down";
const OPPOSITE: Record<PaneDirection, PaneDirection> = { left: "right", right: "left", up: "down", down: "up" };

/**
 * herdr's `pane.resize`, measured on herdr 0.9.3 (src/lib/layoutTree.ts does the same for the
 * demo): the split whose cut the pane stands against on that side, else on the other, moves by
 * `amount` of its own extent (capped at 0.5, the ratio held to 0.1..0.9); right and down add to
 * the ratio, left and up take off. null when no border of the pane moves.
 */
export function resizeLeaf(root: LayoutNode, pane: string, direction: PaneDirection, amount: number): LayoutNode | null {
  interface Step { path: boolean[]; node: Extract<LayoutNode, { split: SplitDirection }>; second: boolean; child: PaneLayoutRect }
  const steps: Step[] = [];
  let paneRect: PaneLayoutRect | null = null;
  const walk = (node: LayoutNode, rect: PaneLayoutRect, path: boolean[]): boolean => {
    if ("leaf" in node) { if (node.leaf === pane) paneRect = rect; return node.leaf === pane; }
    const rects = sides(node, rect);
    for (const second of [false, true]) {
      const step: Step = { path, node, second, child: rects[second ? 1 : 0] };
      steps.push(step);
      if (walk(second ? node.second : node.first, step.child, [...path, second])) return true;
      steps.pop();
    }
    return false;
  };
  if (!walk(root, LAYOUT_AREA, [])) return null;
  const at = paneRect as PaneLayoutRect | null;
  if (!at) return null;
  const cut = (nav: PaneDirection): Step | undefined => {
    const axis: SplitDirection = nav === "left" || nav === "right" ? "right" : "down";
    const second = nav === "left" || nav === "up";
    const horizontal = axis === "right";
    return [...steps].reverse().find((step) => step.node.split === axis && step.second === second && (second
      ? (horizontal ? at.x === step.child.x : at.y === step.child.y)
      : (horizontal ? at.x + at.width === step.child.x + step.child.width : at.y + at.height === step.child.y + step.child.height)));
  };
  const step = cut(direction) ?? cut(OPPOSITE[direction]);
  if (!step) return null;
  const delta = Math.min(0.5, Math.abs(amount));
  const ratio = clampRatio(step.node.ratio + (direction === "right" || direction === "down" ? delta : -delta));
  if (ratio === step.node.ratio) return null;
  return setRatio(root, step.path, ratio);
}

export function neighbour(root: LayoutNode, pane: string, direction: PaneDirection): string | null {
  const { panes } = place(root);
  const from = panes.find((entry) => entry.pane_id === pane)?.rect;
  if (!from) return null;
  const horizontal = direction === "left" || direction === "right";
  let best: { id: string; overlap: number } | null = null;
  for (const { pane_id, rect } of panes) {
    if (pane_id === pane) continue;
    const touches = direction === "right" ? rect.x === from.x + from.width
      : direction === "left" ? rect.x + rect.width === from.x
      : direction === "down" ? rect.y === from.y + from.height
      : rect.y + rect.height === from.y;
    if (!touches) continue;
    const overlap = horizontal
      ? Math.min(rect.y + rect.height, from.y + from.height) - Math.max(rect.y, from.y)
      : Math.min(rect.x + rect.width, from.x + from.width) - Math.max(rect.x, from.x);
    if (overlap > 0 && (!best || overlap > best.overlap)) best = { id: pane_id, overlap };
  }
  return best?.id ?? null;
}
