import { describe, expect, it } from "bun:test";
import { NEW_PC_MS, type MyPc } from "../account/myPcs.ts";
import type { PcStatus } from "./pcStatus.ts";
import type { DashboardPc } from "./dashboard.ts";
import { dashboardModel, dashboardPcs, dashboardState, relayHost } from "./dashboard.ts";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const GLOBAL = "wss://relay.ovis.sh";

function pc(server_id: string, state: DashboardPc["state"], relay: string | null = null, last_seen_at: string | null = null): DashboardPc {
  return {
    server_id, name: server_id, state, relay, last_seen_at, added_at: null,
    listed: true, paired: state === "paired", linked: false,
  };
}

function fresh(server_id: string, ago: number): DashboardPc {
  return { ...pc(server_id, "needs-approval"), added_at: new Date(NOW - ago).toISOString(), join: { server_public_key: "k", relay: GLOBAL } };
}

const model = (pcs: readonly DashboardPc[], status?: ReadonlyMap<string, PcStatus>) =>
  dashboardModel(pcs, { label: "Me", now: NOW, ...(status ? { status } : {}) }, GLOBAL);

describe("dashboardModel counts and filters", () => {
  it("counts Needs you as approval, update and offline together, overlapping Offline", () => {
    const m = model([pc("paired", "paired"), pc("approval", "needs-approval"), pc("update", "needs-update"), pc("offline", "offline")]);
    expect(m.counts).toEqual({ ready: 1, needsYou: 3, offline: 1, paired: 1 });
    expect(m.filters.needs).toEqual(["approval", "update", "offline"]);
    expect(m.filters.offline).toEqual(["offline"]);
  });

  it("derives every count, the attention list and the Needs filter from one membership", () => {
    const m = model([pc("a", "needs-approval"), pc("b", "offline"), pc("c", "paired"), pc("d", "needs-update"), pc("e", "offline")]);
    expect(m.counts.needsYou).toBe(m.filters.needs.length);
    expect(m.counts.ready).toBe(m.filters.ready.length);
    expect(m.counts.offline).toBe(m.filters.offline.length);
    expect(m.attention.map(({ server_id }) => server_id).sort()).toEqual([...m.filters.needs].sort());
    expect(m.filters.all).toEqual(m.rows.map(({ server_id }) => server_id));
  });

  it("reads 0/4/1 for the preview fleet of four unpaired PCs, one of them offline", () => {
    const m = model([pc("Studio desktop", "needs-approval"), pc("Work laptop", "needs-approval"), pc("Home server", "offline"), pc("Old MacBook", "needs-approval")]);
    expect([m.counts.ready, m.counts.needsYou, m.counts.offline]).toEqual([0, 4, 1]);
  });

  it("returns zero counts, empty filters and no relay groups for an empty fleet", () => {
    expect(model([])).toMatchObject({
      counts: { ready: 0, needsYou: 0, offline: 0, paired: 0 },
      filters: { all: [], ready: [], needs: [], offline: [] },
      attention: [], relays: [], map: { hubs: [] },
    });
  });

  it("asks nothing of an all-ready fleet", () => {
    const m = model([pc("a", "paired"), pc("b", "paired")]);
    expect(m.counts).toEqual({ ready: 2, needsYou: 0, offline: 0, paired: 2 });
    expect(m.attention).toEqual([]);
  });
});

describe("dashboardModel provenance", () => {
  it("says a PC the directory does not list is known to this device alone, and not checked until a check returns", () => {
    const local = { ...pc("qr", "paired"), listed: false };
    const [row] = model([local]).rows;
    expect(row).toMatchObject({ source: "this-device", check: null });
    expect(model([local]).counts.ready).toBe(0);
    expect(model([local]).filters.ready).toEqual([]);
    expect(model([local]).attention).toEqual([]);
    expect(model([local], new Map([["qr", { kind: "checking" }]])).rows[0]?.check).toEqual({ kind: "checking" });
  });

  it("preserves raw directory provenance while a live answer determines readiness everywhere", () => {
    const answered: PcStatus = { kind: "answered", route: "relay", relay: GLOBAL, rttMs: 42 };
    const stale = { ...pc("home", "offline", null, "2026-11-01T00:00:00Z"), paired: true };
    const m = model([stale], new Map([["home", answered]]));
    expect(m.rows[0]).toMatchObject({ state: "offline", source: "directory", check: answered });
    expect([m.counts.offline, m.counts.needsYou, m.counts.ready]).toEqual([0, 0, 1]);
    expect(m.map.hubs[0]?.nodes[0]).toMatchObject({ state: "paired", seen: "stale", check: answered });
  });

  it("puts no probe on a PC this device is not paired with", () => {
    const m = model([pc("join", "needs-approval")], new Map([["join", { kind: "offline", reason: "pc" }]]));
    expect(m.rows[0]?.check).toBeNull();
  });
});

describe("this device's own check of a paired PC", () => {
  const answered: PcStatus = { kind: "answered", route: "relay", relay: GLOBAL, rttMs: 41 };
  const nobody: PcStatus = { kind: "offline", reason: "pc" };
  const unreached: PcStatus = { kind: "offline", reason: "relay" };
  const turnedAway: PcStatus = { kind: "offline", reason: "refused" };

  // `paired`: the account heard from it lately; `offline`: it confirmed it has not for fifteen minutes (a failed read ages
  // no row, accountController.ts). An answer beats that Offline, nobody at the relay is Machine offline whatever the account
  // last heard, and a relay this device could not reach, or that turned it away, says nothing of the PC, so the account's
  // word stands beside it. A re-check in flight keeps the last finished check's word; before any has finished, the account's
  // word stands
  it.each([
    ["paired", null, "paired"], ["paired", { kind: "checking" }, "paired"], ["paired", answered, "paired"],
    ["paired", nobody, "offline"], ["paired", unreached, "unreachable"], ["paired", turnedAway, "unreachable"],
    ["paired", { kind: "checking", previous: nobody }, "offline"], ["paired", { kind: "checking", previous: unreached }, "unreachable"],
    ["offline", null, "offline"], ["offline", { kind: "checking" }, "offline"], ["offline", answered, "paired"],
    ["offline", nobody, "offline"], ["offline", unreached, "offline"], ["offline", turnedAway, "offline"],
    ["offline", { kind: "checking", previous: answered }, "paired"], ["offline", { kind: "checking", previous: unreached }, "offline"],
  ] as const)("reads a listed PC the account calls %s, checked %j, as %s", (state, check, expected) => {
    expect(dashboardState({ state, listed: true }, check)).toBe(expected);
  });

  it("reads a pairing the account does not list by the check alone", () => {
    expect([null, answered, nobody, unreached].map((check) => dashboardState({ state: "paired", listed: false }, check))).toEqual(["unchecked", "paired", "offline", "unreachable"]);
  });

  it("puts a PC nobody answered for under Offline and Needs you, and one this device could not reach under Needs you alone: neither is Ready", () => {
    const m = model([pc("off", "paired"), pc("far", "paired"), pc("up", "paired")], new Map<string, PcStatus>([["off", nobody], ["far", unreached], ["up", answered]]));
    expect(m.counts).toEqual({ ready: 1, needsYou: 2, offline: 1, paired: 3 });
    expect([m.filters.ready, m.filters.offline, m.filters.needs]).toEqual([["up"], ["off"], ["far", "off"]]);
    expect(m.attention.map(({ server_id, reason }) => [server_id, reason])).toEqual([["far", "unreachable"], ["off", "offline"]]);
    expect(Object.fromEntries(m.map.hubs[0]?.nodes.map((node) => [node.server_id, node.state]) ?? [])).toEqual({ far: "unreachable", off: "offline", up: "paired" });
  });
});

describe("dashboardModel urgency", () => {
  it("orders attention by nearest Add expiry, then updates, other approvals and offline, names breaking ties", () => {
    const m = model([
      pc("z-offline", "offline"), pc("b-approval", "needs-approval"), pc("a-approval", "needs-approval"),
      pc("update", "needs-update"), fresh("new-late", 2 * 60_000), fresh("new-soon", 8 * 60_000), pc("ready", "paired"),
    ]);
    expect(m.attention.map(({ server_id, reason }) => [server_id, reason])).toEqual([
      ["new-soon", "needs-approval"], ["new-late", "needs-approval"], ["update", "needs-update"],
      ["a-approval", "needs-approval"], ["b-approval", "needs-approval"], ["z-offline", "offline"],
    ]);
    expect(m.attention[0]?.expiresAt).toBe(NOW + 2 * 60_000);
    expect(m.attention.find(({ server_id }) => server_id === "a-approval")?.expiresAt).toBeNull();
  });

  it("closes the Add window at exactly ten minutes", () => {
    const m = model([fresh("closed", NEW_PC_MS), fresh("open", NEW_PC_MS - 1)]);
    expect(m.attention.map(({ server_id, expiresAt }) => [server_id, expiresAt])).toEqual([["open", NOW + 1], ["closed", null]]);
  });

  it("offers no Add window to a new PC that already came by the account service: it pulls only once it belongs to the account", () => {
    const inAccount: DashboardPc = { ...fresh("in-account", 2 * 60_000), last_seen_at: new Date(NOW - 30_000).toISOString() };
    const m = model([inAccount, fresh("waiting", 2 * 60_000)]);
    expect(m.attention.map(({ server_id, expiresAt }) => [server_id, expiresAt])).toEqual([["waiting", NOW + 8 * 60_000], ["in-account", null]]);
  });

  it("offers no Add window to a new PC without a join route, and puts a PC without a relay under the default one", () => {
    const routeless: DashboardPc = { ...pc("routeless", "needs-approval"), added_at: new Date(NOW - 60_000).toISOString() };
    const m = model([routeless, pc("update", "needs-update")]);
    expect(m.attention.map(({ server_id, expiresAt }) => [server_id, expiresAt])).toEqual([["update", null], ["routeless", null]]);
    expect(m.relays).toEqual([{ origin: GLOBAL, regional: false, pcs: ["routeless", "update"] }]);
  });

  it("orders the table action-required, offline, ready, by name then server id within a group", () => {
    const twin = (id: string): DashboardPc => ({ ...pc(id, "paired"), name: "Twin" });
    const m = model([twin("id-b"), pc("Alpha", "paired"), pc("Zed", "offline"), pc("Mid", "needs-update"), twin("id-a"), pc("Beta", "needs-approval")]);
    expect(m.filters.all).toEqual(["Beta", "Mid", "Zed", "Alpha", "id-a", "id-b"]);
  });

  it("gives the same order for any input order across a thousand PCs", () => {
    const states = ["paired", "needs-approval", "offline", "needs-update"] as const;
    const fleet = Array.from({ length: 1000 }, (_, i) => ({ ...pc(`pc-${String(i).padStart(4, "0")}`, states[i % 4] ?? "paired"), name: `PC ${i % 37}` }));
    const forward = model(fleet);
    const backward = model([...fleet].reverse());
    expect(backward.filters).toEqual(forward.filters);
    expect(backward.attention).toEqual(forward.attention);
    expect(forward.counts).toEqual({ ready: 250, needsYou: 750, offline: 250, paired: 250 });
    const groups = forward.rows.map(({ state }) => (state === "paired" ? 2 : state === "offline" ? 1 : 0));
    expect(groups).toEqual([...groups].sort((a, b) => a - b));
  });
});

describe("dashboardModel relays and map", () => {
  it("groups PCs by relay, the busiest first, in table order inside each", () => {
    const regional = "wss://relay-ap.ovis.sh";
    const m = model([pc("c", "paired", regional), pc("a", "paired", GLOBAL), pc("b", "offline", GLOBAL)]);
    expect(m.relays).toEqual([
      { origin: GLOBAL, regional: false, pcs: ["b", "a"] },
      { origin: regional, regional: true, pcs: ["c"] },
    ]);
    expect(m.map.hubs.map((hub) => hub.origin)).toEqual([GLOBAL, regional]);
  });

  it("marks only configured regional relay origins as regional", () => {
    const m = model([pc("regional", "paired", "wss://relay-ap.ovis.sh"), pc("self-hosted", "paired", "wss://relay.example.test")]);
    expect(Object.fromEntries(m.relays.map(({ origin, regional }) => [origin, regional]))).toEqual({
      "wss://relay-ap.ovis.sh": true,
      "wss://relay.example.test": false,
    });
  });

  it("marks paired, unknown, and offline sightings", () => {
    const m = model([
      pc("seen", "paired", null, "2026-11-07T00:00:00Z"),
      pc("never-seen", "paired"),
      pc("old", "offline", null, "2026-11-01T00:00:00Z"),
      pc("approval-seen", "needs-approval", null, "2026-11-07T00:00:00Z"),
      pc("approval-unknown", "needs-approval"),
    ]);
    expect(Object.fromEntries(m.map.hubs[0]?.nodes.map((node) => [node.server_id, node.seen]) ?? [])).toEqual({
      seen: "lately", "never-seen": "unknown", old: "stale", "approval-seen": "unknown", "approval-unknown": "unknown",
    });
    expect(Object.fromEntries(m.map.hubs[0]?.nodes.map((node) => [node.server_id, node.last_seen_at]) ?? [])).toEqual({
      seen: "2026-11-07T00:00:00Z", "never-seen": null, old: "2026-11-01T00:00:00Z", "approval-seen": "2026-11-07T00:00:00Z", "approval-unknown": null,
    });
  });

  it("names a relay by its host, and an origin that is not a URL as it is", () => {
    expect(relayHost("wss://relay-ap.ovis.sh")).toBe("relay-ap.ovis.sh");
    expect(relayHost("wss://relay.example:8443/path")).toBe("relay.example:8443");
    expect(relayHost("not a url")).toBe("not a url");
    expect(relayHost("wss://relay.example:443")).toBe("relay.example");
  });
});

describe("dashboardPcs", () => {
  const row = (server_id: string, state: MyPc["state"], extra: Partial<MyPc> = {}): MyPc => ({ server_id, name: server_id, state, last_seen_at: null, added_at: null, listed: false, paired: state === "paired", linked: false, ...extra });
  const relayOf = (pcs: readonly DashboardPc[]) => Object.fromEntries(pcs.map(({ server_id, relay }) => [server_id, relay]));

  it("takes the directory's relay for a PC the account lists, its join route's for one this device is not paired with, and the pairing's for one paired without the account", () => {
    const pcs = dashboardPcs(
      [row("listed", "paired", { listed: true }), row("joinable", "needs-approval", { listed: true, join: { server_public_key: "k", relay: "wss://relay-ap.ovis.sh" } }), row("qr", "paired")],
      [{ server_id: "listed", relay: "wss://relay.old.example" }, { server_id: "qr", relay: "wss://relay.example" }],
      [{ server_id: "listed", relay: "wss://relay.ovis.sh" }, { server_id: "joinable", relay: "wss://relay-ap.ovis.sh" }],
    );
    expect(relayOf(pcs)).toEqual({ listed: "wss://relay.ovis.sh", joinable: "wss://relay-ap.ovis.sh", qr: "wss://relay.example" });
    expect(pcs.find(({ server_id }) => server_id === "listed")).toMatchObject({ state: "paired", listed: true, paired: true });
  });

  it("falls back from a directory entry without a relay to the pairing's, and to null when neither knows one", () => {
    const pcs = dashboardPcs(
      [row("paired", "paired", { listed: true }), row("unknown", "needs-approval", { listed: true })],
      [{ server_id: "paired", relay: "wss://relay.example" }],
      [{ server_id: "paired", relay: null }, { server_id: "unknown", relay: null }],
    );
    expect(relayOf(pcs)).toEqual({ paired: "wss://relay.example", unknown: null });
    expect(model(pcs).relays.map(({ origin, pcs: ids }) => [origin, ids])).toEqual([["wss://relay.example", ["paired"]], ["wss://relay.ovis.sh", ["unknown"]]]);
  });

  it("works without a directory: every saved pairing is a local PC on its own relay", () => {
    expect(dashboardPcs([row("a", "paired")], [{ server_id: "a", relay: "wss://relay-ap.ovis.sh" }]).map(({ relay }) => relay)).toEqual(["wss://relay-ap.ovis.sh"]);
  });
});
