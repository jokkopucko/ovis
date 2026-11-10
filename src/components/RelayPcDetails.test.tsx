import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import * as ReactDom from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { dashboardModel, type DashboardPc } from "../lib/relay/dashboard.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import { SettingsProvider } from "../lib/settings.ts";

await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
const { RelayPcDetails } = await import("./RelayPcDetails.tsx");
import type { RelayPcDetailsProps } from "./RelayPcDetails.tsx";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const GLOBAL = "wss://relay.ovis.sh";
const SERVER_ID = "0123456789abcdef0123456789abcdef";

function makeRow(
  over: Partial<DashboardPc> = {},
  status?: PcStatus,
) {
  const pc: DashboardPc = {
    server_id: SERVER_ID,
    name: "Home server",
    state: "offline",
    relay: GLOBAL,
    last_seen_at: "2026-11-08T10:00:00.000Z",
    added_at: "2026-11-01T12:00:00.000Z",
    listed: true,
    paired: true,
    linked: true,
    ...over,
  };
  const m = dashboardModel([pc], { label: "Me", now: NOW, ...(status ? { status: new Map([[pc.server_id, status]]) } : {}) }, GLOBAL);
  const first = m.rows[0];
  if (!first) throw new Error("no row");
  return first;
}

const none = () => {};

function renderHtml(props: RelayPcDetailsProps): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(RelayPcDetails, props) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

describe("RelayPcDetails", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let wideMatches = true;

  beforeEach(() => {
    wideMatches = true;
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
      matches: query === "(max-width: 1099px)" ? !wideMatches : false,
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
        body: { nodeType: 1, children: [], createNodeMock: () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} }) },
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
  const mount = async (props: RelayPcDetailsProps) => {
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: createElement(RelayPcDetails, props) }), {
        createNodeMock: () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} }),
      });
    });
  };

  it("renders a 44px location bar with StatusDot glyph, PC name and Close/Back, plus state (no source line under it), relay, absolute last seen, check result, grouped key ID and observed version without opening a socket", () => {
    const row = makeRow({}, { kind: "offline", reason: "pc" });
    const html = renderHtml({
      pc: row,
      observedVersion: { version: "0.5.0", outdated: false, observedAt: "2026-11-08T11:30:00.000Z" },
      onClose: none,
      onForget: async () => {},
    });
    expect(html).toContain('data-pc-details="0123456789abcdef0123456789abcdef"');
    expect(html).toContain("Home server");
    expect(html).toContain("Offline");
    // the State field says the state alone: no "Account directory" line under it
    expect(html).not.toContain("Account directory");
    expect(/<dt>State<\/dt><dd>([\s\S]*?)<\/dd>/.exec(html)?.[1]).toBe('<span class="relay-pc-details-value">Offline</span>');
    expect(html).toContain("relay.ovis.sh");
    expect(html).toContain('dateTime="2026-11-08T10:00:00.000Z"');
    expect(html).toContain("This device: no answer");
    // Grouped KeyId in mono
    expect(html).toContain("0123");
    expect(html).toContain("cdef");
    // Observed version and observation time
    expect(html).toContain("0.5.0");
    expect(html).toContain('dateTime="2026-11-08T11:30:00.000Z"');
    // Paired PC offers Open and Forget
    expect(html).toContain(`href="/s/${SERVER_ID}/"`);
    expect(html).toContain("Forget this PC");
  });

  it("renders explicit Not checked / — for unknown relay, last seen, check result and version, and omits Open/Forget for unpaired PCs", () => {
    const unknownRow = makeRow({
      name: "Spare desktop",
      state: "needs-approval",
      relay: null,
      last_seen_at: null,
      paired: false,
      linked: false,
      join: { server_public_key: "k", relay: GLOBAL },
    });
    const html = renderHtml({
      pc: unknownRow,
      observedVersion: null,
      onClose: none,
      onOpenSheet: none,
    });
    expect(html).toContain("Spare desktop");
    expect(html).toContain("Not checked");
    expect(html).toContain("—");
    // Unpaired PC has no Open link and no Forget button
    expect(html).not.toContain(`href="/s/${SERVER_ID}/"`);
    expect(html).not.toContain("Forget this PC");
    // Instead offers Join
    expect(html).toContain("Join");
  });

  it("uses ConfirmDialog for Forget this PC and invokes onForget only after confirmation", async () => {
    const forgotten: string[] = [];
    let closed = 0;
    const row = makeRow({ state: "paired" });
    await mount({
      pc: row,
      onClose: () => { closed += 1; },
      onForget: async (id) => { forgotten.push(id); },
    });

    const forgetBtn = rootOf(renderer).find((n) => n.type === "button" && textOf(n) === "Forget this PC");
    await act(async () => { forgetBtn.props.onClick(); });

    const dialog = rootOf(renderer).find((n) => n.props.role === "alertdialog");
    expect(textOf(dialog)).toContain("Forget this PC?");

    // Cancel closes the confirmation without forgetting
    const cancelBtn = dialog.find((n) => n.type === "button" && textOf(n) === "Cancel");
    await act(async () => { cancelBtn.props.onClick(); });
    expect(forgotten).toEqual([]);
    expect(rootOf(renderer).findAll((n) => n.props.role === "alertdialog")).toHaveLength(0);

    // Re-open and confirm Forget
    await act(async () => { forgetBtn.props.onClick(); });
    const dialog2 = rootOf(renderer).find((n) => n.props.role === "alertdialog");
    const confirmBtn = dialog2.find((n) => n.type === "button" && textOf(n) === "Forget");
    await act(async () => { await confirmBtn.props.onClick(); });
    expect(forgotten).toEqual([SERVER_ID]);
  });

  it("makes the dashboard behind the Forget confirmation inert while it is up, and live again after Cancel and after Forget", async () => {
    const dashboard = { inert: false };
    const row = makeRow({ state: "paired" });
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: createElement(RelayPcDetails, { pc: row, onClose: none, onForget: async () => {} }) }), {
        createNodeMock: (element) => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: (selector: string) => element.type === "aside" && selector === ".relay-dash" ? dashboard : null, addEventListener() {}, removeEventListener() {} }),
      });
    });
    const forgetBtn = rootOf(renderer).find((n) => n.type === "button" && textOf(n) === "Forget this PC");
    const dialogButton = (label: string) => rootOf(renderer).find((n) => n.props.role === "alertdialog").find((n) => n.type === "button" && textOf(n) === label);

    expect(dashboard.inert).toBe(false);
    await act(async () => { forgetBtn.props.onClick(); });
    expect(dashboard.inert).toBe(true);
    await act(async () => { dialogButton("Cancel").props.onClick(); });
    expect(dashboard.inert).toBe(false);

    await act(async () => { forgetBtn.props.onClick(); });
    expect(dashboard.inert).toBe(true);
    await act(async () => { await dialogButton("Forget").props.onClick(); });
    expect(rootOf(renderer).findAll((n) => n.props.role === "alertdialog")).toHaveLength(0);
    expect(dashboard.inert).toBe(false);
  });

  it("shows Back in the location bar below 1100px and closes on Escape", async () => {
    wideMatches = false;
    let closed = 0;
    await mount({
      pc: makeRow(),
      onClose: () => { closed += 1; },
    });
    const backBtn = rootOf(renderer).find((n) => n.type === "button" && textOf(n).includes("Back"));
    await act(async () => { backBtn.props.onClick(); });
    expect(closed).toBe(1);

    const escapeEvent = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
    await act(async () => { window.dispatchEvent(escapeEvent); });
    expect(closed).toBe(2);
  });

  it("names the route this device reaches the PC by in its own labelled row: the way and the round trip, No answer, Not checked, or nothing for an unpaired PC", () => {
    const routeOf = (html: string) => /<dt>Route<\/dt><dd[^>]*>([\s\S]*?)<\/dd>/.exec(html)?.[1] ?? "";
    const text = (cell: string) => cell.replace(/<[^>]+>/g, "");
    expect(text(routeOf(renderHtml({ pc: makeRow({ state: "paired" }, { kind: "answered", route: "lan", rttMs: 4 }), onClose: none })))).toBe("Same network · 4 ms");
    expect(text(routeOf(renderHtml({ pc: makeRow({ state: "paired" }, { kind: "answered", route: "tailscale", rttMs: 18 }), onClose: none })))).toBe("Tailscale · 18 ms");
    const relayed = routeOf(renderHtml({ pc: makeRow({ state: "paired" }, { kind: "answered", route: "relay", relay: "wss://relay-ap.ovis.sh", rttMs: 62 }), onClose: none }));
    expect(relayed).toContain('<code class="relay-pc-relay-chip">relay-ap.ovis.sh</code>');
    expect(text(relayed)).toBe("relay-ap.ovis.sh · 62 ms");
    expect(text(routeOf(renderHtml({ pc: makeRow({}, { kind: "offline", reason: "relay" }), onClose: none })))).toBe("No answer");
    expect(text(routeOf(renderHtml({ pc: makeRow({ state: "paired" }), onClose: none })))).toBe("Not checked");
    expect(text(routeOf(renderHtml({ pc: makeRow({ state: "needs-approval", paired: false, linked: false }), onClose: none })))).toBe("—");
  });

  it("names the specific state the table names, Needs approval or Needs update, never the Needs you group word", () => {
    const stateOf = (html: string) => /<dt>State<\/dt><dd><span class="relay-pc-details-value">([^<]+)<\/span>/.exec(html)?.[1];
    const approval = renderHtml({ pc: makeRow({ state: "needs-approval", paired: false, linked: false, join: { server_public_key: "k", relay: GLOBAL } }), onClose: none, onOpenSheet: none });
    expect(stateOf(approval)).toBe("Needs approval");
    // a listed PC past its ten minutes says how this device gets in, in the table's and the overview's words
    expect(approval).toContain("Join · a device of your account connected to it approves");
    expect(approval).not.toContain("Add window closed");
    const update = renderHtml({ pc: makeRow({ state: "needs-update" }), onClose: none });
    expect(stateOf(update)).toBe("Needs update");
    expect(update).toContain("Update Ovis on it");
    expect(approval + update).not.toContain("Needs you");
    // a PC the account does not list reads by this device's check, as the table does: Answers / No answer, and Needs update when it is outdated even though it answered
    const unlisted = (status: PcStatus, over: Partial<DashboardPc> = {}) => renderHtml({ pc: makeRow({ state: "paired", listed: false, linked: false, last_seen_at: null, ...over }, status), onClose: none });
    expect(stateOf(unlisted({ kind: "answered", route: "lan", rttMs: 9 }))).toBe("Answers");
    expect(stateOf(unlisted({ kind: "offline", reason: "pc" }))).toBe("No answer");
    expect(stateOf(unlisted({ kind: "answered", route: "lan", rttMs: 9 }, { state: "needs-update" }))).toBe("Needs update");
    // a live answer from this device beats the directory's stale Offline: Ready, with the answer in Route and This device
    const reached = renderHtml({ pc: makeRow({}, { kind: "answered", route: "relay", relay: GLOBAL, rttMs: 42 }), onClose: none });
    expect(stateOf(reached)).toBe("Ready");
    expect(reached).toContain('<svg class="status-dot" data-state="ready"');
    expect(reached).not.toContain("Offline");
    expect(reached).toContain("This device: answered · 42 ms");
    expect(reached.replace(/<[^>]+>/g, "")).toContain("relay.ovis.sh · 42 ms");
  });

  it("checks this PC alone from Check now, says Checking… while its check runs, and offers no check for an unpaired PC", async () => {
    const checked: string[] = [];
    await mount({ pc: makeRow({ state: "paired" }), onClose: none, onCheckPc: (id) => { checked.push(id); } });
    const button = rootOf(renderer).find((n) => n.type === "button" && n.props["data-action"] === "check-pc");
    expect(textOf(button)).toBe("Check now");
    await act(async () => { button.props.onClick(); });
    expect(checked).toEqual([SERVER_ID]);
    expect(renderHtml({ pc: makeRow({ state: "paired" }, { kind: "checking" }), onClose: none, onCheckPc: none })).toContain('data-action="check-pc">Checking…</button>');
    expect(renderHtml({ pc: makeRow({ state: "needs-approval", paired: false, linked: false }), onClose: none, onCheckPc: none })).not.toContain("check-pc");
  });

  it("renders an explicit Not checked observation time when observedVersion has no observedAt", () => {
    const html = renderHtml({ pc: makeRow(), observedVersion: { version: "0.5.0", outdated: false }, onClose: none });
    const versionField = /<dt>Version<\/dt>([\s\S]*?)<\/dd>/.exec(html)?.[1] ?? "";
    expect(versionField).toContain("0.5.0");
    expect(versionField).toContain("Not checked");
  });
});
