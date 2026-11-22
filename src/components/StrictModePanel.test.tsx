import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { type ReactNode } from "react";
import * as ReactDom from "react-dom";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { mock, spyOn } from "bun:test";
import type { LockState } from "../lib/account/lock.ts";

// turning strict mode on asks in a confirmation, a portal into document.body: drawn in place here
await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
const { StrictModePanel, StrictModeSection, StrictUnlockAsk } = await import("./StrictModePanel.tsx");
const { AccessGate } = await import("./AccessGate.tsx");

/** what a confirmation over the row needs of the page: an element type for its focus trap, and a history for Back */
function confirmable(): void {
  class HTMLElement { isConnected = true; focus(): void {} }
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
  const view = globalThis.window as unknown as Record<string, unknown>;
  Object.assign(view, { history: { state: null, replaceState() {}, pushState() {}, back() {} }, location: { ...(view["location"] as object ?? {}), href: "http://127.0.0.1:7318/", search: "", pathname: "/", origin: "http://127.0.0.1:7318" }, innerWidth: 1440, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  const page = globalThis.document as unknown as Record<string, unknown>;
  Object.assign(page, { activeElement: null, body: { nodeType: 1, children: [] }, addEventListener() {}, removeEventListener() {} });
}

const unlocked: LockState = {
  bound: true, confirm: "available", locked: null, strict: false,
  preview: { rows: [{ id: "r1", label: "Galaxy S30", origin: { from: "remote", how: "list" }, file: "account" }, { id: "r2", label: "Old iPad", origin: null, file: "devices" }], grants: ["token", "tailscale"] },
};
const locked: LockState = { bound: true, confirm: "available", locked: "l1", strict: false };

describe("the strict-mode row", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"] } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
    confirmable();
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const mount = async (state: LockState, local = true, asked: string[] = []) => {
    await act(async () => {
      renderer = create(<SettingsProvider><StrictModePanel state={state} local={local} onTurnOn={() => asked.push("on")} onTurnOff={(id) => asked.push(`off ${id}`)} /></SettingsProvider>);
    });
    return { shown: text(renderer!.root), buttons: renderer!.root.findAll((node) => node.type === "button") };
  };
  /** the switch turned on: the confirmation it asks, before anything is asked of the PC */
  const confirmation = async (): Promise<string> => {
    await act(async () => { renderer!.root.find((node) => node.props.role === "switch").props.onClick(); });
    return text(renderer!.root.find((node) => node.props.role === "alertdialog"));
  };

  it("shows one row with its switch, and none of what it ends until it is turned on", async () => {
    const asked: string[] = [];
    const { shown, buttons } = await mount(unlocked, true, asked);
    expect(shown).toBe("Strict mode (Linux)");
    expect(buttons.map((button) => button.props.role)).toEqual(["switch"]);
    await confirmation();
    expect(asked).toEqual([]);
    await act(async () => { await renderer!.root.find((node) => node.type === "button" && text(node) === "Turn on strict mode").props.onClick(); });
    expect(asked).toEqual(["on"]);
  });

  it("T46: before it is turned on, names each device and access it will end", async () => {
    await mount(unlocked);
    const shown = await confirmation();
    expect(shown).toContain("Galaxy S30");
    expect(shown).toContain("Old iPad");
    expect(shown).toContain("Tailscale");
  });

  it("N7, T49: says what strict mode does not cover and that rolling back Ovis by hand is not stopped", async () => {
    await mount(unlocked);
    const shown = await confirmation();
    expect(shown).toContain("signed in to this computer");
    expect(shown).toContain("older Ovis");
  });

  it.each([true, false])("T47: unlocking names the standing lock (bound: %s)", async (bound) => {
    const asked: string[] = [];
    const { buttons } = await mount({ ...locked, bound }, true, asked);
    expect(buttons.map((button) => [button.props.role, button.props["aria-checked"]])).toEqual([["switch", true]]);
    await act(async () => { buttons[0]!.props.onClick(); });
    expect(asked).toEqual(["off l1"]);
  });

  it("R10: only this PC's own window gets the switch", async () => {
    expect((await mount(unlocked, false)).buttons).toEqual([]);
  });

  it("N4: while locked, says this PC is used through its desktop app or a terminal on it", async () => {
    const { shown } = await mount(locked);
    expect(shown).toContain("desktop app");
    expect(shown).toContain("terminal");
  });

  it("P11: a PC with no way to confirm on its screen offers no switch and says strict mode is Linux only for now", async () => {
    const { shown, buttons } = await mount({ ...unlocked, confirm: "unsupported" });
    expect(buttons).toEqual([]);
    expect(shown).toContain("Linux");
  });

  it("P11: a locked PC that cannot confirm on its screen offers no switch either, since it would refuse the unlock", async () => {
    const { buttons } = await mount({ ...locked, confirm: "unsupported" });
    expect(buttons).toEqual([]);
  });

  it("P12: a PC in no account offers no strict mode and says it needs an account", async () => {
    const { shown, buttons } = await mount({ bound: false, confirm: "available", locked: null, strict: false });
    expect(buttons).toEqual([]);
    expect(shown).toContain("account");
  });
});

describe("the strict-mode section in Settings", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let requests: string[];
  let answer: LockState;
  let refuse: { status: number; code: string } | null;
  let refuseRead: boolean;
  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");

  beforeEach(() => {
    requests = [];
    answer = unlocked;
    refuse = null;
    refuseRead = false;
    for (const key of ["window", "document", "navigator", "getComputedStyle", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"] } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://127.0.0.1:7318", href: "http://127.0.0.1:7318/" }, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
    confirmable();
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1:7318").pathname}`);
      if (init?.method !== "POST" && refuseRead) return Response.json({ error: { code: "locked", message: "locked" } }, { status: 403 });
      if (init?.method === "POST" && refuse !== null) return Response.json({ error: { code: refuse.code, message: refuse.code === "lock_removals_pending" ? "Repair this PC's state folder first: the devices this lock signs out are not written yet." : "refused" } }, { status: refuse.status });
      return init?.method === "POST" ? Response.json({ confirm: "c1" }, { status: 202 }) : Response.json(answer);
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
  });

  const toggle = () => renderer!.root.find((node) => node.props.role === "switch");
  /** turns strict mode on as a person does: the switch, then the confirmation's own button */
  const turnOn = async (): Promise<void> => {
    await act(async () => { toggle().props.onClick(); });
    await act(async () => { await renderer!.root.find((node) => node.type === "button" && text(node) === "Turn on strict mode").props.onClick(); });
  };

  it("G5: on a PC that does not offer it, shows nothing and asks the PC nothing", async () => {
    await act(async () => { renderer = create(<SettingsProvider><StrictModeSection offered={false} auth={{ required: false, authenticated: true, via: "local", role: "drive", own_window: true }} /></SettingsProvider>); });
    expect(renderer!.toJSON()).toBeNull();
    expect(requests).toEqual([]);
  });

  it("T46, R10, Q20: after asking, says strict mode is not on until approved on this PC's screen, by when, and how to open that page", async () => {
    await act(async () => { renderer = create(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive", own_window: true }} /></SettingsProvider>); });
    const before = text(renderer!.root);
    expect(before).not.toContain("ovis confirm");
    await turnOn();
    const shown = text(renderer!.root);
    expect(shown).toContain("Strict mode is not on yet");
    expect(shown).toContain("ovis confirm");
    expect(shown).toMatch(/\d{1,2}:\d{2}/);
  });

  it("T47: asking to turn it off says it stays on until approved on this PC's screen", async () => {
    answer = locked;
    await act(async () => { renderer = create(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive", own_window: true }} /></SettingsProvider>); });
    await act(async () => { toggle().props.onClick(); });
    expect(requests).toContain("POST /api/account/unlock");
    const shown = text(renderer!.root);
    expect(shown).toContain("Strict mode stays on");
    expect(shown).toContain("ovis confirm");
  });

  it("R10: the switch shows exactly where the server says this is the PC's own window: local and the token from loopback yes, any other window no", async () => {
    for (const [via, own] of [["local", true], ["token", true], ["token", false], ["tailscale", false], ["open", false], ["device", false], ["portal", false], ["relay", false]] as const) {
      await act(async () => { renderer = create(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via, role: "drive", ...(own ? { own_window: true } : {}) }} /></SettingsProvider>); });
      expect({ via, own, buttons: renderer!.root.findAll((node) => node.type === "button").length }).toEqual({ via, own, buttons: own ? 1 : 0 });
      await act(async () => { renderer?.unmount(); });
    }
  });

  it("one status at a time: a refused retry replaces the approve-by line", async () => {
    await act(async () => { renderer = create(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive", own_window: true }} /></SettingsProvider>); });
    await turnOn();
    expect(text(renderer!.root)).toContain("ovis confirm");
    refuse = { status: 409, code: "already_locked" };
    await turnOn();
    const shown = text(renderer!.root);
    expect(shown).toContain("Strict mode changed already.");
    expect(shown).not.toContain("ovis confirm");
  });

  it("T47: the locked view's approve-by line goes when the PC's window for it has passed", async () => {
    jest.useFakeTimers();
    try {
      answer = locked;
      await act(async () => { renderer = create(<SettingsProvider><StrictUnlockAsk /></SettingsProvider>); });
      await act(async () => { renderer!.root.find((node) => node.type === "button").props.onClick(); });
      expect(text(renderer!.root)).toContain("ovis confirm");
      await act(async () => { jest.advanceTimersByTime(120_000); });
      expect(text(renderer!.root)).not.toContain("ovis confirm");
    } finally { jest.useRealTimers(); }
  });

  it("T47: an unlock refused while this PC's lock removals are unwritten says so, with the PC's own repair message", async () => {
    answer = locked;
    refuse = { status: 409, code: "lock_removals_pending" };
    await act(async () => { renderer = create(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive", own_window: true }} /></SettingsProvider>); });
    await act(async () => { toggle().props.onClick(); });
    const shown = text(renderer!.root);
    expect(shown).toContain("Strict mode stays on until this PC finishes signing out the devices it ended. Try again shortly.");
    expect(shown).toContain("Repair this PC's state folder first");
  });

  it("R10: a request the PC refuses says why, here local_required", async () => {
    refuse = { status: 403, code: "local_required" };
    await act(async () => { renderer = create(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive", own_window: true }} /></SettingsProvider>); });
    await turnOn();
    const shown = text(renderer!.root);
    expect(shown).toContain("Turn strict mode on or off in a browser on this PC itself.");
    expect(shown).not.toContain("ovis confirm");
  });

  it("Q20: the approve-by time is taken before the request goes out, so a slow answer never shows a later time than the PC's", async () => {
    let now = Date.parse("2026-11-21T03:00:00.000Z");
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const reply = Promise.withResolvers<Response>();
    const slow = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1:7318").pathname}`);
      return init?.method === "POST" ? reply.promise : Response.json(answer);
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(slow, { preconnect: globalThis.fetch.preconnect }));
    try {
      const sent = now;
      await act(async () => { renderer = create(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive", own_window: true }} /></SettingsProvider>); });
      await turnOn();
      now += 90_000;
      await act(async () => { reply.resolve(Response.json({ confirm: "c1" }, { status: 202 })); });
      const by = (at: number) => new Date(at).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
      const shown = text(renderer!.root);
      expect(shown).toContain(by(sent + 120_000));
      expect(shown).not.toContain(by(sent + 210_000));
    } finally { clock.mockRestore(); }
  });

  it("T47, N4: a locked PC's own window, which the server lets read the lock, may only ask to turn strict mode off", async () => {
    answer = locked;
    await act(async () => { renderer = create(<SettingsProvider><StrictUnlockAsk /></SettingsProvider>); });
    const buttons = renderer!.root.findAll((node) => node.type === "button");
    expect(buttons.map((button) => text(button))).toEqual(["Ask to turn strict mode off"]);
    await act(async () => { buttons[0]!.props.onClick(); });
    expect(requests).toContain("POST /api/account/unlock");
    expect(text(renderer!.root)).toContain("Strict mode stays on until you approve turning it off");
  });

  it("T47, R10: a window the server does not let read the lock (relay, LAN, a forwarded page) sees no unlock request", async () => {
    refuseRead = true;
    await act(async () => { renderer = create(<SettingsProvider><StrictUnlockAsk /></SettingsProvider>); });
    expect(renderer!.toJSON()).toBeNull();
  });

  it("T47, N4: a locked PC's own window gets the strict view instead of the pairing gate; any other window gets nothing", async () => {
    answer = locked;
    await act(async () => {
      renderer = create(<SettingsProvider><AccessGate reason="locked" ownWindow initialCode="" consumePairCode={() => ""} pairingUnconfirmed={false} onUnlocked={() => {}} /></SettingsProvider>);
    });
    expect(renderer!.root.findAll((node) => node.type === "button").map((node) => text(node))).toEqual(["Ask to turn strict mode off"]);
    expect(renderer!.root.findAll((node) => node.type === "input")).toHaveLength(0);
    await act(async () => { renderer?.unmount(); });
    await act(async () => {
      renderer = create(<SettingsProvider><AccessGate reason="locked" ownWindow={false} initialCode="" consumePairCode={() => ""} pairingUnconfirmed={false} onUnlocked={() => {}} /></SettingsProvider>);
    });
    expect(text(renderer!.root)).toBe("This PC is in strict mode.");
  });

  it("T47, N4: a window that is not this PC's own sees one static line on a locked PC: no form, no button, no request", async () => {
    await act(async () => {
      renderer = create(<SettingsProvider><AccessGate reason="locked" ownWindow={false} initialCode="123456" consumePairCode={() => "123456"} pairingUnconfirmed={false} onUnlocked={() => {}} /></SettingsProvider>);
    });
    expect(text(renderer!.root)).toContain("This PC is in strict mode.");
    expect(renderer!.root.findAll((node) => node.type === "button" || node.type === "input" || node.type === "form")).toHaveLength(0);
    expect(requests).toEqual([]);
  });

  it("T47, N4: a locked PC's own window opened from a pairing QR sends no pairing request", async () => {
    answer = locked;
    let claimed = 0;
    await act(async () => {
      renderer = create(<SettingsProvider><AccessGate reason="locked" ownWindow initialCode="123456" consumePairCode={() => { claimed++; return "123456"; }} pairingUnconfirmed={false} onUnlocked={() => {}} /></SettingsProvider>);
    });
    expect(requests.filter((request) => request.includes("/api/devices/pair"))).toEqual([]);
    expect(claimed).toBe(0);
  });

  it("T47: the locked view reads the lock again when the window comes back", async () => {
    answer = locked;
    await act(async () => { renderer = create(<SettingsProvider><StrictUnlockAsk /></SettingsProvider>); });
    expect(renderer!.root.findAll((node) => node.type === "button")).toHaveLength(1);
    answer = unlocked;
    const reads = requests.length;
    await act(async () => { (globalThis.window as unknown as EventTarget).dispatchEvent(new Event("focus")); });
    expect(requests.length).toBe(reads + 1);
    expect(renderer!.toJSON()).toBeNull();
  });

  it("a refusal stays when the lock state is read again after it", async () => {
    refuse = { status: 409, code: "already_locked" };
    await act(async () => { renderer = create(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive", own_window: true }} /></SettingsProvider>); });
    answer = locked;
    await turnOn();
    expect(text(renderer!.root)).toContain("Strict mode changed already.");
  });

  it("T46, R10: reads the PC's state, and the switch only asks the PC's screen", async () => {
    await act(async () => { renderer = create(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive", own_window: true }} /></SettingsProvider>); });
    await turnOn();
    expect(requests).toEqual(["GET /api/account/lock", "POST /api/account/lock", "GET /api/account/lock"]);
  });
});
