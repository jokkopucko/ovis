import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { AccountList, AccountListView, ListTrouble } from "../lib/account/accountList.ts";
import { setPageAccountList } from "../lib/account/pageList.ts";
import { translate } from "../lib/i18n.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { ListAlarmLine, ListAlarmNotice } from "./ListAlarmNotice.tsx";

const LIST = "5c".repeat(32);
const textOf = (node: ReactTestInstance): string => node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const viewOf = (trouble: ListTrouble | null, account = "acct"): AccountListView =>
  ({ account, reached: true, status: { at: "following", list: LIST, standing: "in", head: 4, read_at: 1, trouble }, devices: [], pcs: [] });

/** The page's list, as the hosted shell keeps it: a view, and whoever listens hears each new one. */
function pageList(first: AccountListView) {
  let view = first;
  const heard = new Set<(view: AccountListView) => void>();
  setPageAccountList({ view: () => view, subscribe: (listener: (view: AccountListView) => void) => { heard.add(listener); return () => { heard.delete(listener); }; } } as unknown as AccountList);
  return { show(next: AccountListView) { view = next; for (const listener of [...heard]) listener(next); } };
}

async function mount(node: ReactNode): Promise<ReactTestRenderer> {
  let root!: ReactTestRenderer;
  await act(async () => { root = create(createElement(SettingsProvider, null, node)); });
  return root;
}

// the app's settings read the browser's languages, storage and window: the few this renderer needs, put back after each test
const kept = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) kept.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  const events = new EventTarget();
  const on = { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) };
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test", maxTouchPoints: 0 } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ...on, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), location: { href: "https://app.example/", search: "", pathname: "/" } } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { ...on, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, querySelectorAll: () => [] } });
});
afterEach(() => {
  setPageAccountList(null);
  for (const [key, descriptor] of kept) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
  kept.clear();
});

describe("the alarm of the account's list, on this device", () => {
  it("says plainly what was seen, what still works, and how to fix it one device or PC at a time", async () => {
    pageList(viewOf("fork"));
    const root = await mount(createElement(ListAlarmNotice, { account: "acct" }));
    const [notice] = root.root.findAll((node) => node.props["data-list-alarm"] !== undefined && typeof node.type === "string");
    const text = textOf(notice!);
    expect(text).toContain("Two different histories of your account's list were seen");
    expect(text).toContain("Devices and PCs already in your account keep working.");
    expect(text).toContain("this device lets nobody new in");
    // one member at a time, removed AT that member, checked before the next, and a stop
    const steps = notice!.findAll((node) => node.type === "li").map(textOf);
    expect(steps).toHaveLength(4);
    // a device is reset by Sign out, which finishes while the alarm stands (Disconnect would sign its removal first):
    // then it is let in again, and its old listing is removed there, on a member that shows no alarm
    expect(steps[0]).not.toMatch(/disconnect/i);
    const order = ["sign out", "sign in again", "allow it from another device or PC", "remove its old listing there"].map((words) => steps[0]!.indexOf(words));
    expect(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!))).toBe(true);
    expect(steps[1]).toContain("on that same device or PC");
    expect(steps[2]).toContain("before you reset the next one");
    expect(steps[3]).toContain("stop");
    // it names no device or PC as the one to blame
    expect(text).not.toMatch(/removed by|was added by|stolen|attack/i);
  });

  it("shows nothing while the list is as it should be, for another account, or with no list at all", async () => {
    const list = pageList(viewOf(null));
    const root = await mount(createElement("div", null, createElement(ListAlarmNotice, { account: "acct" }), createElement(ListAlarmLine, { account: "acct" })));
    const shown = () => root.root.findAll((node) => node.props["data-list-alarm"] !== undefined && typeof node.type === "string").length;
    expect(shown()).toBe(0);
    // another history a member signed is seen: both come up at once, from the view the list publishes
    await act(async () => { list.show(viewOf("fork")); });
    expect(shown()).toBe(2);
    // other troubles are not this alarm
    for (const trouble of ["stuck", "other_list", "refused", "unsigned", "wrong_key", "needs_newer_client"] as const) {
      await act(async () => { list.show(viewOf(trouble)); });
      expect(shown()).toBe(0);
    }
    await act(async () => { list.show(viewOf("fork", "acct_other")); });
    expect(shown()).toBe(0);
    setPageAccountList(null);
    const none = await mount(createElement(ListAlarmNotice, { account: "acct" }));
    expect(none.toJSON()).toBeNull();
  });

  it("puts one line on My PCs that says where to look", async () => {
    pageList(viewOf("fork"));
    const root = await mount(createElement(ListAlarmLine, { account: "acct" }));
    const [line] = root.root.findAll((node) => node.props["data-list-alarm"] !== undefined && typeof node.type === "string");
    expect(line!.props["role"]).toBe("status");
    expect(textOf(line!)).toBe(translate("en", "Two different histories of your account's list were seen. Nobody new is let in from this device. Open Manage account to see what to do."));
  });

  it("is said in every language the app speaks", () => {
    const keys = [
      "Two different histories of your account's list were seen",
      "Two different histories of your account's list were seen. Nobody new is let in from this device. Open Manage account to see what to do.",
    ];
    for (const language of ["ko", "ja", "zh"] as const) for (const key of keys) expect(translate(language, key)).not.toBe(key);
  });
});
