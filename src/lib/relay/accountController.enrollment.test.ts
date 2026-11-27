import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import { EnrollmentStatus } from "../../components/EnrollmentStatus.tsx";
import { ACCOUNT_FEATURE, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";
import { exportPublicKey, generateKeyPair, importPublicKey } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { accountDeviceId, newRecordId, signAccountRecord } from "../../../shared/account-records.ts";
import type { AddRecord } from "../../../shared/account-records.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import type { AccountList, AccountListView } from "../account/accountList.ts";
import type { PcFetch } from "../account/join.ts";
import { enrollPc, planEnroll, rememberDevice } from "../account/join.ts";
import { memoryAccountStore, memoryLock, newKey } from "../account/store.ts";
import { refusalOf } from "./firstLink.ts";
import { AccountService, AccountServiceUnreachableError } from "../account/service.ts";
import { SettingsProvider } from "../settings.ts";
import { setCurrentLanguage, translate } from "../i18n.ts";
import { AddedToListError, ConsentChangedError, createAccountController, ListUnwritableError, PlacedInListError } from "./accountController.ts";
import { accountList as accountListOf } from "../account/accountList.ts";
import { askingPc, postPcKeys } from "../account/accountList.test-helpers.ts";
import { memoryListLock, memoryListStore } from "../account/listStore.ts";
import { ACCOUNT_SENDS, NETWORK_RETRY_MS, RETRY_AFTER_MAX_MS } from "./networkRetry.ts";
import { offerOf } from "./shellState.ts";
import { keepKnownPcs, knownPcs } from "../account/knownPcs.ts";
import type { MyPc } from "../account/myPcs.ts";
import { enrollmentOf, type RelayDevice, type SavedDevice, type ShellDeviceStore } from "./device.ts";
import { createShellTestPage } from "./shell.test.tsx";
import { RelayTransport } from "./transport.ts";
import { forgetSavedPc } from "./updateFlow.ts";

describe("account enrollment ownership", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  const transports: RelayTransport[] = [];
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  beforeEach(() => { browser = createShellTestPage(); browser.setVisibility("hidden"); });
  afterEach(() => {
    jest.useRealTimers();
    for (const transport of transports.splice(0)) transport.close();
    browser.dispose();
    if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
    else delete (globalThis as Record<string, unknown>)["navigator"];
    setCurrentLanguage("en");
  });

  async function fixture(heldPath: string, options: { readonly linking?: boolean; readonly planned?: false; readonly addAtPc?: true; readonly admitted?: number; readonly listed?: boolean; readonly holdRenewal?: boolean; readonly peerFetch?: PcFetch; readonly heldAccount?: string;
    readonly accountAnswer?: (route: string, sent: number, init?: RequestInit) => Response | Error | undefined | Promise<Response | Error | undefined>;
    readonly viewActive?: boolean;
    /** this device follows its account's signed list (`following`), waits to be let into it (`waiting`), or the round that tells has not ended (`unread`) */
    readonly list?: "following" | "waiting" | "unread" | "unanswered";
    /**
     * this device is in its account's signed list for real (it started it), and the PC answers the naming of a list as a
     * PC that can follow one does: its card for the list over the session, then that it read the entry. `"none"`: the PC
     * has no such call.
     */
    readonly named?: "follows" | "unread" | "none";
    /** another tab saves a newer pairing of this PC just before this tab deletes the pairing it holds */
    readonly replaceAtRemove?: true;
    /** the PC lets its account's devices in by the account's signed list alone: it refuses a link */
    readonly pinned?: true;
    /** whether the PC is in the account, where that is not what `linking` says */
    readonly inAccount?: boolean;
    /** the PC's row of this device is no member's */
    readonly unlinkedRow?: true;
    /**
     * an own sign-in made 30 days ago, on an account service with Step 2 on (both clocks agree), with the key it registered
     * or none; `before`: the account service from before key proofs
     */
    readonly old?: { readonly key: boolean; readonly before?: boolean } } = {}) {
    const identity = generateKeyPair();
    const offer = { v: 1 as const, server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey), relay: "wss://relay.invalid", name: "Desk" };
    const accountStore = memoryAccountStore();
    let ahead = 0;
    const service = new FakeAccountService(() => Date.now() + ahead);
    const token = service.issueToken("account");
    await accountStore.set("session", { service: "https://account.invalid", account: "account", provider: "github", access_token: token, refresh_token: "test", expires_at: Date.now() + 3_600_000,
      ...(options.old === undefined ? {} : { sign_in_id: "this-sign-in", signed_in_at: Date.now() - 30 * 86_400_000 }) });
    if (options.old !== undefined) {
      service.opensAll = true;
      service.pcAddProofs = options.old.before !== true;
      if (options.old.key) {
        const registered = await newKey();
        await accountStore.set("signin_key", { account: "account", sign_in_id: "this-sign-in", key: registered, no: service.registerSessionKey(token, registered.public_spki, "Phone") });
      }
      ahead = 30 * 86_400_000;
    }
    const key = await accountStore.key();
    const original: RelayDevice = { ...offer, device_id: "12".repeat(8), private_key: key.private_key, public_spki: key.public_spki, label: "Phone", account: "account" };
    const devices = new Map([[offer.server_id, original]]);
    // another tab's newer pairing of this PC, saved just before this tab's delete runs
    const newer: RelayDevice = { ...original, device_id: "56".repeat(8) };
    const replaced = (id: string): void => { if (options.replaceAtRemove && devices.get(id)?.device_id === original.device_id) devices.set(id, newer); };
    const store: ShellDeviceStore = {
      get: async (id) => devices.get(id), list: async () => [...devices.values()],
      remove: async (id) => { replaced(id); devices.delete(id); },
      removeRow: async (id, row) => { replaced(id); if (devices.get(id)?.device_id !== row) return false; devices.delete(id); return true; },
      update: async (id, change, source) => { source?.assert(devices.get(source.serverId)); const next = change(devices.get(id)); devices.set(id, next); return next; },
    };
    const records: AddRecord[] = [];
    for (let index = 0; index < 2; index++) {
      const peerKey = await memoryAccountStore().key();
      const record = await signAccountRecord({ v: 1, kind: "add", account: "account", key: peerKey.public_spki, label: "Other device", role: "drive", issued_at: new Date().toISOString(), id: newRecordId(), signer: key.public_spki }, key.private_key);
      await rememberDevice(accountStore, record);
      records.push(record);
    }
    if (options.planned !== false) await planEnroll(accountStore, offer.server_id, "account");
    const requested = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const renewalRequested = Promise.withResolvers<void>();
    const renewalResponse = Promise.withResolvers<void>();
    const putPcs: string[] = [];
    // every request to the account service, with the fake clock's time it went at
    const sends: { readonly route: string; readonly at: number }[] = [];
    const accountRequested = Promise.withResolvers<void>();
    const accountRelease = Promise.withResolvers<void>();
    const signOutAsked = Promise.withResolvers<void>();
    const viewChanged = Promise.withResolvers<void>();
    let accountHeld = false;
    let linked = options.inAccount ?? !options.linking;
    let introductions = 0;
    let links = 0;
    const answer = (path: string): Response => {
      switch (path) {
        case "/api/account/status": return Response.json({ account: linked ? "account" : null, unlinked: options.unlinkedRow ? [original.device_id] : [], removals: [], enrolling: options.planned !== false, ...(options.addAtPc ? { pc_add_required: true } : {}) });
        case "/api/account/link": links++; if (options.pinned) return Response.json({ error: { code: "list_followed" } }, { status: 409 }); linked = true; return Response.json({});
        case "/api/account/enroll": return Response.json({ results: records.map((record, index) => ({ id: record.id, outcome: index < (options.admitted ?? 2) ? "applied" : "refused", code: "key_held" })) });
        case "/api/account/introduction": introductions++; return Response.json({ pcs: [] });
        default: throw new TypeError("Unexpected PC request: " + path);
      }
    };
    class Admitted extends RelayTransport {
      override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL, features: [ACCOUNT_FEATURE] }; }
      override async renew() {
        if (!options.holdRenewal) return;
        renewalRequested.resolve();
        await renewalResponse.promise;
      }
      override async fetch(path: string) { if (path === heldPath) { requested.resolve(); return response.promise; } return path === "/api/account/list/named" ? named() : answer(path); }
    }
    class Peer extends RelayTransport {
      override async fetch(path: string, init?: RequestInit) {
        if (options.peerFetch === undefined) throw new TypeError("Unexpected peer request");
        return options.peerFetch(path, init);
      }
    }
    const listStatus: AccountListView["status"] = options.list === "waiting" ? { at: "not_in", list: "5c".repeat(32), why: "not_mine", claim: "claimed" }
      : { at: "following", list: "5c".repeat(32), standing: "in", head: 1, read_at: 1, trouble: null };
    const listView: AccountListView = { account: "account", reached: true, status: listStatus, devices: [], pcs: [] };
    const unread: AccountListView = { account: null, reached: true, status: { at: "off" }, devices: [], pcs: [] };
    // the account service did not say whether the account has a list, and this page holds no copy that says so
    const unanswered: AccountListView = { account: "account", reached: false, status: { at: "off" }, devices: [], pcs: [] };
    let listRead = options.list !== "unread";
    const accountList: AccountList | undefined = options.list === undefined ? undefined : {
      sync: async () => { listRead = true; return options.list === "unanswered" ? unanswered : listView; }, follows: async () => true, view: () => options.list === "unanswered" ? unanswered : listRead ? listView : unread, subscribe: () => () => {}, holdsPc: () => false, pcOfKey: () => null, due: () => null,
      shown: () => Math.floor(Date.now() / 1000), shadow: async () => null, dropNames: async () => {}, forget: async () => {}, pinnedElsewhere: async () => null, adopt: async () => listView, writer: () => null, placeAt: () => null, holdsEntry: () => false, gossip: () => null, pageAfter: () => null, compare: () => null, takeFromPeer: async () => null, knowsPc: () => false, kept: async () => null, keep: async () => { throw new Error("nothing is signed in this test"); }, unkeep: async () => {}, waiting: async () => null, cancel: async () => "gone" as const,
    };
    // the PC's own keys for a list, and the device's real list, where a test names a list to the PC
    const pcKeys = options.named === undefined ? null : { ...(await askingPc()), endpoint: Array.from(identity.publicKey, (byte) => byte.toString(16).padStart(2, "0")).join(""), server_id: offer.server_id, secret: identity.secretKey };
    let realList: AccountList | undefined;
    if (options.named !== undefined) {
      service.opensAll = true;
      service.listAccounts = "*";
      const stored = (await accountStore.get("session"))!;
      await accountStore.set("session", { ...stored, sign_in_id: "this-sign-in", signed_in_at: Date.now() });
      const registered = await newKey();
      await accountStore.set("signin_key", { account: "account", sign_in_id: "this-sign-in", key: registered, no: service.registerSessionKey(token, registered.public_spki, "Phone") });
      realList = accountListOf({ service: new AccountService({ store: accountStore, fetch: service.fetch, lock: memoryLock() }), accountStore, listStore: memoryListStore(), lock: memoryListLock(), genesis: () => "always", durable: async () => true, names: () => ({ label: "Phone", os: "ios" }) });
      await realList.sync();
    }
    let namings = 0;
    const named = async (): Promise<Response> => {
      namings++;
      if (options.named === "none" || pcKeys === null) return Response.json({ error: { code: "not_found" } }, { status: 404 });
      const held = service.accountList("account")!;
      const row = held.state.pcs[pcKeys.endpoint];
      // `unread`: the PC has not read its entry yet, at any ask
      if (options.named === "follows" && row !== undefined && row.removed === null && row.key === pcKeys.key) return Response.json({ state: "added", account: "account" });
      // as the PC does: it posts its keys and its card to the account service too
      const card = await postPcKeys(service.fetch, "https://account.invalid", token, pcKeys, held.id);
      return Response.json({ state: "waiting", standing: "waiting", key: pcKeys.key, enc: pcKeys.enc, card });
    };
    const open = async (target: RelayOffer = offer) => { const transport = target.server_id === offer.server_id ? new Admitted(offer) : new Peer(target); transports.push(transport); return transport; };
    const controller = () => createAccountController({
      container: Object.create(null), entryUrl: "https://app.ovis.invalid", renderApp: () => { throw new TypeError("No app here"); },
      store, accountStore, accountService: "https://account.invalid", accountProviders: ["github"], open, ...(realList !== undefined ? { accountList: realList } : accountList === undefined ? {} : { accountList }),
      accountFetch: async (input, init) => {
        const route = `${init?.method ?? "GET"} ${new URL(input instanceof Request ? input.url : String(input)).pathname}`;
        sends.push({ route, at: Date.now() });
        const given = await options.accountAnswer?.(route, sends.filter((sent) => sent.route === route).length, init);
        if (given instanceof Error) throw given;
        if (given !== undefined) return given;
        if (route === "POST /v1/signout") signOutAsked.resolve();
        if (route === options.heldAccount && !accountHeld) { accountHeld = true; accountRequested.resolve(); await accountRelease.promise; }
        if (init?.method === "PUT") putPcs.push("put");
        if (options.listed && init?.method === "GET") return Response.json({ pcs: [{ server_id: "a".repeat(32), label: "Unread PC", public_key: null, relay: offer.relay, added_at: new Date().toISOString(), last_seen_at: null }] });
        return service.fetch(input, init);
      },
    }, { active: () => options.viewActive === true, changed: async () => { viewChanged.resolve(); }, outdated: () => new Set() });
    return {
      controller: controller(), otherController: controller(), namings: () => namings, pcKeys, realList, store, original, requested, response, answer, open, records, putPcs, links: () => links, renewalRequested, renewalResponse, accountStore, key, service, linked: () => linked,
      accountRequested, accountRelease, signOutAsked, viewChanged: viewChanged.promise, introductions: () => introductions,
      /** the times, from the first, that `route` went to the account service */
      sent: (route: string) => sends.filter((sent) => sent.route === route).map((sent, _index, all) => sent.at - (all[0]?.at ?? 0)),
    };
  }
  type Run = Awaited<ReturnType<typeof fixture>>;
  const unlinked = async (run: Run): Promise<void> => {
    const own = await memoryAccountStore().key();
    const { account: _account, ...rest } = run.original;
    await run.store.update(run.original.server_id, () => ({ ...rest, private_key: own.private_key, public_spki: own.public_spki }));
  };
  const listInDirectory = (run: Run): Promise<void> => new AccountService({ store: run.accountStore, fetch: run.service.fetch }).putPc(run.original.server_id, {
    label: "Desk", relay: run.original.relay, public_key: Array.from(importPublicKey(run.original.server_public_key), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  });
  const tokenStatus = async (run: Run, token: string): Promise<number> => (await run.service.fetch(new URL("/v1/pcs", "https://account.invalid"), { headers: { authorization: `Bearer ${token}` } })).status;
  const laterSignIn = async (run: Run) => {
    const first = await run.accountStore.get("session");
    if (first === undefined) throw new TypeError("Missing sign-in");
    return { first, later: { ...first, access_token: run.service.issueToken("account"), refresh_token: "later", sign_in_id: "later" } };
  };

  it("opening a saved pairing of a PC that is in the account writes nothing to the account's directory", async () => {
    // the account may have removed the PC a moment ago, before the PC noticed: opening it must not put it back
    const run = await fixture("unused", { planned: false });
    expect(await run.controller.enroll(await run.open(), run.original.server_id, false)).toMatchObject({ state: "complete" });
    expect({ puts: run.putPcs, links: run.links() }).toEqual({ puts: [], links: 0 });
  });

  it("a saved pairing of a PC that left its account and waits to be added at the PC sends it no link and lists nothing", async () => {
    const run = await fixture("unused", { linking: true, planned: false, addAtPc: true });
    expect(await run.controller.enroll(await run.open(), run.original.server_id, false)).toBe("local");
    expect({ puts: run.putPcs, links: run.links() }).toEqual({ puts: [], links: 0 });
    // the pairing is this device's own again: nothing here says the PC is in the account
    expect((await run.store.get(run.original.server_id))?.account).toBeUndefined();
    expect(enrollmentOf((await run.store.get(run.original.server_id))!)).toBeUndefined();
  });

  it("a new pairing with such a PC still sends its link: only the PC knows whether its own code was used", async () => {
    const run = await fixture("unused", { linking: true, addAtPc: true });
    expect(await run.controller.enroll(await run.open(), run.original.server_id, true)).toMatchObject({ state: "complete" });
    expect(run.links()).toBe(1);
    expect(run.putPcs).toEqual(["put"]);
  });

  describe("on an account that lets its PCs in by its signed list", () => {
    /** what the row of the PC then says, as My PCs draws it */
    const rowSays = async (run: Run): Promise<string> => renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(EnrollmentStatus, { state: enrollmentOf((await run.store.get(run.original.server_id))!) }) }));
    for (const list of ["following", "waiting", "unread", "unanswered"] as const) {
      it(`opening a saved pairing lists no PC and starts no enrollment, though one was planned (${list})`, async () => {
        // the account service refuses that listing from a sign-in older than ten minutes: nothing is sent for it to refuse
        const run = await fixture("unused", { list, accountAnswer: (route) => route === "PUT /v1/pcs/" + run.original.server_id ? Response.json({ error: { code: "session_not_fresh", message: "" } }, { status: 403 }) : undefined });
        const asked: string[] = [];
        const opened = await run.open();
        const fetch = opened.fetch.bind(opened);
        opened.fetch = async (path: string) => { asked.push(path); return fetch(path); };
        const said = await run.controller.enroll(opened, run.original.server_id, false);
        // a device that still waits to be let into the list says nothing of the account: "In your account" is for one its own copy shows in
        if (list === "waiting") expect(said).toBe("local");
        else expect(said).toMatchObject({ state: "complete" });
        expect({ puts: run.putPcs, links: run.links(), enrolled: asked.includes("/api/account/enroll") }).toEqual({ puts: [], links: 0, enrolled: false });
        expect(await rowSays(run)).not.toContain("incomplete");
        // the pairing is what it was
        expect(await run.store.get(run.original.server_id)).toMatchObject({ device_id: run.original.device_id, public_spki: run.original.public_spki });
      });
    }

    it("where the account service did not say whether the account keeps a list, a saved pairing of a PC in no account is only left as it is: what its row says of the account is not erased", async () => {
      const run = await fixture("unused", { list: "unanswered", linking: true, planned: false });
      const before = (await run.store.get(run.original.server_id))! as { account?: string; account_enrollment?: unknown };
      expect(before.account).toBe("account");
      expect(await run.controller.enroll(await run.open(), run.original.server_id, false)).toBe("local");
      expect({ puts: run.putPcs, links: run.links() }).toEqual({ puts: [], links: 0 });
      // nothing was sent, and nothing was taken from the row: the next open that gets an answer decides
      expect(await run.store.get(run.original.server_id)).toMatchObject({ account: "account", device_id: run.original.device_id });
    });

    it("a saved pairing whose row is not linked yet, on a PC that is in the account and still enrolling, plans no enrollment of its own (M20)", async () => {
      const run = await fixture("unused", { list: "following", inAccount: true, unlinkedRow: true });
      await run.accountStore.set("enrolls", undefined);
      await run.controller.enroll(await run.open(), run.original.server_id, false);
      // the link goes, as for any row that is not linked; the enrollment that brings a PC into the account is the list's
      expect({ links: run.links(), plan: (await run.accountStore.get("enrolls"))?.[run.original.server_id], puts: run.putPcs }).toEqual({ links: 1, plan: undefined, puts: [] });
    });

    it("a saved pairing of a PC that is in no account sends it no link: a PC comes into such an account by the list", async () => {
      const run = await fixture("unused", { list: "following", linking: true, planned: false });
      await unlinked(run);
      const before = await run.store.get(run.original.server_id);
      expect(await run.controller.enroll(await run.open(), run.original.server_id, false)).toBe("local");
      expect({ puts: run.putPcs, links: run.links() }).toEqual({ puts: [], links: 0 });
      expect(await rowSays(run)).toBe("");
      expect(await run.store.get(run.original.server_id)).toMatchObject({ device_id: before!.device_id, public_spki: before!.public_spki, private_key: before!.private_key });
    });

    it("an account that follows no list lists and enrolls as before", async () => {
      const run = await fixture("unused", { linking: true });
      await unlinked(run);
      expect(await run.controller.enroll(await run.open(), run.original.server_id, false)).toMatchObject({ state: "complete" });
      expect({ puts: run.putPcs, links: run.links() }).toEqual({ puts: ["put"], links: 1 });
    });

    for (const fresh of [false, true]) {
      it(`a pairing made at a PC that lets devices in by the list alone is whole without a link (${fresh ? "new" : "saved"})`, async () => {
        const run = await fixture("unused", { list: "waiting", pinned: true, inAccount: true, unlinkedRow: true, planned: false });
        await unlinked(run);
        const before = await run.store.get(run.original.server_id);
        expect(await run.controller.enroll(await run.open(), run.original.server_id, fresh)).toBe("local");
        expect({ puts: run.putPcs, links: run.links() }).toEqual({ puts: [], links: 1 });
        // neither a failed pairing nor a failed enrollment: the row says nothing, and the pairing opens the PC as before
        expect(await rowSays(run)).toBe("");
        expect(await run.store.get(run.original.server_id)).toMatchObject({ device_id: before!.device_id, public_spki: before!.public_spki, private_key: before!.private_key });
      });
    }
  });

  it("does not list a pairing after Forget releases a held renewal", async () => {
    const run = await fixture("unused", { linking: true, holdRenewal: true });
    const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
    await run.renewalRequested.promise;
    await forgetSavedPc(run.original.server_id, run.store);
    run.renewalResponse.resolve();
    await pending;
    expect(run.putPcs).toEqual([]);
  });

  it.each(["while that leave runs", "after that leave ends"] as const)("sends no link from another tab once this tab's leave has its snapshot, %s", async (moment) => {
    const run = await fixture("/api/account/status", { linking: true, heldAccount: "GET /v1/pcs" });
    await unlinked(run);
    const linking = run.otherController.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
    await run.requested.promise;
    run.controller.leave();
    await run.accountRequested.promise;
    if (moment === "after that leave ends") { run.accountRelease.resolve(); await run.viewChanged; }
    run.response.resolve(run.answer("/api/account/status"));
    const outcome = await linking;
    expect(run.linked()).toBe(false);
    expect((await run.store.get(run.original.server_id))?.pending_key).toBeUndefined();
    expect(outcome).toBeInstanceOf(DOMException);
    run.accountRelease.resolve();
    await run.viewChanged;
    expect(run.controller.state).toEqual({ kind: "signed-out", error: null });
  });

  it.each(["account", "another"] as const)("drops the account's PCs kept on this device at a leave only when they are the leaving account's (%s)", async (owner) => {
    const run = await fixture("unused");
    keepKnownPcs(owner, [{ server_id: "a".repeat(32), name: "Desk", paired: false, join: { server_public_key: "k", relay: "wss://relay.invalid" } } as unknown as MyPc]);
    const said = await run.controller.leave();
    expect(said.left).toBe(true);
    expect(knownPcs(owner)).toEqual(owner === "account" ? [] : [{ server_id: "a".repeat(32), name: "Desk" }]);
  });

  it.each(["renewal", "link answer"] as const)("leaves at once while an enrollment of this tab waits on its %s, and names a PC that may still take the key", async (held) => {
    const run = await fixture(held === "link answer" ? "/api/account/link" : "unused", { linking: true, holdRenewal: held === "renewal" });
    await unlinked(run);
    if (held === "renewal") await listInDirectory(run);
    const { first } = await laterSignIn(run);
    const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
    await (held === "renewal" ? run.renewalRequested.promise : run.requested.promise);
    const said = await run.controller.leave();
    await run.viewChanged;
    // the leave answers what the page that asked shows: nothing once it left everywhere, else the PC that may keep the key
    if (held === "renewal") expect(said).toEqual({ left: true, message: null });
    else expect(said).toEqual({ left: true, message: expect.stringContaining("Desk") });
    if (held === "renewal") {
      expect(run.service.mailbox(run.original.server_id, "account")).toMatchObject([{ kind: "remove", account: "account", key: run.key.public_spki }]);
      expect(await run.store.get(run.original.server_id)).toBeUndefined();
      expect(run.controller.state).toEqual({ kind: "signed-out", error: null });
    } else {
      // the link went out, and its answer has not come: the PC may hold the key, so it is named
      expect(run.service.requests).not.toContain("POST /v1/records");
      expect((await run.store.get(run.original.server_id))?.pending_key?.public_spki).toBe(run.key.public_spki);
      expect(run.controller.state).toMatchObject({ kind: "signed-out", error: expect.stringContaining("Desk") });
    }
    expect(await run.accountStore.get("session")).toBeUndefined();
    expect(await tokenStatus(run, first.access_token)).toBe(401);
    expect((await run.accountStore.key()).public_spki).not.toBe(run.key.public_spki);
    if (held === "renewal") run.renewalResponse.resolve(); else run.response.resolve(run.answer("/api/account/link"));
    await pending;
  });

  it("sends no removal for a sign-in made while this device's leave reads the directory, and keeps it", async () => {
    const run = await fixture("unused", { heldAccount: "GET /v1/pcs" });
    await listInDirectory(run);
    const { later } = await laterSignIn(run);
    run.controller.leave();
    await run.accountRequested.promise;
    await run.accountStore.set("session", later);
    run.accountRelease.resolve();
    await run.viewChanged;
    expect(run.service.requests.filter((request) => request === "POST /v1/records" || request === "POST /v1/signout")).toEqual([]);
    expect(run.service.mailbox(run.original.server_id, "account")).toEqual([]);
    expect(await run.accountStore.get("session")).toEqual(later);
    expect(await tokenStatus(run, later.access_token)).toBe(200);
    expect((await run.accountStore.key()).public_spki).toBe(run.key.public_spki);
    expect(await run.accountStore.get("leaving")).toBeUndefined();
    expect(await run.store.get(run.original.server_id)).toEqual(run.original);
  });

  it("signs out only the sign-in it was asked to when a new one lands while it waits on the lock", async () => {
    const run = await fixture("unused");
    const lock = memoryLock();
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { ...navigator, locks: { request: (_name: string, work: () => Promise<unknown>) => lock(work) } } });
    const holding = Promise.withResolvers<void>();
    const held = lock(() => holding.promise);
    const { first, later } = await laterSignIn(run);
    run.controller.signOut();
    await run.accountStore.set("session", later);
    holding.resolve();
    await held;
    await run.signOutAsked.promise;
    await lock(async () => undefined);
    expect(await run.accountStore.get("session")).toEqual(later);
    expect(await tokenStatus(run, later.access_token)).toBe(200);
    expect(await tokenStatus(run, first.access_token)).toBe(401);
  });

  it.each(["same", "other"] as const)("does not save an introduced pairing after the %s controller forgets its source during a held update", async (canceller) => {
    const run = await fixture("/api/account/introduction");
    const identity = generateKeyPair();
    const introduced = { server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey), relay: run.original.relay, name: "Introduced" };
    const updating = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const update = run.store.update;
    run.store.update = async (id, change, source) => {
      if (id === introduced.server_id) { updating.resolve(); await release.promise; }
      return update(id, change, source);
    };
    const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
    await run.requested.promise;
    run.response.resolve(Response.json({ pcs: [introduced] }));
    await updating.promise;
    const controller = canceller === "same" ? run.controller : run.otherController;
    controller.cancelEnrollment(run.original.server_id);
    await forgetSavedPc(run.original.server_id, run.store);
    release.resolve();
    await pending;
    expect(await run.store.get(introduced.server_id)).toBeUndefined();
  });

  it.each(["cancel", "forget", "forget-body"] as const)("stops multi-key peer introductions after source %s during the first request", async (action) => {
    const requested = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const delivered: unknown[] = [];
    const run = await fixture("unused", { peerFetch: async (path, init) => {
      if (path === "/api/account/status?fresh=1") return Response.json({ account: "account", fresh: true, removals: [], adds: [], blocked: [] });
      if (path !== "/api/account/introduce") throw new TypeError("Unexpected peer request: " + path);
      delivered.push(JSON.parse(String(init?.body)));
      if (delivered.length === 1) {
        if (action === "forget-body") {
          class HeldRefusal extends Response {
            override async json() { requested.resolve(); return (await response.promise).json(); }
          }
          return new HeldRefusal(null, { status: 404 });
        }
        requested.resolve(); return response.promise;
      }
      return Response.json({});
    } });
    const identity = generateKeyPair();
    const peer = { ...run.original, server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey) };
    await run.store.update(peer.server_id, () => peer);
    const firstRecord = run.records[0];
    if (firstRecord === undefined) throw new TypeError("Missing enrollment record");
    if (action === "forget-body") await run.accountStore.set("enrolls", { [run.original.server_id]: {
      account: "account", done: [], introduce: { keys: [firstRecord.key], pc: {
        server_id: run.original.server_id, server_public_key: run.original.server_public_key, relay: run.original.relay, name: "Desk",
      }, to: [peer.server_id] },
    } });
    const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
    await requested.promise;
    if (action === "cancel") run.controller.cancelEnrollment(run.original.server_id);
    else { run.otherController.cancelEnrollment(run.original.server_id); await forgetSavedPc(run.original.server_id, run.store); }
    response.resolve(Response.json(action === "forget-body" ? { error: { code: "introduction_unknown_key" } } : {}));
    expect(await pending).toBeInstanceOf(DOMException);
    expect(delivered).toEqual([{ key: run.records[0]?.key, pcs: [{ server_id: run.original.server_id, server_public_key: run.original.server_public_key, relay: run.original.relay, name: "Desk" }] }]);
    expect((await run.accountStore.get("enrolls"))?.[run.original.server_id]?.introduce?.to).toEqual([peer.server_id]);
  });

  it.each(["en", "ja", "ko", "zh"] as const)("keeps all enrollment surfaces truthful after listing succeeds and setup fails in %s", async (language) => {
    const run = await fixture("/api/account/enroll");
    const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
    await run.requested.promise;
    run.response.resolve(Response.json({ error: { code: "account_unavailable" } }, { status: 503 }));
    await pending;
    const directory = await new AccountService({ store: run.accountStore, fetch: run.service.fetch }).listPcs();
    expect(directory.map((pc) => pc.server_id)).toEqual([run.original.server_id]);
    const devices = await run.store.list();
    const pc = devices[0];
    if (pc === undefined) throw new TypeError("Missing paired PC");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: [language] } });
    const surfaces = [
      { element: createElement(EnrollmentStatus, { state: enrollmentOf(pc) }), text: "Account setup is incomplete." },
    ];
    for (const surface of surfaces) {
      const markup = renderToStaticMarkup(createElement(SettingsProvider, { children: surface.element }));
      expect(markup).toContain(translate(language, surface.text));
      expect(markup).not.toContain(translate(language, "Ready · not in the account yet"));
    }
  });

  it("retains confirmed admissions when an introduction-only retry adds none", async () => {
    const run = await fixture("unused");
    const introducing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Response>();
    let introductions = 0;
    let enrollments = 0;
    const options = {
      store: run.accountStore, account: "account", serverId: run.original.server_id,
      pc: { ...run.original, name: "Desk" },
      fetch: async (path: string) => { enrollments++; return run.answer(path); },
      others: [{ serverId: "peer", fetch: async (path: string) => {
        switch (path) {
          case "/api/account/status?fresh=1": return Response.json({ account: "account", fresh: true, removals: [], adds: [], blocked: [] });
          case "/api/account/introduce":
            if (++introductions === 1) { introducing.resolve(); return release.promise; }
            return Response.json({});
          default: throw new TypeError("Unexpected peer request: " + path);
        }
      } }],
    };
    const first = enrollPc(options);
    await introducing.promise;
    release.resolve(Response.json({ error: { code: "unavailable" } }, { status: 503 }));
    expect(await first).toMatchObject({ finished: false, admitted: run.records.map((record) => record.key) });
    const admittedBeforeRetry = enrollments;
    const again = await enrollPc(options);
    expect(again.finished).toBe(true);
    expect(enrollments).toBe(admittedBeforeRetry);
    expect(again.admitted).toEqual(run.records.map((record) => record.key));
  });

  it.each([
    ["/api/account/status", false], ["/api/account/link", true], ["/api/account/enroll", false], ["/api/account/introduction", false],
  ] as const)("does not restore a forgotten pairing after %s returns", async (path, linking) => {
    const run = await fixture(path, { linking });
    const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
    await run.requested.promise;
    await forgetSavedPc(run.original.server_id, run.store);
    run.response.resolve(run.answer(path));
    await pending;
    expect(await run.store.get(run.original.server_id)).toBeUndefined();
    expect((await run.store.list()).map((device) => device.private_key)).toEqual([]);
  });

  it.each([false, true])("does not recreate or alter a forgotten pairing after failure (replacement: %s)", async (replace) => {
    const run = await fixture("/api/account/enroll");
    const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
    await run.requested.promise;
    await forgetSavedPc(run.original.server_id, run.store);
    const key = await memoryAccountStore().key();
    const replacement = { ...run.original, device_id: accountDeviceId(run.original.server_id, key.public_spki), ...key };
    if (replace) await run.store.update(run.original.server_id, () => replacement);
    run.response.resolve(Response.json({ error: { code: "account_unavailable" } }, { status: 503 }));
    await pending;
    expect(await run.store.list()).toEqual(replace ? [replacement] : []);
  });

  it.each([0, 1, 2])("reports the actual %s admitted devices instead of universal access", async (admitted) => {
    const run = await fixture("unused", { admitted });
    const outcome = await run.controller.enroll(await run.open(), run.original.server_id, false);
    expect(outcome).toEqual({ state: "complete", admitted });
  });

  it("finishes a code pairing after one look for an introduction, with no wait", async () => {
    jest.useFakeTimers();
    const run = await fixture("unused");
    expect(await run.controller.enroll(await run.open(), run.original.server_id, true)).toEqual({ state: "complete", admitted: 2 });
    expect(run.introductions()).toBe(1);
    expect(enrollmentOf((await run.store.get(run.original.server_id))!)).toBe("complete");
  });

  it("waits a minute for an introduction after a pairing made without a code, which a member may have approved", async () => {
    jest.useFakeTimers();
    const run = await fixture("unused");
    const began = Date.now();
    let outcome: unknown;
    const pending = run.controller.enroll(await run.open(), run.original.server_id, true, true).then((value) => { outcome = value; });
    for (let turn = 0; outcome === undefined && turn < 5_000; turn++) {
      if (jest.getTimerCount() > 0) jest.advanceTimersByTime(3_000);
      await crypto.subtle.digest("SHA-256", new Uint8Array(1));
    }
    await pending;
    expect(outcome).toEqual({ state: "complete", admitted: 2 });
    expect(Date.now() - began).toBe(60_000);
    expect(run.introductions()).toBe(21);
  });

  it("adds nothing to the account of a sign-in other than the one the pairing was confirmed for", async () => {
    const run = await fixture("unused");
    const { first, later } = await laterSignIn(run);
    await run.accountStore.set("session", later);
    const signal = new AbortController().signal;
    const { name: _name, ...offer } = offerOf(run.original);
    // the confirm named the first sign-in's account: no account key goes to the PC under the one stored now
    await expect(run.controller.prepare({ ...offer, code: "123456" }, signal, first)).rejects.toBeInstanceOf(ConsentChangedError);
    expect(await run.controller.enroll(await run.open(), run.original.server_id, true, false, { consent: first })).toBe("local");
    // and a confirm that said "a key of its own" joins no account at all
    expect(await run.controller.prepare({ ...offer, code: "123456" }, signal, null)).toEqual({});
    expect(await run.controller.enroll(await run.open(), run.original.server_id, true, false, { consent: null })).toBe("local");
    expect(run.putPcs).toEqual([]);
    expect(enrollmentOf((await run.store.get(run.original.server_id))!)).toBeUndefined();
    expect((await run.controller.prepare({ ...offer, code: "123456" }, signal, later)).accountKey).toBeDefined();
    expect(await run.controller.enroll(await run.open(), run.original.server_id, true, false, { consent: later })).toEqual({ state: "complete", admitted: 2 });
  });

  describe("Add and pair, and its enrollment, from an own sign-in made 30 days ago", () => {
    const marked = (run: Run) => { const { name: _name, ...offer } = offerOf(run.original); return { ...offer, code: "123456", admission: 1 as const }; };
    const consent = async (run: Run) => (await run.accountStore.get("session"))!;

    it("with the key that sign-in registered, the listing carries its proof and the pairing goes on, with no sign-in again", async () => {
      const run = await fixture("unused", { old: { key: true } });
      expect((await run.controller.prepare(marked(run), new AbortController().signal, await consent(run))).accountKey).toBeDefined();
      expect(run.sent("POST /v1/pcs/challenge")).toHaveLength(1);
      expect(run.service.pcs("account").map((pc) => [pc.server_id, pc.listed_by_device])).toEqual([[run.original.server_id, false]]);
    });

    describe("on an account with a signed list, from a device that is in it", () => {
      it("names the list to the PC in place of the link: the PC is signed into the list with the card it gave over the session, and the pairing is spent", async () => {
        const run = await fixture("unused", { linking: true, planned: false, named: "follows" });
        await unlinked(run);
        expect((await run.controller.prepare(marked(run), new AbortController().signal, await consent(run))).accountKey).toBeDefined();
        const ended = await run.controller.enroll(await run.open(), run.original.server_id, true, false, { consent: await consent(run) }).catch((error: unknown) => error);
        expect(ended).toBeInstanceOf(AddedToListError);
        // no link went, the PC is in the list by its own card, and the pairing's row is gone
        expect([run.links(), run.namings(), await run.store.get(run.original.server_id)]).toEqual([0, 2, undefined]);
        const held = run.service.accountList("account")!;
        expect(held.state.pcs[run.pcKeys!.endpoint]).toMatchObject({ key: run.pcKeys!.key, removed: null });
        expect(run.realList!.view().pcs.map((pc) => pc.server_id)).toEqual([run.original.server_id]);
      });

      it("deletes the pairing by its own row, inside the delete: a newer pairing another tab saved meanwhile stays, with its key", async () => {
        const run = await fixture("unused", { linking: true, planned: false, named: "follows", replaceAtRemove: true });
        await unlinked(run);
        await run.controller.prepare(marked(run), new AbortController().signal, await consent(run));
        const ended = await run.controller.enroll(await run.open(), run.original.server_id, true, false, { consent: await consent(run) }).catch((error: unknown) => error);
        // the PC is in the list all the same; the pairing this tab held is gone, and the one saved since is this tab's no more to delete
        expect(ended).not.toBeInstanceOf(AddedToListError);
        expect((await run.store.get(run.original.server_id))?.device_id).toBe("56".repeat(8));
      });

      it("keeps the pairing where the entry is placed and the PC has not said it read it: nothing is spent, and nothing is opened over its session", async () => {
        const run = await fixture("unused", { linking: true, planned: false, named: "unread" });
        await unlinked(run);
        await run.controller.prepare(marked(run), new AbortController().signal, await consent(run));
        const ended = await run.controller.enroll(await run.open(), run.original.server_id, true, false, { consent: await consent(run) }).catch((error: unknown) => error);
        expect(ended).toBeInstanceOf(PlacedInListError);
        expect(run.service.accountList("account")!.state.pcs[run.pcKeys!.endpoint]).toMatchObject({ key: run.pcKeys!.key, removed: null });
        // the pairing stays this device's own, with nothing said of an account at its row, and no link went
        const kept = await run.store.get(run.original.server_id) as SavedDevice | undefined;
        expect([run.links(), kept?.device_id, kept?.account_enrollment]).toEqual([0, run.original.device_id, undefined]);
      });

      it("sends no link from a device that cannot write its account's list: the pairing stays its own, and nothing is opened over it", async () => {
        const run = await fixture("unused", { list: "following", linking: true, planned: false });
        await unlinked(run);
        await run.controller.prepare(marked(run), new AbortController().signal, await consent(run));
        const ended = await run.controller.enroll(await run.open(), run.original.server_id, true, false, { consent: await consent(run) }).catch((error: unknown) => error);
        expect(ended).toBeInstanceOf(ListUnwritableError);
        const kept = await run.store.get(run.original.server_id) as SavedDevice | undefined;
        expect([run.links(), kept?.device_id, kept?.account_enrollment]).toEqual([0, run.original.device_id, undefined]);
      });

      it("sends the link as before to a PC that has no such call", async () => {
        const run = await fixture("unused", { linking: true, planned: false, named: "none" });
        await unlinked(run);
        await run.controller.prepare(marked(run), new AbortController().signal, await consent(run));
        expect(await run.controller.enroll(await run.open(), run.original.server_id, true, false, { consent: await consent(run) })).toMatchObject({ state: "complete" });
        expect([run.links(), run.namings(), (await run.store.get(run.original.server_id))?.device_id]).toEqual([1, 1, run.original.device_id]);
      });
    });

    it("with no key to prove, the account service refuses the listing, and the failure screen signs in again in place", async () => {
      const run = await fixture("unused", { old: { key: false } });
      const refused = await run.controller.prepare(marked(run), new AbortController().signal, await consent(run)).catch((error: unknown) => error);
      expect(refusalOf(refused)).toBe("sign-in-first");
      expect(run.sent("POST /v1/pcs/challenge")).toEqual([]);
      expect(run.service.pcs("account")).toEqual([]);
    });

    it("an account service from before key proofs gives no challenge and lists the PC as before", async () => {
      const run = await fixture("unused", { old: { key: true, before: true } });
      expect((await run.controller.prepare(marked(run), new AbortController().signal, await consent(run))).accountKey).toBeDefined();
      expect(run.sent("POST /v1/pcs/challenge")).toHaveLength(1);
      expect(run.service.pcs("account").map((pc) => pc.server_id)).toEqual([run.original.server_id]);
    });

    it("the enrollment of a pairing just made from that confirm lists the PC with the key's proof, and completes", async () => {
      jest.useFakeTimers();
      const run = await fixture("unused", { old: { key: true } });
      expect(await run.controller.enroll(await run.open(), run.original.server_id, true, false, { consent: await consent(run) })).toEqual({ state: "complete", admitted: 2 });
      expect(run.sent("POST /v1/pcs/challenge")).toHaveLength(1);
      expect(run.service.pcs("account").map((pc) => pc.server_id)).toEqual([run.original.server_id]);
    });

    it("opening a saved pairing signs nothing: its enrollment lists the PC with no proof, as before while the service's list rule is off", async () => {
      jest.useFakeTimers();
      const run = await fixture("unused", { old: { key: true } });
      run.service.listProofRequired = false;
      expect(await run.controller.enroll(await run.open(), run.original.server_id, false)).toEqual({ state: "complete", admitted: 2 });
      expect(run.sent("POST /v1/pcs/challenge")).toEqual([]);
      expect(run.service.pcs("account").map((pc) => pc.server_id)).toEqual([run.original.server_id]);
    });
  });

  it("says its session is settled only once the link and the renewal are done, and before the rest of the enrollment", async () => {
    const run = await fixture("/api/account/enroll", { linking: true, holdRenewal: true });
    let settled = 0;
    const enrolling = run.controller.enroll(await run.open(), run.original.server_id, true, false, { settled: () => { settled++; } });
    await run.renewalRequested.promise;
    expect(run.linked()).toBe(true);
    expect(settled).toBe(0);
    run.renewalResponse.resolve();
    await run.requested.promise;
    expect(settled).toBe(1);
    run.response.resolve(run.answer("/api/account/enroll"));
    expect(await enrolling).toEqual({ state: "complete", admitted: 2 });
    expect(settled).toBe(1);
  });

  it("says its session is settled when the enrollment ends before any link, as one that joins no account does", async () => {
    const run = await fixture("unused");
    let settled = 0;
    expect(await run.controller.enroll(await run.open(), run.original.server_id, true, false, { consent: null, settled: () => { settled++; } })).toBe("local");
    await Promise.resolve();
    expect(settled).toBe(1);
  });

  it("reports no admitted devices when directory peers cannot be read", async () => {
    const run = await fixture("unused", { listed: true });
    expect(await run.controller.enroll(await run.open(), run.original.server_id, false)).toEqual({ state: "complete", admitted: 0 });
  });

  describe("a request to the account service the connection dropped under", () => {
    const dropped = (): TypeError => new TypeError("Failed to fetch");
    /** lets the enrollment run on without moving the fake clock, until `done` holds */
    const settle = async (done: () => boolean): Promise<void> => {
      for (let turn = 0; !done() && turn < 5_000; turn++) await crypto.subtle.digest("SHA-256", new Uint8Array(1));
      expect(done()).toBe(true);
    };
    /** `pending` to its end, the fake clock moved to each timer it sets meanwhile */
    const onFakeClock = async <T>(pending: Promise<T>): Promise<T> => {
      let over = false;
      void pending.then(() => { over = true; }, () => { over = true; });
      for (let turn = 0; !over && turn < 5_000; turn++) {
        if (jest.getTimerCount() > 0) jest.advanceTimersToNextTimer();
        await crypto.subtle.digest("SHA-256", new Uint8Array(1));
      }
      return pending;
    };
    const putRoute = (run: Run): string => `PUT /v1/pcs/${run.original.server_id}`;
    const savedState = async (run: Run) => enrollmentOf((await run.store.get(run.original.server_id))!);
    beforeEach(() => { jest.useFakeTimers(); browser.setVisibility("visible"); });

    it("lists the PC once the connection is back, after a pause", async () => {
      const run = await fixture("unused", { accountAnswer: (route, sent) => route.startsWith("PUT ") && sent === 1 ? dropped() : undefined });
      expect(await onFakeClock(run.controller.enroll(await run.open(), run.original.server_id, false))).toEqual({ state: "complete", admitted: 2 });
      expect(run.sent(putRoute(run))).toEqual([0, NETWORK_RETRY_MS[0]]);
      expect((await new AccountService({ store: run.accountStore, fetch: run.service.fetch }).listPcs()).map((pc) => pc.server_id)).toEqual([run.original.server_id]);
      expect(await savedState(run)).toBe("complete");
    });

    it("sends it again as soon as the browser is online again", async () => {
      const run = await fixture("unused", { accountAnswer: (route, sent) => route.startsWith("PUT ") && sent === 1 ? dropped() : undefined });
      const pending = run.controller.enroll(await run.open(), run.original.server_id, false);
      await settle(() => run.sent(putRoute(run)).length === 1 && jest.getTimerCount() > 0);
      window.dispatchEvent(new Event("online"));
      expect(await pending).toEqual({ state: "complete", admitted: 2 });
      expect(run.sent(putRoute(run))).toEqual([0, 0]);
    });

    it("sends nothing while the page is hidden, and sends it again once the page is shown", async () => {
      browser.setVisibility("hidden");
      const run = await fixture("unused", { accountAnswer: (route, sent) => route.startsWith("PUT ") && sent === 1 ? dropped() : undefined });
      let over = false;
      const pending = run.controller.enroll(await run.open(), run.original.server_id, false).finally(() => { over = true; });
      await settle(() => run.sent(putRoute(run)).length === 1 && jest.getTimerCount() > 0);
      // past the backoff, and past it again: a page that sent now would send, and finish, within these turns
      for (const step of [NETWORK_RETRY_MS[0], 10 * 60_000]) {
        jest.advanceTimersByTime(step);
        for (let turn = 0; turn < 200; turn++) await crypto.subtle.digest("SHA-256", new Uint8Array(1));
        expect([run.sent(putRoute(run)), over]).toEqual([[0], false]);
      }
      browser.setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(await pending).toEqual({ state: "complete", admitted: 2 });
      expect(run.sent(putRoute(run))).toEqual([0, NETWORK_RETRY_MS[0] + 10 * 60_000]);
    });

    it("reads the account's PCs again rather than count an unanswered read as a PC it cannot check", async () => {
      const run = await fixture("unused", { accountAnswer: (route, sent) => route === "GET /v1/pcs" && sent === 1 ? dropped() : undefined });
      expect(await onFakeClock(run.controller.enroll(await run.open(), run.original.server_id, false))).toEqual({ state: "complete", admitted: 2 });
      expect(run.sent("GET /v1/pcs")).toEqual([0, NETWORK_RETRY_MS[0]]);
    });

    it("waits as long as a busy service's retry-after asks, and the browser being online does not cut it short", async () => {
      const busy = () => Response.json({ error: { code: "rate_limited" } }, { status: 429, headers: { "retry-after": "30" } });
      const run = await fixture("unused", { accountAnswer: (route, sent) => route.startsWith("PUT ") && sent === 1 ? busy() : undefined });
      const pending = run.controller.enroll(await run.open(), run.original.server_id, false);
      await settle(() => run.sent(putRoute(run)).length === 1 && jest.getTimerCount() > 0);
      window.dispatchEvent(new Event("online"));
      await settle(() => jest.getTimerCount() > 0);
      expect(run.sent(putRoute(run))).toEqual([0]);
      expect(await onFakeClock(pending)).toEqual({ state: "complete", admitted: 2 });
      expect(run.sent(putRoute(run))).toEqual([0, 30_000]);
    });

    it("does not send it again when a busy service asks for a longer wait than it is given, and the setup fails as before", async () => {
      const run = await fixture("unused", { accountAnswer: (route) => route.startsWith("PUT ") ? Response.json({ error: { code: "rate_limited" } }, { status: 429, headers: { "retry-after": String(RETRY_AFTER_MAX_MS / 1000 + 1) } }) : undefined });
      await expect(run.controller.enroll(await run.open(), run.original.server_id, false)).rejects.toMatchObject({ status: 429, retryAfterMs: RETRY_AFTER_MAX_MS + 1_000 });
      expect([run.sent(putRoute(run)), jest.getTimerCount(), await savedState(run)]).toEqual([[0], 0, "failed"]);
    });

    it("sends it no more than its bound when the connection stays down, then leaves the setup failed with nothing left to send", async () => {
      const run = await fixture("unused", { accountAnswer: (route) => route.startsWith("PUT ") ? dropped() : undefined });
      await expect(onFakeClock(run.controller.enroll(await run.open(), run.original.server_id, false))).rejects.toBeInstanceOf(AccountServiceUnreachableError);
      expect(run.sent(putRoute(run))).toEqual([0, NETWORK_RETRY_MS[0], NETWORK_RETRY_MS[0] + NETWORK_RETRY_MS[1]]);
      expect(run.sent(putRoute(run))).toHaveLength(ACCOUNT_SENDS);
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(60 * 60_000);
      window.dispatchEvent(new Event("online"));
      await settle(() => true);
      expect([run.sent(putRoute(run)).length, await savedState(run)]).toEqual([ACCOUNT_SENDS, "failed"]);
    });

    /** a token refresh as the service answers it: a refresh token is good once, and seen again ends the sign-in */
    const grant = (run: Run): Response => Response.json({ access_token: run.service.issueToken("account"), refresh_token: crypto.randomUUID(), expires_in: 3600, account: "account", provider: "github" });
    const expiring = async (run: Run, inMs: number): Promise<void> => {
      await run.accountStore.update("session", (session) => session === undefined ? undefined : { ...session, expires_at: Date.now() + inMs });
    };

    it("does not send a token refresh again whose answer was lost, so the sign-in it rotated is not ended", async () => {
      const run = await fixture("unused", { accountAnswer: (route, sent) => {
        if (route !== "POST /v1/token") return undefined;
        // the service rotated the token, and the answer was lost on the way
        if (sent === 1) { grant(run); return dropped(); }
        return Response.json({ error: { code: "invalid_grant" } }, { status: 400 });
      } });
      await expiring(run, 0);
      await expect(onFakeClock(run.controller.enroll(await run.open(), run.original.server_id, false))).rejects.toBeInstanceOf(AccountServiceUnreachableError);
      expect([run.sent("POST /v1/token"), run.sent(putRoute(run)), await run.accountStore.get("session") === undefined]).toEqual([[0], [], false]);
    });

    it("counts every HTTP send of the listing against its bound, the one after a refused token too", async () => {
      const run = await fixture("unused", { accountAnswer: (route, sent) => {
        if (route === "POST /v1/token") return grant(run);
        if (!route.startsWith("PUT ")) return undefined;
        return sent % 2 === 1 ? dropped() : Response.json({ error: { code: "unauthorized" } }, { status: 401 });
      } });
      await expect(onFakeClock(run.controller.enroll(await run.open(), run.original.server_id, false))).rejects.toBeInstanceOf(AccountServiceUnreachableError);
      expect(run.sent(putRoute(run))).toHaveLength(ACCOUNT_SENDS);
      expect(run.sent("POST /v1/token")).toHaveLength(1);
    });

    it("sends nothing for a pairing forgotten while the token refresh before a send again was out", async () => {
      const refresh = Promise.withResolvers<Response>();
      const run = await fixture("unused", { accountAnswer: (route, sent) => {
        if (route === "POST /v1/token") return refresh.promise;
        return route.startsWith("PUT ") && sent === 1 ? dropped() : undefined;
      } });
      // fresh for the first send, due for a refresh by the second
      await expiring(run, 60_000 + NETWORK_RETRY_MS[0] / 2);
      const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
      await settle(() => run.sent(putRoute(run)).length === 1 && jest.getTimerCount() > 0);
      jest.advanceTimersByTime(NETWORK_RETRY_MS[0]);
      await settle(() => run.sent("POST /v1/token").length === 1);
      run.controller.cancelEnrollment(run.original.server_id);
      await forgetSavedPc(run.original.server_id, run.store);
      refresh.resolve(grant(run));
      expect(await onFakeClock(pending)).toBeInstanceOf(DOMException);
      expect(run.sent(putRoute(run))).toEqual([0]);
    });

    it("waits for a busy service's retry-after given as a date", async () => {
      const run = await fixture("unused", { accountAnswer: (route, sent) => route.startsWith("PUT ") && sent === 1
        ? Response.json({ error: { code: "rate_limited" } }, { status: 429, headers: { "retry-after": new Date(Date.now() + 30_000).toUTCString() } }) : undefined });
      expect(await onFakeClock(run.controller.enroll(await run.open(), run.original.server_id, false))).toEqual({ state: "complete", admitted: 2 });
      const [, again] = run.sent(putRoute(run));
      // an HTTP date is to the second
      expect(again).toBeGreaterThan(29_000);
      expect(again).toBeLessThanOrEqual(30_000);
    });

    it("sends nothing when the browser is online again while the page is hidden, and sends once it is shown", async () => {
      browser.setVisibility("hidden");
      const run = await fixture("unused", { accountAnswer: (route, sent) => route.startsWith("PUT ") && sent === 1 ? dropped() : undefined });
      let over = false;
      const pending = run.controller.enroll(await run.open(), run.original.server_id, false).finally(() => { over = true; });
      await settle(() => run.sent(putRoute(run)).length === 1 && jest.getTimerCount() > 0);
      window.dispatchEvent(new Event("online"));
      for (let turn = 0; turn < 200; turn++) await crypto.subtle.digest("SHA-256", new Uint8Array(1));
      expect([run.sent(putRoute(run)), over]).toEqual([[0], false]);
      browser.setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(await pending).toEqual({ state: "complete", admitted: 2 });
      expect(run.sent(putRoute(run))).toEqual([0, 0]);
    });

    // the failure's own read of the account's PCs sent the refresh token again, which the lost refresh had spent
    it("reads nothing more after a token refresh whose answer was lost, so the sign-in shown stays", async () => {
      const run = await fixture("unused", { viewActive: true, accountAnswer: (route, sent) => {
        if (route !== "POST /v1/token") return undefined;
        if (sent === 1) { grant(run); return dropped(); }
        return Response.json({ error: { code: "invalid_grant" } }, { status: 400 });
      } });
      await run.controller.load(null);
      expect(run.controller.state?.kind).toBe("signed-in");
      await expiring(run, 0);
      await expect(run.controller.enroll(await run.open(), run.original.server_id, false)).rejects.toBeInstanceOf(AccountServiceUnreachableError);
      expect([run.sent("POST /v1/token"), await run.accountStore.get("session") === undefined, run.controller.state?.kind, await savedState(run)]).toEqual([[0], false, "signed-in", "failed"]);
    });

    it("ends a listing that is out when its pairing is forgotten, and nothing is listed", async () => {
      const held = Promise.withResolvers<void>();
      let ended = false;
      const run = await fixture("unused", { accountAnswer: async (route, _sent, init) => {
        if (!route.startsWith("PUT ")) return undefined;
        // fetch ends a request whose signal aborts: it does not reach the service
        await new Promise<void>((resolve) => { init?.signal?.addEventListener("abort", () => { ended = true; resolve(); }, { once: true }); void held.promise.then(() => resolve()); });
        return ended ? new DOMException("The operation was aborted", "AbortError") : undefined;
      } });
      const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
      await settle(() => run.sent(putRoute(run)).length === 1);
      run.controller.cancelEnrollment(run.original.server_id);
      await forgetSavedPc(run.original.server_id, run.store);
      held.resolve();
      expect(await pending).toBeInstanceOf(DOMException);
      expect([ended, await new AccountService({ store: run.accountStore, fetch: run.service.fetch }).listPcs()]).toEqual([true, []]);
    });

    it("ends at once when its pairing is forgotten while the token refresh before a send is out", async () => {
      const refresh = Promise.withResolvers<Response>();
      const run = await fixture("unused", { accountAnswer: (route) => route === "POST /v1/token" ? refresh.promise : undefined });
      await expiring(run, 0);
      let ended = false;
      const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error).finally(() => { ended = true; });
      await settle(() => run.sent("POST /v1/token").length === 1);
      run.controller.cancelEnrollment(run.original.server_id);
      await settle(() => ended);
      refresh.resolve(grant(run));
      expect(await pending).toBeInstanceOf(DOMException);
      expect(run.sent(putRoute(run))).toEqual([]);
    });

    it("sends nothing again once the sign-in changed while it waited", async () => {
      const run = await fixture("unused", { accountAnswer: (route, sent) => route.startsWith("PUT ") && sent === 1 ? dropped() : undefined });
      const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
      await settle(() => run.sent(putRoute(run)).length === 1 && jest.getTimerCount() > 0);
      const { later } = await laterSignIn(run);
      await run.accountStore.set("session", later);
      expect(await onFakeClock(pending)).toMatchObject({ name: "SignedOutError" });
      expect(run.sent(putRoute(run))).toEqual([0]);
    });

    it("sends nothing once the sign-in changed while its pairing was read before a send again", async () => {
      const run = await fixture("unused", { accountAnswer: (route, sent) => route.startsWith("PUT ") && sent === 1 ? dropped() : undefined });
      const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
      await settle(() => run.sent(putRoute(run)).length === 1 && jest.getTimerCount() > 0);
      // the next read of the pairing is the check before the send again: the sign-in changes while it is out
      const { later } = await laterSignIn(run);
      const get = run.store.get;
      let armed = true;
      run.store.get = async (id) => {
        if (armed) { armed = false; await run.accountStore.set("session", later); }
        return get(id);
      };
      expect(await onFakeClock(pending)).toMatchObject({ name: "SignedOutError" });
      expect(run.sent(putRoute(run))).toEqual([0]);
    });

    // a read of the account's PCs that got no answer counted as one PC not read, and the enrollment's own read at its end
    // then sent the spent refresh token again
    it("reads nothing more once a token refresh before the directory read lost its answer, so the sign-in shown stays", async () => {
      const run = await fixture("unused", { viewActive: true, accountAnswer: async (route, sent) => {
        // the listing goes through, and the token is due before the read that follows it
        if (route.startsWith("PUT ")) { await expiring(run, 0); return undefined; }
        if (route !== "POST /v1/token") return undefined;
        if (sent === 1) { grant(run); return dropped(); }
        return Response.json({ error: { code: "invalid_grant" } }, { status: 400 });
      } });
      await run.controller.load(null);
      expect(run.controller.state?.kind).toBe("signed-in");
      await run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
      expect([run.sent("POST /v1/token"), run.sent("GET /v1/pcs").length, await run.accountStore.get("session") === undefined, run.controller.state?.kind])
        .toEqual([[0], 1, false, "signed-in"]);
    });

    it("sends nothing again from a page hidden while the token refresh before it was out, and sends once it is shown", async () => {
      const refresh = Promise.withResolvers<Response>();
      const run = await fixture("unused", { accountAnswer: (route, sent) => {
        if (route === "POST /v1/token") return refresh.promise;
        return route.startsWith("PUT ") && sent === 1 ? dropped() : undefined;
      } });
      // fresh for the first send, due for a refresh by the second
      await expiring(run, 60_000 + NETWORK_RETRY_MS[0] / 2);
      let over = false;
      const pending = run.controller.enroll(await run.open(), run.original.server_id, false).finally(() => { over = true; });
      await settle(() => run.sent(putRoute(run)).length === 1 && jest.getTimerCount() > 0);
      jest.advanceTimersByTime(NETWORK_RETRY_MS[0]);
      await settle(() => run.sent("POST /v1/token").length === 1);
      browser.setVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      refresh.resolve(grant(run));
      for (let turn = 0; turn < 200; turn++) await crypto.subtle.digest("SHA-256", new Uint8Array(1));
      expect([run.sent(putRoute(run)), over]).toEqual([[0], false]);
      browser.setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(await pending).toEqual({ state: "complete", admitted: 2 });
      expect(run.sent(putRoute(run))).toEqual([0, NETWORK_RETRY_MS[0]]);
    });

    it("sends nothing again for a pairing forgotten while it waited", async () => {
      const run = await fixture("unused", { accountAnswer: (route) => route.startsWith("PUT ") ? dropped() : undefined });
      const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
      await settle(() => run.sent(putRoute(run)).length === 1 && jest.getTimerCount() > 0);
      run.controller.cancelEnrollment(run.original.server_id);
      await forgetSavedPc(run.original.server_id, run.store);
      expect(await onFakeClock(pending)).toBeInstanceOf(DOMException);
      expect([run.sent(putRoute(run)), await run.store.get(run.original.server_id)]).toEqual([[0], undefined]);
    });
  });
});
