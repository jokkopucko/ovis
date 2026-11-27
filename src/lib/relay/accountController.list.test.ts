import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AccountList, AccountListView, ListClaimState } from "../account/accountList.ts";
import type { DirectoryPc } from "../account/service.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { memoryAccountStore, newKey, type AccountSession, type AccountStore } from "../account/store.ts";
import { createAccountController } from "./accountController.ts";
import type { RelayDevice, ShellDeviceStore } from "./device.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { ACCOUNT_FEATURE } from "../../../shared/relay-mux.ts";
import { createShellTestPage } from "./shell.test.tsx";
import type { RelayTransport } from "./transport.ts";

const SERVICE = "https://account.ovis.sh";
const OFF: AccountListView = { account: null, status: { at: "off" }, reached: true, devices: [], pcs: [] };
const row = (id: string): DirectoryPc => ({ server_id: id, label: "Desk", added_at: "2026-11-24T00:00:00.000Z", last_seen_at: null, public_key: null, relay: null, new_until: null, admitted_at: null, admitted_before_you: false });
const session = (account: string): AccountSession => ({ service: SERVICE, account, provider: "github", access_token: `access-${account}`, refresh_token: `refresh-${account}`, expires_at: Date.now() + 3_600_000, sign_in_id: `sign-in-${account}`, signed_in_at: Date.now() });
/** The waits of the code under test, run one at a time by the test: no clock passes. */
function useFakeWaits() {
  const real = globalThis.setTimeout;
  const pending: (() => void)[] = [];
  globalThis.setTimeout = ((run: () => void, ms?: number) => {
    if (ms === undefined || ms < 1000) return real(run, ms);
    pending.push(run);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  return { next: async (): Promise<void> => { pending.shift()?.(); }, restore: (): void => { globalThis.setTimeout = real; } };
}

const empty: ShellDeviceStore = {
  get: async () => undefined, list: async () => [],
  remove: async () => {}, removeRow: async () => false,
  update: async () => { throw new Error("No pairing is made here"); },
};

/** what a device that follows the list of `account` and is in it shows */
const inList = (account: string): AccountListView => ({ account, reached: true, status: { at: "following", list: "5c".repeat(32), standing: "in", head: 0, read_at: 1, trouble: null }, devices: [], pcs: [] });

/** a list that only records what the shell asks of it */
function recordingList(): { list: AccountList; calls: string[]; heard: (() => void)[] } {
  const calls: string[] = [];
  const heard: (() => void)[] = [];
  const list: AccountList = {
    sync: async () => { calls.push("sync"); return OFF; },
    follows: async () => false,
    shown: () => Math.floor(Date.now() / 1000),
    view: () => OFF,
    subscribe: (listener) => { heard.push(() => listener(OFF)); return () => {}; },
    holdsPc: () => false,
    pcOfKey: () => null,
    due: () => null,
    shadow: async (account, directory, opens) => { calls.push(`shadow ${account} ${directory.map((pc) => pc.server_id).join(",")} opens:${[...opens ?? []].join(",")}`); return null; },
    dropNames: async (account) => { calls.push(`dropNames ${account}`); },
    forget: async (account) => { calls.push(`forget ${account}`); },
    pinnedElsewhere: async () => null,
    adopt: async (offer) => { calls.push(`adopt ${offer.list} ${offer.seq}`); return OFF; },
    writer: () => null,
    placeAt: () => null,
    holdsEntry: () => false,
    gossip: () => null,
    pageAfter: () => null,
    compare: () => null,
    takeFromPeer: async () => null,
    knowsPc: () => false,
    kept: async () => null, keep: async () => { throw new Error("nothing is signed in this test"); }, unkeep: async () => {}, waiting: async () => null, cancel: async () => "gone" as const,
  };
  return { list, calls, heard };
}

describe("the hosted shell and the account's signed list", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  let accountStore: AccountStore;
  let directory: DirectoryPc[];
  let asked: string[];
  beforeEach(() => {
    browser = createShellTestPage();
    accountStore = memoryAccountStore();
    directory = [row("a1".repeat(16))];
    asked = [];
  });
  const made: { dispose(): void }[] = [];
  afterEach(() => { for (const each of made.splice(0)) each.dispose(); browser.dispose(); });

  const settle = async (): Promise<void> => { for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
  const controller = (accountList?: AccountList | null, store: ShellDeviceStore = empty, changed: () => void = () => {}, open?: () => Promise<RelayTransport>) => kept(createAccountController({
    container: Object.create(null), entryUrl: "https://app.ovis.sh/", store, accountStore, accountService: SERVICE, ...(open === undefined ? {} : { open }),
    accountFetch: async (input) => {
      const { pathname } = new URL(new Request(input).url);
      asked.push(pathname);
      if (pathname === "/v1/admissions") return Response.json({}, { status: 201 });
      return pathname === "/v1/pcs" ? Response.json({ pcs: directory }) : Response.json({ error: { code: "not_found", message: "No such route" } }, { status: 404 });
    },
    renderApp: () => ({ render() {}, unmount() {} }),
    ...(accountList === undefined ? {} : { accountList }),
  }, { active: () => true, changed: async () => { changed(); }, outdated: () => new Set() }));
  /** every controller a test makes ends what it armed (its timer, its listeners) when the test does */
  const kept = <T extends { dispose(): void }>(account: T): T => { made.push(account); return account; };
  const signIn = async (account: string, no: number | null = 1): Promise<void> => {
    const signedIn = session(account);
    await accountStore.set("session", signedIn);
    await accountStore.set("signin_key", { account, sign_in_id: signedIn.sign_in_id!, key: await newKey(), no });
  };

  it("reads the list once per sign-in, after the directory, and holds each directory read against it", async () => {
    await signIn("acct-one");
    const { list, calls, heard } = recordingList();
    let viewed = "acct-one";
    list.view = () => inList(viewed);
    const account = controller(list);
    await account.refresh(true);
    await settle();
    expect(calls).toEqual(["sync", `shadow acct-one ${"a1".repeat(16)} opens:`]);
    // a later read of the directory compares again, and reads the list no second time: that is the list's own clock
    directory = [row("a1".repeat(16)), row("b2".repeat(16))];
    await account.refresh(false, true);
    await settle();
    expect(calls.slice(2)).toEqual([`shadow acct-one ${"a1".repeat(16)},${"b2".repeat(16)} opens:`]);
    // the list moved: compared again with the directory last read
    for (const tell of heard) tell();
    await settle();
    expect(calls.slice(3)).toEqual([`shadow acct-one ${"a1".repeat(16)},${"b2".repeat(16)} opens:`]);
    // another sign-in: its list is read at once
    viewed = "acct-two";
    await signIn("acct-two");
    await account.refresh(false, true);
    await settle();
    expect(calls.slice(4)).toEqual(["sync", `shadow acct-two ${"a1".repeat(16)},${"b2".repeat(16)} opens:`]);
  });

  for (const [status, says] of [[{ at: "newer_save" }, "newer"], [{ at: "damaged", why: "form" }, "damaged"]] as const) {
    it(`says that this device cannot read its list from the very first draw, and marks every row then (${says}) (M64)`, async () => {
      await signIn("acct-one");
      directory = [row("a1".repeat(16))];
      const { list } = recordingList();
      const unreadable = { account: "acct-one", reached: true, status, devices: [], pcs: [] } as unknown as AccountListView;
      let read = false;
      list.view = () => read ? unreadable : OFF;
      list.sync = async () => { read = true; return unreadable; };
      list.follows = async () => true;
      const lines: (string | undefined)[] = [];
      const marked: boolean[] = [];
      const account = controller(list, empty, () => {
        const { state } = account;
        if (state?.kind !== "signed-in" || state.pcs === null) return;
        lines.push(state.list);
        marked.push(state.pcs.every((pc) => pc.notInList === true));
      });
      await account.refresh(true);
      await settle();
      expect([lines[0], marked[0], lines.length > 0]).toEqual([says, true, true]);
    });
  }

  it("says that this device has not read its list yet where it holds a copy and no read ended, marks every row, and reads again at the next refresh", async () => {
    await signIn("acct-one");
    directory = [row("a1".repeat(16))];
    const { list, calls } = recordingList();
    // the page's rounds fail: no view of the account is ever there, and the device holds a copy
    let fails = true;
    list.view = () => fails ? OFF : inList("acct-one");
    list.sync = async () => { calls.push("sync"); if (fails) throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); return inList("acct-one"); };
    list.follows = async () => true;
    const account = controller(list);
    await account.refresh(true);
    await settle();
    const first = account.state as { kind: string; list?: string; pcs: { notInList?: true }[] };
    expect([first.kind, first.list, first.pcs.every((pc) => pc.notInList === true), account.knowsList]).toEqual(["signed-in", "unread", true, true]);
    // the read is tried again with the next refresh, and once one ends the rows are the list's
    const reads = calls.filter((call) => call === "sync").length;
    fails = false;
    await account.refresh(false, true);
    await settle();
    expect(calls.filter((call) => call === "sync").length).toBeGreaterThan(reads);
    expect((account.state as { list?: string }).list).toBeUndefined();
  });

  it("gives the list key only while the sign-in it belongs to is the one in view: none from the moment a sign-out begins", async () => {
    await signIn("acct-one");
    const { list } = recordingList();
    const mine = (await accountStore.key()).public_spki;
    const held: AccountListView = { ...inList("acct-one"), devices: [{ key: mine, self: true, power: "full", role: "drive", until: null, carried: false, name: null }] };
    list.view = () => held;
    list.sync = async () => held;
    list.follows = async () => true;
    const account = controller(list);
    await account.refresh(true);
    await settle();
    expect(account.listKey?.public_spki).toBe(mine);
    // the person signs out: the list's own view goes only once the account service answered, the key at once
    account.signOut();
    expect([account.listKey, list.view().account]).toEqual([null, "acct-one"]);
  });

  it("draws nothing again when the list moves on an account that has none: only a list that is drawn from, or was, redraws the rows", async () => {
    await signIn("acct-one");
    directory = [row("a1".repeat(16))];
    const { list, heard } = recordingList();
    // the account service keeps no list for this account, and says so at the end of the page's first round
    const off: AccountListView = { account: "acct-one", reached: true, status: { at: "off" }, devices: [], pcs: [] };
    list.view = () => off;
    let draws = 0;
    const account = controller(list, empty, () => { draws += 1; });
    await account.refresh(true);
    await settle();
    const before = draws;
    for (const tell of heard) tell();
    await settle();
    expect(draws).toBe(before);
    // the device comes into a list: now its rows are the list's, and they are drawn
    list.view = () => inList("acct-one");
    for (const tell of heard) tell();
    await settle();
    expect(draws).toBeGreaterThan(before);
    // and when that list is gone again, once more, to take its rows back
    const after = draws;
    list.view = () => off;
    for (const tell of heard) tell();
    await settle();
    expect(draws).toBeGreaterThan(after);
    const last = draws;
    for (const tell of heard) tell();
    await settle();
    expect(draws).toBe(last);
  });

  it("stops following the list once it is disposed: no later round reads it", async () => {
    await signIn("acct-one");
    const { list, calls } = recordingList();
    let viewed = "acct-one";
    list.view = () => inList(viewed);
    const account = controller(list);
    await account.refresh(true);
    await settle();
    const reads = (): number => calls.filter((call) => call === "sync").length;
    expect(reads()).toBe(1);
    account.dispose();
    // what would begin a round: another sign-in, read by a refresh
    viewed = "acct-two";
    await signIn("acct-two");
    await account.refresh(false, true);
    await settle();
    expect(reads()).toBe(1);
  });

  it("compares nothing for a sign-in that ended while it read this device's pairings", async () => {
    await signIn("acct-one");
    const { list, calls, heard } = recordingList();
    // the read of the pairings that a comparison waits for, held by the test
    const reads: (() => void)[] = [];
    let holding = false;
    list.view = () => inList("acct-one");
    const account = controller(list, { ...empty, list: () => holding ? new Promise((resolve) => { reads.push(() => resolve([])); }) : Promise.resolve([]) });
    await account.refresh(true);
    await settle();
    const unhandled: unknown[] = [];
    const note = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", note);
    try {
      holding = true;
      for (const tell of heard) tell();
      await settle();
      expect(reads.length).toBe(1);
      holding = false;
      account.signOut();
      await settle();
      calls.length = 0;
      for (const release of reads) release();
      await settle();
    } finally { process.off("unhandledRejection", note); }
    expect([unhandled, calls.filter((call) => call.startsWith("shadow"))]).toEqual([[], []]);
  });

  it("compares nothing where the device is in no list of the account", async () => {
    await signIn("acct-one");
    const { list, calls, heard } = recordingList();
    const account = controller(list);
    await account.refresh(true);
    await settle();
    for (const tell of heard) tell();
    await settle();
    expect(calls.filter((call) => call.startsWith("shadow"))).toEqual([]);
  });

  it("reads the list again after a sign-out, so that nothing of the ended sign-in stays in view, and forgets what opens its names", async () => {
    await signIn("acct-one");
    const { list, calls } = recordingList();
    const account = controller(list);
    await account.refresh(true);
    await settle();
    calls.length = 0;
    account.signOut();
    await settle();
    // once, when the sign-in is gone from the store: not while it is still there. What opens the list's names goes
    // as the PCs' names do, and the copy stays: the device is still a member
    expect([...calls].sort()).toEqual(["dropNames acct-one", "sync"]);
    expect(await accountStore.get("session")).toBeUndefined();
  });

  it("changes nothing it draws or sends by the list: the same rows and the same requests with one and with none", async () => {
    await signIn("acct-one");
    const withList = controller(recordingList().list);
    await withList.refresh(true);
    await settle();
    const [drawn, sent] = [withList.state, [...asked]];
    asked = [];
    const without = controller(null);
    await without.refresh(true);
    await settle();
    expect(drawn).toMatchObject({ kind: "signed-in", error: null, pcs: [{ server_id: "a1".repeat(16) }] });
    expect(without.state).toEqual(drawn!);
    expect(without.directory).toEqual(withList.directory);
    expect(asked).toEqual(sent);
  });

  it("draws the PCs its list holds for a device that is in it, from the first draw on, and again when the list moves", async () => {
    await signIn("acct-one");
    const keys = [generateKeyPair().publicKey, generateKeyPair().publicKey, generateKeyPair().publicKey];
    const [held, rogue, unreached] = keys.map((key) => ({ endpoint: Array.from(key, (byte) => byte.toString(16).padStart(2, "0")).join(""), server_id: deriveServerId(key) }));
    const routed = (pc: { endpoint: string; server_id: string }): DirectoryPc => ({ ...row(pc.server_id), label: "The service's name", public_key: pc.endpoint, relay: "wss://relay.test", last_seen_at: new Date().toISOString() });
    directory = [routed(held!), routed(rogue!)];
    const listed = (pc: { endpoint: string; server_id: string }, label: string) => ({ ...pc, how: "added" as const, allows: true, name: { label, os: null }, seq: 1, by: null, new_at: null });
    const { list, heard } = recordingList();
    let view: AccountListView = { account: "acct-one", reached: true, status: { at: "following", list: "5c".repeat(32), standing: "in", head: 2, read_at: 1, trouble: null }, devices: [], pcs: [listed(held!, "Desk")] };
    // the list is read from this device's own store and the account service: it answers after the directory does
    let read = false;
    list.view = () => read ? view : OFF;
    list.sync = async () => { await settle(); read = true; return view; };
    list.follows = async () => true;
    const drawn: string[][] = [];
    const account = controller(list, empty, () => { const { state } = account; if (state?.kind === "signed-in" && state.pcs !== null) drawn.push(state.pcs.map((pc) => pc.server_id)); });
    await account.refresh(true);
    await settle();
    // never drawn by the account service's word alone: from the first draw on, the PC that only the directory names is marked
    expect(drawn.length).toBeGreaterThan(0);
    const marks = (pcs: readonly { server_id: string; byList?: true; notInList?: true }[]) => pcs.map((pc) => [pc.server_id, pc.byList === true ? "list" : pc.notInList === true ? "outside" : "plain"]);
    const rowsNow = () => marks((account.state as { pcs: { server_id: string; byList?: true; notInList?: true }[] }).pcs);
    expect(drawn.every((rows) => rows.length === 2)).toBe(true);
    expect(rowsNow().sort()).toEqual([[held!.server_id, "list"], [rogue!.server_id, "outside"]].sort());
    expect((account.state as { pcs: { server_id: string }[] }).pcs.find((pc) => pc.server_id === held!.server_id)).toMatchObject({ name: "Desk", byList: true, accountOpen: true, join: { relay: "wss://relay.test" } });
    expect((account.state as { list?: string }).list).toBeUndefined();
    // the list moved: a PC came in that the account service does not say how to reach
    view = { ...view, pcs: [...view.pcs, listed(unreached!, "Laptop")] };
    for (const tell of heard) tell();
    await settle();
    const laptop = (account.state as { pcs: { server_id: string; name: string; byList?: true; join?: unknown }[] }).pcs.find((pc) => pc.server_id === unreached!.server_id)!;
    expect([laptop.name, laptop.byList, laptop.join]).toEqual(["Laptop", true, undefined]);
    // put out of the list, this device goes by the account service's directory again, as a device of an account with no list does
    view = { ...view, status: { at: "following", list: "5c".repeat(32), standing: "out", head: 3, read_at: 1, trouble: null }, pcs: [] };
    for (const tell of heard) tell();
    await settle();
    expect(rowsNow().sort()).toEqual([[held!.server_id, "plain"], [rogue!.server_id, "plain"]].sort());
    // a copy that only a newer app reads: the directory's PCs, every one marked, and the view says why
    view = { ...view, status: { at: "newer_save" }, pcs: [] };
    for (const tell of heard) tell();
    await settle();
    expect([rowsNow().sort(), (account.state as { list?: string }).list]).toEqual([[[held!.server_id, "outside"], [rogue!.server_id, "outside"]].sort(), "newer"]);
    // read again, the line goes
    view = { ...view, status: { at: "following", list: "5c".repeat(32), standing: "in", head: 4, read_at: 1, trouble: null }, pcs: [listed(held!, "Desk")] };
    for (const tell of heard) tell();
    await settle();
    expect((account.state as { list?: string }).list).toBeUndefined();
  });

  /** A pairing this device just made with a PC of its account by the digits, which a member approved: its session, and what the PC answers. */
  async function approvedPairing(introductions: unknown[]) {
    const signedIn = await accountStore.get("session");
    const key = await accountStore.key();
    const serverId = "a1".repeat(16);
    const row: RelayDevice = { server_id: serverId, server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.test", device_id: "12".repeat(8), private_key: key.private_key, public_spki: key.public_spki, label: "Phone", account: signedIn!.account };
    const rows = new Map([[serverId, row]]);
    const store: ShellDeviceStore = {
      get: async (id) => rows.get(id), list: async () => [...rows.values()], remove: async (id) => { rows.delete(id); }, removeRow: async () => false,
      update: async (id, change) => { const next = change(rows.get(id)); rows.set(id, next); return next; },
    };
    const asked: string[] = [];
    const renewed: number[] = [];
    const fetch = async (path: string): Promise<Response> => {
      asked.push(`${path} ${renewed.length > 0 ? "signed in" : "not yet"}`);
      if (path === "/api/account/status") return Response.json({ account: signedIn!.account, unlinked: [], removals: [], enrolling: false });
      if (path === "/api/account/introduction") return Response.json(introductions.shift() ?? { pcs: [] });
      throw new TypeError(`Unexpected PC request: ${path}`);
    };
    const session = { server: { features: [ACCOUNT_FEATURE] }, fetch, renew: async () => { renewed.push(Date.now()); }, close() {} } as unknown as RelayTransport;
    return { serverId, store, session, asked, introductions: () => asked.filter((each) => each.startsWith("/api/account/introduction")) };
  }
  const place = { id: "5c".repeat(32), seq: 4, hash: "ab".repeat(32) };
  const waitingView = (): AccountListView => ({ account: "acct-one", status: { at: "not_in", list: "5c".repeat(32), why: "not_mine", claim: "claimed" }, reached: true, devices: [], pcs: [] });

  it("reads its place in the list from the introduction of the PC a member just let it in at, over the session that signed in, and takes the first one", async () => {
    await signIn("acct-one");
    const { list, calls } = recordingList();
    let view = waitingView();
    list.view = () => view;
    // the list reads the log up to that place itself, and finds this device in
    const inView: AccountListView = { account: "acct-one", reached: true, status: { at: "following", list: place.id, standing: "in", head: 4, read_at: 1, trouble: null }, devices: [], pcs: [] };
    list.adopt = async (offer) => { calls.push(`adopt ${offer.list} ${offer.seq} ${offer.hash}`); view = inView; return inView; };
    const pairing = await approvedPairing([{ pcs: [] }, { pcs: [], list: place }, { pcs: [], list: { ...place, seq: 9 } }]);
    const account = controller(list, pairing.store, () => {}, async () => pairing.session);
    const timers = useFakeWaits();
    try {
      const done = account.enroll(pairing.session, pairing.serverId, true, true);
      await settle();
      expect(calls.filter((call) => call.startsWith("adopt"))).toEqual([]);
      await timers.next();
      expect(await done).toMatchObject({ state: "complete" });
    } finally { timers.restore(); }
    // asked twice, never before the session signed in again, and not a third time once a place was taken
    expect(pairing.introductions()).toEqual(["/api/account/introduction signed in", "/api/account/introduction signed in"]);
    expect(calls.filter((call) => call.startsWith("adopt"))).toEqual([`adopt ${place.id} 4 ${place.hash}`]);
  });

  it("says nothing of the account while its own copy of the list does not show it in, though it was handed a place", async () => {
    await signIn("acct-one");
    const { list, calls } = recordingList();
    // the log ends one entry short of the place: the list keeps the place for its next read, and the device still waits
    list.view = waitingView;
    list.adopt = async (offer) => { calls.push(`adopt ${offer.list} ${offer.seq}`); return waitingView(); };
    const pairing = await approvedPairing([{ pcs: [], list: place }]);
    const account = controller(list, pairing.store, () => {}, async () => pairing.session);
    expect(await account.enroll(pairing.session, pairing.serverId, true, true)).toBe("local");
    expect(calls.filter((call) => call.startsWith("adopt"))).toEqual([`adopt ${place.id} 4`]);
  });

  it("hands a place to the list whatever this page drew of it so far, and after a pairing made with a code reads the introduction once, with no wait", async () => {
    await signIn("acct-one");
    const { list, calls } = recordingList();
    // the page has not read its list yet (a reload): the place is the list's to judge, and a list that is followed takes none
    const first = await approvedPairing([{ pcs: [], list: place }]);
    await controller(list, first.store, () => {}, async () => first.session).enroll(first.session, first.serverId, true, true);
    expect(calls.filter((call) => call.startsWith("adopt"))).toEqual([`adopt ${place.id} 4`]);
    // a pairing that is not one a member's approval made: the introduction is read once, as before, with no waiting
    // for another; a device that still waits to be let into the list takes the place that one read brings
    calls.length = 0;
    list.view = waitingView;
    const second = await approvedPairing([{ pcs: [] }, { pcs: [], list: place }]);
    await controller(list, second.store, () => {}, async () => second.session).enroll(second.session, second.serverId, true, false);
    expect(second.introductions().length).toBe(1);
    expect(calls.filter((call) => call.startsWith("adopt"))).toEqual([]);
  });

  it("asks a PC it is paired with for its place again at a later open, while it still waits to be let into the list", async () => {
    await signIn("acct-one");
    const { list, calls } = recordingList();
    // the member's Allow went through only after this device stopped asking: the PC carries the place now, and this
    // device opens the PC from its saved pairing
    list.view = waitingView;
    list.follows = async () => false;
    const later = await approvedPairing([{ pcs: [], list: place }]);
    await controller(list, later.store, () => {}, async () => later.session).enroll(later.session, later.serverId, false);
    expect(later.introductions().length).toBe(1);
    expect(calls.filter((call) => call.startsWith("adopt"))).toEqual([`adopt ${place.id} 4`]);
    // a device that follows its list asks no PC for a place at an open
    calls.length = 0;
    list.view = () => ({ account: "acct-one", reached: true, status: { at: "following", list: place.id, standing: "in", head: 4, read_at: 1, trouble: null }, devices: [], pcs: [] });
    const settledIn = await approvedPairing([{ pcs: [], list: place }]);
    await controller(list, settledIn.store, () => {}, async () => settledIn.session).enroll(settledIn.session, settledIn.serverId, false);
    // the introduction is read once, as at any open, and no place is taken from it
    expect([settledIn.introductions().length, calls.filter((call) => call.startsWith("adopt"))]).toEqual([1, []]);
  });

  it("takes no place for a pairing that was forgotten while the PC's answer was on its way", async () => {
    await signIn("acct-one");
    const { list, calls } = recordingList();
    list.view = waitingView;
    const pairing = await approvedPairing([{ pcs: [], list: place }]);
    // Forget, in another tab, between the request for the introduction and its answer
    const asks = pairing.session.fetch.bind(pairing.session);
    (pairing.session as { fetch: typeof asks }).fetch = async (path, init) => {
      const answer = await asks(path, init);
      if (path === "/api/account/introduction") await pairing.store.remove(pairing.serverId);
      return answer;
    };
    const ended = await controller(list, pairing.store, () => {}, async () => pairing.session).enroll(pairing.session, pairing.serverId, true, true).then(() => "enrolled", (error: unknown) => (error as Error).name);
    expect(ended).not.toBe("enrolled");
    expect(calls.filter((call) => call.startsWith("adopt"))).toEqual([]);
  });

  it("stops asking for its place when the pairing is forgotten", async () => {
    await signIn("acct-one");
    const { list, calls } = recordingList();
    list.view = waitingView;
    const pairing = await approvedPairing([]);
    const account = controller(list, pairing.store, () => {}, async () => pairing.session);
    const timers = useFakeWaits();
    try {
      const done = account.enroll(pairing.session, pairing.serverId, true, true).catch((error: unknown) => (error as Error).name);
      await settle();
      account.cancelEnrollment(pairing.serverId);
      expect(await done).toBe("AbortError");
      const asked = pairing.introductions().length;
      await timers.next();
      await settle();
      expect([pairing.introductions().length, calls.filter((call) => call.startsWith("adopt"))]).toEqual([asked, []]);
    } finally { timers.restore(); }
  });

  it("says which account is signed in before it read the account's PCs, and writes nothing to the stored sign-in for it", async () => {
    // a sign-in stored by an older build, with no id of its own: reading whose it is must not name it
    const { sign_in_id: _unnamed, ...legacy } = session("acct-one");
    await accountStore.set("session", legacy);
    const account = controller(null);
    expect(account.signedInAs).toBeUndefined();
    expect(await account.storedAccount()).toBe("acct-one");
    expect(await accountStore.get("session")).toEqual(legacy);
    expect(asked).toEqual([]);
  });

  it("brings its card to a join only for a claim of its key that stands by a read of the list made for that join", async () => {
    await signIn("acct-one");
    const LIST = "5c".repeat(32);
    const waits = (claim: ListClaimState, account = "acct-one"): AccountListView => ({ account, reached: true, status: { at: "not_in", list: LIST, why: "not_mine", claim }, devices: [], pcs: [] });
    const { list, calls } = recordingList();
    let drawn = waits("claimed");
    let read = waits("unclaimed");
    list.view = () => drawn;
    list.sync = async () => { calls.push("sync"); drawn = read; return read; };
    const account = controller(list);
    const offer = { v: 1 as const, server_id: "a1".repeat(16), server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.example" };
    const card = async () => (await account.prepare(offer, new AbortController().signal)).listCard;
    // the view drawn before this page slept shows a claim, which lapsed: the read for the join could not make it again
    expect(await card()).toBeUndefined();
    // a page whose first read had not landed shows none: the claim stands by the read the join waits for
    drawn = OFF;
    read = waits("claimed");
    expect(await card()).toMatchObject({ list: LIST });
    // the read finds this device signed in to another account meanwhile: no card for it
    read = waits("claimed", "acct-two");
    expect(await card()).toBeUndefined();
  });

  it("keeps the place a PC handed its join for the account the card was made for, also where the sign-in ended before it was taken", async () => {
    await signIn("acct-one");
    const LIST = "5c".repeat(32);
    const { list, calls } = recordingList();
    const waits: AccountListView = { account: "acct-one", reached: true, status: { at: "not_in", list: LIST, why: "not_mine", claim: "claimed" }, devices: [], pcs: [] };
    list.view = () => waits;
    list.sync = async () => waits;
    list.adopt = async (offer, account) => { calls.push(`adopt ${offer.list} ${offer.seq} for ${account}`); return OFF; };
    const account = controller(list);
    const offer = { v: 1 as const, server_id: "a1".repeat(16), server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.example" };
    expect((await account.prepare(offer, new AbortController().signal)).listCard).toMatchObject({ list: LIST });
    // the sign-in ends between the PC's answer and the place being taken
    await accountStore.set("session", undefined);
    await account.takePlace({ id: LIST, seq: 4, hash: "ab".repeat(32) });
    expect(calls.filter((call) => call.startsWith("adopt"))).toEqual([`adopt ${LIST} 4 for acct-one`]);
  });

  it("says the PC may open with the list key only where the account the page shows after the place was taken is the card's", async () => {
    await signIn("acct-one");
    const LIST = "5c".repeat(32);
    const { list } = recordingList();
    const waits: AccountListView = { account: "acct-one", reached: true, status: { at: "not_in", list: LIST, why: "not_mine", claim: "claimed" }, devices: [], pcs: [] };
    list.view = () => waits;
    list.sync = async () => waits;
    let elsewhere = false;
    // another tab signs in to another account while the place is taken
    list.adopt = async () => { if (elsewhere) await signIn("acct-two"); return OFF; };
    const account = controller(list);
    const offer = { v: 1 as const, server_id: "a1".repeat(16), server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.example" };
    expect((await account.prepare(offer, new AbortController().signal)).listCard).toMatchObject({ list: LIST });
    const place = { id: LIST, seq: 4, hash: "ab".repeat(32) };
    // the answer is the view's the read put up, which `listKey` gives its key for: the shell opens the PC with no other
    expect([await account.takePlace(place), account.signedInAs?.account]).toEqual([true, "acct-one"]);
    elsewhere = true;
    const opens = await account.takePlace(place);
    expect([opens, opens === (account.signedInAs?.account === "acct-one")]).toEqual([false, true]);
  });

  it("keeps no place a PC handed for a list no card of this page was made for: never under whichever account is signed in", async () => {
    await signIn("acct-one");
    const { list, calls } = recordingList();
    list.adopt = async (offer, account) => { calls.push(`adopt ${offer.list} for ${account}`); return OFF; };
    const account = controller(list);
    expect(await account.takePlace({ id: "5c".repeat(32), seq: 4, hash: "ab".repeat(32) })).toBe(false);
    expect(calls.filter((call) => call.startsWith("adopt"))).toEqual([]);
  });

  it("follows no list where a test gives its own account store or fetch and no list", async () => {
    await signIn("acct-one");
    const account = controller();
    await account.refresh(true);
    await settle();
    expect(asked.filter((path) => path.startsWith("/v2/"))).toEqual([]);
  });
});
