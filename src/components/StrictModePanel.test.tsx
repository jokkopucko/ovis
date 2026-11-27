import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { SettingsProvider } from "../lib/settings.ts";
import { mock, spyOn } from "bun:test";
import type { LockState } from "../lib/account/lock.ts";

import { StrictModePanel, StrictModeSection, StrictUnlockAsk } from "./StrictModePanel.tsx";
import { AccessGate } from "./AccessGate.tsx";

let page: Page;
let savedElement: PropertyDescriptor | undefined;

beforeEach(() => {
  page = openPage("http://127.0.0.1:7318/");
  page.window.innerWidth = 1440;
  Object.defineProperty(page.window, "setTimeout", { configurable: true, value: (...args: Parameters<typeof setTimeout>) => setTimeout(...args) });
  Object.defineProperty(page.window, "clearTimeout", { configurable: true, value: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args) });
  savedElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: page.window.HTMLElement });
});

afterEach(async () => {
  jest.useRealTimers();
  await page.close();
  mock.restore();
  if (savedElement) Object.defineProperty(globalThis, "HTMLElement", savedElement);
  else Reflect.deleteProperty(globalThis, "HTMLElement");
});

const body = () => document.body;
const text = (node: Element): string => node.textContent ?? "";
const confirmationDialog = () => {
  const found = body().querySelectorAll('[role="alertdialog"]');
  if (found.length !== 1) throw new Error(`Expected one confirmation, found ${found.length}`);
  return found[0]!;
};
const confirmButton = () => {
  const found = [...confirmationDialog().querySelectorAll<HTMLButtonElement>("button")].filter((node) => text(node) === "Turn on strict mode");
  if (found.length !== 1) throw new Error(`Expected one confirmation button, found ${found.length}`);
  return found[0]!;
};

const unlocked: LockState = {
  bound: true, confirm: "available", locked: null, strict: false,
  preview: { rows: [{ id: "r1", label: "Galaxy S30", origin: { from: "remote", how: "list" }, file: "account" }, { id: "r2", label: "Old iPad", origin: null, file: "devices" }], grants: ["token", "tailscale"] },
};
const locked: LockState = { bound: true, confirm: "available", locked: "l1", strict: false };

describe("the strict-mode row", () => {
  const mount = async (state: LockState, local = true, asked: string[] = []) => {
    await page.render(<SettingsProvider><StrictModePanel state={state} local={local} onTurnOn={() => asked.push("on")} onTurnOff={(id) => asked.push(`off ${id}`)} /></SettingsProvider>);
    return { shown: text(body()), buttons: [...body().querySelectorAll<HTMLButtonElement>("button")] };
  };
  /** the switch turned on: the confirmation it asks, before anything is asked of the PC */
  const confirmation = async (): Promise<string> => {
    await act(async () => { page.one<HTMLButtonElement>('[role="switch"]').click(); });
    return text(confirmationDialog());
  };

  it("shows one row with its switch, and none of what it ends until it is turned on", async () => {
    const asked: string[] = [];
    const { shown, buttons } = await mount(unlocked, true, asked);
    expect(shown).toBe("Strict mode (Linux)");
    expect(buttons.map((button) => button.getAttribute("role"))).toEqual(["switch"]);
    await confirmation();
    expect(asked).toEqual([]);
    await act(async () => { confirmButton().click(); });
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
    expect(buttons.map((button) => [button.getAttribute("role"), button.getAttribute("aria-checked")])).toEqual([["switch", "true"]]);
    await act(async () => { buttons[0]!.click(); });
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
  let requests: string[];
  let answer: LockState;
  let refuse: { status: number; code: string } | null;
  let refuseRead: boolean;

  beforeEach(() => {
    requests = [];
    answer = unlocked;
    refuse = null;
    refuseRead = false;
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1:7318").pathname}`);
      if (init?.method !== "POST" && refuseRead) return Response.json({ error: { code: "locked", message: "locked" } }, { status: 403 });
      if (init?.method === "POST" && refuse !== null) return Response.json({ error: { code: refuse.code, message: refuse.code === "lock_removals_pending" ? "Repair this PC's state folder first: the devices this lock signs out are not written yet." : "refused" } }, { status: refuse.status });
      return init?.method === "POST" ? Response.json({ confirm: "c1" }, { status: 202 }) : Response.json(answer);
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
  });

  const toggle = () => page.one<HTMLButtonElement>('[role="switch"]');
  /** turns strict mode on as a person does: the switch, then the confirmation's own button */
  const turnOn = async (): Promise<void> => {
    await act(async () => { toggle().click(); });
    await act(async () => { confirmButton().click(); });
  };

  it("G5: on a PC that does not offer it, shows nothing and asks the PC nothing", async () => {
    const section = (offered: boolean) => <SettingsProvider><StrictModeSection offered={offered} auth={{ required: false, authenticated: true, via: "local", role: "drive", own_window: true }} /></SettingsProvider>;
    await page.render(section(false));
    expect(page.container.childNodes).toHaveLength(0);
    expect([...body().childNodes].map((node) => node === page.container ? "mount" : node.nodeName)).toEqual(["mount"]);
    expect(requests).toEqual([]);

    await page.render(section(true));
    await act(async () => { toggle().click(); });
    expect(text(confirmationDialog())).toContain("Turn on strict mode?");
    await page.render(section(false));
    expect(page.container.childNodes).toHaveLength(0);
    expect([...body().childNodes].map((node) => node === page.container ? "mount" : node.nodeName)).toEqual(["mount"]);
    expect(requests).toEqual(["GET /api/account/lock"]);
  });

  it("T46, R10, Q20: after asking, says strict mode is not on until approved on this PC's screen, by when, and how to open that page", async () => {
    await page.render(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive", own_window: true }} /></SettingsProvider>);
    const before = text(body());
    expect(before).not.toContain("ovis confirm");
    await turnOn();
    const shown = text(body());
    expect(shown).toContain("Strict mode is not on yet");
    expect(shown).toContain("ovis confirm");
    expect(shown).toMatch(/\d{1,2}:\d{2}/);
  });

  it("T47: asking to turn it off says it stays on until approved on this PC's screen", async () => {
    answer = locked;
    await page.render(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive", own_window: true }} /></SettingsProvider>);
    await act(async () => { toggle().click(); });
    expect(requests).toContain("POST /api/account/unlock");
    const shown = text(body());
    expect(shown).toContain("Strict mode stays on");
    expect(shown).toContain("ovis confirm");
  });

  it("R10: the switch shows exactly where the server says this is the PC's own window: local and the token from loopback yes, any other window no", async () => {
    for (const [via, own] of [["local", true], ["token", true], ["token", false], ["tailscale", false], ["open", false], ["device", false], ["portal", false], ["relay", false]] as const) {
      await page.render(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via, role: "drive", ...(own ? { own_window: true } : {}) }} /></SettingsProvider>);
      expect({ via, own, buttons: [...body().querySelectorAll<HTMLButtonElement>("button")].length }).toEqual({ via, own, buttons: own ? 1 : 0 });
      await page.render(null);
    }
  });

  it("one status at a time: a refused retry replaces the approve-by line", async () => {
    await page.render(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive", own_window: true }} /></SettingsProvider>);
    await turnOn();
    expect(text(body())).toContain("ovis confirm");
    refuse = { status: 409, code: "already_locked" };
    await turnOn();
    const shown = text(body());
    expect(shown).toContain("Strict mode changed already.");
    expect(shown).not.toContain("ovis confirm");
  });

  it("T47: the locked view's approve-by line goes when the PC's window for it has passed", async () => {
    jest.useFakeTimers();
    try {
      answer = locked;
      await page.render(<SettingsProvider><StrictUnlockAsk /></SettingsProvider>);
      await act(async () => { page.one<HTMLButtonElement>("button").click(); });
      expect(text(body())).toContain("ovis confirm");
      await act(async () => { jest.advanceTimersByTime(120_000); });
      expect(text(body())).not.toContain("ovis confirm");
    } finally { jest.useRealTimers(); }
  });

  it("T47: an unlock refused while this PC's lock removals are unwritten says so, with the PC's own repair message", async () => {
    answer = locked;
    refuse = { status: 409, code: "lock_removals_pending" };
    await page.render(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive", own_window: true }} /></SettingsProvider>);
    await act(async () => { toggle().click(); });
    const shown = text(body());
    expect(shown).toContain("Strict mode stays on until this PC finishes signing out the devices it ended. Try again shortly.");
    expect(shown).toContain("Repair this PC's state folder first");
  });

  it("R10: a request the PC refuses says why, here local_required", async () => {
    refuse = { status: 403, code: "local_required" };
    await page.render(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive", own_window: true }} /></SettingsProvider>);
    await turnOn();
    const shown = text(body());
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
      await page.render(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive", own_window: true }} /></SettingsProvider>);
      await turnOn();
      now += 90_000;
      await act(async () => { reply.resolve(Response.json({ confirm: "c1" }, { status: 202 })); });
      const by = (at: number) => new Date(at).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
      const shown = text(body());
      expect(shown).toContain(by(sent + 120_000));
      expect(shown).not.toContain(by(sent + 210_000));
    } finally { clock.mockRestore(); }
  });

  it("T47, N4: a locked PC's own window, which the server lets read the lock, may only ask to turn strict mode off", async () => {
    answer = locked;
    await page.render(<SettingsProvider><StrictUnlockAsk /></SettingsProvider>);
    const buttons = [...body().querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((button) => text(button))).toEqual(["Ask to turn strict mode off"]);
    await act(async () => { buttons[0]!.click(); });
    expect(requests).toContain("POST /api/account/unlock");
    expect(text(body())).toContain("Strict mode stays on until you approve turning it off");
  });

  it("T47, R10: a window the server does not let read the lock (relay, LAN, a forwarded page) sees no unlock request", async () => {
    refuseRead = true;
    await page.render(<SettingsProvider><StrictUnlockAsk /></SettingsProvider>);
    expect(page.container.childNodes).toHaveLength(0);
  });

  it("T47, N4: a locked PC's own window gets the strict view instead of the pairing gate; any other window gets nothing", async () => {
    answer = locked;
    await page.render(<SettingsProvider><AccessGate reason="locked" ownWindow initialCode="" consumePairCode={() => ""} pairingUnconfirmed={false} onUnlocked={() => {}} /></SettingsProvider>);
    expect([...body().querySelectorAll<HTMLButtonElement>("button")].map((node) => text(node))).toEqual(["Ask to turn strict mode off"]);
    expect(body().querySelectorAll("input")).toHaveLength(0);
    await page.render(null);
    await page.render(<SettingsProvider><AccessGate reason="locked" ownWindow={false} initialCode="" consumePairCode={() => ""} pairingUnconfirmed={false} onUnlocked={() => {}} /></SettingsProvider>);
    expect(text(body())).toBe("This PC is in strict mode.");
  });

  it("T47, N4: a window that is not this PC's own sees one static line on a locked PC: no form, no button, no request", async () => {
    await page.render(<SettingsProvider><AccessGate reason="locked" ownWindow={false} initialCode="123456" consumePairCode={() => "123456"} pairingUnconfirmed={false} onUnlocked={() => {}} /></SettingsProvider>);
    expect(text(body())).toContain("This PC is in strict mode.");
    expect(body().querySelectorAll("button, input, form")).toHaveLength(0);
    expect(requests).toEqual([]);
  });

  it("T47, N4: a locked PC's own window opened from a pairing QR sends no pairing request", async () => {
    answer = locked;
    let claimed = 0;
    await page.render(<SettingsProvider><AccessGate reason="locked" ownWindow initialCode="123456" consumePairCode={() => { claimed++; return "123456"; }} pairingUnconfirmed={false} onUnlocked={() => {}} /></SettingsProvider>);
    expect(requests.filter((request) => request.includes("/api/devices/pair"))).toEqual([]);
    expect(claimed).toBe(0);
  });

  it("T47: the locked view reads the lock again when the window comes back", async () => {
    answer = locked;
    await page.render(<SettingsProvider><StrictUnlockAsk /></SettingsProvider>);
    expect([...body().querySelectorAll<HTMLButtonElement>("button")]).toHaveLength(1);
    answer = unlocked;
    const reads = requests.length;
    await act(async () => { page.window.dispatchEvent(new page.window.Event("focus")); });
    expect(requests.length).toBe(reads + 1);
    expect(page.container.childNodes).toHaveLength(0);
  });

  it("a refusal stays when the lock state is read again after it", async () => {
    refuse = { status: 409, code: "already_locked" };
    await page.render(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive", own_window: true }} /></SettingsProvider>);
    answer = locked;
    await turnOn();
    expect(text(body())).toContain("Strict mode changed already.");
  });

  it("T46, R10: reads the PC's state, and the switch only asks the PC's screen", async () => {
    await page.render(<SettingsProvider><StrictModeSection offered auth={{ required: false, authenticated: true, via: "local", role: "drive", own_window: true }} /></SettingsProvider>);
    await turnOn();
    expect(requests).toEqual(["GET /api/account/lock", "POST /api/account/lock", "GET /api/account/lock"]);
  });
});
