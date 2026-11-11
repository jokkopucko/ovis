import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { act, createElement, type ReactNode } from "react";
import * as ReactDom from "react-dom";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { MyPc } from "../lib/account/myPcs.ts";
import { SignedOutError, type AccountService } from "../lib/account/service.ts";
import type { AccountSession } from "../lib/account/store.ts";
import { SettingsProvider } from "../lib/settings.ts";

// the confirmation is a portal into document.body: drawn in place here, so the test renderer holds it
await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
const { AccountPcRows, HOSTED_APP_URL, NoAccountPcHint, removePcFromAccount, unusedPc } = await import("./AccountPcs.tsx");

const DESK = "a".repeat(32);
const LAPTOP = "b".repeat(32);
const pc = (server_id: string, name: string): MyPc => ({ server_id, name, state: "needs-approval", last_seen_at: null, added_at: null, listed: true, paired: false, linked: false });

const NOW = Date.parse("2026-11-11T00:00:00Z");
/** a PC the account last heard from ten days before `NOW` */
const gone = (server_id: string, name: string): MyPc => ({ ...pc(server_id, name), state: "offline", last_seen_at: "2026-11-01T00:00:00Z", added_at: "2026-10-01T00:00:00Z" });
/** a press of a row's button, inside the list's group */
const click = (group: { focus: () => void } = { focus() {} }) => ({ currentTarget: { closest: () => group } });

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

describe("the account's PCs in a PC's own Settings", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let warn: typeof console.warn;

  beforeEach(() => {
    warn = console.warn;
    console.warn = () => {};
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "matchMedia", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    const events = new EventTarget();
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() };
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    class HTMLElement { isConnected = true; focus(): void {} }
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "https://pc.example/", search: "", origin: "https://pc.example", pathname: "/" },
      history: { state: null, replaceState() {} },
      localStorage: storage, matchMedia, innerWidth: 1440,
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      activeElement: new HTMLElement(),
      body: { nodeType: 1, children: [] },
      querySelector: () => null,
      querySelectorAll: () => [],
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

  const mount = async (node: ReactNode): Promise<ReactTestInstance> => {
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: node }), {
        createNodeMock: () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} }),
      });
    });
    if (!renderer) throw new Error("not mounted");
    return renderer.root;
  };
  const dialogs = (root: ReactTestInstance) => root.findAll((node) => node.props.role === "alertdialog");

  it("gives the rows no action of their own, and one link under them to the hosted app's front page", async () => {
    const root = await mount(createElement(AccountPcRows, { pcs: [pc(DESK, "Desk"), pc(LAPTOP, "Laptop")], watching: false, now: NOW, remove: async () => {}, onRemoved: () => {} }));
    // a PC's own page cannot tell whether this browser is paired with that PC at app.ovis.sh, where /s/<id>/ opens
    // only a paired one: the link goes to the front page, which is right for every browser, and is named for it
    const links = root.findAll((node) => node.type === "a");
    expect(links.map((link) => [textOf(link), link.props.href, link.props.target, link.props.rel])).toEqual([["Open app.ovis.sh", "https://app.ovis.sh/", "_blank", "noreferrer"]]);
    expect(HOSTED_APP_URL).toBe("https://app.ovis.sh/");
    expect(root.findAll((node) => node.type === "li").map(textOf)).toEqual([
      "DeskPCIn your account", "LaptopPCIn your account",
      "To open a PC of your account in a browser, sign in to this account at app.ovis.sh.Open app.ovis.sh",
    ]);
    expect(root.findAll((node) => node.type === "button")).toHaveLength(0);
  });

  it("draws no link when the account lists no other PC", async () => {
    const root = await mount(createElement(AccountPcRows, { pcs: [], watching: false, now: NOW, remove: async () => {}, onRemoved: () => {} }));
    expect(root.findAll((node) => node.type === "a" || node.type === "li")).toHaveLength(0);
  });

  it("offers Remove only on a PC the account has not heard from for two days", async () => {
    const ago = (ms: number): string => new Date(NOW - ms).toISOString();
    const HOUR = 3_600_000;
    const root = await mount(createElement(AccountPcRows, { watching: false, now: NOW, remove: async () => {}, onRemoved: () => {}, pcs: [
      // in use: a device of the account that opens it lists it again, so a removal would not last
      { ...pc(DESK, "Live"), last_seen_at: ago(60_000), added_at: ago(900 * HOUR) },
      // off since last night: back tomorrow
      { ...pc("c".repeat(32), "Overnight"), state: "offline", last_seen_at: ago(20 * HOUR), added_at: ago(900 * HOUR) },
      // just listed by its own Add this PC screen, which lists it again while it waits
      { ...pc("d".repeat(32), "Fresh"), last_seen_at: null, added_at: ago(HOUR) },
      // nothing known of when: not offered
      { ...pc("e".repeat(32), "Unknown"), last_seen_at: null, added_at: null },
      { ...pc(LAPTOP, "Gone"), state: "offline", last_seen_at: ago(49 * HOUR), added_at: ago(900 * HOUR) },
      // listed once and never enrolled
      { ...pc("f".repeat(32), "Abandoned"), last_seen_at: null, added_at: ago(49 * HOUR) },
    ] }));
    expect(root.findAll((node) => node.type === "button").map((button) => button.props["aria-label"])).toEqual(["Remove Gone from the list", "Remove Abandoned from the list"]);
    expect(unusedPc({ last_seen_at: ago(48 * HOUR - 1000), added_at: ago(900 * HOUR) }, NOW)).toBe(false);
    expect(unusedPc({ last_seen_at: ago(48 * HOUR + 1000), added_at: ago(900 * HOUR) }, NOW)).toBe(true);
    // a clock behind the service's, or a date that does not parse: not offered
    expect(unusedPc({ last_seen_at: "soon", added_at: null }, NOW)).toBe(false);
  });

  it("removes a PC from the list only after a confirm that says what it does not do, once, then asks for the list again", async () => {
    const calls: string[] = [];
    const root = await mount(createElement(AccountPcRows, {
      pcs: [pc(DESK, "Desk"), gone(LAPTOP, "Laptop")], watching: false, now: NOW,
      remove: async (id: string) => { calls.push(`remove ${id}`); }, onRemoved: () => { calls.push("recheck"); },
    }));
    const removeButton = root.find((node) => node.type === "button" && node.props["aria-label"] === "Remove Laptop from the list");
    expect(removeButton.props.title).toBe("Remove Laptop from the list");

    await act(async () => { removeButton.props.onClick(click()); });
    const dialog = dialogs(root)[0]!;
    const words = textOf(dialog);
    expect(words).toContain("Remove Laptop from the list?");
    expect(words).toContain("Takes Laptop off your account's list of PCs on every device.");
    // it ends no access, now or later
    expect(words).toContain("It revokes nothing: devices paired with Laptop keep their access, and a device you later remove from your account is not removed from it.");
    // and it is not for good on a PC that is used again
    expect(words).toContain("If Laptop is used again, it comes back on the list when a device of your account opens it.");
    expect(words).toContain("Until then it cannot use the Ovis relay where the relay needs an account.");
    expect(words).not.toContain("within two days");

    await act(async () => { dialog.find((node) => node.type === "button" && textOf(node) === "Cancel").props.onClick(); });
    expect(dialogs(root)).toHaveLength(0);
    expect(calls).toEqual([]);

    await act(async () => { removeButton.props.onClick(click()); });
    await act(async () => { await dialogs(root)[0]!.find((node) => node.type === "button" && textOf(node) === "Remove from list").props.onClick(); });
    expect(calls).toEqual([`remove ${LAPTOP}`, "recheck"]);
    expect(dialogs(root)).toHaveLength(0);
  });

  it("moves the focus to the list's group once the removed row is gone", async () => {
    let focused = 0;
    const group = { focus: () => { focused += 1; } };
    const root = await mount(createElement(AccountPcRows, { pcs: [gone(LAPTOP, "Laptop")], watching: false, now: NOW, remove: async () => {}, onRemoved: () => {} }));
    await act(async () => { root.find((node) => node.type === "button" && node.props["aria-label"] === "Remove Laptop from the list").props.onClick(click(group)); });
    await act(async () => { dialogs(root)[0]!.find((node) => node.type === "button" && textOf(node) === "Cancel").props.onClick(); });
    // a no gives the focus back to the button by itself (ConfirmDialog)
    expect(focused).toBe(0);
    await act(async () => { root.find((node) => node.type === "button" && node.props["aria-label"] === "Remove Laptop from the list").props.onClick(click(group)); });
    await act(async () => { await dialogs(root)[0]!.find((node) => node.type === "button" && textOf(node) === "Remove from list").props.onClick(); });
    expect(focused).toBe(1);
  });

  it("keeps the confirm up with a retry line when the removal fails, and asks for no recheck", async () => {
    let rechecks = 0;
    const root = await mount(createElement(AccountPcRows, {
      pcs: [gone(DESK, "Desk")], watching: false, now: NOW,
      remove: async () => { throw new Error("502 bad gateway from the service"); }, onRemoved: () => { rechecks += 1; },
    }));
    await act(async () => { root.find((node) => node.type === "button" && node.props["aria-label"] === "Remove Desk from the list").props.onClick(click()); });
    await act(async () => { await dialogs(root)[0]!.find((node) => node.type === "button" && textOf(node) === "Remove from list").props.onClick(); });
    const alert = dialogs(root)[0]!.find((node) => node.props.role === "alert");
    expect(textOf(alert)).toBe("Desk could not be removed. Try again.");
    expect(rechecks).toBe(0);
  });

  it("closes the confirm and asks for the account again when the sign-in ended, with no retry line", async () => {
    let rechecks = 0;
    let attempts = 0;
    const root = await mount(createElement(AccountPcRows, {
      pcs: [gone(DESK, "Desk")], watching: false, now: NOW,
      remove: async () => { attempts += 1; throw new SignedOutError(); }, onRemoved: () => { rechecks += 1; },
    }));
    await act(async () => { root.find((node) => node.type === "button" && node.props["aria-label"] === "Remove Desk from the list").props.onClick(click()); });
    await act(async () => { await dialogs(root)[0]!.find((node) => node.type === "button" && textOf(node) === "Remove from list").props.onClick(); });
    // no dialog left to retry in: the page reads the stored sign-in again and shows signed out, or the other account
    expect(dialogs(root)).toHaveLength(0);
    expect(textOf(root)).not.toContain("Try again");
    expect([attempts, rechecks]).toEqual([1, 1]);
  });

  it("offers a watching device no removal", async () => {
    const root = await mount(createElement(AccountPcRows, { pcs: [gone(DESK, "Desk")], watching: true, now: NOW, remove: async () => {}, onRemoved: () => {} }));
    expect(root.findAll((node) => node.type === "button")).toHaveLength(0);
    expect(root.findAll((node) => node.type === "li").map(textOf)[0]).toStartWith("DeskPCOffline");
  });

  it("says an account with no PC has none, in words that hold for every way of signing in", async () => {
    const root = await mount(createElement(NoAccountPcHint, { provider: "apple" }));
    expect(textOf(root)).toBe("No PC in this account yet. Signed in with Apple: each way of signing in is a separate Ovis account until you link them.");
  });
});

describe("removePcFromAccount", () => {
  const session = (account: string): AccountSession => ({ service: "https://account.example", account, provider: "github", access_token: "a", refresh_token: "r", expires_at: 0, sign_in_id: `id-${account}` });
  const serviceWith = (stored: AccountSession | undefined, deleted: string[]): Pick<AccountService, "session" | "forSignIn"> => ({
    session: async () => stored,
    forSignIn: (signIn: AccountSession) => ({ deletePc: async (id: string) => { deleted.push(`${signIn.account} ${id}`); } }) as unknown as AccountService,
  });

  it("removes the PC as the sign-in whose list is shown", async () => {
    const deleted: string[] = [];
    await removePcFromAccount(serviceWith(session("acct-1"), deleted), "acct-1", DESK);
    expect(deleted).toEqual([`acct-1 ${DESK}`]);
  });

  it("removes nothing once another sign-in, or none, is stored", async () => {
    const deleted: string[] = [];
    await expect(removePcFromAccount(serviceWith(session("acct-2"), deleted), "acct-1", DESK)).rejects.toBeInstanceOf(SignedOutError);
    await expect(removePcFromAccount(serviceWith(undefined, deleted), "acct-1", DESK)).rejects.toBeInstanceOf(SignedOutError);
    expect(deleted).toEqual([]);
  });
});

describe("Settings → Devices and PCs", () => {
  it("draws the Account group above the device list, outside More settings", () => {
    const source = readFileSync(new URL("./SettingsDialog.tsx", import.meta.url), "utf8");
    const page = source.slice(source.indexOf("function DevicesPage("), source.indexOf("function UseRelayHere("));
    const account = page.indexOf("<AccountSection ");
    const fold = page.indexOf('<SettingsFold kind="more"');
    expect(account).toBeGreaterThan(-1);
    expect(page.indexOf("<AccountSection ", account + 1)).toBe(-1);
    expect(account).toBeLessThan(page.indexOf('<SettingsGroup section="devices">'));
    expect(account).toBeLessThan(fold);
    // and its link from Add a connection opens no fold to reach it
    expect(page.slice(page.indexOf("const openAccount"), page.indexOf("const accountService"))).not.toContain("details");
  });
});
