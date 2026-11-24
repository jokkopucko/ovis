import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import * as ReactDom from "react-dom";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { listView, signListEntry } from "../../shared/account-list.ts";
import { entryFromText, readBody } from "../../shared/account-list-entry.ts";
import { askingPc, listWorld, postPcKeys, type WorldDevice } from "../lib/account/accountList.test-helpers.ts";
import { allowDevice } from "../lib/account/listAllow.ts";
import { removeFromList } from "../lib/account/listRemoveDevice.ts";
import { translate } from "../lib/i18n.ts";
import { SettingsProvider } from "../lib/settings.ts";

// the confirmation is a portal into document.body: drawn in place here, so the test renderer holds it
await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
const { ListDeviceNotices } = await import("./ListDeviceNotices.tsx");

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

describe("the new-device notice of an account with a signed list", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let warn: typeof console.warn;

  beforeEach(() => {
    warn = console.warn;
    console.warn = () => {};
    for (const key of ["window", "document", "navigator", "getComputedStyle", "matchMedia", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT", "localStorage"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    const kept = new Map<string, string>();
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    class HTMLElement { isConnected = true; focus(): void {} }
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, value); }, removeItem: (key: string) => { kept.delete(key); } } });
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

  const mount = async (device: WorldDevice): Promise<ReactTestInstance> => {
    await device.list.sync();
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: createElement(ListDeviceNotices, { list: device.list }) }), {
        createNodeMock: () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {} }),
      });
    });
    return renderer!.root;
  };
  /** The device reads the list, and the notices are drawn again. */
  const read = async (device: WorldDevice): Promise<void> => { await act(async () => { await device.list.sync(); }); };
  const notices = (root: ReactTestInstance) => root.findAll((node) => node.props["data-testid"] === "list-device-notice").map((node) => textOf(node.findByType("span")));
  const dialog = (root: ReactTestInstance) => root.find((node) => node.props.role === "alertdialog");

  /** Dana's phone started the list and looked at it; then her tablet came in through it, before anything the test does. */
  async function looked() {
    const w = listWorld();
    const phone = await w.device({ label: "Dana's phone" });
    await phone.list.sync();
    const tablet = await letIn(w, phone, "Dana's tablet");
    const root = await mount(phone);
    return { w, phone, tablet, root };
  }

  it("tells nothing on the first look: whoever was in before is no news", async () => {
    const { root } = await looked();
    expect(notices(root)).toEqual([]);
  });

  it("tells of a device another member let in, by both names, and not of one this device let in itself", async () => {
    const { w, phone, tablet, root } = await looked();
    await letIn(w, tablet, "Laptop");
    await read(phone);
    expect(notices(root)).toEqual(["Laptop was allowed into your account by Dana's tablet."]);
    // one this phone let in is no news to it
    await letIn(w, phone, "Desk browser");
    await read(phone);
    expect(notices(root)).toEqual(["Laptop was allowed into your account by Dana's tablet."]);
  });

  it("closes a notice for good with Dismiss", async () => {
    const { w, phone, tablet, root } = await looked();
    await letIn(w, tablet, "Laptop");
    await read(phone);
    await act(async () => { root.find((node) => node.type === "button" && node.props["aria-label"] === "Dismiss").props.onClick(); });
    expect(notices(root)).toEqual([]);
    await read(phone);
    expect(notices(root)).toEqual([]);
  });

  it("Not me asks Remove's question with everything the device added ticked, each can be left out, and says it is out", async () => {
    const { w, phone, tablet, root } = await looked();
    const stranger = await letIn(w, tablet, "Unknown laptop");
    await letIn(w, stranger, "Second stranger");
    const pc = await askingPc();
    const card = await postPcKeys(w.fake.fetch, w.origin, stranger.session.access_token, pc, w.held().id);
    const keys = await stranger.keys();
    const added = await signListEntry(w.held().state, { kind: "pc", key: pc.key, endpoint: pc.endpoint, enc: pc.enc, card, sealed: null }, { key: keys.key, privateKey: keys.signs }, Math.floor(w.clock.now / 1000));
    await stranger.service.placeEntries(w.held().id, [added.text], []);
    await read(phone);
    expect(notices(root)).toEqual(["Unknown laptop was allowed into your account by Dana's tablet.", "Second stranger was allowed into your account by Unknown laptop."]);
    await act(async () => { root.findAll((node) => node.type === "button" && textOf(node) === "Not me")[0]!.props.onClick(); });
    expect(textOf(dialog(root))).toContain("Remove Unknown laptop from your account?");
    const boxes = () => dialog(root).find((node) => node.props["data-testid"] === "came-in-through").findAll((node) => node.type === "input");
    expect(boxes().map((node) => node.props.checked)).toEqual([true, true]);
    expect(dialog(root).findAll((node) => node.props["data-testid"] === "pcs-added-again").map(textOf)).toEqual(["These PCs will need to be added again."]);
    await act(async () => { dialog(root).find((node) => node.type === "button" && textOf(node) === "Remove").props.onClick(); });
    await waitFor(() => root.findAll((node) => node.props["data-testid"] === "list-device-notice-removed").length > 0);
    expect(textOf(root.find((node) => node.props["data-testid"] === "list-device-notice-removed"))).toBe("Unknown laptop was removed from your account.");
    expect(kinds(w.held().entries).slice(-4)).toEqual(["remove", "remove", "remove", "epoch"]);
    const after = listView(w.held().state);
    expect([after.devices.filter((row) => row.ended === null).length, after.pcs.filter((row) => row.removed === null).length]).toEqual([2, 0]);
    await read(phone);
    expect(notices(root)).toEqual([]);
  });

  it("keeps Not me's question up with what was done when its removal stops after a part that already put the device out", async () => {
    const { w, phone, tablet, root } = await looked();
    const stranger = await letIn(w, tablet, "Unknown laptop");
    for (let index = 0; index < 15; index += 1) await letIn(w, stranger, `Stranger ${index + 1}`);
    await read(phone);
    // the first part of the removal is placed, the second is refused for the list's budget
    let parts = 0;
    phone.wire.answer = (request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/entries")) return null;
      parts += 1;
      return parts === 1 ? null : Response.json({ error: { code: "entry_budget", message: "later" }, now: 1 }, { status: 429, headers: { "retry-after": "60" } });
    };
    await act(async () => { root.findAll((node) => node.type === "button" && textOf(node) === "Not me")[0]!.props.onClick(); });
    expect(dialog(root).find((node) => node.props["data-testid"] === "came-in-through").findAll((node) => node.type === "input")).toHaveLength(15);
    await act(async () => { dialog(root).find((node) => node.type === "button" && textOf(node) === "Remove").props.onClick(); });
    await waitFor(() => parts >= 2 && root.findAll((node) => node.props.role === "alert").length > 0 || (parts >= 2 && root.findAll((node) => node.props.role === "alertdialog").length === 0));
    expect(textOf(dialog(root).find((node) => node.props.role === "alert"))).toBe("15 of 16 were removed. Try again for the rest.");
    // and goes on from there: the last one goes, with the epoch
    phone.wire.answer = null;
    await act(async () => { dialog(root).find((node) => node.type === "button" && textOf(node) === "Remove").props.onClick(); });
    await waitFor(() => root.findAll((node) => node.props["data-testid"] === "list-device-notice-removed").length > 0);
    expect(kinds(w.held().entries).slice(-2)).toEqual(["remove", "epoch"]);
    expect(listView(w.held().state).devices.filter((row) => row.ended === null)).toHaveLength(2);
  });

  it("tells nothing of a device that handed its place to a new key of its own: it is no new device", async () => {
    const { w, phone, tablet, root } = await looked();
    const heir = await w.device({ label: "Dana's tablet" });
    await heir.list.sync();
    const next = (await heir.keys()).key;
    const claim = (await tablet.service.listClaims(w.held().id)).find((each) => each.key === next)!;
    const old = await tablet.keys();
    const rotation = await signListEntry(w.held().state, { kind: "device", key: claim.key, power: "full", role: "drive", until: null, enc: claim.enc, card: claim.card, sealed: null, rotates: true },
      { key: old.key, privateKey: old.signs }, Math.floor(w.clock.now / 1000));
    await tablet.service.placeEntries(w.held().id, [rotation.text], []);
    await read(phone);
    expect(listView(w.held().state).devices.find((row) => row.key === next)?.ended).toBeNull();
    expect(notices(root)).toEqual([]);
  });

  it("tells a device whose place was handed to a new key it did not make so, and what to do", async () => {
    const { w, tablet } = await looked();
    // somebody holding the tablet's key hands its place to a key of theirs: the tablet itself made no hand-over
    const heir = await w.device({ label: "Thief's laptop" });
    await heir.list.sync();
    const next = (await heir.keys()).key;
    const claim = (await tablet.service.listClaims(w.held().id)).find((each) => each.key === next)!;
    const old = await tablet.keys();
    const rotation = await signListEntry(w.held().state, { kind: "device", key: claim.key, power: "full", role: "drive", until: null, enc: claim.enc, card: claim.card, sealed: null, rotates: true },
      { key: old.key, privateKey: old.signs }, Math.floor(w.clock.now / 1000));
    await tablet.service.placeEntries(w.held().id, [rotation.text], []);
    await act(async () => { renderer?.unmount(); });
    const root = await mount(tablet);
    expect(root.findAll((node) => node.props["data-testid"] === "list-device-handed-away").map((node) => textOf(node))).toEqual([
      "This device's place in your account was handed to a new key (Unnamed device). If you did not do this, remove that device from another of your devices.",
    ]);
  });

  it("names an approver that is no longer in the list as such, and the Korean words name an unnamed device once", async () => {
    const { w, phone, tablet, root } = await looked();
    await letIn(w, tablet, "Laptop");
    await read(phone);
    // the tablet that let the laptop in is put out, alone
    const out = await removeFromList(phone.list, { keys: [(await tablet.keys()).key], pcs: [] }, { wait: async () => {} });
    expect(out).toEqual({ removed: true });
    await read(phone);
    expect(notices(root)).toEqual(["Laptop was allowed into your account by a device that is no longer in your account."]);
    expect(translate("ko", "{device} was allowed into your account by {approver}.", { device: translate("ko", "Unnamed device"), approver: "Dana's phone" })).not.toContain("기기 기기");
  });

  it("names an approver that handed its place to a new key by the device that holds it now, not as gone", async () => {
    const { w, phone, tablet, root } = await looked();
    await letIn(w, tablet, "Laptop");
    // the tablet hands its place to a new key of its own (its name is not sealed again here)
    const heir = await w.device({ label: "Dana's tablet" });
    await heir.list.sync();
    const next = (await heir.keys()).key;
    const claim = (await tablet.service.listClaims(w.held().id)).find((each) => each.key === next)!;
    const old = await tablet.keys();
    const rotation = await signListEntry(w.held().state, { kind: "device", key: claim.key, power: "full", role: "drive", until: null, enc: claim.enc, card: claim.card, sealed: null, rotates: true },
      { key: old.key, privateKey: old.signs }, Math.floor(w.clock.now / 1000));
    await tablet.service.placeEntries(w.held().id, [rotation.text], []);
    await read(phone);
    expect(notices(root)).toEqual(["Laptop was allowed into your account by Unnamed device."]);
  });

  it("tells a device that may not remove anybody nothing", async () => {
    const { w, phone, tablet } = await looked();
    await letIn(w, tablet, "Laptop");
    await phone.list.sync();
    await act(async () => { renderer?.unmount(); });
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: createElement(ListDeviceNotices, { list: { ...phone.list, writer: () => null } }) }));
    });
    expect(notices(renderer!.root)).toEqual([]);
  });
});
