import type { DashboardFilter } from "./dashboard.ts";

export const DASHBOARD_VIEWS = ["overview", "pcs", "devices", "relay", "settings"] as const;
export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

export interface DashboardRoute {
  readonly view: DashboardView;
  readonly filter: DashboardFilter;
  readonly relay: string | null;
  readonly pc: string | null;
}

const LEGACY_VIEW: Readonly<Record<string, DashboardView>> = {
  "relay-dash-overview": "overview",
  "relay-dash-pcs": "pcs",
  "relay-dash-device": "devices",
  "relay-dash-devices": "devices",
  "relay-dash-relays": "relay",
  "relay-dash-relay": "relay",
  "relay-dash-settings": "settings",
};

function isView(value: string): value is DashboardView {
  return (DASHBOARD_VIEWS as readonly string[]).includes(value);
}

function isFilter(value: string | null): value is DashboardFilter {
  return value === "all" || value === "ready" || value === "needs" || value === "offline";
}

function parseHead(raw: string): DashboardView | null {
  if (isView(raw)) return raw;
  return Object.hasOwn(LEGACY_VIEW, raw) ? LEGACY_VIEW[raw] ?? null : null;
}

/**
 * True when `hash` is a dashboard route fragment (`#overview`, `#pcs?...`, or a legacy
 * `#relay-dash-*` anchor), never an OAuth callback, pairing offer or PC-app fragment.
 */
export function isDashboardHash(hash: string | null | undefined): boolean {
  if (!hash || !hash.startsWith("#")) return false;
  const body = hash.slice(1);
  if (body === "") return false;
  const q = body.indexOf("?");
  const head = q === -1 ? body : body.slice(0, q);
  return parseHead(head) !== null;
}

export function parseDashboardHash(hash: string | null | undefined): DashboardRoute {
  const input = hash ?? "";
  const raw = input.startsWith("#") ? input.slice(1) : input;
  const q = raw.indexOf("?");
  const head = q === -1 ? raw : raw.slice(0, q);
  const view = parseHead(head) ?? "overview";
  if (view !== "pcs" || q === -1) {
    return { view, filter: "all", relay: null, pc: null };
  }
  const params = new URLSearchParams(raw.slice(q + 1));
  const filterParam = params.get("filter");
  const filter: DashboardFilter = isFilter(filterParam) ? filterParam : "all";
  const relayParam = params.get("relay")?.trim() ?? "";
  const pcParam = params.get("pc")?.trim() ?? "";
  return {
    view: "pcs",
    filter,
    relay: relayParam.length > 0 ? relayParam : null,
    pc: pcParam.length > 0 ? pcParam : null,
  };
}

export function formatDashboardHash(route: {
  readonly view: DashboardView;
  readonly filter?: DashboardFilter;
  readonly relay?: string | null;
  readonly pc?: string | null;
}): string {
  if (route.view !== "pcs") return `#${route.view}`;
  const params = new URLSearchParams();
  if (route.filter && route.filter !== "all") params.set("filter", route.filter);
  if (route.relay) params.set("relay", route.relay);
  if (route.pc) params.set("pc", route.pc);
  const query = params.toString();
  return query.length > 0 ? `#pcs?${query}` : "#pcs";
}
