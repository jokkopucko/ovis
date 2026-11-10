import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { exportPublicKey, generateKeyPair, importPublicKey } from "../../shared/relay-e2ee.ts";
import { encodeOffer } from "../../shared/relay-offer.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { SignedOutError, type AccountService } from "../lib/account/service.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";
import { ADDED_POLL_MS, AddThisPc, ANSWER_MS, REOPEN_MS, WAITING_MS } from "./AccountSection.tsx";

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
   * fails (null: it gives a link), and the route whose next request never gets an answer (null: every one is answered)
   */
  let pc: { account: string | null; enrolling: boolean; linkError: { status: number; code: string } | null; statusDown: boolean; offer: string; hang: string | null };
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
  /** what the next reads of the directory and of the stored sign-in wait for (null: nothing) */
  let held: { listPcs: Promise<void> | null; session: Promise<void> | null };
  /** the account service; `bound` is the account of the one sign-in it acts for (forSignIn), which refuses once another is stored */
  const service = (bound?: string): AccountService => {
    const mine = (): void => { if (bound !== undefined && signedIn !== bound) throw new SignedOutError(); };
    return {
      listPcs: async () => { mine(); await held.listPcs; return []; },
      putPc: async (id: string) => { mine(); directory.push("putPc"); puts.push(`${signedIn}/${id}`); },
      deletePc: async () => { mine(); directory.push("deletePc"); },
      session: async () => { await held.session; return signedIn === null ? undefined : { account: signedIn }; },
      forSignIn: (session: { account: string }) => service(session.account),
    } as unknown as AccountService;
  };
  /** holds what is read through `held` until the function returned is called */
  const hold = (what: "listPcs" | "session"): (() => void) => {
    let release!: () => void;
    held[what] = new Promise<void>((done) => { release = done; });
    return () => { held[what] = null; release(); };
  };

  beforeEach(() => {
    renderers = [];
    pc = { account: null, enrolling: false, linkError: null, statusDown: false, offer: offerOf(publicKey, "desk"), hang: null };
    signedIn = ACCOUNT;
    asked = [];
    directory = [];
    puts = [];
    held = { listPcs: null, session: null };
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
      if (path === "/api/account/status" && pc.statusDown) return Response.json({ error: { code: "internal", message: "restarting" } }, { status: 503 });
      if (path === "/api/account/status") return Response.json({ account: pc.account, unlinked: [], removals: [], adds: [], blocked: [], enrolling: pc.enrolling });
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
  const mount = async (): Promise<ReactTestRenderer> => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(createElement(SettingsProvider, { children: createElement(AddThisPc, { service: unbound }) })); });
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
    expect(new Set(asked.map((request) => request.path))).toEqual(new Set(["/api/account/status", "/api/relay/link", "/api/account/relay-account"]));
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

  test("an address that now answers for another PC ends the wait kept for the first, with nothing listed", async () => {
    tab.set(MARKER, kept(60_000));
    pc.offer = offerOf(otherKey, "laptop");
    const renderer = await mount();
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(tab.has(MARKER)).toBe(false);
    expect(links()).toBe(1);
    await advance(RELIST_MS + REOPEN_MS);
    expect(links()).toBe(1);
    expect(directory).toEqual([]);
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

  test("Stop waiting returns to the offer, forgets the wait and reopens nothing more", async () => {
    const renderer = await waitingFrom();
    await press(renderer, "Stop waiting");
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(tab.has(MARKER)).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    const stopped = asked.length;
    await advance(REOPEN_MS * 2);
    expect(asked.length).toBe(stopped);
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

  test("works without a tab storage, only not resumed", async () => {
    Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new Error("blocked"); } });
    const renderer = await waitingFrom();
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    await advance(REOPEN_MS);
    expect(links()).toBe(2);
  });
});
