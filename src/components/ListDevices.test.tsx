import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { listView, signListEntry } from "../../shared/account-list.ts";
import { entryFromText, readBody } from "../../shared/account-list-entry.ts";
import { askingPc, listWorld, postPcKeys, type WorldDevice } from "../lib/account/accountList.test-helpers.ts";
import { allowDevice } from "../lib/account/listAllow.ts";
import { LIST_WRITE_WAITING_EVENT } from "../lib/account/listWrite.ts";
import { setPageAccountList } from "../lib/account/pageList.ts";
import { SettingsProvider } from "../lib/settings.ts";

import { ListDevices, showsListDevices, SignOutEverywhereSays, useNotMe } from "./ListDevices.tsx";

const textOf = (node: Element): string => node.textContent ?? "";
const kinds = (texts: readonly string[]): string[] => texts.map((text) => readBody(entryFromText(text).body).kind);

type World = ReturnType<typeof listWorld>;

/** Lets the work a press started run until `done`, for ten seconds at most. */
async function waitFor(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("what the press started did not end");
    await new Promise<void>((resolve) => setImmediate(resolve));
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
  let page: Page;
  let warn: typeof console.warn;

  beforeEach(() => {
    warn = console.warn;
    console.warn = () => {};
    page = openPage("https://app.example/");
    Object.defineProperty(page.window.navigator, "userAgent", { configurable: true, value: "Test" });
    Object.defineProperty(page.window.navigator, "maxTouchPoints", { configurable: true, value: 0 });
    for (const [key, value] of Object.entries({
      HTMLElement: page.window.HTMLElement, CustomEvent: page.window.CustomEvent, Event: page.window.Event, matchMedia: page.window.matchMedia.bind(page.window),
    })) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
  });

  afterEach(async () => {
    await page.close();
    console.warn = warn;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const mount = async (device: WorldDevice, onLeave?: () => Promise<void>): Promise<HTMLElement> => {
    const view = await device.list.sync();
    if (!showsListDevices(view, device.session.account)) throw new Error("the device does not show the list");
    await page.render(createElement(SettingsProvider, { children: createElement(ListDevices, { list: device.list, view, ...(onLeave ? { onLeave } : {}) }) }));
    return page.container;
  };
  const rows = (root: Element) => [...one(root, '[data-testid="account-devices"]').querySelectorAll("li")].map(textOf);
  const one = (root: ParentNode, selector: string) => {
    const found = root.querySelectorAll(selector);
    if (found.length !== 1) throw new Error(`Expected one ${selector}`);
    return found[0]!;
  };
  const dialog = () => one(document, '[role="alertdialog"]');
  const press = (label: string) => [...dialog().querySelectorAll("button")].find((node) => textOf(node) === label)!.click();
  /** Presses the confirm's button and waits, a bounded while, until its deed is over: the dialog gone, or an error in it. */
  const confirm = async (label: string): Promise<void> => {
    await act(async () => { press(label); });
    await waitFor(() => {
      const open = [...document.querySelectorAll('[role="alertdialog"]')];
      return open.length === 0 || [...open[0]!.querySelectorAll('[role="alert"]')].length > 0;
    });
  };

  it("Sign out every device's question says that this device keeps its place in the list, and how to take it out too, alone or with others", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    const STAYS = "This device keeps its place in your account's list: signed in again here, it opens your PCs with no Allow. To take it out too, use Disconnect on its own row.";
    /** what the question says, by its parts: the devices that go, then what stays */
    const says = async (named: readonly string[]): Promise<string[]> => {
      await page.render(createElement(SettingsProvider, { children: createElement(SignOutEverywhereSays, { account: w.account, named, children: "the plain question" }) }));
      const parts = ["sign-out-everywhere-says", "sign-out-everywhere-stays"].flatMap((id) => [...page.container.querySelectorAll(`[data-testid="${id}"]`)].map(textOf));
      await page.render(null);
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
  const through = () => one(dialog(), '[data-testid="came-in-through"]');
  const boxes = () => through().querySelectorAll<HTMLInputElement>("input");
  const addedAgain = () => [...dialog().querySelectorAll('[data-testid="pcs-added-again"]')].map(textOf);
  const live = async (w: World) => {
    const view = listView(w.held().state);
    return [view.devices.filter((row) => row.ended === null).length, view.pcs.filter((row) => row.removed === null).length];
  };

  it("removes the device alone unless the person ticks what it added, and says it is done", async () => {
    const { w, first, third } = await withAdditions();
    const root = await mount(first);
    expect(rows(root)).toEqual(["Dana's phoneThis device", "Lost phoneRemove", "LaptopRemove"]);
    await act(async () => { root.querySelectorAll<HTMLButtonElement>('button[data-action="remove-device"]')[0]!.click(); });
    expect(textOf(dialog())).toContain("Remove Lost phone from your account?");
    expect(textOf(through())).toBe("Came in through Lost phone:LaptopUnnamed PCIf Lost phone was stolen, tick what you did not add yourself.");
    expect([[...boxes()].map((node) => node.checked), addedAgain()]).toEqual([[false, false], []]);
    await confirm("Remove");
    expect(kinds(w.held().entries).slice(-2)).toEqual(["remove", "epoch"]);
    expect(listView(w.held().state).devices.filter((row) => row.ended === null).map((row) => row.key)).toEqual([(await first.keys()).key, (await third.keys()).key]);
    expect(await live(w)).toEqual([2, 1]);
    expect(textOf(one(root, '[data-testid="list-device-note"]'))).toBe("Lost phone was removed from your account.");
  });

  it("puts out what the person ticks in the same request, and says when PCs must be added again", async () => {
    const { w, first } = await withAdditions();
    const root = await mount(first);
    await act(async () => { root.querySelectorAll<HTMLButtonElement>('button[data-action="remove-device"]')[0]!.click(); });
    await act(async () => { boxes()[0]!.click(); });
    expect(addedAgain()).toEqual([]);
    await act(async () => { boxes()[1]!.click(); });
    expect([[...boxes()].map((node) => node.checked), addedAgain()]).toEqual([[true, true], ["These PCs will need to be added again."]]);
    await confirm("Remove");
    // one request: the three removes, then one epoch
    expect(kinds(w.held().entries).slice(-4)).toEqual(["remove", "remove", "remove", "epoch"]);
    expect(await live(w)).toEqual([1, 0]);
  });

  it("names nothing for a device that added nothing", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    await letIn(w, first, "Dana's tablet");
    await mount(first);
    await act(async () => { page.one('button[data-action="remove-device"]').click(); });
    expect([...dialog().querySelectorAll('[data-testid="came-in-through"]')]).toHaveLength(0);
  });

  it("keeps the confirm up with the list's own wording when the account service cannot change the list, and removes nobody", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    await letIn(w, first, "Dana's tablet");
    await mount(first);
    w.fake.tamperList(w.held().id, { stopped: true });
    await act(async () => { page.one('button[data-action="remove-device"]').click(); });
    await confirm("Remove");
    expect(textOf(one(dialog(), '[role="alert"]'))).toBe("The account service cannot change the list right now. To remove a device, use Revoke on each PC.");
    expect(kinds(w.held().entries)).toEqual(["genesis", "device"]);
  });

  it("says it does not know yet, rather than that nothing went, when the request got no answer and the log cannot be read", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    await letIn(w, first, "Dana's tablet");
    await mount(first);
    let away = false;
    first.wire.answer = (request) => {
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")) away = true;
      return away ? Promise.reject(new TypeError("offline")) : null;
    };
    await act(async () => { page.one('button[data-action="remove-device"]').click(); });
    await confirm("Remove");
    expect(textOf(one(dialog(), '[role="alert"]'))).toBe("Whether Dana's tablet was removed is not known yet. Look at the list again in a moment.");
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
    await mount(first);
    // the card of the change that waits is put up wherever the page draws it
    let cards = 0;
    window.addEventListener(LIST_WRITE_WAITING_EVENT, () => { cards += 1; });
    await act(async () => { page.one('button[data-action="remove-device"]').click(); });
    await confirm("Remove");
    expect(textOf(one(dialog(), '[role="alert"]'))).toBe("An earlier change is still waiting: try it again or cancel it first.");
    expect(w.held().entries).toHaveLength(entries);
    expect(cards).toBe(1);
  });

  it("asks again for the new key of a device that handed its place over while the question was open, and never says it was removed", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    const tablet = await letIn(w, first, "Dana's tablet");
    await mount(first);
    await act(async () => { page.one('button[data-action="remove-device"]').click(); });
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
    await confirm("Remove");
    expect(textOf(one(dialog(), '[role="alert"]'))).toBe("Dana's tablet moved to a new key since you asked. Nothing was removed: press Remove again to remove it.");
    expect(w.held().entries).toHaveLength(before);
    await confirm("Remove");
    expect([...document.querySelectorAll('[role="alertdialog"]')]).toHaveLength(0);
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
    await page.render(createElement(SettingsProvider, { children: createElement(Host) }));
    expect([...document.querySelectorAll('[role="alertdialog"]')]).toHaveLength(0);
    await act(async () => { ask!((await second.keys()).key, "Lost phone"); });
    expect(textOf(dialog())).toContain("Remove Lost phone from your account?");
    expect([...boxes()].map((node) => node.checked)).toEqual([true, true]);
    await confirm("Remove");
    expect([...document.querySelectorAll('[role="alertdialog"]')]).toHaveLength(0);
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
    await act(async () => { page.one('button[data-action="remove-device"]').click(); });
    await confirm("Remove");
    expect(listView(w.held().state).devices.find((row) => row.key === next)?.ended).not.toBeNull();
  });

  it("says that what was ticked moved to a new key, not the device asked for, when only a ticked one handed its place on", async () => {
    const { w, first, third } = await withAdditions();
    const root = await mount(first);
    await act(async () => { root.querySelectorAll<HTMLButtonElement>('button[data-action="remove-device"]')[0]!.click(); });
    await act(async () => { boxes()[0]!.click(); });
    // the laptop, ticked, hands its place to a new key of its own before the press
    const heir = await w.device({ label: "Laptop" });
    await heir.list.sync();
    const next = (await heir.keys()).key;
    const claim = (await third.service.listClaims(w.held().id)).find((each) => each.key === next)!;
    const old = await third.keys();
    const rotation = await signListEntry(w.held().state, { kind: "device", key: claim.key, power: "full", role: "drive", until: null, enc: claim.enc, card: claim.card, sealed: null, rotates: true },
      { key: old.key, privateKey: old.signs }, Math.floor(w.clock.now / 1000));
    await third.service.placeEntries(w.held().id, [rotation.text], []);
    await confirm("Remove");
    expect(textOf(one(dialog(), '[role="alert"]'))).toBe("Something you ticked moved to a new key since you asked. Nothing was removed: press Remove again to remove it.");
    await confirm("Remove");
    expect([...document.querySelectorAll('[role="alertdialog"]')]).toHaveLength(0);
    expect(listView(w.held().state).devices.find((row) => row.key === next)?.ended).not.toBeNull();
  });

  it("offers no Remove to a device that may not remove anybody", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    await letIn(w, first, "Dana's tablet");
    const view = await first.list.sync();
    await page.render(createElement(SettingsProvider, { children: createElement(ListDevices, { list: { ...first.list, writer: () => null }, view }) }));
    expect(rows(page.container)).toEqual(["Dana's phoneThis device", "Dana's tablet"]);
  });

});
