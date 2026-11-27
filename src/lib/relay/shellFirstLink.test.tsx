import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import { ACCOUNT_FEATURE, MuxProtocolError, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { relayFailureText } from "../../components/relayFailureText.ts";
import { memoryAccountStore } from "../account/store.ts";
import { translate, type Vars } from "../i18n.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import type { AccountList, AccountListView, ListWriter } from "../account/accountList.ts";
import type { RelayDevice, ShellDeviceStore, SavedDevice } from "./device.ts";
import { ADMISSION_WAIT_MS, LINK_RETRY_MAX_MS } from "./accountController.ts";
import { readSeenPcs } from "../account/seenPcs.ts";
import { keepTypedCode } from "./shellState.ts";
import { askingPc } from "../account/accountList.test-helpers.ts";
import { signCard } from "../../../shared/account-list.ts";
import { ACCOUNT_STEPS_WAIT_MS, mountRelayShell } from "./shell.tsx";
import { createShellTestPage } from "./shell.test.tsx";
import { RelayTransport, type RelayTransportOptions } from "./transport.ts";

const t = (key: string, vars?: Vars): string => translate("en", key, vars);
const OLDER_ID = "12".repeat(8);
const NEWER_ID = "34".repeat(8);
// a newer pairing of the same PC that another tab saved
const REPLACED_ID = "56".repeat(8);

let waiting: (() => void)[] = [];
/** Told by every fake of a pairing when what it holds changes: a render, a request, a store write, a timer armed, a session closed. */
const changed = (): void => { for (const wake of waiting.splice(0)) wake(); };
/**
 * Settles once `holds`, looked at again at each change a fake tells of. The work between them signs, which settles on
 * no turn of this thread, so no count of turns bounds it: the test's own timeout does, which no faked clock holds.
 */
async function until(holds: () => boolean | Promise<boolean>): Promise<void> {
  for (;;) {
    // asked for before the look, so a change while an async look runs wakes the next one
    const next = new Promise<void>((resolve) => { waiting.push(resolve); });
    if (await holds()) return;
    await next;
  }
}

// A device stops before pairing only for a code that
// carries the mark `admission: 1`. Then, signed in, it lists the PC when its account does not list it yet, posts its
// admission and has it answered, and only then pairs and links, all under the sign-in the person said yes under. Any
// other offer pairs as before, posting nothing. A refused link forgets no pairing.
describe("the admission before a first link", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  const transports: RelayTransport[] = [];
  const setTimer = globalThis.setTimeout;
  beforeEach(() => { browser = createShellTestPage(); browser.setVisibility("hidden"); });
  afterEach(() => { globalThis.setTimeout = setTimer; jest.useRealTimers(); for (const transport of transports.splice(0)) transport.close(); setTransport(nativeTransport); browser.dispose(); waiting = []; });

  interface Options {
    /** the offer carries `admission: 1` (a code whose PC checks new devices with the account service) */
    readonly mark?: boolean;
    /** the device already has a pairing for this PC that is not linked to the account */
    readonly saved?: boolean;
    /** that saved pairing says it is a member of this account already */
    readonly member?: boolean;
    /** the PC's own page opens the saved pairing: no offer, no code, no confirm */
    readonly reopen?: boolean;
    /** the offer carries no code: a join of a PC the account lists, by comparing digits */
    readonly codeless?: boolean;
    /** the PC is in the account already, with this device's new row not linked yet */
    readonly pcIn?: boolean;
    /** the account service never answers the admission, and ends it only when its signal aborts */
    readonly neverAnswers?: "admission";
    /** the confirm is not pressed: the test presses it (to install fake timers first) */
    readonly hold?: boolean;
    /** another tab forgets this PC just as the older record is about to be written back */
    readonly forgetAtRestore?: boolean;
    /** another tab saves a newer pairing of this PC just as the older record is about to be written back */
    readonly replaceAtRestore?: boolean;
    /** another tab saves a newer pairing of this PC just as this tab begins to forget it */
    readonly replaceAtForget?: boolean;
    /** the second admission (the changed key's) waits until the test releases it */
    readonly holdSecondPost?: boolean;
    /** the code was typed and matched on this device (sessionStorage), so the pairing goes with no confirm and no press */
    readonly typedConfirmed?: boolean;
    /** the first read of the saved record after the PAIR waits until the test releases it */
    readonly holdReadAfterPair?: boolean;
    /** the PC ends the new row's sessions just before it answers the first link, so that end arrives first */
    readonly endRowBeforeAnswer?: boolean;
    /** another tab signs in to another account once the first admission was answered */
    readonly switchAfterAdmission?: boolean;
    /** the account lists the PC already */
    readonly listed?: boolean;
    /** no sign-in is stored on the device */
    readonly signedOut?: boolean;
    /** a leave in another tab replaces the stored account key once the first admission was answered */
    readonly keyChanges?: boolean;
    /** the account service's answer to PUT /v1/pcs/:id */
    readonly listing?: () => Response;
    /** its answer to POST /v1/admissions, by default the repository's fake's (400 `unknown_pc` for a PC the account does not list); "unanswered": it never arrives */
    readonly admission?: () => Response | "unanswered";
    /** the PC's answers to POST /api/account/link, one per link sent, the last one again; by default it takes it, as a PC that asks the account service nothing does */
    readonly links?: readonly (() => Response)[];
    /** the version the PC runs (the shell's is 1.0.0) */
    readonly pcVersion?: string;
    /** another tab saves a newer pairing of this PC right after the PAIR was admitted */
    readonly replaceAfterPair?: boolean;
    /** the first read of the saved record once an admission was answered answers what was saved then, when the test releases it */
    readonly holdMarkedRead?: boolean;
    /** the first link waits until the test releases it */
    readonly holdFirstLink?: boolean;
    /**
     * This device follows its account's signed list and may write it, and the PC takes the list named over the session
     * of the pairing: it says it read its entry at the first ask, as a PC the list holds already does.
     */
    readonly namedList?: boolean;
    /**
     * As namedList, but the PC never says that it read its entry: it answers with its card for the list at every ask,
     * and the list holds the PC's key already (an earlier press placed it), so nothing is signed here either
     */
    readonly namedUnread?: boolean;
    /** the code was typed on this device and compared there (codeMatch), not scanned */
    readonly typedCode?: boolean;
    /** another tab signs in to another account the moment the PC admits the pairing */
    readonly switchAtPair?: boolean;
  }

  async function pairing(options: Options = {}) {
    const identity = generateKeyPair();
    const offer = { v: 1 as const, server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey), relay: "wss://relay.ovis.sh", name: "Desk", ...(options.codeless ? {} : { code: "123456" }), ...(options.mark ? { admission: 1 as const } : {}) };
    const accountStore = memoryAccountStore();
    const sessionOf = (account: string) => ({ service: "https://account.ovis.sh", account, provider: "github" as const, access_token: `access-${account}`, refresh_token: `refresh-${account}`, expires_at: Date.now() + 3_600_000 });
    if (!options.signedOut) await accountStore.set("session", sessionOf("acct-test"));
    const key = await accountStore.key();
    const { code: _code, admission: _mark, ...pairedOffer } = offer;
    const older: RelayDevice = { ...pairedOffer, device_id: OLDER_ID, private_key: key.private_key, public_spki: key.public_spki, label: "Phone", ...(options.member ? { account: "acct-test" } : {}) };
    const devices = new Map<string, RelayDevice>(options.saved || options.reopen ? [[offer.server_id, older]] : []);
    const newer: RelayDevice = { ...older, device_id: REPLACED_ID };
    const readHeld = Promise.withResolvers<void>(), readRelease = Promise.withResolvers<void>();
    const secondPostHeld = Promise.withResolvers<void>(), secondPostRelease = Promise.withResolvers<void>();
    let readsHeld = 0;
    const markedReadHeld = Promise.withResolvers<void>(), markedReadRelease = Promise.withResolvers<void>();
    let markedReadsHeld = 0;
    const linkHeld = Promise.withResolvers<void>(), linkRelease = Promise.withResolvers<void>();
    let linksHeld = 0;
    let reloads = 0;
    // another tab's write that commits just before this tab's own delete of the record
    const replaceFirst = (id: string): void => { if (options.replaceAtForget && devices.get(id)?.device_id === NEWER_ID) devices.set(id, newer); };
    const store: ShellDeviceStore = {
      get: async (id) => {
        if (options.holdReadAfterPair && events.includes("pair") && readsHeld++ === 0) { readHeld.resolve(); await readRelease.promise; }
        if (options.holdMarkedRead && events.includes("admission answered") && markedReadsHeld++ === 0) {
          const then = devices.get(id);
          markedReadHeld.resolve();
          await markedReadRelease.promise;
          return then;
        }
        return devices.get(id);
      },
      list: async () => [...devices.values()],
      remove: async (id) => { replaceFirst(id); devices.delete(id); changed(); },
      removeRow: async (id, row) => { replaceFirst(id); if (devices.get(id)?.device_id !== row) return false; devices.delete(id); changed(); return true; },
      update: async (id, change) => {
        // the write that would put the older record back: another tab's Forget, or newer pairing, commits just before it
        if ((options.forgetAtRestore || options.replaceAtRestore) && devices.get(id)?.device_id === NEWER_ID) {
          let next: RelayDevice | undefined;
          try { next = change(devices.get(id)); } catch { next = undefined; }
          if (next?.device_id === OLDER_ID) { if (options.forgetAtRestore) devices.delete(id); else devices.set(id, newer); }
        }
        const device = change(devices.get(id)); devices.set(id, device); changed(); return device;
      },
    };
    // what reached the account service and the PC, in order, with the keys each admission and link named
    const events: string[] = [];
    const posted: string[] = [];
    // whether each admission asked to be taken without telling the account's other devices
    const quiet: boolean[] = [];
    const sent: string[] = [];
    const admissionGate = Promise.withResolvers<void>();
    let listed = options.listed === true;
    let postSignal: AbortSignal | undefined;
    let apps = 0, opens = 0, linked = false, directoryReads = 0;
    // the list named to the PC over a pairing's session, and each session opened: with the key the list holds, or not
    const namings: unknown[] = [];
    const byListKey: boolean[] = [];
    const LIST = "5c".repeat(32);
    const endpoint = Buffer.from(identity.publicKey).toString("hex");
    const listView = (): AccountListView => ({
      account: "acct-test", reached: true, status: { at: "following", list: LIST, standing: "in", head: namings.length === 0 ? 1 : 2, read_at: 1, trouble: null },
      devices: [{ key: key.public_spki, self: true, power: "full", role: "drive", until: null, carried: false, name: null }],
      pcs: namings.length === 0 ? [] : [{ endpoint, server_id: offer.server_id, how: "added", allows: true, name: { label: "Desk", os: null }, seq: 2, by: key.public_spki, new_at: null }],
    });
    // the PC's own keys for the list, and its card, where it answers the naming with them
    const pcKeys = options.namedUnread ? await askingPc() : null;
    const pcCard = pcKeys === null ? null : await signCard({ key: pcKeys.key, enc: pcKeys.enc, list: LIST, endpoint, invite: null }, pcKeys.signs);
    const accountList: AccountList | undefined = !options.namedList && !options.namedUnread ? undefined : {
      sync: async () => listView(), follows: async () => true, view: listView, subscribe: () => () => {}, holdsPc: () => namings.length > 0, pcOfKey: () => null, due: () => null, shown: () => Math.floor(Date.now() / 1000),
      shadow: async () => null, dropNames: async () => {}, forget: async () => {}, pinnedElsewhere: async () => null, adopt: async () => listView(), placeAt: () => null, holdsEntry: () => false, gossip: () => null, pageAfter: () => null, compare: () => null, takeFromPeer: async () => null, knowsPc: () => false,
      kept: async () => null, keep: async () => { throw new Error("nothing is signed in this test"); }, unkeep: async () => {}, waiting: async () => null, cancel: async () => "gone" as const,
      // the PC answers that it read its entry, so nothing is signed with this: only whose list it is and which is asked
      writer: () => ({ account: "acct-test", list: LIST, keys: { key: key.public_spki },
        state: { footing: { seq: 2, hash: "ab".repeat(32) }, pcs: pcKeys === null ? {} : { [endpoint]: { key: pcKeys.key, enc: pcKeys.enc, removed: null } } } }) as unknown as ListWriter,
    };
    // the row the PC ended, by its device id: a sign-in with that row is refused, one with another row is not
    let ended: string | null | undefined;
    const fatal: ((error: Error) => void)[] = [];
    // every wait armed, with how many links had been sent by then: a test moves a faked clock only past one it saw armed
    const timers: { readonly ms: number; readonly links: number }[] = [];
    globalThis.setTimeout = ((...timer: Parameters<typeof setTimeout>) => {
      timers.push({ ms: timer[1] ?? 0, links: sent.length }); changed();
      return setTimer(...timer);
    }) as typeof setTimeout;
    const opened: Admitted[] = [];
    class Admitted extends RelayTransport {
      closed = false;
      /** the row the PC admitted this session as */
      row: string | null | undefined;
      override close() { this.closed = true; super.close(); changed(); }
      override get server() { return { version: options.pcVersion ?? "1.0.0", relayProtocol: RELAY_PROTOCOL, features: [ACCOUNT_FEATURE] }; }
      override get deviceId() { return this.row; }
      override async renew() {}
      override async fetch(path: string, init?: RequestInit) {
        if (path === "/api/account/link" && options.holdFirstLink && linksHeld++ === 0) { linkHeld.resolve(); await linkRelease.promise; }
        try { return this.answer(path, init); } finally { changed(); }
      }
      answer(path: string, init?: RequestInit) {
        switch (path) {
          case "/api/account/status": return Response.json({ account: linked || options.pcIn ? "acct-test" : null, unlinked: options.pcIn && !linked ? [NEWER_ID, OLDER_ID] : [], removals: [], enrolling: !linked && !options.pcIn });
          case "/api/account/link": {
            events.push("link");
            if (options.endRowBeforeAnswer && sent.length === 0) endRow();
            sent.push((JSON.parse(String(init?.body)) as { record: { key: string } }).record.key);
            const answers = options.links ?? [];
            const answer = answers[Math.min(sent.length, answers.length) - 1]?.() ?? Response.json({});
            if (answer.ok) linked = true;
            return answer;
          }
          case "/api/account/enroll": return Response.json({ results: [] });
          case "/api/account/introduction": return Response.json({ pcs: [] });
          case "/api/account/list/named": {
            if (!options.namedList && !options.namedUnread) return Response.json({ error: { code: "not_found" } }, { status: 404 });
            events.push("named");
            namings.push(JSON.parse(String(init?.body)));
            if (pcKeys !== null) return Response.json({ state: "waiting", standing: "waiting", key: pcKeys.key, enc: pcKeys.enc, card: pcCard });
            return Response.json({ state: "added", account: "acct-test" });
          }
          default: throw new TypeError(`Unexpected PC request: ${path}`);
        }
      }
    }
    let props: RelayShellProps | undefined;
    // every screen drawn, in order
    const drawn: RelayShellProps["state"][] = [];
    const render = (node: ReactNode): void => {
      if (!isValidElement<{ readonly children?: ReactNode }>(node)) throw new TypeError("Missing shell element");
      if (node.type === RelayShell && isValidElement<RelayShellProps>(node)) { props = node.props; drawn.push(node.props.state); changed(); return; }
      render(node.props.children);
    };
    const current = (): RelayShellProps => { if (!props) throw new TypeError("Shell not rendered"); return props; };
    const listedPc = { server_id: offer.server_id, label: "Desk", added_at: "2026-11-01T00:00:00Z", last_seen_at: null };
    if (options.typedConfirmed) sessionStorage.setItem("ovis-confirmed-pc", offer.server_id);
    if (options.typedCode) keepTypedCode(offer);
    // the tab's memory of the reloads it made for a newer PC (skew.ts reloadOnce)
    if (options.pcVersion !== undefined) (window as unknown as { sessionStorage: Storage }).sessionStorage = sessionStorage;
    await mountRelayShell({
      container: Object.create(null), entryUrl: options.reopen ? `https://app.ovis.sh/s/${offer.server_id}/` : encodeOffer(offer, "https://app.ovis.sh"), shellVersion: "1.0.0", store, accountStore,
      ...(accountList === undefined ? {} : { accountList }),
      accountService: "https://account.ovis.sh",
      accountFetch: async (input, init) => {
        const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
        const bearer = new Headers(init?.headers).get("authorization");
        // a call that is never answered ends only by its own signal, as fetch does
        const hung = (): Promise<Response> => new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        if (path === `/v1/pcs/${offer.server_id}` && init?.method === "PUT") {
          events.push(`list ${bearer}`);
          const answer = options.listing?.() ?? Response.json({});
          if (answer.ok) listed = true;
          changed();
          return answer;
        }
        if (path !== "/v1/admissions" || init?.method !== "POST") {
          directoryReads++; changed();
          return Response.json({ pcs: listed ? [listedPc] : [] });
        }
        events.push(`admission ${bearer}`);
        const body = JSON.parse(String(init.body)) as { key: string; quiet?: unknown };
        posted.push(body.key);
        quiet.push(body.quiet === true);
        postSignal = init.signal ?? undefined;
        changed();
        if (options.neverAnswers === "admission") return hung();
        if (options.holdSecondPost && posted.length === 2) { secondPostHeld.resolve(); await secondPostRelease.promise; }
        await admissionGate.promise;
        const answer = options.admission?.() ?? (listed ? Response.json({ id: "adm-1" }) : Response.json({ error: { code: "unknown_pc", message: "List PCs of this account only" } }, { status: 400 }));
        if (answer === "unanswered") throw new TypeError("Failed to fetch");
        events.push(answer.ok ? "admission answered" : "admission refused");
        if (options.keyChanges && posted.length === 1) await accountStore.clear(() => true);
        if (options.switchAfterAdmission && answer.ok) await accountStore.set("session", sessionOf("acct-other"));
        changed();
        return answer;
      },
      createRoot: () => ({ render, unmount() {} }), renderApp: () => { apps++; changed(); return { render() {}, unmount() {} }; },
      reload: async () => { reloads++; changed(); },
      pendingPush: { get: async () => undefined, clear: async () => {} }, navigate() {}, checkPc: async () => ({ kind: "offline", reason: "relay" }),
      // a pairing (the offer carries the code) saves a new row's record for this device in place of any, as PAIR does;
      // a sign-in with what is saved is refused once the PC ended the row
      open: async (opening, transportOptions: RelayTransportOptions = {}) => {
        opens++;
        // as a transport does, an attempt that ended opens nothing
        transportOptions.signal?.throwIfAborted();
        byListKey.push(transportOptions.accountListKey === true);
        if (opening.code !== undefined) { events.push("pair"); devices.set(offer.server_id, { ...older, device_id: NEWER_ID }); if (options.switchAtPair) await accountStore.set("session", sessionOf("acct-other")); }
        // a session by the key the list holds for this device rests on no pairing: the PC knows the key from its list
        else if (transportOptions.accountListKey === true) events.push("list key");
        else if (ended !== undefined && devices.get(offer.server_id)?.device_id === ended) throw new MuxProtocolError("auth_failed", "the PC ended this row");
        else devices.set(offer.server_id, devices.get(offer.server_id) ?? older);
        if (transportOptions.onFatal) fatal.push(transportOptions.onFatal);
        const transport = new Admitted(offer); transport.row = devices.get(offer.server_id)?.device_id;
        if (options.replaceAfterPair && opening.code !== undefined) devices.set(offer.server_id, newer);
        transports.push(transport); opened.push(transport); changed(); return transport;
      },
    });
    const press = (): void => { events.push("pressed"); current().onPair(); };
    if (!options.reopen && !options.typedConfirmed) {
      await until(() => current().state.kind === "confirm" && (current().state as { account?: string }).account !== "checking");
      if (!options.hold) press();
    }
    const pcEvents = (): string[] => events.filter((event) => event === "pair" || event === "link");
    const failure = (): string | null => { const state = current().state; return state.kind === "failed" ? state.failure : null; };
    /** the PC ends the row: every session of it ends `auth_revoked`, and a later sign-in with it is refused */
    const endRow = (): void => { ended = devices.get(offer.server_id)?.device_id; for (const end of fatal.splice(0)) end(new MuxProtocolError("auth_revoked", "the PC ended this row")); };
    const switchAccount = (): Promise<void> => accountStore.set("session", sessionOf("acct-other"));
    /** a wait of `ms` armed after the `links`th link: the faked clock is moved past it only once it is */
    const armed = (ms: number, links: number): Promise<void> => until(() => sent.length === links && timers.some((timer) => timer.ms === ms && timer.links === links));
    /** every session the attempt opened is closed: it is over, and nothing more of it reaches the PC */
    const over = (): Promise<void> => until(() => opened.length > 0 && opened.every((transport) => transport.closed));
    const enrollment = async (): Promise<string | undefined> => ((await store.get(offer.server_id)) as SavedDevice | undefined)?.account_enrollment?.state;
    return { current, drawn: () => drawn, press, switchAccount, armed, over, enrollment, directoryReads: () => directoryReads, reloads: () => reloads, namings, byListKey, devices, serverId: offer.server_id,
      markedReadHeld: markedReadHeld.promise, releaseMarkedRead: () => markedReadRelease.resolve(), linkHeld: linkHeld.promise, releaseLink: () => linkRelease.resolve(), readHeld: readHeld.promise, releaseRead: () => readRelease.resolve(), secondPostHeld: secondPostHeld.promise, releaseSecondPost: () => secondPostRelease.resolve(), events, pcEvents, posted, quiet, sent, failure, endRow, admissionGate, store, offer, apps: () => apps, opens: () => opens, postSignal: () => postSignal };
  }

  for (const [what, options, expected] of [
    ["a PC the account does not list yet", {}, ["list Bearer access-acct-test", "admission Bearer access-acct-test", "admission answered", "pair", "link"]],
    ["a PC this device has a pairing with that is not linked, which the account lists", { saved: true, listed: true }, ["admission Bearer access-acct-test", "admission answered", "pair", "link"]],
    // a marked PAIR makes a new row on the PC, whatever this device saved: the saved record decides nothing
    ["a PC this device's saved pairing says it is a member of already", { saved: true, member: true, listed: true }, ["admission Bearer access-acct-test", "admission answered", "pair", "link"]],
  ] as const) {
    it(`with the mark, has the post answered before any PAIR or link: ${what}`, async () => {
      const run = await pairing({ mark: true, ...options });
      await until(() => run.posted.length === 1);
      // the post is out and not answered: nothing reaches the PC meanwhile, and the post can be ended at its bound
      expect(run.opens()).toBe(0);
      expect(run.postSignal()).toBeInstanceOf(AbortSignal);
      run.admissionGate.resolve();
      await until(() => run.apps() === 1 && run.sent.length === 1);
      expect(run.events.filter((event) => event !== "pressed").slice(0, expected.length)).toEqual([...expected]);
      // a marked code is a new PC's: its admission asks to be taken without telling the account's other devices
      expect(run.quiet).toEqual([true]);
    });
  }

  it("a scanned PC that takes the account's list named is opened anew with the key the list holds: no link is sent, and the pairing that named it is gone", async () => {
    const run = await pairing({ mark: true, listed: true, namedList: true });
    run.admissionGate.resolve();
    await until(() => run.byListKey.at(-1) === true);
    // the pairing's own session named the list and nothing else, then the PC is opened as a PC of the list
    expect(run.events.filter((event) => event === "pair" || event === "named" || event === "link" || event === "list key")).toEqual(["pair", "named", "list key"]);
    expect(run.namings).toEqual([{ account: "acct-test", list: "5c".repeat(32) }]);
    // the pairing, its own sign-in as before, then the list's key
    expect(run.byListKey).toEqual([false, false, true]);
    expect(run.sent).toEqual([]);
    expect(run.devices.has(run.serverId)).toBe(false);
    await until(() => run.apps() >= 1);
    // the app opens once, on the list's session: the pairing's screen stayed until then, and no screen said it failed
    expect(run.apps()).toBe(1);
    expect(run.drawn().some((state) => state.kind === "failed")).toBe(false);
  });

  // The device's own record of its PCs (account/seenPcs.ts): a QR code of that PC scanned for the account is `added`; a
  // code typed here is a pairing at the PC (`paired`), never more; and the act goes to the account it was confirmed for
  describe("what the pairing writes in the device's record of its PCs", () => {
    const endpointOf = (offer: { readonly server_public_key: string }): string => Buffer.from(Uint8Array.from(atob(offer.server_public_key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))).toString("hex");
    it("a QR code of that PC, scanned for the account: added", async () => {
      const run = await pairing({ mark: true, listed: true });
      run.admissionGate.resolve();
      await until(() => run.apps() === 1 && run.sent.length === 1);
      await until(() => readSeenPcs("acct-test").pcs[endpointOf(run.offer)] !== undefined);
      expect(readSeenPcs("acct-test").pcs[endpointOf(run.offer)]?.how).toBe("added");
    });

    it("a scanned code that carries no account mark pairs with the PC alone: paired, never added", async () => {
      const run = await pairing({ listed: true });
      await until(() => run.apps() === 1 && run.sent.length === 1);
      await until(() => readSeenPcs("acct-test").pcs[endpointOf(run.offer)] !== undefined);
      expect(readSeenPcs("acct-test").pcs[endpointOf(run.offer)]?.how).toBe("paired");
    });

    it("a code typed on this device and compared here: paired, never added", async () => {
      const run = await pairing({ mark: true, listed: true, typedConfirmed: true, typedCode: true });
      run.admissionGate.resolve();
      await until(() => run.apps() === 1 && run.sent.length === 1);
      await until(() => readSeenPcs("acct-test").pcs[endpointOf(run.offer)] !== undefined);
      expect(readSeenPcs("acct-test").pcs[endpointOf(run.offer)]?.how).toBe("paired");
    });

    it("goes to the account the pairing was confirmed for, though another tab signed in as someone else since", async () => {
      const run = await pairing({ mark: true, listed: true, switchAtPair: true });
      run.admissionGate.resolve();
      await until(() => readSeenPcs("acct-test").pcs[endpointOf(run.offer)] !== undefined);
      expect([readSeenPcs("acct-test").pcs[endpointOf(run.offer)]?.how, readSeenPcs("acct-other").pcs]).toEqual(["added", {}]);
    });
  });

  it("a scanned PC whose entry is in the list but that has not read it yet keeps the pairing, opens nothing over its session, and shows the front page", async () => {
    const run = await pairing({ mark: true, listed: true, namedUnread: true });
    run.admissionGate.resolve();
    await until(() => run.current().state.kind === "list" || run.current().state.kind === "empty");
    // the pairing's session named the list, as many times as the PC counts, and nothing else went to the PC
    expect(run.events.filter((event) => event === "pair" || event === "named" || event === "link" || event === "list key")).toEqual(["pair", "named", "named", "named", "named"]);
    expect([run.sent, run.byListKey.includes(true), run.apps()]).toEqual([[], false, 0]);
    // the pairing is not spent: its row stays, the device's own, with nothing said of an account at it
    const kept = run.devices.get(run.serverId) as SavedDevice | undefined;
    expect([kept?.device_id, kept?.account_enrollment, kept?.account]).toEqual([NEWER_ID, undefined, undefined]);
    expect(run.drawn().some((state) => state.kind === "failed")).toBe(false);
  }, 15_000);

  it("with the mark, ends the post itself when the person cancels while it waits, and pairs nothing", async () => {
    const run = await pairing({ mark: true, listed: true });
    await until(() => run.posted.length === 1);
    run.current().onCancel();
    expect(run.postSignal()?.aborted).toBe(true);
    run.admissionGate.resolve();
    expect(run.opens()).toBe(0);
  });

  for (const [what, options, failure] of [
    ["no sign-in", { signedOut: true }, "sign-in-first"],
    ["400 unknown_pc", { listed: true, admission: () => Response.json({ error: { code: "unknown_pc" } }, { status: 400 }) }, "account-unlisted"],
    ["429 too_many_admissions", { listed: true, admission: () => Response.json({ error: { code: "too_many_admissions" } }, { status: 429 }) }, "account-busy"],
    ["503", { listed: true, admission: () => Response.json({ error: { code: "unavailable" } }, { status: 503 }) }, "admission-unanswered"],
    ["no answer", { listed: true, admission: () => "unanswered" as const }, "admission-unanswered"],
    ["400 invalid_key", { listed: true, admission: () => Response.json({ error: { code: "invalid_key" } }, { status: 400 }) }, "admission-failed"],
  ] as const) {
    it(`with the mark, sends no PAIR on ${what}, and says why`, async () => {
      const run = await pairing({ mark: true, ...options });
      run.admissionGate.resolve();
      await until(() => run.current().state.kind === "failed");
      expect(run.failure()).toBe(failure);
      expect(run.opens()).toBe(0);
      const said = relayFailureText(t, failure, "Desk");
      expect(said.title).not.toBe(relayFailureText(t, "relay-unreachable", "Desk").title);
      expect(said.retry).toBe(failure !== "sign-in-first");
    });
  }

  // the account service answers as the repository's fake does, or not at all; neither is asked
  for (const [what, options] of [["a PC the account does not list", {}], ["an account service that does not answer", { admission: () => "unanswered" as const }]] as const) {
    it(`without the mark, posts nothing and pairs and links as before: ${what}`, async () => {
      const run = await pairing(options);
      await until(() => run.apps() === 1 && run.sent.length === 1);
      expect(run.posted).toEqual([]);
      // nothing reaches the account service before the pairing
      expect(run.events.slice(0, run.events.indexOf("pair")).filter((event) => event.startsWith("list") || event.startsWith("admission"))).toEqual([]);
      expect(run.pcEvents()).toEqual(["pair", "link"]);
    });
  }

  it("without a code, a join by comparing digits posts an ordinary admission as before, never a quiet one", async () => {
    const run = await pairing({ codeless: true, listed: true });
    await until(() => run.posted.length === 1);
    run.admissionGate.resolve();
    expect(run.quiet).toEqual([false]);
    expect(run.events.filter((event) => event.startsWith("list"))).toEqual([]);
  });

  it("with the mark, stops when the stored sign-in changed since the press: nothing is posted under the other", async () => {
    const run = await pairing({ mark: true, listed: true, hold: true });
    run.press();
    await run.switchAccount();
    run.admissionGate.resolve();
    // the question is asked again, under the sign-in stored now
    await until(() => run.current().state.kind === "confirm" && (run.current().state as { account?: string }).account !== "checking");
    expect(run.posted).toEqual([]);
    expect(run.opens()).toBe(0);
  });

  it("with the mark, posts the key the link will name when the account key changed after the post, once, and stops when that link is refused too", async () => {
    const run = await pairing({ mark: true, listed: true, keyChanges: true, links: [() => Response.json({ error: { code: "unverified_device" } }, { status: 403 })] });
    run.admissionGate.resolve();
    await until(() => run.current().state.kind === "failed");
    expect(run.posted).toHaveLength(2);
    expect(run.posted[1]).not.toBe(run.posted[0]);
    expect(run.quiet).toEqual([true, true]);
    expect(run.sent).toEqual(run.posted.slice(1));
    expect(run.failure()).toBe("unverified-device");
  });

  it("with the mark, sends no link when the post of the changed key fails, and says why", async () => {
    let posts = 0;
    const run = await pairing({ mark: true, listed: true, keyChanges: true, admission: () => ++posts === 1 ? Response.json({ id: "adm-1" }) : Response.json({ error: { code: "unavailable" } }, { status: 503 }) });
    run.admissionGate.resolve();
    await until(() => run.current().state.kind === "failed");
    expect(run.posted).toHaveLength(2);
    // the PC would refuse that link and spend a use: none is sent
    expect(run.sent).toEqual([]);
    expect(run.failure()).toBe("new-key-unvouched");
  });

  it("sends the same link again on the same session after the wait a 503 account_unavailable named, and pairs once", async () => {
    const run = await pairing({ mark: true, listed: true, hold: true, links: [() => Response.json({ error: { code: "account_unavailable" } }, { status: 503, headers: { "retry-after": "3" } }), () => Response.json({})] });
    jest.useFakeTimers();
    run.press();
    run.admissionGate.resolve();
    await run.armed(3_000, 1);
    jest.advanceTimersByTime(3_000);
    await until(() => run.sent.length === 2);
    expect(run.pcEvents().filter((event) => event === "pair")).toHaveLength(1);
  });

  // a marked pairing's first link the PC turned away: the refusal is said, and the record of the row it ended goes
  it("keeps a new pairing's mark on the failure screen of its refused first link", async () => {
    const run = await pairing({ mark: true, listed: true, links: [() => Response.json({ error: { code: "link_required" } }, { status: 403 })] });
    run.admissionGate.resolve();
    await until(() => run.current().state.kind === "failed");
    expect(run.current().state).toMatchObject({ kind: "failed", failure: "link-required", pairing: true });
  });

  for (const [code, status, failure] of [["link_required", 403, "link-required"], ["account_mismatch", 409, "account-mismatch"], ["unverified_device", 403, "unverified-device"]] as const) {
    it(`says a new marked pairing's refused link (${code}) in its own words, opens no app, and forgets the row the PC ended`, async () => {
      const run = await pairing({ mark: true, listed: true, links: [() => Response.json({ error: { code, message: "private refusal" } }, { status })] });
      run.admissionGate.resolve();
      await until(() => run.current().state.kind === "failed");
      expect(run.failure()).toBe(failure);
      expect(run.apps()).toBe(0);
      expect(await run.store.get(run.offer.server_id)).toBeUndefined();
      const said = relayFailureText(t, failure, "Desk");
      expect(said.title).not.toBe(relayFailureText(t, "revoked", "Desk").title);
      expect(JSON.stringify(said)).not.toContain("private refusal");
    });
    // an unmarked pairing's refused link goes as before: the PC opens, and its record goes only once the PC ends the
    // row (a PC that was set up for another account and is in none keeps it, and the device drives on)
    it(`opens the PC as before when an unmarked pairing's link is refused ${code}, and forgets its record once the PC ends the row`, async () => {
      const run = await pairing({ links: [() => Response.json({ error: { code } }, { status })] });
      await until(() => run.apps() === 1 && run.sent.length === 1);
      expect(run.failure()).toBeNull();
      expect((await run.store.get(run.offer.server_id))?.device_id).toBe(NEWER_ID);
      run.endRow();
      await until(async () => await run.store.get(run.offer.server_id) === undefined);
    });
  }

  // a PC the account's signed list removed takes no link into that account: it comes back only as a new PC
  it("says that the account's list removed the PC, in words of its own, with nothing to try again", async () => {
    const run = await pairing({ mark: true, listed: true, links: [() => Response.json({ error: { code: "list_removed", message: "private refusal" } }, { status: 409 })] });
    run.admissionGate.resolve();
    await until(() => run.current().state.kind === "failed");
    expect(run.failure()).toBe("list-removed");
    expect(run.apps()).toBe(0);
    const said = relayFailureText(t, "list-removed", "Desk");
    expect([said.title, said.retry]).toEqual(["Desk was removed from your account", false]);
    expect(said.copy).toContain("only as a new PC");
    expect(JSON.stringify(said)).not.toContain("private refusal");
  });

  // a pairing with no mark is the device's own and stands whatever the link answers: the words are said all the same
  it("says that the account's list removed the PC for a plain code's link too, and keeps the pairing that was made", async () => {
    const run = await pairing({ pcIn: true, listed: true, links: [() => Response.json({ error: { code: "list_removed", message: "private refusal" } }, { status: 409 })] });
    run.admissionGate.resolve();
    await until(() => run.current().state.kind === "failed");
    expect([run.failure(), run.apps()]).toEqual(["list-removed", 0]);
    // nothing of this device's was forgotten: the pairing made with the PC itself still opens it
    expect(await run.store.get(run.offer.server_id)).toMatchObject({ server_id: run.offer.server_id });
  });

  // a PC already in an account keeps a row whose link names another account, and the device drives it as before
  for (const mark of [false, true]) {
    it(`opens the PC as before when a PC already in an account answers the link account_mismatch (${mark ? "marked" : "plain"} code)`, async () => {
      const run = await pairing({ mark, pcIn: true, listed: true, links: [() => Response.json({ error: { code: "account_mismatch" } }, { status: 409 })] });
      run.admissionGate.resolve();
      await until(() => run.apps() === 1 && run.sent.length === 1);
      expect(run.failure()).toBeNull();
      expect((await run.store.get(run.offer.server_id))?.device_id).toBe(NEWER_ID);
    });
  }

  // a hung account service holds a marked pairing no longer than its bound, and nothing reaches the PC
  for (const [hung, failure, options] of [["admission", "admission-unanswered", { listed: true }]] as const) {
    it(`with the mark, stops at the bound when the account service never answers the ${hung}, and sends no PAIR`, async () => {
      const run = await pairing({ mark: true, hold: true, neverAnswers: hung, ...options });
      jest.useFakeTimers();
      run.press();
      // the post's bound is armed with the post itself
      await until(() => run.posted.length === 1);
      expect(run.current().state.kind).toBe("connecting");
      jest.advanceTimersByTime(ADMISSION_WAIT_MS);
      await until(() => run.current().state.kind === "failed");
      expect(run.failure()).toBe(failure);
      expect(run.opens()).toBe(0);
    });
  }

  // a PC that keeps answering account_unavailable gets the link a bounded number of times, each after a bounded wait
  it("with the mark, sends the link five times to a PC that keeps answering account_unavailable, then records the enrollment as failed", async () => {
    const run = await pairing({ mark: true, listed: true, hold: true, links: [() => Response.json({ error: { code: "account_unavailable" } }, { status: 503 })] });
    jest.useFakeTimers();
    run.press();
    run.admissionGate.resolve();
    // the PC named no wait: each link but the last waits three seconds before the next
    for (let links = 1; links < 5; links++) {
      await run.armed(3_000, links);
      jest.advanceTimersByTime(3_000);
    }
    await until(async () => await run.enrollment() === "failed");
    expect(run.sent).toHaveLength(5);
    expect(run.pcEvents().filter((event) => event === "pair")).toHaveLength(1);
  });

  it("waits no longer than its cap before sending the link again, whatever wait the PC names", async () => {
    const run = await pairing({ mark: true, listed: true, hold: true, links: [() => Response.json({ error: { code: "account_unavailable" } }, { status: 503, headers: { "retry-after": "3600" } }), () => Response.json({})] });
    jest.useFakeTimers();
    run.press();
    run.admissionGate.resolve();
    await run.armed(LINK_RETRY_MAX_MS, 1);
    jest.advanceTimersByTime(LINK_RETRY_MAX_MS);
    await until(() => run.sent.length === 2);
  });

  // without the mark a link goes as before: once, unless the PC named a wait
  for (const [what, headers] of [["names no wait", {}], ["names a wait", { "retry-after": "1" }]] as const) {
    it(`without the mark, sends the link again only when the PC ${what}`, async () => {
      const run = await pairing({ hold: true, links: [() => Response.json({ error: { code: "account_unavailable" } }, { status: 503, headers }), () => Response.json({})] });
      jest.useFakeTimers();
      run.press();
      if (what === "names a wait") {
        await run.armed(1_000, 1);
        jest.advanceTimersByTime(1_000);
        // the enrollment settles after the second link: no third one follows
        await until(async () => await run.enrollment() !== "pending");
        expect([await run.enrollment(), run.sent.length]).toEqual(["complete", 2]);
      } else {
        // the one link is answered, and the enrollment ends with it
        await until(async () => await run.enrollment() === "failed");
        expect(run.sent).toHaveLength(1);
      }
    });
  }

  for (const [code, status] of [["unverified_device", 403], ["account_mismatch", 409], ["pairing_ended", 409]] as const) {
    it(`keeps a saved pairing reopened without a code, and opens the PC, when its link is refused ${code}`, async () => {
      const run = await pairing({ reopen: true, links: [() => Response.json({ error: { code } }, { status })] });
      await until(() => run.apps() === 1 && run.sent.length === 1);
      expect((await run.store.get(run.offer.server_id))?.device_id).toBe(OLDER_ID);
    });
  }

  it("forgets the pairing once the PC ends the row", async () => {
    const run = await pairing({ reopen: true, links: [() => Response.json({ error: { code: "unverified_device" } }, { status: 403 })] });
    await until(() => run.apps() === 1 && run.sent.length === 1);
    run.endRow();
    await until(async () => await run.store.get(run.offer.server_id) === undefined);
  });

  it("keeps the older record of a saved pairing that paired again from a marked code whose new link was refused, and opens the PC with it", async () => {
    const run = await pairing({ mark: true, saved: true, listed: true, links: [() => Response.json({ error: { code: "unverified_device" } }, { status: 403 })] });
    run.admissionGate.resolve();
    await until(() => run.apps() === 1);
    expect((await run.store.get(run.offer.server_id))?.device_id).toBe(OLDER_ID);
  });

  it("keeps the older record of a saved pairing that paired again from a marked code when the PC ends the new row after a refusal with no words of its own, and opens the PC with it", async () => {
    const run = await pairing({ mark: true, saved: true, listed: true, links: [() => Response.json({ error: { code: "key_in_use" } }, { status: 409 })] });
    run.admissionGate.resolve();
    await until(() => run.sent.length === 1);
    run.endRow();
    await until(() => run.apps() === 1);
    expect((await run.store.get(run.offer.server_id))?.device_id).toBe(OLDER_ID);
    expect(run.failure()).toBeNull();
  });

  // the mark comes with the QR code, which nothing signs: it only chooses the confirm. The person's press of Add and pair
  // on that confirm, which names the PC and the account, lists a PC the account does not list yet; then the admission
  // goes, then the PAIR
  it("with the mark, lists a PC the account does not list once Add and pair is pressed, then posts, pairs and links", async () => {
    const run = await pairing({ mark: true });
    run.admissionGate.resolve();
    await until(() => run.apps() === 1 && run.sent.length === 1);
    // the enrollment lists the PC again once the link passed, as for any pairing; these are the steps before it
    expect(run.events.filter((event) => event !== "pressed").slice(0, 5)).toEqual(["list Bearer access-acct-test", "admission Bearer access-acct-test", "admission answered", "pair", "link"]);
    expect(run.events.indexOf("pressed")).toBeLessThan(run.events.indexOf("list Bearer access-acct-test"));
    expect(run.failure()).toBeNull();
  });

  // a typed code that matched pairs with no confirm, so no press of Add and pair: nothing is listed for it. Its admission
  // goes, and an account that does not list the PC refuses it (a known limit of the typed path)
  it("with the mark, lists nothing for a typed code that pairs with no confirm pressed", async () => {
    const run = await pairing({ mark: true, typedConfirmed: true });
    run.admissionGate.resolve();
    await until(() => run.current().state.kind === "failed");
    expect(run.failure()).toBe("account-unlisted");
    expect(run.events.filter((event) => event.startsWith("list"))).toEqual([]);
    expect(run.opens()).toBe(0);
  });

  it("with the mark, lists nothing and posts nothing while Add and pair is not pressed", async () => {
    const run = await pairing({ mark: true, hold: true });
    run.admissionGate.resolve();
    // the work before the confirm is done: the directory was read, and the confirm drawn from it
    await until(() => run.directoryReads() > 0 && run.current().state.kind === "confirm" && (run.current().state as { account?: string }).account !== "checking");
    // no request is sent before the press: none to the account service but that read, none to the PC
    expect([run.events, run.posted, run.opens()]).toEqual([[], [], 0]);
    // the press is what sends them
    run.press();
    await until(() => run.posted.length === 1);
    expect(run.events.slice(0, 3)).toEqual(["pressed", "list Bearer access-acct-test", "admission Bearer access-acct-test"]);
  });

  // another tab signs out of, or into another account than, the one the confirm named while the post is out: no PAIR
  it("with the mark, sends no PAIR when the stored sign-in changed while the admission was out, and asks again", async () => {
    const run = await pairing({ mark: true, listed: true, switchAfterAdmission: true });
    run.admissionGate.resolve();
    await until(() => run.posted.length === 1 && run.current().state.kind === "confirm" && (run.current().state as { account?: string }).account !== "checking");
    expect(run.opens()).toBe(0);
  });

  it("with the mark, sends the link no more once the stored sign-in changed while it waited to send it again", async () => {
    const run = await pairing({ mark: true, listed: true, hold: true, links: [() => Response.json({ error: { code: "account_unavailable" } }, { status: 503, headers: { "retry-after": "2" } }), () => Response.json({})] });
    jest.useFakeTimers();
    run.press();
    run.admissionGate.resolve();
    await run.armed(2_000, 1);
    await run.switchAccount();
    jest.advanceTimersByTime(2_000);
    // the wait over, the sign-in is read again and the enrollment ends
    await until(async () => await run.enrollment() === "failed");
    expect(run.sent).toHaveLength(1);
  });

  // a marked re-pair whose new link is refused restores the older record only while the refused row still holds it
  it("keeps a Forget that another tab makes as a marked re-pair's refusal is handled, and writes no older record over it", async () => {
    const run = await pairing({ mark: true, saved: true, listed: true, forgetAtRestore: true, links: [() => Response.json({ error: { code: "unverified_device" } }, { status: 403 })] });
    run.admissionGate.resolve();
    // the refusal is handled, and said
    await until(() => run.current().state.kind === "failed");
    // the older record was not written back over the Forget
    expect(await run.store.get(run.offer.server_id)).toBeUndefined();
  });

  // the PC ends the refused row's sessions as it answers: that end may arrive before the refusal itself
  for (const saved of [true, false]) {
    it(`handles a marked pairing's refusal that arrives after the end of its sessions (${saved ? "a re-pair" : "a new pairing"})`, async () => {
      const run = await pairing({ mark: true, saved, listed: true, endRowBeforeAnswer: true, links: [() => Response.json({ error: { code: "unverified_device" } }, { status: 403 })] });
      run.admissionGate.resolve();
      if (saved) {
        await until(() => run.apps() === 1);
        expect((await run.store.get(run.offer.server_id))?.device_id).toBe(OLDER_ID);
      } else {
        await until(() => run.current().state.kind === "failed");
        expect(run.failure()).toBe("unverified-device");
        expect(await run.store.get(run.offer.server_id)).toBeUndefined();
        // the PAIR and the link's own connection, and no sign-in again with the key of a row the PC turned away
        expect(run.opens()).toBe(2);
      }
    });
  }

  // a Cancel ends the attempt wherever it waits: it sends no link, opens no app, and writes nothing after it
  for (const mark of [true, false]) {
    it(`sends no link and opens nothing after a Cancel while the PAIR's record is read (${mark ? "marked" : "plain"} code)`, async () => {
      const run = await pairing({ mark, listed: true, holdReadAfterPair: true });
      run.admissionGate.resolve();
      await run.readHeld;
      run.current().onCancel();
      run.releaseRead();
      await run.over();
      expect(run.sent).toEqual([]);
      expect(run.apps()).toBe(0);
    });
  }

  it("with the mark, sends no link again and records nothing after a Cancel while a link waits to be sent again", async () => {
    const run = await pairing({ mark: true, listed: true, hold: true, links: [() => Response.json({ error: { code: "account_unavailable" } }, { status: 503, headers: { "retry-after": "2" } }), () => Response.json({})] });
    jest.useFakeTimers();
    run.press();
    run.admissionGate.resolve();
    await run.armed(2_000, 1);
    const before = await run.enrollment();
    run.current().onCancel();
    jest.advanceTimersByTime(LINK_RETRY_MAX_MS);
    await run.over();
    expect(run.sent).toHaveLength(1);
    expect(run.apps()).toBe(0);
    expect(await run.enrollment()).toBe(before);
  });

  // a refused first link forgets only the refused row's own record: a newer pairing another tab saved meanwhile stands
  it("keeps a newer pairing another tab saves as the refused row's record is forgotten", async () => {
    const run = await pairing({ mark: true, listed: true, replaceAtForget: true, links: [() => Response.json({ error: { code: "unverified_device" } }, { status: 403 })] });
    run.admissionGate.resolve();
    await until(() => run.current().state.kind === "failed");
    expect(run.failure()).toBe("unverified-device");
    expect((await run.store.get(run.offer.server_id))?.device_id).toBe(REPLACED_ID);
  });

  it("keeps a newer pairing another tab saves as a re-pair's older record would be written back, when the end of its sessions came first", async () => {
    const run = await pairing({ mark: true, saved: true, listed: true, endRowBeforeAnswer: true, replaceAtRestore: true, links: [() => Response.json({ error: { code: "unverified_device" } }, { status: 403 })] });
    run.admissionGate.resolve();
    await until(() => run.current().state.kind === "failed");
    expect((await run.store.get(run.offer.server_id))?.device_id).toBe(REPLACED_ID);
  });

  it("keeps a newer pairing another tab saved right after the PAIR when the refused row's record is forgotten: the row is the one the PC admitted", async () => {
    const run = await pairing({ mark: true, listed: true, replaceAfterPair: true, links: [() => Response.json({ error: { code: "unverified_device" } }, { status: 403 })] });
    run.admissionGate.resolve();
    await until(() => run.current().state.kind === "failed");
    expect(run.failure()).toBe("unverified-device");
    expect((await run.store.get(run.offer.server_id))?.device_id).toBe(REPLACED_ID);
  });

  it("says a connecting screen comes after approval only once the PC accepted the pairing", async () => {
    const run = await pairing({ mark: true, listed: true });
    run.admissionGate.resolve();
    await until(() => run.drawn().some((state) => state.kind === "connecting" && state.approved === true));
    const connecting = run.drawn().filter((state) => state.kind === "connecting");
    // the first is drawn as the pairing starts, before any compare or PAIR: nothing was approved yet
    expect(connecting[0]).not.toHaveProperty("approved");
    expect(connecting.at(-1)).toMatchObject({ kind: "connecting", name: "Desk", approved: true });
    expect(run.pcEvents()[0]).toBe("pair");
  });

  it("with the mark, keeps the connecting screen and its Cancel while the first link waits for the time the PC named, and opens the PC once it passes", async () => {
    const run = await pairing({ mark: true, listed: true, hold: true, links: [() => Response.json({ error: { code: "account_unavailable" } }, { status: 503, headers: { "retry-after": "15" } }), () => Response.json({})] });
    jest.useFakeTimers();
    run.press();
    run.admissionGate.resolve();
    await run.armed(LINK_RETRY_MAX_MS, 1);
    jest.advanceTimersByTime(ACCOUNT_STEPS_WAIT_MS);
    expect([run.apps(), run.current().state.kind]).toEqual([0, "connecting"]);
    await until(() => run.apps() === 1);
    expect(run.sent).toHaveLength(2);
  });

  it("with the mark, does not reload for a newer PC before a re-pair's first link is answered, and keeps the older record when that link is refused", async () => {
    const run = await pairing({ mark: true, saved: true, listed: true, pcVersion: "1.1.0", links: [() => Response.json({ error: { code: "unverified_device" } }, { status: 403 })] });
    run.admissionGate.resolve();
    await until(() => run.reloads() > 0 || run.apps() > 0);
    // the link went out from this page, whose refusal restored the older record: the reload comes with the PC's
    // admission of that record, which a newer shell then opens
    expect(run.sent).toHaveLength(1);
    expect((await run.store.get(run.offer.server_id))?.device_id).toBe(OLDER_ID);
  });

  it("with the mark, a pairing cancelled while its saved record was read leaves the next pairing's refusal its own: a Forget made meanwhile stands", async () => {
    const run = await pairing({ mark: true, saved: true, listed: true, holdMarkedRead: true, holdFirstLink: true, links: [() => Response.json({ error: { code: "unverified_device" } }, { status: 403 })] });
    run.admissionGate.resolve();
    await run.markedReadHeld;
    // another tab forgets the PC, and the same link is opened again here: the first attempt ends, and the second pairs
    await run.store.remove(run.offer.server_id);
    const link = new URL(encodeOffer(run.offer, "https://app.ovis.sh"));
    Object.assign(window.location, { href: link.href, hash: link.hash });
    window.dispatchEvent(new Event("hashchange"));
    await until(() => run.current().state.kind === "confirm" && (run.current().state as { account?: string }).account !== "checking");
    run.press();
    await run.linkHeld;
    // the first attempt's read answers now, with the record saved before the Forget
    run.releaseMarkedRead();
    // fixed wait: one turn of the event loop, for whatever the first attempt still does after its read
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    run.releaseLink();
    await until(() => run.current().state.kind === "failed" || run.apps() > 0);
    expect([run.failure(), run.apps()]).toEqual(["unverified-device", 0]);
    expect(await run.store.get(run.offer.server_id)).toBeUndefined();
  });

  it("with the mark, ends the changed key's admission when the person cancels while it is out, and sends no link", async () => {
    const run = await pairing({ mark: true, listed: true, keyChanges: true, holdSecondPost: true });
    run.admissionGate.resolve();
    await run.secondPostHeld;
    run.current().onCancel();
    expect(run.postSignal()?.aborted).toBe(true);
    run.releaseSecondPost();
    await run.over();
    expect(run.sent).toEqual([]);
    expect(run.apps()).toBe(0);
  });
});
