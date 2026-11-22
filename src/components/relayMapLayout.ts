import { REGIONAL_RELAYS } from "../../shared/relay-regions.ts";
import { relayHost, type dashboardModel } from "../lib/relay/dashboard.ts";
import type { StatusDotState } from "./StatusDot.tsx";

export type RelayMapModel = ReturnType<typeof dashboardModel>["map"];
export type RelayMapHub = RelayMapModel["hubs"][number];
export type RelayMapNode = RelayMapHub["nodes"][number];
export type WireState = "live" | "still" | "off" | "checking";
export type LabelSide = "right" | "above" | "below";

export interface Placed {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly side: LabelSide;
}

export interface PlacedPc extends Placed {
  readonly kind: "pc";
  readonly node: RelayMapNode;
  readonly hub: number;
  readonly via: "direct" | "hub";
}

export interface RelayHandshake {
  readonly rttMs: number;
  readonly pcName: string;
}

export interface PlacedHub extends Placed {
  readonly kind: "hub";
  readonly hub: number;
  readonly origin: string;
  readonly regional: boolean;
  readonly pcCount: number;
  readonly rttMs: number | null;
  readonly handshake: RelayHandshake | null;
}

export interface RelayMapLayout {
  readonly width: number;
  readonly height: number;
  readonly me: Placed;
  readonly primary: PlacedHub;
  readonly hubs: readonly PlacedHub[];
  readonly pcs: readonly PlacedPc[];
  readonly items: readonly (PlacedPc | PlacedHub)[];
}

export const DIAGRAM_MAX_PCS = 8;
export const NODE_R = 16;
export const HUB_R = 18;
export const NAME_UNITS = 18;

const DIAGRAM_WIDTH = 960;
const ME_X = 64;
const HUB_X = 336;
const PC_X = 656;
const PC_STEP_Y = 54;
const HUB_MIN_STEP_Y = 76;
const PAD_Y = 38;

export function isRegionalRelay(origin: string): boolean {
  return REGIONAL_RELAYS.includes(origin);
}

export function relayHandshake(hub: RelayMapHub): RelayHandshake | null {
  const host = relayHost(hub.origin);
  let best: RelayHandshake | null = null;
  for (const node of hub.nodes) {
    const check = node.check;
    if (check?.kind === "answered" && check.route === "relay" && (check.relay === undefined || relayHost(check.relay) === host)) {
      if (best === null || check.rttMs < best.rttMs) {
        best = { rttMs: check.rttMs, pcName: node.name };
      }
    }
  }
  return best;
}

export function relayHandshakeMs(hub: RelayMapHub): number | null {
  return relayHandshake(hub)?.rttMs ?? null;
}

export function isDirectRoute(node: RelayMapNode): boolean {
  return node.check?.kind === "answered" && node.check.route !== "relay";
}

export function hubRoutedNodes(hub: RelayMapHub): RelayMapNode[] {
  return hub.nodes.filter((node) => !isDirectRoute(node));
}

export function nodeWireState(node: RelayMapNode): WireState {
  if (node.check?.kind === "checking") return "checking";
  if (node.check?.kind === "answered") return "live";
  if (node.state === "offline" || node.check?.kind === "offline") return "off";
  return node.seen === "lately" ? "live" : "still";
}

export function hubWireState(nodes: readonly RelayMapNode[]): WireState {
  if (nodes.some((node) => nodeWireState(node) === "checking")) return "checking";
  if (nodes.some((node) => nodeWireState(node) === "live")) return "live";
  if (nodes.length > 0 && nodes.every((node) => nodeWireState(node) === "off")) return "off";
  return "still";
}

export function nodeStatusDotState(node: RelayMapNode): StatusDotState {
  if (node.check?.kind === "checking") return "checking";
  switch (node.state) {
    case "needs-approval":
    case "needs-update":
      return "needs-you";
    case "offline": case "unchecked":
      return "offline";
    case "unreachable":
      return "failed";
    case "paired":
      return "ready";
  }
}

export function layoutRelayMap(map: RelayMapModel): RelayMapLayout | null {
  const totalPcs = map.hubs.reduce((sum, hub) => sum + hub.nodes.length, 0);
  if (totalPcs === 0 || totalPcs > DIAGRAM_MAX_PCS || map.hubs.length === 0) return null;

  const direct = map.hubs.flatMap((hub, hubIndex) => hub.nodes.filter(isDirectRoute).map((node) => ({ node, hubIndex })));
  const routed = map.hubs.map(hubRoutedNodes);
  const pcSpan = Math.max(0, routed.reduce((sum, nodes) => sum + nodes.length, 0) - 1) * PC_STEP_Y;
  const hubSpan = (direct.length > 0 ? direct.length * PC_STEP_Y + HUB_MIN_STEP_Y - PC_STEP_Y : 0) + (map.hubs.length - 1) * HUB_MIN_STEP_Y;
  const height = Math.max(152, Math.max(pcSpan, hubSpan) + PAD_Y * 2);
  const centerY = Math.round(height / 2);
  const pcTop = Math.round(centerY - pcSpan / 2);
  const pcs: PlacedPc[] = [];
  const hubCenters: number[] = [];

  const directTop = Math.round(centerY - hubSpan / 2);
  direct.forEach(({ node, hubIndex }, i) => {
    pcs.push({ kind: "pc", node, hub: hubIndex, via: "direct", x: HUB_X, y: Math.round(directTop + i * PC_STEP_Y), r: NODE_R, side: "right" });
  });
  const directBottom = direct.length > 0 ? directTop + (direct.length - 1) * PC_STEP_Y : null;

  let cursor = 0;
  routed.forEach((nodes, hubIndex) => {
    const startIdx = cursor;
    for (const node of nodes) {
      pcs.push({ kind: "pc", node, hub: hubIndex, via: "hub", x: PC_X, y: Math.round(pcTop + cursor * PC_STEP_Y), r: NODE_R, side: "right" });
      cursor += 1;
    }
    const endIdx = cursor - 1;
    hubCenters.push(startIdx <= endIdx ? Math.round((pcTop + startIdx * PC_STEP_Y + pcTop + endIdx * PC_STEP_Y) / 2) : centerY);
  });

  for (let i = 0; i < hubCenters.length; i++) {
    const floor = i === 0 ? (directBottom === null ? -Infinity : directBottom + HUB_MIN_STEP_Y) : (hubCenters[i - 1] ?? centerY) + HUB_MIN_STEP_Y;
    const curr = hubCenters[i] ?? centerY;
    if (curr < floor || (routed[i]?.length === 0 && Number.isFinite(floor))) hubCenters[i] = floor;
  }
  const shift = hubCenters.length > 1 && direct.length === 0 ? Math.round(centerY - ((hubCenters[0] ?? centerY) + (hubCenters[hubCenters.length - 1] ?? centerY)) / 2) : 0;
  if (hubCenters.length > 1) {
    for (let i = 0; i < hubCenters.length; i++) {
      hubCenters[i] = Math.max(PAD_Y, Math.min(height - PAD_Y, (hubCenters[i] ?? centerY) + shift));
    }
  }

  const hubs: PlacedHub[] = map.hubs.map((hub, i) => {
    const hs = relayHandshake(hub);
    return {
      kind: "hub", hub: i, origin: hub.origin, regional: isRegionalRelay(hub.origin),
      pcCount: hub.nodes.length, rttMs: hs?.rttMs ?? null, handshake: hs,
      x: HUB_X, y: hubCenters[i] ?? centerY, r: HUB_R, side: "below",
    };
  });
  const primary = hubs[0];
  if (primary === undefined) return null;

  const me: Placed = { x: ME_X, y: centerY, r: NODE_R, side: "below" };
  return { width: DIAGRAM_WIDTH, height, me, primary, hubs, pcs, items: [...hubs.slice(1), ...pcs] };
}

export function checkingWirePaths(map: RelayMapModel, layout: RelayMapLayout | null): string[] {
  if (layout === null) return [];
  return [
    ...layout.hubs.filter((hub) => { const model = map.hubs[hub.hub]; return model !== undefined && hubWireState(hubRoutedNodes(model)) === "checking"; }).map((hub) => wire(layout.me, hub)),
    ...layout.pcs.flatMap((pc) => {
      const hub = layout.hubs[pc.hub];
      return hub && nodeWireState(pc.node) === "checking" ? [wire(hub, pc)] : [];
    }),
  ];
}

export function placeLabel({ x, y, r, side }: Placed, lines: 1 | 2): { x: number; y: number; anchor: "start" | "middle" } {
  if (side === "right") return { x: x + r + 12, y: lines === 2 ? y - 1 : y + 4, anchor: "start" };
  if (side === "above") return { x, y: y - r - (lines === 2 ? 22 : 8), anchor: "middle" };
  return { x, y: y + r + 16, anchor: "middle" };
}

export function wire(from: Placed, to: Placed): string {
  const sx = Math.round(from.x + from.r);
  const sy = Math.round(from.y);
  const ex = Math.round(to.x - to.r);
  const ey = Math.round(to.y);
  const dx = ex - sx;
  return `M${sx} ${sy} C${Math.round(sx + dx * 0.42)} ${sy}, ${Math.round(sx + dx * 0.58)} ${ey}, ${ex} ${ey}`;
}

export function clip(text: string, max = NAME_UNITS): string {
  let units = 0;
  let end = 0;
  for (const ch of text) {
    units += /[\u2E80-\uFFFF]/.test(ch) ? 2 : 1;
    if (units > max) return `${text.slice(0, end)}…`;
    end += ch.length;
  }
  return text;
}
