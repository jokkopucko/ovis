import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import * as ReactDom from "react-dom";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { listView, signListEntry } from "../../shared/account-list.ts";
import { entryFromText, readBody } from "../../shared/account-list-entry.ts";
import { askingPc, listWorld, postPcKeys, type WorldDevice } from "../lib/account/accountList.test-helpers.ts";
import { allowDevice } from "../lib/account/listAllow.ts";
import { LIST_WRITE_WAITING_EVENT } from "../lib/account/listWrite.ts";
import { setPageAccountList } from "../lib/account/pageList.ts";
import { SettingsProvider } from "../lib/settings.ts";

// the confirmation is a portal into document.body: drawn in place here, so the test renderer holds it
await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
const { ListDevices, showsListDevices, SignOutEverywhereSays, useNotMe } = await import("./ListDevices.tsx");

const textOf = (node: ReactTestInstance): string => node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const kinds = (texts: readonly string[]): string[] => texts.map((text) => readBody(entryFromText(text).body).kind);

type World = ReturnType<typeof listWorld>;

/** Lets the work a press started run until `done`, for ten seconds at most. */
async function waitFor(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("what the press started did not end");
    await Bun.sleep(25);
    // what settled meanwhile is drawn
    await act(async () => {});
  }
}

async function letIn(w: World, by: WorldDevice, label: string): Promise<WorldDevice> {
  const device = await w.device({ label });
  await device.list.sync();
  const offer = await allowDevice(by.list, { key: (await device.keys()).key, label, os: "android" }, { wait: async () => {} });
  if (!offer.allowed) throw new Error(offer.why);
  await device.list.adopt(offer.offer);
  return device;
}

describe("Manage account's devices from the account's signed list", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let warn: typeof console.warn;

  beforeEach(() => {
    warn = console.warn;
    console.warn = () => {};
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
      location: { href: "https://app.example/", search: "", origin: "https://app.example", pathname: "/", protocol: "https:" },
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

  const mount = async (device: WorldDevice, onLeave?: () => Promise<void>): Promise<ReactTestInstance> => {
    const view = await device.list.sync();
    if (!showsListDevices(view, device.session.account)) throw new Error("the device does not show the list");
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: createElement(ListDevices, { list: device.list, view, ...(onLeave ? { onLeave } : {}) }) }), {
        createNodeMock: () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} }),
      });
    });
    if (!renderer) throw new Error("not mounted");
    return renderer.root;
  };
  const rows = (root: ReactTestInstance) => root.find((node) => node.props["data-testid"] === "account-devices").findAll((node) => node.type === "li").map(textOf);
  const dialog = (root: ReactTestInstance) => root.find((node) => node.props.role === "alertdialog");
  const press = (root: ReactTestInstance, label: string) => dialog(root).find((node) => node.type === "button" && textOf(node) === label).props.onClick();
  /** Presses the confirm's button and waits, a bounded while, until its deed is over: the dialog gone, or an error in it. */
  const confirm = async (root: ReactTestInstance, label: string): Promise<void> => {
    await act(async () => { press(root, label); });
    await waitFor(() => {
      const open = root.findAll((node) => node.props.role === "alertdialog");
      return open.length === 0 || open[0]!.findAll((node) => node.props.role === "alert").length > 0;
    });
  };

  it("Sign out every device's question says that this device keeps its place in the list, and how to take it out too, alone or with others", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    const STAYS = "This device keeps its place in your account's list: signed in again here, it opens your PCs with no Allow. To take it out too, use Disconnect on its own row.";
    /** what the question says, by its parts: the devices that go, then what stays */
    const says = async (named: readonly string[]): Promise<string[]> => {
      await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(SignOutEverywhereSays, { account: w.account, named, children: "the plain question" }) })); });
      const parts = ["sign-out-everywhere-says", "sign-out-everywhere-stays"].flatMap((id) => renderer!.root.findAll((node) => node.props["data-testid"] === id).map(textOf));
      await act(async () => { renderer!.unmount(); });
      renderer = undefined;
      return parts;
    };
    setPageAccountList(first.list);
    try {
      expect(await says([])).toEqual(["Every browser and app is signed out of the account.", STAYS]);
      const second = await letIn(w, first, "Dana's tablet");
      await first.list.sync();
      expect(await says([(await second.keys()).key])).toEqual(["These devices leave your account for good, then every browser and app is signed out: Dana's tablet", STAYS]);
    } finally { setPageAccountList(null); }
    // an account whose list this device is not in keeps its plain question, with nothing of a list
    expect(await says([])).toEqual([]);
  });

  it("lists each device by its name, this device as such, and offers Remove on the others", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    await letIn(w, first, "Dana's tablet");
    const root = await mount(first, async () => {});
    expect(rows(root)).toEqual(["Dana's phoneThis deviceDisconnect", "Dana's tabletRemove"]);
  });

  /** An account whose first device let a device in that in turn let a laptop in and added a PC. */
  async function withAdditions() {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    const second = await letIn(w, first, "Lost phone");
    const third = await letIn(w, second, "Laptop");
    const pc = await askingPc();
    const card = await postPcKeys(w.fake.fetch, w.origin, second.session.access_token, pc, w.held().id);
    const keys = await second.keys();
    const added = await signListEntry(w.held().state, { kind: "pc", key: pc.key, endpoint: pc.endpoint, enc: pc.enc, card, sealed: null }, { key: keys.key, privateKey: keys.signs }, Math.floor(w.clock.now / 1000));
    await second.service.placeEntries(w.held().id, [added.text], []);
    return { w, first, second, third, pc };
  }
  const through = (root: ReactTestInstance) => dialog(root).find((node) => node.props["data-testid"] === "came-in-through");
  const boxes = (root: ReactTestInstance) => through(root).findAll((node) => node.type === "input");
  const addedAgain = (root: ReactTestInstance) => dialog(root).findAll((node) => node.props["data-testid"] === "pcs-added-again").map(textOf);
  const live = async (w: World) => {
    const view = listView(w.held().state);
    return [view.devices.filter((row) => row.ended === null).length, view.pcs.filter((row) => row.removed === null).length];
  };

  it("removes the device alone unless the person ticks what it added, and says it is done", async () => {
    const { w, first, third } = await withAdditions();
    const root = await mount(first);
    expect(rows(root)).toEqual(["Dana's phoneThis device", "Lost phoneRemove", "LaptopRemove"]);
    await act(async () => { root.findAll((node) => node.type === "button" && node.props["data-action"] === "remove-device")[0]!.props.onClick(); });
    expect(textOf(dialog(root))).toContain("Remove Lost phone from your account?");
    expect(textOf(through(root))).toBe("Came in through Lost phone:LaptopUnnamed PCIf Lost phone was stolen, tick what you did not add yourself.");
    expect([boxes(root).map((node) => node.props.checked), addedAgain(root)]).toEqual([[false, false], []]);
    await confirm(root, "Remove");
    expect(kinds(w.held().entries).slice(-2)).toEqual(["remove", "epoch"]);
    expect(listView(w.held().state).devices.filter((row) => row.ended === null).map((row) => row.key)).toEqual([(await first.keys()).key, (await third.keys()).key]);
    expect(await live(w)).toEqual([2, 1]);
    expect(textOf(root.find((node) => node.props["data-testid"] === "list-device-note"))).toBe("Lost phone was removed from your account.");
  });

  it("puts out what the person ticks in the same request, and says when PCs must be added again", async () => {
    const { w, first } = await withAdditions();
    const root = await mount(first);
    await act(async () => { root.findAll((node) => node.type === "button" && node.props["data-action"] === "remove-device")[0]!.props.onClick(); });
    await act(async () => { boxes(root)[0]!.props.onChange(); });
    expect(addedAgain(root)).toEqual([]);
    await act(async () => { boxes(root)[1]!.props.onChange(); });
    expect([boxes(root).map((node) => node.props.checked), addedAgain(root)]).toEqual([[true, true], ["These PCs will need to be added again."]]);
    await confirm(root, "Remove");
    // one request: the three removes, then one epoch
    expect(kinds(w.held().entries).slice(-4)).toEqual(["remove", "remove", "remove", "epoch"]);
    expect(await live(w)).toEqual([1, 0]);
  });

  it("names nothing for a device that added nothing", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    await letIn(w, first, "Dana's tablet");
    const root = await mount(first);
    await act(async () => { root.find((node) => node.type === "button" && node.props["data-action"] === "remove-device").props.onClick(); });
    expect(dialog(root).findAll((node) => node.props["data-testid"] === "came-in-through")).toHaveLength(0);
  });

  it("keeps the confirm up with the list's own wording when the account service cannot change the list, and removes nobody", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    await letIn(w, first, "Dana's tablet");
    const root = await mount(first);
    w.fake.tamperList(w.held().id, { stopped: true });
    await act(async () => { root.find((node) => node.type === "button" && node.props["data-action"] === "remove-device").props.onClick(); });
    await confirm(root, "Remove");
    expect(textOf(dialog(root).find((node) => node.props.role === "alert"))).toBe("The account service cannot change the list right now. To remove a device, use Revoke on each PC.");
    expect(kinds(w.held().entries)).toEqual(["genesis", "device"]);
  });

  it("says it does not know yet, rather than that nothing went, when the request got no answer and the log cannot be read", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    await letIn(w, first, "Dana's tablet");
    const root = await mount(first);
    let away = false;
    first.wire.answer = (request) => {
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")) away = true;
      return away ? Promise.reject(new TypeError("offline")) : null;
    };
    await act(async () => { root.find((node) => node.type === "button" && node.props["data-action"] === "remove-device").props.onClick(); });
    await confirm(root, "Remove");
    expect(textOf(dialog(root).find((node) => node.props.role === "alert"))).toBe("Whether Dana's tablet was removed is not known yet. Look at the list again in a moment.");
  });

  it("says an earlier change still waits, and signs nothing, while a request signed for an Allow waits at this head", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    await letIn(w, first, "Dana's tablet");
    const laptop = await w.device({ label: "Laptop" });
    await laptop.list.sync();
    // every placement is answered `409 head_moved` while the device's own read shows the same head: the Allow's request stays kept
    w.fake.tamperList(w.held().id, { headMoved: true });
    expect(await allowDevice(first.list, { key: (await laptop.keys()).key, label: "Laptop", os: "android" }, { wait: async () => {} })).toMatchObject({ allowed: false, why: "busy" });
    w.fake.untamperList(w.held().id);
    const entries = w.held().entries.length;
    const root = await mount(first);
    // the card of the change that waits is put up wherever the page draws it
    let cards = 0;
    window.addEventListener(LIST_WRITE_WAITING_EVENT, () => { cards += 1; });
    await act(async () => { root.find((node) => node.type === "button" && node.props["data-action"] === "remove-device").props.onClick(); });
    await confirm(root, "Remove");
    expect(textOf(dialog(root).find((node) => node.props.role === "alert"))).toBe("An earlier change is still waiting: try it again or cancel it first.");
    expect(w.held().entries).toHaveLength(entries);
    expect(cards).toBe(1);
  });

  it("asks again for the new key of a device that handed its place over while the question was open, and never says it was removed", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    const tablet = await letIn(w, first, "Dana's tablet");
    const root = await mount(first);
    await act(async () => { root.find((node) => node.type === "button" && node.props["data-action"] === "remove-device").props.onClick(); });
    // the tablet hands its place to a new key of its own before the person confirms
    const heir = await w.device({ label: "Dana's tablet" });
    await heir.list.sync();
    const next = (await heir.keys()).key;
    const claim = (await tablet.service.listClaims(w.held().id)).find((each) => each.key === next)!;
    const old = await tablet.keys();
    const rotation = await signListEntry(w.held().state, { kind: "device", key: claim.key, power: "full", role: "drive", until: null, enc: claim.enc, card: claim.card, sealed: null, rotates: true },
      { key: old.key, privateKey: old.signs }, Math.floor(w.clock.now / 1000));
    await tablet.service.placeEntries(w.held().id, [rotation.text], []);
    const before = w.held().entries.length;
    await confirm(root, "Remove");
    expect(textOf(dialog(root).find((node) => node.props.role === "alert"))).toBe("Dana's tablet moved to a new key since you asked. Nothing was removed: press Remove again to remove it.");
    expect(w.held().entries).toHaveLength(before);
    await confirm(root, "Remove");
    expect(root.findAll((node) => node.props.role === "alertdialog")).toHaveLength(0);
    expect(listView(w.held().state).devices.find((row) => row.key === next)?.ended).not.toBeNull();
  });

  it("Not me from elsewhere on the page (useNotMe, for the move's notice) asks Remove's question with everything ticked, and puts the device out", async () => {
    const { w, first, second, third } = await withAdditions();
    await first.list.sync();
    let ask: ((key: string, name: string) => void) | null = null;
    function Host() {
      const { notMe, dialog } = useNotMe(first.list);
      ask = notMe;
      return createElement("div", null, dialog);
    }
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: createElement(Host) }), {
        createNodeMock: () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} }),
      });
    });
    const root = renderer!.root;
    expect(root.findAll((node) => node.props.role === "alertdialog")).toHaveLength(0);
    await act(async () => { ask!((await second.keys()).key, "Lost phone"); });
    expect(textOf(dialog(root))).toContain("Remove Lost phone from your account?");
    expect(boxes(root).map((node) => node.props.checked)).toEqual([true, true]);
    await confirm(root, "Remove");
    expect(root.findAll((node) => node.props.role === "alertdialog")).toHaveLength(0);
    const out = listView(w.held().state).devices.filter((row) => row.ended !== null).map((row) => row.key);
    expect(out).toEqual(expect.arrayContaining([(await second.keys()).key, (await third.keys()).key]));
  });

  it("shows a device that handed its place to a new key as moved, with the day, and Remove still puts it out", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    const tablet = await letIn(w, first, "Dana's tablet");
    const heir = await w.device({ label: "Dana's tablet" });
    await heir.list.sync();
    const next = (await heir.keys()).key;
    const claim = (await tablet.service.listClaims(w.held().id)).find((each) => each.key === next)!;
    const old = await tablet.keys();
    const at = Math.floor(w.clock.now / 1000);
    const rotation = await signListEntry(w.held().state, { kind: "device", key: claim.key, power: "full", role: "drive", until: null, enc: claim.enc, card: claim.card, sealed: null, rotates: true }, { key: old.key, privateKey: old.signs }, at);
    await tablet.service.placeEntries(w.held().id, [rotation.text], []);
    const root = await mount(first);
    const day = new Date(at * 1000).toLocaleDateString("en", { month: "short", day: "numeric" });
    expect(rows(root)).toEqual(["Dana's phoneThis device", `Unnamed deviceMoved to a new key on ${day}Remove`]);
    await act(async () => { root.find((node) => node.type === "button" && node.props["data-action"] === "remove-device").props.onClick(); });
    await confirm(root, "Remove");
    expect(listView(w.held().state).devices.find((row) => row.key === next)?.ended).not.toBeNull();
  });

  it("says that what was ticked moved to a new key, not the device asked for, when only a ticked one handed its place on", async () => {
    const { w, first, third } = await withAdditions();
    const root = await mount(first);
    await act(async () => { root.findAll((node) => node.type === "button" && node.props["data-action"] === "remove-device")[0]!.props.onClick(); });
    await act(async () => { boxes(root)[0]!.props.onChange(); });
    // the laptop, ticked, hands its place to a new key of its own before the press
    const heir = await w.device({ label: "Laptop" });
    await heir.list.sync();
    const next = (await heir.keys()).key;
    const claim = (await third.service.listClaims(w.held().id)).find((each) => each.key === next)!;
    const old = await third.keys();
    const rotation = await signListEntry(w.held().state, { kind: "device", key: claim.key, power: "full", role: "drive", until: null, enc: claim.enc, card: claim.card, sealed: null, rotates: true },
      { key: old.key, privateKey: old.signs }, Math.floor(w.clock.now / 1000));
    await third.service.placeEntries(w.held().id, [rotation.text], []);
    await confirm(root, "Remove");
    expect(textOf(dialog(root).find((node) => node.props.role === "alert"))).toBe("Something you ticked moved to a new key since you asked. Nothing was removed: press Remove again to remove it.");
    await confirm(root, "Remove");
    expect(root.findAll((node) => node.props.role === "alertdialog")).toHaveLength(0);
    expect(listView(w.held().state).devices.find((row) => row.key === next)?.ended).not.toBeNull();
  });

  it("offers no Remove to a device that may not remove anybody", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    await letIn(w, first, "Dana's tablet");
    const view = await first.list.sync();
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: createElement(ListDevices, { list: { ...first.list, writer: () => null }, view }) }));
    });
    expect(rows(renderer!.root)).toEqual(["Dana's phoneThis device", "Dana's tablet"]);
  });

});
