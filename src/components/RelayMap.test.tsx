import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { dashboardModel } from "../lib/relay/dashboard.ts";
import type { DashboardPc } from "../lib/relay/dashboard.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import { clip, layoutRelayMap, placeLabel, RelayMap } from "./RelayMap.tsx";
import type { RelayMapModel, RelayMapProps } from "./RelayMap.tsx";

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

const mockup = (status?: ReadonlyMap<string, PcStatus>): RelayMapModel =>
  dashboardModel(
    [
      pc("Desk PC", "paired", REGIONAL, "2026-11-07T00:00:00Z"),
      pc("MacBook", "paired", REGIONAL),
      pc("Mac mini", "needs-approval", REGIONAL, "2026-11-07T00:00:00Z"),
      pc("Home server", "offline", GLOBAL, "2026-11-01T00:00:00Z", true),
    ],
    { label: "This iPhone", ...(status ? { status } : {}) },
    GLOBAL,
  ).map;

const render = (props: RelayMapProps | RelayMapModel, language: "en" | "ko" | "ja" | "zh" = "en"): string => {
  const mapProps: RelayMapProps = "me" in props && "hubs" in props ? { map: props } : props;
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: [language] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(RelayMap, mapProps) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

const wires = (html: string): Record<string, string> =>
  Object.fromEntries([...html.matchAll(/class="relay-map-edge" data-wire="(\w+)" data-pc="([^"]+)"/g)].map(([, w, id]) => [id ?? "", w ?? ""]));
const count = (html: string, pattern: RegExp): number => (html.match(pattern) ?? []).length;

describe("the connection map", () => {
  it("keeps settled wires still without particles, and animates only active checks", () => {
    const html = render(mockup());
    expect(count(html, /class="relay-map-hub-btn"/g)).toBe(2);
    expect(count(html, /class="relay-map-flow"/g)).toBe(0);
    expect(count(html, /class="relay-map-dot"/g)).toBe(0);
    expect(html).not.toContain("animateMotion");
    expect(html).not.toContain("relay-map-orbit");
    expect(wires(html)).toEqual({ "Desk PC": "live", "MacBook": "still", "Mac mini": "still", "Home server": "off" });
    expect(html).toContain('data-pc-state="paired" data-seen="lately"');

    const checking = render(mockup(new Map([["Desk PC", { kind: "checking" }]])));
    expect(wires(checking)["Desk PC"]).toBe("checking");
    expect(count(checking, /class="relay-map-flow"/g)).toBe(2);
    expect(count(checking, /class="relay-map-dot"/g)).toBe(0);
  });

  it("keeps a still wire and neutral Paired · not checked label for an unchecked local/unlisted pairing", () => {
    const localMap = dashboardModel(
      [
        { ...pc("Home server", "paired", GLOBAL, null), listed: false },
        { ...pc("Lab NUC", "paired", REGIONAL, null), listed: false },
      ],
      { label: "This iPhone" },
      GLOBAL,
    ).map;
    const html = render(localMap);
    expect(wires(html)).toEqual({ "Home server": "still", "Lab NUC": "still" });
    expect(html).toContain("Paired · not checked");
    const legend = /<ul class="relay-map-legend"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? "";
    expect(legend).not.toContain('data-state="ready"');
  });

  it("reconciles live check results and labels hub RTT as the fastest answer through this relay", () => {
    const answeredSlow: PcStatus = { kind: "answered", route: "relay", relay: REGIONAL, rttMs: 68 };
    const answeredFast: PcStatus = { kind: "answered", route: "relay", relay: REGIONAL, rttMs: 42 };
    const html = render(mockup(new Map([["Desk PC", answeredSlow], ["MacBook", answeredFast]])));
    expect(wires(html)["MacBook"]).toBe("live");
    expect(html).toContain("Fastest PC handshake · 42 ms");
    expect(html).not.toContain("Fastest PC handshake · 68 ms");
    expect(count(html, /<time[^>]*dateTime="2026-11-07T00:00:00Z"[^>]*title="[^"]+"/g)).toBe(4);
    expect(count(html, /<span class="relay-map-tooltip-seen">Last seen: unknown<\/span>/g)).toBe(2);
  });

  it("exposes one accessible route list and figcaption without duplicate SVG aria-label", () => {
    const html = render(mockup());
    expect(html).toContain("<figcaption");
    expect(count(html, /<svg class="relay-map-svg"[^>]*aria-hidden="true"/g)).toBe(1);
    expect(count(html, /<ol class="relay-map-routes"[^>]*aria-label="Relays"/g)).toBe(1);
    expect(html).not.toMatch(/\b(session|online|connected)\b/i);
  });

  it("lists every relay with its host, PC count, regional/global scope, connector link, and the PCs behind it", () => {
    const html = render(mockup());
    const routes = html.slice(html.indexOf('<ol class="relay-map-routes"'));
    expect(count(routes, /class="relay-map-route"/g)).toBe(2);
    expect(count(routes, /class="relay-map-link"/g)).toBe(2);
    expect(count(routes, /class="relay-map-link"[^>]*data-wire="live"/g)).toBe(1);
    expect(count(routes, /class="relay-map-link"[^>]*data-wire="off"/g)).toBe(1);
    expect(routes.indexOf("This iPhone")).toBeLessThan(routes.indexOf("relay-ap.ovis.sh"));
    expect(routes.indexOf("relay-ap.ovis.sh")).toBeLessThan(routes.indexOf("Desk PC"));
    expect(routes.indexOf("relay.ovis.sh")).toBeLessThan(routes.indexOf("Home server"));
    expect(routes).toContain("regional");
    expect(routes).toContain("global");
    expect(count(routes, /data-pc-state=/g)).toBe(4);
  });

  it("renders the diagram for 1..8 PCs and switches to list-only for 9+ PCs", () => {
    const eight = dashboardModel(
      Array.from({ length: 8 }, (_, i) => pc(`PC ${i + 1}`, "paired", i % 2 === 0 ? REGIONAL : GLOBAL, "2026-11-07T00:00:00Z")),
      { label: "Me" },
      GLOBAL,
    ).map;
    const html8 = render(eight);
    expect(count(html8, /class="relay-map-svg"/g)).toBe(1);

    const nine = dashboardModel(
      Array.from({ length: 9 }, (_, i) => pc(`PC ${i + 1}`, "paired", i % 2 === 0 ? REGIONAL : GLOBAL, "2026-11-07T00:00:00Z")),
      { label: "Me" },
      GLOBAL,
    ).map;
    const html9 = render(nine);
    expect(count(html9, /class="relay-map-svg"/g)).toBe(0);
    expect(count(html9, /class="relay-map-routes"/g)).toBe(1);
    expect(count(html9, /data-pc-state="paired"/g)).toBe(9);
  });

  it("shows empty state in standalone Relay view and nothing on Overview when fleet has 0 PCs", () => {
    const emptyMap = dashboardModel([], { label: "This iPhone" }, GLOBAL).map;
    expect(render(emptyMap)).toBe("");
    const standaloneEmpty = render({ map: emptyMap, standalone: true });
    expect(standaloneEmpty).toContain("relay-map-empty");
    expect(standaloneEmpty).not.toContain("relay-map-svg");
  });

  it("wires every PC to its own relay hub in the middle tier", () => {
    const relays = [REGIONAL, GLOBAL, SELF];
    const map = dashboardModel(
      Array.from({ length: 6 }, (_, i) => pc(`pc-${i}`, "paired", relays[i % 3] ?? GLOBAL)),
      { label: "Me" },
      GLOBAL,
    ).map;
    const layout = layoutRelayMap(map);
    if (!layout) throw new Error("expected layout");
    const html = render(map);
    const starts = Object.fromEntries(
      [...html.matchAll(/class="relay-map-edge" data-wire="\w+" data-pc="([^"]+)" d="M(-?\d+) (-?\d+)/g)].map(([, id, x, y]) => [
        id ?? "",
        [Number(x), Number(y)],
      ]),
    );
    const strays = layout.pcs.flatMap((item) => {
      const hub = layout.hubs[item.hub];
      const coords = starts[item.node.server_id];
      if (!hub || !coords) return [`missing ${item.node.server_id}`];
      const [x, y] = coords;
      const gap = Math.abs(Math.hypot((x ?? 0) - hub.x, (y ?? 0) - hub.y) - hub.r);
      return gap <= 1.5 ? [] : [`${item.node.server_id} leaves ${hub.origin} ${gap.toFixed(1)} off its ring`];
    });
    expect(Object.keys(starts)).toHaveLength(6);
    expect(strays).toEqual([]);
  });

  it("draws a PC this device reached directly from this device itself, names its route, and lists it as a route of its own before the relays", () => {
    const html = render(mockup(new Map<string, PcStatus>([
      ["Desk PC", { kind: "answered", route: "lan", rttMs: 4 }],
      ["MacBook", { kind: "answered", route: "relay", relay: REGIONAL, rttMs: 62 }],
    ])));
    const layout = layoutRelayMap(mockup(new Map<string, PcStatus>([["Desk PC", { kind: "answered", route: "lan", rttMs: 4 }], ["MacBook", { kind: "answered", route: "relay", relay: REGIONAL, rttMs: 62 }]])));
    if (!layout) throw new Error("expected layout");
    const edges = Object.fromEntries([...html.matchAll(/class="relay-map-edge" data-wire="\w+" data-pc="([^"]+)" d="M(-?\d+) (-?\d+)[^"]*" data-via="(\w+)"/g)].map(([, id, x, y, via]) => [id ?? "", { x: Number(x), y: Number(y), via }]));
    expect(edges["Desk PC"]?.via).toBe("direct");
    expect(edges["Desk PC"]?.x).toBe(layout.me.x + layout.me.r);
    expect(edges["Desk PC"]?.y).toBe(layout.me.y);
    expect(edges["MacBook"]?.via).toBe("hub");
    expect(html).toMatch(/class="relay-map-edge" data-wire="live" data-hub="wss:\/\/relay-ap\.ovis\.sh"/);
    expect(html).toContain("Same network · 4 ms");
    expect(html).toContain("relay-ap.ovis.sh · 62 ms");
    expect(html).not.toContain("Answers");
    const routes = html.slice(html.indexOf('<ol class="relay-map-routes"'));
    expect(count(routes, /class="relay-map-route" data-route="direct"/g)).toBe(1);
    expect(routes.indexOf("Desk PC")).toBeLessThan(routes.indexOf("relay-ap.ovis.sh"));
    expect(count(routes, /data-pc-id="Desk PC"/g)).toBe(1);
    expect(count(routes, /data-pc-state=/g)).toBe(4);
  });

  it("names a PC's specific state on its node, in its tooltip and in the route list, keeping Needs you for the legend alone", () => {
    const html = render(dashboardModel([
      pc("Mac mini", "needs-approval", REGIONAL, "2026-11-07T00:00:00Z"),
      { ...pc("Build box", "paired", GLOBAL, "2026-11-07T00:00:00Z"), state: "needs-update" },
    ], { label: "This iPhone" }, GLOBAL).map);
    expect(count(html, /<span class="relay-map-word">Needs approval<\/span>/g)).toBe(1);
    expect(count(html, /<span class="relay-map-word">Needs update<\/span>/g)).toBe(1);
    expect(count(html, /<small class="relay-map-hop-note">Needs approval<\/small>/g)).toBe(1);
    expect(count(html, /<small class="relay-map-hop-note">Needs update<\/small>/g)).toBe(1);
    expect(html).toContain("Mac mini · Needs approval · ");
    expect(html).toContain("Build box · Needs update · Update Ovis on it · ");
    const legend = /<ul class="relay-map-legend"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? "";
    expect(legend).toContain("Needs you");
    expect(html.replace(legend, "").replace(/aria-label="[^"]*"/g, "")).not.toContain("Needs you");
  });

  it("preserves full PC names via title attributes on truncated labels", () => {
    const longName = "Workstation on the third floor lab bench with a very long name";
    const map = dashboardModel([pc(longName, "paired", GLOBAL, "2026-11-07T00:00:00Z")], { label: "Me" }, GLOBAL).map;
    const html = render(map);
    expect(html).toContain(`title="${longName}"`);
    expect(clip(longName)).toBe("Workstation on the…");
    expect(placeLabel({ x: 100, y: 100, r: 18, side: "right" }, 2).anchor).toBe("start");
    const pills = [...html.matchAll(/<span class="pill relay-map-host">([^<]*)<\/span>/g)].map(([, host]) => host);
    expect(pills).toEqual(["relay.ovis.sh", "relay.ovis.sh"]);
    expect(html).not.toMatch(/relay-map-host[^>]*title=/);
  });

  it("lets a live answer from this device beat the directory's stale Offline on every map surface, and keeps Needs update with the measured route beside it", () => {
    const status = new Map<string, PcStatus>([
      ["Home server", { kind: "answered", route: "lan", rttMs: 4 }],
      ["Old box", { kind: "answered", route: "tailscale", rttMs: 18 }],
    ]);
    const reached = dashboardModel(
      [pc("Home server", "offline", GLOBAL, "2026-11-01T00:00:00Z", true), { ...pc("Old box", "needs-update", GLOBAL, "2026-11-07T00:00:00Z"), paired: true, linked: true }, pc("Dark box", "offline", GLOBAL, "2026-11-01T00:00:00Z", true)],
      { label: "This iPhone", status },
      GLOBAL,
    ).map;
    const html = render(reached);
    const nodeOf = (name: string) => new RegExp(`data-pc-node="${name}"[^>]*title="([^"]+)"[\\s\\S]*?<span class="relay-map-word">([^<]+)</span>`).exec(html)?.slice(1) ?? [];
    const [homeTitle, homeWord] = nodeOf("Home server");
    expect(homeWord).toBe("Same network · 4 ms");
    expect(homeTitle).toStartWith("Home server · Same network · 4 ms · Last seen");
    const [boxTitle, boxWord] = nodeOf("Old box");
    expect(boxWord).toBe("Needs update");
    expect(boxTitle).toStartWith("Old box · Needs update · Update Ovis on it · Tailscale · 18 ms · Last seen");
    expect(new RegExp('data-pc-node="Home server"[\\s\\S]*?<svg class="status-dot" data-state="ready"').test(html)).toBe(true);
    expect(wires(html)).toEqual({ "Home server": "live", "Old box": "live", "Dark box": "off" });
    expect(html).toMatch(/data-pc="Home server"[^>]*data-via="direct"/);
    const routes = html.slice(html.indexOf('<ol class="relay-map-routes"'));
    expect([...routes.matchAll(/<small class="relay-map-hop-note">([^<]+)<\/small>/g)].map(([, word]) => word)).toEqual(["Needs update", "Same network · 4 ms", "Machine offline"]);
    expect(/data-pc-id="Home server"[^>]*title="([^"]+)"/.exec(routes)?.[1]).not.toContain("Offline");
  });
});

describe("interactive RelayMap in a browser", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let observerCallback: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
  const nodeMock = () => ({
    isConnected: true,
    focus() {},
    contains: () => false,
    querySelectorAll: () => [],
    getClientRects: () => [],
    closest: () => null,
    addEventListener() {},
    removeEventListener() {},
    pauseAnimations() {},
    unpauseAnimations() {},
  });

  beforeEach(() => {
    observerCallback = null;
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "matchMedia", "IntersectionObserver", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
      key: () => null,
      length: 0,
      clear: () => store.clear(),
    };
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    class MockIntersectionObserver {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        observerCallback = cb;
      }
      observe(): void {}
      disconnect(): void {}
    }
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: MockIntersectionObserver });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { href: "https://app.ovis.sh/", hash: "", search: "", origin: "https://app.ovis.sh", pathname: "/" },
        localStorage: storage,
        matchMedia,
        addEventListener() {},
        removeEventListener() {},
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
        body: { nodeType: 1, children: [], createNodeMock: nodeMock },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {},
      },
    });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  it("selects the corresponding PC on keyboard activation or click, and filters by relay when a hub is activated", async () => {
    const selectedPcs: string[] = [];
    const selectedRelays: string[] = [];
    await act(async () => {
      renderer = create(
        createElement(SettingsProvider, {
          children: createElement(RelayMap, {
            map: mockup(),
            selectedPcId: "Mac mini",
            onSelectPc: (id) => selectedPcs.push(id),
            onSelectRelay: (origin) => selectedRelays.push(origin),
          }),
        }),
        { createNodeMock: nodeMock },
      );
    });
    if (!renderer) throw new Error("expected renderer");

    const pcButtons = renderer.root.findAll((node) => node.type === "button" && node.props["data-pc-id"] !== undefined);
    expect(pcButtons.map((node) => node.props["data-pc-id"])).toEqual(["Mac mini", "Desk PC", "MacBook", "Home server"]);
    const deskBtn = pcButtons.find((node) => node.props["data-pc-id"] === "Desk PC");
    if (!deskBtn) throw new Error("missing Desk PC button");
    await act(async () => { deskBtn.props.onClick(); });
    expect(selectedPcs).toEqual(["Desk PC"]);

    const relayButtons = renderer.root.findAll((node) => node.type === "button" && node.props["data-relay-origin"] !== undefined);
    expect(relayButtons.map((node) => node.props["data-relay-origin"])).toEqual([REGIONAL, GLOBAL]);
    const firstRelay = relayButtons[0];
    if (!firstRelay) throw new Error("missing first relay button");
    await act(async () => { firstRelay.props.onClick(); });
    expect(selectedRelays).toEqual([REGIONAL]);
  });

  it("pauses checking wire animations when the map scrolls offscreen", async () => {
    const checkingMap = mockup(new Map([["Desk PC", { kind: "checking" }]]));
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: createElement(RelayMap, { map: checkingMap }) }), { createNodeMock: nodeMock });
    });
    if (!renderer) throw new Error("expected renderer");
    const svg = renderer.root.find((node) => node.type === "svg" && node.props.className === "relay-map-svg");
    expect(svg.props["data-paused"]).toBeUndefined();
    expect(observerCallback).not.toBeNull();
    await act(async () => { observerCallback?.([{ isIntersecting: false }]); });
    expect(svg.props["data-paused"]).toBe("");
    await act(async () => { observerCallback?.([{ isIntersecting: true }]); });
    expect(svg.props["data-paused"]).toBeUndefined();
  });
});
