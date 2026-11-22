import type { PaneDirection } from "../../shared/protocol.ts";

export type SplitSide = "left" | "right";
export type SplitEdge = "left" | "right" | "top" | "bottom";
export type SplitSlot = string;

export interface SplitTarget {
  machineId: string;
  paneId: string;
}

export type SplitNode = { slot: SplitSlot } | { dir: "row" | "column"; ratio: number; first: SplitNode; second: SplitNode };

export interface SplitState {
  root: SplitNode;
  panes: Record<SplitSlot, SplitTarget>;
  active: SplitSlot;
}

export interface DropZone {
  slot: SplitSlot;
  edge: SplitEdge | null;
}

export interface SplitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SplitDivider {
  path: string;
  dir: "row" | "column";
  ratio: number;
  area: SplitRect;
}

export interface SplitChange {
  split: SplitState | null;
  solo: SplitSlot;
  select: SplitTarget;
}

export const MAX_SPLIT_SLOTS = 4;
export const MIN_SPLIT_RATIO = 0.15;
export const SPLIT_RATIO_STEP = 0.05;
const EDGE_BAND = 0.25;

export const PANE_DRAG_TYPE = "application/x-herdr-pane";

const STORAGE_KEY = "ovis:split";
const SLOT_ID = /^[a-z]$/;
const FULL: SplitRect = { x: 0, y: 0, w: 1, h: 1 };

export function otherSide(side: SplitSide): SplitSide {
  return side === "left" ? "right" : "left";
}

export function sameTarget(a: SplitTarget | null | undefined, b: SplitTarget | null | undefined): boolean {
  return !!a && !!b && a.machineId === b.machineId && a.paneId === b.paneId;
}

const isLeaf = (node: SplitNode): node is { slot: SplitSlot } => "slot" in node;

export function slotsOf(node: SplitNode): SplitSlot[] {
  return isLeaf(node) ? [node.slot] : [...slotsOf(node.first), ...slotsOf(node.second)];
}

export function otherTargets(state: SplitState | null): SplitTarget[] {
  return state ? Object.values(state.panes) : [];
}

export function splitShows(state: SplitState | null, target: SplitTarget): boolean {
  return otherTargets(state).some((other) => sameTarget(other, target));
}

function halves(node: { dir: "row" | "column"; ratio: number }, rect: SplitRect): [SplitRect, SplitRect] {
  if (node.dir === "row") {
    const w = rect.w * node.ratio;
    return [{ ...rect, w }, { ...rect, x: rect.x + w, w: rect.w - w }];
  }
  const h = rect.h * node.ratio;
  return [{ ...rect, h }, { ...rect, y: rect.y + h, h: rect.h - h }];
}

export function slotRects(root: SplitNode): Map<SplitSlot, SplitRect> {
  const rects = new Map<SplitSlot, SplitRect>();
  const walk = (node: SplitNode, rect: SplitRect): void => {
    if (isLeaf(node)) { rects.set(node.slot, rect); return; }
    const [first, second] = halves(node, rect);
    walk(node.first, first);
    walk(node.second, second);
  };
  walk(root, FULL);
  return rects;
}

export function splitDividers(root: SplitNode): SplitDivider[] {
  const dividers: SplitDivider[] = [];
  const walk = (node: SplitNode, rect: SplitRect, path: string): void => {
    if (isLeaf(node)) return;
    dividers.push({ path, dir: node.dir, ratio: node.ratio, area: rect });
    const [first, second] = halves(node, rect);
    walk(node.first, first, `${path}0`);
    walk(node.second, second, `${path}1`);
  };
  walk(root, FULL, "");
  return dividers;
}

export function slotSide(state: SplitState, slot: SplitSlot): SplitSide | null {
  const root = state.root;
  if (isLeaf(root) || root.dir !== "row" || !isLeaf(root.first) || !isLeaf(root.second)) return null;
  return root.first.slot === slot ? "left" : root.second.slot === slot ? "right" : null;
}

export function resizeSplit(state: SplitState, path: string, ratio: number): SplitState {
  if (!Number.isFinite(ratio)) return state;
  const clamped = Math.round(Math.min(1 - MIN_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio)) * 1000) / 1000;
  const walk = (node: SplitNode, rest: string): SplitNode => {
    if (isLeaf(node)) return node;
    if (rest === "") return node.ratio === clamped ? node : { ...node, ratio: clamped };
    const turn = rest[0] === "0" ? "first" : "second";
    const child = walk(node[turn], rest.slice(1));
    return child === node[turn] ? node : { ...node, [turn]: child };
  };
  const root = walk(state.root, path);
  return root === state.root ? state : { ...state, root };
}

function insertBeside(root: SplitNode, at: SplitSlot, slot: SplitSlot, edge: SplitEdge): SplitNode {
  if (isLeaf(root)) {
    if (root.slot !== at) return root;
    const added = { slot };
    const before = edge === "left" || edge === "top";
    return { dir: edge === "left" || edge === "right" ? "row" : "column", ratio: 0.5, first: before ? added : root, second: before ? root : added };
  }
  return { ...root, first: insertBeside(root.first, at, slot, edge), second: insertBeside(root.second, at, slot, edge) };
}

function pruneSlots(root: SplitNode, drop: ReadonlySet<SplitSlot>): SplitNode | null {
  if (isLeaf(root)) return drop.has(root.slot) ? null : root;
  const first = pruneSlots(root.first, drop);
  const second = pruneSlots(root.second, drop);
  if (first === null) return second;
  if (second === null) return first;
  return first === root.first && second === root.second ? root : { ...root, first, second };
}

function freeSlot(used: readonly SplitSlot[]): SplitSlot | null {
  for (let code = 97; code <= 122; code++) {
    const slot = String.fromCharCode(code);
    if (!used.includes(slot)) return slot;
  }
  return null;
}

function contents(state: SplitState, active: SplitTarget): Map<SplitSlot, SplitTarget> {
  const map = new Map<SplitSlot, SplitTarget>();
  for (const slot of slotsOf(state.root)) map.set(slot, slot === state.active ? active : state.panes[slot]!);
  return map;
}

function settle(root: SplitNode, map: Map<SplitSlot, SplitTarget>, active: SplitSlot): SplitChange {
  const select = map.get(active)!;
  const slots = slotsOf(root);
  if (slots.length === 1) return { split: null, solo: slots[0]!, select };
  const panes: Record<SplitSlot, SplitTarget> = {};
  for (const slot of slots) if (slot !== active) panes[slot] = map.get(slot)!;
  return { split: { root, panes, active }, solo: active, select };
}

function soloState(solo: SplitSlot): SplitState {
  return { root: { slot: solo }, panes: {}, active: solo };
}

export function dockPane(
  state: SplitState | null,
  active: SplitTarget | null,
  dragged: SplitTarget,
  zone: DropZone,
  solo: SplitSlot = "a",
): SplitChange | null {
  if (active === null) return null;
  const now = state ?? soloState(solo);
  const slots = slotsOf(now.root);
  if (!slots.includes(zone.slot)) return null;
  const map = contents(now, active);
  if (zone.edge === null) {
    if (zone.slot === now.active && sameTarget(dragged, active)) return null;
    map.set(zone.slot, dragged);
    return settle(now.root, map, zone.slot);
  }
  if (slots.length >= MAX_SPLIT_SLOTS) return null;
  const added = freeSlot(slots);
  if (added === null) return null;
  map.set(added, dragged);
  return settle(insertBeside(now.root, zone.slot, added, zone.edge), map, added);
}

export function activateSlot(state: SplitState, active: SplitTarget, slot: SplitSlot): SplitChange | null {
  if (slot === state.active || !(slot in state.panes)) return null;
  return settle(state.root, contents(state, active), slot);
}

export function pickInSlot(state: SplitState, active: SplitTarget, slot: SplitSlot, target: SplitTarget): SplitChange | null {
  if (!(slot in state.panes) && slot !== state.active) return null;
  const map = contents(state, active);
  map.set(slot, target);
  return settle(state.root, map, slot);
}

function heirOf(root: SplitNode, slot: SplitSlot): SplitSlot | null {
  if (isLeaf(root)) return null;
  if (isLeaf(root.first) && root.first.slot === slot) return slotsOf(root.second)[0] ?? null;
  if (isLeaf(root.second) && root.second.slot === slot) return slotsOf(root.first).at(-1) ?? null;
  return heirOf(root.first, slot) ?? heirOf(root.second, slot);
}

export function closeSlots(state: SplitState, active: SplitTarget, closed: ReadonlySet<SplitSlot>): SplitChange | null {
  const root = pruneSlots(state.root, closed);
  if (root === null) return null;
  const map = contents(state, active);
  let next = state.active;
  if (closed.has(next)) {
    const left = slotsOf(root);
    const heir = heirOf(state.root, next);
    next = heir !== null && left.includes(heir) ? heir : left[0]!;
  }
  return settle(root, map, next);
}

export function withoutSlots(state: SplitState, closed: ReadonlySet<SplitSlot>): { split: SplitState | null; solo: SplitSlot } {
  const drop = new Set([...closed].filter((slot) => slot !== state.active));
  const root = pruneSlots(state.root, drop);
  if (root === null || isLeaf(root)) return { split: null, solo: state.active };
  const panes: Record<SplitSlot, SplitTarget> = {};
  for (const [slot, target] of Object.entries(state.panes)) if (!drop.has(slot)) panes[slot] = target;
  return { split: { ...state, root, panes }, solo: state.active };
}

export function replaceSlotPane(state: SplitState, slot: SplitSlot, target: SplitTarget): SplitState {
  if (!(slot in state.panes)) return state;
  return { ...state, panes: { ...state.panes, [slot]: target } };
}

export function dropSide(x: number, left: number, width: number, previous: SplitSide | null = null): SplitSide {
  const middle = left + width / 2;
  const margin = Math.min(12, width / 4);
  if (previous === "left" && x <= middle + margin) return "left";
  if (previous === "right" && x >= middle - margin) return "right";
  return x < middle ? "left" : "right";
}

export function sideZone(state: SplitState | null, solo: SplitSlot, side: SplitSide): DropZone | null {
  if (state === null) return { slot: solo, edge: side };
  const [from, to] = side === "left" ? [0, 0.5] : [0.5, 1];
  let best: { slot: SplitSlot; share: number } | null = null;
  for (const [slot, rect] of slotRects(state.root)) {
    const share = Math.max(0, Math.min(rect.x + rect.w, to) - Math.max(rect.x, from)) * rect.h;
    const tied = best !== null && Math.abs(share - best.share) < 1e-9;
    if (best === null || share > best.share + 1e-9 || (tied && slot === state.active)) best = { slot, share };
  }
  return best && best.share > 0 ? { slot: best.slot, edge: null } : null;
}

export function dropZone(
  x: number,
  y: number,
  box: { left: number; top: number; width: number; height: number },
  state: SplitState | null,
  solo: SplitSlot,
  previous: DropZone | null = null,
): DropZone | null {
  if (box.width <= 0 || box.height <= 0) return null;
  const px = (x - box.left) / box.width;
  const py = (y - box.top) / box.height;
  if (px < 0 || px >= 1 || py < 0 || py >= 1) return null;
  const full = state !== null && slotsOf(state.root).length >= MAX_SPLIT_SLOTS;
  const rects = state ? slotRects(state.root) : new Map([[solo, FULL]]);
  for (const [slot, rect] of rects) {
    if (px < rect.x || px >= rect.x + rect.w || py < rect.y || py >= rect.y + rect.h) continue;
    const u = (px - rect.x) / rect.w;
    const v = (py - rect.y) / rect.h;
    if (state === null) {
      const vertical = Math.min(v, 1 - v);
      if (vertical < EDGE_BAND && vertical < Math.min(u, 1 - u)) return { slot, edge: v < 0.5 ? "top" : "bottom" };
      const kept = previous?.slot === slot && (previous.edge === "left" || previous.edge === "right") ? previous.edge : null;
      return { slot, edge: dropSide(x, box.left, box.width, kept) };
    }
    const distances: [SplitEdge, number][] = [["left", u], ["right", 1 - u], ["top", v], ["bottom", 1 - v]];
    const [edge, distance] = distances.reduce((best, next) => (next[1] < best[1] ? next : best));
    return { slot, edge: distance < EDGE_BAND && !full ? edge : null };
  }
  return null;
}

export function zoneRect(zone: DropZone, state: SplitState | null, solo: SplitSlot): SplitRect | null {
  const rect = state ? slotRects(state.root).get(zone.slot) : zone.slot === solo ? FULL : undefined;
  if (!rect) return null;
  switch (zone.edge) {
    case null: return rect;
    case "left": return { ...rect, w: rect.w / 2 };
    case "right": return { ...rect, x: rect.x + rect.w / 2, w: rect.w / 2 };
    case "top": return { ...rect, h: rect.h / 2 };
    case "bottom": return { ...rect, y: rect.y + rect.h / 2, h: rect.h / 2 };
  }
}

const BESIDE_MARGIN = 0.05;

export function besideSide(x: number, y: number, box: { left: number; top: number; width: number; height: number }, previous: PaneDirection | null = null): PaneDirection {
  const width = Math.max(1, box.width);
  const height = Math.max(1, box.height);
  const shares: Record<PaneDirection, number> = {
    left: (x - box.left) / width, right: (box.left + width - x) / width,
    up: (y - box.top) / height, down: (box.top + height - y) / height,
  };
  const nearest = (["left", "right", "up", "down"] as const).reduce((best, side) => (shares[side] < shares[best] ? side : best));
  return previous !== null && shares[previous] - shares[nearest] < BESIDE_MARGIN ? previous : nearest;
}

export function draggedPane(data: string): SplitTarget | null {
  try {
    const value = JSON.parse(data) as { machine_id?: unknown; pane_id?: unknown };
    return typeof value.machine_id === "string" && typeof value.pane_id === "string" ? { machineId: value.machine_id, paneId: value.pane_id } : null;
  } catch {
    return null;
  }
}

export function paneDragData(target: SplitTarget): string {
  return JSON.stringify({ machine_id: target.machineId, pane_id: target.paneId });
}

function readTarget(value: unknown): SplitTarget | null {
  const target = value as Partial<SplitTarget> | null;
  return target && typeof target === "object" && typeof target.machineId === "string" && typeof target.paneId === "string" ? { machineId: target.machineId, paneId: target.paneId } : null;
}

function readNode(value: unknown, depth = 0): SplitNode | null {
  if (depth > MAX_SPLIT_SLOTS || value === null || typeof value !== "object") return null;
  const node = value as { slot?: unknown; dir?: unknown; ratio?: unknown; first?: unknown; second?: unknown };
  if (typeof node.slot === "string") return SLOT_ID.test(node.slot) ? { slot: node.slot } : null;
  if (node.dir !== "row" && node.dir !== "column") return null;
  if (typeof node.ratio !== "number" || !(node.ratio >= MIN_SPLIT_RATIO && node.ratio <= 1 - MIN_SPLIT_RATIO)) return null;
  const first = readNode(node.first, depth + 1);
  const second = readNode(node.second, depth + 1);
  return first && second ? { dir: node.dir, ratio: node.ratio, first, second } : null;
}

export function storedSplit(): SplitState | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null") as Record<string, unknown> | null;
    if (!value || typeof value !== "object") return null;
    if ("other" in value) {
      const other = readTarget(value["other"]);
      const bSide = value["bSide"], active = value["active"];
      if (!other || (bSide !== "left" && bSide !== "right") || (active !== "a" && active !== "b")) return null;
      const a = { slot: "a" }, b = { slot: "b" };
      return {
        root: { dir: "row", ratio: 0.5, first: bSide === "left" ? b : a, second: bSide === "left" ? a : b },
        panes: { [active === "a" ? "b" : "a"]: other },
        active,
      };
    }
    const root = readNode(value["root"]);
    const active = value["active"];
    if (!root || typeof active !== "string") return null;
    const slots = slotsOf(root);
    if (slots.length < 2 || slots.length > MAX_SPLIT_SLOTS || new Set(slots).size !== slots.length || !slots.includes(active)) return null;
    const stored = (value["panes"] ?? {}) as Record<string, unknown>;
    const panes: Record<SplitSlot, SplitTarget> = {};
    for (const slot of slots) {
      if (slot === active) continue;
      const target = readTarget(stored[slot]);
      if (!target) return null;
      panes[slot] = target;
    }
    return { root, panes, active };
  } catch {
    return null;
  }
}

export function storeSplit(state: SplitState | null): void {
  try {
    if (state === null) window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
  }
}
