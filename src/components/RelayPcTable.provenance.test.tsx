import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { dashboardModel, type DashboardFilter, type DashboardPc } from "../lib/relay/dashboard.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { RelayMap } from "./RelayMap.tsx";
import { RelayOverview } from "./RelayOverview.tsx";
import { RelayPcDetails } from "./RelayPcDetails.tsx";
import { RelayPcTable } from "./RelayPcTable.tsx";

const RELAY = "wss://relay.ovis.sh";
const NOW = Date.parse("2026-11-08T12:00:00Z");
const none = () => {};
const pc = (server_id: string, extra: Partial<DashboardPc> = {}): DashboardPc => ({
  server_id, name: server_id, state: "paired", relay: RELAY,
  listed: true, paired: true, linked: true,
  last_seen_at: "2026-11-08T11:59:00Z", added_at: null, ...extra,
});

function renderFleet(pcs: readonly DashboardPc[], status: ReadonlyMap<string, PcStatus>, filter: DashboardFilter = "all") {
  const model = dashboardModel(pcs, { label: "Me", now: NOW, status }, RELAY);
  return renderToStaticMarkup(<SettingsProvider><>
    <RelayOverview pcs={pcs} pcStatus={status} defaultRelay={RELAY} now={NOW} />
    <RelayPcTable rows={model.rows} filters={model.filters} filter={filter} onSelect={none} onOpenSheet={none} now={NOW} />
    {model.rows.map((row) => <RelayPcDetails key={row.server_id} pc={row} onClose={none} now={NOW} />)}
    <RelayMap map={model.map} />
  </></SettingsProvider>);
}

const rowIds = (html: string) => [...html.matchAll(/<tr[^>]*data-pc-id="([^"]+)"/g)].map((match) => match[1]);
const stripCount = (html: string, key: string) => Number(new RegExp(`data-strip-cell="${key}"[^>]*data-strip-count="(\\d+)"`).exec(html)?.[1]);

describe("dashboard state provenance across rendered surfaces", () => {
  let languages: PropertyDescriptor | undefined;
  beforeEach(() => {
    languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  });
  afterEach(() => {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  });

  it("keeps directory-error pairings out of Ready until this device or the account confirms them", () => {
    const pcs = ["Desk", "Laptop", "Home", "NUC"].map((id) => pc(id, { listed: false, linked: false, last_seen_at: null }));
    const html = renderFleet(pcs, new Map());
    expect(stripCount(html, "ready")).toBe(0);
    expect(rowIds(renderFleet(pcs, new Map(), "ready"))).toEqual([]);
    expect(rowIds(html)).toEqual(["Desk", "Home", "Laptop", "NUC"]);
    expect([...html.matchAll(/class="relay-pc-state-word"[^>]*>([^<]+)/g)].map((match) => match[1])).toEqual(Array(4).fill("Paired · not checked"));
    expect(html).toContain("PCs: 4. Seen lately: 0. Ready: 0.");
  });

  it("puts an answered stale-offline PC in Ready on every surface and removes it from attention", () => {
    const pcs = [
      pc("Answered", { state: "offline", last_seen_at: "2026-11-01T00:00:00Z" }),
      pc("Unchecked", { listed: false, linked: false, last_seen_at: null }),
      pc("Offline", { state: "offline", last_seen_at: "2026-11-01T00:00:00Z" }),
      pc("Update", { state: "needs-update" }),
      pc("Account"),
    ];
    const status = new Map<string, PcStatus>([
      ["Answered", { kind: "answered", route: "lan", rttMs: 9 }],
      ["Update", { kind: "answered", route: "relay", relay: RELAY, rttMs: 42 }],
    ]);
    const ready = renderFleet(pcs, status, "ready");
    expect(rowIds(ready)).toEqual(["Account", "Answered"]);
    expect(stripCount(ready, "ready")).toBe(2);
    expect(rowIds(renderFleet(pcs, status, "needs"))).toEqual(["Update", "Offline"]);
    expect(stripCount(ready, "needs")).toBe(2);
    expect(rowIds(renderFleet(pcs, status, "offline"))).toEqual(["Offline"]);
    const attention = /<ol class="relay-overview-attention">([\s\S]*?)<\/ol>/.exec(ready)?.[1] ?? "";
    expect(attention).toContain("Update");
    expect(attention).toContain("Offline");
    expect(attention).not.toContain("Answered");
    expect(ready).toMatch(/data-pc-details="Answered"[\s\S]*?<dt>State<\/dt><dd><span[^>]*>Ready<\/span>/);
    expect(ready).toContain('data-pc-node="Answered" data-pc-state="paired"');
    expect(ready).toContain("PCs: 5. Seen lately:");
    expect(ready).toContain("Ready: 2. Needs you: 2. Offline: 1.");
  });

  it.each(["pending", "failed"] as const)("keeps primary state and action when enrollment is %s", (enrollment) => {
    const pcs = [
      pc("Update", { state: "needs-update", enrollment }),
      pc("Offline", { state: "offline", enrollment }),
    ];
    const html = renderFleet(pcs, new Map());
    const update = /<tr[^>]*data-pc-id="Update"[\s\S]*?<\/tr>/.exec(html)?.[0] ?? "";
    const offline = /<tr[^>]*data-pc-id="Offline"[\s\S]*?<\/tr>/.exec(html)?.[0] ?? "";
    expect(update).toMatch(/class="relay-pc-state-word"[^>]*>Needs update<\/span>/);
    expect(update).toContain('data-pc-action="update">Update</a>');
    expect(offline).toMatch(/class="relay-pc-state-word"[^>]*>Machine offline/);
    expect(offline).toContain('data-pc-action="details">Details</button>');
    expect(update).toContain(enrollment === "pending" ? "Adding it to your account…" : "Account setup is incomplete.");
    expect(offline).toContain(enrollment === "pending" ? "Adding it to your account…" : "Account setup is incomplete.");
    const enrollmentText = enrollment === "pending" ? "Adding it to your account…" : "Account setup is incomplete.";
    const lines = (rowHtml: string) => [...rowHtml.matchAll(/class="relay-pc-probe-line"[^>]*>([^<]+)</g)].map((match) => match[1]);
    expect(lines(update)).toEqual([enrollmentText, "Update Ovis on it"]);
    expect(lines(offline)).toEqual([enrollmentText]);
    const model = dashboardModel(pcs, { label: "Me", now: NOW, status: new Map() }, RELAY);
    const phone = renderToStaticMarkup(<SettingsProvider><RelayPcTable rows={model.rows} narrow onSelect={none} onOpenSheet={none} now={NOW} /></SettingsProvider>);
    const phoneUpdate = /<li[^>]*data-pc-id="Update"[\s\S]*?<\/li>/.exec(phone)?.[0] ?? "";
    expect(lines(phoneUpdate)).toEqual([enrollmentText, "Update Ovis on it"]);
  });
});
