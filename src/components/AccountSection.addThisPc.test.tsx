import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { exportPublicKey, generateKeyPair, importPublicKey } from "../../shared/relay-e2ee.ts";
import { decodeOffer, encodeOffer } from "../../shared/relay-offer.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { CLOSE_ANSWER_MS } from "../lib/account/addThisPc.ts";
import { SignedOutError, type AccountService } from "../lib/account/service.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";
import { ADDED_POLL_MS, ADDING_MS, AddThisPc, ANSWER_MS, REOPEN_MS, SIGNED_IN_RETRY_MS, WAITING_MS } from "./AccountSection.tsx";

const at = Date.parse("2026-11-10T03:00:00Z");
const MARKER = "ovis-add-pc-waiting";
const ACCOUNT = "acct_0123456789abcdef";
const keys = generateKeyPair();
const publicKey = exportPublicKey(keys.publicKey);
const SERVER = deriveServerId(importPublicKey(publicKey));
const offerOf = (key: string, name: string): string => encodeOffer({ v: 1, server_id: deriveServerId(importPublicKey(key)), server_public_key: key, relay: "wss://relay.ovis.sh", name }, "https://app.ovis.sh");
const otherKey = exportPublicKey(generateKeyPair().publicKey);
const OTHER_SERVER = deriveServerId(importPublicKey(otherKey));
const RELIST_MS = 9 * 60_000;
/** a wait as its tab keeps it: pressed `ago` before now on this PC under this account, last listed `listed` before now */
const kept = (ago: number, listed = ago, over: Record<string, unknown> = {}): string => JSON.stringify({ name: "desk", until: at - ago + WAITING_MS, serverId: SERVER, account: ACCOUNT, listedAt: at - listed, ...over });

describe("AddThisPc", () => {
  const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator", "location"];
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let renderers: ReactTestRenderer[];
  /**
   * what the PC answers: its account, whether it still waits for its first member's enrollment, how the link route
   * fails (null: it gives a link), and the route whose next request never gets an answer (null: every one is answered);
   * its relay (`relay`, what may block it, what a start comes to), whether it has the close route, its device gate,
   * how this browser is in (`via`: one in only through the open device gate is refused the PC's account, as
   * server/dispatch.ts refuses it), whether it is paired and its pairing cookie sticks, and whether its health answers
   */
  let pc: {
    account: string | null; enrolling: boolean; linkError: { status: number; code: string } | null; statusDown: boolean; offer: string; hang: string | null;
    relay: "on" | "off"; blocked: "serve_only" | null; start: "ok" | "off" | "broken"; closeMissing: boolean;
    gate: "open" | "closed"; via: "open" | "loopback" | "device"; paired: boolean; cookieSticks: boolean; healthDown: boolean;
    /** what this browser may do on the PC */
    role: "drive" | "watch";
    /** the relay ID its health tells: its own (the one of its offer), one given here, or none (null: an Ovis that does not tell it) */
    healthId?: string | null;
  };
  /** the account this tab is signed in to; null when signed out */
  let signedIn: string | null;
  /** every request to the PC: its path, and whether it asked for an approve-here window */
  let asked: { path: string; localOnly: boolean }[];
  /** the account directory's writes */
  let directory: string[];
  let page: { hidden: boolean; events: EventTarget };
  let tab: Map<string, string>;
  let restore: (() => void)[];
  /** every PC put in a directory, as `<account>/<server id>` */
  let puts: string[];
  /** what the next reads of the directory and of the stored sign-in, the next write of the PC (after it was sent), the next link, the next relay start and the next close of the window wait for (null: nothing) */
  let held: { listPcs: Promise<void> | null; putPc: Promise<void> | null; session: Promise<void> | null; link: Promise<void> | null; start: Promise<void> | null; close: Promise<void> | null };
  /** the account service; `bound` is the account of the one sign-in it acts for (forSignIn), which refuses once another is stored */
  const service = (bound?: string): AccountService => {
    const mine = (): void => { if (bound !== undefined && signedIn !== bound) throw new SignedOutError(); };
    return {
      listPcs: async () => { mine(); await held.listPcs; return []; },
      putPc: async (id: string) => { mine(); directory.push("putPc"); puts.push(`${signedIn}/${id}`); await held.putPc; },
      deletePc: async () => { mine(); directory.push("deletePc"); },
      session: async () => { await held.session; return signedIn === null ? undefined : { account: signedIn }; },
      forSignIn: (session: { account: string }) => service(session.account),
    } as unknown as AccountService;
  };
  /** holds what is read through `held` until the function returned is called */
  const hold = (what: "listPcs" | "putPc" | "session" | "link" | "start" | "close"): (() => void) => {
    let release!: () => void;
    held[what] = new Promise<void>((done) => { release = done; });
    return () => { held[what] = null; release(); };
  };

  beforeEach(() => {
    renderers = [];
    pc = { account: null, enrolling: false, linkError: null, statusDown: false, offer: offerOf(publicKey, "desk"), hang: null, relay: "on", blocked: null, start: "ok", closeMissing: false, gate: "closed", via: "loopback", paired: false, cookieSticks: true, healthDown: false, role: "drive" };
    signedIn = ACCOUNT;
    asked = [];
    directory = [];
    puts = [];
    held = { listPcs: null, putPc: null, session: null, link: null, start: null, close: null };
    tab = new Map();
    page = { hidden: false, events: new EventTarget() };
    for (const name of globals) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const style = { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => "", backgroundColor: "" };
    const listen = { addEventListener: () => {}, removeEventListener: () => {} };
    const storage = { getItem: (key: string) => tab.get(key) ?? null, setItem: (key: string, value: string) => { tab.set(key, value); }, removeItem: (key: string) => { tab.delete(key); } };
    const values: Record<string, unknown> = {
      IS_REACT_ACT_ENVIRONMENT: true,
      window: { ...listen, sessionStorage: storage, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 } },
      document: {
        documentElement: { lang: "", dataset: {}, style }, querySelector: () => null,
        get hidden() { return page.hidden; },
        addEventListener: page.events.addEventListener.bind(page.events), removeEventListener: page.events.removeEventListener.bind(page.events),
      },
      getComputedStyle: () => style,
      navigator: { languages: ["en"], userAgent: "Mozilla/5.0", maxTouchPoints: 0 },
      location: { pathname: "/", origin: "http://localhost" },
    };
    for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
    const answer = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(String(input instanceof Request ? input.url : input), "http://localhost").pathname;
      asked.push({ path, localOnly: new Headers(init?.headers).get("x-ovis-local-only") === "1" });
      if (pc.hang === path) { pc.hang = null; return new Promise<Response>(() => {}); }
      if (path === "/api/account/status" && pc.via === "open") return Response.json({ error: { code: "owner_only", message: "Manage the account from this PC itself, or from a paired device." } }, { status: 403 });
      if (path === "/api/relay/link") await held.link;
      if (path === "/api/relay/start") await held.start;
      if (path === "/api/relay/link/close") await held.close;
      if (path === "/api/account/status" && pc.statusDown) return Response.json({ error: { code: "internal", message: "restarting" } }, { status: 503 });
      if (path === "/api/account/status") return Response.json({ account: pc.account, unlinked: [], removals: [], adds: [], blocked: [], enrolling: pc.enrolling });
      if (path === "/api/relay/start" && pc.start === "broken") return Response.json({ error: { code: "internal", message: "broken" } }, { status: 500 });
      if (path === "/api/relay/start" && pc.start === "off") return Response.json({ phase: "off", relay: "wss://relay.ovis.sh", app: "https://app.ovis.sh", sessions: 0, blocked: null, error: null });
      if (path === "/api/relay/start") {
        if (pc.blocked === null) pc.relay = "on";
        return Response.json({ phase: pc.relay === "on" ? "connecting" : "off", relay: "wss://relay.ovis.sh", app: "https://app.ovis.sh", sessions: 0, blocked: pc.blocked, error: null }, { status: pc.blocked === null ? 200 : 409 });
      }
      if (path === "/api/relay/link/close" && !pc.closeMissing) return Response.json({ ok: true });
      if (path === "/api/health" && pc.healthDown) return Response.json({ error: { code: "internal", message: "restarting" } }, { status: 503 });
      if (path === "/api/health") {
        const id = pc.healthId === undefined ? decodeOffer(pc.offer)!.server_id : pc.healthId;
        return Response.json({ security: { pairing_gate: pc.gate, token_configured: false }, auth: { required: false, authenticated: true, via: pc.via, role: pc.role }, web_ui: { boot_id: "boot", revision: null, ...(id === null ? {} : { server_id: id }) } });
      }
      if (path === "/api/relay") return Response.json({ phase: pc.relay === "on" ? "online" : "off", relay: "wss://relay.ovis.sh", app: "https://app.ovis.sh", sessions: 0, blocked: null, error: null });
      if (path === "/api/devices") return Response.json({ devices: pc.paired ? [{ id: "dev_1", label: "this browser", current: true }] : [] });
      if (path === "/api/devices/pair/start") return Response.json({ code: "123456", expires_at: at + 60_000 });
      if (path === "/api/devices/pair") { pc.paired = pc.cookieSticks; if (pc.paired) pc.via = "device"; return Response.json({ ok: true }); }
      if (path === "/api/relay/link" && pc.relay === "off") return Response.json({ error: { code: "relay_off", message: "Start the relay before pairing." } }, { status: 409 });
      if (path === "/api/relay/link") return pc.linkError === null ? Response.json({ url: pc.offer }) : Response.json({ error: { code: pc.linkError.code, message: "refused" } }, { status: pc.linkError.status });
      return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
    };
    setTransport({ ...nativeTransport, fetch: answer });
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(answer as typeof fetch);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    restore = [() => fetchSpy.mockRestore(), () => warn.mockRestore()];
    jest.useFakeTimers();
    jest.setSystemTime(new Date(at));
  });
  afterEach(() => {
    act(() => { for (const renderer of renderers) renderer.unmount(); });
    jest.useRealTimers();
    setTransport(nativeTransport);
    for (const undo of restore) undo();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    saved.clear();
  });

  const unbound = (): AccountService => service();
  /** lets the answers on their way arrive and the screen draw them */
  const settle = async (): Promise<void> => { await act(async () => { for (let turn = 0; turn < 200; turn++) await Promise.resolve(); }); };
  const advance = async (ms: number): Promise<void> => { act(() => { jest.advanceTimersByTime(ms); }); await settle(); };
  /**
   * `signedInAs`: the account of a sign-in that just finished on the screen, as AccountSection hands it over once;
   * `adds`: whether the button that began it said it adds this PC
   */
  const mount = async (signedInAs: string | null = null, adds = true): Promise<ReactTestRenderer> => {
    let renderer!: ReactTestRenderer;
    let fresh = signedInAs === null ? null : { account: signedInAs, adds };
    const signedInHere = (): { account: string; adds: boolean } | null => { const taken = fresh; fresh = null; return taken; };
    act(() => { renderer = create(createElement(SettingsProvider, { children: createElement(AddThisPc, { service: unbound, signedInHere }) })); });
    renderers.push(renderer);
    await settle();
    return renderer;
  };
  const words = (renderer: ReactTestRenderer): string => {
    const text = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(text).join("");
    return renderer.root.findAll((node) => node.type === "p").map(text).join("\n");
  };
  const press = async (renderer: ReactTestRenderer, label: string): Promise<void> => {
    const button = renderer.root.find((node) => node.type === "button" && node.children.join("") === label);
    act(() => { (button.props as { onClick: () => void }).onClick(); });
    await settle();
  };
  const buttons = (renderer: ReactTestRenderer): string[] => renderer.root.findAll((node) => node.type === "button").map((node) => node.children.join(""));
  const links = (): number => asked.filter((request) => request.path === "/api/relay/link").length;
  const show = (hidden: boolean): void => { page.hidden = hidden; act(() => { page.events.dispatchEvent(new Event("visibilitychange")); }); };
  const waitingFrom = async (): Promise<ReactTestRenderer> => {
    const renderer = await mount();
    await press(renderer, "Add this PC to my account");
    return renderer;
  };

  test("after the press it says what to do on any signed-in device, and keeps the wait for a reload", async () => {
    const renderer = await waitingFrom();
    expect(words(renderer)).toContain("On a device already signed in to this account (the Ovis app or app.ovis.sh), choose Add on desk. This screen then shows a six-digit number: type it there, then press Approve here. Keep this page open.");
    expect(words(renderer)).toContain("Waiting. The window reopens by itself if Ovis restarts.");
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    expect(directory).toEqual(["putPc"]);
    expect(JSON.parse(tab.get(MARKER)!)).toEqual({ name: "desk", until: at + WAITING_MS, serverId: SERVER, account: ACCOUNT, listedAt: at });
  });

  test("tells its owner once when the press listed the PC, so the account's list is read again", async () => {
    let renderer!: ReactTestRenderer;
    const told: string[][] = [];
    // what the directory held each time the owner was told: the PC is in it by then
    const onListed = (): void => { told.push([...directory]); };
    act(() => { renderer = create(createElement(SettingsProvider, { children: createElement(AddThisPc, { service: unbound, signedInHere: () => null, onListed }) })); });
    renderers.push(renderer);
    await settle();
    // the offer alone lists nothing
    expect(told).toEqual([]);
    await press(renderer, "Add this PC to my account");
    expect(told).toEqual([["putPc"]]);
    // the window reopening is no new listing
    await advance(REOPEN_MS);
    expect(told).toHaveLength(1);
  });

  test("opens the window again every 30 seconds, approve-here only, with no directory write", async () => {
    await waitingFrom();
    expect(links()).toBe(1);
    await advance(REOPEN_MS - 1);
    expect(links()).toBe(1);
    await advance(1);
    expect(links()).toBe(2);
    // one at a time, as a clock passes them: an answer still on its way holds the next reopen back
    for (let tick = 0; tick < 3; tick++) await advance(REOPEN_MS);
    expect(links()).toBe(5);
    expect(asked.filter((request) => request.path === "/api/relay/link").every((request) => request.localOnly)).toBe(true);
    // the press listed the PC once; no reopening wrote to the directory or asked any other route
    expect(directory).toEqual(["putPc"]);
    // (the press also told the PC which account it asks its relay pass under, once)
    // (and the screen read once, before its offer, what this browser may do on the PC, then before every reopen which PC answers)
    expect(new Set(asked.map((request) => request.path))).toEqual(new Set(["/api/account/status", "/api/health", "/api/relay/link", "/api/account/relay-account"]));
    expect(asked.filter((request) => request.path === "/api/health").length).toBe(5);
    expect(asked.filter((request) => request.path === "/api/account/relay-account").length).toBe(1);
  });

  test("goes on reopening after a refused attempt, as while Ovis restarts", async () => {
    const renderer = await waitingFrom();
    pc.linkError = { status: 503, code: "internal" };
    await advance(REOPEN_MS);
    pc.linkError = null;
    await advance(REOPEN_MS);
    expect(links()).toBe(3);
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
  });

  test("reopens nothing while the page is hidden, and at once when it shows again", async () => {
    await waitingFrom();
    show(true);
    await settle();
    for (let tick = 0; tick < 4; tick++) await advance(REOPEN_MS);
    expect(links()).toBe(1);
    show(false);
    await settle();
    expect(links()).toBe(2);
  });

  test("says by itself that the PC is in the account once a device added it, and then asks nothing more", async () => {
    const renderer = await waitingFrom();
    await advance(ADDED_POLL_MS);
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    pc.account = ACCOUNT;
    await advance(ADDED_POLL_MS);
    expect(words(renderer)).toContain("This PC is in your account. Your other devices can open it now.");
    expect(words(renderer)).toContain("Account acct_0123456…");
    expect(words(renderer)).not.toContain(ACCOUNT);
    expect(buttons(renderer)).toEqual([]);
    expect(tab.has(MARKER)).toBe(false);
    const before = asked.length;
    await advance(WAITING_MS);
    expect(asked.length).toBe(before);
    expect(jest.getTimerCount()).toBe(0);
    expect(words(renderer)).toContain("This PC is in your account.");
  });

  test("a reloaded tab that was waiting goes on waiting and opens the window, without a press or a directory write", async () => {
    tab.set(MARKER, kept(20 * 60_000, 60_000));
    const renderer = await mount();
    expect(words(renderer)).toContain("choose Add on desk.");
    expect(links()).toBe(1);
    expect(asked.filter((request) => request.path === "/api/relay/link")[0]!.localOnly).toBe(true);
    expect(directory).toEqual([]);
    // the reload starts no new thirty minutes: the wait ends when the press's would have
    await advance(10 * 60_000);
    expect(words(renderer)).toContain("This PC stopped waiting after 30 minutes.");
  });

  test("a reloaded tab whose wait ran out, or whose marker is not one, offers the button and opens nothing", async () => {
    for (const stale of [kept(WAITING_MS + 1), kept(-60_000), "{", JSON.stringify({ name: 3, until: "soon" }), JSON.stringify({ name: "desk", until: at + 10 * 60_000 })]) {
      tab.set(MARKER, stale);
      const renderer = await mount();
      expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
      expect(tab.has(MARKER)).toBe(false);
    }
    expect(links()).toBe(0);
  });

  test("a reloaded tab finds the PC added meanwhile and says so", async () => {
    tab.set(MARKER, kept(20 * 60_000));
    pc.account = ACCOUNT;
    const renderer = await mount();
    expect(words(renderer)).toContain("This PC is in your account. Your other devices can open it now.");
    expect(tab.has(MARKER)).toBe(false);
    expect(links()).toBe(0);
  });

  test("a wait kept under another account, or with no sign-in now, is not taken up: the offer, and nothing opened or listed", async () => {
    for (const now of ["acct_someone_else", null]) {
      signedIn = now;
      tab.set(MARKER, kept(60_000));
      const renderer = await mount();
      expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
      expect(tab.has(MARKER)).toBe(false);
      await advance(RELIST_MS + REOPEN_MS);
    }
    expect(links()).toBe(0);
    expect(directory).toEqual([]);
  });

  test("a wait kept for another PC of the hosted app is not taken up on this one's page", async () => {
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { pathname: `/s/${OTHER_SERVER}/`, origin: "http://localhost" } });
    tab.set(MARKER, kept(60_000));
    const renderer = await mount();
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(tab.has(MARKER)).toBe(false);
    await advance(RELIST_MS + REOPEN_MS);
    expect(links()).toBe(0);
    expect(directory).toEqual([]);

    // nor does that wait make this PC, already in an account, say it was just added
    tab.set(MARKER, kept(60_000));
    pc.account = ACCOUNT;
    expect((await mount()).toJSON()).toBeNull();
  });

  test("a wait kept for this PC of the hosted app goes on, on its own page", async () => {
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { pathname: `/s/${SERVER}/`, origin: "http://localhost" } });
    tab.set(MARKER, kept(60_000));
    expect(buttons(await mount())).toEqual(["Stop waiting"]);
    expect(links()).toBe(1);
  });

  test("an address that now answers for another PC ends the wait kept for the first, with no window opened on that PC and nothing listed", async () => {
    tab.set(MARKER, kept(60_000));
    pc.offer = offerOf(otherKey, "laptop");
    const renderer = await mount();
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(tab.has(MARKER)).toBe(false);
    // which PC answers was read from its health, which opens nothing
    expect(links()).toBe(0);
    await advance(RELIST_MS + REOPEN_MS);
    expect(links()).toBe(0);
    expect(directory).toEqual([]);
  });

  test("an address that changes PC between that read and the window ends the wait as before, once the window says so", async () => {
    tab.set(MARKER, kept(60_000));
    pc.offer = offerOf(otherKey, "laptop");
    pc.healthId = SERVER;
    const renderer = await mount();
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(tab.has(MARKER)).toBe(false);
    expect(links()).toBe(1);
    expect(directory).toEqual([]);
    // that request opened a window on the other PC, where no screen waits: closed again, after it was opened
    const windows = asked.filter((request) => request.path === "/api/relay/link" || request.path === "/api/relay/link/close").map((request) => request.path);
    expect(windows).toEqual(["/api/relay/link", "/api/relay/link/close"]);
    // and never again: nothing of that wait is left
    await advance(RELIST_MS + REOPEN_MS);
    expect(asked.filter((request) => request.path === "/api/relay/link" || request.path === "/api/relay/link/close")).toHaveLength(2);
  });

  test("a reloaded tab whose address now answers for another PC, already in the account, does not say the PC that waited was added", async () => {
    tab.set(MARKER, kept(20 * 60_000));
    pc.offer = offerOf(otherKey, "laptop");
    pc.account = ACCOUNT;
    const renderer = await mount();
    expect(renderer.toJSON()).toBeNull();
    expect(tab.has(MARKER)).toBe(false);
    expect(links()).toBe(0);
  });

  test("an address that starts answering for another PC of the account under a waiting screen does not say the PC that waited was added", async () => {
    const renderer = await waitingFrom();
    pc.offer = offerOf(otherKey, "laptop");
    pc.account = ACCOUNT;
    await advance(ADDED_POLL_MS);
    expect(renderer.toJSON()).toBeNull();
    expect(tab.has(MARKER)).toBe(false);
    expect(links()).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("a PC that does not say which PC it is gets no window from a wait taken up again, and is not said to be added", async () => {
    tab.set(MARKER, kept(60_000));
    pc.healthId = null;
    const renderer = await mount();
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    await advance(REOPEN_MS);
    expect(links()).toBe(0);
    pc.account = ACCOUNT;
    await advance(ADDED_POLL_MS);
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    // it says so again: the wait goes on where it was
    pc.healthId = undefined;
    await advance(ADDED_POLL_MS);
    expect(words(renderer)).toContain("This PC is in your account. Your other devices can open it now.");
  });

  test("on the hosted app's page for the PC, which names it, a PC that does not say which PC it is still gets its window", async () => {
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { pathname: `/s/${SERVER}/`, origin: "http://localhost" } });
    tab.set(MARKER, kept(60_000));
    pc.healthId = null;
    expect(buttons(await mount())).toEqual(["Stop waiting"]);
    expect(links()).toBe(1);
  });

  test("a PC that joined another account than the one waited under does not say it is in yours", async () => {
    const renderer = await waitingFrom();
    pc.account = "acct_someone_else";
    await advance(ADDED_POLL_MS);
    expect(renderer.toJSON()).toBeNull();
    expect(tab.has(MARKER)).toBe(false);
    expect(jest.getTimerCount()).toBe(0);

    tab.set(MARKER, kept(60_000));
    expect((await mount()).toJSON()).toBeNull();
    expect(tab.has(MARKER)).toBe(false);
  });

  test("a sign-in that changed under a waiting screen ends the wait before the PC is listed again", async () => {
    const renderer = await waitingFrom();
    signedIn = "acct_someone_else";
    await advance(RELIST_MS);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(directory).toEqual(["putPc"]);
    expect(tab.has(MARKER)).toBe(false);
  });

  test("lists the PC again nine minutes after it was last listed, also across a reload", async () => {
    tab.set(MARKER, kept(8 * 60_000));
    await mount();
    expect(directory).toEqual([]);
    await advance(60_000 - 1);
    expect(directory).toEqual([]);
    await advance(1);
    expect(directory).toEqual(["putPc"]);
    expect(JSON.parse(tab.get(MARKER)!).listedAt).toBe(at + 60_000);
    // and from then every nine minutes, as without a reload
    await advance(RELIST_MS - 1);
    expect(directory).toEqual(["putPc"]);
    await advance(1);
    expect(directory).toEqual(["putPc", "putPc"]);
  });

  test("a reloaded tab whose listing is already due lists the PC at once", async () => {
    tab.set(MARKER, kept(20 * 60_000, 9 * 60_000 + 30_000));
    await mount();
    await advance(0);
    expect(directory).toEqual(["putPc"]);
    expect(JSON.parse(tab.get(MARKER)!).listedAt).toBe(Date.now());
  });

  test("a listing that failed is tried again with the next reopen, not nine minutes later", async () => {
    await waitingFrom();
    pc.linkError = { status: 503, code: "internal" };
    await advance(RELIST_MS);
    expect(directory).toEqual(["putPc"]);
    pc.linkError = null;
    await advance(REOPEN_MS);
    expect(directory).toEqual(["putPc", "putPc"]);
  });

  test("a reloaded tab whose PC does not answer yet asks again and then goes on waiting", async () => {
    tab.set(MARKER, kept(60_000));
    pc.statusDown = true;
    const renderer = await mount();
    expect(renderer.toJSON()).toBeNull();
    expect(tab.has(MARKER)).toBe(true);
    await advance(ADDED_POLL_MS);
    expect(renderer.toJSON()).toBeNull();
    pc.statusDown = false;
    await advance(ADDED_POLL_MS);
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    expect(links()).toBe(1);
  });

  test("a PC that does not answer on a page with no wait kept is not asked again", async () => {
    pc.statusDown = true;
    const renderer = await mount();
    expect(jest.getTimerCount()).toBe(0);
    expect(renderer.toJSON()).toBeNull();
  });

  test("a PC already in an account, with no wait kept, shows nothing", async () => {
    pc.account = ACCOUNT;
    const renderer = await mount();
    expect(renderer.toJSON()).toBeNull();
  });

  test("stops after 30 minutes, and Keep waiting starts another 30", async () => {
    const renderer = await waitingFrom();
    await advance(WAITING_MS - 1);
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    await advance(1);
    expect(words(renderer)).toBe("This PC stopped waiting after 30 minutes.");
    expect(buttons(renderer)).toEqual(["Keep waiting"]);
    expect(tab.has(MARKER)).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    const stopped = asked.length;
    await advance(WAITING_MS);
    expect(asked.length).toBe(stopped);

    await press(renderer, "Keep waiting");
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    expect(JSON.parse(tab.get(MARKER)!)).toEqual({ name: "desk", until: Date.now() + WAITING_MS, serverId: SERVER, account: ACCOUNT, listedAt: Date.now() });
    const opened = links();
    await advance(REOPEN_MS);
    expect(links()).toBe(opened + 1);
  });

  test("a page hidden through the end of its 30 minutes reopens nothing when it shows again", async () => {
    const renderer = await waitingFrom();
    show(true);
    await advance(WAITING_MS);
    const opened = links();
    show(false);
    await settle();
    expect(links()).toBe(opened);
    expect(buttons(renderer)).toEqual(["Keep waiting"]);
  });

  test("Stop waiting returns to the offer, forgets the wait, closes the window on the PC and reopens nothing more", async () => {
    const renderer = await waitingFrom();
    await press(renderer, "Stop waiting");
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(tab.has(MARKER)).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    expect(asked.filter((request) => request.path === "/api/relay/link/close").length).toBe(1);
    expect(asked.at(-1)!.path).toBe("/api/relay/link/close");
    const stopped = asked.length;
    await advance(REOPEN_MS * 2);
    expect(asked.length).toBe(stopped);
  });

  test("Stop waiting on an Ovis from before the close route stops all the same, without a word", async () => {
    pc.closeMissing = true;
    const renderer = await waitingFrom();
    const warned = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    await press(renderer, "Stop waiting");
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(words(renderer)).not.toContain("Try again");
    expect((console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(warned);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("Stop waiting in one of two copies closes the window once: the copy that only follows closes nothing", async () => {
    const settings = await waitingFrom();
    const welcome = await mount();
    expect(buttons(welcome)).toEqual(["Stop waiting"]);
    await press(settings, "Stop waiting");
    await advance(REOPEN_MS);
    expect(buttons(welcome)).toEqual(["Add this PC to my account"]);
    expect(asked.filter((request) => request.path === "/api/relay/link/close").length).toBe(1);
  });

  test("a wait that ran out by itself closes nothing: only Stop waiting does", async () => {
    const renderer = await waitingFrom();
    await advance(WAITING_MS);
    expect(buttons(renderer)).toEqual(["Keep waiting"]);
    expect(asked.some((request) => request.path === "/api/relay/link/close")).toBe(false);
  });

  test("a sign-in that just finished here lists the PC once and waits, with no press", async () => {
    const renderer = await mount(ACCOUNT);
    expect(words(renderer).split("\n")[0]).toBe("Signed in. Adding this PC to your account…");
    expect(words(renderer)).toContain("choose Add on desk.");
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    expect(directory).toEqual(["putPc"]);
    expect(puts).toEqual([`${ACCOUNT}/${SERVER}`]);
    expect(links()).toBe(1);
    expect(JSON.parse(tab.get(MARKER)!)).toEqual({ name: "desk", until: at + WAITING_MS, serverId: SERVER, account: ACCOUNT, listedAt: at });
    // the wait is the pressed one's: reopened, approve-here only, and the relay was never asked to start
    await advance(REOPEN_MS);
    expect(links()).toBe(2);
    expect(asked.filter((request) => request.path === "/api/relay/link").every((request) => request.localOnly)).toBe(true);
    expect(asked.some((request) => request.path === "/api/relay/start")).toBe(false);
    expect(directory).toEqual(["putPc"]);
  });

  test("the wait a sign-in began is the pressed one's: it stops after 30 minutes, pauses under a hidden page and is listed again", async () => {
    const renderer = await mount(ACCOUNT);
    show(true);
    await settle();
    for (let tick = 0; tick < 4; tick++) await advance(REOPEN_MS);
    expect(links()).toBe(1);
    show(false);
    await settle();
    expect(links()).toBe(2);
    // nine minutes after the sign-in listed it
    await advance(RELIST_MS - 4 * REOPEN_MS);
    expect(directory).toEqual(["putPc", "putPc"]);
    await advance(WAITING_MS);
    expect(buttons(renderer)).toEqual(["Keep waiting"]);
    expect(tab.has(MARKER)).toBe(false);
    const opened = links();
    await advance(REOPEN_MS * 2);
    expect(links()).toBe(opened);
  });

  test("a sign-in that was already there lists nothing by itself: the offer and its button", async () => {
    const renderer = await mount();
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    await advance(RELIST_MS);
    expect(links()).toBe(0);
    expect(directory).toEqual([]);
  });

  test("a sign-in that just finished is taken once: a later mount of the screen offers the button", async () => {
    let fresh: { account: string; adds: boolean } | null = { account: ACCOUNT, adds: true };
    const signedInHere = (): { account: string; adds: boolean } | null => { const taken = fresh; fresh = null; return taken; };
    for (const expected of [["Stop waiting"], ["Add this PC to my account"]]) {
      tab.clear();
      let renderer!: ReactTestRenderer;
      act(() => { renderer = create(createElement(SettingsProvider, { children: createElement(AddThisPc, { service: unbound, signedInHere }) })); });
      await settle();
      expect(buttons(renderer)).toEqual(expected);
      act(() => { renderer.unmount(); });
    }
    expect(directory).toEqual(["putPc"]);
  });

  test("a sign-in that just finished on a PC already in an account shows nothing and lists nothing", async () => {
    pc.account = ACCOUNT;
    const renderer = await mount(ACCOUNT);
    expect(renderer.toJSON()).toBeNull();
    expect(links()).toBe(0);
    expect(directory).toEqual([]);
  });

  test("a sign-in replaced by another before the screen read it lists nothing under the other", async () => {
    signedIn = "acct_someone_else";
    const renderer = await mount(ACCOUNT);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(links()).toBe(0);
    expect(directory).toEqual([]);
  });

  test("a sign-in that just finished while another copy already waits goes on with that wait, and lists nothing itself", async () => {
    const settings = await waitingFrom();
    const welcome = await mount(ACCOUNT);
    expect(buttons(welcome)).toEqual(["Stop waiting"]);
    expect(words(welcome)).not.toContain("Signed in. Adding this PC to your account…");
    // it opened the window as any copy that finds a wait kept does, and wrote nothing to the directory
    expect(directory).toEqual(["putPc"]);
    expect(links()).toBe(2);
    // one wait for both: stopping it in the first stops the one the sign-in joined
    await press(settings, "Stop waiting");
    await advance(REOPEN_MS);
    expect(buttons(welcome)).toEqual(["Add this PC to my account"]);
    expect(directory).toEqual(["putPc"]);
  });

  test("another copy that began a wait while the sign-in was read is joined: the PC is listed once", async () => {
    const release = hold("session");
    const welcome = await mount(ACCOUNT);
    expect(welcome.toJSON()).toBeNull();
    // the wait another copy of the screen began meanwhile, as the tab keeps it
    tab.set(MARKER, kept(0));
    release();
    await settle();
    expect(buttons(welcome)).toEqual(["Stop waiting"]);
    expect(links()).toBe(0);
    expect(directory).toEqual([]);
  });

  test("the wait a sign-in began is taken up by a copy showing the button, as a pressed one is", async () => {
    const settings = await mount();
    expect(buttons(settings)).toEqual(["Add this PC to my account"]);
    const welcome = await mount(ACCOUNT);
    expect(buttons(welcome)).toEqual(["Stop waiting"]);
    expect(buttons(settings)).toEqual(["Stop waiting"]);
    expect(directory).toEqual(["putPc"]);
    expect(links()).toBe(1);
  });

  test("a wait left under another sign-in than the one that just finished is dropped, and the PC listed under the new one", async () => {
    tab.set(MARKER, kept(60_000, 60_000, { account: "acct_before" }));
    const renderer = await mount(ACCOUNT);
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    expect(puts).toEqual([`${ACCOUNT}/${SERVER}`]);
    expect(JSON.parse(tab.get(MARKER)!)).toEqual({ name: "desk", until: at + WAITING_MS, serverId: SERVER, account: ACCOUNT, listedAt: at });
  });

  test("with the relay off the sign-in starts nothing: one button turns the relay on and lists", async () => {
    pc.relay = "off";
    const renderer = await mount(ACCOUNT);
    expect(buttons(renderer)).toEqual(["Turn on the relay and add this PC"]);
    expect(words(renderer)).toContain("The Ovis relay lets your devices reach this PC from anywhere.");
    expect(words(renderer)).not.toContain("closes the device gate");
    expect(asked.some((request) => request.path === "/api/relay/start")).toBe(false);
    expect(directory).toEqual([]);
    expect(tab.has(MARKER)).toBe(false);

    await press(renderer, "Turn on the relay and add this PC");
    expect(asked.filter((request) => request.path === "/api/relay/start").length).toBe(1);
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    expect(directory).toEqual(["putPc"]);
    expect(asked.filter((request) => request.path === "/api/relay/link").every((request) => request.localOnly)).toBe(true);
    // the start came before the listing's window
    const paths = asked.map((request) => request.path);
    expect(paths.indexOf("/api/relay/start")).toBeLessThan(paths.lastIndexOf("/api/relay/link"));
  });

  test("a copy offering the relay button takes up the wait another copy begins", async () => {
    pc.relay = "off";
    const welcome = await mount(ACCOUNT);
    expect(buttons(welcome)).toEqual(["Turn on the relay and add this PC"]);
    // the relay is turned on elsewhere (its own switch), and the other copy's button is pressed
    pc.relay = "on";
    const settings = await mount();
    await press(settings, "Add this PC to my account");
    expect(buttons(welcome)).toEqual(["Stop waiting"]);
    expect(directory).toEqual(["putPc"]);
    expect(asked.some((request) => request.path === "/api/relay/start")).toBe(false);
  });

  test("the relay button says what the relay's switch says of the device gate it closes", async () => {
    pc.relay = "off";
    pc.gate = "open";
    const renderer = await mount(ACCOUNT);
    expect(words(renderer)).toContain("Turning on the relay closes the device gate: a new browser then needs a pairing code or the access token.");
  });

  test("a relay that may not be turned on says why, and nothing is listed", async () => {
    pc.relay = "off";
    pc.blocked = "serve_only";
    const renderer = await mount(ACCOUNT);
    await press(renderer, "Turn on the relay and add this PC");
    expect(words(renderer)).toContain("Blocked: OVIS_TAILSCALE_SERVE_ONLY says tailscale serve is the only way in.");
    expect(buttons(renderer)).toEqual(["Turn on the relay and add this PC"]);
    expect(directory).toEqual([]);
    expect(tab.has(MARKER)).toBe(false);
  });

  test("a browser in only because the device gate is open pairs itself before the relay closes that gate", async () => {
    pc.relay = "off";
    pc.gate = "open";
    const renderer = await mount(ACCOUNT);
    // the PC refuses such a browser its account, so the button is never offered to one: this one came to be in that way since
    pc.via = "open";
    await press(renderer, "Turn on the relay and add this PC");
    const paths = asked.map((request) => request.path);
    expect(paths.filter((path) => path === "/api/devices/pair").length).toBe(1);
    expect(paths.indexOf("/api/devices/pair/start")).toBeGreaterThan(-1);
    expect(paths.indexOf("/api/devices/pair")).toBeLessThan(paths.indexOf("/api/relay/start"));
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    expect(directory).toEqual(["putPc"]);
  });

  test("a browser in another way than the open gate is not paired by the relay button", async () => {
    pc.relay = "off";
    pc.gate = "open";
    const renderer = await mount(ACCOUNT);
    await press(renderer, "Turn on the relay and add this PC");
    expect(asked.some((request) => request.path.startsWith("/api/devices"))).toBe(false);
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
  });

  test("a browser whose pairing did not stick leaves the relay off, says so, and nothing is listed", async () => {
    pc.relay = "off";
    pc.gate = "open";
    pc.cookieSticks = false;
    const renderer = await mount(ACCOUNT);
    pc.via = "open";
    await press(renderer, "Turn on the relay and add this PC");
    expect(words(renderer)).toContain("Could not confirm this browser is paired. Check that cookies are enabled, then try again.");
    expect(asked.some((request) => request.path === "/api/relay/start")).toBe(false);
    expect(buttons(renderer)).toEqual(["Turn on the relay and add this PC"]);
    expect(links()).toBe(1);
    expect(directory).toEqual([]);
  });

  test("the relay is not turned on while how this browser is in cannot be read", async () => {
    pc.relay = "off";
    const renderer = await mount(ACCOUNT);
    pc.healthDown = true;
    await press(renderer, "Turn on the relay and add this PC");
    expect(words(renderer)).toContain("The relay could not be turned on. Try again.");
    expect(asked.some((request) => request.path === "/api/relay/start")).toBe(false);
    expect(buttons(renderer)).toEqual(["Turn on the relay and add this PC"]);
  });

  for (const start of ["off", "broken"] as const) {
    test(`a relay start that ${start === "off" ? "leaves the relay off" : "fails"} says so, keeps the button and lists nothing`, async () => {
      pc.relay = "off";
      pc.start = start;
      const renderer = await mount(ACCOUNT);
      const opened = links();
      await press(renderer, "Turn on the relay and add this PC");
      expect(asked.filter((request) => request.path === "/api/relay/start").length).toBe(1);
      const alerts = renderer.root.findAll((node) => node.type === "p" && (node.props as { role?: string }).role === "alert").map((node) => node.children.join(""));
      expect(alerts).toEqual(["The relay could not be turned on. Try again."]);
      expect(buttons(renderer)).toEqual(["Turn on the relay and add this PC"]);
      expect(directory).toEqual([]);
      expect(links()).toBe(opened);
      expect(tab.has(MARKER)).toBe(false);
    });
  }

  test("a browser the PC refuses its account (in only through the open device gate) is shown nothing after a sign-in, and asks once", async () => {
    pc.gate = "open";
    pc.via = "open";
    const renderer = await mount(ACCOUNT);
    expect(renderer.toJSON()).toBeNull();
    await advance(SIGNED_IN_RETRY_MS);
    expect(asked.filter((request) => request.path === "/api/account/status").length).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(links()).toBe(0);
    expect(directory).toEqual([]);
  });

  test("another sign-in stored while the PC's window was being opened: nothing is listed under it, and the offer", async () => {
    const release = hold("link");
    const renderer = await mount(ACCOUNT);
    expect(words(renderer)).toBe("Signed in. Adding this PC to your account…");
    expect(buttons(renderer)).toEqual([]);
    // another tab of this browser signed out and in as someone else meanwhile
    signedIn = "acct_someone_else";
    release();
    await settle();
    expect(puts).toEqual([]);
    expect(directory).toEqual([]);
    expect(tab.has(MARKER)).toBe(false);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(words(renderer)).not.toContain("Signed in. Adding this PC to your account…");
    expect(words(renderer)).not.toContain("Try again");
  });

  test("the relay button lists only under the sign-in it was offered to: with another stored, the relay is not started and nothing is listed", async () => {
    pc.relay = "off";
    const renderer = await mount(ACCOUNT);
    expect(buttons(renderer)).toEqual(["Turn on the relay and add this PC"]);
    signedIn = "acct_someone_else";
    await press(renderer, "Turn on the relay and add this PC");
    expect(asked.some((request) => request.path === "/api/relay/start")).toBe(false);
    expect(puts).toEqual([]);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
  });

  test("another sign-in stored while the relay was starting: the relay button lists nothing under it", async () => {
    pc.relay = "off";
    const renderer = await mount(ACCOUNT);
    const release = hold("start");
    await press(renderer, "Turn on the relay and add this PC");
    signedIn = "acct_someone_else";
    release();
    await settle();
    expect(asked.filter((request) => request.path === "/api/relay/start").length).toBe(1);
    expect(puts).toEqual([]);
    expect(tab.has(MARKER)).toBe(false);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
  });

  test("a listing after the sign-in that gets no answer is given up: the button again, and a late answer lists and keeps nothing", async () => {
    const release = hold("listPcs");
    const renderer = await mount(ACCOUNT);
    expect(words(renderer)).toBe("Signed in. Adding this PC to your account…");
    expect(buttons(renderer)).toEqual([]);
    await advance(ADDING_MS);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(words(renderer)).toContain("This PC could not be listed in your account. Try again.");
    // the account service answers after all: nothing is written for the attempt given up, and no wait appears
    release();
    await settle();
    expect(puts).toEqual([]);
    expect(tab.has(MARKER)).toBe(false);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    // the button lists as any press does
    await press(renderer, "Add this PC to my account");
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    expect(puts).toEqual([`${ACCOUNT}/${SERVER}`]);
  });

  test("a PC that stops answering while the sign-in lists it gives the button back", async () => {
    pc.hang = "/api/relay/link";
    const renderer = await mount(ACCOUNT);
    expect(buttons(renderer)).toEqual([]);
    await advance(ADDING_MS);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(words(renderer)).toContain("This PC could not be listed in your account. Try again.");
    expect(directory).toEqual([]);
  });

  test("a relay start that gets no answer gives the relay button back, and a late answer lists nothing", async () => {
    pc.relay = "off";
    const renderer = await mount(ACCOUNT);
    const release = hold("start");
    await press(renderer, "Turn on the relay and add this PC");
    expect(words(renderer)).toBe("Signed in. Adding this PC to your account…");
    expect(buttons(renderer)).toEqual([]);
    await advance(ADDING_MS);
    expect(buttons(renderer)).toEqual(["Turn on the relay and add this PC"]);
    expect(words(renderer)).toContain("The relay could not be turned on. Try again.");
    const opened = links();
    release();
    await settle();
    expect(links()).toBe(opened);
    expect(directory).toEqual([]);
    expect(buttons(renderer)).toEqual(["Turn on the relay and add this PC"]);
  });

  test("a sign-in that just finished while the PC's account cannot be read is taken by that mount alone", async () => {
    pc.statusDown = true;
    let fresh: { account: string; adds: boolean } | null = { account: ACCOUNT, adds: true };
    const signedInHere = (): { account: string; adds: boolean } | null => { const taken = fresh; fresh = null; return taken; };
    const tree = () => createElement(SettingsProvider, { children: createElement(AddThisPc, { service: unbound, signedInHere }) });
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(tree()); });
    await settle();
    expect(renderer.toJSON()).toBeNull();
    // taken although nothing could be read: a later mount (a sign-in again for this account) only offers the button
    expect(fresh).toBeNull();
    act(() => { renderer.unmount(); });
    pc.statusDown = false;
    act(() => { renderer = create(tree()); });
    renderers.push(renderer);
    await settle();
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    await advance(RELIST_MS);
    expect(links()).toBe(0);
    expect(directory).toEqual([]);
  });

  test("a sign-in that just finished is listed once the PC's account answers again", async () => {
    pc.statusDown = true;
    const renderer = await mount(ACCOUNT);
    expect(renderer.toJSON()).toBeNull();
    await advance(ADDED_POLL_MS);
    expect(links()).toBe(0);
    pc.statusDown = false;
    await advance(ADDED_POLL_MS);
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    expect(directory).toEqual(["putPc"]);
  });

  test("past a minute without an answer the sign-in lists nothing any more: the PC is still asked, and the button comes once it answers", async () => {
    pc.statusDown = true;
    const renderer = await mount(ACCOUNT);
    await advance(SIGNED_IN_RETRY_MS);
    expect(renderer.toJSON()).toBeNull();
    pc.statusDown = false;
    await advance(REOPEN_MS);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(words(renderer)).not.toContain("Signed in. Adding this PC to your account…");
    await advance(SIGNED_IN_RETRY_MS);
    expect(links()).toBe(0);
    expect(directory).toEqual([]);
  });

  test("a sign-in that just finished on a PC a device added meanwhile lists nothing and says it is added", async () => {
    pc.statusDown = true;
    const renderer = await mount(ACCOUNT);
    pc.statusDown = false;
    pc.account = ACCOUNT;
    await advance(ADDED_POLL_MS);
    expect(renderer.toJSON()).toBeNull();
    expect(links()).toBe(0);
    expect(directory).toEqual([]);
  });

  test("a listing after the sign-in that fails for another reason than the relay keeps the plain offer and its words", async () => {
    pc.linkError = { status: 503, code: "internal" };
    const renderer = await mount(ACCOUNT);
    expect(words(renderer)).toContain("This PC could not be listed in your account. Try again.");
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(asked.some((request) => request.path === "/api/relay/start")).toBe(false);
  });

  test("words a relay that is off, and keeps the offer", async () => {
    const renderer = await mount();
    pc.linkError = { status: 409, code: "relay_off" };
    await press(renderer, "Add this PC to my account");
    expect(words(renderer)).toContain("Turn on remote access through the Ovis relay above first.");
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(tab.has(MARKER)).toBe(false);
  });

  test("Stop waiting in one copy of the screen stops the other copy too: nothing reopened, listed or kept again", async () => {
    // the welcome's copy stays mounted under Settings, whose copy takes up the same wait
    const welcome = await waitingFrom();
    const settings = await mount();
    expect(buttons(settings)).toEqual(["Stop waiting"]);
    // the second copy taking the wait up does not end it for the first
    await advance(ADDED_POLL_MS);
    expect(buttons(welcome)).toEqual(["Stop waiting"]);
    expect(tab.has(MARKER)).toBe(true);

    await press(settings, "Stop waiting");
    await advance(ADDED_POLL_MS);
    expect(buttons(welcome)).toEqual(["Add this PC to my account"]);
    expect(jest.getTimerCount()).toBe(0);
    const opened = links();
    await advance(RELIST_MS + REOPEN_MS);
    expect(links()).toBe(opened);
    expect(directory).toEqual(["putPc"]);
    expect(tab.has(MARKER)).toBe(false);
  });

  test("a copy whose wait another copy stopped lists nothing under a hidden page either, and keeps nothing again", async () => {
    tab.set(MARKER, kept(8 * 60_000));
    const welcome = await mount();
    const settings = await mount();
    await press(settings, "Stop waiting");
    show(true);
    await advance(RELIST_MS);
    expect(directory).toEqual([]);
    expect(tab.has(MARKER)).toBe(false);
    expect(buttons(welcome)).toEqual(["Add this PC to my account"]);
  });

  test("a copy that waits says the PC was added, not the offer, when the other copy found it first", async () => {
    const welcome = await waitingFrom();
    const settings = await mount();
    // the other copy forgot the wait because the PC joined: this one's reopen comes before its own poll
    pc.account = ACCOUNT;
    tab.delete(MARKER);
    await advance(ADDED_POLL_MS);
    for (const copy of [welcome, settings]) expect(words(copy)).toContain("This PC is in your account. Your other devices can open it now.");
  });

  test("a sign-out or another sign-in in another tab ends the wait with the next reopen, not nine minutes later", async () => {
    for (const now of [null, "acct_someone_else"]) {
      signedIn = ACCOUNT;
      const renderer = await waitingFrom();
      const opened = links();
      signedIn = now;
      await advance(REOPEN_MS);
      expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
      expect(links()).toBe(opened);
      expect(tab.has(MARKER)).toBe(false);
      await advance(RELIST_MS);
      expect(links()).toBe(opened);
      act(() => { renderer.unmount(); });
    }
    expect(directory).toEqual(["putPc", "putPc"]);
  });

  test("a reopen that never gets an answer does not hold the next ones", async () => {
    await waitingFrom();
    pc.hang = "/api/relay/link";
    await advance(REOPEN_MS);
    expect(links()).toBe(2);
    await advance(ANSWER_MS);
    await advance(2 * REOPEN_MS);
    expect(links()).toBeGreaterThanOrEqual(3);
  });

  test("a question about the account that never gets an answer does not hold the next ones", async () => {
    const renderer = await waitingFrom();
    pc.hang = "/api/account/status";
    await advance(ADDED_POLL_MS);
    pc.account = ACCOUNT;
    await advance(ANSWER_MS);
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    await advance(ADDED_POLL_MS);
    expect(words(renderer)).toContain("This PC is in your account. Your other devices can open it now.");
  });

  test("a listing that never gets an answer is tried again", async () => {
    await waitingFrom();
    await advance(RELIST_MS - ADDED_POLL_MS);
    // the listing's own question about the account is the one left unanswered
    pc.hang = "/api/account/status";
    await advance(ADDED_POLL_MS - 1);
    expect(pc.hang).toBe("/api/account/status");
    await advance(1);
    expect(pc.hang).toBeNull();
    expect(directory).toEqual(["putPc"]);
    await advance(2 * REOPEN_MS);
    await advance(REOPEN_MS);
    expect(directory).toEqual(["putPc", "putPc"]);
  });

  test("says the other devices can open the PC only once the device that added it has enrolled it", async () => {
    const renderer = await waitingFrom();
    pc.account = ACCOUNT;
    pc.enrolling = true;
    await advance(ADDED_POLL_MS);
    expect(words(renderer)).toContain("This PC is in your account. The device that added it is still letting your other devices in.");
    expect(words(renderer)).not.toContain("Your other devices can open it now.");
    // the wait itself is over: nothing is reopened or listed while the enrollment runs
    const opened = links();
    await advance(RELIST_MS);
    expect(links()).toBe(opened);
    expect(directory).toEqual(["putPc"]);
    expect(words(renderer)).not.toContain("Your other devices can open it now.");
    pc.enrolling = false;
    await advance(ADDED_POLL_MS);
    expect(words(renderer)).toContain("This PC is in your account. Your other devices can open it now.");
    expect(jest.getTimerCount()).toBe(0);
  });

  test("a reloaded tab finds the PC added but not enrolled yet, and says so until it is", async () => {
    tab.set(MARKER, kept(60_000));
    pc.account = ACCOUNT;
    pc.enrolling = true;
    const renderer = await mount();
    expect(words(renderer)).toContain("The device that added it is still letting your other devices in.");
    pc.enrolling = false;
    await advance(ADDED_POLL_MS);
    expect(words(renderer)).toContain("Your other devices can open it now.");
  });

  test("a PC whose first member left before enrolling it offers the button again", async () => {
    const renderer = await waitingFrom();
    pc.account = ACCOUNT;
    pc.enrolling = true;
    await advance(ADDED_POLL_MS);
    pc.account = null;
    await advance(ADDED_POLL_MS);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
  });

  test("a PC added under the account that waited is not called yours once the tab is signed in to another", async () => {
    // after a reload
    tab.set(MARKER, kept(60_000));
    pc.account = ACCOUNT;
    signedIn = "acct_someone_else";
    expect((await mount()).toJSON()).toBeNull();
    expect(tab.has(MARKER)).toBe(false);
    signedIn = null;
    tab.set(MARKER, kept(60_000));
    expect((await mount()).toJSON()).toBeNull();

    // and on a screen that waits
    pc.account = null;
    signedIn = ACCOUNT;
    const renderer = await waitingFrom();
    signedIn = "acct_someone_else";
    pc.account = ACCOUNT;
    await advance(ADDED_POLL_MS);
    expect(renderer.toJSON()).toBeNull();
    expect(tab.has(MARKER)).toBe(false);
  });

  test("a reloaded tab whose PC answers only after the 30 minutes says the wait stopped", async () => {
    tab.set(MARKER, kept(WAITING_MS - 2 * ADDED_POLL_MS));
    pc.statusDown = true;
    const renderer = await mount();
    expect(renderer.toJSON()).toBeNull();
    await advance(2 * ADDED_POLL_MS);
    expect(words(renderer)).toBe("This PC stopped waiting after 30 minutes.");
    expect(buttons(renderer)).toEqual(["Keep waiting"]);
    expect(tab.has(MARKER)).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("a press after a device added the PC through the window that outlived the wait lists nothing and says it is added", async () => {
    const renderer = await waitingFrom();
    await advance(WAITING_MS);
    expect(buttons(renderer)).toEqual(["Keep waiting"]);
    pc.account = ACCOUNT;
    const before = directory.length;
    await press(renderer, "Keep waiting");
    expect(words(renderer)).toContain("This PC is in your account. Your other devices can open it now.");
    expect(directory.length).toBe(before);

    // the same after Stop waiting, and under another sign-in it is not called yours
    pc.account = null;
    const other = await waitingFrom();
    await press(other, "Stop waiting");
    pc.account = "acct_someone_else";
    const listed = directory.length;
    await press(other, "Add this PC to my account");
    expect(other.toJSON()).toBeNull();
    expect(directory.length).toBe(listed);
  });

  test("a sign-in that changes while the PC is being listed again is never written to", async () => {
    const renderer = await waitingFrom();
    const release = hold("listPcs");
    await advance(RELIST_MS);
    // another tab signed out and in as someone else while the directory was being read
    signedIn = "acct_someone_else";
    release();
    await settle();
    expect(puts).toEqual([`${ACCOUNT}/${SERVER}`]);
    // the next reopen finds the other sign-in and ends the wait
    await advance(REOPEN_MS);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(puts).toEqual([`${ACCOUNT}/${SERVER}`]);
    expect(tab.has(MARKER)).toBe(false);
  });

  test("an address that answers for another PC under a hidden page is not listed in its place", async () => {
    const renderer = await waitingFrom();
    show(true);
    pc.offer = offerOf(otherKey, "laptop");
    await advance(RELIST_MS);
    expect(puts).toEqual([`${ACCOUNT}/${SERVER}`]);
    expect(directory).toEqual(["putPc"]);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(tab.has(MARKER)).toBe(false);
  });

  test("a second copy that was still reading the sign-in when the first stopped the wait does not take it up", async () => {
    const welcome = await waitingFrom();
    const release = hold("session");
    const settings = await mount();
    await press(welcome, "Stop waiting");
    const opened = links();
    release();
    await settle();
    expect(buttons(settings)).toEqual(["Add this PC to my account"]);
    await advance(2 * REOPEN_MS);
    expect(links()).toBe(opened);
    expect(tab.has(MARKER)).toBe(false);
  });

  test("Stop waiting while the PC is being listed again writes nothing to the directory", async () => {
    const renderer = await waitingFrom();
    const release = hold("listPcs");
    await advance(RELIST_MS);
    await press(renderer, "Stop waiting");
    release();
    await settle();
    expect(directory).toEqual(["putPc"]);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(tab.has(MARKER)).toBe(false);
  });

  test("Stop waiting in the other copy while this one lists the PC again writes nothing either", async () => {
    tab.set(MARKER, kept(8 * 60_000));
    const welcome = await mount();
    const settings = await mount();
    const release = hold("listPcs");
    await advance(60_000);
    await press(settings, "Stop waiting");
    release();
    await settle();
    await advance(ADDED_POLL_MS);
    expect(directory).toEqual([]);
    expect(buttons(welcome)).toEqual(["Add this PC to my account"]);
    expect(tab.has(MARKER)).toBe(false);
  });

  test("a copy showing the button takes up the wait begun in the other copy, and goes on with it when that one closes", async () => {
    // the guide's path: its copy is mounted first and says the relay is off; the press is made in Settings' copy
    const welcome = await mount();
    pc.linkError = { status: 409, code: "relay_off" };
    await press(welcome, "Add this PC to my account");
    pc.linkError = null;
    const settings = await mount();
    await press(settings, "Add this PC to my account");
    expect(buttons(welcome)).toEqual(["Stop waiting"]);
    expect(directory).toEqual(["putPc"]);
    act(() => { settings.unmount(); });
    renderers = renderers.filter((renderer) => renderer !== settings);
    const opened = links();
    await advance(REOPEN_MS);
    expect(links()).toBe(opened + 1);
    pc.account = ACCOUNT;
    await advance(ADDED_POLL_MS);
    expect(words(welcome)).toContain("This PC is in your account. Your other devices can open it now.");
    expect(tab.has(MARKER)).toBe(false);
  });

  test("a copy showing the button does not take up a wait begun under another sign-in than the one stored", async () => {
    const welcome = await mount();
    tab.set(MARKER, kept(0, 0, { account: "acct_someone_else" }));
    const { keepAddPcWaiting, readAddPcWaiting } = await import("../lib/account/addThisPc.ts");
    act(() => { keepAddPcWaiting(readAddPcWaiting()); });
    await settle();
    expect(buttons(welcome)).toEqual(["Add this PC to my account"]);
  });

  test("a copy whose wait the other copy replaced with a new one goes on with the new one", async () => {
    const welcome = await waitingFrom();
    const settings = await mount();
    await press(settings, "Stop waiting");
    await advance(1_000);
    await press(settings, "Add this PC to my account");
    await advance(ADDED_POLL_MS);
    expect(buttons(welcome)).toEqual(["Stop waiting"]);
    await press(welcome, "Stop waiting");
    await advance(ADDED_POLL_MS);
    expect(buttons(settings)).toEqual(["Add this PC to my account"]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("two copies waiting on one wait list the PC again once, not once each", async () => {
    await waitingFrom();
    const settings = await mount();
    await advance(RELIST_MS);
    expect(directory).toEqual(["putPc", "putPc"]);
    expect(JSON.parse(tab.get(MARKER)!).listedAt).toBe(at + RELIST_MS);
    // the copy that did not list goes on from the shared listing: once more nine minutes later, and alone when the other closed
    await advance(RELIST_MS);
    expect(directory).toEqual(["putPc", "putPc", "putPc"]);
    act(() => { settings.unmount(); });
    renderers = renderers.filter((renderer) => renderer !== settings);
    await advance(RELIST_MS);
    expect(directory).toEqual(["putPc", "putPc", "putPc", "putPc"]);
  });

  const closes = (): number => asked.filter((request) => request.path === "/api/relay/link/close").length;
  const passes = (): number => asked.filter((request) => request.path === "/api/account/relay-account").length;

  test("a sign-in whose button did not say it adds the PC lists and opens nothing, though the relay is on: the offer", async () => {
    const renderer = await mount(ACCOUNT, false);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(words(renderer)).not.toContain("Signed in. Adding this PC to your account…");
    await advance(ADDING_MS);
    expect(links()).toBe(0);
    expect(directory).toEqual([]);
    expect(tab.has(MARKER)).toBe(false);
    // the button lists as any press does
    await press(renderer, "Add this PC to my account");
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
  });

  test("a sign-in whose button did not say it adds the PC, with the relay off, is offered the one button for both", async () => {
    pc.relay = "off";
    const renderer = await mount(ACCOUNT, false);
    expect(buttons(renderer)).toEqual(["Turn on the relay and add this PC"]);
    expect(links()).toBe(0);
    expect(asked.some((request) => request.path === "/api/relay/start")).toBe(false);
    await press(renderer, "Turn on the relay and add this PC");
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    expect(puts).toEqual([`${ACCOUNT}/${SERVER}`]);
  });

  test("a device that only watches this PC is shown nothing: no listing after its sign-in, and no offer", async () => {
    pc.role = "watch";
    for (const adds of [true, false]) {
      const renderer = await mount(ACCOUNT, adds);
      expect(renderer.toJSON()).toBeNull();
    }
    const later = await mount();
    expect(later.toJSON()).toBeNull();
    await advance(ADDING_MS);
    expect(links()).toBe(0);
    expect(directory).toEqual([]);
  });

  test("a sign-in is not listed by itself while what this browser may do on the PC cannot be read: the offer", async () => {
    pc.healthDown = true;
    const renderer = await mount(ACCOUNT);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(links()).toBe(0);
    expect(directory).toEqual([]);
  });

  test("given up with the PC's entry already on its way: the window is closed, the PC is not told the account, and the screen says it may be listed", async () => {
    const release = hold("putPc");
    const renderer = await mount(ACCOUNT);
    expect(words(renderer)).toBe("Signed in. Adding this PC to your account…");
    expect(puts).toEqual([`${ACCOUNT}/${SERVER}`]);
    await advance(ADDING_MS);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(words(renderer)).toContain("This PC may not have been listed in your account. Try again.");
    expect(words(renderer)).not.toContain("could not be listed");
    // the window the attempt opened waits for nobody: closed, once
    expect(closes()).toBe(1);
    release();
    await settle();
    expect(passes()).toBe(0);
    expect(closes()).toBe(1);
    expect(tab.has(MARKER)).toBe(false);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
  });

  test("given up while the PC's window was still being opened: the window is closed once it does open", async () => {
    const release = hold("link");
    const renderer = await mount(ACCOUNT);
    await advance(ADDING_MS);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(words(renderer)).toContain("This PC could not be listed in your account. Try again.");
    expect(closes()).toBe(0);
    release();
    await settle();
    expect(closes()).toBe(1);
    expect(asked.at(-1)!.path).toBe("/api/relay/link/close");
    expect(directory).toEqual([]);
  });

  test("a late window of an attempt given up is left open once the person pressed the button since", async () => {
    const release = hold("link");
    const renderer = await mount(ACCOUNT);
    await advance(ADDING_MS);
    await press(renderer, "Add this PC to my account");
    release();
    await settle();
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    expect(closes()).toBe(0);
    expect(puts).toEqual([`${ACCOUNT}/${SERVER}`]);
  });

  test("a listing refused for another sign-in after the window opened closes that window", async () => {
    const release = hold("link");
    const renderer = await mount(ACCOUNT);
    signedIn = "acct_someone_else";
    release();
    await settle();
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(closes()).toBe(1);
    expect(puts).toEqual([]);
  });

  test("a screen closed while the sign-in lists the PC drops the listing: nothing written or kept, the window closed, and the next screen offers the button", async () => {
    const release = hold("link");
    const renderer = await mount(ACCOUNT);
    expect(words(renderer)).toBe("Signed in. Adding this PC to your account…");
    act(() => { renderer.unmount(); });
    release();
    await settle();
    expect(puts).toEqual([]);
    expect(directory).toEqual([]);
    expect(tab.has(MARKER)).toBe(false);
    expect(closes()).toBe(1);
    const next = await mount();
    expect(buttons(next)).toEqual(["Add this PC to my account"]);
  });

  test("a screen closed while the relay button starts the relay lists nothing when the relay answers", async () => {
    pc.relay = "off";
    const renderer = await mount(ACCOUNT);
    const release = hold("start");
    await press(renderer, "Turn on the relay and add this PC");
    act(() => { renderer.unmount(); });
    const opened = links();
    release();
    await settle();
    expect(links()).toBe(opened);
    expect(puts).toEqual([]);
    expect(tab.has(MARKER)).toBe(false);
  });

  test("a pressed listing goes on when its screen closes, as before: the wait is kept for the next screen", async () => {
    const release = hold("link");
    const renderer = await mount();
    await press(renderer, "Add this PC to my account");
    act(() => { renderer.unmount(); });
    release();
    await settle();
    expect(puts).toEqual([`${ACCOUNT}/${SERVER}`]);
    expect(tab.has(MARKER)).toBe(true);
    expect(closes()).toBe(0);
  });

  test("Stop waiting while a reopen is on its way closes the window that reopen opens late", async () => {
    const renderer = await waitingFrom();
    const release = hold("link");
    await advance(REOPEN_MS);
    expect(links()).toBe(2);
    await press(renderer, "Stop waiting");
    expect(closes()).toBe(1);
    // the reopen reaches the PC after the close, and opens a window nobody waits on: closed again
    release();
    await settle();
    expect(closes()).toBe(2);
    expect(asked.at(-1)!.path).toBe("/api/relay/link/close");
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
  });

  test("a late reopen after Stop waiting is left open once the person pressed the button again", async () => {
    const renderer = await waitingFrom();
    const release = hold("link");
    await advance(REOPEN_MS);
    await press(renderer, "Stop waiting");
    release();
    await press(renderer, "Add this PC to my account");
    await settle();
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    expect(closes()).toBe(1);
  });

  test("Stop waiting after a listing that got no answer in time closes the window that listing opens late", async () => {
    const renderer = await waitingFrom();
    // under a hidden page only the listing asks for the window, not the reopening
    show(true);
    await advance(RELIST_MS - 1);
    const release = hold("link");
    await advance(1);
    expect(links()).toBe(2);
    // the listing is given up for this attempt; its request for the window is still on its way to the PC
    await advance(2 * REOPEN_MS);
    await press(renderer, "Stop waiting");
    expect(closes()).toBe(1);
    // it reaches the PC after the close, and opens a window nobody waits on: closed again
    release();
    await settle();
    expect(links()).toBe(2);
    expect(closes()).toBe(2);
    expect(asked.at(-1)!.path).toBe("/api/relay/link/close");
    expect(directory).toEqual(["putPc"]);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
  });

  test("Stop waiting while a listing asks for the window closes the window it opens late, also when the account's directory never answers", async () => {
    const renderer = await waitingFrom();
    // under a hidden page only the listing asks for the window, not the reopening
    show(true);
    await advance(RELIST_MS - 1);
    const release = hold("link");
    await advance(1);
    expect(links()).toBe(2);
    await press(renderer, "Stop waiting");
    expect(closes()).toBe(1);
    // the request reaches the PC after the close and opens a window nobody waits on, and the directory gives no answer
    hold("listPcs");
    release();
    await settle();
    await advance(2 * REOPEN_MS);
    expect(links()).toBe(2);
    expect(closes()).toBe(2);
    expect(asked.at(-1)!.path).toBe("/api/relay/link/close");
    expect(directory).toEqual(["putPc"]);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
  });

  test("a wait begun right after Stop waiting asks for its window only once that close was answered", async () => {
    const renderer = await waitingFrom();
    const release = hold("close");
    await press(renderer, "Stop waiting");
    expect(closes()).toBe(1);
    // the close is still on its way: a window asked for now could be the one it closes
    await press(renderer, "Add this PC to my account");
    expect(links()).toBe(1);
    expect(directory).toEqual(["putPc"]);
    release();
    await settle();
    expect(links()).toBe(2);
    expect(asked.at(-1)!.path).not.toBe("/api/relay/link/close");
    expect(asked.map((request) => request.path).lastIndexOf("/api/relay/link")).toBeGreaterThan(asked.map((request) => request.path).lastIndexOf("/api/relay/link/close"));
    expect(directory).toEqual(["putPc", "putPc"]);
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    expect(closes()).toBe(1);
  });

  test("a close that never gets an answer holds the next wait's window for a minute, not for good", async () => {
    const renderer = await waitingFrom();
    pc.hang = "/api/relay/link/close";
    await press(renderer, "Stop waiting");
    await press(renderer, "Add this PC to my account");
    await advance(CLOSE_ANSWER_MS - 1);
    expect(links()).toBe(1);
    await advance(1);
    expect(links()).toBe(2);
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
  });

  test("works without a tab storage, only not resumed", async () => {
    Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new Error("blocked"); } });
    const renderer = await waitingFrom();
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    await advance(REOPEN_MS);
    expect(links()).toBe(2);
  });
});
