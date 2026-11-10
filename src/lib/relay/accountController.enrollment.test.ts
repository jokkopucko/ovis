import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import { EnrollmentStatus } from "../../components/EnrollmentStatus.tsx";
import { RelayPcDetails } from "../../components/RelayPcDetails.tsx";
import { RelayPcTable } from "../../components/RelayPcTable.tsx";
import { ACCOUNT_FEATURE, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";
import { exportPublicKey, generateKeyPair, importPublicKey } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { accountDeviceId, newRecordId, signAccountRecord } from "../../../shared/account-records.ts";
import type { AddRecord } from "../../../shared/account-records.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import type { PcFetch } from "../account/join.ts";
import { enrollPc, planEnroll, rememberDevice } from "../account/join.ts";
import { memoryAccountStore, memoryLock } from "../account/store.ts";
import { AccountService } from "../account/service.ts";
import { myPcs } from "../account/myPcs.ts";
import { SettingsProvider } from "../settings.ts";
import { setCurrentLanguage, translate } from "../i18n.ts";
import { createAccountController } from "./accountController.ts";
import { enrollmentOf, type RelayDevice, type RelayDeviceStore } from "./device.ts";
import { dashboardModel, dashboardPcs } from "./dashboard.ts";
import { createShellTestPage } from "./shell.test.tsx";
import { RelayTransport } from "./transport.ts";
import { forgetSavedPc } from "./updateFlow.ts";

describe("account enrollment ownership", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  const transports: RelayTransport[] = [];
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  beforeEach(() => { browser = createShellTestPage(); browser.setVisibility("hidden"); });
  afterEach(() => {
    for (const transport of transports.splice(0)) transport.close();
    browser.dispose();
    if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
    else delete (globalThis as Record<string, unknown>)["navigator"];
    setCurrentLanguage("en");
  });

  async function fixture(heldPath: string, options: { readonly linking?: boolean; readonly admitted?: number; readonly listed?: boolean; readonly holdRenewal?: boolean; readonly peerFetch?: PcFetch; readonly heldAccount?: string } = {}) {
    const identity = generateKeyPair();
    const offer = { v: 1 as const, server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey), relay: "wss://relay.invalid", name: "Desk" };
    const accountStore = memoryAccountStore();
    const service = new FakeAccountService();
    await accountStore.set("session", { service: "https://account.invalid", account: "account", provider: "github", access_token: service.issueToken("account"), refresh_token: "test", expires_at: Date.now() + 3_600_000 });
    const key = await accountStore.key();
    const original: RelayDevice = { ...offer, device_id: "12".repeat(8), private_key: key.private_key, public_spki: key.public_spki, label: "Phone", account: "account" };
    const devices = new Map([[offer.server_id, original]]);
    const store: RelayDeviceStore = {
      get: async (id) => devices.get(id), list: async () => [...devices.values()], remove: async (id) => { devices.delete(id); },
      update: async (id, change, source) => { source?.assert(devices.get(source.serverId)); const next = change(devices.get(id)); devices.set(id, next); return next; },
    };
    const records: AddRecord[] = [];
    for (let index = 0; index < 2; index++) {
      const peerKey = await memoryAccountStore().key();
      const record = await signAccountRecord({ v: 1, kind: "add", account: "account", key: peerKey.public_spki, label: "Other device", role: "drive", issued_at: new Date().toISOString(), id: newRecordId(), signer: key.public_spki }, key.private_key);
      await rememberDevice(accountStore, record);
      records.push(record);
    }
    await planEnroll(accountStore, offer.server_id, "account");
    const requested = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const renewalRequested = Promise.withResolvers<void>();
    const renewalResponse = Promise.withResolvers<void>();
    const putPcs: string[] = [];
    // the first account service request `heldAccount` names ("GET /v1/pcs") waits for accountRelease
    const accountRequested = Promise.withResolvers<void>();
    const accountRelease = Promise.withResolvers<void>();
    const signOutAsked = Promise.withResolvers<void>();
    const viewChanged = Promise.withResolvers<void>();
    let accountHeld = false;
    let linked = !options.linking;
    const answer = (path: string): Response => {
      switch (path) {
        case "/api/account/status": return Response.json({ account: linked ? "account" : null, unlinked: [], removals: [], enrolling: true });
        case "/api/account/link": linked = true; return Response.json({});
        case "/api/account/enroll": return Response.json({ results: records.map((record, index) => ({ id: record.id, outcome: index < (options.admitted ?? 2) ? "applied" : "refused", code: "key_held" })) });
        case "/api/account/introduction": return Response.json({ pcs: [] });
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
      override async fetch(path: string) { if (path === heldPath) { requested.resolve(); return response.promise; } return answer(path); }
    }
    class Peer extends RelayTransport {
      override async fetch(path: string, init?: RequestInit) {
        if (options.peerFetch === undefined) throw new TypeError("Unexpected peer request");
        return options.peerFetch(path, init);
      }
    }
    const open = async (target: RelayOffer = offer) => { const transport = target.server_id === offer.server_id ? new Admitted(offer) : new Peer(target); transports.push(transport); return transport; };
    const controller = () => createAccountController({
      container: Object.create(null), entryUrl: "https://app.ovis.invalid", renderApp: () => { throw new TypeError("No app here"); },
      store, accountStore, accountService: "https://account.invalid", accountProviders: ["github"], open,
      accountFetch: async (input, init) => {
        const route = `${init?.method ?? "GET"} ${new URL(input instanceof Request ? input.url : String(input)).pathname}`;
        if (route === "POST /v1/signout") signOutAsked.resolve();
        if (route === options.heldAccount && !accountHeld) { accountHeld = true; accountRequested.resolve(); await accountRelease.promise; }
        if (init?.method === "PUT") putPcs.push("put");
        if (options.listed && init?.method === "GET") return Response.json({ pcs: [{ server_id: "a".repeat(32), label: "Unread PC", public_key: null, relay: offer.relay, added_at: new Date().toISOString(), last_seen_at: null }] });
        return service.fetch(input, init);
      },
    }, { active: () => false, changed: async () => { viewChanged.resolve(); }, outdated: () => new Set() });
    return {
      controller: controller(), otherController: controller(), store, original, requested, response, answer, open, records, putPcs, renewalRequested, renewalResponse, accountStore, key, service, linked: () => linked,
      accountRequested, accountRelease, signOutAsked, viewChanged: viewChanged.promise,
    };
  }
  type Run = Awaited<ReturnType<typeof fixture>>;
  // a pairing just made with its own key, which an enrollment links to the account key
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
    // a sign-in of its own, as the service's answer makes one (sessionOf): the stored one may carry an id by now
    return { first, later: { ...first, access_token: run.service.issueToken("account"), refresh_token: "later", sign_in_id: "later" } };
  };

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
    // the other tab's enrollment waits on the PC's status, before its link
    const linking = run.otherController.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
    await run.requested.promise;
    run.controller.leave();
    // marked and snapshotted: the leave now reads the directory
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

  it.each(["renewal", "link answer"] as const)("leaves at once while an enrollment of this tab waits on its %s, and names a PC that may still take the key", async (held) => {
    const run = await fixture(held === "link answer" ? "/api/account/link" : "unused", { linking: true, holdRenewal: held === "renewal" });
    await unlinked(run);
    if (held === "renewal") await listInDirectory(run);
    const { first } = await laterSignIn(run);
    const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
    await (held === "renewal" ? run.renewalRequested.promise : run.requested.promise);
    run.controller.leave();
    await run.viewChanged;
    if (held === "renewal") {
      // linked and listed: the removal went to its mailbox, and its pairing is forgotten here
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
    // signed out and in again meanwhile (the phone app's page stays open)
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
    // another tab holds the account lock (a refresh on its way)
    const holding = Promise.withResolvers<void>();
    const held = lock(() => holding.promise);
    const { first, later } = await laterSignIn(run);
    run.controller.signOut();
    await run.accountStore.set("session", later);
    holding.resolve();
    await held;
    await run.signOutAsked.promise;
    // the sign-out's own turn under the lock is over once this one runs
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
    const rows = dashboardModel(dashboardPcs(myPcs(directory, devices, { now: Date.now(), account: "account", accountKey: run.key.public_spki }), devices, directory), { label: "Phone" }, pc.relay).rows;
    const row = rows[0];
    if (row === undefined) throw new TypeError("Missing dashboard row");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: [language] } });
    const surfaces = [
      { element: createElement(RelayPcTable, { rows, onSelect() {}, onOpenSheet() {} }), text: "Account setup is incomplete. Open it to try again." },
      { element: createElement(RelayPcDetails, { pc: row, onClose() {} }), text: "Account setup is incomplete." },
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

  it("reports no admitted devices when directory peers cannot be read", async () => {
    const run = await fixture("unused", { listed: true });
    expect(await run.controller.enroll(await run.open(), run.original.server_id, false)).toEqual({ state: "complete", admitted: 0 });
  });
});
