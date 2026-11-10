import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { act, createElement, useLayoutEffect } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { MyPc } from "../lib/account/myPcs.ts";
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
  /** what had the focus when the sheet opened, and how often it got it back */
  let opener: { isConnected: boolean; focus: () => void; focused: number };
  let calls: { joins: unknown[][]; matches: unknown[][]; cancels: number; closes: number; pairs: number; qr: number; retries: number; opens: number };

  beforeEach(() => {
    calls = { joins: [], matches: [], cancels: 0, closes: 0, pairs: 0, qr: 0, retries: 0, opens: 0 };
    for (const key of ["window", "document", "navigator", "localStorage", "sessionStorage", "getComputedStyle", "matchMedia", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    events = new EventTarget();
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() };
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    class HTMLElement { isConnected = true; focused = 0; focus(): void { this.focused += 1; } }
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
    // the relay's refusal comes after the digits were confirmed: the typed number was right
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

  it("walks a new PC through the typed join: Step n of 4, visible label, footer actions, 90-second wait, wrong-number retry, and Ready", async () => {
    const pc = pcOf();
    await mount(props("new", pc, LIST));
    expect(renderer!.root.findByProps({ role: "dialog" }).props["aria-modal"]).toBe("true");
    expect(all()).toContain("Add desk2 to your account");
    expect(all()).toContain("Step 2 of 4");
    expect(steps()).toEqual(["done", "running", "todo", "todo"]);
    await click("Add this PC");
    expect(calls.joins).toEqual([[pc, { typed: true }]]);
    // connecting shows visible status text alongside the spinner
    await update(props("new", pc, { kind: "connecting", name: "desk2" }));
    const waitStatus = renderer!.root.findByProps({ role: "status" });
    expect(waitStatus.findAll((n) => n.props.className === "visually-hidden")).toHaveLength(0);
    expect(text(waitStatus)).toContain("desk2");
    // the shell asks for the number the PC shows: visible label, .input class, footer submit button, no h1 inside dialog
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
    // value preserved in DOM input across submission
    expect(mockField.value).toBe("123 456");
    // pending submit suppression: a second submit before challenge advances is ignored and button is disabled
    const submitBtn = footer.findAll((n) => n.type === "button" && n.props.type === "submit")[0]!;
    expect(submitBtn.props.disabled).toBe(true);
    await act(async () => { form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => mockField } } }); });
    expect(calls.matches).toHaveLength(1);
    // approving states the 90-second deadline and keeps Cancel
    await update(props("new", pc, { kind: "compare", name: "desk2", digits: "123456", confirmed: true, challenge: 1 }));
    expect(steps()).toEqual(["done", "done", "running", "todo"]);
    expect(all()).toContain("90");
    expect(renderer!.root.findByType("footer").findAll((n) => n.type === "button").map(text)).toEqual(["Cancel"]);
    // ready step marks all 4 steps done and offers Open PC
    await update(props("new", pc, { kind: "ready", name: "desk2", server_id: SERVER_ID }));
    expect(addPcPhase(pc, { kind: "ready", name: "desk2", server_id: SERVER_ID })).toBe("ready");
    expect(steps()).toEqual(["done", "done", "done", "done"]);
    expect(all()).toContain("Step 4 of 4");
    await click("Open PC");
    expect(calls.opens).toBe(1);
  });

  it.each(["pending", "complete", "failed"] as const)("keeps Open PC available and reports %s account enrollment truthfully", async (enrollment) => {
    await mount(props("new", pcOf(), { kind: "ready", name: "desk2", server_id: SERVER_ID, enrollment }));
    expect(all()).toContain("desk2 is ready to open on this device.");
    expect(all().includes("In your account")).toBe(enrollment === "complete");
    expect(all().includes("Adding it to your account…")).toBe(enrollment === "pending");
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

  it("walks an account join: expired Add window explanation, approval on a device connected to the PC, 90-second wait, and refusal", async () => {
    // a PC this device paired by QR knows nothing of desk2's requests: it is never named as the approver
    const unrelated = pcOf({ server_id: "a".repeat(32), name: "Work MacBook", state: "paired", paired: true });
    const pc = pcOf({ added_at: new Date(Date.now() - 15 * 60_000).toISOString() });
    const stateWithPcs: RelayShellState = { kind: "list", devices: [], account: { kind: "signed-in", provider: "github", error: null, pcs: [unrelated, pc] } };
    await mount(props("join", pc, stateWithPcs));
    expect(all()).toContain("Add this device to desk2");
    expect(all()).toContain("Add window closed · an account member must approve on a device connected to desk2.");
    expect(all()).toContain("Check the number on a device connected to desk2");
    expect(all()).not.toContain("Work MacBook");
    expect(steps()).toEqual(["current", "todo", "todo", "todo"]);
    await click("Ask to join");
    expect(calls.joins).toEqual([[pc]]);
    await update(props("join", pc, { kind: "compare", name: "desk2", digits: "123456", confirmed: false }));
    expect(all()).toContain("A device connected to desk2 shows three numbers: pick this one there.");
    const digits = renderer!.root.findByProps({ className: "relay-shell-digits" });
    expect(text(digits)).toBe("123 456");
    expect(digits.props["aria-label"]).toBe("1 2 3 4 5 6");
    expect(digitField()).toHaveLength(0);
    expect(steps()).toEqual(["done", "running", "todo", "todo"]);
    await click("The numbers match");
    expect(calls.matches).toEqual([[]]);
    await update(props("join", pc, { kind: "compare", name: "desk2", digits: "123456", confirmed: true }));
    expect(steps()).toEqual(["done", "done", "running", "todo"]);
    expect(all()).toContain("Waiting for an account member to approve this device within 90 seconds…");
    await update(props("join", pc, { kind: "failed", failure: "pair-declined", name: "desk2", detail: null }));
    expect(steps()).toEqual(["done", "done", "failed", "todo"]);
    expect(all()).not.toContain("Work MacBook");
    expect(all()).toContain("desk2 did not approve this device");
    expect(all()).toContain("90 seconds");
    expect(renderer!.root.findAll((instance) => instance.type === "button").map(text)).toEqual(["Close"]);
    await click("Close");
    expect(calls).toMatchObject({ closes: 1, cancels: 0, retries: 0 });
  });

  it("keeps a connection failure's own diagnosis after a new PC's Add window has closed, and the closed window for a refusal", async () => {
    const expired = pcOf({ added_at: new Date(Date.now() - 15 * 60_000).toISOString() });
    await mount(props("new", expired, { kind: "failed", failure: "pc-offline", name: "desk2", detail: null, server_id: SERVER_ID }));
    expect(all()).toContain("desk2 is offline");
    expect(all()).not.toContain("Add window closed");
    await update(props("new", expired, { kind: "failed", failure: "relay-unreachable", name: "desk2", detail: null, server_id: SERVER_ID }));
    expect(all()).toContain("The relay could not be reached");
    expect(all()).not.toContain("Add window closed");
    // the relay's refusal of a new device is the account's limit, not the window: it says so, and can be tried again
    await update(props("new", expired, { kind: "failed", failure: "new-devices-refused", name: "desk2", detail: null, server_id: SERVER_ID }));
    expect(all()).toContain("desk2 cannot add new devices right now");
    expect(all()).toContain("Devices already added still connect.");
    expect(all()).not.toContain("Add window closed");
    expect(renderer!.root.findAll((instance) => instance.type === "button").map(text)).toContain("Try again");
    await update(props("new", expired, { kind: "failed", failure: "pair-declined", name: "desk2", detail: null, server_id: SERVER_ID }));
    expect(all()).toContain("Add window closed · an account member must approve");
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
    // fresh challenge arrives with challenge: 2
    await update(props("new", pc, { kind: "compare", name: "desk2", digits: "654321", confirmed: false, typed: true, challenge: 2 }));
    expect(digitField()).toHaveLength(1);
    expect(all()).toContain("changed");
  });

  it("says why a join failed without raw close-code details, offers Try again where that can help, and never repeats the problem line in the subtitle across any sheet state", async () => {
    await mount(props("new", pcOf(), { kind: "failed", failure: "pc-offline", name: "desk2", detail: "The relay closed the connection (0)", server_id: SERVER_ID }));
    expect(renderer!.root.findByProps({ role: "dialog" }).props["data-add-pc-phase"]).toBe("failed");
    expect(all()).toContain("desk2 is offline");
    expect(all()).toContain("Start Ovis on the PC");
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
    // scrim click on the backdrop also closes and cancels an active phase
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
    // the page behind is inert while the sheet is open; the commit that removes the sheet lifts it after the sheet's cleanup ran
    const Behind = ({ shown }: { shown: boolean }) => { useLayoutEffect(() => { inert = shown; }, [shown]); return null; };
    const screen = (shown: boolean) => createElement(SettingsProvider, { children: [shown && createElement(AddPcSheet, { key: "sheet", ...props("add", null, LIST) }), createElement(Behind, { key: "behind", shown })] });
    await act(async () => { renderer = create(screen(true), { createNodeMock: node }); });
    // the focus was in the sheet and leaves with it
    page.activeElement = page.body;
    await act(async () => { renderer!.update(screen(false)); });
    expect(page.activeElement).toBe(opener);
  });

  it("with no PC, says how one is added in one concise sentence and leads to the QR and code screen", async () => {
    await mount(props("add", null, LIST));
    expect(all()).toContain("Add a PC");
    expect(steps()).toEqual([]);
    expect(renderer!.root.findAll((instance) => instance.props.className === "add-pc-bars")).toHaveLength(0);
    await click("Pair with a QR or code");
    expect(calls.qr).toBe(1);
    await click("Close");
    expect(calls).toMatchObject({ closes: 1, cancels: 0 });
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
    expect(relayFailureText(id, "relay-unreachable", "desk2").copy).toBe("Check this device's connection, then try again.");
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
