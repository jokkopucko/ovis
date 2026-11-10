import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { NEW_PC_MS } from "../lib/account/myPcs.ts";
import { dashboardModel, dashboardPcs, type DashboardFilter, type DashboardPc } from "../lib/relay/dashboard.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { CHECK_AGAIN_BUSY_MS, COPIED_MS, relayLatencyMs, RelayOverview, WINDOWS_INSTALLER_COMMAND, type RelayOverviewProps } from "./RelayOverview.tsx";
import { INSTALLER_COMMAND } from "./RelayShellScreens.tsx";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const GLOBAL = "wss://relay.ovis.sh";
const AP = "wss://relay-ap.ovis.sh";

function makePc(server_id: string, name: string, state: DashboardPc["state"], extra: Partial<DashboardPc> = {}): DashboardPc {
  return {
    server_id,
    name,
    state,
    relay: GLOBAL,
    last_seen_at: state === "paired" ? new Date(NOW - 60_000).toISOString() : state === "offline" ? new Date(NOW - 2 * 3_600_000).toISOString() : null,
    added_at: new Date(NOW - 7 * 86_400_000).toISOString(),
    listed: true,
    paired: state === "paired",
    linked: state === "paired",
    ...extra,
  };
}

function f4Pcs(): DashboardPc[] {
  return [
    makePc("id_studio", "Studio desktop", "needs-approval", { relay: GLOBAL, join: { server_public_key: "k1", relay: GLOBAL } }),
    makePc("id_work", "Work laptop", "needs-approval", { relay: AP, join: { server_public_key: "k2", relay: AP } }),
    makePc("id_home", "Home server", "offline", { relay: GLOBAL, paired: false }),
    makePc("id_old", "Old MacBook", "needs-approval", { relay: AP, last_seen_at: null }),
  ];
}

function freadyPcs(): DashboardPc[] {
  return [
    makePc("id_studio", "Studio desktop", "paired", { relay: GLOBAL }),
    makePc("id_work", "Work laptop", "paired", { relay: AP }),
    makePc("id_home", "Home server", "offline", { relay: GLOBAL, paired: true, linked: true }),
    makePc("id_nuc", "Lab NUC", "paired", { relay: GLOBAL, listed: false, linked: false, last_seen_at: null }),
    makePc("id_mini", "New mini PC", "needs-approval", { relay: GLOBAL, added_at: new Date(NOW - 2 * 60_000).toISOString(), join: { server_public_key: "k_mini", relay: GLOBAL } }),
    makePc("id_old", "Old MacBook", "needs-approval", { relay: AP, last_seen_at: null, join: { server_public_key: "k_old", relay: AP } }),
  ];
}

function f20Pcs(): DashboardPc[] {
  const names = [
    "Studio desktop", "Work laptop", "Home server", "Build box", "Render node", "Media PC", "Lab NUC", "Office iMac", "Garage Pi", "Test rig A",
    "Test rig B", "CI runner 1", "CI runner 2", "Backup NAS", "Game PC", "Kids laptop", "Travel laptop", "Old MacBook", "Kitchen tablet PC", "Spare desktop",
  ];
  return names.map((name, i) => {
    const relay = i % 3 === 0 ? AP : GLOBAL;
    const paired = i < 12;
    const state: DashboardPc["state"] = i < 8 ? "paired" : i < 12 ? "offline" : "needs-approval";
    return makePc(`id_${String(i).padStart(2, "0")}`, name, state, {
      relay,
      paired,
      linked: paired,
      last_seen_at: i < 8 || (i >= 12 && i < 16) ? new Date(NOW - 60_000).toISOString() : i < 12 ? new Date(NOW - (2 + (i - 8)) * 86_400_000).toISOString() : null,
      ...(state === "needs-approval" && i < 16 ? { join: { server_public_key: `k_${i}`, relay } } : {}),
    });
  });
}

function localPcs(): DashboardPc[] {
  return dashboardPcs(
    [
      makePc("id_studio", "Studio desktop", "paired", { listed: false, linked: false, last_seen_at: null }),
      makePc("id_work", "Work laptop", "paired", { relay: AP, listed: false, linked: false, last_seen_at: null }),
      makePc("id_home", "Home server", "paired", { listed: false, linked: false, last_seen_at: null }),
      makePc("id_nuc", "Lab NUC", "paired", { listed: false, linked: false, last_seen_at: null }),
    ],
    [
      { server_id: "id_studio", relay: GLOBAL },
      { server_id: "id_work", relay: AP },
      { server_id: "id_home", relay: GLOBAL },
      { server_id: "id_nuc", relay: GLOBAL },
    ],
  );
}

const renderMarkup = (props: RelayOverviewProps, language: "en" | "ko" | "ja" | "zh" = "en"): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: [language] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(RelayOverview, props) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("RelayOverview", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let scheduledTimers: Map<number, { fn: () => void; ms: number }>;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "matchMedia", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    scheduledTimers = new Map();
    let nextTimerId = 1;
    const events = new EventTarget();
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
    class HTMLElement { isConnected = true; focus(): void {} }
    let rafId = 1;
    const cancelledRafs = new Set<number>();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { href: "https://app.ovis.sh/", search: "", origin: "https://app.ovis.sh", pathname: "/" },
        history: { state: null, replaceState() {} },
        localStorage: storage,
        matchMedia,
        innerWidth: 1440,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
        requestAnimationFrame: (cb: FrameRequestCallback) => {
          const id = rafId++;
          queueMicrotask(() => { if (!cancelledRafs.has(id)) cb(0); });
          return id;
        },
        cancelAnimationFrame: (id: number) => { cancelledRafs.add(id); },
        setTimeout: (fn: () => void, ms?: number) => {
          const id = nextTimerId++;
          scheduledTimers.set(id, { fn, ms: ms ?? 0 });
          return id;
        },
        clearTimeout: (id: number) => {
          scheduledTimers.delete(Number(id));
        },
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
        activeElement: new HTMLElement(),
        body: { nodeType: 1, children: [] },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
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

  const mount = async (shown: RelayOverviewProps): Promise<ReactTestInstance> => {
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: createElement(RelayOverview, shown) }));
    });
    if (!renderer) throw new Error("renderer was not created");
    return renderer.root;
  };
  const textOf = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");

  it("renders three actionable strip buttons in account mode and routes each to its filter or the Relay view", async () => {
    const pcs = freadyPcs();
    const filters: DashboardFilter[] = [];
    const openedRelays: (string | undefined)[] = [];
    const root = await mount({
      pcs,
      mode: "account",
      defaultRelay: GLOBAL,
      now: NOW,
      activeFilter: "needs",
      onSelectFilter: (f) => { filters.push(f); },
      onOpenRelay: (origin) => { openedRelays.push(origin); },
    });
    const stripButtons = root.findAll((node) => node.type === "button" && typeof node.props["data-strip-cell"] === "string");
    expect(stripButtons.map((b) => [b.props["data-strip-cell"], b.props["data-strip-count"], b.props["aria-pressed"] ?? false])).toEqual([
      ["ready", 2, false],
      ["needs", 3, true],
      ["relays", 2, false],
    ]);
    for (const btn of stripButtons) {
      await act(async () => { btn.props.onClick(); });
    }
    expect(filters).toEqual(["ready", "needs"]);
    expect(openedRelays).toEqual([undefined]);

    const relayChips = root.findAll((node) => node.type === "button" && String(node.props.className ?? "").includes("relay-overview-relay-chip"));
    expect(relayChips.map(textOf)).toEqual(["relay.ovis.sh", "relay-ap.ovis.sh"]);
    await act(async () => { relayChips[1]?.props.onClick(); });
    expect(openedRelays).toEqual([undefined, AP]);
  });

  it("counts confirmed Ready PCs and Needs you separately from unchecked pairings, with Offline under Needs you", () => {
    for (const [pcs, expected, offline, note] of [
      [f4Pcs(), { ready: 0, needs: 4, relays: 2 }, 1, "incl. 1 offline"],
      [freadyPcs(), { ready: 2, needs: 3, relays: 2 }, 1, "incl. 1 offline"],
      [f20Pcs(), { ready: 8, needs: 12, relays: 2 }, 4, "incl. 4 offline"],
    ] as const) {
      const html = renderMarkup({ pcs, mode: "account", defaultRelay: GLOBAL, now: NOW });
      const cells = Object.fromEntries([...html.matchAll(/data-strip-cell="(\w+)"[^>]*data-strip-count="(\d+)"/g)].map(([, cell, count]) => [cell, Number(count)]));
      expect(cells).toEqual(expected);
      expect(cells.ready + cells.needs).toBe(pcs.filter((pc) => pc.listed).length);
      expect(Number(/data-strip-cell="needs"[^>]*data-strip-offline="(\d+)"/.exec(html)?.[1])).toBe(offline);
      expect(html).toContain(`<small class="relay-overview-strip-note">${note}</small>`);
      expect(html).not.toContain('data-strip-cell="offline"');
      expect(html).not.toContain("relay-dash-notice");
    }
    // nothing offline: no line under Needs you
    const none = renderMarkup({ pcs: [makePc("id_a", "A", "paired"), makePc("id_b", "B", "needs-approval")], mode: "account", defaultRelay: GLOBAL, now: NOW });
    expect(none).not.toContain("relay-overview-strip-note");
    expect(renderMarkup({ pcs: f4Pcs(), mode: "account", defaultRelay: GLOBAL, now: NOW }, "ko")).toContain("오프라인 1대 포함");
  });

  it("shows Paired with this device N and Relays in local mode without Ready or Offline columns, and lists no PC of its own: the table below carries each PC's state and route", () => {
    const pcs = localPcs();
    const checks = new Map<string, PcStatus>([["id_studio", { kind: "answered", route: "lan", rttMs: 38 }], ["id_work", { kind: "offline", reason: "pc" }]]);
    for (const html of [renderMarkup({ pcs, mode: "local", defaultRelay: GLOBAL, now: NOW }), renderMarkup({ pcs, mode: "local", defaultRelay: GLOBAL, pcStatus: checks, now: NOW })]) {
      const cells = [...html.matchAll(/data-strip-cell="(\w+)"[^>]*data-strip-count="(\d+)"/g)].map(([, cell, count]) => [cell, Number(count)]);
      expect(cells).toEqual([["paired", 4], ["relays", 2]]);
      expect(html).toContain("Paired with this device");
      expect(html).not.toContain(">Ready<");
      expect(html).not.toContain("Offline");
      // PF-6: no second list of the same PCs under the strip
      expect(html).not.toContain("relay-overview-local");
      expect(html).not.toContain("This device:");
      expect(html).not.toContain("Studio desktop");
    }
    expect(renderMarkup({ pcs, mode: "local", defaultRelay: GLOBAL, pcStatus: checks, now: NOW })).toContain('data-reachable-direct="1" data-reachable-relay="0" data-reachable-none="1"');
  });

  it("reports measured relay latency only after a check answers through that relay and never fabricates latency", () => {
    const pcs = freadyPcs();
    const model = dashboardModel(pcs, { label: "Me", now: NOW }, GLOBAL);
    const primaryRelay = model.relays[0];
    if (!primaryRelay) throw new Error("expected primary relay");
    expect(relayLatencyMs(primaryRelay, undefined)).toBeNull();
    const lanOnly = new Map<string, PcStatus>([["id_studio", { kind: "answered", route: "lan", rttMs: 4 }]]);
    expect(relayLatencyMs(primaryRelay, lanOnly)).toBeNull();
    const relayCheck = new Map<string, PcStatus>([
      ["id_studio", { kind: "answered", route: "relay", relay: GLOBAL, rttMs: 42 }],
      ["id_home", { kind: "answered", route: "relay", relay: GLOBAL, rttMs: 29 }],
    ]);
    expect(relayLatencyMs(primaryRelay, relayCheck)).toBe(29);

    const noProbeHtml = renderMarkup({ pcs, mode: "account", defaultRelay: GLOBAL, now: NOW });
    expect(noProbeHtml).not.toMatch(/\b\d+\s*ms\b/);
    const probedHtml = renderMarkup({ pcs, mode: "account", defaultRelay: GLOBAL, pcStatus: relayCheck, now: NOW });
    expect(probedHtml).toContain("29 ms");
  });

  it("sums how many PCs this device reaches right now, directly, through a relay or not at all, and says nothing before a check finished", () => {
    const pcs = freadyPcs();
    const checks = new Map<string, PcStatus>([
      ["id_studio", { kind: "answered", route: "lan", rttMs: 4 }],
      ["id_work", { kind: "answered", route: "tailscale", rttMs: 18 }],
      ["id_nuc", { kind: "answered", route: "relay", relay: GLOBAL, rttMs: 62 }],
      ["id_home", { kind: "offline", reason: "pc" }],
    ]);
    const html = renderMarkup({ pcs, mode: "account", defaultRelay: GLOBAL, pcStatus: checks, now: NOW });
    const line = /<p class="relay-overview-reach"[^>]*>([^<]*)<\/p>/.exec(html);
    expect(line?.[1]).toBe("Reachable now: 2 direct · 1 via relay · 1 no answer");
    expect(html).toContain('data-reachable-direct="2" data-reachable-relay="1" data-reachable-none="1"');
    // a check under way and a PC never checked count nowhere, so the line waits for the first finished check
    expect(renderMarkup({ pcs, mode: "account", defaultRelay: GLOBAL, now: NOW })).not.toContain("relay-overview-reach");
    expect(renderMarkup({ pcs, mode: "account", defaultRelay: GLOBAL, pcStatus: new Map([["id_studio", { kind: "checking" }]]), now: NOW })).not.toContain("relay-overview-reach");
    const partial = renderMarkup({ pcs, mode: "account", defaultRelay: GLOBAL, pcStatus: new Map<string, PcStatus>([["id_studio", { kind: "checking" }], ["id_work", { kind: "answered", route: "tailscale", rttMs: 18 }]]), now: NOW });
    expect(partial).toContain('data-reachable-direct="1" data-reachable-relay="0" data-reachable-none="0"');
  });

  it("caps visible attention items at three on Overview and shows View all N with the complete Needs you count", async () => {
    const pcs = f20Pcs();
    const filters: DashboardFilter[] = [];
    const root = await mount({
      pcs,
      mode: "account",
      defaultRelay: GLOBAL,
      now: NOW,
      onSelectFilter: (f) => { filters.push(f); },
    });
    const rows = root.findAll((node) => node.type === "li" && node.props.className === "relay-overview-attention-row");
    expect(rows).toHaveLength(3);
    const viewAll = root.find((node) => node.type === "button" && node.props["data-action"] === "view-all-attention");
    expect(viewAll.props["data-attention-total"]).toBe(12);
    expect(textOf(viewAll)).toBe("View all 12");
    await act(async () => { viewAll.props.onClick(); });
    expect(filters).toEqual(["needs"]);
  });

  it("renders each strip label whole in its own span under the strip, the local strip marked for its two-line labels, and every major section as a direct child of the overview in reading order", () => {
    // the rendered hooks the stylesheet's wrap and spacing rules attach to; the browser QA measures the result (overview-section-spacing: 24px between these children; the capture matrix: no clipped label at 390)
    const local = renderMarkup({ pcs: localPcs(), mode: "local", defaultRelay: GLOBAL, now: NOW });
    expect(local).toContain('<section class="relay-overview-strip" data-local="" aria-label="Summary">');
    expect([...local.matchAll(/<span class="relay-overview-strip-label"><svg[\s\S]*?<\/svg><span>([^<]+)<\/span><\/span>/g)].map(([, label]) => label)).toEqual(["Paired with this device", "Relays"]);
    expect(local).not.toMatch(/relay-overview-strip-label[^>]*title=/);
    const account = renderMarkup({ pcs: f20Pcs(), mode: "account", defaultRelay: GLOBAL, now: NOW, children: createElement("section", { id: "relay-dash-pcs" }) });
    // a cut attention name keeps its full name to hand; a strip label never needs one
    expect(account).toMatch(/<span class="relay-overview-attention-name" title="Backup NAS">Backup NAS<\/span>/);
    const overview = /<div class="relay-overview" data-overview-mode="account">([\s\S]*)<\/div>$/.exec(account)?.[1] ?? "";
    // the overview's direct children, by class or id: a wrapper around any section would break the spacing rule that keys on them
    const topLevel: string[] = [];
    let depth = 0;
    for (const [, closing, attrs, selfClosing] of overview.matchAll(/<(\/?)[a-zA-Z][\w-]*([^>]*?)(\/?)>/g)) {
      if (closing) { depth -= 1; continue; }
      if (depth === 0) topLevel.push(/class="([^"]+)"/.exec(attrs ?? "")?.[1] ?? `#${/id="([^"]+)"/.exec(attrs ?? "")?.[1] ?? ""}`);
      if (!selfClosing) depth += 1;
    }
    expect(topLevel).toEqual(["visually-hidden", "relay-overview-strip", "relay-overview-connectivity", "relay-overview-attention-section", "#relay-dash-pcs", "relay-overview-map-disclosure"]);
  });


  it("says a reason shared by every shown attention row once, as the list caption, keeps those rows to name and relay or last seen, and draws them on the plain surface", () => {
    const html = renderMarkup({ pcs: f4Pcs(), mode: "account", defaultRelay: GLOBAL, now: NOW });
    const section = /<section class="relay-overview-attention-section"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    const reason = "Add window closed · an account member must approve";
    expect(section.match(new RegExp(reason, "g"))).toHaveLength(1);
    expect(section).toContain(`<p class="relay-overview-attention-caption">${reason}</p>`);
    // PF-1: the shared reason and View all share one head row above the list, so the head costs the table no second line
    expect(section).toMatch(/<div class="relay-overview-attention-head"><p class="relay-overview-attention-caption">[^<]+<\/p><button[^>]*data-action="view-all-attention"[^>]*>[^<]+<\/button><\/div><ol class="relay-overview-attention">/);
    const rows = [...section.matchAll(/<span class="relay-overview-attention-name"[^>]*>([^<]+)<\/span><span class="relay-overview-attention-why">([^<]+)<\/span>/g)].map(([, name, why]) => [name, why]);
    expect(rows).toEqual([["Old MacBook", "relay-ap.ovis.sh"], ["Studio desktop", "relay.ovis.sh"], ["Work laptop", "relay-ap.ovis.sh"]]);
    // rows with different reasons keep each reason on its row, with no caption
    const mixed = renderMarkup({ pcs: freadyPcs(), mode: "account", defaultRelay: GLOBAL, now: NOW });
    expect(mixed).not.toContain("relay-overview-attention-caption");
    expect(mixed).toContain('<span class="relay-overview-attention-why">new · 8 min left</span>');
    // the state is the dot's alone: every row renders as the plain row with its glyph, no state class or tint hook on the row itself
    const mixedRows = [...mixed.matchAll(/<li class="([^"]+)" data-pc-state="([^"]+)"><svg class="status-dot" data-state="([^"]+)"/g)].map(([, className, state, dot]) => [className, state, dot]);
    expect(mixedRows).toEqual([
      ["relay-overview-attention-row", "needs-approval", "needs-you"],
      ["relay-overview-attention-row", "needs-approval", "needs-you"],
      ["relay-overview-attention-row", "offline", "offline"],
    ]);
  });

  it("explains fresh Add countdowns, closed Add windows, available updates, and offline durations across locales without duplicated suffixes, and triggers Details without opening a connection", async () => {
    const freshPc = makePc("id_fresh", "Fresh Box", "needs-approval", {
      added_at: new Date(NOW - 2 * 60_000).toISOString(),
      join: { server_public_key: "k_fresh", relay: GLOBAL },
    });
    const expiredPc = makePc("id_expired", "Expired Box", "needs-approval", {
      added_at: new Date(NOW - (NEW_PC_MS + 60_000)).toISOString(),
      join: { server_public_key: "k_exp", relay: GLOBAL },
    });
    const updatePc = makePc("id_upd", "Update Box", "needs-update", { paired: true, linked: true });
    const offlinePaired = makePc("id_off", "Offline Box", "offline", {
      paired: true,
      linked: true,
      last_seen_at: new Date(NOW - 2 * 3_600_000).toISOString(),
    });
    const offlineMins = makePc("id_off_min", "Offline Min", "offline", {
      paired: true,
      linked: true,
      last_seen_at: new Date(NOW - 15 * 60_000).toISOString(),
    });
    const versions = new Map([["id_upd", { version: "0.4.0", outdated: true }]]);
    const openedSheets: [string, "new" | "join"][] = [];
    const selectedDetails: string[] = [];
    const openedPcs: string[] = [];

    const html = renderMarkup({
      pcs: [freshPc, expiredPc, updatePc],
      mode: "account",
      defaultRelay: GLOBAL,
      now: NOW,
      observedVersions: versions,
      targetVersion: "1.9",
    });
    expect(html).toContain("new · 8 min left");
    expect(html).toContain("Add window closed · an account member must approve");
    expect(html).toContain("update to 1.9");

    const offlineReasons = (lang: "en" | "ko" | "ja" | "zh"): string[] => [
      ...renderMarkup({ pcs: [offlinePaired, offlineMins], mode: "account", defaultRelay: GLOBAL, now: NOW }, lang)
        .matchAll(/<span class="relay-overview-attention-why">([^<]+)<\/span>/g),
    ].map(([, text]) => text ?? "");

    expect(offlineReasons("en")).toEqual(["offline since 2 h", "offline since 15 min"]);
    expect(offlineReasons("ko")).toEqual(["2시간 전부터 오프라인", "15분 전부터 오프라인"]);
    expect(offlineReasons("ja")).toEqual(["2 時間前からオフライン", "15 分前からオフライン"]);
    expect(offlineReasons("zh")).toEqual(["已离线 2 小时", "已离线 15 分钟"]);

    const root = await mount({
      pcs: [freshPc, updatePc, offlinePaired],
      mode: "account",
      defaultRelay: GLOBAL,
      now: NOW,
      observedVersions: versions,
      onOpenSheet: (pc, mode) => { openedSheets.push([pc.server_id, mode]); },
      onSelectPc: (pcId) => { selectedDetails.push(pcId); },
      onOpenPc: (pc) => { openedPcs.push(pc.server_id); },
    });
    const actionButtons = root.findAll((node) => node.type === "button" && typeof node.props["data-attention-action"] === "string");
    expect(actionButtons.map((b) => b.props["data-attention-action"])).toEqual(["add", "update", "details"]);
    await act(async () => { actionButtons[0]?.props.onClick(); });
    await act(async () => { actionButtons[2]?.props.onClick(); });
    expect(openedSheets).toEqual([["id_fresh", "new"]]);
    expect(selectedDetails).toEqual(["id_off"]);
    expect(openedPcs).toEqual([]);
  });

  it("renders the directory error banner above the strip with Try again while keeping existing rows visible", async () => {
    let retried = 0;
    const errorMsg = "The account service could not be reached. The PCs this device is paired with still work.";
    const html = renderMarkup({
      pcs: freadyPcs(),
      mode: "account",
      defaultRelay: GLOBAL,
      now: NOW,
      error: errorMsg,
      onRetryError: () => {},
    });
    expect(html.indexOf('role="alert"')).toBeGreaterThan(-1);
    expect(html.indexOf('role="alert"')).toBeLessThan(html.indexOf('class="relay-overview-strip"'));
    expect(html).toContain('data-strip-cell="ready"');

    const root = await mount({
      pcs: freadyPcs(),
      mode: "account",
      defaultRelay: GLOBAL,
      now: NOW,
      error: errorMsg,
      onRetryError: () => { retried += 1; },
    });
    const retryBtn = root.find((node) => node.type === "button" && node.props["data-action"] === "retry-directory");
    await act(async () => { retryBtn.props.onClick(); });
    expect(retried).toBe(1);
  });

  it("reserves the strip numerals and four skeleton rows while loading, shows the spinner only past 1 s, and transitions cleanly to content", async () => {
    const root = await mount({
      pcs: null,
      mode: "account",
      defaultRelay: GLOBAL,
      now: NOW,
    });
    const stripSkeletons = root.findAll((node) => node.props["data-loading-slot"] === "strip-numeral");
    const rowSkeletons = root.findAll((node) => node.props["data-loading-slot"] === "table-row");
    expect(stripSkeletons).toHaveLength(3);
    expect(rowSkeletons).toHaveLength(4);
    expect(root.findAll((node) => node.props.className === "boot-spinner")).toHaveLength(0);

    const delayTimers = [...scheduledTimers.values()].filter((t) => t.ms === 1_000);
    expect(delayTimers).toHaveLength(1);
    await act(async () => { delayTimers[0]?.fn(); });
    expect(root.findAll((node) => node.props.className === "boot-spinner")).toHaveLength(1);

    await act(async () => {
      renderer?.update(createElement(SettingsProvider, {
        children: createElement(RelayOverview, {
          pcs: freadyPcs(),
          mode: "account",
          defaultRelay: GLOBAL,
          now: NOW,
        }),
      }));
    });
    expect(root.findAll((node) => node.props["data-loading-slot"] === "strip-numeral")).toHaveLength(0);
    expect(root.findAll((node) => node.props.className === "boot-spinner")).toHaveLength(0);
    expect(root.findAll((node) => node.type === "button" && typeof node.props["data-strip-cell"] === "string")).toHaveLength(3);
  });

  it("tells a signed-in account with no PC the three steps, which sign-in it is, and re-reads the list on Check again", async () => {
    let refreshed = 0;
    const copiedText: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copiedText.push(text); } } });
    const root = await mount({ pcs: [], mode: "account", provider: "google", defaultRelay: GLOBAL, now: NOW, onRefreshAccount: () => { refreshed += 1; }, onAddPc: () => {}, onPairByQr: () => {} });
    const empty = root.find((node) => node.props["data-dashboard-empty"] === "");
    expect(textOf(empty.find((node) => node.type === "h2"))).toBe("No PCs yet");
    expect(empty.findAll((node) => node.type === "ol")).toHaveLength(1);
    expect(empty.findAll((node) => node.type === "li").map(textOf)).toEqual([
      `Install Ovis on the PC.On macOS or Linux:${INSTALLER_COMMAND}CopyOn Windows, in PowerShell:${WINDOWS_INSTALLER_COMMAND}Copy`,
      "On that PC, open Settings → Devices and PCs → Account and sign in with the same Google account as on this device.",
      "Choose Add this PC to my account there. It then shows here with Add.",
    ]);
    expect(empty.findAll((node) => node.type === "code").map(textOf)).toEqual([INSTALLER_COMMAND, WINDOWS_INSTALLER_COMMAND]);
    expect(textOf(empty.find((node) => node.props["data-empty-provider"] === ""))).toBe("Signed in with Google. GitHub and Google are separate Ovis accounts until you link them, so a PC signed in the other way is not listed here.");
    expect(textOf(empty)).not.toContain("QR code it shows");
    expect(empty.findAll((node) => node.type === "button").map(textOf)).toEqual(["Copy", "Copy", "Check again", "Add a PC", "Pair with a QR or code"]);
    expect(empty.findAll((node) => node.type === "button" && String(node.props.className ?? "").includes("btn-primary")).map(textOf)).toEqual(["Add a PC"]);

    const check = () => empty.find((node) => node.type === "button" && node.props["data-action"] === "check-again");
    // aria-disabled, never disabled: a disabled button drops the keyboard's focus to the page
    const busyState = () => [check().props.disabled, check().props["aria-disabled"], check().props["aria-busy"], textOf(check())];
    expect(busyState()).toEqual([undefined, undefined, undefined, "Check again"]);
    await act(async () => { check().props.onClick(); });
    expect(refreshed).toBe(1);
    expect(busyState()).toEqual([undefined, true, true, "Checking…"]);
    // a click that still lands while it is busy asks nothing
    await act(async () => { check().props.onClick(); });
    expect(refreshed).toBe(1);
    const busy = [...scheduledTimers.values()].filter((timer) => timer.ms === CHECK_AGAIN_BUSY_MS);
    expect(busy).toHaveLength(1);
    await act(async () => { busy[0]?.fn(); });
    expect(busyState()).toEqual([undefined, undefined, undefined, "Check again"]);
    await act(async () => { check().props.onClick(); });
    expect(refreshed).toBe(2);

    const copy = empty.find((node) => node.type === "button" && node.props["data-action"] === "copy-install");
    await act(async () => { copy.props.onClick(); });
    expect(copiedText).toEqual([INSTALLER_COMMAND]);
    expect(textOf(copy)).toBe("Copied");
    // a second copy starts the wait over: the first copy's timer is gone, so it cannot turn the label back early
    const copiedTimers = () => [...scheduledTimers.values()].filter((timer) => timer.ms === COPIED_MS);
    const first = copiedTimers();
    expect(first).toHaveLength(1);
    await act(async () => { copy.props.onClick(); });
    expect(copiedTimers()).toHaveLength(1);
    expect(copiedTimers()[0]).not.toBe(first[0]);
    expect(textOf(copy)).toBe("Copied");

    const windows = empty.find((node) => node.type === "button" && node.props["data-action"] === "copy-install-windows");
    await act(async () => { windows.props.onClick(); });
    expect(copiedText).toEqual([INSTALLER_COMMAND, INSTALLER_COMMAND, WINDOWS_INSTALLER_COMMAND]);
    expect(copiedTimers()).toHaveLength(2);
    // leaving the screen takes the waiting timers with it
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    expect(copiedTimers()).toHaveLength(0);
  });

  it("keeps Check again busy until the read it asked for has landed, however long that takes, and never for less than its least time", async () => {
    const reads: ReturnType<typeof Promise.withResolvers<void>>[] = [];
    const root = await mount({ pcs: [], mode: "account", provider: "github", defaultRelay: GLOBAL, now: NOW, onRefreshAccount: () => { const read = Promise.withResolvers<void>(); reads.push(read); return read.promise; } });
    const check = () => root.find((node) => node.type === "button" && node.props["data-action"] === "check-again");
    const busyTimer = () => [...scheduledTimers.values()].filter((timer) => timer.ms === CHECK_AGAIN_BUSY_MS);
    // the read is slower than the least time: the button stays busy and a press asks nothing more
    await act(async () => { check().props.onClick(); });
    await act(async () => { busyTimer()[0]?.fn(); });
    expect([check().props["aria-disabled"], textOf(check())]).toEqual([true, "Checking…"]);
    await act(async () => { check().props.onClick(); });
    expect(reads).toHaveLength(1);
    await act(async () => { reads[0]?.resolve(); });
    expect([check().props["aria-disabled"], textOf(check())]).toEqual([undefined, "Check again"]);
    // the read is faster than the least time, and fails: still busy until the time is up, then free again
    await act(async () => { check().props.onClick(); });
    expect(reads).toHaveLength(2);
    await act(async () => { reads[1]?.reject(new Error("the read failed")); });
    expect(check().props["aria-disabled"]).toBe(true);
    // the harness keeps a timer that ran: the second press's is the last one
    await act(async () => { busyTimer().at(-1)?.fn(); });
    expect(check().props["aria-disabled"]).toBeUndefined();
  });

  it("shows no steps to add a PC, and no second refresh button, under an account read that failed", async () => {
    let refreshed = 0;
    const failed = "The account service could not be reached. The PCs this device is paired with still work.";
    const root = await mount({ pcs: [], mode: "account", provider: "github", defaultRelay: GLOBAL, now: NOW, error: failed, onRefreshAccount: () => { refreshed += 1; }, onAddPc: () => {}, onPairByQr: () => {} });
    expect(textOf(root.find((node) => node.props["data-directory-error"] === ""))).toBe(`${failed}Try again`);
    const empty = root.find((node) => node.props["data-dashboard-empty"] === "");
    // the list was not read, so it is not known to be empty: nobody is told to install Ovis and add their PCs again
    expect(textOf(empty)).toBe("No PCs yetAdd a PCPair with a QR or code");
    expect(empty.findAll((node) => node.type === "ol" || node.type === "pre" || node.props["data-empty-provider"] === "")).toHaveLength(0);
    expect(root.findAll((node) => node.type === "button").map(textOf)).toEqual(["Try again", "Add a PC", "Pair with a QR or code"]);
    await act(async () => { root.find((node) => node.props["data-action"] === "retry-directory").props.onClick(); });
    expect(refreshed).toBe(1);
  });

  it("names each Copy button by the system its command is for, and gives the command a basis so Copy wraps under it on a narrow screen", async () => {
    const root = await mount({ pcs: [], mode: "account", provider: "github", defaultRelay: GLOBAL, now: NOW });
    const described = root.findAll((node) => node.type === "button" && String(node.props["data-action"] ?? "").startsWith("copy-install"))
      .map((button) => textOf(root.find((node) => node.type === "span" && node.props.id === button.props["aria-describedby"])));
    expect(described).toEqual(["On macOS or Linux:", "On Windows, in PowerShell:"]);
    const css = readFileSync(new URL("./RelayOverview.css", import.meta.url), "utf8");
    const command = /\.relay-overview-empty-command \{([^}]*)\}/.exec(css)?.[1] ?? "";
    // `flex: 1` is a basis of 0: the row then never wraps and the command is squeezed to a few characters a line
    expect(command).toMatch(/flex: 1 1 \d+rem;/);
    expect(/\.relay-overview-empty-command-row \{([^}]*)\}/.exec(css)?.[1]).toContain("flex-wrap: wrap");
  });

  it("does not tell an account signed in with Apple to sign in on the PC with Apple, which a PC's page cannot do", async () => {
    const root = await mount({ pcs: [], mode: "account", provider: "apple", defaultRelay: GLOBAL, now: NOW, onRefreshAccount: () => {}, onAddPc: () => {}, onPairByQr: () => {} });
    const empty = root.find((node) => node.props["data-dashboard-empty"] === "");
    const steps = empty.findAll((node) => node.type === "li").map(textOf);
    expect(steps).toHaveLength(3);
    expect(steps[1]).toBe("On that PC, open Settings → Devices and PCs → Account and sign in with a GitHub or Google sign-in that is linked to this account.");
    expect(textOf(empty)).not.toContain("sign in with Apple");
    expect(textOf(empty)).not.toContain("the other way");
    expect(textOf(empty.find((node) => node.props["data-empty-provider"] === ""))).toBe("Signed in with Apple. A PC signs in with GitHub or Google only, and each is a separate Ovis account until you link it to this one. Without a linked sign-in, pair with a QR or code instead.");
    expect(empty.findAll((node) => node.type === "button").map(textOf)).toEqual(["Copy", "Copy", "Check again", "Add a PC", "Pair with a QR or code"]);
    for (const language of ["ko", "ja", "zh"] as const) {
      const html = renderMarkup({ pcs: [], mode: "account", provider: "apple", defaultRelay: GLOBAL, now: NOW }, language);
      expect(html).toContain("Apple");
      expect(html).not.toContain("Signed in with");
      expect(html).not.toContain("sign in with a GitHub or Google");
      expect(html).not.toContain("{provider}");
    }
  });

  it("keeps the one-sentence empty state without an account, and offers no Check again without a refresh to call", async () => {
    const local = await mount({ pcs: [], mode: "local", defaultRelay: GLOBAL, now: NOW, onRefreshAccount: () => {}, onAddPc: () => {}, onPairByQr: () => {} });
    const empty = local.find((node) => node.props["data-dashboard-empty"] === "");
    expect(textOf(empty.find((node) => node.props.className === "relay-overview-empty-copy"))).toBe("Sign in on a PC, or scan the QR code it shows, to see it here.");
    expect(empty.findAll((node) => node.type === "ol" || node.props["data-empty-provider"] === "")).toHaveLength(0);
    expect(empty.findAll((node) => node.type === "button").map(textOf)).toEqual(["Add a PC", "Pair with a QR or code"]);
    await act(async () => { renderer?.unmount(); });

    const account = await mount({ pcs: [], mode: "account", provider: "github", defaultRelay: GLOBAL, now: NOW, onAddPc: () => {} });
    const guided = account.find((node) => node.props["data-dashboard-empty"] === "");
    expect(textOf(guided.find((node) => node.props["data-empty-provider"] === ""))).toStartWith("Signed in with GitHub. ");
    expect(guided.findAll((node) => node.type === "button").map(textOf)).toEqual(["Copy", "Copy", "Add a PC"]);
    for (const language of ["ko", "ja", "zh"] as const) {
      const html = renderMarkup({ pcs: [], mode: "account", provider: "github", defaultRelay: GLOBAL, now: NOW }, language);
      expect(html).toContain("GitHub");
      expect(html).not.toContain("Install Ovis on the PC.");
      expect(html).not.toContain("On Windows, in PowerShell:");
      expect(html).not.toContain("{provider}");
    }
  });

  it("renders the centred empty state with one primary Add a PC and ghost Pair with a QR or code, plus the 44px map disclosure when populated", async () => {
    let added = 0;
    let pairedQr = 0;
    let openedRelay = 0;
    const root = await mount({
      pcs: [],
      mode: "account",
      defaultRelay: GLOBAL,
      now: NOW,
      onAddPc: () => { added += 1; },
      onPairByQr: () => { pairedQr += 1; },
    });
    const emptyCopy = root.find((node) => node.type === "p" && node.props.className === "relay-overview-empty-copy");
    expect(textOf(emptyCopy)).toBe("Sign in on a PC, or scan the QR code it shows, to see it here.");
    const primaries = root.findAll((node) => node.type === "button" && String(node.props.className ?? "").includes("btn-primary"));
    const ghosts = root.findAll((node) => node.type === "button" && String(node.props.className ?? "").includes("btn-ghost"));
    expect(primaries).toHaveLength(1);
    expect(ghosts).toHaveLength(1);
    await act(async () => { primaries[0]?.props.onClick(); });
    await act(async () => { ghosts[0]?.props.onClick(); });
    expect([added, pairedQr]).toEqual([1, 1]);

    await act(async () => {
      renderer?.update(createElement(SettingsProvider, {
        children: createElement(RelayOverview, {
          pcs: freadyPcs(),
          mode: "account",
          defaultRelay: GLOBAL,
          now: NOW,
          onOpenRelay: () => { openedRelay += 1; },
        }),
      }));
    });
    const disclosure = root.find((node) => node.type === "button" && node.props["data-action"] === "open-connection-map");
    await act(async () => { disclosure.props.onClick(); });
    expect(openedRelay).toBe(1);
  });
});
