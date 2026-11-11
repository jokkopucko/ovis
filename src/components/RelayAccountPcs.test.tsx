import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import type { AccountPcEntry } from "../lib/api.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { RelayAccountPcs, type AccountPcsSource } from "./RelayAccountPcs.tsx";

// Add a connection → Ovis relay, signed in with this PC in the account: the account's other PCs, each with Connect
// (already in this app), Add (it would pair) or what keeps it from pairing; Add posts the admission naming the key this
// PC's server made, shows the digits while a member approves elsewhere, and opens the PC once it is added.
const pc = (id: string, name: string): AccountPcEntry => ({ server_id: id.repeat(32).slice(0, 32), server_public_key: "key", relay: "wss://relay.ovis.example", name });
const OWN = pc("0", "This PC");
const DESK = pc("d", "Desk");
const LAB = pc("1", "Lab");
const OLD = pc("2", "Old box");
const AWAY = pc("3", "Away");
const local = { id: "local", name: "This PC", kind: "local", server_id: OWN.server_id } as unknown as Machine;
const lab = { id: "lab-id", name: "Lab", kind: "relay", relay: { server_id: LAB.server_id, relay: LAB.relay } } as unknown as Machine;
const added = { id: "desk-id", name: "Desk", kind: "relay", relay: { server_id: DESK.server_id, relay: DESK.relay } } as unknown as Machine;

describe("the account's PCs in the relay tab", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let requests: { path: string; body: unknown; signal?: AbortSignal | null }[];
  let pairLines: ReadableStreamDefaultController<Uint8Array> | undefined;
  let admitted: [string, string, string][];
  let source: AccountPcsSource;
  let refuseCheck: boolean;
  /** PCs whose entry this PC's server refuses (account_pc_invalid), and PCs whose answer waits until released */
  let invalid: Set<string>;
  let slow: Map<string, { promise: Promise<void> }>;

  beforeEach(() => {
    requests = [];
    admitted = [];
    pairLines = undefined;
    refuseCheck = false;
    invalid = new Set();
    slow = new Map();
    source = { list: async () => [OWN, DESK, LAB, OLD, AWAY], admit: async (...args) => { admitted.push(args); } };
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "http://127.0.0.1:7318/", origin: "http://127.0.0.1:7318" },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1:7318").pathname;
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ path, body, signal: init?.signal ?? null });
      if (path === "/api/machines/relay/account/check" && refuseCheck) return Response.json({ error: { code: "owner_only", message: "no" } }, { status: 403 });
      if (path === "/api/machines/relay/account/check") {
        const asked = (body as { pcs: AccountPcEntry[] }).pcs;
        // the server refuses the whole batch for one entry it cannot use, and answers once every PC in it did
        if (asked.some((entry) => invalid.has(entry.server_id))) return Response.json({ error: { code: "account_pc_invalid", message: "no" } }, { status: 400 });
        for (const entry of asked) await slow.get(entry.server_id)?.promise;
        const states: Record<string, string> = { [DESK.server_id]: "ready", [LAB.server_id]: "ready", [OLD.server_id]: "outdated", [AWAY.server_id]: "offline" };
        return Response.json({ pcs: asked.map((entry) => ({ server_id: entry.server_id, state: states[entry.server_id] })) });
      }
      if (path === "/api/machines/relay/account/start") return Response.json({ ticket: "ticket-1", key: "a-key", label: "Ovis on here" });
      if (path === "/api/machines/relay/account/pair") return new Response(new ReadableStream<Uint8Array>({ start: (controller) => { pairLines = controller; } }));
      return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    mock.restore();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const rows = () => renderer!.root.findAll((node) => node.type === "li").map((row) => [
    text(row.findByProps({ className: "connect-found-name" })), text(row.findByProps({ className: "connect-found-detail" })),
    row.findAll((node) => node.type === "button").map((button) => text(button)).join(","),
  ]);
  const button = (label: string) => renderer!.root.find((node) => node.type === "button" && (node.props["aria-label"] ?? text(node)) === label);
  const line = async (value: unknown) => { await act(async () => { pairLines!.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`)); }); };
  const tree = (machines: readonly Machine[], onConnect: (machine: Machine) => void) => <SettingsProvider><RelayAccountPcs machines={machines} onConnectMachine={onConnect} source={source} /></SettingsProvider>;
  const mount = async (onConnect: (machine: Machine) => void = () => {}, machines: readonly Machine[] = [local, lab]) => {
    await act(async () => { renderer = create(tree(machines, onConnect)); });
  };

  it("lists the account's other PCs as the SSH tab does: Connect, Add, or why not, never this PC", async () => {
    const connected: Machine[] = [];
    await mount((machine) => connected.push(machine));
    expect(rows()).toEqual([
      ["Desk", "Online", "Add"], ["Lab", "In this app", "Connect"], ["Old box", "Update Ovis on that PC", ""], ["Away", "Offline", ""],
    ]);
    // the PC already in the list is not asked whether it would pair
    expect(requests.filter((request) => request.path.endsWith("/check")).map((request) => request.body)).toEqual([{ pcs: [DESK] }, { pcs: [OLD] }, { pcs: [AWAY] }]);
    await act(async () => { button("Connect").props.onClick(); });
    expect(connected).toEqual([lab]);
  });

  it("adds a PC: the admission names the key this PC's server made, the digits show while a member approves, then it opens", async () => {
    const connected: Machine[] = [];
    await mount((machine) => connected.push(machine));
    await act(async () => { button("Add Desk").props.onClick(); });
    expect(requests.find((request) => request.path.endsWith("/start"))?.body).toEqual({ pc: DESK });
    expect(admitted).toEqual([[DESK.server_id, "Ovis on here", "a-key"]]);
    expect(requests.find((request) => request.path.endsWith("/pair"))?.body).toEqual({ ticket: "ticket-1" });
    await line({ digits: "123456" });
    const waiting = renderer!.root.findByProps({ className: "relay-account-wait" });
    expect(text(waiting)).toBe("Approve on another device of your account123 456");
    expect(rows()[0]).toEqual(["Desk", "Online", "Cancel"]);
    await line({ machine: added });
    expect(connected).toEqual([added]);
  });

  it("says why a PC was not added, and marks an older one", async () => {
    await mount();
    await act(async () => { button("Add Desk").props.onClick(); });
    await line({ digits: "123456" });
    await line({ error: { code: "account_pc_declined", message: "That PC was not approved. Nothing was added." } });
    expect(renderer!.root.findAll((node) => node.props.role === "alert").map(text)).toEqual(["That PC was not approved. Nothing was added."]);
    expect(renderer!.root.findAllByProps({ className: "relay-account-wait" })).toEqual([]);
  });

  it("cancels the comparison on this PC's server when the sheet closes while it waits", async () => {
    await mount();
    await act(async () => { button("Add Desk").props.onClick(); });
    await line({ digits: "123456" });
    const signal = requests.find((request) => request.path.endsWith("/pair"))!.signal!;
    expect(signal.aborted).toBe(false);
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    expect(signal.aborted).toBe(true);
  });

  it("shows no list, rather than rows checking for good, when this PC will not say whether they would pair", async () => {
    refuseCheck = true;
    await mount();
    expect(renderer!.toJSON()).toBeNull();
  });

  it("leaves out only a PC whose entry this PC cannot use", async () => {
    invalid.add(OLD.server_id);
    await mount();
    expect(rows()).toEqual([["Desk", "Online", "Add"], ["Lab", "In this app", "Connect"], ["Away", "Offline", ""]]);
  });

  it("shows each PC's state as it comes: one slow to answer holds no other row on Checking…", async () => {
    let release = () => {};
    slow.set(AWAY.server_id, { promise: new Promise<void>((resolve) => { release = resolve; }) });
    await mount();
    expect(rows()).toEqual([
      ["Desk", "Online", "Add"], ["Lab", "In this app", "Connect"], ["Old box", "Update Ovis on that PC", ""], ["Away", "Checking…", ""],
    ]);
    await act(async () => { release(); });
    expect(rows()[3]).toEqual(["Away", "Offline", ""]);
  });

  it("asks about a PC once another window removed it from this app", async () => {
    await mount();
    expect(rows()[1]).toEqual(["Lab", "In this app", "Connect"]);
    await act(async () => { renderer!.update(tree([local], () => {})); });
    expect(rows()[1]).toEqual(["Lab", "Online", "Add"]);
    expect(requests.filter((request) => request.path.endsWith("/check")).map((request) => request.body)).toContainEqual({ pcs: [LAB] });
  });

  it("shows nothing when this page is not signed in", async () => {
    source = { list: async () => null, admit: async () => { throw new Error("not signed in"); } };
    await mount();
    expect(renderer!.toJSON()).toBeNull();
    expect(requests).toEqual([]);
  });
});
