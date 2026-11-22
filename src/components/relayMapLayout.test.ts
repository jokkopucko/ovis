import { describe, expect, it } from "bun:test";

import { dashboardModel } from "../lib/relay/dashboard.ts";
import type { DashboardPc } from "../lib/relay/dashboard.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import {
  clip,
  DIAGRAM_MAX_PCS,
  hubRoutedNodes,
  hubWireState,
  isDirectRoute,
  layoutRelayMap,
  nodeStatusDotState,
  nodeWireState,
  placeLabel,
  relayHandshake,
  relayHandshakeMs,
  wire,
} from "./relayMapLayout.ts";
import type { RelayMapLayout, RelayMapModel, RelayMapNode } from "./relayMapLayout.ts";

const GLOBAL = "wss://relay.ovis.sh";
const REGIONAL = "wss://relay-ap.ovis.sh";
const SELF = "wss://relay.example.test";

function pc(
  server_id: string,
  state: DashboardPc["state"],
  relay: string | null = null,
  last_seen_at: string | null = null,
  paired = state === "paired",
): DashboardPc {
  return { server_id, name: server_id, state, relay, last_seen_at, added_at: null, listed: true, paired, linked: paired };
}

const modelOf = (pcs: readonly DashboardPc[], status?: ReadonlyMap<string, PcStatus>): RelayMapModel =>
  dashboardModel(pcs, { label: "This iPhone", ...(status ? { status } : {}) }, GLOBAL).map;

function requireLayout(map: RelayMapModel): RelayMapLayout {
  const layout = layoutRelayMap(map);
  if (layout === null) throw new Error("expected non-null RelayMapLayout");
  return layout;
}

function requireNode(nodes: readonly RelayMapNode[], id: string): RelayMapNode {
  const found = nodes.find((n) => n.server_id === id);
  if (found === undefined) throw new Error(`missing node ${id}`);
  return found;
}

type Box = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number; readonly of: string };
const overlaps = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function boxes(layout: RelayMapLayout): Box[] {
  const circle = (x: number, y: number, r: number, of: string): Box => ({ left: x - r, top: y - r, right: x + r, bottom: y + r, of });
  const out: Box[] = [circle(layout.me.x, layout.me.y, layout.me.r, "me")];
  for (const hub of layout.hubs) {
    out.push(circle(hub.x, hub.y, hub.r, `hub:${hub.origin}`));
  }
  for (const item of layout.pcs) {
    out.push(circle(item.x, item.y, item.r, `pc:${item.node.name}`));
  }
  return out;
}

describe("relayMapLayout threshold and tiers", () => {
  it("returns null for an empty fleet (0 relays / 0 PCs)", () => {
    expect(layoutRelayMap({ me: { label: "This iPhone" }, hubs: [] })).toBeNull();
  });

  it("lays out 1 to 8 PCs in three distinct left-to-right tiers (me -> hubs -> PCs)", () => {
    const one = requireLayout(modelOf([pc("Desk PC", "paired", GLOBAL, "2026-11-07T00:00:00Z")]));
    expect(one.height).toBeLessThanOrEqual(220);
    const oneHub = one.hubs[0];
    const onePc = one.pcs[0];
    if (!oneHub || !onePc) throw new Error("missing hub or pc");
    expect(one.me.x).toBeLessThan(oneHub.x);
    expect(oneHub.x).toBeLessThan(onePc.x);

    const eight = requireLayout(
      modelOf(Array.from({ length: DIAGRAM_MAX_PCS }, (_, i) => pc(`PC ${i + 1}`, "paired", i % 2 === 0 ? REGIONAL : GLOBAL, "2026-11-07T00:00:00Z"))),
    );
    expect(eight.hubs).toHaveLength(2);
    expect(eight.pcs).toHaveLength(8);
    const [firstHub, secondHub] = eight.hubs;
    if (!firstHub || !secondHub) throw new Error("expected two hubs");
    expect(firstHub.x).toBe(secondHub.x);
    expect(firstHub.r).toBe(secondHub.r);
    for (const hub of eight.hubs) {
      expect(eight.me.x).toBeLessThan(hub.x);
      for (const node of eight.pcs) {
        expect(hub.x).toBeLessThan(node.x);
      }
    }
    const all = boxes(eight);
    const clashes = all.flatMap((a, i) => all.slice(i + 1).filter((b) => overlaps(a, b)).map((b) => `${a.of} / ${b.of}`));
    expect(clashes).toEqual([]);
  });

  it("returns null above 8 PCs so 9+ fleets use the adjacency list instead of a dense diagram", () => {
    const nine = modelOf(Array.from({ length: DIAGRAM_MAX_PCS + 1 }, (_, i) => pc(`PC ${i + 1}`, "paired", GLOBAL)));
    expect(layoutRelayMap(nine)).toBeNull();
  });

  it("groups each relay's PCs adjacent to their own hub and wires every PC from its hub's ring", () => {
    const relays = [REGIONAL, GLOBAL, SELF];
    const map = modelOf(Array.from({ length: 6 }, (_, i) => pc(`pc-${i}`, "paired", relays[i % 3] ?? GLOBAL)));
    const layout = requireLayout(map);
    expect(layout.hubs).toHaveLength(3);
    for (const item of layout.pcs) {
      const hub = layout.hubs[item.hub];
      if (!hub) throw new Error(`missing hub ${item.hub}`);
      const d = wire(hub, item);
      const match = /^M(-?\d+) (-?\d+) C(-?\d+ -?\d+, ){2}(-?\d+) (-?\d+)$/.exec(d);
      if (!match) throw new Error(`invalid path ${d}`);
      const sx = Number(match[1]);
      const sy = Number(match[2]);
      const ex = Number(match[4]);
      const ey = Number(match[5]);
      expect(Math.abs(Math.hypot(sx - hub.x, sy - hub.y) - hub.r)).toBeLessThanOrEqual(1.5);
      expect(Math.abs(Math.hypot(ex - item.x, ey - item.y) - item.r)).toBeLessThanOrEqual(1.5);
    }
  });
});

describe("a PC this device reaches directly", () => {
  const fleet = modelOf(
    [
      pc("Studio desktop", "paired", GLOBAL, "2026-11-07T00:00:00Z"),
      pc("Work laptop", "paired", REGIONAL, "2026-11-07T00:00:00Z"),
      pc("Home server", "offline", GLOBAL, "2026-11-01T00:00:00Z", true),
      pc("Lab NUC", "paired", GLOBAL, null),
      pc("Old MacBook", "needs-approval", REGIONAL, null),
    ],
    new Map<string, PcStatus>([
      ["Studio desktop", { kind: "answered", route: "lan", rttMs: 4 }],
      ["Work laptop", { kind: "answered", route: "tailscale", rttMs: 18 }],
      ["Home server", { kind: "offline", reason: "pc" }],
      ["Lab NUC", { kind: "answered", route: "relay", relay: GLOBAL, rttMs: 62 }],
    ]),
  );

  it("is one the check answered on the same network or over Tailscale, never through a relay", () => {
    const nodes = fleet.hubs.flatMap((hub) => hub.nodes);
    expect(nodes.filter(isDirectRoute).map((node) => node.name)).toEqual(["Studio desktop", "Work laptop"]);
    const [global, regional] = fleet.hubs;
    if (!global || !regional) throw new Error("expected two hubs");
    expect(hubRoutedNodes(global).map((node) => node.name)).toEqual(["Home server", "Lab NUC"]);
    expect(hubRoutedNodes(regional).map((node) => node.name)).toEqual(["Old MacBook"]);
    expect(hubWireState(hubRoutedNodes(regional))).toBe("still");
    expect(hubWireState(hubRoutedNodes(global))).toBe("live");
  });

  it("sits in the hub column with its wire from this device, so no relay hub lies on its way, while the hubs centre on the PCs behind them", () => {
    const layout = requireLayout(fleet);
    const direct = layout.pcs.filter((item) => item.via === "direct");
    const behind = layout.pcs.filter((item) => item.via === "hub");
    expect(direct.map((item) => item.node.name)).toEqual(["Studio desktop", "Work laptop"]);
    expect(behind.map((item) => item.node.name)).toEqual(["Home server", "Lab NUC", "Old MacBook"]);
    const [global, regional] = layout.hubs;
    if (!global || !regional) throw new Error("expected two hubs");
    for (const item of direct) {
      expect(item.x).toBe(global.x);
      const match = /^M(-?\d+) (-?\d+) /.exec(wire(layout.me, item));
      if (!match) throw new Error("invalid path");
      expect(Math.abs(Math.hypot(Number(match[1]) - layout.me.x, Number(match[2]) - layout.me.y) - layout.me.r)).toBeLessThanOrEqual(1.5);
    }
    for (const item of behind) expect(item.x).toBeGreaterThan(global.x);
    const lastDirect = direct[direct.length - 1];
    if (!lastDirect) throw new Error("expected direct PCs");
    expect(global.y - lastDirect.y).toBeGreaterThanOrEqual(76);
    expect(regional.y - global.y).toBeGreaterThanOrEqual(76);
    const all = boxes(layout);
    expect(all.flatMap((a, i) => all.slice(i + 1).filter((b) => overlaps(a, b)).map((b) => `${a.of} / ${b.of}`))).toEqual([]);
    const plain = requireLayout(modelOf([pc("Desk PC", "paired", GLOBAL, "2026-11-07T00:00:00Z"), pc("Lab box", "paired", REGIONAL, "2026-11-07T00:00:00Z")]));
    expect(plain.pcs.map((item) => item.via)).toEqual(["hub", "hub"]);
  });
});

describe("wire, status, and relay RTT helpers", () => {
  it("computes honest wire and StatusDot states from directory state and live check", () => {
    const hub = modelOf(
      [
        pc("a-lately", "paired", GLOBAL, "2026-11-07T00:00:00Z"),
        pc("b-unseen", "paired", GLOBAL, null),
        pc("c-checking", "paired", GLOBAL, "2026-11-07T00:00:00Z"),
        pc("d-answeredLocal", "paired", GLOBAL, null),
        pc("e-failedCheck", "paired", GLOBAL, "2026-11-07T00:00:00Z"),
        pc("f-approval", "needs-approval", GLOBAL, "2026-11-07T00:00:00Z"),
        pc("g-update", "needs-update", GLOBAL, "2026-11-07T00:00:00Z"),
        pc("h-offline", "offline", GLOBAL, "2026-11-01T00:00:00Z", true),
        pc("i-offlineAnswered", "offline", GLOBAL, "2026-11-01T00:00:00Z", true),
        { ...pc("j-updateAnswered", "needs-update", GLOBAL, "2026-11-07T00:00:00Z"), paired: true, linked: true },
      ],
      new Map<string, PcStatus>([
        ["c-checking", { kind: "checking" }],
        ["d-answeredLocal", { kind: "answered", route: "relay", relay: GLOBAL, rttMs: 31 }],
        ["e-failedCheck", { kind: "offline", reason: "pc" }],
        ["i-offlineAnswered", { kind: "answered", route: "lan", rttMs: 4 }],
        ["j-updateAnswered", { kind: "answered", route: "relay", relay: GLOBAL, rttMs: 40 }],
      ]),
    ).hubs[0];
    if (!hub) throw new Error("missing hub");
    const nodes = hub.nodes;

    expect(nodeWireState(requireNode(nodes, "a-lately"))).toBe("live");
    expect(nodeStatusDotState(requireNode(nodes, "a-lately"))).toBe("ready");

    expect(nodeWireState(requireNode(nodes, "b-unseen"))).toBe("still");
    expect(nodeStatusDotState(requireNode(nodes, "b-unseen"))).toBe("ready");

    expect(nodeWireState(requireNode(nodes, "c-checking"))).toBe("checking");
    expect(nodeStatusDotState(requireNode(nodes, "c-checking"))).toBe("checking");

    expect(nodeWireState(requireNode(nodes, "d-answeredLocal"))).toBe("live");
    expect(nodeStatusDotState(requireNode(nodes, "d-answeredLocal"))).toBe("ready");

    expect(nodeWireState(requireNode(nodes, "e-failedCheck"))).toBe("off");

    expect(nodeStatusDotState(requireNode(nodes, "f-approval"))).toBe("needs-you");
    expect(nodeStatusDotState(requireNode(nodes, "g-update"))).toBe("needs-you");
    expect(nodeWireState(requireNode(nodes, "h-offline"))).toBe("off");
    expect(nodeStatusDotState(requireNode(nodes, "h-offline"))).toBe("offline");
    expect(nodeWireState(requireNode(nodes, "i-offlineAnswered"))).toBe("live");
    expect(nodeStatusDotState(requireNode(nodes, "i-offlineAnswered"))).toBe("ready");
    expect(nodeWireState(requireNode(nodes, "j-updateAnswered"))).toBe("live");
    expect(nodeStatusDotState(requireNode(nodes, "j-updateAnswered"))).toBe("needs-you");
  });

  it("aggregates hub wire state and shows the fastest answer through this relay across multiple measured PCs", () => {
    const map = modelOf(
      [
        pc("Studio desktop", "paired", REGIONAL, "2026-11-07T00:00:00Z"),
        pc("Work laptop", "paired", REGIONAL, "2026-11-07T00:00:00Z"),
        pc("LAN box", "paired", REGIONAL, "2026-11-07T00:00:00Z"),
        pc("Home server", "offline", GLOBAL, "2026-11-01T00:00:00Z", true),
      ],
      new Map<string, PcStatus>([
        ["Studio desktop", { kind: "answered", route: "relay", relay: REGIONAL, rttMs: 65 }],
        ["Work laptop", { kind: "answered", route: "relay", relay: REGIONAL, rttMs: 42 }],
        ["LAN box", { kind: "answered", route: "lan", rttMs: 8 }],
      ]),
    );
    const [hub0, hub1] = map.hubs;
    if (!hub0 || !hub1) throw new Error("expected two hubs");
    expect(hubWireState(hub0.nodes)).toBe("live");
    expect(hubWireState(hub1.nodes)).toBe("off");
    expect(relayHandshake(hub0)).toEqual({ rttMs: 42, pcName: "Work laptop" });
    expect(relayHandshakeMs(hub0)).toBe(42);
    expect(relayHandshake(hub1)).toBeNull();
    expect(relayHandshakeMs(hub1)).toBeNull();
  });

  it("places label anchors and clips long strings with CJK double-width accounting", () => {
    expect(placeLabel({ x: 100, y: 100, r: 18, side: "right" }, 2).anchor).toBe("start");
    expect(placeLabel({ x: 100, y: 100, r: 18, side: "below" }, 1).anchor).toBe("middle");
    expect(clip("Workstation number 12")).toBe("Workstation number…");
    expect(clip("Home server")).toBe("Home server");
    expect(clip("거실 책상 아래 서버 컴퓨터 하나")).toBe("거실 책상 아래 서…");
  });
});
