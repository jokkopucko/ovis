import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import type { AccountPcEntry } from "../lib/api.ts";
import { ACCOUNT_SESSION_EVENT } from "../lib/account/store.ts";
import { SignedOutError } from "../lib/account/service.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { AccountPcsSource } from "../lib/account/useAccountPcs.ts";
import { SidebarAccountPcs } from "./SidebarAccountPcs.tsx";

const pc = (id: string, name: string): AccountPcEntry => ({ server_id: id.repeat(32).slice(0, 32), server_public_key: "key", relay: "wss://relay.ovis.example", name });
const OWN = pc("0", "This PC");
const DESK = pc("d", "Desk");
const LAB = pc("1", "Lab");
const OLD = pc("2", "Old box");
const AWAY = pc("3", "Away");
const local = { id: "local", name: "This PC", kind: "local", server_id: OWN.server_id } as unknown as Machine;
const lab = { id: "lab-id", name: "Lab", kind: "relay", relay: { server_id: LAB.server_id, relay: LAB.relay } } as unknown as Machine;
const desk = { id: "desk-id", name: "Desk", kind: "relay", relay: { server_id: DESK.server_id, relay: DESK.relay } } as unknown as Machine;

describe("the account's PCs in the sidebar", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let requests: { path: string; body: unknown }[];
  let pairLines: ReadableStreamDefaultController<Uint8Array> | undefined;
  let pairSignal: AbortSignal | null;
  let source: AccountPcsSource;
  let mine: string | null;
  let pcAccount: string | null;
  let relayPhase: string;
  let awayAnswers: string[];
  let listAccount: string | null;
  let lists: number;
  let admitted: string[];
  let failAwayCheck: boolean;
  let awayHold: Promise<void> | null;
  let statusFails: boolean;
  let invalidAway: boolean;
  let events: EventTarget;
  let documentEvents: EventTarget;
  // this browser's storage, kept across a page load within a test (mount again) and cleared between tests
  const stored = new Map<string, string>();

  beforeEach(() => {
    requests = [];
    pairLines = undefined;
    pairSignal = null;
    mine = "acct";
    pcAccount = "acct";
    relayPhase = "online";
    awayAnswers = ["offline"];
    listAccount = null;
    lists = 0;
    admitted = [];
    failAwayCheck = false;
    awayHold = null;
    statusFails = false;
    invalidAway = false;
    source = {
      account: async () => mine,
      list: async () => { lists += 1; const who = listAccount ?? mine; return who === null ? null : { account: who, pcs: [OWN, DESK, LAB, OLD, AWAY] }; },
      admit: async (serverId) => { admitted.push(serverId); },
    };
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    stored.clear();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } } });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
    events = new EventTarget();
    documentEvents = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "http://127.0.0.1:7318/", origin: "http://127.0.0.1:7318" },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      hidden: false, visibilityState: "visible",
      addEventListener: documentEvents.addEventListener.bind(documentEvents), removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null,
    } });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1:7318").pathname;
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ path, body });
      if (path === "/api/relay") return Response.json({ phase: relayPhase, blocked: null, error: null });
      if (path === "/api/account/status" && statusFails) return Response.json({ error: { code: "unavailable", message: "no" } }, { status: 503 });
      if (path === "/api/account/status") return Response.json({ account: pcAccount, unlinked: [], removals: [], adds: [], blocked: [] });
      if (path === "/api/machines/relay/account/check") {
        const asked = (body as { pcs: AccountPcEntry[] }).pcs;
        if (invalidAway && asked[0]?.server_id === AWAY.server_id) return Response.json({ error: { code: "account_pc_invalid", message: "no" } }, { status: 400 });
        if (failAwayCheck && asked[0]?.server_id === AWAY.server_id && awayHold !== null) await awayHold;
        if (failAwayCheck && asked[0]?.server_id === AWAY.server_id) return Response.json({ error: { code: "relay_unavailable", message: "The relay did not answer." } }, { status: 503 });
        const states: Record<string, string> = { [DESK.server_id]: "ready", [LAB.server_id]: "ready", [OLD.server_id]: "outdated" };
        if (asked[0]?.server_id === AWAY.server_id) {
          const answer = awayAnswers.shift();
          const hold = awayHold;
          if (hold !== null) await hold;
          return Response.json({ pcs: [{ server_id: AWAY.server_id, state: answer }] });
        }
        return Response.json({ pcs: asked.map((entry) => ({ server_id: entry.server_id, state: states[entry.server_id] })) });
      }
      if (path === "/api/machines/relay/account/start") return Response.json({ ticket: "ticket-1", key: "a-key", label: "Ovis on here" });
      if (path === "/api/machines/relay/account/pair") pairSignal = init?.signal ?? null;
      if (path === "/api/machines/relay/account/pair") return new Response(new ReadableStream<Uint8Array>({ start: (controller) => { pairLines = controller; } }));
      return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
  });

  afterEach(async () => {
    jest.useRealTimers();
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    mock.restore();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const groups = () => renderer!.root.findAll((node) => node.type === "section").map((group) => [
    group.props["aria-label"], group.props["data-pc-state"],
    group.findAll((node) => node.type === "button").map((button) => text(button)).join(","),
  ]);
  const row = (name: string) => renderer!.root.find((node) => node.type === "section" && node.props["aria-label"] === `PC ${name}`);
  const starts = () => requests.filter((request) => request.path.endsWith("/start")).length;
  const line = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  /** the window is left and comes back, as a tab switch does: blur, then focus and visibilitychange together */
  const comeBack = async () => {
    await act(async () => {
      events.dispatchEvent(new Event("blur"));
      events.dispatchEvent(new Event("focus"));
      documentEvents.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
  };
  const settle = async () => { for (let round = 0; round < 6; round += 1) await act(async () => {}); };
  const tree = (onAdded: (machine: Machine) => void, machines: readonly Machine[], hidden = false) => <SettingsProvider><SidebarAccountPcs machines={machines} onAdded={onAdded} source={source} hidden={hidden} /></SettingsProvider>;
  const mount = async (onAdded: (machine: Machine) => void = () => {}, machines: readonly Machine[] = [local, lab]) => {
    await act(async () => { renderer = create(tree(onAdded, machines)); });
    await settle();
  };

  it("lists the account's PCs not in this app yet and adds one that would pair on its own, with nothing to press", async () => {
    await mount();
    expect(groups()).toEqual([["PC Desk", "ready", ""], ["PC Old box", "outdated", ""], ["PC Away", "offline", ""]]);
    expect(admitted).toEqual([DESK.server_id]);
    expect(text(row("Desk"))).toContain("Connecting…");
    // nothing answered through the relay in time: that is all the check knows, so it never says the PC is switched off
    expect(text(row("Away"))).toContain("Can't reach the PC: it may be off");
    expect(text(row("Away"))).not.toContain("Switched off");
    expect(renderer!.root.findAll((node) => node.type === "button")).toHaveLength(0);
  });

  it("says the PC may be off only where nothing answered in time, and only that it cannot reach a PC whose answer was kept away otherwise", async () => {
    awayAnswers = ["unreachable"];
    await mount();
    expect(groups()[2]).toEqual(["PC Away", "unreachable", ""]);
    expect(text(row("Away"))).toContain("Can't reach the PC");
    expect(text(row("Away"))).not.toContain("may be off");
    expect(text(row("Away"))).not.toContain("Switched off");
  });

  it("adds no PC by itself that the account's list does not hold, asks nothing of one it has no way to, and says which is which", async () => {
    source.list = async () => ({ account: "acct", pcs: [
      { ...DESK, outside: true as const },
      { ...AWAY, server_public_key: "", relay: "", unreachable: true as const },
    ] });
    await act(async () => { renderer = create(tree(() => {}, [local])); });
    await settle();
    expect(groups().map(([label]) => label)).toEqual(["PC Desk", "PC Away"]);
    expect(text(row("Desk"))).toContain("Not in your account's list yet");
    // the account service gives no way to it: it keeps saying only that it cannot be reached
    expect(text(row("Away"))).toContain("Can't reach the PC");
    expect(text(row("Away"))).not.toContain("may be off");
    // nothing was admitted or paired, and the PC with no way to it was asked nothing
    expect(admitted).toEqual([]);
    expect(requests.filter(({ path, body }) => path === "/api/machines/relay/account/check" && (body as { pcs: AccountPcEntry[] }).pcs.some((pc) => pc.server_id === AWAY.server_id))).toEqual([]);
    expect(requests.filter(({ path }) => path === "/api/machines/relay/account/start")).toEqual([]);
  });

  it("adds by itself no PC of the list that is still new to this device: it waits for a person, as it does on My PCs", async () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    source.list = async () => ({ account: "acct", pcs: [{ ...DESK, byList: true as const, new_until: soon }] });
    await act(async () => { renderer = create(tree(() => {}, [local])); });
    await settle();
    expect(groups().map(([label, state]) => [label, state])).toEqual([["PC Desk", "ready"]]);
    expect(admitted).toEqual([]);
    expect(requests.filter(({ path }) => path === "/api/machines/relay/account/start")).toEqual([]);
  });

  it("A3: marks only the sidebar PC whose admission has not expired", async () => {
    jest.useFakeTimers();
    const now = Date.now();
    source.list = async () => ({ account: "acct", pcs: [
      { ...DESK, new_until: new Date(now + 1_000).toISOString() },
      { ...OLD, new_until: null },
      { ...AWAY, new_until: new Date(now - 1).toISOString() },
    ] });
    await act(async () => { renderer = create(tree(() => {}, [local])); });
    const marks = () => renderer?.root.findAllByType("section").filter((group) => group.findAll((node) => node.type === "span" && node.children.includes("New PC")).length > 0);
    expect(marks()?.map((group) => group.props["aria-label"])).toEqual(["PC Desk"]);
    await act(async () => { jest.advanceTimersByTime(1_000); });
    expect(marks()).toHaveLength(0);
  });

  it("adds one PC at a time: the next waits, Connecting…, until the one pairing ends", async () => {
    awayAnswers = ["ready"];
    let machines: readonly Machine[] = [local, lab];
    await mount((machine) => { machines = [...machines, machine]; });
    expect(text(row("Away"))).toContain("Connecting…");
    expect(starts()).toBe(1);
    await act(async () => { pairLines!.enqueue(line({ machine: desk })); pairLines!.close(); });
    await settle();
    await act(async () => { renderer!.update(tree(() => {}, machines)); });
    await settle();
    expect(admitted).toEqual([DESK.server_id, AWAY.server_id]);
    expect(groups().map(([name]) => name)).toEqual(["PC Old box", "PC Away"]);
  });

  it("adds a PC as the relay tab does and hands it over, Connecting… while a member approves on the account's devices", async () => {
    const opened: Machine[] = [];
    await mount((machine) => opened.push(machine));
    await act(async () => { pairLines!.enqueue(line({ waiting: true })); });
    expect(admitted).toEqual([DESK.server_id]);
    expect(text(row("Desk"))).toContain("Connecting…");
    await act(async () => { pairLines!.enqueue(line({ machine: desk })); pairLines!.close(); });
    await settle();
    expect(opened.map((machine) => machine.id)).toEqual(["desk-id"]);
  });

  it("says why a PC was not added and asks it nothing more, also when the window comes back or the account lists another PC", async () => {
    await mount();
    await act(async () => { pairLines!.enqueue(line({ error: { code: "account_pc_declined", message: "That PC was not approved. Nothing was added." } })); pairLines!.close(); });
    await settle();
    expect(text(row("Desk"))).toContain("Not approved");
    expect(text(row("Desk"))).not.toContain("Connecting…");
    await comeBack();
    await comeBack();
    expect(starts()).toBe(1);
    // the account lists another PC: a Deny stays until the account lists that PC itself anew
    source.list = async () => { lists += 1; return { account: "acct", pcs: [OWN, DESK, LAB, OLD, AWAY, { ...pc("4", "New one"), server_id: "4".repeat(32) }] }; };
    await comeBack();
    expect(starts()).toBe(1);
    expect(admitted).toEqual([DESK.server_id]);
  });

  it("remembers a member's Deny across a page load: the PC is not asked again, and its row says so", async () => {
    await mount();
    await act(async () => { pairLines!.enqueue(line({ error: { code: "account_pc_declined", message: "That PC was not approved. Nothing was added." } })); pairLines!.close(); });
    await settle();
    await act(async () => { renderer!.unmount(); });
    await mount();
    expect(starts()).toBe(1);
    expect(text(row("Desk"))).toContain("Not approved");
    // the account lists that PC anew (a new window): it gets one more look
    source.list = async () => ({ account: "acct", pcs: [OWN, { ...DESK, new_until: new Date(Date.now() + 60_000).toISOString() }, LAB, OLD, AWAY] });
    await comeBack();
    expect(starts()).toBe(2);
  });

  it("remembers nothing when nobody answered in time: the PC gets its one more try and is asked again on the next load", async () => {
    await mount();
    await act(async () => { pairLines!.enqueue(line({ error: { code: "account_pc_unanswered", message: "Nobody approved that PC in time. Nothing was added." } })); pairLines!.close(); });
    await settle();
    await comeBack();
    expect(starts()).toBe(2);
    await act(async () => { renderer!.unmount(); });
    await mount();
    expect(starts()).toBe(3);
  });

  it("keeps a Deny to the PC that asked: another PC of the account still adds that PC", async () => {
    await mount();
    await act(async () => { pairLines!.enqueue(line({ error: { code: "account_pc_declined", message: "That PC was not approved. Nothing was added." } })); pairLines!.close(); });
    await settle();
    await act(async () => { renderer!.unmount(); });
    // the same browser on another PC's page (the hosted app and the phone app share one origin)
    const other = { ...local, server_id: "c".repeat(32) } as unknown as Machine;
    await mount(() => {}, [other, lab]);
    expect(starts()).toBe(2);
  });

  it("tries a PC that used its one more try again once the relay comes back on", async () => {
    await mount();
    const fail = async (code: string) => {
      await act(async () => { pairLines!.enqueue(line({ error: { code, message: "no" } })); pairLines!.close(); });
      await settle();
    };
    await fail("account_pc_offline");
    await comeBack();
    await fail("account_pc_offline");
    expect(starts()).toBe(2);
    relayPhase = "off";
    await comeBack();
    relayPhase = "online";
    await comeBack();
    expect(starts()).toBe(3);
  });

  it("does not ask a declined PC again after one failed read of the account's list", async () => {
    await mount();
    await act(async () => { pairLines!.enqueue(line({ error: { code: "account_pc_declined", message: "That PC was not approved. Nothing was added." } })); pairLines!.close(); });
    await settle();
    const list = source.list;
    source.list = async () => { throw new TypeError("The account service could not be reached"); };
    await comeBack();
    source.list = list;
    await comeBack();
    expect(starts()).toBe(1);
  });

  it("tries a PC whose add failed for a passing reason once more when the window comes back, and no more", async () => {
    await mount();
    const fail = async () => {
      await act(async () => { pairLines!.enqueue(line({ error: { code: "account_pc_offline", message: "That PC could not be reached through the relay." } })); pairLines!.close(); });
      await settle();
    };
    await fail();
    await comeBack();
    expect(starts()).toBe(2);
    await fail();
    await comeBack();
    expect(starts()).toBe(2);
  });

  it("signed out, asks this PC nothing: not its relay, not its account", async () => {
    mine = null;
    await mount();
    expect(groups()).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("shows nothing signed out, on a PC in another account or in none, or with the relay not online, and asks the account for no PC", async () => {
    for (const [who, pcIn, phase] of [[null, "acct", "online"], ["acct", "other", "online"], ["acct", null, "online"], ["acct", "acct", "connecting"]] as const) {
      mine = who;
      pcAccount = pcIn;
      relayPhase = phase;
      requests = [];
      await mount();
      expect(groups()).toEqual([]);
      expect(requests.some((request) => request.path.startsWith("/api/machines/relay/account"))).toBe(false);
      expect(lists).toBe(0);
      await act(async () => { renderer!.unmount(); });
      renderer = undefined;
    }
  });

  it("lists the account once this browser signs in to it, when the window comes back", async () => {
    mine = null;
    await mount();
    expect(groups()).toEqual([]);
    mine = "acct";
    await comeBack();
    expect(groups().map(([name]) => name)).toEqual(["PC Desk", "PC Old box", "PC Away"]);
  });

  it("leaves out a PC that is in this app already: the sidebar lists it as its own", async () => {
    await mount(() => {}, [local, lab, desk]);
    expect(groups().map(([name]) => name)).toEqual(["PC Old box", "PC Away"]);
  });

  it("keeps only the account it checked this PC against: a list read under another sign-in shows and asks nothing", async () => {
    listAccount = "someone-else";
    await mount();
    expect(groups()).toEqual([]);
    expect(requests.some((request) => request.path.startsWith("/api/machines/relay/account"))).toBe(false);
  });

  it("asks nothing when this page signed out before its turn, and says to sign in again", async () => {
    let reads = 0;
    source.account = async () => (reads += 1) === 1 ? "acct" : null;
    await mount();
    expect(starts()).toBe(0);
    expect(admitted).toEqual([]);
    expect(text(row("Desk"))).toContain("Sign in again");
  });

  it("says to sign in again only until this page is signed in to that account again, then adds the PC it asked nothing of", async () => {
    // signed out after the list was read, before Desk's turn
    let reads = 0;
    source.account = async () => (reads += 1) === 1 ? "acct" : mine;
    listAccount = "acct";
    mine = null;
    await mount();
    expect(text(row("Desk"))).toContain("Sign in again");
    // signed in to another account: still nothing is asked of Desk
    mine = "other";
    await act(async () => { events.dispatchEvent(new Event(ACCOUNT_SESSION_EVENT)); });
    await settle();
    expect(text(row("Desk"))).toContain("Sign in again");
    expect(starts()).toBe(0);
    // signed in to that account again in this window: no reload, no other window in between
    mine = "acct";
    await act(async () => { events.dispatchEvent(new Event(ACCOUNT_SESSION_EVENT)); });
    await settle();
    expect(text(row("Desk"))).not.toContain("Sign in again");
    expect(starts()).toBe(1);
    expect(admitted).toEqual([DESK.server_id]);
  });

  it("asks to sign in again where the admission finds the page's sign-in gone, and tries that PC once it is signed in again", async () => {
    let gone = true;
    source.admit = async (serverId) => { if (gone) throw new SignedOutError(); admitted.push(serverId); };
    await mount();
    expect(text(row("Desk"))).toContain("Sign in again");
    expect(admitted).toEqual([]);
    gone = false;
    await act(async () => { events.dispatchEvent(new Event(ACCOUNT_SESSION_EVENT)); });
    await settle();
    expect(text(row("Desk"))).not.toContain("Sign in again");
    expect(admitted).toEqual([DESK.server_id]);
  });

  it("clears a Sign in again when the window comes back signed in to that account", async () => {
    let reads = 0;
    source.account = async () => (reads += 1) === 1 ? "acct" : mine;
    listAccount = "acct";
    mine = null;
    await mount();
    expect(text(row("Desk"))).toContain("Sign in again");
    mine = "acct";
    await comeBack();
    expect(text(row("Desk"))).not.toContain("Sign in again");
    expect(starts()).toBe(1);
  });

  it("says why a PC was not added in the page's language: the PC's server says it in English only", async () => {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["ko"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
    const said: Record<string, string> = {
      // refused before the request was shown: most often a PC with no device of the account paired at it to approve
      account_pc_refused: "그 PC가 요청을 받지 않았습니다. 그 PC와 페어링된 내 계정의 기기만 다른 PC를 들여보낼 수 있습니다.",
      account_pc_declined: "승인되지 않음",
      account_pc_unanswered: "승인되지 않음",
      account_pc_offline: "PC에 연결할 수 없음",
      account_pc_gone: "그 PC를 추가하지 못했습니다. 다시 시도하세요.",
    };
    for (const [code, words] of Object.entries(said)) {
      stored.clear();
      await mount();
      await act(async () => { pairLines!.enqueue(line({ error: { code, message: "An English sentence from the PC's server." } })); pairLines!.close(); });
      await settle();
      const dot = row("Desk").find((node) => node.type === "span" && typeof node.props.className === "string" && node.props.className.includes("machine-dot"));
      expect([code, dot.props.title, text(row("Desk")).includes("English sentence")]).toEqual([code, words, false]);
      await act(async () => { renderer!.unmount(); });
      renderer = undefined;
    }
  });

  it("tells the sidebar only the PCs it is adding, so a device keeps its own link to one that is outdated, off or declined", async () => {
    const told: (readonly string[])[] = [];
    await act(async () => { renderer = create(<SettingsProvider><SidebarAccountPcs machines={[local, lab]} onAdded={() => {}} onListed={(ids) => told.push(ids)} source={source} /></SettingsProvider>); });
    await settle();
    // Desk is being added; Old box (outdated) and Away (off) are not, and keep any link of this device's own
    expect(told.at(-1)).toEqual([DESK.server_id]);
    await act(async () => { pairLines!.enqueue(line({ error: { code: "account_pc_declined", message: "That PC was not approved. Nothing was added." } })); pairLines!.close(); });
    await settle();
    expect(told.at(-1)).toEqual([]);
    relayPhase = "off";
    await comeBack();
    expect(told.at(-1)).toEqual([]);
  });

  it("opens a PC being added by its row, where this device keeps its own link to it, so the add never hides the way to it", async () => {
    await act(async () => { renderer = create(<SettingsProvider><SidebarAccountPcs machines={[local, lab]} onAdded={() => {}} openable={new Set([DESK.server_id])} source={source} /></SettingsProvider>); });
    await settle();
    expect(text(row("Desk"))).toContain("Connecting…");
    expect(row("Desk").findAll((node) => node.type === "a").map((link) => link.props.href)).toEqual([`/s/${DESK.server_id}/`]);
    expect(row("Away").findAll((node) => node.type === "a")).toHaveLength(0);
  });

  it("keeps each PC's own failure while the next PC is added", async () => {
    awayAnswers = ["ready"];
    await mount();
    await act(async () => { pairLines!.enqueue(line({ error: { code: "account_pc_unreachable", message: "Desk did not answer." } })); pairLines!.close(); });
    await settle();
    expect(admitted).toEqual([DESK.server_id, AWAY.server_id]);
    expect(text(row("Away"))).toContain("Connecting…");
    expect(text(row("Desk"))).toContain("That PC could not be added. Try again.");
    expect(text(row("Desk"))).not.toContain("Connecting…");
  });

  it("steps aside for the sidebar filter without ending a pairing under way", async () => {
    await mount();
    await act(async () => { renderer!.update(tree(() => {}, [local, lab], true)); });
    const hidden = Object.fromEntries(renderer!.root.findAll((node) => node.type === "section").map((group) => [group.props["aria-label"], group.props.hidden]));
    expect(hidden).toEqual({ "PC Desk": false, "PC Old box": true, "PC Away": true });
    expect(pairSignal?.aborted).toBe(false);
  });

  it("lists nothing, not even this PC, until it knows which PC it is on", async () => {
    await mount(() => {}, []);
    expect(groups()).toEqual([]);
    expect(lists).toBe(0);
  });

  it("adds no poll of its own: the relay and the PC's account are read once, and again only when the window comes back", async () => {
    await mount();
    const reads = () => requests.filter((request) => request.path === "/api/relay" || request.path === "/api/account/status").length;
    expect(reads()).toBe(2);
    await settle();
    expect(reads()).toBe(2);
    await comeBack();
    expect(reads()).toBe(4);
    // focus alone, with the window never left, reads nothing
    await act(async () => { events.dispatchEvent(new Event("focus")); });
    await settle();
    expect(reads()).toBe(4);
  });

  it("reads the account's PCs again when the window comes back, and asks a newly listed PC", async () => {
    await mount();
    expect(lists).toBe(1);
    await comeBack();
    expect(lists).toBe(2);
    expect(groups().map(([name]) => name)).toEqual(["PC Desk", "PC Old box", "PC Away"]);
    // what each PC said stays, and none of them is asked again
    expect(groups().map(([, state]) => state)).toEqual(["ready", "outdated", "offline"]);
    expect(requests.filter((request) => request.path.endsWith("/check"))).toHaveLength(3);
  });

  it("keeps a pairing under way when the window comes back, and starts no second one", async () => {
    await mount();
    await act(async () => { pairLines!.enqueue(line({ waiting: true })); });
    const checks = requests.filter((request) => request.path.endsWith("/check")).length;
    await comeBack();
    expect(requests.filter((request) => request.path.endsWith("/check"))).toHaveLength(checks);
    expect(starts()).toBe(1);
    expect(text(row("Desk"))).toContain("Connecting…");
    expect(pairSignal?.aborted).toBe(false);
  });

  it("keeps a pairing under way when a read on the window's return fails", async () => {
    await mount();
    statusFails = true;
    await comeBack();
    expect(pairSignal?.aborted).toBe(false);
  });

  it("shows a PC whose first check failed as one it cannot reach, never as switched off, keeps the others, and asks it again when the window comes back", async () => {
    failAwayCheck = true;
    await mount();
    expect(groups()).toEqual([["PC Desk", "ready", ""], ["PC Old box", "outdated", ""], ["PC Away", "unreachable", ""]]);
    expect(text(row("Away"))).toContain("Can't reach the PC");
    expect(text(row("Away"))).not.toContain("Switched off");
    failAwayCheck = false;
    awayAnswers = ["ready"];
    await comeBack();
    expect(groups()[2]).toEqual(["PC Away", "ready", ""]);
  });

  it("during a pairing, a PC whose first check fails reads as not answering, and the pairing stays", async () => {
    let releaseAway = () => {};
    // Away's first check is still out while Desk is being paired, and then fails
    awayHold = new Promise<void>((resolve) => { releaseAway = resolve; });
    failAwayCheck = true;
    await mount();
    await act(async () => { releaseAway(); });
    await settle();
    expect(groups()[2]).toEqual(["PC Away", "unreachable", ""]);
    expect(pairSignal?.aborted).toBe(false);
  });

  it("keeps a PC this PC cannot use out of the list after a refresh reads it again", async () => {
    invalidAway = true;
    await mount();
    expect(groups().map(([name]) => name)).toEqual(["PC Desk", "PC Old box"]);
    await comeBack();
    expect(groups().map(([name]) => name)).toEqual(["PC Desk", "PC Old box"]);
  });

  it("keeps the rows and a pairing under way while the relay only reconnects, and ends them when it is off", async () => {
    await mount();
    relayPhase = "connecting";
    await comeBack();
    expect(pairSignal?.aborted).toBe(false);
    expect(groups().map(([name]) => name)).toEqual(["PC Desk", "PC Old box", "PC Away"]);
    relayPhase = "off";
    await comeBack();
    expect(groups()).toEqual([]);
    expect(pairSignal?.aborted).toBe(true);
  });

  it("asks a PC that did not answer nothing more when the roster changes: only a refresh asks it", async () => {
    failAwayCheck = true;
    await mount();
    const checks = () => requests.filter((request) => request.path.endsWith("/check")).length;
    const before = checks();
    // the roster changes as panes and agents move: a new array each time
    for (let round = 0; round < 3; round += 1) {
      await act(async () => { renderer!.update(tree(() => {}, [{ ...local }, { ...lab }])); });
      await settle();
    }
    expect(checks()).toBe(before);
    expect(groups()[2]).toEqual(["PC Away", "unreachable", ""]);
  });

  it("keeps a pairing under way when the roster changes", async () => {
    await mount();
    await act(async () => { renderer!.update(tree(() => {}, [{ ...local }, { ...lab }])); });
    await settle();
    expect(pairSignal?.aborted).toBe(false);
    expect(starts()).toBe(1);
  });
});
