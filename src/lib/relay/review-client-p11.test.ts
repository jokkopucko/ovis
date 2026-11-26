/**
 * Independent adversarial review of client step 11 (P11, 114ffe9c1): one test per finding, written as if it lived in
 * `src/lib/relay/`. A test named "FINDING ..." fails on 114ffe9c1 and passes once the finding is fixed; a test named
 * "HOLDS ..." pins a guard that was checked and found sound, and passes on 114ffe9c1; "(kills Mn)" names the mutant of
 * the step's own guards (review-client-p11.md) that the step's tests leave alive and this test kills.
 *
 * Run: copy to src/lib/relay/review-client-p11.test.ts in a checkout of the reviewed head, then
 *   TMPDIR=<short dir> bun test src/lib/relay/review-client-p11.test.ts
 * On 114ffe9c1: 8 pass, 7 fail (the seven FINDING tests).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import { signListEntry } from "../../../shared/account-list.ts";
import { generateKeyPair, exportPublicKey } from "../../../shared/relay-e2ee.ts";
import { MuxProtocolError, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { accountList, type AccountList } from "../account/accountList.ts";
import { addListPc, listWorld, type WorldDevice } from "../account/accountList.test-helpers.ts";
import { allowDevice } from "../account/listAllow.ts";
import { removeListPc } from "../account/listRemove.ts";
import { memoryListLock, type ListStore } from "../account/listStore.ts";
import { setPageAccountList } from "../account/pageList.ts";
import type { DirectoryPc } from "../account/service.ts";
import { indexedAccountStore } from "../account/store.ts";
import { signedInAccount } from "../account/useAccountPcs.ts";
import { openPage } from "../page.fixture.ts";
import { usePcRemoval } from "../../components/usePcRemoval.tsx";
import { SettingsProvider } from "../settings.ts";
import { createAccountController } from "./accountController.ts";
import type { RelayDevice, ShellDeviceStore } from "./device.ts";
import { accountOpenablePcs } from "./pcPick.ts";
import { notePcTap } from "./pcTap.ts";
import { mountRelayShell, type RelayShellMount } from "./shell.tsx";
import { removedPcs } from "./shellState.ts";
import { RelayTransport } from "./transport.ts";

class Admitted extends RelayTransport {
  override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL }; }
}

type World = ReturnType<typeof listWorld>;
const noWait = { wait: async () => {} };
const settle = async (): Promise<void> => { for (let turn = 0; turn < 40; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };

/** The shell also reads storage and matchMedia as bare browser globals. */
function openShellPage() {
  const page = openPage("https://app.ovis.sh/");
  const { window } = page;
  window.sessionStorage.setItem("ovis-launched", "1");
  const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  Object.defineProperty(window.document, "visibilityState", { configurable: true, value: "hidden" });
  Object.defineProperties(window.navigator, {
    languages: { configurable: true, value: ["en"] },
    userAgent: { configurable: true, value: "Mozilla/5.0 (X11; Linux x86_64)" },
    maxTouchPoints: { configurable: true, value: 0 },
  });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ localStorage: window.localStorage, sessionStorage: window.sessionStorage, matchMedia })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  return { page, async close() {
    await page.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  } };
}

/** A directory row the account service gives for a PC: routed, and heard from a minute ago. */
const routed = (pc: { server_id: string; endpoint: string }, label: string): DirectoryPc => ({
  server_id: pc.server_id, label, added_at: new Date(Date.now() - 2 * 864e5).toISOString(), last_seen_at: new Date(Date.now() - 60_000).toISOString(),
  public_key: pc.endpoint, relay: "wss://relay.test", new_until: null, admitted_at: null, admitted_before_you: false,
});
const someKey = (): { server_id: string; endpoint: string } => {
  const key = generateKeyPair().publicKey;
  return { server_id: deriveServerId(key), endpoint: Buffer.from(key).toString("hex") };
};

/** The same device on a new page: a new list over the stores it saved, as a reload makes. `lists`: its store as this page sees it. */
const reloaded = (w: World, device: WorldDevice, lists: ListStore = device.lists): AccountList => accountList({
  service: device.service, accountStore: device.store, listStore: lists, lock: memoryListLock(), now: () => w.clock.now,
  names: () => ({ label: "Phone", os: "ios" }), linkedPcs: async () => 0, durable: async () => true,
});

/** A list store whose every write fails as a full disk makes it fail (QuotaExceededError); reads go on. */
const full = (inner: ListStore): ListStore => ({
  get: (record, account) => inner.get(record, account),
  set: async () => { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); },
  swap: async () => { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); },
  drop: (account, copy) => inner.drop(account, copy),
  accounts: () => inner.accounts(),
});

const noPairings: ShellDeviceStore = { get: async () => undefined, list: async () => [], remove: async () => {}, removeRow: async () => false, update: async () => { throw new Error("No pairing is made here"); } };

describe("P11 review: what a page that holds a saved copy draws and opens", () => {
  let browser: ReturnType<typeof openShellPage>;
  beforeEach(() => { browser = openShellPage(); });
  afterEach(async () => { setPageAccountList(null); await browser.close(); });

  /** A device that started its account's list and added Desk to it; the account service's directory also names a PC of its own. */
  async function account() {
    const w = listWorld("acct_owner", Date.now());
    const phone = await w.device({ label: "Phone" });
    await phone.list.sync();
    const desk = await addListPc(w, phone, "Desk");
    const rogue = someKey();
    const directory = [routed(desk, "PC"), routed(rogue, "Rogue")];
    return { w, phone, desk, rogue, directory };
  }

  const controllerOf = (w: World, phone: WorldDevice, list: AccountList, directory: readonly DirectoryPc[]) => createAccountController({
    container: Object.create(null), entryUrl: "https://app.ovis.sh/", store: noPairings, accountStore: phone.store, accountService: w.origin, accountList: list,
    accountFetch: async (input, init) => {
      const request = new Request(input, init);
      return new URL(request.url).pathname === "/v1/pcs" ? Response.json({ pcs: directory }) : w.fake.fetch(request);
    },
    renderApp: () => ({ render() {}, unmount() {} }),
  }, { active: () => true, changed: async () => {}, outdated: () => new Set() });

  it("HOLDS: on a reload whose list round succeeds, the PC that only the directory names is marked and never opens by itself", async () => {
    const { w, phone, desk, rogue, directory } = await account();
    w.clock.now += 60_000;
    const controller = controllerOf(w, phone, reloaded(w, phone), directory);
    try {
      await controller.refresh(true);
      await settle();
      const state = controller.state;
      if (state?.kind !== "signed-in" || state.pcs === null) throw new TypeError("not drawn");
      expect(state.pcs.find((pc) => pc.server_id === rogue.server_id)).toMatchObject({ notInList: true });
      expect(accountOpenablePcs(state.pcs, { account: w.account, devices: [], now: Date.now() }).map((pc) => pc.server_id)).toEqual([desk.server_id]);
      expect(controller.listHolds(desk.server_id)).toBe(true);
    } finally { controller.dispose(); }
  });

  it("FINDING F1: a reload whose first list round throws (a storage write fails) draws the account service's directory as the account's own, and opens a PC the list does not hold by itself", async () => {
    const { w, phone, desk, rogue, directory } = await account();
    // the floor of the device's clock moves with this round, so the round writes; the disk is full
    w.clock.now += 60_000;
    const list = reloaded(w, phone, full(phone.lists));
    const controller = controllerOf(w, phone, list, directory);
    try {
      await controller.refresh(true);
      await settle();
      const state = controller.state;
      if (state?.kind !== "signed-in" || state.pcs === null) throw new TypeError("not drawn");
      // the copy is there and reads: this device follows the list, and the list holds Desk and not Rogue
      expect(await list.follows(w.account)).toBe(true);
      const opens = accountOpenablePcs(state.pcs, { account: w.account, devices: [], now: Date.now() }).map((pc) => pc.server_id);
      // what should hold (X6, docs/account-list.md "no row is drawn as the account's own by the account service's word alone")
      expect({ rogueMarked: state.pcs.find((pc) => pc.server_id === rogue.server_id)?.notInList === true, rogueOpensByItself: opens.includes(rogue.server_id), deskByListKey: controller.listHolds(desk.server_id) })
        .toEqual({ rogueMarked: true, rogueOpensByItself: false, deskByListKey: true });
    } finally { controller.dispose(); }
  });

  /** Settings' and the notice's Remove (usePcRemoval) on this page, with an account service whose directory removal answers 204. */
  async function removal() {
    const deleted: string[] = [];
    const told: string[] = [];
    const service = { forSignIn: () => ({ deletePc: async (serverId: string) => { deleted.push(serverId); } }) } as unknown as Parameters<typeof usePcRemoval>[0];
    let hook: ReturnType<typeof usePcRemoval> | undefined;
    const Probe = () => { hook = usePcRemoval(service, (_serverId, how) => { told.push(how); }); return null; };
    await browser.page.render(createElement(SettingsProvider, { children: createElement(Probe) }));
    return { deleted, told, remove: (session: WorldDevice["session"], serverId: string) => act(async () => { await hook!.remove(session, serverId).catch(() => false); }) };
  }

  for (const [when, prepare] of [
    // the page's list exists and holds a copy, and this page has not finished its first round yet (a reload, the app just opened)
    ["before this page's first list round has ended", async (_w: World, _phone: WorldDevice, list: AccountList) => { void list; }],
    // or its rounds throw (F1's full disk): then for as long as the page lives
    ["when this page's list rounds throw", async (_w: World, _phone: WorldDevice, list: AccountList) => { await list.sync().catch(() => undefined); }],
  ] as const) {
    it(`FINDING F2: Remove of a PC the saved copy holds, ${when}, goes to the account service's directory, says "directory" (Settings then forgets this device's own pairing) and leaves the PC in the list`, async () => {
      const { w, phone, desk } = await account();
      w.clock.now += 60_000;
      const list = reloaded(w, phone, when.startsWith("when") ? full(phone.lists) : phone.lists);
      setPageAccountList(list);
      await prepare(w, phone, list);
      const r = await removal();
      await r.remove(phone.session, desk.server_id);
      const stillIn = (await phone.list.sync()).pcs.some((pc) => pc.endpoint === desk.endpoint);
      // what should hold: the PC leaves by an entry of the list, or the removal fails and says so; never the directory's
      // DELETE, never "removed" while the list still holds it, and never "directory" (on which Settings forgets the pairing)
      expect({ directoryDelete: r.deleted, toldDirectory: r.told.includes("directory"), shownRemovedButStillIn: r.told.length > 0 && stillIn })
        .toEqual({ directoryDelete: [], toldDirectory: false, shownRemovedButStillIn: false });
    });
  }

  it("FINDING F3 (the sidebar): the sidebar's rows, read before this page's first list round, mark nothing, and the sidebar adds by itself every row not marked `outside`", async () => {
    const { w, phone, desk, rogue, directory } = await account();
    setPageAccountList(reloaded(w, phone));
    // the page's own sign-in, as the sidebar reads it (indexedAccountStore, the page's fetch)
    const spies = [spyOn(indexedAccountStore, "get").mockImplementation(phone.store.get), spyOn(indexedAccountStore, "update").mockImplementation(phone.store.update), spyOn(indexedAccountStore, "set").mockImplementation(phone.store.set)];
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      return new URL(request.url).pathname === "/v1/pcs" ? Response.json({ pcs: directory }) : w.fake.fetch(request);
    }) as typeof fetch;
    try {
      const read = await signedInAccount().list();
      const rows = read?.pcs ?? [];
      expect({ rogueOutside: rows.find((pc) => pc.server_id === rogue.server_id)?.outside === true, deskOutside: rows.find((pc) => pc.server_id === desk.server_id)?.outside === true })
        .toEqual({ rogueOutside: true, deskOutside: false });
    } finally { globalThis.fetch = fetchBefore; for (const spy of spies) spy.mockRestore(); }
  });
});

describe("P11 review: a device that every sign-in now offers account-list-1 from, meeting a pinned PC that holds no row for it", () => {
  let browser: ReturnType<typeof openShellPage>;
  beforeEach(() => { browser = openShellPage(); });
  afterEach(async () => { await browser.close(); });

  /**
   * A saved pairing of a device with no account here (signed out, or of an account with no list), opened on its PC's own
   * page; the PC removed that pairing and answers its sign-in with `refusal`. What the screen ends at, what is kept.
   */
  async function revokedPairing(refusal: MuxProtocolError) {
    const identity = generateKeyPair();
    const serverId = deriveServerId(identity.publicKey);
    const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const saved: RelayDevice[] = [{ server_id: serverId, server_public_key: exportPublicKey(identity.publicKey), relay: "wss://relay.ovis.sh", device_id: "row-1", private_key: key.privateKey, public_spki: "spki", label: "Phone", name: "Desk" }];
    const store: ShellDeviceStore = {
      async get(id) { return saved.find((device) => device.server_id === id); }, async list() { return [...saved]; },
      async remove(id) { const at = saved.findIndex((device) => device.server_id === id); if (at >= 0) saved.splice(at, 1); },
      async removeRow(id, row) { const at = saved.findIndex((device) => device.server_id === id && device.device_id === row); if (at < 0) return false; saved.splice(at, 1); return true; },
      async update(id, change) { const next = change(saved.find((device) => device.server_id === id)); const at = saved.findIndex((device) => device.server_id === id); if (at >= 0) saved[at] = next; else saved.push(next); return next; },
    };
    const navigations: string[] = [];
    const states: string[] = [];
    let tries = 0;
    const render = (node: unknown): void => {
      let at = node as { type?: unknown; props?: { children?: unknown; state?: { kind: string; failure?: string } } };
      while (at?.props !== undefined && at.props.state === undefined && at.props.children !== undefined) at = at.props.children as typeof at;
      if (at?.props?.state !== undefined) states.push(at.props.state.failure === undefined ? at.props.state.kind : `${at.props.state.kind}:${at.props.state.failure}`);
    };
    await mountRelayShell({
      container: Object.create(null), entryUrl: `https://app.ovis.sh/s/${serverId}/`, shellVersion: "1.0.0", label: "Phone", store, accountService: null,
      createRoot: () => ({ render, unmount() {} }), renderApp: () => ({ render() {}, unmount() {} }), pendingPush: { get: async () => undefined, clear: async () => {} },
      checkPc: async () => ({ kind: "offline", reason: "relay" }), reload: async () => {},
      navigate: (path) => { navigations.push(path); }, replace: (path) => { navigations.push(path); },
      open: (async () => { tries += 1; throw refusal; }) as unknown as RelayShellMount["open"],
    } as RelayShellMount);
    await settle();
    return { serverId, saved, navigations, states, tries: () => tries };
  }

  it("HOLDS (as before P11): a revoked pairing answered `auth_failed` is told it was removed, and its dead row is forgotten", async () => {
    const run = await revokedPairing(new MuxProtocolError("auth_failed", "Unknown device"));
    expect({ removed: removedPcs()[run.serverId], kept: run.saved.length, joins: run.navigations.filter((path) => path.includes("#offer=")).length }).toEqual({ removed: "removed", kept: 0, joins: 0 });
  });

  it("FINDING F4: the same revoked pairing on a pinned PC is answered `account_list_required` (it offered the feature) and is led to a join sheet; nothing says it was removed and its dead row stays, so every start does it again", async () => {
    const run = await revokedPairing(new MuxProtocolError("account_list_required", "This PC lets devices of its account in by the account's signed list."));
    expect({ removed: removedPcs()[run.serverId], kept: run.saved.length, joins: run.navigations.filter((path) => path.includes("#offer=")).length }).toEqual({ removed: "removed", kept: 0, joins: 0 });
  });
});

describe("P11 review: the clean-up a Remove signs", () => {
  it("FINDING F6 (also astra-cl11b HIGH 3, ruled C3): Remove signs the removal of a borrowed key while this device's clock reads more than ten minutes under its floor (X1 amended)", async () => {
    const start = Date.now();
    const w = listWorld("acct_owner", start);
    const first = await w.device({ label: "Phone" });
    await first.list.sync();
    // a second device whose clock runs five minutes fast: the account service takes its entries (ten minutes at most)
    const second = await w.device({ label: "Tablet", skew: 5 * 60_000 });
    await second.list.sync();
    const outcome = await allowDevice(first.list, { key: (await second.keys()).key, label: "Tablet", os: "android" }, noWait);
    if (!outcome.allowed) throw new Error(`not let in: ${outcome.why}`);
    await second.list.adopt(outcome.offer);
    const desk = await addListPc(w, first, "Desk");
    // a borrowed browser, let in until three minutes from now (the true time is the account service's)
    const browser = await w.device({ label: "Borrowed browser" });
    await browser.list.sync();
    const writer = first.list.writer()!;
    const browserKey = (await browser.keys()).key;
    const claim = (await writer.service.listClaims(writer.list)).find((each) => each.key === browserKey)!;
    const borrowed = await signListEntry(writer.state, { kind: "device", key: claim.key, power: "bound", role: "drive", until: Math.floor(w.clock.now / 1000) + 180, enc: claim.enc, card: claim.card, sealed: null, rotates: false }, { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
    await writer.service.placeEntries(writer.list, [borrowed.text], []);
    // the tablet's floor is pushed two hours ahead (a date set forward once), then its clock is set back: it reads
    // 5 minutes fast now, and more than ten minutes under its own floor
    w.clock.now += 2 * 60 * 60_000;
    await second.list.sync();
    w.clock.now -= 2 * 60 * 60_000;
    await second.list.sync();
    expect(second.list.writer()!.adrift).toBe(true);
    expect(await removeListPc(second.list, desk.endpoint, noWait)).toEqual({ removed: true });
    const sent = second.sent.filter((each) => each.route.endsWith("/entries")).at(-1)!.body!.entries as string[];
    const ends = sent.map((text) => readBody(entryFromText(text).body)).flatMap((body) => body.kind === "remove" && "ends" in (body as unknown as Record<string, unknown>) ? [(body as unknown as { ends: string }).ends] : []);
    // the borrowed browser's three minutes are not over by the true time: no clean-up removal may be signed here
    expect(ends).not.toContain(browserKey);
  });
});

describe("P11 review: which key the shell signs in with, against a PC that lies about following a list", () => {
  let browser: ReturnType<typeof openShellPage>;
  beforeEach(() => { browser = openShellPage(); });
  afterEach(async () => { await browser.close(); });

  /**
   * A PC's own page, signed in with a registered key, on a device whose list holds that PC (or not: `holds`). The PC
   * answers each sign-in with `answer`, by the key it came with. What was tried, and where the page ended.
   */
  async function listedPc(held: boolean, answer: (how: "list" | "sign-in" | "other") => Error | "admit" | null, heldAfterRead = held, paired = false, until: number | null = null) {
    let holds = held;
    const identity = generateKeyPair();
    const serverId = deriveServerId(identity.publicKey);
    // a press on the PC's row led here: a PC this device's list does not hold is opened by its own page only on that
    // word (added after the review: its own finding's sibling, astra-cl11b HIGH 1, made every such open need a press)
    notePcTap(serverId);
    const endpoint = Buffer.from(identity.publicKey).toString("hex");
    // `paired`: this device also keeps a pairing it made at that PC
    const pairingKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const saved: RelayDevice[] = paired ? [{ server_id: serverId, server_public_key: exportPublicKey(identity.publicKey), relay: "wss://relay.ovis.sh", device_id: "row-1", private_key: pairingKey.privateKey, public_spki: "spki", label: "Phone", name: "Desk" }] : [];
    const store: ShellDeviceStore = {
      async get(id) { return saved.find((device) => device.server_id === id); }, async list() { return [...saved]; },
      async remove(id) { const at = saved.findIndex((device) => device.server_id === id); if (at >= 0) saved.splice(at, 1); },
      async removeRow(id, row) { const at = saved.findIndex((device) => device.server_id === id && device.device_id === row); if (at < 0) return false; saved.splice(at, 1); return true; },
      async update(id, change) { const next = change(saved.find((device) => device.server_id === id)); const at = saved.findIndex((device) => device.server_id === id); if (at >= 0) saved[at] = next; else saved.push(next); return next; },
    };
    const accountStore = (await import("../account/store.ts")).memoryAccountStore();
    await accountStore.set("session", { service: "https://account.ovis.sh", account: "acct_1", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000, sign_in_id: "sign-in-1", signed_in_at: Date.now() });
    await accountStore.set("signin_key", { account: "acct_1", sign_in_id: "sign-in-1", no: 1, key: await (await import("../account/store.ts")).newKey() });
    const memberKey = (await accountStore.key()).public_spki;
    const view = () => ({ account: "acct_1", reached: true, status: { at: "following", list: "5c".repeat(32), standing: "in", head: 1, read_at: 1, trouble: null },
      devices: [{ key: memberKey, self: true, power: until === null ? "full" : "bound", role: "drive", until, carried: false, name: null }],
      pcs: holds ? [{ endpoint, server_id: serverId, how: "added", allows: true, name: { label: "Desk", os: null }, seq: 1, by: memberKey, new_at: null }] : [] });
    let reads = 0;
    const list = {
      // the first read is the page's own round; a later one is the read a PC's `account_list_required` asks for
      sync: async () => { reads += 1; if (reads > 1) holds = heldAfterRead; return view(); }, follows: async () => true, view, subscribe: () => () => {}, holdsPc: () => holds, pcOfKey: () => null, due: () => null,
      shadow: async () => null, dropNames: async () => {}, forget: async () => {}, adopt: async () => view(), writer: () => null, placeAt: () => null, holdsEntry: () => false, gossip: () => null, pageAfter: () => null,
      kept: async () => null, keep: async () => { throw new Error("nothing is signed here"); }, unkeep: async () => {}, waiting: async () => null, cancel: async () => "gone" as const,
      shown: () => Math.floor(Date.now() / 1000),
    } as unknown as AccountList;
    const tried: string[] = [];
    const navigations: string[] = [];
    let opened = 0;
    const fatal: ((error: Error) => void)[] = [];
    const failures: string[] = [];
    await mountRelayShell({
      container: Object.create(null), entryUrl: `https://app.ovis.sh/s/${serverId}/`, shellVersion: "1.0.0", label: "Phone", store, accountStore, accountList: list,
      accountService: "https://account.ovis.sh", accountProviders: ["github"],
      accountFetch: async (input) => new URL(input instanceof Request ? input.url : String(input)).pathname === "/v1/pcs"
        ? Response.json({ pcs: [{ ...routed({ server_id: serverId, endpoint }, "Desk"), relay: "wss://relay.ovis.sh" }] }) : new Response(null, { status: 404 }),
      createRoot: () => ({ render(node: unknown) {
        let at = node as { props?: { children?: unknown; state?: { kind: string; failure?: string } } } | undefined;
        while (at?.props !== undefined && at.props.state === undefined && at.props.children !== undefined) at = at.props.children as typeof at;
        if (at?.props?.state?.kind === "failed" && at.props.state.failure !== undefined) failures.push(at.props.state.failure);
      }, unmount() {} }), renderApp: () => { opened += 1; return { render() {}, unmount() {} }; },
      pendingPush: { get: async () => undefined, clear: async () => {} }, checkPc: async () => ({ kind: "offline", reason: "relay" }), reload: async () => {},
      navigate: (path) => { navigations.push(path); }, replace: (path) => { navigations.push(path); },
      open: (async (offer: ConstructorParameters<typeof RelayTransport>[0], options?: { accountListKey?: boolean; accountOpensAll?: boolean; onFatal?: (error: Error) => void }) => {
        const how = options?.accountListKey === true ? "list" : options?.accountOpensAll === true ? "sign-in" : "other";
        tried.push(how);
        const refusal = answer(how);
        if (refusal === "admit") { if (options?.onFatal) fatal.push(options.onFatal); return new Admitted(offer); }
        if (refusal !== null) throw refusal;
        throw new RangeError("stop here: the test looks only at the keys tried");
      }) as unknown as RelayShellMount["open"],
    } as RelayShellMount);
    for (let turn = 0; turn < 10 && navigations.length === 0; turn += 1) await settle();
    return { serverId, tried, navigations, saved, fatal, failures, opened: () => opened };
  }

  it("HOLDS (kills M6): a PC that wants the list key from the sign-in key and then says it follows no list gets each key once, and the page goes to the join", async () => {
    const { AccountListUnsupportedError } = await import("../../../shared/relay-channel.ts");
    const run = await listedPc(true, (how) => how === "list" ? new AccountListUnsupportedError() : new MuxProtocolError("account_list_required", ""));
    expect(run.tried).toEqual(["list", "sign-in"]);
    expect(run.navigations.some((path) => path.includes("#offer="))).toBe(true);
  });

  it("HOLDS (kills M5): a PC the copy did not name that wants the list key, and then says it follows no list once the read found it, gets each key once", async () => {
    const { AccountListUnsupportedError } = await import("../../../shared/relay-channel.ts");
    const run = await listedPc(false, (how) => how === "list" ? new AccountListUnsupportedError() : new MuxProtocolError("account_list_required", ""), true);
    expect(run.tried).toEqual(["sign-in", "list"]);
    expect(run.navigations.some((path) => path.includes("#offer="))).toBe(true);
  });

  it("FINDING F5: a saved pairing opened on its PC's own page that the PC answers `account_list_required` is sent to the join, though this device's list holds it and the PC: the page has not read the sign-in, so it has no list key", async () => {
    const run = await listedPc(true, (how) => how === "list" ? "admit" : new MuxProtocolError("account_list_required", ""), true, true);
    expect({ tried: run.tried, joins: run.navigations.filter((path) => path.includes("#offer=")).length }).toEqual({ tried: ["other", "list"], joins: 0 });
  });

  it("HOLDS: a saved pairing that a pinned PC sends to the list key at a reconnect, whose list key the PC then ends, keeps this device's own pairing", async () => {
    let refuse = false;
    const run = await listedPc(true, (how) => how === "list" ? new MuxProtocolError("auth_revoked", "") : refuse ? new MuxProtocolError("account_list_required", "") : "admit", true, true);
    for (let turn = 0; turn < 10 && run.opened() === 0; turn += 1) await settle();
    // the session was let in by its pairing; at a reconnect the PC says to come by the list key, which it then ends
    refuse = true;
    run.fatal[0]!(new MuxProtocolError("account_list_required", ""));
    for (let turn = 0; turn < 10 && run.tried.length < 2; turn += 1) await settle();
    await settle();
    expect(run.tried).toEqual(["other", "list"]);
    expect(run.saved.map((device) => device.device_id)).toEqual(["row-1"]);
  });

  it("HOLDS (kills M17): a borrowed device whose time is not over, whose list key a PC refuses, is led to the join and not told that its time is over", async () => {
    const run = await listedPc(true, () => new MuxProtocolError("auth_failed", ""), true, false, Math.floor(Date.now() / 1000) + 3600);
    expect(run.tried).toEqual(["list"]);
    expect(run.failures).not.toContain("list-time-over");
    expect(run.navigations.some((path) => path.includes("#offer="))).toBe(true);
  });
});

describe("P11 review: a request that waits (X5)", () => {
  it("HOLDS (kills M40): a request older than ten minutes is not let go while the forced read of the log does not reach the account service", async () => {
    const w = listWorld("acct_owner", Date.now());
    const first = await w.device({ label: "Phone" });
    await first.list.sync();
    const desk = await addListPc(w, first, "Desk");
    const second = await w.device({ label: "Tablet" });
    await second.list.sync();
    const newcomer = { key: (await second.keys()).key, label: "Tablet", os: "android" as const };
    // every placement is answered head_moved and the device's own read shows the same head: the Allow's request stays kept
    w.fake.tamperList(w.held().id, { headMoved: true });
    expect(await allowDevice(first.list, newcomer, noWait)).toMatchObject({ allowed: false, why: "busy" });
    w.fake.untamperList(w.held().id);
    w.clock.now += 11 * 60_000;
    // the account service cannot be read now: whether the Allow's request was placed is not known
    first.wire.answer = (request) => new URL(request.url).pathname.startsWith("/v2/lists") ? new Response(null, { status: 503 }) : null;
    expect(await removeListPc(first.list, desk.endpoint, noWait)).toMatchObject({ removed: false, why: "waiting" });
    expect(await first.list.waiting()).toMatchObject({ for: `allow:${newcomer.key}` });
  });

  it("HOLDS (kills M56): the Remove of one PC never sends the request kept for the Remove of another, and never says that PC is out", async () => {
    const w = listWorld("acct_owner", Date.now());
    const first = await w.device({ label: "Phone" });
    await first.list.sync();
    const desk = await addListPc(w, first, "Desk");
    const laptop = await addListPc(w, first, "Laptop");
    w.fake.tamperList(w.held().id, { headMoved: true });
    expect(await removeListPc(first.list, desk.endpoint, noWait)).toMatchObject({ removed: false, why: "busy" });
    w.fake.untamperList(w.held().id);
    // a minute on, the person removes the other PC
    w.clock.now += 60_000;
    const outcome = await removeListPc(first.list, laptop.endpoint, noWait);
    const holds = (await first.list.sync()).pcs.map((pc) => pc.endpoint);
    // either Laptop is out, or the removal says it is not: never "removed" while the list still holds Laptop
    expect(outcome.removed && holds.includes(laptop.endpoint)).toBe(false);
    // and Desk is not put out by a press on Laptop
    expect(holds).toContain(desk.endpoint);
  });
});
