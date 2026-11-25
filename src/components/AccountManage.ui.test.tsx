import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import * as ReactDom from "react-dom";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { PairedDevice } from "../../shared/protocol.ts";
import * as Api from "../lib/api.ts";
import * as Leave from "../lib/account/leave.ts";
import * as Service from "../lib/account/service.ts";
import * as Store from "../lib/account/store.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { AccountList, AccountListView } from "../lib/account/accountList.ts";
import { setPageAccountList } from "../lib/account/pageList.ts";
import * as Relay from "../lib/relay.ts";
import * as UseRelay from "../lib/useRelay.ts";

const MY_KEY = "my-key";
const NOW = Date.now();
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const device = (id: string, extra: Partial<PairedDevice> = {}): PairedDevice => ({ id, label: id, role: "drive", created_at: "", last_seen_at: "", current: false, ...extra });

let devices: PairedDevice[] = [];
let pcs: Service.DirectoryPc[] = [];
const calls: string[] = [];
let deleteFails = false;
/** PCR-1: the service wants a fresh sign-in for a removal, which only the sign-in again below ("fresh") has */
let refuseStale = false;
let readsFail = false;
let deviceReads = 0;
const SESSION = { account: "acct", provider: "github", service: "https://account.example", sign_in_id: "s", access_token: "a", refresh_token: "r", expires_at: NOW + 3_600_000 };

// the confirmation is a portal into document.body: drawn in place here, so the test renderer holds it
await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
await mock.module("../lib/api.ts", () => ({ ...Api, fetchDevices: async () => { deviceReads++; if (readsFail) throw new Error("503 from the PC"); return devices; } }));
await mock.module("../lib/account/leave.ts", () => ({ ...Leave, removeFromAccount: async (options: { key: string }) => { calls.push(`disconnect ${options.key}`); return { remove: {}, unconfirmed: [], queued: [] }; } }));
await mock.module("../lib/account/store.ts", () => ({ ...Store, indexedAccountStore: { ...Store.indexedAccountStore, key: async () => ({ public_spki: MY_KEY }), get: async (name: string) => name === "session" ? SESSION : undefined } }));
class FakeService {
  async listPcs() { if (readsFail) throw new Error("503 from the service"); return pcs; }
  async session() { return { account: "acct" }; }
  forSignIn(signIn: { sign_in_id?: string }) { return { deletePc: async (id: string) => {
    if (deleteFails) throw new Error("502 from the service");
    if (refuseStale && signIn.sign_in_id !== "fresh") throw new Service.AccountServiceError(403, "reauth_required", "Sign in again first");
    calls.push(`remove ${id}`);
  } }; }
}
await mock.module("../lib/account/service.ts", () => ({ ...Service, AccountService: FakeService }));
// a PC that leaves by an entry of the account's list: what the page asks of the list, and whether it forgot a pairing for it
await mock.module("../lib/account/listRemove.ts", () => ({ removeListPc: async (_list: unknown, endpoint: string, options: { expect?: { account: string; list: string; key?: string } }) => { calls.push(`list-remove ${endpoint} for ${options.expect?.account} ${options.expect?.list}${options.expect?.key === undefined ? "" : ` ${options.expect.key}`}`); return { removed: true }; } }));
// the PCs that posted their keys for the list, as the page reads them, and the number dialog it opens for one
let posted: { server_id: string; endpoint?: string; key?: string }[] | Error = [];
/** runs while the posts are read, before they come back */
let postsReading: () => void = () => {};
const ListAdd = await import("../lib/account/listAdd.ts");
await mock.module("../lib/account/listAdd.ts", () => ({ ...ListAdd, postedPcs: async () => { postsReading(); if (posted instanceof Error) throw posted; return posted; } }));
await mock.module("./AddPcByNumber.tsx", () => ({ AddPcByNumber: (props: { post: { server_id: string }; name: string; account: string; keys?: boolean; onAdded: () => void }) =>
  createElement("div", { "data-testid": "add-pc-number", "data-post": props.post.server_id, "data-name": props.name, "data-account": props.account, "data-keys": props.keys === true ? "yes" : "no", onClick: props.onAdded }) }));
let inShell = false;
await mock.module("../lib/useRelay.ts", () => ({ ...UseRelay, inRelayShell: () => inShell }));
await mock.module("../lib/relay.ts", () => ({ ...Relay, loadRelayShell: async () => ({ forgetSavedPc: async (id: string) => { calls.push(`forget pairing ${id}`); } }) }));
const { AccountManageLists } = await import("./AccountManage.tsx");
const { HostedAccountGroup } = await import("./AccountHead.tsx");
const { RelayShell } = await import("./RelayShell.tsx");
const { keepShellAccount } = await import("../lib/account/hostedSignIn.ts");

const textOf = (node: ReactTestInstance): string => node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

describe("Manage account's devices and PCs", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let warn: typeof console.warn;

  beforeEach(() => {
    warn = console.warn;
    console.warn = () => {};
    calls.length = 0;
    deleteFails = false;
    refuseStale = false;
    readsFail = false;
    deviceReads = 0;
    devices = [
      device("me", { current: true, account: "acct", account_key: MY_KEY, connection: { route: "relay", rtt_ms: 9 } as PairedDevice["connection"] }),
      device("Lost phone", { account: "acct", account_key: "phone-key" }),
      device("Other account", { account: "other", account_key: "x-key" }),
      device("Cookie browser"),
    ];
    pcs = [
      { server_id: "a".repeat(32), label: "Desk", public_key: null, relay: null, added_at: ago(60 * 24 * 300), last_seen_at: ago(2) },
      { server_id: "b".repeat(32), label: "Dead box", public_key: null, relay: null, added_at: ago(60), last_seen_at: ago(30) },
    ] as Service.DirectoryPc[];
    for (const key of ["window", "document", "navigator", "getComputedStyle", "matchMedia", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    class HTMLElement { isConnected = true; focus(): void {} }
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "https://pc.example/", search: "", origin: "https://pc.example", pathname: "/", protocol: "https:" },
      history: { state: null, replaceState() {} }, matchMedia, innerWidth: 1440, innerHeight: 900,
      requestAnimationFrame: () => 1, cancelAnimationFrame() {},
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      activeElement: new HTMLElement(), body: { nodeType: 1, children: [] },
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    console.warn = warn;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const mount = async (props: { watching?: boolean; onLeave?: () => Promise<void> } = {}): Promise<ReactTestInstance> => {
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: createElement(AccountManageLists, { account: "acct", watching: props.watching ?? false, ...(props.onLeave ? { onLeave: props.onLeave } : {}) }) }), {
        createNodeMock: () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} }),
      });
    });
    if (!renderer) throw new Error("not mounted");
    return renderer.root;
  };
  const rows = (root: ReactTestInstance, list: string) => root.find((node) => node.props["data-testid"] === list).findAll((node) => node.type === "li").map(textOf);
  const action = (root: ReactTestInstance, name: string) => root.find((node) => node.type === "button" && node.props["data-action"] === name);
  const dialog = (root: ReactTestInstance) => root.find((node) => node.props.role === "alertdialog");
  const press = (root: ReactTestInstance, label: string) => dialog(root).find((node) => node.type === "button" && textOf(node) === label).props.onClick();

  it("lists the account's other devices on this PC, one line each, and disconnects one after a single confirm", async () => {
    const root = await mount();
    expect(rows(root, "account-devices")).toEqual(["OfflineLost phoneDisconnect"]);
    await act(async () => { action(root, "disconnect-device").props.onClick(); });
    expect(textOf(dialog(root))).toContain("Disconnect Lost phone?");
    expect(calls).toEqual([]);
    await act(async () => { await press(root, "Disconnect"); });
    expect(calls).toEqual(["disconnect phone-key"]);
    expect(root.findAll((node) => node.props.role === "alertdialog")).toHaveLength(0);
  });

  it("offers Remove on an offline PC whatever its age, never on one heard from lately, and removes it after one confirm", async () => {
    const root = await mount();
    expect(rows(root, "account-pcs")).toEqual(["OnlineDesk", "OfflineDead boxRemove"]);
    await act(async () => { action(root, "remove-pc").props.onClick(); });
    expect(textOf(dialog(root))).toContain("Remove Dead box from your account?");
    await act(async () => { await press(root, "Remove"); });
    expect(calls).toEqual([`remove ${"b".repeat(32)}`]);
  });

  it("on an account with a list, removes a PC by an entry of the list and keeps this device's own pairing with it; a PC with no way to it is removable, and the rows follow the list", async () => {
    const LIST = "5c".repeat(32);
    const listed = (n: string, label: string) => ({ endpoint: n.repeat(64), server_id: n.repeat(32), how: "added" as const, allows: true, name: { label, os: null }, seq: 1, by: null, new_at: null });
    let view: AccountListView = { account: "acct", reached: true, status: { at: "following", list: LIST, standing: "in", head: 2, read_at: 1, trouble: null }, devices: [], pcs: [listed("c", "Laptop"), listed("a", "Desk")] };
    const heard: (() => void)[] = [];
    setPageAccountList({ view: () => view, subscribe: (listener: () => void) => { heard.push(listener); return () => {}; }, writer: () => ({ account: "acct", list: LIST, keys: { key: "member-key" }, state: { signers: {}, devices: {}, pcs: {}, invites: {} } }) } as unknown as AccountList);
    inShell = true;
    try {
      // the directory routes Desk (heard from lately) and names Dead box alone; the list holds Laptop with no route
      pcs = [{ ...pcs[0]!, public_key: "a".repeat(64), relay: "wss://relay.example" }, pcs[1]!] as Service.DirectoryPc[];
      const root = await mount();
      // this device may write the list, and Dead box posted no keys for it: it was not added from itself yet, or runs an
      // Ovis from before lists. Desk runs, and the list holds it: it is removable all the same (it comes back only anew)
      expect(rows(root, "account-pcs")).toEqual(["OfflineLaptopRemove", "OnlineDeskRemove", "OfflineDead box · Not in your account's list yet · Add it from that PC (ovis add, or Add this PC to my account there); update an Ovis older than 0.5.10 firstRemove"]);
      const removes = () => root.findAll((node) => node.type === "button" && node.props["data-action"] === "remove-pc");
      await act(async () => { removes()[0]!.props.onClick(); });
      expect(textOf(dialog(root))).toContain("Remove Laptop from your account?");
      await act(async () => { await press(root, "Remove"); });
      // signed into the list, for the account, the list and the member key the row came from, and no pairing of this device's was forgotten
      expect(calls).toEqual([`list-remove ${"c".repeat(64)} for acct ${LIST} member-key`]);
      // another device put Desk out: the rows are drawn again from the list, with no reload
      view = { ...view, pcs: [] };
      await act(async () => { for (const tell of heard) tell(); });
      expect(rows(root, "account-pcs").some((row) => row.includes("Laptop"))).toBe(false);
      // a PC the account service alone names leaves by the account service; on a device that goes by a list, no
      // pairing made with a PC itself is forgotten for it either
      calls.length = 0;
      await act(async () => { removes().at(-1)!.props.onClick(); });
      await act(async () => { await press(root, "Remove"); });
      expect(calls).toEqual([`remove ${"b".repeat(32)}`]);
    } finally { setPageAccountList(null); inShell = false; }
  });

  it("offers Remove for a running PC the account's list holds, through the same confirm, which says it comes back only as a new PC", async () => {
    const LIST = "5c".repeat(32);
    const view: AccountListView = { account: "acct", reached: true, status: { at: "following", list: LIST, standing: "in", head: 2, read_at: 1, trouble: null }, devices: [],
      pcs: [{ endpoint: "a".repeat(64), server_id: "a".repeat(32), how: "added", allows: true, name: { label: "Desk", os: null }, seq: 1, by: null, new_at: null }] };
    setPageAccountList({ view: () => view, subscribe: () => () => {}, writer: () => ({ account: "acct", list: LIST, keys: { key: "member-key" }, state: { signers: {}, devices: {}, pcs: {}, invites: {} } }) } as unknown as AccountList);
    try {
      // Desk was heard from a minute ago: on an account with no list it would list itself again, and no Remove is offered
      pcs = [{ ...pcs[0]!, public_key: "a".repeat(64), relay: "wss://relay.example" }] as Service.DirectoryPc[];
      const root = await mount();
      expect(rows(root, "account-pcs")).toEqual(["OnlineDeskRemove"]);
      await act(async () => { action(root, "remove-pc").props.onClick(); });
      expect(textOf(dialog(root))).toContain("Remove Desk from your account?");
      expect(textOf(dialog(root))).toContain("Desk leaves your account's list on every device, and your account's devices no longer open it; a device paired with Desk itself still does. It comes back to your account only as a new PC, added again on Desk.");
      await act(async () => { await press(root, "Remove"); });
      expect(calls).toEqual([`list-remove ${"a".repeat(64)} for acct ${LIST} member-key`]);
    } finally { setPageAccountList(null); }
  });

  it("a row drawn as the list's never leaves through the account service: with the list no longer followed at the press, nothing is removed, and it says why", async () => {
    const LIST = "5c".repeat(32);
    let view: AccountListView = { account: "acct", reached: true, status: { at: "following", list: LIST, standing: "in", head: 2, read_at: 1, trouble: null }, devices: [],
      pcs: [{ endpoint: "a".repeat(64), server_id: "a".repeat(32), how: "added", allows: true, name: { label: "Desk", os: null }, seq: 1, by: null, new_at: null }] };
    setPageAccountList({ view: () => view, subscribe: () => () => {}, writer: () => ({ account: "acct", list: LIST, keys: { key: "member-key" }, state: { signers: {}, devices: {}, pcs: {}, invites: {} } }) } as unknown as AccountList);
    try {
      pcs = [{ ...pcs[0]!, public_key: "a".repeat(64), relay: "wss://relay.example" }] as Service.DirectoryPc[];
      const root = await mount();
      expect(rows(root, "account-pcs")).toEqual(["OnlineDeskRemove"]);
      // the list stops being followed here before the press (its saved copy turned out damaged), and the row is not drawn again yet
      view = { ...view, status: { at: "damaged", why: "sum" } };
      await act(async () => { action(root, "remove-pc").props.onClick(); });
      await act(async () => { await press(root, "Remove"); });
      expect(calls).toEqual([]);
      expect(textOf(dialog(root).find((node) => node.props.role === "alert"))).toBe("This device cannot use your account's list right now, so the PC was not removed. Try again in a moment.");
    } finally { setPageAccountList(null); }
  });

  it("the question keeps the list row it was asked for: a PC another member put out meanwhile is not removed through the account service, and no pairing is forgotten", async () => {
    const LIST = "5c".repeat(32);
    const listed = (n: string, label: string) => ({ endpoint: n.repeat(64), server_id: n.repeat(32), how: "added" as const, allows: true, name: { label, os: null }, seq: 1, by: null, new_at: null });
    let view: AccountListView = { account: "acct", reached: true, status: { at: "following", list: LIST, standing: "in", head: 2, read_at: 1, trouble: null }, devices: [], pcs: [listed("c", "Laptop")] };
    const heard: (() => void)[] = [];
    setPageAccountList({ view: () => view, subscribe: (listener: () => void) => { heard.push(listener); return () => {}; }, writer: () => ({ account: "acct", list: LIST, keys: { key: "member-key" }, state: { signers: {}, devices: {}, pcs: {}, invites: {} } }) } as unknown as AccountList);
    inShell = true;
    try {
      // the directory still names Laptop, as it does for a while after the list put it out
      pcs = [{ ...pcs[1]!, server_id: "c".repeat(32), label: "Laptop", public_key: "c".repeat(64) }] as Service.DirectoryPc[];
      const root = await mount();
      await act(async () => { root.findAll((node) => node.type === "button" && node.props["data-action"] === "remove-pc")[0]!.props.onClick(); });
      expect(textOf(dialog(root))).toContain("Remove Laptop from your account?");
      // while the question is up, another member's removal of Laptop reaches this page
      view = { ...view, pcs: [] };
      await act(async () => { for (const tell of heard) tell(); });
      await act(async () => { await press(root, "Remove"); });
      // the removal is the one that was asked for: of that relay key, in that list, which finds it done
      expect(calls).toEqual([`list-remove ${"c".repeat(64)} for acct ${LIST} member-key`]);
    } finally { setPageAccountList(null); inShell = false; }
  });

  it("on a row the list does not hold yet, offers Add for a PC that posted its keys for the list and says to update one that did not", async () => {
    const LIST = "5c".repeat(32);
    const view: AccountListView = { account: "acct", reached: true, status: { at: "following", list: LIST, standing: "in", head: 2, read_at: 1, trouble: null }, devices: [],
      pcs: [{ endpoint: "a".repeat(64), server_id: "a".repeat(32), how: "added", allows: true, name: { label: "Desk", os: null }, seq: 1, by: null, new_at: null }] };
    let writes = true;
    setPageAccountList({ view: () => view, subscribe: () => () => {}, writer: () => (writes ? { account: "acct", list: LIST, keys: { key: "member-key" }, state: { signers: {}, devices: {}, pcs: {}, invites: {} } } : null) } as unknown as AccountList);
    try {
      pcs = [{ ...pcs[0]!, public_key: "a".repeat(64), relay: "wss://relay.example" }, pcs[1]!,
        { server_id: "d".repeat(32), label: "Old box", public_key: null, relay: null, added_at: ago(60), last_seen_at: ago(1) }] as Service.DirectoryPc[];
      // Dead box posted for the list; Old box runs a build from before lists
      posted = [{ server_id: "b".repeat(32) }];
      const root = await mount();
      expect(rows(root, "account-pcs")).toEqual(["OnlineDeskRemove", "OfflineDead box · Not in your account's list yetAddRemove", "OnlineOld box · Not in your account's list yet · Add it from that PC (ovis add, or Add this PC to my account there); update an Ovis older than 0.5.10 first"]);
      await act(async () => { action(root, "add-pc").props.onClick(); });
      const number = root.find((node) => node.props["data-testid"] === "add-pc-number");
      expect([number.props["data-post"], number.props["data-name"], number.props["data-account"]]).toEqual(["b".repeat(32), "Dead box", "acct"]);
      await act(async () => { number.props.onClick(); });
      expect(root.findAll((node) => node.props["data-testid"] === "add-pc-number")).toEqual([]);
      // a watching device adds nothing, and is told nothing it could do about it
      await act(async () => { renderer?.unmount(); });
      const watching = await mount({ watching: true });
      expect(rows(watching, "account-pcs")).toEqual(["OnlineDesk", "OfflineDead box · Not in your account's list yet", "OnlineOld box · Not in your account's list yet"]);
      // where the posts could not be read, or this device may not write the list, neither is said
      for (const unread of [() => { posted = new Error("503 from the service"); }, () => { posted = []; writes = false; }]) {
        unread();
        await act(async () => { renderer?.unmount(); });
        expect(rows(await mount(), "account-pcs")).toEqual(["OnlineDeskRemove", "OfflineDead box · Not in your account's list yetRemove", "OnlineOld box · Not in your account's list yet"]);
      }
    } finally { setPageAccountList(null); posted = []; }
  });

  it("on a row of a PC the move carried in with no key of its own, says so, offers Add for its keys once it posted, and leaves to its signer the PC only that device can finish", async () => {
    const LIST = "5c".repeat(32);
    const pc = (n: string, label: string, how: "added" | "carried", allows: boolean) => ({ endpoint: n.repeat(64), server_id: n.repeat(32), how, allows, name: { label, os: null }, seq: 1, by: null, new_at: null });
    const view: AccountListView = { account: "acct", reached: true, status: { at: "following", list: LIST, standing: "in", head: 4, read_at: 1, trouble: null },
      devices: [{ key: "tablet-key", name: { label: "Tablet", os: null } } as unknown as AccountListView["devices"][number]],
      pcs: [pc("a", "Desk", "added", true), pc("e", "Mover", "carried", false), pc("f", "Held", "added", true)] };
    const state = {
      level: 1, list: LIST, footing: { seq: 4, hash: "h".repeat(43) }, needs: 1, behind: null,
      signers: { "f-key": { power: "full", seq: 3, by: "tablet-key", ended: null, as: "pc" } }, devices: {}, invites: {},
      pcs: { ["e".repeat(64)]: { how: "carried", key: null, enc: null, seq: 1, invite: null, removed: null }, ["f".repeat(64)]: { how: "added", key: "f-key", enc: "f-enc", seq: 3, invite: null, removed: null } },
    };
    setPageAccountList({ view: () => view, subscribe: () => () => {}, writer: () => ({ account: "acct", list: LIST, keys: { key: "member-key" }, state }) } as unknown as AccountList);
    try {
      pcs = ["a", "e", "f"].map((n, index) => ({ server_id: n.repeat(32), label: ["Desk", "Mover", "Held"][index], public_key: n.repeat(64), relay: "wss://relay.example", added_at: ago(60 * 24 * 300), last_seen_at: ago(1) })) as Service.DirectoryPc[];
      // nothing posted yet: the PC is to run ovis add itself
      posted = [];
      expect(rows(await mount(), "account-pcs")).toEqual(["OnlineDeskRemove", "OnlineMover · No key of its own in your account's list yet · Run ovis add on that PC to give it one, and compare the number with this deviceRemove", "OnlineHeldRemove"]);
      // ovis add runs on both: Mover is given its keys from here; Held's keys were signed by the tablet, which alone finishes it
      posted = [{ server_id: "e".repeat(32), endpoint: "e".repeat(64), key: "e-key" }, { server_id: "f".repeat(32), endpoint: "f".repeat(64), key: "f-key" }];
      await act(async () => { renderer?.unmount(); });
      const root = await mount();
      expect(rows(root, "account-pcs")).toEqual(["OnlineDeskRemove", "OnlineMover · No key of its own in your account's list yetAddRemove", "OnlineHeld · Only Tablet can finish giving it its keys: compare the number on TabletRemove"]);
      await act(async () => { action(root, "add-pc").props.onClick(); });
      const number = root.find((node) => node.props["data-testid"] === "add-pc-number");
      expect([number.props["data-post"], number.props["data-name"], number.props["data-keys"]]).toEqual(["e".repeat(32), "Mover", "yes"]);
    } finally { setPageAccountList(null); posted = []; }
  });

  it("classifies the posts by the list as it stands once they are read: a PC another member put out meanwhile is offered no Add", async () => {
    const LIST = "5c".repeat(32);
    const view: AccountListView = { account: "acct", reached: true, status: { at: "following", list: LIST, standing: "in", head: 4, read_at: 1, trouble: null }, devices: [],
      pcs: [{ endpoint: "e".repeat(64), server_id: "e".repeat(32), how: "carried", allows: false, name: { label: "Mover", os: null }, seq: 1, by: null, new_at: null }] };
    const carried = (removed: number | null) => ({ level: 1, list: LIST, footing: { seq: 4, hash: "h".repeat(43) }, needs: 1, behind: null, signers: {}, devices: {}, invites: {},
      pcs: { ["e".repeat(64)]: { how: "carried", key: null, enc: null, seq: 1, invite: null, removed } } });
    let state = carried(null);
    setPageAccountList({ view: () => view, subscribe: () => () => {}, writer: () => ({ account: "acct", list: LIST, keys: { key: "member-key" }, state }) } as unknown as AccountList);
    try {
      pcs = [{ server_id: "e".repeat(32), label: "Mover", public_key: "e".repeat(64), relay: "wss://relay.example", added_at: ago(60), last_seen_at: ago(1) }] as Service.DirectoryPc[];
      posted = [{ server_id: "e".repeat(32), endpoint: "e".repeat(64), key: "e-key" }];
      postsReading = () => { state = carried(6); };
      const root = await mount();
      expect(root.findAll((node) => node.type === "button" && node.props["data-action"] === "add-pc")).toEqual([]);
    } finally { setPageAccountList(null); posted = []; postsReading = () => {}; }
  });

  it("keeps the confirm up with a retry line when the removal fails", async () => {
    deleteFails = true;
    const root = await mount();
    await act(async () => { action(root, "remove-pc").props.onClick(); });
    await act(async () => { await press(root, "Remove"); });
    expect(textOf(dialog(root).find((node) => node.props.role === "alert"))).toBe("Dead box could not be removed. Try again.");
  });

it("PCR-1: a removal that wants a fresh sign-in closes the confirm, and Sign in again removes that PC with the fresh sign-in", async () => {
    refuseStale = true;
    const signInsAgain: string[] = [];
    keepShellAccount({ signOut() {}, signOutEverywhere: async () => null, leave: async () => ({ left: true, message: null }), deleteAccount: async () => null,
      freshSignIn: async (from) => { signInsAgain.push(from.account); return { ...SESSION, sign_in_id: "fresh" } as Store.AccountSession; } });
    try {
      const root = await mount();
      await act(async () => { action(root, "remove-pc").props.onClick(); });
      await act(async () => { await press(root, "Remove"); });
      expect(root.findAll((node) => node.props.role === "alertdialog")).toHaveLength(0);
      expect(textOf(root.find((node) => node.props["data-pc-removal"] === "b".repeat(32)))).toContain("Sign in again to remove it: your sign-in is more than ten minutes old.");
      expect(calls).toEqual([]);
      const again = root.find((node) => node.type === "button" && textOf(node) === "Sign in again");
      await act(async () => { again.props.onClick(); });
      expect(signInsAgain).toEqual(["acct"]);
      expect(calls).toEqual([`remove ${"b".repeat(32)}`]);
      expect(root.findAll((node) => node.props["data-pc-removal"] !== undefined)).toHaveLength(0);
    } finally {
      keepShellAccount(null);
    }
  });

  it("says the lists could not be read rather than show an empty account", async () => {
    readsFail = true;
    const root = await mount();
    expect(rows(root, "account-devices")).toEqual(["Devices could not be loaded."]);
    expect(rows(root, "account-pcs")).toEqual(["PCs could not be loaded."]);
  });

  it("offers a watching device no PC removal", async () => {
    const root = await mount({ watching: true });
    expect(root.findAll((node) => node.type === "button" && node.props["data-action"] === "remove-pc")).toHaveLength(0);
  });

  it("lets this device leave the account from its own row, after a confirm, where the page offers it", async () => {
    let left = 0;
    const root = await mount({ onLeave: async () => { left++; } });
    expect(rows(root, "account-devices")[0]).toBe("This deviceDisconnect");
    await act(async () => { action(root, "leave-account").props.onClick(); });
    expect(left).toBe(0);
    await act(async () => { await press(root, "Disconnect"); });
    expect(left).toBe(1);
  });

  type Leave = (shown?: unknown) => Promise<{ readonly left: boolean; readonly message: string | null }>;
  type Everywhere = (asked?: unknown) => Promise<string | null>;
  const hosted = (leave: Leave, signOutEverywhere: Everywhere = async () => null) => ({ provider: "github" as const, account: "acct", signOut() {}, leave, deleteAccount: async () => null, signOutEverywhere });
  const group = (signIn: ReturnType<typeof hosted> | null) => createElement(SettingsProvider, { children: createElement(HostedAccountGroup, { signIn }) });
  const openSheet = async (signIn: ReturnType<typeof hosted>): Promise<ReactTestInstance> => {
    await act(async () => {
      renderer = create(group(signIn), {
        createNodeMock: () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} }),
      });
    });
    await act(async () => { action(renderer!.root, "manage-account").props.onClick(); });
    return renderer!.root;
  };

  it("names the account by the start of its ID, as ovis status does, for ovis add --account", async () => {
    const root = await openSheet({ ...hosted(async () => ({ left: true, message: null })), account: "acct_0123456789abcdef" });
    expect(textOf(root.find((node) => node.type === "div" && node.props["data-account-id"] === true))).toBe("Account IDacct_0123456");
  });

  it("signs every device out from Manage account after one short confirm that says PCs stay", async () => {
    let asked = 0;
    const root = await openSheet(hosted(async () => ({ left: true, message: null }), async () => { asked++; return null; }));
    expect(textOf(action(root, "sign-out-everywhere"))).toBe("Sign out every device");
    await act(async () => { action(root, "sign-out-everywhere").props.onClick(); });
    expect(asked).toBe(0);
    expect(textOf(root.find((node) => node.props["data-testid"] === "sign-out-everywhere-says"))).toBe("Every browser and app is signed out of the account. Devices paired with a PC can still open it, so cut off a lost device with Disconnect.");
    expect(action(root, "sign-out-everywhere").props["data-confirm"]).toBe("sign-out-everywhere");
    await act(async () => { action(root, "sign-out-everywhere").props.onClick(); });
    expect(asked).toBe(1);
  });

  /** A page list that shows this device in the account's list beside `others`, with what the sheet's rows read of it. */
  const listShowing = (others: readonly string[]) => {
    const LIST = "5c".repeat(32);
    const device = (key: string, self: boolean) => ({ key, self, power: "full" as const, role: "drive" as const, until: null, carried: false, name: { label: key, os: null } });
    let view: AccountListView = { account: "acct", reached: true, status: { at: "following", list: LIST, standing: "in", head: 2, read_at: 1, trouble: null }, devices: [device("member-key", true), ...others.map((key) => device(key, false))], pcs: [] };
    const heard: (() => void)[] = [];
    setPageAccountList({ view: () => view, subscribe: (listener: () => void) => { heard.push(listener); return () => {}; }, writer: () => ({ account: "acct", list: LIST, keys: { key: "member-key" }, state: { signers: {}, devices: {}, pcs: {}, invites: {} } }) } as unknown as AccountList);
    return { LIST, device, heard, set: (next: AccountListView) => { view = next; }, view: () => view };
  };

  it("H1: Sign out every device passes the devices its question named and the list it was asked in, not what the list shows at the press", async () => {
    const shown = listShowing(["Tablet"]);
    try {
      let asked: unknown = null;
      const root = await openSheet(hosted(async () => ({ left: true, message: null }), async (question?: unknown) => { asked = question; return null; }));
      await act(async () => { action(root, "sign-out-everywhere").props.onClick(); });
      // a device comes in after the question was drawn
      shown.set({ ...shown.view(), devices: [...shown.view().devices, shown.device("Newcomer", false)] });
      await act(async () => { for (const tell of shown.heard) tell(); });
      await act(async () => { action(root, "sign-out-everywhere").props.onClick(); });
      expect(asked).toEqual({ confirmed: ["Tablet"], shown: { account: "acct", scope: { account: "acct", list: shown.LIST, member: "member-key" } } });
    } finally { setPageAccountList(null); }
  });

  it("H1: Disconnect passes the account, the list and the member key its question was drawn for", async () => {
    const shown = listShowing(["Tablet"]);
    try {
      let asked: unknown = null;
      const root = await openSheet(hosted(async (question?: unknown) => { asked = question; return { left: true, message: null }; }));
      await act(async () => { action(root, "leave-account").props.onClick(); });
      await act(async () => { await press(root, "Disconnect"); });
      expect(asked).toEqual({ account: "acct", scope: { account: "acct", list: shown.LIST, member: "member-key" } });
    } finally { setPageAccountList(null); }
  });

  it("keeps the sheet up with the reason when every device could not be signed out", async () => {
    const root = await openSheet(hosted(async () => ({ left: true, message: null }), async () => "Could not sign out every device. Try again."));
    await act(async () => { action(root, "sign-out-everywhere").props.onClick(); });
    await act(async () => { action(root, "sign-out-everywhere").props.onClick(); });
    expect(sheets(root)).toHaveLength(1);
    expect(root.findAll((node) => node.props.role === "alert").map(textOf)).toContain("Could not sign out every device. Try again.");
    expect(textOf(action(root, "sign-out-everywhere"))).toBe("Sign out every device");
  });

  const leaveFromSheet = async (leave: Leave): Promise<ReactTestInstance> => {
    await act(async () => {
      renderer = create(group(hosted(leave)), {
        createNodeMock: () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} }),
      });
    });
    const root = renderer!.root;
    await act(async () => { action(root, "manage-account").props.onClick(); });
    await act(async () => { action(root, "leave-account").props.onClick(); });
    await act(async () => { await press(root, "Disconnect"); });
    return root;
  };
  const sheets = (root: ReactTestInstance) => root.findAll((node) => node.type === "div" && node.props["data-testid"] === "manage-account");

  it("keeps the sheet and its confirm up with the error when this device could not leave the account", async () => {
    const root = await leaveFromSheet(async () => ({ left: false, message: "This device could not leave the account. Try again." }));
    expect(textOf(dialog(root).find((node) => node.props.role === "alert"))).toBe("This device could not leave the account. Try again.");
    expect(sheets(root)).toHaveLength(1);
  });

  it("names the PCs that kept this device in the sheet after a partial leave whose sign-in went before its outcome came", async () => {
    // as leave.ts does: the stored sign-in is cleared (the hook reads null) while the leave still names the PCs
    const outcome = Promise.withResolvers<{ left: boolean; message: string | null }>();
    await act(async () => {
      renderer = create(group(hosted(() => outcome.promise)), {
        createNodeMock: () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} }),
      });
    });
    const root = renderer!.root;
    await act(async () => { action(root, "manage-account").props.onClick(); });
    await act(async () => { action(root, "leave-account").props.onClick(); });
    let pressed: Promise<void> | undefined;
    await act(async () => { pressed = press(root, "Disconnect"); });
    await act(async () => { renderer!.update(group(null)); });
    expect(sheets(root)).toHaveLength(1);
    await act(async () => { outcome.resolve({ left: true, message: "These PCs still have it, so revoke it on them: Desk" }); await pressed; });
    expect(root.findAll((node) => node.props.role === "alertdialog")).toHaveLength(0);
    expect(sheets(root)).toHaveLength(1);
    expect(textOf(sheets(root)[0]!.find((node) => node.props.role === "alert"))).toBe("These PCs still have it, so revoke it on them: Desk");
  });

  const startScreen = async (): Promise<ReactTestInstance> => {
    const none = () => {};
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: createElement(RelayShell, {
        state: { kind: "list", devices: [], account: { kind: "signed-in", provider: "github", error: null, pcs: [] } },
        scoped: false, iosTab: false, onSignIn: none, onPair: none, onRetry: none, onCancel: none, onBack: none, onForget: none, onUpdate: none, onMatch: none, onCodeStart: none, onCodeSubmit: none, onCodeMatch: none,
      }) }), {
        createNodeMock: () => ({ isConnected: true, focus() {}, contains: () => false, querySelector: () => null, querySelectorAll: () => [], getClientRects: () => [], getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }), closest: () => null, addEventListener() {}, removeEventListener() {} }),
      });
    });
    return renderer!.root;
  };
  const menuItem = (root: ReactTestInstance, id: string) => root.find((node) => node.type === "button" && node.props["data-item"] === id);

  it("keeps the signed-in start screen's account in its ⋮ menu: who is signed in, Manage account and Sign out, and no link under the tabs", async () => {
    let signedOut = 0;
    keepShellAccount({ signOut: () => { signedOut += 1; }, leave: async () => ({ left: true, message: null }), deleteAccount: async () => null, signOutEverywhere: async () => null });
    try {
      const root = await startScreen();
      expect(root.findAll((node) => node.type === "button" && node.props["data-action"] === "manage-account")).toHaveLength(0);
      await act(async () => { action(root, "account-menu").props.onClick(); });
      const menu = root.find((node) => node.props.role === "menu");
      expect(textOf(menu)).toContain("Signed in with GitHub");
      expect(menu.findAll((node) => node.type === "button").map((node) => node.props["data-item"])).toEqual(["manage-account", "sign-out"]);
      await act(async () => { menuItem(root, "sign-out").props.onClick(); });
      expect(signedOut).toBe(1);
    } finally {
      keepShellAccount(null);
    }
  });

  it("opens Manage account from the signed-in start screen with no PC open, and removes an offline PC through the account service", async () => {
    const none = () => {};
    keepShellAccount({ signOut: none, leave: async () => ({ left: true, message: null }), deleteAccount: async () => null, signOutEverywhere: async () => null });
    try {
      const root = await startScreen();
      await act(async () => { action(root, "account-menu").props.onClick(); });
      await act(async () => { menuItem(root, "manage-account").props.onClick(); });
      // no PC answers here: the sheet asks none for its devices, and offers this device's own row
      expect(deviceReads).toBe(0);
      expect(rows(root, "account-devices")).toEqual(["This deviceDisconnect"]);
      expect(rows(root, "account-pcs")).toEqual(["OnlineDesk", "OfflineDead boxRemove"]);
      await act(async () => { action(root, "remove-pc").props.onClick(); });
      await act(async () => { await press(root, "Remove"); });
      expect(calls).toEqual([`remove ${"b".repeat(32)}`]);
    } finally {
      keepShellAccount(null);
    }
  });

  it("closes the sheet once this device left everywhere", async () => {
    const root = await leaveFromSheet(async () => ({ left: true, message: null }));
    expect(sheets(root)).toHaveLength(0);
  });
});
