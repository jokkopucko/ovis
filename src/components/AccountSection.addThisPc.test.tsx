import { afterAll, afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { unitHerdrOnly } from "../../scripts/test-herdr.ts";
import { pairingPc } from "../../server/account/pairing.test-helpers.ts";
import { handleRelayRequest } from "../../server/relay/routes.ts";
import { exportPublicKey, generateKeyPair, importPublicKey } from "../../shared/relay-e2ee.ts";
import { decodeOffer, encodeOffer } from "../../shared/relay-offer.ts";
import type { ListAddState } from "../../shared/machines.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { CLOSE_ANSWER_MS, listNumberHeld, NAMING_MS } from "../lib/account/addThisPc.ts";
import { AccountServiceError, SignedOutError, type AccountService } from "../lib/account/service.ts";
import type { AccountSession } from "../lib/account/store.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";
import { ADDED_POLL_MS, ADDING_MS, AddThisPc, ANSWER_MS, REOPEN_MS, SIGNED_IN_RETRY_MS, WAITING_MS, type SignInAgain } from "./AccountSection.tsx";

// the real PC of realRelay reads no herdr: its status reads would put their timeouts on this suite's fake timer queue
afterAll(unitHerdrOnly());

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
    role: "drive" | "watch";
    healthId?: string | null;
    /** in its account, following its list with no key of its own in it (it came in as the account moved) */
    needsKeys?: boolean;
  };
  let signedIn: string | null;
  /** which sign-in of that account is stored: a sign-in again, or another one, stores the next */
  let signInNo: number;
  /** whether the account service admits this PC in one press (a fresh two-step sign-in), and what the PC answers the press with */
  /** `refusal`: the code the account service refuses a press with while `admits` is false */
  let onePress: { admits: boolean; pcStatus: number; opensAll: boolean; refusal: string };
  let admitted: string[];
  let asked: { path: string; localOnly: boolean }[];
  let directory: string[];
  let page: { hidden: boolean; events: EventTarget };
  let tab: Map<string, string>;
  let restore: (() => void)[];
  let puts: string[];
  /** what the account service answers a PUT with instead of listing the PC; null: it lists it */
  let putRefusal: AccountServiceError | null;
  /** the PCs the account lists, as GET /v1/pcs answers; null: none (the default, which no wait reads as a decline) */
  let listedNow: string[] | null;
  let relayRequest: ((path: string, init?: RequestInit) => Promise<Response>) | null;
  /**
   * this PC's add by the account's signed list (/api/account/list/add…): null answers 404, as a PC that follows no list;
   * `start`: what a POST answers (a state, or a refusal), after `started` ran; `now`: what a read answers; `calls`: what
   * was asked of it, in order, with the account this PC was named (POST /api/account/relay-account) at that moment
   */
  let byList: {
    start: ListAddState | { status: number; code: string }; started?: () => void | Promise<void>; now: ListAddState | null;
    calls: { what: string; body: Record<string, unknown> | null; named: string | null }[];
  } | null;
  let namedAs: string | null;
  /** this PC never answers a naming of its account (POST /api/account/relay-account) */
  let hangNaming: boolean;
  const loopbackFetch = globalThis.fetch;
  let held: { listPcs: Promise<void> | null; putPc: Promise<void> | null; session: Promise<void> | null; link: Promise<void> | null; start: Promise<void> | null; close: Promise<void> | null; press: Promise<void> | null };
  /** the account service; `bound` is the account of the one sign-in it acts for (forSignIn), which refuses once another is stored */
  const service = (bound?: string, boundSignIn?: string): AccountService => {
    const mine = (): void => { if (bound !== undefined && (signedIn !== bound || (boundSignIn !== undefined && boundSignIn !== `r-${signInNo}`))) throw new SignedOutError(); };
    return {
      listPcs: async () => { mine(); await held.listPcs; return (listedNow ?? []).map((id) => ({ server_id: id, label: "desk", added_at: new Date(at).toISOString(), last_seen_at: null, public_key: null, relay: null, new_until: null, admitted_at: null, admitted_before_you: false })); },
      putPc: async (id: string) => { mine(); directory.push("putPc"); puts.push(`${signedIn}/${id}`); await held.putPc; if (putRefusal !== null) throw putRefusal; },
      deletePc: async () => { mine(); directory.push("deletePc"); },
      admitPc: async () => { mine(); admitted.push(signedIn ?? ""); if (!onePress.admits) throw new AccountServiceError(403, onePress.refusal, "The sign-in was refused"); return { account: signedIn, new_until: new Date(at + 86_400_000).toISOString() }; },
      session: async () => { await held.session; return signedIn === null ? undefined : { account: signedIn, refresh_token: `r-${signInNo}` }; },
      forSignIn: (session: { account: string; refresh_token?: string }) => service(session.account, session.refresh_token),
    } as unknown as AccountService;
  };
  const hold = (what: "listPcs" | "putPc" | "session" | "link" | "start" | "close" | "press"): (() => void) => {
    let release!: () => void;
    held[what] = new Promise<void>((done) => { release = done; });
    return () => { held[what] = null; release(); };
  };

  beforeEach(() => {
    renderers = [];
    pc = { account: null, enrolling: false, linkError: null, statusDown: false, offer: offerOf(publicKey, "desk"), hang: null, relay: "on", blocked: null, start: "ok", closeMissing: false, gate: "closed", via: "loopback", paired: false, cookieSticks: true, healthDown: false, role: "drive" };
    signedIn = ACCOUNT;
    signInNo = 0;
    onePress = { admits: false, pcStatus: 200, opensAll: true, refusal: "session_not_fresh" };
    admitted = [];
    asked = [];
    directory = [];
    puts = [];
    putRefusal = null;
    listedNow = null;
    relayRequest = null;
    byList = null;
    namedAs = null;
    hangNaming = false;
    held = { listPcs: null, putPc: null, session: null, link: null, start: null, close: null, press: null };
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
      const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost");
      if (url.hostname === "127.0.0.1" && url.port !== "") return loopbackFetch(input, init);
      const path = url.pathname;
      asked.push({ path, localOnly: new Headers(init?.headers).get("x-ovis-local-only") === "1" });
      if (pc.hang === path) { pc.hang = null; return new Promise<Response>(() => {}); }
      if (path === "/api/account/status" && pc.via === "open") return Response.json({ error: { code: "owner_only", message: "Manage the account from this PC itself, or from a paired device." } }, { status: 403 });
      if (path === "/api/relay/link") await held.link;
      if (path === "/api/relay/start") await held.start;
      if (path === "/api/relay/link/close") await held.close;
      if (relayRequest !== null && (path === "/api/relay/link" || path === "/api/relay/link/close")) return relayRequest(path, init);
      if (path === "/api/account/status" && pc.statusDown) return Response.json({ error: { code: "internal", message: "restarting" } }, { status: 503 });
      if (path === "/api/account/status") return Response.json({ account: pc.account, unlinked: [], removals: [], adds: [], blocked: [], enrolling: pc.enrolling,
        ...(pc.needsKeys === true ? { list: { pinned_list: "f".repeat(64), standing: "in", reason: "no key of its own", needs_keys: true } } : {}) });
      if (path === "/api/relay/start" && pc.start === "broken") return Response.json({ error: { code: "internal", message: "broken" } }, { status: 500 });
      if (path === "/api/relay/start" && pc.start === "off") return Response.json({ phase: "off", relay: "wss://relay.ovis.sh", app: "https://app.ovis.sh", sessions: 0, blocked: null, error: null });
      if (path === "/api/relay/start") {
        if (pc.blocked === null) pc.relay = "on";
        return Response.json({ phase: pc.relay === "on" ? "connecting" : "off", relay: "wss://relay.ovis.sh", app: "https://app.ovis.sh", sessions: 0, blocked: pc.blocked, error: null }, { status: pc.blocked === null ? 200 : 409 });
      }
      if (path === "/api/relay/link/close" && !pc.closeMissing) return Response.json({ ok: true });
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
      if (path === "/api/account/relay-account") namedAs = typeof body?.account === "string" ? body.account : null;
      if (path === "/api/account/relay-account" && hangNaming) return new Promise<Response>(() => {});
      if (byList !== null && path.startsWith("/api/account/list/add")) {
        byList.calls.push({ what: `${init?.method ?? "GET"} ${path}${url.search}`, body, named: namedAs });
        if (path === "/api/account/list/add/cancel") return Response.json(byList.now = { state: "ended", run: String(body?.run), account: ACCOUNT, why: "cancelled" });
        if (path === "/api/account/list/add/confirm") {
          const shown = byList.now;
          if (shown?.state !== "number" || shown.digits !== body?.digits || shown.run !== body?.run) return Response.json({ error: { code: "wrong_number", message: "not that number" } }, { status: 409 });
          return Response.json(byList.now = { state: "confirmed", run: shown.run, account: shown.account, list: shown.list, until: shown.until });
        }
        if (init?.method !== "POST") return Response.json(byList.now ?? { state: "none" });
        await byList.started?.();
        const start = byList.start;
        if ("code" in start) return Response.json({ error: { code: start.code, message: "refused" } }, { status: start.status });
        // a start that answers no_list leaves the PC holding no run: a read by the run asked before answers `replaced`
        byList.now = "run" in start ? start : { state: "replaced" };
        return Response.json(start);
      }
      if (path === "/api/account/relay-account" && onePress.admits) return new Response(null, { status: 204 });
      if (path === "/api/account/one-press") {
        await held.press;
        if (onePress.pcStatus !== 200) return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: onePress.pcStatus });
        pc.account = ACCOUNT;
        return Response.json({ account: ACCOUNT });
      }
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
      if (path === "/api/relay/link") return pc.linkError === null ? Response.json({ url: pc.offer, window_id: links().toString(16).padStart(32, "0") }) : Response.json({ error: { code: pc.linkError.code, message: "refused" } }, { status: pc.linkError.status });
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
  const settle = async (): Promise<void> => { await act(async () => { for (let turn = 0; turn < 200; turn++) await Promise.resolve(); }); };
  const advance = async (ms: number): Promise<void> => { act(() => { jest.advanceTimersByTime(ms); }); await settle(); };
  const mount = async (signedInAs: string | null = null, adds = true): Promise<ReactTestRenderer> => {
    let renderer!: ReactTestRenderer;
    let fresh = signedInAs === null ? null : { account: signedInAs, adds };
    const signedInHere = (): { account: string; adds: boolean } | null => { const taken = fresh; fresh = null; return taken; };
    act(() => { renderer = create(createElement(SettingsProvider, { children: createElement(AddThisPc, { service: unbound, signedInHere, opensAll: () => onePress.opensAll }) })); });
    renderers.push(renderer);
    await settle();
    return renderer;
  };
  const words = (renderer: ReactTestRenderer): string => {
    const text = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(text).join("");
    return renderer.root.findAll((node) => node.type === "p").map(text).join("\n");
  };
  /** a button as these tests name it: the relay-off offer reads like the plain one, and is told apart by its mark */
  const named = (node: ReactTestInstance): string => `${node.children.join("")}${node.props["data-relay"] === "off" ? " (relay off)" : ""}`;
  const press = async (renderer: ReactTestRenderer, label: string): Promise<void> => {
    const button = renderer.root.find((node) => node.type === "button" && named(node) === label);
    act(() => { (button.props as { onClick: () => void }).onClick(); });
    await settle();
  };
  const buttons = (renderer: ReactTestRenderer): string[] => renderer.root.findAll((node) => node.type === "button").map(named);
  const links = (): number => asked.filter((request) => request.path === "/api/relay/link").length;
  const show = (hidden: boolean): void => { page.hidden = hidden; act(() => { page.events.dispatchEvent(new Event("visibilitychange")); }); };
  const waitingFrom = async (): Promise<ReactTestRenderer> => {
    const renderer = await mount();
    await press(renderer, "Add this PC to my account");
    return renderer;
  };

  async function realRelay() {
    // Keep the fixture server's background tasks off the browser's fake timer queue.
    jest.useRealTimers();
    const fixture = await pairingPc();
    jest.useFakeTimers();
    jest.setSystemTime(new Date(at));
    const { context } = fixture.app;
    const base = `http://127.0.0.1:${fixture.app.port}`;
    relayRequest = (path, init) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", base);
      return handleRelayRequest(new Request(base + path, { ...init, headers }), path, context, null, true, true);
    };
    pc.healthId = context.services.relay.currentIdentity()?.server_id ?? null;
    return {
      approvals: context.services.relay.approvals,
      copyLink: () => fixture.local("/api/relay/link", { method: "POST", headers: { "x-herdr-update": "1" } }),
      close: fixture.close,
    };
  }

  test("after the press it says what to do on any signed-in device, and keeps the wait for a reload", async () => {
    const renderer = await waitingFrom();
    expect(words(renderer)).toContain("On another device of your account, choose Add on desk.");
    expect(words(renderer)).toContain("On another device of your account, choose Add on desk.");
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    expect(directory).toEqual(["putPc"]);
    expect(JSON.parse(tab.get(MARKER)!)).toEqual({ name: "desk", until: at + WAITING_MS, serverId: SERVER, account: ACCOUNT, listedAt: at });
  });

  test("one press: when the account service admits this PC, the press adds it with no digits and no wait", async () => {
    onePress.admits = true;
    const renderer = await waitingFrom();
    expect(words(renderer)).toContain("Added");
    expect(words(renderer)).not.toContain("On another device of your account, choose Add on desk.");
    expect([directory, admitted]).toEqual([["putPc"], [ACCOUNT]]);
    expect(asked.map((request) => request.path)).toContain("/api/account/one-press");
    // the window the listing opened is closed again, and no wait is kept for a reload
    expect(asked.map((request) => request.path)).toContain("/api/relay/link/close");
    expect(tab.has(MARKER)).toBe(false);
    await advance(REOPEN_MS);
    expect(links()).toBe(1);
  });

  test("a one press that answers after its attempt was given up clears no wait and closes no window a newer attempt owns", async () => {
    onePress.admits = true;
    const release = hold("press");
    const renderer = await mount(ACCOUNT);
    await advance(ADDING_MS);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    // a newer press waits with digits: its wait is kept, its window open
    onePress.admits = false;
    await press(renderer, "Add this PC to my account");
    expect(tab.has(MARKER)).toBe(true);
    const closes = asked.filter((request) => request.path === "/api/relay/link/close").length;
    onePress.pcStatus = 200;
    release();
    await settle();
    expect(tab.has(MARKER)).toBe(true);
    expect(asked.filter((request) => request.path === "/api/relay/link/close").length).toBe(closes);
    expect(words(renderer)).toContain("On another device of your account, choose Add on desk.");
  });

  test("PADD-5: a one-press success tells its owner once, so the account's list is read again", async () => {
    onePress.admits = true;
    let renderer!: ReactTestRenderer;
    let told = 0;
    act(() => { renderer = create(createElement(SettingsProvider, { children: createElement(AddThisPc, { service: unbound, signedInHere: () => null, onListed: () => { told++; }, opensAll: () => onePress.opensAll }) })); });
    renderers.push(renderer);
    await settle();
    await press(renderer, "Add this PC to my account");
    expect(words(renderer)).toContain("Added");
    expect(told).toBe(1);
  });

  test("one press refused by the account service (no two-step sign-in, a stale sign-in, the daily cap) keeps today's digit wait, and the PC is never asked", async () => {
    const renderer = await waitingFrom();
    expect([directory, admitted]).toEqual([["putPc"], [ACCOUNT]]);
    expect(asked.map((request) => request.path)).not.toContain("/api/account/one-press");
    expect(words(renderer)).toContain("On another device of your account, choose Add on desk.");
  });

  describe("sign in again from the wait", () => {
    const WAIT = "On another device of your account, choose Add on desk.";
    const OFFER = "Sign in again now to add it right away.";
    /**
     * this page's own sign-in again, as these tests make it: `comes` says what the fresh sign-in comes to (a two-step
     * one or a plain one stored in the old one's place, another account's stored nowhere, a failure, no end yet, a
     * two-step one held until `release`, or a two-step one that another sign-in of the account replaces at once)
     */
    let comes: "two-step" | "plain" | "other" | "fail" | "open" | "held" | "replaced";
    let calls: { account: string; signal: AbortSignal }[];
    let installs: number;
    let release: () => void;
    /** stores the fresh sign-in in the old one's place, only while it is still wanted at that write */
    const install = (wanted: () => boolean): AccountSession | null => {
      if (!wanted()) return null;
      installs++;
      signInNo++;
      return { account: ACCOUNT, refresh_token: `r-${signInNo}` } as AccountSession;
    };
    const signInAgain: SignInAgain = (from, { signal, wanted }) => {
      calls.push({ account: from.account, signal });
      switch (comes) {
        case "two-step": onePress.admits = true; return Promise.resolve(install(wanted));
        case "plain": return Promise.resolve(install(wanted));
        case "other": return Promise.resolve(null);
        case "fail": return Promise.reject(new Error("no sign-in"));
        case "open": return new Promise<AccountSession | null>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError"))));
        case "held": return new Promise<AccountSession | null>((done) => { release = () => { onePress.admits = true; done(install(wanted)); }; });
        case "replaced": {
          onePress.admits = true;
          const fresh = install(wanted);
          signInNo++;
          return Promise.resolve(fresh);
        }
      }
    };
    const waitingWithOffer = async (): Promise<ReactTestRenderer> => {
      let renderer!: ReactTestRenderer;
      act(() => { renderer = create(createElement(SettingsProvider, { children: createElement(AddThisPc, { service: unbound, signedInHere: () => null, opensAll: () => onePress.opensAll, signInAgain }) })); });
      renderers.push(renderer);
      await settle();
      await press(renderer, "Add this PC to my account");
      return renderer;
    };
    beforeEach(() => { comes = "two-step"; calls = []; installs = 0; });
    const pressedOnce = (renderer: ReactTestRenderer): void => {
      expect(admitted).toEqual([ACCOUNT]);
      expect(asked.map((request) => request.path)).not.toContain("/api/account/one-press");
      expect(words(renderer)).not.toContain("Added");
    };

    test("Stop waiting in another copy of the screen while the sign-in is out: the fresh sign-in is not stored and nothing is pressed", async () => {
      comes = "held";
      const renderer = await waitingWithOffer();
      const other = await mount();
      expect(buttons(other)).toEqual(["Stop waiting"]);
      await press(renderer, "Sign in again");
      await press(other, "Stop waiting");
      act(() => { release(); });
      await settle();
      expect(installs).toBe(0);
      pressedOnce(renderer);
    });

    test("Stop waiting in another copy before Sign in again is pressed here: no sign-in starts, nothing is stored or pressed", async () => {
      const renderer = await waitingWithOffer();
      const other = await mount();
      await press(other, "Stop waiting");
      // this copy has not polled since: it still shows the offer, and the press finds the wait gone
      await press(renderer, "Sign in again");
      await settle();
      expect(installs).toBe(0);
      pressedOnce(renderer);
      expect(words(renderer)).not.toContain("Added");
      expect(buttons(renderer)).not.toContain("Sign in again");
    });

    test("a screen closed while its sign-in again is out stores nothing and presses nothing", async () => {
      comes = "held";
      const renderer = await waitingWithOffer();
      await press(renderer, "Sign in again");
      act(() => { renderer.unmount(); });
      act(() => { release(); });
      await settle();
      expect(installs).toBe(0);
      // the screen is gone: what reached the service and the PC says it all (only the first, refused press)
      expect(admitted).toEqual([ACCOUNT]);
      expect(asked.map((request) => request.path)).not.toContain("/api/account/one-press");
    });

    test("another sign-in of the account stored after the fresh one: the retry presses with no sign-in but the fresh one", async () => {
      comes = "replaced";
      const renderer = await waitingWithOffer();
      await press(renderer, "Sign in again");
      expect(installs).toBe(1);
      pressedOnce(renderer);
      expect(words(renderer)).toContain(WAIT);
    });

    test("the address answers for another PC once the sign-in is back: nothing is listed or pressed for that PC", async () => {
      comes = "held";
      const renderer = await waitingWithOffer();
      await press(renderer, "Sign in again");
      pc.offer = offerOf(otherKey, "other");
      act(() => { release(); });
      await settle();
      expect(puts).toEqual([`${ACCOUNT}/${SERVER}`]);
      pressedOnce(renderer);
      expect(buttons(renderer)).toEqual(["Stop waiting"]);
    });

    test("a listing refused for an old sign-in with no key offers Sign in again here, then lists and adds with the fresh one", async () => {
      putRefusal = new AccountServiceError(403, "session_not_fresh", "Sign in again on this device first");
      let renderer!: ReactTestRenderer;
      act(() => { renderer = create(createElement(SettingsProvider, { children: createElement(AddThisPc, { service: unbound, signedInHere: () => null, opensAll: () => onePress.opensAll, signInAgain }) })); });
      renderers.push(renderer);
      await settle();
      await press(renderer, "Add this PC to my account");
      expect(words(renderer)).toContain("Sign in again to add it: your sign-in is more than ten minutes old.");
      expect(words(renderer)).not.toContain("This PC could not be listed in your account. Try again.");
      expect(buttons(renderer)).toEqual(["Sign in again"]);
      expect(admitted).toEqual([]);
      // the fresh sign-in lists the PC, and its one press adds it
      putRefusal = null;
      await press(renderer, "Sign in again");
      expect(calls.map((call) => call.account)).toEqual([ACCOUNT]);
      expect(installs).toBe(1);
      expect(puts).toEqual([`${ACCOUNT}/${SERVER}`, `${ACCOUNT}/${SERVER}`]);
      expect(admitted).toEqual([ACCOUNT]);
      expect(words(renderer)).toContain("Added");
    });

    test("a Sign in again for a refused listing that does not finish says so and offers it again", async () => {
      putRefusal = new AccountServiceError(403, "session_not_fresh", "Sign in again on this device first");
      comes = "fail";
      let renderer!: ReactTestRenderer;
      act(() => { renderer = create(createElement(SettingsProvider, { children: createElement(AddThisPc, { service: unbound, signedInHere: () => null, opensAll: () => onePress.opensAll, signInAgain }) })); });
      renderers.push(renderer);
      await settle();
      await press(renderer, "Add this PC to my account");
      await press(renderer, "Sign in again");
      expect(words(renderer)).toContain("The sign-in did not finish. Try again.");
      expect(buttons(renderer)).toEqual(["Sign in again"]);
      expect(puts).toEqual([`${ACCOUNT}/${SERVER}`]);
    });

    test("a one press refused for the sign-in itself offers to sign in again, beside Stop waiting", async () => {
      const renderer = await waitingWithOffer();
      expect(words(renderer)).toContain(WAIT);
      expect(words(renderer)).toContain(OFFER);
      expect(buttons(renderer)).toEqual(["Sign in again", "Stop waiting"]);
      expect(calls).toEqual([]);
    });

    test("a fresh two-step sign-in adds the PC in one press, under the same account", async () => {
      const renderer = await waitingWithOffer();
      await press(renderer, "Sign in again");
      expect(calls.map((call) => call.account)).toEqual([ACCOUNT]);
      expect(admitted).toEqual([ACCOUNT, ACCOUNT]);
      expect(asked.map((request) => request.path)).toContain("/api/account/one-press");
      expect(words(renderer)).toContain("Added");
      expect(tab.has(MARKER)).toBe(false);
    });

    const NO_TWO_STEP = "This sign-in has no two-step sign-in.";
    const OTHER_WAYS = "Add this PC from another device of your account and approve the number it shows here, or scan this PC's QR code with your phone.";
    const TURN_ON = "To add it in one press, turn on two-step sign-in with your sign-in provider and sign in again.";

    test("a sign-in without two-step is told so and what works, and is offered no sign-in again", async () => {
      onePress.refusal = "two_step_required";
      const renderer = await waitingWithOffer();
      expect(admitted).toEqual([ACCOUNT]);
      expect(words(renderer)).toContain(WAIT);
      expect(words(renderer)).toContain(`${NO_TWO_STEP} ${OTHER_WAYS} ${TURN_ON}`);
      expect(words(renderer)).not.toContain(OFFER);
      expect(buttons(renderer)).toEqual(["Stop waiting"]);
      expect(calls).toEqual([]);
    });

    test.each([
      ["still refused as not fresh", "session_not_fresh", `This PC was not added in one press. ${OTHER_WAYS}`],
      ["found to have no two-step", "two_step_required", `${NO_TWO_STEP} ${OTHER_WAYS} ${TURN_ON}`],
    ] as const)("a fresh sign-in that is %s goes back to the wait with no second offer, and says why", async (_case, refusal, said) => {
      comes = "plain";
      const renderer = await waitingWithOffer();
      onePress.refusal = refusal;
      await press(renderer, "Sign in again");
      expect(admitted).toEqual([ACCOUNT, ACCOUNT]);
      expect(words(renderer)).toContain(WAIT);
      expect(words(renderer)).toContain(said);
      expect(words(renderer)).not.toContain(OFFER);
      expect(buttons(renderer)).toEqual(["Stop waiting"]);
    });

    test("another account's sign-in adds nothing: the plain wait goes on", async () => {
      comes = "other";
      const renderer = await waitingWithOffer();
      await press(renderer, "Sign in again");
      expect(admitted).toEqual([ACCOUNT]);
      expect(words(renderer)).toContain(WAIT);
      expect(words(renderer)).not.toContain(OFFER);
      expect(buttons(renderer)).toEqual(["Stop waiting"]);
    });

    test("a failed sign-in adds nothing: the plain wait goes on, and the failure is said", async () => {
      comes = "fail";
      const failed = await waitingWithOffer();
      await press(failed, "Sign in again");
      expect(admitted).toEqual([ACCOUNT]);
      expect(words(failed)).toContain(WAIT);
      expect(words(failed)).toContain("The sign-in did not finish. Try again.");
      expect(buttons(failed)).toEqual(["Stop waiting"]);
    });

    test("Stop waiting still stops, also while the sign-in again is under way, which then adds nothing", async () => {
      comes = "open";
      const renderer = await waitingWithOffer();
      await press(renderer, "Sign in again");
      expect(words(renderer)).toContain("Finish signing in in your browser.");
      expect(buttons(renderer)).toEqual(["Cancel", "Stop waiting"]);
      await press(renderer, "Stop waiting");
      expect(calls[0]!.signal.aborted).toBe(true);
      expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
      expect(tab.has(MARKER)).toBe(false);
      expect(admitted).toEqual([ACCOUNT]);
    });
  });

  test("a PC whose step-2 switch is off is never tried in one press: the account service is not asked, and the digit wait comes", async () => {
    onePress.admits = true;
    onePress.opensAll = false;
    const renderer = await waitingFrom();
    expect(admitted).toEqual([]);
    expect(asked.map((request) => request.path)).not.toContain("/api/account/one-press");
    expect(words(renderer)).toContain("On another device of your account, choose Add on desk.");
  });

  test("a PC without the one-press route (an older Ovis, or the step-2 switch off) keeps today's digit wait", async () => {
    onePress.admits = true;
    onePress.pcStatus = 404;
    const renderer = await waitingFrom();
    expect(words(renderer)).toContain("On another device of your account, choose Add on desk.");
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
  });

  test("tells its owner once when the press listed the PC, so the account's list is read again", async () => {
    let renderer!: ReactTestRenderer;
    const told: string[][] = [];
    const onListed = (): void => { told.push([...directory]); };
    act(() => { renderer = create(createElement(SettingsProvider, { children: createElement(AddThisPc, { service: unbound, signedInHere: () => null, onListed }) })); });
    renderers.push(renderer);
    await settle();
    expect(told).toEqual([]);
    await press(renderer, "Add this PC to my account");
    expect(told).toEqual([["putPc"]]);
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
    for (let tick = 0; tick < 3; tick++) await advance(REOPEN_MS);
    expect(links()).toBe(5);
    expect(asked.filter((request) => request.path === "/api/relay/link").every((request) => request.localOnly)).toBe(true);
    expect(directory).toEqual(["putPc"]);
    // (and the screen read once, before its offer, what this browser may do on the PC, then before every reopen which PC answers;
    // the one listing asked the PC for its own proof, then, named the account once more, whether it adds itself by the account's list)
    expect(new Set(asked.map((request) => request.path))).toEqual(new Set(["/api/account/status", "/api/health", "/api/relay/link", "/api/account/pc-proof", "/api/account/relay-account", "/api/account/list/add"]));
    expect(asked.filter((request) => request.path === "/api/account/pc-proof").length).toBe(1);
    expect(asked.filter((request) => request.path === "/api/health").length).toBe(5);
    expect(asked.filter((request) => request.path === "/api/account/relay-account").length).toBe(2);
    expect(asked.filter((request) => request.path === "/api/account/list/add").length).toBe(1);
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

  test("a periodic relist that sees the PC bind during its directory read ends the wait without writing", async () => {
    const renderer = await waitingFrom();
    // The hidden page still relists but neither polls membership nor reopens on its own.
    show(true);
    const release = hold("listPcs");
    await advance(RELIST_MS);
    expect(links()).toBe(2);

    pc.account = ACCOUNT;
    release();
    await settle();

    expect(directory).toEqual(["putPc"]);
    expect(words(renderer)).toContain("Added");
    expect(buttons(renderer)).toEqual([]);
    expect(tab.has(MARKER)).toBe(false);
    expect(asked.filter(({ path }) => path === "/api/relay/link" || path === "/api/relay/link/close").map(({ path }) => path))
      .toEqual(["/api/relay/link", "/api/relay/link", "/api/relay/link/close"]);
  });

  test("an Add press closes the window it opened if the PC binds during the directory read", async () => {
    const renderer = await mount();
    const release = hold("listPcs");
    await press(renderer, "Add this PC to my account");
    expect(links()).toBe(1);

    pc.account = ACCOUNT;
    release();
    await settle();

    expect(words(renderer)).toContain("Added");
    expect(directory).toEqual([]);
    expect(tab.has(MARKER)).toBe(false);
    expect(asked.filter(({ path }) => path === "/api/relay/link" || path === "/api/relay/link/close").map(({ path }) => path))
      .toEqual(["/api/relay/link", "/api/relay/link/close"]);
  });

  test("a retry that finds membership leaves an independently opened codeless window open", async () => {
    const relay = await realRelay();
    try {
      const renderer = await mount();
      const release = hold("listPcs");
      await press(renderer, "Add this PC to my account");
      expect(relay.approvals.windowOpen()).toBe(true);

      pc.account = ACCOUNT;
      expect((await relay.copyLink()).status).toBe(200);
      release();
      await settle();

      expect(words(renderer)).toContain("Added");
      expect(relay.approvals.windowOpen()).toBe(true);
    } finally { await relay.close(); }
  });

  test("a periodic relist finding membership closes its window even when session storage is blocked", async () => {
    const relay = await realRelay();
    try {
      Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new Error("blocked"); } });
      const renderer = await waitingFrom();
      expect(buttons(renderer)).toEqual(["Stop waiting"]);
      show(true);
      const release = hold("listPcs");
      await advance(RELIST_MS);
      expect(links()).toBe(2);
      expect(relay.approvals.windowOpen()).toBe(true);

      pc.account = ACCOUNT;
      release();
      await settle();

      expect(words(renderer)).toContain("Added");
      expect(relay.approvals.windowOpen()).toBe(false);
    } finally { await relay.close(); }
  });

  test("says by itself that the PC is in the account once a device added it, and then asks nothing more", async () => {
    const renderer = await waitingFrom();
    await advance(ADDED_POLL_MS);
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    pc.account = ACCOUNT;
    await advance(ADDED_POLL_MS);
    expect(words(renderer)).toContain("Added");
    expect(words(renderer)).not.toContain("acct_");
    expect(buttons(renderer)).toEqual([]);
    expect(tab.has(MARKER)).toBe(false);
    const before = asked.length;
    await advance(WAITING_MS);
    expect(asked.length).toBe(before);
    expect(jest.getTimerCount()).toBe(0);
    expect(words(renderer)).toContain("Added");
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
    expect(words(renderer)).toContain("Added");
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
    pc.healthId = undefined;
    await advance(ADDED_POLL_MS);
    expect(words(renderer)).toContain("Added");
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

  test("a PC already in the signed-in account shows Added without opening or listing", async () => {
    pc.account = ACCOUNT;
    const renderer = await mount();
    expect(words(renderer)).toContain("Added");
    expect(buttons(renderer)).toEqual([]);
    expect(links()).toBe(0);
    expect(directory).toEqual([]);
  });

  test.each(["acct_other", null])("a bound PC shows no add status when signed in as %s", async (account) => {
    pc.account = ACCOUNT;
    signedIn = account;
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
    expect(words(renderer).split("\n")[0]).toBe("On another device of your account, choose Add on desk.");
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
    await advance(RELIST_MS - 4 * REOPEN_MS);
    expect(directory).toEqual(["putPc", "putPc"]);
    await advance(WAITING_MS);
    expect(buttons(renderer)).toEqual(["Keep waiting"]);
    expect(tab.has(MARKER)).toBe(false);
    const opened = links();
    await advance(REOPEN_MS * 2);
    expect(links()).toBe(opened);
  });

  test("a request another device of the account denied ends the wait: not added, not listed again, and asked anew only by a press", async () => {
    listedNow = [SERVER];
    const renderer = await mount(ACCOUNT);
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    await advance(REOPEN_MS);
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    // Deny on the phone removed the listing
    listedNow = [];
    await advance(REOPEN_MS);
    expect(words(renderer)).toContain("Another device of your account declined adding this PC.");
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    expect(tab.has(MARKER)).toBe(false);
    await advance(RELIST_MS);
    expect(directory).toEqual(["putPc"]);
    await press(renderer, "Add this PC to my account");
    expect(directory).toEqual(["putPc", "putPc"]);
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

  test("a sign-in that just finished on a PC already in that account shows Added and lists nothing", async () => {
    pc.account = ACCOUNT;
    const renderer = await mount(ACCOUNT);
    expect(words(renderer)).toContain("Added");
    expect(buttons(renderer)).toEqual([]);
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
    expect(directory).toEqual(["putPc"]);
    expect(links()).toBe(2);
    await press(settings, "Stop waiting");
    await advance(REOPEN_MS);
    expect(buttons(welcome)).toEqual(["Add this PC to my account"]);
    expect(directory).toEqual(["putPc"]);
  });

  test("another copy that began a wait while the sign-in was read is joined: the PC is listed once", async () => {
    const release = hold("session");
    const welcome = await mount(ACCOUNT);
    expect(welcome.toJSON()).toBeNull();
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
    expect(buttons(renderer)).toEqual(["Add this PC to my account (relay off)"]);
    expect(words(renderer)).toBe("");
    expect(words(renderer)).not.toContain("closes the device gate");
    expect(asked.some((request) => request.path === "/api/relay/start")).toBe(false);
    expect(directory).toEqual([]);
    expect(tab.has(MARKER)).toBe(false);

    await press(renderer, "Add this PC to my account (relay off)");
    expect(asked.filter((request) => request.path === "/api/relay/start").length).toBe(1);
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    expect(directory).toEqual(["putPc"]);
    expect(asked.filter((request) => request.path === "/api/relay/link").every((request) => request.localOnly)).toBe(true);
    const paths = asked.map((request) => request.path);
    expect(paths.indexOf("/api/relay/start")).toBeLessThan(paths.lastIndexOf("/api/relay/link"));
  });

  test("the relay-and-add button leaves the relay off when the PC has since bound", async () => {
    pc.relay = "off";
    const renderer = await mount(ACCOUNT, false);
    pc.account = ACCOUNT;

    await press(renderer, "Add this PC to my account (relay off)");

    expect(asked.filter(({ path }) => path === "/api/relay/start")).toEqual([]);
    expect(words(renderer)).toContain("Added");
    expect(links()).toBe(0);
    expect(directory).toEqual([]);
  });

  test("a copy offering the relay button takes up the wait another copy begins", async () => {
    pc.relay = "off";
    const welcome = await mount(ACCOUNT);
    expect(buttons(welcome)).toEqual(["Add this PC to my account (relay off)"]);
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
    await press(renderer, "Add this PC to my account (relay off)");
    expect(words(renderer)).toContain("Blocked: OVIS_TAILSCALE_SERVE_ONLY says tailscale serve is the only way in.");
    expect(buttons(renderer)).toEqual(["Add this PC to my account (relay off)"]);
    expect(directory).toEqual([]);
    expect(tab.has(MARKER)).toBe(false);
  });

  test("a browser in only because the device gate is open pairs itself before the relay closes that gate", async () => {
    pc.relay = "off";
    pc.gate = "open";
    const renderer = await mount(ACCOUNT);
    // the PC refuses such a browser its account, so the button is never offered to one: this one came to be in that way since
    pc.via = "open";
    await press(renderer, "Add this PC to my account (relay off)");
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
    await press(renderer, "Add this PC to my account (relay off)");
    expect(asked.some((request) => request.path.startsWith("/api/devices"))).toBe(false);
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
  });

  test("a browser whose pairing did not stick leaves the relay off, says so, and nothing is listed", async () => {
    pc.relay = "off";
    pc.gate = "open";
    pc.cookieSticks = false;
    const renderer = await mount(ACCOUNT);
    pc.via = "open";
    await press(renderer, "Add this PC to my account (relay off)");
    expect(words(renderer)).toContain("Could not confirm this browser is paired. Check that cookies are enabled, then try again.");
    expect(asked.some((request) => request.path === "/api/relay/start")).toBe(false);
    expect(buttons(renderer)).toEqual(["Add this PC to my account (relay off)"]);
    expect(links()).toBe(1);
    expect(directory).toEqual([]);
  });

  test("the relay is not turned on while how this browser is in cannot be read", async () => {
    pc.relay = "off";
    const renderer = await mount(ACCOUNT);
    pc.healthDown = true;
    await press(renderer, "Add this PC to my account (relay off)");
    expect(words(renderer)).toContain("The relay could not be turned on. Try again.");
    expect(asked.some((request) => request.path === "/api/relay/start")).toBe(false);
    expect(buttons(renderer)).toEqual(["Add this PC to my account (relay off)"]);
  });

  for (const start of ["off", "broken"] as const) {
    test(`a relay start that ${start === "off" ? "leaves the relay off" : "fails"} says so, keeps the button and lists nothing`, async () => {
      pc.relay = "off";
      pc.start = start;
      const renderer = await mount(ACCOUNT);
      const opened = links();
      await press(renderer, "Add this PC to my account (relay off)");
      expect(asked.filter((request) => request.path === "/api/relay/start").length).toBe(1);
      const alerts = renderer.root.findAll((node) => node.type === "p" && (node.props as { role?: string }).role === "alert").map((node) => node.children.join(""));
      expect(alerts).toEqual(["The relay could not be turned on. Try again."]);
      expect(buttons(renderer)).toEqual(["Add this PC to my account (relay off)"]);
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
    expect(buttons(renderer)).toEqual(["Add this PC to my account (relay off)"]);
    signedIn = "acct_someone_else";
    await press(renderer, "Add this PC to my account (relay off)");
    expect(asked.some((request) => request.path === "/api/relay/start")).toBe(false);
    expect(puts).toEqual([]);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
  });

  test("another sign-in stored while the relay was starting: the relay button lists nothing under it", async () => {
    pc.relay = "off";
    const renderer = await mount(ACCOUNT);
    const release = hold("start");
    await press(renderer, "Add this PC to my account (relay off)");
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
    release();
    await settle();
    expect(puts).toEqual([]);
    expect(tab.has(MARKER)).toBe(false);
    expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    await press(renderer, "Add this PC to my account");
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
    expect(puts).toEqual([`${ACCOUNT}/${SERVER}`]);
  });

  test("a PC that left the account (ovis logout) and gave no proof of its own here says to sign in on the PC", async () => {
    putRefusal = new AccountServiceError(409, "pc_left", "This PC left the account; sign in on the PC to add it again");
    const renderer = await mount(ACCOUNT);
    await settle();
    expect(puts).toEqual([`${ACCOUNT}/${SERVER}`]);
    expect(words(renderer)).toContain("Sign in on this PC to add it again");
    expect(words(renderer)).not.toContain("This PC could not be listed in your account. Try again.");
    expect(tab.has(MARKER)).toBe(false);
  });

  test("a listing the account service refuses for an old sign-in with no key to prove says to sign in again, not to try again", async () => {
    putRefusal = new AccountServiceError(403, "session_not_fresh", "Sign in again on this device first");
    const renderer = await mount(ACCOUNT);
    await settle();
    expect(puts).toEqual([`${ACCOUNT}/${SERVER}`]);
    expect(words(renderer)).toContain("Sign in again to add it: your sign-in is more than ten minutes old.");
    expect(words(renderer)).not.toContain("This PC could not be listed in your account. Try again.");
    expect(tab.has(MARKER)).toBe(false);
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
    await press(renderer, "Add this PC to my account (relay off)");
    expect(words(renderer)).toBe("Signed in. Adding this PC to your account…");
    expect(buttons(renderer)).toEqual([]);
    await advance(ADDING_MS);
    expect(buttons(renderer)).toEqual(["Add this PC to my account (relay off)"]);
    expect(words(renderer)).toContain("The relay could not be turned on. Try again.");
    const opened = links();
    release();
    await settle();
    expect(links()).toBe(opened);
    expect(directory).toEqual([]);
    expect(buttons(renderer)).toEqual(["Add this PC to my account (relay off)"]);
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
    expect(words(renderer)).toContain("Added");
    expect(buttons(renderer)).toEqual([]);
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
    const welcome = await waitingFrom();
    const settings = await mount();
    expect(buttons(settings)).toEqual(["Stop waiting"]);
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
    pc.account = ACCOUNT;
    tab.delete(MARKER);
    await advance(ADDED_POLL_MS);
    for (const copy of [welcome, settings]) expect(words(copy)).toContain("Added");
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
    expect(words(renderer)).toContain("Added");
  });

  test("a listing that never gets an answer is tried again", async () => {
    await waitingFrom();
    await advance(RELIST_MS - ADDED_POLL_MS);
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
    expect(words(renderer)).toContain("Not finished yet: the device that added this PC is still setting it up. If it stopped, open this PC on that device and choose Try again.");
    expect(words(renderer)).not.toContain("Added");
    const opened = links();
    await advance(RELIST_MS);
    expect(links()).toBe(opened);
    expect(directory).toEqual(["putPc"]);
    expect(words(renderer)).not.toContain("Added");
    pc.enrolling = false;
    await advance(ADDED_POLL_MS);
    expect(words(renderer)).toContain("Added");
    expect(jest.getTimerCount()).toBe(0);
  });

  test("a reloaded tab finds the PC added but not enrolled yet, and says so until it is", async () => {
    tab.set(MARKER, kept(60_000));
    pc.account = ACCOUNT;
    pc.enrolling = true;
    const renderer = await mount();
    expect(words(renderer)).toContain("the device that added this PC is still setting it up");
    pc.enrolling = false;
    await advance(ADDED_POLL_MS);
    expect(words(renderer)).toContain("Added");
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
    tab.set(MARKER, kept(60_000));
    pc.account = ACCOUNT;
    signedIn = "acct_someone_else";
    expect((await mount()).toJSON()).toBeNull();
    expect(tab.has(MARKER)).toBe(false);
    signedIn = null;
    tab.set(MARKER, kept(60_000));
    expect((await mount()).toJSON()).toBeNull();

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
    expect(words(renderer)).toContain("Added");
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
    expect(words(welcome)).toContain("Added");
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
    await press(renderer, "Add this PC to my account");
    expect(buttons(renderer)).toEqual(["Stop waiting"]);
  });

  test("a sign-in whose button did not say it adds the PC, with the relay off, is offered the one button for both", async () => {
    pc.relay = "off";
    const renderer = await mount(ACCOUNT, false);
    expect(buttons(renderer)).toEqual(["Add this PC to my account (relay off)"]);
    expect(links()).toBe(0);
    expect(asked.some((request) => request.path === "/api/relay/start")).toBe(false);
    await press(renderer, "Add this PC to my account (relay off)");
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
    await press(renderer, "Add this PC to my account (relay off)");
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
    show(true);
    await advance(RELIST_MS - 1);
    const release = hold("link");
    await advance(1);
    expect(links()).toBe(2);
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

  describe("an account that keeps a signed list: the PC starts its add by the list first, as `ovis add` does", () => {
    const RUN = "0123456789abcdef";
    const NEXT = "fedcba9876543210";
    const LIST = "f".repeat(64);
    const WAIT = "On another device of your account, choose Add on desk.";
    const running = (run = RUN): ListAddState => ({ state: "waiting", run, account: ACCOUNT, list: LIST, until: new Date(at + 10 * 60_000).toISOString() });
    const starts = (): number => byList!.calls.filter(({ what }) => what === "POST /api/account/list/add").length;
    const cancels = (): { what: string; body: Record<string, unknown> | null; named: string | null }[] => byList!.calls.filter(({ what }) => what === "POST /api/account/list/add/cancel");
    beforeEach(() => { byList = { start: running(), now: null, calls: [] }; });

    test("the press starts the PC's add under the account named to it just before, and nothing is pressed once", async () => {
      // a one press the account service would admit: on an account with a list it is never asked
      onePress.admits = true;
      const renderer = await waitingFrom();
      expect(byList!.calls[0]).toEqual({ what: "POST /api/account/list/add", body: { account: ACCOUNT }, named: ACCOUNT });
      expect(admitted).toEqual([]);
      expect(asked.map((request) => request.path)).not.toContain("/api/account/one-press");
      expect(words(renderer)).toContain(WAIT);
      expect(buttons(renderer)).toEqual(["Stop waiting"]);
      expect(directory).toEqual(["putPc"]);
      expect(JSON.parse(tab.get(MARKER)!)).toEqual({ name: "desk", until: at + WAITING_MS, serverId: SERVER, account: ACCOUNT, listedAt: at, run: RUN });
    });

    test("a sign-in that just finished here starts the same add, and presses nothing once", async () => {
      onePress.admits = true;
      const renderer = await mount(ACCOUNT);
      expect(starts()).toBe(1);
      expect(admitted).toEqual([]);
      expect(words(renderer)).toContain(WAIT);
    });

    test("Stop waiting gives the PC's add up by its run", async () => {
      const renderer = await waitingFrom();
      await press(renderer, "Stop waiting");
      expect(cancels()).toEqual([{ what: "POST /api/account/list/add/cancel", body: { run: RUN }, named: ACCOUNT }]);
      expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
      expect(tab.has(MARKER)).toBe(false);
    });

    test("a tab reloaded while it waited gives up the run it kept on Stop waiting", async () => {
      tab.set(MARKER, kept(60_000, 60_000, { run: RUN }));
      const renderer = await mount();
      expect(buttons(renderer)).toEqual(["Stop waiting"]);
      expect(starts()).toBe(0);
      await press(renderer, "Stop waiting");
      expect(cancels().map(({ body }) => body)).toEqual([{ run: RUN }]);
    });

    test("no_list: the one press is taken as today, after the PC said the account keeps no list", async () => {
      byList!.start = { state: "no_list", account: ACCOUNT };
      onePress.admits = true;
      const renderer = await waitingFrom();
      expect(words(renderer)).toContain("Added");
      expect(admitted).toEqual([ACCOUNT]);
      const paths = asked.map((request) => request.path);
      expect(paths.indexOf("/api/account/one-press")).toBeGreaterThan(paths.indexOf("/api/account/list/add"));
      expect(tab.has(MARKER)).toBe(false);
    });

    test("no_list with the one press refused: today's digit wait, kept as before with no run", async () => {
      byList!.start = { state: "no_list", account: ACCOUNT };
      const renderer = await waitingFrom();
      expect(words(renderer)).toContain(WAIT);
      expect(admitted).toEqual([ACCOUNT]);
      expect(JSON.parse(tab.get(MARKER)!)).toEqual({ name: "desk", until: at + WAITING_MS, serverId: SERVER, account: ACCOUNT, listedAt: at });
      await advance(ADDED_POLL_MS);
      expect(starts()).toBe(1);
      expect(byList!.calls.map(({ what }) => what)).toEqual(["POST /api/account/list/add"]);
    });

    test("503 account_unavailable: says the account service could not be reached and offers the button again, never one press", async () => {
      byList!.start = { status: 503, code: "account_unavailable" };
      onePress.admits = true;
      const renderer = await waitingFrom();
      expect(words(renderer)).toContain("The account service could not be reached, so this PC was not added. Try again.");
      expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
      expect(admitted).toEqual([]);
      expect(asked.map((request) => request.path)).not.toContain("/api/account/one-press");
      expect(tab.has(MARKER)).toBe(false);
      byList!.start = running();
      await press(renderer, "Add this PC to my account");
      expect(starts()).toBe(2);
      expect(words(renderer)).toContain(WAIT);
    });

    test("409 account_mismatch says so in its own words, and nothing is pressed once", async () => {
      byList!.start = { status: 409, code: "account_mismatch" };
      onePress.admits = true;
      const renderer = await waitingFrom();
      expect(words(renderer)).toContain("This PC was set up for another account. Sign in to that one, or add this PC again.");
      expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
      expect(admitted).toEqual([]);
    });

    test("409 list_removed says the PC comes back only as a new PC", async () => {
      byList!.start = { status: 409, code: "list_removed" };
      const renderer = await waitingFrom();
      expect(words(renderer)).toContain("This PC was removed from this Ovis account. It can come back only as a new PC: on the PC, reset its relay identity, then add it again.");
      expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
      expect(tab.has(MARKER)).toBe(false);
    });

    test("409 in_account from a PC that joined the account meanwhile says Added", async () => {
      byList!.start = { status: 409, code: "in_account" };
      byList!.started = () => { pc.account = ACCOUNT; };
      const renderer = await waitingFrom();
      expect(words(renderer)).toContain("Added");
      expect(buttons(renderer)).toEqual([]);
    });

    describe("a PC in its account that the account's move left with no key of its own in the list", () => {
      const KEYS = "This PC is in your account, but holds no key of its own in your account's list yet: it came in as your account moved, so it cannot let a new device in.";
      const KEYS_WAIT = "On another device of your account, open Manage account → PCs and choose Add for this PC, then compare the number it shows with the one here.";
      beforeEach(() => { pc.account = ACCOUNT; pc.needsKeys = true; });

      test("offers the add for its keys in words of its own, and the press starts the add by the list with nothing listed and no window opened", async () => {
        const renderer = await mount();
        expect(words(renderer)).toContain(KEYS);
        expect(words(renderer)).not.toContain("Added");
        expect(buttons(renderer)).toEqual(["Add this PC to my account's list"]);
        await press(renderer, "Add this PC to my account's list");
        expect(byList!.calls[0]).toEqual({ what: "POST /api/account/list/add", body: { account: ACCOUNT }, named: ACCOUNT });
        expect(words(renderer)).toContain(KEYS_WAIT);
        expect(buttons(renderer)).toEqual(["Stop waiting"]);
        // the device whose number was confirmed signs its keys: the PC holds them, and the window says Added
        byList!.now = { state: "added", run: RUN, account: ACCOUNT, list: LIST };
        pc.needsKeys = false;
        await advance(ADDED_POLL_MS);
        expect(words(renderer)).toContain("Added");
        // nothing of the old way: no listing in the directory, no pairing window, no one press
        expect([directory, links(), admitted]).toEqual([[], 0, []]);
        expect(asked.map((request) => request.path)).not.toContain("/api/account/one-press");
      });

      test("a wait for this PC's add that finds it in the account with no key of its own in the list offers its keys, never Added", async () => {
        pc.account = null;
        pc.needsKeys = false;
        const renderer = await waitingFrom();
        expect(words(renderer)).toContain("On another device of your account, choose Add on desk.");
        // the PC came into the account by a move of its list meanwhile, with no key of its own there
        pc.account = ACCOUNT;
        pc.needsKeys = true;
        await advance(ADDED_POLL_MS);
        expect(words(renderer)).not.toContain("Added");
        expect(words(renderer)).toContain(KEYS);
        expect(buttons(renderer)).toEqual(["Add this PC to my account's list"]);
      });

      test("a second press while the first start of its add is on its way starts nothing and gives up nothing", async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        byList!.started = () => held;
        const renderer = await mount();
        await press(renderer, "Add this PC to my account's list");
        await press(renderer, "Add this PC to my account's list");
        release();
        await settle();
        expect(starts()).toBe(1);
        expect(cancels()).toEqual([]);
        expect(words(renderer)).toContain(KEYS_WAIT);
        expect(buttons(renderer)).toEqual(["Stop waiting"]);
      });

      test("never says Added while this PC still says it needs keys, whatever its add answered: the offer stays", async () => {
        const renderer = await mount();
        await press(renderer, "Add this PC to my account's list");
        byList!.now = { state: "added", run: RUN, account: ACCOUNT, list: LIST };
        await advance(ADDED_POLL_MS);
        expect(words(renderer)).not.toContain("Added");
        expect(words(renderer)).toContain(KEYS);
        expect(buttons(renderer)).toEqual(["Add this PC to my account's list"]);
      });

      test("Stop waiting gives that add up by its run and offers it again; an add the PC ends says why", async () => {
        const renderer = await mount();
        await press(renderer, "Add this PC to my account's list");
        await press(renderer, "Stop waiting");
        expect(cancels().map(({ body }) => body)).toEqual([{ run: RUN }]);
        expect(buttons(renderer)).toEqual(["Add this PC to my account's list"]);
        byList!.now = null;
        await press(renderer, "Add this PC to my account's list");
        byList!.now = { state: "ended", run: RUN, account: ACCOUNT, why: "cancelled" };
        await advance(ADDED_POLL_MS);
        expect(words(renderer)).toContain("The numbers were not the same, so nothing was added.");
        expect(buttons(renderer)).toEqual(["Add this PC to my account's list"]);
        expect(links()).toBe(0);
      });

      test("a PC that holds its keys says Added, and one signed in to another account is offered nothing", async () => {
        pc.needsKeys = false;
        expect(words(await mount())).toContain("Added");
        pc.needsKeys = true;
        signedIn = "acct_other";
        const other = await mount();
        expect(buttons(other)).toEqual([]);
        expect(words(other)).not.toContain(KEYS);
      });
    });

    test("an add the PC ends (the numbers were not the same) ends the wait and says why", async () => {
      const renderer = await waitingFrom();
      byList!.now = { state: "ended", run: RUN, account: ACCOUNT, why: "cancelled" };
      await advance(ADDED_POLL_MS);
      expect(byList!.calls.map(({ what }) => what)).toContain(`GET /api/account/list/add?run=${RUN}`);
      expect(words(renderer)).toContain("The numbers were not the same, so nothing was added. If the device that adds this PC showed another number, something stood between the two: try once more, and if they differ again, do not add it.");
      expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
      expect(tab.has(MARKER)).toBe(false);
    });

    test("three numbers none confirmed end the wait with the card's own sentence", async () => {
      const renderer = await waitingFrom();
      byList!.now = { state: "ended", run: RUN, account: ACCOUNT, why: "attempts" };
      await advance(ADDED_POLL_MS);
      expect(words(renderer)).toContain("Too many tries for this PC. Start again on the PC in a few minutes.");
    });

    test("an add whose ten minutes ran out is started again while the wait runs, and Stop waiting gives up the new one", async () => {
      const renderer = await waitingFrom();
      byList!.now = { state: "ended", run: RUN, account: ACCOUNT, why: "timeout" };
      byList!.start = running(NEXT);
      await advance(ADDED_POLL_MS);
      expect(starts()).toBe(2);
      expect(words(renderer)).toContain(WAIT);
      expect(JSON.parse(tab.get(MARKER)!).run).toBe(NEXT);
      await press(renderer, "Stop waiting");
      expect(cancels().map(({ body }) => body)).toEqual([{ run: NEXT }]);
    });

    test("an add started again after Stop waiting gave the wait up is given up too", async () => {
      const renderer = await waitingFrom();
      byList!.now = { state: "ended", run: RUN, account: ACCOUNT, why: "timeout" };
      byList!.start = running(NEXT);
      let release!: () => void;
      byList!.started = () => new Promise<void>((done) => { release = done; });
      await advance(ADDED_POLL_MS);
      expect(starts()).toBe(2);
      await press(renderer, "Stop waiting");
      release();
      await settle();
      expect(cancels().map(({ body }) => body)).toEqual([{ run: RUN }, { run: NEXT }]);
      expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    });

    test("Stop waiting gives up the run the tab keeps for the wait, which another copy may have started again", async () => {
      const renderer = await waitingFrom();
      tab.set(MARKER, JSON.stringify({ ...JSON.parse(tab.get(MARKER)!), run: NEXT }));
      await press(renderer, "Stop waiting");
      expect(cancels().map(({ body }) => body)).toEqual([{ run: NEXT }]);
    });

    test("a PC that never answers the naming of its account holds the add for NAMING_MS at most", async () => {
      hangNaming = true;
      const renderer = await waitingFrom();
      expect(starts()).toBe(0);
      await advance(NAMING_MS);
      expect(starts()).toBe(1);
      expect(words(renderer)).toContain(WAIT);
    });

    test("an add whose ten minutes ran out is not started again once the address answers for another PC: the wait ends", async () => {
      const renderer = await waitingFrom();
      pc.healthId = OTHER_SERVER;
      byList!.now = { state: "ended", run: RUN, account: ACCOUNT, why: "timeout" };
      byList!.start = running(NEXT);
      await advance(ADDED_POLL_MS);
      expect(starts()).toBe(1);
      expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
      expect(tab.has(MARKER)).toBe(false);
    });

    test("the old way stays shut while the add by the list runs: the window the listing opened is closed, and the wait opens none", async () => {
      await waitingFrom();
      const closes = (): number => asked.filter(({ path }) => path === "/api/relay/link/close").length;
      const paths = (): string[] => asked.map(({ path }) => path);
      // the listing asked for the window (the PC's relay key comes with it), and the press closed it once the PC said its add runs
      expect(links()).toBe(1);
      expect(closes()).toBe(1);
      expect(paths().lastIndexOf("/api/relay/link/close")).toBeGreaterThan(paths().indexOf("/api/account/list/add"));
      // no reopening every 30 seconds while it waits
      await advance(3 * REOPEN_MS);
      expect(links()).toBe(1);
      // the relist keeps the listing in the account, and closes at once the window it had to open for it
      await advance(RELIST_MS - 3 * REOPEN_MS);
      expect(directory).toEqual(["putPc", "putPc"]);
      expect(links()).toBe(2);
      expect(closes()).toBe(2);
    });

    test("a wait begun by the list never opens the old window again where a restart of its add answers no_list: it asks the list again", async () => {
      await waitingFrom();
      expect(links()).toBe(1);
      // the run's ten minutes are over; the PC is asked to start it again, and answers no_list (its account service did not
      // name the list at that moment), which is no word that the account keeps none
      byList!.now = { state: "ended", run: RUN, account: ACCOUNT, why: "timeout" };
      byList!.start = { state: "no_list", account: ACCOUNT };
      await advance(ADDED_POLL_MS);
      expect(starts()).toBe(2);
      for (let round = 0; round < 3; round++) await advance(REOPEN_MS);
      // no window again, and the add by the list asked for again, a round apart
      expect(links()).toBe(1);
      expect(starts()).toBe(5);
      expect(asked.map(({ path }) => path)).not.toContain("/api/account/one-press");
      // once the PC names the list again, the wait follows the new run
      byList!.start = running(NEXT);
      await advance(REOPEN_MS);
      expect(JSON.parse(tab.get(MARKER)!).run).toBe(NEXT);
      expect(links()).toBe(1);
    });

    test("a wait begun by the list whose add could not be started again ends at its thirty minutes saying so, with no window left open", async () => {
      const renderer = await waitingFrom();
      byList!.now = { state: "ended", run: RUN, account: ACCOUNT, why: "timeout" };
      byList!.start = { state: "no_list", account: ACCOUNT };
      await advance(ADDED_POLL_MS);
      await advance(WAITING_MS);
      expect(words(renderer)).toContain("This PC could not be added by your account's list in time. Try again.");
      expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
      expect(tab.has(MARKER)).toBe(false);
      // the relists that kept the listing opened a window each and closed it at once
      expect(asked.filter(({ path }) => path === "/api/relay/link/close").length).toBe(links());
    });

    test("the wait shows the PC's number where the person pressed Add this PC, and The numbers match confirms it for its run", async () => {
      const renderer = await waitingFrom();
      byList!.now = { state: "number", run: RUN, account: ACCOUNT, list: LIST, digits: "482913", until: new Date(at + 120_000).toISOString() };
      await advance(ADDED_POLL_MS);
      expect(words(renderer)).toContain("This PC is being added to your account. Does the device adding it show 482 913?");
      expect(buttons(renderer)).toEqual(["The numbers match", "Cancel", "Stop waiting"]);
      // the window's own prompt leaves this number to the wait while the wait shows it: one place takes the yes
      expect(listNumberHeld(RUN)).toBe(true);
      await press(renderer, "The numbers match");
      expect(byList!.calls.filter(({ what }) => what === "POST /api/account/list/add/confirm").map(({ body }) => body)).toEqual([{ run: RUN, digits: "482913" }]);
      // confirmed: the number goes, and the wait goes on until the device's entry adds the PC
      await advance(ADDED_POLL_MS);
      expect(words(renderer)).not.toContain("482 913");
      expect(buttons(renderer)).toEqual(["Stop waiting"]);
      expect(listNumberHeld(RUN)).toBe(false);
    });

    test("Cancel beside the PC's number says the numbers were not the same, and the wait ends", async () => {
      const renderer = await waitingFrom();
      byList!.now = { state: "number", run: RUN, account: ACCOUNT, list: LIST, digits: "482913", until: new Date(at + 120_000).toISOString() };
      await advance(ADDED_POLL_MS);
      await press(renderer, "Cancel");
      expect(cancels().map(({ body }) => body)).toEqual([{ run: RUN }]);
      await advance(ADDED_POLL_MS);
      expect(words(renderer)).toContain("The numbers were not the same, so nothing was added.");
      expect(buttons(renderer)).toEqual(["Add this PC to my account"]);
    });

    test("a relist keeps the run the tab holds for the wait (another copy started it again), and Stop waiting gives that run up", async () => {
      const renderer = await waitingFrom();
      // another copy of the screen started the add again: the tab holds its new run for the same wait
      tab.set(MARKER, JSON.stringify({ ...JSON.parse(tab.get(MARKER)!), run: NEXT }));
      await advance(RELIST_MS);
      expect(directory).toEqual(["putPc", "putPc"]);
      expect(JSON.parse(tab.get(MARKER)!).run).toBe(NEXT);
      await press(renderer, "Stop waiting");
      expect(cancels().map(({ body }) => body)).toEqual([{ run: NEXT }]);
    });

    test("the PC joins by its list: the wait says Added", async () => {
      const renderer = await waitingFrom();
      pc.account = ACCOUNT;
      byList!.now = { state: "added", run: RUN, account: ACCOUNT, list: LIST };
      await advance(ADDED_POLL_MS);
      expect(words(renderer)).toContain("Added");
      expect(tab.has(MARKER)).toBe(false);
    });
  });
});
