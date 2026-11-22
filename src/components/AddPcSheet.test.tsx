import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { act, createElement, useLayoutEffect } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { MyPc } from "../lib/account/myPcs.ts";
import { translate } from "../lib/i18n.ts";
import type { RelayShellState } from "../lib/relay/shellState.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AddPcSheet, addPcPhase, addPcSteps, type AddPcSheetProps } from "./AddPcSheet.tsx";
import { RelayPairingPrompt } from "./RelayPairingPrompt.tsx";
import { relayFailureDetail, relayFailureText } from "./relayFailureText.ts";

const SERVER_ID = "b".repeat(32);
const pcOf = (over: Partial<MyPc> = {}): MyPc => ({ server_id: SERVER_ID, name: "desk2", state: "needs-approval", last_seen_at: null, added_at: new Date().toISOString(), listed: true, paired: false, linked: false, join: { server_public_key: "k", relay: "wss://relay.example" }, ...over });
const LIST: RelayShellState = { kind: "list", devices: [], account: { kind: "signed-in", provider: "github", error: null, pcs: [] } };

// the test renderer draws no DOM: a node stands in for every element, so the focus trap finds nothing to hold
const node = () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ height: 400 }), getAnimations: () => [], style: {} });

describe("the Add-a-PC sheet", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let events: EventTarget;
  let opener: { isConnected: boolean; focus: () => void; focused: number };
  let calls: { joins: unknown[][]; matches: unknown[][]; cancels: number; closes: number; pairs: number; qr: number; retries: number; opens: number };

  beforeEach(() => {
    calls = { joins: [], matches: [], cancels: 0, closes: 0, pairs: 0, qr: 0, retries: 0, opens: 0 };
    for (const key of ["window", "document", "navigator", "localStorage", "sessionStorage", "getComputedStyle", "matchMedia", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    events = new EventTarget();
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() };
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    class HTMLElement { isConnected = true; focused = 0; focus(): void { this.focused += 1; } closest(): null { return null; } }
    opener = new HTMLElement();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test browser", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "", touchAction: "auto", position: "static", backgroundColor: "rgba(0, 0, 0, 0.5)" }) });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "https://app.ovis.example/", search: "", origin: "https://app.ovis.example", pathname: "/" },
      history: { state: null, replaceState() {}, pushState() {}, back() {} },
      localStorage: storage,
      matchMedia,
      innerWidth: 1280,
      setTimeout, clearTimeout,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      activeElement: opener,
      // the sheet portals into the body: the renderer needs a container with a node mock for refs
      body: { nodeType: 1, children: [], createNodeMock: node },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } });
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

  const props = (mode: AddPcSheetProps["mode"], pc: MyPc | null, state: RelayShellState): AddPcSheetProps => ({
    mode, pc, state,
    onJoin: (...args) => { calls.joins.push(args); },
    onPair: () => { calls.pairs += 1; },
    onMatch: (...args) => { calls.matches.push(args); },
    onRetry: () => { calls.retries += 1; },
    onOpenPc: () => { calls.opens += 1; },
    onCancel: () => { calls.cancels += 1; },
    onClose: () => { calls.closes += 1; },
    onPairByQr: () => { calls.qr += 1; },
  });
  const view = (shown: AddPcSheetProps) => createElement(SettingsProvider, { children: createElement(AddPcSheet, shown) });
  const mount = async (shown: AddPcSheetProps) => { await act(async () => { renderer = create(view(shown), { createNodeMock: node }); }); }, update = async (shown: AddPcSheetProps) => { await act(async () => { renderer!.update(view(shown)); }); };
  const text = (instance: ReactTestInstance): string => instance.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const all = () => text(renderer!.root);
  const click = async (label: string) => {
    const found = renderer!.root.findAll((instance) => instance.type === "button" && text(instance) === label);
    expect(found.map(text)).toEqual([label]);
    await act(async () => { found[0]!.props.onClick(); });
  };
  const steps = () => renderer!.root.findAll((instance) => instance.type === "li").map((instance) => instance.props["data-step"] as string), digitField = () => renderer!.root.findAll((instance) => instance.type === "input" && instance.props.name === "digits");
  const escape = async () => {
    const event = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
    await act(async () => { window.dispatchEvent(event); });
    return event.defaultPrevented;
  };

  it("marks the steps done in order, keeps join start idle until asked, and marks all four done on ready", () => {
    expect(addPcSteps("new", "start", null)).toEqual(["done", "running", "todo", "todo"]);
    expect(addPcSteps("new", "compare", null)).toEqual(["done", "running", "todo", "todo"]);
    expect(addPcSteps("new", "approving", null)).toEqual(["done", "done", "running", "todo"]);
    expect(addPcSteps("new", "failed", "new-devices-refused")).toEqual(addPcSteps("new", "failed", "pair-declined"));
    expect(addPcSteps("join", "failed", "new-devices-refused")).toEqual(addPcSteps("join", "failed", "pair-declined"));
    expect(addPcSteps("new", "ready", null)).toEqual(["done", "done", "done", "done"]);
    expect(addPcSteps("join", "start", null)).toEqual(["current", "todo", "todo", "todo"]);
    expect(addPcSteps("join", "connecting", null)).toEqual(["running", "todo", "todo", "todo"]);
    expect(addPcSteps("join", "compare", null)).toEqual(["done", "running", "todo", "todo"]);
    expect(addPcSteps("join", "ready", null)).toEqual(["done", "done", "done", "done"]);
    expect(addPcSteps("join", "failed", "pc-offline")).toEqual(["failed", "todo", "todo", "todo"]);
    expect(addPcSteps("join", "failed", "pair-declined")).toEqual(["done", "done", "failed", "todo"]);
  });

  it("shows a join a PC's own page offers as one press, then the number alone: no steps, no choices, Cancel the one button, the other way folded away", async () => {
    const offer = { v: 1 as const, server_id: SERVER_ID, server_public_key: "k", relay: "wss://relay.example", name: "desk2" };
    await mount(props("join", pcOf(), { kind: "confirm", offer, account: "listed", alone: true }));
    expect(renderer!.root.findByProps({ role: "dialog" }).props["data-add-pc-phase"]).toBe("confirm");
    expect(steps()).toEqual([]);
    expect(renderer!.root.findAll((instance) => instance.type === "button").map(text).sort()).toEqual(["Ask to join", "Cancel"]);
    await click("Ask to join");
    expect(calls.pairs).toBe(1);
    await update(props("join", pcOf(), { kind: "compare", name: "desk2", digits: "123456", confirmed: true, challenge: 1, alone: true }));
    const dialog = renderer!.root.findByProps({ role: "dialog" });
    expect(dialog.props["data-add-pc-phase"]).toBe("compare");
    expect(text(renderer!.root.findByProps({ className: "modal-title" }))).toBe(translate("en", "Approve it on {name}", { name: "desk2" }));
    expect(text(renderer!.root.findByProps({ className: "relay-shell-digits" }))).toBe("123 456");
    expect(steps()).toEqual([]);
    expect(renderer!.root.findAll((instance) => instance.props.className === "add-pc-bars")).toEqual([]);
    expect(renderer!.root.findAll((instance) => instance.type === "button").map(text)).toEqual(["Cancel"]);
    expect(renderer!.root.findAll((instance) => instance.type === "details").map((instance) => instance.props.open)).toEqual([undefined]);
    await click("Cancel");
    expect([calls.cancels, calls.closes, calls.matches]).toEqual([1, 1, []]);
  });

  it("walks a new PC through the typed join: Step n of 4, visible label, footer actions, 90-second wait, wrong-number retry, and Ready", async () => {
    const pc = pcOf();
    await mount(props("new", pc, LIST));
    expect(renderer!.root.findByProps({ role: "dialog" }).props["aria-modal"]).toBe("true");
    expect(all()).toContain("Add desk2 to your account");
    // the step's number is the thin bars' own, for a screen reader, never a line on the sheet
    expect((renderer!.root.findAll((n) => n.type === "div" && n.props.role === "progressbar").map((n) => [n.props["aria-valuenow"], n.props["aria-valuetext"]]))).toEqual([[2, "Step 2 of 4"]]);
    expect(all()).not.toContain("Step 2 of 4");
    expect(steps()).toEqual(["done", "running", "todo", "todo"]);
    await click("Add this PC");
    expect(calls.joins).toEqual([[pc, { typed: true }]]);
    await update(props("new", pc, { kind: "connecting", name: "desk2" }));
    const waitStatus = renderer!.root.findByProps({ role: "status" });
    expect(waitStatus.findAll((n) => n.props.className === "visually-hidden")).toHaveLength(0);
    expect(text(waitStatus)).toContain("desk2");
    await update(props("new", pc, { kind: "compare", name: "desk2", digits: "123456", confirmed: false, typed: true, challenge: 1 }));
    expect(renderer!.root.findAllByType("h1")).toHaveLength(0);
    expect(digitField()).toHaveLength(1);
    expect(String(digitField()[0]!.props.className)).toContain("input");
    expect(renderer!.root.findAll((n) => n.type === "label")).toHaveLength(1);
    const footer = renderer!.root.findByType("footer");
    expect(footer.findAll((n) => n.type === "button").map(text)).toEqual(["Cancel", "Add this PC"]);
    expect(all()).not.toContain("123 456");
    expect(steps()).toEqual(["done", "running", "todo", "todo"]);
    const form = renderer!.root.findByType("form");
    const mockField = { value: "123 456" };
    await act(async () => { form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => mockField } } }); });
    expect(calls.matches).toEqual([["123456"]]);
    expect(mockField.value).toBe("123 456");
    const submitBtn = footer.findAll((n) => n.type === "button" && n.props.type === "submit")[0]!;
    expect(submitBtn.props.disabled).toBe(true);
    await act(async () => { form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => mockField } } }); });
    expect(calls.matches).toHaveLength(1);
    await update(props("new", pc, { kind: "compare", name: "desk2", digits: "123456", confirmed: true, challenge: 1 }));
    expect(steps()).toEqual(["done", "done", "running", "todo"]);
    expect(all()).toContain("90");
    expect(renderer!.root.findByType("footer").findAll((n) => n.type === "button").map(text)).toEqual(["Cancel"]);
    await update(props("new", pc, { kind: "ready", name: "desk2", server_id: SERVER_ID }));
    expect(addPcPhase(pc, { kind: "ready", name: "desk2", server_id: SERVER_ID })).toBe("ready");
    expect(steps()).toEqual(["done", "done", "done", "done"]);
    expect((renderer!.root.findAll((n) => n.type === "div" && n.props.role === "progressbar").map((n) => [n.props["aria-valuenow"], n.props["aria-valuetext"]]))).toEqual([[4, "Step 4 of 4"]]);
    await click("Open PC");
    expect(calls.opens).toBe(1);
  });

  it.each(["pending", "complete", "failed"] as const)("keeps Open PC available and reports %s account enrollment truthfully", async (enrollment) => {
    await mount(props("new", pcOf(), { kind: "ready", name: "desk2", server_id: SERVER_ID, enrollment }));
    expect(all()).toContain("desk2 is ready to open on this device.");
    expect(all().includes("In your account")).toBe(enrollment === "complete");
    expect(all().includes("Adding it to your account. Keep this open until it is done.")).toBe(enrollment === "pending");
    expect(all().includes("Account setup is incomplete.")).toBe(enrollment === "failed");
    if (enrollment === "failed") { await click("Try again"); expect(calls.retries).toBe(1); }
    await click("Open PC");
    expect(calls.opens).toBe(1);
  });

  it("closes Ready once without cancelling account work", async () => {
    await mount(props("new", pcOf(), { kind: "ready", name: "desk2", server_id: SERVER_ID, enrollment: "pending" }));
    await escape();
    expect(calls).toMatchObject({ closes: 1, cancels: 0 });
  });

  it("walks an account join: who approves it and what to open first, approval on a device connected to the PC, 90-second wait, and refusal", async () => {
    // a PC this device paired by QR knows nothing of desk2's requests: it is never named as the approver
    const unrelated = pcOf({ server_id: "a".repeat(32), name: "Work MacBook", state: "paired", paired: true });
    const pc = pcOf({ added_at: new Date(Date.now() - 15 * 60_000).toISOString() });
    const stateWithPcs: RelayShellState = { kind: "list", devices: [], account: { kind: "signed-in", provider: "github", error: null, pcs: [unrelated, pc] } };
    await mount(props("join", pc, stateWithPcs));
    const sub = () => text(renderer!.root.findByProps({ className: "add-pc-sub" }));
    // the start says what must be open before the press: only a device with the PC open hears the request
    expect(text(renderer!.root.findByProps({ className: "modal-title" }))).toBe(translate("en", "Get approved on a device you already use"));
    expect(sub()).toBe(translate("en", "Open {name} in Ovis on a device you already use and approve there, or on {name} itself: Settings → Devices and PCs, then type the number this device shows.", { name: "desk2" }));
    expect(all()).not.toContain("Add window closed");
    expect(all()).toContain("Check the number on a device connected to desk2");
    expect(all()).not.toContain("Work MacBook");
    expect(steps()).toEqual(["current", "todo", "todo", "todo"]);
    await click("Ask to join");
    expect(calls.joins).toEqual([[pc]]);
    await update(props("join", pc, { kind: "compare", name: "desk2", digits: "123456", confirmed: false }));
    // the approvers it names are a device connected to desk2 and desk2 itself, never the unrelated paired PC
    expect(text(renderer!.root.findByProps({ className: "modal-title" }))).toBe(translate("en", "Add this device to {name}", { name: "desk2" }));
    expect(sub()).toBe(translate("en", "Approve this device on a device of your account connected to {name}, or on {name} itself: Settings → Devices and PCs, then type the number this device shows.", { name: "desk2" }));
    expect(sub()).not.toContain("Work MacBook");
    expect(all()).toContain("Check that this number matches where you approve, then approve.");
    const digits = renderer!.root.findByProps({ className: "relay-shell-digits" });
    expect(text(digits)).toBe("123 456");
    expect(digits.props["aria-label"]).toBe("1 2 3 4 5 6");
    expect(digitField()).toHaveLength(0);
    expect(steps()).toEqual(["done", "running", "todo", "todo"]);
    await click("The numbers match");
    expect(calls.matches).toEqual([[]]);
    await update(props("join", pc, { kind: "compare", name: "desk2", digits: "123456", confirmed: true }));
    expect(steps()).toEqual(["done", "done", "running", "todo"]);
    expect(all()).toContain("Waiting up to 90 seconds for approval…");
    expect(all()).toContain("On a device of your account that is connected to desk2, or on desk2 itself");
    await update(props("join", pc, { kind: "failed", failure: "pair-declined", name: "desk2", detail: null }));
    expect(steps()).toEqual(["done", "done", "failed", "todo"]);
    expect(all()).not.toContain("Work MacBook");
    // a join has no link to open again: the refusal names both that may approve it, the PC itself among them when its own Add screen waits
    expect(text(renderer!.root.findByProps({ className: "add-pc-problem" }))).toBe("Nobody approved this device for desk2");
    expect(all()).toContain("Nobody approved it within 90 seconds, or it was denied. Try again, and approve it on a device of your account that is connected to desk2 (keep desk2 open in Ovis there), or on desk2 itself if it shows this request. If it keeps failing, pair this device with a QR or code from desk2.");
    expect(all()).not.toContain("Open the link again");
    expect(renderer!.root.findAll((instance) => instance.type === "button").map(text)).toEqual(["Close", "Try again"]);
    await click("Try again");
    await click("Close");
    expect(calls).toMatchObject({ closes: 1, cancels: 0, retries: 1 });
  });

  it("says what stopped a new PC or a join and what to press, with Try again, instead of an add window no one can reopen from here", async () => {
    const buttons = () => renderer!.root.findAll((instance) => instance.type === "button").map(text);
    const problem = () => text(renderer!.root.findByProps({ className: "add-pc-problem" }));
    const expired = pcOf({ added_at: new Date(Date.now() - 15 * 60_000).toISOString() });
    await mount(props("new", pcOf(), { kind: "failed", failure: "pair-unavailable", name: "desk2", detail: null, server_id: SERVER_ID }));
    expect(problem()).toBe("desk2 is no longer waiting to be added");
    expect(all()).toContain("On desk2, open Settings → Devices and PCs → Add a connection → Ovis relay and keep that screen open (choose Keep waiting or Add this PC to my account if it shows one), then try again here. If it still refuses, wait a few minutes: it pauses after too many tries.");
    expect(all()).not.toContain("Copy a new link");
    expect(buttons()).toEqual(["Close", "Try again"]);
    await click("Try again");
    expect(calls.retries).toBe(1);
    // the same words whatever the row's age: a new PC has no member to ask
    await update(props("new", expired, { kind: "failed", failure: "pair-unavailable", name: "desk2", detail: null, server_id: SERVER_ID }));
    expect(problem()).toBe("desk2 is no longer waiting to be added");
    expect(all()).not.toContain("account member");
    // a new PC that declined, or was not approved in time, is approved on the PC itself
    await update(props("new", pcOf(), { kind: "failed", failure: "pair-declined", name: "desk2", detail: null, server_id: SERVER_ID }));
    expect(problem()).toBe("desk2 did not approve this device");
    expect(all()).toContain("It was declined on desk2, or not approved within 90 seconds. Try again and press Approve on desk2. If desk2 showed no number, ask to join instead.");
    expect(all()).not.toContain("Open the link again");
    expect(buttons()).toEqual(["Close", "Try again"]);
    // a join the PC refused before any digits: it has not learned this device yet, or it is paused (nobody connected is a timeout, not this)
    await update(props("join", expired, { kind: "failed", failure: "pair-unavailable", name: "desk2", detail: null, server_id: SERVER_ID }));
    expect(problem()).toBe("desk2 cannot take this device yet");
    expect(all()).toContain("desk2 did not take this request. It may not know this device yet (it learns your account's devices within a few minutes), or it is paused after too many tries. Wait a moment, then try again. If no device of your account uses desk2 yet, pair this device with a QR or code from desk2 instead.");
    expect(all()).not.toContain("Copy a new link");
    expect(buttons()).toEqual(["Close", "Try again"]);
    await update(props("join", expired, { kind: "failed", failure: "pair-declined", name: "desk2", detail: null, server_id: SERVER_ID }));
    expect(problem()).toBe("Nobody approved this device for desk2");
    expect(buttons()).toEqual(["Close", "Try again"]);
    const { onRetry: _onRetry, ...noRetry } = props("new", pcOf(), { kind: "failed", failure: "pair-unavailable", name: "desk2", detail: null, server_id: SERVER_ID });
    await update(noRetry);
    expect(buttons()).toEqual(["Close"]);
  });

  it("keeps a connection failure's own diagnosis after a new PC's Add window has closed, and the same subtitle before and after it", async () => {
    const expired = pcOf({ added_at: new Date(Date.now() - 15 * 60_000).toISOString() });
    await mount(props("new", expired, { kind: "failed", failure: "pc-offline", name: "desk2", detail: null, server_id: SERVER_ID }));
    expect(all()).toContain("Machine offline");
    expect(all()).not.toContain("Add window closed");
    await update(props("new", expired, { kind: "failed", failure: "relay-unreachable", name: "desk2", detail: null, server_id: SERVER_ID }));
    expect(all()).toContain("Could not reach this machine");
    expect(all()).not.toContain("Add window closed");
    expect(all()).toContain("This device could not reach the relay. Check this device's network, then try again.");
    // the relay's refusal of a new device is the account's limit, not the window or the flow: both flows say what the link says, with Try again
    for (const flow of ["new", "join"] as const) {
      const plain = relayFailureText((key) => key, "new-devices-refused", "desk2", null);
      expect(relayFailureText((key) => key, "new-devices-refused", "desk2", null, flow)).toEqual(plain);
      await update(props(flow, expired, { kind: "failed", failure: "new-devices-refused", name: "desk2", detail: null, server_id: SERVER_ID }));
      expect(text(renderer!.root.findByProps({ className: "add-pc-problem" }))).toBe("desk2 cannot add new devices right now");
      expect(all()).toContain("Devices already added still connect.");
      expect(all()).not.toContain("Add window closed");
      expect(renderer!.root.findAll((instance) => instance.type === "button").map(text)).toContain("Try again");
    }
    await update(props("join", expired, { kind: "failed", failure: "pc-offline", name: "desk2", detail: null, server_id: SERVER_ID }));
    expect(all()).toContain("Machine offline");
    expect(all()).toContain("Start it, or wait for it to come back");
    for (const pc of [pcOf(), expired]) {
      await update(props("new", pc, LIST));
      expect(text(renderer!.root.findByProps({ className: "add-pc-sub" }))).toBe("Type the number desk2 shows on its own screen, then approve there.");
      expect(renderer!.root.findAll((instance) => instance.props.className === "relay-shell-copy")).toHaveLength(0);
    }
  });

  it("offers Try again on a wrong typed number to start a fresh handshake, and clears the field when the new challenge arrives", async () => {
    const pc = pcOf();
    await mount(props("new", pc, { kind: "compare", name: "desk2", digits: "", confirmed: false, typed: true, wrong: true, challenge: 1 }));
    expect(all()).toContain("That is not the number desk2 shows");
    expect(all()).not.toContain("Tap the PC again");
    expect(steps()).toEqual(["done", "running", "todo", "todo"]);
    const retryBtn = renderer!.root.findAll((n) => n.type === "button" && n.props["data-action"] === "retry");
    expect(retryBtn).toHaveLength(1);
    await click("Try again");
    expect(calls.retries).toBe(1);
    await update(props("new", pc, { kind: "compare", name: "desk2", digits: "654321", confirmed: false, typed: true, challenge: 2 }));
    expect(digitField()).toHaveLength(1);
    expect(all()).toContain("changed");
  });

  it("says why a join failed without raw close-code details, offers Try again where that can help, and never repeats the problem line in the subtitle across any sheet state", async () => {
    await mount(props("new", pcOf(), { kind: "failed", failure: "pc-offline", name: "desk2", detail: "The relay closed the connection (0)", server_id: SERVER_ID }));
    expect(renderer!.root.findByProps({ role: "dialog" }).props["data-add-pc-phase"]).toBe("failed");
    expect(all()).toContain("Machine offline");
    expect(all()).toContain("Start it, or wait for it to come back");
    expect(all()).not.toContain("The relay closed the connection (0)");
    expect(steps()).toEqual(["done", "failed", "todo", "todo"]);
    await click("Try again");
    expect(calls.retries).toBe(1);

    const normalize = (value: string): string => value.trim().replace(/[.。]+$/, "");
    const freshPc = pcOf({ added_at: new Date().toISOString() });
    const expiredPc = pcOf({ added_at: new Date(Date.now() - 15 * 60_000).toISOString() });
    const states: RelayShellState[] = [
      LIST,
      { kind: "confirm", offer: { v: 1, server_id: SERVER_ID, server_public_key: "k", relay: "wss://relay.example", name: "desk2" } },
      { kind: "connecting", name: "desk2" },
      { kind: "compare", name: "desk2", digits: "123456", confirmed: false, typed: true, challenge: 1 },
      { kind: "compare", name: "desk2", digits: "", confirmed: false, typed: true, wrong: true, challenge: 1 },
      { kind: "compare", name: "desk2", digits: "123456", confirmed: true, challenge: 1 },
      { kind: "ready", name: "desk2", server_id: SERVER_ID },
      { kind: "failed", failure: "pair-unavailable", name: "desk2", detail: null, server_id: SERVER_ID },
      { kind: "failed", failure: "pc-offline", name: "desk2", detail: null, server_id: SERVER_ID },
      { kind: "failed", failure: "pair-declined", name: "desk2", detail: null, server_id: SERVER_ID },
    ];
    for (const [mode, target] of [["new", freshPc], ["new", expiredPc], ["join", expiredPc]] as const) {
      for (const st of states) {
        await update(props(mode, target, st));
        const subText = text(renderer!.root.findByProps({ className: "add-pc-sub" }));
        for (const problem of renderer!.root.findAll((n) => n.props.className === "add-pc-problem")) {
          expect(normalize(text(problem))).not.toBe(normalize(subText));
        }
      }
    }
  });

  it("closes on Escape, swipe-down, and scrim click, ending a comparison in progress, and gives the focus back to what opened it", async () => {
    await mount(props("new", pcOf(), LIST));
    expect(await escape()).toBe(true);
    expect(calls).toMatchObject({ closes: 1, cancels: 0 });
    await update(props("new", pcOf(), { kind: "compare", name: "desk2", digits: "123456", confirmed: false, typed: true }));
    await escape();
    expect(calls).toMatchObject({ closes: 2, cancels: 1 });
    const scrim = renderer!.root.findByProps({ className: "modal-scrim" });
    await act(async () => { scrim.props.onMouseDown({ target: scrim, currentTarget: scrim }); });
    expect(calls).toMatchObject({ closes: 3, cancels: 2 });
    expect(opener.focused).toBe(0);
    await act(async () => { renderer!.unmount(); });
    expect(opener.focused).toBe(1);
  });

  it("gives the focus back to what opened it when the page behind turns interactive only after the sheet is gone", async () => {
    const page = document as unknown as { activeElement: unknown; body: unknown };
    let inert = true;
    opener.focus = () => { if (!inert) page.activeElement = opener; };
    const Behind = ({ shown }: { shown: boolean }) => { useLayoutEffect(() => { inert = shown; }, [shown]); return null; };
    const screen = (shown: boolean) => createElement(SettingsProvider, { children: [shown && createElement(AddPcSheet, { key: "sheet", ...props("add", null, LIST) }), createElement(Behind, { key: "behind", shown })] });
    await act(async () => { renderer = create(screen(true), { createNodeMock: node }); });
    page.activeElement = page.body;
    await act(async () => { renderer!.update(screen(false)); });
    expect(page.activeElement).toBe(opener);
  });

  it("with no PC, says how one is added in one concise sentence and leads to the QR and code screen", async () => {
    await mount(props("add", null, LIST));
    expect(all()).toContain("Add a PC");
    expect(all()).toContain("On the PC, open Settings → Devices and PCs → Add a connection → Ovis relay, sign in, then choose Add this PC to my account. It then shows here.");
    expect(steps()).toEqual([]);
    expect(renderer!.root.findAll((instance) => instance.props.className === "add-pc-bars")).toHaveLength(0);
    await click("Pair with a QR or code");
    expect(calls.qr).toBe(1);
    await click("Close");
    expect(calls).toMatchObject({ closes: 1, cancels: 0 });
  });

  it("keeps a second way on a new PC's sheet and on the join sheet based on whether the PC waits to be added, not a number before Add starts", async () => {
    let asked = 0;
    await mount({ ...props("new", pcOf(), LIST), onAskToJoin: () => { asked += 1; } });
    expect(text(renderer!.root.findByProps({ className: "add-pc-sub" }))).toBe("Type the number desk2 shows on its own screen after you start Add, then approve there. If desk2 is already in your account, ask to join instead.");
    expect(renderer!.root.findByType("footer").findAll((n) => n.type === "button").map(text)).toEqual(["Cancel", "Ask to join", "Add this PC"]);
    await click("Ask to join");
    expect(asked).toBe(1);
    expect(calls.joins).toEqual([]);

    let typed = 0;
    await update({ ...props("join", pcOf(), LIST), onTypeNumber: () => { typed += 1; } });
    expect(renderer!.root.findByType("footer").findAll((n) => n.type === "button").map(text)).toEqual(["Cancel", "Type the number", "Ask to join"]);
    await click("Type the number");
    expect(typed).toBe(1);
  });

  it("makes approval on a device already in use a join's one way at the start, with no QR choice: a PC in an account shows no QR code", async () => {
    const pc = pcOf();
    const primary = () => renderer!.root.findAll((n) => n.type === "button" && n.props["data-sheet-primary"] === true);
    for (const typeNumber of [undefined, () => {}]) {
      calls = { ...calls, joins: [], qr: 0 };
      await mount({ ...props("join", pc, LIST), ...(typeNumber ? { onTypeNumber: typeNumber } : {}) });
      // the one primary asks to join through the account
      expect(primary()).toHaveLength(1);
      await act(async () => { primary()[0]!.props.onClick(); });
      expect([calls.joins, calls.qr]).toEqual([[[pc]], 0]);
      // no way to the PC's QR code, and nothing after the footer
      expect(renderer!.root.findAll((n) => n.type === "button" && n.props["data-action"] === "pair-qr")).toHaveLength(0);
      const footer = renderer!.root.findByType("footer");
      expect(footer.parent!.children.at(-1)).toBe(footer);
      await act(async () => { renderer!.unmount(); });
    }
  });

  it("offers Ask to join under a typed comparison, for a PC that shows no number, and only where the shell can turn the request into a join", async () => {
    const typing: RelayShellState = { kind: "compare", name: "desk2", digits: "", confirmed: false, typed: true, challenge: 1 };
    const footer = () => renderer!.root.findByType("footer").findAll((n) => n.type === "button").map(text);
    let asked = 0;
    await mount({ ...props("new", pcOf(), typing), onAskToJoin: () => { asked += 1; } });
    expect(all()).toContain("desk2 shows no number? Ask to join instead.");
    expect(footer()).toEqual(["Cancel", "Ask to join", "Add this PC"]);
    await click("Ask to join");
    expect(asked).toBe(1);
    expect(calls).toMatchObject({ cancels: 0, closes: 0 });
    await update(props("new", pcOf(), typing));
    expect(all()).not.toContain("desk2 shows no number? Ask to join instead.");
    expect(footer()).toEqual(["Cancel", "Add this PC"]);
  });

  it("places the primary action first in DOM order on phone sheets and second on desktop across sheet phases", async () => {
    const pc = pcOf();
    const footerLabels = () => renderer!.root.findByType("footer").findAll((n) => n.type === "button").map(text);
    await mount(props("new", pc, LIST));
    expect(footerLabels()).toEqual(["Cancel", "Add this PC"]);
    await act(async () => { renderer!.unmount(); });

    const phoneMedia = (query: string) => ({ matches: query === "(max-width: 640px)", addEventListener() {}, removeEventListener() {} });
    (window as unknown as { matchMedia: typeof phoneMedia }).matchMedia = phoneMedia;
    jest.useFakeTimers();
    try {
      await mount(props("add", null, LIST));
      expect(footerLabels()).toEqual(["Pair with a QR or code", "Close"]);
      await update(props("new", pc, LIST));
      expect(footerLabels()).toEqual(["Add this PC", "Cancel"]);
      await update(props("join", pc, LIST));
      expect(footerLabels()).toEqual(["Ask to join", "Cancel"]);
      await update(props("new", pc, { kind: "confirm", offer: { v: 1, server_id: SERVER_ID, server_public_key: "k", relay: "wss://relay.example", name: "desk2" } }));
      expect(footerLabels()).toEqual(["Pair", "Cancel"]);
      await update(props("new", pc, { kind: "compare", name: "desk2", digits: "123456", confirmed: false, typed: true, challenge: 1 }));
      expect(footerLabels()).toEqual(["Add this PC", "Cancel"]);
      await update(props("join", pc, { kind: "compare", name: "desk2", digits: "123456", confirmed: false }));
      expect(footerLabels()).toEqual(["The numbers match", "Cancel"]);
      await update(props("new", pc, { kind: "compare", name: "desk2", digits: "", confirmed: false, typed: true, wrong: true, challenge: 1 }));
      expect(footerLabels()).toEqual(["Try again", "Cancel"]);
      await update(props("new", pc, { kind: "ready", name: "desk2", server_id: SERVER_ID }));
      expect(footerLabels()).toEqual(["Open PC", "Cancel"]);
      await update(props("new", pc, { kind: "failed", failure: "pc-offline", name: "desk2", detail: null, server_id: SERVER_ID }));
      expect(footerLabels()).toEqual(["Try again", "Close"]);
      await act(async () => { renderer!.unmount(); jest.runAllTimers(); });
    } finally {
      jest.useRealTimers();
    }
  });

  it("uses device terminology instead of hardcoding phone in relayFailureText and sets aria-busy on RelayPairingPrompt", async () => {
    const id = (s: string, vars?: Record<string, string | number>) => vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? "")) : s;
    expect(relayFailureText(id, "pair-declined", "desk2").title).toBe("desk2 did not approve this device");
    expect(relayFailureText(id, "pair-unavailable", "desk2").title).toBe("desk2 is not taking new devices right now");
    expect(relayFailureText(id, "pair-declined", "desk2")).toMatchObject({ copy: "It was declined on the PC, or not approved within 90 seconds. Open the link again to compare new numbers.", retry: false });
    expect(relayFailureText(id, "pair-unavailable", "desk2")).toMatchObject({ retry: false });
    expect(relayFailureText(id, "pair-unavailable", "desk2").copy).toContain("Copy a new link on the PC");
    for (const flow of ["new", "join"] as const) {
      expect(relayFailureText(id, "pair-unavailable", "desk2", null, flow).retry).toBe(true);
      expect(relayFailureText(id, "pair-declined", "desk2", null, flow).retry).toBe(true);
      for (const failure of ["not-added-yet", "pc-offline", "pc-unresponsive", "relay-unreachable", "needs-update", "revoked", "identity-changed", "code-expired", "bad-offer"] as const) {
        expect(relayFailureText(id, failure, "desk2", "x", flow)).toEqual(relayFailureText(id, failure, "desk2", "x"));
      }
    }
    expect(relayFailureText(id, "relay-unreachable", "desk2").copy).toBe("This device could not reach the relay. Check this device's network, then try again.");
    expect(relayFailureText(id, "revoked", "desk2").title).toBe("This device was removed from desk2");
    expect(relayFailureText(id, "pair-declined", "desk2", "The relay closed the connection (0)").detail).toBeNull();
    expect(relayFailureText(id, "pc-offline", "desk2", "relay closed 4404").detail).toBe("relay closed 4404");
    expect(relayFailureDetail("The relay closed the connection (1011)")).toBeNull();
    expect(relayFailureDetail("relay closed 4404")).toBe("relay closed 4404");

    let promptRenderer: ReactTestRenderer | undefined;
    await act(async () => {
      promptRenderer = create(createElement(SettingsProvider, {
        children: createElement(RelayPairingPrompt, { pairings: [{ id: "p1", label: "Linux · Chrome", digits: "725403", expires_at: "" }] }),
      }));
    });
    const buttons = promptRenderer!.root.findAllByType("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.props["aria-busy"]).toBeUndefined();
    await act(async () => { promptRenderer?.unmount(); });
  });
});
