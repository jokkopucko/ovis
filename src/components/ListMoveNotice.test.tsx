import { afterEach, beforeEach, expect, it } from "bun:test";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { AccountList, AccountListView } from "../lib/account/accountList.ts";
import type { MoveNoticeView } from "../lib/account/listMigrate.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { ListJoinRefusal, ListMoveNotice } from "./ListMoveNotice.tsx";

const ACCOUNT = "acct_moved";
const LIST = "5c".repeat(32);
const E = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const globals = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  for (const [key, value] of Object.entries({
    IS_REACT_ACT_ENVIRONMENT: true, window: new EventTarget(), location: new URL("https://app.ovis.sh/"),
    document: Object.assign(new EventTarget(), { visibilityState: "visible", querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }), navigator: { languages: ["en"] }, localStorage: { getItem: () => null, setItem: () => {} },
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  for (const [key, descriptor] of globals) {
    if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[key];
    else Object.defineProperty(globalThis, key, descriptor);
  }
  globals.clear();
});

const following: AccountListView = { account: ACCOUNT, reached: true, status: { at: "following", list: LIST, standing: "in", head: 5, read_at: 1, trouble: null }, devices: [], pcs: [] };

function listWith(view: AccountListView, notice: MoveNoticeView | null) {
  const seen: string[] = [];
  const list = {
    view: () => view, subscribe: () => () => {},
    writer: () => (view.status.at === "following" ? { account: view.account, list: view.status.list, keys: { key: "MEMBER" } } : null),
    notice: async () => (seen.length > 0 ? null : notice),
    noticeSeen: async (_account: string, list: string) => { seen.push(list); },
  } as unknown as AccountList;
  return { list, seen };
}

const text = (): string => JSON.stringify(renderer?.toJSON() ?? null);
const settle = async (): Promise<void> => { await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); }); };

it("says once who made the list and whom it brought in, with Not me on each PC, and is not shown again after OK", async () => {
  const notice: MoveNoticeView = { list: LIST, first: { self: true, key: "G", name: null }, devices: [{ key: "K", name: { label: "Laptop", os: null } }], pcs: [{ endpoint: E(1), name: { label: "Desk", os: null } }], removed: [] };
  const { list, seen } = listWith(following, notice);
  const removed: string[] = [];
  await act(async () => { renderer = create(<SettingsProvider><ListMoveNotice list={list} removePc={async (endpoint) => { removed.push(endpoint); return true; }} /></SettingsProvider>); });
  await settle();
  expect(text()).toContain("This device made your account's list.");
  expect(text()).toContain("Laptop");
  expect(text()).toContain("Desk");
  const notMe = renderer!.root.findAll((node) => node.type === "button" && node.props.children === "Not me");
  expect(notMe).toHaveLength(1);
  await act(async () => { notMe[0]!.props.onClick(); });
  // asked first, as Remove asks
  expect(text()).toContain("Remove Desk from your account?");
  const yes = renderer!.root.findAll((node) => node.type === "button" && node.props.children === "Remove")[0]!;
  await act(async () => { yes.props.onClick(); });
  await settle();
  expect(removed).toEqual([E(1)]);
  expect(text()).toContain("Desk was removed from your account.");
  const ok = renderer!.root.findAll((node) => node.type === "button" && node.props.children === "OK")[0]!;
  await act(async () => { ok.props.onClick(); });
  await settle();
  expect(seen).toEqual([LIST]);
  expect(renderer!.toJSON()).toBeNull();
});

it("names the device that made the list where this device did not", async () => {
  const notice: MoveNoticeView = { list: LIST, first: { self: false, key: "G", name: { label: "Phone", os: null } }, devices: [], pcs: [], removed: [] };
  await act(async () => { renderer = create(<SettingsProvider><ListMoveNotice list={listWith(following, notice).list} /></SettingsProvider>); });
  await settle();
  expect(text()).toContain("Phone made your account's list.");
});

it("shows nothing for an account that has not moved", async () => {
  await act(async () => { renderer = create(<SettingsProvider><ListMoveNotice list={listWith(following, null).list} /></SettingsProvider>); });
  await settle();
  expect(renderer!.toJSON()).toBeNull();
});

it("tells a device the list carried in why it did not join, naming the PC and what to do", async () => {
  const refused: AccountListView = { account: ACCOUNT, reached: true, status: { at: "not_in", list: LIST, why: "not_mine", claim: "claimed", refused: { why: "other_list", pcs: [E(1)] } }, devices: [], pcs: [] };
  await act(async () => { renderer = create(<SettingsProvider><ListJoinRefusal list={listWith(refused, null).list} pcName={() => "Desk"} /></SettingsProvider>); });
  expect(text()).toContain("Desk follows another list of your account");
  for (const [why, line] of [["first_signer_unknown", "Your PCs do not know the device that made your account's list"], ["first_signer_removed", "A PC of yours removed the device that made your account's list"]] as const) {
    const view: AccountListView = { ...refused, status: { at: "not_in", list: LIST, why: "not_mine", claim: "claimed", refused: { why, pcs: [E(1)] } } };
    await act(async () => { renderer!.update(<SettingsProvider><ListJoinRefusal list={listWith(view, null).list} pcName={() => null} /></SettingsProvider>); });
    expect(text()).toContain(line);
  }
  // a device that only waits on its PCs is told nothing: there is nothing to press
  const waiting: AccountListView = { ...refused, status: { at: "not_in", list: LIST, why: "carried", claim: "unclaimed", join: { why: "pcs_silent", wait: 60, pcs: [E(1)] } } };
  await act(async () => { renderer!.update(<SettingsProvider><ListJoinRefusal list={listWith(waiting, null).list} pcName={() => null} /></SettingsProvider>); });
  expect(renderer!.toJSON()).toBeNull();
});

it("says which device it put out again because this device said Not me to it, with no Not me on it (#4652)", async () => {
  const notice: MoveNoticeView = { list: LIST, first: { self: true, key: "G", name: null }, devices: [], pcs: [], removed: [{ key: "L", name: { label: "Laptop", os: null } }] };
  const asked: string[] = [];
  await act(async () => { renderer = create(<SettingsProvider><ListMoveNotice list={listWith(following, notice).list} notMeDevice={(key) => { asked.push(key); }} /></SettingsProvider>); });
  await settle();
  expect(text()).toContain("Laptop was removed from your account, as you asked with Not me.");
  expect(renderer!.root.findAll((node) => node.type === "button" && node.props.children === "Not me")).toHaveLength(0);
  expect(asked).toEqual([]);
});

it("draws a carried device's row with no Not me while nothing removes a device here: no button that does nothing", async () => {
  const notice: MoveNoticeView = { list: LIST, first: { self: true, key: "G", name: null }, devices: [{ key: "K", name: { label: "Laptop", os: null } }], pcs: [], removed: [] };
  await act(async () => { renderer = create(<SettingsProvider><ListMoveNotice list={listWith(following, notice).list} /></SettingsProvider>); });
  await settle();
  expect(text()).toContain("Laptop");
  expect(renderer!.root.findAll((node) => node.type === "button" && node.props.children === "Not me")).toHaveLength(0);
});

it("hands a carried device's key and name to the devices list's Remove (useNotMe's notMe) on Not me", async () => {
  const notice: MoveNoticeView = { list: LIST, first: { self: true, key: "G", name: null }, devices: [{ key: "K", name: { label: "Laptop", os: null } }, { key: "J", name: null }], pcs: [], removed: [] };
  const asked: [string, string][] = [];
  await act(async () => { renderer = create(<SettingsProvider><ListMoveNotice list={listWith(following, notice).list} notMeDevice={(key, name) => { asked.push([key, name]); }} /></SettingsProvider>); });
  await settle();
  const notMe = renderer!.root.findAll((node) => node.type === "button" && node.props.children === "Not me");
  expect(notMe).toHaveLength(2);
  await act(async () => { notMe[0]!.props.onClick(); notMe[1]!.props.onClick(); });
  expect(asked).toEqual([["K", "Laptop"], ["J", "A device of yours"]]);
});

it("tells a device whose PCs do not know the list it follows so, and offers the reset of its copy, which leads to an Allow (V4-6)", async () => {
  const doubted: AccountListView = { ...following, status: { at: "following", list: LIST, standing: "in", head: 5, read_at: 1, trouble: null, doubt: { why: "first_signer_unknown", pcs: [E(1)] } } };
  const forgot: string[] = [];
  const list = { ...listWith(doubted, null).list, forget: async (account: string) => { forgot.push(account); } } as unknown as AccountList;
  await act(async () => { renderer = create(<SettingsProvider><ListJoinRefusal list={list} pcName={() => "Desk"} /></SettingsProvider>); });
  expect(text()).toContain("Your PCs do not know the list this device follows");
  expect(text()).toContain("Your PCs do not know the device that made the list this device follows.");
  const reset = renderer!.root.findAll((node) => node.type === "button" && node.props.children === "Reset this device's list")[0]!;
  await act(async () => { await reset.props.onClick(); });
  expect(forgot).toEqual([ACCOUNT]);
  for (const [why, line] of [["other_list", "Desk follows another list of your account."], ["first_signer_removed", "A PC of yours removed the device that made the list this device follows."]] as const) {
    const view: AccountListView = { ...doubted, status: { at: "following", list: LIST, standing: "in", head: 5, read_at: 1, trouble: null, doubt: { why, pcs: [E(1)] } } };
    await act(async () => { renderer!.update(<SettingsProvider><ListJoinRefusal list={listWith(view, null).list} pcName={() => "Desk"} /></SettingsProvider>); });
    expect(text()).toContain(line);
  }
});

it("Not me on a PC acts on the account, list and member key it was pressed for, and asks nothing once they changed (astra-migapp 9)", async () => {
  const notice: MoveNoticeView = { list: LIST, first: { self: true, key: "G", name: null }, devices: [], pcs: [{ endpoint: E(1), name: { label: "Desk", os: null } }], removed: [] };
  let view: AccountListView = following;
  const listeners: ((next: AccountListView) => void)[] = [];
  const list = {
    view: () => view, subscribe: (listener: (next: AccountListView) => void) => { listeners.push(listener); return () => {}; },
    notice: async () => notice, noticeSeen: async () => {},
    writer: () => ({ account: view.account, list: view.status.at === "following" ? view.status.list : "", keys: { key: "MEMBER" } }),
  } as unknown as AccountList;
  const removed: [string, unknown][] = [];
  await act(async () => { renderer = create(<SettingsProvider><ListMoveNotice list={list} removePc={async (endpoint, scope) => { removed.push([endpoint, scope]); return true; }} /></SettingsProvider>); });
  await settle();
  const press = async (label: string) => { const button = renderer!.root.findAll((node) => node.type === "button" && node.props.children === label)[0]!; await act(async () => { await button.props.onClick(); }); };
  await press("Not me");
  expect(text()).toContain("Remove Desk from your account?");
  // another account signs in while the question is up: the question goes, and nothing is removed
  view = { ...following, account: "acct_other" };
  await act(async () => { for (const listener of listeners) listener(view); });
  await settle();
  expect(text()).not.toContain("Remove Desk from your account?");
  expect(removed).toEqual([]);
  // back on the list it was shown for: the removal names that account, that list and that member key
  view = following;
  await act(async () => { for (const listener of listeners) listener(view); });
  await settle();
  await press("Not me");
  await press("Remove");
  expect(removed).toEqual([[E(1), { account: ACCOUNT, list: LIST, key: "MEMBER" }]]);
});
