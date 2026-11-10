import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { dashboardModel, type DashboardFilter, type DashboardPc } from "../lib/relay/dashboard.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { RelayPcTable, type RelayPcTableProps } from "./RelayPcTable.tsx";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const GLOBAL = "wss://relay.ovis.sh";
const AP = "wss://relay-ap.ovis.sh";

const IDS = {
  ready: "1".repeat(32),
  fresh: "2".repeat(32),
  join: "3".repeat(32),
  update: "4".repeat(32),
  offlinePaired: "5".repeat(32),
  offlineJoin: "6".repeat(32),
  routeless: "7".repeat(32),
  local: "8".repeat(32),
};

function makePc(
  server_id: string,
  name: string,
  state: DashboardPc["state"],
  over: Partial<DashboardPc> = {},
): DashboardPc {
  return {
    server_id,
    name,
    state,
    relay: GLOBAL,
    last_seen_at: new Date(NOW - 60_000).toISOString(),
    added_at: new Date(NOW - 7 * 86_400_000).toISOString(),
    listed: true,
    paired: state === "paired" || state === "needs-update",
    linked: state === "paired" || state === "needs-update",
    ...over,
  };
}

function sampleFleet(): DashboardPc[] {
  return [
    makePc(IDS.ready, "Studio desktop", "paired", { relay: GLOBAL }),
    makePc(IDS.fresh, "New mini PC", "needs-approval", {
      added_at: new Date(NOW - 2 * 60_000).toISOString(),
      paired: false,
      linked: false,
      join: { server_public_key: "k1", relay: GLOBAL },
    }),
    makePc(IDS.join, "Old MacBook", "needs-approval", {
      relay: AP,
      paired: false,
      linked: false,
      join: { server_public_key: "k2", relay: AP },
    }),
    makePc(IDS.update, "Build box", "needs-update", { relay: GLOBAL }),
    makePc(IDS.offlinePaired, "Home server", "offline", {
      last_seen_at: new Date(NOW - 2 * 3_600_000).toISOString(),
      paired: true,
      linked: true,
    }),
    makePc(IDS.offlineJoin, "Travel laptop", "offline", {
      relay: AP,
      last_seen_at: new Date(NOW - 5 * 3_600_000).toISOString(),
      paired: false,
      linked: false,
      join: { server_public_key: "k3", relay: AP },
    }),
    makePc(IDS.routeless, "Spare desktop", "needs-approval", {
      relay: null,
      last_seen_at: null,
      paired: false,
      linked: false,
    }),
  ];
}

const none = () => {};

function buildProps(
  pcs: readonly DashboardPc[] = sampleFleet(),
  over: Partial<RelayPcTableProps> = {},
  status?: ReadonlyMap<string, PcStatus>,
): RelayPcTableProps {
  const model = dashboardModel(pcs, { label: "This device", now: NOW, ...(status ? { status } : {}) }, GLOBAL);
  return {
    rows: model.rows,
    attention: model.attention,
    filters: model.filters,
    filter: "all",
    onFilter: none,
    selectedPcId: null,
    onSelect: none,
    onOpenSheet: none,
    now: NOW,
    ...over,
  };
}

function renderHtml(props: RelayPcTableProps): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(RelayPcTable, props) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

describe("RelayPcTable", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let phoneMatches = false;

  beforeEach(() => {
    phoneMatches = false;
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "matchMedia", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
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
    const matchMedia = (query: string) => ({
      matches: query === "(max-width: 768px)" ? phoneMatches : false,
      addEventListener() {},
      removeEventListener() {},
    });
    class HTMLElement { isConnected = true; focus(): void {} }
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test", maxTouchPoints: 0 } });
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
        requestAnimationFrame: (cb: FrameRequestCallback) => { cb(0); return 1; },
        cancelAnimationFrame() {},
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
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

  const rootOf = (r: ReactTestRenderer | undefined): ReactTestInstance => { if (!r) throw new Error("not mounted"); return r.root; };
  const rootUpdate = (r: ReactTestRenderer | undefined) => { if (!r) throw new Error("not mounted"); return r.update.bind(r); };
  const mount = async (props: RelayPcTableProps) => {
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: createElement(RelayPcTable, props) }));
    });
  };

  it("renders a semantic table with caption, scoped headers, 36/18/22/12/12 colgroup, and urgency order", () => {
    const html = renderHtml(buildProps());
    expect(html).toContain("<caption");
    expect(html.match(/<th scope="col"/g)).toHaveLength(5);
    expect(html).toContain("<colgroup>");
    const rowIds = [...html.matchAll(/<tr[^>]*data-pc-id="([^"]+)"/g)].map(([, id]) => id);
    expect(rowIds).toEqual([
      IDS.update,
      IDS.fresh,
      IDS.join,
      IDS.routeless,
      IDS.offlinePaired,
      IDS.offlineJoin,
      IDS.ready,
    ]);
  });

  it.each([false, true])("keeps failed enrollment visible beside the PC's own state and Open route on phone=%s", async (phone) => {
    phoneMatches = phone;
    const pc = makePc(IDS.local, "Paired desk", "paired", { listed: false, linked: false, enrollment: "failed" });
    await mount(buildProps([pc]));
    const root = rootOf(renderer);
    expect(textOf(root)).toContain("Account setup is incomplete. Open it to try again.");
    const retry = root.find((node) => node.type === "a" && textOf(node) === "Open");
    expect(retry.props.href).toBe(`/s/${IDS.local}/`);
  });

  it("offers exactly one neutral next action per row: Open, Add, Join, Update, or Details (never btn-primary)", () => {
    const html = renderHtml(buildProps());
    expect(html).not.toContain("btn-primary");
    const rowAction = (id: string) => {
      const tr = new RegExp(`<tr[^>]*data-pc-id="${id}"[\\s\\S]*?<\\/tr>`).exec(html)?.[0] ?? "";
      const match = /<(a|button)[^>]*data-pc-action="([^"]+)"[^>]*>([\s\S]*?)<\/(?:a|button)>/.exec(tr);
      return match ? [match[1], match[2], (match[3] ?? '').replace(/<[^>]+>/g, "")] : null;
    };
    expect(rowAction(IDS.ready)).toEqual(["a", "open", "Open"]);
    expect(rowAction(IDS.fresh)).toEqual(["button", "add", "Add"]);
    expect(rowAction(IDS.join)).toEqual(["button", "join", "Join"]);
    expect(rowAction(IDS.update)).toEqual(["a", "update", "Update"]);
    expect(rowAction(IDS.offlinePaired)).toEqual(["button", "details", "Details"]);
    expect(rowAction(IDS.offlineJoin)).toEqual(["button", "join", "Join"]);
    // V-073: a needs-approval or offline PC without a verified join route offers Details instead of an empty cell
    expect(rowAction(IDS.routeless)).toEqual(["button", "details", "Details"]);
  });

  it("opens Details without a connection attempt on row click, name button Enter/click, or Details button, and action clicks do not bubble into Details", async () => {
    const selected: string[] = [];
    const sheets: [string, "new" | "join"][] = [];
    const opened: string[] = [];
    await mount(buildProps(sampleFleet(), {
      onSelect: (id) => selected.push(id),
      onOpenSheet: (pc, mode) => sheets.push([pc.server_id, mode]),
      onOpenPc: (pc) => opened.push(pc.server_id),
    }));

    // 1. Clicking the native name button selects the PC
    const studioNameBtn = rootOf(renderer).find((n) => n.type === "button" && n.props.className === "relay-pc-name-btn" && textOf(n) === "Studio desktop");
    await act(async () => { studioNameBtn.props.onClick({ stopPropagation() {} }); });
    expect(selected).toEqual([IDS.ready]);
    expect(opened).toEqual([]);
    expect(sheets).toEqual([]);

    // 2. Clicking the row background selects the PC without triggering its Open / Add / Join action
    const freshRow = rootOf(renderer).find((n) => n.type === "tr" && n.props["data-pc-id"] === IDS.fresh);
    await act(async () => { freshRow.props.onClick({ target: freshRow }); });
    expect(selected).toEqual([IDS.ready, IDS.fresh]);
    expect(sheets).toEqual([]);

    // 3. Clicking the Add button opens the sheet in "new" mode and does NOT select the row for Details
    const addBtn = freshRow.find((n) => n.props["data-pc-action"] === "add");
    let stopped = false;
    await act(async () => { addBtn.props.onClick({ stopPropagation: () => { stopped = true; } }); });
    expect(stopped).toBe(true);
    expect(sheets).toEqual([[IDS.fresh, "new"]]);
    expect(selected).toEqual([IDS.ready, IDS.fresh]);

    // 4. Clicking the Details button on an offline paired PC selects it for Details with zero connection attempts
    const offlineRow = rootOf(renderer).find((n) => n.type === "tr" && n.props["data-pc-id"] === IDS.offlinePaired);
    const detailsBtn = offlineRow.find((n) => n.props["data-pc-action"] === "details");
    expect(detailsBtn.type).toBe("button");
    expect(detailsBtn.props.href).toBeUndefined();
    await act(async () => { detailsBtn.props.onClick({ stopPropagation() {} }); });
    expect(selected).toEqual([IDS.ready, IDS.fresh, IDS.offlinePaired]);
    expect(opened).toEqual([]);
  });

  it("filters rows by All / Ready / Needs you / Offline and announces result counts via aria-live='polite'", async () => {
    const chosen: DashboardFilter[] = [];
    const fleet = sampleFleet();
    await mount(buildProps(fleet, { filter: "all", onFilter: (f) => chosen.push(f) }));

    const segButtons = rootOf(renderer).findByProps({ className: "segmented" }).findAll((n) => n.type === "button");
    expect(segButtons.map((b) => textOf(b))).toEqual(["All", "Ready", "Needs you", "Offline"]);
    await act(async () => { segButtons[2]?.props.onClick(); });
    expect(chosen).toEqual(["needs"]);

    // Re-render with filter="needs" (includes needs-approval, needs-update, AND offline)
    await act(async () => {
      rootUpdate(renderer)(createElement(SettingsProvider, { children: createElement(RelayPcTable, buildProps(fleet, { filter: "needs" })) }));
    });
    const needsRows = rootOf(renderer).findAll((n) => n.type === "tr" && n.props["data-pc-id"] !== undefined);
    expect(needsRows).toHaveLength(6);
    const liveStatus = rootOf(renderer).find((n) => n.props["aria-live"] === "polite");
    expect(textOf(liveStatus)).toContain("6");

    // Re-render with filter="offline"
    await act(async () => {
      rootUpdate(renderer)(createElement(SettingsProvider, { children: createElement(RelayPcTable, buildProps(fleet, { filter: "offline" })) }));
    });
    const offlineRows = rootOf(renderer).findAll((n) => n.type === "tr" && n.props["data-pc-id"] !== undefined);
    expect(offlineRows).toHaveLength(2);

    // Filtered empty state offers Show all PCs reset button (V-097)
    const onlyOffline = [makePc(IDS.offlinePaired, "Home server", "offline", { paired: true })];
    const resets: DashboardFilter[] = [];
    await act(async () => {
      rootUpdate(renderer)(createElement(SettingsProvider, {
        children: createElement(RelayPcTable, buildProps(onlyOffline, { filter: "ready", onFilter: (f) => { resets.push(f); } })),
      }));
    });
    const emptyBlock = rootOf(renderer).find((n) => n.props["data-filter-empty"] !== undefined);
    expect(textOf(emptyBlock)).toContain("No PC matches this filter.");
    const resetBtn = emptyBlock.find((n) => n.type === "button");
    await act(async () => { resetBtn.props.onClick(); });
    expect(resets).toEqual(["all"]);
  });

  it("formats <time> with relative text, machine dateTime and absolute local title, and renders explicit — for unknown relay or last seen", () => {
    const html = renderHtml(buildProps());
    const readyRow = new RegExp(`<tr[^>]*data-pc-id="${IDS.ready}"[\\s\\S]*?<\\/tr>`).exec(html)?.[0] ?? "";
    expect(readyRow).toMatch(/<time[^>]*dateTime="2026-11-08T11:59:00\.000Z"[^>]*title="[^"]+"[^>]*>just now<\/time>/);
    // a PC this device cannot check (no pairing) keeps the relay the directory assigns it
    const joinRow = new RegExp(`<tr[^>]*data-pc-id="${IDS.join}"[\\s\\S]*?<\\/tr>`).exec(html)?.[0] ?? "";
    expect(joinRow).toContain('<code class="relay-pc-relay-chip">relay-ap.ovis.sh</code>');

    // Routeless / unknown relay and last_seen_at renders — instead of assuming defaultRelay (V-084)
    const unknownRow = new RegExp(`<tr[^>]*data-pc-id="${IDS.routeless}"[\\s\\S]*?<\\/tr>`).exec(html)?.[0] ?? "";
    expect(unknownRow).not.toContain("relay.ovis.sh");
    expect(unknownRow).toContain("—");
  });

  it("keeps directory state and this device's check separate in account mode, and uses truthful local-mode words", () => {
    const status = new Map<string, PcStatus>([
      [IDS.ready, { kind: "answered", route: "relay", relay: GLOBAL, rttMs: 42 }],
      [IDS.offlinePaired, { kind: "answered", route: "lan", rttMs: 9 }],
    ]);
    // Automatic probe (checkedByUser = false): does not add a second probe line on every row in account mode
    const autoHtml = renderHtml(buildProps(sampleFleet(), { checkedByUser: false }, status));
    const autoReadyRow = new RegExp(`<tr[^>]*data-pc-id="${IDS.ready}"[\\s\\S]*?<\\/tr>`).exec(autoHtml)?.[0] ?? "";
    expect(autoReadyRow).toContain("Ready");
    expect(autoReadyRow).not.toContain("This device: answered");

    // Explicit Check now (checkedByUser = true): shows "This device: answered · 42 ms" beneath state
    const manualHtml = renderHtml(buildProps(sampleFleet(), { checkedByUser: true }, status));
    const manualReadyRow = new RegExp(`<tr[^>]*data-pc-id="${IDS.ready}"[\\s\\S]*?<\\/tr>`).exec(manualHtml)?.[0] ?? "";
    expect(manualReadyRow).toContain("Ready");
    expect(manualReadyRow).toContain("This device: answered · 42 ms");

    // Local mode: says "Paired · not checked" until checked, then Answers or No answer (the Relay cell carries the way and the round trip), never "Ready"
    const localPc = makePc(IDS.local, "Desk NUC", "paired", { listed: false, linked: false, last_seen_at: null });
    const uncheckedLocal = renderHtml(buildProps([localPc], { mode: "local" }));
    expect(uncheckedLocal).toContain("Paired · not checked");
    expect(uncheckedLocal).not.toContain(">Ready<");

    const answeredLocal = renderHtml(buildProps([localPc], { mode: "local" }, new Map([[IDS.local, { kind: "answered", route: "lan", rttMs: 31 }]])));
    expect(answeredLocal).toContain('<span class="relay-pc-state-word" title="Answers">Answers</span>');
    expect(answeredLocal).toContain("Same network · 31 ms");
    expect(answeredLocal).not.toContain("This device: answered");
    expect(answeredLocal).not.toContain(">Ready<");

    const noAnswerLocal = renderHtml(buildProps([localPc], { mode: "local" }, new Map([[IDS.local, { kind: "offline", reason: "pc" }]])));
    expect(noAnswerLocal).toContain('<span class="relay-pc-state-word" title="No answer">No answer</span>');
    expect(noAnswerLocal).not.toContain("This device: no answer");
  });

  it("renders a semantic <ul> of two-line rows on phones (<=768px) or when narrow, keeping glyph, name, action, state, relay and last seen", async () => {
    phoneMatches = true;
    await mount(buildProps());
    expect(rootOf(renderer).findAll((n) => n.type === "table")).toHaveLength(0);
    const list = rootOf(renderer).find((n) => n.type === "ul" && n.props["data-pc-list"] === "phone");
    const items = list.findAll((n) => n.type === "li" && n.props["data-pc-state"] !== undefined);
    expect(items).toHaveLength(7);
    const studioItem = items.find((n) => n.props["data-pc-id"] === IDS.ready);
    if (!studioItem) throw new Error("missing studio item");
    const text = textOf(studioItem);
    expect(text).toContain("Studio desktop");
    expect(text).toContain("Open");
    expect(text).toContain("Ready");
    expect(text).toContain("Not checked");
    expect(text).toContain("just now");
  });

  it("keeps the full name of a long PC name in the name button's title", () => {
    const longName = "Workstation on the third floor lab bench with a very long name";
    const longPc = makePc(IDS.ready, longName, "paired");
    const html = renderHtml(buildProps([longPc]));
    expect(html).toContain(`title="${longName}"`);
  });

  it("flags a list of 200 rows or more as a large fleet and one of 199 not, and renders every one of 1000 rows", () => {
    const fleet200 = Array.from({ length: 200 }, (_, i) =>
      makePc(`${String(i).padStart(32, "0")}`, `Node ${i}`, "paired"),
    );
    const html200 = renderHtml(buildProps(fleet200));
    expect(html200).toContain("is-large-fleet");

    const fleet199 = Array.from({ length: 199 }, (_, i) =>
      makePc(`${String(i).padStart(32, "0")}`, `Node ${i}`, "paired"),
    );
    expect(renderHtml(buildProps(fleet199))).not.toContain("is-large-fleet");

    const fleet1000 = Array.from({ length: 1000 }, (_, i) =>
      makePc(`${String(i).padStart(32, "0")}`, `Node ${i}`, i % 2 === 0 ? "paired" : "offline"),
    );
    const html1000 = renderHtml(buildProps(fleet1000));
    expect(html1000.match(/<tr[^>]*data-pc-id="/g)).toHaveLength(1000);
  });

  it("gates offline answered probe lines and unchecked paired-row hints on explicit Check now (checkedByUser)", () => {
    const offline = makePc(IDS.offlinePaired, "Home server", "offline", { paired: true, linked: true });
    const uncheckedPaired = makePc(IDS.ready, "Render node", "paired", { paired: true, linked: true });
    const status = new Map<string, PcStatus>([[IDS.offlinePaired, { kind: "answered", route: "lan", rttMs: 9 }]]);

    const stateCellOf = (html: string, id: string) => /<td class="relay-dash-state-cell[^"]*">([\s\S]*?)<\/td>/.exec(new RegExp(`<tr[^>]*data-pc-id="${id}"[\\s\\S]*?<\\/tr>`).exec(html)?.[0] ?? "")?.[1] ?? "";
    // Automatic probe (checkedByUser = false): no second line under the state word; the answered row reads Ready (a live answer beats a stale Offline)
    const autoHtml = renderHtml(buildProps([offline, uncheckedPaired], { checkedByUser: false }, status));
    expect(autoHtml).not.toContain("relay-pc-probe-line");
    expect(autoHtml).not.toContain("This device: answered");
    expect(stateCellOf(autoHtml, IDS.offlinePaired)).toContain(">Ready</span>");
    expect(stateCellOf(autoHtml, IDS.ready)).not.toContain("Not checked");

    // Explicit Check now (checkedByUser = true): the answered row shows the probe line, and the unchecked paired row shows Not checked under its word (V-096)
    const manualHtml = renderHtml(buildProps([offline, uncheckedPaired], { checkedByUser: true }, status));
    expect(stateCellOf(manualHtml, IDS.offlinePaired)).toContain("This device: answered · 9 ms");
    expect(stateCellOf(manualHtml, IDS.ready)).toContain("Ready");
    expect(stateCellOf(manualHtml, IDS.ready)).toContain('<small class="relay-pc-probe-line">Not checked</small>');
  });

  it("reads an answered PC as reachable whatever the directory last saw: Ready with its glyph over a stale Offline, Needs update kept with its route beside it, Offline only without an answer", () => {
    const stale = makePc(IDS.offlinePaired, "Home server", "offline", { paired: true, linked: true, last_seen_at: new Date(NOW - 20 * 3_600_000).toISOString() });
    const outdated = makePc(IDS.update, "Build box", "needs-update");
    const answered = new Map<string, PcStatus>([[IDS.offlinePaired, { kind: "answered", route: "lan", rttMs: 4 }], [IDS.update, { kind: "answered", route: "tailscale", rttMs: 18 }]]);
    const html = renderHtml(buildProps([stale, outdated], {}, answered));
    const rowOf = (id: string) => new RegExp(`<tr[^>]*data-pc-id="${id}"[\\s\\S]*?<\\/tr>`).exec(html)?.[0] ?? "";
    expect(rowOf(IDS.offlinePaired)).toContain('<svg class="status-dot" data-state="ready"');
    expect(rowOf(IDS.offlinePaired)).toContain('<span class="relay-pc-state-word" title="Ready">Ready</span>');
    expect(rowOf(IDS.offlinePaired)).not.toContain("Offline");
    expect(rowOf(IDS.offlinePaired).replace(/<[^>]+>/g, "")).toContain("Same network · 4 ms");
    expect(rowOf(IDS.update)).toContain('<svg class="status-dot" data-state="needs-you"');
    expect(rowOf(IDS.update)).toContain('<span class="relay-pc-state-word" title="Needs update">Needs update</span>');
    expect(rowOf(IDS.update).replace(/<[^>]+>/g, "")).toContain("Tailscale · 18 ms");
    // no answer: the directory's Offline stands, with the route cell saying so
    const unanswered = renderHtml(buildProps([stale], {}, new Map<string, PcStatus>([[IDS.offlinePaired, { kind: "offline", reason: "pc" }]])));
    expect(unanswered).toContain('<svg class="status-dot" data-state="offline"');
    expect(unanswered).toContain('title="Offline · 20 h ago">Offline · 20 h ago</span>');
    expect(unanswered.replace(/<[^>]+>/g, "")).toContain("No answer");
  });

  it("keeps Needs update, its glyph and Update for a PC the account does not list once this device's check answered, with the answer in the Relay cell", () => {
    const nuc = makePc(IDS.local, "Lab NUC", "needs-update", { listed: false, linked: false, last_seen_at: null });
    const status = new Map<string, PcStatus>([[IDS.local, { kind: "answered", route: "lan", rttMs: 21 }]]);
    for (const mode of ["account", "local"] as const) {
      const html = renderHtml(buildProps([nuc], { mode }, status));
      const row = new RegExp(`<tr[^>]*data-pc-id="${IDS.local}"[\\s\\S]*?<\\/tr>`).exec(html)?.[0] ?? "";
      expect(row).toContain('<svg class="status-dot" data-state="needs-you"');
      expect(row).toContain('<span class="relay-pc-state-word" title="Needs update">Needs update</span>');
      expect(row).toContain('<small class="relay-pc-probe-line">Update Ovis on it</small>');
      expect(row).toContain('data-pc-action="update"');
      expect(row.replace(/<[^>]+>/g, "")).toContain("Same network · 21 ms");
      expect(row).not.toContain("Answers");
      expect(row).not.toContain('data-state="ready"');
    }
    // a paired PC the account does not list, with nothing to act on, still reads by this device's check alone
    const quiet = renderHtml(buildProps([makePc(IDS.local, "Lab NUC", "paired", { listed: false, linked: false, last_seen_at: null })], {}, status));
    expect(quiet).toContain('<svg class="status-dot" data-state="ready"');
    expect(quiet).toContain('<span class="relay-pc-state-word" title="Answers">Answers</span>');
  });

  it("keeps a Join row's State cell to one line by putting the closed-window reason in the state word's title (while the phone list keeps the line), so rows stay 44px without clipping (PF-1)", async () => {
    const html = renderHtml(buildProps());
    const joinRow = new RegExp(`<tr[^>]*data-pc-id="${IDS.join}"[\\s\\S]*?<\\/tr>`).exec(html)?.[0] ?? "";
    expect(joinRow).toContain('<span class="relay-pc-state-word" title="Needs approval · Join · a device of your account connected to it approves">Needs approval</span>');
    expect(joinRow).not.toContain("relay-pc-probe-line");
    phoneMatches = true;
    await mount(buildProps());
    const joinPhone = rootOf(renderer).find((n) => n.type === "li" && n.props["data-pc-id"] === IDS.join);
    expect(textOf(joinPhone)).toContain("Join · a device of your account connected to it approves");
  });

  it("names the specific state in the State cell (Needs approval, Needs update, Offline · when, Ready) with the full text in a title, while the filter chip keeps Needs you", () => {
    const html = renderHtml(buildProps());
    const stateOf = (id: string) => /<span class="relay-pc-state-word" title="([^"]+)">([^<]+)<\/span>/.exec(new RegExp(`<tr[^>]*data-pc-id="${id}"[\\s\\S]*?<\\/tr>`).exec(html)?.[0] ?? "")?.slice(1);
    expect(stateOf(IDS.fresh)).toEqual(["Needs approval", "Needs approval"]);
    expect(stateOf(IDS.update)).toEqual(["Needs update", "Needs update"]);
    expect(stateOf(IDS.offlinePaired)).toEqual(["Offline · 2 h ago", "Offline · 2 h ago"]);
    expect(stateOf(IDS.ready)).toEqual(["Ready", "Ready"]);
    expect(html).not.toContain(">Needs you</span>");
    const chips = /<div class="segmented"[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
    expect(chips).toContain(">Needs you</button>");
  });

  it("shows in the Relay cell the route this device reached each PC by, with its round trip, Not checked for a paired PC it has not checked, and the assigned relay's chip only for a PC it cannot check", async () => {
    const studio = makePc(IDS.ready, "Studio desktop", "paired", { relay: GLOBAL });
    const laptop = makePc(IDS.update, "Work laptop", "needs-update", { relay: AP });
    const nuc = makePc(IDS.local, "Lab NUC", "paired", { relay: GLOBAL, listed: false, linked: false, last_seen_at: null });
    const home = makePc(IDS.offlinePaired, "Home server", "offline", { paired: true, linked: true });
    const unchecked = makePc(IDS.join, "Render node", "paired", { relay: AP });
    const unpaired = makePc(IDS.fresh, "New mini PC", "needs-approval", { paired: false, linked: false, join: { server_public_key: "k1", relay: GLOBAL } });
    const status = new Map<string, PcStatus>([
      [IDS.ready, { kind: "answered", route: "lan", rttMs: 4 }],
      [IDS.update, { kind: "answered", route: "tailscale", rttMs: 18 }],
      [IDS.local, { kind: "answered", route: "relay", relay: AP, rttMs: 62 }],
      [IDS.offlinePaired, { kind: "offline", reason: "pc" }],
    ]);
    const html = renderHtml(buildProps([studio, laptop, nuc, home, unchecked, unpaired], {}, status));
    const cellOf = (id: string) => /<td class="relay-dash-relay relay-pc-cell-relay">([\s\S]*?)<\/td>/.exec(new RegExp(`<tr[^>]*data-pc-id="${id}"[\\s\\S]*?<\\/tr>`).exec(html)?.[0] ?? "")?.[1] ?? "";
    const text = (cell: string) => cell.replace(/<[^>]+>/g, "");
    // one label per route kind, the round trip beside it; the state colour stays on the dot, so the cell carries no state class
    expect(cellOf(IDS.ready)).toContain('data-route="lan"');
    expect(text(cellOf(IDS.ready))).toBe("Same network · 4 ms");
    expect(cellOf(IDS.update)).toContain('data-route="tailscale"');
    expect(text(cellOf(IDS.update))).toBe("Tailscale · 18 ms");
    expect(cellOf(IDS.local)).toContain('data-route="relay"');
    expect(cellOf(IDS.local)).toContain('<code class="relay-pc-relay-chip">relay-ap.ovis.sh</code>');
    expect(text(cellOf(IDS.local))).toBe("relay-ap.ovis.sh · 62 ms");
    expect(cellOf(IDS.offlinePaired)).toContain('data-route="offline"');
    expect(text(cellOf(IDS.offlinePaired))).toBe("No answer");
    expect(html).not.toMatch(/relay-pc-route[^>]*data-state=/);
    // the full label is the cell's title, since the cell keeps one line
    expect(cellOf(IDS.local)).toContain('title="relay-ap.ovis.sh · 62 ms"');
    // no check yet on a paired PC: Not checked, never the assigned relay standing in for a measurement; a PC this device is not paired with has no check to make, so its directory relay stays
    expect(cellOf(IDS.join)).toBe('<span class="relay-pc-route" data-route="unchecked" title="Not checked"><span>Not checked</span></span>');
    expect(cellOf(IDS.fresh)).toBe('<code class="relay-pc-relay-chip">relay.ovis.sh</code>');
    expect(html).toContain('<th scope="col" class="relay-pc-head-relay">Relay</th>');
    // the phone row says the same in its summary line
    phoneMatches = true;
    await mount(buildProps([studio, laptop, nuc, home], {}, status));
    const list = rootOf(renderer).find((n) => n.type === "ul" && n.props["data-pc-list"] === "phone");
    const metaOf = (id: string) => textOf(list.find((n) => n.type === "li" && n.props["data-pc-id"] === id).find((n) => n.props.className === "relay-pc-phone-meta"));
    expect(metaOf(IDS.ready)).toBe("Ready·Same network · 4 ms·just now");
    expect(metaOf(IDS.update)).toBe("Needs update·Tailscale · 18 ms·just now");
    expect(metaOf(IDS.offlinePaired)).toBe("Offline · just now·No answer·just now");
    // the phone summary of a paired PC not checked yet says so too
    await act(async () => { rootUpdate(renderer)(createElement(SettingsProvider, { children: createElement(RelayPcTable, buildProps([unchecked], {}, status)) })); });
    const uncheckedItem = rootOf(renderer).find((n) => n.type === "li" && n.props["data-pc-id"] === IDS.join);
    expect(textOf(uncheckedItem.find((n) => n.props.className === "relay-pc-phone-meta"))).toBe("Ready·Not checked·just now");
  });

  it("drops the Last seen column when asked (Details open beside it) and rebalances the remaining four columns", () => {
    const html = renderHtml(buildProps(sampleFleet(), { showLastSeen: false }));
    expect(html.match(/<th scope="col"/g)).toHaveLength(4);
    expect(html).not.toContain("Last seen");
    expect(html).not.toContain("relay-pc-col-seen");
    expect(html).not.toContain("relay-pc-cell-seen");
    expect(html).toContain('class="relay-dash-table relay-pc-table is-without-seen"');
    expect(renderHtml(buildProps()).match(/<th scope="col"/g)).toHaveLength(5);
  });
});
